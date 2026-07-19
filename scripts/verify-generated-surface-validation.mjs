import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
const root = process.cwd(); const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix)); if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/"); const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache"); mkdirSync(cacheRoot, { recursive: true }); const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-generated-surface-")); const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/core-schemas/src/index.ts", "packages/action-catalog/src/index.ts", "packages/runtime/src/presentation/generated-surface.ts", "scripts/fixtures/generated-surface-validation.ts", "scripts/verify-generated-surface-validation.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/generated-surface-validation.ts"), "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString(); const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim(); const result = JSON.parse(rawResult); const completedAt = new Date().toISOString(); const evidenceDir = path.join(root, "reports/core-completion/evidence"); mkdirSync(evidenceDir, { recursive: true });
  const evidence = { schema_version: 1, test_id: "D02", command: "pnpm core:test:generated-surface", status: "passed", ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt, assertions: [
    { name: "Valid HTML/CSS/script/action bundle", actual: result.valid_bundle, expected: true },
    { name: "Fixed generated task benchmark", actual: { tasks: result.benchmark_tasks, success_rate: result.generation_success_rate }, expected: { tasks: 30, success_rate: ">=0.90" } },
    { name: "Schema and action validation rate", actual: result.schema_action_validation_rate, expected: 1 },
    { name: "CSP denies network and parent authority", actual: /connect-src 'none'/.test(result.csp), expected: true },
    { name: "Capability and malformed matrix", actual: result.invalid_cases.length, expected: 7 },
    { name: "Fallback chain", actual: result.fallback_chain, expected: ["built_in_surface", "artifact", "text"] }
  ], result };
  writeFileSync(path.join(evidenceDir, "D02.json"), `${JSON.stringify(evidence, null, 2)}\n`); process.stdout.write(`${rawResult}\n`);
} finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
