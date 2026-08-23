import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Persist the claim boundary so an outbound side effect cannot be retried after recovery. */
export const externalSendDispatchSafetyMigration: WorkspaceMigration = {
  version: 29,
  name: "external_send_dispatch_safety",
  steps: [
    {
      kind: "add_column_if_missing",
      table: "external_sends",
      column: "dispatch_claim_token",
      statement: "ALTER TABLE external_sends ADD COLUMN dispatch_claim_token TEXT"
    },
    {
      kind: "add_column_if_missing",
      table: "external_sends",
      column: "dispatch_claimed_at",
      statement: "ALTER TABLE external_sends ADD COLUMN dispatch_claimed_at TEXT"
    },
    {
      kind: "add_column_if_missing",
      table: "external_sends",
      column: "dispatch_lease_until",
      statement: "ALTER TABLE external_sends ADD COLUMN dispatch_lease_until TEXT"
    }
  ]
};
