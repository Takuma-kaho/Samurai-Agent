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
  // A Session only gives this fixture a trusted Room. The Artifact mutations
  // themselves are Session-free Core08 calls.
  const compatibilitySession = await runtime.createSession({ title: "Artifact revisions", ui_locale: "en", output_locale: "en" });
  const directTrusted = { roomId: compatibilitySession.room_id! };
  const sessionsBeforeMutations = (await store.listSessions()).length;
  const created = await runtime.runDomainCommand({
    command_id: "artifact.create", input_source: "runtime_api", idempotency_key: "artifact-create",
    payload: { title: "Lineage artifact", content: "revision zero", kind: "markdown", output_locale: "en", input_locale: "en", metadata: {} }
  }, directTrusted);
  const artifactId = (created.result as Record<string, any>).resource.id as string;
  const first = await runtime.runDomainCommand({ command_id: "artifact.revise", input_source: "runtime_api", idempotency_key: "artifact-revision-1", payload: { artifact_id: artifactId, content: "revision one", extension: "md", editor_source: "surface", change_summary: "Surface edit" } }, directTrusted);
  const firstWrite = first.result as Record<string, any>;
  const second = await runtime.runDomainCommand({ command_id: "artifact.revise", input_source: "runtime_api", idempotency_key: "artifact-revision-2", payload: { artifact_id: artifactId, content: "revision two", extension: "md", base_revision_id: firstWrite.revision.id, editor_source: "chat", change_summary: "Chat edit", provenance: { source: "fixture" } } }, directTrusted);
  const secondWrite = second.result as Record<string, any>;
  assert.equal(firstWrite.revision.revision, 1);
  assert.equal(secondWrite.revision.revision, 2);
  assert.equal(secondWrite.revision.parent_revision_id, firstWrite.revision.id);
  assert.equal(firstWrite.revision.editor_source, "surface");
  assert.equal(secondWrite.revision.editor_source, "chat");
  assert.equal(secondWrite.revision.base_revision_id, firstWrite.revision.id);
  assert.notEqual(firstWrite.revision.content_hash, secondWrite.revision.content_hash);
  assert.equal(Buffer.from((await store.readArtifactRevisionContent(firstWrite.revision.id))!).toString(), "revision one");
  assert.equal(Buffer.from((await store.readArtifactRevisionContent(secondWrite.revision.id))!).toString(), "revision two");

  await assert.rejects(
    runtime.runDomainCommand({ command_id: "artifact.revise", input_source: "runtime_api", idempotency_key: "artifact-revision-conflict", payload: { artifact_id: artifactId, content: "stale edit", base_revision_id: firstWrite.revision.id } }, directTrusted),
    /artifact_revision_conflict/
  );
  const restored = await runtime.runDomainCommand({ command_id: "artifact.restore_revision", input_source: "runtime_api", idempotency_key: "artifact-revision-restore", payload: { artifact_id: artifactId, revision_id: firstWrite.revision.id, base_revision_id: secondWrite.revision.id } }, directTrusted);
  const restoredWrite = restored.result as Record<string, any>;
  assert.equal(restoredWrite.revision.editor_source, "restore");
  assert.equal(Buffer.from((await store.readArtifactRevisionContent(restoredWrite.revision.id))!).toString(), "revision one");

  await rm(path.join(sourceRoot, restoredWrite.revision.file_ref.uri), { force: true });
  const repaired = await runtime.runDomainCommand({ command_id: "artifact.repair", input_source: "runtime_api", idempotency_key: "artifact-repair", payload: { artifact_id: artifactId } }, directTrusted);
  assert.equal((repaired.result as Record<string, any>).repair.repaired, true);
  assert.equal(Buffer.from((await store.readArtifactRevisionContent(restoredWrite.revision.id))!).toString(), "revision one");

  const exported = await store.exportWorkspaceBundle(exportRoot);
  const target = await WorkspaceStore.create({ rootDir: targetRoot });
  await target.importWorkspaceBundle(exported.path);
  const sourceRevisions = await store.listArtifactRevisions(artifactId);
  const targetRevisions = await target.listArtifactRevisions(artifactId);
  assert.deepEqual(targetRevisions.map((item) => item.content_hash), sourceRevisions.map((item) => item.content_hash));
  const sourceContents = await Promise.all(sourceRevisions.map(async (item) => stableHash(Buffer.from((await store.readArtifactRevisionContent(item.id))!).toString())));
  const targetContents = await Promise.all(targetRevisions.map(async (item) => stableHash(Buffer.from((await target.readArtifactRevisionContent(item.id))!).toString())));
  assert.deepEqual(targetContents, sourceContents);
  await target.close();

  const mutationOperationIds = [firstWrite.operation.id, secondWrite.operation.id, restoredWrite.operation.id, (repaired.result as Record<string, any>).operation.id];
  const activities = await store.listActivities({ workspaceId: "workspace", roomId: compatibilitySession.room_id });
  const mutationActivities = activities.filter((activity) => mutationOperationIds.some((operationId) => activity.domain_operation_ids.includes(operationId)));
  assert.equal(mutationActivities.length, 4);
  for (const activity of mutationActivities) {
    const usage = await store.listResourceUsage({ activityId: activity.id });
    assert.ok(usage.some((item) => item.stage === "modified"));
  }
  assert.equal((await store.listSessions()).length, sessionsBeforeMutations);

  process.stdout.write(`${JSON.stringify({ status: "passed", revisions: 3, lineage: [firstWrite.revision.id, secondWrite.revision.parent_revision_id, restoredWrite.revision.parent_revision_id], hashes_unique: true, conflict_rejected: true, restored_revision: true, old_revision_redisplay: true, missing_source_repaired: true, activity_evidence: mutationActivities.length, export_import_hash_equal: true, session_count_unchanged: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await Promise.all([sourceRoot, targetRoot, exportRoot].map((root) => rm(root, { recursive: true, force: true })));
}
