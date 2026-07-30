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
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-migration-"));
const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/workspace-store/src/index.ts", "packages/workspace-store/src/workspace-store.ts", "packages/workspace-store/src/kernel/migration-runner.ts", "packages/workspace-store/src/migrations/index.ts", "packages/workspace-store/src/migrations/006-pre-core04-schema-normalization.ts", "scripts/fixtures/workspace-migration.ts", "scripts/verify-workspace-migration.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/workspace-migration.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "C01.json"), `${JSON.stringify({
    schema_version: 1, test_id: "C01", command: "pnpm core:test:migration", status: "passed",
    ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt,
    assertions: [
      { name: "Fresh install reaches latest schema", actual: result.fresh_install, expected: true },
      { name: "All supported legacy versions upgrade", actual: result.upgraded_versions, expected: result.supported_legacy_versions.length },
      { name: "Fresh and upgraded checksums match", actual: result.checksum_equal, expected: true },
      { name: "Migration checksum tampering rejected", actual: result.checksum_tamper_rejected, expected: true },
      { name: "Migration name tampering rejected", actual: result.name_tamper_rejected, expected: true },
      { name: "Migration history gaps rejected", actual: result.history_gap_rejected, expected: true },
      { name: "Future migration versions rejected", actual: result.future_version_rejected, expected: true },
      { name: "Failed migration rolls back schema and history", actual: result.migration_failure_rollback, expected: true },
      { name: "Current Knowledge Wiki setting is preserved when legacy column remains", actual: result.knowledge_wiki_capture_migration_preserves_current_value, expected: true },
      { name: "Legacy Knowledge Wiki setting is adopted only when the current column is absent", actual: result.knowledge_wiki_capture_migration_adopts_legacy_value, expected: true }
    ], result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
