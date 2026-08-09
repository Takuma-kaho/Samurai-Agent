import type { WorkspaceMigration } from "../kernel/migration-runner";

/**
 * Core 07 Activity History.
 *
 * These rows are durable Room-scoped work evidence. They deliberately do not
 * reuse the notification-only Activity Inbox or backend-event stream tables.
 */
export const core07ActivityHistoryMigration: WorkspaceMigration = {
  version: 12,
  name: "core07_activity_history",
  steps: [
    {
      kind: "sql",
      statement: `CREATE TABLE activity_records (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
        principal_json TEXT NOT NULL,
        principal_kind TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        source_json TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('recording', 'completed', 'failed', 'cancelled', 'outcome_unknown')),
        idempotency_key TEXT NOT NULL,
        instruction_summary TEXT NOT NULL,
        result_summary TEXT,
        verification_json TEXT NOT NULL,
        failure_json TEXT,
        correction_of_activity_id TEXT REFERENCES activity_records(id) ON DELETE RESTRICT,
        session_ref_json TEXT,
        backend_run_id TEXT,
        domain_operation_ids_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finalized_at TEXT,
        UNIQUE(workspace_id, idempotency_key),
        CHECK(
          (status = 'recording' AND finalized_at IS NULL AND result_summary IS NULL AND failure_json IS NULL)
          OR (status = 'completed' AND finalized_at IS NOT NULL AND result_summary IS NOT NULL)
          OR (status IN ('failed', 'cancelled', 'outcome_unknown') AND finalized_at IS NOT NULL AND failure_json IS NOT NULL)
        )
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE resource_usage_records (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE RESTRICT,
        workspace_job_attempt_id TEXT,
        resource_ref_json TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version TEXT,
        content_hash TEXT,
        usage_scope_json TEXT NOT NULL,
        stage TEXT NOT NULL CHECK(stage IN ('referenced', 'read', 'applied', 'modified', 'reverted')),
        domain_operation_id TEXT,
        workspace_change_id TEXT,
        created_at TEXT NOT NULL,
        CHECK(
          stage NOT IN ('modified', 'reverted')
          OR workspace_change_id IS NOT NULL
        )
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TRIGGER core07_activity_records_terminal_immutable
        BEFORE UPDATE ON activity_records
        WHEN OLD.status != 'recording'
        BEGIN
          SELECT RAISE(ABORT, 'activity_finalized_immutable');
        END`
    },
    {
      kind: "sql",
      statement: `CREATE TRIGGER core07_resource_usage_records_update_immutable
        BEFORE UPDATE ON resource_usage_records
        BEGIN
          SELECT RAISE(ABORT, 'resource_usage_immutable');
        END`
    },
    {
      kind: "sql",
      statement: `CREATE TRIGGER core07_resource_usage_records_delete_immutable
        BEFORE DELETE ON resource_usage_records
        BEGIN
          SELECT RAISE(ABORT, 'resource_usage_immutable');
        END`
    },
    { kind: "sql", statement: "CREATE INDEX idx_activity_records_room_time ON activity_records(room_id, created_at DESC)" },
    { kind: "sql", statement: "CREATE INDEX idx_activity_records_workspace_principal_time ON activity_records(workspace_id, principal_kind, principal_id, created_at DESC)" },
    { kind: "sql", statement: "CREATE INDEX idx_activity_records_workspace_source_time ON activity_records(workspace_id, source_kind, source_id, created_at DESC)" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_activity_records_backend_run_unique ON activity_records(backend_run_id) WHERE backend_run_id IS NOT NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_resource_usage_records_activity_time ON resource_usage_records(activity_id, created_at ASC)" },
    { kind: "sql", statement: "CREATE INDEX idx_resource_usage_records_resource ON resource_usage_records(resource_kind, resource_id, created_at DESC)" }
  ]
};
