export interface WorkspaceMembersTable {
  id: string;
  participant_id: string;
  role: string;
  joined_at: string;
  removed_at: string | null;
  created_by_participant_id: string;
  removed_by_participant_id: string | null;
  updated_at: string;
}

export interface RoomMembersTable {
  id: string;
  room_id: string;
  participant_id: string;
  role: string;
  joined_at: string;
  removed_at: string | null;
  created_by_participant_id: string;
  removed_by_participant_id: string | null;
  updated_at: string;
}

export interface RoomAgentsTable {
  id: string;
  room_id: string;
  agent_id: string;
  can_view: number;
  can_edit: number;
  can_execute: number;
  joined_at: string;
  removed_at: string | null;
  created_by_participant_id: string;
  removed_by_participant_id: string | null;
  updated_at: string;
}

export interface AgentWorkspacePermissionsTable {
  id: string;
  agent_id: string;
  permission: string;
  granted_at: string;
  revoked_at: string | null;
  granted_by_participant_id: string;
  revoked_by_participant_id: string | null;
  updated_at: string;
}

export interface ResourceAccessBoundariesTable {
  id: string;
  resource_kind: string;
  resource_id: string;
  source_room_id: string | null;
  owner_participant_id: string;
  created_by_participant_id: string;
  created_at: string;
  updated_at: string;
}

export interface RoomResourceSharesTable {
  id: string;
  resource_access_boundary_id: string;
  source_room_id: string;
  target_room_id: string;
  shared_by_participant_id: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by_participant_id: string | null;
  updated_at: string;
}
