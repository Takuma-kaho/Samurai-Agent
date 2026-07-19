/**
 * Gateway tool permission is an owner policy field. Existing pairing policies
 * retain their historical default-deny behavior until an owner explicitly
 * saves an allowlist.
 */
export const gatewayPairingPolicyAllowedToolsMigration = {
  version: 5,
  name: "gateway_pairing_policy_allowed_tools",
  statements: [
    "ALTER TABLE gateway_pairing_policies ADD COLUMN allowed_tools_json TEXT NOT NULL DEFAULT '[]'"
  ]
} as const;
