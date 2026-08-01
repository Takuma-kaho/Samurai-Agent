import type { BackendOutputEvent, BackendRuntimeFailure, BackendRunInput, RuntimeFailureCauseCategory } from "@samurai-agent/agent-backends";
import { BackendTerminalEvidenceSchema, type BackendEventRecord, type BackendRunRecord, type GatewayBoundaryPolicy, type JsonValue } from "@samurai-agent/core-schemas";
import type { CommittedEventPublisherPort, HostDiagnosticsPort, PreparedTurn, TurnCleanupPort, TurnToolExecutionPort } from "../host/host-types";
import { normalizeBackendOutputEvent } from "../backend/event-bridge";
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
  readonly committedEventPublisher: CommittedEventPublisherPort;
  readonly toolExecution: TurnToolExecutionPort;
  readonly cleanup: TurnCleanupPort;
  readonly diagnostics: HostDiagnosticsPort;
}

export interface TurnExecutorCleanupInput {
  readonly runId: string;
  readonly sessionId: string;
}

export interface TurnResumeExecutionInput {
  readonly run: BackendRunRecord;
  readonly backend: { execution_owner: "host" | "backend" | "tool_bridge"; resumeRun?: (runId: string, input: Record<string, JsonValue>) => AsyncIterable<BackendOutputEvent> };
  readonly input: Record<string, JsonValue>;
  readonly backendInput?: BackendRunInput;
  readonly gatewayBoundaryPolicy?: GatewayBoundaryPolicy;
}

export interface TurnSyncExecutionInput {
  readonly run: BackendRunRecord;
  readonly backend: { streamEvents?: (runId: string) => AsyncIterable<BackendOutputEvent> };
}

/**
 * Owns Backend session startup, one attempt, and the canonical Event stream.
 * It returns a prepared terminal settlement; it never writes a terminal Event
 * outside the completion transaction.
 */
export class TurnExecutor {
  private readonly lifecycle: RunLifecycle;
  private readonly committedEventPublisher: CommittedEventPublisherPort;
  private readonly toolExecution: TurnToolExecutionPort;
  private readonly cleanupPort: TurnCleanupPort;
  private readonly diagnostics: HostDiagnosticsPort;

  constructor(
    private readonly store: LifecycleRunStore,
    private readonly journal: BackendEventJournal,
    options: TurnExecutorOptions
  ) {
    this.lifecycle = options.lifecycle ?? new RunLifecycle();
    this.committedEventPublisher = options.committedEventPublisher;
    this.toolExecution = options.toolExecution;
    this.cleanupPort = options.cleanup;
    this.diagnostics = options.diagnostics;
  }

  async execute(prepared: PreparedTurn, signal?: AbortSignal): Promise<TurnExecutionResult> {
    throwIfAborted(signal);
    let run = prepared.run;
    let currentPrepared = prepared;
    run = await this.lifecycle.transition(this.store, run, { type: "backend_starting" });
    currentPrepared = withRun(prepared, run);

    const backend = currentPrepared.binding.backend;
    if (Object.keys(currentPrepared.backendInput.metadata).length > 0) {
      run = await this.lifecycle.persist(this.store, run, {
        ...run,
        metadata: { ...run.metadata, ...currentPrepared.backendInput.metadata }
      });
      currentPrepared = withRun(currentPrepared, run);
    }
    if (backend.sessionPolicy.acquisition === "start_session" && !backend.startSession) {
      throw new Error("backend_start_session_unsupported");
    }
    if (!run.backend_session_id && backend.sessionPolicy.acquisition === "start_session") {
      throwIfAborted(signal);
      const sessionHandle = await backend.startSession!({
        session_id: run.session_id,
        session_key: currentPrepared.session.session_key,
        ...(currentPrepared.session.room_id ? { room_id: currentPrepared.session.room_id } : {}),
        ...(currentPrepared.backendInput.agent_context ? { agent_id: currentPrepared.backendInput.agent_context.id } : {}),
        ...(currentPrepared.backendInput.backend_session_key ? { backend_session_key: currentPrepared.backendInput.backend_session_key } : {}),
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
      store: this.store,
      emitCommitted: async (event, committedRun, sourceEvent) => {
        await this.publishCommittedEvent(event, committedRun, "event_publisher");
        if (event.event_type === "tool_call_started" && backend.execution_owner === "host") {
          await this.executeHostTool({
            event,
            sourceEvent,
            run: committedRun,
            backendInput: currentPrepared.backendInput,
            gatewayBoundaryPolicy: currentPrepared.request.gatewayBoundaryPolicy
          });
        }
      }
    });
    if (execution.cleanupError !== undefined) {
      await this.recordDiagnostic(execution.run, "host_cleanup_failed", "iterator_cleanup", execution.cleanupError);
    }
    return { ...execution, prepared: withRun(currentPrepared, execution.run) };
  }

  async resumeRun(input: TurnResumeExecutionInput): Promise<TurnExecutionResult> {
    if (!input.backend.resumeRun) throw new Error("backend_resume_unsupported");
    const execution = await consumeBackendEvents({
      run: input.run,
      sessionId: input.run.session_id,
      stream: input.backend.resumeRun(input.run.id, input.input),
      journal: this.journal,
      lifecycle: this.lifecycle,
      store: this.store,
      emitCommitted: async (event, committedRun, sourceEvent) => {
        await this.publishCommittedEvent(event, committedRun, "control_event_publisher");
        if (event.event_type === "tool_call_started" && input.backend.execution_owner === "host" && input.backendInput) {
          await this.executeHostTool({
            event,
            sourceEvent,
            run: committedRun,
            backendInput: input.backendInput,
            gatewayBoundaryPolicy: input.gatewayBoundaryPolicy
          });
        }
      }
    });
    if (execution.cleanupError !== undefined) {
      await this.recordDiagnostic(execution.run, "host_cleanup_failed", "iterator_cleanup", execution.cleanupError);
    }
    return execution;
  }

  /** Consume a durable backend stream without executing Host-owned Tools. */
  async syncRun(input: TurnSyncExecutionInput): Promise<TurnExecutionResult | undefined> {
    if (!input.backend.streamEvents) return undefined;
    const execution = await consumeBackendEvents({
      run: input.run,
      sessionId: input.run.session_id,
      stream: input.backend.streamEvents(input.run.id),
      journal: this.journal,
      lifecycle: this.lifecycle,
      store: this.store,
      emitCommitted: async (event, committedRun) => {
        await this.publishCommittedEvent(event, committedRun, "sync_event_publisher");
      }
    });
    if (execution.cleanupError !== undefined) {
      await this.recordDiagnostic(execution.run, "host_cleanup_failed", "iterator_cleanup", execution.cleanupError);
    }
    return execution;
  }

  /** Required-finalize cleanup. Each resource is attempted independently. */
  async cleanup(input: TurnExecutorCleanupInput): Promise<void> {
    try {
      await this.cleanupPort.cleanup(input);
    } catch (error) {
      const run = await (this.store as LifecycleRunStore & { getBackendRun?: (runId: string) => Promise<BackendRunRecord | undefined> }).getBackendRun?.(input.runId);
      if (run) await this.recordDiagnostic(run, "host_cleanup_failed", "cleanup", error);
      else this.diagnostics.logPersistenceFailure({
        runId: input.runId,
        sessionId: input.sessionId,
        attemptNo: 1,
        operationId: "cleanup",
        eventType: "host_cleanup_failed",
        message: error instanceof Error ? error.message : String(error),
        error
      });
    }
  }

  private async recordDiagnostic(run: BackendRunRecord, eventType: "host_cleanup_failed" | "host_emit_failed", operationId: string, error: unknown): Promise<void> {
      const input = {
        runId: run.id,
        sessionId: run.session_id,
      attemptNo: run.current_attempt ?? 1,
      operationId,
      eventType,
      message: error instanceof Error ? error.message : String(error)
    } as const;
    try {
      await this.diagnostics.record(input);
    } catch (diagnosticError) {
      this.diagnostics.logPersistenceFailure({ ...input, error: diagnosticError });
    }
  }

  private async executeHostTool(input: {
    event: BackendEventRecord;
    sourceEvent?: BackendOutputEvent;
    run: BackendRunRecord;
    backendInput: BackendRunInput;
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy;
  }): Promise<void> {
    const toolCallId = input.sourceEvent?.tool_call_id ?? (typeof input.event.payload.tool_call_id === "string" ? input.event.payload.tool_call_id : undefined);
    if (!toolCallId) throw new Error("tool_call_id_required");
    await this.toolExecution.execute({
      run: input.run,
      backendInput: input.backendInput,
      event: {
        event_type: "tool_call_started",
        tool_call_id: toolCallId,
        payload: input.sourceEvent?.payload ?? input.event.payload
      },
      gatewayBoundaryPolicy: input.gatewayBoundaryPolicy,
      recordEvent: async (toolEvent) => {
        const normalizedToolEvent = normalizeBackendOutputEvent(toolEvent);
        const recorded = await this.journal.appendCanonicalEvent({
          runId: input.run.id,
          sessionId: input.run.session_id,
          ...(normalizedToolEvent.backend_session_id ? { backendSessionId: normalizedToolEvent.backend_session_id } : {}),
          attemptNo: input.run.current_attempt ?? 1,
          eventType: normalizedToolEvent.event_type,
          payload: normalizedToolEvent.payload,
          resourceRefs: normalizedToolEvent.resource_refs,
          sourceEventId: `host-tool:${input.run.id}:${input.run.current_attempt ?? 1}:${normalizedToolEvent.tool_call_id ?? toolCallId ?? input.event.id}:${normalizedToolEvent.event_type}:${String(backendOutputPayload(normalizedToolEvent).action_id ?? backendOutputPayload(normalizedToolEvent).status ?? "result")}`
        });
        if (!recorded.duplicate) {
          await this.publishCommittedEvent(recorded.event, input.run, "tool_event_publisher");
        }
        return recorded.event;
      }
    });
  }

  private async publishCommittedEvent(event: Awaited<ReturnType<BackendEventJournal["appendCanonicalEvent"]>>["event"], run: BackendRunRecord, operationId: string): Promise<void> {
    try {
      await this.committedEventPublisher.publish({ event, run });
    } catch (error) {
      await this.recordDiagnostic(run, "host_emit_failed", operationId, error);
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
  const payload = backendOutputPayload(event);
  const code = typeof payload.error_code === "string" ? payload.error_code : undefined;
  const message = typeof payload.message === "string" ? payload.message : undefined;
  const causeCategory = failureCauseCategory(payload.cause_category, event);
  return code || message
    ? {
        code: code ?? "backend_failed",
        message: message ?? "Backend operation failed.",
        retryable: payload.retryable === true,
        causeCategory
      }
    : undefined;
}

function backendOutputPayload(event: BackendOutputEvent): Record<string, JsonValue> {
  return event.payload as Record<string, JsonValue>;
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

export async function consumeBackendEvents(input: { run: BackendRunRecord; sessionId: string; stream: AsyncIterable<BackendOutputEvent>; journal: BackendEventJournal; store?: LifecycleRunStore; clock?: () => string; lifecycle?: RunLifecycle; emitCommitted?: (event: TurnExecutionResult["events"][number], run: BackendRunRecord, sourceEvent?: BackendOutputEvent) => Promise<void> }): Promise<TurnExecutionResult> {
  let run = input.run;
  const events: TurnExecutionResult["events"] = [];
  let terminal = false;
  const textParts: string[] = [];
  const lifecycle = input.lifecycle ?? new RunLifecycle(input.clock);
  let terminalSettlement: PreparedTerminalSettlement | undefined;
  let sourceSequence = 0;
  const eventStore = input.store as (LifecycleRunStore & {
    listBackendEvents?: (input: { runId: string }) => Promise<BackendEventRecord[]>;
  }) | undefined;
  if (eventStore?.listBackendEvents) {
    const existingEvents = await eventStore.listBackendEvents({ runId: input.run.id });
    sourceSequence = existingEvents.reduce((max, event) => Math.max(max, event.source_sequence ?? 0), 0);
  }
  let waitingExecution: "live" | "suspended" | undefined;
  let streamError: unknown;
  const iterator = input.stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const event = normalizeBackendOutputEvent(next.value);
      if ((event.event_type === "run_completed" || event.event_type === "run_failed") && !event.terminal_evidence) {
        throw new Error("terminal_evidence_required");
      }
      if (event.terminal_evidence) BackendTerminalEvidenceSchema.parse(event.terminal_evidence);
      const observedBackendSessionId = backendSessionIdFromEvent(event);
      if (observedBackendSessionId) {
        const sessionSourceEvent = event.source_event_id ?? event.event_type;
        if (run.backend_session_id && run.backend_session_id !== observedBackendSessionId) {
          const conflictEvent: BackendOutputEvent = {
            event_type: "run_failed",
            terminal_evidence: {
              kind: "failed",
              source: "canonical_event",
              error: {
                code: "backend_session_conflict",
                message: "Backend emitted a different native Session ID.",
                retryable: false,
                causeCategory: "runtime"
              }
            },
            payload: {
              error_code: "backend_session_conflict",
              message: "Backend emitted a different native Session ID.",
              reason: "session_conflict",
              retryable: false,
              ...(typeof backendOutputPayload(event).provider_event_type === "string" ? { provider_event_type: backendOutputPayload(event).provider_event_type } : {})
            }
          };
          const conflictSourceSequence = sourceSequence + 1;
          const conflictJournalInput = {
            runId: run.id,
            sessionId: input.sessionId,
            ...(run.backend_session_id ? { backendSessionId: run.backend_session_id } : {}),
            attemptNo: run.current_attempt ?? 1,
            eventType: conflictEvent.event_type,
            payload: conflictEvent.payload,
            resourceRefs: [],
            sourceEventId: `backend-session-conflict:${run.id}:${run.current_attempt ?? 1}`,
            sourceSequence: conflictSourceSequence,
            terminalEvidence: conflictEvent.terminal_evidence
          };
          const conflictLifecycleEvent = lifecycleEventForBackendEvent(conflictEvent);
          if (!conflictLifecycleEvent) throw new Error("backend_session_conflict_terminal_missing");
          const decision = lifecycle.decide(run, conflictLifecycleEvent);
          terminalSettlement = await input.journal.prepareTerminalSettlement(run, conflictJournalInput, decision);
          events.push(terminalSettlement.terminalEvent);
          run = terminalSettlement.nextRun;
          terminal = true;
          break;
        }
        if (event.terminal_evidence) {
          run = mergeBackendSession(run, observedBackendSessionId, sessionSourceEvent);
        } else if (input.store) {
          run = await lifecycle.recordBackendSession(input.store, run, observedBackendSessionId, sessionSourceEvent);
        } else {
          run = mergeBackendSession(run, observedBackendSessionId, sessionSourceEvent);
        }
      }
      const canonicalSourceSequence = sourceSequence + 1;
      sourceSequence = Math.max(canonicalSourceSequence, event.source_sequence ?? 0);
      const candidateLifecycleEvent = lifecycleEventForBackendEvent(event, run.phase === "cancelling");
      const lifecycleEvent = candidateLifecycleEvent?.type === "started" && run.status === "running" ? undefined : candidateLifecycleEvent;
      const journalInput = {
        runId: run.id,
        sessionId: input.sessionId,
        ...(event.backend_session_id ? { backendSessionId: event.backend_session_id } : {}),
        attemptNo: run.current_attempt ?? 1,
        eventType: event.event_type,
        payload: event.payload,
        resourceRefs: event.resource_refs,
        sourceEventId: event.source_event_id,
        sourceSequence: event.source_event_id ? event.source_sequence ?? canonicalSourceSequence : canonicalSourceSequence,
        terminalEvidence: event.terminal_evidence
      };
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
          await input.emitCommitted?.(committed.event, committed.run, event);
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
          await input.emitCommitted?.(committed.event, run, event);
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

function backendSessionIdFromEvent(event: BackendOutputEvent): string | undefined {
  const value = event.backend_session_id;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mergeBackendSession(run: BackendRunRecord, backendSessionId: string, sourceEventId?: string): BackendRunRecord {
  if (run.backend_session_id && run.backend_session_id !== backendSessionId) {
    throw new Error(`backend_session_conflict:${run.id}`);
  }
  if (run.backend_session_id) return run;
  return {
    ...run,
    backend_session_id: backendSessionId,
    metadata: {
      ...run.metadata,
      backend_session_id: backendSessionId,
      ...(sourceEventId ? { backend_session_source_event: sourceEventId } : {})
    }
  };
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
