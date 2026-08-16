import { describe, expect, it } from "vitest";
import { WorkspaceServerError } from "./errors";
import {
  assertSafeLearningPayload,
  classifyLearningActivity,
  rankKnowledgeForCurrentRoom,
  validateWorkspaceKnowledgeReviewResult,
  type WorkspaceKnowledgeReviewSnapshot
} from "./workspace-learning-policy";
import type { WorkspaceLearningResource } from "./types";

const now = "2026-08-15T00:00:00.000Z";

describe("Workspace learning policy", () => {
  it("does not send unfinished, cancelled, or speculative work to review", () => {
    expect(classifyLearningActivity({
      outcome: "completed", verificationState: "not_run", failureState: "none", explicitRemember: false
    })).toMatchObject({ eligible: false, priority: "normal" });
    expect(classifyLearningActivity({
      outcome: "cancelled", verificationState: "unknown", failureState: "unresolved", explicitRemember: false
    })).toMatchObject({ eligible: false, priority: "normal" });
    expect(classifyLearningActivity({
      outcome: "cancelled", verificationState: "unknown", failureState: "none", explicitRemember: true,
      learningUseOutcomeKnown: true
    })).toMatchObject({ eligible: false, priority: "normal" });
    expect(classifyLearningActivity({
      outcome: "outcome_unknown", verificationState: "unknown", failureState: "none", explicitRemember: false,
      correctionOfActivityId: "activity_original"
    })).toMatchObject({ eligible: true, priority: "high", reasons: ["human_correction"] });
    expect(classifyLearningActivity({
      outcome: "completed", verificationState: "not_run", failureState: "resolved", explicitRemember: false,
      finalizedResource: true, reusableCompletion: true
    })).toMatchObject({ eligible: false });
  });

  it("ranks only matching Knowledge in the fixed three-layer order", () => {
    const results = rankKnowledgeForCurrentRoom({
      query: "deploy",
      workspaceRules: [resource("rule", "Always deploy", "Rule", { kind: "workspace" }, true)],
      roomKnowledge: [resource("room", "Deploy to staging", "Room", { kind: "room", roomId: "room_current" })],
      workspaceKnowledge: [
        resource("workspace", "Deploy overview", "Common", { kind: "workspace" }),
        resource("unrelated", "Expense policy", "No match", { kind: "workspace" })
      ],
      limit: 10
    });
    expect(results.map((item) => item.id)).toEqual(["rule", "room", "workspace"]);
  });

  it("keeps a fixed item intact while accepting a separately recorded conflict candidate", () => {
    const fixed = { ...resource("resource_fixed", "Fixed procedure", "Human-approved", { kind: "room", roomId: "room_current" }), aiUpdateLocked: true };
    const snapshot: WorkspaceKnowledgeReviewSnapshot = {
      workspaceId: "workspace_one",
      roomId: "room_current",
      activities: [{
        id: "activity_one", instructionSummary: "Correct the procedure", outcome: "completed",
        verificationState: "confirmed", failureState: "none", explicitRemember: false, payload: {}
      }],
      workspaceRules: [], workspaceKnowledge: [], roomKnowledge: [fixed]
    };
    expect(validateWorkspaceKnowledgeReviewResult(snapshot, {
      reviewer: "test", summary: "conflict found", mutations: [{
        kind: "conflict", resourceId: fixed.id, expectedVersion: fixed.version,
        title: "Alternative procedure", content: "Different evidence", reason: "Contradictory verified result",
        confidence: 0.7, evidenceActivityIds: ["activity_one"]
      }]
    }).mutations).toHaveLength(1);
  });

  it("rejects a review attempt to update another Room or persist a credential", () => {
    const snapshot: WorkspaceKnowledgeReviewSnapshot = {
      workspaceId: "workspace_one", roomId: "room_current", activities: [{
        id: "activity_one", instructionSummary: "Work", outcome: "completed",
        verificationState: "confirmed", failureState: "none", explicitRemember: false, payload: {}
      }],
      workspaceRules: [], workspaceKnowledge: [], roomKnowledge: []
    };
    expect(() => validateWorkspaceKnowledgeReviewResult(snapshot, {
      reviewer: "test", summary: "bad", mutations: [{
        kind: "update", resourceId: "resource_other_room", expectedVersion: 1,
        title: "Bad", content: "Bad", reason: "Bad", evidenceActivityIds: ["activity_one"]
      }]
    })).toThrow("workspace_learning_review_cross_room_resource_denied");
    expect(() => assertSafeLearningPayload({ api_key: "not-allowed" })).toThrow(WorkspaceServerError);
    expect(() => assertSafeLearningPayload([])).toThrow("workspace_learning_payload_invalid");
    expect(() => validateWorkspaceKnowledgeReviewResult(snapshot, {
      reviewer: "test", summary: "bad evidence", mutations: [{
        kind: "no_change", reason: "Nothing reusable", evidenceActivityIds: "activity_one"
      }]
    } as unknown as Parameters<typeof validateWorkspaceKnowledgeReviewResult>[1])).toThrow("workspace_learning_review_evidence_invalid");
    expect(() => validateWorkspaceKnowledgeReviewResult(snapshot, {
      reviewer: `sk-${"a".repeat(24)}`, summary: "bad", mutations: []
    })).toThrow("workspace_learning_secret_content_forbidden");
  });

  it("keeps only the declared mutation fields before a model result becomes job history", () => {
    const snapshot: WorkspaceKnowledgeReviewSnapshot = {
      workspaceId: "workspace_one", roomId: "room_current", activities: [],
      workspaceRules: [], workspaceKnowledge: [], roomKnowledge: []
    };
    const reviewed = validateWorkspaceKnowledgeReviewResult(snapshot, {
      reviewer: "test", summary: "No durable change", mutations: [{
        kind: "no_change", reason: "Nothing reusable", evidenceActivityIds: [],
        injected_secret: `sk-${"a".repeat(24)}`
      }]
    } as unknown as Parameters<typeof validateWorkspaceKnowledgeReviewResult>[1]);
    expect(reviewed.mutations).toEqual([{ kind: "no_change", reason: "Nothing reusable", evidenceActivityIds: [] }]);
  });

  it("requires confidence for new AI Knowledge and optimistic version for evidence-only changes", () => {
    const target = resource("resource_room", "Deploy", "Known", { kind: "room", roomId: "room_current" });
    const snapshot: WorkspaceKnowledgeReviewSnapshot = {
      workspaceId: "workspace_one", roomId: "room_current", activities: [{
        id: "activity_one", instructionSummary: "Verified", outcome: "completed", verificationState: "confirmed",
        failureState: "none", explicitRemember: false, payload: {}
      }], workspaceRules: [], workspaceKnowledge: [], roomKnowledge: [target]
    };
    expect(() => validateWorkspaceKnowledgeReviewResult(snapshot, {
      reviewer: "test", summary: "create", mutations: [{
        kind: "create", resourceKind: "knowledge", title: "New", content: "Verified", reason: "Evidence", evidenceActivityIds: ["activity_one"]
      }]
    })).toThrow("workspace_learning_review_create_invalid");
    expect(() => validateWorkspaceKnowledgeReviewResult(snapshot, {
      reviewer: "test", summary: "append", mutations: [{
        kind: "evidence_append", resourceId: target.id, reason: "Evidence", evidenceActivityIds: ["activity_one"]
      }]
    })).toThrow("workspace_learning_review_evidence_append_invalid");
  });

  it("does not inject conflict rows into search context", () => {
    const conflict = { ...resource("conflict", "Deploy", "Candidate", { kind: "room", roomId: "room_current" }), state: "conflict" as const };
    expect(rankKnowledgeForCurrentRoom({ query: "deploy", workspaceRules: [], workspaceKnowledge: [], roomKnowledge: [conflict], limit: 10 })).toEqual([]);
  });
});

function resource(
  id: string,
  title: string,
  content: string,
  scope: WorkspaceLearningResource["scope"],
  isAbsoluteRule = false
): WorkspaceLearningResource {
  return {
    workspaceId: "workspace_one", id, scope,
    kind: isAbsoluteRule ? "workspace_rule" : "knowledge",
    state: "active", isAbsoluteRule, aiUpdateLocked: false,
    title, content, payload: {}, version: 1,
    createdBy: "account_owner", updatedBy: "account_owner",
    createdAt: now, updatedAt: now
  };
}
