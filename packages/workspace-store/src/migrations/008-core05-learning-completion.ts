import type { WorkspaceMigration, WorkspaceMigrationStep } from "../kernel/migration-runner";

const addColumn = (table: string, column: string, definition: string): WorkspaceMigrationStep => ({
  kind: "add_column_if_missing",
  table,
  column,
  statement: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
});

/**
 * Core 05 completion data.  It intentionally adds no backfill: legacy resources
 * keep their existing shape until a new version is explicitly created.
 */
export const core05LearningCompletionMigration: WorkspaceMigration = {
  version: 8,
  name: "core05_learning_completion",
  steps: [
    addColumn("settings", "learning_enabled", "INTEGER NOT NULL DEFAULT 1"),
    addColumn("settings", "learning_budget_ratio", "REAL NOT NULL DEFAULT 0.1"),
    addColumn("settings", "learning_budget_window_days", "INTEGER NOT NULL DEFAULT 7"),
    addColumn("learning_resource_uses", "usage_scope_json", "TEXT"),
    addColumn("learning_resource_uses", "decision_summary", "TEXT"),
    addColumn("learning_resource_uses", "matched_conditions_json", "TEXT"),
    addColumn("learning_evaluations", "evaluation_json", "TEXT"),
    addColumn("reflection_runs", "candidate_key", "TEXT"),
    addColumn("reflection_runs", "candidate_signals_json", "TEXT"),
    addColumn("reflection_runs", "deferred_reason", "TEXT"),
    addColumn("reflection_runs", "budget_unit", "TEXT"),
    addColumn("reflection_runs", "budget_estimate", "REAL"),
    {
      kind: "sql",
      statement: `CREATE TABLE IF NOT EXISTS learning_resource_versions (
        id TEXT PRIMARY KEY,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        version TEXT NOT NULL,
        parent_version TEXT,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        change_reason TEXT NOT NULL,
        source_run_ids_json TEXT NOT NULL,
        actor TEXT NOT NULL,
        is_current INTEGER NOT NULL,
        restored_from_version TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(resource_kind, resource_id, version)
      )`
    },
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_reflection_runs_candidate_key ON reflection_runs(candidate_key) WHERE candidate_key IS NOT NULL" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_reflection_runs_candidate_status ON reflection_runs(kind, status, room_id, started_at)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_learning_resource_uses_applied ON learning_resource_uses(run_id, stage, resource_id)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_learning_resource_versions_current ON learning_resource_versions(resource_kind, resource_id, is_current, created_at DESC)" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_resource_versions_one_current ON learning_resource_versions(resource_kind, resource_id) WHERE is_current = 1" }
  ]
};
