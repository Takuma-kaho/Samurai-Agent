import type { WorkspaceMigration } from "../kernel/migration-runner";

/**
 * Core06 Session boundary. Existing rows are copied byte-for-byte into the
 * rebuilt execution tables; no Room is inferred from a legacy Session.
 * Session-bound Native App tables remain intact and are intentionally kept as
 * the compatibility surface.
 */
export const core06SessionReferenceBoundaryMigration: WorkspaceMigration = {
  version: 11,
  name: "core06_session_reference_boundary",
  steps: [
    {
      kind: "sql",
      statement: `CREATE TABLE operations_v11 (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        run_id TEXT,
        capability_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        actor_identity TEXT NOT NULL,
        participant_id TEXT,
        participant_kind TEXT,
        requested_by_participant_id TEXT,
        room_id TEXT,
        principal_json TEXT,
        source_json TEXT,
        session_ref_json TEXT,
        instruction_source TEXT NOT NULL,
        instruction_authority TEXT NOT NULL,
        channel TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_ref_json TEXT,
        target_resource_refs_json TEXT NOT NULL,
        proposed_effects_json TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_decision_id TEXT,
        approval_request_id TEXT,
        result_ref_json TEXT,
        error TEXT,
        correlation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO operations_v11(
        id, session_id, run_id, capability_id, operation, actor_identity, participant_id,
        participant_kind, requested_by_participant_id, room_id, principal_json,
        source_json, session_ref_json, instruction_source, instruction_authority,
        channel, input_hash, input_ref_json, target_resource_refs_json,
        proposed_effects_json, status, policy_decision_id, approval_request_id,
        result_ref_json, error, correlation_id, created_at, updated_at
      ) SELECT id, session_id, NULL, capability_id, operation, actor_identity,
        participant_id, participant_kind, requested_by_participant_id, room_id,
        NULL, NULL, NULL, instruction_source, instruction_authority, channel,
        input_hash, input_ref_json, target_resource_refs_json, proposed_effects_json,
        status, policy_decision_id, approval_request_id, result_ref_json, error,
        correlation_id, created_at, updated_at FROM operations`
    },
    { kind: "sql", statement: "DROP TABLE operations" },
    { kind: "sql", statement: "ALTER TABLE operations_v11 RENAME TO operations" },
    {
      kind: "sql",
      statement: `CREATE TABLE backend_runs_v11 (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        room_id TEXT,
        principal_json TEXT,
        source_json TEXT,
        session_ref_json TEXT,
        agent_id TEXT,
        requested_by_participant_id TEXT,
        input_message_id TEXT,
        output_message_id TEXT,
        backend_id TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        backend_session_id TEXT,
        status TEXT NOT NULL,
        phase TEXT,
        current_attempt INTEGER,
        request_idempotency_key TEXT,
        request_hash TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        input_summary TEXT NOT NULL,
        output_summary TEXT,
        error_code TEXT,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO backend_runs_v11(
        id, session_id, room_id, principal_json, source_json, session_ref_json,
        agent_id, requested_by_participant_id, input_message_id, output_message_id,
        backend_id, backend_kind, backend_session_id, status, phase, current_attempt,
        request_idempotency_key, request_hash, started_at, completed_at, input_summary,
        output_summary, error_code, metadata_json
      ) SELECT id, session_id, NULL, NULL, NULL, NULL, agent_id,
        requested_by_participant_id, input_message_id, output_message_id, backend_id,
        backend_kind, backend_session_id, status, phase, current_attempt,
        request_idempotency_key, request_hash, started_at, completed_at, input_summary,
        output_summary, error_code, metadata_json FROM backend_runs`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE learning_resource_uses_v11 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT,
        room_id TEXT,
        agent_id TEXT,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version TEXT,
        content_hash TEXT,
        usage_scope_json TEXT,
        stage TEXT NOT NULL,
        source_operation_id TEXT,
        decision_summary TEXT,
        matched_conditions_json TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, resource_kind, resource_id, stage, source_operation_id),
        FOREIGN KEY (run_id) REFERENCES backend_runs_v11(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO learning_resource_uses_v11(
        id, run_id, session_id, room_id, agent_id, resource_kind, resource_id,
        resource_version, content_hash, usage_scope_json, stage, source_operation_id,
        decision_summary, matched_conditions_json, metadata_json, created_at
      ) SELECT id, run_id, session_id, room_id, agent_id, resource_kind, resource_id,
        resource_version, content_hash, usage_scope_json, stage, source_operation_id,
        decision_summary, matched_conditions_json, metadata_json, created_at
        FROM learning_resource_uses`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE external_assist_records_v11 (
        id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT,
        input_message_id TEXT,
        query TEXT NOT NULL,
        role TEXT NOT NULL,
        hints_json TEXT NOT NULL,
        error TEXT,
        isolated_from_memory INTEGER NOT NULL,
        included_in_active_memory INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (run_id) REFERENCES backend_runs_v11(id),
        FOREIGN KEY (input_message_id) REFERENCES messages(id)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO external_assist_records_v11(
        id, phase, status, provider_id, session_id, run_id, input_message_id, query,
        role, hints_json, error, isolated_from_memory, included_in_active_memory,
        created_at, updated_at
      ) SELECT id, phase, status, provider_id, session_id, run_id, input_message_id,
        query, role, hints_json, error, isolated_from_memory, included_in_active_memory,
        created_at, updated_at FROM external_assist_records`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE tool_runs_v11 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT,
        tool_call_id TEXT,
        provider_tool_name TEXT NOT NULL,
        action_id TEXT,
        status TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        output_summary TEXT NOT NULL,
        error_code TEXT,
        resource_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES backend_runs_v11(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO tool_runs_v11(
        id, run_id, session_id, tool_call_id, provider_tool_name, action_id, status,
        input_summary, output_summary, error_code, resource_refs_json, created_at
      ) SELECT id, run_id, session_id, tool_call_id, provider_tool_name, action_id,
        status, input_summary, output_summary, error_code, resource_refs_json, created_at
        FROM tool_runs`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE backend_events_v11 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT,
        backend_session_id TEXT,
        event_type TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        attempt_no INTEGER,
        source_event_id TEXT,
        source_sequence INTEGER,
        payload_json TEXT NOT NULL,
        resource_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES backend_runs_v11(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO backend_events_v11(
        id, run_id, session_id, backend_session_id, event_type, sequence, attempt_no,
        source_event_id, source_sequence, payload_json, resource_refs_json, created_at
      ) SELECT id, run_id, session_id, backend_session_id, event_type, sequence,
        attempt_no, source_event_id, source_sequence, payload_json, resource_refs_json,
        created_at FROM backend_events`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE session_run_reservations_v11 (
        session_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        held_at TEXT NOT NULL,
        released_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (run_id) REFERENCES backend_runs_v11(id)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO session_run_reservations_v11(session_id, run_id, status, version, held_at, released_at)
        SELECT session_id, run_id, status, version, held_at, released_at FROM session_run_reservations`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE workspace_changes_v11 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT,
        resource_ref_json TEXT NOT NULL,
        change_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        legacy_operation_id TEXT,
        correlation_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES backend_runs_v11(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO workspace_changes_v11(
        id, run_id, session_id, resource_ref_json, change_type, summary,
        legacy_operation_id, correlation_id, created_at
      ) SELECT id, run_id, session_id, resource_ref_json, change_type, summary,
        legacy_operation_id, correlation_id, created_at FROM workspace_changes`
    },
    { kind: "sql", statement: "DROP TABLE workspace_changes" },
    { kind: "sql", statement: "DROP TABLE session_run_reservations" },
    { kind: "sql", statement: "DROP TABLE backend_events" },
    { kind: "sql", statement: "DROP TABLE tool_runs" },
    { kind: "sql", statement: "DROP TABLE external_assist_records" },
    { kind: "sql", statement: "DROP TABLE learning_resource_uses" },
    { kind: "sql", statement: "DROP TABLE backend_runs" },
    { kind: "sql", statement: "ALTER TABLE backend_runs_v11 RENAME TO backend_runs" },
    { kind: "sql", statement: "ALTER TABLE learning_resource_uses_v11 RENAME TO learning_resource_uses" },
    { kind: "sql", statement: "ALTER TABLE external_assist_records_v11 RENAME TO external_assist_records" },
    { kind: "sql", statement: "ALTER TABLE tool_runs_v11 RENAME TO tool_runs" },
    { kind: "sql", statement: "ALTER TABLE backend_events_v11 RENAME TO backend_events" },
    { kind: "sql", statement: "ALTER TABLE session_run_reservations_v11 RENAME TO session_run_reservations" },
    { kind: "sql", statement: "ALTER TABLE workspace_changes_v11 RENAME TO workspace_changes" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_backend_runs_session_idempotency ON backend_runs(session_id, request_idempotency_key) WHERE session_id IS NOT NULL AND request_idempotency_key IS NOT NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_backend_runs_room_idempotency ON backend_runs(room_id, request_idempotency_key) WHERE room_id IS NOT NULL AND request_idempotency_key IS NOT NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_backend_runs_agent ON backend_runs(agent_id)" },
    { kind: "sql", statement: "CREATE INDEX idx_backend_runs_room_started ON backend_runs(room_id, started_at DESC)" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_backend_events_source_identity ON backend_events(run_id, attempt_no, source_event_id) WHERE source_event_id IS NOT NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_backend_events_source_sequence ON backend_events(run_id, attempt_no, source_sequence) WHERE source_sequence IS NOT NULL AND source_event_id IS NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_operations_run_id ON operations(run_id) WHERE run_id IS NOT NULL" },
    { kind: "sql", statement: "CREATE INDEX learning_resource_uses_run_idx ON learning_resource_uses(run_id, created_at DESC)" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX learning_resource_uses_dedupe_idx ON learning_resource_uses(run_id, resource_kind, resource_id, stage, COALESCE(source_operation_id, ''))" },
    { kind: "sql", statement: "CREATE INDEX idx_learning_resource_uses_activity ON learning_resource_uses(room_id, session_id, agent_id)" },
    { kind: "sql", statement: "CREATE INDEX idx_learning_resource_uses_applied ON learning_resource_uses(run_id, stage, resource_id)" },
    { kind: "sql", statement: "CREATE TABLE IF NOT EXISTS run_leases (lane_key TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('held', 'released')), version INTEGER NOT NULL, held_at TEXT NOT NULL, released_at TEXT, FOREIGN KEY (run_id) REFERENCES backend_runs(id))" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_run_leases_status ON run_leases(status, held_at)" },
    { kind: "sql", statement: "CREATE TRIGGER IF NOT EXISTS core06_block_new_session_shares BEFORE INSERT ON room_resource_shares WHEN EXISTS (SELECT 1 FROM resource_access_boundaries WHERE resource_access_boundaries.resource_kind = 'session' AND resource_access_boundaries.id = NEW.resource_access_boundary_id) BEGIN SELECT RAISE(ABORT, 'core06_session_share_forbidden'); END" },
    { kind: "sql", statement: "ALTER TABLE audit_records ADD COLUMN principal_json TEXT" },
    { kind: "sql", statement: "ALTER TABLE audit_records ADD COLUMN source_json TEXT" },
    { kind: "sql", statement: "ALTER TABLE audit_records ADD COLUMN session_ref_json TEXT" }
  ]
};
