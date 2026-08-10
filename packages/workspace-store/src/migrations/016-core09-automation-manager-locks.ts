import type { WorkspaceMigration } from "../kernel/migration-runner";

/**
 * Core09 correction: manager controls and a token-bound, crash-safe scheduler
 * claim. Existing started runs are never resumed ambiguously after upgrade.
 */
export const core09AutomationManagerLocksMigration: WorkspaceMigration = {
  version: 16,
  name: "core09_automation_manager_locks",
  steps: [
    {
      kind: "add_column_if_missing",
      table: "automation_jobs",
      column: "management_state",
      statement: "ALTER TABLE automation_jobs ADD COLUMN management_state TEXT NOT NULL DEFAULT 'allowed' CHECK(management_state IN ('allowed', 'manager_stopped'))"
    },
    {
      kind: "add_column_if_missing",
      table: "automation_jobs",
      column: "management_operation_id",
      statement: "ALTER TABLE automation_jobs ADD COLUMN management_operation_id TEXT"
    },
    {
      kind: "add_column_if_missing",
      table: "automation_jobs",
      column: "lock_owner_token",
      statement: "ALTER TABLE automation_jobs ADD COLUMN lock_owner_token TEXT"
    },
    {
      kind: "add_column_if_missing",
      table: "automation_jobs",
      column: "rebound_operation_id",
      statement: "ALTER TABLE automation_jobs ADD COLUMN rebound_operation_id TEXT"
    },
    {
      kind: "sql",
      statement: `UPDATE automation_jobs
        SET failure_count = CASE WHEN failure_count < max_attempts THEN failure_count + 1 ELSE failure_count END,
            status = CASE
              WHEN management_state = 'manager_stopped' THEN 'disabled'
              WHEN failure_count + 1 < max_attempts THEN 'enabled'
              ELSE 'disabled'
            END,
            retry_after_at = NULL,
            locked_until = NULL,
            lock_owner_token = NULL,
            last_error = 'automation_execution_interrupted',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id IN (
          SELECT job_id FROM automation_runs WHERE status = 'started' AND job_id IS NOT NULL
        )`
    },
    {
      kind: "sql",
      statement: `UPDATE automation_runs
        SET status = 'failed',
            error_code = 'automation_execution_interrupted',
            error = COALESCE(error, 'automation_execution_interrupted'),
            completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            blocked_at = NULL
        WHERE status = 'started'`
    },
    {
      kind: "sql",
      statement: "UPDATE automation_jobs SET locked_until = NULL, lock_owner_token = NULL WHERE locked_until IS NOT NULL OR lock_owner_token IS NOT NULL"
    },
    {
      kind: "sql",
      statement: "CREATE UNIQUE INDEX idx_automation_runs_one_started_per_job ON automation_runs(job_id) WHERE job_id IS NOT NULL AND status = 'started'"
    }
  ]
};
