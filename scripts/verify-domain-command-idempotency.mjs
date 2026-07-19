import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const platformPackagePrefix = process.platform === "darwin"
  ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
  : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm"))
  .find((entry) => entry.startsWith(platformPackagePrefix));
if (!packageDir) {
  throw new Error(`esbuild native package not found: ${platformPackagePrefix}`);
}
const esbuildPackageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", esbuildPackageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-command-race-"));
const output = path.join(temporaryRoot, "verify.mjs");
const idempotencyWorker = path.join(temporaryRoot, "domain-command-idempotency-worker.mjs");
const crashWorker = path.join(temporaryRoot, "domain-command-crash-worker.mjs");

try {
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/domain-command-idempotency.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });
  for (const [fixture, workerOutput] of [
    ["domain-command-idempotency-worker.ts", idempotencyWorker],
    ["domain-command-crash-worker.ts", crashWorker]
  ]) {
    execFileSync(esbuild, [
      path.join(root, "scripts/fixtures", fixture),
      "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${workerOutput}`
    ], { cwd: root, stdio: "inherit" });
  }
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SAMURAI_DOMAIN_IDEMPOTENCY_WORKER: idempotencyWorker,
      SAMURAI_DOMAIN_CRASH_WORKER: crashWorker
    }
  }).trim();
  const result = JSON.parse(rawResult);
  const assertions = [
    { name: "100 parallel requests", actual: result.parallel_requests, expected: 100 },
    { name: "one side effect", actual: result.side_effects, expected: 1 },
    { name: "one result id", actual: result.result_ids.length, expected: 1 },
    { name: "durable replay", actual: result.durable_replay, expected: true },
    { name: "payload mismatch rejected", actual: result.mismatched_payload_rejected, expected: true },
    { name: "crash during production transaction replays without partial state", actual: result.crash_during_transaction_replayed && result.crash_during_transaction_partial_rows === 0, expected: true }
  ];
  for (const assertion of assertions) {
    if (JSON.stringify(assertion.actual) !== JSON.stringify(assertion.expected)) {
      throw new Error(`command_race_assertion_failed:${assertion.name}`);
    }
  }
  const completedAt = new Date().toISOString();
  const generationId = randomUUID();
  const sourceEvidence = committedSourceEvidence(root, [
    "packages/core-schemas/src/index.ts",
    "packages/workspace-store/src/index.ts",
    "packages/workspace-store/src/workspace-store.ts",
    "packages/workspace-store/src/transactions/recovery-policy.ts",
    "packages/domain-operations/src/registry/operation-registry.ts",
    "packages/runtime/src/commands/domain-command-bus.ts",
    "packages/runtime/src/commands/services/collection-domain-service.ts",
    "packages/runtime/src/agent-runtime.ts",
    "scripts/fixtures/domain-command-idempotency.ts",
    "scripts/fixtures/domain-command-idempotency-worker.ts",
    "scripts/fixtures/domain-command-crash-worker.ts",
    "scripts/verify-domain-command-idempotency.mjs",
    "scripts/lib/core-evidence.mjs",
    ...recursiveFiles(path.join(root, "packages/runtime/src/commands/services"))
  ]);
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, "A04.json");
  const temporaryEvidence = path.join(evidenceDir, `.A04.${process.pid}.tmp`);
  writeFileSync(temporaryEvidence, `${JSON.stringify({
    evidence_kind: "domain-command-race",
    generation_id: generationId,
    schema_version: 1,
    test_id: "A04",
    command: "pnpm core:test:command-race",
    status: "passed",
    ...sourceEvidence,
    started_at: startedAt,
    completed_at: completedAt,
    assertions,
    result: { ...result, generation_id: generationId }
  }, null, 2)}\n`, { flag: "wx" });
  renameSync(temporaryEvidence, evidencePath);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function recursiveFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? recursiveFiles(target) : [path.relative(root, target)];
  }).filter((file) => /\.(?:ts|mts|mjs|json)$/.test(file));
}
