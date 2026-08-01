import type { WorkspaceMigration, WorkspaceMigrationStep } from "../kernel/migration-runner";

const addColumn = (table: string, column: string, definition: string): WorkspaceMigrationStep => ({
  kind: "add_column_if_missing",
  table,
  column,
  statement: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
});

/** Core 05 start-condition data only; existing content is not backfilled. */
export const core05RoomAgentFoundationMigration: WorkspaceMigration = {
  version: 7,
  name: "core05_room_agent_foundation",
  steps: [
    { kind: "sql", statement: "CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)" },
    { kind: "sql", statement: "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL, backend_id TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)" },
    addColumn("settings", "default_room_id", "TEXT"),
    addColumn("settings", "default_agent_id", "TEXT"),
    addColumn("sessions", "room_id", "TEXT"),
    addColumn("backend_runs", "agent_id", "TEXT"),
    addColumn("learning_resource_uses", "room_id", "TEXT"),
    addColumn("learning_resource_uses", "agent_id", "TEXT"),
    addColumn("background_review_changes", "room_id", "TEXT"),
    addColumn("background_review_changes", "agent_id", "TEXT"),
    addColumn("reflection_runs", "room_id", "TEXT"),
    addColumn("reflection_runs", "agent_id", "TEXT"),
    addColumn("memory_index", "usage_scope_kind", "TEXT"),
    addColumn("memory_index", "usage_scope_ref_id", "TEXT"),
    addColumn("wiki_index", "usage_scope_kind", "TEXT"),
    addColumn("wiki_index", "usage_scope_ref_id", "TEXT"),
    addColumn("skill_index", "usage_scope_kind", "TEXT"),
    addColumn("skill_index", "usage_scope_ref_id", "TEXT"),
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room_id)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_backend_runs_agent ON backend_runs(agent_id)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_agents_backend_enabled ON agents(backend_id, enabled)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_learning_resource_uses_activity ON learning_resource_uses(room_id, session_id, agent_id)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_background_review_changes_activity ON background_review_changes(room_id, source_session_id, agent_id)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_reflection_runs_activity ON reflection_runs(room_id, session_id, agent_id)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_memory_index_usage_scope ON memory_index(usage_scope_kind, usage_scope_ref_id)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_wiki_index_usage_scope ON wiki_index(usage_scope_kind, usage_scope_ref_id)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_skill_index_usage_scope ON skill_index(usage_scope_kind, usage_scope_ref_id)" }
  ]
};
