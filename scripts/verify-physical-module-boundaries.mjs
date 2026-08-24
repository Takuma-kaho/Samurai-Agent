import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const writeEvidence = process.argv.includes("--write-evidence");
const lineCount = (file) => readFileSync(path.join(root, file), "utf8").split("\n").length;
const sourceFiles = (directory) => {
  const files = [];
  for (const entry of readdirSync(path.join(root, directory))) {
    const relative = path.join(directory, entry), absolute = path.join(root, relative);
    if (statSync(absolute).isDirectory()) files.push(...sourceFiles(relative));
    else if (/\.(?:ts|tsx|vue)$/.test(entry) && !/\.test\./.test(entry) && !/\.d\.ts$/.test(entry)) files.push(relative);
  }
  return files;
};
const entrypoints = ["packages/runtime/src/index.ts", "packages/workspace-server/src/index.ts", "apps/server/src/index.ts", "apps/web/src/App.vue"];
const roots = ["packages/runtime/src", "packages/workspace-server/src", "apps/server/src", "apps/web/src"];
const allSources = roots.flatMap(sourceFiles);
const oversizedEntrypoints = entrypoints.map((file) => ({ file, lines: lineCount(file) })).filter((item) => item.lines > 500);
const normalModules = allSources.filter((file) => !entrypoints.includes(file) && !/(?:schema|migration)/i.test(path.basename(file)));
const largeModules = normalModules.map((file) => ({ file, lines: lineCount(file) })).filter((item) => item.lines > 1_200);
const requiredDirectories = [
  "packages/runtime/src/host", "packages/runtime/src/commands", "packages/runtime/src/execution", "packages/runtime/src/context", "packages/runtime/src/presentation", "packages/runtime/src/backend", "packages/runtime/src/learning",
  "packages/workspace-server/src",
  "apps/server/src/middleware", "apps/server/src/workers", "apps/server/src/composition",
  "apps/web/src/components", "apps/web/src/lib"
];
const missingDirectories = requiredDirectories.filter((directory) => !existsSync(path.join(root, directory)));
const result = { status: oversizedEntrypoints.length === 0 && missingDirectories.length === 0 ? "passed" : "partial", entrypoint_limit: 500, module_line_warning: 1200, entrypoints: entrypoints.map((file) => ({ file, lines: lineCount(file) })), oversized_entrypoints: oversizedEntrypoints, large_modules_advisory: largeModules, missing_directories: missingDirectories };
if (writeEvidence) {
  const now = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const evidenceSources = [...allSources, "scripts/verify-physical-module-boundaries.mjs", "scripts/lib/core-evidence.mjs"];
  writeFileSync(path.join(evidenceDir, "A01.json"), `${JSON.stringify({ schema_version: 1, test_id: "A01", command: "pnpm core:test:physical-boundaries -- --write-evidence", status: result.status, ...committedSourceEvidence(root, evidenceSources), started_at: now, completed_at: now, assertions: [{ name: "Entrypoints remain composition/export focused", actual: oversizedEntrypoints, expected: [] }, { name: "Required responsibility directories", actual: missingDirectories, expected: [] }], advisories: [{ name: "Large modules recorded for follow-up", actual: largeModules }], result }, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "passed") process.exitCode = 1;
