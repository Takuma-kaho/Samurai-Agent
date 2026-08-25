import { describe, expect, it } from "vitest";
import { inspectPostgresOperatorHealth } from "./operator-health";
import { workspaceServerMigrationStatus } from "./schema";

describe("PostgreSQL operator health", () => {
  it("checks migration parity, RLS, recovery state, runtime state and gateway state", async () => {
    const migrations = workspaceServerMigrationStatus();
    const report = await inspectPostgresOperatorHealth(new FakeSql({ migrations }));

    expect(report.storage).toBe("postgresql");
    expect(report.ok).toBe(true);
    expect(report.schema).toMatchObject({
      expected_migrations: migrations.length,
      applied_migrations: migrations.length,
      migration_ok: true,
      rls_tables: 78,
      unprotected_workspace_tables: 0
    });
    expect(report.workspace).toMatchObject({ workspaces: 2, members: 3, files: 4, pending_file_transactions: 0 });
    expect(report.runtime).toMatchObject({ active_operations: 0, unresolved_operations: 0 });
    expect(report.gateway).toMatchObject({ pairings: { approved: 1 }, inbound: { delivered: 2 }, active_locks: 1 });
  });

  it("fails closed when PostgreSQL has stale migrations or unresolved work", async () => {
    const report = await inspectPostgresOperatorHealth(new FakeSql({
      migrations: workspaceServerMigrationStatus().slice(0, -1),
      rls: { rls_tables: 2, unprotected_workspace_tables: 1 },
      pendingFileTransactions: 1,
      unresolvedOperations: 2
    }));

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "schema_migration_mismatch",
      "workspace_rls_missing",
      "file_transaction_pending",
      "runtime_operation_unresolved"
    ]));
  });
});

class FakeSql {
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
