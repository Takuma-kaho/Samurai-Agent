import { describe, expect, it } from "vitest";
import { WorkspaceServerError } from "./errors";
import {
  assertAutomaticLearningResourceScope,
  assertSafeLearningPayload,
  assertWorkspaceMemoryAllowed,
  classifyLearningActivity,
  rankKnowledgeForCurrentRoom,
  resolveWorkspaceLearningSettings,
  validateWorkspaceKnowledgeReviewResult,
  type WorkspaceKnowledgeReviewSnapshot
} from "./workspace-learning-policy";
import type { WorkspaceLearningResource, WorkspaceLearningSettings } from "./types";

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

  it("ranks only matching Room Knowledge and Workspace policy", () => {
    const results = rankKnowledgeForCurrentRoom({
      query: "deploy",
      workspaceRules: [resource("rule", "Always deploy", "Rule", { kind: "workspace" }, true)],
      roomKnowledge: [resource("room", "Deploy to staging", "Room", { kind: "room", roomId: "room_current" })],
      workspaceKnowledge: [],
      limit: 10
    });
    expect(results.map((item) => item.id)).toEqual(["rule", "room"]);
  });

  it("rejects removed Workspace Knowledge/Memory and fixes automatic output to one Room", () => {
    expect(() => assertWorkspaceMemoryAllowed({ kind: "workspace" }, "knowledge")).toThrow("workspace_memory_removed");
    expect(() => assertWorkspaceMemoryAllowed({ kind: "workspace" }, "memory")).toThrow("workspace_memory_removed");
    expect(() => rankKnowledgeForCurrentRoom({
      query: "deploy", workspaceRules: [], roomKnowledge: [],
      workspaceKnowledge: [resource("removed", "Removed", "old", { kind: "workspace" })], limit: 10
    })).toThrow("workspace_memory_removed");
    expect(() => assertAutomaticLearningResourceScope({ kind: "workspace" }, "room_current"))
      .toThrow("workspace_learning_auto_resource_scope_invalid");
    expect(() => assertAutomaticLearningResourceScope({ kind: "room", roomId: "other_room" }, "room_current"))
      .toThrow("workspace_learning_auto_resource_scope_invalid");
  });

  it("inherits only enabled while keeping Room model, budget, and usage", () => {
    const workspace = settings({ kind: "workspace" }, true, "workspace-model", 10, 100, 3, 30);
    const room = settings({ kind: "room", roomId: "room_current" }, false, "room-model", 20, 200, 7, 70, true);
    const inherited = resolveWorkspaceLearningSettings({ workspace, room });
    expect(inherited.effective).toMatchObject({
      enabled: true,
      enabledInheritsWorkspace: true,
      model: "room-model",
      currencyLimit: 20,
      tokenLimit: 200,
      currencyUsed: 7,
      tokensUsed: 70
    });

    const overridden = resolveWorkspaceLearningSettings({
      workspace,
      room: settings({ kind: "room", roomId: "room_current" }, false, "room-model", 20, 200, 7, 70, false)
    });
    expect(overridden.effective.enabled).toBe(false);
    expect(overridden.effective.enabledInheritsWorkspace).toBe(false);
    expect(overridden.effective.currencyUsed).toBe(7);
    expect(overridden.effective.tokensUsed).toBe(70);
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

function settings(
  scope: WorkspaceLearningSettings["scope"],
  enabled: boolean,
  model: string,
  currencyLimit: number,
  tokenLimit: number,
  currencyUsed: number,
  tokensUsed: number,
  enabledInheritsWorkspace = false
): WorkspaceLearningSettings {
  return {
    workspaceId: "workspace_one",
    id: scope.kind === "room" ? `room:${scope.roomId}` : "workspace",
    scope,
    enabled,
    model,
    currencyLimit,
    tokenLimit,
    currencyUsed,
    tokensUsed,
    currencyReserved: 1,
    tokensReserved: 10,
    version: 1,
    updatedBy: "account_owner",
    updatedAt: now,
    ...(enabledInheritsWorkspace ? { enabledInheritsWorkspace } : {})
  } as WorkspaceLearningSettings;
}
