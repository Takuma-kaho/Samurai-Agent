import type { BackendOutputEvent, BackendRuntimeFailure, RuntimeFailureCauseCategory } from "@samurai-agent/agent-backends";
import type { BackendRunRecord, JsonValue } from "@samurai-agent/core-schemas";
import type { PreparedTurn, ToolDispatchPort, TurnCleanupPort } from "../host/host-types";
import { BackendEventJournal } from "./backend-event-journal";
import { RunLifecycle, type LifecycleRunStore, type PreparedTerminalSettlement } from "./run-lifecycle";
import { lifecycleEventForTerminalEvidence } from "./run-state-machine";

export interface TurnExecutionResult {
  run: BackendRunRecord;
  events: Awaited<ReturnType<BackendEventJournal["appendCanonicalEvent"]>>["event"][];
  terminal: boolean;
  text: string;
  terminalSettlement?: PreparedTerminalSettlement;
  cleanupError?: unknown;
  waitingExecution?: "live" | "suspended";
  prepared?: PreparedTurn;
}

export interface TurnExecutorOptions {
  readonly lifecycle?: RunLifecycle;
  readonly emitCommitted?: (event: TurnExecutionResult["events"][number], run: BackendRunRecord) => Promise<void>;
  readonly toolDispatch?: ToolDispatchPort;
  readonly cleanup?: TurnCleanupPort;
}

export interface TurnExecutorCleanupInput {
  readonly runId: string;
  readonly sessionId: string;
}

export interface TurnResumeExecutionInput {
  readonly run: BackendRunRecord;
  readonly backend: { resumeRun?: (runId: string, input: Record<string, JsonValue>) => AsyncIterable<BackendOutputEvent> };
  readonly input: Record<string, JsonValue>;
}

/**
 * Owns Backend session startup, one attempt, and the canonical Event stream.
 * It returns a prepared terminal settlement; it never writes a terminal Event
 * outside the completion transaction.
 */
export class TurnExecutor {
  private readonly lifecycle: RunLifecycle;

  constructor(
    private readonly store: LifecycleRunStore,
    private readonly journal: BackendEventJournal,
    private readonly options: TurnExecutorOptions = {}
  ) {
    this.lifecycle = options.lifecycle ?? new RunLifecycle();
  }

  async execute(prepared: PreparedTurn, signal?: AbortSignal): Promise<TurnExecutionResult> {
    throwIfAborted(signal);
    let run = prepared.run;
    let currentPrepared = prepared;
    run = await this.lifecycle.transition(this.store, run, { type: "backend_starting" });
    currentPrepared = withRun(prepared, run);

    const backend = currentPrepared.binding.backend;
    if (!run.backend_session_id && backend.startSession) {
      throwIfAborted(signal);
      const sessionHandle = await backend.startSession({
        session_id: run.session_id,
        session_key: currentPrepared.session.session_key,
        output_locale: currentPrepared.session.output_locale,
        metadata: currentPrepared.backendInput.metadata
      });
      throwIfAborted(signal);
      run = await this.lifecycle.recordBackendSession(this.store, run, sessionHandle.backend_session_id);
      currentPrepared = withRun(currentPrepared, run, {
        ...currentPrepared.backendInput,
        backend_session_id: sessionHandle.backend_session_id
      });
    }

    run = await this.lifecycle.transition(this.store, run, { type: "external_running" });
    currentPrepared = withRun(currentPrepared, run, {
      ...currentPrepared.backendInput,
      run_id: run.id,
      session_id: run.session_id,
      input_message_id: run.input_message_id,
      ...(run.backend_session_id ? { backend_session_id: run.backend_session_id } : {}),
      ...(signal ? { abort_signal: signal } : {})
    });
    throwIfAborted(signal);

    const execution = await consumeBackendEvents({
      run,
      sessionId: run.session_id,
      stream: backend.runTurn(currentPrepared.backendInput),
      journal: this.journal,
      lifecycle: this.lifecycle,
      emitCommitted: async (event, committedRun) => {
        try {
          await this.options.emitCommitted?.(event, committedRun);
        } catch (error) {
          await this.recordCleanupFailure(committedRun.id, "committed_event_emit", error);
        }
        if (event.event_type === "tool_call_started" || event.event_type === "tool_call_output") {
          await this.options.toolDispatch?.dispatch({
            turn: withRun(currentPrepared, committedRun),
            event: {
              tool_call_id: event.payload.tool_call_id as string | undefined,
              payload: event.payload
            }
          });
        }
      }
    });
    if (execution.cleanupError !== undefined) {
      await this.recordCleanupFailure(execution.run.id, "iterator_cleanup", execution.cleanupError);
    }
    return { ...execution, prepared: withRun(currentPrepared, execution.run) };
  }

  async resumeRun(input: TurnResumeExecutionInput): Promise<TurnExecutionResult> {
    if (!input.backend.resumeRun) throw new Error("backend_resume_unsupported");
    const decision = this.lifecycle.decide(input.run, { type: "started" });
    const resumed = await this.journal.commitLifecycleTransitionEvent(input.run, {
      runId: input.run.id,
      sessionId: input.run.session_id,
      attemptNo: input.run.current_attempt ?? 1,
      eventType: "run_started",
      payload: { reason: "resume" },
      sourceEventId: `control:resume:${input.run.id}:${input.run.current_attempt ?? 1}`
    }, decision);
    const execution = await consumeBackendEvents({
      run: resumed.run,
      sessionId: resumed.run.session_id,
      stream: input.backend.resumeRun(resumed.run.id, input.input),
      journal: this.journal,
      lifecycle: this.lifecycle,
      emitCommitted: this.options.emitCommitted
    });
    if (execution.cleanupError !== undefined) {
      await this.recordCleanupFailure(execution.run.id, "iterator_cleanup", execution.cleanupError);
    }
    return execution;
  }

  /** Required-finalize cleanup. Each resource is attempted independently. */
  async cleanup(input: TurnExecutorCleanupInput): Promise<void> {
    const cleanup = this.options.cleanup;
    if (!cleanup) return;
    const operations: Array<[string, () => void | Promise<void>]> = [
      ["event_flush", () => cleanup.flushEvents?.(input.runId)],
      ["event_sequence_cache", () => cleanup.clearEventSequence?.(input.runId)],
      ["tool_bridge_token", () => cleanup.revokeToolBridge?.(input.runId)],
      ["execution_lock", () => cleanup.releaseExecutionLock?.({ runId: input.runId, sessionId: input.sessionId })]
    ];
    for (const [operation, run] of operations) {
      try {
        await run();
      } catch (error) {
        await this.recordCleanupFailure(input.runId, operation, error);
      }
    }
  }

  private async recordCleanupFailure(runId: string, operation: string, error: unknown): Promise<void> {
    try {
      await this.options.cleanup?.recordFailure?.({ runId, operation, error });
    } catch {
      // Failure reporting is also best-effort and must not change the Run.
    }
  }
}

export function lifecycleEventForBackendEvent(event: BackendOutputEvent, requestedCancel = false) {
  if (event.terminal_evidence) {
    return lifecycleEventForTerminalEvidence(event.terminal_evidence, {
      requestedCancel,
      failure: backendFailureForEvent(event)
    });
  }
  if (event.event_type === "run_started") return { type: "started" as const };
  if (event.event_type === "backend_waiting_for_native_input") return { type: "waiting" as const };
  return undefined;
}

function backendFailureForEvent(event: BackendOutputEvent): BackendRuntimeFailure | undefined {
  if (event.terminal_evidence?.kind === "failed") return event.terminal_evidence.error;
  const code = typeof event.payload.error_code === "string" ? event.payload.error_code : undefined;
  const message = typeof event.payload.message === "string" ? event.payload.message : undefined;
  const causeCategory = failureCauseCategory(event.payload.cause_category, event);
  return code || message
    ? {
        code: code ?? "backend_failed",
        message: message ?? "Backend operation failed.",
        retryable: event.payload.retryable === true,
        causeCategory
      }
    : undefined;
}

function failureCauseCategory(value: unknown, event: BackendOutputEvent): RuntimeFailureCauseCategory {
  if (value === "configuration" || value === "provider" || value === "transport" || value === "cancellation" || value === "process" || value === "runtime" || value === "unknown") return value;
  if (event.terminal_evidence?.kind === "indeterminate") {
    if (event.terminal_evidence.reason === "transport_lost") return "transport";
    if (event.terminal_evidence.reason === "cancel_unconfirmed") return "cancellation";
    return "runtime";
  }
  if (event.terminal_evidence?.kind === "not_started") return "configuration";
  return "unknown";
}

export async function consumeBackendEvents(input: { run: BackendRunRecord; sessionId: string; stream: AsyncIterable<BackendOutputEvent>; journal: BackendEventJournal; clock?: () => string; lifecycle?: RunLifecycle; emitCommitted?: (event: TurnExecutionResult["events"][number], run: BackendRunRecord) => Promise<void> }): Promise<TurnExecutionResult> {
  let run = input.run;
  const events: TurnExecutionResult["events"] = [];
  let terminal = false;
  const textParts: string[] = [];
  const lifecycle = input.lifecycle ?? new RunLifecycle(input.clock);
  let terminalSettlement: PreparedTerminalSettlement | undefined;
  let sourceSequence = 0;
  let waitingExecution: "live" | "suspended" | undefined;
  let streamError: unknown;
  const iterator = input.stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      sourceSequence = Math.max(sourceSequence + 1, event.source_sequence ?? 0);
      const candidateLifecycleEvent = lifecycleEventForBackendEvent(event, run.phase === "cancelling");
      const lifecycleEvent = candidateLifecycleEvent?.type === "started" && run.status === "running" ? undefined : candidateLifecycleEvent;
      const journalInput = { runId: run.id, sessionId: input.sessionId, attemptNo: run.current_attempt ?? 1, eventType: event.event_type, payload: event.payload, resourceRefs: event.resource_refs, sourceEventId: event.source_event_id, sourceSequence: event.source_sequence ?? sourceSequence, terminalEvidence: event.terminal_evidence };
      if (lifecycleEvent && event.terminal_evidence) {
        const decision = lifecycle.decide(run, lifecycleEvent);
        terminalSettlement = await input.journal.prepareTerminalSettlement(run, journalInput, decision);
        events.push(terminalSettlement.terminalEvent);
        if (event.event_type === "text_delta" && typeof event.payload.text === "string") textParts.push(event.payload.text);
        run = terminalSettlement.nextRun;
        terminal = true;
        break;
      }
      if (lifecycleEvent) {
        const committed = await input.journal.commitLifecycleTransitionEvent(run, journalInput, lifecycle.decide(run, lifecycleEvent));
        if (!committed.duplicate) {
          events.push(committed.event);
          if (event.event_type === "text_delta" && typeof event.payload.text === "string") textParts.push(event.payload.text);
          await input.emitCommitted?.(committed.event, committed.run);
        }
        run = committed.run;
        if (event.event_type === "backend_waiting_for_native_input") {
          const mode = event.payload.waiting_execution;
          waitingExecution = mode === "suspended" ? "suspended" : "live";
        }
      } else {
        const committed = await input.journal.appendCanonicalEvent(journalInput);
        if (!committed.duplicate) {
          events.push(committed.event);
          if (event.event_type === "text_delta" && typeof event.payload.text === "string") textParts.push(event.payload.text);
          await input.emitCommitted?.(committed.event, run);
        }
      }
    }
  } catch (error) {
    streamError = error;
  } finally {
    try {
      await iterator.return?.();
    } catch (error) {
      streamError ??= error;
    }
  }
  if (streamError !== undefined) {
    if (terminalSettlement) {
      return { run, events, terminal: true, text: textParts.join(""), terminalSettlement, cleanupError: streamError, ...(waitingExecution ? { waitingExecution } : {}) };
    }
    throw streamError;
  }
  return { run, events, terminal, text: textParts.join(""), ...(terminalSettlement ? { terminalSettlement } : {}), ...(waitingExecution ? { waitingExecution } : {}) };
}

function withRun(prepared: PreparedTurn, run: BackendRunRecord, backendInput: PreparedTurn["backendInput"] = prepared.backendInput): PreparedTurn {
  return Object.freeze({ ...prepared, run, backendInput });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw typeof DOMException === "function"
    ? new DOMException("The operation was aborted", "AbortError")
    : Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}
