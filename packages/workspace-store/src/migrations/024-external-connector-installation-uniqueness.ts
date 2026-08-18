import type { WorkspaceMigration } from "../kernel/migration-runner";

/** A Workspace may have installation history, but only one enabled version of
 * a Connector can be active at a time.  Install/upgrade uses CAS and this
 * index closes the remaining first-install race across processes. */
export const externalConnectorInstallationUniquenessMigration: WorkspaceMigration = {
  version: 24,
  name: "external_connector_installation_uniqueness",
  steps: [
    {
      kind: "sql",
      statement: `UPDATE external_integration_records
        SET payload_json = json_set(
          payload_json,
          '$.enabled', 0,
          '$.disabled_at', COALESCE(json_extract(payload_json, '$.disabled_at'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE record_type = 'connector_installation'
          AND json_extract(payload_json, '$.enabled') = 1
          AND record_id NOT IN (
            SELECT record_id FROM (
              SELECT record_id,
                row_number() OVER (
                  PARTITION BY workspace_id, connector_id
                  ORDER BY updated_at DESC, record_id DESC
                ) AS installation_rank
              FROM external_integration_records
              WHERE record_type = 'connector_installation'
                AND json_extract(payload_json, '$.enabled') = 1
            ) ranked
            WHERE installation_rank = 1
          )`
    },
    {
      kind: "sql",
      statement: "CREATE UNIQUE INDEX idx_external_connector_active_installation ON external_integration_records(workspace_id, connector_id) WHERE record_type = 'connector_installation' AND json_extract(payload_json, '$.enabled') = 1"
    }
  ]
};
