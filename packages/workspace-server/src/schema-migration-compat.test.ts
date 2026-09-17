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

  it("appends the Episode external-key nullability repair after existing schemas", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(125));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    const statements = client.queries.map((query) => query.text);
    expect(statements).toContain("BEGIN");
    expect(statements.some((statement) => statement.includes("pg_get_constraintdef"))).toBe(true);
    expect(statements).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS workspace_completion_episodes_external_key_unique ON workspace_completion_episodes(workspace_id, room_id, external_episode_key) WHERE external_episode_key IS NOT NULL"
    );
    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([126, "workspace_server_completion_episode_external_key_nullability_repair"])
    });
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

  it("appends the Native UI context-sharing schema after the existing migrations", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(128));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([129, "workspace_server_native_ui_context_sharing_schema"])
    });
    const contextMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 129);
    expect(contextMigration?.statements.join("\n")).toContain("workspace_completion_resources_workspace_knowledge_retired_check");
    expect(contextMigration?.statements.join("\n")).toContain("account_notification_outbox_due_index");
  });

  it("appends the import-session-only sharing RLS repair after v129", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(129));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([130, "workspace_server_native_ui_context_sharing_import_rls"])
    });
    const repairMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 130);
    const repairSql = repairMigration?.statements.join("\n") ?? "";
    expect(repairSql).toContain("samurai_is_import_session(workspace_id)");
    expect(repairSql).toContain("samurai_guard_workspace_share_recipients");
    expect(repairSql).toContain("PERFORM samurai_abort_workspace_import_v89");
    expect(repairSql).not.toContain("CREATE POLICY account_notifications");
    expect(repairSql).not.toContain("CREATE POLICY account_notification_outbox");
  });

  it("appends the narrow public-share functions after v130 without an anonymous RLS policy", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(130));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([131, "workspace_server_share_public_locator_and_claim_functions"])
    });
    const publicShareMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 131);
    const publicShareSql = publicShareMigration?.statements.join("\n") ?? "";
    expect(publicShareSql).toContain("samurai_workspace_share_public_lookup");
    expect(publicShareSql).toContain("samurai_workspace_share_claim");
    expect(publicShareSql).toContain("samurai_workspace_share_claim_content");
    expect(publicShareSql).toContain("FOR UPDATE");
    expect(publicShareSql).not.toContain("CREATE POLICY workspace_shares_public");
    expect(publicShareSql).not.toContain("CREATE POLICY workspace_share_claims_public");
  });

  it("appends the Account-owned personal preference snapshot guard after v131", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(131));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([132, "workspace_server_human_work_personal_preferences_snapshot"])
    });
    const preferenceMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 132);
    const preferenceSql = preferenceMigration?.statements.join("\n") ?? "";
    expect(preferenceSql).toContain("personal_preferences_snapshot JSONB NULL");
    expect(preferenceSql).toContain("workspace_human_work_instructions_personal_preferences_snapshot_check");
    expect(preferenceSql).toContain("samurai_set_human_work_instruction_personal_preferences");
    expect(preferenceSql).toContain("operation_row.status = 'running'");
    expect(preferenceSql).toContain("instruction_row.work_id IS DISTINCT FROM target_work_id");
    expect(preferenceSql).toContain("instruction_row.created_by IS DISTINCT FROM samurai_current_account_id()");
    expect(preferenceSql).toContain("FOR UPDATE");
    expect(preferenceSql).toContain("human_work_instruction_version_conflict");
  });

  it("appends canonical HTTPS share origins without rewriting legacy audit rows", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(132));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([133, "workspace_server_share_origin_canonicalization"])
    });
    const originMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 133);
    const originSql = originMigration?.statements.join("\n") ?? "";
    expect(originSql).toContain("DROP CONSTRAINT IF EXISTS workspace_share_claims_target_origin_check");
    expect(originSql).toContain("DROP CONSTRAINT IF EXISTS workspace_share_imports_source_origin_check");
    expect(originSql).toContain("CHECK (target_origin ~ '^https://[^/?#@]+/$') NOT VALID");
    expect(originSql).toContain("CHECK (source_origin ~ '^https://[^/?#@]+/$') NOT VALID");
    expect(originSql).toContain("samurai_normalize_workspace_share_claim_origin");
    expect(originSql).toContain("samurai_normalize_workspace_share_import_origin");
    expect(originSql).toContain("workspace_share_claims_origin_canonicalization");
    expect(originSql).toContain("workspace_share_imports_origin_canonicalization");
    expect(originSql).toContain("VALIDATE CONSTRAINT workspace_share_claims_target_origin_canonical_check");
    expect(originSql).toContain("VALIDATE CONSTRAINT workspace_share_imports_source_origin_canonical_check");
    expect(originSql).toContain("p_target_origin !~ '^https://[^/?#@]+/$'");
    expect(originSql).not.toContain("p_target_origin !~ '^https?://[^/?#@]+$'");
    expect(originSql).not.toMatch(/UPDATE\s+workspace_share_(claims|imports)/);
    expect(originSql).not.toMatch(/DELETE\s+FROM\s+workspace_share_(claims|imports)/);
  });

  it("normalizes committed imports and fixes their terminal retry state", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(133));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([134, "workspace_server_share_committed_import_terminal_state"])
    });
    const terminalMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 134);
    const terminalSql = terminalMigration?.statements.join("\n") ?? "";
    expect(terminalSql).toContain("SET retryable = FALSE, failure_code = NULL");
    expect(terminalSql).toContain("workspace_share_imports_committed_terminal_state_check");
    expect(terminalSql).toContain("VALIDATE CONSTRAINT workspace_share_imports_committed_terminal_state_check");
  });

  it("converges failed imports and guards resource scope at the committed boundary", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(134));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([135, "workspace_server_share_import_scope_and_failed_terminal_guards"])
    });
    const scopeMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 135);
    const scopeSql = scopeMigration?.statements.join("\n") ?? "";
    expect(scopeSql).toContain("SET phase = 'cleanup', retryable = FALSE, lease_token = NULL, lease_until = NULL");
    expect(scopeSql).toContain("workspace_share_imports_failed_terminal_state_check");
    expect(scopeSql).toContain("samurai_guard_workspace_share_import_agent_scope");
    expect(scopeSql).toContain("samurai_guard_workspace_share_import_resource");
    expect(scopeSql).toContain("samurai_guard_workspace_share_import_resource_parent");
    expect(scopeSql).toContain("resource_row.scope_kind <> 'agent'");
    expect(scopeSql).toContain("resource_row.scope_kind <> 'room'");
  });

  it("records orphaned Workspace file paths before deleting their DB batches", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(135));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([136, "workspace_server_completion_file_cleanup_ledger"])
    });
    const cleanupMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 136);
    const cleanupSql = cleanupMigration?.statements.join("\n") ?? "";
    expect(cleanupSql.indexOf("INSERT INTO workspace_completion_file_cleanup_queue")).toBeLessThan(cleanupSql.indexOf("DELETE FROM workspace_completion_file_batch_entries"));
    expect(cleanupSql.indexOf("DELETE FROM workspace_completion_file_batch_entries")).toBeLessThan(cleanupSql.indexOf("DELETE FROM workspace_completion_file_batches"));
    expect(cleanupSql).toContain("ALTER TABLE workspace_completion_file_cleanup_queue FORCE ROW LEVEL SECURITY");
    expect(cleanupSql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("restores Completion migration capability after the Agent-scope RLS rewrite", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(136));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([137, "workspace_server_completion_migration_resource_rls_boundary"])
    });
    const repairMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 137);
    const repairSql = repairMigration?.statements.join("\n") ?? "";
    for (const policy of [
      "workspace_completion_resources_access",
      "workspace_completion_versions_access",
      "workspace_completion_evidence_access",
      "workspace_completion_skill_files_access"
    ]) {
      expect(repairSql).toContain(`ALTER POLICY ${policy}`);
    }
    expect(repairSql).toContain("samurai_is_import_session(workspace_id)");
    expect(repairSql).toContain("samurai_completion_migration_write_allowed(workspace_id)");
  });

  it("allows only an owning account's writable draft Share file transaction", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(137));

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([138, "workspace_server_share_draft_file_transaction_rls"])
    });
    const repairMigration = workspaceServerMigrationDefinitions().find((migration) => migration.version === 138);
    const repairSql = repairMigration?.statements.join("\n") ?? "";
    expect(repairSql).toContain("ALTER POLICY workspace_share_file_transactions_internal ON workspace_share_file_transactions");
    expect(repairSql).toContain("owner_kind = 'draft'");
    expect(repairSql).toContain("share_row.status = 'draft'");
    expect(repairSql).toContain("share_row.created_by = samurai_current_account_id()");
    expect(repairSql).toContain("samurai_can_room(share_row.workspace_id, share_row.source_room_id, 'manage')");
    expect(repairSql).toContain("samurai_can_workspace(share_row.workspace_id, 'admin')");
    expect(repairSql).toContain("samurai_workspace_is_writable(workspace_id)");
    expect(repairSql).toContain("actor_account_id = samurai_current_account_id()");
    expect(repairSql).toContain("current_setting('samurai.share_operation', true) = '1'");
    expect(repairSql).toContain("samurai_is_completion_maintenance_identity(workspace_id)");
    expect(repairSql).toContain("samurai_is_import_session(workspace_id)");
    expect(repairSql).toContain("current_setting('samurai.internal_access', true) = '1'");
    expect(repairSql).toContain("current_setting('samurai.share_operation', true) = '1'");
  });

  it("extends Share recipient reads to active and revoked owner-managed Shares", () => {
    const migration = workspaceServerMigrationDefinitions().find((item) => item.version === 139);
    const sql = migration?.statements.join("\n") ?? "";
    expect(migration?.name).toBe("workspace_server_share_recipient_read_projection_rls");
    expect(sql).toContain("ALTER POLICY workspace_share_recipients_manage ON workspace_share_recipients");
    expect(sql).toContain("share_row.status IN ('draft','active','revoked')");
  });

  it("allows the maintenance projection to satisfy notification ON CONFLICT RLS", () => {
    const migration = workspaceServerMigrationDefinitions().find((item) => item.version === 140);
    const sql = migration?.statements.join("\n") ?? "";
    expect(migration?.name).toBe("workspace_server_notification_projection_rls");
    expect(sql).toContain("CREATE POLICY account_notifications_internal_read ON account_notifications FOR SELECT");
    expect(sql).toContain("samurai_is_completion_maintenance_identity(workspace_id)");
    expect(sql).toContain("current_setting('samurai.internal_access', true) = '1'");
  });

  it("rolls back the cleanup ledger transaction when the queue insert fails", async () => {
    const client = new FakeMigrationClient(migrationRowsThrough(135), "INSERT INTO workspace_completion_file_cleanup_queue");

    await expect(applyWorkspaceServerMigrations(fakePool(client), "samurai_app"))
      .rejects.toThrow("simulated_migration_failure");
    expect(client.queries.map((query) => query.text)).toContain("ROLLBACK");
    expect(client.queries).not.toContainEqual(expect.objectContaining({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([136, "workspace_server_completion_file_cleanup_ledger"])
    }));
  });

  it("accepts the pre-ledger v129 checksum and converges it after the repair", async () => {
    const applied = migrationRowsThrough(135).map((migration) => (
      migration.version === 129
        ? { ...migration, checksum: "c9691dde97e7a3879f2b72605a065cc42c46d9278b42eec75971eab6e2b5afde" }
        : migration
    ));
    const client = new FakeMigrationClient(applied);

    await applyWorkspaceServerMigrations(fakePool(client), "samurai_app");

    const currentV129 = workspaceServerMigrationStatus().find((migration) => migration.version === 129)?.checksum;
    expect(ledgerUpdates(client)).toContainEqual({
      text: "UPDATE samurai_server_schema_migrations SET checksum = $1 WHERE version = $2",
      values: [currentV129, 129]
    });
    expect(client.queries).toContainEqual({
      text: "INSERT INTO samurai_server_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
      values: expect.arrayContaining([136, "workspace_server_completion_file_cleanup_ledger"])
    });
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
