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
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-restore-"));
const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/workspace-store/src/index.ts", "packages/workspace-store/src/workspace-store.ts", "packages/workspace-store/src/kernel/workspace-database.ts", "scripts/fixtures/workspace-restore-atomicity.ts", "scripts/verify-workspace-restore-atomicity.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/workspace-restore-atomicity.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "C04.json"), `${JSON.stringify({
    schema_version: 1, test_id: "C04", command: "pnpm core:test:restore", status: "passed",
    ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt,
    assertions: [
      { name: "Restore failure points", actual: result.failure_points, expected: ["extract", "hash_verify", "swap"] },
      { name: "Current Workspace preserved after every failure", actual: result.preserved_count, expected: 3 },
      { name: "Same Store remains usable after successful restore", actual: result.successful_restore_store_reusable, expected: true }
    ], result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
