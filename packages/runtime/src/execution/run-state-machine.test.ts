import { describe, expect, it } from "vitest";
import { applyLifecycleTransition, backendTerminalEvidenceFromValue, lifecycleEventForTerminalEvidence, terminalStatusForEvidence, type BackendTerminalEvidence } from "./run-state-machine";
import type { BackendRunRecord } from "@samurai-agent/core-schemas";
import { RunLifecycle } from "./run-lifecycle";

const lifecycle = new RunLifecycle(() => "2026-01-01T00:00:01.000Z");
const decide = lifecycle.decide.bind(lifecycle);

const run = (status: BackendRunRecord["status"] = "queued"): BackendRunRecord => ({
  id: "run-1", session_id: "session-1", input_message_id: "message-1", backend_id: "backend", backend_kind: "mock", status,
  phase: status === "queued" ? "admitted" : status === "waiting_for_backend_input" ? "waiting" : status === "outcome_unknown" ? "settled" : "external_running",
  started_at: "2026-01-01T00:00:00.000Z", input_summary: "hello", metadata: {}
});

const providerFailure = {
  code: "provider_denied",
  message: "Provider denied the request.",
  retryable: false,
  causeCategory: "provider"
} as const;

describe("RunLifecycle", () => {
  it("accepts only the documented state path", () => {
    const started = decide(run(), { type: "started" });
    expect(started.toStatus).toBe("running");
    const completed = decide(applyLifecycleTransition(run(), started, "2026-01-01T00:00:01.000Z"), { type: "completed", evidence: { kind: "completed", source: "canonical_event" } });
    expect(completed.toPhase).toBe("settled");
    expect(() => decide(run(), { type: "completed", evidence: { kind: "completed", source: "canonical_event" } })).toThrow("invalid_run_transition");
  });

  it("preserves indeterminate failure detail without completed_at", () => {
    const running = { ...run("running"), completed_at: "2026-01-01T00:00:00.500Z" };
    const evidence = { kind: "indeterminate", reason: "cancel_unconfirmed", providerStarted: true, mayHaveSideEffects: true } as const;
    const decision = decide(running, lifecycleEventForTerminalEvidence(evidence, {
      failure: { code: "cancel_transport_lost", message: "cancel failed at /workspace/project and /Library/App with Bearer token-secret; docs https://example.test/api", retryable: false, causeCategory: "cancellation" }
    }));
    const next = applyLifecycleTransition(running, decision, "2026-01-01T00:00:01.000Z");
    expect(next).toMatchObject({
      status: "outcome_unknown",
      error_code: "outcome_unknown",
      metadata: {
        failure_code: "cancel_transport_lost",
        failure_phase: "external_running",
        failure_retryable: false,
        failure_cause_category: "cancellation",
        outcome_unknown_reason: "cancel_unconfirmed"
      }
    });
    expect(next.completed_at).toBeUndefined();
    expect(next.metadata.error_message).toContain("[path]");
    expect(next.metadata.error_message).toContain("[redacted]");
    expect(next.metadata.error_message).not.toContain("/workspace/project");
    expect(next.metadata.error_message).not.toContain("/Library/App");
    expect(next.metadata.error_message).toContain("https://example.test/api");
    expect(next.metadata.error_message).not.toContain("token-secret");
  });

  it("clears the display warning when an unknown outcome is later confirmed", () => {
    const current = {
      ...run("outcome_unknown"),
      metadata: {
        warning: "cancel_outcome_unknown",
        outcome_unknown_reason: "cancel_unconfirmed",
        provider_started: true,
        may_have_external_side_effects: true,
        retained_context: "keep"
      }
    };
    const decision = decide(current, { type: "completed", evidence: { kind: "completed", source: "canonical_event" } });
    const next = applyLifecycleTransition(current, decision, "2026-01-01T00:00:02.000Z");
    expect(next.status).toBe("completed");
    expect(next.metadata).toEqual({ retained_context: "keep" });
  });

  it.each([
    ["completed", { kind: "completed", source: "provider_terminal_response" }, false, "completed"],
    ["failed", { kind: "failed", source: "provider_terminal_response", error: providerFailure }, false, "failed"],
    ["cancelled", { kind: "cancelled", source: "process_exit" }, false, "cancelled"],
    ["normal not_started", { kind: "not_started", source: "preflight_rejection" }, false, "failed"],
    ["cancel not_started", { kind: "not_started", source: "preflight_rejection" }, true, "cancelled"],
    ["indeterminate", { kind: "indeterminate", reason: "transport_lost", providerStarted: true, mayHaveSideEffects: true }, false, "outcome_unknown"]
  ] as const)("maps %s evidence without inferring from event names", (_name, evidence, requestedCancel, expected) => {
    expect(terminalStatusForEvidence(evidence as BackendTerminalEvidence, requestedCancel)).toBe(expected);
  });

  it("keeps the complete backend failure contract on a failed run", () => {
    const evidence = { kind: "failed", source: "provider_terminal_response", error: providerFailure } as const;
    const current = run("running");
    const decision = decide(current, lifecycleEventForTerminalEvidence(evidence));
    const next = applyLifecycleTransition(current, decision, "2026-01-01T00:00:01.000Z");
    expect(next).toMatchObject({
      status: "failed",
      error_code: "provider_denied",
      metadata: {
        failure_code: "provider_denied",
        error_message: "Provider denied the request.",
        failure_phase: "external_running",
        failure_retryable: false,
        failure_cause_category: "provider"
      },
      completed_at: "2026-01-01T00:00:01.000Z"
    });
  });

  it("upgrades legacy persisted failed evidence with safe defaults", () => {
    const parsed = backendTerminalEvidenceFromValue({
      kind: "failed",
      source: "provider_terminal_response",
      error: { code: "provider_denied", message: "failed at /Users/person/file with api_key=secretvalue" }
    });
    expect(parsed).toMatchObject({
      kind: "failed",
      error: { code: "provider_denied", retryable: false, causeCategory: "provider" }
    });
    expect(parsed?.kind === "failed" ? parsed.error.message : "").toContain("[path]");
    expect(parsed?.kind === "failed" ? parsed.error.message : "").toContain("[redacted]");
  });

  it("rejects indeterminate evidence when external uncertainty is disproven", () => {
    const invalid = { kind: "indeterminate", reason: "transport_lost", providerStarted: false, mayHaveSideEffects: false } as const;
    expect(() => terminalStatusForEvidence(invalid)).toThrow("invalid_indeterminate_evidence");
    expect(backendTerminalEvidenceFromValue(invalid)).toBeUndefined();
  });

  it("allows cancel_requested only for running and waiting runs", () => {
    for (const status of ["running", "waiting_for_backend_input"] as const) {
      const current = run(status);
      const next = applyLifecycleTransition(current, decide(current, { type: "cancel_requested" }), "2026-01-01T00:00:01.000Z");
      expect(next).toMatchObject({ status, phase: "cancelling" });
    }
    for (const status of ["queued", "completed", "failed", "cancelled", "outcome_unknown"] as const) {
      expect(() => decide(run(status), { type: "cancel_requested" })).toThrow(`invalid_run_lifecycle_event:cancel_requested:${status}`);
    }
  });

  it("rejects a decision when either source status or phase is stale", () => {
    const current = run("running");
    const decision = decide(current, { type: "waiting" });
    expect(() => applyLifecycleTransition({ ...current, phase: "cancelling" }, decision, "2026-01-01T00:00:01.000Z")).toThrow("stale_run_transition");
  });
});
