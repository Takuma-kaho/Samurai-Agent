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
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-command-ingress-"));
const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = [
  "packages/action-catalog/src/index.ts",
  "packages/runtime/src/index.ts",
  "packages/runtime/src/commands/domain-command-bus.ts",
  "packages/workspace-store/src/index.ts",
  "apps/server/src/index.ts",
  "apps/web/src/lib/api.ts",
  "apps/desktop/src/main.ts",
  "scripts/fixtures/domain-command-ingress.ts",
  "scripts/verify-domain-command-ingress.mjs",
  "scripts/lib/core-evidence.mjs"
];

try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/domain-command-ingress.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "A02.json"), `${JSON.stringify({
    schema_version: 1,
    test_id: "A02",
    command: "pnpm core:test:command-ingress",
    status: result.real_ingresses.length >= 5 && result.web_api_boundary && result.desktop_api_boundary && result.direct_server_mutations === 0 ? "passed" : "partial",
    ...committedSourceEvidence(root, sourceFiles),
    started_at: startedAt,
    completed_at: completedAt,
    assertions: [
      { name: "Five logical mutation entrances use Domain Command Bus", actual: result.real_ingresses.length, expected: 5 },
      { name: "Web mutation boundary uses Server API", actual: result.web_api_boundary, expected: true },
      { name: "Desktop mutation boundary uses Server API", actual: result.desktop_api_boundary, expected: true },
      { name: "Direct Server mutations", actual: result.direct_server_mutations, expected: 0 }
    ],
    result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
