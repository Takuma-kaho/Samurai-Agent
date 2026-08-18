import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Enforces the logical identities that are checked in the external
 * integration services.  The primary key protects generated record IDs, but
 * retries use Provider/idempotency fields and must be unique in the durable
 * store as well. */
export const externalIntegrationIdempotencyMigration: WorkspaceMigration = {
  version: 23,
  name: "external_integration_idempotency",
  steps: [
    {
      kind: "sql",
      statement: "CREATE UNIQUE INDEX idx_external_approval_idempotency ON external_integration_records(record_type, workspace_id, account_id, json_extract(payload_json, '$.idempotency_key')) WHERE record_type = 'approval_request'"
    },
    {
      kind: "sql",
      // Activity identity is owned by a Workspace.  A single SQLite file can
      // contain more than one Workspace, so a provider event/session pair in
      // Workspace A must not block the same provider event/session pair in
      // Workspace B. Migration 025 keeps the same scope while removing the
      // legacy index name for databases that already applied an earlier build.
      statement: "CREATE UNIQUE INDEX idx_external_activity_identity ON external_integration_records(record_type, COALESCE(workspace_id, ''), json_extract(payload_json, '$.identity_key')) WHERE record_type = 'activity_event'"
    }
  ]
};
