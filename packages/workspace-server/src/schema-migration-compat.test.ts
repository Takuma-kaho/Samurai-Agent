import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import {
  applyWorkspaceServerMigrations,
  workspaceServerMigrationDefinitions,
  workspaceServerMigrationStatus
} from "./schema";

describe("Workspace Server migration checksum compatibility", () => {
  it("does not rewrite legacy checksums when a later migration fails", async () => {
    const applied = migrationRowsThrough(79).map((migration) => legacyMigrationIfNeeded(migration));
    const client = new FakeMigrationClient(applied, "ALTER TABLE workspaces ALTER COLUMN organization_id DROP NOT NULL");

    await expect(applyWorkspaceServerMigrations(fakePool(client), "samurai_app")).rejects.toThrow("simulated_migration_failure");

    expect(ledgerUpdates(client)).toHaveLength(0);
    expect(client.queries.map((query) => query.text)).toContain("ROLLBACK");
  });

  it("rewrites only the known legacy checksums after grants succeed", async () => {
    const applied = migrationRowsThrough(81).map((migration) => legacyMigrationIfNeeded(migration));
    const client = new FakeMigrationClient(applied);

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    const updates = ledgerUpdates(client);
    expect(updates).toHaveLength(2);
    expect(updates.map((query) => query.values?.[1])).toEqual([78, 79]);
    const lastGrant = client.queries.reduce((index, query, queryIndex) => (
      query.text.startsWith("GRANT ") ? queryIndex : index
    ), -1);
    const firstUpdate = client.queries.findIndex((query) => query.text.startsWith("UPDATE samurai_server_schema_migrations"));
    const lastBegin = client.queries.map((query) => query.text).lastIndexOf("BEGIN");
    expect(lastGrant).toBeGreaterThanOrEqual(0);
    expect(lastBegin).toBeGreaterThan(lastGrant);
    expect(lastBegin).toBeLessThan(firstUpdate);
    expect(firstUpdate).toBeGreaterThan(lastGrant);
    expect(client.queries.map((query) => query.text).slice(firstUpdate, firstUpdate + 3)).toEqual([
      "UPDATE samurai_server_schema_migrations SET checksum = $1 WHERE version = $2",
      "UPDATE samurai_server_schema_migrations SET checksum = $1 WHERE version = $2",
      "COMMIT"
    ]);
  });

  it("keeps the corrected aliases out of the fresh-database migration SQL", () => {
    for (const version of [78, 79]) {
      const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === version);
      const sql = migration?.statements.join("\n") ?? "";
      expect(sql).not.toMatch(/organization_invitation_workspace_grants\s+grant\b/);
    }
  });
});

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
}

interface QueryCall {
  text: string;
  values?: readonly unknown[];
}

function migrationRowsThrough(version: number): MigrationRow[] {
  return workspaceServerMigrationStatus()
    .filter((migration) => migration.version <= version)
    .map((migration) => ({ ...migration }));
}

function legacyMigrationIfNeeded(migration: MigrationRow): MigrationRow {
  return migration.version === 78 || migration.version === 79
    ? legacyMigration(migration.version)
    : migration;
}

function legacyMigration(version: number): MigrationRow {
  const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === version);
  if (!migration) throw new Error(`missing_migration:${version}`);
  return {
    version: migration.version,
    name: migration.name,
    checksum: createHash("sha256")
      .update(JSON.stringify({
        name: migration.name,
        statements: migration.statements.map((statement) => statement.replace(/\binvitation_grant\b/g, "grant"))
      }))
      .digest("hex")
  };
}

function ledgerUpdates(client: FakeMigrationClient): QueryCall[] {
  return client.queries.filter((query) => query.text.startsWith("UPDATE samurai_server_schema_migrations"));
}

function fakePool(client: FakeMigrationClient): Pool {
  return { connect: async () => client as unknown as PoolClient } as unknown as Pool;
}

class FakeMigrationClient {
  readonly queries: QueryCall[] = [];

  constructor(
    private readonly applied: readonly MigrationRow[],
    private readonly failureText?: string
  ) {}

  async query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    if (this.failureText && text.includes(this.failureText)) throw new Error("simulated_migration_failure");
    if (text.includes("SELECT version, name, checksum FROM samurai_server_schema_migrations")) {
      return { rows: this.applied as unknown as Row[] } as QueryResult<Row>;
    }
    if (text === "COMMIT" || text === "ROLLBACK" || text === "BEGIN") return { rows: [] as Row[] } as QueryResult<Row>;
    return { rows: [] as Row[] } as QueryResult<Row>;
  }

  release(): void {}
}
