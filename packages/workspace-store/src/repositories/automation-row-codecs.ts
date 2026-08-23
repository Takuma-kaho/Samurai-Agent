import { AutomationJobRecordSchema, type AutomationJobRecord } from "@samurai-agent/core-schemas";
import type { AutomationJobsTable } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

export function automationJobToRow(job: AutomationJobRecord): AutomationJobsTable {
  const record = AutomationJobRecordSchema.parse(job);
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    status: record.status,
    schedule: record.schedule,
    target_instruction: record.target_instruction,
    delivery_target_json: stringify(record.delivery_target),
    workspace_id: record.workspace_id ?? null,
    room_id: record.room_id ?? null,
    authority_kind: record.authority?.kind ?? null,
    authority_ref_json: record.authority ? stringify(record.authority) : null,
    created_principal_snapshot_json: record.created_principal_snapshot ? stringify(record.created_principal_snapshot) : null,
    source_snapshot_json: record.source_snapshot ? stringify(record.source_snapshot) : null,
    connection_id: record.connection_id ?? null,
    session_ref_json: record.session_ref ? stringify(record.session_ref) : null,
    authorization_state: record.authorization_state,
    authorization_error_code: record.authorization_error_code ?? null,
    authorized_at: record.authorized_at ?? null,
    blocked_at: record.blocked_at ?? null,
    rebound_at: record.rebound_at ?? null,
    management_state: record.management_state,
    management_operation_id: record.management_operation_id ?? null,
    created_operation_id: record.created_operation_id ?? null,
    rebound_operation_id: record.rebound_operation_id ?? null,
    file_transaction_id: null,
    next_run_at: record.next_run_at ?? null,
    last_run_at: record.last_run_at ?? null,
    retry_after_at: record.retry_after_at ?? null,
    locked_until: record.locked_until ?? null,
    lock_owner_token: record.lock_owner_token ?? null,
    failure_count: record.failure_count ?? 0,
    max_attempts: record.max_attempts ?? 3,
    last_error: record.last_error ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export function automationJobFromRow(row: AutomationJobsTable): AutomationJobRecord {
  const authority = automationAuthorityFromRow(row.authority_ref_json, row.authority_kind);
  return AutomationJobRecordSchema.parse({
    id: row.id,
    title: row.title,
    kind: row.kind as AutomationJobRecord["kind"],
    status: row.status as AutomationJobRecord["status"],
    schedule: row.schedule,
    target_instruction: row.target_instruction,
    delivery_target: parse(row.delivery_target_json),
    ...(row.workspace_id ? { workspace_id: row.workspace_id } : {}),
    ...(row.room_id ? { room_id: row.room_id } : {}),
    ...(authority ? { authority } : {}),
    ...(row.created_principal_snapshot_json ? { created_principal_snapshot: parse(row.created_principal_snapshot_json) } : {}),
    ...(row.source_snapshot_json ? { source_snapshot: parse(row.source_snapshot_json) } : {}),
    ...(row.connection_id ? { connection_id: row.connection_id } : {}),
    ...(row.session_ref_json ? { session_ref: parse(row.session_ref_json) } : {}),
    authorization_state: row.authorization_state ?? "rebind_required",
    ...(row.authorization_error_code ? { authorization_error_code: row.authorization_error_code } : {}),
    ...(row.authorized_at ? { authorized_at: row.authorized_at } : {}),
    ...(row.blocked_at ? { blocked_at: row.blocked_at } : {}),
    ...(row.rebound_at ? { rebound_at: row.rebound_at } : {}),
    management_state: row.management_state ?? "allowed",
    ...(row.management_operation_id ? { management_operation_id: row.management_operation_id } : {}),
    ...(row.created_operation_id ? { created_operation_id: row.created_operation_id } : {}),
    ...(row.rebound_operation_id ? { rebound_operation_id: row.rebound_operation_id } : {}),
    next_run_at: row.next_run_at ?? undefined,
    last_run_at: row.last_run_at ?? undefined,
    retry_after_at: row.retry_after_at ?? undefined,
    locked_until: row.locked_until ?? undefined,
    lock_owner_token: row.lock_owner_token ?? undefined,
    failure_count: row.failure_count,
    max_attempts: row.max_attempts,
    last_error: row.last_error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function automationAuthorityFromRow(
  authorityJson: AutomationJobsTable["authority_ref_json"],
  authorityKind: AutomationJobsTable["authority_kind"]
): AutomationJobRecord["authority"] {
  if (!authorityJson) {
    if (authorityKind) throw new Error("automation_job_authority_row_mismatch");
    return undefined;
  }
  const authority = parse(authorityJson) as { kind?: unknown };
  if (!authorityKind || authority.kind !== authorityKind) throw new Error("automation_job_authority_row_mismatch");
  return authority as NonNullable<AutomationJobRecord["authority"]>;
}
