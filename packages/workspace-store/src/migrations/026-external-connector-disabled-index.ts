import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Migration 024 protected only `enabled=1`.  A legacy record could still
 * carry `disabled_at` while retaining that flag, which made the durable
 * uniqueness rule stricter than the Connector Registry's active check and
 * could block an explicit re-enable/upgrade. Normalize that invalid state and
 * make the database predicate match the runtime definition of active. */
export const externalConnectorDisabledIndexMigration: WorkspaceMigration = {
  version: 26,
  name: "external_connector_disabled_index",
  steps: [
    {
      kind: "sql",
      statement: `UPDATE external_integration_records
        SET payload_json = json_set(payload_json, '$.enabled', 0),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE record_type = 'connector_installation'
          AND json_extract(payload_json, '$.enabled') = 1
          AND json_extract(payload_json, '$.disabled_at') IS NOT NULL`
    },
    { kind: "sql", statement: "DROP INDEX IF EXISTS idx_external_connector_active_installation" },
    {
      kind: "sql",
      statement: "CREATE UNIQUE INDEX idx_external_connector_active_installation ON external_integration_records(workspace_id, connector_id) WHERE record_type = 'connector_installation' AND json_extract(payload_json, '$.enabled') = 1 AND json_extract(payload_json, '$.disabled_at') IS NULL"
    }
  ]
};
