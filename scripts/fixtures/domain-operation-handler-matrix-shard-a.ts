import assert from "node:assert/strict";
import Ajv from "ajv";
import staticManifestSource from "./domain-command-schema-expectations.json";
import {
  DomainContractError,
  bindOperationDefinition,
  jsonSchemaFor,
  type OperationDefinition,
  type TrustedDomainContext
} from "../../packages/domain-operations/src/definition/index";
import { operationDefinitions } from "../../packages/domain-operations/src/generated/operation-index.generated";
import {
  aHandlerCaseCount,
  aHandlerExpectations,
  aHandlerOperationCount,
  type AHandlerCallExpectation,
  type AHandlerCaseExpectation,
  type HandlerArgExpectation
} from "./domain-operation-handler-expectations-shard-a";

type JsonSchema = Record<string, unknown>;

interface StaticOperation {
  id: string;
  input: { root_schema: string };
}

interface StaticManifest {
  review_policy: { source: string; runtime_expected_value_generation: string; production_schema_or_ledger_import_for_expectation: string };
  schema_catalog: Record<string, { schema: JsonSchema }>;
  operations: StaticOperation[];
}

interface InputCoverage {
  fields: Set<string>;
  required: Set<string>;
  enums: Map<string, Set<string>>;
  unions: Map<string, Set<number>>;
}

const manifest = staticManifestSource as StaticManifest;
const operationIds = Object.keys(aHandlerExpectations).sort();
const definitionById = new Map(operationDefinitions.map((definition) => [definition.id, definition]));
const staticOperationById = new Map(manifest.operations.map((operation) => [operation.id, operation]));
const now = "2026-07-17T00:00:00.000Z";
const contextBase: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "handler-matrix-workspace",
  actorId: "handler-matrix-actor",
  correlationId: "handler-matrix",
  sessionId: "session_fixture",
  runId: "run_fixture"
};

const artifactRef = { kind: "artifact", id: "artifact_fixture", uri: "artifacts/artifact_fixture.md", label: "Fixture artifact" };
const session = { id: "session_fixture", session_key: "session_fixture", title: "Fixture session", ui_locale: "en", output_locale: "en", created_at: now, updated_at: now };
const envelope = { id: "envelope_fixture", source: "web", actor_identity: "owner", session_key: "session_fixture", user_intent: "Fixture intent", attachments: [], input_locale: "en", output_locale: "en", metadata: {}, received_at: now };
const operation = { id: "operation_fixture", session_id: "session_fixture", capability_id: "fixture", operation: "fixture", actor_identity: "owner", instruction_source: "owner_instruction", instruction_authority: "owner", channel: "test", input_hash: "fixture_hash", target_resource_refs: [], proposed_effects: [], status: "completed", created_at: now, updated_at: now };
const artifact = { id: "artifact_fixture", title: "Fixture artifact", kind: "markdown", locale: "en", source_locales: ["en"], file_ref: artifactRef, metadata: { current_revision_id: "revision_fixture" }, source_operation_id: "operation_fixture", created_by: "fixture", created_at: now, updated_at: now };
const graphArtifact = { ...artifact, id: "graph_fixture", title: "Fixture graph", kind: "graph", file_ref: { kind: "artifact", id: "graph_fixture", uri: "artifacts/graph_fixture.json", label: "Fixture graph" } };
const revisionRef = { kind: "artifact_revision", id: "revision_fixture", uri: "artifacts/artifact_fixture/revisions/revision_fixture", label: "Fixture revision" };
const revision = { id: "revision_fixture", artifact_id: "artifact_fixture", revision: 1, parent_revision_id: "base_fixture", source_ref: artifactRef, file_ref: revisionRef, blob_ref: { kind: "file", id: "blobs/revision_fixture", uri: "blobs/revision_fixture", label: "Fixture blob" }, content_hash: "fixture_hash", content_bytes: 8, created_at: now };
const collectionSchema = { id: "collection_fixture", version: "1", labels: {}, descriptions: {}, fields: [], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {}, file_path: "collections/collection_fixture/schema.json" };
const collectionRecord = { id: "record_fixture", collection_id: "collection_fixture", version: 1, data: { title: "Fixture" }, resource_refs: [artifactRef], created_at: now, updated_at: now, file_path: "collections/collection_fixture/records/record_fixture.json" };
const generatedSurfaceAction = { id: "action_fixture", label: "Create", command_id: "artifact.create", input_schema: {}, payload_template: { approved: true }, requires_confirmation: false };
const surface = { id: "surface_fixture", state: "ephemeral", session_id: "session_fixture", title: "Fixture surface", input_data_schema: {}, actions: [generatedSurfaceAction], capability_manifest: { allowed_domain_commands: ["artifact.create"], network_access: "none", workspace_write: "domain_commands_only" }, source_refs: [], content_hash: "surface_hash", current_revision_id: "surface_revision_fixture", current_revision: 1, preview_url: "surfaces/surface_fixture", fallback_chain: ["built_in_surface"], created_at: now, updated_at: now };
const surfaceRevision = { id: "surface_revision_fixture", surface_id: "surface_fixture", revision: 1, prompt_fingerprint: "surface_hash", knowledge_refs: [], skill_refs: [], html_ref: { kind: "file", id: "surfaces/surface_fixture/index.html", uri: "surfaces/surface_fixture/index.html", label: "Fixture HTML" }, asset_refs: [], bundle_hash: "surface_hash", validation_report: { valid: true, issues: [], html_bytes: 20, css_bytes: 6, script_bytes: 0, action_count: 1, csp: "default-src 'none'" }, created_at: now };

assert.equal(manifest.review_policy.source, "frozen_static_schema_catalog", "handler_matrix_static_catalog_source_invalid");
assert.equal(manifest.review_policy.runtime_expected_value_generation, "forbidden", "handler_matrix_static_expectation_generation_allowed");
assert.equal(manifest.review_policy.production_schema_or_ledger_import_for_expectation, "forbidden", "handler_matrix_static_production_expectation_import_allowed");
assert.equal(aHandlerOperationCount, 30, "handler_matrix_shard_a_operation_count_invalid");
assert.equal(operationIds.length, 30, "handler_matrix_shard_a_operation_ids_invalid");
assert.equal(new Set(operationIds).size, 30, "handler_matrix_shard_a_duplicate_operation");

let assertions = 0;
let branchAssertions = 0;
let invalidInputAssertions = 0;
let invalidOutputAssertions = 0;
let staticMissing = 0;
let executedPortCalls = 0;
const staticInputTotals = { fields: 0, required: 0, enumValues: 0, unionBranches: 0 };

for (const operationId of operationIds) {
  const definition = definitionById.get(operationId);
  const expectation = aHandlerExpectations[operationId as keyof typeof aHandlerExpectations];
  const staticOperation = staticOperationById.get(operationId);
  assert.ok(definition, `handler_matrix_definition_missing:${operationId}`);
  assert.ok(staticOperation, `handler_matrix_static_operation_missing:${operationId}`);
  const staticInput = hydrateStaticRoot(staticOperation.input.root_schema);
  const expectedCoverage = expectedInputCoverage(staticInput);
  staticInputTotals.fields += expectedCoverage.fields.size;
  staticInputTotals.required += expectedCoverage.required.size;
  staticInputTotals.enumValues += [...expectedCoverage.enums.values()].reduce((count, values) => count + values.size, 0);
  staticInputTotals.unionBranches += [...expectedCoverage.unions.values()].reduce((count, values) => count + values.size, 0);
  const actualCoverage = emptyCoverage();
  const coveredBranches = new Set<string>();

  for (const testCase of expectation.cases) {
    const context = caseContext(testCase);
    const parsedInput = definition.input.parse(testCase.input) as Record<string, unknown>;
    coverInput(parsedInput, expectedCoverage, actualCoverage, staticInput);
    assertNestedBranchMetadata(operationId, testCase, parsedInput, staticInput);
    for (const branch of testCase.branches) coveredBranches.add(branch);

    const recorder = createPortRecorder(operationId, testCase, parsedInput, context, definition);
    const handler = definition.createHandler(recorder.ports as never);
    const result = await handler.execute(context, parsedInput as never);
    assert.equal(result.ok, true, `handler_matrix_handler_result_invalid:${operationId}:${testCase.id}`);
    recorder.assertComplete();
    assertions += 1;
    executedPortCalls += testCase.calls.length;
  }

  assert.deepEqual([...coveredBranches].sort(), [...expectation.requiredBranches].sort(), `handler_matrix_branch_coverage_missing:${operationId}`);
  branchAssertions += expectation.requiredBranches.length;
  staticMissing += assertInputCoverage(operationId, expectedCoverage, actualCoverage);

  await assertInvalidInputZeroCalls(definition, expectation.cases[0]!);
  invalidInputAssertions += 1;
  await assertInvalidOutputRejected(definition, expectation.cases[0]!);
  invalidOutputAssertions += 1;
}

assert.equal(assertions, aHandlerCaseCount, "handler_matrix_shard_a_cases_not_all_executed");
assert.equal(staticMissing, 0, "handler_matrix_static_input_coverage_missing_total");
const summary = {
  status: "passed",
  gates: ["RH06", "RH07", "RH08"],
  manifest_source: "scripts/fixtures/domain-command-schema-expectations.json",
  expectation_source: "scripts/fixtures/domain-operation-handler-expectations-shard-a.ts",
  covered_operations: aHandlerOperationCount,
  covered_operation_ids: operationIds,
  required_operations: 30,
  remaining_operations: 0,
  cases: assertions,
  port_calls: executedPortCalls,
  branches: branchAssertions,
  handler_branch_coverage_missing: 0,
  invalid_input_zero_calls: invalidInputAssertions,
  invalid_output_rejected: invalidOutputAssertions,
  static_input_coverage_missing: staticMissing,
  static_input_coverage: {
    top_level_fields: staticInputTotals.fields,
    required_fields: staticInputTotals.required,
    enum_values: staticInputTotals.enumValues,
    union_branches: staticInputTotals.unionBranches,
    missing: 0
  },
  expectation_mode: "static_method_args_order_count_forbidden"
};
process.stdout.write(`${JSON.stringify(summary)}\n`);

function caseContext(testCase: AHandlerCaseExpectation): TrustedDomainContext {
  return { ...contextBase, ...testCase.context };
}

function createPortRecorder(operationId: string, testCase: AHandlerCaseExpectation, parsedInput: Record<string, unknown>, context: TrustedDomainContext, definition: OperationDefinition) {
  let cursor = 0;
  const expected = testCase.calls;
  const callLog: Array<{ method: string; args: unknown[] }> = [];
  const dynamicValues = createDynamicValueTracker();
  const record = (method: string, args: unknown[]): unknown => {
    const next = expected[cursor];
    assert.ok(next, `handler_matrix_forbidden_port_call:${operationId}:${testCase.id}:${method}`);
    assert.equal(method, next.method, `handler_matrix_port_order_drift:${operationId}:${testCase.id}:${cursor}`);
    const normalizedArgs = dynamicValues.normalize(args);
    assertArgs(next, normalizedArgs, parsedInput, context, `${operationId}:${testCase.id}:${method}`);
    cursor += 1;
    callLog.push({ method, args: normalizedArgs });
    return portResponse(method, args, operationId, testCase, definition);
  };
  const syncMethods = new Set([
    "artifactContract", "collectionMutationContract", "createArtifactEnvelope", "createCollectionMutationEnvelope", "createFileEnvelope", "createBrowserEnvelope", "createRollbackEnvelope",
    "createGeneratedSurfaceRequestId", "generatedSurfaceNow", "generatedSurfaceFingerprint", "validateGraphArtifactContent", "resolveFilePath", "resolveBrowserWorkspacePath", "resolveRollbackPath",
    "isManagedCollectionPath", "stableBrowserHash", "browserBytesToBase64", "rollbackFileRef", "currentTimeMillis", "collectionDeleteAllowed", "collectionRecordRef", "collectionSchemaRef", "buildGeneratedSurfaceRevision"
  ]);
  const ports = new Proxy({}, {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      const method = String(property);
      return (...args: unknown[]) => {
        const value = record(method, args);
        return syncMethods.has(method) ? value : Promise.resolve(value);
      };
    }
  });
  return {
    ports,
    assertComplete() {
      assert.equal(cursor, expected.length, `handler_matrix_port_call_count_drift:${operationId}:${testCase.id}; actual=${JSON.stringify(callLog)}`);
    }
  };
}

function portResponse(method: string, args: unknown[], operationId: string, testCase: AHandlerCaseExpectation, definition: OperationDefinition): unknown {
  if (method.endsWith("Error") || method.includes("NotFoundError") || method.includes("QueryError")) return new Error(method);
  if (method === "artifactContract" || method === "collectionMutationContract") return { id: operationId, proposed_effects: proposedEffects(operationId) };
  if (method === "createArtifactEnvelope" || method === "createCollectionMutationEnvelope" || method === "createFileEnvelope" || method === "createBrowserEnvelope") return envelope;
  if (method === "createRollbackEnvelope") return envelope;
  if (method === "createArtifactSession" || method === "getArtifactSession" || method === "ensureArtifactSession" || method === "ensureCollectionMutationSession" || method === "ensureFileSession" || method === "ensureBrowserSession" || method === "ensureRollbackSession") return session;
  if (method === "getArtifact") return operationId === "graph.patch" ? graphArtifact : artifact;
  if (method === "getArtifactRevision") return revision;
  if (method === "readArtifactRevisionContent") return new Uint8Array([1, 2, 3]);
  if (method === "readArtifactContent") return operationId === "graph.patch" ? JSON.stringify({ version: "1", nodes: [], edges: [] }) : "fixture content";
  if (method === "exportArtifactPdf") return { adapterId: "fixture_adapter", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) };
  if (method === "createArtifactDraft") {
    const value = args[0] as Record<string, unknown>;
    return { ...artifact, title: value.title, kind: value.kind ?? "markdown", locale: value.locale, source_locales: value.sourceLocales, metadata: (value.metadata as Record<string, unknown>) ?? {}, created_by: value.createdBy };
  }
  if (method === "createArtifactRevision") return { artifact: operationId === "graph.patch" ? graphArtifact : artifact, revision };
  if (method === "createArtifactRollback" || method === "createCollectionRollback" || method === "createFileRollback" || method === "createBrowserRollback" || method === "createRestoreRollback") return rollbackPoint();
  if (method === "repairArtifactRevisionSource") return { repaired: true };
  if (method === "runArtifactMutation" || method === "runCollectionMutation" || method === "runFileMutation" || method === "runBrowserMutation" || method === "runRollbackMutation") return runMutation(args[0], operationId, definition);
  if (method === "getCollectionSchema" || method === "getCollectionSchemaForMutation") return operationId === "collection.schema.save" && testCase.id.startsWith("create") ? undefined : collectionSchema;
  if (method === "collectionDeleteAllowed") return true;
  if (method === "getCollectionRecord") return collectionRecord;
  if (method === "deleteCollectionRecord" || method === "saveCollectionRecord" || method === "applyCollectionRecordPatch") {
    if (method === "applyCollectionRecordPatch") return { before: collectionRecord, after: collectionRecord };
    return collectionRecord;
  }
  if (method === "saveCollectionSchema" || method === "updateCollectionSchema") return collectionSchema;
  if (method === "collectionRecordRef") return { kind: "collection_record", id: "collection_fixture:record_fixture", uri: collectionRecord.file_path, label: "Fixture record" };
  if (method === "collectionSchemaRef") return { kind: "collection_schema", id: "collection_fixture", uri: collectionSchema.file_path, label: "Fixture collection" };
  if (method === "reindexCollectionStore") return collectionIndex();
  if (method === "listCollectionRecords") return { collection_id: "collection_fixture", count: 0, items: [], linked_data: {}, schema_fields: {} };
  if (method === "readCollectionSchemaDocs") return { action: "schemaDocs", schema_docs: {} };
  if (method === "presentCollectionView") return sampleOutput(definition);
  if (method === "getGeneratedSurface" || method === "updateGeneratedSurfaceState") return surface;
  if (method === "resolveGeneratedSurfaceAction") return { surface, revisionId: surfaceRevision.id, action: surface.actions[0] };
  if (method === "getGeneratedSurfaceRevision") return surfaceRevision;
  if (method === "readGeneratedSurfaceBundle") return { html: "<main>fixture</main>", css: "main{}", script: "" };
  if (method === "saveGeneratedSurfaceInteraction") return args[0];
  if (method === "createGeneratedSurfaceRequestId") return "surface_request_fixture";
  if (method === "generatedSurfaceNow") return now;
  if (method === "generatedSurfaceFingerprint") return "surface_hash";
  if (method === "stableBrowserHash") return "browser_hash";
  if (method === "buildGeneratedSurfaceRevision") return { definition: surface, revision: surfaceRevision };
  if (method === "saveGeneratedSurfaceRevision") return { definition: surface, revision: surfaceRevision };
  if (method === "readBrowserPage") return { url: String(args[0]), title: "Fixture browser", html: "<main>fixture</main>", text: "Fixture browser text", adapter: "fetch" };
  if (method === "captureBrowserScreenshot") return { adapterId: "fixture_browser", bytes: new Uint8Array([1, 2, 3]), mimeType: testCase.id.includes("jpeg") ? "image/jpeg" : "image/png", width: 1, height: 1 };
  if (method === "resolveBrowserWorkspacePath") return workspacePath(String(args[0]));
  if (method === "readBrowserWorkspaceText") return "before fixture";
  if (method === "readBrowserWorkspaceBytes") return new Uint8Array([1]);
  if (method === "browserBytesToBase64") return "AQ==";
  if (method === "resolveFilePath" || method === "resolveRollbackPath") return workspacePath(String(args[0]));
  if (method === "readFileTextIfExists" || method === "readRollbackFile") return "before fixture";
  if (method === "isManagedCollectionPath") return String(args[0]).startsWith("workspace/");
  if (method === "rollbackFileRef") return { kind: "file", id: String(args[0]), uri: String(args[0]), label: String(args[0]) };
  if (method === "getRollbackPoint") return { id: String(args[0]), reversible: true, expires_at: "2099-01-01T00:00:00.000Z", before_snapshot: { path: "workspace/fixture.txt", content: testCase.id === "deleted" ? null : "fixture" } };
  if (method === "currentTimeMillis") return Date.parse("2026-07-17T00:00:00.000Z");
  if (method === "createWorkspaceBackup" || method === "restoreWorkspaceBackup" || method === "repairWorkspace") return sampleOutput(definition);
  return undefined;
}

async function runMutation(request: unknown, operationId: string, definition: OperationDefinition): Promise<unknown> {
  const execute = request && typeof request === "object" ? (request as { execute?: (operation: typeof operation) => Promise<unknown> }).execute : undefined;
  assert.equal(typeof execute, "function", `handler_matrix_mutation_callback_missing:${operationId}`);
  await execute!(operation);
  if (operationId === "collection.patch.apply") return { resource: collectionRecord, before: collectionRecord, operation, activity: [] };
  if (operationId === "collection.record.create" || operationId === "collection.record.delete") return { resource: collectionRecord, operation, activity: [] };
  if (operationId === "collection.reindex") return { resource: collectionIndex(), operation, activity: [] };
  if (operationId === "collection.schema.save") return { resource: collectionSchema, operation, activity: [] };
  return { resource: operationId === "graph.patch" ? graphArtifact : artifact, operation, activity: [] };
}

function proposedEffects(operationId: string): string[] {
  const definition = definitionById.get(operationId);
  assert.ok(definition, `handler_matrix_effect_definition_missing:${operationId}`);
  return [...definition.proposedEffects];
}

function workspacePath(relativePath: string) {
  return { absolutePath: `/tmp/handler-matrix/${relativePath}`, relativePath };
}

function rollbackPoint() {
  return { id: "rollback_fixture", operation_id: "operation_fixture", affected_resources: [artifactRef], before_snapshot: {}, after_snapshot: {}, reversible: true, irreversible_effects: [], created_at: now, expires_at: "2099-01-01T00:00:00.000Z" };
}

function collectionIndex() {
  const partition = { files: 0, indexed: 0, created: 0, updated: 0, removed: 0, skipped: 0, errors: [] };
  return { schemas: partition, records: partition };
}

function assertArgs(expected: AHandlerCallExpectation, actual: unknown[], parsedInput: Record<string, unknown>, context: TrustedDomainContext, label: string): void {
  assert.equal(actual.length, expected.args.length, `handler_matrix_port_arg_count_drift:${label}`);
  for (let index = 0; index < expected.args.length; index += 1) {
    assertMatcher(expected.args[index], actual[index], parsedInput, context, `${label}:arg${index}`);
  }
}

function assertMatcher(expected: unknown, actual: unknown, parsedInput: Record<string, unknown>, trustedContext: TrustedDomainContext, label: string): void {
  if (isArgExpectation(expected)) {
    if (expected.$handler_matrix === "function") return assert.equal(typeof actual, "function", `handler_matrix_expected_function:${label}`);
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `handler_matrix_expected_array:${label}`);
    assert.equal(actual.length, expected.length, `handler_matrix_array_length_drift:${label}`);
    expected.forEach((value, index) => assertMatcher(value, actual[index], parsedInput, trustedContext, `${label}[${index}]`));
    return;
  }
  if (isObject(expected)) {
    assert.ok(isObject(actual), `handler_matrix_expected_object:${label}`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `handler_matrix_object_keys_drift:${label}`);
    for (const [key, value] of Object.entries(expected)) assertMatcher(value, actual[key], parsedInput, trustedContext, `${label}.${key}`);
    return;
  }
  assert.deepEqual(actual, expected, `handler_matrix_port_arg_drift:${label}`);
}

function isArgExpectation(value: unknown): value is HandlerArgExpectation {
  return isObject(value) && typeof value.$handler_matrix === "string";
}

/**
 * Generated timestamps are intentionally represented by one static token.
 * Every other fixture value remains a complete literal object, so a new,
 * missing, or misspelled Port field still fails deep equality.
 */
function createDynamicValueTracker() {
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") return value !== now && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) ? "$generated:time" : value;
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalize(item)]));
  };
  return { normalize };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getAt(value: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const part of path) current = isObject(current) ? current[part] : undefined;
  return current;
}

function emptyCoverage(): InputCoverage {
  return { fields: new Set(), required: new Set(), enums: new Map(), unions: new Map() };
}

function expectedInputCoverage(schema: JsonSchema): InputCoverage {
  const root = resolveStaticSchema(schema, schema);
  const properties = isObject(root.properties) ? root.properties : {};
  const expected = emptyCoverage();
  for (const [field, property] of Object.entries(properties)) {
    expected.fields.add(field);
    const resolved = resolveStaticSchema(property as JsonSchema, schema);
    const enumValues = directEnum(resolved);
    if (enumValues.length) expected.enums.set(field, new Set(enumValues.map(stableKey)));
    const branches = directUnion(resolved);
    if (branches.length) expected.unions.set(field, new Set(branches.map((_branch, index) => index)));
  }
  for (const field of Array.isArray(root.required) ? root.required : []) if (typeof field === "string") expected.required.add(field);
  return expected;
}

function coverInput(parsedInput: Record<string, unknown>, expected: InputCoverage, actual: InputCoverage, schema: JsonSchema): void {
  const root = resolveStaticSchema(schema, schema);
  const properties = isObject(root.properties) ? root.properties : {};
  for (const field of expected.fields) {
    if (!(field in parsedInput)) continue;
    actual.fields.add(field);
    if (expected.required.has(field)) actual.required.add(field);
    const property = resolveStaticSchema(properties[field] as JsonSchema, schema);
    const enumValues = directEnum(property);
    if (enumValues.length) {
      const seen = actual.enums.get(field) ?? new Set<string>();
      seen.add(stableKey(parsedInput[field]));
      actual.enums.set(field, seen);
    }
    const branches = directUnion(property);
    if (branches.length) {
      const seen = actual.unions.get(field) ?? new Set<number>();
      branches.forEach((branch, index) => {
        if (validateStatic(branch, parsedInput[field], schema)) seen.add(index);
      });
      actual.unions.set(field, seen);
    }
  }
}

function assertInputCoverage(operationId: string, expected: InputCoverage, actual: InputCoverage): number {
  const missing: string[] = [];
  for (const field of expected.fields) if (!actual.fields.has(field)) missing.push(`field:${field}`);
  for (const field of expected.required) if (!actual.required.has(field)) missing.push(`required:${field}`);
  for (const [field, values] of expected.enums) for (const value of values) if (!actual.enums.get(field)?.has(value)) missing.push(`enum:${field}:${value}`);
  for (const [field, values] of expected.unions) for (const value of values) if (!actual.unions.get(field)?.has(value)) missing.push(`union:${field}:${value}`);
  assert.equal(missing.length, 0, `handler_matrix_static_input_coverage_missing:${operationId}:${missing.join(",")}`);
  return missing.length;
}

function assertNestedBranchMetadata(operationId: string, testCase: AHandlerCaseExpectation, parsedInput: Record<string, unknown>, schema: JsonSchema): void {
  for (const metadata of testCase.nestedBranches ?? []) {
    const value = getAt(parsedInput, metadata.path);
    const property = resolvePath(schema, metadata.path);
    const branches = directUnion(property);
    assert.ok(branches.length > metadata.branch, `handler_matrix_nested_union_catalog_missing:${operationId}:${testCase.id}:${metadata.path.join(".")}`);
    assert.ok(validateStatic(branches[metadata.branch]!, value, schema), `handler_matrix_nested_union_dto_disagrees:${operationId}:${testCase.id}:${metadata.label}`);
    if (metadata.label === "direct") assert.ok(isObject(value) && !("custom_view" in value), `handler_matrix_nested_union_label_drift:${operationId}:${testCase.id}:direct`);
    if (metadata.label === "custom_view") assert.ok(isObject(value) && "custom_view" in value, `handler_matrix_nested_union_label_drift:${operationId}:${testCase.id}:custom_view`);
  }
}

function directEnum(schema: JsonSchema): unknown[] {
  return Array.isArray(schema.enum) ? schema.enum : [];
}

function directUnion(schema: JsonSchema): JsonSchema[] {
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : [];
  return branches.filter(isObject);
}

function stableKey(value: unknown): string {
  return JSON.stringify(value);
}

function hydrateStaticRoot(rootId: string): JsonSchema {
  assert.ok(manifest.schema_catalog[rootId], `handler_matrix_static_root_missing:${rootId}`);
  return { $defs: Object.fromEntries(Object.entries(manifest.schema_catalog).map(([id, node]) => [id, hydrateStaticNode(node.schema)])), $ref: `#/$defs/${escapePointer(rootId)}` };
}

function hydrateStaticNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrateStaticNode);
  if (!isObject(value)) return value;
  if (typeof value.$schema_ref === "string") return { $ref: `#/$defs/${escapePointer(value.$schema_ref)}` };
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, hydrateStaticNode(child)]));
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function resolveStaticSchema(schema: JsonSchema, root: JsonSchema = schema): JsonSchema {
  let current = schema;
  const seen = new Set<JsonSchema>();
  while (typeof current.$ref === "string" && current.$ref.startsWith("#/$defs/") && !seen.has(current)) {
    seen.add(current);
    const id = current.$ref.slice("#/$defs/".length).replaceAll("~1", "/").replaceAll("~0", "~");
    const definitions = isObject(root.$defs) ? root.$defs : undefined;
    const next = definitions?.[id];
    if (!isObject(next)) break;
    current = next;
  }
  return current;
}

function resolvePath(schema: JsonSchema, path: readonly string[]): JsonSchema {
  let current = resolveStaticSchema(schema, schema);
  for (const part of path) {
    const properties = isObject(current.properties) ? current.properties : {};
    const child = properties[part];
    assert.ok(isObject(child), `handler_matrix_static_property_missing:${path.join(".")}`);
    current = resolveStaticSchema(child, schema);
  }
  return current;
}

function validateStatic(schema: JsonSchema, value: unknown, root: JsonSchema): boolean {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile({ $defs: root.$defs, ...schema })(value) as boolean;
}

async function assertInvalidInputZeroCalls(definition: OperationDefinition, testCase: AHandlerCaseExpectation): Promise<void> {
  let calls = 0;
  const ports = new Proxy({}, { get() { return () => { calls += 1; throw new Error("handler_matrix_invalid_input_port_call"); }; } });
  const handler = definition.createHandler(ports as never);
  const bound = bindOperationDefinition(definition as never, handler as never);
  const invalid = { ...testCase.input, __handler_matrix_unknown_key: true };
  await assert.rejects(() => bound.execute(caseContext(testCase), invalid), (error: unknown) => error instanceof DomainContractError && error.stage === "input", `handler_matrix_invalid_input_not_rejected:${definition.id}`);
  assert.equal(calls, 0, `handler_matrix_invalid_input_called_port:${definition.id}`);
}

async function assertInvalidOutputRejected(definition: OperationDefinition, testCase: AHandlerCaseExpectation): Promise<void> {
  const invalidOutput = {
    async execute() { return { ok: true as const, value: { __handler_matrix_invalid_output: true } }; }
  };
  const bound = bindOperationDefinition(definition as never, invalidOutput as never);
  await assert.rejects(() => bound.execute(caseContext(testCase), testCase.input), (error: unknown) => error instanceof DomainContractError && error.stage === "output", `handler_matrix_invalid_output_not_rejected:${definition.id}`);
}

function sampleOutput(definition: OperationDefinition): unknown {
  const schema = jsonSchemaFor(definition.output, `${definition.id}.output`) as JsonSchema;
  return sampleSchema(schema, schema);
}

function sampleSchema(raw: JsonSchema, root: JsonSchema, depth = 0): unknown {
  if (depth > 24) return null;
  const schema = resolveJsonSchema(raw, root);
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const unions = directUnion(schema);
  if (unions.length) return sampleSchema(unions[0]!, root, depth + 1);
  const allOf = Array.isArray(schema.allOf) ? schema.allOf.filter(isObject) : [];
  if (allOf.length) return Object.assign({}, ...allOf.map((item) => sampleSchema(item, root, depth + 1) as Record<string, unknown>));
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object" || isObject(schema.properties)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
    const value: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(properties)) if (required.has(key) || key in properties) value[key] = sampleSchema(child as JsonSchema, root, depth + 1);
    return value;
  }
  if (type === "array") return [];
  if (type === "boolean") return true;
  if (type === "integer" || type === "number") return Math.max(Number(schema.minimum ?? 0), 1);
  if (type === "null") return null;
  if (schema.format === "date-time") return now;
  if (schema.format === "uri") return "https://example.com/fixture";
  if (typeof schema.pattern === "string" && schema.pattern.includes("/")) return "text/plain";
  return "fixture";
}

function resolveJsonSchema(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema;
  const value = schema.$ref.slice(2).split("/").reduce<unknown>((current, part) => isObject(current) ? current[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined, root);
  return isObject(value) ? value : schema;
}
