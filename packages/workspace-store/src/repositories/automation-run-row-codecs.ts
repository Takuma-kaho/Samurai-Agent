import type { AutomationRunRecord } from "../workspace-store-contracts";
import type { AutomationRunsTable } from "../kernel/workspace-db-schema";

export function automationRunToRow(run: AutomationRunRecord): AutomationRunsTable {
  return {
    id: run.id,
    kind: run.kind,
    source: run.source,
    session_id: run.session_id ?? null,
    backend_run_id: run.backend_run_id ?? null,
    status: run.status,
    operation_id: run.operation_id ?? null,
    started_at: run.started_at,
    completed_at: run.completed_at ?? null,
    error: run.error ?? null
  };
}
export function automationRunFromRow(row: AutomationRunsTable): AutomationRunRecord {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    session_id: row.session_id ?? undefined,
    backend_run_id: row.backend_run_id ?? undefined,
    status: row.status as AutomationRunRecord["status"],
    operation_id: row.operation_id ?? undefined,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    error: row.error ?? undefined
  };
}
