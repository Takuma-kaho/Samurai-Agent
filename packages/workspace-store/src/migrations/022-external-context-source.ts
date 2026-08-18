import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Human-owned Workspace/Room context for external-session startup snapshots.
 * This is content metadata in the Workspace DB, not Connector operational
 * state, and it deliberately leaves existing labels/goals empty rather than
 * fabricating values during migration. */
export const externalContextSourceMigration: WorkspaceMigration = {
  version: 22,
  name: "external_context_source",
  steps: [
    { kind: "sql", statement: "ALTER TABLE settings ADD COLUMN workspace_name TEXT" },
    { kind: "sql", statement: "ALTER TABLE settings ADD COLUMN workspace_rules_json TEXT NOT NULL DEFAULT '[]'" },
    {
      kind: "sql",
      statement: `CREATE TABLE room_context_metadata (
        room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE RESTRICT,
        purpose TEXT,
        work_goal TEXT,
        updated_at TEXT NOT NULL
      )`
    }
  ]
};
