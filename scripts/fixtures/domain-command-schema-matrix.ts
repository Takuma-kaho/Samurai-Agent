import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import Ajv from "ajv";
import staticManifestSource from "./domain-command-schema-expectations.json";
import {
  DomainContractError,
  DomainOperationError,
  DomainOperationRegistry,
  bindOperationDefinition,
  jsonSchemaFor,
  operationDefinitions,
  type BoundOperationDefinition,
  type DomainOperationPorts,
  type OperationDefinition,
  type TrustedDomainContext
} from "../../packages/domain-operations/src/index";

type JsonSchema = Record<string, unknown>;
type PathPart = string | number;
type CaseKind =
  | "required"
  | "type"
  | "enum"
  | "minLength"
  | "maxLength"
  | "pattern"
  | "format"
  | "minimum"
  | "maximum"
  | "exclusiveMinimum"
  | "exclusiveMaximum"
  | "multipleOf"
  | "minItems"
  | "maxItems"
  | "minProperties"
  | "maxProperties"
  | "unknown_key"
  | "global_limit";

interface StaticFieldExpectation {
  path: string;
  kind: "root" | "property" | "array_item" | "union_branch" | "all_of_branch" | "additional_property" | "tuple_item";
  required: boolean | null;
  types: string[];
  constraint_kinds?: string[];
  unknown_key_policy?: "closed" | "typed" | "open";
  limit_classification: "local_and_global" | "global_only" | "local" | "not_applicable";
  checks: CaseKind[];
  review: "reviewed" | "unreviewed";
}

interface StaticEndpointExpectation {
  review: "reviewed" | "unreviewed";
  root_schema: string;
}

interface StaticOperationExpectation {
  id: string;
  kind: "command" | "query";
  review: { input: "reviewed" | "unreviewed"; output: "reviewed" | "unreviewed" };
  input: StaticEndpointExpectation;
  output: StaticEndpointExpectation;
}

interface StaticSchemaManifest {
  manifest_version: number;
  review_policy: {
    source: "frozen_static_schema_catalog";
    runtime_expected_value_generation: "forbidden";
    production_schema_or_ledger_import_for_expectation: "forbidden";
    canonical_reference_key: "$schema_ref";
    review_unit: "canonical_schema_node";
    recursive_json_value: "global_json_value";
  };
  review: {
    required_operations: number;
    reviewed_operations: number;
    unreviewed_operations: number;
    required_endpoints: number;
    reviewed_endpoints: number;
    unreviewed_endpoints: number;
    required_schema_nodes: number;
    reviewed_schema_nodes: number;
    unreviewed_schema_nodes: number;
  };
  global_payload_limits: {
    review: "reviewed" | "unreviewed";
    classification: "global_limit";
    maximum_depth: number;
    maximum_array_items: number;
    maximum_object_keys: number;
    maximum_string_length: number;
    maximum_total_characters: number;
      forbidden_object_keys: string[];
  };
  global_json_value: {
    schema_ref: "global_json_value";
    review: "reviewed" | "unreviewed";
    boundary_checks: ["string_length", "array_items", "object_keys", "depth", "total_characters", "forbidden_key"];
  };
  schema_catalog: Record<string, {
    structural_hash: string;
    review: "reviewed" | "unreviewed";
    first_seen: { operation: string; endpoint: "input" | "output"; path: string };
    schema: JsonSchema;
  }>;
  operations: StaticOperationExpectation[];
}

interface MatrixCase {
  id: string;
  kind: Exclude<CaseKind, "global_limit">;
  value: unknown;
}

interface Counter {
  cases: number;
  required: number;
  type: number;
  enum: number;
  bound: number;
  format: number;
  pattern: number;
  unknownKey: number;
}

interface InputFieldUsageSummary {
  operations: number;
  top_level_fields: number;
  unused_fields: number;
  helper_tracing: true;
  spread_tracking: true;
}

interface InputFieldUsageFinding {
  operationId: string;
  field: string;
  file: string;
}

type InputFieldSet = ReadonlySet<string>;
type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

const manifest = staticManifestSource as StaticSchemaManifest;
const definitions = [...operationDefinitions].sort((left, right) => left.id.localeCompare(right.id));
const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
const staticAjv = createAjv();
const projectionAjv = createAjv();
const ts: typeof import("typescript") = createRequire(resolve(process.env.SAMURAI_REPO_ROOT ?? process.cwd(), "package.json"))("typescript");

await main();

async function main(): Promise<void> {
  validateManifest(manifest);
  const inputUsage = assertInputFieldUsage();
  const expectedOperations = [...manifest.operations].sort((left, right) => left.id.localeCompare(right.id));
  const expectedById = new Map(expectedOperations.map((operation) => [operation.id, operation]));
  assert.equal(expectedOperations.length, 132, "schema_manifest_operation_count_mismatch:132");
  assert.equal(definitions.length, 132, "schema_matrix_definition_count_mismatch:132");
  assert.deepEqual([...expectedById.keys()], definitions.map((definition) => definition.id), "schema_manifest_definition_id_set_mismatch");

  const counters = { input: emptyCounter(), output: emptyCounter() };
  const fieldCounts = { input: 0, output: 0 };
  const fieldPathCounts = { input: 0, output: 0 };
  const validOutputs = new Map<string, unknown>();
  const projectedNodeIds = new Set<string>();

  for (const expected of expectedOperations) {
    const definition = definitionById.get(expected.id);
    assert.ok(definition, `schema_manifest_definition_missing:${expected.id}`);
    assert.equal(definition.kind, expected.kind, `schema_manifest_kind_mismatch:${expected.id}`);

    const staticInput = staticSchemaFor(expected.input.root_schema);
    const staticOutput = staticSchemaFor(expected.output.root_schema);
    const actualInput = jsonSchemaFor(definition.input, `${definition.id}.input`) as JsonSchema;
    const actualOutput = jsonSchemaFor(definition.output, `${definition.id}.output`) as JsonSchema;
    const staticInputFields = assertSchemaAndFieldParity(expected.id, "input", expected.input, staticInput, actualInput, projectedNodeIds);
    const staticOutputFields = assertSchemaAndFieldParity(expected.id, "output", expected.output, staticOutput, actualOutput, projectedNodeIds);
    fieldCounts.input += staticInputFields.length;
    fieldCounts.output += staticOutputFields.length;
    fieldPathCounts.input += new Set(staticInputFields.map((field) => field.path)).size;
    fieldPathCounts.output += new Set(staticOutputFields.map((field) => field.path)).size;

    const expectedInputValidator = staticAjv.compile(staticInput);
    const expectedOutputValidator = staticAjv.compile(staticOutput);
    const actualInputValidator = projectionAjv.compile(actualInput);
    const actualOutputValidator = projectionAjv.compile(actualOutput);
    const validInput = completeSample(staticInput);
    const validOutput = completeSample(staticOutput);
    validOutputs.set(definition.id, validOutput);
    assertAccepted(expected.id, "input", validInput, expectedInputValidator, actualInputValidator, definition.input.safeParse(validInput).success);
    assertAccepted(expected.id, "output", validOutput, expectedOutputValidator, actualOutputValidator, definition.output.safeParse(validOutput).success);

    const inputCases = invalidCases(staticInput, validInput, expectedInputValidator);
    const outputCases = invalidCases(staticOutput, validOutput, expectedOutputValidator);
    assertFullCaseCoverage(expected.id, "input", staticInputFields, inputCases);
    assertFullCaseCoverage(expected.id, "output", staticOutputFields, outputCases);

    await assertValidBinding(definition, validInput, validOutput);
    for (const testCase of inputCases) {
      assertRejected(expected.id, "input", testCase, actualInputValidator, definition.input.safeParse(testCase.value).success);
      await assertInputBindingRejects(definition, validOutput, testCase);
      count(counters.input, testCase.kind);
    }
    for (const testCase of outputCases) {
      assertRejected(expected.id, "output", testCase, actualOutputValidator, definition.output.safeParse(testCase.value).success);
      await assertOutputBindingRejects(definition, validInput, testCase);
      count(counters.output, testCase.kind);
    }
  }

  const staticNodeIds = new Set(Object.keys(manifest.schema_catalog));
  assert.deepEqual([...projectedNodeIds].sort(), [...staticNodeIds].sort(), "schema_catalog_projection_node_set_drift");

  await assertGlobalPayloadLimits(validOutputs);
  const summary = {
    status: "passed",
    gates: ["CT02", "CT03", "CT04", "CT05", "CT08", "CT12", "RH04", "RH05", "ES07"],
    manifest: {
      version: manifest.manifest_version,
      operations: expectedOperations.length,
      reviewed_operations: manifest.review.reviewed_operations,
      unreviewed_operations: manifest.review.unreviewed_operations,
      endpoints: manifest.review.required_endpoints,
      reviewed_schema_nodes: manifest.review.reviewed_schema_nodes,
      unreviewed_schema_nodes: manifest.review.unreviewed_schema_nodes
    },
    operations: { total: expectedOperations.length, commands: expectedOperations.filter((operation) => operation.kind === "command").length, queries: expectedOperations.filter((operation) => operation.kind === "query").length },
    field_paths: {
      input_fields: fieldCounts.input,
      output_fields: fieldCounts.output,
      input_distinct_paths: fieldPathCounts.input,
      output_distinct_paths: fieldPathCounts.output,
      projection_parity: true
    },
    input: counters.input,
    output: counters.output,
    parity: { zod: true, ajv: true, bind_operation_definition: true },
    input_field_usage: inputUsage,
    global_payload_limits: { ...manifest.global_payload_limits, boundary_checks: 6 }
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function validateManifest(value: StaticSchemaManifest): void {
  assert.equal(value.manifest_version, 2, "schema_manifest_version_invalid");
  assert.equal(value.review_policy.source, "frozen_static_schema_catalog", "schema_manifest_static_catalog_source_invalid");
  assert.equal(value.review_policy.runtime_expected_value_generation, "forbidden", "schema_manifest_runtime_expected_generation_allowed");
  assert.equal(value.review_policy.production_schema_or_ledger_import_for_expectation, "forbidden", "schema_manifest_production_expectation_import_allowed");
  assert.equal(value.review_policy.canonical_reference_key, "$schema_ref", "schema_manifest_catalog_reference_key_invalid");
  assert.equal(value.review_policy.review_unit, "canonical_schema_node", "schema_manifest_review_unit_invalid");
  assert.equal(value.review_policy.recursive_json_value, "global_json_value", "schema_manifest_recursive_json_value_invalid");
  assert.equal(value.review.required_operations, 132, "schema_manifest_required_operation_count_invalid");
  assert.equal(value.operations.length, value.review.required_operations, "schema_manifest_operation_count_mismatch");
  const commands = value.operations.filter((operation) => operation.kind === "command").length;
  const queries = value.operations.filter((operation) => operation.kind === "query").length;
  assert.equal(commands, 111, "schema_manifest_command_count_mismatch");
  assert.equal(queries, 21, "schema_manifest_query_count_mismatch");
  assert.equal(value.review.reviewed_operations, 132, "schema_manifest_reviewed_operation_count_mismatch");
  assert.equal(value.review.unreviewed_operations, 0, "schema_manifest_unreviewed_operations");
  assert.equal(value.review.required_endpoints, 264, "schema_manifest_required_endpoint_count_invalid");
  assert.equal(value.review.reviewed_endpoints, 264, "schema_manifest_reviewed_endpoint_count_invalid");
  assert.equal(value.review.unreviewed_endpoints, 0, "schema_manifest_unreviewed_endpoints");
  assert.equal(value.review.required_schema_nodes, 812, "schema_catalog_required_node_count_invalid");
  assert.equal(value.review.reviewed_schema_nodes, value.review.required_schema_nodes, "schema_catalog_reviewed_node_count_invalid");
  assert.equal(value.review.unreviewed_schema_nodes, 0, "schema_catalog_unreviewed_nodes");
  assert.equal(value.global_payload_limits.review, "reviewed", "schema_manifest_global_limit_unreviewed");
  assert.equal(value.global_json_value.schema_ref, "global_json_value", "schema_manifest_global_json_value_ref_invalid");
  assert.equal(value.global_json_value.review, "reviewed", "schema_manifest_global_json_value_unreviewed");
  assert.deepEqual(value.global_json_value.boundary_checks, ["string_length", "array_items", "object_keys", "depth", "total_characters", "forbidden_key"], "schema_manifest_global_json_value_boundary_set_invalid");

  const ids = new Set<string>();
  let endpoints = 0;
  for (const operation of value.operations) {
    assert.ok(!ids.has(operation.id), `schema_manifest_duplicate_operation:${operation.id}`);
    ids.add(operation.id);
    assert.equal(operation.review.input, "reviewed", `schema_manifest_input_unreviewed:${operation.id}`);
    assert.equal(operation.review.output, "reviewed", `schema_manifest_output_unreviewed:${operation.id}`);
    assert.equal(operation.input.review, "reviewed", `schema_manifest_input_endpoint_unreviewed:${operation.id}`);
    assert.equal(operation.output.review, "reviewed", `schema_manifest_output_endpoint_unreviewed:${operation.id}`);
    endpoints += 2;
    assert.ok(operation.input.root_schema in value.schema_catalog, `schema_catalog_endpoint_root_missing:${operation.id}:input`);
    assert.ok(operation.output.root_schema in value.schema_catalog, `schema_catalog_endpoint_root_missing:${operation.id}:output`);
  }
  assert.equal(endpoints, value.review.required_endpoints, "schema_manifest_endpoint_count_mismatch");
  validateSchemaCatalog(value, ids);
}

function validateSchemaCatalog(value: StaticSchemaManifest, operationIds: ReadonlySet<string>): void {
  const entries = Object.entries(value.schema_catalog);
  assert.equal(entries.length, value.review.required_schema_nodes, "schema_catalog_node_count_mismatch");
  const hashes = new Map<string, string>();
  const references = new Map<string, string[]>();
  for (const [id, node] of entries) {
    assert.equal(node.review, "reviewed", `schema_catalog_node_unreviewed:${id}`);
    assert.ok(operationIds.has(node.first_seen.operation), `schema_catalog_first_seen_operation_missing:${id}`);
    assert.ok(["input", "output"].includes(node.first_seen.endpoint), `schema_catalog_first_seen_endpoint_invalid:${id}`);
    assert.ok(node.first_seen.path.startsWith("$"), `schema_catalog_first_seen_path_invalid:${id}`);
    const computed = schemaHash(node.schema);
    assert.equal(node.structural_hash, computed, `schema_catalog_hash_invalid:${id}`);
    if (id === "global_json_value") {
      assertGlobalJsonValueNode(node.schema);
    } else {
      assert.equal(id, `sha256:${computed}`, `schema_catalog_id_hash_mismatch:${id}`);
    }
    const duplicate = hashes.get(computed);
    assert.equal(duplicate, undefined, `schema_catalog_hash_collision:${duplicate}:${id}`);
    hashes.set(computed, id);
    const refs = schemaCatalogRefs(node.schema);
    for (const ref of refs) assert.ok(ref in value.schema_catalog, `schema_catalog_ref_missing:${id}:${ref}`);
    references.set(id, refs);
  }
  assertCatalogAcyclic(references);
}

function assertGlobalJsonValueNode(schema: JsonSchema): void {
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  assert.equal(branches.length, 6, "schema_catalog_global_json_value_shape_invalid");
  const [string, number, boolean, nil, array, object] = branches;
  assert.equal(isSchema(string) && string.type, "string", "schema_catalog_global_json_value_string_invalid");
  assert.equal(isSchema(number) && number.type, "number", "schema_catalog_global_json_value_number_invalid");
  assert.equal(isSchema(boolean) && boolean.type, "boolean", "schema_catalog_global_json_value_boolean_invalid");
  assert.equal(isSchema(nil) && nil.type, "null", "schema_catalog_global_json_value_null_invalid");
  assert.equal(isSchema(array) && array.type, "array", "schema_catalog_global_json_value_array_invalid");
  assert.equal(isSchema(object) && object.type, "object", "schema_catalog_global_json_value_object_invalid");
  assert.equal(isCatalogRef(isSchema(array) ? array.items : undefined) && array.items.$schema_ref, "global_json_value", "schema_catalog_global_json_value_array_ref_invalid");
  assert.equal(isCatalogRef(isSchema(object) ? object.additionalProperties : undefined) && object.additionalProperties.$schema_ref, "global_json_value", "schema_catalog_global_json_value_object_ref_invalid");
}

function assertCatalogAcyclic(references: ReadonlyMap<string, readonly string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`schema_catalog_ref_cycle:${id}`);
    visiting.add(id);
    for (const reference of references.get(id) ?? []) {
      if (id === "global_json_value" && reference === "global_json_value") continue;
      visit(reference);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of references.keys()) visit(id);
}

function schemaCatalogRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!isSchema(current)) return;
    if (isCatalogRef(current)) {
      refs.add(current.$schema_ref);
      return;
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
  return [...refs].sort();
}

function isCatalogRef(value: unknown): value is { $schema_ref: string } {
  return isSchema(value) && Object.keys(value).length === 1 && typeof value.$schema_ref === "string";
}

/**
 * Every public Input field must be consumed by its own handler path.  This is
 * deliberately source-based: a field that is merely declared in Zod still
 * fails until it is read directly, forwarded to a local helper, or spread
 * into a downstream payload.
 */
function assertInputFieldUsage(): InputFieldUsageSummary {
  const repositoryRoot = process.env.SAMURAI_REPO_ROOT ?? process.cwd();
  const operationsRoot = resolve(repositoryRoot, "packages/domain-operations/src/operations");
  const files = operationSourceFiles(operationsRoot);
  const expectedIds = new Set(definitions.map((definition) => definition.id));
  const foundIds = new Set<string>();
  const findings: InputFieldUsageFinding[] = [];
  let topLevelFields = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const operationId = sourceOperationId(ast, file);
    if (foundIds.has(operationId)) throw new Error(`input_field_usage_duplicate_operation:${operationId}`);
    foundIds.add(operationId);
    const definition = definitionById.get(operationId);
    if (!definition) throw new Error(`input_field_usage_definition_missing:${operationId}`);
    const fields = projectedInputFieldKeys(definition, file);
    const handler = operationHandler(ast, file);
    const used = usedInputFields(ast, handler, fields);
    topLevelFields += fields.length;
    for (const field of fields) {
      if (!used.has(field)) findings.push({ operationId, field, file: relative(repositoryRoot, file) });
    }
  }

  if (files.length !== definitions.length) throw new Error(`input_field_usage_file_count_mismatch:${files.length}:${definitions.length}`);
  const missingDefinitions = [...expectedIds].filter((id) => !foundIds.has(id));
  const unexpectedDefinitions = [...foundIds].filter((id) => !expectedIds.has(id));
  if (missingDefinitions.length || unexpectedDefinitions.length) {
    throw new Error(`input_field_usage_operation_set_mismatch:missing=${missingDefinitions.slice(0, 4).join(",")}:unexpected=${unexpectedDefinitions.slice(0, 4).join(",")}`);
  }
  if (findings.length) {
    const first = findings[0]!;
    throw new Error(`domain_operation_input_field_unused:${first.operationId}:${first.field}:${first.file}`);
  }
  return {
    operations: files.length,
    top_level_fields: topLevelFields,
    unused_fields: 0,
    helper_tracing: true,
    spread_tracking: true
  };
}

function operationSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(".operation.ts")) files.push(target);
    }
  };
  visit(root);
  return files.sort();
}

function sourceOperationId(ast: ts.SourceFile, file: string): string {
  const candidates: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && isDefinitionFactoryConfig(node)) {
      const id = definitionConfigId(node);
      if (id) candidates.push(id);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) throw new Error(`input_field_usage_operation_id_missing:${file}`);
  return unique[0]!;
}

function definitionConfigId(node: ts.ObjectLiteralExpression): string | undefined {
  const direct = objectStringProperty(node, "id");
  if (direct) return direct;
  for (const property of node.properties) {
    if (!ts.isSpreadAssignment(property) || !ts.isObjectLiteralExpression(property.expression)) continue;
    const nested = objectStringProperty(property.expression, "id");
    if (nested) return nested;
  }
  return undefined;
}

function isDefinitionFactoryConfig(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  const factoryCall = parent.expression;
  if (!ts.isCallExpression(factoryCall)) return false;
  return ts.isIdentifier(factoryCall.expression)
    && (factoryCall.expression.text === "defineCommand" || factoryCall.expression.text === "defineQuery");
}

function projectedInputFieldKeys(definition: OperationDefinition, file: string): string[] {
  const schema = jsonSchemaFor(definition.input, `${definition.id}.input_usage`);
  const fields = new Set<string>();
  let objectShapeFound = false;
  const collect = (raw: JsonSchema, activeRefs: Set<string>): void => {
    const ref = typeof raw.$ref === "string" ? raw.$ref : undefined;
    if (ref && activeRefs.has(ref)) return;
    const resolved = ref ? resolveSchema(raw, schema) : raw;
    const nextRefs = ref ? new Set([...activeRefs, ref]) : activeRefs;
    const properties = asSchemaMap(resolved.properties);
    if (schemaTypes(resolved).includes("object") || isSchema(resolved.properties)) objectShapeFound = true;
    for (const field of Object.keys(properties)) fields.add(field);
    for (const branch of [...(Array.isArray(resolved.anyOf) ? resolved.anyOf : []), ...(Array.isArray(resolved.oneOf) ? resolved.oneOf : []), ...(Array.isArray(resolved.allOf) ? resolved.allOf : [])]) {
      if (isSchema(branch)) collect(branch, nextRefs);
    }
  };
  collect(schema, new Set());
  if (!objectShapeFound) throw new Error(`input_field_usage_input_shape_missing:${definition.id}:${file}`);
  return [...fields].sort();
}

function operationHandler(ast: ts.SourceFile, file: string): FunctionLike {
  const handlers: FunctionLike[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyName(node) === "execute" && isFunctionLike(node.initializer) && node.initializer.parameters.length >= 2) {
      handlers.push(node.initializer);
    } else if (ts.isMethodDeclaration(node) && propertyName(node) === "execute" && node.parameters.length >= 2) {
      handlers.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (handlers.length !== 1) throw new Error(`input_field_usage_handler_count_mismatch:${file}:${handlers.length}`);
  const input = handlers[0]!.parameters[1];
  if (!input || !ts.isIdentifier(input.name)) throw new Error(`input_field_usage_handler_input_missing:${file}`);
  return handlers[0]!;
}

function usedInputFields(ast: ts.SourceFile, handler: FunctionLike, fields: readonly string[]): Set<string> {
  const allFields = new Set(fields);
  const used = new Set<string>();
  const localFunctions = localFunctionIndex(ast);
  const inputParameter = handler.parameters[1];
  if (!inputParameter || !ts.isIdentifier(inputParameter.name)) return used;
  const initialTracked = new Map<string, InputFieldSet>([[inputParameter.name.text, allFields]]);
  const tracedHelpers = new Set<ts.Node>();

  const mark = (candidates: InputFieldSet | undefined): void => {
    if (!candidates) return;
    for (const field of candidates) if (allFields.has(field)) used.add(field);
  };
  const tracked = (expression: ts.Expression | undefined, names: ReadonlyMap<string, InputFieldSet>): InputFieldSet | undefined => {
    if (!expression) return undefined;
    if (ts.isIdentifier(expression)) return names.get(expression.text);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) return tracked(expression.expression, names);
    return undefined;
  };
  const directField = (expression: ts.Expression, names: ReadonlyMap<string, InputFieldSet>): InputFieldSet | undefined => {
    if (ts.isPropertyAccessExpression(expression)) {
      const owner = tracked(expression.expression, names);
      return owner?.has(expression.name.text) ? new Set([expression.name.text]) : undefined;
    }
    if (ts.isElementAccessExpression(expression)) {
      const owner = tracked(expression.expression, names);
      if (owner && expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression) && owner.has(expression.argumentExpression.text)) return new Set([expression.argumentExpression.text]);
    }
    return undefined;
  };
  const withoutParameters = (names: ReadonlyMap<string, InputFieldSet>, functionLike: FunctionLike): Map<string, InputFieldSet> => {
    const next = new Map(names);
    for (const parameter of functionLike.parameters) for (const name of bindingNames(parameter.name)) next.delete(name);
    return next;
  };
  const scanHelper = (helper: FunctionLike, names: ReadonlyMap<string, InputFieldSet>): void => {
    if (tracedHelpers.has(helper)) return;
    tracedHelpers.add(helper);
    if (helper.body) scan(helper.body, names);
  };
  const scan = (node: ts.Node, names: ReadonlyMap<string, InputFieldSet>): void => {
    if (isFunctionLike(node)) {
      if (node.body) scan(node.body, withoutParameters(names, node));
      return;
    }
    if (ts.isPropertyAccessExpression(node)) mark(directField(node, names));
    if (ts.isElementAccessExpression(node)) {
      const owner = tracked(node.expression, names);
      if (owner && (!node.argumentExpression || !ts.isStringLiteral(node.argumentExpression))) mark(owner);
      else mark(directField(node, names));
    }
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) mark(tracked(node.expression, names) ?? directField(node.expression, names));
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const source = tracked(node.initializer, names);
      if (source) {
        if (ts.isIdentifier(node.name)) {
          const next = new Map(names);
          next.set(node.name.text, source);
          ts.forEachChild(node, (child) => scan(child, next));
          return;
        }
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (element.dotDotDotToken) mark(source);
            else {
              const key = element.propertyName ? propertyName(element.propertyName) : ts.isIdentifier(element.name) ? element.name.text : undefined;
              if (key && source.has(key)) used.add(key);
            }
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const helper = ts.isIdentifier(node.expression) ? localFunctions.get(node.expression.text) : undefined;
      if (helper) {
        const forwarded = new Map<string, InputFieldSet>();
        node.arguments.forEach((argument, index) => {
          const value = tracked(argument, names);
          const parameter = helper.parameters[index];
          if (value && parameter && ts.isIdentifier(parameter.name)) forwarded.set(parameter.name.text, value);
        });
        if (forwarded.size) scanHelper(helper, forwarded);
      } else {
        for (const argument of node.arguments) mark(tracked(argument, names));
      }
      for (const argument of node.arguments) {
        if (isFunctionLike(argument) && argument.body) scan(argument.body, withoutParameters(names, argument));
      }
    }
    ts.forEachChild(node, (child) => scan(child, names));
  };

  if (handler.body) scan(handler.body, initialTracked);
  return used;
}

function localFunctionIndex(ast: ts.SourceFile): Map<string, FunctionLike> {
  const functions = new Map<string, FunctionLike>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFunctionLike(node.initializer)) functions.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return functions;
}

function objectStringProperty(object: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property) !== name || !ts.isStringLiteral(property.initializer)) continue;
    return property.initializer.text;
  }
  return undefined;
}

function propertyName(node: ts.ObjectLiteralElementLike | ts.PropertyName): string | undefined {
  const name = ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node) ? node.name : node;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => bindingNames(element.name));
}

function isFunctionLike(node: ts.Node | undefined): node is FunctionLike {
  return Boolean(node && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)));
}

function staticSchemaFor(rootSchema: string): JsonSchema {
  const definitions = Object.fromEntries(Object.entries(manifest.schema_catalog).map(([id, node]) => [id, hydrateCatalogNode(node.schema)]));
  return { $ref: catalogJsonPointer(rootSchema), $defs: definitions };
}

function hydrateCatalogNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrateCatalogNode);
  if (!isSchema(value)) return value;
  if (isCatalogRef(value)) return { $ref: catalogJsonPointer(value.$schema_ref) };
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, hydrateCatalogNode(child)]));
}

function catalogJsonPointer(id: string): string {
  return `#/$defs/${id.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function assertSchemaAndFieldParity(operationId: string, endpoint: "input" | "output", expected: StaticEndpointExpectation, staticSchema: JsonSchema, actualSchema: JsonSchema, projectedNodeIds: Set<string>): StaticFieldExpectation[] {
  assert.equal(canonicalProjectionSchemaId(actualSchema, projectedNodeIds), expected.root_schema, `schema_projection_drift:${operationId}:${endpoint}`);
  const staticFields = collectFields(staticSchema);
  const actualFields = normalizeFields(collectFields(actualSchema));
  assert.deepEqual(actualFields, normalizeFields(staticFields), `schema_projection_field_path_drift:${operationId}:${endpoint}`);
  return staticFields;
}

function canonicalProjectionSchemaId(schema: JsonSchema, projectedNodeIds = new Set<string>()): string {
  const canonicalize = (raw: JsonSchema, root: JsonSchema, activeRefs: Set<string>): string => {
    const resolved = resolveProjectionSchema(raw, root);
    if (isGlobalJsonValueProjection(resolved, root)) {
      projectedNodeIds.add("global_json_value");
      return "global_json_value";
    }
    const ref = typeof raw.$ref === "string" ? raw.$ref : undefined;
    if (ref && activeRefs.has(ref)) throw new Error(`schema_projection_unexpected_ref_cycle:${ref}`);
    const nextRefs = ref ? new Set([...activeRefs, ref]) : activeRefs;
    const node: JsonSchema = {};
    for (const key of Object.keys(resolved).sort()) {
      if (["$schema", "title", "description"].includes(key)) continue;
      const value = resolved[key];
      if (key === "properties" && isSchema(value)) {
        node[key] = Object.fromEntries(Object.entries(asSchemaMap(value)).sort(([left], [right]) => left.localeCompare(right)).map(([name, child]) => [name, { $schema_ref: canonicalize(child, root, nextRefs) }]));
      } else if (["items", "additionalProperties", "not", "if", "then", "else", "contains"].includes(key) && isSchema(value)) {
        node[key] = { $schema_ref: canonicalize(value, root, nextRefs) };
      } else if (["anyOf", "oneOf", "allOf", "prefixItems"].includes(key) && Array.isArray(value)) {
        node[key] = value.map((child) => isSchema(child) ? { $schema_ref: canonicalize(child, root, nextRefs) } : child);
      } else {
        node[key] = value;
      }
    }
    const id = `sha256:${schemaHash(node)}`;
    projectedNodeIds.add(id);
    return id;
  };
  return canonicalize(schema, schema, new Set());
}

function resolveProjectionSchema(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (ref === undefined) return schema;
  if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error(`schema_projection_external_ref_unsupported:${String(ref)}`);
  const target = ref.slice(2).split("/").reduce<unknown>((current, token) => current && typeof current === "object" ? (current as Record<string, unknown>)[token.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, root);
  if (!isSchema(target)) throw new Error(`schema_projection_ref_missing:${ref}`);
  return target;
}

function isGlobalJsonValueProjection(schema: JsonSchema, root: JsonSchema): boolean {
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  if (branches.length !== 6) return false;
  const [string, number, boolean, nil, array, object] = branches;
  if (!isSchema(string) || !isSchema(number) || !isSchema(boolean) || !isSchema(nil) || !isSchema(array) || !isSchema(object)) return false;
  if (string.type !== "string" || number.type !== "number" || boolean.type !== "boolean" || nil.type !== "null" || array.type !== "array" || object.type !== "object") return false;
  if (!isSchema(array.items) || !isSchema(object.additionalProperties)) return false;
  return resolveProjectionSchema(array.items, root) === schema && resolveProjectionSchema(object.additionalProperties, root) === schema;
}

function isJsonValueFieldShape(schema: JsonSchema, root: JsonSchema, depth = 0, activeRefs = new Set<string>()): boolean {
  if (depth > 8) return false;
  const ref = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (ref && activeRefs.has(ref)) return true;
  const resolved = resolveSchema(schema, root);
  const nextRefs = ref ? new Set([...activeRefs, ref]) : activeRefs;
  const branches = Array.isArray(resolved.anyOf) ? resolved.anyOf.filter(isSchema) : [];
  const flattened = branches.flatMap((branch) => {
    const child = resolveSchema(branch, root);
    return schemaTypes(child).length === 0 && Array.isArray(child.anyOf)
      ? child.anyOf.filter(isSchema).map((nested) => resolveSchema(nested, root))
      : [child];
  });
  const byType = new Map(flattened.map((branch) => [schemaTypes(branch)[0], branch]));
  if (!["string", "number", "boolean", "null", "array", "object"].every((type) => byType.has(type))) return false;
  const array = byType.get("array");
  const object = byType.get("object");
  if (!array || !object || !isSchema(array.items) || !isSchema(object.additionalProperties)) return false;
  const scalar = (child: JsonSchema): boolean => {
    const childTypes = schemaTypes(resolveSchema(child, root));
    return childTypes.length === 1 && ["string", "number", "boolean", "null"].includes(childTypes[0]!);
  };
  const child = (value: JsonSchema): boolean => scalar(value) || isJsonValueFieldShape(value, root, depth + 1, nextRefs);
  return child(array.items) && child(object.additionalProperties);
}

function schemaHash(schema: JsonSchema): string {
  return createHash("sha256").update(stableJson(schema)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isSchema(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function normalizeFields(fields: StaticFieldExpectation[]): Omit<StaticFieldExpectation, "review">[] {
  return fields.map(({ review: _review, ...field }) => field).sort((left, right) => fieldIdentity(left).localeCompare(fieldIdentity(right)));
}

function fieldIdentity(field: Omit<StaticFieldExpectation, "review"> | StaticFieldExpectation): string {
  return `${field.path}:${field.kind}`;
}

function assertAccepted(operationId: string, endpoint: "input" | "output", value: unknown, expectedValidator: ReturnType<Ajv["compile"]>, actualValidator: ReturnType<Ajv["compile"]>, zodAccepted: boolean): void {
  assert.equal(expectedValidator(value), true, `schema_manifest_valid_sample_invalid:${operationId}:${endpoint}`);
  assert.equal(actualValidator(value), true, `schema_projection_rejects_manifest_valid_sample:${operationId}:${endpoint}`);
  assert.equal(zodAccepted, true, `zod_rejects_manifest_valid_sample:${operationId}:${endpoint}`);
}

function assertRejected(operationId: string, endpoint: "input" | "output", testCase: MatrixCase, actualValidator: ReturnType<Ajv["compile"]>, zodAccepted: boolean): void {
  assert.equal(actualValidator(testCase.value), false, `ajv_acceptance_mismatch:${operationId}:${endpoint}:${testCase.id}`);
  assert.equal(zodAccepted, false, `zod_acceptance_mismatch:${operationId}:${endpoint}:${testCase.id}`);
}

function assertFullCaseCoverage(operationId: string, endpoint: "input" | "output", fields: StaticFieldExpectation[], cases: MatrixCase[]): void {
  const expected = new Set(fields.flatMap((field) => field.checks.filter((check) => check !== "global_limit").map((check) => `${field.path}:${check}`)));
  const actual = new Set(cases.map((testCase) => testCase.id));
  const missing = [...expected].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  assert.equal(missing.length, 0, `schema_matrix_uncovered_constraints:${operationId}:${endpoint}:${missing.slice(0, 8).join(",")}`);
  assert.equal(unexpected.length, 0, `schema_matrix_unreviewed_generated_cases:${operationId}:${endpoint}:${unexpected.slice(0, 8).join(",")}`);
}

async function assertValidBinding(definition: OperationDefinition, validInput: unknown, validOutput: unknown): Promise<void> {
  const binding = testBinding(definition, validOutput, () => {});
  const result = await binding.execute(trustedContext(definition), validInput);
  assert.equal(result.ok, true, `bind_operation_definition_rejects_manifest_valid_sample:${definition.id}`);
}

async function assertInputBindingRejects(definition: OperationDefinition, validOutput: unknown, testCase: MatrixCase): Promise<void> {
  let handlerCalls = 0;
  const binding = testBinding(definition, validOutput, () => { handlerCalls += 1; });
  await assert.rejects(
    binding.execute(trustedContext(definition), testCase.value),
    (error: unknown) => error instanceof DomainContractError && error.stage === "input",
    `bind_input_acceptance_mismatch:${definition.id}:${testCase.id}`
  );
  assert.equal(handlerCalls, 0, `invalid_input_reaches_handler:${definition.id}:${testCase.id}`);
}

async function assertOutputBindingRejects(definition: OperationDefinition, validInput: unknown, testCase: MatrixCase): Promise<void> {
  const binding = testBinding(definition, testCase.value, () => {});
  await assert.rejects(
    binding.execute(trustedContext(definition), validInput),
    (error: unknown) => error instanceof DomainContractError && error.stage === "output",
    `bind_output_acceptance_mismatch:${definition.id}:${testCase.id}`
  );
}

function testBinding(definition: OperationDefinition, output: unknown, onHandler: () => void): BoundOperationDefinition {
  return bindOperationDefinition(definition as never, {
    async execute() {
      onHandler();
      return { ok: true as const, value: output };
    }
  } as never);
}

function trustedContext(definition: OperationDefinition): TrustedDomainContext {
  return {
    inputSource: definition.sources[0]!,
    workspaceId: "schema-matrix-workspace",
    actorId: "schema-matrix-actor",
    correlationId: `schema-matrix:${definition.id}`
  };
}

async function assertGlobalPayloadLimits(validOutputs: Map<string, unknown>): Promise<void> {
  const definition = definitions.find((candidate) => candidate.id === "artifact.create") ?? definitions[0];
  assert.ok(definition, "schema_global_limit_definition_missing");
  const bindings = definitions.map((candidate, index) => ({
    definition: candidate,
    handlerName: `schemaMatrixGlobalLimitHandler${index}`,
    async execute() { return { ok: true as const, value: validOutputs.get(candidate.id) }; }
  })) as unknown as BoundOperationDefinition[];
  const registry = new DomainOperationRegistry({} as DomainOperationPorts, bindings);
  const limits = manifest.global_payload_limits;
  const context = trustedContext(definition);
  await assertLimitBoundary(registry, context, definition.id, "string_length", { value: "x".repeat(limits.maximum_string_length) }, { value: "x".repeat(limits.maximum_string_length + 1) });
  await assertLimitBoundary(registry, context, definition.id, "array_items", { value: Array.from({ length: limits.maximum_array_items }, () => 0) }, { value: Array.from({ length: limits.maximum_array_items + 1 }, () => 0) });
  await assertLimitBoundary(registry, context, definition.id, "object_keys", objectWithKeys(limits.maximum_object_keys), objectWithKeys(limits.maximum_object_keys + 1));
  await assertLimitBoundary(registry, context, definition.id, "depth", nestedObject(limits.maximum_depth), nestedObject(limits.maximum_depth + 1));
  const atTotal = { a: "x".repeat(limits.maximum_string_length), b: "x".repeat(limits.maximum_total_characters - limits.maximum_string_length - 2) };
  const beyondTotal = { a: "x".repeat(limits.maximum_string_length), b: "x".repeat(limits.maximum_total_characters - limits.maximum_string_length - 1) };
  await assertLimitBoundary(registry, context, definition.id, "total_characters", atTotal, beyondTotal);
  const forbidden = JSON.parse('{"__proto__":"injected"}') as Record<string, unknown>;
  await assert.rejects(
    registry.execute(context, definition.id, forbidden),
    (error: unknown) => error instanceof DomainOperationError && error.message.endsWith(":forbidden_key"),
    "schema_global_limit_forbidden_key_rejected"
  );
}

async function assertLimitBoundary(registry: DomainOperationRegistry, context: TrustedDomainContext, operationId: string, reason: string, atLimit: unknown, beyondLimit: unknown): Promise<void> {
  const accepted = await registry.execute(context, operationId, atLimit);
  assert.equal(accepted.ok, true, `schema_global_limit_at_boundary:${reason}`);
  await assert.rejects(registry.execute(context, operationId, beyondLimit), (error: unknown) => error instanceof DomainOperationError && error.message.endsWith(`:${reason}`), `schema_global_limit_over_boundary:${reason}`);
}

function objectWithKeys(size: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: size }, (_, index) => [`k${index}`, index]));
}

function nestedObject(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  return root;
}

function invalidCases(schema: JsonSchema, valid: unknown, validator: ReturnType<Ajv["compile"]>): MatrixCase[] {
  const cases = new Map<string, MatrixCase>();
  const add = (route: string, kind: Exclude<CaseKind, "global_limit">, value: unknown) => {
    const id = `${route}:${kind}`;
    if (cases.has(id)) return;
    const candidate = validator(value) === false ? value : forceInvalidRoot(schema);
    if (validator(candidate) !== false) return;
    cases.set(id, { id, kind, value: candidate });
  };
  walkCases(schema, schema, valid, [], "$", null, "root", add, 0, new Set());
  return [...cases.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function forceInvalidRoot(schema: JsonSchema): unknown {
  return incompatibleValue(schema, schema);
}

function walkCases(raw: JsonSchema, root: JsonSchema, value: unknown, at: PathPart[], route: string, required: boolean | null, kind: StaticFieldExpectation["kind"], add: (route: string, kind: Exclude<CaseKind, "global_limit">, value: unknown) => void, depth: number, activeRefs: Set<string>): void {
  if (depth > 10) return;
  const ref = typeof raw.$ref === "string" ? raw.$ref : undefined;
  if (ref && activeRefs.has(ref)) return;
  const resolved = ref ? resolveSchema(raw, root) : raw;
  const nextRefs = ref ? new Set([...activeRefs, ref]) : activeRefs;
  const types = schemaTypes(resolved);
  const object = types.includes("object") || isSchema(resolved.properties);
  const array = types.includes("array") || isSchema(resolved.items) || Array.isArray(resolved.items) || Array.isArray(resolved.prefixItems);
  if (required === true && at.length > 0) add(route, "required", removeAt(value, at));
  if (types.length > 0) add(route, "type", setAt(value, at, incompatibleValue(resolved, root)));
  const constraints = constraintsFor(resolved);
  if (Array.isArray(constraints.enum) || "const" in constraints) {
    const outside = enumOutside(Array.isArray(constraints.enum) ? constraints.enum : [constraints.const]);
    if (outside !== undefined) add(route, "enum", setAt(value, at, outside));
  }
  addConstraintCases(resolved, root, value, at, route, add);
  if (isJsonValueFieldShape(resolved, root)) return;
  if (object && resolved.additionalProperties === false) {
    const unknown = { ...asObject(getAt(value, at)), __unexpected_contract_field: true };
    const requiredName = stringArray(resolved.required)[0];
    if (requiredName) delete unknown[requiredName];
    add(route, "unknown_key", setAt(value, at, unknown));
  }
  if (kind === "additional_property") return;
  const branches = Array.isArray(resolved.anyOf) ? resolved.anyOf : Array.isArray(resolved.oneOf) ? resolved.oneOf : [];
  for (const [index, branch] of branches.entries()) {
    if (!isSchema(branch)) continue;
    const branchValue = completeSample(branch, root);
    const branchBase = at.length === 0 ? branchValue : setAt(value, at, branchValue);
    walkCases(branch, root, branchBase, at, `${route}.branch[${index}]`, required, "union_branch", add, depth + 1, nextRefs);
  }
  if (Array.isArray(resolved.allOf)) {
    for (const [index, branch] of resolved.allOf.entries()) {
      if (isSchema(branch)) walkCases(branch, root, value, at, `${route}.allOf[${index}]`, required, "all_of_branch", add, depth + 1, nextRefs);
    }
  }
  if (object) {
    const requiredNames = new Set(stringArray(resolved.required));
    for (const [name, child] of Object.entries(asSchemaMap(resolved.properties))) {
      walkCases(child, root, value, [...at, name], `${route}[${JSON.stringify(name)}]`, requiredNames.has(name), "property", add, depth + 1, nextRefs);
    }
    if (isSchema(resolved.additionalProperties)) {
      walkCases(resolved.additionalProperties, root, value, additionalPropertyPath(value, at, resolved, root), `${route}.*`, null, "additional_property", add, depth + 1, nextRefs);
    }
  }
  if (array) {
    const arrayValue = getAt(value, at);
    if (Array.isArray(arrayValue) && arrayValue.length > 0 && isSchema(resolved.items)) walkCases(resolved.items, root, value, [...at, 0], `${route}[]`, null, "array_item", add, depth + 1, nextRefs);
    if (Array.isArray(arrayValue) && Array.isArray(resolved.items)) {
      for (const [index, child] of resolved.items.entries()) if (isSchema(child)) walkCases(child, root, value, [...at, index], `${route}[${index}]`, null, "tuple_item", add, depth + 1, nextRefs);
    }
    if (Array.isArray(resolved.prefixItems)) {
      for (const [index, child] of resolved.prefixItems.entries()) if (isSchema(child)) walkCases(child, root, value, [...at, index], `${route}[${index}]`, null, "tuple_item", add, depth + 1, nextRefs);
    }
  }
}

function addConstraintCases(schema: JsonSchema, root: JsonSchema, value: unknown, at: PathPart[], route: string, add: (route: string, kind: Exclude<CaseKind, "global_limit">, value: unknown) => void): void {
  const constraints = constraintsFor(schema);
  const types = schemaTypes(schema);
  const current = getAt(value, at);
  if (types.includes("string")) {
    if (typeof constraints.minLength === "number" && constraints.minLength > 0) add(route, "minLength", setAt(value, at, validPatternString(schema, Math.max(0, constraints.minLength - 1))));
    if (typeof constraints.maxLength === "number") add(route, "maxLength", setAt(value, at, overlongString(schema, current, constraints.maxLength + 1)));
    if (typeof constraints.pattern === "string") add(route, "pattern", setAt(value, at, "!".repeat(Math.max(4, typeof constraints.minLength === "number" ? constraints.minLength : 1))));
    if (typeof constraints.format === "string") add(route, "format", setAt(value, at, "not a valid format"));
  }
  if (types.includes("number") || types.includes("integer")) {
    if (typeof constraints.minimum === "number") add(route, "minimum", setAt(value, at, constraints.minimum - 1));
    if (typeof constraints.maximum === "number") add(route, "maximum", setAt(value, at, constraints.maximum + 1));
    if (typeof constraints.exclusiveMinimum === "number") add(route, "exclusiveMinimum", setAt(value, at, constraints.exclusiveMinimum));
    if (typeof constraints.exclusiveMaximum === "number") add(route, "exclusiveMaximum", setAt(value, at, constraints.exclusiveMaximum));
    if (typeof constraints.multipleOf === "number") add(route, "multipleOf", setAt(value, at, constraints.multipleOf / 2));
  }
  if (types.includes("array")) {
    if (typeof constraints.minItems === "number" && constraints.minItems > 0) add(route, "minItems", setAt(value, at, []));
    if (typeof constraints.maxItems === "number") add(route, "maxItems", setAt(value, at, Array.from({ length: constraints.maxItems + 1 }, () => completeSample(itemSchema(schema) ?? {}, root))));
  }
  if (types.includes("object") || isSchema(schema.properties)) {
    if (typeof constraints.minProperties === "number" && constraints.minProperties > 0) add(route, "minProperties", setAt(value, at, {}));
    if (typeof constraints.maxProperties === "number") add(route, "maxProperties", setAt(value, at, objectWithKeys(constraints.maxProperties + 1)));
  }
}

function collectFields(root: JsonSchema): StaticFieldExpectation[] {
  const fields: StaticFieldExpectation[] = [];
  const seen = new Set<string>();
  const visit = (raw: JsonSchema, route: string, schemaRoute: string, required: boolean | null, kind: StaticFieldExpectation["kind"], depth: number, activeRefs: Set<string>): void => {
    if (depth > 10) return;
    const ref = typeof raw.$ref === "string" ? raw.$ref : undefined;
    if (ref && activeRefs.has(ref)) return;
    const resolved = ref ? resolveSchema(raw, root) : raw;
    const referenceRoute = ref ? `${schemaRoute}=>${ref}` : schemaRoute;
    const marker = `${route}|${referenceRoute}|${kind}`;
    if (seen.has(marker)) return;
    seen.add(marker);
    const nextRefs = ref ? new Set([...activeRefs, ref]) : activeRefs;
    const types = schemaTypes(resolved);
    const object = types.includes("object") || isSchema(resolved.properties);
    const array = types.includes("array") || isSchema(resolved.items) || Array.isArray(resolved.items) || Array.isArray(resolved.prefixItems);
    const closure = object ? resolved.additionalProperties === false ? "closed" : isSchema(resolved.additionalProperties) ? "typed" : "open" : undefined;
    const constraints = constraintsFor(resolved);
    fields.push({
      path: route,
      kind,
      required,
      types,
      ...(Object.keys(constraints).length > 0 ? { constraint_kinds: Object.keys(constraints).sort() } : {}),
      ...(closure ? { unknown_key_policy: closure } : {}),
      limit_classification: limitClassification(types, constraints),
      checks: checksFor(required, types, constraints, closure),
      review: "reviewed"
    });
    if (isJsonValueFieldShape(resolved, root)) return;
    if (kind === "additional_property") return;
    const branches = Array.isArray(resolved.anyOf) ? resolved.anyOf : Array.isArray(resolved.oneOf) ? resolved.oneOf : [];
    for (const [index, branch] of branches.entries()) if (isSchema(branch)) visit(branch, `${route}.branch[${index}]`, `${referenceRoute}/${Array.isArray(resolved.anyOf) ? "anyOf" : "oneOf"}/${index}`, required, "union_branch", depth + 1, nextRefs);
    if (Array.isArray(resolved.allOf)) for (const [index, branch] of resolved.allOf.entries()) if (isSchema(branch)) visit(branch, `${route}.allOf[${index}]`, `${referenceRoute}/allOf/${index}`, required, "all_of_branch", depth + 1, nextRefs);
    if (object) {
      const requiredNames = new Set(stringArray(resolved.required));
      for (const [name, child] of Object.entries(asSchemaMap(resolved.properties))) visit(child, `${route}[${JSON.stringify(name)}]`, `${referenceRoute}/properties/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`, requiredNames.has(name), "property", depth + 1, nextRefs);
      if (isSchema(resolved.additionalProperties)) visit(resolved.additionalProperties, `${route}.*`, `${referenceRoute}/additionalProperties`, null, "additional_property", depth + 1, nextRefs);
    }
    if (array) {
      if (isSchema(resolved.items)) visit(resolved.items, `${route}[]`, `${referenceRoute}/items`, null, "array_item", depth + 1, nextRefs);
      if (Array.isArray(resolved.items)) for (const [index, child] of resolved.items.entries()) if (isSchema(child)) visit(child, `${route}[${index}]`, `${referenceRoute}/items/${index}`, null, "tuple_item", depth + 1, nextRefs);
      if (Array.isArray(resolved.prefixItems)) for (const [index, child] of resolved.prefixItems.entries()) if (isSchema(child)) visit(child, `${route}[${index}]`, `${referenceRoute}/prefixItems/${index}`, null, "tuple_item", depth + 1, nextRefs);
    }
  };
  visit(root, "$", "#", null, "root", 0, new Set());
  return fields.sort((left, right) => fieldIdentity(left).localeCompare(fieldIdentity(right)));
}

function constraintsFor(schema: JsonSchema): Record<string, unknown> {
  const constraints: Record<string, unknown> = {};
  for (const key of ["minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "minProperties", "maxProperties"]) if (key in schema) constraints[key] = schema[key];
  if ("const" in schema) constraints.const = schema.const;
  if (Array.isArray(schema.enum)) constraints.enum = schema.enum;
  return constraints;
}

function checksFor(required: boolean | null, types: string[], constraints: Record<string, unknown>, closure: "closed" | "typed" | "open" | undefined): CaseKind[] {
  const checks: CaseKind[] = [];
  if (required === true) checks.push("required");
  if (types.length > 0) checks.push("type");
  if (Array.isArray(constraints.enum) || "const" in constraints) checks.push("enum");
  if (typeof constraints.minLength === "number" && constraints.minLength > 0) checks.push("minLength");
  if (typeof constraints.maxLength === "number") checks.push("maxLength");
  if (typeof constraints.pattern === "string") checks.push("pattern");
  if (typeof constraints.format === "string") checks.push("format");
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const) if (key in constraints) checks.push(key);
  if (typeof constraints.minItems === "number" && constraints.minItems > 0) checks.push("minItems");
  if (typeof constraints.maxItems === "number") checks.push("maxItems");
  if (typeof constraints.minProperties === "number" && constraints.minProperties > 0) checks.push("minProperties");
  if (typeof constraints.maxProperties === "number") checks.push("maxProperties");
  if (closure === "closed") checks.push("unknown_key");
  return checks;
}

function limitClassification(types: string[], constraints: Record<string, unknown>): StaticFieldExpectation["limit_classification"] {
  const string = types.includes("string");
  const array = types.includes("array");
  const object = types.includes("object");
  const local = (string && ("minLength" in constraints || "maxLength" in constraints)) || (array && ("minItems" in constraints || "maxItems" in constraints)) || (object && ("minProperties" in constraints || "maxProperties" in constraints));
  const global = string || array || object || types.length === 0;
  return local && global ? "local_and_global" : local ? "local" : global ? "global_only" : "not_applicable";
}

function completeSample(schema: JsonSchema, root: JsonSchema = schema, depth = 0): unknown {
  if (depth > 10) return null;
  const resolved = resolveSchema(schema, root);
  const branches = Array.isArray(resolved.anyOf) ? resolved.anyOf : Array.isArray(resolved.oneOf) ? resolved.oneOf : [];
  const branch = branches.find(isSchema);
  if (branch) return completeSample(branch, root, depth + 1);
  if (Array.isArray(resolved.allOf)) return resolved.allOf.filter(isSchema).reduce<unknown>((current, child) => mergeSample(current, completeSample(child, root, depth + 1)), {});
  if ("const" in resolved) return resolved.const;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0];
  const types = schemaTypes(resolved);
  if (types.includes("object") || isSchema(resolved.properties)) {
    const required = new Set(stringArray(resolved.required));
    const sample = Object.fromEntries(Object.entries(asSchemaMap(resolved.properties)).flatMap(([key, child]) => {
      if (!required.has(key) && isImpossibleSchema(child, root)) return [];
      return [[key, completeSample(child, root, depth + 1)]];
    }));
    if (isSchema(resolved.additionalProperties)) sample[additionalPropertyKey(resolved, root)] = completeSample(resolved.additionalProperties, root, depth + 1);
    return sample;
  }
  if (types.includes("array")) {
    if (Array.isArray(resolved.items)) {
      const tuple = resolved.items.filter(isSchema).map((item) => completeSample(item, root, depth + 1));
      if (tuple.length > 0) return tuple;
    }
    if (Array.isArray(resolved.prefixItems)) {
      const tuple = resolved.prefixItems.filter(isSchema).map((item) => completeSample(item, root, depth + 1));
      if (tuple.length > 0) return tuple;
    }
    const maximum = typeof resolved.maxItems === "number" ? resolved.maxItems : Number.POSITIVE_INFINITY;
    const minimum = typeof resolved.minItems === "number" ? resolved.minItems : 0;
    const count = Math.min(maximum, Math.max(minimum, maximum === 0 ? 0 : 1));
    return Array.from({ length: count }, () => completeSample(itemSchema(resolved) ?? {}, root, depth + 1));
  }
  if (types.includes("number") || types.includes("integer")) {
    const minimum = typeof resolved.minimum === "number" ? resolved.minimum : typeof resolved.exclusiveMinimum === "number" ? resolved.exclusiveMinimum + 1 : 1;
    return types.includes("integer") ? Math.ceil(minimum) : minimum;
  }
  if (types.includes("boolean")) return true;
  if (types.includes("null")) return null;
  if (resolved.format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (resolved.format === "uri") return "https://example.com/";
  return validPatternString(resolved, Math.max(1, typeof resolved.minLength === "number" ? resolved.minLength : 1));
}

function isImpossibleSchema(schema: JsonSchema, root: JsonSchema): boolean {
  const resolved = resolveSchema(schema, root);
  return Boolean(resolved.not);
}

function validPatternString(schema: JsonSchema, length: number): string {
  if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (schema.format === "uri") return "https://example.com/";
  const minimum = Math.max(1, length);
  const candidates = [
    "A".repeat(minimum),
    `application/json${"A".repeat(Math.max(0, minimum - "application/json".length))}`,
    `dGVzdA==${"A".repeat(Math.max(0, minimum - "dGVzdA==".length))}`,
    `sample${"A".repeat(Math.max(0, minimum - "sample".length))}`
  ];
  if (typeof schema.pattern !== "string") return candidates[0];
  try {
    const pattern = new RegExp(schema.pattern);
    const match = candidates.find((candidate) => pattern.test(candidate));
    if (match) return match;
  } catch { /* the production schema validator will reject an invalid pattern */ }
  throw new Error(`schema_matrix_valid_pattern_unavailable:${schema.pattern}`);
}

function overlongString(schema: JsonSchema, current: unknown, length: number): string {
  if (schema.format === "uri") return `https://example.com/${"x".repeat(Math.max(1, length))}`;
  const source = typeof current === "string" ? current : validPatternString(schema, length);
  return source.padEnd(length, "A");
}

function incompatibleValue(schema: JsonSchema, root: JsonSchema): unknown {
  const types = schemaTypes(resolveSchema(schema, root));
  if (types.includes("string")) return 42;
  if (types.includes("number") || types.includes("integer")) return "not-a-number";
  if (types.includes("boolean")) return "not-a-boolean";
  if (types.includes("array")) return {};
  if (types.includes("object")) return [];
  if (types.includes("null")) return true;
  return { __wrong_type: true };
}

function enumOutside(values: unknown[]): unknown {
  if (values.every((value) => typeof value === "string")) return "__not_in_static_enum__";
  if (values.every((value) => typeof value === "number")) return Math.max(...values as number[]) + 1;
  if (values.length === 1 && typeof values[0] === "boolean") return !values[0];
  if (values.length === 1 && values[0] === null) return true;
  return undefined;
}

function resolveSchema(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema;
  const target = schema.$ref.slice(2).split("/").reduce<unknown>((current, token) => {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    return current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }, root);
  return isSchema(target) ? target : schema;
}

function schemaTypes(schema: JsonSchema): string[] {
  return Array.isArray(schema.type) ? schema.type.filter((value): value is string => typeof value === "string") : typeof schema.type === "string" ? [schema.type] : [];
}

function itemSchema(schema: JsonSchema): JsonSchema | undefined {
  if (isSchema(schema.items)) return schema.items;
  if (Array.isArray(schema.items)) return schema.items.find(isSchema);
  return Array.isArray(schema.prefixItems) ? schema.prefixItems.find(isSchema) : undefined;
}

function asSchemaMap(value: unknown): Record<string, JsonSchema> {
  if (!isSchema(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, JsonSchema] => isSchema(entry[1])));
}

function additionalPropertyPath(value: unknown, at: PathPart[], schema: JsonSchema, root: JsonSchema): PathPart[] {
  const declared = new Set(Object.keys(asSchemaMap(schema.properties)));
  const existing = Object.keys(asObject(getAt(value, at))).find((key) => !declared.has(key));
  return [...at, existing ?? additionalPropertyKey(schema, root)];
}

function additionalPropertyKey(schema: JsonSchema, root: JsonSchema): string {
  const declared = new Set(Object.keys(asSchemaMap(schema.properties)));
  const propertyNames = isSchema(schema.propertyNames) ? resolveSchema(schema.propertyNames, root) : undefined;
  const allowed = Array.isArray(propertyNames?.enum) ? propertyNames.enum.find((value): value is string => typeof value === "string" && !declared.has(value)) : undefined;
  let key = allowed ?? "__schema_matrix_dynamic_key";
  let suffix = 0;
  while (declared.has(key)) key = `__schema_matrix_dynamic_key_${++suffix}`;
  return key;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isSchema(value: unknown): value is JsonSchema {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asObject(value: unknown): Record<string, unknown> {
  return isSchema(value) ? value : {};
}

function getAt(value: unknown, at: PathPart[]): unknown {
  return at.reduce<unknown>((current, part) => typeof part === "number" ? Array.isArray(current) ? current[part] : undefined : asObject(current)[part], value);
}

function setAt(value: unknown, at: PathPart[], replacement: unknown): unknown {
  if (at.length === 0) return replacement;
  const [head, ...tail] = at;
  if (typeof head === "number") {
    const source = Array.isArray(value) ? value : [];
    const copy = [...source];
    copy[head] = setAt(copy[head], tail, replacement);
    return copy;
  }
  return { ...asObject(value), [head]: setAt(asObject(value)[head], tail, replacement) };
}

function removeAt(value: unknown, at: PathPart[]): unknown {
  if (at.length === 0) return undefined;
  const [head, ...tail] = at;
  if (typeof head === "number") {
    const source = Array.isArray(value) ? value : [];
    const copy = [...source];
    if (tail.length === 0) copy.splice(head, 1); else copy[head] = removeAt(copy[head], tail);
    return copy;
  }
  const source = asObject(value);
  if (tail.length === 0) {
    const { [head]: _removed, ...rest } = source;
    return rest;
  }
  return { ...source, [head]: removeAt(source[head], tail) };
}

function mergeSample(left: unknown, right: unknown): unknown {
  if (left && typeof left === "object" && !Array.isArray(left) && right && typeof right === "object" && !Array.isArray(right)) return { ...(left as Record<string, unknown>), ...(right as Record<string, unknown>) };
  return right;
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!isSchema(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["$schema", "title", "description"].includes(key)).map(([key, child]) => [key, normalizeSchema(child)]));
}

function createAjv(): Ajv {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  ajv.addFormat("date-time", { type: "string", validate: (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)) });
  ajv.addFormat("uri", { type: "string", validate: (value: string) => /^[a-z][a-z0-9+.-]*:/i.test(value) && !/\s/.test(value) });
  return ajv;
}

function emptyCounter(): Counter {
  return { cases: 0, required: 0, type: 0, enum: 0, bound: 0, format: 0, pattern: 0, unknownKey: 0 };
}

function count(counter: Counter, kind: Exclude<CaseKind, "global_limit">): void {
  counter.cases += 1;
  if (kind === "required") counter.required += 1;
  else if (kind === "type") counter.type += 1;
  else if (kind === "enum") counter.enum += 1;
  else if (kind === "format") counter.format += 1;
  else if (kind === "pattern") counter.pattern += 1;
  else if (kind === "unknown_key") counter.unknownKey += 1;
  else counter.bound += 1;
}
