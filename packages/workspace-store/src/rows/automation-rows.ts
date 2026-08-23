import type { JsonColumn } from "./json-column";

export interface AutomationRunsTable {
  id: string; kind: string; source: string; session_id: string | null; backend_run_id: string | null; status: string; operation_id: string | null;
  job_id: string | null; workspace_id: string | null; room_id: string | null; authority_kind: string | null; authority_ref_json: JsonColumn | null;
  connector_id: string | null; app_id: string | null; activity_id: string | null; session_ref_json: JsonColumn | null; error_code: string | null;
  started_at: string; completed_at: string | null; blocked_at: string | null; error: string | null;
}
export interface AutomationJobsTable {
  id: string; title: string; kind: string; status: string; schedule: string; target_instruction: string; delivery_target_json: JsonColumn;
  workspace_id: string | null; room_id: string | null; authority_kind: string | null; authority_ref_json: JsonColumn | null;
  created_principal_snapshot_json: JsonColumn | null; source_snapshot_json: JsonColumn | null; connection_id: string | null; session_ref_json: JsonColumn | null;
  authorization_state: string; authorization_error_code: string | null; authorized_at: string | null; blocked_at: string | null; rebound_at: string | null;
  management_state: string; management_operation_id: string | null; created_operation_id: string | null; rebound_operation_id: string | null;
  /** A Collection trigger is invisible to workers until this file journal is settled. */
  file_transaction_id: string | null;
  next_run_at: string | null; last_run_at: string | null; retry_after_at: string | null; locked_until: string | null; lock_owner_token: string | null; failure_count: number; max_attempts: number; last_error: string | null; created_at: string; updated_at: string;
}
