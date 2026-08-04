import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type ApprovalRequest, type AuditRecord, type GrantRecord, type PolicyDecisionRecord, type RollbackPoint } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import { approvalRequestFromRow, auditRecordFromRow, grantFromRow, policyDecisionFromRow, rollbackPointFromRow } from "./access-history-row-codecs";
import { stringify } from "./serialization";

/** Policy decisions, access records, grants, and rollback history. */
export class AccessHistoryRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>, private readonly rootDir: string) {}

  async savePolicyDecision(decision: PolicyDecisionRecord): Promise<PolicyDecisionRecord> {
    await this.db
      .insertInto("policy_decisions")
      .values({
        id: decision.id,
        operation_id: decision.operation_id,
        capability_id: decision.capability_id,
        operation: decision.operation,
        decision: decision.decision,
        reason: decision.reason,
        policy_inputs_json: stringify(decision.policy_inputs),
        matched_rules_json: stringify(decision.matched_rules),
        required_approval_level: decision.required_approval_level,
        grant_id: decision.grant_id ?? null,
        created_at: decision.created_at
      })
      .execute();
    return decision;
  }

  async listPolicyDecisions(): Promise<PolicyDecisionRecord[]> {
    const rows = await this.db.selectFrom("policy_decisions").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(policyDecisionFromRow);
  }

  /** Reads policy history only after its owning operations were Room-scoped. */
  async listPolicyDecisionsForOperationIds(operationIds: readonly string[]): Promise<PolicyDecisionRecord[]> {
    if (operationIds.length === 0) return [];
    const rows = await this.db.selectFrom("policy_decisions").selectAll()
      .where("operation_id", "in", operationIds)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(policyDecisionFromRow);
  }

  async getPolicyDecision(id: string): Promise<PolicyDecisionRecord | undefined> {
    const row = await this.db.selectFrom("policy_decisions").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? policyDecisionFromRow(row) : undefined;
  }

  async saveApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    await this.db
      .insertInto("approval_requests")
      .values({
        id: request.id,
        operation_id: request.operation_id,
        requested_level: request.requested_level,
        status: request.status,
        reason: request.reason,
        requested_by: request.requested_by,
        decided_by: request.decided_by ?? null,
        created_at: request.created_at,
        expires_at: request.expires_at,
        decided_at: request.decided_at ?? null
      })
      .execute();
    return request;
  }

  async updateApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    await this.db
      .updateTable("approval_requests")
      .set({
        requested_level: request.requested_level,
        status: request.status,
        reason: request.reason,
        requested_by: request.requested_by,
        decided_by: request.decided_by ?? null,
        expires_at: request.expires_at,
        decided_at: request.decided_at ?? null
      })
      .where("id", "=", request.id)
      .execute();
    return request;
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    const row = await this.db.selectFrom("approval_requests").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? approvalRequestFromRow(row) : undefined;
  }

  async listApprovalRequests(): Promise<ApprovalRequest[]> {
    const rows = await this.db.selectFrom("approval_requests").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(approvalRequestFromRow);
  }

  /** Reads approval history only after its owning operations were Room-scoped. */
  async listApprovalRequestsForOperationIds(operationIds: readonly string[]): Promise<ApprovalRequest[]> {
    if (operationIds.length === 0) return [];
    const rows = await this.db.selectFrom("approval_requests").selectAll()
      .where("operation_id", "in", operationIds)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(approvalRequestFromRow);
  }

  async saveAuditRecord(record: AuditRecord): Promise<AuditRecord> {
    await this.db
      .insertInto("audit_records")
      .values({
        id: record.id,
        actor_identity: record.actor_identity,
        participant_id: record.participant_id ?? null,
        participant_kind: record.participant_kind ?? null,
        requested_by_participant_id: record.requested_by_participant_id ?? null,
        room_id: record.room_id ?? null,
        operation_id: record.operation_id,
        capability_id: record.capability_id,
        instruction_source: record.instruction_source,
        inputs_summary: record.inputs_summary,
        outputs_summary: record.outputs_summary,
        policy_decision_id: record.policy_decision_id ?? null,
        room_access_scope: record.room_access_scope ?? null,
        room_access_action: record.room_access_action ?? null,
        room_access_allowed: record.room_access_allowed === undefined ? null : record.room_access_allowed ? 1 : 0,
        room_access_reason: record.room_access_reason ?? null,
        affected_resources_json: stringify(record.affected_resources),
        rollback_point_id: record.rollback_point_id ?? null,
        created_at: record.created_at
      })
      .execute();
    return record;
  }

  async updateAuditRecord(record: AuditRecord): Promise<AuditRecord> {
    await this.db
      .updateTable("audit_records")
      .set({
        actor_identity: record.actor_identity,
        participant_id: record.participant_id ?? null,
        participant_kind: record.participant_kind ?? null,
        requested_by_participant_id: record.requested_by_participant_id ?? null,
        room_id: record.room_id ?? null,
        capability_id: record.capability_id,
        instruction_source: record.instruction_source,
        inputs_summary: record.inputs_summary,
        outputs_summary: record.outputs_summary,
        policy_decision_id: record.policy_decision_id ?? null,
        room_access_scope: record.room_access_scope ?? null,
        room_access_action: record.room_access_action ?? null,
        room_access_allowed: record.room_access_allowed === undefined ? null : record.room_access_allowed ? 1 : 0,
        room_access_reason: record.room_access_reason ?? null,
        affected_resources_json: stringify(record.affected_resources),
        rollback_point_id: record.rollback_point_id ?? null
      })
      .where("id", "=", record.id)
      .execute();
    return record;
  }

  async listAuditRecords(): Promise<AuditRecord[]> {
    const rows = await this.db.selectFrom("audit_records").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(auditRecordFromRow);
  }

  /** Room-scoped audit history query; avoids reading other Rooms before filtering. */
  async listAuditRecordsForRoom(roomId: string): Promise<AuditRecord[]> {
    const rows = await this.db.selectFrom("audit_records").selectAll()
      .where("room_id", "=", roomId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(auditRecordFromRow);
  }

  async listAuditRecordsForOperation(operationId: string): Promise<AuditRecord[]> {
    const rows = await this.db.selectFrom("audit_records").selectAll().where("operation_id", "=", operationId).orderBy("created_at", "desc").execute();
    return rows.map(auditRecordFromRow);
  }

  async saveRollbackPoint(point: RollbackPoint): Promise<RollbackPoint> {
    const filePath = path.join(this.rootDir, "rollback", `${point.id}.json`);
    await writeFile(filePath, JSON.stringify(point, null, 2));
    await this.db
      .insertInto("rollback_points")
      .values({
        id: point.id,
        operation_id: point.operation_id,
        affected_resources_json: stringify(point.affected_resources),
        before_snapshot_json: stringify(point.before_snapshot),
        after_snapshot_json: stringify(point.after_snapshot),
        reversible: point.reversible ? 1 : 0,
        irreversible_effects_json: stringify(point.irreversible_effects),
        created_at: point.created_at,
        expires_at: point.expires_at
      })
      .execute();
    return point;
  }

  async listRollbackPoints(): Promise<RollbackPoint[]> {
    const rows = await this.db.selectFrom("rollback_points").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(rollbackPointFromRow);
  }

  /** Reads rollback history only after its owning operations were Room-scoped. */
  async listRollbackPointsForOperationIds(operationIds: readonly string[]): Promise<RollbackPoint[]> {
    if (operationIds.length === 0) return [];
    const rows = await this.db.selectFrom("rollback_points").selectAll()
      .where("operation_id", "in", operationIds)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(rollbackPointFromRow);
  }

  async getRollbackPoint(id: string): Promise<RollbackPoint | undefined> {
    const row = await this.db.selectFrom("rollback_points").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? rollbackPointFromRow(row) : undefined;
  }

  /** A direct rollback lookup is constrained by the already-authorized Room operations. */
  async getRollbackPointForOperationIds(id: string, operationIds: readonly string[]): Promise<RollbackPoint | undefined> {
    if (operationIds.length === 0) return undefined;
    const row = await this.db.selectFrom("rollback_points").selectAll()
      .where("id", "=", id)
      .where("operation_id", "in", operationIds)
      .executeTakeFirst();
    return row ? rollbackPointFromRow(row) : undefined;
  }

  async listGrants(): Promise<GrantRecord[]> {
    const rows = await this.db.selectFrom("grants").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(grantFromRow);
  }

  async getGrant(id: string): Promise<GrantRecord | undefined> {
    const row = await this.db.selectFrom("grants").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? grantFromRow(row) : undefined;
  }

  async saveGrant(grant: GrantRecord): Promise<GrantRecord> {
    await this.db
      .insertInto("grants")
      .values({
        id: grant.id,
        capability_id: grant.capability_id,
        operation: grant.operation,
        actor_identity: grant.actor_identity,
        channel: grant.channel,
        resource_scope: grant.resource_scope,
        manifest_version: grant.manifest_version,
        risk_snapshot: grant.risk_snapshot,
        scope_snapshot: grant.scope_snapshot,
        external_impact_snapshot: grant.external_impact_snapshot ? 1 : 0,
        secret_requirement_snapshot: grant.secret_requirement_snapshot,
        granted_by: grant.granted_by,
        reason: grant.reason,
        created_at: grant.created_at,
        expires_at: grant.expires_at ?? null,
        revoked_at: grant.revoked_at ?? null
      })
      .execute();
    return grant;
  }

  async revokeGrant(id: string, revokedAt: string): Promise<GrantRecord | undefined> {
    await this.db
      .updateTable("grants")
      .set({ revoked_at: revokedAt })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .execute();
    return this.getGrant(id);
  }

}
