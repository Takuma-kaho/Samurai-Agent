import { nowIso, type DomainCommandExecutionRecord, type ObjectiveRecord, type RunCheckpointRecord, type WorkDependencyRecord, type WorkItemRecord } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import { domainCommandExecutionFromRow, domainCommandExecutionToRow, objectiveFromRow, objectiveToRow, runCheckpointFromRow, runCheckpointToRow, workDependencyFromRow, workDependencyToRow, workItemFromRow, workItemToRow } from "./durable-work-row-codecs";

/** Durable Domain Command execution, objectives, work items, dependencies, and checkpoints. */
export class DurableWorkRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async saveObjective(record: ObjectiveRecord): Promise<ObjectiveRecord> {
    await this.db.insertInto("objectives").values(objectiveToRow(record)).onConflict((conflict) => conflict.column("id").doUpdateSet(objectiveToRow(record))).execute();
    return record;
  }

  async getObjective(id: string): Promise<ObjectiveRecord | undefined> {
    const row = await this.db.selectFrom("objectives").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? objectiveFromRow(row) : undefined;
  }

  async listObjectives(status?: ObjectiveRecord["status"]): Promise<ObjectiveRecord[]> {
    let query = this.db.selectFrom("objectives").selectAll();
    if (status) query = query.where("status", "=", status);
    return (await query.orderBy("updated_at", "desc").execute()).map(objectiveFromRow);
  }

  async updateObjective(record: ObjectiveRecord): Promise<ObjectiveRecord> {
    await this.db.updateTable("objectives").set(objectiveToRow(record)).where("id", "=", record.id).execute();
    return record;
  }

  async saveWorkItem(record: WorkItemRecord): Promise<WorkItemRecord> {
    await this.db.insertInto("work_items").values(workItemToRow(record)).onConflict((conflict) => conflict.column("id").doUpdateSet(workItemToRow(record))).execute();
    return record;
  }

  async getWorkItem(id: string): Promise<WorkItemRecord | undefined> {
    const row = await this.db.selectFrom("work_items").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? workItemFromRow(row) : undefined;
  }

  async listWorkItems(input: { objectiveId?: string; status?: WorkItemRecord["status"] } = {}): Promise<WorkItemRecord[]> {
    let query = this.db.selectFrom("work_items").selectAll();
    if (input.objectiveId) query = query.where("objective_id", "=", input.objectiveId);
    if (input.status) query = query.where("status", "=", input.status);
    return (await query.orderBy("priority", "desc").orderBy("created_at", "asc").execute()).map(workItemFromRow);
  }

  async saveWorkDependency(record: WorkDependencyRecord): Promise<WorkDependencyRecord> {
    await this.db.insertInto("work_dependencies").values(workDependencyToRow(record)).onConflict((conflict) => conflict.columns(["predecessor_work_item_id", "successor_work_item_id"]).doNothing()).execute();
    return record;
  }

  async listWorkDependencies(objectiveId: string): Promise<WorkDependencyRecord[]> {
    return (await this.db.selectFrom("work_dependencies").selectAll().where("objective_id", "=", objectiveId).orderBy("created_at", "asc").execute()).map(workDependencyFromRow);
  }

  async claimWorkItem(input: { workerId: string; leaseMs: number; now?: string }): Promise<WorkItemRecord | undefined> {
    const now = input.now ?? nowIso();
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString();
    const candidates = await this.db.selectFrom("work_items").selectAll()
      .where("status", "in", ["queued", "ready"])
      .where((eb) => eb.or([eb("retry_after_at", "is", null), eb("retry_after_at", "<=", now)]))
      .orderBy("priority", "desc").orderBy("created_at", "asc").limit(50).execute();
    for (const candidate of candidates) {
      const blockers = await this.db.selectFrom("work_dependencies as dependency")
        .innerJoin("work_items as predecessor", "predecessor.id", "dependency.predecessor_work_item_id")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("dependency.successor_work_item_id", "=", candidate.id)
        .where("predecessor.status", "!=", "completed")
        .executeTakeFirst();
      if (Number(blockers?.count ?? 0) > 0) continue;
      const updated = await this.db.updateTable("work_items").set({
        status: "running",
        lease_owner: input.workerId,
        lease_expires_at: leaseExpiresAt,
        heartbeat_at: now,
        attempt: candidate.attempt + 1,
        started_at: candidate.started_at ?? now,
        updated_at: now,
        retry_after_at: null,
        failure_kind: null,
        error: null
      }).where("id", "=", candidate.id).where("status", "in", ["queued", "ready"]).executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1) return this.getWorkItem(candidate.id);
    }
    return undefined;
  }

  async heartbeatWorkItem(input: { workItemId: string; workerId: string; leaseMs: number; now?: string }): Promise<WorkItemRecord | undefined> {
    const now = input.now ?? nowIso();
    const updated = await this.db.updateTable("work_items").set({
      heartbeat_at: now,
      lease_expires_at: new Date(Date.parse(now) + input.leaseMs).toISOString(),
      updated_at: now
    }).where("id", "=", input.workItemId).where("status", "=", "running").where("lease_owner", "=", input.workerId).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getWorkItem(input.workItemId) : undefined;
  }

  async completeWorkItem(input: { workItemId: string; workerId: string; now?: string }): Promise<WorkItemRecord | undefined> {
    const now = input.now ?? nowIso();
    const updated = await this.db.updateTable("work_items").set({
      status: "completed",
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      retry_after_at: null,
      failure_kind: null,
      error: null,
      completed_at: now,
      updated_at: now
    }).where("id", "=", input.workItemId).where("status", "=", "running").where("lease_owner", "=", input.workerId).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getWorkItem(input.workItemId) : undefined;
  }

  async failWorkItem(input: { workItemId: string; workerId: string; failureKind: "retryable" | "non_retryable" | "cancelled"; error: string; now?: string; baseRetryMs?: number }): Promise<WorkItemRecord | undefined> {
    const current = await this.getWorkItem(input.workItemId);
    if (!current || current.status !== "running" || current.lease_owner !== input.workerId) return undefined;
    const now = input.now ?? nowIso();
    const canRetry = input.failureKind === "retryable" && current.attempt < current.max_attempts;
    const retryDelay = (input.baseRetryMs ?? 1_000) * Math.min(2 ** Math.max(0, current.attempt - 1), 64);
    const updated = await this.db.updateTable("work_items").set({
      status: canRetry ? "ready" : input.failureKind === "cancelled" ? "cancelled" : "failed",
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      retry_after_at: canRetry ? new Date(Date.parse(now) + retryDelay).toISOString() : null,
      failure_kind: input.failureKind,
      error: input.error,
      completed_at: canRetry ? null : now,
      updated_at: now
    }).where("id", "=", input.workItemId).where("status", "=", "running").where("lease_owner", "=", input.workerId).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getWorkItem(input.workItemId) : undefined;
  }

  async cancelObjective(input: { objectiveId: string; now?: string }): Promise<{ objective?: ObjectiveRecord; workItems: WorkItemRecord[] }> {
    const now = input.now ?? nowIso();
    await this.db.transaction().execute(async (transaction) => {
      await transaction.updateTable("objectives").set({ status: "cancelled", updated_at: now, completed_at: now }).where("id", "=", input.objectiveId).where("status", "not in", ["completed", "cancelled", "failed"]).execute();
      await transaction.updateTable("work_items").set({
        status: "cancelled",
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        retry_after_at: null,
        failure_kind: "cancelled",
        error: "objective_cancelled",
        updated_at: now,
        completed_at: now
      }).where("objective_id", "=", input.objectiveId).where("status", "not in", ["completed", "cancelled", "failed"]).execute();
    });
    return { objective: await this.getObjective(input.objectiveId), workItems: await this.listWorkItems({ objectiveId: input.objectiveId }) };
  }

  async reconcileExpiredWorkItems(input: { now?: string; baseRetryMs?: number } = {}): Promise<WorkItemRecord[]> {
    const now = input.now ?? nowIso();
    const expired = await this.db.selectFrom("work_items").selectAll().where("status", "=", "running").where("lease_expires_at", "<=", now).execute();
    const reconciled: WorkItemRecord[] = [];
    for (const row of expired) {
      const terminal = row.attempt >= row.max_attempts;
      const retryDelay = (input.baseRetryMs ?? 1_000) * Math.min(2 ** Math.max(0, row.attempt - 1), 64);
      const updated = await this.db.updateTable("work_items").set({
        status: terminal ? "failed" : "ready",
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        retry_after_at: terminal ? null : new Date(Date.parse(now) + retryDelay).toISOString(),
        failure_kind: terminal ? "non_retryable" : "retryable",
        error: terminal ? "work_item_max_attempts_exceeded" : "work_item_lease_expired",
        updated_at: now,
        completed_at: terminal ? now : null
      }).where("id", "=", row.id).where("status", "=", "running").where("lease_expires_at", "<=", now).executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1) {
        const record = await this.getWorkItem(row.id);
        if (record) reconciled.push(record);
      }
    }
    return reconciled;
  }

  async saveRunCheckpoint(record: RunCheckpointRecord): Promise<RunCheckpointRecord> {
    await this.db.insertInto("run_checkpoints").values(runCheckpointToRow(record)).onConflict((conflict) => conflict.column("idempotency_key").doNothing()).execute();
    const saved = await this.db.selectFrom("run_checkpoints").selectAll().where("idempotency_key", "=", record.idempotency_key).executeTakeFirstOrThrow();
    const checkpoint = runCheckpointFromRow(saved);
    await this.db.updateTable("work_items").set({ current_checkpoint_id: checkpoint.id, updated_at: record.created_at }).where("id", "=", record.work_item_id).execute();
    await this.db.updateTable("objectives").set({ current_checkpoint_id: checkpoint.id, updated_at: record.created_at }).where("id", "=", record.objective_id).execute();
    return checkpoint;
  }

  async listRunCheckpoints(workItemId: string): Promise<RunCheckpointRecord[]> {
    return (await this.db.selectFrom("run_checkpoints").selectAll().where("work_item_id", "=", workItemId).orderBy("sequence", "asc").execute()).map(runCheckpointFromRow);
  }

  async claimDomainCommandExecution(record: DomainCommandExecutionRecord): Promise<{ record: DomainCommandExecutionRecord; claimed: boolean }> {
    const inserted = await this.db
      .insertInto("domain_command_executions")
      .values(domainCommandExecutionToRow(record))
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 1) {
      return { record, claimed: true };
    }
    const existing = await this.getDomainCommandExecution(record.idempotency_key);
    if (!existing) {
      throw new Error(`Domain command execution claim disappeared: ${record.idempotency_key}`);
    }
    return { record: existing, claimed: false };
  }

  async getDomainCommandExecution(idempotencyKey: string): Promise<DomainCommandExecutionRecord | undefined> {
    const row = await this.db
      .selectFrom("domain_command_executions")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row ? domainCommandExecutionFromRow(row) : undefined;
  }

  async listDomainCommandExecutions():Promise<DomainCommandExecutionRecord[]>{return(await this.db.selectFrom("domain_command_executions").selectAll().orderBy("created_at","asc").execute()).map(domainCommandExecutionFromRow)}

  async updateDomainCommandExecution(record: DomainCommandExecutionRecord): Promise<DomainCommandExecutionRecord> {
    await this.db
      .updateTable("domain_command_executions")
      .set(domainCommandExecutionToRow(record))
      .where("id", "=", record.id)
      .execute();
    return record;
  }

  async compareAndSetDomainCommandExecution(input: { id: string; expectedStatus: DomainCommandExecutionRecord["status"]; expectedHeartbeatAt: string; next: DomainCommandExecutionRecord }): Promise<boolean> {
    const result = await this.db.updateTable("domain_command_executions")
      .set(domainCommandExecutionToRow(input.next))
      .where("id", "=", input.id)
      .where("status", "=", input.expectedStatus)
      .where("heartbeat_at", "=", input.expectedHeartbeatAt)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) === 1;
  }

  async heartbeatDomainCommandExecution(id: string, heartbeatAt: string): Promise<boolean> {
    const result = await this.db.updateTable("domain_command_executions")
      .set({ heartbeat_at: heartbeatAt, updated_at: heartbeatAt })
      .where("id", "=", id)
      .where("status", "=", "running")
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) === 1;
  }

}

