import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import type { WorkspaceDb } from "./workspace-db-schema";
import type { WorkspacePaths } from "./workspace-paths";

/** Owns one SQLite connection and its lifecycle for a Workspace. */
export class WorkspaceDatabase {
  private connection: Kysely<WorkspaceDb> | undefined;

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
      this.connection = new Kysely<WorkspaceDb>({ dialect: new SqliteDialect({ database }) });
      return this.connection;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    await connection?.destroy();
  }

  async reopen(): Promise<Kysely<WorkspaceDb>> {
    await this.close();
    return this.open();
  }

  async checkpoint(): Promise<void> {
    await sql`PRAGMA wal_checkpoint(FULL)`.execute(this.db).catch(() => undefined);
  }

  static verifyIntegrity(dbPath: string): string {
    const database = new Database(dbPath, { readonly: true });
    try {
      return String(database.pragma("integrity_check", { simple: true }));
    } finally {
      database.close();
    }
  }
}
