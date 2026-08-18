import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Migration 017/018 remain immutable. Capture quota is operational metadata,
 * so the byte reservation and encrypted-record write can share one database
 * transaction without treating captured text as Workspace content. */
export const externalIntegrationCaptureQuotaMigration: WorkspaceMigration = {
  version: 19,
  name: "external_integration_capture_quota",
  steps: [
    {
      kind: "sql",
      statement: `CREATE TABLE external_capture_quota_usage (
        workspace_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        used_bytes INTEGER NOT NULL CHECK(used_bytes >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, connection_id)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO external_capture_quota_usage (workspace_id, connection_id, used_bytes, updated_at)
        SELECT workspace_id, connection_id,
          COALESCE(SUM(CAST(json_extract(payload_json, '$.size_bytes') AS INTEGER)), 0),
          MAX(updated_at)
        FROM external_integration_records
        WHERE record_type = 'raw_external_record'
          AND workspace_id IS NOT NULL
          AND connection_id IS NOT NULL
        GROUP BY workspace_id, connection_id`
    },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_external_capture_policy_identity ON external_integration_records(workspace_id, connection_id, account_id) WHERE record_type = 'capture_policy'" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_external_oauth_code_hash ON external_integration_records(record_type, json_extract(payload_json, '$.code_hash')) WHERE record_type = 'oauth_authorization_code'" }
  ]
};
