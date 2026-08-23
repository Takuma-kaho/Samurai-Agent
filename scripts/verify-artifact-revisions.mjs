import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
import { evaluateVerifierAssertions, reportVerifierFailures, verifierEvidenceStatus } from "./lib/verifier-assertions.mjs";
const root = process.cwd(); const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix)); if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/"); const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild"); const cacheRoot = path.join(root, "node_modules/.cache"); mkdirSync(cacheRoot, { recursive: true }); const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-artifact-revisions-")); const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/core-schemas/src/index.ts", "packages/action-catalog/src/index.ts", "packages/workspace-store/src/index.ts", "packages/runtime/src/index.ts", "scripts/fixtures/artifact-revisions.ts", "scripts/verify-artifact-revisions.mjs", "scripts/lib/core-evidence.mjs", "scripts/lib/verifier-assertions.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/artifact-revisions.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString(); const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim(); const result = JSON.parse(rawResult); const completedAt = new Date().toISOString(); const evidenceDir = path.join(root, "reports/core-completion/evidence"); mkdirSync(evidenceDir, { recursive: true });
  const assertions = [
    { name: "Immutable revision lineage", actual: result.revisions, expected: 3 },
    { name: "Stale base revision is rejected", actual: result.conflict_rejected, expected: true },
    { name: "Earlier revision restores as a new revision", actual: result.restored_revision, expected: true },
    { name: "Revision hashes differ and old revision redisplays", actual: result.hashes_unique && result.old_revision_redisplay, expected: true },
    { name: "Missing source repaired from verified blob", actual: result.missing_source_repaired, expected: true },
    { name: "Every revision and repair has Activity evidence", actual: result.activity_evidence, expected: 4 },
    { name: "Session-free mutations do not create Sessions", actual: result.session_count_unchanged, expected: true },
    { name: "Export/import preserves hashes", actual: result.export_import_hash_equal, expected: true }
  ];
  const failures = evaluateVerifierAssertions(assertions, result);
  writeFileSync(path.join(evidenceDir, "D07.json"), `${JSON.stringify({ schema_version: 1, test_id: "D07", command: "pnpm core:test:artifact", status: verifierEvidenceStatus(result, failures), ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt, assertions, ...(failures.length ? { failures } : {}), result }, null, 2)}\n`);
  reportVerifierFailures("D07", failures); process.stdout.write(`${rawResult}\n`);
} finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
