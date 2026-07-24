import type { BackendEventRecord, BackendRunPhase, BackendRunRecord, BackendRunStatus, LifecycleTransitionDecision as CoreLifecycleTransitionDecision } from "@samurai-agent/core-schemas";
import type { BackendTerminalEvidence, RuntimeFailureCauseCategory } from "@samurai-agent/agent-backends";
import { applyLifecycleTransition, canTransitionStatus, normalizeBackendFailure } from "./run-state-machine";
import type { CanonicalLifecycleEvent } from "./run-state-machine";

const lifecycleDecisionBrand: unique symbol = Symbol("LifecycleTransitionDecision");

interface RuntimeFailure {
  readonly code: string;
  readonly message: string;
  readonly phase: BackendRunPhase;
  readonly retryable: boolean;
  readonly causeCategory: RuntimeFailureCauseCategory;
}

export type LifecycleTransitionDecision = CoreLifecycleTransitionDecision & {
  readonly reason: string;
  readonly terminalEvidence?: BackendTerminalEvidence;
  readonly failure?: RuntimeFailure;
  readonly [lifecycleDecisionBrand]: true;
};

export interface LifecycleRunStore {
  commitCore02RunTransition(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord>;
  commitCore02BackendSession(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord>;
}

export interface PreparedTerminalSettlement {
  readonly expectedRun: BackendRunRecord;
  readonly nextRun: BackendRunRecord;
  readonly decision: LifecycleTransitionDecision;
  readonly terminalEvent: BackendEventRecord;
  readonly attemptNo: number;
  readonly sourceIdentity: {
    readonly sourceEventId?: string;
    readonly sourceSequence?: number;
  };
  readonly terminalEvidence: BackendTerminalEvidence;
}

/**
 * The only production owner that creates lifecycle decisions.
 * State-machine functions remain pure and table-testable; this class owns the
 * boundary where a decision is applied to a persisted Run.
 */
export class RunLifecycle {
  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  decide(run: Pick<BackendRunRecord, "status" | "phase">, event: CanonicalLifecycleEvent): LifecycleTransitionDecision {
    return createLifecycleTransitionDecision(run, event);
  }

  apply(run: BackendRunRecord, decision: LifecycleTransitionDecision): BackendRunRecord {
    return applyLifecycleTransition(run, decision, this.clock());
  }

  async transition(store: LifecycleRunStore, run: BackendRunRecord, event: CanonicalLifecycleEvent): Promise<BackendRunRecord> {
    const decision = this.decide(run, event);
    return this.persist(store, run, this.apply(run, decision));
  }

  async persist(store: LifecycleRunStore, expectedRun: BackendRunRecord, nextRun: BackendRunRecord): Promise<BackendRunRecord> {
    return store.commitCore02RunTransition({ expectedRun, nextRun });
  }

  async recordBackendSession(store: LifecycleRunStore, run: BackendRunRecord, backendSessionId: string): Promise<BackendRunRecord> {
    if (!backendSessionId.trim()) throw new Error("backend_session_id_required");
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "outcome_unknown") {
      throw new Error(`backend_session_after_settlement:${run.id}`);
    }
    const nextRun = { ...run, backend_session_id: backendSessionId };
    return store.commitCore02BackendSession({ expectedRun: run, nextRun });
  }

  prepareTerminalSettlement(
    expectedRun: BackendRunRecord,
    nextRun: BackendRunRecord,
    decision: LifecycleTransitionDecision,
    terminalEvent: BackendEventRecord
  ): PreparedTerminalSettlement {
    if (!isTerminalStatus(nextRun.status)) throw new Error(`lifecycle_terminal_required:${nextRun.id}`);
    const terminalEvidence = readTerminalEvidence(terminalEvent);
    if (!terminalEvidence) throw new Error(`terminal_evidence_required:${terminalEvent.id}`);
    const attemptNo = nextRun.current_attempt ?? expectedRun.current_attempt ?? 1;
    if (terminalEvent.run_id !== expectedRun.id || terminalEvent.session_id !== expectedRun.session_id) {
      throw new Error(`terminal_event_scope_conflict:${expectedRun.id}`);
    }
    if (terminalEvent.attempt_no !== undefined && terminalEvent.attempt_no !== attemptNo) {
      throw new Error(`terminal_event_attempt_conflict:${expectedRun.id}`);
    }
    return {
      expectedRun,
      nextRun,
      decision,
      terminalEvent: { ...terminalEvent, attempt_no: attemptNo },
      attemptNo,
      sourceIdentity: {
        ...(terminalEvent.source_event_id ? { sourceEventId: terminalEvent.source_event_id } : {}),
        ...(terminalEvent.source_sequence !== undefined ? { sourceSequence: terminalEvent.source_sequence } : {})
      },
      terminalEvidence
    };
  }
}

function createLifecycleTransitionDecision(run: Pick<BackendRunRecord, "status" | "phase">, event: CanonicalLifecycleEvent): LifecycleTransitionDecision {
  const from = run.status;
  const phase = run.phase ?? "admitted";
  assertLifecycleEventAllowed(from, event.type);
  assertLifecyclePhaseAllowed(phase, event.type);
  let to: BackendRunStatus;
  let toPhase: BackendRunPhase;
  let reason: string;
  let terminalEvidence: BackendTerminalEvidence | undefined;
  let failure: RuntimeFailure | undefined;
  switch (event.type) {
    case "preparing": to = from; toPhase = "preparing"; reason = "turn_preparing"; break;
    case "backend_starting": to = from; toPhase = "backend_starting"; reason = "backend_starting"; break;
    case "external_running": to = "running"; toPhase = "external_running"; reason = "backend_external_running"; break;
    case "started": to = "running"; toPhase = "external_running"; reason = "backend_started"; break;
    case "waiting": to = "waiting_for_backend_input"; toPhase = "waiting"; reason = "backend_waiting_for_input"; break;
    case "cancel_requested": to = from; toPhase = "cancelling"; reason = "cancel_requested"; break;
    case "cancel_queued": to = "cancelled"; toPhase = "settled"; reason = "queued_cancelled"; terminalEvidence = { kind: "not_started", source: "preflight_rejection" }; break;
    case "completed": to = "completed"; toPhase = "settled"; reason = "terminal_completed"; terminalEvidence = event.evidence; break;
    case "failed": to = "failed"; toPhase = "settled"; reason = "terminal_failed"; terminalEvidence = event.evidence; break;
    case "cancelled": to = "cancelled"; toPhase = "settled"; reason = "terminal_cancelled"; terminalEvidence = event.evidence; break;
    case "indeterminate": to = "outcome_unknown"; toPhase = "settled"; reason = "terminal_indeterminate"; terminalEvidence = event.evidence; break;
  }
  if (!canTransitionStatus(from, to)) throw new Error(`invalid_run_transition:${from}->${to}`);
  const failureInput = event.type === "failed" || event.type === "indeterminate" ? event.failure : undefined;
  failure = failureInput ? { ...normalizeBackendFailure(failureInput, failureInput), phase } : undefined;
  return {
    fromStatus: from,
    toStatus: to,
    fromPhase: phase,
    toPhase,
    reason,
    ...(terminalEvidence ? { terminalEvidence } : {}),
    ...(failure ? { failure } : {}),
    [lifecycleDecisionBrand]: true
  } as LifecycleTransitionDecision;
}

function assertLifecycleEventAllowed(status: BackendRunStatus, eventType: CanonicalLifecycleEvent["type"]): void {
  if (eventType === "preparing" || eventType === "backend_starting" || eventType === "cancel_queued") {
    if (status === "queued") return;
    throw new Error(`invalid_run_lifecycle_event:${eventType}:${status}`);
  }
  if (eventType === "external_running" || eventType === "started") {
    if (status === "queued" || status === "waiting_for_backend_input") return;
    throw new Error(`invalid_run_lifecycle_event:${eventType}:${status}`);
  }
  if (eventType === "cancel_requested") {
    if (status === "running" || status === "waiting_for_backend_input") return;
    throw new Error(`invalid_run_lifecycle_event:${eventType}:${status}`);
  }
  if (eventType === "waiting") {
    if (status === "running") return;
    throw new Error(`invalid_run_lifecycle_event:${eventType}:${status}`);
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    throw new Error(`invalid_run_lifecycle_event:${eventType}:${status}`);
  }
  if (eventType === "indeterminate" && status === "outcome_unknown") {
    throw new Error(`invalid_run_lifecycle_event:${eventType}:${status}`);
  }
}

function assertLifecyclePhaseAllowed(phase: BackendRunPhase, eventType: CanonicalLifecycleEvent["type"]): void {
  if (eventType === "preparing" && phase !== "admitted") throw new Error(`invalid_run_lifecycle_phase:${eventType}:${phase}`);
  if (eventType === "backend_starting" && phase !== "admitted" && phase !== "preparing") throw new Error(`invalid_run_lifecycle_phase:${eventType}:${phase}`);
  if (eventType === "external_running" && phase !== "admitted" && phase !== "preparing" && phase !== "backend_starting") throw new Error(`invalid_run_lifecycle_phase:${eventType}:${phase}`);
  if (eventType === "waiting" && phase !== "external_running") throw new Error(`invalid_run_lifecycle_phase:${eventType}:${phase}`);
  if (eventType === "started" && (phase === "cancelling" || phase === "settled")) throw new Error(`invalid_run_lifecycle_phase:${eventType}:${phase}`);
  if (eventType === "cancel_requested" && phase === "settled") throw new Error(`invalid_run_lifecycle_phase:${eventType}:${phase}`);
}

export function isTerminalStatus(status: BackendRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "outcome_unknown";
}

function readTerminalEvidence(event: BackendEventRecord): BackendTerminalEvidence | undefined {
  const value = event.payload.terminal_evidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { kind?: unknown };
  if (candidate.kind === "completed" || candidate.kind === "failed" || candidate.kind === "cancelled" || candidate.kind === "not_started" || candidate.kind === "indeterminate") {
    return value as BackendTerminalEvidence;
  }
  return undefined;
}
