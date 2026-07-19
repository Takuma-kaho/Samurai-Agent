import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-image-artifact-"));
const store = await WorkspaceStore.create({ rootDir: root });
const runtime = new AgentRuntime(store);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=";
try {
  const generated = await runtime.runDomainCommand({
    command_id: "image.generate",
    input_source: "provider_tool_call",
    idempotency_key: "image-generate",
    payload: { title: "Generated pixel", provider: "fixture-provider", prompt: "one pixel", source_run_id: "run-image-generate", mime_type: "image/png", width: 1, height: 1, data_base64: png, provenance: { request_id: "fixture-1" } }
  });
  const generatedWrite = generated.result as Record<string, any>;
  assert.equal(generatedWrite.resource.kind, "image");
  assert.equal(generatedWrite.revision.editor_source, "image_provider");
  assert.equal(generatedWrite.revision.provenance.operation, "generate");

  const edited = await runtime.runDomainCommand({
    command_id: "image.edit",
    input_source: "provider_tool_call",
    idempotency_key: "image-edit",
    payload: { artifact_id: generatedWrite.resource.id, base_revision_id: generatedWrite.revision.id, provider: "fixture-provider", prompt: "edit pixel", source_run_id: "run-image-edit", mime_type: "image/png", width: 1, height: 1, data_base64: png }
  });
  const editedWrite = edited.result as Record<string, any>;
  assert.equal(editedWrite.revision.parent_revision_id, generatedWrite.revision.id);
  assert.equal(editedWrite.revision.provenance.operation, "edit");
  assert.equal(editedWrite.revision.provenance.source_asset_id, generatedWrite.resource.id);

  const restored = await runtime.runDomainCommand({
    command_id: "artifact.restore_revision",
    input_source: "runtime_api",
    idempotency_key: "image-restore",
    payload: { artifact_id: generatedWrite.resource.id, revision_id: generatedWrite.revision.id, base_revision_id: editedWrite.revision.id }
  });
  assert.equal((restored.result as Record<string, any>).revision.editor_source, "restore");

  await assert.rejects(runtime.runDomainCommand({
    command_id: "image.generate",
    input_source: "runtime_api",
    idempotency_key: "image-provider-missing",
    payload: { title: "Missing provider", prompt: "no provider", source_run_id: "run-missing", mime_type: "image/png", width: 1, height: 1, data_base64: png }
  }), /image_provider_result_incomplete/);

  process.stdout.write(`${JSON.stringify({ status: "passed", generated_revision: true, edited_revision: true, provenance: true, restored_revision: true, missing_provider_rejected: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
