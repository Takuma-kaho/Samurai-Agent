import type { JsonColumn } from "./json-column";

/** Durable boundary records for OAuth, bindings, snapshots, approvals,
 * capture metadata, connector manifests/installations, and Activity dedupe. */
export interface ExternalIntegrationRecordsTable {
  record_type: string;
  record_id: string;
  workspace_id: string | null;
  connection_id: string | null;
  connector_id: string | null;
  account_id: string | null;
  project_ref: string | null;
  external_session_id: string | null;
  payload_json: JsonColumn;
  version: number;
  created_at: string;
  updated_at: string;
}

/** Atomic quota reservation for optional encrypted Capture. */
export interface ExternalCaptureQuotaUsageTable {
  workspace_id: string;
  connection_id: string;
  used_bytes: number;
  updated_at: string;
}
