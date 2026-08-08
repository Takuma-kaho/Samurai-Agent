import { type ApprovalRequest, type AuditRecord, type GrantRecord, type PolicyDecisionRecord, type RollbackPoint } from "@samurai-agent/core-schemas";
import type { ApprovalRequestsTable, AuditRecordsTable, GrantsTable, PolicyDecisionsTable, RollbackPointsTable } from "../kernel/workspace-db-schema";
import { parse } from "./serialization";

export function policyDecisionFromRow(row: PolicyDecisionsTable): PolicyDecisionRecord {
  return {
    id: row.id,
    operation_id: row.operation_id,
    capability_id: row.capability_id,
    operation: row.operation,
    decision: row.decision as PolicyDecisionRecord["decision"],
    reason: row.reason,
    policy_inputs: parse(row.policy_inputs_json),
    matched_rules: parse(row.matched_rules_json),
    required_approval_level: row.required_approval_level as PolicyDecisionRecord["required_approval_level"],
    grant_id: row.grant_id ?? undefined,
    created_at: row.created_at
  };
}
export function approvalRequestFromRow(row: ApprovalRequestsTable): ApprovalRequest {
  return {
    id: row.id,
    operation_id: row.operation_id,
    requested_level: row.requested_level as ApprovalRequest["requested_level"],
    status: row.status as ApprovalRequest["status"],
    reason: row.reason,
    requested_by: row.requested_by,
    decided_by: row.decided_by ?? undefined,
    created_at: row.created_at,
    expires_at: row.expires_at,
    decided_at: row.decided_at ?? undefined
  };
}

export function auditRecordFromRow(row: AuditRecordsTable): AuditRecord {
  return {
    id: row.id,
    actor_identity: row.actor_identity as AuditRecord["actor_identity"],
    participant_id: row.participant_id ?? undefined,
    participant_kind: row.participant_kind as AuditRecord["participant_kind"] | undefined,
    requested_by_participant_id: row.requested_by_participant_id ?? undefined,
    room_id: row.room_id ?? undefined,
    ...(row.principal_json ? { principal: parse(row.principal_json) } : {}),
    ...(row.source_json ? { source: parse(row.source_json) } : {}),
    ...(row.session_ref_json ? { session_ref: parse(row.session_ref_json) } : {}),
    operation_id: row.operation_id,
    capability_id: row.capability_id,
    instruction_source: row.instruction_source as AuditRecord["instruction_source"],
    inputs_summary: row.inputs_summary,
    outputs_summary: row.outputs_summary,
    ...(row.policy_decision_id ? { policy_decision_id: row.policy_decision_id } : {}),
    ...(row.room_access_scope ? { room_access_scope: row.room_access_scope as AuditRecord["room_access_scope"] } : {}),
    ...(row.room_access_action ? { room_access_action: row.room_access_action } : {}),
    ...(row.room_access_allowed === null ? {} : { room_access_allowed: row.room_access_allowed === 1 }),
    ...(row.room_access_reason ? { room_access_reason: row.room_access_reason } : {}),
    affected_resources: parse(row.affected_resources_json),
    rollback_point_id: row.rollback_point_id ?? undefined,
    created_at: row.created_at
  };
}

export function rollbackPointFromRow(row: RollbackPointsTable): RollbackPoint {
  return {
    id: row.id,
    operation_id: row.operation_id,
    affected_resources: parse(row.affected_resources_json),
    before_snapshot: parse(row.before_snapshot_json),
    after_snapshot: parse(row.after_snapshot_json),
    reversible: row.reversible === 1,
    irreversible_effects: parse(row.irreversible_effects_json),
    created_at: row.created_at,
    expires_at: row.expires_at
  };
}

export function grantFromRow(row: GrantsTable): GrantRecord {
  return {
    id: row.id,
    capability_id: row.capability_id,
    operation: row.operation,
    actor_identity: row.actor_identity as GrantRecord["actor_identity"],
    channel: row.channel,
    resource_scope: row.resource_scope,
    manifest_version: row.manifest_version,
    risk_snapshot: row.risk_snapshot as GrantRecord["risk_snapshot"],
    scope_snapshot: row.scope_snapshot as GrantRecord["scope_snapshot"],
    external_impact_snapshot: row.external_impact_snapshot === 1,
    secret_requirement_snapshot: row.secret_requirement_snapshot,
    granted_by: row.granted_by,
    reason: row.reason,
    created_at: row.created_at,
    expires_at: row.expires_at ?? undefined,
    revoked_at: row.revoked_at ?? undefined
  };
}
