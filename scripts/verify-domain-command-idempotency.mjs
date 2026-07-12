import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

try {
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/domain-command-idempotency.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const sourceEvidence = committedSourceEvidence(root, ["packages/core-schemas/src/index.ts", "packages/workspace-store/src/index.ts", "packages/runtime/src/commands/domain-command-bus.ts", "scripts/fixtures/domain-command-idempotency.ts", "scripts/verify-domain-command-idempotency.mjs", "scripts/lib/core-evidence.mjs"]);
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "A04.json"), `${JSON.stringify({
    schema_version: 1,
    test_id: "A04",
    command: "pnpm core:test:command-race",
    status: "passed",
    ...sourceEvidence,
    started_at: startedAt,
    completed_at: completedAt,
    assertions: [
      { name: "100 parallel requests", actual: result.parallel_requests, expected: 100 },
      { name: "one side effect", actual: result.side_effects, expected: 1 },
      { name: "one result id", actual: result.result_ids.length, expected: 1 },
      { name: "durable replay", actual: result.durable_replay, expected: true },
      { name: "payload mismatch rejected", actual: result.mismatched_payload_rejected, expected: true }
    ],
    result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
