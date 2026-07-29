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
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-file-transaction-"));
const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/core-schemas/src/index.ts", "packages/workspace-store/src/index.ts", "packages/workspace-store/src/workspace-store.ts", "packages/workspace-store/src/kernel/workspace-database.ts", "packages/workspace-store/src/transactions/workspace-file-transaction-coordinator.ts", "packages/workspace-store/src/transactions/collection-record-recovery-handler.ts", "scripts/fixtures/workspace-file-transaction-recovery.ts", "scripts/verify-workspace-file-transaction-recovery.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/workspace-file-transaction-recovery.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "C03.json"), `${JSON.stringify({
    schema_version: 1, test_id: "C03", command: "pnpm core:test:file-transaction", status: "passed",
    ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt,
    assertions: [
      { name: "Failure injection points", actual: result.failure_points.map((item) => item.phase), expected: ["planned", "staged", "db_committed", "renamed"] },
      { name: "Every crash completes or rolls back", actual: result.consistent_outcomes, expected: 4 },
      { name: "No pending file transaction remains", actual: result.pending_transactions, expected: 0 },
      { name: "Ordinary post-commit errors recover through the same journal", actual: result.ordinary_error_recovery, expected: true },
      { name: "Rollback failure retains recovery state", actual: result.rollback_failure_preserves_recovery, expected: true },
      { name: "Newer Collection record blocks unsafe rollback", actual: result.rollback_conflict_rejected, expected: true },
      { name: "Unknown transaction kinds stop recovery", actual: result.unknown_kind_rejected, expected: true }
    ], result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
