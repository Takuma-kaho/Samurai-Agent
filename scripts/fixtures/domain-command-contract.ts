import assert from "node:assert/strict";
import {
  actionCatalogEntries,
  getDomainCommandEntry,
  getDomainCommandForProviderToolName,
  getDomainCommandForSurfaceOperationKind,
  getDomainQueryForProviderToolName,
  getDomainQueryForSurfaceOperationKind,
  listDomainCommandEntries,
  listDomainQueryEntries
} from "../../packages/action-catalog/src/index";
import { samuraiToolBridgeDescriptors } from "../../packages/runtime/src/index";
import { providerTools } from "../../packages/runtime/src/provider-profiles";
import { stableHash } from "../../packages/core-schemas/src/index";

const catalogById = new Map(actionCatalogEntries.map((entry) => [entry.id, entry]));
const queryById = new Map(listDomainQueryEntries().map((entry) => [entry.id, entry]));
for (const command of listDomainCommandEntries()) {
  assert.deepEqual(catalogById.get(command.id)?.input_schema, command.input_schema);
}

let bridgeMappings = 0;
for (const tool of samuraiToolBridgeDescriptors) {
  const entry = getDomainCommandForProviderToolName(tool.provider_tool_name)
    ?? getDomainCommandForProviderToolName(tool.name)
    ?? getDomainQueryForProviderToolName(tool.provider_tool_name)
    ?? getDomainQueryForProviderToolName(tool.name);
  if (!entry) continue;
  bridgeMappings += 1;
  assert.deepEqual(tool.input_schema, entry.input_schema, `${tool.name} schema drifted from ${entry.id}`);
}
assert.ok(bridgeMappings >= 6);

const openAiTools = providerTools("openai") as Array<{ name: string; parameters: Record<string, unknown> }>;
let providerMappings = 0;
for (const tool of openAiTools) {
  const entry = getDomainCommandForProviderToolName(tool.name)
    ?? getDomainQueryForProviderToolName(tool.name);
  assert.ok(entry, `provider tool is not mapped: ${tool.name}`);
  providerMappings += 1;
  assert.deepEqual(tool.parameters, entry.input_schema, `${tool.name} provider schema drifted`);
}
assert.equal(providerMappings, 3);

const surfaceKinds = ["message.submit", "artifact.request", "collection.record.create", "collection.record.patch", "collection.view.present", "collection.action.run"];
for (const kind of surfaceKinds) {
  const entry = getDomainCommandForSurfaceOperationKind(kind)
    ?? getDomainQueryForSurfaceOperationKind(kind);
  assert.ok(entry, `surface operation is not mapped: ${kind}`);
  assert.deepEqual(catalogById.get(entry.id)?.input_schema ?? queryById.get(entry.id)?.input_schema, entry.input_schema);
}
assert.equal(surfaceKinds.length, 6);
const patchSchema = getDomainCommandEntry("collection.patch.apply")?.input_schema;
assert.ok(Array.isArray(patchSchema?.required) && patchSchema.required.includes("expected_version"));

process.stdout.write(`${JSON.stringify({
  status: "passed",
  commands: listDomainCommandEntries().length,
  action_catalog_matches: true,
  bridge_mappings: bridgeMappings,
  provider_mappings: providerMappings,
  surface_mappings: surfaceKinds.length,
  expected_version_in_patch_schema: true,
  schema_fingerprint: stableHash(actionCatalogEntries.map((entry) => ({ id: entry.id, input_schema: entry.input_schema })))
})}\n`);
