import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outputDir = path.join(root, ".tmp-core02-vitest");
const entries = [
  "packages/runtime/src/execution/run-state-machine.test.ts",
  "packages/runtime/src/execution/run-lifecycle.test.ts",
  "packages/runtime/src/execution/backend-event-journal.test.ts",
  "packages/runtime/src/execution/turn-executor.test.ts",
  "packages/runtime/src/execution/run-control.test.ts",
  "packages/runtime/src/execution/run-recovery.test.ts",
  "packages/runtime/src/execution/session-run-queue.test.ts",
  "packages/workspace-store/src/core02-admission.test.ts",
  "packages/workspace-store/src/core02-settlement.test.ts",
  "packages/workspace-store/src/core02-event-identity.test.ts"
];

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
const esbuild = nativeEsbuildPath();
execFileSync(esbuild, [
  ...entries,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--external:vitest",
  "--external:better-sqlite3",
  `--outdir=${outputDir}`,
  "--entry-names=[name]",
  "--out-extension:.js=.mjs"
], { cwd: root, stdio: "inherit" });
console.log(JSON.stringify({ ok: true, output_dir: path.relative(root, outputDir), entries: entries.length }));

function nativeEsbuildPath() {
  const packageRoot = path.join(root, "node_modules/.pnpm");
  const platformPrefix = process.platform === "darwin"
    ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
    : `@esbuild+${process.platform}-${process.arch}@`;
  const packageDir = readdirSync(packageRoot).find((entry) => entry.startsWith(platformPrefix));
  if (!packageDir) throw new Error(`core02_esbuild_native_package_missing:${platformPrefix}`);
  const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
  return path.join(packageRoot, packageDir, "node_modules", packageName, "bin", "esbuild");
}
