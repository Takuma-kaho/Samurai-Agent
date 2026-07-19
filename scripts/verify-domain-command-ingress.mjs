import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
import { execJsonChild } from "./lib/exec-json-child.mjs";

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
  "apps/server/src/api-server.ts",
  "apps/server/src/domain-ingress.ts",
  "scripts/fixtures/domain-command-ingress.ts",
  "scripts/verify-domain-command-ingress.mjs",
  "scripts/lib/core-evidence.mjs"
];

try {
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/domain-command-ingress.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  // Bundling makes api-server.ts appear to be the executable module.  Marking
  // the isolated fixture as a test prevents its production `startServer()`
  // main-entry hook from opening the repository's real workspace in parallel.
  const rawResult = execJsonChild(output, {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", SAMURAI_INGRESS_DEBUG: "1" }
  }).trim();
  const result = JSON.parse(rawResult);
  if (
    result.status !== "passed" ||
    !Array.isArray(result.entrances) ||
    result.entrances.length !== 6 ||
    result.result_parity !== true ||
    result.error_parity !== true ||
    result.artifact_operation_parity !== true ||
    !result.contract_fingerprint ||
    !result.rejection_parity ||
    result.rejection_parity.error?.code !== "validation" ||
    !Array.isArray(result.rejection_parity.entrances) ||
    result.rejection_parity.entrances.length !== 6 ||
    !result.rejection_parity.entrances.every((entrance) => entrance.handlerReached === false && entrance.artifactCommandSideEffects === 0) ||
    result.direct_store_mutation !== false ||
    !Array.isArray(result.workspace_change_telemetry) ||
    !result.workspace_change_telemetry.every((telemetry) => telemetry.allLinkedToRealBackendRuns === true)
  ) {
    throw new Error(`Domain Command ingress fixture did not prove all required invariants: ${JSON.stringify(result)}`);
  }
  const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "A02.json"), `${JSON.stringify({
    schema_version: 1,
    test_id: "A02",
    command: "pnpm core:test:command-ingress",
    status: "passed",
    ...committedSourceEvidence(root, sourceFiles),
    started_at: startedAt,
    completed_at: completedAt,
    assertions: [
      { name: "Six real entrances reach one Artifact Command binding", actual: result.entrances.length, expected: 6 },
      { name: "All entrances use the canonical contract fingerprint", actual: result.contract_fingerprint, expected: "non-empty" },
      { name: "Artifact and Operation semantic result parity", actual: result.artifact_operation_parity, expected: true },
      { name: "Success and error parity", actual: { result: result.result_parity, error: result.error_parity }, expected: { result: true, error: true } },
      { name: "Invalid artifact.create has the canonical validation code and is rejected before every Handler with no artifact side effect", actual: result.rejection_parity, expected: "validation and six zero-side-effect rejections" },
      { name: "WorkspaceChange telemetry links only to real BackendRuns", actual: result.workspace_change_telemetry, expected: "all linked" },
      { name: "Direct Store mutations", actual: result.direct_store_mutation, expected: false }
    ],
    result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
