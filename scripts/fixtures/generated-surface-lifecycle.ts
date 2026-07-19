import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nowIso, stableHash, type CollectionSchema, type JsonValue } from "../../packages/core-schemas/src/index";
import { AgentRuntime, RuntimeRequestError } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const sourceRoot = await mkdtemp(path.join(tmpdir(), "samurai-generated-lifecycle-"));
const targetRoot = await mkdtemp(path.join(tmpdir(), "samurai-generated-lifecycle-import-"));
const exportRoot = await mkdtemp(path.join(tmpdir(), "samurai-generated-lifecycle-export-"));
let store = await WorkspaceStore.create({ rootDir: sourceRoot });
let runtime = new AgentRuntime(store);
const now = nowIso();

try {
  await store.createSession({ id: "surface-session", session_key: "web:surface:main", title: "Surface lifecycle", ui_locale: "en", output_locale: "en", created_at: now, updated_at: now });
  const schema: CollectionSchema = {
    id: "surface-items", version: "1", labels: { en: "Surface items" }, descriptions: { en: "Surface items" },
    fields: [{ id: "name", type: "string" }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: { update: true }
  };
  await store.saveCollectionSchema(schema);
  for (const id of ["generated", "human", "agent"]) {
    await store.saveCollectionRecord({ id, collection_id: schema.id, version: 1, data: { name: "before" }, resource_refs: [], created_at: now, updated_at: now });
  }
  const request = {
    id: "request-lifecycle", session_id: "surface-session", user_intent: "Update an item from a generated control",
    source_resource_refs: [], allowed_domain_commands: ["collection.patch.apply"], selected_knowledge_refs: [], selected_skill_refs: [],
    client_capabilities: { generated_surface: true }, expected_lifetime: "session", fallback_chain: ["artifact", "text"], created_at: now
  };
  const bundle = {
    title: "Item control",
    html: '<main><button type="button" data-action-id="complete">Complete</button></main>',
    css: "main { display: grid; }",
    script: "document.addEventListener('click', event => parent.postMessage({type:'surface.action', action_id:event.target.dataset.actionId}, '*'));",
    actions: [{
      id: "complete", label: "Complete", command_id: "collection.patch.apply", input_schema: { type: "object" },
      payload_template: { collection_id: schema.id, record_id: "generated", expected_version: 1, changes: { name: "done" } }, requires_confirmation: false
    }]
  };
  const created = await runtime.runDomainCommand({ command_id: "generated_surface.create", input_source: "runtime_api", idempotency_key: "surface-create", payload: { request, bundle } as unknown as Record<string, JsonValue> });
  const createdResource = created.result as { definition: { id: string; current_revision_id: string; content_hash: string }; revision: { id: string; bundle_hash: string } };
  assert.equal(created.render_spec?.kind, "custom_view");

  const generated = await runtime.runGeneratedSurfaceAction({
    surfaceId: createdResource.definition.id,
    revisionId: createdResource.definition.current_revision_id,
    actionId: "complete",
    interactionId: "surface-interaction-action",
    actionPayload: {}
  });
  const generatedWrite = generated.command as Record<string, any>;
  const human = await runtime.runDomainCommand({
    command_id: "collection.patch.apply", input_source: "runtime_api", idempotency_key: "human-patch",
    payload: { collection_id: schema.id, record_id: "human", expected_version: 1, changes: { name: "done" } }
  });
  const agent = await runtime.runDomainCommand({
    command_id: "collection.patch.apply", input_source: "provider_tool_call", idempotency_key: "agent-patch",
    payload: { collection_id: schema.id, record_id: "agent", expected_version: 1, changes: { name: "done" } }
  });
  const writes = [generatedWrite, human.result as Record<string, any>, agent.result as Record<string, any>];
  const normalized = writes.map((write) => ({ operation: write.operation.operation, status: write.operation.status, decision: write.policyDecision.decision, version: write.resource.version, data: write.resource.data, audited: Boolean(write.auditRecord.id) }));
  assert.deepEqual(normalized[1], normalized[0]);
  assert.deepEqual(normalized[2], normalized[0]);
  assert.equal((await store.listSurfaceInteractions(createdResource.definition.id)).filter((item) => item.kind === "action").length, 1);
  await assert.rejects(runtime.runGeneratedSurfaceAction({
    surfaceId: createdResource.definition.id,
    revisionId: "stale-surface-revision",
    actionId: "complete",
    interactionId: "surface-interaction-stale",
    actionPayload: {}
  }), (error: unknown) => error instanceof RuntimeRequestError && error.code === "conflict");

  await runtime.shutdownMcpProcessPool();
  await store.close();
  store = await WorkspaceStore.create({ rootDir: sourceRoot });
  runtime = new AgentRuntime(store);
  const reloaded = await store.getGeneratedSurface(createdResource.definition.id);
  const reloadedBundle = await store.readGeneratedSurfaceBundle(createdResource.revision.id);
  assert.equal(reloaded?.content_hash, createdResource.definition.content_hash);
  assert.equal(stableHash(reloadedBundle), stableHash({ html: bundle.html, css: bundle.css, script: bundle.script }));

  const revisedBundle = { ...bundle, html: '<main><p>Revision 2</p><button type="button" data-action-id="complete">Complete</button></main>' };
  const revised = await runtime.runDomainCommand({
    command_id: "generated_surface.revise", input_source: "runtime_api", idempotency_key: "surface-revise",
    payload: { surface_id: createdResource.definition.id, request, bundle: revisedBundle } as unknown as Record<string, JsonValue>
  });
  const revisedResource = revised.result as { definition: { id: string; current_revision: number; current_revision_id: string; content_hash: string }; revision: { parent_revision_id: string; bundle_hash: string } };
  assert.equal(revisedResource.definition.id, createdResource.definition.id);
  assert.equal(revisedResource.definition.current_revision, 2);
  assert.equal(revisedResource.revision.parent_revision_id, createdResource.revision.id);
  assert.notEqual(revisedResource.definition.content_hash, createdResource.definition.content_hash);
  assert.ok(await store.readGeneratedSurfaceBundle(createdResource.revision.id));
  await runtime.runDomainCommand({ command_id: "generated_surface.state", input_source: "runtime_api", idempotency_key: "surface-pin", payload: { surface_id: createdResource.definition.id, action: "pin", interaction_id: "surface-interaction-pin" } });
  assert.equal((await store.getGeneratedSurface(createdResource.definition.id))?.state, "pinned");

  const exported = await store.exportWorkspaceBundle(exportRoot);
  const target = await WorkspaceStore.create({ rootDir: targetRoot });
  await target.importWorkspaceBundle(exported.path);
  const imported = await target.getGeneratedSurface(createdResource.definition.id);
  const importedRevisions = await target.listGeneratedSurfaceRevisions(createdResource.definition.id);
  const sourceRevisions = await store.listGeneratedSurfaceRevisions(createdResource.definition.id);
  assert.equal(imported?.content_hash, revisedResource.definition.content_hash);
  assert.deepEqual(importedRevisions.map((item) => item.bundle_hash), sourceRevisions.map((item) => item.bundle_hash));
  assert.equal(stableHash(await target.readGeneratedSurfaceBundle(imported!.current_revision_id)), stableHash(await store.readGeneratedSurfaceBundle(imported!.current_revision_id)));
  await target.close();

  process.stdout.write(`${JSON.stringify({
    status: "passed", command_parity: normalized, generated_action_audited: true, stale_validation_rejected: true,
    reload_same_hash: true, same_surface_id: true, revisions: sourceRevisions.length, parent_lineage: true, pinned: true,
    cross_client_resource_state: (await store.getCollectionRecord(schema.id, "generated"))?.data,
    export_import_hash_equal: true, interactions: (await store.listSurfaceInteractions(createdResource.definition.id)).map((item) => item.kind)
  })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await Promise.all([sourceRoot, targetRoot, exportRoot].map((root) => rm(root, { recursive: true, force: true })));
}
