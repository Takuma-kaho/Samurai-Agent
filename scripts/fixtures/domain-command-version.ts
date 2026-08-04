import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nowIso, type CollectionPatch, type CollectionSchema, type SessionRecord } from "../../packages/core-schemas/src/index";
import { AgentRuntime, RuntimeRequestError, type ResourceVersionConflictPayload } from "../../packages/runtime/src/index";
import { localOwnerParticipantId } from "../../packages/room-permissions/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-domain-version-evidence-"));
const store = await WorkspaceStore.create({ rootDir: root });
const runtime = new AgentRuntime(store);
const labels = { ja: "項目", en: "Items", zh: "项目", ko: "항목", es: "Elementos", "pt-BR": "Itens", fr: "Éléments", de: "Elemente" };
const schema: CollectionSchema = {
  id: "versioned_items",
  version: "1",
  labels,
  descriptions: labels,
  fields: [{ id: "name", type: "string", required: true }],
  refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], permissions: {}
};

try {
  const sqliteSettings = await store.getSqliteRuntimeSettings();
  assert.equal(sqliteSettings.foreign_keys, 1);
  assert.equal(sqliteSettings.journal_mode.toLowerCase(), "wal");
  assert.ok(sqliteSettings.busy_timeout >= 5_000);
  const settings = await store.getSettings();
  assert.ok(settings.default_room_id, "default Room is required for a mutation");
  const session: SessionRecord = {
    id: "domain-command-version-session",
    session_key: "domain-command-version-session",
    room_id: settings.default_room_id,
    title: "Domain command version fixture",
    ui_locale: "en",
    output_locale: "en",
    created_at: nowIso(),
    updated_at: nowIso()
  };
  await store.createSession(session);
  await store.ensureResourceAccessBoundary({
    resourceKind: "session",
    resourceId: session.id,
    sourceRoomId: session.room_id,
    ownerParticipantId: localOwnerParticipantId,
    actorId: localOwnerParticipantId
  });
  await store.saveCollectionSchema(schema);
  const now = nowIso();
  await store.saveCollectionRecord({
    id: "item-1",
    collection_id: schema.id,
    version: 1,
    data: { name: "before" },
    resource_refs: [],
    created_at: now,
    updated_at: now
  });
  await store.ensureResourceAccessBoundary({
    resourceKind: "collection_record",
    resourceId: `${schema.id}/item-1`,
    sourceRoomId: session.room_id,
    ownerParticipantId: localOwnerParticipantId,
    actorId: localOwnerParticipantId
  });

  const applyPatch = async (patch: CollectionPatch) => {
    const command = await runtime.runRuntimeApiDomainCommand({
      command_id: "collection.patch.apply",
      idempotency_key: `domain-command-version:${patch.id}`,
      payload: {
        collection_id: schema.id,
        record_id: "item-1",
        patch_id: patch.id,
        expected_version: patch.expected_version,
        changes: patch.changes
      }
    }, { sessionId: session.id });
    return command.result as Awaited<ReturnType<AgentRuntime["applyCollectionPatch"]>>;
  };

  const first = await applyPatch({ id: "patch-first", record_id: "item-1", expected_version: 1, changes: { name: "first" }, source_operation_id: "fixture", created_at: nowIso() });
  assert.equal(first.resource.version, 2);

  const replay = await applyPatch({ id: "patch-first", record_id: "item-1", expected_version: 1, changes: { name: "first" }, source_operation_id: "fixture", created_at: nowIso() });
  assert.equal(replay.resource.version, first.resource.version);
  assert.deepEqual(replay.resource.data, first.resource.data);

  let stalePayload: ResourceVersionConflictPayload | undefined;
  try {
    await applyPatch({ id: "patch-stale", record_id: "item-1", expected_version: 1, changes: { name: "stale" }, source_operation_id: "fixture", created_at: nowIso() });
  } catch (error) {
    assert.ok(error instanceof RuntimeRequestError);
    assert.equal(error.code, "conflict");
    assert.ok(error.payload && "conflict" in error.payload);
    stalePayload = error.payload as ResourceVersionConflictPayload;
  }
  assert.equal(stalePayload?.actual_version, 2);
  assert.equal(stalePayload?.latest_resource.data.name, "first");
  assert.equal(stalePayload?.retry.expected_version, 2);

  const attempts = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => applyPatch({
      id: `patch-race-${index}`,
      record_id: "item-1",
      expected_version: 2,
      changes: { name: `winner-${index}` },
      source_operation_id: "fixture",
      created_at: nowIso()
    })));
  const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 99);
  assert.ok(rejected.every((attempt) => attempt.reason instanceof RuntimeRequestError && attempt.reason.code === "conflict"));
  const latest = await store.getCollectionRecord(schema.id, "item-1");
  assert.equal(latest?.version, 3);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    stale_update_rejected: true,
    latest_resource_returned: true,
    retry_version_returned: true,
    parallel_updates: 100,
    successful_updates: fulfilled.length,
    rejected_updates: rejected.length,
    final_version: latest?.version,
    sqlite_settings: sqliteSettings
  })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
