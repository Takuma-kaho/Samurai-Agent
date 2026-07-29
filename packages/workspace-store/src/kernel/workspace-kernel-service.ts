import { sql, type Kysely } from "kysely";
import { workspaceMigrations } from "../migrations";
import { CollectionRecordRecoveryHandler } from "../transactions/collection-record-recovery-handler";
import {
  WorkspaceFileTransactionCoordinator,
  type WorkspaceFileTransactionFailureInjector
} from "../transactions/workspace-file-transaction-coordinator";
import { WorkspaceDatabase } from "./workspace-database";
import type { WorkspaceDb } from "./workspace-db-schema";
import { WorkspaceMigrationRunner } from "./migration-runner";
import { WorkspacePaths } from "./workspace-paths";
import { SessionSearchIndex } from "./session-search-index";

/**
 * Shared SQLite lifecycle and Phase 1 recovery primitives.
 *
 * It has no resource-specific API: repositories receive its concrete
 * transaction helpers only at composition time.
 */
export class WorkspaceKernelService {
  private dbConnection: Kysely<WorkspaceDb>;
  private collectionRecovery: CollectionRecordRecoveryHandler;
  private transactions: WorkspaceFileTransactionCoordinator;
  private search: SessionSearchIndex;

  readonly paths: WorkspacePaths;
  readonly database: WorkspaceDatabase;

  constructor(
    readonly rootDir: string,
    private readonly fileTransactionFailureInjector?: WorkspaceFileTransactionFailureInjector
  ) {
    this.paths = new WorkspacePaths(rootDir);
    this.database = new WorkspaceDatabase(this.paths);
    this.dbConnection = this.database.open();
    this.collectionRecovery = new CollectionRecordRecoveryHandler(this.dbConnection, rootDir);
    this.transactions = new WorkspaceFileTransactionCoordinator(
      this.dbConnection,
      rootDir,
      fileTransactionFailureInjector,
      [this.collectionRecovery]
    );
    this.search = new SessionSearchIndex(this.dbConnection);
  }

  get db(): Kysely<WorkspaceDb> {
    return this.dbConnection;
  }

  get dbPath(): string {
    return this.paths.dbPath;
  }

  get fileTransactions(): WorkspaceFileTransactionCoordinator {
    return this.transactions;
  }

  get collectionRecordRecoveryHandler(): CollectionRecordRecoveryHandler {
    return this.collectionRecovery;
  }

  get sessionSearchIndex(): SessionSearchIndex {
    return this.search;
  }

  async migrate(): Promise<void> {
    await new WorkspaceMigrationRunner(this.dbConnection, workspaceMigrations).migrate();
  }

  async listSchemaMigrations(): Promise<Array<{ version: number; name: string; checksum: string; applied_at: string }>> {
    const result = await sql<{ version: number; name: string; checksum: string; applied_at: string }>`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`.execute(this.dbConnection);
    return result.rows.map((row) => ({ ...row, version: Number(row.version) }));
  }

  async getSqliteRuntimeSettings(): Promise<{ foreign_keys: number; journal_mode: string; busy_timeout: number; synchronous: number }> {
    const [foreignKeys, journalMode, busyTimeout, synchronous] = await Promise.all([
      sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(this.dbConnection),
      sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(this.dbConnection),
      sql<{ timeout: number }>`PRAGMA busy_timeout`.execute(this.dbConnection),
      sql<{ synchronous: number }>`PRAGMA synchronous`.execute(this.dbConnection)
    ]);
    return {
      foreign_keys: Number(foreignKeys.rows[0]?.foreign_keys ?? 0),
      journal_mode: String(journalMode.rows[0]?.journal_mode ?? ""),
      busy_timeout: Number(busyTimeout.rows[0]?.timeout ?? 0),
      synchronous: Number(synchronous.rows[0]?.synchronous ?? 0)
    };
  }

  /** Kernel-owned SQLite integrity check used by Workspace maintenance. */
  async checkDatabaseIntegrity(): Promise<{ ok: boolean; result: string }> {
    const integrity = await sql<{ integrity_check: string }>`PRAGMA integrity_check`.execute(this.dbConnection);
    const result = integrity.rows.map((row) => row.integrity_check).join("\n") || "unknown";
    return { ok: result === "ok", result };
  }

  /** Validates a staged SQLite file before maintenance swaps it into place. */
  verifyDatabaseFileIntegrity(dbPath: string): string {
    return WorkspaceDatabase.verifyIntegrity(dbPath);
  }

  async recoverWorkspaceFileTransactions(): Promise<{ completed: number; rolled_back: number }> {
    return this.transactions.recoverPending();
  }

  async countPendingWorkspaceFileTransactions(): Promise<number> {
    return this.transactions.countPending();
  }

  async listMigrationJournal(limit = 20): Promise<Array<{ id: string; name: string; status: "completed" | "failed"; details_json: string; created_at: string }>> {
    const rows = await this.dbConnection
      .selectFrom("migration_journal")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(Math.max(1, Math.min(limit, 200)))
      .execute();
    return rows.map((row) => ({ ...row, status: row.status as "completed" | "failed" }));
  }

  async checkpoint(): Promise<void> {
    await this.database.checkpoint();
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  /** Recreate all database-bound Phase 1 helpers after an atomic restore. */
  async reopen(): Promise<void> {
    this.dbConnection = await this.database.reopen();
    this.collectionRecovery = new CollectionRecordRecoveryHandler(this.dbConnection, this.rootDir);
    this.transactions = new WorkspaceFileTransactionCoordinator(
      this.dbConnection,
      this.rootDir,
      this.fileTransactionFailureInjector,
      [this.collectionRecovery]
    );
    this.search = new SessionSearchIndex(this.dbConnection);
  }
}
