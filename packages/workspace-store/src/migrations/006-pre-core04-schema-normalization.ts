import type { WorkspaceMigration, WorkspaceMigrationStep } from "../kernel/migration-runner";

const addColumn = (table: string, column: string, definition: string): WorkspaceMigrationStep => ({
  kind: "add_column_if_missing",
  table,
  column,
  statement: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
});

export const preCore04SchemaNormalizationMigration: WorkspaceMigration = {
  version: 6,
  name: "pre_core04_schema_normalization",
  steps: [
    {
      kind: "sql",
      statement: "CREATE TEMP TABLE workspace_v6_settings_column_state AS SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('settings') WHERE name = 'knowledge_wiki_capture_mode') THEN 0 ELSE 1 END AS copy_legacy"
    },
    addColumn("settings", "memory_capture_mode", "TEXT NOT NULL DEFAULT 'auto'"),
    addColumn("settings", "knowledge_wiki_capture_mode", "TEXT NOT NULL DEFAULT 'auto'"),
    addColumn("settings", "skill_capture_mode", "TEXT NOT NULL DEFAULT 'auto'"),
    addColumn("settings", "external_provider_role", "TEXT NOT NULL DEFAULT 'assistive'"),
    addColumn("settings", "default_backend_id", "TEXT"),
    { kind: "sql_if_column_exists", table: "settings", column: "llm_wiki_capture_mode", statement: "UPDATE settings SET knowledge_wiki_capture_mode = llm_wiki_capture_mode WHERE llm_wiki_capture_mode IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_v6_settings_column_state WHERE copy_legacy = 1)" },
    { kind: "sql", statement: "UPDATE settings SET memory_capture_mode = 'auto' WHERE memory_capture_mode = 'suggest'" },
    { kind: "sql", statement: "UPDATE settings SET knowledge_wiki_capture_mode = 'auto' WHERE knowledge_wiki_capture_mode = 'suggest'" },
    { kind: "sql", statement: "UPDATE settings SET skill_capture_mode = 'auto' WHERE skill_capture_mode = 'suggest'" },
    addColumn("automation_jobs", "retry_after_at", "TEXT"),
    addColumn("automation_jobs", "locked_until", "TEXT"),
    addColumn("automation_jobs", "failure_count", "INTEGER NOT NULL DEFAULT 0"),
    addColumn("automation_jobs", "max_attempts", "INTEGER NOT NULL DEFAULT 3"),
    addColumn("automation_jobs", "last_error", "TEXT"),
    addColumn("automation_runs", "backend_run_id", "TEXT"),
    addColumn("collection_records", "version", "INTEGER NOT NULL DEFAULT 1"),
    addColumn("domain_command_executions", "correlation_id", "TEXT"),
    { kind: "sql", statement: "UPDATE domain_command_executions SET correlation_id = id WHERE correlation_id IS NULL" },
    addColumn("domain_command_executions", "heartbeat_at", "TEXT"),
    { kind: "sql", statement: "UPDATE domain_command_executions SET heartbeat_at = updated_at WHERE heartbeat_at IS NULL" },
    addColumn("domain_command_executions", "phase", "TEXT NOT NULL DEFAULT 'external_running'"),
    { kind: "sql", statement: "UPDATE domain_command_executions SET status = 'outcome_unknown', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'running' AND phase = 'external_running' AND unixepoch(COALESCE(heartbeat_at, updated_at)) < unixepoch('now', '-5 minutes')" },
    addColumn("operations", "correlation_id", "TEXT"),
    addColumn("workspace_changes", "correlation_id", "TEXT"),
    addColumn("backend_runs", "phase", "TEXT"),
    addColumn("backend_runs", "backend_session_id", "TEXT"),
    addColumn("backend_runs", "current_attempt", "INTEGER"),
    addColumn("backend_runs", "request_idempotency_key", "TEXT"),
    addColumn("backend_runs", "request_hash", "TEXT"),
    addColumn("backend_events", "attempt_no", "INTEGER"),
    addColumn("backend_events", "backend_session_id", "TEXT"),
    addColumn("backend_events", "source_event_id", "TEXT"),
    addColumn("backend_events", "source_sequence", "INTEGER"),
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_runs_session_idempotency ON backend_runs(session_id, request_idempotency_key) WHERE request_idempotency_key IS NOT NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_events_source_identity ON backend_events(run_id, attempt_no, source_event_id) WHERE source_event_id IS NOT NULL" },
    { kind: "sql", statement: "DROP INDEX IF EXISTS idx_backend_events_source_sequence" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_backend_events_source_sequence ON backend_events(run_id, attempt_no, source_sequence) WHERE source_sequence IS NOT NULL AND source_event_id IS NULL" },
    { kind: "sql", statement: "UPDATE backend_runs SET phase = CASE WHEN status = 'queued' THEN 'admitted' WHEN status = 'waiting_for_backend_input' THEN 'waiting' WHEN status IN ('completed','failed','cancelled','outcome_unknown') THEN 'settled' ELSE NULL END WHERE phase IS NULL" },
    { kind: "sql", statement: "UPDATE backend_runs SET current_attempt = 1 WHERE current_attempt IS NULL" },
    addColumn("message_presentations", "surface_id", "TEXT"),
    addColumn("message_presentations", "revision_id", "TEXT"),
    addColumn("message_presentations", "preview_url", "TEXT"),
    { kind: "sql", statement: "UPDATE backend_runs SET backend_session_id = NULL WHERE status IN ('queued', 'running', 'waiting_for_backend_input') AND backend_session_id IS NOT NULL AND backend_session_id = backend_id || ':' || session_id" },
    { kind: "sql", statement: "DROP TABLE workspace_v6_settings_column_state" }
  ]
};
