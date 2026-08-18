import {
  ActivityRecordSchema,
  ResourceRefSchema,
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
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import { activityFromRow, activityToRow, resourceUsageFromRow, resourceUsageToRow } from "./activity-job-row-codecs";

type FinalActivityStatus = Exclude<ActivityRecordStatus, "recording">;

/** Durable Activity evidence and resource-use history. No learning writes live here. */
export class ActivityHistoryRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async createActivity(recordInput: ActivityRecord): Promise<ActivityRecord> {
    const record = sanitizeActivity(ActivityRecordSchema.parse(recordInput));
    if (record.status !== "recording") throw new Error("activity_initial_status_must_be_recording");
    if (record.correction_of_activity_id) {
      const original = await this.getActivity(record.correction_of_activity_id);
      if (!original || original.workspace_id !== record.workspace_id || original.room_id !== record.room_id || original.status === "recording") {
        throw new Error("activity_correction_scope_invalid");
      }
    }
    await this.db.insertInto("activity_records").values(activityToRow(record)).onConflict((conflict) => conflict.columns(["workspace_id", "idempotency_key"]).doNothing()).execute();
    const saved = await this.getActivityByIdempotency({ workspaceId: record.workspace_id, idempotencyKey: record.idempotency_key });
    if (!saved) throw new Error("activity_idempotency_claim_lost");
    if (!sameActivityClaim(saved, record)) throw new Error("activity_idempotency_conflict");
    return saved;
  }

  async getActivity(id: string): Promise<ActivityRecord | undefined> {
    const row = await this.db.selectFrom("activity_records").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? activityFromRow(row) : undefined;
  }

  async getActivityByIdempotency(input: { workspaceId: string; idempotencyKey: string }): Promise<ActivityRecord | undefined> {
    const row = await this.db.selectFrom("activity_records").selectAll()
      .where("workspace_id", "=", input.workspaceId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    return row ? activityFromRow(row) : undefined;
  }

  async getActivityByBackendRunId(backendRunId: string): Promise<ActivityRecord | undefined> {
    const row = await this.db.selectFrom("activity_records").selectAll().where("backend_run_id", "=", backendRunId).executeTakeFirst();
    return row ? activityFromRow(row) : undefined;
  }

  async listActivities(input: {
    workspaceId: string;
    roomId?: string;
    principalId?: string;
    sourceKind?: ActivityRecord["source"]["kind"];
    sourceId?: string;
    status?: ActivityRecordStatus;
    createdAfter?: string;
    createdBefore?: string;
    limit?: number;
  }): Promise<ActivityRecord[]> {
    let query = this.db.selectFrom("activity_records").selectAll().where("workspace_id", "=", input.workspaceId);
    if (input.roomId) query = query.where("room_id", "=", input.roomId);
    if (input.principalId) query = query.where("principal_id", "=", input.principalId);
    if (input.sourceKind) query = query.where("source_kind", "=", input.sourceKind);
    if (input.sourceId) query = query.where("source_id", "=", input.sourceId);
    if (input.status) query = query.where("status", "=", input.status);
    if (input.createdAfter) query = query.where("created_at", ">=", input.createdAfter);
    if (input.createdBefore) query = query.where("created_at", "<=", input.createdBefore);
    const rows = await query.orderBy("created_at", "desc").limit(input.limit ?? 100).execute();
    return rows.map(activityFromRow);
  }

  async linkActivityBackendRun(input: { activityId: string; backendRunId: string; now: string }): Promise<ActivityRecord> {
    const current = await this.getActivity(input.activityId);
    if (!current) throw new Error("activity_not_found");
    if (current.status !== "recording") {
      if (current.backend_run_id === input.backendRunId) return current;
      throw new Error("activity_finalized_immutable");
    }
    if (current.backend_run_id && current.backend_run_id !== input.backendRunId) throw new Error("activity_backend_run_conflict");
    if (current.backend_run_id === input.backendRunId) return current;
    const linked = await this.getActivityByBackendRunId(input.backendRunId);
    if (linked && linked.id !== current.id) throw new Error("activity_backend_run_conflict");
    await this.assertBackendRunScope(current, input.backendRunId);
    const updated = await this.db.updateTable("activity_records")
      .set({ backend_run_id: input.backendRunId, updated_at: input.now })
      .where("id", "=", input.activityId)
      .where("status", "=", "recording")
      .where("backend_run_id", "is", null)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) !== 1) {
      const winner = await this.getActivity(input.activityId);
      if (winner?.backend_run_id === input.backendRunId) return winner;
      if (winner?.status !== "recording") throw new Error("activity_finalized_immutable");
      throw new Error("activity_backend_run_conflict");
    }
    const saved = await this.getActivity(input.activityId);
    if (!saved) throw new Error("activity_not_found");
    return saved;
  }

  async finalizeActivity(input: {
    activityId: string;
    status: FinalActivityStatus;
    resultSummary?: string;
    verification?: ActivityVerificationRecord[];
    failure?: ActivityFailure;
    backendRunId?: string;
    domainOperationIds?: string[];
    now: string;
    signal?: AbortSignal;
  }): Promise<ActivityRecord> {
    throwIfAborted(input.signal);
    const safeInput = sanitizeFinalization(input);
    const current = await this.getActivity(safeInput.activityId);
    if (!current) throw new Error("activity_not_found");
    if (current.status !== "recording") {
      if (sameFinalActivityClaim(current, safeInput)) return current;
      throw new Error("activity_finalized_immutable");
    }
    if (safeInput.backendRunId && current.backend_run_id && safeInput.backendRunId !== current.backend_run_id) {
      throw new Error("activity_backend_run_conflict");
    }
    if (safeInput.backendRunId) await this.assertBackendRunScope(current, safeInput.backendRunId);
    if (safeInput.domainOperationIds) await this.assertDomainOperationScopes(current, safeInput.domainOperationIds);
    assertActivityStatusTransition(current.status, safeInput.status);
    const next = buildFinalActivity(current, safeInput);
    throwIfAborted(input.signal);
    const updated = await this.db.updateTable("activity_records")
      .set(activityToRow(next))
      .where("id", "=", current.id)
      .where("status", "=", "recording")
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) !== 1) {
      const winner = await this.getActivity(safeInput.activityId);
      if (winner && sameFinalActivityClaim(winner, safeInput)) return winner;
      throw new Error("activity_finalized_immutable");
    }
    return next;
  }

  async ingestFinalizedActivity(input: {
    activity: ActivityRecord;
    resourceUsage: ResourceUsageRecord[];
    finalization: {
      status: FinalActivityStatus;
      resultSummary?: string;
      verification?: ActivityVerificationRecord[];
      failure?: ActivityFailure;
      backendRunId?: string;
      domainOperationIds?: string[];
      now: string;
    };
    signal?: AbortSignal;
  }): Promise<ActivityRecord> {
    throwIfAborted(input.signal);
    return this.db.transaction().execute(async (transaction) => {
      throwIfAborted(input.signal);
      const repository = new ActivityHistoryRepository(transaction);
      const requestedActivity = input.finalization.backendRunId
        ? ActivityRecordSchema.parse({ ...input.activity, backend_run_id: input.finalization.backendRunId })
        : input.activity;
      const activity = await repository.createActivity(requestedActivity);
      throwIfAborted(input.signal);
      if (input.finalization.backendRunId) await repository.assertBackendRunScope(activity, input.finalization.backendRunId);
      for (const usage of input.resourceUsage) {
        throwIfAborted(input.signal);
        if (usage.activity_id !== input.activity.id && usage.activity_id !== activity.id) throw new Error("resource_usage_activity_mismatch");
        await repository.recordResourceUsage({ ...usage, activity_id: activity.id });
      }
      throwIfAborted(input.signal);
      return repository.finalizeActivity({ activityId: activity.id, ...input.finalization, signal: input.signal });
    });
  }

  async recordResourceUsage(recordInput: ResourceUsageRecord): Promise<ResourceUsageRecord> {
    const record = ResourceUsageRecordSchema.parse(recordInput);
    const existing = await this.getResourceUsage(record.id);
    if (existing) {
      if (!sameResourceUsageClaim(existing, record)) throw new Error("resource_usage_idempotency_conflict");
      return existing;
    }
    const activity = await this.getActivity(record.activity_id);
    if (!activity) throw new Error("activity_not_found");
    if (activity.status !== "recording" && !record.workspace_job_attempt_id) throw new Error("activity_finalized_immutable");
    if (activity.status !== "recording" && (record.stage === "modified" || record.stage === "reverted")) {
      throw new Error("workspace_job_processor_read_only");
    }
    if (record.workspace_job_attempt_id) {
      const attempt = await this.db.selectFrom("workspace_job_attempts").select(["activity_id", "status"])
        .where("id", "=", record.workspace_job_attempt_id)
        .executeTakeFirst();
      if (!attempt || attempt.activity_id !== activity.id) throw new Error("resource_usage_workspace_job_attempt_scope_invalid");
      if (attempt.status !== "running") throw new Error("resource_usage_workspace_job_attempt_closed");
    }
    if (record.usage_scope.kind === "room" && record.usage_scope.room_id !== activity.room_id) {
      throw new Error("resource_usage_room_scope_mismatch");
    }
    await this.assertResourceUsageEvidence(record, activity);
    await this.db.insertInto("resource_usage_records").values(resourceUsageToRow(record)).onConflict((conflict) => conflict.column("id").doNothing()).execute();
    const row = await this.db.selectFrom("resource_usage_records").selectAll().where("id", "=", record.id).executeTakeFirst();
    if (!row) throw new Error("resource_usage_idempotency_claim_lost");
    const saved = resourceUsageFromRow(row);
    if (!sameResourceUsageClaim(saved, record)) throw new Error("resource_usage_idempotency_conflict");
    return saved;
  }

  async getResourceUsage(id: string): Promise<ResourceUsageRecord | undefined> {
    const row = await this.db.selectFrom("resource_usage_records").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? resourceUsageFromRow(row) : undefined;
  }

  async listResourceUsage(input: { activityId: string; workspaceJobAttemptId?: string }): Promise<ResourceUsageRecord[]> {
    let query = this.db.selectFrom("resource_usage_records").selectAll().where("activity_id", "=", input.activityId);
    if (input.workspaceJobAttemptId) query = query.where("workspace_job_attempt_id", "=", input.workspaceJobAttemptId);
    return (await query.orderBy("created_at", "asc").execute()).map(resourceUsageFromRow);
  }

  private async assertResourceUsageEvidence(record: ResourceUsageRecord, activity: ActivityRecord): Promise<void> {
    if ((record.stage === "modified" || record.stage === "reverted") && !record.workspace_change_id) {
      throw new Error("resource_usage_workspace_change_required");
    }
    if (record.workspace_change_id) {
      const change = await this.db.selectFrom("workspace_changes").select([
        "run_id", "room_id", "activity_id", "domain_operation_id",
        "legacy_operation_id", "resource_ref_json"
      ])
        .where("id", "=", record.workspace_change_id)
        .executeTakeFirst();
      if (!change) throw new Error("resource_usage_workspace_change_not_found");
      if (change.room_id && change.room_id !== activity.room_id) {
        throw new Error("resource_usage_workspace_change_scope_invalid");
      }
      if (change.activity_id && change.activity_id !== activity.id) throw new Error("resource_usage_workspace_change_activity_mismatch");
      if (change.run_id) {
        const run = await this.db.selectFrom("backend_runs").select(["room_id"])
          .where("id", "=", change.run_id)
          .executeTakeFirst();
        if (!run || run.room_id !== activity.room_id || (activity.backend_run_id && change.run_id !== activity.backend_run_id)) {
          throw new Error("resource_usage_workspace_change_scope_invalid");
        }
      } else if (!change.room_id) {
        // Only legacy Run-backed changes may omit a Room. New direct writes
        // must name their Room instead of inheriting it from a Session.
        throw new Error("resource_usage_workspace_change_scope_invalid");
      }
      if (!sameValue(parseResourceRef(change.resource_ref_json), record.resource_ref)) {
        throw new Error("resource_usage_workspace_change_resource_mismatch");
      }
      if (record.domain_operation_id && change.domain_operation_id !== record.domain_operation_id && change.legacy_operation_id !== record.domain_operation_id) {
        throw new Error("resource_usage_workspace_change_operation_mismatch");
      }
    }
    if (record.domain_operation_id) {
      const operation = await this.db.selectFrom("operations").select(["room_id", "run_id"])
        .where("id", "=", record.domain_operation_id)
        .executeTakeFirst();
      if (!operation || operation.room_id !== activity.room_id || (activity.backend_run_id && operation.run_id && operation.run_id !== activity.backend_run_id)) {
        throw new Error("resource_usage_domain_operation_scope_invalid");
      }
    }
  }

  private async assertBackendRunScope(activity: ActivityRecord, backendRunId: string): Promise<void> {
    const run = await this.db.selectFrom("backend_runs").select(["room_id"])
      .where("id", "=", backendRunId)
      .executeTakeFirst();
    if (!run || run.room_id !== activity.room_id) throw new Error("activity_backend_run_scope_invalid");
  }

  private async assertDomainOperationScopes(activity: ActivityRecord, operationIds: string[]): Promise<void> {
    for (const operationId of operationIds) {
      const operation = await this.db.selectFrom("operations").select(["room_id", "run_id"])
        .where("id", "=", operationId)
        .executeTakeFirst();
      if (!operation || operation.room_id !== activity.room_id || (activity.backend_run_id && operation.run_id && operation.run_id !== activity.backend_run_id)) {
        throw new Error("activity_domain_operation_scope_invalid");
      }
    }
  }
}

function parseResourceRef(value: string): ResourceUsageRecord["resource_ref"] {
  return ResourceRefSchema.parse(JSON.parse(value));
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
    provenance: {
      kind: existing.provenance.kind,
      source_id: existing.provenance.source_id
    }
  }, {
    workspace_id: requested.workspace_id,
    room_id: requested.room_id,
    principal: requested.principal,
    source: requested.source,
    idempotency_key: requested.idempotency_key,
    instruction_summary: requested.instruction_summary,
    correction_of_activity_id: requested.correction_of_activity_id,
    session_ref: requested.session_ref,
    provenance: {
      kind: requested.provenance.kind,
      source_id: requested.provenance.source_id
    }
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

function sameFinalActivityClaim(
  existing: ActivityRecord,
  input: {
    status: FinalActivityStatus;
    resultSummary?: string;
    verification?: ActivityVerificationRecord[];
    failure?: ActivityFailure;
    backendRunId?: string;
    domainOperationIds?: string[];
    now: string;
  }
): boolean {
  if (existing.status !== input.status) return false;
  if (input.resultSummary !== undefined && existing.result_summary !== input.resultSummary) return false;
  if (input.verification !== undefined && !sameValue(existing.verification, input.verification)) return false;
  if (input.failure !== undefined && !sameValue(existing.failure, input.failure)) return false;
  if (input.backendRunId !== undefined && existing.backend_run_id !== input.backendRunId) return false;
  if (input.domainOperationIds !== undefined && !sameValue(existing.domain_operation_ids, input.domainOperationIds)) return false;
  return true;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function sanitizeActivity(record: ActivityRecord): ActivityRecord {
  return ActivityRecordSchema.parse({
    ...record,
    instruction_summary: redactPrivateData(record.instruction_summary, { redactPii: true }),
    verification: record.verification.map(sanitizeVerification),
    ...(record.failure ? { failure: sanitizeFailure(record.failure) } : {})
  });
}

function sanitizeFinalization<T extends {
  resultSummary?: string;
  verification?: ActivityVerificationRecord[];
  failure?: ActivityFailure;
}>(input: T): T {
  return {
    ...input,
    ...(input.resultSummary !== undefined ? { resultSummary: redactPrivateData(input.resultSummary, { redactPii: true }) } : {}),
    ...(input.verification !== undefined ? { verification: input.verification.map(sanitizeVerification) } : {}),
    ...(input.failure !== undefined ? { failure: sanitizeFailure(input.failure) } : {})
  };
}

function sanitizeVerification(verification: ActivityVerificationRecord): ActivityVerificationRecord {
  return {
    ...verification,
    summary: redactPrivateData(verification.summary, { redactPii: true })
  };
}

function sanitizeFailure(failure: ActivityFailure): ActivityFailure {
  return {
    ...failure,
    summary: redactPrivateData(failure.summary, { redactPii: true })
  };
}

function buildFinalActivity(
  current: ActivityRecord,
  input: {
    status: FinalActivityStatus;
    resultSummary?: string;
    verification?: ActivityVerificationRecord[];
    failure?: ActivityFailure;
    backendRunId?: string;
    domainOperationIds?: string[];
    now: string;
  }
): ActivityRecord {
  const next: ActivityRecord = {
    ...current,
    status: input.status,
    ...(input.status === "completed" ? { result_summary: input.resultSummary } : {}),
    ...(input.status !== "completed" ? { failure: input.failure } : {}),
    verification: input.verification ?? current.verification,
    ...(input.backendRunId ?? current.backend_run_id ? { backend_run_id: input.backendRunId ?? current.backend_run_id } : {}),
    domain_operation_ids: input.domainOperationIds ?? current.domain_operation_ids,
    updated_at: input.now,
    finalized_at: input.now
  };
  return ActivityRecordSchema.parse(next);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("external_app_ingress_aborted");
}
