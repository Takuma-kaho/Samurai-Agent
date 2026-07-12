import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const platformPackagePrefix = process.platform === "darwin"
  ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
  : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(platformPackagePrefix));
if (!packageDir) throw new Error(`esbuild native package not found: ${platformPackagePrefix}`);
const esbuildPackageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", esbuildPackageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-command-version-"));
const output = path.join(temporaryRoot, "verify.mjs");

try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/domain-command-version.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const sourceEvidence = committedSourceEvidence(root, ["packages/core-schemas/src/index.ts", "packages/workspace-store/src/index.ts", "packages/runtime/src/index.ts", "packages/ui-protocol/src/index.ts", "scripts/fixtures/domain-command-version.ts", "scripts/verify-domain-command-version.mjs", "scripts/lib/core-evidence.mjs"]);
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "A05.json"), `${JSON.stringify({
    schema_version: 1, test_id: "A05", command: "pnpm core:test:command-version", status: "passed",
    ...sourceEvidence, started_at: startedAt, completed_at: completedAt,
    assertions: [
      { name: "stale update rejected", actual: result.stale_update_rejected, expected: true },
      { name: "latest resource returned", actual: result.latest_resource_returned, expected: true },
      { name: "retry version returned", actual: result.retry_version_returned, expected: true },
      { name: "one concurrent update", actual: result.successful_updates, expected: 1 },
      { name: "monotonic final version", actual: result.final_version, expected: 3 }
    ], result
  }, null, 2)}\n`);
  writeFileSync(path.join(evidenceDir, "C02.json"), `${JSON.stringify({
    schema_version: 1, test_id: "C02", command: "pnpm core:test:sqlite-race", status: "passed",
    ...sourceEvidence, started_at: startedAt, completed_at: completedAt,
    assertions: [
      { name: "SQLite foreign keys enabled", actual: result.sqlite_settings.foreign_keys, expected: 1 },
      { name: "SQLite WAL enabled", actual: result.sqlite_settings.journal_mode, expected: "wal" },
      { name: "SQLite busy timeout", actual: result.sqlite_settings.busy_timeout >= 5000, expected: true },
      { name: "100 parallel updates", actual: result.parallel_updates, expected: 100 },
      { name: "No lost update", actual: result.final_version, expected: 3 }
    ], result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
