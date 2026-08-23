import type { WorkspaceMigration } from "../kernel/migration-runner";

/**
 * A trigger job is durable in the same SQLite commit as its Collection write,
 * but workers must wait until the corresponding file transaction is settled.
 */
export const collectionTriggerFileTransactionMigration: WorkspaceMigration = {
  version: 30,
  name: "collection_trigger_file_transaction",
  steps: [
    {
      kind: "add_column_if_missing",
      table: "automation_jobs",
      column: "file_transaction_id",
      statement: "ALTER TABLE automation_jobs ADD COLUMN file_transaction_id TEXT"
    },
    {
      kind: "sql",
      statement: "CREATE INDEX IF NOT EXISTS idx_automation_jobs_file_transaction ON automation_jobs(file_transaction_id)"
    }
  ]
};
