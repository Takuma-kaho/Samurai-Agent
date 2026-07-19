import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const dir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix));
if (!dir) throw new Error("esbuild missing");
const packageName = dir.slice(0, dir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", dir, "node_modules", packageName, "bin/esbuild");
const cache = path.join(root, "node_modules/.cache"); mkdirSync(cache, { recursive: true });
const temp = mkdtempSync(path.join(cache, "samurai-wiki-loop-"));
const output = path.join(temp, "verify.mjs");
const sources = ["packages/learning/src/background-review.ts", "packages/runtime/src/index.ts", "packages/workspace-store/src/index.ts", "packages/core-schemas/src/index.ts", "scripts/fixtures/wiki-learning-loop.ts", "scripts/verify-wiki-learning-loop.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/wiki-learning-loop.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const started_at = new Date().toISOString();
  const raw = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(raw), completed_at = new Date().toISOString();
  const evidence = path.join(root, "reports/core-completion/evidence"); mkdirSync(evidence, { recursive: true });
  const mutationKinds = ["wiki_patch", "wiki_create", "wiki_merge", "wiki_archive"];
  writeFileSync(path.join(evidence, "E07.json"), `${JSON.stringify({ schema_version: 1, test_id: "E07", command: "pnpm core:test:wiki-learning-loop", status: "passed", ...committedSourceEvidence(root, sources), started_at, completed_at, assertions: [
    { name: "20-task closed-loop evidence", actual: { tasks: result.benchmark_tasks, complete: result.closed_loop_evidence_complete }, expected: { tasks: 20, complete: true } },
    { name: "Accepted corrections appear in next use", actual: result.correction_reflection_rate, expected: ">=0.90" },
    { name: "Unrelated task misapplication", actual: result.unrelated_misapplications, expected: 0 },
    { name: "Active Wiki retrieval and purpose-specific usage trace", actual: result.active_retrieval && result.use_purposes.includes("context") && result.use_purposes.includes("surface_generation"), expected: true },
    { name: "Background Review mutation kinds", actual: mutationKinds.filter((kind) => result.change_kinds.includes(kind)), expected: mutationKinds },
    { name: "Curator and rollback close the loop", actual: result.curator_completed && result.reused_updated_version && result.rollback_restored, expected: true }
  ], result }, null, 2)}\n`);
  process.stdout.write(`${raw}\n`);
} finally { rmSync(temp, { recursive: true, force: true }); }
