import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.env.SAMURAI_REPO_ROOT ? path.resolve(process.env.SAMURAI_REPO_ROOT) : process.cwd();
const storeMutationVerbs = new Set(["save", "update", "delete", "set", "upsert", "archive", "apply", "create", "claim", "revoke", "rotate", "repair", "restore", "reindex", "prune", "expire", "requeue", "release", "mark", "ack", "fail", "patch"]);
const runtimeMutationVerbs = new Set(["save", "create", "patch", "delete", "archive", "restore", "apply", "run", "reindex", "approve", "deny", "reject", "rotate", "revoke", "expire", "repair", "recreate", "sync", "dispatch", "prepare", "handle"]);
const workspaceServerStoreMutationVerbs = new Set(["register", "accept", "put"]);
const workspaceServerFileMutationVerbs = new Set(["write"]);
const workspaceServerBundleMutationVerbs = new Set(["import", "stage", "put", "complete", "begin", "record", "rollback"]);
const allowedRuntimeEntrances = new Set([
  "runDomainCommand", "runDomainQuery", "runCollectionManageCompatibility", "runSurfaceOperation",
  "runBackendToolBridgeCall", "runDueAutomationJobs", "syncBackendStream", "runGeneratedSurfaceAction"
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
  inspectMutationCallsWithAliases(ast, server, "store", storeMutationVerbs, "server_route_direct_store_mutation");
  inspectMutationCallsWithAliases(ast, server, "runtime", runtimeMutationVerbs, "server_direct_runtime_mutation_bypasses_command_bus", allowedRuntimeEntrances);
  if (server === "apps/server/src/workspace-server/http-server.ts") {
    inspectMutationCallsWithAliases(ast, server, "store", workspaceServerStoreMutationVerbs, "workspace_server_http_direct_store_mutation");
    inspectMutationCallsWithAliases(ast, server, "files", workspaceServerFileMutationVerbs, "workspace_server_http_direct_file_mutation");
    inspectMutationCallsWithAliases(ast, server, "bundles", workspaceServerBundleMutationVerbs, "workspace_server_http_direct_bundle_mutation");
  }
}

for (const file of sourceFiles("packages/learning/src")) {
  const source = readFileSync(path.join(root, file), "utf8");
  if (importsOf(parse(file, source)).some((specifier) => specifier === "@samurai-agent/ui-protocol" || specifier.startsWith("apps/web"))) issues.push({ code: "learning_depends_on_ui", file });
}
for (const file of [...sourceFiles("apps/web/src"), ...sourceFiles("packages/ui-protocol/src")]) {
  const source = readFileSync(path.join(root, file), "utf8");
  const ast = parse(file, source);
  if (importsOf(ast).some((specifier) => specifier === "pg" || specifier === "@samurai-agent/workspace-server")) issues.push({ code: "renderer_depends_on_database", file });
}
for (const directory of ["packages/ui-protocol/src", "packages/agent-backends/src", "packages/gateway/src"]) {
  for (const file of sourceFiles(directory)) {
    const source = readFileSync(path.join(root, file), "utf8");
    const ast = parse(file, source);
    if (importsOf(ast).includes("pg") || identifiers(ast).includes("PostgresWorkspaceDatabase")) issues.push({ code: "adapter_depends_on_database", file });
    inspectMutationCallsWithAliases(ast, file, "store", storeMutationVerbs, "adapter_direct_store_mutation");
  }
}

if (issues.length) {
  process.stderr.write(`${JSON.stringify({ status: "failed", issues }, null, 2)}\n`);
  process.exit(1);
}

const result = { status: "passed", server_direct_store_mutations: 0, workspace_server_http_direct_mutations: 0, server_runtime_mutation_bypasses: 0, adapter_direct_store_mutations: 0, adapter_store_dependencies: 0, learning_ui_dependencies: 0, renderer_store_dependencies: 0 };
if (process.env.SAMURAI_EVIDENCE_MODE === "deferred") {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const evidenceSources = [...serverFiles, ...sourceFiles("packages/learning/src"), ...sourceFiles("apps/web/src"), ...sourceFiles("packages/ui-protocol/src"), ...sourceFiles("packages/agent-backends/src"), ...sourceFiles("packages/gateway/src"), "scripts/verify-architecture-boundaries.mjs"];
const sourceHash = createHash("sha256").update(evidenceSources.map((file) => `${file}\0${readFileSync(path.join(root, file), "utf8")}`).join("\0")).digest("hex");
const worktreeClean = evidenceSources.every((file) => {
  try {
    return execFileSync("git", ["show", `HEAD:${file}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"]
    }).equals(readFileSync(path.join(root, file)));
  } catch {
    return false;
  }
});
// Boundary verification is intentionally read-only. A verifier must not
// rewrite tracked Evidence because that would make a stale or locally dirty
// report look like proof for the current source tree. CI may persist this
// stdout as an artifact when it needs a durable record.
process.stdout.write(`${JSON.stringify({
  ...result,
  test_id: "A07",
  command: "pnpm core:test:boundaries",
  commit_sha: commitSha,
  worktree_clean: worktreeClean,
  source_sha256: sourceHash,
  source_files: evidenceSources
})}\n`);

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

// Boundary checks must follow the object, not just one spelling of it. A
// route can hide a Store behind `this.store`, a local alias, destructuring, or
// a small wrapper and still bypass the command bus. This is intentionally a
// conservative, syntax-only dataflow check: it catches writes without trying
// to infer arbitrary application types.
function inspectMutationCallsWithAliases(ast, file, receiver, verbs, code, allowed = new Set()) {
  const aliases = new Set([receiver]);
  const mutationAliases = new Set();
  const isStoreRoot = (node) => ts.isPropertyAccessExpression(node)
    && ts.isThis(node.expression) && node.name.text === receiver;
  const isAliasRoot = (node) => ts.isIdentifier(node) && aliases.has(node.text);
  const isMutationMethod = (name) => [...verbs].some((candidate) => name.startsWith(candidate)
    && name.length > candidate.length && /[A-Z]/.test(name[candidate.length]));
  const propertyReceiver = (node) => ts.isPropertyAccessExpression(node)
    && (isAliasRoot(node.expression) || isStoreRoot(node.expression) || (ts.isPropertyAccessExpression(node.expression)
      && ts.isThis(node.expression.expression) && node.expression.name.text === receiver));

  // Resolve aliases and method references to a fixed point so wrappers such
  // as `const save = this.store.saveArtifact` are still observable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of allNodes(ast).filter((node) => ts.isVariableDeclaration(node))) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = declaration.initializer;
      if (isStoreRoot(value) || isAliasRoot(value)
        || (ts.isPropertyAccessExpression(value) && value.name.text === receiver)) {
        if (!aliases.has(declaration.name.text)) { aliases.add(declaration.name.text); changed = true; }
      }
      if (ts.isPropertyAccessExpression(value) && (isAliasRoot(value.expression) || isStoreRoot(value.expression)) && isMutationMethod(value.name.text)) {
        if (!mutationAliases.has(declaration.name.text)) { mutationAliases.add(declaration.name.text); changed = true; }
      }
    }
    for (const declaration of allNodes(ast).filter((node) => ts.isVariableDeclaration(node))) {
      if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer) continue;
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const property = element.propertyName ? element.propertyName.getText(ast) : element.name.text;
        if (property === receiver && !aliases.has(element.name.text)) { aliases.add(element.name.text); changed = true; }
      }
    }
  }

  for (const call of allNodes(ast).filter((node) => ts.isCallExpression(node))) {
    if (ts.isIdentifier(call.expression) && mutationAliases.has(call.expression.text)) {
      issues.push({ code, file, line: ast.getLineAndCharacterOfPosition(call.getStart()).line + 1, value: `${call.expression.text}()` });
      continue;
    }
    if (!ts.isPropertyAccessExpression(call.expression) || !isMutationMethod(call.expression.name.text)) continue;
    if (allowed.has(call.expression.name.text)) continue;
    if (propertyReceiver(call.expression)) {
      issues.push({ code, file, line: ast.getLineAndCharacterOfPosition(call.getStart()).line + 1, value: `${receiver}.${call.expression.name.text}` });
      continue;
    }
    // A wrapper parameter that performs a write is unsafe when called from a
    // boundary with the Store alias. The call-site check below links the two.
    const owner = enclosingFunction(call);
    if (!owner) continue;
    const target = call.expression.expression;
    if (!ts.isIdentifier(target)) continue;
    const parameter = owner.parameters.some((item) => ts.isIdentifier(item.name) && item.name.text === target.text);
    if (!parameter) continue;
    for (const wrapperCall of allNodes(ast).filter((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression))) {
      const ownerName = functionName(owner);
      const index = ownerName ? wrapperCall.expression.text === ownerName
        ? owner.parameters.findIndex((item) => ts.isIdentifier(item.name) && item.name.text === target.text) : -1 : -1;
      if (index >= 0 && wrapperCall.arguments[index] && (isAliasRoot(wrapperCall.arguments[index]) || isStoreRoot(wrapperCall.arguments[index]))) {
        issues.push({ code, file, line: ast.getLineAndCharacterOfPosition(wrapperCall.getStart()).line + 1, value: `${wrapperCall.expression.text}(${target.text})` });
      }
    }
  }
}

function functionName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)
    && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current) || ts.isMethodDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}
