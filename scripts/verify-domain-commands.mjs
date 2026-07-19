import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
import { domainVerifierViolationCodes } from "./lib/domain-verifier-policy.mjs";

const root = process.cwd();
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-domain-commands-"));
const evidenceDir = path.join(root, "reports/core-completion/evidence");
const evidencePath = path.join(evidenceDir, "domain-commands.json");

mkdirSync(evidenceDir, { recursive: true });
const temporaryEvidence = path.join(evidenceDir, `.domain-commands.${process.pid}.tmp`);

try {
  const startedAt = new Date().toISOString();
  const checkOutput = execFileSync("pnpm", ["core:domain-commands:check"], { cwd: root, encoding: "utf8" });
  process.stdout.write(checkOutput);
  const resultLine = checkOutput.trim().split(/\r?\n/).filter((line) => line.startsWith("{")).at(-1);
  if (!resultLine) throw new Error("domain_command_check_summary_missing");
  const result = JSON.parse(resultLine);
  const ledger = JSON.parse(readFileSync(path.join(root, "plans/domain-command-contract-ledger.json"), "utf8"));
  const expectedHardGateCount = hardGateIds().length;
  const expectedOperationCount = ledger.counts.commands + ledger.counts.queries;
  const expectedFormalVerifierMutations = domainVerifierViolationCodes.slice(0, 15).length;
  const expectedOperations = Number(result.contracts?.commands) + Number(result.contracts?.queries);
  const expectedVerifierMutations = Number(result.verifier_mutations);
  if (result.status !== "passed"
    || result.gate_count !== expectedHardGateCount
    || result.contracts?.commands !== ledger.counts.commands
    || result.contracts?.queries !== ledger.counts.queries
    || result.operation_modules !== expectedOperationCount
    || result.repository_tests !== result.repository_passed_tests
    || expectedVerifierMutations !== expectedFormalVerifierMutations) {
    throw new Error("domain_command_verification_assertion_mismatch");
  }
  const temporaryLedger = path.join(temporaryRoot, "domain-command-contract-ledger.json");
  execFileSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/generate-domain-contract-ledger.mjs")], {
    cwd: root,
    env: { ...process.env, SAMURAI_DOMAIN_LEDGER_OUTPUT: temporaryLedger },
    stdio: "inherit"
  });
  if (readFileSync(temporaryLedger).compare(readFileSync(path.join(root, "plans/domain-command-contract-ledger.json"))) !== 0) {
    throw new Error("domain_command_contract_ledger_drift");
  }
  const completedAt = new Date().toISOString();
  const generationId = randomUUID();
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
    "scripts/generate-domain-operation-index.mjs",
    "scripts/generate-domain-contract-ledger.mjs",
    "scripts/run-domain-contract-ledger.mjs",
    "scripts/verify-domain-commands.mjs",
    "scripts/lib/core-evidence.mjs",
    "scripts/lib/domain-verifier-policy.mjs",
    "scripts/verify-domain-command-verifier-self-test.mjs",
    "scripts/verify-domain-operation-evidence.mjs",
    "scripts/verify-architecture-boundaries.mjs",
    "scripts/fixtures/domain-operation-structure.ts",
    "scripts/fixtures/domain-operation-evidence-valid.json",
    "scripts/fixtures/domain-verifier-model-valid.json",
    ".github/workflows/ci.yml",
    ...recursiveFiles(path.join(root, "packages/workspace-store/src")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "packages/domain-operations/src")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "packages/runtime/src")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "packages/gateway/src")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "packages/agent-backends/src")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "apps/server/src")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "packages/action-catalog/src")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "packages/runtime/src/domain-operation-ports")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "packages/runtime/src/commands/services")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "scripts/fixtures")).map((file) => path.relative(root, file)),
    ...recursiveFiles(path.join(root, "scripts/lib")).map((file) => path.relative(root, file))
  ]);
  if (!sourceEvidence.worktree_clean || sourceEvidence.source_read_errors.length > 0) {
    throw new Error(`domain_command_sources_not_committed_and_clean:${sourceEvidence.source_read_errors.join(",")}`);
  }
  writeFileSync(temporaryEvidence, `${JSON.stringify({
    evidence_kind: "domain-command",
    schema_version: 1,
    test_id: "domain-commands",
    command: "pnpm core:domain-commands:verify",
    status: "passed",
    generation_id: generationId,
    ...sourceEvidence,
    started_at: startedAt,
    completed_at: completedAt,
    assertions: [
      { name: "hard gate count", actual: result.gate_count, expected: expectedHardGateCount, expected_source: "plan-hard-gates" },
      { name: "active command count", actual: result.contracts.commands, expected: ledger.counts.commands, expected_source: "contract-ledger" },
      { name: "query count", actual: result.contracts.queries, expected: ledger.counts.queries, expected_source: "contract-ledger" },
      { name: "operation modules", actual: result.operation_modules, expected: expectedOperationCount, expected_source: "contract-ledger" },
      { name: "strict input contracts", actual: result.contracts.strict_inputs, expected: expectedOperationCount, expected_source: "contract-ledger" },
      { name: "strict output contracts", actual: result.contracts.strict_outputs, expected: expectedOperationCount, expected_source: "contract-ledger" },
      { name: "property invalid inputs", actual: result.contracts.property_invalid_inputs, expected: expectedOperationCount * 10, expected_source: "contract-ledger-property-cases" },
      { name: "repository tests", actual: result.repository_passed_tests },
      { name: "coverage lines", actual: result.coverage.lines, expected: 100, expected_source: "core-01-plan-coverage" },
      { name: "verifier mutations", actual: result.verifier_mutations, expected: expectedFormalVerifierMutations, expected_source: "verifier-policy-v001-v015" },
      { name: "verifier self-test mutations", actual: result.verifier_self_test_mutations }
    ],
    result: { ...result, generation_id: generationId }
  }, null, 2)}\n`, { flag: "wx" });
  execFileSync(process.execPath, [path.join(root, "scripts/verify-domain-operation-evidence.mjs"), temporaryEvidence], { cwd: root, stdio: "inherit" });
  renameSync(temporaryEvidence, evidencePath);
  process.stdout.write(`${JSON.stringify({ status: "passed", evidence: path.relative(root, evidencePath), commit_sha: sourceEvidence.commit_sha, source_sha256: sourceEvidence.source_sha256 })}\n`);
} catch (error) {
  if (existsSync(temporaryEvidence)) unlinkSync(temporaryEvidence);
  if (existsSync(evidencePath)) {
    renameSync(evidencePath, `${evidencePath}.invalid.${process.pid}`);
  }
  throw error;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function recursiveFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? recursiveFiles(target) : [target];
  }).filter((file) => /\.(?:ts|mts|mjs|json)$/.test(file));
}

function hardGateIds() {
  return [
    ...Array.from({ length: 14 }, (_, index) => `ST${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 12 }, (_, index) => `CT${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 12 }, (_, index) => `RH${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 12 }, (_, index) => `IN${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 15 }, (_, index) => `ID${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 8 }, (_, index) => `QP${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 8 }, (_, index) => `ES${String(index + 1).padStart(2, "0")}`)
  ];
}
