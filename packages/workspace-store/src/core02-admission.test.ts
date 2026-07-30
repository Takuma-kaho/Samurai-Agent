import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createId, nowIso, type BackendEventRecord, type MessageEnvelope, type SessionRecord } from "@samurai-agent/core-schemas";
import { RunLifecycle } from "../../runtime/src/execution/run-lifecycle";
import { WorkspaceStore } from "./workspace-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core02-")); roots.push(root);
  const store = await WorkspaceStore.create({ rootDir: root }); const now = nowIso();
  const session: SessionRecord = { id: createId("session"), session_key: "web:owner:core02", title: "Core 02", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
  await store.createSession(session);
  const envelope: MessageEnvelope = { id: createId("envelope"), source: "web", actor_identity: "owner", session_key: session.session_key, user_intent: "chat", attachments: [], input_locale: "ja", output_locale: "ja", metadata: {}, received_at: now };
  return { store, session, envelope };
}

async function twoStoreFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core02-shared-")); roots.push(root);
  const firstStore = await WorkspaceStore.create({ rootDir: root });
  const secondStore = await WorkspaceStore.create({ rootDir: root });
  const now = nowIso();
  const session: SessionRecord = { id: createId("session"), session_key: "web:owner:core02-shared", title: "Core 02", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
  await firstStore.createSession(session);
  const envelope: MessageEnvelope = { id: createId("envelope"), source: "web", actor_identity: "owner", session_key: session.session_key, user_intent: "chat", attachments: [], input_locale: "ja", output_locale: "ja", metadata: {}, received_at: now };
  return { firstStore, secondStore, session, envelope };
}

function reservationCount(dbPath: string, sessionId: string): number {
  const database = new Database(dbPath);
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM session_run_reservations WHERE session_id = ?").get(sessionId) as { count: number };
    return Number(row.count);
  } finally {
    database.close();
  }
}

function installAdmissionFault(dbPath: string): void {
  const database = new Database(dbPath);
  try {
    database.exec("CREATE TRIGGER core02_admission_fault BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'core02_admission_fault'); END");
  } finally {
    database.close();
  }
}

describe("Core 02 admission transaction", () => {
  it("is idempotent, reuses released reservation, and rejects hash conflicts", async () => {
    const { store, session, envelope } = await fixture();
    const first = await store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "hello", envelope, idempotencyKey: "key-1", metadata: {} }, requestHash: "hash-1", runId: createId("run"), now: nowIso() });
    await settleCompleted(store, first.run);
    const second = await store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "again", envelope: { ...envelope, id: createId("envelope") }, idempotencyKey: "key-2", metadata: {} }, requestHash: "hash-2", runId: createId("run"), now: nowIso() });
    expect(second.reservation.version).toBeGreaterThan(first.reservation.version);
    const replay = await store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "hello", envelope, idempotencyKey: "key-1", metadata: {} }, requestHash: "hash-1", runId: createId("run"), now: nowIso() });
    expect(replay.replay).toBe(true); expect(replay.run.id).toBe(first.run.id);
    await expect(store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "changed", envelope, idempotencyKey: "key-1", metadata: {} }, requestHash: "different", runId: createId("run"), now: nowIso() })).rejects.toThrow("idempotency_conflict");
    await store.close();
  });

  it("C02-H03 same-key concurrent requests converge to one run", async () => {
    const { store, session, envelope } = await fixture();
    const request = { sessionId: session.id, content: "same", envelope, idempotencyKey: "concurrent", metadata: {} };
    const results = await Promise.allSettled([
      store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request, requestHash: "same-hash", runId: createId("run"), now: nowIso() }),
      store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request, requestHash: "same-hash", runId: createId("run"), now: nowIso() })
    ]);
    const successful = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<WorkspaceStore["admitTurn"]>>> => result.status === "fulfilled");
    expect(successful.length).toBe(2);
    expect(new Set(successful.map((result) => result.value.run.id)).size).toBe(1);
    expect((await store.listMessages(session.id)).filter((message) => message.role === "user").length).toBe(1);
    expect((await store.listBackendRuns(session.id)).length).toBe(1);
    await store.close();
  });

  it("C02-H03 held reservation rejects another key without orphan rows", async () => {
    const { store, session, envelope } = await fixture();
    await store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "held", envelope, idempotencyKey: "held-key", metadata: {} }, requestHash: "held-hash", runId: createId("run"), now: nowIso() });
    await expect(store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "other", envelope: { ...envelope, id: createId("envelope") }, idempotencyKey: "other-key", metadata: {} }, requestHash: "other-hash", runId: createId("run"), now: nowIso() })).rejects.toThrow(`session_run_in_progress:`);
    expect((await store.listMessages(session.id)).length).toBe(1);
    expect((await store.listBackendRuns(session.id)).length).toBe(1);
    await store.close();
  });

  it("returns the waiting run ID when the Session is waiting for backend input", async () => {
    const { store, session, envelope } = await fixture();
    const first = await store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "waiting", envelope, idempotencyKey: "waiting-key", metadata: {} }, requestHash: "waiting-hash", runId: createId("run"), now: nowIso() });
    const waiting = { ...first.run, status: "waiting_for_backend_input" as const, phase: "waiting" as const };
    await store.commitCore02RunTransition({ expectedRun: first.run, nextRun: waiting });
    await expect(store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "other", envelope: { ...envelope, id: createId("envelope") }, idempotencyKey: "other-waiting-key", metadata: {} }, requestHash: "other-waiting-hash", runId: createId("run"), now: nowIso() })).rejects.toThrow(`session_waiting_for_backend_input:${first.run.id}`);
    expect(await store.listBackendRuns(session.id)).toHaveLength(1);
    await store.close();
  });

  it("C02-H03 uses SQLite UNIQUE across two independent Store connections", async () => {
    const { firstStore, secondStore, session, envelope } = await twoStoreFixture();
    const request = { sessionId: session.id, content: "same", envelope, idempotencyKey: "shared-key", metadata: {} };
    const results = await Promise.all([
      firstStore.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request, requestHash: "same-hash", runId: createId("run"), now: nowIso() }),
      secondStore.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request, requestHash: "same-hash", runId: createId("run"), now: nowIso() })
    ]);
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect((await firstStore.listMessages(session.id)).filter((message) => message.role === "user")).toHaveLength(1);
    expect(await firstStore.listBackendRuns(session.id)).toHaveLength(1);
    await firstStore.close(); await secondStore.close();
  });

  it("C02-H03 turns same-key hash mismatch into idempotency_conflict without orphans", async () => {
    const { firstStore, secondStore, session, envelope } = await twoStoreFixture();
    const request = { sessionId: session.id, content: "same", envelope, idempotencyKey: "shared-conflict", metadata: {} };
    const results = await Promise.allSettled([
      firstStore.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request, requestHash: "hash-a", runId: createId("run"), now: nowIso() }),
      secondStore.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request, requestHash: "hash-b", runId: createId("run"), now: nowIso() })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ message: "idempotency_conflict" });
    expect(await firstStore.listBackendRuns(session.id)).toHaveLength(1);
    expect((await firstStore.listMessages(session.id)).filter((message) => message.role === "user")).toHaveLength(1);
    expect(reservationCount(firstStore.dbPath, session.id)).toBe(1);
    await firstStore.close(); await secondStore.close();
  });

  it("C02-H03 accepts one of two different keys and leaves no loser rows", async () => {
    const { firstStore, secondStore, session, envelope } = await twoStoreFixture();
    const results = await Promise.allSettled([
      firstStore.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "one", envelope, idempotencyKey: "key-a", metadata: {} }, requestHash: "hash-a", runId: createId("run"), now: nowIso() }),
      secondStore.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "two", envelope: { ...envelope, id: createId("envelope") }, idempotencyKey: "key-b", metadata: {} }, requestHash: "hash-b", runId: createId("run"), now: nowIso() })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await firstStore.listBackendRuns(session.id)).toHaveLength(1);
    expect((await firstStore.listMessages(session.id)).filter((message) => message.role === "user")).toHaveLength(1);
    await firstStore.close(); await secondStore.close();
  });

  it("C02-H03 replays the persisted run after close and reopen", async () => {
    const { firstStore, secondStore, session, envelope } = await twoStoreFixture();
    const request = { sessionId: session.id, content: "persist", envelope, idempotencyKey: "reopen-key", metadata: {} };
    const first = await firstStore.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request, requestHash: "persist-hash", runId: createId("run"), now: nowIso() });
    await firstStore.close(); await secondStore.close();
    const reopened = await WorkspaceStore.create({ rootDir: path.dirname(path.join(firstStore.rootDir, "workspace.sqlite")) });
    const replay = await reopened.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request, requestHash: "persist-hash", runId: createId("run"), now: nowIso() });
    expect(replay.replay).toBe(true);
    expect(replay.run.id).toBe(first.run.id);
    expect(await reopened.listBackendRuns(session.id)).toHaveLength(1);
    await reopened.close();
  });

  it("C02-H03 rolls back every admission row when SQLite rejects the message write", async () => {
    const { store, session, envelope } = await fixture();
    installAdmissionFault(store.dbPath);
    await expect(store.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "fault", envelope, idempotencyKey: "fault-key", metadata: {} }, requestHash: "fault-hash", runId: createId("run"), now: nowIso() })).rejects.toThrow("core02_admission_fault");
    expect(await store.listBackendRuns(session.id)).toHaveLength(0);
    expect((await store.listMessages(session.id)).filter((message) => message.role === "user")).toHaveLength(0);
    expect(reservationCount(store.dbPath, session.id)).toBe(0);
    await store.close();
  });
});

async function settleCompleted(store: WorkspaceStore, run: Awaited<ReturnType<WorkspaceStore["admitTurn"]>>["run"]): Promise<void> {
  const reservation = await store.getSessionRunReservation({ runId: run.id });
  if (!reservation) throw new Error("reservation_missing");
  const now = nowIso();
  const running = { ...run, status: "running" as const, phase: "external_running" as const };
  await store.commitCore02RunTransition({ expectedRun: run, nextRun: running });
  const decision = new RunLifecycle(() => now).decide(running, {
    type: "completed",
    evidence: { kind: "completed", source: "canonical_event" }
  });
  const event: BackendEventRecord = {
    id: `terminal-event:${run.id}`,
    run_id: run.id,
    session_id: run.session_id,
    event_type: "run_completed",
    sequence: 1,
    attempt_no: run.current_attempt ?? 1,
    source_event_id: `terminal:${run.id}`,
    payload: { terminal_evidence: { kind: "completed", source: "canonical_event" } },
    resource_refs: [],
    created_at: now
  };
  await store.commitTurnSettlement({
    expectedRun: running,
    nextRun: { ...running, status: "completed", phase: "settled", completed_at: now },
    terminalEvent: event,
    outputSourceId: `message:${run.id}:output`,
    decision,
    attemptNo: event.attempt_no ?? 1,
    sourceIdentity: { sourceEventId: event.source_event_id },
    terminalEvidence: { kind: "completed", source: "canonical_event" },
    diagnostic: { code: "completed_without_output", message: "Completed without an output message in the admission fixture." },
    reservation
  });
}
