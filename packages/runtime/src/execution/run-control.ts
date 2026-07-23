import type {
  AgentBackend,
  BackendCancelResult,
  BackendOutputEvent,
  BackendRuntimeFailure,
  BackendTerminalEvidence
} from "@samurai-agent/agent-backends";
import type { BackendEventRecord, BackendRunRecord, JsonValue, MessageRecord, SessionRecord } from "@samurai-agent/core-schemas";
import { nowIso } from "@samurai-agent/core-schemas";
import { BackendEventJournal } from "./backend-event-journal";
import { RunLifecycle, type LifecycleRunStore, type PreparedTerminalSettlement } from "./run-lifecycle";
import { TurnExecutor, consumeBackendEvents, type TurnExecutionResult } from "./turn-executor";
import type { CommitTurnSettlementPort, CommittedEventPublisherPort, HostDiagnosticsPort, TurnCleanupPort, TurnSettlementInput, TurnToolExecutionPort } from "../host/host-types";
import { backendFailureFromUnknown, lifecycleEventForTerminalEvidence } from "./run-state-machine";

export type RunControlSettlementInput = TurnSettlementInput;

export interface RunControlStore extends LifecycleRunStore, CommitTurnSettlementPort {
  getBackendRun(runId: string): Promise<BackendRunRecord | undefined>;
  listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]>;
  commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }>;
  getSessionRunReservation(input: { runId: string }): Promise<{ sessionId: string; runId: string; version: number; status: "held" | "released" } | undefined>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
}

export interface RunControlOptions {
  settleTimeoutMs?: number;
  clock?: () => string;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitForEvidence?: (runId: string, deadline: number) => Promise<BackendCancelResult | undefined>;
  cleanup: TurnCleanupPort;
  diagnostics: HostDiagnosticsPort;
  committedEventPublisher: CommittedEventPublisherPort;
  toolExecution: TurnToolExecutionPort;
}

/** Direct control path for a known Run. It never queues cancel/resume/sync. */
export class RunControl {
  private readonly settleTimeoutMs: number;
  private readonly clock: () => string;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly waitForEvidence?: RunControlOptions["waitForEvidence"];
  private readonly lifecycle: RunLifecycle;
  private readonly eventJournal: BackendEventJournal;
  private readonly executor: TurnExecutor;
  private readonly committedEventPublisher: CommittedEventPublisherPort;
  private readonly diagnostics: HostDiagnosticsPort;

  constructor(
    private readonly store: RunControlStore,
    private readonly backendFor: (id: string) => AgentBackend | undefined,
    options: RunControlOptions,
    journal: BackendEventJournal
  ) {
    this.settleTimeoutMs = Math.max(1, options.settleTimeoutMs ?? 2500);
    this.clock = options.clock ?? nowIso;
    this.nowMs = options.nowMs ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.waitForEvidence = options.waitForEvidence;
    this.lifecycle = new RunLifecycle(this.clock);
    this.eventJournal = journal;
    this.committedEventPublisher = options.committedEventPublisher;
    this.diagnostics = options.diagnostics;
    this.executor = new TurnExecutor(store, this.eventJournal, {
      lifecycle: this.lifecycle,
      committedEventPublisher: options.committedEventPublisher,
      toolExecution: options.toolExecution,
      cleanup: options.cleanup,
      diagnostics: options.diagnostics
    });
  }

  async cancel(runId: string): Promise<BackendRunRecord> {
    const run = await this.requireRun(runId);
    if (hasSettledOutcome(run)) return run;

    if (run.status === "queued") {
      const decision = this.lifecycle.decide(run, { type: "cancel_queued" });
      const pending = await this.prepareTerminal(run, { kind: "not_started", source: "preflight_rejection" }, undefined, true, decision, "queued_cancel");
      return this.commitPending(pending, undefined, { code: "cancelled", message: "Queued run was cancelled before backend start." });
    }

    const preCancelPhase = run.phase ?? "admitted";
    const cancelling = await this.lifecycle.transition(this.store, run, { type: "cancel_requested" });
    const backend = this.backendFor(cancelling.backend_id);
    const deadline = this.nowMs() + this.settleTimeoutMs;
    let result: BackendCancelResult = { kind: "unsupported" };
    let cancelError: unknown;

    if (backend?.cancelRun) {
      let cancellation: Promise<BackendCancelResult>;
      try {
        cancellation = backend.cancelRun(runId);
      } catch (error) {
        cancellation = Promise.reject(error);
      }
      const response = await this.awaitBeforeDeadline(cancellation, deadline);
      if (response.kind === "settled") result = response.value;
      else if (response.kind === "rejected") {
        cancelError = response.error;
      } else {
        result = { kind: "requested" };
      }
    }

    while (result.kind === "requested" && this.nowMs() < deadline) {
      const latest = await this.store.getBackendRun(runId);
      if (latest && hasSettledOutcome(latest)) return latest;
      if (this.waitForEvidence) {
        let evidenceProbe: Promise<BackendCancelResult | undefined>;
        try {
          evidenceProbe = this.waitForEvidence(runId, deadline);
        } catch (error) {
          cancelError = error;
          break;
        }
        const response = await this.awaitBeforeDeadline(evidenceProbe, deadline);
        if (response.kind === "settled") {
          result = response.value ?? { kind: "requested" };
          if (result.kind === "settled") break;
        } else if (response.kind === "rejected") {
          cancelError = response.error;
          break;
        } else {
          break;
        }
      }
      if (result.kind === "requested") {
        const remaining = deadline - this.nowMs();
        if (remaining <= 0) break;
        await this.sleep(Math.min(25, remaining));
      }
    }

    const latest = await this.store.getBackendRun(runId);
    if (latest && hasSettledOutcome(latest)) return latest;
      const evidence: BackendTerminalEvidence = result.kind === "settled"
      ? result.evidence
      : isPreExternalPhase(preCancelPhase)
        ? { kind: "not_started", source: "preflight_rejection" }
        : { kind: "indeterminate", reason: result.kind === "requested" || cancelError !== undefined || !backend?.cancelRun ? "cancel_unconfirmed" : "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true };
    const failure = evidence.kind === "indeterminate"
      ? backendFailureFromUnknown(cancelError, evidence.reason === "cancel_unconfirmed"
        ? cancelError !== undefined
          ? { code: "backend_cancel_failed", message: "Backend cancellation failed before its outcome was confirmed.", retryable: false, causeCategory: "cancellation" }
          : { code: "backend_cancel_unconfirmed", message: "Backend cancellation could not be confirmed.", retryable: false, causeCategory: "cancellation" }
        : { code: "backend_runtime_state_unavailable", message: "Backend runtime state is unavailable.", retryable: false, causeCategory: "runtime" })
      : undefined;
    const pending = await this.prepareTerminal(cancelling, evidence, failure, true, undefined, "cancel");
    const withWarning = evidence.kind === "indeterminate"
      ? { ...pending, nextRun: { ...pending.nextRun, metadata: { ...pending.nextRun.metadata, warning: "cancel_outcome_unknown", may_have_external_side_effects: true } } }
      : pending;
    return this.commitPending(withWarning, undefined, failure ?? { code: "cancelled", message: "Run cancellation was confirmed." });
  }

  async resume(runId: string, input: Record<string, unknown> = {}): Promise<BackendRunRecord> {
    const run = await this.requireRun(runId);
    if (hasSettledOutcome(run)) return run;
    if (run.status !== "waiting_for_backend_input") throw new Error(`run_not_waiting:${runId}`);
    const safeInput = validateResumeInput(input);
    const backend = this.backendFor(run.backend_id);
    if (!backend?.resumeRun) {
      const failure = { code: "backend_resume_unsupported", message: "Backend does not support resume.", retryable: false, causeCategory: "configuration" as const };
      const pending = await this.prepareTerminal(run, { kind: "not_started", source: "preflight_rejection" }, failure, false, undefined, "resume_unsupported");
      return this.commitPending(pending, undefined, failure);
    }

    try {
      const backendInput = run.backend_session_id ? { ...safeInput, backend_session_id: run.backend_session_id } : safeInput;
      const execution = await this.executor.resumeRun({ run, backend, input: backendInput });
      return this.finishControlExecution(execution, "resume_terminal_missing");
    } catch (error) {
      const latest = await this.store.getBackendRun(runId) ?? run;
      if (hasSettledOutcome(latest)) return latest;
      const failure = backendFailureFromUnknown(error, { code: "backend_transport_lost", message: "Backend transport was lost before the result was confirmed.", retryable: false, causeCategory: "transport" });
      const pending = await this.prepareTerminal(latest, { kind: "indeterminate", reason: "transport_lost", providerStarted: true, mayHaveSideEffects: true }, failure, false, undefined, "resume_transport_lost");
      return this.commitPending(pending, undefined, failure);
    }
  }

  async answer(runId: string, input: Record<string, unknown>): Promise<BackendRunRecord> {
    return this.resume(runId, input);
  }

  async sync(runId: string): Promise<BackendRunRecord> {
    const run = await this.requireRun(runId);
    if (hasSettledOutcome(run)) return run;
    const backend = this.backendFor(run.backend_id);
    if (!backend?.streamEvents) {
      const pending = await this.prepareUnknown(run, "stream_sync_unsupported");
      return this.commitPending(pending, undefined, { code: "stream_sync_unsupported", message: "Backend stream synchronization is unavailable." });
    }
    try {
      const execution = await this.consumeControlStream(run, backend.streamEvents(runId));
      return this.finishControlExecution(execution, "stream_terminal_missing");
    } catch (error) {
      const latest = await this.store.getBackendRun(runId) ?? run;
      if (hasSettledOutcome(latest)) return latest;
      const failure = backendFailureFromUnknown(error, { code: "backend_transport_lost", message: "Backend transport was lost before the result was confirmed.", retryable: false, causeCategory: "transport" });
      const pending = await this.prepareTerminal(latest, { kind: "indeterminate", reason: "transport_lost", providerStarted: true, mayHaveSideEffects: true }, failure, false, undefined, "stream_transport_lost");
      return this.commitPending(pending, undefined, failure);
    }
  }

  private async consumeControlStream(run: BackendRunRecord, stream: AsyncIterable<BackendOutputEvent>): Promise<TurnExecutionResult> {
    return consumeBackendEvents({
      run,
      sessionId: run.session_id,
      stream,
      journal: this.eventJournal,
      clock: this.clock,
      emitCommitted: async (event, committedRun) => this.publishCommittedEvent(event, committedRun, "control_event_publisher")
    });
  }

  private async finishControlExecution(execution: TurnExecutionResult, missingReason: string): Promise<BackendRunRecord> {
    if (execution.run.status === "waiting_for_backend_input") return execution.run;
    if (execution.terminalSettlement) {
      return this.commitPending(execution.terminalSettlement, execution.text || outputSummaryFromEvents(execution.events), undefined);
    }
    const pending = await this.prepareUnknown(execution.run, missingReason);
    return this.commitPending(pending, execution.text || outputSummaryFromEvents(execution.events), { code: "outcome_unknown", message: "Backend finished without a terminal result." });
  }

  private async prepareUnknown(run: BackendRunRecord, reason: string): Promise<PreparedTerminalSettlement> {
    const pending = await this.prepareTerminal(
      run,
      { kind: "indeterminate", reason: "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true },
      { code: "backend_runtime_state_unavailable", message: "Backend finished without a terminal result.", retryable: false, causeCategory: "runtime" },
      false,
      undefined,
      reason
    );
    return {
      ...pending,
      nextRun: {
        ...pending.nextRun,
        metadata: { ...pending.nextRun.metadata, warning: reason }
      }
    };
  }

  private async prepareTerminal(
    run: BackendRunRecord,
    evidence: BackendTerminalEvidence,
    failure: BackendRuntimeFailure | undefined,
    requestedCancel: boolean,
    decision: PreparedTerminalSettlement["decision"] | undefined,
    source: string
  ): Promise<PreparedTerminalSettlement> {
    const lifecycleEvent = lifecycleEventForTerminalEvidence(evidence, { requestedCancel, ...(failure ? { failure } : {}) });
    const selectedDecision = decision ?? this.lifecycle.decide(run, lifecycleEvent);
    const error = failure ?? (evidence.kind === "failed" ? evidence.error : undefined);
    return this.eventJournal.prepareTerminalSettlement(run, {
      runId: run.id,
      sessionId: run.session_id,
      attemptNo: run.current_attempt ?? 1,
      eventType: selectedDecision.toStatus === "completed" ? "run_completed" : "run_failed",
      payload: { ...(error ? { error_code: error.code, message: error.message } : {}) },
      sourceEventId: `control:${source}:${run.id}:${run.current_attempt ?? 1}:${selectedDecision.toStatus}`,
      terminalEvidence: evidence
    }, selectedDecision);
  }

  private async commitPending(pending: PreparedTerminalSettlement, content: string | undefined, diagnostic?: { code: string; message: string }): Promise<BackendRunRecord> {
    const output = content !== undefined && pending.nextRun.status === "completed" && content.length > 0
      ? await this.createOutput(pending.expectedRun, content)
      : undefined;
    const reservation = await this.store.getSessionRunReservation({ runId: pending.expectedRun.id });
    if (!reservation) throw new Error(`settlement_reservation_missing:${pending.expectedRun.id}`);
    const settled = await this.store.commitTurnSettlement({
      ...pending,
      outputSourceId: `message:${pending.expectedRun.id}:output`,
      ...(output ? { output } : {}),
      ...(!output ? { diagnostic: { code: diagnostic?.code ?? pending.nextRun.error_code ?? "turn_settled", message: diagnostic?.message ?? pending.decision.failure?.message ?? pending.decision.reason } } : {}),
      reservation
    });
    await this.publishCommittedEvent(pending.terminalEvent, settled, "control_terminal_publisher");
    return settled;
  }

  private async publishCommittedEvent(event: BackendEventRecord, run: BackendRunRecord, operationId: string): Promise<void> {
    try {
      await this.committedEventPublisher.publish({ event, run });
    } catch (error) {
      const input = {
        runId: run.id,
        sessionId: run.session_id,
        attemptNo: run.current_attempt ?? 1,
        operationId,
        eventType: "host_emit_failed" as const,
        message: error instanceof Error ? error.message : String(error)
      };
      try {
        await this.diagnostics.record(input);
      } catch (diagnosticError) {
        this.diagnostics.logPersistenceFailure({ ...input, error: diagnosticError });
      }
    }
  }

  private async createOutput(run: BackendRunRecord, content: string): Promise<MessageRecord | undefined> {
    const session = await this.store.getSession(run.session_id);
    if (!session) return undefined;
    return {
      id: `message:${run.id}:output`,
      session_id: session.id,
      role: "agent",
      content,
      input_locale: session.ui_locale,
      output_locale: session.output_locale,
      created_at: this.clock()
    };
  }

  private async requireRun(runId: string): Promise<BackendRunRecord> {
    const run = await this.store.getBackendRun(runId);
    if (!run) throw new Error(`run_not_found:${runId}`);
    return run;
  }

  private async awaitBeforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<{ kind: "settled"; value: T } | { kind: "rejected"; error: unknown } | { kind: "deadline" }> {
    const remaining = Math.max(0, deadline - this.nowMs());
    if (remaining === 0) return { kind: "deadline" };
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result: { kind: "settled"; value: T } | { kind: "rejected"; error: unknown } | { kind: "deadline" }) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ kind: "deadline" }), remaining);
      promise.then((value) => finish({ kind: "settled", value }), (error: unknown) => finish({ kind: "rejected", error }));
    });
  }
}

function hasSettledOutcome(run: BackendRunRecord): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "outcome_unknown";
}

function isPreExternalPhase(phase: BackendRunRecord["phase"]): boolean {
  return phase === undefined || phase === "admitted" || phase === "preparing" || phase === "backend_starting";
}

function validateResumeInput(input: Record<string, unknown>): Record<string, JsonValue> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("resume_input_object_required");
  const cloned = JSON.parse(JSON.stringify(input)) as unknown;
  if (!isJsonObject(cloned)) throw new Error("resume_input_json_object_required");
  return cloned;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}

function outputSummaryFromEvents(events: BackendEventRecord[]): string | undefined {
  const terminal = [...events].reverse().find((event) => event.event_type === "run_completed");
  return typeof terminal?.payload.output_summary === "string" ? terminal.payload.output_summary : undefined;
}
