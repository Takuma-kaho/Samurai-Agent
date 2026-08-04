import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const platformPrefix = process.platform === "darwin"
  ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
  : `@esbuild+${process.platform}-${process.arch}@`;
const packageDirectory = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(platformPrefix));
if (!packageDirectory) throw new Error("esbuild missing");
const packageName = packageDirectory.slice(0, packageDirectory.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDirectory, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-signed-gateway-"));
const output = path.join(temporaryRoot, "verify.mjs");
const sources = [
  "apps/server/src/middleware/security.ts",
  "apps/server/src/index.ts",
  "packages/gateway/src/index.ts",
  "packages/runtime/src/index.ts",
  "packages/workspace-store/src/index.ts",
  "scripts/fixtures/signed-gateway-sandbox-flow.ts",
  "scripts/verify-signed-gateway-sandbox-flow.mjs",
  "scripts/lib/core-evidence.mjs"
];

try {
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/signed-gateway-sandbox-flow.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const raw = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } }).trim();
  const result = JSON.parse(raw);
  const coreFlowPassed = result.signature_verified
    && result.invalid_signature_rejected
    && result.docker_policy_executed
    && result.domain_command_executions === 1
    && result.workspace_inbound_saved === 1
    && result.metadata_does_not_grant_room_access
    && result.session_saved === false
    && result.reply_delivered;
  const status = coreFlowPassed ? "passed" : "partial";
  const completedAt = new Date().toISOString();
  const evidenceDirectory = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(path.join(evidenceDirectory, "F05.json"), `${JSON.stringify({
    schema_version: 1,
    test_id: "F05",
    command: "pnpm core:test:signed-gateway-sandbox",
    status,
    ...committedSourceEvidence(root, sources),
    started_at: startedAt,
    completed_at: completedAt,
    assertions: [
      { name: "Signed webhook verifies and invalid signature rejects", actual: result.signature_verified && result.invalid_signature_rejected, expected: true },
      { name: "Sandbox policy crosses configured adapter boundary", actual: result.docker_policy_executed, expected: true },
      { name: "Gateway crosses Domain Command, saves Workspace and delivers reply without metadata granting Room access", actual: result.domain_command_executions === 1 && result.workspace_inbound_saved === 1 && result.metadata_does_not_grant_room_access && result.session_saved === false && result.reply_delivered, expected: true }
    ],
    release_certification: {
      real_docker_required_for_core: false,
      real_docker_executed: result.real_docker_executed
    },
    result: { ...result, status }
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...result, status })}\n`);
  if (status !== "passed") process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
