import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createId, nowIso, type BackendEventRecord, type MessageEnvelope, type SessionRecord } from "@samurai-agent/core-schemas";
import { sql } from "kysely";
import { WorkspaceStore } from "./workspace-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Core 02 event source identity", () => {
  it("migrates ID-first dedupe and preserves every canonical part", async () => {
    const fixture = await createFixture();
    await sql.raw("DROP INDEX IF EXISTS idx_backend_events_source_sequence").execute(fixture.store.db);
    await sql.raw("CREATE UNIQUE INDEX idx_backend_events_source_sequence ON backend_events(run_id, attempt_no, source_sequence) WHERE source_sequence IS NOT NULL").execute(fixture.store.db);
    await fixture.store.close();
    const store = await WorkspaceStore.create({ rootDir: fixture.root });

    const index = await sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_backend_events_source_sequence'`.execute(store.db);
    expect(index.rows[0]?.sql).toContain("source_event_id IS NULL");

    const expanded: CanonicalEventFixture[] = [
      { event_type: "text_delta", source_event_id: "provider-id:provider-event-1:part:0", source_sequence: 7, payload: { text: "hello" }, resource_refs: [] },
      { event_type: "tool_call_started", source_event_id: "provider-id:provider-event-1:part:1", source_sequence: 7, payload: { tool_call_id: "call-read", provider_tool_name: "Read" }, resource_refs: [] },
      { event_type: "tool_call_started", source_event_id: "provider-id:provider-event-1:part:2", source_sequence: 7, payload: { tool_call_id: "call-search", provider_tool_name: "Search" }, resource_refs: [] }
    ];
    expect(expanded).toHaveLength(3);
    expect(new Set(expanded.map((event) => event.source_event_id)).size).toBe(3);
    expect(expanded.map((event) => event.source_sequence)).toEqual([7, 7, 7]);

    for (const event of expanded) {
      expect((await store.appendCore02Event(toRecord(fixture.runId, fixture.sessionId, event, 1))).duplicate).toBe(false);
    }
    for (const event of expanded) {
      expect((await store.appendCore02Event(toRecord(fixture.runId, fixture.sessionId, event, 1))).duplicate).toBe(true);
    }

    const idAndSequence = eventRecord(fixture.runId, fixture.sessionId, 1, { source_event_id: "provider-both", source_sequence: 20 });
    const sequenceOnly = eventRecord(fixture.runId, fixture.sessionId, 1, { source_sequence: 20 });
    expect((await store.appendCore02Event(idAndSequence)).duplicate).toBe(false);
    expect((await store.appendCore02Event(sequenceOnly)).duplicate).toBe(false);
    expect((await store.appendCore02Event(eventRecord(fixture.runId, fixture.sessionId, 1, { source_event_id: "provider-both", source_sequence: 21 }))).duplicate).toBe(true);
    expect((await store.appendCore02Event(eventRecord(fixture.runId, fixture.sessionId, 1, { source_sequence: 20 }))).duplicate).toBe(true);
    expect((await store.appendCore02Event(eventRecord(fixture.runId, fixture.sessionId, 2, { source_event_id: "provider-both", source_sequence: 20 }))).duplicate).toBe(false);

    const expectedRun = await store.getBackendRun(fixture.runId);
    if (!expectedRun) throw new Error("fixture_run_missing");
    const committed = await store.commitCore02LifecycleEvent({
      expectedRun,
      nextRun: { ...expectedRun, status: "running", phase: "external_running" },
      event: { ...eventRecord(fixture.runId, fixture.sessionId, 1, { source_event_id: "provider-commit", source_sequence: 20 }), event_type: "run_started" }
    });
    expect(committed.duplicate).toBe(false);
    expect(committed.run.status).toBe("running");
    expect(await store.listBackendEvents({ runId: fixture.runId })).toHaveLength(7);
    await store.close();
  });
});

async function createFixture(): Promise<{ root: string; store: WorkspaceStore; runId: string; sessionId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core02-event-identity-"));
  roots.push(root);
  const store = await WorkspaceStore.create({ rootDir: root });
  const now = nowIso();
  const session: SessionRecord = { id: createId("session"), session_key: "web:owner:event-identity", title: "Event identity", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
  await store.createSession(session);
  const envelope: MessageEnvelope = { id: createId("envelope"), source: "web", actor_identity: "owner", session_key: session.session_key, user_intent: "chat", attachments: [], input_locale: "ja", output_locale: "ja", metadata: {}, received_at: now };
  const admitted = await store.admitTurn({ session, binding: { id: "external", kind: "external" }, request: { sessionId: session.id, content: "identity", envelope, idempotencyKey: createId("identity-key"), metadata: {} }, requestHash: "identity-hash", runId: createId("run"), now });
  return { root, store, runId: admitted.run.id, sessionId: session.id };
}

type CanonicalEventFixture = Pick<BackendEventRecord, "event_type" | "source_event_id" | "source_sequence" | "payload" | "resource_refs">;

function toRecord(runId: string, sessionId: string, event: CanonicalEventFixture, attemptNo: number): BackendEventRecord {
  return {
    id: createId("event"), run_id: runId, session_id: sessionId, event_type: event.event_type, sequence: 0, attempt_no: attemptNo,
    source_event_id: event.source_event_id, source_sequence: event.source_sequence, payload: event.payload, resource_refs: event.resource_refs ?? [], created_at: nowIso()
  };
}

function eventRecord(runId: string, sessionId: string, attemptNo: number, identity: Pick<BackendEventRecord, "source_event_id" | "source_sequence">): BackendEventRecord {
  return {
    id: createId("event"), run_id: runId, session_id: sessionId, event_type: "text_delta", sequence: 0, attempt_no: attemptNo,
    ...identity, payload: { text: "same sequence is valid" }, resource_refs: [], created_at: nowIso()
  };
}
