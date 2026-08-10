import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import fc from "fast-check";
import Ajv from "ajv";
import {
  actionCatalogEntries,
  domainCommandEntries,
  domainLegacyCommandEntries,
  domainQueryEntries,
  getDomainCommandCatalogDiagnostics
} from "../../packages/action-catalog/src/index";
import {
  DomainContractError,
  DomainOperationError,
  DomainOperationRegistry,
  bindOperationDefinition,
  bindOperationDefinitions,
  domainInputSources,
  fingerprintDefinition,
  jsonSchemaFor,
  operationDefinitions,
  type BoundOperationDefinition,
  type DomainOperationPorts
} from "../../packages/domain-operations/src/index";
import { assertContractVersionDiscipline } from "../lib/domain-contract-version.mjs";

const root = process.cwd();
const expectedCommandCount = Number(process.env.SAMURAI_EXPECT_COMMAND_COUNT ?? "132");
const expectedQueries = ["activity.history.list", "agent.list", "agent.view", "browser.extract", "collection.records.list", "collection.schema.docs", "collection.schema.get", "collection.search", "collection.view.present", "curator.snapshot.list", "file.inspect", "file.list", "file.read", "generated_surface.export", "memory.search", "presentation.plan", "room.list", "room.member.list", "room.ownerless.list", "room.resource.share.list", "room.view", "session.search", "skill.search", "skill.view", "wiki.search", "workspace.member.list"];
const expectedLegacy = ["approval.approve", "approval.deny", "grant.create", "grant.revoke", "workspace.delete"];

assert.equal(domainCommandEntries.length, expectedCommandCount);
assert.equal(domainQueryEntries.length, 26);
assert.equal(domainLegacyCommandEntries.length, 5);
assert.equal(operationDefinitions.length, 158);
assert.deepEqual(domainQueryEntries.map((entry) => entry.id).sort(), expectedQueries);
assert.deepEqual(domainLegacyCommandEntries.map((entry) => entry.id).sort(), expectedLegacy);
assert.equal(actionCatalogEntries.length, 132);
assert.equal(getDomainCommandCatalogDiagnostics().ok, true);
assert.equal(new Set(operationDefinitions.map((definition) => definition.id)).size, 158);

for (const action of actionCatalogEntries) {
  assert.equal("handler_id" in action, false, `${action.id} leaked handler_id into Action Catalog`);
  assert.equal("runtime_method" in action, false, `${action.id} leaked runtime method into Action Catalog`);
}

const calls: string[] = [];
const validOutputById = new Map(operationDefinitions.map((definition) => [
  definition.id,
  sample(jsonSchemaFor(definition.output, `${definition.id}.output`))
]));
const ports = new Proxy({}, {
  get: (_target, id) => new Proxy({}, {
    get: (_port, method) => async () => {
      return { ok: true as const, value: validOutputById.get(String(id)) };
    }
  })
}) as DomainOperationPorts;
const bindings = bindOperationDefinitions(ports);
// Registry contract checks use a narrow synthetic Handler so every operation
// can be exercised without pretending one generic Port return value satisfies
// every concrete Handler's domain-specific Port shape. Concrete Handler/Port
// behavior is covered by the three static handler matrices below.
const contractBindings: readonly BoundOperationDefinition[] = operationDefinitions.map((definition) => Object.freeze({
  definition,
  handlerName: `contract_${definition.id}`,
  execute: async (_context: Parameters<BoundOperationDefinition["execute"]>[0], rawInput: unknown) => {
    const input = definition.input.safeParse(rawInput);
    if (!input.success) throw new DomainContractError("input", definition.id, input.error.issues[0]);
    const output = definition.output.safeParse(validOutputById.get(definition.id));
    if (!output.success) throw new DomainContractError("output", definition.id, output.error.issues[0]);
    return { ok: true as const, value: output.data };
  }
}));
const instrumentedBindings = contractBindings.map((binding) => ({
  ...binding,
  execute: async (context: Parameters<typeof binding.execute>[0], input: Parameters<typeof binding.execute>[1]) => {
    // Count only inputs that pass the operation contract. Invalid DTOs must be
    // rejected before the Handler/Port boundary, so they are not invocations.
    if (binding.definition.input.safeParse(input).success) calls.push(binding.definition.id);
    return binding.execute(context, input);
  }
}));
const registry = new DomainOperationRegistry(ports, instrumentedBindings);
assert.throws(() => new DomainOperationRegistry(ports, [...bindings.slice(0, -1), { ...bindings.at(-1)!, definition: undefined }] as never), /domain_operation_definition_missing/);
assert.throws(() => new DomainOperationRegistry(ports, [...bindings.slice(0, -1), bindings[0]!]), /duplicate_domain_operation_id/);
assert.throws(() => new DomainOperationRegistry(ports, [...bindings.slice(0, -1), { ...bindings.at(-1)!, handlerName: bindings[0]!.handlerName }] as never), /domain_operation_handler_reused/);
assert.throws(() => new DomainOperationRegistry(ports, [...bindings.slice(0, -1), { ...bindings.at(-1)!, definition: { ...bindings.at(-1)!.definition, input: undefined } }] as never), /domain_operation_input_schema_missing/);
assert.throws(() => new DomainOperationRegistry(ports, [...bindings.slice(0, -1), { ...bindings.at(-1)!, definition: { ...bindings.at(-1)!.definition, output: undefined } }] as never), /domain_operation_output_schema_missing/);
assert.throws(() => new DomainOperationRegistry(ports, [...bindings.slice(0, -1), { ...bindings.at(-1)!, execute: undefined }] as never), /domain_operation_handler_missing/);
assert.throws(() => new DomainOperationRegistry(ports, bindings.slice(0, -1)), /domain_operation_registry_incomplete/);
assert.equal(Object.isFrozen(registry), true);
assert.deepEqual(registry.list().map(({ id }) => id), registry.list().map(({ id }) => id));
assert.equal(registry.list(operationDefinitions[0]!.sources[0]!).every((definition) => definition.sources.includes(operationDefinitions[0]!.sources[0]!)), true);
assert.equal(registry.get(operationDefinitions[0]!.id)?.id, operationDefinitions[0]!.id);
assert.equal(registry.get("unknown.operation"), undefined);
assert.equal(registry.bindingIdentity(operationDefinitions[0]!.id)?.operationId, operationDefinitions[0]!.id);
assert.equal(registry.bindingIdentity("unknown.operation"), undefined);
const unavailableBinding = { ...bindings[0]!, definition: { ...bindings[0]!.definition, availability: "deprecated_command" as const } };
const unavailableRegistry = new DomainOperationRegistry(ports, [unavailableBinding, ...bindings.slice(1)]);
assert.equal(unavailableRegistry.list().some(({ id }) => id === unavailableBinding.definition.id), false);
const unavailableEntry = [...domainCommandEntries, ...domainQueryEntries].find(({ id }) => id === unavailableBinding.definition.id)!;
await assert.rejects(
  unavailableRegistry.execute({ inputSource: unavailableBinding.definition.sources[0]!, workspaceId: "workspace", actorId: "actor", correlationId: "unavailable" }, unavailableBinding.definition.id, sample(unavailableEntry.input_schema)),
  (error: unknown) => error instanceof Error && "code" in error && error.code === "unavailable"
);
let strictInputs = 0;
let missingInputChecks = 0;
let strictOutputs = 0;
let missingOutputChecks = 0;
let propertyInvalidInputs = 0;
let payloadLimitChecks = 0;
let schemaCaseChecks = 0;
let publicSchemaParityChecks = 0;
const ajv = new Ajv({ strict: false, allErrors: true, formats: {
  "date-time": true, date: true, time: true, uri: true, url: true, uuid: true
} });

const payloadLimitDefinition = operationDefinitions.find((definition) => {
  const schema = jsonSchemaFor(definition.input, `${definition.id}.input`);
  return schema.properties && typeof schema.properties === "object" && "metadata" in schema.properties;
});
assert.ok(payloadLimitDefinition, "payload limit fixture requires an operation with metadata");
const payloadLimitCatalog = [...domainCommandEntries, ...domainQueryEntries].find((entry) => entry.id === payloadLimitDefinition.id)!;
const payloadLimitInput = sample(payloadLimitCatalog.input_schema as Record<string, unknown>) as Record<string, unknown>;
const payloadLimitContext = { inputSource: payloadLimitDefinition.sources[0]!, workspaceId: "workspace", actorId: "actor", correlationId: "payload-limits" };
const nested: Record<string, unknown> = {};
let cursor = nested;
for (let depth = 0; depth < 34; depth += 1) {
  const child: Record<string, unknown> = {};
  cursor.child = child;
  cursor = child;
}
for (const [reason, metadata] of [
  ["depth", nested],
  ["array_items", { items: Array.from({ length: 1_001 }, () => null) }],
  ["string_length", { text: "x".repeat(1_000_001) }],
  ["forbidden_key", JSON.parse('{"__proto__":{"polluted":true}}')]
] as const) {
  const before = calls.length;
  await assert.rejects(
    registry.execute(payloadLimitContext, payloadLimitDefinition.id, { ...payloadLimitInput, metadata }),
    (error: unknown) => error instanceof Error && error.message.endsWith(`:${reason}`)
  );
  assert.equal(calls.length, before);
  payloadLimitChecks += 1;
}
for (const [reason, metadata] of [
  ["object_keys", Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`key_${index}`, null]))],
  ["total_characters", { one: "x".repeat(700_000), two: "x".repeat(700_000), three: "x".repeat(700_000) }]
] as const) {
  const before = calls.length;
  await assert.rejects(registry.execute(payloadLimitContext, payloadLimitDefinition.id, { ...payloadLimitInput, metadata }), (error: unknown) => error instanceof Error && error.message.endsWith(`:${reason}`));
  assert.equal(calls.length, before);
  payloadLimitChecks += 1;
}
for (const context of [
  { ...payloadLimitContext, signal: AbortSignal.abort() },
  { ...payloadLimitContext, deadlineAt: Date.now() - 1 }
]) {
  const before = calls.length;
  await assert.rejects(registry.execute(context, payloadLimitDefinition.id, payloadLimitInput), (error: unknown) => error instanceof Error && "code" in error && error.code === "unavailable");
  assert.equal(calls.length, before);
}

for (const definition of operationDefinitions) {
  const catalog = [...domainCommandEntries, ...domainQueryEntries].find((entry) => entry.id === definition.id);
  assert.ok(catalog, `missing catalog projection: ${definition.id}`);
  const sampledInput = sample(catalog.input_schema as Record<string, unknown>) as Record<string, unknown>;
  // Static JSON Schema cannot express these cross-field refinements, so add
  // one representative valid value for the contract fixture.
  const input = definition.id === "skill.optimization.rollback"
    ? { ...sampledInput, promotion_id: "promotion_fixture" }
    : definition.id === "agent.patch"
      ? { ...sampledInput, role: "Fixture role" }
      : definition.id === "learning.resource.version.update"
        ? { ...sampledInput, content: "Fixture Resource content." }
      : sampledInput;
  assert.equal(definition.input.safeParse(input).success, true, `${definition.id} contract fixture sample is rejected by Zod`);
  const validatePublicInput = ajv.compile(catalog.input_schema);
  assert.equal(validatePublicInput(input), true, `${definition.id} public input schema rejects its sample`);
  assert.equal(validatePublicInput(null), definition.input.safeParse(null).success, `${definition.id} input parity differs for root type`);
  publicSchemaParityChecks += 2;
  schemaCaseChecks += 2;
  const context = { inputSource: definition.sources[0]!, workspaceId: "workspace", actorId: "actor", correlationId: definition.id };
  const callsBeforeInvalidInput = calls.length;
  await assert.rejects(
    registry.execute(context, definition.id, { ...input, __unexpected_contract_field: true }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_input"
  );
  assert.equal(calls.length, callsBeforeInvalidInput, `${definition.id} invoked its Port for an invalid input`);
  strictInputs += 1;
  assert.equal(definition.input.safeParse(null).success, false, `${definition.id} accepts a non-object input`);
  const inputRequired = Array.isArray(catalog.input_schema.required)
    ? catalog.input_schema.required.filter((value): value is string => typeof value === "string")
    : [];
  if (inputRequired.length > 0) {
    const missing = { ...input };
    delete missing[inputRequired[0]!];
    assert.equal(definition.input.safeParse(missing).success, false, `${definition.id} accepts missing ${inputRequired[0]}`);
    missingInputChecks += 1;
    assert.equal(validatePublicInput(missing), false, `${definition.id} public input schema accepts missing ${inputRequired[0]}`);
    publicSchemaParityChecks += 1;
  }
  await fc.assert(fc.asyncProperty(
    fc.jsonValue().filter((value) => !definition.input.safeParse(value).success),
    async (invalid) => {
      const before = calls.length;
      await assert.rejects(registry.execute(context, definition.id, invalid));
      assert.equal(calls.length, before);
      propertyInvalidInputs += 1;
    }
  ), { numRuns: 10 });
  const generatedOutput = validOutputById.get(definition.id);
  const outputSchema = jsonSchemaFor(definition.output, `${definition.id}.output`);
  const validatePublicOutput = ajv.compile(outputSchema);
  assert.equal(
    definition.output.safeParse(generatedOutput).success,
    true,
    `${definition.id} generated public-schema sample is rejected by Zod: ${JSON.stringify(generatedOutput)}`
  );
  assert.equal(validatePublicOutput(generatedOutput), true, `${definition.id} public output schema rejects its sample`);
  assert.equal(validatePublicOutput(null), definition.output.safeParse(null).success, `${definition.id} output parity differs for root type`);
  publicSchemaParityChecks += 2;
  schemaCaseChecks += 2;
  const invalidOutputBinding = bindOperationDefinition(definition as never, {
    execute: async function invalidOutputHandler() {
      return { ok: true as const, value: undefined };
    }
  } as never);
  const invalidOutputRegistry = new DomainOperationRegistry(ports, contractBindings.map((binding) =>
    binding.definition.id === definition.id ? invalidOutputBinding : binding
  ));
  await assert.rejects(
    invalidOutputRegistry.execute(context, definition.id, input),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_output"
  );
  const result = await registry.execute(context, definition.id, input);
  assert.equal(result.ok, true);
  assert.equal(calls.at(-1), definition.id);
  const validOutput = validOutputById.get(definition.id);
  assert.equal(definition.output.safeParse(validOutput).success, true);
  if (validOutput && typeof validOutput === "object" && !Array.isArray(validOutput)) {
    assert.equal(
      definition.output.safeParse({ ...(validOutput as Record<string, unknown>), extra: true }).success,
      false,
      `${definition.id} output accepts undeclared top-level fields`
    );
    strictOutputs += 1;
    const outputRequired = Array.isArray(outputSchema.required)
      ? outputSchema.required.filter((value): value is string => typeof value === "string")
      : [];
    if (outputRequired.length > 0) {
      const missing = { ...(validOutput as Record<string, unknown>) };
      delete missing[outputRequired[0]!];
      assert.equal(definition.output.safeParse(missing).success, false, `${definition.id} accepts missing output ${outputRequired[0]}`);
      missingOutputChecks += 1;
      assert.equal(validatePublicOutput(missing), false, `${definition.id} public output schema accepts missing ${outputRequired[0]}`);
      publicSchemaParityChecks += 1;
    }
  } else {
    assert.equal(definition.output.safeParse({ __wrong_output_type: true }).success, false);
    strictOutputs += 1;
  }
}
assert.equal(calls.length, operationDefinitions.length);
for (const definition of operationDefinitions) {
  assert.equal(calls.filter((operationId) => operationId === definition.id).length, 1, `${definition.id} contract handler was not executed exactly once`);
}

const errorDefinition = bindings[0]!.definition;
const errorEntry = [...domainCommandEntries, ...domainQueryEntries].find(({ id }) => id === errorDefinition.id)!;
const errorInput = sample(errorEntry.input_schema);
const errorContext = { inputSource: errorDefinition.sources[0]!, workspaceId: "workspace", actorId: "actor", correlationId: "error-correlation" };
const registryWithHandler = (execute: () => Promise<never>) => new DomainOperationRegistry(ports, [
  bindOperationDefinition(errorDefinition, {
    execute: async function registryErrorHandler() {
      return execute();
    }
  } as never),
  ...bindings.slice(1)
]);
const secretError = "token=raw-secret /Users/private/workspace/file.txt";
const unknownRegistry = registryWithHandler(async () => { throw new Error(secretError); });
await assert.rejects(unknownRegistry.execute(errorContext, errorDefinition.id, errorInput), (error: unknown) => error instanceof Error && "code" in error && error.code === "internal" && !error.message.includes(secretError));
const unknownLog = unknownRegistry.listLogEntries().at(-1)!;
assert.deepEqual(Object.keys(unknownLog).sort(), ["correlationId", "durationMs", "errorCode", "operationId", "outcome", "source", "version"]);
assert.equal(JSON.stringify(unknownLog).includes("raw-secret"), false);
assert.equal(JSON.stringify(unknownLog).includes("/Users/"), false);
const domainErrorRegistry = registryWithHandler(async () => { throw new DomainOperationError("conflict", "domain_conflict"); });
await assert.rejects(domainErrorRegistry.execute(errorContext, errorDefinition.id, errorInput), (error: unknown) => error instanceof DomainOperationError && error.message === "domain_conflict");
const invalidEnvelopeRegistry = new DomainOperationRegistry(ports, [
  bindOperationDefinition(errorDefinition, {
    execute: async function invalidEnvelopeHandler() {
      return undefined;
    }
  } as never),
  ...bindings.slice(1)
] as never);
await assert.rejects(invalidEnvelopeRegistry.execute(errorContext, errorDefinition.id, errorInput), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_output");
const throwingSchemaRegistry = new DomainOperationRegistry(ports, [
  { ...bindings[0]!, execute: async () => { throw new Error(secretError); } },
  ...bindings.slice(1)
] as never);
await assert.rejects(throwingSchemaRegistry.execute(errorContext, errorDefinition.id, errorInput), (error: unknown) => error instanceof Error && "code" in error && error.code === "internal");
const issueLessSchemaRegistry = new DomainOperationRegistry(ports, [
  { ...bindings[0]!, execute: async () => { throw new DomainContractError("input", errorDefinition.id, undefined); } },
  ...bindings.slice(1)
] as never);
await assert.rejects(issueLessSchemaRegistry.execute(errorContext, errorDefinition.id, errorInput), (error: unknown) => error instanceof Error && error.message.endsWith("$:invalid_value"));
for (const code of ["conflict", "not_found", "unavailable", "outcome_unknown"] as const) {
  const typedRegistry = registryWithHandler(async () => { throw Object.assign(new Error(secretError), { code }); });
  await assert.rejects(typedRegistry.execute(errorContext, errorDefinition.id, errorInput), (error: unknown) => error instanceof Error && "code" in error && error.code === code && !error.message.includes("raw-secret"));
}
const forbiddenSource = domainInputSources.find((source) => !errorDefinition.sources.includes(source))!;
const callsBeforeForbiddenSource = calls.length;
await assert.rejects(registry.execute({ ...errorContext, inputSource: forbiddenSource }, errorDefinition.id, errorInput), (error: unknown) => error instanceof Error && "code" in error && error.code === "source_not_allowed");
assert.equal(calls.length, callsBeforeForbiddenSource);
await assert.rejects(registry.execute(errorContext, "unknown.operation", {}), (error: unknown) => error instanceof Error && "code" in error && error.code === "not_found");
for (let index = 0; index < 1_001; index += 1) {
  await registry.execute({ ...errorContext, correlationId: `log-${index}` }, errorDefinition.id, errorInput);
}
assert.equal(registry.listLogEntries().length, 1_000);

for (const [definition, entry] of operationDefinitions.map((definition) => [
  definition,
  [...domainCommandEntries, ...domainQueryEntries].find((candidate) => candidate.id === definition.id)!
] as const)) {
  assert.equal(entry.contract_fingerprint, fingerprintDefinition(definition));
  assert.notEqual(entry.contract_fingerprint, fingerprintDefinition({ ...definition, description: `${definition.description} changed` }));
  assert.notEqual(entry.contract_fingerprint, fingerprintDefinition(definition, { ...entry.input_schema, title: "changed" }, entry.output_schema));
}
const versionFixture = domainCommandEntries[0]!;
assert.throws(() => assertContractVersionDiscipline([versionFixture], [{ ...versionFixture, contract_fingerprint: "0".repeat(64) }]), /domain_contract_version_not_bumped/);
const nextContractVersion = `${Number(versionFixture.contract_version.split(".")[0]) + 1}.0`;
assert.doesNotThrow(() => assertContractVersionDiscipline([versionFixture], [{ ...versionFixture, contract_version: nextContractVersion, contract_fingerprint: "0".repeat(64) }]));

const operationsRoot = path.join(root, "packages/domain-operations/src/operations");
const operationFiles = filesUnder(operationsRoot).filter((file) => file.endsWith(".operation.ts"));
assert.equal(operationFiles.length, 158);
for (const file of operationFiles) {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const declaredContracts = new Set<string>();
  let hasCreateHandler = false;
  let privateZodAccess = false;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declaredContracts.add(node.name.text);
    if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === "createHandler") {
      hasCreateHandler = true;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "_def") privateZodAccess = true;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(declaredContracts.has("Input"), true, `${file} is missing its Input contract`);
  assert.equal(declaredContracts.has("Output"), true, `${file} is missing its Output contract`);
  assert.equal(hasCreateHandler, true, `${file} is missing createHandler`);
  assert.equal(privateZodAccess, false, `${file} reads Zod internals`);
}

for (const removed of [
  "packages/runtime/src/commands/domain-command-registry.ts",
  "packages/runtime/src/commands/domain-query-registry.ts",
  "packages/runtime/src/commands/domain-operation-handlers.ts",
  "packages/runtime/src/commands/domain-operation-definitions.ts",
  "packages/action-catalog/src/domain-operation-input-schemas.ts"
]) assert.equal(existsSync(path.join(root, removed)), false, `legacy source remains: ${removed}`);

const indexSource = readFileSync(path.join(root, "packages/domain-operations/src/generated/operation-index.generated.ts"), "utf8");
assert.equal((indexSource.match(/import operation\d+/g) ?? []).length, 158);
assert.equal(indexSource.includes("handler_id"), false);
assert.equal(indexSource.includes("runtime_method"), false);
const binderSource = readFileSync(path.join(root, "packages/domain-operations/src/generated/operation-binder.generated.ts"), "utf8");
assert.equal((binderSource.match(/import operation\d+/g) ?? []).length, 158);

const checkedSources = [
  "packages/action-catalog/src/index.ts",
  "packages/action-catalog/src/domain-catalog-projection.ts",
  "packages/runtime/src/agent-runtime.ts",
  "packages/runtime/src/domain-operation-composition.ts",
  "packages/domain-operations/src/registry/operation-registry.ts",
  "packages/domain-operations/src/definition/index.ts"
];
for (const relative of checkedSources) {
  const source = readFileSync(path.join(root, relative), "utf8");
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.ES2022, true);
  let privateZodAccess = false;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "_def") privateZodAccess = true;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(privateZodAccess, false, `${relative} reads Zod private internals`);
}
const runtimeSource = readFileSync(path.join(root, "packages/runtime/src/agent-runtime.ts"), "utf8");
assert.equal(runtimeSource.includes("domainCommandWritePorts"), false);
assert.equal(runtimeSource.includes("domainQueryReadPorts"), false);
assert.equal(runtimeSource.includes("DomainCommandRegistry"), false);
assert.equal(runtimeSource.includes("DomainQueryRegistry"), false);
assert.equal(runtimeSource.includes("typedPortHandler"), false);

  process.stdout.write(`${JSON.stringify({ status: "passed", gates: ["CT01", "CT02", "CT03", "CT04", "CT05", "CT06", "CT08", "CT09", "CT10", "CT11", "CT12", "RH01", "RH02", "RH03", "RH04", "RH05", "RH06", "RH07", "RH08", "RH09", "RH10", "RH11", "QP03", "IN11", "ES01", "ES02", "ES03", "ES04", "ES05", "ES07", "ES08"], commands: domainCommandEntries.length, queries: domainQueryEntries.length, deprecated_commands: domainLegacyCommandEntries.length, registry_handlers: operationDefinitions.length, handler_executions: operationDefinitions.length, handler_invocations: calls.length, strict_input_checks: strictInputs, missing_input_checks: missingInputChecks, strict_output_checks: strictOutputs, missing_output_checks: missingOutputChecks, schema_case_checks: schemaCaseChecks, public_schema_parity_checks: publicSchemaParityChecks, property_invalid_inputs: propertyInvalidInputs, payload_limit_checks: payloadLimitChecks, cancellation_checks: 2, registry_initialization_rejections: 7, contract_handler_calls: calls.length, read_only_adapter_queries: domainQueryEntries.length, typed_error_codes: 8, metadata_only_logs: true, retained_log_entries: registry.listLogEntries().length, fingerprint_checks: operationDefinitions.length * 3, version_discipline_checks: 2 })}\n`);

export function sample(schema: Record<string, unknown>, root: Record<string, unknown> = schema, includeOptional = false): unknown {
  if ("const" in schema) return schema.const;
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union?.length) {
    const branch = union[0];
    if (branch && typeof branch === "object" && !Array.isArray(branch)) return sample(branch as Record<string, unknown>, root, includeOptional);
  }
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    const referenced = resolveJsonPointer(root, schema.$ref);
    if (referenced && typeof referenced === "object" && !Array.isArray(referenced)) return sample(referenced as Record<string, unknown>, root, includeOptional);
  }
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object") {
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties as Record<string, Record<string, unknown>> : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
    const keys = includeOptional ? Object.keys(properties) : required;
    return Object.fromEntries(keys.map((key) => [key, sample(properties[key] ?? { type: "string" }, root, includeOptional)]));
  }
  if (type === "array") {
    if (Array.isArray(schema.prefixItems)) {
      return schema.prefixItems.map((item) => item && typeof item === "object" && !Array.isArray(item)
        ? sample(item as Record<string, unknown>, root, includeOptional)
        : null);
    }
    if (Array.isArray(schema.items)) {
      return schema.items.map((item) => item && typeof item === "object" && !Array.isArray(item)
        ? sample(item as Record<string, unknown>, root, includeOptional)
        : null);
    }
    const minimum = typeof schema.minItems === "number" ? schema.minItems : 0;
    const itemSchema = schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
      ? schema.items as Record<string, unknown>
      : { type: "string" };
    return Array.from({ length: minimum }, () => sample(itemSchema, root, includeOptional));
  }
  if (type === "number" || type === "integer") {
    if (typeof schema.minimum === "number") return schema.minimum;
    if (typeof schema.exclusiveMinimum === "number") return schema.exclusiveMinimum + 1;
    return 1;
  }
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (schema.format === "date") return "2026-01-01";
  if (schema.format === "time") return "00:00:00Z";
  if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000000";
  if (schema.format === "uri" || schema.format === "url") return "https://example.com/";
  if (schema.pattern === "^[A-Za-z0-9+/]+={0,2}$") {
    const minimumLength = Math.max(typeof schema.minLength === "number" ? schema.minLength : 0, 4);
    return "A".repeat(Math.ceil(minimumLength / 4) * 4);
  }
  if (schema.pattern === "^human:[^\\s:][^\\s]*$") return "human:sample";
  const minimumLength = typeof schema.minLength === "number" ? schema.minLength : 0;
  return "sample".padEnd(minimumLength, "x");
}

export function completeSample(schema: Record<string, unknown>): unknown {
  return sample(schema, schema, true);
}

function resolveJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  return pointer.slice(2).split("/").reduce<unknown>((value, token) => {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) return /^\d+$/.test(key) ? value[Number(key)] : undefined;
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, root);
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}
