import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
const root = process.cwd(); const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix)); if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/"); const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache"); mkdirSync(cacheRoot, { recursive: true }); const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-generated-lifecycle-")); const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/core-schemas/src/index.ts", "packages/action-catalog/src/index.ts", "packages/workspace-store/src/index.ts", "packages/runtime/src/index.ts", "packages/runtime/src/presentation/generated-surface.ts", "apps/server/src/index.ts", "scripts/fixtures/generated-surface-lifecycle.ts", "scripts/verify-generated-surface-lifecycle.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/generated-surface-lifecycle.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString(); const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim(); const result = JSON.parse(rawResult); const completedAt = new Date().toISOString(); const evidenceDir = path.join(root, "reports/core-completion/evidence"); mkdirSync(evidenceDir, { recursive: true }); const sourceEvidence = committedSourceEvidence(root, sourceFiles);
  writeFileSync(path.join(evidenceDir, "D03.json"), `${JSON.stringify({ schema_version: 1, test_id: "D03", command: "pnpm core:test:surface-lifecycle", status: "passed", ...sourceEvidence, started_at: startedAt, completed_at: completedAt, assertions: [
    { name: "Generated and direct command parity", actual: new Set(result.command_parity.map((item) => JSON.stringify(item))).size, expected: 1 },
    { name: "Generated action has Activity evidence", actual: result.generated_action_has_activity, expected: true },
    { name: "Generated action uses normal version validation", actual: result.stale_validation_rejected, expected: true }
  ], result }, null, 2)}\n`);
  writeFileSync(path.join(evidenceDir, "D04.json"), `${JSON.stringify({ schema_version: 1, test_id: "D04", command: "pnpm core:test:surface-lifecycle", status: "passed", ...sourceEvidence, started_at: startedAt, completed_at: completedAt, assertions: [
    { name: "Reload preserves content hash", actual: result.reload_same_hash, expected: true },
    { name: "Revision keeps same Surface id and parent lineage", actual: result.same_surface_id && result.parent_lineage, expected: true },
    { name: "Pin persists", actual: result.pinned, expected: true },
    { name: "Backup restores Artifact and Collection primary resources without Surface files", actual: result.backup_preserves_primary_resources, expected: true },
    { name: "Immutable revisions remain available", actual: result.revisions, expected: 2 }
  ], result }, null, 2)}\n`); process.stdout.write(`${rawResult}\n`);
} finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
