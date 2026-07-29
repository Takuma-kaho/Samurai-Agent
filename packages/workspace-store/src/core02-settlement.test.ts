import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createId, nowIso, type BackendEventRecord, type BackendRunRecord, type JsonValue, type MessageEnvelope, type MessageRecord, type SessionRecord } from "@samurai-agent/core-schemas";
import { RunLifecycle } from "../../runtime/src/execution/run-lifecycle";
import { lifecycleEventForTerminalEvidence } from "../../runtime/src/execution/run-state-machine";
import { WorkspaceStore } from "./workspace-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core02-settle-")); roots.push(root);
  const firstStore = await WorkspaceStore.create({ rootDir: root });
  const secondStore = await WorkspaceStore.create({ rootDir: root });
  const now = nowIso();
  const session: SessionRecord = { id: createId("session"), session_key: "web:owner:core02-settle", title: "Core 02", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
  await firstStore.createSession(session);
  const envelope: MessageEnvelope = { id: createId("envelope"), source: "web", actor_identity: "owner", session_key: session.session_key, user_intent: "chat", attachments: [], input_locale: "ja", output_locale: "ja", metadata: {}, received_at: now };
  const admitted = await firstStore.admitTurn({ session, binding: { id: "mock", kind: "mock" }, request: { sessionId: session.id, content: "settle", envelope, idempotencyKey: createId("settle-key"), metadata: {} }, requestHash: "settle-hash", runId: createId("run"), now });
  const running = { ...admitted.run, status: "running" as const, phase: "external_running" as const };
  await firstStore.commitCore02RunTransition({ expectedRun: admitted.run, nextRun: running });
  return { root, firstStore, secondStore, session, run: running };
}

function output(session: SessionRecord, id = createId("output"), content = "done"): MessageRecord {
  return { id, session_id: session.id, role: "agent", content, input_locale: "ja", output_locale: "ja", created_at: nowIso() };
}

function terminalEvent(runId: string, sessionId: string, id = createId("event"), payload: Record<string, JsonValue> = { message: "password=secret" }): BackendEventRecord {
  return { id, run_id: runId, session_id: sessionId, event_type: "run_completed", sequence: 1, attempt_no: 1, payload, resource_refs: [], created_at: nowIso() };
}

function reservationStatus(dbPath: string, runId: string): string | undefined {
  const database = new Database(dbPath);
  try {
    return (database.prepare("SELECT status FROM session_run_reservations WHERE run_id = ?").get(runId) as { status?: string } | undefined)?.status;
  } finally {
    database.close();
  }
}

function installSettlementFault(dbPath: string): void {
  const database = new Database(dbPath);
  try {
    database.exec("CREATE TRIGGER core02_settlement_fault BEFORE INSERT ON backend_events BEGIN SELECT RAISE(ABORT, 'core02_settlement_fault'); END");
  } finally {
    database.close();
  }
}

describe("Core 02 settlement transaction", () => {
  it("C02-H12 settles concurrently across two SQLite connections exactly once", async () => {
    const { firstStore, secondStore, session, run } = await fixture();
    const sharedOutput = output(session, "output-1");
    const sharedEvent = terminalEvent(run.id, session.id, "event-1");
    const result = await Promise.all([
      settle(firstStore, { run, status: "completed", output: sharedOutput, events: [sharedEvent] }),
      settle(secondStore, { run, status: "completed", output: sharedOutput, events: [sharedEvent] })
    ]);
    expect(result.map((entry) => entry.id)).toEqual([run.id, run.id]);
    expect(result.every((entry) => entry.status === "completed")).toBe(true);
    expect(await firstStore.listBackendEvents({ runId: run.id })).toHaveLength(1);
    expect((await firstStore.listBackendEvents({ runId: run.id }))[0]?.payload).toMatchObject({ message: "password=[redacted]" });
    expect((await firstStore.listMessages(session.id)).filter((message) => message.role === "agent")).toHaveLength(1);
    expect(reservationStatus(firstStore.dbPath, run.id)).toBe("released");
    await firstStore.close(); await secondStore.close();
  });

  it("C02-H12 redacts events and keeps commit-before failure atomic", async () => {
    const { firstStore, secondStore, session, run } = await fixture();
    installSettlementFault(firstStore.dbPath);
    await expect(settle(firstStore, { run, status: "completed", output: output(session, "output-fault"), events: [terminalEvent(run.id, session.id, "event-fault")] })).rejects.toThrow("core02_settlement_fault");
    expect((await firstStore.getBackendRun(run.id))?.status).toBe("running");
    expect(await firstStore.listBackendEvents({ runId: run.id })).toHaveLength(0);
    expect((await firstStore.listMessages(session.id)).filter((message) => message.role === "agent")).toHaveLength(0);
    expect(reservationStatus(firstStore.dbPath, run.id)).toBe("held");
    await firstStore.close(); await secondStore.close();
  });

  it("C02-H13 returns the committed result on identical replay and rejects contradictions", async () => {
    const { root, firstStore, secondStore, session, run } = await fixture();
    const event = terminalEvent(run.id, session.id, "event-replay");
    const message = output(session, "output-replay");
    const settled = await settle(firstStore, { run, status: "completed", output: message, events: [event], now: "2026-01-01T00:00:01.000Z" });
    const replay = await settle(secondStore, { run, status: "completed", output: message, events: [event], now: "2026-01-01T00:00:02.000Z" });
    expect(replay).toEqual(settled);
    await expect(settle(secondStore, { run, status: "failed", output: output(session, "output-different", "different"), events: [event] })).rejects.toThrow("settlement_conflict");
    expect(await firstStore.listBackendEvents({ runId: run.id })).toHaveLength(1);
    expect((await firstStore.listMessages(session.id)).filter((entry) => entry.role === "agent")).toHaveLength(1);
    await firstStore.close(); await secondStore.close();
    const reopened = await WorkspaceStore.create({ rootDir: root });
    const reopenedReplay = await settle(reopened, { run, status: "completed", output: message, events: [event] });
    expect(reopenedReplay.status).toBe("completed");
    expect(await reopened.listBackendEvents({ runId: run.id })).toHaveLength(1);
    expect((await reopened.listMessages(session.id)).filter((entry) => entry.role === "agent")).toHaveLength(1);
    await reopened.close();
  });

  it("C02-H13 preserves outcome_unknown diagnostics and releases without retry rows", async () => {
    const { firstStore, secondStore, session, run } = await fixture();
    const diagnosticRun = { ...run, status: "outcome_unknown" as const, phase: "settled" as const, metadata: { warning: "cancel outcome could not be confirmed", error_code: "outcome_unknown" } };
    const settled = await settle(firstStore, { expectedRun: run, run: diagnosticRun, status: "outcome_unknown", events: [terminalEvent(run.id, session.id, "event-unknown", { message: "cancel outcome could not be confirmed" })] });
    expect(settled.status).toBe("outcome_unknown");
    expect(settled.metadata).toMatchObject({ warning: "cancel outcome could not be confirmed", error_code: "outcome_unknown" });
    expect(reservationStatus(firstStore.dbPath, run.id)).toBe("released");
    expect(await firstStore.listBackendRuns(session.id)).toHaveLength(1);
    await firstStore.close(); await secondStore.close();
  });
});

async function settle(store: WorkspaceStore, input: { expectedRun?: BackendRunRecord; run: BackendRunRecord; status: BackendRunRecord["status"]; output?: MessageRecord; events?: BackendEventRecord[]; now?: string }): Promise<Awaited<ReturnType<WorkspaceStore["commitTurnSettlement"]>>> {
  const expectedRun = input.expectedRun ?? input.run;
  const now = input.now ?? nowIso();
  const event = input.events?.find((candidate) => candidate.event_type === "run_completed" || candidate.event_type === "run_failed") ?? terminalEvent(input.run.id, input.run.session_id);
  const evidence = input.status === "completed"
    ? { kind: "completed", source: "canonical_event" }
    : input.status === "outcome_unknown"
      ? { kind: "indeterminate", reason: "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true }
      : input.status === "cancelled"
        ? { kind: "cancelled", source: "canonical_event" }
        : { kind: "failed", source: "canonical_event", error: { code: input.run.error_code ?? "backend_failed", message: "Backend operation failed.", retryable: false, causeCategory: "runtime" } };
  const terminal: BackendEventRecord = { ...event, event_type: input.status === "completed" ? "run_completed" : "run_failed", attempt_no: event.attempt_no ?? input.run.current_attempt ?? 1, source_event_id: event.source_event_id ?? `terminal:${input.run.id}:${input.status}`, payload: { ...event.payload, terminal_evidence: event.payload.terminal_evidence ?? evidence } };
  const reservation = await store.getSessionRunReservation({ runId: input.run.id });
  if (!reservation) throw new Error("reservation_missing");
  const deterministicOutput = input.output ? { ...input.output, id: `message:${input.run.id}:output` } : undefined;
  const decision = new RunLifecycle(() => now).decide(expectedRun, lifecycleEventForTerminalEvidence(evidence, { failure: input.status === "completed" ? undefined : evidence.kind === "failed" ? evidence.error : { code: input.run.error_code ?? "backend_failed", message: "Backend operation failed.", retryable: false, causeCategory: input.status === "outcome_unknown" ? "runtime" : "runtime" } }));
  const nextRun = { ...input.run, status: input.status, phase: "settled" as const, ...(input.status === "outcome_unknown" ? { completed_at: undefined } : { completed_at: input.run.completed_at ?? now }), ...(deterministicOutput ? { output_message_id: deterministicOutput.id } : {}) };
  return store.commitTurnSettlement({
    expectedRun,
    nextRun,
    terminalEvent: terminal,
    outputSourceId: `message:${input.run.id}:output`,
    ...(deterministicOutput ? { output: deterministicOutput } : {}),
    decision,
    attemptNo: terminal.attempt_no ?? 1,
    sourceIdentity: {
      ...(terminal.source_event_id ? { sourceEventId: terminal.source_event_id } : {}),
      ...(terminal.source_sequence !== undefined ? { sourceSequence: terminal.source_sequence } : {})
    },
    terminalEvidence: evidence,
    ...(!deterministicOutput ? { diagnostic: { code: input.status, message: `Test settlement: ${input.status}.` } } : {}),
    reservation
  });
}
