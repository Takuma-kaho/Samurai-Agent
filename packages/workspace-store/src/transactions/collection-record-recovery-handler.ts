import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Kysely, type Transaction } from "kysely";
import type { CollectionPatch, CollectionRecord } from "@samurai-agent/core-schemas";
import type { WorkspaceDb, WorkspaceFileTransactionsTable } from "../kernel/workspace-db-schema";
import { workspaceFileRecoveryAction } from "./recovery-policy";
import type { WorkspaceFileTransactionRecoveryHandler } from "./workspace-file-transaction-coordinator";

type StoredRecord = Omit<CollectionRecord, "version"> & { version: number; file_path?: string };

/** Owns Collection record SQLite writes and recovery; the coordinator stays resource-neutral. */
export class CollectionRecordRecoveryHandler implements WorkspaceFileTransactionRecoveryHandler {
  readonly kinds = ["collection_record_create", "collection_record_patch", "collection_record_repair", "collection_record_delete"] as const;

  constructor(private readonly db: Kysely<WorkspaceDb>, private readonly rootDir: string) {}

  async commitCreate(transaction: Transaction<WorkspaceDb>, input: { record: StoredRecord }): Promise<void> {
    const { file_path, ...record } = input.record;
    if (!file_path) throw new Error("collection_record_create_file_path_missing");
    await transaction.insertInto("collection_records").values({
      id: record.id,
      collection_id: record.collection_id,
      file_path,
      record_json: JSON.stringify(record),
      version: record.version,
      created_at: record.created_at,
      updated_at: record.updated_at
    }).execute();
  }

  async rollbackCreate(transaction: Transaction<WorkspaceDb>, input: { record: StoredRecord; fileTransactionId?: string }): Promise<void> {
    const current = await transaction.selectFrom("collection_records")
      .select("version")
      .where("collection_id", "=", input.record.collection_id)
      .where("id", "=", input.record.id)
      .executeTakeFirst();
    if (current && current.version !== input.record.version) {
      throw new Error(`workspace_file_transaction_rollback_conflict:${input.record.collection_id}:${input.record.id}`);
    }
    if (current) {
      const deleted = await transaction.deleteFrom("collection_records")
        .where("collection_id", "=", input.record.collection_id)
        .where("id", "=", input.record.id)
        .where("version", "=", input.record.version)
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows ?? 0) !== 1) {
        throw new Error(`workspace_file_transaction_rollback_conflict:${input.record.collection_id}:${input.record.id}`);
      }
    }
    await this.deleteTriggerJobs(transaction, input.fileTransactionId);
  }

  async commitPatch(transaction: Transaction<WorkspaceDb>, input: { collectionId: string; recordId: string; before: StoredRecord; after: StoredRecord; patch: CollectionPatch }): Promise<boolean> {
    const update = await transaction.updateTable("collection_records")
      .set({ record_json: JSON.stringify(input.after), version: input.after.version, updated_at: input.after.updated_at })
      .where("collection_id", "=", input.collectionId)
      .where("id", "=", input.recordId)
      .where("version", "=", input.before.version)
      .executeTakeFirst();
    if (Number(update.numUpdatedRows) !== 1) return false;
    await transaction.insertInto("collection_patches")
      .values({ id: input.patch.id, collection_id: input.collectionId, record_id: input.recordId, patch_json: JSON.stringify(input.patch), source_operation_id: input.patch.source_operation_id, created_at: input.patch.created_at })
      .onConflict((conflict) => conflict.columns(["collection_id", "record_id", "id"]).doNothing())
      .execute();
    return true;
  }

  async rollbackPatch(transaction: Transaction<WorkspaceDb>, input: {
    collectionId: string;
    recordId: string;
    before: StoredRecord;
    after: StoredRecord;
    patchId: string;
    fileTransactionId?: string;
  }): Promise<void> {
    await this.rollbackRecord(transaction, input);
    await transaction.deleteFrom("collection_patches").where("collection_id", "=", input.collectionId).where("record_id", "=", input.recordId).where("id", "=", input.patchId).execute();
    await this.deleteTriggerJobs(transaction, input.fileTransactionId);
  }

  async commitRepair(transaction: Transaction<WorkspaceDb>, input: { collectionId: string; recordId: string; before: StoredRecord; after: StoredRecord }): Promise<boolean> {
    const update = await transaction.updateTable("collection_records")
      .set({ record_json: JSON.stringify(input.after), version: input.after.version, updated_at: input.after.updated_at })
      .where("collection_id", "=", input.collectionId)
      .where("id", "=", input.recordId)
      .where("version", "=", input.before.version)
      .executeTakeFirst();
    return Number(update.numUpdatedRows) === 1;
  }

  async rollbackRepair(transaction: Transaction<WorkspaceDb>, input: { collectionId: string; recordId: string; before: StoredRecord; after: StoredRecord }): Promise<void> {
    await this.rollbackRecord(transaction, input);
  }

  async recover(row: WorkspaceFileTransactionsTable): Promise<"completed" | "rolled_back"> {
    const targetPath = path.join(this.rootDir, row.target_path);
    const stagedPath = path.join(this.rootDir, row.staged_path);
    if (row.kind === "collection_record_delete") {
      if (row.status === "db_committed") {
        await rm(stagedPath, { force: true });
        return "completed";
      }
      if (await exists(stagedPath)) {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await rename(stagedPath, targetPath);
      }
      return "rolled_back";
    }
    const target = await readFile(targetPath, "utf8").then((value) => JSON.parse(value) as StoredRecord).catch(() => undefined);
    const after = JSON.parse(row.after_json) as StoredRecord;
    const action = workspaceFileRecoveryAction({ status: row.status, stagedExists: await exists(stagedPath), targetVersion: target?.version, afterVersion: after.version });
    if (action === "finalize_staged") {
      await rename(stagedPath, targetPath);
      return "completed";
    }
    if (action === "accept_target") return "completed";
    if (action === "discard_staged") {
      await rm(stagedPath, { force: true });
      return "rolled_back";
    }
    if (row.kind === "collection_record_create") {
      if (!row.collection_id || !row.record_id) throw new Error(`workspace_file_transaction_invalid:${row.id}`);
      await this.db.transaction().execute(async (transaction) => {
        await this.rollbackCreate(transaction, { record: after, fileTransactionId: row.id });
      });
      return "rolled_back";
    }
    if (!row.collection_id || !row.record_id) throw new Error(`workspace_file_transaction_invalid:${row.id}`);
    const before = JSON.parse(row.before_json) as StoredRecord;
    await this.db.transaction().execute(async (transaction) => {
      if (row.kind === "collection_record_patch" && row.patch_id) {
        await this.rollbackPatch(transaction, {
          collectionId: row.collection_id!,
          recordId: row.record_id!,
          before,
          after,
          patchId: row.patch_id,
          fileTransactionId: row.id
        });
      } else {
        await this.rollbackRepair(transaction, { collectionId: row.collection_id!, recordId: row.record_id!, before, after });
      }
    });
    return "rolled_back";
  }

  private async rollbackRecord(transaction: Transaction<WorkspaceDb>, input: { collectionId: string; recordId: string; before: StoredRecord; after: StoredRecord }): Promise<void> {
    const current = await transaction.selectFrom("collection_records")
      .select("version")
      .where("collection_id", "=", input.collectionId)
      .where("id", "=", input.recordId)
      .executeTakeFirst();
    if (current?.version === input.before.version) return;
    if (current?.version !== input.after.version) throw new Error(`workspace_file_transaction_rollback_conflict:${input.collectionId}:${input.recordId}`);
    const update = await transaction.updateTable("collection_records")
      .set({ record_json: JSON.stringify(input.before), version: input.before.version, updated_at: input.before.updated_at })
      .where("collection_id", "=", input.collectionId)
      .where("id", "=", input.recordId)
      .where("version", "=", input.after.version)
      .executeTakeFirst();
    if (Number(update.numUpdatedRows) !== 1) throw new Error(`workspace_file_transaction_rollback_conflict:${input.collectionId}:${input.recordId}`);
  }

  private async deleteTriggerJobs(transaction: Transaction<WorkspaceDb>, fileTransactionId?: string): Promise<void> {
    if (!fileTransactionId) return;
    await transaction.deleteFrom("automation_jobs").where("file_transaction_id", "=", fileTransactionId).execute();
  }
}

async function exists(filePath: string): Promise<boolean> {
  return readFile(filePath).then(() => true).catch(() => false);
}
