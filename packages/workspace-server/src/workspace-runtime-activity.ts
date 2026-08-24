import {
  ActivityRecordSchema,
  ResourceUsageRecordSchema,
  assertActivityStatusTransition,
  redactPrivateData,
  stableStringify,
  type ActivityFailure,
  type ActivityRecord,
  type ActivityRecordStatus,
  type ActivityVerificationRecord,
  type ResourceUsageRecord
} from "@samurai-agent/core-schemas";
import { WorkspaceServerError } from "./errors";
import { PostgresWorkspaceDatabase, type WorkspaceSql } from "./postgres";
import type { WorkspaceRequestContext } from "./types";

type FinalActivityStatus = Exclude<ActivityRecordStatus, "recording">;

export interface RuntimeActivityFinalizationInput {
  activityId: string;
  status: FinalActivityStatus;
  resultSummary?: string;
  verification?: ActivityVerificationRecord[];
  failure?: ActivityFailure;
  backendRunId?: string;
  domainOperationIds?: string[];
  now?: string;
}

export interface RuntimeFinalizedActivityInput {
  activity: ActivityRecord;
  resourceUsage: ResourceUsageRecord[];
  finalization: Omit<RuntimeActivityFinalizationInput, "activityId">;
}

interface RuntimeActivityRow {
  workspace_id: string;
  id: string;
  room_id: string;
  status: string;
  idempotency_key: string;
  backend_run_id: string | null;
  record: unknown;
  created_at: string;
  updated_at: string;
}

interface RuntimeResourceUsageRow {
  workspace_id: string;
  id: string;
  activity_id: string;
  workspace_job_attempt_id: string | null;
  resource_ref: unknown;
  resource_version: string | null;
  content_hash: string | null;
  usage_scope: unknown;
  stage: string;
  domain_operation_id: string | null;
  workspace_change_id: string | null;
  created_at: string;
}

/**
 * PostgreSQL persistence for the Core Activity evidence path.
 *
 * Runtime activities intentionally keep the complete ActivityRecord in the
 * JSONB `record` column while the table columns provide tenant, Room,
 * idempotency and foreign-key boundaries.  Every method runs in an RLS
 * transaction and uses the same immutable-finalization rules as Core07.
 */
export class WorkspaceRuntimeActivityService {
  constructor(
    private readonly database: PostgresWorkspaceDatabase,
    private readonly clock: () => string = () => new Date().toISOString()
  ) {}

  async createActivity(context: WorkspaceRequestContext, recordInput: ActivityRecord): Promise<ActivityRecord> {
    const record = sanitizeActivity(ActivityRecordSchema.parse(recordInput));
    if (record.status !== "recording") throw new WorkspaceServerError("activity_initial_status_must_be_recording", 400);
    assertWorkspace(record, context);
    return this.database.withContext(context, async (sql) => {
      await this.assertRoom(sql, context.workspaceId, record.room_id, "execute");
      if (record.correction_of_activity_id) {
        const original = await this.selectActivity(sql, context.workspaceId, record.correction_of_activity_id);
        if (!original || original.room_id !== record.room_id || original.status === "recording") {
          throw new WorkspaceServerError("activity_correction_scope_invalid", 409);
        }
      }
      await sql.query(
        `INSERT INTO workspace_runtime_activities(
           workspace_id, id, room_id, status, idempotency_key, backend_run_id, record, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $8)
         ON CONFLICT (workspace_id, room_id, idempotency_key) DO NOTHING`,
        [context.workspaceId, record.id, record.room_id, record.status, record.idempotency_key, record.backend_run_id ?? null, jsonText(record), record.created_at]
      );
      const saved = await sql.query<RuntimeActivityRow>(
        `SELECT * FROM workspace_runtime_activities
         WHERE workspace_id = $1 AND room_id = $2 AND idempotency_key = $3`,
        [context.workspaceId, record.room_id, record.idempotency_key]
      );
      const row = saved.rows[0];
      if (!row) throw new WorkspaceServerError("activity_idempotency_claim_lost", 500);
      const activity = activityFromRow(row);
      if (!sameActivityClaim(activity, record)) throw new WorkspaceServerError("activity_idempotency_conflict", 409);
      return activity;
    });
  }

  /** Records an already terminal external result atomically with its evidence. */
  async ingestFinalizedActivity(context: WorkspaceRequestContext, input: RuntimeFinalizedActivityInput): Promise<ActivityRecord> {
    const activity = sanitizeActivity(ActivityRecordSchema.parse(input.activity));
    if (activity.status !== "recording") throw new WorkspaceServerError("activity_initial_status_must_be_recording", 400);
    assertWorkspace(activity, context);
    const finalization = sanitizeFinalization({ ...input.finalization, activityId: activity.id });
    const now = finalization.now ?? this.clock();
    return this.database.withContext(context, async (sql) => {
      await this.assertRoom(sql, context.workspaceId, activity.room_id, "execute");
      if (activity.correction_of_activity_id) {
        const original = await this.selectActivity(sql, context.workspaceId, activity.correction_of_activity_id);
        if (!original || original.room_id !== activity.room_id || original.status === "recording") {
          throw new WorkspaceServerError("activity_correction_scope_invalid", 409);
        }
      }
      await sql.query(
        `INSERT INTO workspace_runtime_activities(
           workspace_id, id, room_id, status, idempotency_key, backend_run_id, record, created_at, updated_at
         ) VALUES ($1, $2, $3, 'recording', $4, $5, $6::JSONB, $7, $7)
         ON CONFLICT (workspace_id, room_id, idempotency_key) DO NOTHING`,
        [context.workspaceId, activity.id, activity.room_id, activity.idempotency_key, activity.backend_run_id ?? null, jsonText(activity), activity.created_at]
      );
      const selected = await this.selectActivityRowByClaim(sql, context.workspaceId, activity.room_id, activity.idempotency_key);
      if (!selected) throw new WorkspaceServerError("activity_idempotency_claim_lost", 500);
      const saved = activityFromRow(selected);
      if (!sameActivityClaim(saved, activity)) throw new WorkspaceServerError("activity_idempotency_conflict", 409);
      if (finalization.backendRunId) await this.assertBackendRunScope(sql, context.workspaceId, saved.room_id, finalization.backendRunId);
      const locked = await this.selectActivityRow(sql, context.workspaceId, saved.id, true);
      if (!locked) throw new WorkspaceServerError("activity_not_found", 404);
      const current = activityFromRow(locked);
      if (current.status !== "recording") {
        if (sameFinalActivityClaim(current, finalization)) return current;
        throw new WorkspaceServerError("activity_finalized_immutable", 409);
      }
      for (const usageInput of input.resourceUsage) {
        if (usageInput.activity_id !== activity.id) {
          throw new WorkspaceServerError("resource_usage_activity_mismatch", 409);
        }
        const usage = ResourceUsageRecordSchema.parse({ ...usageInput, activity_id: saved.id });
        const existing = await sql.query<RuntimeResourceUsageRow>(
          "SELECT * FROM workspace_runtime_resource_usage WHERE workspace_id = $1 AND id = $2",
          [context.workspaceId, usage.id]
        );
        if (existing.rows[0]) {
          const replay = resourceUsageFromRow(existing.rows[0]);
          if (!sameResourceUsageClaim(replay, usage)) throw new WorkspaceServerError("resource_usage_idempotency_conflict", 409);
          continue;
        }
        const action = usage.stage === "modified" || usage.stage === "reverted" ? "edit" : "read";
        await this.assertRoom(sql, context.workspaceId, current.room_id, action);
        if (usage.usage_scope.kind === "room" && usage.usage_scope.room_id !== current.room_id) {
          throw new WorkspaceServerError("resource_usage_room_scope_mismatch", 409);
        }
        await this.assertResourceUsageEvidence(sql, context.workspaceId, usage, current);
        await sql.query(
          `INSERT INTO workspace_runtime_resource_usage(
             workspace_id, id, activity_id, workspace_job_attempt_id, resource_ref, resource_version,
             content_hash, usage_scope, stage, domain_operation_id, workspace_change_id, created_at
           ) VALUES ($1, $2, $3, $4, $5::JSONB, $6, $7, $8::JSONB, $9, $10, $11, $12)
           ON CONFLICT (workspace_id, id) DO NOTHING`,
          [context.workspaceId, usage.id, saved.id, usage.workspace_job_attempt_id ?? null, jsonText(usage.resource_ref), usage.resource_version ?? null, usage.content_hash ?? null, jsonText(usage.usage_scope), usage.stage, usage.domain_operation_id ?? null, usage.workspace_change_id ?? null, usage.created_at]
        );
        const claimed = await sql.query<RuntimeResourceUsageRow>(
          "SELECT * FROM workspace_runtime_resource_usage WHERE workspace_id = $1 AND id = $2",
          [context.workspaceId, usage.id]
        );
        if (!claimed.rows[0] || !sameResourceUsageClaim(resourceUsageFromRow(claimed.rows[0]), usage)) {
          throw new WorkspaceServerError("resource_usage_idempotency_conflict", 409);
        }
      }
      for (const operationId of [
        ...(finalization.domainOperationIds ?? []),
        ...(finalization.verification ?? []).flatMap((verification) => verification.source_operation_id ? [verification.source_operation_id] : [])
      ]) {
        await this.assertDomainOperationScope(sql, context.workspaceId, current.room_id, operationId);
      }
      assertActivityStatusTransition(current.status, finalization.status);
      const next = buildFinalActivity(current, finalization, now);
      const updated = await sql.query<RuntimeActivityRow>(
        `UPDATE workspace_runtime_activities
         SET status = $3, backend_run_id = $4, record = $5::JSONB, updated_at = $6
         WHERE workspace_id = $1 AND id = $2 AND status = 'recording'
         RETURNING *`,
        [context.workspaceId, current.id, next.status, next.backend_run_id ?? null, jsonText(next), now]
      );
      if (!updated.rows[0]) throw new WorkspaceServerError("activity_finalized_immutable", 409);
      return activityFromRow(updated.rows[0]);
    });
  }

  async getActivity(context: WorkspaceRequestContext, activityId: string): Promise<ActivityRecord | undefined> {
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<RuntimeActivityRow>(
        "SELECT * FROM workspace_runtime_activities WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, activityId]
      );
      return result.rows[0] ? activityFromRow(result.rows[0]) : undefined;
    });
  }

  async getOperation(context: WorkspaceRequestContext, operationId: string): Promise<{ room_id?: string } | undefined> {
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<{ room_id: string | null }>(
        "SELECT room_id FROM workspace_runtime_operations WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, operationId]
      );
      const row = result.rows[0];
      return row ? { ...(row.room_id ? { room_id: row.room_id } : {}) } : undefined;
    });
  }

  async linkActivityBackendRun(
    context: WorkspaceRequestContext,
    input: { activityId: string; backendRunId: string; now?: string }
  ): Promise<ActivityRecord> {
    const now = input.now ?? this.clock();
    return this.database.withContext(context, async (sql) => {
      const currentRow = await this.selectActivityRow(sql, context.workspaceId, input.activityId, true);
      if (!currentRow) throw new WorkspaceServerError("activity_not_found", 404);
      const current = activityFromRow(currentRow);
      await this.assertRoom(sql, context.workspaceId, current.room_id, "execute");
      if (current.status !== "recording") {
        if (current.backend_run_id === input.backendRunId) return current;
        throw new WorkspaceServerError("activity_finalized_immutable", 409);
      }
      if (current.backend_run_id && current.backend_run_id !== input.backendRunId) {
        throw new WorkspaceServerError("activity_backend_run_conflict", 409);
      }
      if (current.backend_run_id === input.backendRunId) return current;
      await this.assertBackendRunScope(sql, context.workspaceId, current.room_id, input.backendRunId);
      const linked = await sql.query<RuntimeActivityRow>(
        `SELECT * FROM workspace_runtime_activities
         WHERE workspace_id = $1 AND room_id = $2 AND backend_run_id = $3
         AND id <> $4 LIMIT 1`,
        [context.workspaceId, current.room_id, input.backendRunId, current.id]
      );
      if (linked.rows[0]) throw new WorkspaceServerError("activity_backend_run_conflict", 409);
      const next = ActivityRecordSchema.parse({ ...current, backend_run_id: input.backendRunId, updated_at: now });
      const updated = await sql.query<RuntimeActivityRow>(
        `UPDATE workspace_runtime_activities
         SET backend_run_id = $3, record = $4::JSONB, updated_at = $5
         WHERE workspace_id = $1 AND id = $2 AND status = 'recording' AND backend_run_id IS NULL
         RETURNING *`,
        [context.workspaceId, current.id, input.backendRunId, jsonText(next), now]
      );
      if (!updated.rows[0]) {
        const winner = await this.selectActivityRow(sql, context.workspaceId, input.activityId, false);
        if (winner) {
          const winnerActivity = activityFromRow(winner);
          if (winnerActivity.backend_run_id === input.backendRunId) return winnerActivity;
          if (winnerActivity.status !== "recording") throw new WorkspaceServerError("activity_finalized_immutable", 409);
        }
        throw new WorkspaceServerError("activity_backend_run_conflict", 409);
      }
      return activityFromRow(updated.rows[0]);
    });
  }

  async recordResourceUsage(context: WorkspaceRequestContext, recordInput: ResourceUsageRecord): Promise<ResourceUsageRecord> {
    const record = ResourceUsageRecordSchema.parse(recordInput);
    assertWorkspaceUsage(record, context);
    return this.database.withContext(context, async (sql) => {
      const existing = await sql.query<RuntimeResourceUsageRow>(
        "SELECT * FROM workspace_runtime_resource_usage WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, record.id]
      );
      if (existing.rows[0]) {
        const saved = resourceUsageFromRow(existing.rows[0]);
        if (!sameResourceUsageClaim(saved, record)) throw new WorkspaceServerError("resource_usage_idempotency_conflict", 409);
        return saved;
      }
      const activityRow = await this.selectActivityRow(sql, context.workspaceId, record.activity_id, true);
      if (!activityRow) throw new WorkspaceServerError("activity_not_found", 404);
      const activity = activityFromRow(activityRow);
      const action = record.stage === "modified" || record.stage === "reverted" ? "edit" : "read";
      await this.assertRoom(sql, context.workspaceId, activity.room_id, action);
      if (activity.status !== "recording") {
        if (!record.workspace_job_attempt_id) throw new WorkspaceServerError("activity_finalized_immutable", 409);
        if (record.stage === "modified" || record.stage === "reverted") {
          throw new WorkspaceServerError("workspace_job_processor_read_only", 409);
        }
        // The PostgreSQL runtime schema has no job-attempt ledger. Do not
        // claim that an unverified attempt is allowed to append evidence.
        throw new WorkspaceServerError("resource_usage_workspace_job_attempt_scope_invalid", 409);
      }
      if (record.usage_scope.kind === "room" && record.usage_scope.room_id !== activity.room_id) {
        throw new WorkspaceServerError("resource_usage_room_scope_mismatch", 409);
      }
      await this.assertResourceUsageEvidence(sql, context.workspaceId, record, activity);
      await sql.query(
        `INSERT INTO workspace_runtime_resource_usage(
           workspace_id, id, activity_id, workspace_job_attempt_id, resource_ref, resource_version,
           content_hash, usage_scope, stage, domain_operation_id, workspace_change_id, created_at
         ) VALUES ($1, $2, $3, $4, $5::JSONB, $6, $7, $8::JSONB, $9, $10, $11, $12)
         ON CONFLICT (workspace_id, id) DO NOTHING`,
        [context.workspaceId, record.id, record.activity_id, record.workspace_job_attempt_id ?? null, jsonText(record.resource_ref), record.resource_version ?? null, record.content_hash ?? null, jsonText(record.usage_scope), record.stage, record.domain_operation_id ?? null, record.workspace_change_id ?? null, record.created_at]
      );
      const saved = await sql.query<RuntimeResourceUsageRow>(
        "SELECT * FROM workspace_runtime_resource_usage WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, record.id]
      );
      const row = saved.rows[0];
      if (!row) throw new WorkspaceServerError("resource_usage_idempotency_claim_lost", 500);
      const usage = resourceUsageFromRow(row);
      if (!sameResourceUsageClaim(usage, record)) throw new WorkspaceServerError("resource_usage_idempotency_conflict", 409);
      return usage;
    });
  }

  async finalizeActivity(context: WorkspaceRequestContext, input: RuntimeActivityFinalizationInput): Promise<ActivityRecord> {
    const safeInput = sanitizeFinalization(input);
    const now = safeInput.now ?? this.clock();
    return this.database.withContext(context, async (sql) => {
      const currentRow = await this.selectActivityRow(sql, context.workspaceId, safeInput.activityId, true);
      if (!currentRow) throw new WorkspaceServerError("activity_not_found", 404);
      const current = activityFromRow(currentRow);
      await this.assertRoom(sql, context.workspaceId, current.room_id, "execute");
      if (current.status !== "recording") {
        if (sameFinalActivityClaim(current, safeInput)) return current;
        throw new WorkspaceServerError("activity_finalized_immutable", 409);
      }
      if (safeInput.backendRunId && current.backend_run_id && safeInput.backendRunId !== current.backend_run_id) {
        throw new WorkspaceServerError("activity_backend_run_conflict", 409);
      }
      if (safeInput.backendRunId) await this.assertBackendRunScope(sql, context.workspaceId, current.room_id, safeInput.backendRunId);
      for (const operationId of safeInput.domainOperationIds ?? []) {
        await this.assertDomainOperationScope(sql, context.workspaceId, current.room_id, operationId);
      }
      assertActivityStatusTransition(current.status, safeInput.status);
      const next = buildFinalActivity(current, safeInput, now);
      const updated = await sql.query<RuntimeActivityRow>(
        `UPDATE workspace_runtime_activities
         SET status = $3, backend_run_id = $4, record = $5::JSONB, updated_at = $6
         WHERE workspace_id = $1 AND id = $2 AND status = 'recording'
         RETURNING *`,
        [context.workspaceId, current.id, next.status, next.backend_run_id ?? null, jsonText(next), now]
      );
      if (!updated.rows[0]) {
        const winnerRow = await this.selectActivityRow(sql, context.workspaceId, safeInput.activityId, false);
        if (winnerRow) {
          const winner = activityFromRow(winnerRow);
          if (sameFinalActivityClaim(winner, safeInput)) return winner;
        }
        throw new WorkspaceServerError("activity_finalized_immutable", 409);
      }
      return activityFromRow(updated.rows[0]);
    });
  }

  async listResourceUsage(context: WorkspaceRequestContext, input: { activityId: string; workspaceJobAttemptId?: string }): Promise<ResourceUsageRecord[]> {
    return this.database.withContext(context, async (sql) => {
      const values: unknown[] = [context.workspaceId, input.activityId];
      let query = `SELECT * FROM workspace_runtime_resource_usage WHERE workspace_id = $1 AND activity_id = $2`;
      if (input.workspaceJobAttemptId) {
        values.push(input.workspaceJobAttemptId);
        query += ` AND workspace_job_attempt_id = $3`;
      }
      query += " ORDER BY created_at ASC";
      const result = await sql.query<RuntimeResourceUsageRow>(query, values);
      return result.rows.map(resourceUsageFromRow);
    });
  }

  private async selectActivityRow(sql: WorkspaceSql, workspaceId: string, activityId: string, forUpdate: boolean): Promise<RuntimeActivityRow | undefined> {
    const result = await sql.query<RuntimeActivityRow>(
      `SELECT * FROM workspace_runtime_activities WHERE workspace_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [workspaceId, activityId]
    );
    return result.rows[0];
  }

  private async selectActivity(sql: WorkspaceSql, workspaceId: string, activityId: string): Promise<ActivityRecord | undefined> {
    const row = await this.selectActivityRow(sql, workspaceId, activityId, false);
    return row ? activityFromRow(row) : undefined;
  }

  private async selectActivityRowByClaim(sql: WorkspaceSql, workspaceId: string, roomId: string, idempotencyKey: string): Promise<RuntimeActivityRow | undefined> {
    const result = await sql.query<RuntimeActivityRow>(
      `SELECT * FROM workspace_runtime_activities
       WHERE workspace_id = $1 AND room_id = $2 AND idempotency_key = $3`,
      [workspaceId, roomId, idempotencyKey]
    );
    return result.rows[0];
  }

  private async assertRoom(sql: WorkspaceSql, workspaceId: string, roomId: string, action: "read" | "edit" | "execute"): Promise<void> {
    const result = await sql.query<{ allowed: boolean }>("SELECT samurai_can_room($1, $2, $3) AS allowed", [workspaceId, roomId, action]);
    if (result.rows[0]?.allowed !== true) throw new WorkspaceServerError("room_permission_denied", 403);
  }

  private async assertBackendRunScope(sql: WorkspaceSql, workspaceId: string, roomId: string, backendRunId: string): Promise<void> {
    const result = await sql.query<{ room_id: string | null }>(
      "SELECT room_id FROM workspace_runtime_runs WHERE workspace_id = $1 AND id = $2",
      [workspaceId, backendRunId]
    );
    if (!result.rows[0] || result.rows[0].room_id !== roomId) throw new WorkspaceServerError("activity_backend_run_scope_invalid", 409);
  }

  private async assertDomainOperationScope(sql: WorkspaceSql, workspaceId: string, roomId: string, operationId: string): Promise<void> {
    const result = await sql.query<{ room_id: string | null }>(
      "SELECT room_id FROM workspace_runtime_operations WHERE workspace_id = $1 AND id = $2",
      [workspaceId, operationId]
    );
    if (!result.rows[0] || result.rows[0].room_id !== roomId) throw new WorkspaceServerError("activity_domain_operation_scope_invalid", 409);
  }

  private async assertResourceUsageEvidence(
    sql: WorkspaceSql,
    workspaceId: string,
    record: ResourceUsageRecord,
    activity: ActivityRecord
  ): Promise<void> {
    if ((record.stage === "modified" || record.stage === "reverted") && !record.workspace_change_id) {
      throw new WorkspaceServerError("resource_usage_workspace_change_required", 400);
    }
    if (record.workspace_change_id) {
      const result = await sql.query<{
        run_id: string | null;
        room_id: string | null;
        activity_id: string | null;
        domain_operation_id: string | null;
        legacy_operation_id: string | null;
        resource_ref: unknown;
      }>(
        `SELECT run_id, room_id, activity_id, domain_operation_id, legacy_operation_id, resource_ref
         FROM workspace_runtime_changes WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, record.workspace_change_id]
      );
      const change = result.rows[0];
      if (!change) throw new WorkspaceServerError("resource_usage_workspace_change_not_found", 404);
      if (change.room_id && change.room_id !== activity.room_id) throw new WorkspaceServerError("resource_usage_workspace_change_scope_invalid", 409);
      if (change.activity_id && change.activity_id !== activity.id) throw new WorkspaceServerError("resource_usage_workspace_change_activity_mismatch", 409);
      if (change.run_id) {
        const run = await sql.query<{ room_id: string | null }>(
          "SELECT room_id FROM workspace_runtime_runs WHERE workspace_id = $1 AND id = $2",
          [workspaceId, change.run_id]
        );
        if (!run.rows[0] || run.rows[0].room_id !== activity.room_id || (activity.backend_run_id && change.run_id !== activity.backend_run_id)) {
          throw new WorkspaceServerError("resource_usage_workspace_change_scope_invalid", 409);
        }
      } else if (!change.room_id) {
        throw new WorkspaceServerError("resource_usage_workspace_change_scope_invalid", 409);
      }
      if (!sameValue(jsonValue(change.resource_ref), record.resource_ref)) {
        throw new WorkspaceServerError("resource_usage_workspace_change_resource_mismatch", 409);
      }
      if (record.domain_operation_id && change.domain_operation_id !== record.domain_operation_id && change.legacy_operation_id !== record.domain_operation_id) {
        throw new WorkspaceServerError("resource_usage_workspace_change_operation_mismatch", 409);
      }
    }
    if (record.domain_operation_id) {
      await this.assertDomainOperationScope(sql, workspaceId, activity.room_id, record.domain_operation_id);
    }
  }
}

function assertWorkspace(record: ActivityRecord, context: WorkspaceRequestContext): void {
  if (record.workspace_id !== context.workspaceId) throw new WorkspaceServerError("activity_context_mismatch", 409);
}

function assertWorkspaceUsage(record: ResourceUsageRecord, context: WorkspaceRequestContext): void {
  // Resource usage has no workspace_id in the Core contract; its Activity is
  // the tenant anchor and is checked again after the row is locked.
  if (!context.workspaceId.trim()) throw new WorkspaceServerError("workspace_id_invalid", 400);
  if (!record.activity_id.trim()) throw new WorkspaceServerError("activity_not_found", 404);
}

function activityFromRow(row: RuntimeActivityRow): ActivityRecord {
  const record = ActivityRecordSchema.parse(jsonValue(row.record));
  if (record.workspace_id !== row.workspace_id || record.id !== row.id || record.room_id !== row.room_id || record.status !== row.status || record.idempotency_key !== row.idempotency_key) {
    throw new WorkspaceServerError("runtime_activity_record_inconsistent", 500);
  }
  // The initial runtime admission writes backend_run_id in the table before
  // the first Activity JSON update. Normalize that known transitional shape.
  if (row.backend_run_id && !record.backend_run_id) return ActivityRecordSchema.parse({ ...record, backend_run_id: row.backend_run_id });
  if (row.backend_run_id && record.backend_run_id !== row.backend_run_id) throw new WorkspaceServerError("runtime_activity_record_inconsistent", 500);
  return record;
}

function resourceUsageFromRow(row: RuntimeResourceUsageRow): ResourceUsageRecord {
  return ResourceUsageRecordSchema.parse({
    id: row.id,
    activity_id: row.activity_id,
    ...(row.workspace_job_attempt_id ? { workspace_job_attempt_id: row.workspace_job_attempt_id } : {}),
    resource_ref: jsonValue(row.resource_ref),
    ...(row.resource_version ? { resource_version: row.resource_version } : {}),
    ...(row.content_hash ? { content_hash: row.content_hash } : {}),
    usage_scope: jsonValue(row.usage_scope),
    stage: row.stage,
    ...(row.domain_operation_id ? { domain_operation_id: row.domain_operation_id } : {}),
    ...(row.workspace_change_id ? { workspace_change_id: row.workspace_change_id } : {}),
    created_at: row.created_at
  });
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new WorkspaceServerError("runtime_activity_json_invalid", 500); }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function sameActivityClaim(existing: ActivityRecord, requested: ActivityRecord): boolean {
  return sameValue({
    workspace_id: existing.workspace_id,
    room_id: existing.room_id,
    principal: existing.principal,
    source: existing.source,
    idempotency_key: existing.idempotency_key,
    instruction_summary: existing.instruction_summary,
    correction_of_activity_id: existing.correction_of_activity_id,
    session_ref: existing.session_ref,
    provenance: { kind: existing.provenance.kind, source_id: existing.provenance.source_id }
  }, {
    workspace_id: requested.workspace_id,
    room_id: requested.room_id,
    principal: requested.principal,
    source: requested.source,
    idempotency_key: requested.idempotency_key,
    instruction_summary: requested.instruction_summary,
    correction_of_activity_id: requested.correction_of_activity_id,
    session_ref: requested.session_ref,
    provenance: { kind: requested.provenance.kind, source_id: requested.provenance.source_id }
  });
}

function sameResourceUsageClaim(existing: ResourceUsageRecord, requested: ResourceUsageRecord): boolean {
  return sameValue({
    activity_id: existing.activity_id,
    workspace_job_attempt_id: existing.workspace_job_attempt_id,
    resource_ref: existing.resource_ref,
    resource_version: existing.resource_version,
    content_hash: existing.content_hash,
    usage_scope: existing.usage_scope,
    stage: existing.stage,
    domain_operation_id: existing.domain_operation_id,
    workspace_change_id: existing.workspace_change_id
  }, {
    activity_id: requested.activity_id,
    workspace_job_attempt_id: requested.workspace_job_attempt_id,
    resource_ref: requested.resource_ref,
    resource_version: requested.resource_version,
    content_hash: requested.content_hash,
    usage_scope: requested.usage_scope,
    stage: requested.stage,
    domain_operation_id: requested.domain_operation_id,
    workspace_change_id: requested.workspace_change_id
  });
}

function sameFinalActivityClaim(existing: ActivityRecord, input: RuntimeActivityFinalizationInput): boolean {
  if (existing.status !== input.status) return false;
  if (input.resultSummary !== undefined && existing.result_summary !== input.resultSummary) return false;
  if (input.verification !== undefined && !sameValue(existing.verification, input.verification)) return false;
  if (input.failure !== undefined && !sameValue(existing.failure, input.failure)) return false;
  if (input.backendRunId !== undefined && existing.backend_run_id !== input.backendRunId) return false;
  if (input.domainOperationIds !== undefined && !sameValue(existing.domain_operation_ids, input.domainOperationIds)) return false;
  return true;
}

function buildFinalActivity(current: ActivityRecord, input: RuntimeActivityFinalizationInput, now: string): ActivityRecord {
  return ActivityRecordSchema.parse({
    ...current,
    status: input.status,
    ...(input.status === "completed" ? { result_summary: input.resultSummary } : { result_summary: undefined }),
    ...(input.status !== "completed" ? { failure: input.failure } : { failure: undefined }),
    verification: input.verification ?? current.verification,
    ...(input.backendRunId ?? current.backend_run_id ? { backend_run_id: input.backendRunId ?? current.backend_run_id } : {}),
    domain_operation_ids: input.domainOperationIds ?? current.domain_operation_ids,
    updated_at: now,
    finalized_at: now
  });
}

function sanitizeActivity(record: ActivityRecord): ActivityRecord {
  return ActivityRecordSchema.parse({
    ...record,
    instruction_summary: redactPrivateData(record.instruction_summary, { redactPii: true }),
    verification: record.verification.map(sanitizeVerification),
    ...(record.failure ? { failure: sanitizeFailure(record.failure) } : {})
  });
}

function sanitizeFinalization(input: RuntimeActivityFinalizationInput): RuntimeActivityFinalizationInput {
  return {
    ...input,
    ...(input.resultSummary !== undefined ? { resultSummary: redactPrivateData(input.resultSummary, { redactPii: true }) } : {}),
    ...(input.verification !== undefined ? { verification: input.verification.map(sanitizeVerification) } : {}),
    ...(input.failure !== undefined ? { failure: sanitizeFailure(input.failure) } : {})
  };
}

function sanitizeVerification(verification: ActivityVerificationRecord): ActivityVerificationRecord {
  return { ...verification, summary: redactPrivateData(verification.summary, { redactPii: true }) };
}

function sanitizeFailure(failure: ActivityFailure): ActivityFailure {
  return { ...failure, summary: redactPrivateData(failure.summary, { redactPii: true }) };
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}
