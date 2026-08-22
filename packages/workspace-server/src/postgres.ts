import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { isTrustedWorkspaceCallerForAccount } from "./auth";
import { WorkspaceServerError } from "./errors";
import { applyWorkspaceServerMigrations, workspaceServerMigrationStatus } from "./schema";
import type { WorkspaceCaller } from "./types";

export interface WorkspaceDatabaseContext {
  accountId: string;
  workspaceId?: string;
  /** A Server-owned operational integration transaction. This is distinct
   * from a Workspace content caller and is only set by the external
   * integration composition root. */
  externalIntegration?: boolean;
  bootstrap?: boolean;
  /** A short-lived, account-bound import capability created by PostgreSQL. */
  importId?: string;
  /** Trusted Server-side provenance, copied into transaction-local settings
   * for RLS functions. It is not a client-provided transport field. */
  caller?: WorkspaceCaller;
  /** Server-owned completion migration capability. */
  migrationRunId?: string;
  migrationOperation?: "completion_backfill" | "completion_rollback";
  /** A Server-owned worker transaction used only to enumerate configured
   * maintenance identities before opening one RLS-scoped Workspace tick. */
  worker?: boolean;
}

export interface WorkspaceSql {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

export interface PostgresWorkspaceDatabaseOptions {
  databaseUrl: string;
  runtimeRole: string;
}

/**
 * Administrative database access is deliberately separate from the runtime
 * Server.  A HTTP/Socket process must never receive this URL: migrations and
 * maintenance run in a short-lived command instead.
 */
export interface PostgresWorkspaceAdminDatabaseOptions {
  databaseAdminUrl: string;
  runtimeRole: string;
}

/**
 * Every application query runs in an explicit transaction with a local tenant
 * context. PostgreSQL RLS reads these settings, so a missing WHERE clause does
 * not expose another Workspace.
 */
export class PostgresWorkspaceDatabase {
  private readonly appPool: Pool;

  constructor(private readonly options: PostgresWorkspaceDatabaseOptions) {
    this.appPool = new Pool({ connectionString: options.databaseUrl, max: 12 });
  }

  /**
   * Runtime startup is intentionally read-only with respect to schema
   * administration.  Deployments must run the dedicated migration command
   * before starting this process.
   */
  async assertReady(): Promise<void> {
    await this.assertRuntimeRoleIsRlsSafe();
    const result = await this.appPool.query<{ schema_ready: string | null }>(
      "SELECT to_regclass('public.samurai_server_schema_migrations') AS schema_ready"
    );
    if (!result.rows[0]?.schema_ready) {
      throw new WorkspaceServerError("workspace_server_schema_migration_required", 503);
    }
    const expected = workspaceServerMigrationStatus();
    const applied = await this.appPool.query<{ version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM samurai_server_schema_migrations ORDER BY version"
    );
    if (applied.rows.length !== expected.length || expected.some((migration, index) => {
      const current = applied.rows[index];
      return !current || Number(current.version) !== migration.version || current.name !== migration.name || current.checksum !== migration.checksum;
    })) {
      throw new WorkspaceServerError("workspace_server_schema_migration_required", 503);
    }
  }

  /** Lightweight readiness probe used by the unauthenticated health route. */
  async ping(): Promise<void> {
    await this.appPool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.appPool.end();
  }

  async withContext<T>(context: WorkspaceDatabaseContext, action: (sql: WorkspaceSql) => Promise<T>): Promise<T> {
    const client = await this.appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path TO public");
      await setTenantContext(client, context);
      const value = await action(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** A stable Bundle/Backup snapshot must observe one PostgreSQL point in time. */
  async withReadSnapshot<T>(context: WorkspaceDatabaseContext, action: (sql: WorkspaceSql) => Promise<T>): Promise<T> {
    const client = await this.appPool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL search_path TO public");
      await setTenantContext(client, context);
      const value = await action(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertRuntimeRoleIsRlsSafe(): Promise<void> {
    const result = await this.appPool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      owns_rls_table: boolean;
      can_assume_privileged_role: boolean;
    }>(`
      SELECT
        current_user,
        runtime_role_row.rolsuper,
        runtime_role_row.rolbypassrls,
        EXISTS(
          SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relrowsecurity
            AND relation.relowner = runtime_role_row.oid
        ) AS owns_rls_table,
        EXISTS(
          SELECT 1
          FROM pg_roles privileged_role
          WHERE pg_has_role(runtime_role_row.oid, privileged_role.oid, 'MEMBER')
            AND (
              privileged_role.rolsuper
              OR privileged_role.rolbypassrls
              OR EXISTS(
                SELECT 1
                FROM pg_class relation
                JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'public'
                  AND relation.relrowsecurity
                  AND relation.relowner = privileged_role.oid
              )
            )
        ) AS can_assume_privileged_role
      FROM pg_roles AS runtime_role_row
      WHERE runtime_role_row.rolname = current_user
    `);
    const role = result.rows[0];
    if (!role || role.current_user !== this.options.runtimeRole || role.rolsuper || role.rolbypassrls || role.owns_rls_table || role.can_assume_privileged_role) {
      throw new WorkspaceServerError("postgres_runtime_role_must_be_non_owner_non_bypassrls", 500);
    }
  }
}

/**
 * This class is for a short-lived migration/maintenance command only.  It is
 * not exported through any HTTP Server core and therefore cannot be reached
 * from a request handler.
 */
export class PostgresWorkspaceAdminDatabase {
  private readonly adminPool: Pool;

  constructor(private readonly options: PostgresWorkspaceAdminDatabaseOptions) {
    this.adminPool = new Pool({ connectionString: options.databaseAdminUrl, max: 2 });
  }

  async migrate(): Promise<void> {
    await applyWorkspaceServerMigrations(this.adminPool, this.options.runtimeRole);
    await this.assertRuntimeRoleDefinition();
  }

  async close(): Promise<void> {
    await this.adminPool.end();
  }

  async withAdmin<T>(action: (sql: WorkspaceSql) => Promise<T>): Promise<T> {
    const client = await this.adminPool.connect();
    try {
      await client.query("SET search_path TO public");
      return await action(client);
    } finally {
      client.release();
    }
  }

  private async assertRuntimeRoleDefinition(): Promise<void> {
    const result = await this.adminPool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      owns_rls_table: boolean;
      can_assume_privileged_role: boolean;
    }>(`
      SELECT
        runtime_role_row.rolsuper,
        runtime_role_row.rolbypassrls,
        EXISTS(
          SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relrowsecurity
            AND relation.relowner = runtime_role_row.oid
        ) AS owns_rls_table,
        EXISTS(
          SELECT 1
          FROM pg_roles privileged_role
          WHERE pg_has_role(runtime_role_row.oid, privileged_role.oid, 'MEMBER')
            AND (
              privileged_role.rolsuper
              OR privileged_role.rolbypassrls
              OR EXISTS(
                SELECT 1
                FROM pg_class relation
                JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'public'
                  AND relation.relrowsecurity
                  AND relation.relowner = privileged_role.oid
              )
            )
        ) AS can_assume_privileged_role
      FROM pg_roles AS runtime_role_row
      WHERE runtime_role_row.rolname = $1
    `, [this.options.runtimeRole]);
    const role = result.rows[0];
    if (!role || role.rolsuper || role.rolbypassrls || role.owns_rls_table || role.can_assume_privileged_role) {
      throw new WorkspaceServerError("postgres_runtime_role_must_be_non_owner_non_bypassrls", 500);
    }
  }
}

async function setTenantContext(client: PoolClient, context: WorkspaceDatabaseContext): Promise<void> {
  const caller = isTrustedWorkspaceCallerForAccount(context.caller, context.accountId) ? context.caller : undefined;
  await client.query("SELECT set_config('samurai.account_id', $1, true)", [context.accountId]);
  await client.query("SELECT set_config('samurai.workspace_id', $1, true)", [context.workspaceId ?? ""]);
  await client.query("SELECT set_config('samurai.external_integration', $1, true)", [context.externalIntegration ? "1" : ""]);
  await client.query("SELECT set_config('samurai.bootstrap', $1, true)", [context.bootstrap ? "1" : ""]);
  await client.query("SELECT set_config('samurai.import_id', $1, true)", [context.importId ?? ""]);
  await client.query("SELECT set_config('samurai.caller_kind', $1, true)", [caller?.kind ?? ""]);
  await client.query("SELECT set_config('samurai.caller_principal_id', $1, true)", [caller?.principalAccountId ?? ""]);
  await client.query("SELECT set_config('samurai.caller_connection_id', $1, true)", [caller?.kind === "connection" ? caller.connectionId : ""]);
  await client.query("SELECT set_config('samurai.caller_request_id', $1, true)", [caller?.kind === "human" || caller?.kind === "connection" ? caller.requestId : ""]);
  await client.query("SELECT set_config('samurai.caller_operation_id', $1, true)", [caller?.operationId ?? ""]);
  await client.query("SELECT set_config('samurai.completion_migration_run_id', $1, true)", [context.migrationRunId ?? ""]);
  await client.query("SELECT set_config('samurai.completion_migration_operation', $1, true)", [context.migrationOperation ?? ""]);
  await client.query("SELECT set_config('samurai.worker', $1, true)", [context.worker ? "1" : ""]);
}
