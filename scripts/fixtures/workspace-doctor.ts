import assert from "node:assert/strict";
import { inspectPostgresOperatorHealth } from "../../packages/workspace-server/src/operator-health";
import { workspaceServerMigrationStatus } from "../../packages/workspace-server/src/schema";

class FixtureSql {
  constructor(private readonly options: {
    migrations: readonly { version: number; name: string; checksum: string }[];
    rls?: { rls_tables: number; unprotected_workspace_tables: number };
    pendingFileTransactions?: number;
    unresolvedOperations?: number;
  }) {}

  async query<Row extends Record<string, unknown>>(text: string): Promise<{ rows: Row[] }> {
    if (text.includes("samurai_server_schema_migrations")) return { rows: this.options.migrations as Row[] };
    if (text.includes("relrowsecurity")) return { rows: [(this.options.rls ?? { rls_tables: 78, unprotected_workspace_tables: 0 }) as Row] };
    if (text.includes("FROM workspaces")) return { rows: [{ count: 2 } as Row] };
    if (text.includes("FROM workspace_members")) return { rows: [{ count: 3 } as Row] };
    if (text.includes("FROM workspace_files")) return { rows: [{ count: 4 } as Row] };
    if (text.includes("workspace_file_transactions")) return { rows: [{ count: this.options.pendingFileTransactions ?? 0 } as Row] };
    if (text.includes("workspace_runtime_runs")) return { rows: [{ id: "run-1", status: "completed", backend_id: "backend-1" } as Row] };
    if (text.includes("workspace_runtime_operations")) return { rows: [{ active: 0, unresolved: this.options.unresolvedOperations ?? 0 } as Row] };
    if (text.includes("workspace_learning_activities")) return { rows: [{ count: 1 } as Row] };
    if (text.includes("workspace_learning_resources")) return { rows: [{ count: 1 } as Row] };
    if (text.includes("workspace_learning_jobs")) return { rows: [{ count: 0 } as Row] };
    if (text.includes("workspace_gateway_pairings")) return { rows: [{ status: "approved", count: 1 } as Row] };
    if (text.includes("workspace_gateway_inbound_messages")) return { rows: [{ status: "delivered", count: 2 } as Row] };
    if (text.includes("workspace_gateway_concurrency_locks")) return { rows: [{ count: 1 } as Row] };
    throw new Error(`unexpected query: ${text}`);
  }
}

const migrations = workspaceServerMigrationStatus();
const healthy = await inspectPostgresOperatorHealth(new FixtureSql({ migrations }));
assert.equal(healthy.storage, "postgresql");
assert.equal(healthy.ok, true);
assert.equal(healthy.schema.migration_ok, true);
assert.equal(healthy.schema.unprotected_workspace_tables, 0);
assert.equal(healthy.workspace.pending_file_transactions, 0);
assert.equal(healthy.runtime.unresolved_operations, 0);

const unhealthy = await inspectPostgresOperatorHealth(new FixtureSql({
  migrations: migrations.slice(0, -1),
  rls: { rls_tables: 2, unprotected_workspace_tables: 1 },
  pendingFileTransactions: 1,
  unresolvedOperations: 1
}));
const detectedCodes = unhealthy.issues.map((issue) => issue.code).sort();
assert.deepEqual(detectedCodes, [
  "file_transaction_pending",
  "runtime_operation_unresolved",
  "schema_migration_mismatch",
  "workspace_rls_missing"
]);
assert.equal(unhealthy.ok, false);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  storage: healthy.storage,
  migration_count: healthy.schema.applied_migrations,
  required_detected: detectedCodes.length,
  detected_codes: detectedCodes,
  healthy_report_ok: healthy.ok,
  unhealthy_report_ok: unhealthy.ok
})}\n`);
