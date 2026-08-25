import { workspaceServerMigrationStatus } from "./schema";
import type { WorkspaceSql } from "./postgres";

export interface OperatorHealthIssue {
  code: string;
  message: string;
}

export interface OperatorHealthReport {
  ok: boolean;
  storage: "postgresql";
  schema: {
    expected_migrations: number;
    applied_migrations: number;
    migration_ok: boolean;
    rls_tables: number;
    unprotected_workspace_tables: number;
  };
  workspace: {
    workspaces: number;
    members: number;
    files: number;
    pending_file_transactions: number;
  };
  runtime: {
    recent_runs: Array<{ id: string; status: string; backend_id: string }>;
    active_operations: number;
    unresolved_operations: number;
  };
  learning: {
    activities: number;
    resources: number;
    queued_jobs: number;
  };
  gateway: {
    pairings: Record<string, number>;
    inbound: Record<string, number>;
    active_locks: number;
  };
  issues: OperatorHealthIssue[];
}

/**
 * Read-only operator diagnostics for the PostgreSQL deployment.
 *
 * This function deliberately accepts a narrow SQL port so it can be used by
 * the short-lived admin command and tested without a database. It never
 * repairs, mutates, or bypasses Workspace RLS through the runtime process.
 */
export async function inspectPostgresOperatorHealth(sql: WorkspaceSql, now = new Date()): Promise<OperatorHealthReport> {
  const issues: OperatorHealthIssue[] = [];
  const [migrations, rls, workspaces, members, files, fileTransactions, runs, operations, learningActivities, learningResources, learningJobs, pairings, inbound, locks] = await Promise.all([
    sql.query<{ version: number; name: string; checksum: string }>("SELECT version, name, checksum FROM samurai_server_schema_migrations ORDER BY version"),
    sql.query<{ rls_tables: number; unprotected_workspace_tables: number }>(`
      SELECT
        COUNT(*) FILTER (WHERE relrowsecurity)::int AS rls_tables,
        COUNT(*) FILTER (WHERE NOT relrowsecurity)::int AS unprotected_workspace_tables
      FROM pg_class
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_namespace.nspname = 'public'
        AND pg_class.relkind = 'r'
        AND pg_class.relname LIKE 'workspace_%'
    `),
    sql.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workspaces"),
    sql.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workspace_members"),
    sql.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workspace_files"),
    sql.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workspace_file_transactions WHERE status NOT IN ('committed', 'rolled_back')"),
    sql.query<{ id: string; status: string; backend_id: string }>("SELECT id, status, backend_id FROM workspace_runtime_runs ORDER BY started_at DESC LIMIT 3"),
    sql.query<{ active: number; unresolved: number }>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'running')::int AS active,
        COUNT(*) FILTER (WHERE status IN ('running', 'in_progress'))::int AS unresolved
      FROM workspace_runtime_operations
    `),
    sql.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workspace_learning_activities"),
    sql.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workspace_learning_resources"),
    sql.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workspace_learning_jobs WHERE status IN ('queued', 'running')"),
    sql.query<{ status: string; count: number }>("SELECT status, COUNT(*)::int AS count FROM workspace_gateway_pairings GROUP BY status ORDER BY status"),
    sql.query<{ status: string; count: number }>("SELECT status, COUNT(*)::int AS count FROM workspace_gateway_inbound_messages GROUP BY status ORDER BY status"),
    sql.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workspace_gateway_concurrency_locks WHERE status = 'acquired' AND expires_at > $1", [now.toISOString()])
  ]);

  const expected = workspaceServerMigrationStatus();
  const applied = migrations.rows;
  const migrationOk = applied.length === expected.length && expected.every((migration, index) => {
    const current = applied[index];
    if (!current) return false;
    return Number(current.version) === migration.version
      && current.name === migration.name
      && current.checksum === migration.checksum;
  });
  const rlsRow = rls.rows[0] ?? { rls_tables: 0, unprotected_workspace_tables: 0 };
  const schema = {
    expected_migrations: expected.length,
    applied_migrations: applied.length,
    migration_ok: migrationOk,
    rls_tables: Number(rlsRow.rls_tables ?? 0),
    unprotected_workspace_tables: Number(rlsRow.unprotected_workspace_tables ?? 0)
  };
  const workspace = {
    workspaces: count(workspaces.rows[0]),
    members: count(members.rows[0]),
    files: count(files.rows[0]),
    pending_file_transactions: count(fileTransactions.rows[0])
  };
  const runtime = {
    recent_runs: runs.rows.map((row) => ({ id: row.id, status: row.status, backend_id: row.backend_id })),
    active_operations: Number(operations.rows[0]?.active ?? 0),
    unresolved_operations: Number(operations.rows[0]?.unresolved ?? 0)
  };
  const learning = {
    activities: count(learningActivities.rows[0]),
    resources: count(learningResources.rows[0]),
    queued_jobs: count(learningJobs.rows[0])
  };
  const gateway = {
    pairings: groupedCounts(pairings.rows),
    inbound: groupedCounts(inbound.rows),
    active_locks: count(locks.rows[0])
  };

  if (!migrationOk) issues.push({ code: "schema_migration_mismatch", message: "PostgreSQL schema migration is incomplete or altered" });
  if (schema.unprotected_workspace_tables > 0) issues.push({ code: "workspace_rls_missing", message: `${schema.unprotected_workspace_tables} workspace table(s) lack row-level security` });
  if (workspace.pending_file_transactions > 0) issues.push({ code: "file_transaction_pending", message: `${workspace.pending_file_transactions} file transaction(s) need recovery` });
  if (runtime.unresolved_operations > 0) issues.push({ code: "runtime_operation_unresolved", message: `${runtime.unresolved_operations} runtime operation(s) remain active or unresolved` });

  return { ok: issues.length === 0, storage: "postgresql", schema, workspace, runtime, learning, gateway, issues };
}

function count(row: { count?: number } | undefined): number {
  return Number(row?.count ?? 0);
}

function groupedCounts(rows: readonly { status: string; count: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}
