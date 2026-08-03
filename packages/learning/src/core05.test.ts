import { nowIso, type BackendRunRecord, type MessageRecord } from "@samurai-agent/core-schemas";
import { describe, expect, it } from "vitest";
import {
  Core05BackgroundReviewMutationSchema,
  deriveLearningCandidateSignals,
  learningBudgetDecision,
  restrictCore05BackgroundReviewResult
} from "./core05.js";

describe("Core 05 learning contract", () => {
  it("does not create a candidate signal from an ordinary Run", () => {
    expect(deriveLearningCandidateSignals(bundle("普通の会話です。"))).toEqual([]);
  });

  it("keeps correction and negation as typed candidate signals", () => {
    const kinds = deriveLearningCandidateSignals(bundle("これは違うので訂正してください。"))
      .map((signal) => signal.kind);
    expect(kinds).toEqual(expect.arrayContaining(["user_correction", "user_negation"]));
  });

  it("forces an inferred experience rule to the source Room and limited use", () => {
    const result = restrictCore05BackgroundReviewResult({
      result: {
        reviewer: "fixture",
        summary: "rule",
        mutations: [{
          kind: "experience_rule_create",
          title: "Rule",
          summary: "summary",
          conditions: ["condition"],
          recommended_action: "action",
          predicted_result: "result",
          reason: "evidence",
          evidence_refs: [{ kind: "backend_run", id: "run-1", uri: "workspace://run-1" }],
          usage_scope: { kind: "room", room_id: "other-room" },
          evidence_state: "direct_confirmed",
          usage_state: "normal"
        }]
      },
      snapshot: reviewSnapshot(),
      activityContext: { room_id: "room-1", session_id: "session-1", agent_id: "agent-1" },
      hasExplicitRuleInstruction: false,
      hasExplicitMemoryInstruction: false
    });
    expect(result.mutations[0]).toMatchObject({
      usage_scope: { kind: "room", room_id: "room-1" },
      evidence_state: "inferred",
      usage_state: "limited"
    });
  });

  it("accepts direct normal use only for an explicit rule instruction", () => {
    const result = restrictCore05BackgroundReviewResult({
      result: {
        reviewer: "fixture",
        summary: "rule",
        mutations: [{
          kind: "experience_rule_create",
          title: "Rule",
          summary: "summary",
          conditions: ["condition"],
          recommended_action: "action",
          predicted_result: "result",
          reason: "explicit instruction",
          evidence_refs: [{ kind: "message", id: "message-1", uri: "workspace://message-1" }],
          usage_scope: { kind: "room", room_id: "room-1" },
          evidence_state: "direct_confirmed",
          usage_state: "limited"
        }]
      },
      snapshot: reviewSnapshot("このRoomに保存して、ルール化してください。"),
      activityContext: { room_id: "room-1", session_id: "session-1", agent_id: "agent-1" },
      hasExplicitRuleInstruction: true,
      hasExplicitMemoryInstruction: false
    });
    expect(result.mutations[0]).toMatchObject({
      usage_scope: { kind: "room", room_id: "room-1" },
      evidence_state: "direct_confirmed",
      usage_state: "normal"
    });
  });

  it("drops a mutation whose evidence was not supplied by this Room", () => {
    const result = restrictCore05BackgroundReviewResult({
      result: {
        reviewer: "fixture",
        summary: "foreign evidence",
        mutations: [{
          kind: "memory_create",
          topic: "Foreign",
          content: "Must not be admitted.",
          reason: "invented foreign run",
          evidence_refs: [{ kind: "backend_run", id: "run-room-b", uri: "workspace://backend-runs/run-room-b" }],
          usage_scope: { kind: "room", room_id: "room-b" },
          evidence_state: "direct_confirmed",
          usage_state: "normal"
        }]
      },
      snapshot: reviewSnapshot(),
      activityContext: { room_id: "room-1", session_id: "session-1", agent_id: "agent-1" },
      hasExplicitRuleInstruction: false,
      hasExplicitMemoryInstruction: false
    });
    expect(result.mutations).toEqual([]);
  });

  it("does not admit delete, archive, merge, or Scope-expansion mutations", () => {
    for (const kind of ["memory_delete", "resource_archive", "resource_merge", "scope_expand"]) {
      expect(Core05BackgroundReviewMutationSchema.safeParse({ kind }).success).toBe(false);
    }
  });

  it("defers review when a configured budget is exceeded without mixing units", () => {
    const source = { ...bundle("覚えて").backend_run, metadata: { cost: 100 } };
    const decision = learningBudgetDecision({
      normal_runs: [source],
      source_run: source,
      ratio: 0,
      window_days: 7,
      already_spent: []
    });
    expect(decision).toMatchObject({ allowed: false, unit: "currency", deferred_reason: "learning_budget_exceeded" });
  });
});

function reviewSnapshot(content = "rule evidence") {
  return {
    evidence: bundle(content),
    pending_room_evidence: [],
    memory_catalog: [],
    knowledge_catalog: [],
    skill_catalog: [],
    applied_resources: []
  };
}

function bundle(content: string) {
  const now = nowIso();
  const input: MessageRecord = {
    id: "message-1",
    session_id: "session-1",
    role: "user",
    content,
    input_locale: "ja",
    output_locale: "ja",
    created_at: now
  };
  const backend_run: BackendRunRecord = {
    id: "run-1",
    session_id: "session-1",
    agent_id: "agent-1",
    input_message_id: input.id,
    backend_id: "fixture",
    backend_kind: "external",
    status: "completed",
    started_at: now,
    completed_at: now,
    input_summary: content,
    metadata: {}
  };
  return {
    backend_run,
    activity_context: { room_id: "room-1", session_id: "session-1", agent_id: "agent-1" },
    input_message: input,
    backend_events: [],
    tool_runs: [],
    workspace_changes: [],
    used_learning_resources: []
  };
}
