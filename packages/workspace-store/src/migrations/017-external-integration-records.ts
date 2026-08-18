import type { WorkspaceMigration } from "../kernel/migration-runner";

export const externalIntegrationRecordsMigration: WorkspaceMigration = {
  version: 17,
  name: "external_integration_records",
  steps: [
    {
      kind: "sql",
      statement: `CREATE TABLE external_integration_records (
        record_type TEXT NOT NULL CHECK(record_type IN (
          'oauth_client', 'oauth_authorization_request', 'oauth_authorization_code', 'oauth_grant',
          'room_binding', 'external_session', 'context_snapshot', 'approval_request', 'capture_policy',
          'raw_external_record', 'connector_manifest', 'connector_installation', 'activity_event'
        )),
        record_id TEXT NOT NULL,
        workspace_id TEXT,
        connection_id TEXT,
        connector_id TEXT,
        account_id TEXT,
        project_ref TEXT,
        external_session_id TEXT,
        payload_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(record_type, record_id)
      )`
    },
    { kind: "sql", statement: "CREATE INDEX idx_external_integration_workspace ON external_integration_records(workspace_id, record_type, updated_at DESC)" },
    { kind: "sql", statement: "CREATE INDEX idx_external_integration_connection ON external_integration_records(connection_id, record_type, updated_at DESC)" },
    { kind: "sql", statement: "CREATE INDEX idx_external_integration_connector ON external_integration_records(connector_id, record_type, updated_at DESC)" },
    { kind: "sql", statement: "CREATE INDEX idx_external_integration_account ON external_integration_records(account_id, record_type, updated_at DESC)" },
    { kind: "sql", statement: "CREATE INDEX idx_external_integration_project ON external_integration_records(workspace_id, connection_id, account_id, project_ref, updated_at DESC)" },
    { kind: "sql", statement: "CREATE INDEX idx_external_integration_session ON external_integration_records(workspace_id, connection_id, external_session_id, updated_at DESC)" }
  ]
};
