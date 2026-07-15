import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { operationDefinitions } from "../../packages/domain-operations/src/index";

const root = process.cwd();
const operationRoot = path.join(root, "packages/domain-operations/src/operations");
const operationFiles = filesUnder(operationRoot).filter((file) => file.endsWith(".operation.ts"));
const operationIds = new Set(operationDefinitions.map((definition) => definition.id));
const issues: Array<{ gate: string; file: string; detail: string }> = [];
const moduleIds = new Set<string>();
const handlerNames = new Set<string>();

for (const file of operationFiles) {
  const relative = path.relative(root, file);
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const definitions = nodes(ast).filter((node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && (node.expression.text === "defineCommand" || node.expression.text === "defineQuery"));
  if (definitions.length !== 1) issues.push({ gate: "ST02", file: relative, detail: `definition_count:${definitions.length}` });
  for (const required of ["Input", "Output"]) {
    const count = nodes(ast).filter((node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === required).length;
    if (count !== 1) issues.push({ gate: "ST03", file: relative, detail: `${required}_count:${count}` });
  }
  if (!source.includes("createHandler")) issues.push({ gate: "ST03", file: relative, detail: "createHandler_missing" });
  const idMatch = source.match(/^[\t ]*["']?id["']?[\t ]*:[\t ]*["']([^"']+)["']/m);
  if (!idMatch) issues.push({ gate: "ST01", file: relative, detail: "operation_id_missing" });
  else if (moduleIds.has(idMatch[1]!)) issues.push({ gate: "ST01", file: relative, detail: `duplicate_module_id:${idMatch[1]}` });
  else moduleIds.add(idMatch[1]!);
  const handlers = nodes(ast).filter((node): node is ts.FunctionExpression => ts.isFunctionExpression(node) && Boolean(node.name));
  if (handlers.length !== 1) issues.push({ gate: "ST04", file: relative, detail: `named_handler_count:${handlers.length}` });
  for (const handler of handlers) {
    const name = handler.name!.text;
    if (handlerNames.has(name)) issues.push({ gate: "ST04", file: relative, detail: `handler_symbol_reused:${name}` });
    handlerNames.add(name);
  }
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (/@samurai-agent\/(runtime|workspace-store)|apps\/(server|web)/.test(specifier)) {
      issues.push({ gate: "ST08", file: relative, detail: `forbidden_import:${specifier}` });
    }
  }
  inspectForbiddenTypes(ast, relative, issues);
  if (source.includes("._def")) issues.push({ gate: "ST11", file: relative, detail: "zod_private_api" });
  for (const token of ["handler_id", "runtime_method", "query_service_id", "typedPortHandler"]) {
    if (source.includes(token)) issues.push({ gate: token === "typedPortHandler" ? "ST07" : "ST05", file: relative, detail: token });
  }
}

if (moduleIds.size !== operationIds.size || [...operationIds].some((id) => !moduleIds.has(id))) {
  issues.push({ gate: "ST01", file: path.relative(root, operationRoot), detail: `module_ids:${moduleIds.size}:active_ids:${operationIds.size}` });
}

const portRoot = path.join(root, "packages/runtime/src/domain-operation-ports");
const portFiles = filesUnder(portRoot).filter((file) => file.endsWith(".ts"));
const boundIds: string[] = [];
for (const file of portFiles) {
  const relative = path.relative(root, file);
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  inspectForbiddenTypes(ast, relative, issues);
  for (const literal of nodes(ast).filter(ts.isStringLiteral)) {
    if (operationIds.has(literal.text) && ts.isPropertyAssignment(literal.parent) && literal.parent.name === literal) boundIds.push(literal.text);
  }
  inspectRedispatch(ast, relative, operationIds, issues);
  if (/\.execute\s*\(/.test(source)) issues.push({ gate: "ST07", file: relative, detail: "generic_execute_forwarding" });
}
assert.equal(portFiles.length, 21);
if (boundIds.length !== 114 || new Set(boundIds).size !== 114) {
  issues.push({ gate: "ST06", file: path.relative(root, portRoot), detail: `bound_ids:${boundIds.length}:unique:${new Set(boundIds).size}` });
}

const compositionFile = path.join(root, "packages/runtime/src/domain-operation-composition.ts");
const compositionSource = readFileSync(compositionFile, "utf8");
if ([...operationIds].some((id) => compositionSource.includes(`"${id}"`))) {
  issues.push({ gate: "ST14", file: path.relative(root, compositionFile), detail: "composition_contains_operation_id" });
}

const runtimeFile = path.join(root, "packages/runtime/src/agent-runtime.ts");
const runtimeSource = readFileSync(runtimeFile, "utf8");
const runtimeAst = ts.createSourceFile(runtimeFile, runtimeSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
for (const literal of nodes(runtimeAst).filter(ts.isStringLiteral)) {
  if (!operationIds.has(literal.text)) continue;
  if (isDispatchOrBranchLiteral(literal)) {
    const line = runtimeAst.getLineAndCharacterOfPosition(literal.getStart()).line + 1;
    issues.push({ gate: "ST14", file: path.relative(root, runtimeFile), detail: `operation_dispatch_literal:${literal.text}:${line}` });
  }
}

const registryFile = path.join(root, "packages/domain-operations/src/registry/operation-registry.ts");
const registrySource = readFileSync(registryFile, "utf8");
const registryAst = ts.createSourceFile(registryFile, registrySource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const executeMethod = nodes(registryAst).find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "execute");
if (!executeMethod) issues.push({ gate: "RH12", file: path.relative(root, registryFile), detail: "execute_method_missing" });
else {
  const executeNodes = nodes(executeMethod);
  const mapLookups = executeNodes.filter((node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get").length;
  const scans = executeNodes.filter((node) => ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
    || (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["find", "filter", "forEach"].includes(node.expression.name.text))).length;
  if (mapLookups !== 2 || scans !== 0) issues.push({ gate: "RH12", file: path.relative(root, registryFile), detail: `map_lookups:${mapLookups}:scans:${scans}` });
}

const coreSchemaFile = path.join(root, "packages/core-schemas/src/index.ts");
const coreSchemaSource = readFileSync(coreSchemaFile, "utf8");
const conversionImports = [...coreSchemaSource.matchAll(/from\s+["']zod-to-json-schema["']/g)].length;
const conversionCalls = [...coreSchemaSource.matchAll(/\bzodToJsonSchema\s*\(/g)].length;
if (conversionImports !== 1 || conversionCalls !== 1) {
  issues.push({ gate: "CT07", file: path.relative(root, coreSchemaFile), detail: `imports:${conversionImports}:calls:${conversionCalls}` });
}
const productionPackageSources = readdirSync(path.join(root, "packages")).flatMap((packageName) => {
  const sourceDirectory = path.join(root, "packages", packageName, "src");
  return existsSync(sourceDirectory) ? filesUnder(sourceDirectory) : [];
});
for (const file of productionPackageSources.filter((entry) => entry.endsWith(".ts") && entry !== coreSchemaFile)) {
  const source = readFileSync(file, "utf8");
  if (/from\s+["']zod-to-json-schema["']|\bzodToJsonSchema\s*\(/.test(source)) {
    issues.push({ gate: "CT07", file: path.relative(root, file), detail: "schema_conversion_outside_shared_boundary" });
  }
}

verifyPackageDirection("packages/core-schemas/src", 0);
verifyPackageDirection("packages/domain-operations/src", 1);
verifyPackageDirection("packages/action-catalog/src", 2);
verifyPackageDirection("packages/runtime/src", 3);

if (issues.length > 0) {
  process.stderr.write(`${JSON.stringify({ status: "failed", issues }, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  gates: ["ST01", "ST02", "ST03", "ST04", "ST05", "ST06", "ST07", "ST08", "ST10", "ST11", "ST13", "ST14", "CT07", "RH12"],
  operation_modules: operationFiles.length,
  unique_handlers: handlerNames.size,
  capability_port_files: portFiles.length,
  bound_operations: boundIds.length
})}\n`);

function inspectForbiddenTypes(ast: ts.SourceFile, relative: string, output: typeof issues): void {
  for (const node of nodes(ast)) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) output.push({ gate: "ST10", file: relative, detail: "any_keyword" });
    if (ts.isAsExpression(node) && ts.isAsExpression(node.expression)) output.push({ gate: "ST10", file: relative, detail: "double_cast" });
    if (ts.isNonNullExpression(node)) output.push({ gate: "ST10", file: relative, detail: "non_null_assertion" });
  }
}

function inspectRedispatch(ast: ts.SourceFile, relative: string, ids: Set<string>, output: typeof issues): void {
  for (const node of nodes(ast)) {
    if (ts.isSwitchStatement(node) && nodes(node).some((child) => ts.isStringLiteral(child) && ids.has(child.text))) {
      output.push({ gate: "ST06", file: relative, detail: "operation_id_switch" });
    }
    if (ts.isBinaryExpression(node) && nodes(node).some((child) => ts.isStringLiteral(child) && ids.has(child.text))) {
      output.push({ gate: "ST06", file: relative, detail: "operation_id_comparison" });
    }
  }
}

function isDispatchOrBranchLiteral(literal: ts.StringLiteral): boolean {
  const parent = literal.parent;
  if (ts.isBinaryExpression(parent) || ts.isCaseClause(parent)) return true;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && ["command_id", "query_id"].includes(parent.name.text)) return true;
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    return ["runDomainCommand", "runDomainQuery", "runSurfaceDomainCommand"].includes(parent.expression.name.text);
  }
  return false;
}

function verifyPackageDirection(directory: string, rank: number): void {
  const ranks = new Map([["core-schemas", 0], ["domain-operations", 1], ["action-catalog", 2], ["runtime", 3]]);
  for (const file of filesUnder(path.join(root, directory)).filter((entry) => entry.endsWith(".ts"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+["']@samurai-agent\/([^"']+)["']/g)) {
      const importedRank = ranks.get(match[1]!);
      if (importedRank !== undefined && importedRank > rank) {
        issues.push({ gate: "ST13", file: path.relative(root, file), detail: `reverse_dependency:${match[1]}` });
      }
    }
  }
}

function nodes(rootNode: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node): void => { result.push(node); ts.forEachChild(node, visit); };
  visit(rootNode);
  return result;
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry);
    return statSync(file).isDirectory() ? filesUnder(file) : [file];
  });
}
