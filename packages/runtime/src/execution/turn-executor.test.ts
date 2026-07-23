import { describe, expect, it } from "vitest";
import type { AgentBackend, BackendOutputEvent, BackendTerminalEvidence } from "@samurai-agent/agent-backends";
import type { BackendEventRecord, BackendRunRecord } from "@samurai-agent/core-schemas";
import { BackendEventJournal, InMemoryBackendEventJournalStore } from "./backend-event-journal";
import { TurnExecutor, consumeBackendEvents } from "./turn-executor";
import type { PreparedTurn } from "../host/host-types";

describe("consumeBackendEvents", () => {
  it.each([
    ["completed", { kind: "completed", source: "provider_terminal_response" }, "completed"],
    ["failed", { kind: "failed", source: "provider_terminal_response", error: { code: "provider_denied", message: "Provider denied the request.", retryable: false, causeCategory: "provider" } }, "failed"],
    ["cancelled", { kind: "cancelled", source: "process_exit" }, "cancelled"],
    ["not_started", { kind: "not_started", source: "preflight_rejection" }, "failed"],
    ["indeterminate", { kind: "indeterminate", reason: "transport_lost", providerStarted: true, mayHaveSideEffects: true }, "outcome_unknown"]
  ] as const)("uses typed %s evidence", async (_name, evidence, expectedStatus) => {
    const store = new InMemoryBackendEventJournalStore();
    const event: BackendOutputEvent = {
      event_type: evidence.kind === "completed" ? "run_completed" : "run_failed",
      terminal_evidence: evidence as BackendTerminalEvidence,
      payload: evidence.kind === "not_started"
        ? { error_code: "provider_not_configured", message: "No provider is configured." }
        : {}
    };

    const result = await consumeBackendEvents({
      run: runningRun(),
      sessionId: "session-1",
      stream: eventsOf(event),
      journal: new BackendEventJournal(store, () => "2026-01-01T00:00:01.000Z")
    });

    expect(result.run.status).toBe(expectedStatus);
    expect(result.terminal).toBe(true);
    expect(store.events).toHaveLength(0);
    expect(result.terminalSettlement?.terminalEvent.payload.terminal_evidence).toEqual(evidence);
    if (evidence.kind === "failed") {
      expect(result.run).toMatchObject({ error_code: evidence.error.code, metadata: { error_message: evidence.error.message } });
    }
    if (evidence.kind === "not_started") {
      expect(result.run).toMatchObject({ error_code: "provider_not_configured", metadata: { error_message: "No provider is configured." } });
    }
  });

  it("does not treat iterator completion as terminal evidence", async () => {
    const result = await consumeBackendEvents({
      run: runningRun(),
      sessionId: "session-1",
      stream: eventsOf({ event_type: "text_delta", payload: { text: "partial" } }),
      journal: new BackendEventJournal(new InMemoryBackendEventJournalStore())
    });

    expect(result.run.status).toBe("running");
    expect(result.terminal).toBe(false);
  });

  it("deduplicates replayed text in both the journal and returned response", async () => {
    const store = new InMemoryBackendEventJournalStore();
    const journal = new BackendEventJournal(store);
    const textEvent: BackendOutputEvent = { event_type: "text_delta", source_event_id: "provider-text-1", payload: { text: "same" } };

    const first = await consumeBackendEvents({ run: runningRun(), sessionId: "session-1", stream: eventsOf(textEvent), journal });
    const replay = await consumeBackendEvents({ run: runningRun(), sessionId: "session-1", stream: eventsOf(textEvent), journal });
    const nextAttempt = await consumeBackendEvents({ run: { ...runningRun(), current_attempt: 2 }, sessionId: "session-1", stream: eventsOf(textEvent), journal });

    expect(first.text).toBe("same");
    expect(replay.text).toBe("");
    expect(replay.events).toHaveLength(0);
    expect(nextAttempt.text).toBe("same");
    expect(store.events).toHaveLength(2);
    expect(store.events.map((event) => event.attempt_no)).toEqual([1, 2]);
  });

  it("stops after the first typed terminal evidence", async () => {
    let pulledAfterTerminal = false;
    async function* duplicateTerminalStream(): AsyncIterable<BackendOutputEvent> {
      yield { event_type: "run_completed", terminal_evidence: { kind: "completed", source: "owned_loop_return" }, payload: {} };
      pulledAfterTerminal = true;
      yield { event_type: "run_failed", terminal_evidence: { kind: "failed", source: "owned_loop_return", error: { code: "late_failure", message: "late", retryable: false, causeCategory: "runtime" } }, payload: {} };
    }
    const store = new InMemoryBackendEventJournalStore();

    const result = await consumeBackendEvents({
      run: runningRun(),
      sessionId: "session-1",
      stream: duplicateTerminalStream(),
      journal: new BackendEventJournal(store)
    });

    expect(result.run.status).toBe("completed");
    expect(store.events.filter((event) => event.event_type === "run_completed" || event.event_type === "run_failed")).toHaveLength(0);
    expect(result.terminalSettlement?.terminalEvent.event_type).toBe("run_completed");
    expect(pulledAfterTerminal).toBe(false);
  });
});

describe("TurnExecutor", () => {
  it("starts the fixed Backend through lifecycle, journals before tool dispatch, and closes the iterator", async () => {
    const store = new ExecutorStore(queuedRun());
    let iteratorClosed = false;
    const backend: AgentBackend = {
      id: "backend",
      kind: "mock",
      label: "Executor Backend",
      startSession: async () => {
        store.order.push("startSession");
        return { backend_session_id: "backend-session-1", metadata: {}, started_at: "2026-01-01T00:00:00.000Z" };
      },
      runTurn: () => streamWithCleanup(() => { iteratorClosed = true; })
    };
    const executor = new TurnExecutor(store, new BackendEventJournal(store), {
      toolDispatch: {
        dispatch: async ({ event }) => {
          expect(store.events.at(-1)?.event_type).toBe("tool_call_started");
          store.order.push(`tool:${event.payload.action}`);
        }
      }
    });

    const result = await executor.execute(preparedTurn(backend));

    expect(result.run.status).toBe("completed");
    expect(result.terminalSettlement?.terminalEvent.event_type).toBe("run_completed");
    expect(store.events.map((event) => event.event_type)).toEqual(["run_started", "tool_call_started"]);
    expect(store.order).toEqual([
      "lifecycle:backend_starting",
      "startSession",
      "session",
      "lifecycle:external_running",
      "runTurn",
      "journal:run_started",
      "journal:tool_call_started",
      "tool:tool.read"
    ]);
    expect(iteratorClosed).toBe(true);
  });

  it("starts resumeRun through the same lifecycle and terminal preparation path", async () => {
    const store = new ExecutorStore({ ...queuedRun(), status: "waiting_for_backend_input", phase: "waiting", backend_session_id: "backend-session-1" });
    let receivedInput: Record<string, unknown> | undefined;
    const backend: AgentBackend = {
      id: "backend",
      kind: "mock",
      label: "Executor Backend",
      resumeRun: (_runId, input) => {
        receivedInput = input;
        return eventsOf({ event_type: "run_completed", payload: {}, terminal_evidence: { kind: "completed", source: "provider_terminal_response" } });
      },
      runTurn: () => eventsOf()
    };
    const result = await new TurnExecutor(store, new BackendEventJournal(store)).resumeRun({ run: store.run, backend, input: { answer: "ok" } });

    expect(result.run.status).toBe("completed");
    expect(receivedInput).toEqual({ answer: "ok" });
    expect(store.events.map((event) => event.event_type)).toEqual(["run_started"]);
    expect(result.terminalSettlement?.terminalEvent.event_type).toBe("run_completed");
  });

  it("attempts required-finalize cleanup independently", async () => {
    const calls: string[] = [];
    const failures: string[] = [];
    const executor = new TurnExecutor({} as never, {} as never, {
      cleanup: {
        flushEvents: async () => { calls.push("flush"); throw new Error("flush failed"); },
        clearEventSequence: () => { calls.push("sequence"); },
        revokeToolBridge: () => { calls.push("token"); },
        releaseExecutionLock: async () => { calls.push("lock"); throw new Error("lock failed"); },
        recordFailure: ({ operation }) => { failures.push(operation); }
      }
    });

    await executor.cleanup({ runId: "run-1", sessionId: "session-1" });

    expect(calls).toEqual(["flush", "sequence", "token", "lock"]);
    expect(failures).toEqual(["event_flush", "execution_lock"]);
  });
});

class ExecutorStore extends InMemoryBackendEventJournalStore {
  readonly order: string[] = [];
  constructor(public run: BackendRunRecord) {
    super();
  }

  async commitCore02RunTransition(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> {
    this.order.push(`lifecycle:${input.nextRun.phase}`);
    this.run = input.nextRun;
    return input.nextRun;
  }

  async commitCore02BackendSession(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> {
    this.order.push("session");
    this.run = input.nextRun;
    return input.nextRun;
  }

  async commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }> {
    this.order.push(`journal:${input.event.event_type}`);
    this.events.push(input.event);
    this.run = input.nextRun;
    return { run: input.nextRun, event: input.event, duplicate: false };
  }

  async appendCore02Event(event: BackendEventRecord): Promise<{ event: BackendEventRecord; duplicate: boolean }> {
    this.order.push(`journal:${event.event_type}`);
    this.events.push(event);
    return { event, duplicate: false };
  }
}

async function* streamWithCleanup(onCleanup: () => void): AsyncIterable<BackendOutputEvent> {
  try {
    yield { event_type: "run_started", payload: {} };
    yield { event_type: "tool_call_started", payload: { tool_call_id: "tool-1", action: "tool.read" } };
    yield { event_type: "run_completed", payload: { output_summary: "done" }, terminal_evidence: { kind: "completed", source: "owned_loop_return" } };
  } finally {
    onCleanup();
  }
}

function preparedTurn(backend: AgentBackend): PreparedTurn {
  const run = queuedRun();
  return {
    request: {
      sessionId: run.session_id,
      content: "hello",
      envelope: { id: "envelope-1", source: "web", actor_identity: "owner", session_key: "session-1", user_intent: "chat", attachments: [], input_locale: "ja", output_locale: "ja", metadata: {}, received_at: run.started_at },
      idempotencyKey: "key-1"
    },
    session: { id: run.session_id, session_key: "session-1", title: "Session", ui_locale: "ja", output_locale: "ja", created_at: run.started_at, updated_at: run.started_at },
    binding: { id: backend.id, kind: backend.kind, backend },
    requestHash: "hash-1",
    reservation: { sessionId: run.session_id, runId: run.id, version: 1, status: "held" },
    userMessage: { id: run.input_message_id, session_id: run.session_id, role: "user", content: "hello", input_locale: "ja", output_locale: "ja", created_at: run.started_at },
    run,
    context: {} as PreparedTurn["context"],
    handoff: { version: 1, strategy: "inline_context", sources: [] },
    backendInput: {
      run_id: run.id,
      session_id: run.session_id,
      input_message_id: run.input_message_id,
      envelope: { id: "envelope-1", source: "web", actor_identity: "owner", session_key: "session-1", user_intent: "chat", attachments: [], input_locale: "ja", output_locale: "ja", metadata: {}, received_at: run.started_at },
      user_input: "hello",
      input_locale: "ja",
      output_locale: "ja",
      active_memory: [],
      recent_messages: [],
      metadata: {}
    }
  };
}

async function* eventsOf(...events: BackendOutputEvent[]): AsyncIterable<BackendOutputEvent> {
  for (const event of events) yield event;
}

function runningRun(): BackendRunRecord {
  return {
    id: "run-1",
    session_id: "session-1",
    input_message_id: "message-1",
    backend_id: "backend",
    backend_kind: "mock",
    status: "running",
    phase: "external_running",
    current_attempt: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    input_summary: "test",
    metadata: {}
  };
}

function queuedRun(): BackendRunRecord {
  return { ...runningRun(), status: "queued", phase: "preparing" };
}
