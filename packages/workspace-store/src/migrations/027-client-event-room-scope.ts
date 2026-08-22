import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Preserve the Room boundary when the legacy SQLite queue handles a newer event. */
export const clientEventRoomScopeMigration: WorkspaceMigration = {
  version: 27,
  name: "client_event_room_scope",
  steps: [
    {
      kind: "add_column_if_missing",
      table: "client_events",
      column: "room_id",
      statement: "ALTER TABLE client_events ADD COLUMN room_id TEXT"
    },
    {
      kind: "sql",
      statement: "CREATE INDEX IF NOT EXISTS idx_client_events_room_delivery ON client_events(room_id, status, created_at)"
    }
  ]
};
