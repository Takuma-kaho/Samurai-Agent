import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
import { evaluateVerifierAssertions, reportVerifierFailures, verifierEvidenceStatus } from "./lib/verifier-assertions.mjs";
const root = process.cwd(); const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix)); if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/"); const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild"); const cacheRoot = path.join(root, "node_modules/.cache"); mkdirSync(cacheRoot, { recursive: true }); const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-collection-safety-")); const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/core-schemas/src/index.ts", "packages/runtime/src/collections/safe-collection.ts", "scripts/fixtures/collection-safety.ts", "scripts/verify-collection-safety.mjs", "scripts/lib/core-evidence.mjs", "scripts/lib/verifier-assertions.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/collection-safety.ts"), "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString(); const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim(); const result = JSON.parse(rawResult); const completedAt = new Date().toISOString(); const evidenceDir = path.join(root, "reports/core-completion/evidence"); mkdirSync(evidenceDir, { recursive: true });
  const assertions = [
    { name: "Schema migration has parity across Human, Agent, and Generated Surface", actual: result.migration_sources, expected: ["human", "agent", "generated_surface"] },
    { name: "10,000 record migration", actual: result.migrated_records, expected: 10000 },
    { name: "No missing records or broken refs", actual: result.missing_records + result.broken_refs, expected: 0 },
    { name: "Rollback snapshot hash", actual: result.rollback_hash_equal, expected: true },
    { name: "Failed migration leaves input snapshot unchanged", actual: result.rollback_preserved, expected: true },
    { name: "Action cycles and duplicate actions are rejected", actual: result.action_cycle_rejected && result.duplicate_action_rejected, expected: true },
    { name: "Duplicate trigger runs one side effect", actual: result.duplicate_trigger_side_effects, expected: 1 },
    { name: "Runtime trigger recursion is rejected", actual: result.runtime_cycle_rejected, expected: true }
  ];
  const failures = evaluateVerifierAssertions(assertions, result);
  writeFileSync(path.join(evidenceDir, "D05.json"), `${JSON.stringify({ schema_version: 1, test_id: "D05", command: "pnpm core:test:collection-safety", status: verifierEvidenceStatus(result, failures), ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt, assertions, ...(failures.length ? { failures } : {}), result }, null, 2)}\n`); reportVerifierFailures("D05", failures); process.stdout.write(`${rawResult}\n`);
} finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
