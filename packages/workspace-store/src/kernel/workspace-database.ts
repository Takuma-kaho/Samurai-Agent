import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import type { WorkspaceDb } from "./workspace-db-schema";
import type { WorkspacePaths } from "./workspace-paths";

/** Owns one SQLite connection and its lifecycle for a Workspace. */
export class WorkspaceDatabase {
  private connection: Kysely<WorkspaceDb> | undefined;
  private rawConnection: Database.Database | undefined;

  constructor(private readonly paths: WorkspacePaths) {}

  get db(): Kysely<WorkspaceDb> {
    if (!this.connection) throw new Error("workspace_database_closed");
    return this.connection;
  }

  open(): Kysely<WorkspaceDb> {
    if (this.connection) return this.connection;
    const database = new Database(this.paths.dbPath);
    try {
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = NORMAL");
      database.pragma("busy_timeout = 5000");
      this.rawConnection = database;
      this.connection = new Kysely<WorkspaceDb>({ dialect: new SqliteDialect({ database }) });
      return this.connection;
    } catch (error) {
      this.rawConnection = undefined;
      database.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.rawConnection = undefined;
    await connection?.destroy();
  }

  async reopen(): Promise<Kysely<WorkspaceDb>> {
    await this.close();
    return this.open();
  }

  async checkpoint(): Promise<void> {
    await sql`PRAGMA wal_checkpoint(FULL)`.execute(this.db);
  }

  /**
   * The restore boundary must not proceed while a WAL checkpoint is busy.
   * A suppressed checkpoint would let old sidecar state race a replacement DB.
   */
  checkpointTruncate(): void {
    const database = this.rawConnection;
    if (!database) throw new Error("workspace_database_closed");
    const result = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>;
    if (Number(result[0]?.busy ?? 0) !== 0) throw new Error("workspace_database_checkpoint_busy");
  }

  /** Creates an SQLite-consistent snapshot, including committed WAL contents. */
  async backupTo(destination: string): Promise<void> {
    const database = this.rawConnection;
    if (!database) throw new Error("workspace_database_closed");
    await database.backup(destination);
  }

  static verifyIntegrity(dbPath: string): string {
    const database = new Database(dbPath, { readonly: true });
    try {
      return String(database.pragma("integrity_check", { simple: true }));
    } finally {
      database.close();
    }
  }

  /** Makes a completed snapshot self-contained before it is published as a file. */
  static checkpointFileTruncate(dbPath: string): void {
    const database = new Database(dbPath);
    try {
      const result = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>;
      if (Number(result[0]?.busy ?? 0) !== 0) throw new Error("workspace_database_checkpoint_busy");
    } finally {
      database.close();
    }
  }
}
