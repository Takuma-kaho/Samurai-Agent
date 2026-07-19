import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const platformPrefix = process.platform === "darwin"
  ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
  : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(platformPrefix));
if (!packageDir) throw new Error(`esbuild native package not found: ${platformPrefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-domain-ledger-"));
const output = path.join(temporaryRoot, "generate.mjs");

try {
  execFileSync(esbuild, [
    path.join(root, "scripts/generate-domain-contract-ledger.mjs"),
    "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [output], { cwd: root, env: process.env, stdio: "inherit" });
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
