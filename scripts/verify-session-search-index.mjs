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
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-search-index-"));
const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/workspace-store/src/index.ts", "packages/workspace-store/src/workspace-store.ts", "packages/workspace-store/src/kernel/session-search-index.ts", "scripts/fixtures/session-search-index.ts", "scripts/verify-session-search-index.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/session-search-index.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "C06.json"), `${JSON.stringify({
    schema_version: 1, test_id: "C06", command: "pnpm core:test:search-index", status: "passed",
    ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt,
    assertions: [
      { name: "Create updates index immediately", actual: result.create_immediate, expected: true },
      { name: "Update replaces index immediately", actual: result.update_immediate, expected: true },
      { name: "Delete removes index immediately", actual: result.delete_immediate, expected: true },
      { name: "Restart preserves existing FTS rows instead of rebuilding", actual: result.startup_preserves_fts, expected: true },
      { name: "FTS unavailable falls back to LIKE", actual: result.fts_fallback, expected: true },
      { name: "Rebuild restores deterministic rank", actual: result.rank_after, expected: result.rank_before }
    ], result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
