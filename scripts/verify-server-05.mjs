import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const reportDir = path.join(root, "reports", "server05-external-integration");
const reportPath = path.join(reportDir, "report.json");

const checks = [];
const requiredOperations = [
  "artifact.create", "artifact.revise", "artifact.restore_revision", "collection.schema.save", "collection.record.create", "collection.patch.apply",
  "collection.record.delete", "wiki.proposal.create", "wiki.patch", "wiki.archive", "skill.candidate.create", "skill.patch", "resource.copy",
  "resource.move", "resource.promote", "policy.change.request", "profile.change.request", "soul.change.request"
];

function read(file) { return readFileSync(path.join(root, file), "utf8"); }
function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: { ...process.env } });
  const passed = result.status === 0;
  checks.push({ label, passed, exit_code: result.status, output_tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-2_000) });
  return passed;
}

function staticBoundary() {
  const checksToRun = [
    ["external protocol has no database or filesystem dependency", "(?:from|require)\\s*[(\"'](?:pg|node:fs)", "packages/external-integration/src"],
    ["MCP workspace port has no direct persistence capability", "(?:options\\.store\\.(?:get|list|save|put|delete)|new\\s+Postgres)", "packages/runtime/src/external-app/mcp-workspace-port.ts"],
    ["automation operation rejects external ingress", "external_app", "packages/domain-operations/src/operations/automation/job/run.operation.ts"],
    ["memory review operation rejects external ingress", "external_app", "packages/domain-operations/src/operations/automation/memory_review/run.operation.ts"]
  ];
  for (const [label, pattern, target] of checksToRun) {
    const result = spawnSync("rg", ["-n", pattern, target], { cwd: root, encoding: "utf8" });
    const output = String(result.stdout ?? "").trim();
    checks.push({ label, passed: result.status === 1, exit_code: result.status, output_tail: output || "no forbidden direct dependency" });
  }
}

function contractCoverage() {
  const ingress = read("apps/server/src/adapters/external/postgres-external-app-ingress.ts");
  const integration = read("apps/server/src/adapters/external/postgres-external-integration.ts");
  const generated = read("packages/domain-operations/src/generated/operation-index.generated.ts");
  const missing = requiredOperations.filter((operation) => !ingress.includes(`case "${operation}"`) && !integration.includes(`"${operation}"`));
  checks.push({ label: "PostgreSQL formal ingress operation coverage", passed: missing.length === 0, exit_code: missing.length === 0 ? 0 : 1, output_tail: missing.length === 0 ? `${requiredOperations.length} operations connected` : `missing: ${missing.join(", ")}` });
  checks.push({ label: "generated operation catalog", passed: requiredOperations.every((operation) => generated.includes(`"${operation}"`)), exit_code: requiredOperations.every((operation) => generated.includes(`"${operation}"`)) ? 0 : 1, output_tail: "generated operation index checked" });
}

function sourceHash() {
  const files = [
    "apps/server/src/adapters/external/postgres-external-app-ingress.ts", "apps/server/src/adapters/external/postgres-external-integration.ts",
    "apps/server/src/adapters/external/postgres-external-integration-store.ts", "apps/server/src/workspace-server/http-server.ts",
    "packages/external-integration/src/mcp.ts", "packages/runtime/src/external-app/mcp-workspace-port.ts", "packages/domain-operations/src/generated/operation-index.generated.ts"
  ].filter((file) => existsSync(path.join(root, file)));
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(read(file)).update("\0");
  return { files, sha256: hash.digest("hex") };
}

function liveEvidenceStatus() {
  const required = ["SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_URL", "SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_URL"];
  const missing = required.filter((key) => !process.env[key]);
  return { status: missing.length === 0 ? "configured" : "unverified", missing };
}

async function main() {
  staticBoundary();
  contractCoverage();
  run("external integration typecheck", "pnpm", ["--filter", "@samurai-agent/external-integration", "run", "typecheck"]);
  run("server external integration contract tests", "pnpm", ["exec", "vitest", "run", "packages/external-integration/src/external-integration.test.ts", "apps/server/src/adapters/external/postgres-external-integration.test.ts"]);
  run("PostgreSQL schema and formal ingress tests", "pnpm", ["exec", "vitest", "run", "packages/workspace-server/src/schema.test.ts", "apps/server/src/adapters/runtime/postgres-gateway.test.ts"]);
  run("diff whitespace", "git", ["diff", "--check"]);
  const source = sourceHash();
  const live = liveEvidenceStatus();
  const implementationPass = checks.every((check) => check.passed);
  const report = {
    feature: "workspace-server-05-external-integration",
    status: implementationPass ? (live.status === "configured" ? "PASS" : "STATIC_PASS_LIVE_UNVERIFIED") : "FAIL",
    implementation_pass: implementationPass,
    live_evidence: live,
    generated_at: new Date().toISOString(),
    source_hash: source.sha256,
    source_file_count: source.files.length,
    checks
  };
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[Server05] ${report.status}`);
  if (!implementationPass) process.exitCode = 1;
}

main().catch((error) => {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({ feature: "workspace-server-05-external-integration", status: "FAIL", error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  console.error(`[Server05] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
