import { describe, expect, it } from "vitest";
import { actualLearningResourceUses, decideSkillLifecycle, evaluateLearningEffect, learningRetryDelayMs, preferredSessionSearchMode, standardLearningJobDefinitions } from "./index";

describe("learning foundation", () => {
  it("separates selected resources from actual reads", () => {
    const base = {
      id: "use_1",
      run_id: "run_1",
      session_id: "session_1",
      resource_kind: "skill" as const,
      resource_id: "skill_1",
      metadata: {},
      created_at: "2026-07-10T00:00:00.000Z"
    };
    expect(actualLearningResourceUses([
      { ...base, stage: "selected" },
      { ...base, id: "use_2", stage: "body_loaded" }
    ])).toHaveLength(1);
  });

  it("prefers trigram search for Japanese", () => {
    expect(preferredSessionSearchMode({ query: "過去会話", trigramAvailable: true, ftsAvailable: true })).toBe("fts5_trigram");
    expect(preferredSessionSearchMode({ query: "workspace", trigramAvailable: true, ftsAvailable: true })).toBe("fts5");
  });

  it("keeps positive evidence and patches harmful Skills before archive", () => {
    const evaluation = (assessment: "helpful" | "harmful") => ({
      id: `evaluation_${assessment}`,
      learning_resource_ref: { kind: "skill", id: "skill_1", uri: "skills/skill_1" },
      task_class: "workspace_task",
      compared_run_ids: ["run_1"],
      before_metrics: {}, after_metrics: {}, effect_estimate: assessment === "helpful" ? 1 : -1,
      confidence: 0.8, assessment, evidence_refs: [], evaluator: "test", created_at: "2026-07-10T00:00:00.000Z"
    });
    const base = { state: "active", owner_pinned: false, usage_count: 1, last_activity_at: "2025-01-01T00:00:00.000Z", now: "2026-07-10T00:00:00.000Z", stale_after_days: 30, archive_after_days: 90 };
    expect(decideSkillLifecycle({ ...base, evaluations: [evaluation("helpful")] }).decision).toBe("keep");
    expect(decideSkillLifecycle({ ...base, evaluations: [evaluation("harmful")] }).decision).toBe("patch");
  });

  it("expresses insufficient evidence without inventing an Outcome", () => {
    const evaluation = evaluateLearningEffect({
      id: "evaluation_1",
      resource_ref: { kind: "skill", id: "skill_1", uri: "skills/skill_1" },
      task_class: "workspace_task",
      before: [],
      after: [{ run_id: "run_1", completed: 1, tool_failure_rate: 0, waiting_or_retry_rate: 0, workspace_change_count: 1, artifact_regeneration_count: 0, correction_count: 0 }],
      evidence_refs: [],
      created_at: "2026-07-10T00:00:00.000Z"
    });
    expect(evaluation.assessment).toBe("insufficient_evidence");
    expect(evaluation).not.toHaveProperty("outcome");
  });

  it("keeps learning jobs separate and uses capped exponential retry", () => {
    expect(standardLearningJobDefinitions).toEqual([]);
    expect(learningRetryDelayMs(2)).toBe(10 * 60_000);
    expect(learningRetryDelayMs(99)).toBe(160 * 60_000);
  });
});
