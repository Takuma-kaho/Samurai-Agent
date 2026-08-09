import type { JsonColumn } from "./json-column";

export interface ActivityRecordsTable {
  id: string;
  workspace_id: string;
  room_id: string;
  principal_json: JsonColumn;
  principal_kind: string;
  principal_id: string;
  source_json: JsonColumn;
  source_kind: string;
  source_id: string | null;
  status: string;
  idempotency_key: string;
  instruction_summary: string;
  result_summary: string | null;
  verification_json: JsonColumn;
  failure_json: JsonColumn | null;
  correction_of_activity_id: string | null;
  session_ref_json: JsonColumn | null;
  backend_run_id: string | null;
  domain_operation_ids_json: JsonColumn;
  provenance_json: JsonColumn;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
}

export interface ResourceUsageRecordsTable {
  id: string;
  activity_id: string;
  workspace_job_attempt_id: string | null;
  resource_ref_json: JsonColumn;
  resource_kind: string;
  resource_id: string;
  resource_version: string | null;
  content_hash: string | null;
  usage_scope_json: JsonColumn;
  stage: string;
  domain_operation_id: string | null;
  workspace_change_id: string | null;
  created_at: string;
}

export interface WorkspaceJobsTable {
  id: string;
  workspace_id: string;
  room_id: string;
  root_activity_id: string;
  kind: string;
  processor_id: string;
  processor_version: string;
  idempotency_key: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  retryable: number;
  cancel_requested_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  retry_after_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkspaceJobAttemptsTable {
  id: string;
  workspace_job_id: string;
  attempt_no: number;
  activity_id: string;
  processor_id: string;
  processor_version: string;
  model_json: JsonColumn | null;
  prompt_or_policy_version: string | null;
  input_schema_version: string;
  output_schema_version: string | null;
  resource_versions_json: JsonColumn;
  input_hash: string | null;
  output_hash: string | null;
  output_json: JsonColumn | null;
  summary: string | null;
  diagnostics_json: JsonColumn;
  status: string;
  error_code: string | null;
  started_at: string;
  prepared_at: string | null;
  completed_at: string | null;
}
