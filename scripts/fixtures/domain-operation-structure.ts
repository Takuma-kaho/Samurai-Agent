import assert from "node:assert/strict";
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.env.SAMURAI_REPO_ROOT ? path.resolve(process.env.SAMURAI_REPO_ROOT) : process.cwd();
const readSource = (file: string): string => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const size = fstatSync(descriptor).size;
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(descriptor, buffer, offset, size - offset, null);
      if (bytesRead === 0) throw new Error("unexpected_eof");
      offset += bytesRead;
    }
    return buffer.toString("utf8");
  } catch (error) {
    throw new Error(`domain_structure_source_read_failed:${path.relative(root, file)}`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
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
  if (!inputDeclaration?.initializer || (!containsCallNamed(inputDeclaration.initializer, "strict")
    && !isImportedSharedValueSchema(inputDeclaration.initializer, ast))) {
    issues.push({ gate: "CT03", file: relative, detail: "input_schema_not_strict" });
  }
  const createHandlers = nodes(ast).filter((node) => (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && propertyName(node.name) === "createHandler");
  if (createHandlers.length !== 1) issues.push({ gate: "ST03", file: relative, detail: `createHandler_count:${createHandlers.length}` });
  const idProperties = nodes(ast).filter((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && propertyName(node.name) === "id" && ts.isStringLiteral(node.initializer));
  const moduleId = idProperties[0]?.initializer.text;
  if (!moduleId) issues.push({ gate: "ST01", file: relative, detail: "operation_id_missing" });
  else if (moduleIds.has(moduleId)) issues.push({ gate: "ST01", file: relative, detail: `duplicate_module_id:${moduleId}` });
  else moduleIds.add(moduleId);
  if (moduleId) inspectCriticalInputContracts(ast, moduleId, relative, issues);
  const definitionKind = nodes(ast).some((node) => ts.isIdentifier(node) && node.text === "defineCommand") ? "command" : "query";
  if (definitionKind === "query") {
    const portInterface = ast.statements.find((statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text.endsWith("Ports"));
    const extendsQuery = portInterface?.heritageClauses?.some((clause) =>
      clause.types.some((type) => type.expression.getText(ast) === "DomainQueryPorts"));
    if (!portInterface || !extendsQuery) {
      issues.push({ gate: "QP01", file: relative, detail: "query_ports_missing_read_capability" });
    }
    if (source.includes("DomainWritePorts") || source.includes("domainWriteCapability")) {
      issues.push({ gate: "QP01", file: relative, detail: "query_ports_write_capability_import" });
    }
    for (const member of portInterface?.members ?? []) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const typeText = member.type.getText(ast);
      if (typeText.includes("ReadCapability") || typeText.includes("[domainQueryReadCapability]")) continue;
      issues.push({ gate: "QP01", file: relative, detail: `query_port_not_read_capability:${member.name.getText(ast)}` });
    }
    if (ast.statements.some((statement) => ts.isImportDeclaration(statement) && statement.moduleSpecifier.getText(ast).includes("runtime"))) {
      issues.push({ gate: "QP01", file: relative, detail: "query_ports_runtime_import" });
    }
  }
  const effects = nodes(ast).filter((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && propertyName(node.name) === "effect" && ts.isStringLiteral(node.initializer));
  if (definitionKind === "command" && effects.length !== 1) issues.push({ gate: "CT11", file: relative, detail: `explicit_effect_count:${effects.length}` });
  const handlers = nodes(ast).filter((node): node is ts.FunctionExpression => ts.isFunctionExpression(node) && Boolean(node.name));
  if (handlers.length !== 1) issues.push({ gate: "ST04", file: relative, detail: `named_handler_count:${handlers.length}` });
  for (const handler of handlers) {
    const name = handler.name!.text;
    if (handlerNames.has(name)) issues.push({ gate: "ST04", file: relative, detail: `handler_symbol_reused:${name}` });
    handlerNames.add(name);
    if (isGenericPortForwardingHandler(handler)) {
      issues.push({ gate: "ST07", file: relative, detail: `direct_port_forwarding_handler:${name}` });
    }
    if (hasHiddenIngressSourceRedispatch(ast, handler)) {
      issues.push({ gate: "IN01", file: relative, detail: `hidden_ingress_source_redispatch:${moduleId ?? "unknown"}:${name}` });
    }
    if (hasLegacyIngressEscape(handler)) {
      issues.push({ gate: "IN03", file: relative, detail: `legacy_ingress_escape:${moduleId ?? "unknown"}:${name}` });
    }
  }
  inspectOperationPortDtoTypes(ast, relative, issues);
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
    if (name && operationIds.has(name)) {
      boundIds.push(name);
    }
  }
  inspectRedispatch(ast, relative, operationIds, issues, true);
  if (hasGenericForwarder(ast)) issues.push({ gate: "ST07", file: relative, detail: "generic_execute_forwarding" });
}
if (portFiles.length === 0) {
  issues.push({ gate: "ST06", file: path.relative(root, portRoot), detail: "capability_port_modules_missing" });
}
if (boundIds.length !== operationIds.size || new Set(boundIds).size !== operationIds.size || [...operationIds].some((id) => !boundIds.includes(id))) {
  issues.push({ gate: "ST06", file: path.relative(root, portRoot), detail: `bound_ids:${boundIds.length}:unique:${new Set(boundIds).size}:operation_ids:${operationIds.size}` });
}

const compositionFile = path.join(root, "packages/runtime/src/domain-operation-composition.ts");
const compositionSource = readSource(compositionFile);
const compositionAst = ts.createSourceFile(compositionFile, compositionSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
if (nodes(compositionAst).some((node) => ts.isStringLiteral(node) && operationIds.has(node.text))) {
  issues.push({ gate: "ST14", file: path.relative(root, compositionFile), detail: "composition_contains_operation_id" });
}
const queryOperationIds = new Set([...operationAsts.entries()]
  .filter(([, ast]) => nodes(ast).some((node) => ts.isIdentifier(node) && node.text === "defineQuery"))
  .flatMap(([, ast]) => [...nodes(ast)].flatMap((node) => ts.isPropertyAssignment(node) && propertyName(node.name) === "id" && ts.isStringLiteral(node.initializer) ? [node.initializer.text] : [])));
const queryPortAssignments: ts.PropertyAssignment[] = [];
for (const file of portFiles) {
  const ast = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  for (const assignment of nodes(ast).filter(ts.isPropertyAssignment)) {
    if (queryOperationIds.has(propertyName(assignment.name) ?? "")) queryPortAssignments.push(assignment);
  }
}
const queryPortFilesWithFactory = new Set(queryPortAssignments
  .filter((assignment) => nodes(assignment.initializer).some((node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === "readOnlyQueryPort"))
  .map((assignment) => assignment.getSourceFile().fileName));
const compositionUsesPostHocQueryBrand = nodes(compositionAst).some((node) => ts.isIdentifier(node)
  && (node.text === "markQuery" || node.text === "readOnlyQueryPort")) || /\bas\s+never\b/.test(compositionSource);
if (!nodes(compositionAst).some((node) => ts.isIdentifier(node) && node.text === "domainQueryIds")
  || queryPortAssignments.length !== queryOperationIds.size
  || queryPortFilesWithFactory.size === 0
  || queryPortAssignments.some((assignment) => !nodes(assignment.initializer).some((node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === "readOnlyQueryPort"))
  || compositionUsesPostHocQueryBrand) {
  issues.push({ gate: "QP01", file: path.relative(root, compositionFile), detail: `query_ports_factory_bound:${queryPortAssignments.length}:${queryOperationIds.size}:posthoc_brand:${compositionUsesPostHocQueryBrand}` });
}

const runtimeFile = path.join(root, "packages/runtime/src/agent-runtime.ts");
const runtimeSource = readSource(runtimeFile);
const runtimeAst = ts.createSourceFile(runtimeFile, runtimeSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
for (const call of nodes(runtimeAst).filter(ts.isCallExpression)) {
  if (ts.isIdentifier(call.expression) && call.expression.text === "domainOperationIdFor") {
    issues.push({ gate: "ST14", file: path.relative(root, runtimeFile), detail: "runtime_generated_operation_key_lookup" });
  }
}
for (const access of nodes(runtimeAst).filter(ts.isPropertyAccessExpression)) {
  if (ts.isIdentifier(access.expression) && ["domainOperationClient", "domainOperationIds"].includes(access.expression.text)) {
    issues.push({ gate: "ST14", file: path.relative(root, runtimeFile), detail: `runtime_generated_operation_property:${access.name.text}` });
  }
}
for (const literal of nodes(runtimeAst).filter(ts.isStringLiteral)) {
  if (!operationIds.has(literal.text)) continue;
  if (isDispatchOrBranchLiteral(literal)) {
    const line = runtimeAst.getLineAndCharacterOfPosition(literal.getStart()).line + 1;
    issues.push({ gate: "ST14", file: path.relative(root, runtimeFile), detail: `operation_dispatch_literal:${literal.text}:${line}` });
  }
}

// Provider/tool composition is a boundary, not a second operation registry.
// It may consume catalog entries, but it must not resolve operation IDs by
// name (including through aliases/helpers or a Map/object/result/resource
// table).  This scan deliberately covers the provider composition modules
// only; Runtime's canonical domain API may still construct typed requests.
for (const file of [
  path.join(root, "packages/runtime/src/provider-tool-bridge-composition.ts"),
  path.join(root, "packages/runtime/src/provider-plan-composition.ts")
]) {
  if (!existsSync(file)) continue;
  const relative = path.relative(root, file);
  const source = readSource(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const operationLookupNames = new Set(["domainOperationIdFor"]);
  for (const declaration of ast.statements.filter(ts.isImportDeclaration)) {
    const bindings = declaration.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.propertyName?.text === "domainOperationIdFor") operationLookupNames.add(element.name.text);
    }
  }
  for (const call of nodes(ast).filter(ts.isCallExpression)) {
    if (ts.isIdentifier(call.expression) && operationLookupNames.has(call.expression.text)) {
      issues.push({ gate: "ST14", file: relative, detail: `provider_operation_key_lookup:${call.expression.text}` });
    }
  }
  for (const literal of nodes(ast).filter(ts.isStringLiteral)) {
    if (!operationIds.has(literal.text)) continue;
    const parent = literal.parent;
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)
      && ["getDomainCommandEntry", "getDomainQueryEntry", "getDomainOperationEntry"].includes(parent.expression.text)) continue;
    const context = ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)
      || ts.isElementAccessExpression(parent) || ts.isArrayLiteralExpression(parent)
      || ts.isCallExpression(parent) || ts.isNewExpression(parent);
    if (context || isDispatchOrBranchLiteral(literal)) {
      const line = ast.getLineAndCharacterOfPosition(literal.getStart()).line + 1;
      issues.push({ gate: "ST14", file: relative, detail: `provider_operation_id_dispatch:${literal.text}:${line}` });
    }
  }
  // Catch an operation ID hidden behind a variable/parameter before it is
  // handed to catalog lookup or a provider result/resource table.
  const aliases = new Set<string>();
  for (const declaration of nodes(ast).filter(ts.isVariableDeclaration)) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    if (ts.isStringLiteral(declaration.initializer) && operationIds.has(declaration.initializer.text)) aliases.add(declaration.name.text);
    if (ts.isTemplateExpression(declaration.initializer)
      && declaration.initializer.templateSpans.some((span) => ts.isStringLiteral(span.expression) && operationIds.has(span.expression.text))) {
      aliases.add(declaration.name.text);
    }
  }
  for (const call of nodes(ast).filter(ts.isCallExpression)) {
    if (call.arguments.some((argument) => ts.isIdentifier(argument) && aliases.has(argument.text))) {
      issues.push({ gate: "ST14", file: relative, detail: "provider_operation_alias_forwarding" });
    }
  }
}

const generatedSurfaceBoundaryFiles = [
  path.join(root, "packages/runtime/src/commands/services/generated-surface-domain-service.ts"),
  path.join(root, "packages/runtime/src/domain-operation-ports/generated-surface-domain-service-ports.ts")
];
for (const file of generatedSurfaceBoundaryFiles) {
  const source = readSource(file);
  if (["dispatchGeneratedSurfaceCommand", "dispatchSurfaceCommand", "dispatchCommand"].some((token) => source.includes(token))) {
    issues.push({ gate: "ST06", file: path.relative(root, file), detail: "generated_surface_target_redispatch" });
    issues.push({ gate: "ST07", file: path.relative(root, file), detail: "generated_surface_generic_target_dispatch" });
  }
}

const registryFile = path.join(root, "packages/domain-operations/src/registry/operation-registry.ts");
const registrySource = readSource(registryFile);
const registryAst = ts.createSourceFile(registryFile, registrySource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const executeMethod = nodes(registryAst).find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "execute");
if (!executeMethod) issues.push({ gate: "RH12", file: path.relative(root, registryFile), detail: "execute_method_missing" });
else {
  const executeNodes = nodes(executeMethod);
  const lookupTargets = new Set(executeNodes
    .filter((node): node is ts.CallExpression => ts.isCallExpression(node))
    .map(registryMapGetTarget)
    .filter((target): target is "definitions" | "bindings" => Boolean(target)));
  const executeHelpers = nodes(executeMethod).filter(ts.isCallExpression).flatMap((call) =>
    ts.isIdentifier(call.expression) ? [call.expression.text] : []
  );
  const helperLinearScan = nodes(registryAst).filter((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && executeHelpers.includes(node.name.text)
  ).some((method) => hasLinearRegistryResolution(method));
  if (!lookupTargets.has("definitions") || !lookupTargets.has("bindings") || hasLinearRegistryResolution(executeMethod) || helperLinearScan) {
    issues.push({
      gate: "RH12",
      file: path.relative(root, registryFile),
      detail: `constant_time_lookup_definitions:${lookupTargets.has("definitions")}:bindings:${lookupTargets.has("bindings")}:linear_scan:${hasLinearRegistryResolution(executeMethod) || helperLinearScan}`
    });
  }
}
const definitionFile = path.join(root, "packages/domain-operations/src/definition/index.ts");
const definitionAst = ts.createSourceFile(definitionFile, readSource(definitionFile), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
// The Registry stores opaque typed bindings. Output validation therefore lives
// in bindOperationDefinition, immediately after the concrete Handler returns;
// requiring Registry.execute itself to call safeParse would force the typed
// boundary back to unknown and is not a meaningful quality test.
const outputValidationCalls = nodes(definitionAst).filter((node) => ts.isCallExpression(node)
  && ts.isPropertyAccessExpression(node.expression)
  && node.expression.name.text === "safeParse"
  && ts.isPropertyAccessExpression(node.expression.expression)
  && node.expression.expression.name.text === "output");
if (outputValidationCalls.length !== 1) issues.push({ gate: "RH05", file: path.relative(root, definitionFile), detail: `binding_output_validation_calls:${outputValidationCalls.length}` });
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
for (const file of productionPackageSources.filter((entry) => entry.endsWith(".ts")
  && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts") && entry !== coreSchemaFile)) {
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
  if (hasGenericForwarder(ast)) issues.push({ gate: "ST07", file: relative, detail: "generic_execute_forwarding" });
  if (nodes(ast).some((node) => ts.isPropertyAccessExpression(node) && node.name.text === "_def")) issues.push({ gate: "ST11", file: relative, detail: "zod_private_api" });
}
inspectServiceDtoContinuity(portFiles, serviceFiles, issues);

if (issues.length > 0) {
  process.stderr.write(`${JSON.stringify({ status: "failed", issues }, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  gates: ["ST01", "ST02", "ST03", "ST04", "ST05", "ST06", "ST07", "ST08", "ST09", "ST10", "ST11", "ST13", "ST14", "CT03", "CT07", "DT01", "RH05", "RH12", "IN01", "IN03"],
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

function inspectRedispatch(ast: ts.SourceFile, relative: string, ids: Set<string>, output: typeof issues, allowOperationBindings = false): void {
  for (const node of nodes(ast)) {
    if (ts.isSwitchStatement(node) && nodes(node).some((child) => ts.isStringLiteral(child) && ids.has(child.text))) {
      output.push({ gate: "ST06", file: relative, detail: "operation_id_switch" });
    }
    if (ts.isBinaryExpression(node) && nodes(node).some((child) => ts.isStringLiteral(child) && ids.has(child.text))) {
      output.push({ gate: "ST06", file: relative, detail: "operation_id_comparison" });
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Map"
      && nodes(node).some((child) => ts.isStringLiteral(child) && ids.has(child.text))) {
      output.push({ gate: "ST06", file: relative, detail: "operation_id_map" });
    }
    if (!allowOperationBindings && ts.isObjectLiteralExpression(node)) {
      const operationKeys = node.properties.filter((property) => {
        if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return false;
        const name = propertyName(property.name);
        return Boolean(name && ids.has(name));
      });
      if (operationKeys.length > 0) output.push({ gate: "ST06", file: relative, detail: "operation_id_dispatch_table" });
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

/** The execution hot path must resolve definition and handler by Map#get. */
function registryMapGetTarget(call: ts.CallExpression): "definitions" | "bindings" | undefined {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "get") return undefined;
  const target = call.expression.expression;
  if (!ts.isPropertyAccessExpression(target) || !ts.isThis(target.expression)) return undefined;
  if (!ts.isPrivateIdentifier(target.name)) return undefined;
  if (target.name.text === "#definitions") return "definitions";
  if (target.name.text === "#bindings") return "bindings";
  return undefined;
}

function hasLinearRegistryResolution(method: ts.MethodDeclaration): boolean {
  return nodes(method.body ?? method).some((node) => {
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      return nodes(node).some(isRegistryCollectionReference);
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    if (!["find", "filter", "findIndex", "some", "every", "forEach", "reduce"].includes(node.expression.name.text)) return false;
    return nodes(node.expression.expression).some(isRegistryCollectionReference);
  });
}

function isRegistryCollectionReference(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node)
    && ts.isThis(node.expression)
    && ts.isPrivateIdentifier(node.name)
    && ["#definitions", "#bindings"].includes(node.name.text);
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

function hasGenericForwarder(ast: ts.SourceFile): boolean {
  const functions = nodes(ast).filter((node): node is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node));
  return functions.some((fn) => {
    if (!fn.body) return false;
    const parameterNames = new Set(fn.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    if (parameterNames.size === 0) return false;
    return nodes(fn.body).some((node) => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "execute"
      && ts.isIdentifier(node.expression.expression)
      && parameterNames.has(node.expression.expression.text));
  });
}

/**
 * A one-line Handler is allowed when it delegates a concrete operation DTO to
 * its concrete operation Port. ST07 rejects only a generic execution boundary
 * (`ports.execute/dispatch/run/...`) that can re-interpret arbitrary operation
 * input. It is intentionally semantic rather than a statement-count rule.
 */
function isGenericPortForwardingHandler(handler: ts.FunctionExpression): boolean {
  if (!handler.body || handler.parameters.length < 2) return false;
  const [contextParameter, inputParameter] = handler.parameters;
  if (!ts.isIdentifier(contextParameter?.name) || !ts.isIdentifier(inputParameter?.name)) return false;
  const contextName = contextParameter.name.text;
  const inputName = inputParameter.name.text;
  return nodes(handler.body).some((node) => {
    if (!ts.isCallExpression(node) || node.arguments.length < 2 || !ts.isPropertyAccessExpression(node.expression)) return false;
    if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "ports") return false;
    if (!["execute", "dispatch", "forward", "handle", "run"].includes(node.expression.name.text)) return false;
    return ts.isIdentifier(node.arguments[0])
      && node.arguments[0].text === contextName
      && ts.isIdentifier(node.arguments[1])
      && node.arguments[1].text === inputName;
  });
}

/**
 * Ingress source is allowed for audit/correlation. It is not allowed to select
 * a hidden operation path. Detect an actual decision (conditional, dispatch
 * lookup, or an operation-local helper that makes either decision) rather than
 * banning harmless recording of `context.inputSource`.
 */
function hasHiddenIngressSourceRedispatch(ast: ts.SourceFile, handler: ts.FunctionExpression): boolean {
  const contextParameter = handler.parameters[0];
  if (!contextParameter || !handler.body) return false;
  const sourceNames = trustedSourceNames(handler, contextParameter);
  if (sourceNames.size === 0) return false;
  if (hasSourceDecision(handler.body, sourceNames)) return true;

  const localFunctions = new Map<string, ts.FunctionLikeDeclaration[]>();
  for (const candidate of nodes(ast)) {
    const name = localFunctionName(candidate);
    if (!name || !isFunctionWithBody(candidate)) continue;
    const values = localFunctions.get(name) ?? [];
    values.push(candidate);
    localFunctions.set(name, values);
  }
  for (const call of nodes(handler.body).filter(ts.isCallExpression)) {
    if (!ts.isIdentifier(call.expression)) continue;
    const functions = localFunctions.get(call.expression.text) ?? [];
    for (const [index, argument] of call.arguments.entries()) {
      if (!isSourceValue(argument, sourceNames)) continue;
      for (const localFunction of functions) {
        const parameter = localFunction.parameters[index];
        if (!parameter || !ts.isIdentifier(parameter.name)) continue;
        if (hasSourceDecision(localFunction.body!, new Set([parameter.name.text]))) return true;
      }
    }
  }
  return false;
}

function trustedSourceNames(handler: ts.FunctionExpression, contextParameter: ts.ParameterDeclaration): Set<string> {
  const names = new Set<string>();
  const sourceProperties = new Set(["inputSource", "input_source", "source", "sourceType", "ingressSource"]);
  if (ts.isObjectBindingPattern(contextParameter.name)) {
    for (const element of contextParameter.name.elements) {
      const property = element.propertyName ? propertyName(element.propertyName) : propertyName(element.name);
      if (property && sourceProperties.has(property) && ts.isIdentifier(element.name)) names.add(element.name.text);
    }
  } else if (ts.isIdentifier(contextParameter.name)) {
    const contextName = contextParameter.name.text;
    for (const access of nodes(handler.body ?? handler).filter(ts.isPropertyAccessExpression)) {
      if (ts.isIdentifier(access.expression) && access.expression.text === contextName && sourceProperties.has(access.name.text)) {
        names.add(sourceExpressionKey(access));
      }
    }
  }
  for (const declaration of nodes(handler.body ?? handler).filter((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node))) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    if (isSourceValue(declaration.initializer, names)) names.add(declaration.name.text);
  }
  return names;
}

function hasSourceDecision(rootNode: ts.Node, sourceNames: Set<string>): boolean {
  return nodes(rootNode).some((node) => {
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      return isSourceValue(node.expression, sourceNames);
    }
    if (ts.isForStatement(node) && node.condition) return isSourceValue(node.condition, sourceNames);
    if (ts.isSwitchStatement(node)) return isSourceValue(node.expression, sourceNames);
    if (ts.isElementAccessExpression(node) && node.argumentExpression) return isSourceValue(node.argumentExpression, sourceNames);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["get", "has", "find", "filter"].includes(node.expression.name.text)) {
      return node.arguments.some((argument) => isSourceValue(argument, sourceNames));
    }
    return false;
  });
}

function isSourceValue(node: ts.Node, sourceNames: Set<string>): boolean {
  return nodes(node).some((child) => {
    if (ts.isIdentifier(child) && sourceNames.has(child.text)) return true;
    return ts.isPropertyAccessExpression(child) && sourceNames.has(sourceExpressionKey(child));
  });
}

function sourceExpressionKey(expression: ts.PropertyAccessExpression): string {
  return `${expression.expression.getText()}.${expression.name.text}`;
}

function localFunctionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.text;
  }
  return undefined;
}

function isFunctionWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration & { body: ts.Block } {
  return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && Boolean(node.body) && ts.isBlock(node.body);
}

/** Old ingress helpers bypass Registry/Bus and must not be reachable from any Handler. */
function hasLegacyIngressEscape(handler: ts.FunctionExpression): boolean {
  return nodes(handler.body ?? handler).some((node) => ts.isPropertyAccessExpression(node)
    && ["runArtifactSurface", "runLegacySurfaceOperation", "runLegacyProviderOperation"].includes(node.name.text));
}

/** A Port's operation request parameter cannot be re-generalized to Record. */
function inspectOperationPortDtoTypes(ast: ts.SourceFile, relative: string, output: typeof issues): void {
  for (const declaration of ast.statements.filter(ts.isInterfaceDeclaration)) {
    if (!declaration.name.text.endsWith("Ports")) continue;
    for (const member of declaration.members.filter(ts.isMethodSignature)) {
      const parameter = member.parameters[0];
      if (!parameter || !isOperationInputParameter(parameter) || !isGenericRecordType(parameter.type)) continue;
      output.push({
        gate: "DT01",
        file: relative,
        detail: `operation_port_generic_record:${declaration.name.text}.${propertyName(member.name) ?? "unknown"}`
      });
    }
  }
}

function isOperationInputParameter(parameter: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(parameter.name) && ["input", "payload", "request", "data", "args"].includes(parameter.name.text);
}

function isGenericRecordType(type: ts.TypeNode | undefined): boolean {
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || type.typeName.text !== "Record") return false;
  const valueType = type.typeArguments?.[1];
  if (!valueType) return false;
  return valueType.kind === ts.SyntaxKind.UnknownKeyword
    || (ts.isTypeReferenceNode(valueType) && ts.isIdentifier(valueType.typeName) && valueType.typeName.text === "JsonValue");
}

/**
 * Follow only real runtime Port adapters into their backing Service methods.
 * This deliberately does not ban internal JSON maps (metadata, snapshots,
 * plugin payloads); it rejects the case that matters for a Domain Operation:
 * an adapter passes its operation request directly into a Service method whose
 * public request type is `Record<string, …>`.
 */
function inspectServiceDtoContinuity(portFiles: string[], serviceFiles: string[], output: typeof issues): void {
  const serviceMethods = new Map<string, Array<{ file: string; method: ts.MethodDeclaration }>>();
  for (const file of serviceFiles) {
    const ast = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    for (const method of nodes(ast).filter(ts.isMethodDeclaration)) {
      const name = propertyName(method.name);
      if (!name) continue;
      const key = `${path.basename(file)}:${name}`;
      const values = serviceMethods.get(key) ?? [];
      values.push({ file, method });
      serviceMethods.set(key, values);
    }
  }
  for (const portFile of portFiles) {
    const ast = ts.createSourceFile(portFile, readSource(portFile), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    for (const call of nodes(ast).filter(ts.isCallExpression)) {
      if (!ts.isPropertyAccessExpression(call.expression) || call.arguments.length === 0) continue;
      const serviceCall = serviceMethodCall(call.expression);
      if (!serviceCall) continue;
      const forwarded = call.arguments[0];
      if (!ts.isIdentifier(forwarded) || !["input", "payload", "request", "data", "args"].includes(forwarded.text)) continue;
      const candidates = serviceMethods.get(`${camelToKebab(serviceCall.serviceProperty)}.ts:${serviceCall.methodName}`) ?? [];
      for (const candidate of candidates) {
        const parameter = candidate.method.parameters[0];
        if (!parameter || !isOperationInputParameter(parameter) || !isGenericRecordType(parameter.type)) continue;
        output.push({
          gate: "DT01",
          file: path.relative(root, portFile),
          detail: `service_port_generic_record:${serviceCall.serviceProperty}.${serviceCall.methodName}:${path.relative(root, candidate.file)}`
        });
      }
    }
  }
}

function serviceMethodCall(expression: ts.PropertyAccessExpression): { serviceProperty: string; methodName: string } | undefined {
  if (!ts.isPropertyAccessExpression(expression.expression)) return undefined;
  const serviceReference = expression.expression;
  if (!ts.isIdentifier(serviceReference.expression) || serviceReference.expression.text !== "services") return undefined;
  return { serviceProperty: serviceReference.name.text, methodName: expression.name.text };
}

function camelToKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function containsCallNamed(node: ts.Node, name: string): boolean {
  return nodes(node).some((child) => ts.isCallExpression(child)
    && ts.isPropertyAccessExpression(child.expression)
    && child.expression.name.text === name);
}

function isImportedSharedValueSchema(node: ts.Node, ast: ts.SourceFile): boolean {
  if (!ts.isIdentifier(node)) return false;
  return ast.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.includes("/value-objects/")) return false;
    return statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements.some((element) => element.name.text === node.text)
      : false;
  });
}

/**
 * These contracts were independently reviewed against the service inputs.
 * Keep this list intentionally narrow and explicit: it protects known places
 * where ingress envelopes had leaked into a Domain Operation DTO.
 */
function inspectCriticalInputContracts(
  ast: ts.SourceFile,
  operationId: string,
  relative: string,
  output: typeof issues
): void {
  const inputProperties = zodObjectProperties(ast, "Input");
  if (!inputProperties) {
    if (["collection.action.run", "file.read", "file.inspect", "file.list", "browser.extract"].includes(operationId)) {
      output.push({ gate: "CT05", file: relative, detail: `${operationId}:input_object_missing` });
    }
    return;
  }
  if (operationId === "collection.action.run") {
    // `session_id` is server-owned trusted context, not caller DTO data.  The
    // Operation may forward it only after Registry ingress has constructed the
    // TrustedDomainContext.  Keeping it out of Input prevents a Surface or API
    // payload from selecting another user's session.
    const allowed = ["collection_id", "action_id", "record_id", "backend_id", "payload"];
    const actual = [...inputProperties.keys()].sort();
    if (actual.length !== allowed.length || actual.some((name, index) => name !== [...allowed].sort()[index])) {
      output.push({ gate: "CT05", file: relative, detail: "collection_action_input_contract:unexpected_or_missing_field" });
    }
    for (const name of ["collection_id", "action_id"]) {
      if (!isBoundedNonEmptyString(inputProperties.get(name), 256, false)) {
        output.push({ gate: "CT05", file: relative, detail: `collection_action_input_contract:${name}` });
      }
    }
    for (const name of ["record_id", "backend_id"]) {
      if (!isBoundedNonEmptyString(inputProperties.get(name), 256, true)) {
        output.push({ gate: "CT05", file: relative, detail: `collection_action_input_contract:${name}` });
      }
    }
    const payload = inputProperties.get("payload");
    if (!payload || !hasZodCall(payload, "record") || !hasZodCall(payload, "default")) {
      output.push({ gate: "CT05", file: relative, detail: "collection_action_input_contract:payload" });
    }
    if (!portMethodUsesNamedDto(ast, "runCollectionAction", "CollectionActionRunRequest")) {
      output.push({ gate: "CT05", file: relative, detail: "collection_action_port_raw_record" });
    }
    if (!collectionActionRequestHasTrustedSession(ast)) {
      output.push({ gate: "CT05", file: relative, detail: "collection_action_port_trusted_session_missing" });
    }
    if (!collectionActionHandlerUsesTrustedSessionOnly(ast)) {
      output.push({ gate: "CT05", file: relative, detail: "collection_action_handler_trusted_session_mapping" });
    }
    return;
  }
  if (["file.read", "file.inspect", "file.list"].includes(operationId)) {
    if (inputProperties.size !== 1 || !isBoundedNonEmptyString(inputProperties.get("path"), 4096, false)) {
      output.push({ gate: "CT05", file: relative, detail: `${operationId}:path_contract` });
    }
    return;
  }
  if (operationId === "browser.extract") {
    const url = inputProperties.get("url");
    if (inputProperties.size !== 1 || !isBoundedUrl(url, 8192)) {
      output.push({ gate: "CT05", file: relative, detail: "browser.extract:url_contract" });
    }
  }
}

function zodObjectProperties(ast: ts.SourceFile, variableName: string): Map<string, ts.Expression> | undefined {
  const declaration = nodes(ast).find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === variableName);
  if (!declaration?.initializer) return undefined;
  const objectCall = nodes(declaration.initializer).find((node): node is ts.CallExpression => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "z"
    && node.expression.name.text === "object");
  const object = objectCall?.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const properties = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name) properties.set(name, property.initializer);
  }
  return properties;
}

function isBoundedNonEmptyString(expression: ts.Expression | undefined, maximum: number, optional: boolean): boolean {
  if (!expression || !hasZodCall(expression, "string") || !hasZodCall(expression, "trim")) return false;
  if (!hasZodNumericCall(expression, "min", 1) || !hasZodNumericCall(expression, "max", maximum)) return false;
  return hasZodCall(expression, "optional") === optional;
}

function isBoundedUrl(expression: ts.Expression | undefined, maximum: number): boolean {
  return Boolean(expression
    && hasZodCall(expression, "string")
    && hasZodCall(expression, "trim")
    && hasZodCall(expression, "url")
    && hasZodNumericCall(expression, "max", maximum)
    && !hasZodCall(expression, "optional"));
}

function hasZodCall(expression: ts.Expression | undefined, name: string): boolean {
  return Boolean(expression && nodes(expression).some((node) => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === name));
}

function hasZodNumericCall(expression: ts.Expression, name: string, expected: number): boolean {
  return nodes(expression).some((node) => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === name
    && node.arguments.length >= 1
    && ts.isNumericLiteral(node.arguments[0])
    && Number(node.arguments[0].text) === expected);
}

function portMethodUsesNamedDto(ast: ts.SourceFile, methodName: string, typeName: string): boolean {
  return nodes(ast).some((node) => ts.isMethodSignature(node)
    && propertyName(node.name) === methodName
    && node.parameters.length === 1
    && node.parameters[0]?.type
    && ts.isTypeReferenceNode(node.parameters[0].type)
    && ts.isIdentifier(node.parameters[0].type.typeName)
    && node.parameters[0].type.typeName.text === typeName);
}

/**
 * The Service needs a session identifier for instruction actions, but that
 * value is deliberately not part of the public Zod DTO.  Keep the bridge type
 * explicit so it cannot silently regress to a raw record or force callers to
 * smuggle `session_id` through the contract.
 */
function collectionActionRequestHasTrustedSession(ast: ts.SourceFile): boolean {
  const request = ast.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement)
    && statement.name.text === "CollectionActionRunRequest");
  const session = request?.members.find((member): member is ts.PropertySignature => ts.isPropertySignature(member)
    && propertyName(member.name) === "sessionId");
  return Boolean(session?.questionToken && session.type?.kind === ts.SyntaxKind.StringKeyword);
}

/**
 * Verify the value crossing into the Port originates from TrustedDomainContext
 * and that the Handler never reads a caller-owned `input.session_id`.  This is
 * AST based rather than a source-text convention, so renaming whitespace or
 * reformatting cannot make the check pass.
 */
function collectionActionHandlerUsesTrustedSessionOnly(ast: ts.SourceFile): boolean {
  const handler = nodes(ast).find((node): node is ts.FunctionExpression => ts.isFunctionExpression(node)
    && node.name?.text === "handleCollectionActionRun");
  if (!handler?.body) return false;
  const hasCallerOwnedSession = nodes(handler.body).some((node) => ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "input"
    && node.name.text === "session_id");
  if (hasCallerOwnedSession) return false;
  return nodes(handler.body).some((node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || !ts.isIdentifier(node.expression.expression)
      || node.expression.expression.text !== "ports"
      || node.expression.name.text !== "runCollectionAction") return false;
    const request = node.arguments[0];
    if (!request || !ts.isObjectLiteralExpression(request)) return false;
    return request.properties.some((property) => {
      if (!ts.isSpreadAssignment(property)) return false;
      const expression = unwrapParentheses(property.expression);
      if (!expression || !ts.isConditionalExpression(expression)) return false;
      const conditional = expression;
      return isContextSessionAccess(conditional.condition)
        && ts.isObjectLiteralExpression(conditional.whenTrue)
        && conditional.whenTrue.properties.some((candidate) => ts.isPropertyAssignment(candidate)
          && propertyName(candidate.name) === "sessionId"
          && isContextSessionAccess(candidate.initializer));
    });
  });
}

function unwrapParentheses(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node;
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isContextSessionAccess(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "context"
    && node.name.text === "sessionId";
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
