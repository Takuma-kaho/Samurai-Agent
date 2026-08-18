import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Wiki and Skill frontmatter versions are semantic labels, not a reliable
 * integer CAS token.  Keep them intact and add a separate Store-owned version
 * for External Integration writes. */
export const externalIntegrationManagedResourceVersionsMigration: WorkspaceMigration = {
  version: 21,
  name: "external_integration_managed_resource_versions",
  steps: [
    {
      kind: "add_column_if_missing",
      table: "wiki_index",
      column: "resource_version",
      statement: "ALTER TABLE wiki_index ADD COLUMN resource_version INTEGER NOT NULL DEFAULT 1 CHECK(resource_version > 0)"
    },
    {
      kind: "add_column_if_missing",
      table: "skill_index",
      column: "resource_version",
      statement: "ALTER TABLE skill_index ADD COLUMN resource_version INTEGER NOT NULL DEFAULT 1 CHECK(resource_version > 0)"
    },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_wiki_index_resource_version ON wiki_index(id, resource_version)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_skill_index_resource_version ON skill_index(id, resource_version)" }
  ]
};
