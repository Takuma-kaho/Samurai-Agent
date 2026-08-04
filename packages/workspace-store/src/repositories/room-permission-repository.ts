import {
  localOwnerParticipantId,
  type AgentWorkspacePermission,
  type RoomHumanRole,
  type WorkspaceRole
} from "@samurai-agent/room-permissions";
import { createId, nowIso, type RoomRecord } from "@samurai-agent/core-schemas";
import type { Kysely, Transaction } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";

export interface WorkspaceMemberRecord {
  id: string;
  participant_id: string;
  role: WorkspaceRole;
  joined_at: string;
  removed_at?: string;
  created_by_participant_id: string;
  removed_by_participant_id?: string;
  updated_at: string;
}

export interface RoomMemberRecord {
  id: string;
  room_id: string;
  participant_id: string;
  role: RoomHumanRole;
  joined_at: string;
  removed_at?: string;
  created_by_participant_id: string;
  removed_by_participant_id?: string;
  updated_at: string;
}

export interface RoomAgentPermissionRecord {
  id: string;
  room_id: string;
  agent_id: string;
  can_view: boolean;
  can_edit: boolean;
  can_execute: boolean;
  joined_at: string;
  removed_at?: string;
  created_by_participant_id: string;
  removed_by_participant_id?: string;
  updated_at: string;
}

export interface AgentWorkspacePermissionRecord {
  id: string;
  agent_id: string;
  permission: AgentWorkspacePermission;
  granted_at: string;
  revoked_at?: string;
  granted_by_participant_id: string;
  revoked_by_participant_id?: string;
  updated_at: string;
}

export interface ResourceAccessBoundaryRecord {
  id: string;
  resource_kind: string;
  resource_id: string;
  source_room_id?: string;
  owner_participant_id: string;
  created_by_participant_id: string;
  created_at: string;
  updated_at: string;
}

export interface RoomResourceShareRecord {
  id: string;
  resource_access_boundary_id: string;
  source_room_id: string;
  target_room_id: string;
  shared_by_participant_id: string;
  created_at: string;
  revoked_at?: string;
  revoked_by_participant_id?: string;
  updated_at: string;
}

type DbExecutor = Kysely<WorkspaceDb> | Transaction<WorkspaceDb>;

/**
 * SQLite owner for current Room participation and explicit resource shares.
 * It never evaluates roles: the pure room-permissions package does that.
 */
export class RoomPermissionRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async ensureInitialAccess(input: { defaultRoomId?: string; defaultAgentId?: string }): Promise<void> {
    // Bootstrap is deliberately not a read-then-write transaction. Parallel
    // Workspace opens otherwise hold concurrent read transactions that cannot
    // be upgraded to a writer in SQLite. Each missing record is instead an
    // idempotent insert protected by the same active-row indexes that enforce
    // the Owner and membership invariants in normal operations.
    const now = nowIso();
    if (!await activeWorkspaceOwner(this.db)) {
      await insertWorkspaceMember(this.db, {
        participantId: localOwnerParticipantId,
        role: "owner",
        actorId: localOwnerParticipantId,
        now,
        id: "workspace-member:local-owner",
        ignoreConflict: true
      });
    }
    const rooms = await this.db.selectFrom("rooms").selectAll().execute();
    for (const room of rooms) {
      if (await activeRoomOwner(this.db, room.id)) continue;
      await insertRoomMember(this.db, {
        roomId: room.id,
        participantId: localOwnerParticipantId,
        role: "owner",
        actorId: localOwnerParticipantId,
        now,
        id: `room-member:initial-owner:${room.id}`,
        ignoreConflict: true
      });
    }
    if (input.defaultRoomId && input.defaultAgentId && !await activeRoomAgent(this.db, input.defaultRoomId, input.defaultAgentId)) {
      await insertRoomAgent(this.db, {
        roomId: input.defaultRoomId,
        agentId: input.defaultAgentId,
        canView: true,
        canEdit: true,
        canExecute: true,
        actorId: localOwnerParticipantId,
        now,
        id: `room-agent:initial:${input.defaultRoomId}:${input.defaultAgentId}`,
        ignoreConflict: true
      });
    }
  }

  async createRoomWithOwner(room: RoomRecord, ownerParticipantId: string): Promise<RoomRecord> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto("rooms").values(room).execute();
      await insertRoomMember(trx, {
        roomId: room.id,
        participantId: ownerParticipantId,
        role: "owner",
        actorId: ownerParticipantId,
        now: room.created_at
      });
    });
    return room;
  }

  async getWorkspaceMember(participantId: string): Promise<WorkspaceMemberRecord | undefined> {
    const row = await this.db.selectFrom("workspace_members").selectAll()
      .where("participant_id", "=", participantId).where("removed_at", "is", null).executeTakeFirst();
    return row ? workspaceMemberFromRow(row) : undefined;
  }

  async listWorkspaceMembers(input: { includeRemoved?: boolean } = {}): Promise<WorkspaceMemberRecord[]> {
    let query = this.db.selectFrom("workspace_members").selectAll();
    if (!input.includeRemoved) query = query.where("removed_at", "is", null);
    return (await query.orderBy("joined_at", "asc").execute()).map(workspaceMemberFromRow);
  }

  async addWorkspaceMember(input: { participantId: string; role: Exclude<WorkspaceRole, "owner">; actorId: string }): Promise<WorkspaceMemberRecord> {
    const now = nowIso();
    const existing = await this.getWorkspaceMember(input.participantId);
    if (existing) throw new Error(`workspace_member_already_active:${input.participantId}`);
    return this.db.transaction().execute(async (trx) => {
      return insertWorkspaceMember(trx, { participantId: input.participantId, role: input.role, actorId: input.actorId, now });
    });
  }

  async changeWorkspaceMemberRole(input: { participantId: string; role: Exclude<WorkspaceRole, "owner">; actorId: string }): Promise<WorkspaceMemberRecord | undefined> {
    const current = await this.getWorkspaceMember(input.participantId);
    if (current?.role === "owner") throw new Error("workspace_owner_transfer_required");
    const now = nowIso();
    const updated = await this.db.updateTable("workspace_members")
      .set({ role: input.role, updated_at: now })
      .where("participant_id", "=", input.participantId).where("removed_at", "is", null).where("role", "!=", "owner").executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw new Error("workspace_owner_transfer_required");
    return this.getWorkspaceMember(input.participantId);
  }

  async removeWorkspaceMember(input: { participantId: string; actorId: string }): Promise<WorkspaceMemberRecord | undefined> {
    const current = await this.getWorkspaceMember(input.participantId);
    if (!current) return undefined;
    if (current.role === "owner") throw new Error("workspace_owner_transfer_required");
    const now = nowIso();
    const updated = await this.db.updateTable("workspace_members")
      .set({ removed_at: now, removed_by_participant_id: input.actorId, updated_at: now })
      .where("id", "=", current.id).where("removed_at", "is", null).where("role", "!=", "owner").executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw new Error("workspace_owner_transfer_required");
    return this.getWorkspaceMemberIncludingRemoved(current.id);
  }

  async transferWorkspaceOwnership(input: { fromParticipantId: string; toParticipantId: string; actorId: string }): Promise<{ previousOwner: WorkspaceMemberRecord; owner: WorkspaceMemberRecord }> {
    return this.db.transaction().execute(async (trx) => {
      const [previous, next] = await Promise.all([
        activeWorkspaceOwner(trx),
        activeWorkspaceMember(trx, input.toParticipantId)
      ]);
      if (!previous || previous.participant_id !== input.fromParticipantId) throw new Error("workspace_owner_transfer_source_invalid");
      if (!next) throw new Error("workspace_owner_transfer_target_missing");
      const now = nowIso();
      // This transaction is the visibility boundary: no reader can observe the
      // internal demote/promote sequence, and the partial index prevents two owners.
      await trx.updateTable("workspace_members").set({ role: "admin", updated_at: now }).where("id", "=", previous.id).execute();
      await trx.updateTable("workspace_members").set({ role: "owner", updated_at: now }).where("id", "=", next.id).execute();
      return {
        previousOwner: workspaceMemberFromRow({ ...previous, role: "admin", updated_at: now }),
        owner: workspaceMemberFromRow({ ...next, role: "owner", updated_at: now })
      };
    });
  }

  async getRoomMember(roomId: string, participantId: string): Promise<RoomMemberRecord | undefined> {
    const row = await this.db.selectFrom("room_members").selectAll()
      .where("room_id", "=", roomId).where("participant_id", "=", participantId).where("removed_at", "is", null).executeTakeFirst();
    return row ? roomMemberFromRow(row) : undefined;
  }

  async listRoomMembers(roomId: string, input: { includeRemoved?: boolean } = {}): Promise<RoomMemberRecord[]> {
    let query = this.db.selectFrom("room_members").selectAll().where("room_id", "=", roomId);
    if (!input.includeRemoved) query = query.where("removed_at", "is", null);
    return (await query.orderBy("joined_at", "asc").execute()).map(roomMemberFromRow);
  }

  async addRoomMember(input: { roomId: string; participantId: string; role: Exclude<RoomHumanRole, "owner">; actorId: string }): Promise<RoomMemberRecord> {
    const existing = await this.getRoomMember(input.roomId, input.participantId);
    if (existing) throw new Error(`room_member_already_active:${input.roomId}:${input.participantId}`);
    return this.db.transaction().execute((trx) => insertRoomMember(trx, {
      roomId: input.roomId,
      participantId: input.participantId,
      role: input.role,
      actorId: input.actorId,
      now: nowIso()
    }));
  }

  async changeRoomMemberRole(input: { roomId: string; participantId: string; role: Exclude<RoomHumanRole, "owner"> }): Promise<RoomMemberRecord | undefined> {
    const current = await this.getRoomMember(input.roomId, input.participantId);
    if (current?.role === "owner") throw new Error("room_owner_transfer_required");
    const now = nowIso();
    const updated = await this.db.updateTable("room_members").set({ role: input.role, updated_at: now })
      .where("room_id", "=", input.roomId).where("participant_id", "=", input.participantId).where("removed_at", "is", null).where("role", "!=", "owner").executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw new Error("room_owner_transfer_required");
    return this.getRoomMember(input.roomId, input.participantId);
  }

  async removeRoomMember(input: { roomId: string; participantId: string; actorId: string }): Promise<RoomMemberRecord | undefined> {
    const current = await this.getRoomMember(input.roomId, input.participantId);
    if (!current) return undefined;
    if (current.role === "owner") throw new Error("room_owner_transfer_required");
    const now = nowIso();
    const updated = await this.db.updateTable("room_members").set({ removed_at: now, removed_by_participant_id: input.actorId, updated_at: now })
      .where("id", "=", current.id).where("removed_at", "is", null).where("role", "!=", "owner").executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw new Error("room_owner_transfer_required");
    return roomMemberFromRow({ ...current, removed_at: now, removed_by_participant_id: input.actorId, updated_at: now });
  }

  async transferRoomOwnership(input: { roomId: string; fromParticipantId: string; toParticipantId: string }): Promise<{ previousOwner: RoomMemberRecord; owner: RoomMemberRecord }> {
    return this.db.transaction().execute(async (trx) => {
      const [previous, next] = await Promise.all([
        activeRoomOwner(trx, input.roomId),
        activeRoomMember(trx, input.roomId, input.toParticipantId)
      ]);
      if (!previous || previous.participant_id !== input.fromParticipantId) throw new Error("room_owner_transfer_source_invalid");
      if (!next) throw new Error("room_owner_transfer_target_missing");
      const now = nowIso();
      await trx.updateTable("room_members").set({ role: "admin", updated_at: now }).where("id", "=", previous.id).execute();
      await trx.updateTable("room_members").set({ role: "owner", updated_at: now }).where("id", "=", next.id).execute();
      return {
        previousOwner: roomMemberFromRow({ ...previous, role: "admin", updated_at: now }),
        owner: roomMemberFromRow({ ...next, role: "owner", updated_at: now })
      };
    });
  }

  async recoverOwnerlessRoom(input: { roomId: string; ownerParticipantId: string }): Promise<RoomMemberRecord> {
    return this.db.transaction().execute(async (trx) => {
      if (await activeRoomOwner(trx, input.roomId)) throw new Error(`room_owner_already_exists:${input.roomId}`);
      const current = await activeRoomMember(trx, input.roomId, input.ownerParticipantId);
      const now = nowIso();
      if (current) {
        await trx.updateTable("room_members").set({ role: "owner", updated_at: now }).where("id", "=", current.id).execute();
        return roomMemberFromRow({ ...current, role: "owner", updated_at: now });
      }
      return insertRoomMember(trx, { roomId: input.roomId, participantId: input.ownerParticipantId, role: "owner", actorId: input.ownerParticipantId, now });
    });
  }

  async getRoomAgent(roomId: string, agentId: string): Promise<RoomAgentPermissionRecord | undefined> {
    const row = await this.db.selectFrom("room_agents").selectAll()
      .where("room_id", "=", roomId).where("agent_id", "=", agentId).where("removed_at", "is", null).executeTakeFirst();
    return row ? roomAgentFromRow(row) : undefined;
  }

  async listRoomAgents(roomId: string, input: { includeRemoved?: boolean } = {}): Promise<RoomAgentPermissionRecord[]> {
    let query = this.db.selectFrom("room_agents").selectAll().where("room_id", "=", roomId);
    if (!input.includeRemoved) query = query.where("removed_at", "is", null);
    return (await query.orderBy("joined_at", "asc").execute()).map(roomAgentFromRow);
  }

  async setRoomAgentPermissions(input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean; actorId: string }): Promise<RoomAgentPermissionRecord> {
    if ((input.canEdit || input.canExecute) && !input.canView) throw new Error("room_agent_view_required");
    const current = await this.getRoomAgent(input.roomId, input.agentId);
    const now = nowIso();
    if (!current) {
      return this.db.transaction().execute((trx) => insertRoomAgent(trx, { ...input, now }));
    }
    await this.db.updateTable("room_agents").set({
      can_view: input.canView ? 1 : 0,
      can_edit: input.canEdit ? 1 : 0,
      can_execute: input.canExecute ? 1 : 0,
      updated_at: now
    }).where("id", "=", current.id).where("removed_at", "is", null).execute();
    return { ...current, can_view: input.canView, can_edit: input.canEdit, can_execute: input.canExecute, updated_at: now };
  }

  async removeRoomAgent(input: { roomId: string; agentId: string; actorId: string }): Promise<RoomAgentPermissionRecord | undefined> {
    const current = await this.getRoomAgent(input.roomId, input.agentId);
    if (!current) return undefined;
    const now = nowIso();
    await this.db.updateTable("room_agents").set({ removed_at: now, removed_by_participant_id: input.actorId, updated_at: now })
      .where("id", "=", current.id).where("removed_at", "is", null).execute();
    return { ...current, removed_at: now, removed_by_participant_id: input.actorId, updated_at: now };
  }

  async getAgentWorkspacePermission(agentId: string, permission: AgentWorkspacePermission = "room.create"): Promise<AgentWorkspacePermissionRecord | undefined> {
    const row = await this.db.selectFrom("agent_workspace_permissions").selectAll()
      .where("agent_id", "=", agentId).where("permission", "=", permission).where("revoked_at", "is", null).executeTakeFirst();
    return row ? agentWorkspacePermissionFromRow(row) : undefined;
  }

  async setAgentWorkspacePermission(input: { agentId: string; permission: AgentWorkspacePermission; allowed: boolean; actorId: string }): Promise<AgentWorkspacePermissionRecord | undefined> {
    const current = await this.getAgentWorkspacePermission(input.agentId, input.permission);
    const now = nowIso();
    if (input.allowed && current) return current;
    if (!input.allowed && !current) return undefined;
    if (!input.allowed && current) {
      await this.db.updateTable("agent_workspace_permissions").set({ revoked_at: now, revoked_by_participant_id: input.actorId, updated_at: now })
        .where("id", "=", current.id).where("revoked_at", "is", null).execute();
      return { ...current, revoked_at: now, revoked_by_participant_id: input.actorId, updated_at: now };
    }
    return this.db.transaction().execute((trx) => insertAgentWorkspacePermission(trx, { agentId: input.agentId, permission: input.permission, actorId: input.actorId, now }));
  }

  async getResourceAccessBoundary(resourceKind: string, resourceId: string): Promise<ResourceAccessBoundaryRecord | undefined> {
    const row = await this.db.selectFrom("resource_access_boundaries").selectAll()
      .where("resource_kind", "=", resourceKind).where("resource_id", "=", resourceId).executeTakeFirst();
    return row ? resourceBoundaryFromRow(row) : undefined;
  }

  async ensureResourceAccessBoundary(input: { resourceKind: string; resourceId: string; sourceRoomId?: string; ownerParticipantId: string; actorId: string }): Promise<ResourceAccessBoundaryRecord> {
    const current = await this.getResourceAccessBoundary(input.resourceKind, input.resourceId);
    if (current) return current;
    const now = nowIso();
    const record: ResourceAccessBoundaryRecord = {
      id: createId("resource-boundary"),
      resource_kind: input.resourceKind,
      resource_id: input.resourceId,
      ...(input.sourceRoomId ? { source_room_id: input.sourceRoomId } : {}),
      owner_participant_id: input.ownerParticipantId,
      created_by_participant_id: input.actorId,
      created_at: now,
      updated_at: now
    };
    await this.db.insertInto("resource_access_boundaries").values({
      ...record,
      source_room_id: record.source_room_id ?? null
    }).onConflict((conflict) => conflict.columns(["resource_kind", "resource_id"]).doNothing()).execute();
    return (await this.getResourceAccessBoundary(input.resourceKind, input.resourceId)) ?? record;
  }

  async listRoomResourceShares(resourceAccessBoundaryId: string, input: { includeRevoked?: boolean } = {}): Promise<RoomResourceShareRecord[]> {
    let query = this.db.selectFrom("room_resource_shares").selectAll().where("resource_access_boundary_id", "=", resourceAccessBoundaryId);
    if (!input.includeRevoked) query = query.where("revoked_at", "is", null);
    return (await query.orderBy("created_at", "asc").execute()).map(roomResourceShareFromRow);
  }

  async shareResource(input: { resourceAccessBoundaryId: string; sourceRoomId: string; targetRoomId: string; actorId: string }): Promise<RoomResourceShareRecord> {
    if (input.sourceRoomId === input.targetRoomId) throw new Error("room_resource_share_same_room");
    const boundary = await this.db.selectFrom("resource_access_boundaries").selectAll()
      .where("id", "=", input.resourceAccessBoundaryId).executeTakeFirst();
    if (!boundary || boundary.source_room_id !== input.sourceRoomId) {
      throw new Error("room_resource_share_source_invalid");
    }
    const current = (await this.listRoomResourceShares(input.resourceAccessBoundaryId)).find((share) => share.target_room_id === input.targetRoomId);
    if (current) return current;
    const now = nowIso();
    const record: RoomResourceShareRecord = {
      id: createId("room-share"),
      resource_access_boundary_id: input.resourceAccessBoundaryId,
      source_room_id: input.sourceRoomId,
      target_room_id: input.targetRoomId,
      shared_by_participant_id: input.actorId,
      created_at: now,
      updated_at: now
    };
    await this.db.insertInto("room_resource_shares").values({ ...record, revoked_at: null, revoked_by_participant_id: null }).execute();
    return record;
  }

  async revokeRoomResourceShare(input: { resourceAccessBoundaryId: string; targetRoomId: string; actorId: string }): Promise<RoomResourceShareRecord | undefined> {
    const current = (await this.listRoomResourceShares(input.resourceAccessBoundaryId)).find((share) => share.target_room_id === input.targetRoomId);
    if (!current) return undefined;
    const now = nowIso();
    await this.db.updateTable("room_resource_shares").set({ revoked_at: now, revoked_by_participant_id: input.actorId, updated_at: now })
      .where("id", "=", current.id).where("revoked_at", "is", null).execute();
    return { ...current, revoked_at: now, revoked_by_participant_id: input.actorId, updated_at: now };
  }

  async isResourceAvailableInRoom(input: { resourceKind: string; resourceId: string; roomId: string; participantId: string }): Promise<boolean> {
    const boundary = await this.getResourceAccessBoundary(input.resourceKind, input.resourceId);
    // Legacy data carries no boundary. It stays private to the Workspace Owner
    // until an explicit edit or share creates one.
    if (!boundary) return (await activeWorkspaceOwner(this.db))?.participant_id === input.participantId;
    if (boundary.source_room_id === input.roomId) return true;
    const shares = await this.listRoomResourceShares(boundary.id);
    return shares.some((share) => share.target_room_id === input.roomId);
  }

  /**
   * Candidate IDs are resolved from the Room boundary, never from UsageScope.
   * Callers may use UsageScope only to narrow this already-authorized set.
   */
  async listResourceIdsAvailableInRoom(input: { resourceKind: string; roomId: string }): Promise<string[]> {
    const rows = await this.db
      .selectFrom("resource_access_boundaries as boundary")
      .leftJoin("room_resource_shares as share", (join) => join
        .onRef("share.resource_access_boundary_id", "=", "boundary.id")
        .on("share.revoked_at", "is", null))
      .select("boundary.resource_id")
      .where("boundary.resource_kind", "=", input.resourceKind)
      .where((eb) => eb.or([
        eb("boundary.source_room_id", "=", input.roomId),
        eb("share.target_room_id", "=", input.roomId)
      ]))
      .distinct()
      .execute();
    return rows.map((row) => row.resource_id);
  }

  async listRoomIdsForHuman(participantId: string): Promise<string[]> {
    return (await this.db.selectFrom("room_members").select("room_id")
      .where("participant_id", "=", participantId).where("removed_at", "is", null).execute()).map((row) => row.room_id);
  }

  async listRoomIdsForAgent(agentId: string): Promise<string[]> {
    return (await this.db.selectFrom("room_agents").select("room_id")
      .where("agent_id", "=", agentId).where("removed_at", "is", null).where("can_view", "=", 1).execute()).map((row) => row.room_id);
  }

  private async getWorkspaceMemberIncludingRemoved(id: string): Promise<WorkspaceMemberRecord | undefined> {
    const row = await this.db.selectFrom("workspace_members").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? workspaceMemberFromRow(row) : undefined;
  }
}

async function activeWorkspaceOwner(db: DbExecutor) {
  return db.selectFrom("workspace_members").selectAll().where("role", "=", "owner").where("removed_at", "is", null).executeTakeFirst();
}

async function activeWorkspaceMember(db: DbExecutor, participantId: string) {
  return db.selectFrom("workspace_members").selectAll().where("participant_id", "=", participantId).where("removed_at", "is", null).executeTakeFirst();
}

async function activeRoomOwner(db: DbExecutor, roomId: string) {
  return db.selectFrom("room_members").selectAll().where("room_id", "=", roomId).where("role", "=", "owner").where("removed_at", "is", null).executeTakeFirst();
}

async function activeRoomMember(db: DbExecutor, roomId: string, participantId: string) {
  return db.selectFrom("room_members").selectAll().where("room_id", "=", roomId).where("participant_id", "=", participantId).where("removed_at", "is", null).executeTakeFirst();
}

async function activeRoomAgent(db: DbExecutor, roomId: string, agentId: string) {
  return db.selectFrom("room_agents").selectAll().where("room_id", "=", roomId).where("agent_id", "=", agentId).where("removed_at", "is", null).executeTakeFirst();
}

async function insertWorkspaceMember(db: DbExecutor, input: { participantId: string; role: WorkspaceRole; actorId: string; now: string; id?: string; ignoreConflict?: boolean }): Promise<WorkspaceMemberRecord> {
  const record: WorkspaceMemberRecord = {
    id: input.id ?? createId("workspace-member"),
    participant_id: input.participantId,
    role: input.role,
    joined_at: input.now,
    created_by_participant_id: input.actorId,
    updated_at: input.now
  };
  const insert = db.insertInto("workspace_members").values({ ...record, removed_at: null, removed_by_participant_id: null });
  if (input.ignoreConflict) await insert.onConflict((conflict) => conflict.doNothing()).execute();
  else await insert.execute();
  return record;
}

async function insertRoomMember(db: DbExecutor, input: { roomId: string; participantId: string; role: RoomHumanRole; actorId: string; now: string; id?: string; ignoreConflict?: boolean }): Promise<RoomMemberRecord> {
  const record: RoomMemberRecord = {
    id: input.id ?? createId("room-member"),
    room_id: input.roomId,
    participant_id: input.participantId,
    role: input.role,
    joined_at: input.now,
    created_by_participant_id: input.actorId,
    updated_at: input.now
  };
  const insert = db.insertInto("room_members").values({ ...record, removed_at: null, removed_by_participant_id: null });
  if (input.ignoreConflict) await insert.onConflict((conflict) => conflict.doNothing()).execute();
  else await insert.execute();
  return record;
}

async function insertRoomAgent(db: DbExecutor, input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean; actorId: string; now: string; id?: string; ignoreConflict?: boolean }): Promise<RoomAgentPermissionRecord> {
  const record: RoomAgentPermissionRecord = {
    id: input.id ?? createId("room-agent"),
    room_id: input.roomId,
    agent_id: input.agentId,
    can_view: input.canView,
    can_edit: input.canEdit,
    can_execute: input.canExecute,
    joined_at: input.now,
    created_by_participant_id: input.actorId,
    updated_at: input.now
  };
  const insert = db.insertInto("room_agents").values({
    ...record,
    can_view: record.can_view ? 1 : 0,
    can_edit: record.can_edit ? 1 : 0,
    can_execute: record.can_execute ? 1 : 0,
    removed_at: null,
    removed_by_participant_id: null
  });
  if (input.ignoreConflict) await insert.onConflict((conflict) => conflict.doNothing()).execute();
  else await insert.execute();
  return record;
}

async function insertAgentWorkspacePermission(db: DbExecutor, input: { agentId: string; permission: AgentWorkspacePermission; actorId: string; now: string }): Promise<AgentWorkspacePermissionRecord> {
  const record: AgentWorkspacePermissionRecord = {
    id: createId("agent-workspace-permission"),
    agent_id: input.agentId,
    permission: input.permission,
    granted_at: input.now,
    granted_by_participant_id: input.actorId,
    updated_at: input.now
  };
  await db.insertInto("agent_workspace_permissions").values({ ...record, revoked_at: null, revoked_by_participant_id: null }).execute();
  return record;
}

function workspaceMemberFromRow(row: WorkspaceDb["workspace_members"]): WorkspaceMemberRecord {
  return {
    id: row.id, participant_id: row.participant_id, role: row.role as WorkspaceRole, joined_at: row.joined_at,
    ...(row.removed_at ? { removed_at: row.removed_at } : {}), created_by_participant_id: row.created_by_participant_id,
    ...(row.removed_by_participant_id ? { removed_by_participant_id: row.removed_by_participant_id } : {}), updated_at: row.updated_at
  };
}

function roomMemberFromRow(row: WorkspaceDb["room_members"]): RoomMemberRecord {
  return {
    id: row.id, room_id: row.room_id, participant_id: row.participant_id, role: row.role as RoomHumanRole, joined_at: row.joined_at,
    ...(row.removed_at ? { removed_at: row.removed_at } : {}), created_by_participant_id: row.created_by_participant_id,
    ...(row.removed_by_participant_id ? { removed_by_participant_id: row.removed_by_participant_id } : {}), updated_at: row.updated_at
  };
}

function roomAgentFromRow(row: WorkspaceDb["room_agents"]): RoomAgentPermissionRecord {
  return {
    id: row.id, room_id: row.room_id, agent_id: row.agent_id, can_view: row.can_view === 1, can_edit: row.can_edit === 1, can_execute: row.can_execute === 1,
    joined_at: row.joined_at, ...(row.removed_at ? { removed_at: row.removed_at } : {}), created_by_participant_id: row.created_by_participant_id,
    ...(row.removed_by_participant_id ? { removed_by_participant_id: row.removed_by_participant_id } : {}), updated_at: row.updated_at
  };
}

function agentWorkspacePermissionFromRow(row: WorkspaceDb["agent_workspace_permissions"]): AgentWorkspacePermissionRecord {
  return {
    id: row.id, agent_id: row.agent_id, permission: row.permission as AgentWorkspacePermission, granted_at: row.granted_at,
    ...(row.revoked_at ? { revoked_at: row.revoked_at } : {}), granted_by_participant_id: row.granted_by_participant_id,
    ...(row.revoked_by_participant_id ? { revoked_by_participant_id: row.revoked_by_participant_id } : {}), updated_at: row.updated_at
  };
}

function resourceBoundaryFromRow(row: WorkspaceDb["resource_access_boundaries"]): ResourceAccessBoundaryRecord {
  return {
    id: row.id, resource_kind: row.resource_kind, resource_id: row.resource_id,
    ...(row.source_room_id ? { source_room_id: row.source_room_id } : {}), owner_participant_id: row.owner_participant_id,
    created_by_participant_id: row.created_by_participant_id, created_at: row.created_at, updated_at: row.updated_at
  };
}

function roomResourceShareFromRow(row: WorkspaceDb["room_resource_shares"]): RoomResourceShareRecord {
  return {
    id: row.id, resource_access_boundary_id: row.resource_access_boundary_id, source_room_id: row.source_room_id,
    target_room_id: row.target_room_id, shared_by_participant_id: row.shared_by_participant_id, created_at: row.created_at,
    ...(row.revoked_at ? { revoked_at: row.revoked_at } : {}), ...(row.revoked_by_participant_id ? { revoked_by_participant_id: row.revoked_by_participant_id } : {}), updated_at: row.updated_at
  };
}
