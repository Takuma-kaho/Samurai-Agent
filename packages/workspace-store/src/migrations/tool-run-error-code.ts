/**
 * Tool failure codes are queryable runtime facts, not diagnostic text embedded
 * in a JSON column. Keep the nullable column separate so existing histories
 * migrate without inventing a code for records that predate this contract.
 */
export const toolRunErrorCodeMigration = {
  version: 4,
  name: "tool_run_error_code",
  statements: [
    "ALTER TABLE tool_runs ADD COLUMN error_code TEXT"
  ]
} as const;
