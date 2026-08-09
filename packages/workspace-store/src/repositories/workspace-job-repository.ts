import {
  ActivityProcessorInputSchema,
  WorkspaceJobAttemptRecordSchema,
  WorkspaceJobRecordSchema,
  assertWorkspaceJobStatusTransition,
  createId,
  redactPrivateData,
  stableStringify,
  type ActivityProcessorInput,
  type ActivityProcessorModelInfo,
  type JsonValue,
  type WorkspaceJobAttemptRecord,
  type WorkspaceJobRecord
} from "@samurai-agent/core-schemas";
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import { workspaceJobAttemptFromRow, workspaceJobAttemptToRow, workspaceJobFromRow, workspaceJobToRow } from "./activity-job-row-codecs";
import { ActivityHistoryRepository } from "./activity-history-repository";
import { stringify } from "./serialization";

type ProcessorResult = {
  outputSchemaVersion: string;
  output: Record<string, JsonValue>;
  summary: string;
  diagnostics: Array<{ code: string; summary: string }>;
  model?: ActivityProcessorModelInfo;
};

/** Durable, deliberately narrow Activity processing jobs. */
export class WorkspaceJobRepository {
  constructor(
    private readonly db: Kysely<WorkspaceDb>,
    private readonly activityHistory: ActivityHistoryRepository
  ) {}

  async enqueueWorkspaceJob(recordInput: WorkspaceJobRecord): Promise<WorkspaceJobRecord> {
    const record = WorkspaceJobRecordSchema.parse(recordInput);
    if (record.kind !== "activity_processing" || record.status !== "queued" || record.attempt_count !== 0) {
      throw new Error("workspace_job_initial_state_invalid");
    }
    const activity = await this.activityHistory.getActivity(record.root_activity_id);
    if (!activity || activity.status === "recording" || activity.workspace_id !== record.workspace_id || activity.room_id !== record.room_id) {
      throw new Error("workspace_job_activity_scope_invalid");
    }
    await this.db.insertInto("workspace_jobs").values(workspaceJobToRow(record)).onConflict((conflict) => conflict.columns(["workspace_id", "idempotency_key"]).doNothing()).execute();
    const saved = await this.getWorkspaceJobByIdempotency({ workspaceId: record.workspace_id, idempotencyKey: record.idempotency_key });
    if (!saved) throw new Error("workspace_job_idempotency_claim_lost");
    if (!sameJobClaim(saved, record)) throw new Error("workspace_job_idempotency_conflict");
    return saved;
  }

  async getWorkspaceJob(id: string): Promise<WorkspaceJobRecord | undefined> {
    const row = await this.db.selectFrom("workspace_jobs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? workspaceJobFromRow(row) : undefined;
  }

  async getWorkspaceJobByIdempotency(input: { workspaceId: string; idempotencyKey: string }): Promise<WorkspaceJobRecord | undefined> {
    const row = await this.db.selectFrom("workspace_jobs").selectAll()
      .where("workspace_id", "=", input.workspaceId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    return row ? workspaceJobFromRow(row) : undefined;
  }

  async listWorkspaceJobs(input: {
    workspaceId: string;
    roomId?: string;
    rootActivityId?: string;
    status?: WorkspaceJobRecord["status"];
    limit?: number;
  }): Promise<WorkspaceJobRecord[]> {
    let query = this.db.selectFrom("workspace_jobs").selectAll().where("workspace_id", "=", input.workspaceId);
    if (input.roomId) query = query.where("room_id", "=", input.roomId);
    if (input.rootActivityId) query = query.where("root_activity_id", "=", input.rootActivityId);
    if (input.status) query = query.where("status", "=", input.status);
    return (await query.orderBy("created_at", "desc").limit(input.limit ?? 100).execute()).map(workspaceJobFromRow);
  }

  async getWorkspaceJobAttempt(id: string): Promise<WorkspaceJobAttemptRecord | undefined> {
    const row = await this.db.selectFrom("workspace_job_attempts").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? workspaceJobAttemptFromRow(row) : undefined;
  }

  async listWorkspaceJobAttempts(workspaceJobId: string): Promise<WorkspaceJobAttemptRecord[]> {
    return (await this.db.selectFrom("workspace_job_attempts").selectAll()
      .where("workspace_job_id", "=", workspaceJobId)
      .orderBy("attempt_no", "asc")
      .execute()).map(workspaceJobAttemptFromRow);
  }

  async claimWorkspaceJob(input: { workerId: string; leaseMs: number; now: string }): Promise<{ job: WorkspaceJobRecord; attempt: WorkspaceJobAttemptRecord } | undefined> {
    if (input.leaseMs <= 0) throw new Error("workspace_job_lease_duration_invalid");
    await this.reconcileExpiredWorkspaceJobs({ now: input.now });
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
    return this.db.transaction().execute(async (transaction) => {
      const candidates = await transaction.selectFrom("workspace_jobs").selectAll()
        .where("status", "=", "queued")
        .where((eb) => eb.or([eb("retry_after_at", "is", null), eb("retry_after_at", "<=", input.now)]))
        .orderBy("created_at", "asc")
        .limit(50)
        .execute();
      for (const candidateRow of candidates) {
        const candidate = workspaceJobFromRow(candidateRow);
        const updated = await transaction.updateTable("workspace_jobs").set({
          status: "running",
          attempt_count: candidate.attempt_count + 1,
          lease_owner: input.workerId,
          lease_expires_at: leaseExpiresAt,
          heartbeat_at: input.now,
          retry_after_at: null,
          error_code: null,
          started_at: candidate.started_at ?? input.now,
          updated_at: input.now,
          completed_at: null
        }).where("id", "=", candidate.id).where("status", "=", "queued").executeTakeFirst();
        if (Number(updated.numUpdatedRows ?? 0) !== 1) continue;
        const jobRow = await transaction.selectFrom("workspace_jobs").selectAll().where("id", "=", candidate.id).executeTakeFirstOrThrow();
        const job = workspaceJobFromRow(jobRow);
        const attempt = WorkspaceJobAttemptRecordSchema.parse({
          id: createId("workspace_job_attempt"),
          workspace_job_id: job.id,
          attempt_no: job.attempt_count,
          activity_id: job.root_activity_id,
          processor_id: job.processor_id,
          processor_version: job.processor_version,
          input_schema_version: "activity_processor.input/v1",
          resource_versions: [],
          diagnostics: [],
          status: "running",
          started_at: input.now
        });
        await transaction.insertInto("workspace_job_attempts").values(workspaceJobAttemptToRow(attempt)).execute();
        return { job, attempt };
      }
      return undefined;
    });
  }

  async prepareWorkspaceJobAttempt(input: {
    workspaceJobId: string;
    attemptId: string;
    workerId: string;
    processorInput: ActivityProcessorInput;
    promptOrPolicyVersion?: string;
    now: string;
  }): Promise<WorkspaceJobAttemptRecord | undefined> {
    const processorInput = ActivityProcessorInputSchema.parse(input.processorInput);
    return this.db.transaction().execute(async (transaction) => {
      const jobRow = await transaction.selectFrom("workspace_jobs").selectAll().where("id", "=", input.workspaceJobId).executeTakeFirst();
      if (!jobRow) return undefined;
      const job = workspaceJobFromRow(jobRow);
      if (!hasActiveLease(job, input.workerId, input.now)) return undefined;
      if (processorInput.activity.id !== job.root_activity_id) throw new Error("workspace_job_attempt_conflict");
      const attemptRow = await transaction.selectFrom("workspace_job_attempts").selectAll().where("id", "=", input.attemptId).executeTakeFirst();
      if (!attemptRow) throw new Error("workspace_job_attempt_conflict");
      const attempt = workspaceJobAttemptFromRow(attemptRow);
      if (attempt.workspace_job_id !== job.id || attempt.status !== "running" || attempt.prepared_at) return undefined;
      const updated = await transaction.updateTable("workspace_job_attempts").set({
        resource_versions_json: stringify(processorInput.resource_versions),
        input_hash: core07Hash(processorInput),
        prompt_or_policy_version: input.promptOrPolicyVersion ?? null,
        prepared_at: input.now
      }).where("id", "=", attempt.id).where("status", "=", "running").where("prepared_at", "is", null).executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) !== 1) return undefined;
      const saved = await transaction.selectFrom("workspace_job_attempts").selectAll().where("id", "=", attempt.id).executeTakeFirst();
      return saved ? workspaceJobAttemptFromRow(saved) : undefined;
    });
  }

  async heartbeatWorkspaceJob(input: { workspaceJobId: string; attemptId: string; workerId: string; leaseMs: number; now: string }): Promise<WorkspaceJobRecord | undefined> {
    if (input.leaseMs <= 0) throw new Error("workspace_job_lease_duration_invalid");
    return this.db.transaction().execute(async (transaction) => {
      const attempt = await transaction.selectFrom("workspace_job_attempts").select(["workspace_job_id", "status"])
        .where("id", "=", input.attemptId)
        .executeTakeFirst();
      if (!attempt || attempt.workspace_job_id !== input.workspaceJobId || attempt.status !== "running") return undefined;
      const updated = await transaction.updateTable("workspace_jobs").set({
        heartbeat_at: input.now,
        lease_expires_at: new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
        updated_at: input.now
      }).where("id", "=", input.workspaceJobId)
        .where("status", "=", "running")
        .where("lease_owner", "=", input.workerId)
        .where("lease_expires_at", ">", input.now)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) !== 1) return undefined;
      const row = await transaction.selectFrom("workspace_jobs").selectAll().where("id", "=", input.workspaceJobId).executeTakeFirst();
      return row ? workspaceJobFromRow(row) : undefined;
    });
  }

  async isWorkspaceJobCancellationRequested(input: { workspaceJobId: string; workerId: string }): Promise<boolean> {
    const job = await this.getWorkspaceJob(input.workspaceJobId);
    return Boolean(job && job.status === "running" && job.lease_owner === input.workerId && job.cancel_requested_at);
  }

  async requestWorkspaceJobCancel(input: { workspaceJobId: string; now: string }): Promise<WorkspaceJobRecord | undefined> {
    const current = await this.getWorkspaceJob(input.workspaceJobId);
    if (!current || current.status === "completed" || current.status === "failed" || current.status === "cancelled") return current;
    if (current.status === "queued") {
      assertWorkspaceJobStatusTransition(current.status, "cancelled");
      const updated = await this.db.updateTable("workspace_jobs").set({
        status: "cancelled", cancel_requested_at: input.now, error_code: "workspace_job_cancelled",
        completed_at: input.now, updated_at: input.now
      }).where("id", "=", current.id).where("status", "=", "queued").executeTakeFirst();
      return Number(updated.numUpdatedRows ?? 0) === 1 ? this.getWorkspaceJob(current.id) : undefined;
    }
    const updated = await this.db.updateTable("workspace_jobs").set({ cancel_requested_at: current.cancel_requested_at ?? input.now, updated_at: input.now })
      .where("id", "=", current.id).where("status", "=", "running").executeTakeFirst();
    return Number(updated.numUpdatedRows ?? 0) === 1 ? this.getWorkspaceJob(current.id) : undefined;
  }

  async completeWorkspaceJob(input: { workspaceJobId: string; attemptId: string; workerId: string; result: ProcessorResult; now: string }): Promise<WorkspaceJobRecord | undefined> {
    return this.finishWorkspaceJob(input, "completed");
  }

  async failWorkspaceJob(input: {
    workspaceJobId: string;
    attemptId: string;
    workerId: string;
    errorCode: string;
    retryable: boolean;
    retryAfterMs?: number;
    /** Used only by recovery to fence the expired lease it observed. */
    expectedLeaseExpiresAt?: string;
    now: string;
  }): Promise<WorkspaceJobRecord | undefined> {
    return this.finishWorkspaceJob(input, "failed");
  }

  async reconcileExpiredWorkspaceJobs(input: { now: string; retryAfterMs?: number } ): Promise<WorkspaceJobRecord[]> {
    const expired = await this.db.selectFrom("workspace_jobs").selectAll()
      .where("status", "=", "running")
      .where("lease_expires_at", "<=", input.now)
      .execute();
    const results: WorkspaceJobRecord[] = [];
    for (const row of expired) {
      const job = workspaceJobFromRow(row);
      const attempt = (await this.listWorkspaceJobAttempts(job.id)).at(-1);
      if (!attempt || !job.lease_owner) continue;
      const reconciled = await this.failWorkspaceJob({
        workspaceJobId: job.id,
        attemptId: attempt.id,
        workerId: job.lease_owner,
        errorCode: "workspace_job_lease_expired",
        retryable: true,
        retryAfterMs: input.retryAfterMs,
        expectedLeaseExpiresAt: job.lease_expires_at,
        now: input.now
      });
      if (reconciled) results.push(reconciled);
    }
    return results;
  }

  private async finishWorkspaceJob(
    input: (
      | { workspaceJobId: string; attemptId: string; workerId: string; result: ProcessorResult; now: string }
      | { workspaceJobId: string; attemptId: string; workerId: string; errorCode: string; retryable: boolean; retryAfterMs?: number; expectedLeaseExpiresAt?: string; now: string }
    ),
    requested: "completed" | "failed"
  ): Promise<WorkspaceJobRecord | undefined> {
    return this.db.transaction().execute(async (transaction) => {
      const jobRow = await transaction.selectFrom("workspace_jobs").selectAll().where("id", "=", input.workspaceJobId).executeTakeFirst();
      if (!jobRow) return undefined;
      const job = workspaceJobFromRow(jobRow);
      const failedInput = requested === "failed" ? input as Extract<typeof input, { errorCode: string }> : undefined;
      const expectedExpiredLease = failedInput?.expectedLeaseExpiresAt;
      const ownsLiveLease = hasActiveLease(job, input.workerId, input.now);
      const ownsObservedExpiredLease = Boolean(
        expectedExpiredLease
          && job.status === "running"
          && job.lease_owner === input.workerId
          && job.lease_expires_at === expectedExpiredLease
          && job.lease_expires_at <= input.now
      );
      if (!ownsLiveLease && !ownsObservedExpiredLease) return undefined;
      const attemptRow = await transaction.selectFrom("workspace_job_attempts").selectAll().where("id", "=", input.attemptId).executeTakeFirst();
      if (!attemptRow) throw new Error("workspace_job_attempt_conflict");
      const attempt = workspaceJobAttemptFromRow(attemptRow);
      if (attempt.workspace_job_id !== job.id || attempt.status !== "running") throw new Error("workspace_job_attempt_conflict");

      const cancelled = Boolean(job.cancel_requested_at);
      const resultInput = requested === "completed" ? input as Extract<typeof input, { result: ProcessorResult }> : undefined;
      if (requested === "completed" && !cancelled && (!attempt.prepared_at || !attempt.input_hash)) {
        throw new Error("workspace_job_attempt_not_prepared");
      }
      const mayRetry = !cancelled && requested === "failed" && Boolean(failedInput?.retryable) && job.retryable && job.attempt_count < job.max_attempts;
      const jobStatus: WorkspaceJobRecord["status"] = cancelled ? "cancelled" : mayRetry ? "queued" : requested === "completed" ? "completed" : "failed";
      assertWorkspaceJobStatusTransition(job.status, jobStatus);
      const attemptStatus: WorkspaceJobAttemptRecord["status"] = cancelled ? "cancelled" : requested;
      const safeResult = resultInput && !cancelled ? sanitizeProcessorResult(resultInput.result) : undefined;
      const attemptNext = WorkspaceJobAttemptRecordSchema.parse({
        ...attempt,
        ...(safeResult ? {
          output_schema_version: safeResult.outputSchemaVersion,
          output: safeResult.output,
          output_hash: core07Hash(safeResult.output),
          summary: safeResult.summary,
          diagnostics: safeResult.diagnostics,
          ...(safeResult.model ? { model: safeResult.model } : {})
        } : {}),
        status: attemptStatus,
        ...(attemptStatus === "completed" ? {} : { error_code: cancelled ? "workspace_job_cancelled" : failedInput?.errorCode ?? "workspace_job_failed" }),
        completed_at: input.now
      });
      const retryDelay = failedInput?.retryAfterMs ?? 1_000;
      const next = WorkspaceJobRecordSchema.parse({
        ...job,
        status: jobStatus,
        lease_owner: undefined,
        lease_expires_at: undefined,
        heartbeat_at: undefined,
        retry_after_at: mayRetry ? new Date(Date.parse(input.now) + retryDelay).toISOString() : undefined,
        error_code: cancelled ? "workspace_job_cancelled" : requested === "failed" ? failedInput?.errorCode : undefined,
        updated_at: input.now,
        ...(jobStatus === "completed" || jobStatus === "failed" || jobStatus === "cancelled" ? { completed_at: input.now } : { completed_at: undefined })
      });
      const updated = await transaction.updateTable("workspace_jobs").set(workspaceJobToRow(next))
        .where("id", "=", job.id)
        .where("status", "=", "running")
        .where("lease_owner", "=", input.workerId)
        .where("lease_expires_at", "=", job.lease_expires_at!)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) !== 1) return undefined;
      const updatedAttempt = await transaction.updateTable("workspace_job_attempts")
        .set(workspaceJobAttemptToRow(attemptNext))
        .where("id", "=", attempt.id)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (Number(updatedAttempt.numUpdatedRows ?? 0) !== 1) throw new Error("workspace_job_attempt_conflict");
      return next;
    });
  }
}

function sameJobClaim(existing: WorkspaceJobRecord, requested: WorkspaceJobRecord): boolean {
  return stableStringify({
    workspace_id: existing.workspace_id,
    room_id: existing.room_id,
    root_activity_id: existing.root_activity_id,
    kind: existing.kind,
    processor_id: existing.processor_id,
    processor_version: existing.processor_version,
    idempotency_key: existing.idempotency_key,
    max_attempts: existing.max_attempts,
    retryable: existing.retryable
  }) === stableStringify({
    workspace_id: requested.workspace_id,
    room_id: requested.room_id,
    root_activity_id: requested.root_activity_id,
    kind: requested.kind,
    processor_id: requested.processor_id,
    processor_version: requested.processor_version,
    idempotency_key: requested.idempotency_key,
    max_attempts: requested.max_attempts,
    retryable: requested.retryable
  });
}

function hasActiveLease(job: WorkspaceJobRecord, workerId: string, now: string): boolean {
  return job.status === "running"
    && job.lease_owner === workerId
    && Boolean(job.lease_expires_at)
    && job.lease_expires_at! > now;
}

function sanitizeProcessorResult(result: ProcessorResult): ProcessorResult {
  return {
    ...result,
    output: redactPrivateData(result.output, { redactPii: true }),
    summary: redactPrivateData(result.summary, { redactPii: true }),
    diagnostics: result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      summary: redactPrivateData(diagnostic.summary, { redactPii: true })
    }))
  };
}

function core07Hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
