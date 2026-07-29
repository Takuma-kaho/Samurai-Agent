import type { WorkspaceMigration } from "../kernel/migration-runner";

export const gatewayPairingPolicyAllowedToolsMigration: WorkspaceMigration = {
  version: 5,
  name: "gateway_pairing_policy_allowed_tools",
  steps: [{ kind: "add_column_if_missing", table: "gateway_pairing_policies", column: "allowed_tools_json", statement: "ALTER TABLE gateway_pairing_policies ADD COLUMN allowed_tools_json TEXT NOT NULL DEFAULT '[]'" }]
};
