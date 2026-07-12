import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactPrivateData } from "../../packages/core-schemas/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-privacy-"));
const store = await WorkspaceStore.create({ rootDir: root });
const at = "2026-01-01T00:00:00.000Z";
const secrets = ["sk-abcdefghijklmnopqrstuvwxyz", "AKIAABCDEFGHIJKLMNOP", "person@example.com", "090-1234-5678", "header.payload.signature"];
const assertClean = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `private value leaked: ${secret}`);
  assert.match(text, /\[redacted/);
};

try {
  await store.createSession({ id: "s", session_key: "s", title: "s", ui_locale: "ja", output_locale: "ja", created_at: at, updated_at: at });
  await store.saveMessage({ id: "m", session_id: "s", role: "user", content: "本文は保持する", input_locale: "ja", output_locale: "ja", created_at: at });
  await store.saveBackendRun({ id: "run", session_id: "s", input_message_id: "m", backend_id: "b", backend_kind: "samurai_native", status: "completed", started_at: at, completed_at: at, input_summary: "x", metadata: {} });

  const event = await store.saveBackendEvent({ id: "e", run_id: "run", session_id: "s", event_type: "text_delta", sequence: 1, payload: { api_key: secrets[0], detail: `Bearer ${secrets[4]} ${secrets[2]}` }, resource_refs: [], created_at: at });
  const artifact = await store.saveArtifactMetadata({ id: "a", title: "a", kind: "note", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "a", uri: "workspace://artifacts/a" }, metadata: { credential: secrets[1], owner: secrets[2] }, source_operation_id: "op", created_by: "fixture", created_at: at, updated_at: at });
  const learning = await store.recordLearningResourceUse({ id: "l", run_id: "run", session_id: "s", resource_kind: "memory", resource_id: "memory-1", stage: "selected", metadata: { source: `${secrets[2]} / ${secrets[3]}`, token: secrets[4] }, created_at: at });
  const gateway = await store.saveGatewayInboundMessage({ id: "g", channel: "webhook", source_identity: "source", body: "本文は保持する", status: "failed", trusted: false, error: `authorization=${secrets[4]} owner=${secrets[2]}`, metadata: { cookie: secrets[0], phone: secrets[3] }, created_at: at, updated_at: at });
  const display = redactPrivateData({ message: `Bearer ${secrets[4]}`, email: secrets[2], phone: secrets[3] }, { redactPii: true });

  for (const value of [event, artifact, learning, gateway, display, ...(await store.listBackendEvents({ runId: "run" })), ...(await store.listArtifacts()), ...(await store.listLearningResourceUses({ runId: "run" })), ...(await store.listGatewayInboundMessages())]) assertClean(value);
  assert.equal((await store.listGatewayInboundMessages())[0]?.body, "本文は保持する");
  process.stdout.write(`${JSON.stringify({ status: "passed", event_redacted: true, artifact_metadata_redacted: true, learning_source_redacted: true, gateway_error_redacted: true, display_redacted: true, body_preserved: true })}\n`);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
