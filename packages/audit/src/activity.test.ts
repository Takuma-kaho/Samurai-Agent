import { describe, expect, it } from "vitest";
import type { ApprovalRequest, AuditRecord, OperationRecord, PolicyDecisionRecord, RollbackPoint } from "@samurai-agent/core-schemas";
import { buildActivityInboxItems } from "./index";

const now = "2026-06-19T00:00:00.000Z";

describe("activity read model", () => {
  it("keeps pending approval to one item per operation and prefers the linked request", () => {
    const operation = operationRecord({ approval_request_id: "approval_linked", status: "pending_approval" });
    const items = buildActivityInboxItems({
      approvals: [
        approvalRequest({ id: "approval_old", operation_id: operation.id, created_at: "2026-06-19T00:01:00.000Z" }),
        approvalRequest({ id: "approval_linked", operation_id: operation.id, created_at: now })
      ],
      operations: [operation],
      decisions: [],
      audits: [],
      rollbacks: []
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.activity_type).toBe("approval_required");
    expect(items[0]?.approval_request_id).toBe("approval_linked");
  });

  it("does not show allow_with_audit as auto run unless the operation completed", () => {
    const operation = operationRecord({ status: "deferred" });
    const decision = policyDecision({ operation_id: operation.id, decision: "allow_with_audit" });
    const items = buildActivityInboxItems({
      approvals: [],
      operations: [operation],
      decisions: [decision],
      audits: [auditRecord({ operation_id: operation.id, policy_decision_id: decision.id })],
      rollbacks: [],
    });

    expect(items.some((item) => item.activity_type === "auto_run")).toBe(false);
  });

  it("shows failure, rollback expiry, and approval without boundary-change duplicates", () => {
    const approvalOperation = operationRecord({ id: "operation_approval", approval_request_id: "approval_1", status: "pending_approval" });
    const failedOperation = operationRecord({ id: "operation_failed", status: "failed", error: "Tool failed." });
    const rollback: RollbackPoint = {
      id: "rollback_1",
      operation_id: failedOperation.id,
      affected_resources: [],
      before_snapshot: {},
      after_snapshot: {},
      reversible: true,
      irreversible_effects: [],
      created_at: now,
      expires_at: new Date(Date.now() + 1000).toISOString()
    };

    const items = buildActivityInboxItems({
      approvals: [approvalRequest({ id: "approval_1", operation_id: approvalOperation.id })],
      operations: [approvalOperation, failedOperation],
      decisions: [],
      audits: [],
      rollbacks: [rollback]
    });

    expect(items.map((item) => item.activity_type)).toContain("approval_required");
    expect(items.map((item) => item.activity_type)).toContain("failure");
    expect(items.map((item) => item.activity_type)).toContain("rollback_expiring");
    expect(items.map((item) => item.activity_type)).not.toContain("boundary_change");
  });
});

function operationRecord(patch: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "operation_1",
    session_id: "session_1",
    capability_id: "proposal_workspace",
    operation: "external.send",
    actor_identity: "owner",
    instruction_source: "owner_instruction",
    instruction_authority: "owner",
    channel: "web",
    input_hash: "hash",
    target_resource_refs: [],
    proposed_effects: ["Prepare outbound action."],
    status: "pending_approval",
    created_at: now,
    updated_at: now,
    ...patch
  };
}

function approvalRequest(patch: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval_1",
    operation_id: "operation_1",
    requested_level: "approval",
    status: "pending",
    reason: "Needs approval.",
    requested_by: "runtime",
    created_at: now,
    expires_at: "2026-06-20T00:00:00.000Z",
    ...patch
  };
}

function policyDecision(patch: Partial<PolicyDecisionRecord> = {}): PolicyDecisionRecord {
  return {
    id: "policy_1",
    operation_id: "operation_1",
    capability_id: "proposal_workspace",
    operation: "memory.topic.create",
    decision: "allow_with_audit",
    reason: "Visible audit.",
    policy_inputs: {
      capability_id: "proposal_workspace",
      operation: "memory.topic.create",
      actor_identity: "owner",
      instruction_source: "owner_instruction",
      instruction_authority: "owner",
      channel: "web",
      target_resource_refs: [],
      proposed_effects: [],
      prior_grants: [],
      recent_history: [],
      input_hash: "hash"
    },
    matched_rules: [],
    required_approval_level: "none",
    created_at: now,
    ...patch
  };
}

function auditRecord(patch: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: "audit_1",
    actor_identity: "owner",
    operation_id: "operation_1",
    capability_id: "proposal_workspace",
    instruction_source: "owner_instruction",
    inputs_summary: "input",
    outputs_summary: "output",
    policy_decision_id: "policy_1",
    affected_resources: [],
    created_at: now,
    ...patch
  };
}
