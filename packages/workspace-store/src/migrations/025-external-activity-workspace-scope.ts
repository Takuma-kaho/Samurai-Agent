import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Activity dedupe is scoped to the owning Workspace/Connection. The old
 * identity index was global to the SQLite file, so two Workspaces using the
 * same Connector session/event identifiers could collide. */
export const externalActivityWorkspaceScopeMigration: WorkspaceMigration = {
  version: 25,
  name: "external_activity_workspace_scope",
  steps: [
    { kind: "sql", statement: "DROP INDEX IF EXISTS idx_external_activity_identity" },
    {
      kind: "sql",
      statement: "CREATE UNIQUE INDEX idx_external_activity_identity_workspace ON external_integration_records(record_type, COALESCE(workspace_id, ''), json_extract(payload_json, '$.identity_key')) WHERE record_type = 'activity_event'"
    }
  ]
};
