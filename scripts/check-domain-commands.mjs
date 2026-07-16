import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { passingDomainVerifierModel, validateDomainVerifierModel } from "./lib/domain-verifier-policy.mjs";

const root = process.env.SAMURAI_REPO_ROOT
  ? path.resolve(process.env.SAMURAI_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platformPrefix = process.platform === "darwin"
  ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
  : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(platformPrefix));
if (!packageDir) throw new Error(`esbuild native package not found: ${platformPrefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-domain-commands-check-"));
const output = path.join(temporaryRoot, "check.mjs");
const fixtureResults = new Map();

function runJsonCheck(file, options = {}) {
  const { nodeArgs = [], env = process.env, ...execOptions } = options;
  const stdout = execFileSync(process.execPath, [...nodeArgs, file], {
    cwd: root,
    encoding: "utf8",
    ...execOptions,
    env: { ...env, SAMURAI_REPO_ROOT: root }
  });
  process.stdout.write(stdout);
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const result = JSON.parse(lines.at(-1));
  if (result.status !== "passed") throw new Error(`domain_check_failed:${file}`);
  return result;
}

try {
  execFileSync(process.execPath, [path.join(root, "scripts/generate-domain-operation-index.mjs"), "--check"], { cwd: root, stdio: "inherit" });
  const queryWritePortNegative = verifyQueryWritePortNegative();
  const negativeDiagnostics = queryWritePortNegative.diagnostics;
  if (queryWritePortNegative.status === 0 || !negativeDiagnostics.includes("TS2559")) throw new Error(`query_write_port_negative_fixture_failed:${negativeDiagnostics}`);
  process.stdout.write(`${JSON.stringify({ status: "passed", gate: "ST09", expected_diagnostic: "TS2559" })}\n`);
  fixtureResults.set("query-write-port-negative", { status: "passed", gates: ["QP01"] });
  const idempotencyWorker = path.join(temporaryRoot, "domain-command-idempotency-worker.mjs");
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/domain-command-idempotency-worker.ts"),
    "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${idempotencyWorker}`
  ], { cwd: root, stdio: "inherit" });
  const crashWorker = path.join(temporaryRoot, "domain-command-crash-worker.mjs");
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/domain-command-crash-worker.ts"),
    "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${crashWorker}`
  ], { cwd: root, stdio: "inherit" });
  for (const fixture of [
    "domain-command-contract.ts",
    "domain-command-idempotency.ts",
    "domain-command-version.ts",
    "domain-command-ingress.ts",
    "domain-command-trusted-context.ts",
    "domain-command-parity.ts",
    "domain-command-compatibility.ts",
    "domain-query-purity.ts",
    "domain-operation-structure.ts"
  ]) {
    if (fixture === "domain-command-ingress.ts") {
      const result = runJsonCheck(path.join(root, "scripts/fixtures", fixture), { nodeArgs: ["--import", "tsx"] });
      fixtureResults.set(fixture.replace(/\.ts$/, ""), result);
      continue;
    }
    const fixtureOutput = path.join(temporaryRoot, fixture.replace(/\.ts$/, ".mjs"));
    execFileSync(esbuild, [
      path.join(root, "scripts/fixtures", fixture),
      "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3",
      ...(fixture === "domain-operation-structure.ts" ? ["--external:typescript"] : []),
      `--outfile=${fixtureOutput}`
    ], { cwd: root, stdio: "inherit" });
    const result = runJsonCheck(fixtureOutput, {
      env: fixture === "domain-command-idempotency.ts"
        ? { ...process.env, SAMURAI_DOMAIN_IDEMPOTENCY_WORKER: idempotencyWorker, SAMURAI_DOMAIN_CRASH_WORKER: crashWorker }
        : process.env
    });
    fixtureResults.set(fixture.replace(/\.ts$/, ""), result);
  }
  const architecture = runJsonCheck(path.join(root, "scripts/verify-architecture-boundaries.mjs"), {
    env: { ...process.env, SAMURAI_EVIDENCE_MODE: "deferred" }
  });
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/domain-commands-gate.ts"),
    "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", "--external:typescript", `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });
  const contracts = runJsonCheck(output);
  const mismatch = spawnSync(process.execPath, [output], {
    cwd: root,
    env: { ...process.env, SAMURAI_EXPECT_COMMAND_COUNT: "101" },
    stdio: "ignore"
  });
  if (mismatch.status === 0) throw new Error("domain_command_verifier_mismatch_self_test_failed");
  process.stdout.write(`${JSON.stringify({ status: "passed", verifier_mismatch_nonzero: true })}\n`);
  const verifierSelfTest = runJsonCheck(path.join(root, "scripts/verify-domain-command-verifier-self-test.mjs"));
  const coverageDirectory = path.join(temporaryRoot, "coverage");
  execFileSync("pnpm", [
    "exec", "vitest", "run", "packages/domain-operations/src/domain-operations.coverage.test.ts", "packages/runtime/src/commands/domain-command-bus.test.ts",
    "--coverage.enabled", "--coverage.provider=v8", "--coverage.reporter=json-summary", `--coverage.reportsDirectory=${coverageDirectory}`,
    "--coverage.include=packages/domain-operations/src/operations/**/*.operation.ts",
    "--coverage.include=packages/domain-operations/src/registry/operation-registry.ts",
    "--coverage.include=packages/domain-operations/src/generated/operation-binder.generated.ts",
    "--coverage.include=packages/runtime/src/commands/domain-command-bus.ts"
  ], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, SAMURAI_DOMAIN_COVERAGE: "1", SAMURAI_DOMAIN_IDEMPOTENCY_WORKER: idempotencyWorker, SAMURAI_DOMAIN_CRASH_WORKER: crashWorker }
  });
  const coverage = JSON.parse(readFileSync(path.join(coverageDirectory, "coverage-summary.json"), "utf8"));
  const measuredFiles = Object.entries(coverage).filter(([file]) => file !== "total");
  const coverageFailures = measuredFiles.flatMap(([file, metrics]) => {
    const failures = [];
    for (const metric of ["lines", "statements", "functions"]) {
      if (metrics[metric].pct !== 100) failures.push(`${path.relative(root, file)}:${metric}:${metrics[metric].pct}`);
    }
    const requiredBranch = file.endsWith("operation-registry.ts") ? 100 : 95;
    if (metrics.branches.pct < requiredBranch) failures.push(`${path.relative(root, file)}:branches:${metrics.branches.pct}`);
    return failures;
  });
  if (coverageFailures.length > 0) throw new Error(`domain_command_coverage_failed:${coverageFailures.join(",")}`);
  process.stdout.write(`${JSON.stringify({ status: "passed", coverage_files: measuredFiles.length, lines: coverage.total.lines.pct, statements: coverage.total.statements.pct, functions: coverage.total.functions.pct, branches: coverage.total.branches.pct })}\n`);
  execFileSync("pnpm", [
    "--filter", "@samurai-agent/core-schemas",
    "--filter", "@samurai-agent/domain-operations",
    "--filter", "@samurai-agent/action-catalog",
    "--filter", "@samurai-agent/runtime",
    "--filter", "@samurai-agent/server",
    "run", "typecheck"
  ], { cwd: root, stdio: "inherit" });
  const repositoryTestOutput = execFileSync("pnpm", ["exec", "vitest", "run", "--reporter=json"], {
    cwd: root,
    encoding: "utf8"
  });
  const repositoryReportStart = repositoryTestOutput.lastIndexOf('{"numTotalTestSuites"');
  if (repositoryReportStart < 0) throw new Error("repository_test_report_missing");
  const repositoryTests = JSON.parse(repositoryTestOutput.slice(repositoryReportStart));
  if (!repositoryTests.success) throw new Error("repository_tests_failed");
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    test_files: repositoryTests.testResults.length,
    tests: repositoryTests.numTotalTests,
    passed_tests: repositoryTests.numPassedTests
  })}\n`);
  execFileSync("git", ["diff", "--check"], { cwd: root, stdio: "inherit" });
  const expectedGateIds = [
    ...Array.from({ length: 14 }, (_, index) => `ST${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 12 }, (_, index) => `CT${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 12 }, (_, index) => `RH${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 12 }, (_, index) => `IN${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 15 }, (_, index) => `ID${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 8 }, (_, index) => `QP${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 8 }, (_, index) => `ES${String(index + 1).padStart(2, "0")}`)
  ];
  const observedGateIds = new Set([
    ...fixtureResults.values(),
    contracts
  ].flatMap((result) => Array.isArray(result.gates) ? result.gates : []));
  observedGateIds.add("ST09");
  observedGateIds.add("ST12");
  const missingGateIds = expectedGateIds.filter((id) => !observedGateIds.has(id));
  if (missingGateIds.length > 0) throw new Error(`domain_command_gates_missing:${missingGateIds.join(",")}`);
  const structure = fixtureResults.get("domain-operation-structure");
  const verifierModel = passingDomainVerifierModel();
  verifierModel.activeIdsComplete = contracts.commands === 102 && contracts.queries === 12 && contracts.deprecated_commands === 5;
  verifierModel.handlersUnique = structure.unique_handlers === 114;
  verifierModel.genericForwarderAbsent = observedGateIds.has("ST07");
  verifierModel.operationRedispatchAbsent = observedGateIds.has("ST06");
  verifierModel.queryWriteCompileRejected = queryWritePortNegative.status !== 0 && negativeDiagnostics.includes("TS2559");
  verifierModel.forbiddenStoreImportsAbsent = observedGateIds.has("ST08");
  verifierModel.strictInputs = observedGateIds.has("CT03");
  verifierModel.outputValidationPresent = observedGateIds.has("CT04") && observedGateIds.has("RH05");
  verifierModel.explicitEffects = observedGateIds.has("CT11");
  verifierModel.zodPrivateApiAbsent = observedGateIds.has("ST11");
  verifierModel.catalogSchemaMatches = fixtureResults.get("domain-command-contract").action_catalog_matches === true;
  verifierModel.generatedIndexMatches = observedGateIds.has("ST14");
  verifierModel.directStoreMutationAbsent = architecture.server_direct_store_mutations === 0 && architecture.adapter_direct_store_mutations === 0;
  verifierModel.evidenceActualMatches = observedGateIds.has("ES07");
  verifierModel.allGatesPassed = missingGateIds.length === 0;
  const verifierViolations = validateDomainVerifierModel(verifierModel);
  if (verifierViolations.length > 0) throw new Error(`domain_command_verifier_policy_failed:${verifierViolations.join(",")}`);
  const idempotency = fixtureResults.get("domain-command-idempotency");
  const trustedContext = fixtureResults.get("domain-command-trusted-context");
  const summary = {
    status: "passed",
    gates: expectedGateIds,
    gate_count: observedGateIds.size,
    structure_gates: [...new Set([...structure.gates, "ST09", "ST12"])].sort(),
    operation_modules: structure.operation_modules,
    contracts: {
      commands: contracts.commands,
      queries: contracts.queries,
      strict_inputs: contracts.strict_input_checks,
      strict_outputs: contracts.strict_output_checks,
      property_invalid_inputs: contracts.property_invalid_inputs
    },
    idempotency: {
      same_process_side_effects: idempotency.side_effects,
      multi_process_side_effects: idempotency.multi_process_side_effects,
      crash_before_reclaimed: idempotency.crash_before_reclaimed,
      crash_after_outcome_unknown: idempotency.crash_after_external_outcome_unknown
    },
    trusted_context: trustedContext,
    ingress: fixtureResults.get("domain-command-ingress"),
    compatibility: fixtureResults.get("domain-command-compatibility"),
    query_purity: fixtureResults.get("domain-query-purity"),
    architecture,
    target_typechecks: 5,
    repository_test_files: repositoryTests.testResults.length,
    repository_tests: repositoryTests.numTotalTests,
    repository_passed_tests: repositoryTests.numPassedTests,
    coverage: { files: measuredFiles.length, lines: coverage.total.lines.pct, statements: coverage.total.statements.pct, functions: coverage.total.functions.pct, branches: coverage.total.branches.pct },
    git_diff_check: true,
    verifier_mismatch_nonzero: true,
    verifier_mutations: verifierSelfTest.mutations
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function verifyQueryWritePortNegative() {
  const definitionFile = path.join(root, "packages/domain-operations/src/definition/index.ts");
  const definitionAst = ts.createSourceFile(definitionFile, readFileSync(definitionFile, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const queryPorts = definitionAst.statements.find((statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === "DomainQueryPorts");
  if (!queryPorts || !ts.isInterfaceDeclaration(queryPorts)) throw new Error("domain_query_ports_missing");
  const members = queryPorts.members.map((member) => member.getText(definitionAst)).join("\n");
  const fixture = "query-write-port-negative.type-test.ts";
  const source = `interface DomainQueryPorts { ${members} }\ninterface WriteOnlyPort { save(value: string): Promise<void> }\ndeclare const writeOnly: WriteOnlyPort;\nconst rejected: DomainQueryPorts = writeOnly;\nvoid rejected;\n`;
  const sourceFile = ts.createSourceFile(fixture, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const host = {
    getSourceFile: (name) => name === fixture ? sourceFile : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {}, getCurrentDirectory: () => "", getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    fileExists: (name) => name === fixture, readFile: (name) => name === fixture ? source : undefined
  };
  const program = ts.createProgram([fixture], { noEmit: true, noLib: true, strict: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.code !== 2318);
  return { status: diagnostics.length === 0 ? 0 : 1, diagnostics: diagnostics.map((diagnostic) => `TS${diagnostic.code}:${diagnostic.messageText}`).join("\n") };
}
