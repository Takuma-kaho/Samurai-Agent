import { describe, expect, it } from "vitest";
import { WorkspaceServerError } from "./errors";
import {
  classifyWorkspaceCompletionActivity,
  containsWorkspaceCompletionSecret,
  evaluateWorkspaceCompletionPolicies,
  validateWorkspaceCompletionPolicyRules,
  validateWorkspaceCompletionReviewResult
} from "./workspace-completion-policy";

describe("Workspace completion policy", () => {
  it("rejects OAuth client secrets in human-readable completion content", () => {
    expect(containsWorkspaceCompletionSecret('{"client_secret":"must-not-persist"}')).toBe(true);
    expect(containsWorkspaceCompletionSecret("client-secret: must-not-persist")).toBe(true);
    expect(containsWorkspaceCompletionSecret('{"oauth_client_secret":"must-not-persist"}')).toBe(true);
  });

  it("does not treat a caller's verified claim as deterministic learning evidence", () => {
    expect(classifyWorkspaceCompletionActivity({
      outcome: "completed", verificationOutcome: "confirmed", failureState: "none", explicitRemember: false, payload: {}
    })).toEqual({ eligible: false, priority: "normal", reasons: [] });
    expect(classifyWorkspaceCompletionActivity({
      outcome: "cancelled", verificationOutcome: "unknown", failureState: "none", explicitRemember: true, payload: {}
    }).eligible).toBe(false);
    expect(classifyWorkspaceCompletionActivity({
      outcome: "failed", verificationOutcome: "failed", failureState: "unresolved", explicitRemember: false, payload: {}
    }).eligible).toBe(false);
  });

  it("does not let a Room allow undo a Workspace deny or require", () => {
    const decision = evaluateWorkspaceCompletionPolicies([
      { id: "workspace_deny", operation: "resource.create", effect: "deny", conditions: {} }
    ], [
      { id: "room_allow", operation: "resource.create", effect: "allow", conditions: {} }
    ], { operation: "resource.create", accountId: "account_a", callerKind: "human", attributes: {}, baseAllowed: true });
    expect(decision).toEqual({ allowed: false, required: [], deniedBy: ["workspace_deny"] });
  });

  it("uses only the trusted caller classification for connection rules", () => {
    const rules = [{
      id: "deny_connection", operation: "resource.create" as const, effect: "deny" as const,
      connectionId: "connection_probe", conditions: { caller_kind: "connection" }
    }];
    expect(evaluateWorkspaceCompletionPolicies(rules, [], {
      operation: "resource.create", accountId: "account_a", callerKind: "human", connectionId: undefined,
      attributes: { caller_kind: "connection", connection_id: "connection_probe" }, baseAllowed: true
    })).toEqual({ allowed: true, required: [], deniedBy: [] });
    expect(evaluateWorkspaceCompletionPolicies(rules, [], {
      operation: "resource.create", accountId: "account_a", callerKind: "connection", connectionId: "connection_probe",
      attributes: {}, baseAllowed: true
    })).toEqual({ allowed: false, required: [], deniedBy: ["deny_connection"] });
  });

  it("accepts finite string, boolean, and numeric fixed conditions", () => {
    expect(validateWorkspaceCompletionPolicyRules([{
      id: "only_human", operation: "policy.apply", effect: "require", conditions: { human: true, source: "native", retries: 3 }
    }])).toEqual([{
      id: "only_human", operation: "policy.apply", effect: "require", conditions: { human: true, source: "native", retries: 3 }
    }]);
  });

  it("returns repair-shaped 422 details without accepting an incomplete Skill", () => {
    try {
      validateWorkspaceCompletionReviewResult({
        workspaceId: "workspace_a", roomId: "room_a", episodeId: "episode_a", activities: [{ id: "activity_a" } as never], resources: []
      }, {
        reviewer: "reviewer", summary: "", candidates: [{
          kind: "skill", resourceKind: "skill", title: "Skill", content: "body", metadata: { when: "now" }, evidenceActivityIds: ["activity_a"], reason: "reuse"
        }]
      });
      throw new Error("expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceServerError);
      expect((error as WorkspaceServerError).status).toBe(422);
      expect((error as WorkspaceServerError).details?.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "$.candidates[0].metadata.steps", code: "required" })
      ]));
    }
  });
});
