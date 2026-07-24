import type { BackendRunRecord, BackendRunStatus, LifecycleTransitionDecision } from "@samurai-agent/core-schemas";
import type { BackendCancelResult, BackendIndeterminateEvidence, BackendRuntimeFailure, BackendTerminalEvidence, RuntimeFailureCauseCategory } from "@samurai-agent/agent-backends";
export type { BackendCancelResult, BackendIndeterminateEvidence, BackendTerminalEvidence } from "@samurai-agent/agent-backends";

export type CanonicalLifecycleEvent =
  | { type: "preparing" }
  | { type: "backend_starting" }
  | { type: "external_running" }
  | { type: "started" }
  | { type: "waiting" }
  | { type: "cancel_requested" }
  | { type: "cancel_queued" }
  | { type: "completed"; evidence: Extract<BackendTerminalEvidence, { kind: "completed" }> }
  | { type: "failed"; evidence: Extract<BackendTerminalEvidence, { kind: "failed" | "not_started" }>; failure: BackendRuntimeFailure }
  | { type: "cancelled"; evidence: Extract<BackendTerminalEvidence, { kind: "cancelled" | "not_started" }> }
  | { type: "indeterminate"; evidence: BackendIndeterminateEvidence; failure: BackendRuntimeFailure };

const allowedStatusTransitions: Record<BackendRunStatus, readonly BackendRunStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["waiting_for_backend_input", "completed", "failed", "cancelled", "outcome_unknown"],
  waiting_for_backend_input: ["running", "failed", "cancelled", "outcome_unknown"],
  outcome_unknown: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

export function canTransitionStatus(from: BackendRunStatus, to: BackendRunStatus): boolean {
  return from === to || allowedStatusTransitions[from].includes(to);
}

export function terminalStatusForEvidence(evidence: BackendTerminalEvidence, requestedCancel = false): BackendRunStatus {
  if (evidence.kind === "completed") return "completed";
  if (evidence.kind === "failed") return "failed";
  if (evidence.kind === "cancelled") return "cancelled";
  if (evidence.kind === "not_started") return requestedCancel ? "cancelled" : "failed";
  assertValidIndeterminateEvidence(evidence);
  // A cancellation request does not prove that the external operation stopped.
  // Keep the indeterminate evidence visible and never infer success/failure.
  return "outcome_unknown";
}

export function lifecycleEventForTerminalEvidence(
  evidence: BackendTerminalEvidence,
  options: { requestedCancel?: boolean; failure?: BackendRuntimeFailure } = {}
): Extract<CanonicalLifecycleEvent, { type: "completed" | "failed" | "cancelled" | "indeterminate" }> {
  const status = terminalStatusForEvidence(evidence, options.requestedCancel === true);
  if (status === "completed" && evidence.kind === "completed") return { type: "completed", evidence };
  if (status === "cancelled" && (evidence.kind === "cancelled" || evidence.kind === "not_started")) return { type: "cancelled", evidence };
  if (status === "outcome_unknown" && evidence.kind === "indeterminate") {
    return { type: "indeterminate", evidence, failure: normalizeBackendFailure(options.failure, indeterminateFailureDefaults(evidence.reason)) };
  }
  if (status === "failed" && (evidence.kind === "failed" || evidence.kind === "not_started")) {
    return {
      type: "failed",
      evidence,
      failure: evidence.kind === "failed"
        ? normalizeBackendFailure(evidence.error, failureDefaultsForSource(evidence.source))
        : normalizeBackendFailure(options.failure, {
            code: "backend_not_started",
            message: "Backend rejected the turn before starting.",
            retryable: false,
            causeCategory: "configuration"
          })
    };
  }
  throw new Error(`invalid_terminal_evidence:${evidence.kind}:${status}`);
}

export function backendTerminalEvidenceFromValue(value: unknown): BackendTerminalEvidence | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "completed" && isSettledSource(value.source)) return { kind: "completed", source: value.source };
  if (value.kind === "cancelled" && isSettledSource(value.source)) return { kind: "cancelled", source: value.source };
  if (value.kind === "not_started" && value.source === "preflight_rejection") return { kind: "not_started", source: "preflight_rejection" };
  if (value.kind === "failed" && isSettledSource(value.source) && isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
    return { kind: "failed", source: value.source, error: normalizeBackendFailure(value.error, failureDefaultsForSource(value.source)) };
  }
  if (
    value.kind === "indeterminate"
    && (value.reason === "transport_lost" || value.reason === "cancel_unconfirmed" || value.reason === "runtime_state_unavailable")
    && typeof value.providerStarted === "boolean"
    && typeof value.mayHaveSideEffects === "boolean"
  ) {
    if (!value.providerStarted && !value.mayHaveSideEffects) return undefined;
    return { kind: "indeterminate", reason: value.reason, providerStarted: value.providerStarted, mayHaveSideEffects: value.mayHaveSideEffects };
  }
  return undefined;
}

export function backendFailureFromUnknown(
  error: unknown,
  defaults: { code: string; message: string; retryable: boolean; causeCategory: RuntimeFailureCauseCategory }
): BackendRuntimeFailure {
  const record = isRecord(error) ? error : {};
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : defaults.message;
  return normalizeBackendFailure({
    code: typeof record.code === "string" ? record.code : defaults.code,
    message,
    retryable: typeof record.retryable === "boolean" ? record.retryable : defaults.retryable,
    causeCategory: isFailureCauseCategory(record.causeCategory) ? record.causeCategory : defaults.causeCategory
  }, defaults);
}

function assertValidIndeterminateEvidence(evidence: BackendIndeterminateEvidence): void {
  if (!evidence.providerStarted && !evidence.mayHaveSideEffects) {
    throw new Error("invalid_indeterminate_evidence:no_external_uncertainty");
  }
}

function indeterminateFailureDefaults(reason: BackendIndeterminateEvidence["reason"]): BackendRuntimeFailure {
  if (reason === "cancel_unconfirmed") {
    return { code: "backend_cancel_unconfirmed", message: "Backend cancellation could not be confirmed.", retryable: false, causeCategory: "cancellation" };
  }
  if (reason === "transport_lost") {
    return { code: "backend_transport_lost", message: "Backend transport was lost before the result was confirmed.", retryable: false, causeCategory: "transport" };
  }
  return { code: "backend_runtime_state_unavailable", message: "Backend runtime state is unavailable.", retryable: false, causeCategory: "runtime" };
}

function failureDefaultsForSource(source: Extract<BackendTerminalEvidence, { kind: "failed" }>["source"]): BackendRuntimeFailure {
  const causeCategory: RuntimeFailureCauseCategory = source === "provider_terminal_response" ? "provider" : source === "process_exit" ? "process" : "runtime";
  return { code: "backend_failed", message: "Backend operation failed.", retryable: false, causeCategory };
}

export function normalizeBackendFailure(value: unknown, defaults: BackendRuntimeFailure): BackendRuntimeFailure {
  const record = isRecord(value) ? value : {};
  return {
    code: typeof record.code === "string" && /^[a-z][a-z0-9_.-]{0,79}$/i.test(record.code) ? record.code : defaults.code,
    message: safeRuntimeFailureMessage(typeof record.message === "string" ? record.message : defaults.message, defaults.message),
    retryable: typeof record.retryable === "boolean" ? record.retryable : defaults.retryable,
    causeCategory: isFailureCauseCategory(record.causeCategory) ? record.causeCategory : defaults.causeCategory
  };
}

function safeRuntimeFailureMessage(value: string, fallback: string): string {
  const safe = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "credential=[redacted]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/(?<![A-Za-z0-9:/.])\/[^\s"'<>]+/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
  return (safe || fallback).slice(0, 240);
}

function isFailureCauseCategory(value: unknown): value is RuntimeFailureCauseCategory {
  return value === "configuration" || value === "provider" || value === "transport" || value === "cancellation" || value === "process" || value === "runtime" || value === "unknown";
}

function isSettledSource(value: unknown): value is "canonical_event" | "process_exit" | "provider_terminal_response" | "owned_loop_return" {
  return value === "canonical_event" || value === "process_exit" || value === "provider_terminal_response" || value === "owned_loop_return";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function applyLifecycleTransition(run: BackendRunRecord, decision: LifecycleTransitionDecision, now: string): BackendRunRecord {
  const currentPhase = run.phase ?? "admitted";
  if (run.status !== decision.fromStatus || currentPhase !== decision.fromPhase || !canTransitionStatus(run.status, decision.toStatus)) {
    throw new Error(`stale_run_transition:${run.id}`);
  }
  const terminal = ["completed", "failed", "cancelled"].includes(decision.toStatus);
  const { completed_at: previousCompletedAt, error_code: _previousErrorCode, metadata: previousMetadata, ...base } = run;
  const metadataWithoutUnknownWarning = (() => {
    const {
      warning: _warning,
      outcome_unknown_reason: _outcomeUnknownReason,
      provider_started: _providerStarted,
      may_have_external_side_effects: _mayHaveExternalSideEffects,
      ...rest
    } = previousMetadata;
    return rest;
  })();
  const baseMetadata = run.status === "outcome_unknown" && decision.toStatus !== "outcome_unknown"
    ? metadataWithoutUnknownWarning
    : previousMetadata;
  const terminalEvidence = backendTerminalEvidenceFromValue(decision.terminalEvidence);
  const metadata = {
    ...baseMetadata,
    ...(decision.failure
      ? {
          failure_code: decision.failure.code,
          error_message: decision.failure.message,
          failure_phase: decision.failure.phase,
          failure_retryable: decision.failure.retryable,
          failure_cause_category: decision.failure.causeCategory
        }
      : {}),
    ...(terminalEvidence?.kind === "indeterminate"
      ? {
          outcome_unknown_reason: terminalEvidence.reason,
          provider_started: terminalEvidence.providerStarted,
          may_have_external_side_effects: terminalEvidence.mayHaveSideEffects
        }
      : {})
  };
  return {
    ...base,
    metadata,
    status: decision.toStatus,
    phase: decision.toPhase,
    ...(terminal ? { completed_at: previousCompletedAt ?? now } : {}),
    ...(decision.toStatus === "failed" && decision.failure
      ? { error_code: decision.failure.code }
      : terminalEvidence?.kind === "indeterminate"
        ? { error_code: "outcome_unknown" }
        : {})
  };
}
