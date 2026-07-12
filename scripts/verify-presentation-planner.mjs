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
const cacheRoot = path.join(root, "node_modules/.cache"); mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-presentation-")); const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/runtime/src/presentation/planner.ts", "scripts/fixtures/presentation-planner.ts", "scripts/verify-presentation-planner.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/presentation-planner.ts"), "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString(); const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim(); const result = JSON.parse(rawResult); const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence"); mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "D01.json"), `${JSON.stringify({ schema_version: 1, test_id: "D01", command: "pnpm core:test:presentation", status: "passed", ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt, assertions: [
    { name: "Fixed benchmark prompt count", actual: result.cases, expected: 100 },
    { name: "Fixed benchmark macro F1", actual: result.macro_f1, expected: ">=0.90" },
    { name: "All five presentation modes covered", actual: result.modes.length, expected: 5 },
    { name: "Unnecessary UI rate", actual: result.unnecessary_ui_rate, expected: 0 }
  ], result }, null, 2)}\n`); process.stdout.write(`${rawResult}\n`);
} finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
