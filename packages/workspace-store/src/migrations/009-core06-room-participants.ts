import type { WorkspaceMigration, WorkspaceMigrationStep } from "../kernel/migration-runner";

const addColumn = (table: string, column: string, definition: string): WorkspaceMigrationStep => ({
  kind: "add_column_if_missing",
  table,
  column,
  statement: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
});

/**
 * Core 06 persists current participation separately from UsageScope and legacy
 * Grant records. Removal is historical; active partial indexes are the current
 * authorization source of truth.
 */
export const core06RoomParticipantsMigration: WorkspaceMigration = {
  version: 9,
  name: "core06_room_participants",
  steps: [
    {
      kind: "sql",
      statement: `CREATE TABLE IF NOT EXISTS workspace_members (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'guest')),
        joined_at TEXT NOT NULL,
        removed_at TEXT,
        created_by_participant_id TEXT NOT NULL,
        removed_by_participant_id TEXT,
        updated_at TEXT NOT NULL
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE IF NOT EXISTS room_members (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'guest')),
        joined_at TEXT NOT NULL,
        removed_at TEXT,
        created_by_participant_id TEXT NOT NULL,
        removed_by_participant_id TEXT,
        updated_at TEXT NOT NULL
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE IF NOT EXISTS room_agents (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        can_view INTEGER NOT NULL CHECK(can_view IN (0, 1)),
        can_edit INTEGER NOT NULL CHECK(can_edit IN (0, 1)),
        can_execute INTEGER NOT NULL CHECK(can_execute IN (0, 1)),
        joined_at TEXT NOT NULL,
        removed_at TEXT,
        created_by_participant_id TEXT NOT NULL,
        removed_by_participant_id TEXT,
        updated_at TEXT NOT NULL,
        CHECK((can_edit = 0 OR can_view = 1) AND (can_execute = 0 OR can_view = 1))
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE IF NOT EXISTS agent_workspace_permissions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        permission TEXT NOT NULL CHECK(permission IN ('room.create')),
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        granted_by_participant_id TEXT NOT NULL,
        revoked_by_participant_id TEXT,
        updated_at TEXT NOT NULL
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE IF NOT EXISTS resource_access_boundaries (
        id TEXT PRIMARY KEY,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        source_room_id TEXT,
        owner_participant_id TEXT NOT NULL,
        created_by_participant_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(resource_kind, resource_id)
      )`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE IF NOT EXISTS room_resource_shares (
        id TEXT PRIMARY KEY,
        resource_access_boundary_id TEXT NOT NULL,
        source_room_id TEXT NOT NULL,
        target_room_id TEXT NOT NULL,
        shared_by_participant_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by_participant_id TEXT,
        updated_at TEXT NOT NULL,
        CHECK(source_room_id <> target_room_id)
      )`
    },
    addColumn("backend_runs", "requested_by_participant_id", "TEXT"),
    addColumn("operations", "participant_id", "TEXT"),
    addColumn("operations", "participant_kind", "TEXT"),
    addColumn("operations", "requested_by_participant_id", "TEXT"),
    addColumn("operations", "room_id", "TEXT"),
    addColumn("audit_records", "participant_id", "TEXT"),
    addColumn("audit_records", "participant_kind", "TEXT"),
    addColumn("audit_records", "requested_by_participant_id", "TEXT"),
    addColumn("audit_records", "room_id", "TEXT"),
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_one_owner ON workspace_members(role) WHERE role = 'owner' AND removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_current_participant ON workspace_members(participant_id) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_one_owner ON room_members(room_id) WHERE role = 'owner' AND removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_current_participant ON room_members(room_id, participant_id) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_room_agents_current_agent ON room_agents(room_id, agent_id) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspace_permissions_current ON agent_workspace_permissions(agent_id, permission) WHERE revoked_at IS NULL" },
    { kind: "sql", statement: "CREATE UNIQUE INDEX IF NOT EXISTS idx_room_resource_shares_current ON room_resource_shares(resource_access_boundary_id, target_room_id) WHERE revoked_at IS NULL" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_room_members_current_room ON room_members(room_id, role) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_room_agents_current_room ON room_agents(room_id, agent_id) WHERE removed_at IS NULL" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_resource_access_boundaries_source_room ON resource_access_boundaries(source_room_id, resource_kind)" },
    { kind: "sql", statement: "CREATE INDEX IF NOT EXISTS idx_room_resource_shares_target_room ON room_resource_shares(target_room_id) WHERE revoked_at IS NULL" },
    {
      kind: "sql",
      statement: `INSERT INTO workspace_members(id, participant_id, role, joined_at, removed_at, created_by_participant_id, removed_by_participant_id, updated_at)
        SELECT 'workspace-member:local-owner', 'human:local-owner', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'human:local-owner', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE NOT EXISTS (SELECT 1 FROM workspace_members WHERE role = 'owner' AND removed_at IS NULL)`
    },
    {
      kind: "sql",
      statement: `INSERT INTO room_members(id, room_id, participant_id, role, joined_at, removed_at, created_by_participant_id, removed_by_participant_id, updated_at)
        SELECT 'room-member:legacy-owner:' || rooms.id, rooms.id, 'human:local-owner', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'human:local-owner', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM rooms
        WHERE NOT EXISTS (SELECT 1 FROM room_members WHERE room_members.room_id = rooms.id AND room_members.role = 'owner' AND room_members.removed_at IS NULL)`
    },
    {
      kind: "sql",
      statement: `INSERT INTO room_agents(id, room_id, agent_id, can_view, can_edit, can_execute, joined_at, removed_at, created_by_participant_id, removed_by_participant_id, updated_at)
        SELECT 'room-agent:legacy:' || settings.default_room_id || ':' || agents.id, settings.default_room_id, agents.id, 1, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'human:local-owner', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM settings CROSS JOIN agents
        WHERE settings.id = 'default' AND settings.default_room_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM room_agents WHERE room_agents.room_id = settings.default_room_id AND room_agents.agent_id = agents.id AND room_agents.removed_at IS NULL)`
    }
  ]
};
