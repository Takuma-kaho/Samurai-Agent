import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const mutationCall = /\bstore\.(save|update|delete|set|upsert|archive|apply|create|claim|revoke|rotate|repair|restore|reindex|prune|expire|requeue|release|mark|ack|fail|patch)[A-Z][A-Za-z0-9_]*\s*\(/g;
const runtimeMutationCall = /\bruntime\.(save|create|patch|delete|archive|restore|apply|run|reindex|approve|deny|reject|rotate|revoke|expire|repair|recreate|sync|dispatch|prepare|handle)[A-Z][A-Za-z0-9_]*\s*\(/g;
const allowedRuntimeEntrances = new Set([
  "runtime.runDomainCommand(",
  "runtime.runSurfaceOperation(",
  "runtime.runBackendToolBridgeCall(",
  "runtime.runDueAutomationJobs(",
  "runtime.syncBackendStream("
]);
const issues = [];

function sourceFiles(directory) {
  const absolute = path.join(root, directory);
  const files = [];
  for (const entry of readdirSync(absolute)) {
    const item = path.join(absolute, entry);
    const relative = path.relative(root, item);
    if (statSync(item).isDirectory()) files.push(...sourceFiles(relative));
    else if (/\.(ts|tsx|vue)$/.test(entry) && !/\.test\./.test(entry)) files.push(relative);
  }
  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

const server = "apps/server/src/api-server.ts";
const serverSource = readFileSync(path.join(root, server), "utf8");
for (const match of serverSource.matchAll(mutationCall)) {
  issues.push({ code: "server_route_direct_store_mutation", file: server, line: lineNumber(serverSource, match.index), value: match[0] });
}
for (const match of serverSource.matchAll(runtimeMutationCall)) {
  if (!allowedRuntimeEntrances.has(match[0])) {
    issues.push({ code: "server_direct_runtime_mutation_bypasses_command_bus", file: server, line: lineNumber(serverSource, match.index), value: match[0] });
  }
}

for (const file of sourceFiles("packages/learning/src")) {
  const source = readFileSync(path.join(root, file), "utf8");
  if (/@samurai-agent\/ui-protocol|apps\/web/.test(source)) issues.push({ code: "learning_depends_on_ui", file });
}
for (const file of [...sourceFiles("apps/web/src"), ...sourceFiles("packages/ui-protocol/src")]) {
  const source = readFileSync(path.join(root, file), "utf8");
  if (/@samurai-agent\/workspace-store|better-sqlite3|workspace\.sqlite/.test(source)) issues.push({ code: "renderer_depends_on_store", file });
}

if (issues.length) {
  process.stderr.write(`${JSON.stringify({ status: "failed", issues }, null, 2)}\n`);
  process.exit(1);
}

const result = { status: "passed", server_direct_store_mutations: 0, server_runtime_mutation_bypasses: 0, learning_ui_dependencies: 0, renderer_store_dependencies: 0 };
const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const evidenceSources = [server, ...sourceFiles("packages/learning/src"), ...sourceFiles("apps/web/src"), ...sourceFiles("packages/ui-protocol/src"), "scripts/verify-architecture-boundaries.mjs"];
const sourceHash = createHash("sha256").update(evidenceSources.map((file) => `${file}\0${readFileSync(path.join(root, file), "utf8")}`).join("\0")).digest("hex");
const worktreeClean = evidenceSources.every((file) => {
  try {
    return execFileSync("git", ["show", `HEAD:${file}`], { cwd: root }).equals(readFileSync(path.join(root, file)));
  } catch {
    return false;
  }
});
const now = new Date().toISOString();
const evidenceDir = path.join(root, "reports/core-completion/evidence");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(path.join(evidenceDir, "A07.json"), `${JSON.stringify({
  schema_version: 1, test_id: "A07", command: "pnpm core:test:boundaries", status: "passed",
  commit_sha: commitSha, worktree_clean: worktreeClean, source_sha256: sourceHash, source_files: evidenceSources, started_at: now, completed_at: now,
  assertions: [
    { name: "Server route direct Store mutations", actual: 0, expected: 0 },
    { name: "Server Runtime mutations bypassing Domain Command Bus", actual: 0, expected: 0 },
    { name: "Learning to UI dependencies", actual: 0, expected: 0 },
    { name: "Renderer to Store dependencies", actual: 0, expected: 0 }
  ], result
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
