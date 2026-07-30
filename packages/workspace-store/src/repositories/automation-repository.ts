import { nowIso, type AutomationJobRecord } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import type { AutomationQueueSummary, AutomationRunRecord } from "../workspace-store-contracts";
import { automationJobFromRow, automationJobToRow } from "./automation-row-codecs";
import { automationRunFromRow, automationRunToRow } from "./automation-run-row-codecs";
import { countAutomationJobs, isAutomationJobDue } from "./collection-codecs";

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

  async acquireAutomationJobLock(jobId: string, input: { lockedUntil: string; now?: string }): Promise<AutomationJobRecord | undefined> {
    const now = input.now ?? nowIso();
    const updated = await this.db.updateTable("automation_jobs")
      .set({ locked_until: input.lockedUntil, updated_at: now })
      .where("id","=",jobId).where("status","=","enabled")
      .where((eb)=>eb.or([eb("locked_until","is",null),eb("locked_until","<=",now)]))
      .where((eb)=>eb.or([eb("next_run_at","is",null),eb("next_run_at","<=",now)]))
      .where((eb)=>eb.or([eb("retry_after_at","is",null),eb("retry_after_at","<=",now)]))
      .whereRef("failure_count","<","max_attempts").executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getAutomationJob(jobId) : undefined;
  }

  async heartbeatAutomationJobLock(jobId:string,input:{expectedLockedUntil:string;lockedUntil:string;now?:string}):Promise<AutomationJobRecord|undefined>{const now=input.now??nowIso();const updated=await this.db.updateTable("automation_jobs").set({locked_until:input.lockedUntil,updated_at:now}).where("id","=",jobId).where("locked_until","=",input.expectedLockedUntil).where("locked_until",">",now).executeTakeFirst();return Number(updated.numUpdatedRows)===1?this.getAutomationJob(jobId):undefined}

  async releaseAutomationJobLock(jobId: string, now = nowIso()): Promise<AutomationJobRecord | undefined> {
    const job = await this.getAutomationJob(jobId);
    if (!job) {
      return undefined;
    }
    const released = { ...job, locked_until: undefined, updated_at: now };
    await this.saveAutomationJob(released);
    return released;
  }

  async requeueAutomationJob(jobId: string, input: { nextRunAt?: string; now?: string } = {}): Promise<AutomationJobRecord | undefined> {
    const now = input.now ?? nowIso();
    const job = await this.getAutomationJob(jobId);
    if (!job) {
      return undefined;
    }
    const requeued: AutomationJobRecord = {
      ...job,
      status: "enabled",
      next_run_at: input.nextRunAt ?? now,
      retry_after_at: undefined,
      locked_until: undefined,
      failure_count: 0,
      last_error: undefined,
      updated_at: now
    };
    await this.saveAutomationJob(requeued);
    return requeued;
  }

  async getAutomationQueueSummary(now = nowIso()): Promise<AutomationQueueSummary> {
    const jobs = await this.listAutomationJobs();
    const enabled = jobs.filter((job) => job.status === "enabled");
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

}
