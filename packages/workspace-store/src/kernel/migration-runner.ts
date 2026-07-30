import { createHash, randomUUID } from "node:crypto";
import { Kysely, sql, type Transaction } from "kysely";
import type { WorkspaceDb } from "./workspace-db-schema";

export interface WorkspaceMigration {
  version: number;
  name: string;
  steps: readonly WorkspaceMigrationStep[];
}

export type WorkspaceMigrationStep =
  | { kind: "sql"; statement: string }
  | { kind: "add_column_if_missing"; table: string; column: string; statement: string }
  | { kind: "sql_if_column_exists"; table: string; column: string; statement: string };

type SqliteExecutor = Kysely<WorkspaceDb> | Transaction<WorkspaceDb>;
type AppliedMigration = { version: number; name: string; checksum: string; applied_at: string };

export class WorkspaceMigrationRunner {
  constructor(private readonly db: Kysely<WorkspaceDb>, private readonly migrations: readonly WorkspaceMigration[]) {}

  async migrate(): Promise<void> {
    this.assertMigrationDefinitions();
    const historyExists = await tableExists(this.db, "schema_migrations");
    const applied = historyExists ? await this.listApplied() : [];
    this.assertAppliedHistory(applied);
    await this.ensureMetadataTables();
    const appliedVersions = new Set(applied.map((migration) => migration.version));
    for (const migration of this.migrations) {
      if (appliedVersions.has(migration.version)) continue;
      try {
        await this.db.transaction().execute(async (transaction) => {
          for (const step of migration.steps) await this.executeStep(transaction, step);
          await sql`INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (${migration.version}, ${migration.name}, ${migrationChecksum(migration)}, ${nowIso()})`.execute(transaction);
        });
      } catch (error) {
        await this.recordFailure(migration, error).catch(() => undefined);
        throw error;
      }
    }
  }

  async listApplied(): Promise<AppliedMigration[]> {
    const result = await sql<AppliedMigration>`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`.execute(this.db);
    return result.rows.map((row) => ({ ...row, version: Number(row.version) }));
  }

  private assertMigrationDefinitions(): void {
    let previous = 0;
    const seen = new Set<number>();
    for (const migration of this.migrations) {
      if (!Number.isInteger(migration.version) || migration.version <= 0 || seen.has(migration.version) || migration.version <= previous) {
        throw new Error(`schema_migration_definition_invalid:${migration.version}`);
      }
      seen.add(migration.version);
      previous = migration.version;
    }
  }

  private assertAppliedHistory(applied: readonly AppliedMigration[]): void {
    const definitions = new Map(this.migrations.map((migration) => [migration.version, migration]));
    const latest = this.migrations.at(-1)?.version ?? 0;
    let expectedVersion = 1;
    for (const current of applied) {
      if (current.version > latest) throw new Error(`schema_migration_version_too_new:${current.version}`);
      if (current.version !== expectedVersion) throw new Error(`schema_migration_history_gap:${expectedVersion}:${current.version}`);
      const definition = definitions.get(current.version);
      if (!definition) throw new Error(`schema_migration_history_unknown:${current.version}`);
      if (current.name !== definition.name) throw new Error(`schema_migration_name_mismatch:${current.version}`);
      if (current.checksum !== migrationChecksum(definition)) throw new Error(`schema_migration_checksum_mismatch:${current.version}`);
      expectedVersion += 1;
    }
  }

  private async ensureMetadataTables(): Promise<void> {
    await sql.raw(`CREATE TABLE IF NOT EXISTS migration_journal (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`).execute(this.db);
    await sql.raw(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`).execute(this.db);
  }

  private async executeStep(db: SqliteExecutor, step: WorkspaceMigrationStep): Promise<void> {
    if (step.kind === "sql") {
      await sql.raw(step.statement).execute(db);
      return;
    }
    const exists = await hasColumn(db, step.table, step.column);
    if (step.kind === "add_column_if_missing" ? !exists : exists) await sql.raw(step.statement).execute(db);
  }

  private async recordFailure(migration: WorkspaceMigration, error: unknown): Promise<void> {
    await sql`INSERT INTO migration_journal(id, name, status, details_json, created_at) VALUES (${randomUUID()}, ${`migration.${migration.version}.${migration.name}`}, ${"failed"}, ${JSON.stringify({ version: migration.version, error: errorMessage(error) })}, ${nowIso()})`.execute(this.db);
  }
}

export function migrationChecksum(migration: WorkspaceMigration): string {
  return createHash("sha256").update(JSON.stringify({ statements: migration.steps.map((step) => step.statement), migrationName: migration.name })).digest("hex");
}

async function hasColumn(db: SqliteExecutor, table: string, column: string): Promise<boolean> {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) throw new Error("schema_migration_identifier_invalid");
  const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(db);
  return result.rows.some((row) => row.name === column);
}

async function tableExists(db: SqliteExecutor, table: string): Promise<boolean> {
  if (!/^[a-z_]+$/.test(table)) throw new Error("schema_migration_identifier_invalid");
  const result = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`.execute(db);
  return result.rows.length > 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
