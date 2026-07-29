import type { WorkspaceMigration } from "../kernel/migration-runner";

export const toolRunErrorCodeMigration: WorkspaceMigration = {
  version: 4,
  name: "tool_run_error_code",
  steps: [{ kind: "add_column_if_missing", table: "tool_runs", column: "error_code", statement: "ALTER TABLE tool_runs ADD COLUMN error_code TEXT" }]
};
