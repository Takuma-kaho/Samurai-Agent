import type { WorkspaceMigration } from "../kernel/migration-runner";

/**
 * Core 06 follow-up integrity migration.
 *
 * Migration 009 is already checksum-addressed in existing Workspaces, so it
 * remains immutable.  This migration rebuilds only the new Core 06 tables
 * with the constraints that make current participation and explicit shares a
 * durable source of truth.  Invalid historical Core 06 rows abort the whole
 * transaction instead of being guessed, dropped, or silently repaired.
 */
export const core06IntegrityHardeningMigration: WorkspaceMigration = {
  version: 10,
  name: "core06_integrity_hardening",
  steps: [
    {
      kind: "sql",
      statement: `CREATE TABLE workspace_members_v10 (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL CHECK(participant_id GLOB 'human:*' AND length(participant_id) > 6),
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'guest')),
        joined_at TEXT NOT NULL,
        removed_at TEXT,
        created_by_participant_id TEXT NOT NULL CHECK(created_by_participant_id GLOB 'human:*' AND length(created_by_participant_id) > 6),
        removed_by_participant_id TEXT CHECK(removed_by_participant_id IS NULL OR (removed_by_participant_id GLOB 'human:*' AND length(removed_by_participant_id) > 6)),
        updated_at TEXT NOT NULL
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE room_members_v10 (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
        participant_id TEXT NOT NULL CHECK(participant_id GLOB 'human:*' AND length(participant_id) > 6),
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'guest')),
        joined_at TEXT NOT NULL,
        removed_at TEXT,
        created_by_participant_id TEXT NOT NULL CHECK(created_by_participant_id GLOB 'human:*' AND length(created_by_participant_id) > 6),
        removed_by_participant_id TEXT CHECK(removed_by_participant_id IS NULL OR (removed_by_participant_id GLOB 'human:*' AND length(removed_by_participant_id) > 6)),
        updated_at TEXT NOT NULL
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE room_agents_v10 (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        can_view INTEGER NOT NULL CHECK(can_view IN (0, 1)),
        can_edit INTEGER NOT NULL CHECK(can_edit IN (0, 1)),
        can_execute INTEGER NOT NULL CHECK(can_execute IN (0, 1)),
        joined_at TEXT NOT NULL,
        removed_at TEXT,
        created_by_participant_id TEXT NOT NULL CHECK(created_by_participant_id GLOB 'human:*' AND length(created_by_participant_id) > 6),
        removed_by_participant_id TEXT CHECK(removed_by_participant_id IS NULL OR (removed_by_participant_id GLOB 'human:*' AND length(removed_by_participant_id) > 6)),
        updated_at TEXT NOT NULL,
        CHECK((can_edit = 0 OR can_view = 1) AND (can_execute = 0 OR can_view = 1))
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE agent_workspace_permissions_v10 (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        permission TEXT NOT NULL CHECK(permission IN ('room.create')),
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        granted_by_participant_id TEXT NOT NULL CHECK(granted_by_participant_id GLOB 'human:*' AND length(granted_by_participant_id) > 6),
        revoked_by_participant_id TEXT CHECK(revoked_by_participant_id IS NULL OR (revoked_by_participant_id GLOB 'human:*' AND length(revoked_by_participant_id) > 6)),
        updated_at TEXT NOT NULL
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE resource_access_boundaries_v10 (
        id TEXT PRIMARY KEY,
        resource_kind TEXT NOT NULL CHECK(resource_kind IN ('session', 'artifact', 'memory', 'wiki', 'skill', 'collection_schema', 'collection_record', 'file', 'generated_surface')),
        resource_id TEXT NOT NULL,
        source_room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
        owner_participant_id TEXT NOT NULL CHECK(owner_participant_id GLOB 'human:*' AND length(owner_participant_id) > 6),
        creator_participant_id TEXT CHECK(creator_participant_id IS NULL OR ((creator_participant_id GLOB 'human:*' OR creator_participant_id GLOB 'agent:*') AND length(creator_participant_id) > 6)),
        resource_created_at TEXT,
        boundary_registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(resource_kind, resource_id),
        UNIQUE(id, source_room_id)
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE room_resource_shares_v10 (
        id TEXT PRIMARY KEY,
        resource_access_boundary_id TEXT NOT NULL,
        source_room_id TEXT NOT NULL,
        target_room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
        shared_by_participant_id TEXT NOT NULL CHECK(shared_by_participant_id GLOB 'human:*' AND length(shared_by_participant_id) > 6),
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by_participant_id TEXT CHECK(revoked_by_participant_id IS NULL OR (revoked_by_participant_id GLOB 'human:*' AND length(revoked_by_participant_id) > 6)),
        updated_at TEXT NOT NULL,
        CHECK(source_room_id <> target_room_id),
        FOREIGN KEY(resource_access_boundary_id, source_room_id) REFERENCES resource_access_boundaries_v10(id, source_room_id) ON DELETE RESTRICT
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE audit_records_v10 (
        id TEXT PRIMARY KEY,
        actor_identity TEXT NOT NULL,
        participant_id TEXT,
        participant_kind TEXT,
        requested_by_participant_id TEXT,
        room_id TEXT,
        operation_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        instruction_source TEXT NOT NULL,
        inputs_summary TEXT NOT NULL,
        outputs_summary TEXT NOT NULL,
        policy_decision_id TEXT,
        room_access_scope TEXT CHECK(room_access_scope IS NULL OR room_access_scope IN ('workspace', 'room', 'resource')),
        room_access_action TEXT,
        room_access_allowed INTEGER CHECK(room_access_allowed IS NULL OR room_access_allowed IN (0, 1)),
        room_access_reason TEXT,
        affected_resources_json TEXT NOT NULL,
        rollback_point_id TEXT,
        created_at TEXT NOT NULL
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO workspace_members_v10(id, participant_id, role, joined_at, removed_at, created_by_participant_id, removed_by_participant_id, updated_at)
        SELECT id, participant_id, role, joined_at, removed_at, created_by_participant_id, removed_by_participant_id, updated_at
        FROM workspace_members`
    },
    {
      kind: "sql",
      statement: `INSERT INTO room_members_v10(id, room_id, participant_id, role, joined_at, removed_at, created_by_participant_id, removed_by_participant_id, updated_at)
        SELECT id, room_id, participant_id, role, joined_at, removed_at, created_by_participant_id, removed_by_participant_id, updated_at
        FROM room_members`
    },
    {
      kind: "sql",
      statement: `INSERT INTO room_agents_v10(id, room_id, agent_id, can_view, can_edit, can_execute, joined_at, removed_at, created_by_participant_id, removed_by_participant_id, updated_at)
        SELECT id, room_id, agent_id, can_view, can_edit, can_execute, joined_at, removed_at, created_by_participant_id, removed_by_participant_id, updated_at
        FROM room_agents`
    },
    {
      kind: "sql",
      statement: `INSERT INTO agent_workspace_permissions_v10(id, agent_id, permission, granted_at, revoked_at, granted_by_participant_id, revoked_by_participant_id, updated_at)
        SELECT id, agent_id, permission, granted_at, revoked_at, granted_by_participant_id, revoked_by_participant_id, updated_at
        FROM agent_workspace_permissions`
    },
    {
      kind: "sql",
      statement: `INSERT INTO resource_access_boundaries_v10(id, resource_kind, resource_id, source_room_id, owner_participant_id, creator_participant_id, resource_created_at, boundary_registered_at, updated_at)
        SELECT resource_access_boundaries.id,
          CASE resource_access_boundaries.resource_kind WHEN 'knowledge_wiki' THEN 'wiki' ELSE resource_access_boundaries.resource_kind END,
          CASE resource_access_boundaries.resource_kind
            WHEN 'collection_record' THEN 'collection:' || length(collection_record.collection_id) || ':' || collection_record.collection_id || length(collection_record.id) || ':' || collection_record.id
            ELSE resource_access_boundaries.resource_id
          END,
          resource_access_boundaries.source_room_id,
          resource_access_boundaries.owner_participant_id,
          resource_access_boundaries.created_by_participant_id,
          NULL,
          resource_access_boundaries.created_at,
          resource_access_boundaries.updated_at
        FROM resource_access_boundaries
        LEFT JOIN collection_records AS collection_record
          ON resource_access_boundaries.resource_kind = 'collection_record'
          AND resource_access_boundaries.resource_id = collection_record.collection_id || '/' || collection_record.id`
    },
    {
      kind: "sql",
      statement: `INSERT INTO room_resource_shares_v10(id, resource_access_boundary_id, source_room_id, target_room_id, shared_by_participant_id, created_at, revoked_at, revoked_by_participant_id, updated_at)
        SELECT id, resource_access_boundary_id, source_room_id, target_room_id, shared_by_participant_id, created_at, revoked_at, revoked_by_participant_id, updated_at
        FROM room_resource_shares`
    },
    {
      kind: "sql",
      statement: `INSERT INTO audit_records_v10(id, actor_identity, participant_id, participant_kind, requested_by_participant_id, room_id, operation_id, capability_id, instruction_source, inputs_summary, outputs_summary, policy_decision_id, affected_resources_json, rollback_point_id, created_at)
        SELECT id, actor_identity, participant_id, participant_kind, requested_by_participant_id, room_id, operation_id, capability_id, instruction_source, inputs_summary, outputs_summary, policy_decision_id, affected_resources_json, rollback_point_id, created_at
        FROM audit_records`
    },
    { kind: "sql", statement: "DROP TABLE room_resource_shares" },
    { kind: "sql", statement: "DROP TABLE resource_access_boundaries" },
    { kind: "sql", statement: "DROP TABLE agent_workspace_permissions" },
    { kind: "sql", statement: "DROP TABLE room_agents" },
    { kind: "sql", statement: "DROP TABLE room_members" },
    { kind: "sql", statement: "DROP TABLE workspace_members" },
    { kind: "sql", statement: "DROP TABLE audit_records" },
    { kind: "sql", statement: "ALTER TABLE workspace_members_v10 RENAME TO workspace_members" },
    { kind: "sql", statement: "ALTER TABLE room_members_v10 RENAME TO room_members" },
    { kind: "sql", statement: "ALTER TABLE room_agents_v10 RENAME TO room_agents" },
    { kind: "sql", statement: "ALTER TABLE agent_workspace_permissions_v10 RENAME TO agent_workspace_permissions" },
    { kind: "sql", statement: "ALTER TABLE resource_access_boundaries_v10 RENAME TO resource_access_boundaries" },
    { kind: "sql", statement: "ALTER TABLE room_resource_shares_v10 RENAME TO room_resource_shares" },
    { kind: "sql", statement: "ALTER TABLE audit_records_v10 RENAME TO audit_records" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_workspace_members_one_owner ON workspace_members(role) WHERE role = 'owner' AND removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_workspace_members_current_participant ON workspace_members(participant_id) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_room_members_one_owner ON room_members(room_id) WHERE role = 'owner' AND removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_room_members_current_participant ON room_members(room_id, participant_id) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_room_agents_current_agent ON room_agents(room_id, agent_id) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_agent_workspace_permissions_current ON agent_workspace_permissions(agent_id, permission) WHERE revoked_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX idx_room_resource_shares_current ON room_resource_shares(resource_access_boundary_id, target_room_id) WHERE revoked_at IS NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_room_members_current_room ON room_members(room_id, role) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_room_agents_current_room ON room_agents(room_id, agent_id) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_resource_access_boundaries_source_room ON resource_access_boundaries(source_room_id, resource_kind)" },
    { kind: "sql", statement: "CREATE INDEX idx_room_resource_shares_target_room ON room_resource_shares(target_room_id) WHERE revoked_at IS NULL" }
  ]
};
