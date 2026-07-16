import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.env.SAMURAI_REPO_ROOT ? path.resolve(process.env.SAMURAI_REPO_ROOT) : process.cwd();
const storeMutationVerbs = new Set(["save", "update", "delete", "set", "upsert", "archive", "apply", "create", "claim", "revoke", "rotate", "repair", "restore", "reindex", "prune", "expire", "requeue", "release", "mark", "ack", "fail", "patch"]);
const runtimeMutationVerbs = new Set(["save", "create", "patch", "delete", "archive", "restore", "apply", "run", "reindex", "approve", "deny", "reject", "rotate", "revoke", "expire", "repair", "recreate", "sync", "dispatch", "prepare", "handle"]);
const allowedRuntimeEntrances = new Set([
  "runDomainCommand", "runDomainQuery", "runCollectionManageCompatibility", "runSurfaceOperation",
  "runBackendToolBridgeCall", "runDueAutomationJobs", "syncBackendStream"
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

const serverFiles = sourceFiles("apps/server/src");
for (const server of serverFiles) {
  const serverSource = readFileSync(path.join(root, server), "utf8");
  const ast = parse(server, serverSource);
  inspectMutationCalls(ast, server, "store", storeMutationVerbs, "server_route_direct_store_mutation");
  inspectMutationCalls(ast, server, "runtime", runtimeMutationVerbs, "server_direct_runtime_mutation_bypasses_command_bus", allowedRuntimeEntrances);
}

for (const file of sourceFiles("packages/learning/src")) {
  const source = readFileSync(path.join(root, file), "utf8");
  if (importsOf(parse(file, source)).some((specifier) => specifier === "@samurai-agent/ui-protocol" || specifier.startsWith("apps/web"))) issues.push({ code: "learning_depends_on_ui", file });
}
for (const file of [...sourceFiles("apps/web/src"), ...sourceFiles("packages/ui-protocol/src")]) {
  const source = readFileSync(path.join(root, file), "utf8");
  const ast = parse(file, source);
  if (importsOf(ast).some((specifier) => specifier === "@samurai-agent/workspace-store" || specifier === "better-sqlite3")
    || stringLiterals(ast).includes("workspace.sqlite")) issues.push({ code: "renderer_depends_on_store", file });
}
for (const directory of ["packages/ui-protocol/src", "packages/agent-backends/src", "packages/gateway/src"]) {
  for (const file of sourceFiles(directory)) {
    const source = readFileSync(path.join(root, file), "utf8");
    const ast = parse(file, source);
    if (importsOf(ast).includes("@samurai-agent/workspace-store") || identifiers(ast).includes("WorkspaceStore")) issues.push({ code: "adapter_depends_on_store", file });
    inspectMutationCalls(ast, file, "store", storeMutationVerbs, "adapter_direct_store_mutation");
  }
}

if (issues.length) {
  process.stderr.write(`${JSON.stringify({ status: "failed", issues }, null, 2)}\n`);
  process.exit(1);
}

const result = { status: "passed", server_direct_store_mutations: 0, server_runtime_mutation_bypasses: 0, adapter_direct_store_mutations: 0, adapter_store_dependencies: 0, learning_ui_dependencies: 0, renderer_store_dependencies: 0 };
if (process.env.SAMURAI_EVIDENCE_MODE === "deferred") {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const evidenceSources = [...serverFiles, ...sourceFiles("packages/learning/src"), ...sourceFiles("apps/web/src"), ...sourceFiles("packages/ui-protocol/src"), ...sourceFiles("packages/agent-backends/src"), ...sourceFiles("packages/gateway/src"), "scripts/verify-architecture-boundaries.mjs"];
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
    { name: "Surface and Provider Adapter direct Store mutations", actual: 0, expected: 0 },
    { name: "Surface and Provider Adapter Store dependencies", actual: 0, expected: 0 },
    { name: "Learning to UI dependencies", actual: 0, expected: 0 },
    { name: "Renderer to Store dependencies", actual: 0, expected: 0 }
  ], result
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);

function parse(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function allNodes(rootNode) {
  const result = [];
  const visit = (node) => { result.push(node); ts.forEachChild(node, visit); };
  visit(rootNode);
  return result;
}

function importsOf(ast) {
  return allNodes(ast).filter((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)).map((node) => node.moduleSpecifier.text);
}

function identifiers(ast) {
  return allNodes(ast).filter(ts.isIdentifier).map((node) => node.text);
}

function stringLiterals(ast) {
  return allNodes(ast).filter(ts.isStringLiteral).map((node) => node.text);
}

function inspectMutationCalls(ast, file, receiver, verbs, code, allowed = new Set()) {
  for (const call of allNodes(ast).filter(ts.isCallExpression)) {
    if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== receiver) continue;
    const method = call.expression.name.text;
    const verb = [...verbs].find((candidate) => method.startsWith(candidate) && method.length > candidate.length && /[A-Z]/.test(method[candidate.length]));
    if (!verb || allowed.has(method)) continue;
    issues.push({ code, file, line: ast.getLineAndCharacterOfPosition(call.getStart()).line + 1, value: `${receiver}.${method}` });
  }
}
