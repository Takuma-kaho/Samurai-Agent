import { AutomationJobRecordSchema, AutomationRunRecordSchema, nowIso, type AutomationJobRecord, type AutomationRunRecord } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import type { AutomationQueueSummary } from "../workspace-store-contracts";
import { automationJobFromRow, automationJobToRow } from "./automation-row-codecs";
import { automationRunFromRow, automationRunToRow } from "./automation-run-row-codecs";
import { countAutomationJobs, isAutomationJobDue } from "./collection-codecs";

export interface AutomationRunSettlementInput {
  jobId: string;
  runId: string;
  lockOwnerToken: string;
  outcome: "completed" | "failed" | "blocked" | "manager_stopped";
  now: string;
  /** Used only for a successful recurring run. */
  nextRunAt?: string;
  /** Used only for ordinary retryable failures. */
  retryAfterAt?: string;
  errorCode?: string;
  error?: string;
}

export interface AutomationRunClaim {
  job: AutomationJobRecord;
  run: AutomationRunRecord;
}

/** Scheduled automation jobs and their durable run ledger. */
export class AutomationRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async saveAutomationJob(job: AutomationJobRecord): Promise<AutomationJobRecord> {
    await this.db
      .insertInto("automation_jobs")
      .values(automationJobToRow(job))
      .onConflict((oc) => oc.column("id").doUpdateSet(automationJobToRow(job)))
      .execute();
    return job;
  }

  async getAutomationJob(id: string): Promise<AutomationJobRecord | undefined> {
    const row = await this.db.selectFrom("automation_jobs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? automationJobFromRow(row) : undefined;
  }

  async listAutomationJobs(input: { dueAt?: string; enabledOnly?: boolean } = {}): Promise<AutomationJobRecord[]> {
    let query = this.db.selectFrom("automation_jobs").selectAll();
    if (input.enabledOnly) {
      query = query.where("status", "=", "enabled");
    }
    const dueAt = input.dueAt;
    if (dueAt) {
      query = query
        .where("authorization_state", "=", "ready")
        .where("management_state", "=", "allowed")
        .where((eb) => eb.or([
          eb("next_run_at", "is", null),
          eb("next_run_at", "<=", dueAt)
        ]))
        .where((eb) => eb.or([
          eb("retry_after_at", "is", null),
          eb("retry_after_at", "<=", dueAt)
        ]))
        .where((eb) => eb.or([
          eb("locked_until", "is", null),
          eb("locked_until", "<=", dueAt)
        ]))
        .whereRef("failure_count", "<", "max_attempts");
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(automationJobFromRow);
  }

  async acquireAutomationJobLock(jobId: string, input: { lockedUntil: string; lockOwnerToken: string; now?: string }): Promise<AutomationJobRecord | undefined> {
    const now = input.now ?? nowIso();
    const updated = await this.db.updateTable("automation_jobs")
      .set({ locked_until: input.lockedUntil, lock_owner_token: input.lockOwnerToken, updated_at: now })
      .where("id","=",jobId).where("status","=","enabled")
      .where("authorization_state", "=", "ready")
      .where("management_state", "=", "allowed")
      .where((eb)=>eb.or([eb("locked_until","is",null),eb("locked_until","<=",now)]))
      .where((eb)=>eb.or([eb("next_run_at","is",null),eb("next_run_at","<=",now)]))
      .where((eb)=>eb.or([eb("retry_after_at","is",null),eb("retry_after_at","<=",now)]))
      .whereRef("failure_count","<","max_attempts").executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getAutomationJob(jobId) : undefined;
  }

  async releaseAutomationJobLock(jobId: string, input: { lockOwnerToken: string; now?: string }): Promise<AutomationJobRecord | undefined> {
    const now = input.now ?? nowIso();
    const updated = await this.db.updateTable("automation_jobs")
      .set({ locked_until: null, lock_owner_token: null, updated_at: now })
      .where("id", "=", jobId)
      .where("lock_owner_token", "=", input.lockOwnerToken)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getAutomationJob(jobId) : undefined;
  }

  async requeueAutomationJob(jobId: string, input: { nextRunAt?: string; now?: string } = {}): Promise<AutomationJobRecord | undefined> {
    const now = input.now ?? nowIso();
    const job = await this.getAutomationJob(jobId);
    if (!job) {
      return undefined;
    }
    if (job.authorization_state !== "ready" || job.management_state !== "allowed" || job.lock_owner_token) return job;
    const requeued: AutomationJobRecord = {
      ...job,
      status: "enabled",
      next_run_at: input.nextRunAt ?? now,
      retry_after_at: undefined,
      locked_until: undefined,
      lock_owner_token: undefined,
      failure_count: 0,
      last_error: undefined,
      updated_at: now
    };
    await this.saveAutomationJob(requeued);
    return requeued;
  }

  async getAutomationQueueSummary(now = nowIso()): Promise<AutomationQueueSummary> {
    const jobs = await this.listAutomationJobs();
    const enabled = jobs.filter((job) => job.status === "enabled" && job.authorization_state === "ready" && job.management_state === "allowed");
    const dueJobs = enabled.filter((job) => isAutomationJobDue(job, now));
    const lockedJobs = jobs.filter((job) => job.locked_until && job.locked_until > now);
    const retryDueJobs = enabled.filter((job) => job.retry_after_at && job.retry_after_at <= now);
    const retryPendingJobs = enabled.filter((job) => job.retry_after_at && job.retry_after_at > now);
    const exhaustedJobs = jobs.filter((job) => (job.failure_count ?? 0) >= (job.max_attempts ?? 3));
    const nextDueAt = enabled
      .flatMap((job) => [job.next_run_at, job.retry_after_at].filter((value): value is string => Boolean(value)))
      .sort()[0];
    const oldestLockedUntil = lockedJobs.map((job) => job.locked_until).filter((value): value is string => Boolean(value)).sort()[0];
    return {
      now,
      total: jobs.length,
      due: dueJobs.length,
      locked: lockedJobs.length,
      retry_due: retryDueJobs.length,
      retry_pending: retryPendingJobs.length,
      exhausted: exhaustedJobs.length,
      by_status: countAutomationJobs(jobs, "status"),
      by_kind: countAutomationJobs(jobs, "kind"),
      next_due_at: nextDueAt,
      oldest_locked_until: oldestLockedUntil
    };
  }

  async createAutomationRun(run: AutomationRunRecord): Promise<AutomationRunRecord> {
    await this.db
      .insertInto("automation_runs")
      .values(automationRunToRow(run))
      .execute();
    return run;
  }

  async updateAutomationRun(run: AutomationRunRecord): Promise<AutomationRunRecord> {
    await this.db
      .updateTable("automation_runs")
      .set(automationRunToRow(run))
      .where("id", "=", run.id)
      .execute();
    return run;
  }

  async getAutomationRun(id: string): Promise<AutomationRunRecord | undefined> {
    const row = await this.db.selectFrom("automation_runs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? automationRunFromRow(row) : undefined;
  }

  async listAutomationRuns(limit = 100): Promise<AutomationRunRecord[]> {
    const rows = await this.db.selectFrom("automation_runs").selectAll().orderBy("started_at", "desc").limit(Math.max(1, Math.min(500, limit))).execute();
    return rows.map(automationRunFromRow);
  }

  /** Links the already-created Operation/Activity before an executor is called. */
  async attachAutomationRunEvidence(input: {
    jobId: string;
    runId: string;
    lockOwnerToken: string;
    operationId: string;
    activityId?: string;
  }): Promise<AutomationRunRecord | undefined> {
    return this.db.transaction().execute(async (transaction) => {
      const jobRow = await transaction.selectFrom("automation_jobs").selectAll().where("id", "=", input.jobId).executeTakeFirst();
      if (!jobRow || jobRow.lock_owner_token !== input.lockOwnerToken) return undefined;
      const runRow = await transaction.selectFrom("automation_runs").selectAll().where("id", "=", input.runId).executeTakeFirst();
      if (!runRow || runRow.status !== "started" || runRow.job_id !== input.jobId) return undefined;
      const updated = AutomationRunRecordSchema.parse({
        ...automationRunFromRow(runRow),
        operation_id: input.operationId,
        ...(input.activityId ? { activity_id: input.activityId } : {})
      });
      await transaction.updateTable("automation_runs").set(automationRunToRow(updated)).where("id", "=", input.runId).execute();
      return updated;
    });
  }

  /** Links a Session-free Backend Run while the scheduler claim is still owned. */
  async attachAutomationRunBackendRun(input: {
    jobId: string;
    runId: string;
    lockOwnerToken: string;
    backendRunId: string;
  }): Promise<AutomationRunRecord | undefined> {
    return this.db.transaction().execute(async (transaction) => {
      const [jobRow, runRow, backendRun] = await Promise.all([
        transaction.selectFrom("automation_jobs").selectAll().where("id", "=", input.jobId).executeTakeFirst(),
        transaction.selectFrom("automation_runs").selectAll().where("id", "=", input.runId).executeTakeFirst(),
        transaction.selectFrom("backend_runs").select(["id", "room_id", "session_id"]).where("id", "=", input.backendRunId).executeTakeFirst()
      ]);
      if (!jobRow || jobRow.lock_owner_token !== input.lockOwnerToken) return undefined;
      if (!runRow || runRow.status !== "started" || runRow.job_id !== input.jobId) return undefined;
      const run = automationRunFromRow(runRow);
      if (run.backend_run_id && run.backend_run_id !== input.backendRunId) {
        throw new Error("automation_run_backend_conflict");
      }
      if (!backendRun || backendRun.session_id !== null || backendRun.room_id !== run.room_id) {
        throw new Error("automation_backend_run_scope_invalid");
      }
      if (run.backend_run_id === input.backendRunId) return run;
      const updated = AutomationRunRecordSchema.parse({ ...run, backend_run_id: input.backendRunId });
      await transaction.updateTable("automation_runs").set(automationRunToRow(updated)).where("id", "=", input.runId).execute();
      return updated;
    });
  }

  /** Settles the Job and Run together, but only for the scheduler claim owner. */
  async settleAutomationRun(input: AutomationRunSettlementInput): Promise<AutomationRunClaim | undefined> {
    return this.db.transaction().execute(async (transaction) => {
      const [jobRow, runRow] = await Promise.all([
        transaction.selectFrom("automation_jobs").selectAll().where("id", "=", input.jobId).executeTakeFirst(),
        transaction.selectFrom("automation_runs").selectAll().where("id", "=", input.runId).executeTakeFirst()
      ]);
      if (!jobRow || !runRow || jobRow.lock_owner_token !== input.lockOwnerToken || runRow.status !== "started" || runRow.job_id !== input.jobId) {
        return undefined;
      }
      const job = automationJobFromRow(jobRow);
      const run = automationRunFromRow(runRow);
      const settledRun = settledRunRecord(run, input);
      const settledJob = settledJobRecord(job, input);
      await transaction.updateTable("automation_runs").set(automationRunToRow(settledRun)).where("id", "=", input.runId).execute();
      await transaction.updateTable("automation_jobs")
        .set(automationJobToRow(settledJob))
        .where("id", "=", input.jobId)
        .where("lock_owner_token", "=", input.lockOwnerToken)
        .execute();
      return { job: settledJob, run: settledRun };
    });
  }

  /** Claims whose durable owner lock has expired and whose executor cannot be trusted to resume. */
  async listExpiredAutomationRunClaims(now = nowIso()): Promise<AutomationRunClaim[]> {
    const runs = await this.db.selectFrom("automation_runs").selectAll().where("status", "=", "started").where("job_id", "is not", null).execute();
    const claims: AutomationRunClaim[] = [];
    for (const row of runs) {
      const run = automationRunFromRow(row);
      if (!run.job_id) continue;
      const job = await this.getAutomationJob(run.job_id);
      if (job?.locked_until && job.locked_until <= now && job.lock_owner_token) claims.push({ job, run });
    }
    return claims;
  }

}

function settledRunRecord(run: AutomationRunRecord, input: AutomationRunSettlementInput): AutomationRunRecord {
  if (input.outcome === "completed") {
    return AutomationRunRecordSchema.parse({ ...run, status: "completed", completed_at: input.now });
  }
  if (input.outcome === "failed") {
    return AutomationRunRecordSchema.parse({
      ...run,
      status: "failed",
      completed_at: input.now,
      ...(input.errorCode ? { error_code: input.errorCode } : {}),
      ...(input.error ? { error: input.error } : {})
    });
  }
  return AutomationRunRecordSchema.parse({
    ...run,
    status: "blocked",
    completed_at: input.now,
    blocked_at: input.now,
    ...(input.errorCode ? { error_code: input.errorCode } : {}),
    ...(input.error ? { error: input.error } : {})
  });
}

function settledJobRecord(job: AutomationJobRecord, input: AutomationRunSettlementInput): AutomationJobRecord {
  const released = { ...job, locked_until: undefined, lock_owner_token: undefined, last_run_at: input.now, updated_at: input.now };
  if (input.outcome === "completed") {
    return AutomationJobRecordSchema.parse({
      ...released,
      status: job.management_state === "manager_stopped" ? "disabled" : isOneShot(job.schedule) ? "disabled" : job.status,
      next_run_at: job.management_state === "manager_stopped" || isOneShot(job.schedule) ? undefined : input.nextRunAt,
      retry_after_at: undefined,
      failure_count: 0,
      last_error: undefined
    });
  }
  if (input.outcome === "failed") {
    const failureCount = (job.failure_count ?? 0) + 1;
    const retryable = failureCount < (job.max_attempts ?? 3) && job.management_state === "allowed";
    return AutomationJobRecordSchema.parse({
      ...released,
      status: retryable ? "enabled" : "disabled",
      retry_after_at: retryable ? input.retryAfterAt : undefined,
      failure_count: failureCount,
      ...(input.error ? { last_error: input.error } : {})
    });
  }
  if (input.outcome === "blocked") {
    return AutomationJobRecordSchema.parse({
      ...released,
      status: "disabled",
      authorization_state: "blocked",
      authorization_error_code: input.errorCode ?? "automation_authorization_blocked",
      blocked_at: input.now,
      ...(input.error ? { last_error: input.error } : {})
    });
  }
  return AutomationJobRecordSchema.parse({
    ...released,
    status: "disabled",
    ...(input.error ? { last_error: input.error } : {})
  });
}

function isOneShot(schedule: string): boolean {
  return ["once", "one-shot", "oneshot"].includes(schedule.trim().toLowerCase());
}
