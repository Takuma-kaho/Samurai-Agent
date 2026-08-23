import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-graph-artifact-"));
const store = await WorkspaceStore.create({ rootDir: root });
const runtime = new AgentRuntime(store);
try {
  const session = await runtime.createSession({ title: "Graph artifact fixture" });
  const trusted = { roomId: session.room_id! };
  const original = { version: "1", nodes: [{ id: "root", label: "Root" }], edges: [] };
  const created = await runtime.runDomainCommand({
    command_id: "graph.create",
    input_source: "provider_tool_call",
    idempotency_key: "graph-create",
    payload: { title: "Plan graph", content: JSON.stringify(original), output_locale: "en" }
  }, trusted);
  const artifact = (created.result as Record<string, any>).resource;
  assert.equal(artifact.kind, "graph");
  const initialRevision = (await store.listArtifactRevisions(artifact.id))[0];
  assert.ok(initialRevision, "graph create must persist an initial revision");

  const patched = await runtime.runDomainCommand({
    command_id: "graph.patch",
    input_source: "surface_operation",
    idempotency_key: "graph-patch",
    payload: {
      artifact_id: artifact.id,
      nodes: [{ id: "child", label: "Child", position: { x: 120, y: 80 } }],
      edges: [{ id: "root-child", source: "root", target: "child" }],
      editor_source: "surface"
    }
  }, trusted);
  const revision = (patched.result as Record<string, any>).revision;
  assert.equal(revision.editor_source, "surface");
  const reloaded = JSON.parse((await store.readArtifactContent(artifact.id))!);
  assert.equal(reloaded.nodes.length, 2);
  assert.equal(reloaded.edges.length, 1);

  await assert.rejects(runtime.runDomainCommand({
    command_id: "graph.patch",
    input_source: "provider_tool_call",
    idempotency_key: "graph-invalid-edge",
    payload: { artifact_id: artifact.id, edges: [{ id: "broken", source: "root", target: "missing" }] }
  }, trusted), /graph_edge_node_missing|graph_document_invalid/);

  const restored = await runtime.runDomainCommand({
    command_id: "artifact.restore_revision",
    input_source: "surface_operation",
    idempotency_key: "graph-restore",
    payload: { artifact_id: artifact.id, revision_id: initialRevision.id, base_revision_id: revision.id }
  }, trusted);
  const restoredRevision = (restored.result as Record<string, any>).revision;
  assert.equal(restoredRevision.editor_source, "restore");
  assert.equal(restoredRevision.parent_revision_id, revision.id);
  const restoredContent = JSON.parse((await store.readArtifactContent(artifact.id))!);
  assert.deepEqual(restoredContent, original);
  const restoredSource = JSON.parse(Buffer.from((await store.readArtifactRevisionContent(restoredRevision.id))!).toString());
  assert.deepEqual(restoredSource, original);
  process.stdout.write(`${JSON.stringify({ status: "passed", graph_created: true, graph_edited: true, invalid_reference_rejected: true, reload_equal: true, restore_revision: true, restored_content_equal: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
