import { describe, expect, it } from "vitest";
import type { BackendRunRecord } from "@samurai-agent/core-schemas";
import { RunLifecycle } from "../execution/run-lifecycle";
import { TurnCompletionCoordinator } from "./turn-completion-coordinator";
import type { AdmittedTurn, TurnOutput, TurnSettlementInput } from "./host-types";

describe("TurnCompletionCoordinator", () => {
  it("does not run Learning Review after a normal turn", async () => {
    const calls: string[] = [];
    const settled = completedRun();
    const coordinator = new TurnCompletionCoordinator(
      { commitTurnSettlement: async () => settled },
      {
        learningReview: { operationId: "learning-review", run: async () => { calls.push("learning-review"); } },
        telemetry: { operationId: "telemetry", run: async () => { calls.push("telemetry"); } }
      },
      { record: async () => undefined, logPersistenceFailure: () => undefined }
    );

    await coordinator.commitTurnSettlement({
      ...settlementInput(settled),
      admitted: admittedTurn(settled),
      turnOutput: { content: "done", events: [] }
    });

    expect(calls).toEqual(["telemetry"]);
  });

  it("keeps the committed result when independent post-turn work fails", async () => {
    const calls: string[] = [];
    const failures: string[] = [];
    const settled = completedRun();
    const coordinator = new TurnCompletionCoordinator(
      { commitTurnSettlement: async () => settled },
      {
        externalAssistSync: { operationId: "external-assist", run: async () => { calls.push("external-assist"); throw new Error("assist failed"); } },
        telemetry: { operationId: "telemetry", run: async () => { calls.push("telemetry"); } }
      },
      {
        record: async ({ operationId, eventType }) => { failures.push(`${eventType}:${operationId}`); },
        logPersistenceFailure: () => undefined
      },
      () => "2026-01-01T00:00:01.000Z"
    );

    const result = await coordinator.commitTurnSettlement({
      ...settlementInput(settled),
      admitted: admittedTurn(settled),
      turnOutput: { content: "done", events: [] }
    });

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["external-assist", "telemetry"]);
    expect(failures).toEqual(["host_post_turn_failed:external-assist"]);
  });
});

function completedRun(): BackendRunRecord {
  return { id: "run-1", session_id: "session-1", input_message_id: "message-1", backend_id: "mock", backend_kind: "mock", status: "completed", phase: "settled", current_attempt: 1, started_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T00:00:01.000Z", input_summary: "test", metadata: {} };
}

function admittedTurn(run: BackendRunRecord): AdmittedTurn {
  const envelope = { id: "envelope-1", source: "web" as const, actor_identity: "owner", session_key: "session-1", user_intent: "chat", attachments: [], input_locale: "ja" as const, output_locale: "ja" as const, metadata: {}, received_at: "2026-01-01T00:00:00.000Z" };
  return {
    request: { sessionId: run.session_id, content: "test", envelope, idempotencyKey: "key-1" },
    session: { id: run.session_id, session_key: "session-1", title: "Session", ui_locale: "ja", output_locale: "ja", created_at: envelope.received_at, updated_at: envelope.received_at },
    binding: { id: run.backend_id, kind: run.backend_kind, backend: { id: run.backend_id, kind: run.backend_kind, label: "Mock", runTurn: () => (async function* () {})() } },
    requestHash: "hash-1",
    reservation: { sessionId: run.session_id, runId: run.id, version: 1, status: "held" },
    userMessage: { id: run.input_message_id, session_id: run.session_id, role: "user", content: "test", input_locale: "ja", output_locale: "ja", created_at: envelope.received_at },
    run
  };
}

function settlementInput(run: BackendRunRecord): TurnSettlementInput {
  const evidence = { kind: "completed" as const, source: "owned_loop_return" as const };
  const { completed_at: _completedAt, ...unsettledBase } = run;
  const expectedRun: BackendRunRecord = { ...unsettledBase, status: "running", phase: "external_running" };
  const lifecycle = new RunLifecycle(() => "2026-01-01T00:00:01.000Z");
  const decision = lifecycle.decide(expectedRun, { type: "completed", evidence });
  const nextRun = lifecycle.apply(expectedRun, decision);
  return {
    expectedRun,
    nextRun,
    decision,
    terminalEvent: { id: "event-1", run_id: run.id, session_id: run.session_id, event_type: "run_completed", sequence: 1, attempt_no: 1, source_event_id: "terminal-1", payload: { terminal_evidence: evidence }, resource_refs: [], created_at: run.completed_at! },
    attemptNo: 1,
    sourceIdentity: { sourceEventId: "terminal-1" },
    terminalEvidence: evidence,
    outputSourceId: `message:${run.id}:output`,
    reservation: { sessionId: run.session_id, runId: run.id, version: 1, status: "held" }
  };
}
