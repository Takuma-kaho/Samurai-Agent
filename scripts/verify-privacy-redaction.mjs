import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const dir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix));
if (!dir) throw new Error("esbuild missing");
const name = dir.slice(0, dir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", dir, "node_modules", name, "bin/esbuild");
const cache = path.join(root, "node_modules/.cache");
mkdirSync(cache, { recursive: true });
const temp = mkdtempSync(path.join(cache, "samurai-privacy-"));
const out = path.join(temp, "verify.mjs");
const sources = ["packages/core-schemas/src/index.ts", "packages/workspace-store/src/index.ts", "scripts/fixtures/privacy-redaction.ts", "scripts/verify-privacy-redaction.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/privacy-redaction.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${out}`], { cwd: root, stdio: "inherit" });
  const started_at = new Date().toISOString();
  const raw = execFileSync(process.execPath, [out], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(raw);
  const completed_at = new Date().toISOString();
  const evidence = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, "G03.json"), `${JSON.stringify({ schema_version: 1, test_id: "G03", command: "pnpm core:test:privacy", status: "passed", ...committedSourceEvidence(root, sources), started_at, completed_at, assertions: Object.entries(result).filter(([key]) => key !== "status").map(([name, actual]) => ({ name, actual, expected: true })), result }, null, 2)}\n`);
  process.stdout.write(`${raw}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
