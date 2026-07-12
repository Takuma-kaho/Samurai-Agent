import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stableHash } from "../../packages/core-schemas/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const sourceRoot = await mkdtemp(path.join(tmpdir(), "samurai-artifact-revisions-"));
const targetRoot = await mkdtemp(path.join(tmpdir(), "samurai-artifact-revisions-target-"));
const exportRoot = await mkdtemp(path.join(tmpdir(), "samurai-artifact-revisions-export-"));
const store = await WorkspaceStore.create({ rootDir: sourceRoot });
const runtime = new AgentRuntime(store);
try {
  const now = "2026-07-11T00:00:00.000Z";
  await store.createSession({ id: "artifact-session", session_key: "web:artifact:main", title: "Artifact revisions", ui_locale: "en", output_locale: "en", created_at: now, updated_at: now });
  const originalPath = await store.writeArtifactContent("artifact-lineage", "revision zero", { extension: "md" });
  await store.saveArtifactMetadata({
    id: "artifact-lineage", title: "Lineage artifact", kind: "markdown", locale: "en", source_locales: ["en"],
    file_ref: { kind: "artifact", id: "artifact-lineage", uri: originalPath, label: "Lineage artifact" }, metadata: {},
    source_operation_id: "artifact-source-operation", created_by: "fixture", created_at: now, updated_at: now
  });
  const first = await runtime.runDomainCommand({ command_id: "artifact.revise", input_source: "runtime_api", idempotency_key: "artifact-revision-1", payload: { artifact_id: "artifact-lineage", session_id: "artifact-session", content: "revision one", extension: "md" } });
  const second = await runtime.runDomainCommand({ command_id: "artifact.revise", input_source: "runtime_api", idempotency_key: "artifact-revision-2", payload: { artifact_id: "artifact-lineage", session_id: "artifact-session", content: "revision two", extension: "md" } });
  const firstWrite = first.result as Record<string, any>;
  const secondWrite = second.result as Record<string, any>;
  assert.equal(firstWrite.revision.revision, 1);
  assert.equal(secondWrite.revision.revision, 2);
  assert.equal(secondWrite.revision.parent_revision_id, firstWrite.revision.id);
  assert.notEqual(firstWrite.revision.content_hash, secondWrite.revision.content_hash);
  assert.equal(Buffer.from((await store.readArtifactRevisionContent(firstWrite.revision.id))!).toString(), "revision one");
  assert.equal(Buffer.from((await store.readArtifactRevisionContent(secondWrite.revision.id))!).toString(), "revision two");

  await rm(path.join(sourceRoot, secondWrite.revision.file_ref.uri), { force: true });
  const repaired = await runtime.runDomainCommand({ command_id: "artifact.repair", input_source: "runtime_api", idempotency_key: "artifact-repair", payload: { artifact_id: "artifact-lineage" } });
  assert.equal((repaired.result as Record<string, any>).repair.repaired, true);
  assert.equal(Buffer.from((await store.readArtifactRevisionContent(secondWrite.revision.id))!).toString(), "revision two");

  const exported = await store.exportWorkspaceBundle(exportRoot);
  const target = await WorkspaceStore.create({ rootDir: targetRoot });
  await target.importWorkspaceBundle(exported.path);
  const sourceRevisions = await store.listArtifactRevisions("artifact-lineage");
  const targetRevisions = await target.listArtifactRevisions("artifact-lineage");
  assert.deepEqual(targetRevisions.map((item) => item.content_hash), sourceRevisions.map((item) => item.content_hash));
  const sourceContents = await Promise.all(sourceRevisions.map(async (item) => stableHash(Buffer.from((await store.readArtifactRevisionContent(item.id))!).toString())));
  const targetContents = await Promise.all(targetRevisions.map(async (item) => stableHash(Buffer.from((await target.readArtifactRevisionContent(item.id))!).toString())));
  assert.deepEqual(targetContents, sourceContents);
  await target.close();

  process.stdout.write(`${JSON.stringify({ status: "passed", revisions: 2, lineage: [firstWrite.revision.id, secondWrite.revision.parent_revision_id], hashes_unique: true, old_revision_redisplay: true, missing_source_repaired: true, audit_records: [firstWrite.auditRecord.id, secondWrite.auditRecord.id, (repaired.result as Record<string, any>).auditRecord.id].length, export_import_hash_equal: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await Promise.all([sourceRoot, targetRoot, exportRoot].map((root) => rm(root, { recursive: true, force: true })));
}
