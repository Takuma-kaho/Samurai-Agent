import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.env.SAMURAI_REPO_ROOT ? path.resolve(process.env.SAMURAI_REPO_ROOT) : process.cwd();
const readSource = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`domain_structure_source_read_failed:${path.relative(root, file)}`, { cause: error });
  }
};
const operationRoot = path.join(root, "packages/domain-operations/src/operations");
const operationFiles = filesUnder(operationRoot).filter((file) => file.endsWith(".operation.ts"));
const issues: Array<{ gate: string; file: string; detail: string }> = [];
const moduleIds = new Set<string>();
const handlerNames = new Set<string>();
const operationAsts = new Map<string, ts.SourceFile>();

for (const file of operationFiles) {
  const relative = path.relative(root, file);
  const source = readSource(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  operationAsts.set(file, ast);
  const definitions = nodes(ast).filter((node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && (node.expression.text === "defineCommand" || node.expression.text === "defineQuery"));
  if (definitions.length !== 1) issues.push({ gate: "ST02", file: relative, detail: `definition_count:${definitions.length}` });
  for (const required of ["Input", "Output"]) {
    const count = nodes(ast).filter((node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === required).length;
    if (count !== 1) issues.push({ gate: "ST03", file: relative, detail: `${required}_count:${count}` });
  }
  const inputDeclaration = nodes(ast).find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "Input");
  if (!inputDeclaration?.initializer || !containsCallNamed(inputDeclaration.initializer, "strict")) {
    issues.push({ gate: "CT03", file: relative, detail: "input_schema_not_strict" });
  }
  const createHandlers = nodes(ast).filter((node) => (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && propertyName(node.name) === "createHandler");
  if (createHandlers.length !== 1) issues.push({ gate: "ST03", file: relative, detail: `createHandler_count:${createHandlers.length}` });
  const idProperties = nodes(ast).filter((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && propertyName(node.name) === "id" && ts.isStringLiteral(node.initializer));
  const moduleId = idProperties[0]?.initializer.text;
  if (!moduleId) issues.push({ gate: "ST01", file: relative, detail: "operation_id_missing" });
  else if (moduleIds.has(moduleId)) issues.push({ gate: "ST01", file: relative, detail: `duplicate_module_id:${moduleId}` });
  else moduleIds.add(moduleId);
  const definitionKind = nodes(ast).some((node) => ts.isIdentifier(node) && node.text === "defineCommand") ? "command" : "query";
  const effects = nodes(ast).filter((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && propertyName(node.name) === "effect" && ts.isStringLiteral(node.initializer));
  if (definitionKind === "command" && effects.length !== 1) issues.push({ gate: "CT11", file: relative, detail: `explicit_effect_count:${effects.length}` });
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
    if (["@samurai-agent/runtime", "@samurai-agent/workspace-store"].includes(specifier) || specifier.startsWith("apps/server") || specifier.startsWith("apps/web")) {
      issues.push({ gate: "ST08", file: relative, detail: `forbidden_import:${specifier}` });
    }
  }
  inspectForbiddenTypes(ast, relative, issues);
  if (nodes(ast).some((node) => ts.isPropertyAccessExpression(node) && node.name.text === "_def")) issues.push({ gate: "ST11", file: relative, detail: "zod_private_api" });
  for (const token of ["handler_id", "runtime_method", "query_service_id", "typedPortHandler"]) {
    if (nodes(ast).some((node) => ts.isIdentifier(node) && node.text === token)) issues.push({ gate: token === "typedPortHandler" ? "ST07" : "ST05", file: relative, detail: token });
  }
}

const symbolHost = ts.createCompilerHost({ noEmit: true, noLib: true, noResolve: true });
symbolHost.getSourceFile = (file) => operationAsts.get(file);
symbolHost.fileExists = (file) => operationAsts.has(file);
symbolHost.readFile = (file) => operationAsts.get(file)?.text;
const symbolProgram = ts.createProgram([...operationAsts.keys()], { noEmit: true, noLib: true, noResolve: true }, symbolHost);
const checker = symbolProgram.getTypeChecker();
const handlerSymbols = new Set<ts.Symbol>();
for (const ast of operationAsts.values()) {
  for (const handler of nodes(ast).filter((node): node is ts.FunctionExpression => ts.isFunctionExpression(node) && Boolean(node.name))) {
    const symbol = handler.name ? checker.getSymbolAtLocation(handler.name) : undefined;
    if (!symbol) issues.push({ gate: "ST04", file: path.relative(root, ast.fileName), detail: "handler_symbol_unresolved" });
    else handlerSymbols.add(symbol);
  }
}
if (handlerSymbols.size !== operationFiles.length) {
  issues.push({ gate: "ST04", file: path.relative(root, operationRoot), detail: `unique_handler_symbols:${handlerSymbols.size}:operations:${operationFiles.length}` });
}

const generatedIndexFile = path.join(root, "packages/domain-operations/src/generated/operation-index.generated.ts");
const generatedIndexAst = ts.createSourceFile(generatedIndexFile, readSource(generatedIndexFile), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const generatedOperationFiles = new Set(nodes(generatedIndexAst)
  .filter((node): node is ts.ImportDeclaration => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
  .filter((node) => (node.moduleSpecifier as ts.StringLiteral).text.startsWith("../operations/"))
  .map((node) => (node.moduleSpecifier as ts.StringLiteral).text.replace("../operations/", "").replace(".operation.js", ".operation.ts")));
const activeOperationFiles = new Set(operationFiles.map((file) => path.relative(operationRoot, file).split(path.sep).join("/")));
const operationIds = new Set(moduleIds);

if (generatedOperationFiles.size !== activeOperationFiles.size || [...activeOperationFiles].some((file) => !generatedOperationFiles.has(file))) {
  issues.push({ gate: "ST01", file: path.relative(root, generatedIndexFile), detail: `generated_files:${generatedOperationFiles.size}:active_files:${activeOperationFiles.size}` });
}

const portRoot = path.join(root, "packages/runtime/src/domain-operation-ports");
const portFiles = filesUnder(portRoot).filter((file) => file.endsWith(".ts"));
const boundIds: string[] = [];
for (const file of portFiles) {
  const relative = path.relative(root, file);
  const source = readSource(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  inspectForbiddenTypes(ast, relative, issues);
  for (const assignment of nodes(ast).filter(ts.isPropertyAssignment)) {
    const name = propertyName(assignment.name);
    if (name && operationIds.has(name)) boundIds.push(name);
  }
  inspectRedispatch(ast, relative, operationIds, issues);
  if (hasGenericExecuteCall(ast)) issues.push({ gate: "ST07", file: relative, detail: "generic_execute_forwarding" });
}
assert.equal(portFiles.length, 21);
if (boundIds.length !== 114 || new Set(boundIds).size !== 114) {
  issues.push({ gate: "ST06", file: path.relative(root, portRoot), detail: `bound_ids:${boundIds.length}:unique:${new Set(boundIds).size}:operation_ids:${operationIds.size}` });
}

const compositionFile = path.join(root, "packages/runtime/src/domain-operation-composition.ts");
const compositionSource = readSource(compositionFile);
const compositionAst = ts.createSourceFile(compositionFile, compositionSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
if (nodes(compositionAst).some((node) => ts.isStringLiteral(node) && operationIds.has(node.text))) {
  issues.push({ gate: "ST14", file: path.relative(root, compositionFile), detail: "composition_contains_operation_id" });
}

const runtimeFile = path.join(root, "packages/runtime/src/agent-runtime.ts");
const runtimeSource = readSource(runtimeFile);
const runtimeAst = ts.createSourceFile(runtimeFile, runtimeSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
for (const literal of nodes(runtimeAst).filter(ts.isStringLiteral)) {
  if (!operationIds.has(literal.text)) continue;
  if (isDispatchOrBranchLiteral(literal)) {
    const line = runtimeAst.getLineAndCharacterOfPosition(literal.getStart()).line + 1;
    issues.push({ gate: "ST14", file: path.relative(root, runtimeFile), detail: `operation_dispatch_literal:${literal.text}:${line}` });
  }
}

const registryFile = path.join(root, "packages/domain-operations/src/registry/operation-registry.ts");
const registrySource = readSource(registryFile);
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
const outputValidationCalls = nodes(registryAst).filter((node) => ts.isCallExpression(node)
  && ts.isPropertyAccessExpression(node.expression)
  && node.expression.name.text === "safeParse"
  && ts.isPropertyAccessExpression(node.expression.expression)
  && node.expression.expression.name.text === "output");
if (outputValidationCalls.length !== 1) issues.push({ gate: "RH05", file: path.relative(root, registryFile), detail: `output_validation_calls:${outputValidationCalls.length}` });

const definitionFile = path.join(root, "packages/domain-operations/src/definition/index.ts");
const definitionAst = ts.createSourceFile(definitionFile, readSource(definitionFile), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const queryPorts = definitionAst.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === "DomainQueryPorts");
const queryWriteMembers = queryPorts?.members.filter((member) => ts.isMethodSignature(member) || ts.isCallSignatureDeclaration(member) || ts.isIndexSignatureDeclaration(member)) ?? [];
if (!queryPorts || queryWriteMembers.length !== 0) {
  issues.push({ gate: "ST09", file: path.relative(root, definitionFile), detail: `query_write_members:${queryWriteMembers.length}` });
}

const coreSchemaFile = path.join(root, "packages/core-schemas/src/index.ts");
const coreSchemaSource = readSource(coreSchemaFile);
const coreSchemaAst = ts.createSourceFile(coreSchemaFile, coreSchemaSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const conversionImports = nodes(coreSchemaAst).filter((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "zod-to-json-schema").length;
const conversionCalls = nodes(coreSchemaAst).filter((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "zodToJsonSchema").length;
if (conversionImports !== 1 || conversionCalls !== 1) {
  issues.push({ gate: "CT07", file: path.relative(root, coreSchemaFile), detail: `imports:${conversionImports}:calls:${conversionCalls}` });
}
const catalogProjectionFile = path.join(root, "packages/action-catalog/src/domain-catalog-projection.ts");
const catalogProjectionAst = ts.createSourceFile(catalogProjectionFile, readSource(catalogProjectionFile), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const inputSchemaProjection = nodes(catalogProjectionAst).filter((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node)
  && propertyName(node.name) === "input_schema"
  && ts.isPropertyAccessExpression(node.initializer)
  && ts.isIdentifier(node.initializer.expression)
  && node.initializer.expression.text === "entry"
  && node.initializer.name.text === "input_schema");
if (inputSchemaProjection.length !== 1) {
  issues.push({ gate: "CT07", file: path.relative(root, catalogProjectionFile), detail: `input_schema_projection_count:${inputSchemaProjection.length}` });
}
const productionPackageSources = readdirSync(path.join(root, "packages")).flatMap((packageName) => {
  const sourceDirectory = path.join(root, "packages", packageName, "src");
  return existsSync(sourceDirectory) ? filesUnder(sourceDirectory) : [];
});
for (const file of productionPackageSources.filter((entry) => entry.endsWith(".ts") && entry !== coreSchemaFile)) {
  const source = readSource(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  if (nodes(ast).some((node) => (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "zod-to-json-schema")
    || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "zodToJsonSchema"))) {
    issues.push({ gate: "CT07", file: path.relative(root, file), detail: "schema_conversion_outside_shared_boundary" });
  }
}

verifyPackageDirection("packages/core-schemas/src", 0);
verifyPackageDirection("packages/domain-operations/src", 1);
verifyPackageDirection("packages/action-catalog/src", 2);
verifyPackageDirection("packages/runtime/src", 3);

const serviceRoot = path.join(root, "packages/runtime/src/commands/services");
const serviceFiles = filesUnder(serviceRoot).filter((file) => file.endsWith(".ts"));
for (const file of serviceFiles) {
  const relative = path.relative(root, file);
  const source = readSource(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  inspectForbiddenTypes(ast, relative, issues);
  inspectRedispatch(ast, relative, operationIds, issues);
  if (hasGenericExecuteCall(ast)) issues.push({ gate: "ST07", file: relative, detail: "generic_execute_forwarding" });
  if (nodes(ast).some((node) => ts.isPropertyAccessExpression(node) && node.name.text === "_def")) issues.push({ gate: "ST11", file: relative, detail: "zod_private_api" });
}

if (issues.length > 0) {
  process.stderr.write(`${JSON.stringify({ status: "failed", issues }, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  gates: ["ST01", "ST02", "ST03", "ST04", "ST05", "ST06", "ST07", "ST08", "ST09", "ST10", "ST11", "ST13", "ST14", "CT03", "CT07", "CT11", "RH05", "RH12"],
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
    const source = readSource(file);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    for (const declaration of nodes(ast).filter((node): node is ts.ImportDeclaration => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))) {
      const specifier = (declaration.moduleSpecifier as ts.StringLiteral).text;
      const importedRank = ranks.get(specifier.startsWith("@samurai-agent/") ? specifier.slice("@samurai-agent/".length) : "");
      if (importedRank !== undefined && importedRank > rank) {
        issues.push({ gate: "ST13", file: path.relative(root, file), detail: `reverse_dependency:${specifier}` });
      }
    }
  }
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function hasGenericExecuteCall(ast: ts.SourceFile): boolean {
  return nodes(ast).some((node) => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "execute");
}

function containsCallNamed(node: ts.Node, name: string): boolean {
  return nodes(node).some((child) => ts.isCallExpression(child)
    && ts.isPropertyAccessExpression(child.expression)
    && child.expression.name.text === name);
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
