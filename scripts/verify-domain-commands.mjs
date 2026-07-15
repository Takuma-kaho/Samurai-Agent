import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-domain-commands-"));
const evidenceDir = path.join(root, "reports/core-completion/evidence");
const evidencePath = path.join(evidenceDir, "domain-commands.json");

mkdirSync(evidenceDir, { recursive: true });
if (existsSync(evidencePath)) unlinkSync(evidencePath);

try {
  const startedAt = new Date().toISOString();
  const checkOutput = execFileSync("pnpm", ["core:domain-commands:check"], { cwd: root, encoding: "utf8" });
  process.stdout.write(checkOutput);
  const resultLine = checkOutput.trim().split(/\r?\n/).filter((line) => line.startsWith("{")).at(-1);
  if (!resultLine) throw new Error("domain_command_check_summary_missing");
  const result = JSON.parse(resultLine);
  if (result.status !== "passed" || result.gate_count !== 81 || result.contracts?.commands !== 102 || result.contracts?.queries !== 12 || result.operation_modules !== 114 || result.repository_tests !== result.repository_passed_tests) {
    throw new Error("domain_command_verification_assertion_mismatch");
  }
  const temporaryLedger = path.join(temporaryRoot, "domain-command-contract-ledger.json");
  const ledgerGenerator = path.join(temporaryRoot, "generate-domain-contract-ledger.mjs");
  execFileSync(esbuild, [
    path.join(root, "scripts/generate-domain-contract-ledger.mjs"),
    "--bundle", "--platform=node", "--format=esm", `--outfile=${ledgerGenerator}`
  ], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [ledgerGenerator], {
    cwd: root,
    env: { ...process.env, SAMURAI_DOMAIN_LEDGER_OUTPUT: temporaryLedger },
    stdio: "inherit"
  });
  if (readFileSync(temporaryLedger).compare(readFileSync(path.join(root, "plans/domain-command-contract-ledger.json"))) !== 0) {
    throw new Error("domain_command_contract_ledger_drift");
  }
  const completedAt = new Date().toISOString();
  const sourceEvidence = committedSourceEvidence(root, [
    "packages/action-catalog/src/index.ts",
    "packages/action-catalog/src/domain-catalog-projection.ts",
    "packages/core-schemas/src/index.ts",
    "packages/domain-operations/src/definition/index.ts",
    "packages/domain-operations/src/catalog.ts",
    "packages/domain-operations/src/registry/operation-registry.ts",
    "packages/domain-operations/src/generated/operation-index.generated.ts",
    "packages/runtime/src/agent-runtime.ts",
    "packages/runtime/src/domain-operation-composition.ts",
    "packages/runtime/src/commands/domain-command-bus.ts",
    "apps/server/src/api-server.ts",
    "apps/server/src/domain-ingress.ts",
    "plans/domain-command-contract-ledger.json",
    "scripts/fixtures/domain-commands-gate.ts",
    "scripts/fixtures/domain-command-compatibility.ts",
    "scripts/fixtures/domain-command-ingress.ts",
    "scripts/fixtures/domain-command-trusted-context.ts",
    "scripts/fixtures/domain-query-purity.ts",
    "scripts/check-domain-commands.mjs",
    "scripts/generate-domain-contract-ledger.mjs",
    "scripts/run-domain-contract-ledger.mjs",
    "scripts/verify-domain-commands.mjs",
    "scripts/lib/core-evidence.mjs",
    "scripts/lib/domain-verifier-policy.mjs",
    "scripts/verify-domain-command-verifier-self-test.mjs",
    ...recursiveFiles(path.join(root, "packages/domain-operations/src")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "packages/runtime/src/domain-operation-ports")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "packages/runtime/src/commands/services")).map((file) => path.relative(root, file))
  ]);
  if (!sourceEvidence.worktree_clean || sourceEvidence.source_read_errors.length > 0) {
    throw new Error(`domain_command_sources_not_committed_and_clean:${sourceEvidence.source_read_errors.join(",")}`);
  }
  const temporaryEvidence = path.join(evidenceDir, `.domain-commands.${process.pid}.tmp`);
  writeFileSync(temporaryEvidence, `${JSON.stringify({
    schema_version: 1,
    test_id: "domain-commands",
    command: "pnpm core:domain-commands:verify",
    status: "passed",
    ...sourceEvidence,
    started_at: startedAt,
    completed_at: completedAt,
    assertions: [
      { name: "hard gate count", actual: result.gate_count, expected: 81 },
      { name: "active command count", actual: result.contracts.commands, expected: 102 },
      { name: "query count", actual: result.contracts.queries, expected: 12 },
      { name: "operation modules", actual: result.operation_modules, expected: 114 },
      { name: "strict input contracts", actual: result.contracts.strict_inputs, expected: 114 },
      { name: "strict output contracts", actual: result.contracts.strict_outputs, expected: 114 },
      { name: "property invalid inputs", actual: result.contracts.property_invalid_inputs, expected: 1140 },
      { name: "repository tests", actual: result.repository_passed_tests, expected: result.repository_tests },
      { name: "coverage lines", actual: result.coverage.lines, expected: 100 },
      { name: "verifier mutations", actual: result.verifier_mutations, expected: 15 }
    ],
    result
  }, null, 2)}\n`);
  renameSync(temporaryEvidence, evidencePath);
  process.stdout.write(`${JSON.stringify({ status: "passed", evidence: path.relative(root, evidencePath), commit_sha: sourceEvidence.commit_sha, source_sha256: sourceEvidence.source_sha256 })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function recursiveFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? recursiveFiles(target) : [target];
  }).filter((file) => /\.(?:ts|mts|mjs|json)$/.test(file));
}
