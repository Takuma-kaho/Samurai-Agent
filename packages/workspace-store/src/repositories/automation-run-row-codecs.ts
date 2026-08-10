import { AutomationRunRecordSchema, type AutomationRunRecord } from "@samurai-agent/core-schemas";
import type { AutomationRunsTable } from "../kernel/workspace-db-schema";

export function automationRunToRow(run: AutomationRunRecord): AutomationRunsTable {
  const record = AutomationRunRecordSchema.parse(run);
  return {
    id: record.id,
    kind: record.kind,
    source: record.source,
    session_id: record.session_id ?? null,
    backend_run_id: record.backend_run_id ?? null,
    status: record.status,
    operation_id: record.operation_id ?? null,
    job_id: record.job_id ?? null,
    workspace_id: record.workspace_id ?? null,
    room_id: record.room_id ?? null,
    authority_kind: record.authority?.kind ?? null,
    authority_ref_json: record.authority ? JSON.stringify(record.authority) : null,
    connector_id: record.connector_id ?? null,
    app_id: record.app_id ?? null,
    activity_id: record.activity_id ?? null,
    session_ref_json: record.session_ref ? JSON.stringify(record.session_ref) : null,
    error_code: record.error_code ?? null,
    started_at: record.started_at,
    completed_at: record.completed_at ?? null,
    blocked_at: record.blocked_at ?? null,
    error: record.error ?? null
  };
}
export function automationRunFromRow(row: AutomationRunsTable): AutomationRunRecord {
  const authority = automationAuthorityFromRow(row.authority_ref_json, row.authority_kind);
  return AutomationRunRecordSchema.parse({
    id: row.id,
    kind: row.kind,
    source: row.source,
    session_id: row.session_id ?? undefined,
    backend_run_id: row.backend_run_id ?? undefined,
    status: row.status,
    operation_id: row.operation_id ?? undefined,
    ...(row.job_id ? { job_id: row.job_id } : {}),
    ...(row.workspace_id ? { workspace_id: row.workspace_id } : {}),
    ...(row.room_id ? { room_id: row.room_id } : {}),
    ...(authority ? { authority } : {}),
    ...(row.connector_id ? { connector_id: row.connector_id } : {}),
    ...(row.app_id ? { app_id: row.app_id } : {}),
    ...(row.activity_id ? { activity_id: row.activity_id } : {}),
    ...(row.session_ref_json ? { session_ref: JSON.parse(row.session_ref_json) } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    blocked_at: row.blocked_at ?? undefined,
    error: row.error ?? undefined
  });
}

function automationAuthorityFromRow(
  authorityJson: AutomationRunsTable["authority_ref_json"],
  authorityKind: AutomationRunsTable["authority_kind"]
): AutomationRunRecord["authority"] {
  if (!authorityJson) {
    if (authorityKind) throw new Error("automation_run_authority_row_mismatch");
    return undefined;
  }
  const authority = JSON.parse(authorityJson) as { kind?: unknown };
  if (!authorityKind || authority.kind !== authorityKind) throw new Error("automation_run_authority_row_mismatch");
  return authority as NonNullable<AutomationRunRecord["authority"]>;
}
