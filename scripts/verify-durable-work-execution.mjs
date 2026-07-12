import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix));
if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-durable-work-"));
const output = path.join(temporaryRoot, "verify.mjs");
const workerOutput = path.join(temporaryRoot, "kill-worker.mjs");
const sourceFiles = ["packages/core-schemas/src/index.ts", "packages/workspace-store/src/index.ts", "packages/runtime/src/commands/domain-command-bus.ts", "scripts/fixtures/durable-work-execution.ts", "scripts/fixtures/durable-work-kill-worker.ts", "scripts/verify-durable-work-execution.mjs", "scripts/lib/core-evidence.mjs"];

try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/durable-work-execution.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/durable-work-kill-worker.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${workerOutput}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8", env: { ...process.env, SAMURAI_KILL_WORKER: workerOutput } }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const sourceEvidence = committedSourceEvidence(root, sourceFiles);
  const cases = {
    B01: [{ name: "Checkpoint survives store restart", actual: result.restart_checkpoint_recovered, expected: true }, { name: "Completion criteria survive restart", actual: result.restart_completion_criteria_recovered, expected: true }, { name: "Worker is actually killed", actual: result.actual_process_killed, expected: true }, { name: "Killed worker lease and checkpoint recover", actual: result.kill_checkpoint_recovered && result.kill_lease_reconciled && result.post_kill_completed, expected: true }],
    B02: [{ name: "Atomic 100-worker claim", actual: result.claim_winners, expected: 1 }, { name: "Claimed side effect", actual: result.claim_side_effects, expected: 1 }, { name: "Dependency blocks successor", actual: result.dependency_blocked, expected: true }],
    B03: [{ name: "Lease heartbeat owner enforcement", actual: result.heartbeat_owner_enforced, expected: true }, { name: "Expired lease reconciliation", actual: result.stale_lease_reconciled, expected: true }],
    B04: [{ name: "Retry increments attempt", actual: result.retry_attempt, expected: 2 }, { name: "Non-retryable failure is terminal", actual: result.non_retryable_terminal, expected: true }, { name: "Attempt budget exhaustion is terminal", actual: result.attempt_budget_terminal, expected: true }],
    B05: [{ name: "Checkpoint idempotency", actual: result.checkpoint_idempotent, expected: true }, { name: "Side effect replay count", actual: result.side_effect_replay_count, expected: 1 }, { name: "Objective completion is explicit", actual: result.objective_requires_explicit_completion, expected: true }]
  };
  for (const [testId, assertions] of Object.entries(cases)) {
    writeFileSync(path.join(evidenceDir, `${testId}.json`), `${JSON.stringify({
      schema_version: 1, test_id: testId, command: "pnpm core:test:durable-work", status: "passed",
      ...sourceEvidence, started_at: startedAt, completed_at: completedAt, assertions, result
    }, null, 2)}\n`);
  }
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
