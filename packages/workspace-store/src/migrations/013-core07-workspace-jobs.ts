import type { WorkspaceMigration } from "../kernel/migration-runner";

/** Core 07's single durable, read-only Activity processing job type. */
export const core07WorkspaceJobsMigration: WorkspaceMigration = {
  version: 13,
  name: "core07_workspace_jobs",
  steps: [
    {
      kind: "sql",
      statement: `CREATE TABLE workspace_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
        root_activity_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind = 'activity_processing'),
        processor_id TEXT NOT NULL,
        processor_version TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
        retryable INTEGER NOT NULL CHECK(retryable IN (0, 1)),
        cancel_requested_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        retry_after_at TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(workspace_id, idempotency_key),
        CHECK(attempt_count <= max_attempts),
        CHECK(status != 'queued' OR attempt_count = 0 OR attempt_count < max_attempts),
        CHECK(
          (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)
          OR (status != 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
        ),
        CHECK(status NOT IN ('completed', 'failed', 'cancelled') OR completed_at IS NOT NULL)
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE workspace_job_attempts (
        id TEXT PRIMARY KEY,
        workspace_job_id TEXT NOT NULL REFERENCES workspace_jobs(id) ON DELETE RESTRICT,
        attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
        activity_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE RESTRICT,
        processor_id TEXT NOT NULL,
        processor_version TEXT NOT NULL,
        model_json TEXT,
        prompt_or_policy_version TEXT,
        input_schema_version TEXT NOT NULL,
        output_schema_version TEXT,
        resource_versions_json TEXT NOT NULL,
        input_hash TEXT,
        output_hash TEXT,
        output_json TEXT,
        summary TEXT,
        diagnostics_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        error_code TEXT,
        started_at TEXT NOT NULL,
        prepared_at TEXT,
        completed_at TEXT,
        UNIQUE(workspace_job_id, attempt_no),
        CHECK(
          (status = 'completed' AND prepared_at IS NOT NULL AND input_hash IS NOT NULL AND completed_at IS NOT NULL AND output_json IS NOT NULL AND output_hash IS NOT NULL AND summary IS NOT NULL AND output_schema_version IS NOT NULL)
          OR (status IN ('failed', 'cancelled') AND completed_at IS NOT NULL AND error_code IS NOT NULL)
          OR status = 'running'
        )
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TRIGGER core07_workspace_jobs_valid_transition
        BEFORE UPDATE OF status ON workspace_jobs
        WHEN NEW.status != OLD.status AND NOT (
          (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled'))
          OR (OLD.status = 'running' AND NEW.status IN ('queued', 'completed', 'failed', 'cancelled'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'workspace_job_invalid_transition');
        END`
    },
    {
      kind: "sql",
      statement: `CREATE TRIGGER core07_workspace_job_attempts_terminal_immutable
        BEFORE UPDATE ON workspace_job_attempts
        WHEN OLD.status != 'running'
        BEGIN
          SELECT RAISE(ABORT, 'workspace_job_attempt_immutable');
        END`
    },
    {
      kind: "sql",
      statement: `CREATE TRIGGER core07_resource_usage_requires_open_activity_or_attempt
        BEFORE INSERT ON resource_usage_records
        WHEN (SELECT status FROM activity_records WHERE id = NEW.activity_id) != 'recording'
          AND NEW.workspace_job_attempt_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'activity_finalized_immutable');
        END`
    },
    {
      kind: "sql",
      statement: `CREATE TRIGGER core07_resource_usage_attempt_matches_activity
        BEFORE INSERT ON resource_usage_records
        WHEN NEW.workspace_job_attempt_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM workspace_job_attempts
          WHERE id = NEW.workspace_job_attempt_id AND activity_id = NEW.activity_id AND status = 'running'
        )
        BEGIN
          SELECT RAISE(ABORT, 'resource_usage_workspace_job_attempt_scope_invalid');
        END`
    },
    { kind: "sql", statement: "CREATE INDEX idx_workspace_jobs_claim ON workspace_jobs(status, retry_after_at, created_at ASC)" },
    { kind: "sql", statement: "CREATE INDEX idx_workspace_jobs_room_time ON workspace_jobs(room_id, created_at DESC)" },
    { kind: "sql", statement: "CREATE INDEX idx_workspace_jobs_root_activity ON workspace_jobs(root_activity_id, created_at DESC)" },
    { kind: "sql", statement: "CREATE INDEX idx_workspace_jobs_expired_lease ON workspace_jobs(status, lease_expires_at) WHERE status = 'running'" },
    { kind: "sql", statement: "CREATE INDEX idx_workspace_job_attempts_job_attempt ON workspace_job_attempts(workspace_job_id, attempt_no ASC)" },
    { kind: "sql", statement: "CREATE INDEX idx_resource_usage_records_attempt ON resource_usage_records(workspace_job_attempt_id, created_at ASC) WHERE workspace_job_attempt_id IS NOT NULL" }
  ]
};
