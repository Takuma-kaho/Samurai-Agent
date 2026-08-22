import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Kysely, type Transaction } from "kysely";
import type { WorkspaceDb, WorkspaceFileTransactionsTable } from "../kernel/workspace-db-schema";

export type WorkspaceFileTransactionFailurePhase = "planned" | "staged" | "db_transaction" | "db_committed" | "renamed";
export type WorkspaceFileTransactionFailureInjector = (phase: WorkspaceFileTransactionFailurePhase) => void;

export class WorkspaceSimulatedCrashError extends Error {}

export interface WorkspaceFileTransactionRecoveryHandler {
  readonly kinds: readonly string[];
  recover(row: WorkspaceFileTransactionsTable): Promise<"completed" | "rolled_back">;
}

export interface WorkspaceFileTransactionRequest {
  kind: string;
  targetPath: string;
  stagedPath: string;
  collectionId?: string;
  recordId?: string;
  patchId?: string;
  beforeJson: string;
  afterJson: string;
  stagedContent?: string;
  /** Stages an existing file when the operation is not a replace-file write. */
  stage?: () => Promise<void>;
  /** Completes the filesystem half after the database transaction commits. */
  finalize?: () => Promise<void>;
  /** Restores staging when the database transaction does not commit. */
  rollbackStage?: () => Promise<void>;
  /** Some finalizers are themselves recoverable and must keep the journal. */
  preserveOnFinalizeFailure?: boolean;
  commit(transaction: Transaction<WorkspaceDb>): Promise<void>;
  rollback(transaction: Transaction<WorkspaceDb>): Promise<void>;
}

/** Coordinates a filesystem rename with one SQLite transaction without knowing resource semantics. */
export class WorkspaceFileTransactionCoordinator {
  private readonly handlers = new Map<string, WorkspaceFileTransactionRecoveryHandler>();

  constructor(
    private readonly db: Kysely<WorkspaceDb>,
    private readonly rootDir: string,
    private readonly failureInjector?: WorkspaceFileTransactionFailureInjector,
    handlers: readonly WorkspaceFileTransactionRecoveryHandler[] = []
  ) {
    for (const handler of handlers) for (const kind of handler.kinds) this.handlers.set(kind, handler);
  }

  async execute(request: WorkspaceFileTransactionRequest): Promise<void> {
    const id = `file_transaction_${randomUUID()}`;
    const stagedAbsolutePath = path.join(this.rootDir, request.stagedPath);
    const targetAbsolutePath = path.join(this.rootDir, request.targetPath);
    const createdAt = new Date().toISOString();
    let databaseCommitted = false;
    let renameAttempted = false;
    let fileRenamed = false;
    let preserveForRecovery = false;

    await this.db.insertInto("workspace_file_transactions").values({
      id,
      kind: request.kind,
      status: "planned",
      target_path: request.targetPath,
      staged_path: request.stagedPath,
      collection_id: request.collectionId ?? null,
      record_id: request.recordId ?? null,
      patch_id: request.patchId ?? null,
      before_json: request.beforeJson,
      after_json: request.afterJson,
      created_at: createdAt,
      updated_at: createdAt
    }).execute();

    try {
      this.failureInjector?.("planned");
      if (request.stage) {
        await request.stage();
      } else {
        if (request.stagedContent === undefined) throw new Error(`workspace_file_transaction_staged_content_missing:${request.kind}`);
        await writeFile(stagedAbsolutePath, request.stagedContent, { flag: "wx" });
      }
      await this.db.updateTable("workspace_file_transactions").set({ status: "staged", updated_at: new Date().toISOString() }).where("id", "=", id).execute();
      this.failureInjector?.("staged");
      await this.db.transaction().execute(async (transaction) => {
        this.failureInjector?.("db_transaction");
        await request.commit(transaction);
        await transaction.updateTable("workspace_file_transactions").set({ status: "db_committed", updated_at: new Date().toISOString() }).where("id", "=", id).execute();
      });
      databaseCommitted = true;
      this.failureInjector?.("db_committed");
      renameAttempted = true;
      if (request.finalize) {
        await request.finalize();
      } else {
        await rename(stagedAbsolutePath, targetAbsolutePath);
      }
      fileRenamed = true;
      this.failureInjector?.("renamed");
      await this.db.deleteFrom("workspace_file_transactions").where("id", "=", id).execute();
    } catch (error) {
      if (error instanceof WorkspaceSimulatedCrashError) {
        preserveForRecovery = true;
        throw error;
      }
      if (!databaseCommitted) {
        try {
          if (request.rollbackStage) await request.rollbackStage();
          else await rm(stagedAbsolutePath, { force: true });
          await this.db.deleteFrom("workspace_file_transactions").where("id", "=", id).execute();
        } catch {
          preserveForRecovery = true;
        }
        throw error;
      }
      // Before rename or after a successful rename, the journal is the only safe recovery path.
      if (!renameAttempted || fileRenamed || request.preserveOnFinalizeFailure) {
        preserveForRecovery = true;
        throw error;
      }
      try {
        await this.db.transaction().execute(async (transaction) => {
          await request.rollback(transaction);
          await transaction.deleteFrom("workspace_file_transactions").where("id", "=", id).execute();
        });
      } catch (rollbackError) {
        preserveForRecovery = true;
        throw rollbackError;
      }
      throw error;
    } finally {
      if (!preserveForRecovery) await rm(stagedAbsolutePath, { force: true });
    }
  }

  async recoverPending(): Promise<{ completed: number; rolled_back: number }> {
    const rows = await this.db.selectFrom("workspace_file_transactions").selectAll().where("status", "!=", "completed").orderBy("created_at", "asc").execute();
    let completed = 0;
    let rolledBack = 0;
    for (const row of rows) {
      const handler = this.handlers.get(row.kind);
      if (!handler) throw new Error(`workspace_file_transaction_handler_missing:${row.kind}`);
      const outcome = await handler.recover(row);
      await this.db.deleteFrom("workspace_file_transactions").where("id", "=", row.id).execute();
      if (outcome === "completed") completed += 1;
      else rolledBack += 1;
    }
    return { completed, rolled_back: rolledBack };
  }

  async countPending(): Promise<number> {
    const row = await this.db.selectFrom("workspace_file_transactions").select(({ fn }) => fn.countAll<number>().as("count")).where("status", "!=", "completed").executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
