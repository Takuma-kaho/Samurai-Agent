import { describe, expect, it, vi } from "vitest";
import type { AgentBackend, BackendOutputEvent } from "@samurai-agent/agent-backends";
import type { BackendEventRecord, BackendRunRecord } from "@samurai-agent/core-schemas";
import { BackendEventJournal } from "./backend-event-journal";
import { RunControl, type RunControlOptions, type RunControlSettlementInput } from "./run-control";
import { TurnExecutor } from "./turn-executor";

describe("RunControl", () => {
  it("maps settled not_started to cancelled only for a cancel request", async () => {
    const store = new ControlStore(run("running", "backend_starting"));
    const backend = backendWith({ cancelRun: async () => ({ kind: "settled", evidence: { kind: "not_started", source: "preflight_rejection" } }) });
    const control = controlFor(store, backend);

    const result = await control.cancel("run-1");

    expect(result.status).toBe("cancelled");
  });

  it("uses the phase before cancelling to prove unsupported work never started", async () => {
    const store = new ControlStore(run("running", "backend_starting"));
    const backend = backendWith({ cancelRun: async () => ({ kind: "unsupported" }) });
    const control = controlFor(store, backend);

    const result = await control.cancel("run-1");

    expect(result.status).toBe("cancelled");
    expect(result.error_code).toBeUndefined();
  });

  it("records only resume input presence and rejects native resume without a Session ID", async () => {
    const store = new ControlStore(run("waiting_for_backend_input", "waiting"));
    const backend = backendWith({
      resumeRun: () => eventsOf({
        event_type: "run_failed",
        terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
        payload: { error_code: "backend_native_session_missing", message: "Native session is missing." }
      })
    });
    const control = controlFor(store, backend);

    const result = await control.resume("run-1", { token: "must-not-persist" });

    expect(result).toMatchObject({
      status: "failed",
      error_code: "backend_native_session_missing",
      metadata: { error_message: "Backend cannot resume because its native Session ID is missing." }
    });
    expect(JSON.stringify(result.metadata)).not.toContain("must-not-persist");
    expect(result.metadata).not.toHaveProperty("resume_input");
  });

  it("uses the same typed evidence path for stream sync", async () => {
    const store = new ControlStore(run("running", "external_running"));
    const backend = backendWith({
      streamEvents: () => eventsOf({
        event_type: "run_failed",
        terminal_evidence: { kind: "failed", source: "provider_terminal_response", error: { code: "provider_denied", message: "Provider denied the request.", retryable: false, causeCategory: "provider" } },
        payload: { error_code: "different_raw_code", message: "different raw message" },
        source_event_id: "terminal-1"
      })
    });
    const control = controlFor(store, backend);

    const result = await control.sync("run-1");

    expect(result).toMatchObject({ status: "failed", error_code: "provider_denied", metadata: { error_message: "Provider denied the request." } });
    expect(store.events).toHaveLength(1);
  });

  it("keeps a resume terminal outcome when iterator cleanup throws after journal commit", async () => {
    const store = new ControlStore({ ...run("waiting_for_backend_input", "waiting"), backend_session_id: "native-session-1" });
    const backend = backendWith({
      resumeRun: () => terminalThenThrow({
        event_type: "run_completed",
        terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
        payload: { output_summary: "done" },
        source_event_id: "resume-terminal-before-cleanup-error"
      }, new Error("resume iterator cleanup failed"))
    });
    const control = controlFor(store, backend);

    const result = await control.resume("run-1", { answer: "ok" });

    expect(result.status).toBe("completed");
    expect(result.metadata).not.toHaveProperty("warning");
    expect(store.events).toHaveLength(3);
  });

  it("keeps a synced terminal outcome when iterator cleanup throws after journal commit", async () => {
    const store = new ControlStore(run("running", "external_running"));
    const backend = backendWith({
      streamEvents: () => terminalThenThrow({
        event_type: "run_completed",
        terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
        payload: { output_summary: "done" },
        source_event_id: "sync-terminal-before-cleanup-error"
      }, new Error("sync iterator cleanup failed"))
    });
    const control = controlFor(store, backend);

    const result = await control.sync("run-1");

    expect(result.status).toBe("completed");
    expect(result.metadata).not.toHaveProperty("warning");
    expect(store.events).toHaveLength(1);
  });

  it("settles an unconfirmed cancel with a fake clock and no completed_at", async () => {
    let now = 0;
    const store = new ControlStore(run("running", "external_running"));
    const backend = backendWith({ cancelRun: async () => ({ kind: "requested" }) });
    const control = controlFor(store, backend, controlOptions({
      settleTimeoutMs: 50,
      nowMs: () => now,
      sleep: async (ms) => { now += ms; }
    }));

    const result = await control.cancel("run-1");

    expect(result.status).toBe("outcome_unknown");
    expect(result.completed_at).toBeUndefined();
    expect(result.metadata).toMatchObject({ warning: "cancel_outcome_unknown", may_have_external_side_effects: true });
  });

  it("keeps waiting when evidence polling only repeats requested", async () => {
    let now = 0;
    let probes = 0;
    const store = new ControlStore(run("running", "external_running"));
    const backend = backendWith({ cancelRun: async () => ({ kind: "requested" }) });
    const control = controlFor(store, backend, controlOptions({
      settleTimeoutMs: 50,
      nowMs: () => now,
      sleep: async (ms) => { now += ms; },
      waitForEvidence: async () => { probes += 1; return { kind: "requested" }; }
    }));

    const result = await control.cancel("run-1");

    expect(probes).toBeGreaterThan(1);
    expect(now).toBe(50);
    expect(result.status).toBe("outcome_unknown");
  });

  it.each(["cancelRun", "waitForEvidence"] as const)("settles by the deadline when %s never resolves", async (stalledStep) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const late = deferred<Awaited<ReturnType<NonNullable<AgentBackend["cancelRun"]>>>>();
      let blockedCalls = 0;
      const store = new ControlStore(run("running", "external_running"));
      const backend = backendWith({
        cancelRun: stalledStep === "cancelRun"
          ? () => { blockedCalls += 1; return late.promise; }
          : async () => ({ kind: "requested" })
      });
      const control = controlFor(store, backend, controlOptions({
        settleTimeoutMs: 50,
        ...(stalledStep === "waitForEvidence"
          ? { waitForEvidence: () => { blockedCalls += 1; return late.promise; } }
          : {})
      }));

      const pending = control.cancel("run-1");
      for (let index = 0; index < 20 && blockedCalls === 0; index += 1) await Promise.resolve();
      expect(blockedCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;

      expect(result).toMatchObject({
        status: "outcome_unknown",
        error_code: "outcome_unknown",
        metadata: { failure_code: "backend_cancel_unconfirmed", warning: "cancel_outcome_unknown" }
      });
      expect(result.completed_at).toBeUndefined();

      late.resolve({ kind: "settled", evidence: { kind: "completed", source: "provider_terminal_response" } });
      await Promise.resolve();
      expect(store.current.status).toBe("outcome_unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a confirmed natural completion while cancelRun is still unresolved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const late = deferred<Awaited<ReturnType<NonNullable<AgentBackend["cancelRun"]>>>>();
      let cancelCalls = 0;
      const store = new ControlStore(run("running", "external_running"));
      const backend = backendWith({ cancelRun: () => { cancelCalls += 1; return late.promise; } });
    const control = controlFor(store, backend, controlOptions({ settleTimeoutMs: 50 }));

      const pending = control.cancel("run-1");
      for (let index = 0; index < 20 && cancelCalls === 0; index += 1) await Promise.resolve();
      expect(cancelCalls).toBe(1);
      store.current = { ...store.current, status: "completed", phase: "settled", completed_at: fixedClock() };
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toBe(store.current);
      expect(store.current.status).toBe("completed");
      expect(store.current.error_code).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps a normally ended stream without terminal evidence to outcome_unknown", async () => {
    const store = new ControlStore(run("running", "external_running"));
    const backend = backendWith({ streamEvents: () => eventsOf({ event_type: "text_delta", payload: { text: "partial" } }) });
    const control = controlFor(store, backend);

    const result = await control.sync("run-1");

    expect(result).toMatchObject({
      status: "outcome_unknown",
      error_code: "outcome_unknown",
      metadata: { failure_code: "backend_runtime_state_unavailable", warning: "stream_terminal_missing" }
    });
    expect(result.completed_at).toBeUndefined();
  });

  it("does not reopen or call the backend when outcome is already unknown", async () => {
    let cancelCalls = 0;
    const existing = run("outcome_unknown", "settled");
    const store = new ControlStore(existing);
    const backend = backendWith({ cancelRun: async () => { cancelCalls += 1; return { kind: "requested" }; } });
    const control = controlFor(store, backend);

    const result = await control.cancel("run-1");

    expect(result).toBe(existing);
    expect(cancelCalls).toBe(0);
    expect(result.phase).toBe("settled");
  });

  it("sanitizes a thrown cancel error before persisting failure metadata", async () => {
    const store = new ControlStore(run("running", "external_running"));
    const backend = backendWith({ cancelRun: async () => { throw new Error("Bearer cancel-secret failed at /Users/person/private/run"); } });
    const control = controlFor(store, backend);

    const result = await control.cancel("run-1");
    const metadata = JSON.stringify(result.metadata);

    expect(result.status).toBe("outcome_unknown");
    expect(result.metadata).toMatchObject({ failure_code: "backend_cancel_failed", failure_cause_category: "cancellation" });
    expect(metadata).toContain("[redacted]");
    expect(metadata).toContain("[path]");
    expect(metadata).not.toContain("cancel-secret");
    expect(metadata).not.toContain("/Users/person");
    expect(result.metadata).not.toHaveProperty("cancel_error_message");
  });
});

class ControlStore {
  readonly events: BackendEventRecord[] = [];
  constructor(public current: BackendRunRecord) {}
  async getBackendRun(runId: string): Promise<BackendRunRecord | undefined> { return this.current.id === runId ? this.current : undefined; }
  async commitCore02RunTransition(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> { this.current = input.nextRun; return input.nextRun; }
  async commitCore02BackendSession(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> { this.current = input.nextRun; return input.nextRun; }
  async commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }> {
    const duplicate = this.events.find((event) => event.run_id === input.event.run_id && event.source_event_id === input.event.source_event_id);
    if (duplicate) return { run: this.current, event: duplicate, duplicate: true };
    this.events.push(input.event);
    this.current = input.nextRun;
    return { run: input.nextRun, event: input.event, duplicate: false };
  }
  async commitTurnSettlement(input: RunControlSettlementInput): Promise<BackendRunRecord> {
    const existing = this.events.find((event) => event.run_id === input.terminalEvent.run_id && event.source_event_id === input.terminalEvent.source_event_id);
    if (!existing) this.events.push(input.terminalEvent);
    this.current = { ...input.nextRun, phase: "settled" };
    return this.current;
  }
  async getSessionRunReservation(input: { runId: string }): Promise<{ sessionId: string; runId: string; version: number; status: "held" | "released" } | undefined> {
    return input.runId === this.current.id ? { sessionId: this.current.session_id, runId: input.runId, version: 1, status: "held" } : undefined;
  }
  async getSession(sessionId: string) {
    return sessionId === this.current.session_id
      ? { id: sessionId, session_key: sessionId, title: "Session", ui_locale: "ja" as const, output_locale: "ja" as const, created_at: this.current.started_at, updated_at: this.current.started_at }
      : undefined;
  }
  async listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]> { return this.events.filter((event) => event.run_id === input.runId); }
  async appendCore02Event(event: BackendEventRecord): Promise<{ event: BackendEventRecord; duplicate: boolean }> {
    const duplicate = this.events.find((candidate) => candidate.run_id === event.run_id && candidate.source_event_id === event.source_event_id);
    if (duplicate) return { event: duplicate, duplicate: true };
    this.events.push(event);
    return { event, duplicate: false };
  }
}

function controlOptions(overrides: Partial<RunControlOptions> = {}): RunControlOptions {
  return {
    cleanup: { cleanup: async () => undefined },
    diagnostics: { record: async () => undefined, logPersistenceFailure: () => undefined },
    committedEventPublisher: { publish: async () => undefined },
    toolExecution: { execute: async () => undefined },
    clock: fixedClock,
    ...overrides
  };
}

function controlFor(store: ControlStore, backend: AgentBackend, options = controlOptions()): RunControl {
  const journal = new BackendEventJournal(store, fixedClock);
  const executor = new TurnExecutor(store, journal, {
    committedEventPublisher: options.committedEventPublisher,
    toolExecution: options.toolExecution,
    cleanup: options.cleanup,
    diagnostics: options.diagnostics,
    lifecycle: options.lifecycle
  });
  return new RunControl(store, () => backend, options, journal, executor);
}

function backendWith(overrides: Partial<AgentBackend>): AgentBackend {
  const sessionPolicy = overrides.sessionPolicy ?? {
    acquisition: "provider_event" as const,
    resume: typeof overrides.resumeRun === "function" ? "native" as const : "unsupported" as const
  };
  return {
    id: "backend",
    kind: "external",
    label: "Backend",
    sessionPolicy,
    execution_owner: "tool_bridge",
    runTurn: () => eventsOf(),
    ...overrides
  };
}

async function* eventsOf(...events: BackendOutputEvent[]): AsyncIterable<BackendOutputEvent> {
  for (const event of events) yield event;
}

async function* terminalThenThrow(event: BackendOutputEvent, error: Error): AsyncIterable<BackendOutputEvent> {
  try {
    yield event;
  } finally {
    throw error;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function run(status: BackendRunRecord["status"], phase: NonNullable<BackendRunRecord["phase"]>): BackendRunRecord {
  return {
    id: "run-1",
    session_id: "session-1",
    input_message_id: "message-1",
    backend_id: "backend",
    backend_kind: "external",
    status,
    phase,
    current_attempt: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    input_summary: "test",
    metadata: {}
  };
}

function fixedClock(): string {
  return "2026-01-01T00:00:01.000Z";
}
