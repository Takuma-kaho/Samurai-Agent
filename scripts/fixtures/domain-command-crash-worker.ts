import { appendFile } from "node:fs/promises";
import { nowIso } from "../../packages/core-schemas/src/index";
import { WorkspaceStore, type CollectionSchema, type CollectionRecord } from "../../packages/workspace-store/src/index";
import { localOwnerParticipantId } from "../../packages/room-permissions/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { DurableDomainCommandBus, type DomainCommandCheckpoint } from "../../packages/runtime/src/commands/domain-command-bus";

const root = requiredEnvironment("SAMURAI_WORKER_ROOT");
const mode = requiredEnvironment("SAMURAI_CRASH_MODE");
const sideEffectFile = process.env.SAMURAI_WORKER_SIDE_EFFECT_FILE;
if (mode === "during_internal_transaction") {
  const store = await WorkspaceStore.create({
    rootDir: root,
    fileTransactionFailureInjector(phase) {
      if (phase === "db_transaction") process.exit(93);
    }
  });
  const schema: CollectionSchema = {
    id: "crash",
    version: "1.0",
    labels: { en: "Crash fixture" },
    descriptions: { en: "Crash fixture" },
    fields: [{ id: "value", type: "string" }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {}
  };
  if (!await store.getCollectionSchema(schema.id)) await store.saveCollectionSchema(schema);
  const now = nowIso();
  const record: CollectionRecord = {
    id: "partial", collection_id: schema.id, version: 1, data: { value: "before" }, resource_refs: [], created_at: now, updated_at: now
  };
  if (!await store.getCollectionRecord(record.collection_id, record.id)) await store.saveCollectionRecord(record);
  const settings = await store.getSettings();
  if (!settings.default_room_id) throw new Error("fixture_room_required");
  const sessionId = "crash-domain-command-session";
  if (!await store.getSession(sessionId)) {
    await store.createSession({
      id: sessionId,
      session_key: sessionId,
      room_id: settings.default_room_id,
      title: "Crash command fixture",
      ui_locale: "en",
      output_locale: "en",
      created_at: now,
      updated_at: now
    });
  }
  for (const [resourceKind, resourceId] of [
    ["session", sessionId],
    ["collection_schema", schema.id],
    ["collection_record", `${record.collection_id}/${record.id}`]
  ] as const) {
    await store.ensureResourceAccessBoundary({
      resourceKind,
      resourceId,
      sourceRoomId: settings.default_room_id,
      ownerParticipantId: localOwnerParticipantId,
      actorId: localOwnerParticipantId
    });
  }
  const runtime = new AgentRuntime(store, undefined, undefined, undefined, undefined, undefined, { domainCommandRunningTimeoutMs: 100 });
  await runtime.runRuntimeApiDomainCommand({
    command_id: "collection.patch.apply",
    idempotency_key: "crash-during-internal-transaction",
    payload: {
      collection_id: record.collection_id,
      record_id: record.id,
      expected_version: 1,
      patch_id: "crash-patch",
      changes: { value: "after" }
    }
  }, { sessionId });
  await runtime.shutdownMcpProcessPool();
  await store.close();
  process.exit(0);
}
const crashCheckpoint: DomainCommandCheckpoint = mode === "before_handler" ? "claimed" : "handler_succeeded";
const executionClass = mode === "before_handler" ? "internal" : "external";
const idempotencyKey = mode === "before_handler" ? "crash-before-handler" : "crash-after-external";
const store = await WorkspaceStore.create({ rootDir: root });
const bus = new DurableDomainCommandBus(store, 100, {
  checkpoint(name) {
    if (name === crashCheckpoint) process.exit(mode === "before_handler" ? 91 : 92);
  }
});

await bus.execute({
  commandId: `test.${mode}`,
  inputSource: "runtime_api",
  payload: { mode },
  idempotencyKey,
  executionClass
}, async () => {
  if (sideEffectFile) await appendFile(sideEffectFile, "external-effect\n", "utf8");
  return { completed: true };
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}
