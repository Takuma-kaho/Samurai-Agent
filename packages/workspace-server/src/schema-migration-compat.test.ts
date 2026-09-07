import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import {
  applyWorkspaceServerMigrations,
  workspaceServerMigrationDefinitions,
  workspaceServerMigrationStatus
} from "./schema";

describe("Workspace Server migration checksum compatibility", () => {
  const legacyV109Checksum = "b08987e51ff8a5caa421b5ea76503b8698da1904afc1416a5f0ada5e40acc143";

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

  it("grants the runtime role the reassignment guard used by reservation claims", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(116));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    const grantQuery = client.queries.find((query) => query.text.startsWith("GRANT EXECUTE ON FUNCTION"));
    expect(grantQuery?.text).toContain("samurai_human_work_assignment_is_superseded(TEXT, TEXT)");
  });

  it("accepts only the known legacy v109 checksum and converges it before v115", async () => {
    const applied = migrationRowsThrough(109).map((migration) => (
      migration.version === 109 ? { ...migration, checksum: legacyV109Checksum } : migration
    ));
    const client = new FakeMigrationClient(applied);

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    const currentV109 = workspaceServerMigrationStatus().find((migration) => migration.version === 109)?.checksum;
    expect(currentV109).toBe("624d49c1a5c07c718366215eebcab9109e7903004478cb414004f35ab9dbdff2");
    expect(ledgerUpdates(client)).toContainEqual({
      text: "UPDATE samurai_server_schema_migrations SET checksum = $1 WHERE version = $2",
      values: [currentV109, 109]
    });
    expect(workspaceServerMigrationDefinitions().find((migration) => migration.version === 113)?.statements.join("\n"))
      .toContain("samurai_reassign_human_work");
    expect(workspaceServerMigrationDefinitions().find((migration) => migration.version === 115)?.name)
      .toBe("workspace_server_human_work_continuation_reply_only");
    const grantIndex = client.queries.reduce((index, query, queryIndex) => (
      query.text.startsWith("GRANT ") ? queryIndex : index
    ), -1);
    const updateIndex = client.queries.findIndex((query) => query.text.startsWith("UPDATE samurai_server_schema_migrations"));
    expect(grantIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(grantIndex);
  });

  it("rejects an unknown v109 checksum without rewriting the ledger", async () => {
    const applied = migrationRowsThrough(109).map((migration) => (
      migration.version === 109 ? { ...migration, checksum: "0".repeat(64) } : migration
    ));
    const client = new FakeMigrationClient(applied);

    await expect(applyWorkspaceServerMigrations(fakePool(client), "samurai_app"))
      .rejects.toThrow("workspace_server_schema_migration_mismatch:109");
    expect(ledgerUpdates(client)).toHaveLength(0);
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
