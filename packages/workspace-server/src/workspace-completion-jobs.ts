import { createHash } from "node:crypto";
import { canonicalJson, createInternalWorkspaceMaintenanceCaller, isTrustedWorkspaceCallerForAccount } from "./auth";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import type {
  WorkspaceCompletionJob,
  WorkspaceCompletionJobAttempt
} from "./workspace-completion-types";
import type { WorkspaceRequestContext } from "./types";
import type {
  WorkspaceCompletionReviewResult,
  WorkspaceCompletionReviewSnapshot,
  WorkspaceCompletionValidationIssue
} from "./workspace-completion-policy";
import {
  WorkspaceCompletionCuratorService,
  type WorkspaceCompletionSemanticCuratorPort
} from "./workspace-completion-curator";
import { WorkspaceCompletionService, type WorkspaceCompletionPage } from "./workspace-completion-service";
import type { WorkspaceSql } from "./postgres";

const maxLeaseMs = 5 * 60_000;
const minLeaseMs = 1_000;

export interface WorkspaceCompletionReviewPort {
  /** Implemented by a replaceable Backend cassette. It receives only the
   * reviewed Episode snapshot, never a database or file capability. */
  review(snapshot: WorkspaceCompletionReviewSnapshot, repair?: { issues: readonly WorkspaceCompletionValidationIssue[] }): Promise<WorkspaceCompletionReviewResult>;
}

export interface ClaimedWorkspaceCompletionReview {
  job: WorkspaceCompletionJob;
  attempt: WorkspaceCompletionJobAttempt;
  snapshot: WorkspaceCompletionReviewSnapshot;
  snapshotHash: string;
  repair?: { issues: readonly WorkspaceCompletionValidationIssue[] };
}

export interface ClaimedWorkspaceCompletionEvaluation {
  job: WorkspaceCompletionJob;
  attempt: WorkspaceCompletionJobAttempt;
  inputHash: string;
}

export interface ClaimedWorkspaceCompletionCurator extends ClaimedWorkspaceCompletionAttempt {
  mode: "light" | "semantic";
}

interface ClaimedWorkspaceCompletionAttempt {
  job: WorkspaceCompletionJob;
  attempt: WorkspaceCompletionJobAttempt;
}

export interface WorkspaceCompletionJobRunResult {
  status: "idle" | "blocked" | "completed" | "repairable_validation" | "stale_input" | "failed";
  jobId?: string;
  issues?: readonly WorkspaceCompletionValidationIssue[];
  evaluationCount?: number;
  curatorStatus?: string;
}

/** The maintenance caller supplies a dedicated account identity.  It never
 * borrows a browser Session or a human request's operation ID. */
export class WorkspaceCompletionJobService {
  constructor(readonly completion: WorkspaceCompletionService) {}

  async listJobs(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; limit?: number; status?: WorkspaceCompletionJob["status"] }): Promise<WorkspaceCompletionJob[]> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    return this.completion.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<JobRow>(
        `SELECT * FROM workspace_completion_jobs
         WHERE workspace_id = $1 AND room_id = $2 AND ($3::TEXT IS NULL OR status = $3)
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [context.workspaceId, input.roomId, input.status ?? null, limit]
      );
      return rows.rows.map(jobFromRow);
    });
  }

  async listJobsPage(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; limit?: number; status?: WorkspaceCompletionJob["status"]; cursor?: string }
  ): Promise<WorkspaceCompletionPage<WorkspaceCompletionJob>> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    const afterId = decodeCompletionCursor(input.cursor);
    return this.completion.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<JobRow>(
        `SELECT * FROM workspace_completion_jobs
         WHERE workspace_id = $1 AND room_id = $2 AND ($3::TEXT IS NULL OR status = $3)
           AND ($4::TEXT IS NULL OR id > $4)
         ORDER BY id ASC LIMIT $5`,
        [context.workspaceId, input.roomId, input.status ?? null, afterId ?? null, limit + 1]
      );
      const jobs = rows.rows.map(jobFromRow);
      const items = jobs.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items,
        ...(jobs.length > limit && last ? { nextCursor: encodeCompletionCursor(last.id) } : {})
      };
    });
  }

  async listAttempts(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, jobId: string, limit?: number): Promise<WorkspaceCompletionJobAttempt[]> {
    assertOpaqueId(jobId, "workspace_completion_job_id_invalid");
    const bounded = boundedLimit(limit);
    return this.completion.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<AttemptRow>(
        "SELECT * FROM workspace_completion_job_attempts WHERE workspace_id = $1 AND job_id = $2 ORDER BY attempt_no ASC LIMIT $3",
        [context.workspaceId, jobId, bounded]
      );
      return rows.rows.map(attemptFromRow);
    });
  }

  async enqueueCurator(
    context: WorkspaceRequestContext,
    input: { roomId: string; mode: "light" | "semantic"; inputHash: string }
  ): Promise<WorkspaceCompletionJob> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    if (!/^[a-f0-9]{64}$/.test(input.inputHash)) throw new WorkspaceServerError("workspace_completion_job_input_hash_invalid", 400);
    const configuration = await this.completion.getEffectiveConfiguration(context, input.roomId);
    const idempotencyKey = `curator:${input.roomId}:${input.mode}:${input.inputHash}`;
    const jobId = completionId("completion_curator_job", context.workspaceId, idempotencyKey);
    return this.completion.store.runIdempotentResult(context, {
      action: "workspace.completion.curator.enqueue",
      input: { ...input, id: jobId, configuration_version: configuration.version }
    }, async (sql) => {
      await this.completion.assertOperationAllowed(sql, context, input.roomId, "curator.apply", "execute", { maintenance_job: "curator", mode: input.mode });
      const inserted = await sql.query<JobRow>(
        `INSERT INTO workspace_completion_jobs(
           workspace_id, room_id, id, kind, status, idempotency_key, group_key, high_watermark, input_hash,
           configuration_version, max_attempts, created_by, updated_by
         ) VALUES ($1, $2, $3, 'curator', 'queued', $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (workspace_id, idempotency_key) DO UPDATE SET id = workspace_completion_jobs.id
         RETURNING *`,
        [context.workspaceId, input.roomId, jobId, idempotencyKey, input.mode, `curator:${input.mode}`, input.inputHash, configuration.version, configuration.values.reviewMaxAttempts, context.accountId]
      );
      return jobFromRow(inserted.rows[0]!);
    }).then((saved) => saved.value);
  }

  async claimReview(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { workerId: string; roomId?: string; leaseMs?: number }
  ): Promise<ClaimedWorkspaceCompletionReview | { blocked: true; jobId: string } | undefined> {
    assertOpaqueId(input.workerId, "workspace_completion_worker_id_invalid");
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    const leaseMs = input.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < minLeaseMs || leaseMs > maxLeaseMs) throw new WorkspaceServerError("workspace_completion_lease_invalid", 400);
    // We obtain the chosen job first, then snapshot it before claiming. The
    // stored hash below rejects any input that changes before apply.
    const candidate = await this.completion.store.database.withContext(context, async (sql) => {
      await sql.query(
        `UPDATE workspace_completion_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = NOW()
         WHERE workspace_id = $1 AND status = 'running' AND lease_expires_at < NOW()`,
        [context.workspaceId]
      );
      const selected = await sql.query<JobRow>(
        `SELECT * FROM workspace_completion_jobs
         WHERE workspace_id = $1 AND kind = 'review' AND status = 'queued' AND ($2::TEXT IS NULL OR room_id = $2)
         ORDER BY updated_at ASC, id ASC LIMIT 1`,
        [context.workspaceId, input.roomId ?? null]
      );
      return selected.rows[0] ? jobFromRow(selected.rows[0]) : undefined;
    });
    if (!candidate) return undefined;
    if (!candidate.groupKey || !candidate.highWatermark) {
      throw new WorkspaceServerError("workspace_completion_review_snapshot_identity_missing", 500);
    }
    let snapshot: WorkspaceCompletionReviewSnapshot;
    try {
      snapshot = await this.completion.createReviewSnapshot(context, candidate.groupKey, {
        highWatermarkActivityId: candidate.highWatermark
      });
    } catch (error) {
      if (error instanceof WorkspaceServerError && error.code === "workspace_completion_review_snapshot_limit_exceeded") {
        await this.blockReviewSnapshotLimit(context, candidate, error);
        return { blocked: true, jobId: candidate.id };
      }
      throw error;
    }
    const snapshotHash = hashSnapshot(snapshot);
    return this.completion.store.database.withContext(context, async (sql) => {
      const selected = await sql.query<JobRow>(
        `SELECT * FROM workspace_completion_jobs
         WHERE workspace_id = $1 AND id = $2 AND status = 'queued' FOR UPDATE SKIP LOCKED`,
        [context.workspaceId, candidate.id]
      );
      const current = selected.rows[0];
      if (!current) return undefined;
      const job = jobFromRow(current);
      await this.completion.assertOperationAllowed(sql, context, job.roomId, "activity.ingest", "execute", { maintenance_job: "review" });
      const updated = await sql.query<JobRow>(
        `UPDATE workspace_completion_jobs
         SET status = 'running', attempt_count = attempt_count + 1, lease_owner = $3,
             lease_expires_at = NOW() + ($4::BIGINT * INTERVAL '1 millisecond'), heartbeat_at = NOW(),
             input_hash = $5, updated_by = $6, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND status = 'queued' RETURNING *`,
        [context.workspaceId, job.id, input.workerId, leaseMs, snapshotHash, context.accountId]
      );
      const claimedRow = updated.rows[0];
      if (!claimedRow) return undefined;
      const claimed = jobFromRow(claimedRow);
      const attemptId = completionId("completion_attempt", context.workspaceId, `${claimed.id}:${claimed.attemptCount}`);
      const attempt = await sql.query<AttemptRow>(
        `INSERT INTO workspace_completion_job_attempts(workspace_id, id, job_id, attempt_no, worker_id, status, input_hash, configuration_version)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7) RETURNING *`,
        [context.workspaceId, attemptId, claimed.id, claimed.attemptCount, input.workerId, snapshotHash, claimed.configurationVersion]
      );
      const repair = parseRepairIssues(job.blockedReason);
      return { job: claimed, attempt: attemptFromRow(attempt.rows[0]!), snapshot, snapshotHash, ...(repair.length ? { repair: { issues: repair } } : {}) };
    });
  }

  async claimEvaluation(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { workerId: string; roomId?: string; leaseMs?: number }
  ): Promise<ClaimedWorkspaceCompletionEvaluation | undefined> {
    assertOpaqueId(input.workerId, "workspace_completion_worker_id_invalid");
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    const leaseMs = input.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < minLeaseMs || leaseMs > maxLeaseMs) throw new WorkspaceServerError("workspace_completion_lease_invalid", 400);
    const candidate = await this.completion.store.database.withContext(context, async (sql) => {
      await sql.query(
        `UPDATE workspace_completion_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = NOW()
         WHERE workspace_id = $1 AND status = 'running' AND lease_expires_at < NOW()`,
        [context.workspaceId]
      );
      const selected = await sql.query<JobRow>(
        `SELECT * FROM workspace_completion_jobs
         WHERE workspace_id = $1 AND kind = 'evaluation' AND status = 'queued' AND ($2::TEXT IS NULL OR room_id = $2)
         ORDER BY updated_at ASC, id ASC LIMIT 1`,
        [context.workspaceId, input.roomId ?? null]
      );
      return selected.rows[0] ? jobFromRow(selected.rows[0]) : undefined;
    });
    if (!candidate) return undefined;
    if (!candidate.groupKey || !candidate.highWatermark) throw new WorkspaceServerError("workspace_completion_evaluation_input_missing", 500);
    const inputHash = await this.completion.evaluationJobInputHash(context, { episodeId: candidate.groupKey, activityId: candidate.highWatermark });
    return this.completion.store.database.withContext(context, async (sql) => {
      const selected = await sql.query<JobRow>(
        `SELECT * FROM workspace_completion_jobs
         WHERE workspace_id = $1 AND id = $2 AND status = 'queued' FOR UPDATE SKIP LOCKED`,
        [context.workspaceId, candidate.id]
      );
      const current = selected.rows[0];
      if (!current) return undefined;
      const job = jobFromRow(current);
      if (job.kind !== "evaluation") return undefined;
      await this.completion.assertOperationAllowed(sql, context, job.roomId, "activity.ingest", "execute", { maintenance_job: "evaluation" });
      const updated = await sql.query<JobRow>(
        `UPDATE workspace_completion_jobs
         SET status = 'running', attempt_count = attempt_count + 1, lease_owner = $3,
             lease_expires_at = NOW() + ($4::BIGINT * INTERVAL '1 millisecond'), heartbeat_at = NOW(),
             input_hash = $5, updated_by = $6, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND status = 'queued' RETURNING *`,
        [context.workspaceId, job.id, input.workerId, leaseMs, inputHash, context.accountId]
      );
      const claimedRow = updated.rows[0];
      if (!claimedRow) return undefined;
      const claimed = jobFromRow(claimedRow);
      const attemptId = completionId("completion_attempt", context.workspaceId, `${claimed.id}:${claimed.attemptCount}`);
      const attempt = await sql.query<AttemptRow>(
        `INSERT INTO workspace_completion_job_attempts(workspace_id, id, job_id, attempt_no, worker_id, status, input_hash, configuration_version)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7) RETURNING *`,
        [context.workspaceId, attemptId, claimed.id, claimed.attemptCount, input.workerId, inputHash, claimed.configurationVersion]
      );
      return { job: claimed, attempt: attemptFromRow(attempt.rows[0]!), inputHash };
    });
  }

  async claimCurator(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { workerId: string; roomId?: string; leaseMs?: number }
  ): Promise<ClaimedWorkspaceCompletionCurator | undefined> {
    assertOpaqueId(input.workerId, "workspace_completion_worker_id_invalid");
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    const leaseMs = input.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < minLeaseMs || leaseMs > maxLeaseMs) throw new WorkspaceServerError("workspace_completion_lease_invalid", 400);
    const candidate = await this.completion.store.database.withContext(context, async (sql) => {
      await sql.query(
        `UPDATE workspace_completion_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = NOW()
         WHERE workspace_id = $1 AND status = 'running' AND lease_expires_at < NOW()`,
        [context.workspaceId]
      );
      const selected = await sql.query<JobRow>(
        `SELECT * FROM workspace_completion_jobs
         WHERE workspace_id = $1 AND kind = 'curator' AND status = 'queued' AND ($2::TEXT IS NULL OR room_id = $2)
         ORDER BY updated_at ASC, id ASC LIMIT 1`,
        [context.workspaceId, input.roomId ?? null]
      );
      return selected.rows[0] ? jobFromRow(selected.rows[0]) : undefined;
    });
    if (!candidate) return undefined;
    const mode = candidate.groupKey === "semantic" ? "semantic" : candidate.groupKey === "light" ? "light" : undefined;
    if (!mode) throw new WorkspaceServerError("workspace_completion_curator_mode_invalid", 500);
    return this.completion.store.database.withContext(context, async (sql) => {
      const selected = await sql.query<JobRow>(
        `SELECT * FROM workspace_completion_jobs
         WHERE workspace_id = $1 AND id = $2 AND kind = 'curator' AND status = 'queued' FOR UPDATE SKIP LOCKED`,
        [context.workspaceId, candidate.id]
      );
      const current = selected.rows[0];
      if (!current) return undefined;
      const job = jobFromRow(current);
      await this.completion.assertOperationAllowed(sql, context, job.roomId, "curator.apply", "execute", { maintenance_job: "curator", mode });
      const updated = await sql.query<JobRow>(
        `UPDATE workspace_completion_jobs
         SET status = 'running', attempt_count = attempt_count + 1, lease_owner = $3,
             lease_expires_at = NOW() + ($4::BIGINT * INTERVAL '1 millisecond'), heartbeat_at = NOW(), updated_by = $5, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND status = 'queued' RETURNING *`,
        [context.workspaceId, job.id, input.workerId, leaseMs, context.accountId]
      );
      const claimedRow = updated.rows[0];
      if (!claimedRow) return undefined;
      const claimed = jobFromRow(claimedRow);
      const attemptId = completionId("completion_attempt", context.workspaceId, `${claimed.id}:${claimed.attemptCount}`);
      const attempt = await sql.query<AttemptRow>(
        `INSERT INTO workspace_completion_job_attempts(workspace_id, id, job_id, attempt_no, worker_id, status, input_hash, configuration_version)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7) RETURNING *`,
        [context.workspaceId, attemptId, claimed.id, claimed.attemptCount, input.workerId, claimed.inputHash, claimed.configurationVersion]
      );
      return { job: claimed, attempt: attemptFromRow(attempt.rows[0]!), mode };
    });
  }

  async heartbeat(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { jobId: string; workerId: string; leaseMs?: number }): Promise<void> {
    assertOpaqueId(input.jobId, "workspace_completion_job_id_invalid");
    assertOpaqueId(input.workerId, "workspace_completion_worker_id_invalid");
    const leaseMs = input.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < minLeaseMs || leaseMs > maxLeaseMs) throw new WorkspaceServerError("workspace_completion_lease_invalid", 400);
    await this.completion.store.database.withContext(context, async (sql) => {
      const updated = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_jobs SET heartbeat_at = NOW(), lease_expires_at = NOW() + ($4::BIGINT * INTERVAL '1 millisecond'), updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND status = 'running' AND lease_owner = $3 AND lease_expires_at >= NOW() RETURNING id`,
        [context.workspaceId, input.jobId, input.workerId, leaseMs]
      );
      if (!updated.rows[0]) throw new WorkspaceServerError("workspace_completion_job_lease_lost", 409);
    });
  }

  async runOneReview(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "caller">, input: { workerId: string; port: WorkspaceCompletionReviewPort; roomId?: string }): Promise<WorkspaceCompletionJobRunResult> {
    const claimed = await this.claimReview(context, { workerId: input.workerId, ...(input.roomId ? { roomId: input.roomId } : {}) });
    if (!claimed) return { status: "idle" };
    if ("blocked" in claimed) return { status: "blocked", jobId: claimed.jobId };
    const workerContext = workerOperationContext(context, "completion_review_apply", `${claimed.job.id}:${claimed.attempt.id}`);
    try {
      const result = await input.port.review(claimed.snapshot, claimed.repair);
      const latest = await this.completion.createReviewSnapshot(context, claimed.snapshot.episodeId, {
        highWatermarkActivityId: claimed.snapshot.highWatermarkActivityId
      });
      if (hashSnapshot(latest) !== claimed.snapshotHash) {
        await this.closeStale(workerContext, claimed, "workspace_completion_review_stale_input");
        return { status: "stale_input", jobId: claimed.job.id };
      }
      await this.completion.applyReviewResult(workerContext, {
        snapshot: claimed.snapshot,
        result,
        jobId: claimed.job.id,
        attemptId: claimed.attempt.id,
        workerId: input.workerId
      });
      return { status: "completed", jobId: claimed.job.id };
    } catch (error) {
      if (error instanceof WorkspaceServerError && error.status === 422) {
        const issues = extractValidationIssues(error);
        await this.closeRepairable(workerContext, claimed, issues);
        return { status: "repairable_validation", jobId: claimed.job.id, issues };
      }
      await this.closeFailed(workerContext, claimed, error instanceof WorkspaceServerError ? error.code : "workspace_completion_review_failed");
      return { status: "failed", jobId: claimed.job.id };
    }
  }

  async runOneEvaluation(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "caller">,
    input: { workerId: string; roomId?: string }
  ): Promise<WorkspaceCompletionJobRunResult> {
    const claimed = await this.claimEvaluation(context, { workerId: input.workerId, ...(input.roomId ? { roomId: input.roomId } : {}) });
    if (!claimed) return { status: "idle" };
    const workerContext = workerOperationContext(context, "completion_evaluation_apply", `${claimed.job.id}:${claimed.attempt.id}`);
    try {
      const result = await this.completion.applyEvaluationJob(workerContext, {
        jobId: claimed.job.id,
        attemptId: claimed.attempt.id,
        workerId: input.workerId,
        expectedInputHash: claimed.inputHash
      });
      return { status: "completed", jobId: claimed.job.id, evaluationCount: result.evaluations.length };
    } catch (error) {
      const code = error instanceof WorkspaceServerError ? error.code : "workspace_completion_evaluation_failed";
      if (code === "workspace_completion_evaluation_stale_input") {
        await this.closeStale(workerContext, claimed, code);
        return { status: "stale_input", jobId: claimed.job.id };
      }
      await this.closeFailed(workerContext, claimed, code);
      return { status: "failed", jobId: claimed.job.id };
    }
  }

  async runOneCurator(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "caller">,
    input: { workerId: string; curator: WorkspaceCompletionCuratorService; semanticPort?: WorkspaceCompletionSemanticCuratorPort; roomId?: string }
  ): Promise<WorkspaceCompletionJobRunResult> {
    const claimed = await this.claimCurator(context, { workerId: input.workerId, ...(input.roomId ? { roomId: input.roomId } : {}) });
    if (!claimed) return { status: "idle" };
    const workerContext = workerOperationContext(context, "completion_curator_apply", `${claimed.job.id}:${claimed.attempt.id}`);
    try {
      const latestHash = await input.curator.inputHash(context, { roomId: claimed.job.roomId, mode: claimed.mode });
      if (latestHash !== claimed.job.inputHash) {
        await this.closeStale(workerContext, claimed, "workspace_completion_curator_stale_input");
        return { status: "stale_input", jobId: claimed.job.id };
      }
      const report = claimed.mode === "light"
        ? await input.curator.runLight(workerContext, { roomId: claimed.job.roomId })
        : input.semanticPort
          ? await input.curator.runSemantic(workerContext, { roomId: claimed.job.roomId, port: input.semanticPort })
          : undefined;
      if (!report) {
        await this.closeFailed(workerContext, claimed, "workspace_completion_semantic_curator_unavailable");
        return { status: "failed", jobId: claimed.job.id };
      }
      await this.closeCompleted(workerContext, claimed, hashText(canonicalJson(report)));
      return { status: "completed", jobId: claimed.job.id, curatorStatus: report.status };
    } catch (error) {
      const code = error instanceof WorkspaceServerError ? error.code : "workspace_completion_curator_failed";
      if (code === "workspace_completion_curator_stale_input") {
        await this.closeStale(workerContext, claimed, code);
        return { status: "stale_input", jobId: claimed.job.id };
      }
      await this.closeFailed(workerContext, claimed, code);
      return { status: "failed", jobId: claimed.job.id };
    }
  }

  async recover(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<number> {
    return this.completion.store.database.withContext(context, async (sql) => {
      const recovered = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = NOW()
         WHERE workspace_id = $1 AND status = 'running' AND lease_expires_at < NOW() RETURNING id`,
        [context.workspaceId]
      );
      return recovered.rows.length;
    });
  }

  /** A Review Job cannot be processed without the host-owned review cassette.
   * Keep the missing capability explicit instead of leaving the Job queued
   * forever in a normal Server process that was started without that cassette. */
  async blockQueuedReviewsWithoutPort(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { limit?: number } = {}
  ): Promise<number> {
    const limit = boundedLimit(input.limit ?? 100);
    return this.completion.store.database.withContext(context, async (sql) => {
      const blocked = await sql.query<{ id: string }>(
        `WITH candidates AS (
           SELECT id FROM workspace_completion_jobs
           WHERE workspace_id = $1 AND kind = 'review' AND status = 'queued'
           ORDER BY updated_at ASC, id ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE workspace_completion_jobs AS job
         SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
             blocked_reason = $3, updated_by = $4, updated_at = NOW()
         FROM candidates
         WHERE job.workspace_id = $1 AND job.id = candidates.id
         RETURNING job.id`,
        [context.workspaceId, limit, JSON.stringify({ code: "workspace_completion_review_port_unavailable", retryable: false }), context.accountId]
      );
      return blocked.rows.length;
    });
  }

  /** An oversized snapshot is not a retryable worker failure: handing an
   * incomplete episode to the Review cassette would make its decision
   * unsound. Keep the reason as structured data so a human can deliberately
   * raise the configured bound or split the Episode. */
  private async blockReviewSnapshotLimit(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    job: WorkspaceCompletionJob,
    error: WorkspaceServerError
  ): Promise<void> {
    await this.completion.store.database.withContext(context, async (sql) => {
      await sql.query(
        `UPDATE workspace_completion_jobs
         SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
             blocked_reason = $3, updated_by = $4, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND status = 'queued'`,
        [
          context.workspaceId,
          job.id,
          JSON.stringify({ code: error.code, ...(error.details ?? {}) }),
          context.accountId
        ]
      );
    });
  }

  private async closeRepairable(context: WorkspaceRequestContext, claimed: ClaimedWorkspaceCompletionReview, issues: readonly WorkspaceCompletionValidationIssue[]): Promise<void> {
    await this.completion.store.database.withContext(context, async (sql) => {
      const attempt = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_job_attempts SET status = 'repairable_validation', error_code = 'workspace_completion_review_validation', completed_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND job_id = $3 AND worker_id = $4 AND status = 'running' RETURNING id`,
        [context.workspaceId, claimed.attempt.id, claimed.job.id, claimed.attempt.workerId]
      );
      if (!attempt.rows[0]) throw new WorkspaceServerError("workspace_completion_job_attempt_lease_lost", 409);
      await this.updateJobAfterAttempt(sql, context, claimed, "workspace_completion_review_validation", issues);
    });
  }

  private async closeStale(context: WorkspaceRequestContext, claimed: ClaimedWorkspaceCompletionAttempt, code: string): Promise<void> {
    await this.completion.store.database.withContext(context, async (sql) => {
      const attempt = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_job_attempts SET status = 'failed', error_code = $5, completed_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND job_id = $3 AND worker_id = $4 AND status = 'running' RETURNING id`,
        [context.workspaceId, claimed.attempt.id, claimed.job.id, claimed.attempt.workerId, code]
      );
      if (!attempt.rows[0]) throw new WorkspaceServerError("workspace_completion_job_attempt_lease_lost", 409);
      await this.updateJobAfterAttempt(sql, context, claimed, code);
    });
  }

  private async closeFailed(context: WorkspaceRequestContext, claimed: ClaimedWorkspaceCompletionAttempt, code: string): Promise<void> {
    await this.completion.store.database.withContext(context, async (sql) => {
      const attempt = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_job_attempts SET status = 'failed', error_code = $5, completed_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND job_id = $3 AND worker_id = $4 AND status = 'running' RETURNING id`,
        [context.workspaceId, claimed.attempt.id, claimed.job.id, claimed.attempt.workerId, code]
      );
      if (!attempt.rows[0]) throw new WorkspaceServerError("workspace_completion_job_attempt_lease_lost", 409);
      await this.updateJobAfterAttempt(sql, context, claimed, code);
    });
  }

  private async closeCompleted(context: WorkspaceRequestContext, claimed: ClaimedWorkspaceCompletionAttempt, outputHash: string): Promise<void> {
    await this.completion.store.database.withContext(context, async (sql) => {
      const attempt = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_job_attempts SET status = 'completed', output_hash = $5, completed_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND job_id = $3 AND worker_id = $4 AND status = 'running' RETURNING id`,
        [context.workspaceId, claimed.attempt.id, claimed.job.id, claimed.attempt.workerId, outputHash]
      );
      if (!attempt.rows[0]) throw new WorkspaceServerError("workspace_completion_job_attempt_lease_lost", 409);
      const job = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_jobs SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           completed_at = NOW(), updated_by = $4, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND lease_owner = $3 AND status = 'running' RETURNING id`,
        [context.workspaceId, claimed.job.id, claimed.attempt.workerId, context.accountId]
      );
      if (!job.rows[0]) throw new WorkspaceServerError("workspace_completion_job_lease_lost", 409);
    });
  }

  private async updateJobAfterAttempt(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    claimed: ClaimedWorkspaceCompletionAttempt,
    code: string,
    issues?: readonly WorkspaceCompletionValidationIssue[]
  ): Promise<void> {
    const current = await sql.query<JobRow>("SELECT * FROM workspace_completion_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [context.workspaceId, claimed.job.id]);
    const job = current.rows[0];
    if (!job || job.lease_owner !== claimed.attempt.workerId || job.status !== "running") throw new WorkspaceServerError("workspace_completion_job_lease_lost", 409);
    const attemptCount = Number(job.attempt_count);
    const maxAttempts = Number(job.max_attempts);
    const terminal = attemptCount >= maxAttempts;
    const updated = await sql.query<{ id: string }>(
      `UPDATE workspace_completion_jobs
       SET status = $3, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           blocked_reason = $4, completed_at = CASE WHEN $3 = 'failed' THEN NOW() ELSE NULL END,
           updated_by = $5, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2 AND lease_owner = $6 AND status = 'running' RETURNING id`,
      [context.workspaceId, claimed.job.id, terminal ? "failed" : "queued", terminal ? code : JSON.stringify({ code, ...(issues ? { issues } : {}) }), context.accountId, claimed.attempt.workerId]
    );
    if (!updated.rows[0]) throw new WorkspaceServerError("workspace_completion_job_lease_lost", 409);
  }
}

interface JobRow {
  workspace_id: string;
  room_id: string;
  id: string;
  kind: WorkspaceCompletionJob["kind"];
  status: WorkspaceCompletionJob["status"];
  idempotency_key: string;
  group_key: string | null;
  high_watermark: string | null;
  input_hash: string;
  configuration_version: number | string;
  attempt_count: number | string;
  max_attempts: number | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null;
  blocked_reason: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface AttemptRow {
  workspace_id: string;
  id: string;
  job_id: string;
  attempt_no: number | string;
  worker_id: string;
  status: WorkspaceCompletionJobAttempt["status"];
  input_hash: string;
  output_hash: string | null;
  error_code: string | null;
  configuration_version: number | string;
  started_at: Date | string;
  completed_at: Date | string | null;
}

function jobFromRow(row: JobRow): WorkspaceCompletionJob {
  return {
    workspaceId: row.workspace_id, roomId: row.room_id, id: row.id, kind: row.kind, status: row.status,
    idempotencyKey: row.idempotency_key, ...(row.group_key ? { groupKey: row.group_key } : {}), ...(row.high_watermark ? { highWatermark: row.high_watermark } : {}),
    inputHash: row.input_hash, configurationVersion: Number(row.configuration_version), attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}), ...(row.heartbeat_at ? { heartbeatAt: iso(row.heartbeat_at) } : {}), ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    createdBy: row.created_by, updatedBy: row.updated_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {})
  };
}

function attemptFromRow(row: AttemptRow): WorkspaceCompletionJobAttempt {
  return {
    workspaceId: row.workspace_id, id: row.id, jobId: row.job_id, attemptNo: Number(row.attempt_no), workerId: row.worker_id,
    status: row.status, inputHash: row.input_hash, ...(row.output_hash ? { outputHash: row.output_hash } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}),
    configurationVersion: Number(row.configuration_version), startedAt: iso(row.started_at), ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {})
  };
}

function workerOperationContext(
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "caller">,
  prefix: string,
  input: string
): WorkspaceRequestContext {
  const operationId = completionId(prefix, context.workspaceId, input);
  return {
    workspaceId: context.workspaceId,
    accountId: context.accountId,
    operationId,
    ...(isTrustedWorkspaceCallerForAccount(context.caller, context.accountId) && context.caller.kind === "maintenance" ? {
      caller: createInternalWorkspaceMaintenanceCaller({ principalAccountId: context.accountId, operationId })
    } : {})
  };
}

function hashSnapshot(snapshot: WorkspaceCompletionReviewSnapshot): string {
  return snapshot.digest;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function completionId(prefix: string, workspaceId: string, input: string): string {
  return `${prefix}_${createHash("sha256").update(`${workspaceId}:${input}`).digest("hex").slice(0, 40)}`;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new WorkspaceServerError("workspace_completion_page_limit_invalid", 400);
  return value;
}

function encodeCompletionCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

function decodeCompletionCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: unknown };
    if (typeof decoded.id !== "string" || decoded.id.length === 0 || decoded.id.length > 256) throw new Error("invalid cursor");
    return decoded.id;
  } catch {
    throw new WorkspaceServerError("workspace_completion_page_cursor_invalid", 400);
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function extractValidationIssues(error: WorkspaceServerError): WorkspaceCompletionValidationIssue[] {
  const issues = error.details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((issue): issue is WorkspaceCompletionValidationIssue => Boolean(issue) && typeof issue === "object" && typeof (issue as WorkspaceCompletionValidationIssue).path === "string" && typeof (issue as WorkspaceCompletionValidationIssue).code === "string" && typeof (issue as WorkspaceCompletionValidationIssue).expected === "string");
}

function parseRepairIssues(value: string | undefined): WorkspaceCompletionValidationIssue[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { code?: unknown; issues?: unknown };
    if (parsed.code !== "workspace_completion_review_validation" || !Array.isArray(parsed.issues)) return [];
    return parsed.issues.filter((issue): issue is WorkspaceCompletionValidationIssue => Boolean(issue) && typeof issue === "object"
      && typeof (issue as WorkspaceCompletionValidationIssue).path === "string"
      && typeof (issue as WorkspaceCompletionValidationIssue).code === "string"
      && typeof (issue as WorkspaceCompletionValidationIssue).expected === "string");
  } catch {
    return [];
  }
}
