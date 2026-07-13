import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CollectionSchema } from "../../packages/core-schemas/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-surface-artifacts-"));
let store = await WorkspaceStore.create({ rootDir: root });
let runtime = new AgentRuntime(store);
try {
  const session = await runtime.createSession({ title: "Surface contracts" });
  const document = await runtime.runDomainCommand({ command_id: "artifact.create", input_source: "provider_tool_call", idempotency_key: "document-create", payload: { session_id: session.id, title: "Document", content: "Persistent document", kind: "document", provider_tool_call: true, output_locale: "en" } });
  const documentArtifact = (document.result as Record<string, any>).resource;
  const chart = await runtime.runSurfaceOperation({ id: "chart-create", kind: "chart.request", session_id: session.id, title: "Revenue", query: "sum revenue", data_refs: ["collection:calendar"], output_locale: "en" });
  const chartArtifact = (chart.result as Record<string, any>).resource;
  assert.equal(chartArtifact.kind, "chart");

  const schema: CollectionSchema = { id: "calendar", version: "1", labels: { en: "Calendar" }, descriptions: { en: "Calendar" }, fields: [{ id: "title", type: "string" }, { id: "date", type: "date" }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [{ id: "calendar", renderer: "calendar_view", fields: ["title", "date"], config: { date_field: "date" } }], permissions: { update: true } };
  await store.saveCollectionSchema(schema);
  const now = new Date().toISOString();
  await store.saveCollectionRecord({ id: "event", collection_id: schema.id, version: 1, data: { title: "Review", date: "2026-07-14" }, resource_refs: [], created_at: now, updated_at: now });
  await runtime.runDomainCommand({ command_id: "collection.patch.apply", input_source: "surface_operation", idempotency_key: "calendar-edit", payload: { collection_id: schema.id, record_id: "event", expected_version: 1, changes: { date: "2026-07-15" } } });
  const calendarView = await runtime.runDomainCommand({ command_id: "collection.view.present", input_source: "surface_operation", idempotency_key: "calendar-view", payload: { collection_id: schema.id, view_id: "calendar" } });
  assert.equal(calendarView.render_spec?.kind === "custom_view" || calendarView.render_spec?.kind === "collection", true);

  const inspected = await runtime.runDomainCommand({ command_id: "file.inspect", input_source: "surface_operation", idempotency_key: "file-inspect", payload: { path: documentArtifact.file_ref.uri } });
  const file = (inspected.result as Record<string, any>).resource;
  assert.equal(file.metadata.size > 0, true);
  assert.equal(file.provenance.artifact_ids.includes(documentArtifact.id), true);

  await runtime.shutdownMcpProcessPool();
  await store.close();
  store = await WorkspaceStore.create({ rootDir: root });
  runtime = new AgentRuntime(store);
  assert.equal(await store.readArtifactContent(documentArtifact.id), "Persistent document");
  assert.equal((await store.getArtifact(chartArtifact.id))?.kind, "chart");
  assert.equal((await store.getCollectionRecord("calendar", "event"))?.data.date, "2026-07-15");
  process.stdout.write(`${JSON.stringify({ status: "passed", document_reload: true, chart_generate_reload: true, calendar_same_source_reload: true, file_metadata_provenance: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
