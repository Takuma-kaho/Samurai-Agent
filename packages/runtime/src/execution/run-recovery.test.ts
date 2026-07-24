import { describe, expect, it } from "vitest";
import type { BackendOutputEvent } from "@samurai-agent/agent-backends";
import type { BackendEventRecord, BackendRunRecord } from "@samurai-agent/core-schemas";
import { BackendEventJournal } from "./backend-event-journal";
import { RunRecovery, type RecoveryBackend, type RecoverySettlementInput } from "./run-recovery";

describe("RunRecovery", () => {
  it("uses stored typed evidence instead of a raw terminal event name", async () => {
    const typedStore = new RecoveryTestStore([runningRun()], [journalEvent({
      error_code: "provider_denied",
      message: "Provider denied the request.",
      terminal_evidence: {
        kind: "failed",
        source: "provider_terminal_response",
        error: { code: "provider_denied", message: "Provider denied the request." }
      }
    })]);
    const rawNameStore = new RecoveryTestStore([runningRun()], [journalEvent({ error_code: "raw_only" })]);

    const [typed] = await makeRecovery(typedStore, () => undefined).reconcile();
    const [rawOnly] = await makeRecovery(rawNameStore, () => undefined).reconcile();

    expect(typed).toMatchObject({ status: "failed", error_code: "provider_denied", metadata: { error_message: "Provider denied the request." } });
    expect(rawOnly).toMatchObject({ status: "outcome_unknown", error_code: "outcome_unknown" });
    expect(rawOnly?.completed_at).toBeUndefined();
  });

  it("uses the shared normalizer and journal for recovered streams", async () => {
    const store = new RecoveryTestStore([runningRun()], []);
    const backend = {
      id: "backend",
      streamEvents: () => eventsOf({
        event_type: "run_failed" as const,
        terminal_evidence: { kind: "not_started" as const, source: "preflight_rejection" as const },
        payload: { error_code: "backend_not_ready", message: "Backend was not ready." },
        source_event_id: "recovery-terminal-1"
      })
    };
    const recovery = makeRecovery(store, () => backend);

    const [recovered] = await recovery.reconcile();

    expect(recovered).toMatchObject({ status: "failed", error_code: "backend_not_ready", metadata: { error_message: "Backend was not ready." } });
    expect(store.events.filter((event) => event.source_event_id === "recovery-terminal-1")).toHaveLength(1);
  });

  it("keeps a token-backed waiting run without issuing an empty resume", async () => {
    const waiting = { ...runningRun(), status: "waiting_for_backend_input", phase: "waiting", backend_session_id: "native-session-1" } as BackendRunRecord;
    const store = new RecoveryTestStore([waiting], []);
    let resumeCalls = 0;
    const backend = {
      id: "backend",
      resumeRun: () => {
        resumeCalls += 1;
        return eventsOf();
      }
    };

    const [recovered] = await makeRecovery(store, () => backend).reconcile();

    expect(resumeCalls).toBe(0);
    expect(recovered).toEqual(waiting);
  });

  it("syncs a waiting run when stream capability exists without issuing resume", async () => {
    const waiting = { ...runningRun(), status: "waiting_for_backend_input", phase: "waiting", backend_session_id: "native-session-1" } as BackendRunRecord;
    const store = new RecoveryTestStore([waiting], []);
    let resumeCalls = 0;
    const backend = {
      id: "backend",
      resumeRun: () => {
        resumeCalls += 1;
        return eventsOf();
      },
      streamEvents: () => eventsOf(
        { event_type: "run_started", payload: {}, source_event_id: "recovery-resync-start" },
        { event_type: "backend_waiting_for_native_input", payload: { prompt: "Choose", waiting_execution: "live" }, source_event_id: "recovery-resync-waiting" }
      )
    };

    const [recovered] = await makeRecovery(store, () => backend).reconcile();

    expect(resumeCalls).toBe(0);
    expect(recovered).toMatchObject({ status: "waiting_for_backend_input", phase: "waiting" });
    expect(store.events.filter((event) => event.source_event_id === "recovery-resync-waiting")).toHaveLength(1);
  });

  it("does not keep waiting when recovery stream ends without terminal or resume evidence", async () => {
    const waiting = { ...runningRun(), status: "waiting_for_backend_input", phase: "waiting", backend_session_id: undefined } as BackendRunRecord;
    const store = new RecoveryTestStore([waiting], []);
    const backend = { id: "backend", streamEvents: () => eventsOf({ event_type: "text_delta", payload: { text: "partial" } }) };

    const [recovered] = await makeRecovery(store, () => backend).reconcile();

    expect(recovered).toMatchObject({
      status: "outcome_unknown",
      error_code: "outcome_unknown",
      metadata: { failure_code: "backend_runtime_state_unavailable", failure_phase: "waiting" }
    });
    expect(recovered?.completed_at).toBeUndefined();
  });

  it("preserves a sanitized recovery transport failure instead of swallowing it", async () => {
    const store = new RecoveryTestStore([runningRun()], []);
    const backend = {
      id: "backend",
      streamEvents: () => throwingEvents(new Error("Bearer recovery-secret failed at /Users/person/private/socket"))
    };

    const [recovered] = await makeRecovery(store, () => backend).reconcile();
    const metadata = JSON.stringify(recovered?.metadata);

    expect(recovered).toMatchObject({
      status: "outcome_unknown",
      error_code: "outcome_unknown",
      metadata: { failure_code: "backend_transport_lost", failure_cause_category: "transport", failure_phase: "external_running" }
    });
    expect(metadata).toContain("[redacted]");
    expect(metadata).toContain("[path]");
    expect(metadata).not.toContain("recovery-secret");
    expect(metadata).not.toContain("/Users/person");
  });

  it("normalizes synchronous stream creation failure and continues reconciling later runs", async () => {
    const first = runningRun("run-1");
    const second = runningRun("run-2");
    const store = new RecoveryTestStore([first, second], []);
    const backend = {
      id: "backend",
      streamEvents: (runId: string) => {
        if (runId === "run-1") throw new Error("Bearer recovery-secret failed at /Users/person/private/socket");
        return eventsOf({
          event_type: "run_completed",
          terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
          payload: { output_summary: "second run completed" },
          source_event_id: "recovery-run-2-terminal"
        });
      }
    };

    const recovered = await makeRecovery(store, () => backend).reconcile();

    expect(recovered[0]).toMatchObject({
      id: "run-1",
      status: "outcome_unknown",
      metadata: { failure_code: "backend_transport_lost", failure_cause_category: "transport" }
    });
    expect(JSON.stringify(recovered[0]?.metadata)).not.toContain("recovery-secret");
    expect(recovered[1]).toMatchObject({ id: "run-2", status: "completed" });
    expect(store.events.filter((event) => event.run_id === "run-2" && event.source_event_id === "recovery-run-2-terminal")).toHaveLength(1);
  });

  it("keeps repeated indeterminate evidence unchanged, accepts later confirmation, and continues", async () => {
    const existingUnknown = { ...runningRun("run-1"), status: "outcome_unknown", phase: "settled", error_code: "outcome_unknown", metadata: { failure_code: "existing_failure" } } as BackendRunRecord;
    const correctableUnknown = { ...runningRun("run-2"), status: "outcome_unknown", phase: "settled", error_code: "outcome_unknown", metadata: { failure_code: "old_failure" } } as BackendRunRecord;
    const queued = queuedRun("run-3");
    const events: BackendEventRecord[] = [
      { ...journalEvent({ terminal_evidence: { kind: "indeterminate", reason: "transport_lost", providerStarted: true, mayHaveSideEffects: true } }), run_id: "run-1" },
      { ...journalEvent({ terminal_evidence: { kind: "completed", source: "provider_terminal_response" } }), id: "event-2", run_id: "run-2", session_id: "session-run-2", event_type: "run_completed" }
    ];
    const store = new RecoveryTestStore([existingUnknown, correctableUnknown, queued], events);
    const enqueued: string[] = [];

    const recovered = await makeRecovery(store, () => undefined, { enqueue: async (run) => { enqueued.push(run.id); } }).reconcile();

    expect(recovered[0]).toEqual(existingUnknown);
    expect(recovered[1]).toMatchObject({ id: "run-2", status: "completed", phase: "settled" });
    expect(recovered[2]).toEqual(queued);
    expect(enqueued).toEqual(["run-3"]);
  });

  it("ignores stored indeterminate evidence and accepts a confirmed terminal from the recovery stream", async () => {
    const existingUnknown = { ...runningRun("run-1"), status: "outcome_unknown", phase: "settled", error_code: "outcome_unknown", metadata: { failure_code: "existing_failure" } } as BackendRunRecord;
    const store = new RecoveryTestStore([existingUnknown], [journalEvent({
      terminal_evidence: { kind: "indeterminate", reason: "transport_lost", providerStarted: true, mayHaveSideEffects: true }
    })]);
    const backend = {
      id: "backend",
      streamEvents: () => eventsOf({
        event_type: "run_completed",
        terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
        payload: { output_summary: "confirmed after recovery" },
        source_event_id: "late-recovery-confirmation"
      })
    };

    const [recovered] = await makeRecovery(store, () => backend).reconcile();

    expect(recovered).toMatchObject({ status: "completed", phase: "settled" });
    expect(store.events.filter((event) => event.source_event_id === "late-recovery-confirmation")).toHaveLength(1);
  });

  it("keeps a failed enqueue queued and continues with later queued runs", async () => {
    const first = queuedRun("run-1");
    const second = queuedRun("run-2");
    const store = new RecoveryTestStore([first, second], []);
    const attempted: string[] = [];

    const recovery = makeRecovery(store, () => undefined, { enqueue: async (run) => {
      attempted.push(run.id);
      if (run.id === "run-1") throw new Error("Bearer queue-secret unavailable at /Users/person/private/queue");
    } });
    const recovered = await recovery.reconcile();
    const report = recovery.getLastReport();

    expect(attempted).toEqual(["run-1", "run-2"]);
    expect(recovered).toEqual([first, second]);
    expect(store.runs).toEqual([first, second]);
    expect(report.diagnostics).toEqual([expect.objectContaining({
      run_id: "run-1",
      code: "recovery_enqueue_failed",
      phase: "admitted",
      retryable: false,
      cause_category: "runtime"
    })]);
    expect(report.diagnostics[0]?.message).toContain("[redacted]");
    expect(report.diagnostics[0]?.message).toContain("[path]");
    expect(JSON.stringify(report)).not.toContain("queue-secret");
    expect(JSON.stringify(report)).not.toContain("/Users/person");
  });

  it("does not reopen an existing outcome_unknown without new terminal evidence", async () => {
    const unknown = { ...runningRun(), status: "outcome_unknown", phase: "settled", error_code: "outcome_unknown", metadata: { failure_code: "existing_failure" } } as BackendRunRecord;
    const store = new RecoveryTestStore([unknown], []);

    const [recovered] = await makeRecovery(store, () => undefined).reconcile();

    expect(recovered).toEqual(unknown);
  });
});

class RecoveryTestStore {
  constructor(public runs: BackendRunRecord[], public events: BackendEventRecord[]) {}
  async listCore02RecoveryCandidates(): Promise<BackendRunRecord[]> { return this.runs.slice(); }
  async listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]> { return this.events.filter((event) => event.run_id === input.runId); }
  async getBackendRun(runId: string): Promise<BackendRunRecord | undefined> { return this.runs.find((run) => run.id === runId); }
  async commitCore02RunTransition(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> { return this.replace(input.nextRun); }
  async commitCore02BackendSession(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> { return this.replace(input.nextRun); }
  async commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }> {
    const duplicate = this.events.find((event) => event.run_id === input.event.run_id && event.source_event_id === input.event.source_event_id);
    if (duplicate) return { run: this.getBackendRun(input.expectedRun.id) ?? input.expectedRun, event: duplicate, duplicate: true };
    this.events.push(input.event);
    return { run: this.replace(input.nextRun), event: input.event, duplicate: false };
  }
  async appendCore02Event(event: BackendEventRecord): Promise<{ event: BackendEventRecord; duplicate: boolean }> {
    const duplicate = this.events.find((candidate) => candidate.run_id === event.run_id && candidate.source_event_id === event.source_event_id);
    if (duplicate) return { event: duplicate, duplicate: true };
    this.events.push(event);
    return { event, duplicate: false };
  }
  async commitTurnSettlement(input: RecoverySettlementInput): Promise<BackendRunRecord> {
    const existing = this.events.find((event) => event.run_id === input.terminalEvent.run_id && event.source_event_id === input.terminalEvent.source_event_id);
    if (!existing) this.events.push(input.terminalEvent);
    return this.replace({ ...input.nextRun, phase: "settled" });
  }
  async getSessionRunReservation(input: { runId: string }): Promise<{ sessionId: string; runId: string; version: number; status: "held" | "released" } | undefined> {
    const run = this.runs.find((item) => item.id === input.runId);
    return run ? { sessionId: run.session_id, runId: run.id, version: 1, status: "held" } : undefined;
  }
  async getSession(sessionId: string) {
    const run = this.runs.find((item) => item.session_id === sessionId);
    return run ? { id: sessionId, session_key: sessionId, title: "Session", ui_locale: "ja" as const, output_locale: "ja" as const, created_at: run.started_at, updated_at: run.started_at } : undefined;
  }
  private replace(run: BackendRunRecord): BackendRunRecord {
    this.runs = this.runs.map((item) => item.id === run.id ? run : item);
    return run;
  }
}

function makeRecovery(
  store: RecoveryTestStore,
  backendFor: (id: string) => RecoveryBackend | undefined,
  options: { enqueue?: (run: BackendRunRecord) => Promise<void> } = {}
): RunRecovery {
  return new RunRecovery(
    store,
    backendFor,
    fixedClock,
    new BackendEventJournal(store, fixedClock),
    { publish: async () => undefined },
    { cleanup: async () => undefined },
    options.enqueue ?? (async () => undefined),
    { record: async () => undefined, logPersistenceFailure: () => undefined }
  );
}

function runningRun(id = "run-1"): BackendRunRecord {
  const identity = id === "run-1" ? "1" : id;
  return {
    id,
    session_id: `session-${identity}`,
    input_message_id: `message-${identity}`,
    backend_id: "backend",
    backend_kind: "external",
    status: "running",
    phase: "external_running",
    current_attempt: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    input_summary: "test",
    metadata: {}
  };
}

function queuedRun(id: string): BackendRunRecord {
  const { started_at: _startedAt, ...base } = runningRun(id);
  return { ...base, status: "queued", phase: "admitted" };
}

function journalEvent(payload: BackendEventRecord["payload"]): BackendEventRecord {
  return {
    id: "event-1",
    run_id: "run-1",
    session_id: "session-1",
    event_type: "run_failed",
    sequence: 1,
    attempt_no: 1,
    payload,
    resource_refs: [],
    created_at: "2026-01-01T00:00:00.500Z"
  };
}

async function* eventsOf(...events: BackendOutputEvent[]): AsyncIterable<BackendOutputEvent> {
  for (const event of events) yield event;
}

async function* throwingEvents(error: Error): AsyncIterable<BackendOutputEvent> {
  throw error;
}

function fixedClock(): string {
  return "2026-01-01T00:00:01.000Z";
}
