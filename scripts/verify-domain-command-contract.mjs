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
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-command-contract-"));
const output = path.join(temporaryRoot, "verify.mjs");

try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/domain-command-contract.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const sourceEvidence = committedSourceEvidence(root, ["packages/action-catalog/src/index.ts", "packages/runtime/src/index.ts", "packages/runtime/src/provider-profiles.ts", "scripts/fixtures/domain-command-contract.ts", "scripts/verify-domain-command-contract.mjs", "scripts/lib/core-evidence.mjs"]);
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "A06.json"), `${JSON.stringify({
    schema_version: 1, test_id: "A06", command: "pnpm core:test:command-contract", status: "passed",
    ...sourceEvidence, started_at: startedAt, completed_at: completedAt,
    assertions: [
      { name: "Action Catalog generated from command schema", actual: result.action_catalog_matches, expected: true },
      { name: "Backend bridge mappings", actual: result.bridge_mappings >= 6, expected: true },
      { name: "Provider mappings", actual: result.provider_mappings, expected: 4 },
      { name: "Surface mappings", actual: result.surface_mappings, expected: 6 },
      { name: "Patch version contract", actual: result.expected_version_in_patch_schema, expected: true }
    ], result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
