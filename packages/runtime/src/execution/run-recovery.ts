import type { BackendOutputEvent, BackendRuntimeFailure, BackendTerminalEvidence } from "@samurai-agent/agent-backends";
import type { BackendEventRecord, BackendRunPhase, BackendRunRecord, JsonValue, MessageRecord, SessionRecord } from "@samurai-agent/core-schemas";
import { nowIso } from "@samurai-agent/core-schemas";
import { BackendEventJournal } from "./backend-event-journal";
import { RunLifecycle, type LifecycleRunStore, type PreparedTerminalSettlement } from "./run-lifecycle";
import { TurnExecutor, type TurnExecutionResult } from "./turn-executor";
import { backendFailureFromUnknown, backendTerminalEvidenceFromValue, lifecycleEventForTerminalEvidence } from "./run-state-machine";
import type { CommitTurnSettlementPort, CommittedEventPublisherPort, HostDiagnosticsPort, HostDiagnosticEventType, TurnCleanupPort, TurnSettlementInput } from "../host/host-types";

type RecoveryEvent = Pick<BackendEventRecord, "id" | "event_type" | "payload" | "resource_refs" | "source_event_id" | "source_sequence" | "attempt_no">;

export type RecoverySettlementInput = TurnSettlementInput;

export interface RecoveryStore extends LifecycleRunStore, CommitTurnSettlementPort {
  listCore02RecoveryCandidates(): Promise<BackendRunRecord[]>;
  listBackendEvents(input: { runId: string }): Promise<RecoveryEvent[]>;
  getBackendRun(runId: string): Promise<BackendRunRecord | undefined>;
  commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }>;
  getSessionRunReservation(input: { runId: string }): Promise<{ sessionId: string; runId: string; version: number; status: "held" | "released" } | undefined>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
}

export interface RecoveryBackend {
  id: string;
  streamEvents?(runId: string): AsyncIterable<BackendOutputEvent>;
  resumeRun?(runId: string, input: Record<string, never>): AsyncIterable<BackendOutputEvent>;
}

export interface RecoveryDiagnostic {
  run_id: string;
  code: "recovery_enqueue_failed";
  phase: BackendRunPhase;
  message: string;
  retryable: false;
  cause_category: "runtime";
}

export interface RecoveryReport {
  diagnostics: RecoveryDiagnostic[];
}

/** One-shot startup reconciliation. It never invents a retry for unknown outcomes. */
export class RunRecovery {
  private lastReport: RecoveryReport = { diagnostics: [] };
  private readonly lifecycle: RunLifecycle;
  private readonly eventJournal: BackendEventJournal;
  private readonly executor: TurnExecutor;

  constructor(
    private readonly store: RecoveryStore,
    private readonly backendFor: (id: string) => RecoveryBackend | undefined,
    private readonly clock: () => string = nowIso,
    journal: BackendEventJournal,
    private readonly committedEventPublisher: CommittedEventPublisherPort,
    private readonly cleanup: TurnCleanupPort,
    private readonly enqueue: (run: BackendRunRecord) => Promise<void>,
    private readonly diagnostics: HostDiagnosticsPort,
    executor: TurnExecutor,
    lifecycle?: RunLifecycle
  ) {
    this.lifecycle = lifecycle ?? new RunLifecycle(clock);
    this.eventJournal = journal;
    this.executor = executor;
  }

  getLastReport(): RecoveryReport {
    return { diagnostics: this.lastReport.diagnostics.map((diagnostic) => ({ ...diagnostic })) };
  }

  async reconcile(): Promise<BackendRunRecord[]> {
    this.lastReport = { diagnostics: [] };
    const recovered: BackendRunRecord[] = [];
    const candidates = await this.store.listCore02RecoveryCandidates();
    for (const run of candidates) {
      try {
        // Room-scoped Runs are reconciled by AgentHost's shared Workspace
        // execution path. This object owns Session-bound Chat recovery only.
        if (!run.session_id) continue;
        if (!(run.status === "queued" || run.status === "running" || run.status === "waiting_for_backend_input" || run.status === "outcome_unknown")) continue;
        if (run.status === "queued") {
          await this.reenqueue(run);
          recovered.push(run);
          continue;
        }

      const storedTerminal = findStoredTerminal(await this.store.listBackendEvents({ runId: run.id }));
      if (storedTerminal) {
        try {
          const pending = await this.prepareTerminal(run, storedTerminal, "stored_terminal");
          recovered.push(await this.commitPending(pending, outputSummary(storedTerminal.payload), undefined));
          continue;
        } catch (error) {
          await this.addDiagnostic(run, "recovery_enqueue_failed", error);
        }
      }

      const backend = this.backendFor(run.backend_id);
      // A waiting Run is never resumed without user input. Stream sync is a
      // separate explicit recovery probe, when the backend exposes it.
      if (run.status === "waiting_for_backend_input" && backend?.resumeRun && !backend.streamEvents) {
        recovered.push(run);
        continue;
      }

      if (backend?.streamEvents) {
        try {
          const execution: TurnExecutionResult | undefined = await this.executor.syncRun({ run, backend });
          if (!execution) {
            recovered.push(run);
            continue;
          }
          const observedWaitingEvent = execution.events.some((event) => event.event_type === "backend_waiting_for_native_input");
          if (execution.run.status === "waiting_for_backend_input" && observedWaitingEvent) {
            recovered.push(execution.run);
          } else if (execution.terminalSettlement) {
            recovered.push(await this.commitPending(execution.terminalSettlement, outputSummaryFromEvents(execution.events) || execution.text, undefined));
          } else {
            recovered.push(await this.markIndeterminate(execution.run, "runtime_state_unavailable"));
          }
        } catch (error) {
          const latest = await this.store.getBackendRun(run.id) ?? run;
          recovered.push(hasSettledOutcome(latest) ? latest : await this.markIndeterminate(latest, "transport_lost", error));
        } finally {
          await this.cleanupRun(run);
        }
        continue;
      }

        recovered.push(hasSettledOutcome(run) ? run : await this.markIndeterminate(run, "runtime_state_unavailable"));
      } catch (error) {
        await this.addDiagnostic(run, "recovery_enqueue_failed", error);
      }
    }
    return recovered;
  }

  private async reenqueue(run: BackendRunRecord): Promise<void> {
    try {
      await this.enqueue(run);
    } catch (error) {
      await this.addDiagnostic(run, "recovery_enqueue_failed", error);
    }
  }

  private async markIndeterminate(run: BackendRunRecord, reason: "transport_lost" | "runtime_state_unavailable", error?: unknown): Promise<BackendRunRecord> {
    if (hasSettledOutcome(run)) return run;
    const evidence = { kind: "indeterminate", reason, providerStarted: true, mayHaveSideEffects: true } as const;
    const failure = backendFailureFromUnknown(error, reason === "transport_lost"
      ? { code: "backend_transport_lost", message: "Backend transport was lost before the result was confirmed.", retryable: false, causeCategory: "transport" }
      : { code: "backend_runtime_state_unavailable", message: "Backend runtime state is unavailable.", retryable: false, causeCategory: "runtime" });
    const pending = await this.prepareTerminal(run, { event_type: "run_failed", payload: {}, resource_refs: [], source_event_id: `recovery:${reason}:${run.id}:${run.current_attempt ?? 1}`, source_sequence: undefined, attempt_no: run.current_attempt ?? 1, id: `recovery:${reason}:${run.id}` , terminal_evidence: evidence }, "recovery_unknown", failure);
    const diagnosed = { ...pending, nextRun: { ...pending.nextRun, metadata: { ...pending.nextRun.metadata, warning: reason } } };
    return this.commitPending(diagnosed, undefined, failure);
  }

  private async prepareTerminal(
    run: BackendRunRecord,
    event: BackendOutputEvent & { id?: string; attempt_no?: number },
    source: string,
    suppliedFailure?: BackendRuntimeFailure
  ): Promise<PreparedTerminalSettlement> {
    requireSessionBoundRun(run);
    const evidence = event.terminal_evidence;
    if (!evidence) throw new Error(`recovery_terminal_evidence_missing:${run.id}`);
    const lifecycleEvent = lifecycleEventForTerminalEvidence(evidence, { failure: suppliedFailure });
    const decision = this.lifecycle.decide(run, lifecycleEvent);
    return this.eventJournal.prepareTerminalSettlement(run, {
      runId: run.id,
      sessionId: run.session_id,
      attemptNo: event.attempt_no ?? run.current_attempt ?? 1,
      eventType: decision.toStatus === "completed" ? "run_completed" : "run_failed",
      payload: event.payload,
      resourceRefs: event.resource_refs,
      ...(event.source_event_id ? { sourceEventId: event.source_event_id } : event.id ? {} : { sourceEventId: `recovery:${source}:${run.id}:${run.current_attempt ?? 1}` }),
      sourceSequence: event.source_sequence,
      eventId: event.id,
      terminalEvidence: evidence
    }, decision);
  }

  private async commitPending(pending: PreparedTerminalSettlement, content: string | undefined, diagnostic?: BackendRuntimeFailure): Promise<BackendRunRecord> {
    const output = content && pending.nextRun.status === "completed" ? await this.createOutput(pending.expectedRun, content) : undefined;
    const reservation = await this.store.getSessionRunReservation({ runId: pending.expectedRun.id });
    if (!reservation) throw new Error(`settlement_reservation_missing:${pending.expectedRun.id}`);
    const settled = await this.store.commitTurnSettlement({
      ...pending,
      outputSourceId: `message:${pending.expectedRun.id}:output`,
      ...(output ? { output } : {}),
      ...(!output ? { diagnostic: { code: diagnostic?.code ?? pending.nextRun.error_code ?? "turn_settled", message: diagnostic?.message ?? pending.decision.failure?.message ?? pending.decision.reason } } : {}),
      reservation
    });
    try {
      await this.committedEventPublisher.publish({ event: pending.terminalEvent, run: settled });
    } catch (error) {
      await this.recordHostDiagnostic(settled, "host_emit_failed", "recovery_terminal_publisher", error);
    }
    return settled;
  }

  private async createOutput(run: BackendRunRecord, content: string): Promise<MessageRecord | undefined> {
    requireSessionBoundRun(run);
    const session = await this.store.getSession(run.session_id);
    if (!session) return undefined;
    return { id: `message:${run.id}:output`, session_id: session.id, role: "agent", content, input_locale: session.ui_locale, output_locale: session.output_locale, created_at: this.clock() };
  }

  private async addDiagnostic(run: BackendRunRecord, code: RecoveryDiagnostic["code"], error: unknown): Promise<void> {
    const message = backendFailureFromUnknown(error, {
      code: "recovery_diagnostic",
      message: "Recovery failed.",
      retryable: false,
      causeCategory: "runtime"
    }).message;
    this.lastReport.diagnostics.push({ run_id: run.id, code, phase: run.phase ?? "admitted", message: message.slice(0, 240), retryable: false, cause_category: "runtime" });
    const diagnostic = {
      runId: run.id,
      sessionId: run.session_id,
      attemptNo: run.current_attempt ?? 1,
      operationId: `recovery:${code}`,
      eventType: "host_cleanup_failed" as const,
      message: message.slice(0, 240)
    };
    await this.recordHostDiagnostic(run, diagnostic.eventType, diagnostic.operationId, error, diagnostic.message);
  }

  private async cleanupRun(run: BackendRunRecord): Promise<void> {
    try {
      await this.cleanup.cleanup({ runId: run.id, sessionId: run.session_id });
    } catch (error) {
      await this.recordHostDiagnostic(run, "host_cleanup_failed", "recovery_cleanup", error);
    }
  }

  private async recordHostDiagnostic(
    run: Pick<BackendRunRecord, "id" | "session_id" | "current_attempt">,
    eventType: HostDiagnosticEventType,
    operationId: string,
    error: unknown,
    message?: string
  ): Promise<void> {
    const diagnostic = {
      runId: run.id,
      sessionId: run.session_id,
      attemptNo: run.current_attempt ?? 1,
      operationId,
      eventType,
      message: message ?? (error instanceof Error ? error.message : String(error))
    };
    try {
      await this.diagnostics.record(diagnostic);
    } catch (diagnosticError) {
      this.diagnostics.logPersistenceFailure({ ...diagnostic, error: diagnosticError });
    }
  }
}

function requireSessionBoundRun(run: BackendRunRecord): asserts run is BackendRunRecord & { session_id: string } {
  if (!run.session_id) throw new Error(`session_bound_run_required:${run.id}`);
}

function hasSettledOutcome(run: BackendRunRecord): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "outcome_unknown";
}

function findStoredTerminal(events: RecoveryEvent[]): (BackendOutputEvent & { id?: string; attempt_no?: number }) | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || (event.event_type !== "run_completed" && event.event_type !== "run_failed")) continue;
    const evidence = backendTerminalEvidenceFromValue(event.payload.terminal_evidence);
    if (!evidence) continue;
    return {
      id: event.id,
      event_type: event.event_type,
      payload: event.payload,
      resource_refs: event.resource_refs,
      source_event_id: event.source_event_id,
      source_sequence: event.source_sequence,
      attempt_no: event.attempt_no,
      terminal_evidence: evidence
    };
  }
  return undefined;
}

function outputSummary(payload: Record<string, JsonValue>): string | undefined {
  return typeof payload.output_summary === "string" ? payload.output_summary : undefined;
}

function outputSummaryFromEvents(events: BackendEventRecord[]): string | undefined {
  const terminal = [...events].reverse().find((event) => event.event_type === "run_completed");
  return terminal ? outputSummary(terminal.payload) : undefined;
}
