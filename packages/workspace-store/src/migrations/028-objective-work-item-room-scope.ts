import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Preserve the Room boundary for durable Objectives and Work Items. Legacy
 * rows stay unbound and are rejected by Room-scoped mutations. */
export const objectiveWorkItemRoomScopeMigration: WorkspaceMigration = {
  version: 28,
  name: "objective_work_item_room_scope",
  steps: [
    {
      kind: "add_column_if_missing",
      table: "objectives",
      column: "room_id",
      statement: "ALTER TABLE objectives ADD COLUMN room_id TEXT"
    },
    {
      kind: "add_column_if_missing",
      table: "work_items",
      column: "room_id",
      statement: "ALTER TABLE work_items ADD COLUMN room_id TEXT"
    },
    {
      kind: "sql",
      statement: "CREATE INDEX IF NOT EXISTS idx_objectives_room_status_updated ON objectives(room_id, status, updated_at)"
    },
    {
      kind: "sql",
      statement: "CREATE INDEX IF NOT EXISTS idx_work_items_room_status_priority ON work_items(room_id, status, priority, created_at)"
    }
  ]
};
