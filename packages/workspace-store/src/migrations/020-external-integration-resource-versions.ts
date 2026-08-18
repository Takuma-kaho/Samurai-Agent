import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Keeps the existing user-facing Collection schema version untouched while
 * adding the integer CAS value used by External Integration writes. */
export const externalIntegrationResourceVersionsMigration: WorkspaceMigration = {
  version: 20,
  name: "external_integration_resource_versions",
  steps: [
    {
      kind: "add_column_if_missing",
      table: "collection_schemas",
      column: "resource_version",
      statement: "ALTER TABLE collection_schemas ADD COLUMN resource_version INTEGER NOT NULL DEFAULT 1 CHECK(resource_version > 0)"
    },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_collection_schemas_resource_version ON collection_schemas(id, resource_version)" }
  ]
};
