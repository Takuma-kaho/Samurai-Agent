import { nowIso, type DomainCommandExecutionRecord, type ObjectiveRecord, type RunCheckpointRecord, type WorkDependencyRecord, type WorkItemRecord } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import { domainCommandExecutionFromRow, domainCommandExecutionToRow, objectiveFromRow, objectiveToRow, runCheckpointFromRow, runCheckpointToRow, workDependencyFromRow, workDependencyToRow, workItemFromRow, workItemToRow } from "./durable-work-row-codecs";

/** Durable Domain Command execution, objectives, work items, dependencies, and checkpoints. */
export class DurableWorkRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async saveObjective(record: ObjectiveRecord, roomId?: string): Promise<ObjectiveRecord> {
    const scopedRecord = bindObjectiveRoom(record, roomId);
    const row = objectiveToRow(scopedRecord);
    await this.db.transaction().execute(async (transaction) => {
      const existing = await transaction.selectFrom("objectives")
        .select(["room_id"])
        .where("id", "=", scopedRecord.id)
        .executeTakeFirst();
      if (existing) {
        assertPersistedRoom(existing.room_id, row.room_id, "objective");
        const updated = await transaction.updateTable("objectives")
          .set(row)
          .where("id", "=", scopedRecord.id)
          .where("room_id", "=", row.room_id)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1) throw new Error("objective_room_mismatch");
        return;
      }
      await transaction.insertInto("objectives").values(row).execute();
    });
    return scopedRecord;
  }

  async getObjective(id: string, roomId?: string): Promise<ObjectiveRecord | undefined> {
    const scopedRoomId = normalizeRoomId(roomId);
    if (!scopedRoomId) return undefined;
    const row = await this.db.selectFrom("objectives")
      .selectAll()
      .where("id", "=", id)
      .where("room_id", "=", scopedRoomId)
      .executeTakeFirst();
    return row ? objectiveFromRow(row) : undefined;
  }

  async listObjectives(status?: ObjectiveRecord["status"], roomId?: string): Promise<ObjectiveRecord[]> {
    const scopedRoomId = normalizeRoomId(roomId);
    if (!scopedRoomId) return [];
    let query = this.db.selectFrom("objectives").selectAll().where("room_id", "=", scopedRoomId);
    if (status) query = query.where("status", "=", status);
    return (await query.orderBy("updated_at", "desc").execute()).map(objectiveFromRow);
  }

  async updateObjective(record: ObjectiveRecord, roomId?: string): Promise<ObjectiveRecord> {
    const scopedRecord = bindObjectiveRoom(record, roomId);
    const row = objectiveToRow(scopedRecord);
    const updated = await this.db.updateTable("objectives")
      .set(row)
      .where("id", "=", scopedRecord.id)
      .where("room_id", "=", row.room_id)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw new Error("objective_not_found_or_room_mismatch");
    return scopedRecord;
  }

  async saveWorkItem(record: WorkItemRecord, roomId?: string): Promise<WorkItemRecord> {
    const scopedRecord = bindWorkItemRoom(record, roomId);
    const row = workItemToRow(scopedRecord);
    await this.db.transaction().execute(async (transaction) => {
      const objective = await transaction.selectFrom("objectives")
        .select(["room_id"])
        .where("id", "=", scopedRecord.objective_id)
        .executeTakeFirst();
      if (!objective || objective.room_id !== row.room_id) throw new Error("work_item_objective_room_mismatch");

      if (scopedRecord.parent_work_item_id) {
        if (scopedRecord.parent_work_item_id === scopedRecord.id) throw new Error("work_item_parent_self_reference");
        const parent = await transaction.selectFrom("work_items")
          .select(["objective_id", "room_id"])
          .where("id", "=", scopedRecord.parent_work_item_id)
          .executeTakeFirst();
        if (!parent || parent.objective_id !== scopedRecord.objective_id || parent.room_id !== row.room_id) {
          throw new Error("work_item_parent_room_mismatch");
        }
      }

      const existing = await transaction.selectFrom("work_items")
        .select(["objective_id", "room_id"])
        .where("id", "=", scopedRecord.id)
        .executeTakeFirst();
      if (existing) {
        if (existing.objective_id !== scopedRecord.objective_id) throw new Error("work_item_objective_mismatch");
        assertPersistedRoom(existing.room_id, row.room_id, "work_item");
        const updated = await transaction.updateTable("work_items")
          .set(row)
          .where("id", "=", scopedRecord.id)
          .where("objective_id", "=", scopedRecord.objective_id)
          .where("room_id", "=", row.room_id)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1) throw new Error("work_item_room_mismatch");
        return;
      }
      await transaction.insertInto("work_items").values(row).execute();
    });
    return scopedRecord;
  }

  async getWorkItem(id: string, roomId?: string): Promise<WorkItemRecord | undefined> {
    const scopedRoomId = normalizeRoomId(roomId);
    if (!scopedRoomId) return undefined;
    const row = await this.db.selectFrom("work_items as work")
      .innerJoin("objectives as objective", "objective.id", "work.objective_id")
      .selectAll("work")
      .where("work.id", "=", id)
      .where("work.room_id", "=", scopedRoomId)
      .where("objective.room_id", "=", scopedRoomId)
      .executeTakeFirst();
    return row ? workItemFromRow(row) : undefined;
  }

  async listWorkItems(input: { objectiveId?: string; status?: WorkItemRecord["status"]; roomId?: string } = {}): Promise<WorkItemRecord[]> {
    const scopedRoomId = normalizeRoomId(input.roomId);
    if (!scopedRoomId) return [];
    let query = this.db.selectFrom("work_items as work")
      .innerJoin("objectives as objective", "objective.id", "work.objective_id")
      .selectAll("work")
      .where("work.room_id", "=", scopedRoomId)
      .where("objective.room_id", "=", scopedRoomId);
    if (input.objectiveId) query = query.where("work.objective_id", "=", input.objectiveId);
    if (input.status) query = query.where("work.status", "=", input.status);
    return (await query.orderBy("priority", "desc").orderBy("created_at", "asc").execute()).map(workItemFromRow);
  }

  async saveWorkDependency(record: WorkDependencyRecord, roomId?: string): Promise<WorkDependencyRecord> {
    const requestedRoomId = normalizeRoomId(roomId);
    await this.db.transaction().execute(async (transaction) => {
      const objective = await transaction.selectFrom("objectives")
        .select(["room_id"])
        .where("id", "=", record.objective_id)
        .executeTakeFirst();
      const resolvedRoomId = requestedRoomId ?? normalizeRoomId(objective?.room_id);
      if (!resolvedRoomId || objective?.room_id !== resolvedRoomId) throw new Error("work_dependency_room_scope_required");

      const predecessor = await transaction.selectFrom("work_items")
        .select(["objective_id", "room_id"])
        .where("id", "=", record.predecessor_work_item_id)
        .executeTakeFirst();
      const successor = await transaction.selectFrom("work_items")
        .select(["objective_id", "room_id"])
        .where("id", "=", record.successor_work_item_id)
        .executeTakeFirst();
      if (!predecessor || !successor
        || predecessor.objective_id !== record.objective_id
        || successor.objective_id !== record.objective_id
        || predecessor.room_id !== resolvedRoomId
        || successor.room_id !== resolvedRoomId) {
        throw new Error("work_dependency_room_mismatch");
      }

      await transaction.insertInto("work_dependencies")
        .values(workDependencyToRow(record))
        .onConflict((conflict) => conflict.columns(["predecessor_work_item_id", "successor_work_item_id"]).doNothing())
        .execute();
    });
    return record;
  }

  async listWorkDependencies(objectiveId: string, roomId?: string): Promise<WorkDependencyRecord[]> {
    const scopedRoomId = normalizeRoomId(roomId);
    if (!scopedRoomId) return [];
    return (await this.db.selectFrom("work_dependencies as dependency")
      .innerJoin("objectives as objective", "objective.id", "dependency.objective_id")
      .innerJoin("work_items as predecessor", "predecessor.id", "dependency.predecessor_work_item_id")
      .innerJoin("work_items as successor", "successor.id", "dependency.successor_work_item_id")
      .selectAll("dependency")
      .where("dependency.objective_id", "=", objectiveId)
      .where("objective.room_id", "=", scopedRoomId)
      .where("predecessor.room_id", "=", scopedRoomId)
      .where("successor.room_id", "=", scopedRoomId)
      .whereRef("predecessor.objective_id", "=", "dependency.objective_id")
      .whereRef("successor.objective_id", "=", "dependency.objective_id")
      .orderBy("dependency.created_at", "asc")
      .execute()).map(workDependencyFromRow);
  }

  async claimWorkItem(input: { workerId: string; leaseMs: number; roomId?: string; now?: string }): Promise<WorkItemRecord | undefined> {
    const scopedRoomId = normalizeRoomId(input.roomId);
    if (!scopedRoomId) return undefined;
    const now = input.now ?? nowIso();
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString();
    const candidates = await this.db.selectFrom("work_items as work")
      .innerJoin("objectives as objective", "objective.id", "work.objective_id")
      .selectAll("work")
      .where("work.room_id", "=", scopedRoomId)
      .where("objective.room_id", "=", scopedRoomId)
      .where("work.status", "in", ["queued", "ready"])
      .where((eb) => eb.or([eb("work.retry_after_at", "is", null), eb("work.retry_after_at", "<=", now)]))
      .orderBy("work.priority", "desc").orderBy("work.created_at", "asc").limit(50).execute();
    for (const candidate of candidates) {
      if (!await this.hasValidParent(candidate, scopedRoomId)) continue;
      const dependencies = await this.db.selectFrom("work_dependencies")
        .select(["objective_id", "predecessor_work_item_id"])
        .where("successor_work_item_id", "=", candidate.id)
        .execute();
      let blocked = false;
      for (const dependency of dependencies) {
        const predecessor = await this.db.selectFrom("work_items")
          .select(["objective_id", "room_id", "status"])
          .where("id", "=", dependency.predecessor_work_item_id)
          .executeTakeFirst();
        if (dependency.objective_id !== candidate.objective_id
          || !predecessor
          || predecessor.objective_id !== candidate.objective_id
          || predecessor.room_id !== scopedRoomId
          || predecessor.status !== "completed") {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
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
      }).where("id", "=", candidate.id).where("room_id", "=", scopedRoomId).where("status", "in", ["queued", "ready"]).executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1) return this.getWorkItem(candidate.id, scopedRoomId);
    }
    return undefined;
  }

  async heartbeatWorkItem(input: { workItemId: string; workerId: string; leaseMs: number; roomId?: string; now?: string }): Promise<WorkItemRecord | undefined> {
    const current = await this.getLeaseOwnedWorkItem(input.workItemId, input.workerId, input.roomId);
    if (!current?.room_id) return undefined;
    const now = input.now ?? nowIso();
    const updated = await this.db.updateTable("work_items").set({
      heartbeat_at: now,
      lease_expires_at: new Date(Date.parse(now) + input.leaseMs).toISOString(),
      updated_at: now
    }).where("id", "=", input.workItemId).where("room_id", "=", current.room_id).where("status", "=", "running").where("lease_owner", "=", input.workerId).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getWorkItem(input.workItemId, current.room_id) : undefined;
  }

  async completeWorkItem(input: { workItemId: string; workerId: string; roomId?: string; now?: string }): Promise<WorkItemRecord | undefined> {
    const current = await this.getLeaseOwnedWorkItem(input.workItemId, input.workerId, input.roomId);
    if (!current?.room_id) return undefined;
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
    }).where("id", "=", input.workItemId).where("room_id", "=", current.room_id).where("status", "=", "running").where("lease_owner", "=", input.workerId).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getWorkItem(input.workItemId, current.room_id) : undefined;
  }

  async failWorkItem(input: { workItemId: string; workerId: string; failureKind: "retryable" | "non_retryable" | "cancelled"; error: string; roomId?: string; now?: string; baseRetryMs?: number }): Promise<WorkItemRecord | undefined> {
    const current = await this.getLeaseOwnedWorkItem(input.workItemId, input.workerId, input.roomId);
    if (!current?.room_id || current.status !== "running" || current.lease_owner !== input.workerId) return undefined;
    const currentRoomId = current.room_id;
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
    }).where("id", "=", input.workItemId).where("room_id", "=", currentRoomId).where("status", "=", "running").where("lease_owner", "=", input.workerId).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getWorkItem(input.workItemId, currentRoomId) : undefined;
  }

  async cancelObjective(input: { objectiveId: string; roomId?: string; now?: string }): Promise<{ objective?: ObjectiveRecord; workItems: WorkItemRecord[] }> {
    const scopedRoomId = normalizeRoomId(input.roomId);
    if (!scopedRoomId) return { objective: undefined, workItems: [] };
    const now = input.now ?? nowIso();
    await this.db.transaction().execute(async (transaction) => {
      await transaction.updateTable("objectives").set({ status: "cancelled", updated_at: now, completed_at: now }).where("id", "=", input.objectiveId).where("room_id", "=", scopedRoomId).where("status", "not in", ["completed", "cancelled", "failed"]).execute();
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
      }).where("objective_id", "=", input.objectiveId).where("room_id", "=", scopedRoomId).where("status", "not in", ["completed", "cancelled", "failed"]).execute();
    });
    return { objective: await this.getObjective(input.objectiveId, scopedRoomId), workItems: await this.listWorkItems({ objectiveId: input.objectiveId, roomId: scopedRoomId }) };
  }

  async reconcileExpiredWorkItems(input: { roomId?: string; now?: string; baseRetryMs?: number } = {}): Promise<WorkItemRecord[]> {
    const scopedRoomId = normalizeRoomId(input.roomId);
    if (!scopedRoomId) return [];
    const now = input.now ?? nowIso();
    const expired = await this.db.selectFrom("work_items as work")
      .innerJoin("objectives as objective", "objective.id", "work.objective_id")
      .selectAll("work")
      .where("work.room_id", "=", scopedRoomId)
      .where("objective.room_id", "=", scopedRoomId)
      .where("work.status", "=", "running")
      .where("work.lease_expires_at", "<=", now)
      .execute();
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
      }).where("id", "=", row.id).where("room_id", "=", scopedRoomId).where("status", "=", "running").where("lease_expires_at", "<=", now).executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1) {
        const record = await this.getWorkItem(row.id, scopedRoomId);
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

  async listRunCheckpoints(workItemId: string, roomId?: string): Promise<RunCheckpointRecord[]> {
    const scopedRoomId = normalizeRoomId(roomId);
    if (!scopedRoomId) return [];
    return (await this.db.selectFrom("run_checkpoints as checkpoint")
      .innerJoin("work_items as work", "work.id", "checkpoint.work_item_id")
      .innerJoin("objectives as objective", "objective.id", "checkpoint.objective_id")
      .selectAll("checkpoint")
      .where("checkpoint.work_item_id", "=", workItemId)
      .where("work.room_id", "=", scopedRoomId)
      .where("objective.room_id", "=", scopedRoomId)
      .whereRef("checkpoint.objective_id", "=", "work.objective_id")
      .orderBy("checkpoint.sequence", "asc")
      .execute()).map(runCheckpointFromRow);
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

  private async hasValidParent(candidate: WorkspaceDb["work_items"], roomId: string): Promise<boolean> {
    if (!candidate.parent_work_item_id) return true;
    if (candidate.parent_work_item_id === candidate.id) return false;
    const parent = await this.db.selectFrom("work_items as parent")
      .innerJoin("objectives as objective", "objective.id", "parent.objective_id")
      .select(["parent.objective_id", "parent.room_id", "objective.room_id as objective_room_id"])
      .where("parent.id", "=", candidate.parent_work_item_id)
      .executeTakeFirst();
    return parent?.objective_id === candidate.objective_id
      && parent.room_id === roomId
      && parent.objective_room_id === roomId;
  }

  private async getLeaseOwnedWorkItem(workItemId: string, workerId: string, roomId?: string): Promise<WorkItemRecord | undefined> {
    const scopedRoomId = normalizeRoomId(roomId);
    if (roomId !== undefined && !scopedRoomId) return undefined;
    let query = this.db.selectFrom("work_items as work")
      .innerJoin("objectives as objective", "objective.id", "work.objective_id")
      .selectAll("work")
      .where("work.id", "=", workItemId)
      .where("work.lease_owner", "=", workerId)
      .where("work.status", "=", "running")
      .where("work.room_id", "is not", null)
      .where("objective.room_id", "is not", null)
      .whereRef("objective.room_id", "=", "work.room_id");
    if (scopedRoomId) query = query.where("work.room_id", "=", scopedRoomId);
    const row = await query.executeTakeFirst();
    return row ? workItemFromRow(row) : undefined;
  }

}

function bindObjectiveRoom(record: ObjectiveRecord, roomId?: string): ObjectiveRecord {
  const scopedRoomId = resolveRecordRoom(record.room_id, roomId, "objective");
  return record.room_id === scopedRoomId ? record : { ...record, room_id: scopedRoomId };
}

function bindWorkItemRoom(record: WorkItemRecord, roomId?: string): WorkItemRecord {
  const scopedRoomId = resolveRecordRoom(record.room_id, roomId, "work_item");
  return record.room_id === scopedRoomId ? record : { ...record, room_id: scopedRoomId };
}

function resolveRecordRoom(recordRoomId: string | undefined, requestedRoomId: string | undefined, resourceKind: "objective" | "work_item"): string {
  const persistedRoomId = normalizeRoomId(recordRoomId);
  const scopedRoomId = normalizeRoomId(requestedRoomId);
  if (!persistedRoomId && !scopedRoomId) throw new Error(`${resourceKind}_room_scope_required`);
  if (persistedRoomId && scopedRoomId && persistedRoomId !== scopedRoomId) throw new Error(`${resourceKind}_room_mismatch`);
  return scopedRoomId ?? persistedRoomId!;
}

function assertPersistedRoom(existingRoomId: string | null, expectedRoomId: string | null, resourceKind: "objective" | "work_item"): void {
  const existing = normalizeRoomId(existingRoomId);
  const expected = normalizeRoomId(expectedRoomId);
  if (!existing || !expected || existing !== expected) throw new Error(`${resourceKind}_room_mismatch`);
}

function normalizeRoomId(roomId: string | null | undefined): string | undefined {
  const normalized = roomId?.trim();
  return normalized || undefined;
}
