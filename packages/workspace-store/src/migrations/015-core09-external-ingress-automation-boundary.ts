import type { WorkspaceMigration } from "../kernel/migration-runner";

/**
 * Core09 persists only secret-free Connection metadata.  Existing automation
 * rows deliberately remain unbound: Room and authority must never be inferred
 * from an old delivery target or Session.
 */
export const core09ExternalIngressAutomationBoundaryMigration: WorkspaceMigration = {
  version: 15,
  name: "core09_external_ingress_automation_boundary",
  steps: [
    {
      kind: "sql",
      statement: `CREATE TABLE external_app_connections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
        delegated_principal_json TEXT NOT NULL,
        non_secret_metadata_json TEXT NOT NULL,
        created_by_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        CHECK((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
        UNIQUE(workspace_id, connector_id)
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE external_app_connection_rooms (
        connection_id TEXT NOT NULL REFERENCES external_app_connections(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
        PRIMARY KEY(connection_id, room_id)
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE external_app_connection_ingress_classes (
        connection_id TEXT NOT NULL REFERENCES external_app_connections(id) ON DELETE RESTRICT,
        ingress_class TEXT NOT NULL CHECK(ingress_class IN ('query', 'domain_operation', 'activity_ingest')),
        PRIMARY KEY(connection_id, ingress_class)
      )`
    },
    { kind: "sql", statement: "CREATE INDEX idx_external_app_connections_workspace_status ON external_app_connections(workspace_id, status)" },
    { kind: "sql", statement: "CREATE INDEX idx_external_app_connection_rooms_room ON external_app_connection_rooms(room_id, connection_id)" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN workspace_id TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN room_id TEXT REFERENCES rooms(id) ON DELETE RESTRICT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN authority_kind TEXT CHECK(authority_kind IN ('direct_principal', 'external_connection'))" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN authority_ref_json TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN created_principal_snapshot_json TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN source_snapshot_json TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN connection_id TEXT REFERENCES external_app_connections(id) ON DELETE RESTRICT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN session_ref_json TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN authorization_state TEXT NOT NULL DEFAULT 'rebind_required' CHECK(authorization_state IN ('ready', 'rebind_required', 'blocked'))" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN authorization_error_code TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN authorized_at TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN blocked_at TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN rebound_at TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_jobs ADD COLUMN created_operation_id TEXT" },
    { kind: "sql", statement: "UPDATE automation_jobs SET authorization_state = 'rebind_required', workspace_id = NULL, room_id = NULL, authority_kind = NULL, authority_ref_json = NULL, connection_id = NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_automation_jobs_authorization_due ON automation_jobs(authorization_state, status, next_run_at) WHERE authorization_state = 'ready'" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN job_id TEXT REFERENCES automation_jobs(id) ON DELETE RESTRICT" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN workspace_id TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN room_id TEXT REFERENCES rooms(id) ON DELETE RESTRICT" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN authority_kind TEXT CHECK(authority_kind IN ('direct_principal', 'external_connection'))" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN authority_ref_json TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN connector_id TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN app_id TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN activity_id TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN session_ref_json TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN error_code TEXT" },
    { kind: "sql", statement: "ALTER TABLE automation_runs ADD COLUMN blocked_at TEXT" },
    { kind: "sql", statement: "CREATE INDEX idx_automation_runs_job_started ON automation_runs(job_id, started_at DESC) WHERE job_id IS NOT NULL" }
  ]
};
