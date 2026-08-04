import {
  canManageRoomTarget,
  canManageWorkspaceTarget,
  evaluateRoomPermission,
  evaluateWorkspacePermission,
  isHumanParticipantId,
  isRoomShareableResourceKind,
  type AgentWorkspacePermission,
  type ResourceAccessMode,
  type RoomHumanRole,
  type RoomShareableResourceKind,
  type WorkspaceRole
} from "@samurai-agent/room-permissions";
import { createId, nowIso, type RoomRecord } from "@samurai-agent/core-schemas";
import { sql, type Kysely, type Transaction } from "kysely";
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
  resource_kind: RoomShareableResourceKind;
  resource_id: string;
  source_room_id: string;
  /** The human requester responsible for the resource's Room ownership. */
  owner_participant_id: string;
  /** The actual human or Agent creator, absent only for unknown legacy data. */
  creator_participant_id?: string;
  /** The original resource timestamp when known; never rewritten on sharing. */
  resource_created_at?: string;
  /** When Core 06 registered the Room boundary. */
  boundary_registered_at: string;
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
 * SQLite owner for current participation and explicit resource shares.
 *
 * Service-layer checks decide whether an operation is understandable to the
 * caller.  Every mutation here repeats the same current-membership decision
 * after a scoped SQLite writer lock so a changed role cannot win a race
 * between admission and persistence.
 */
export class RoomPermissionRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  /** Called only when the default Room or default Agent has just been created. */
  async grantInitialDefaultAgentAccess(input: { roomId: string; agentId: string; ownerParticipantId: string }): Promise<RoomAgentPermissionRecord> {
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.roomId);
      await requireActiveWorkspaceMember(trx, input.ownerParticipantId);
      const owner = await requireActiveRoomMember(trx, input.roomId, input.ownerParticipantId);
      if (owner.role !== "owner") throw new Error("default_room_owner_required");
      const current = await activeRoomAgent(trx, input.roomId, input.agentId);
      if (current) return roomAgentFromRow(current);
      return insertRoomAgent(trx, {
        roomId: input.roomId,
        agentId: input.agentId,
        canView: true,
        canEdit: true,
        canExecute: true,
        actorId: input.ownerParticipantId,
        now: nowIso()
      });
    });
  }

  /** Room creation and the initial human Owner are one SQLite transaction. */
  async createRoomWithOwner(room: RoomRecord, ownerParticipantId: string): Promise<RoomRecord> {
    assertHumanParticipantId(ownerParticipantId, "room_owner_participant_id_invalid");
    await this.db.transaction().execute(async (trx) => {
      await lockWorkspace(trx);
      const owner = await requireActiveWorkspaceMember(trx, ownerParticipantId);
      assertWorkspaceAction(owner, ownerParticipantId, "create_room");
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
    const row = await activeWorkspaceMember(this.db, participantId);
    return row ? workspaceMemberFromRow(row) : undefined;
  }

  async listWorkspaceMembers(input: { includeRemoved?: boolean } = {}): Promise<WorkspaceMemberRecord[]> {
    let query = this.db.selectFrom("workspace_members").selectAll();
    if (!input.includeRemoved) query = query.where("removed_at", "is", null);
    return (await query.orderBy("joined_at", "asc").execute()).map(workspaceMemberFromRow);
  }

  async addWorkspaceMember(input: { participantId: string; role: Exclude<WorkspaceRole, "owner">; actorId: string }): Promise<WorkspaceMemberRecord> {
    assertHumanParticipantId(input.participantId, "workspace_member_participant_id_invalid");
    return this.db.transaction().execute(async (trx) => {
      await lockWorkspace(trx);
      const actor = await requireActiveWorkspaceMember(trx, input.actorId);
      assertWorkspaceManagement(actor, input.actorId, input.role);
      if (await activeWorkspaceMember(trx, input.participantId)) throw new Error(`workspace_member_already_active:${input.participantId}`);
      return insertWorkspaceMember(trx, { ...input, now: nowIso() });
    });
  }

  async changeWorkspaceMemberRole(input: { participantId: string; role: Exclude<WorkspaceRole, "owner">; actorId: string }): Promise<WorkspaceMemberRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      await lockWorkspace(trx);
      const actor = await requireActiveWorkspaceMember(trx, input.actorId);
      const target = await activeWorkspaceMember(trx, input.participantId);
      if (!target) return undefined;
      if (target.role === "owner") throw new Error("workspace_owner_transfer_required");
      assertWorkspaceManagement(actor, input.actorId, target.role as WorkspaceRole);
      // An Admin can manage a lower member but cannot manufacture a peer Admin.
      assertWorkspaceManagement(actor, input.actorId, input.role);
      const now = nowIso();
      await trx.updateTable("workspace_members").set({ role: input.role, updated_at: now })
        .where("id", "=", target.id).where("removed_at", "is", null).where("role", "!=", "owner").execute();
      return workspaceMemberFromRow({ ...target, role: input.role, updated_at: now });
    });
  }

  /**
   * Workspace departure immediately removes all non-owner Room memberships.
   * A human who owns a Room must transfer that Room first, preserving the
   * single-owner invariant instead of inventing an implicit recovery owner.
   */
  async removeWorkspaceMember(input: { participantId: string; actorId: string }): Promise<WorkspaceMemberRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      await lockWorkspace(trx);
      const actor = await requireActiveWorkspaceMember(trx, input.actorId);
      const target = await activeWorkspaceMember(trx, input.participantId);
      if (!target) return undefined;
      if (target.role === "owner") throw new Error("workspace_owner_transfer_required");
      assertWorkspaceManagement(actor, input.actorId, target.role as WorkspaceRole);
      const ownedRoom = await trx.selectFrom("room_members").select("room_id")
        .where("participant_id", "=", input.participantId).where("role", "=", "owner").where("removed_at", "is", null).executeTakeFirst();
      if (ownedRoom) throw new Error(`workspace_member_room_owner_transfer_required:${ownedRoom.room_id}`);
      const now = nowIso();
      await trx.updateTable("room_members").set({ removed_at: now, removed_by_participant_id: input.actorId, updated_at: now })
        .where("participant_id", "=", input.participantId).where("removed_at", "is", null).where("role", "!=", "owner").execute();
      await trx.updateTable("workspace_members").set({ removed_at: now, removed_by_participant_id: input.actorId, updated_at: now })
        .where("id", "=", target.id).where("removed_at", "is", null).where("role", "!=", "owner").execute();
      return workspaceMemberFromRow({ ...target, removed_at: now, removed_by_participant_id: input.actorId, updated_at: now });
    });
  }

  async transferWorkspaceOwnership(input: { fromParticipantId: string; toParticipantId: string; actorId: string }): Promise<{ previousOwner: WorkspaceMemberRecord; owner: WorkspaceMemberRecord }> {
    return this.db.transaction().execute(async (trx) => {
      await lockWorkspace(trx);
      const previous = await activeWorkspaceOwner(trx);
      if (!previous || previous.participant_id !== input.fromParticipantId || input.actorId !== input.fromParticipantId) {
        throw new Error("workspace_owner_transfer_source_invalid");
      }
      assertWorkspaceAction(previous, input.actorId, "transfer_ownership");
      const next = await requireActiveWorkspaceMember(trx, input.toParticipantId);
      const now = nowIso();
      // Both writes are invisible until this transaction commits. The active
      // owner partial index also rejects a second Owner on future edits.
      await trx.updateTable("workspace_members").set({ role: "admin", updated_at: now }).where("id", "=", previous.id).execute();
      await trx.updateTable("workspace_members").set({ role: "owner", updated_at: now }).where("id", "=", next.id).execute();
      return {
        previousOwner: workspaceMemberFromRow({ ...previous, role: "admin", updated_at: now }),
        owner: workspaceMemberFromRow({ ...next, role: "owner", updated_at: now })
      };
    });
  }

  async getRoomMember(roomId: string, participantId: string): Promise<RoomMemberRecord | undefined> {
    const row = await activeRoomMember(this.db, roomId, participantId);
    return row ? roomMemberFromRow(row) : undefined;
  }

  async listRoomMembers(roomId: string, input: { includeRemoved?: boolean } = {}): Promise<RoomMemberRecord[]> {
    let query = this.db.selectFrom("room_members").selectAll().where("room_id", "=", roomId);
    if (!input.includeRemoved) query = query.where("removed_at", "is", null);
    return (await query.orderBy("joined_at", "asc").execute()).map(roomMemberFromRow);
  }

  async addRoomMember(input: { roomId: string; participantId: string; role: Exclude<RoomHumanRole, "owner">; actorId: string }): Promise<RoomMemberRecord> {
    assertHumanParticipantId(input.participantId, "room_member_participant_id_invalid");
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.roomId);
      const actor = await requireCurrentRoomHuman(trx, input.roomId, input.actorId);
      assertRoomManagement(actor, input.actorId, input.role);
      await requireActiveWorkspaceMember(trx, input.participantId);
      if (await activeRoomMember(trx, input.roomId, input.participantId)) throw new Error(`room_member_already_active:${input.roomId}:${input.participantId}`);
      return insertRoomMember(trx, { ...input, now: nowIso() });
    });
  }

  async changeRoomMemberRole(input: { roomId: string; participantId: string; role: Exclude<RoomHumanRole, "owner">; actorId: string }): Promise<RoomMemberRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.roomId);
      const actor = await requireCurrentRoomHuman(trx, input.roomId, input.actorId);
      const target = await activeRoomMember(trx, input.roomId, input.participantId);
      if (!target) return undefined;
      if (target.role === "owner") throw new Error("room_owner_transfer_required");
      assertRoomManagement(actor, input.actorId, target.role as RoomHumanRole);
      assertRoomManagement(actor, input.actorId, input.role);
      const now = nowIso();
      await trx.updateTable("room_members").set({ role: input.role, updated_at: now })
        .where("id", "=", target.id).where("removed_at", "is", null).where("role", "!=", "owner").execute();
      return roomMemberFromRow({ ...target, role: input.role, updated_at: now });
    });
  }

  async removeRoomMember(input: { roomId: string; participantId: string; actorId: string }): Promise<RoomMemberRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.roomId);
      const actor = await requireCurrentRoomHuman(trx, input.roomId, input.actorId);
      const target = await activeRoomMember(trx, input.roomId, input.participantId);
      if (!target) return undefined;
      if (target.role === "owner") throw new Error("room_owner_transfer_required");
      assertRoomManagement(actor, input.actorId, target.role as RoomHumanRole);
      const now = nowIso();
      await trx.updateTable("room_members").set({ removed_at: now, removed_by_participant_id: input.actorId, updated_at: now })
        .where("id", "=", target.id).where("removed_at", "is", null).where("role", "!=", "owner").execute();
      return roomMemberFromRow({ ...target, removed_at: now, removed_by_participant_id: input.actorId, updated_at: now });
    });
  }

  async transferRoomOwnership(input: { roomId: string; fromParticipantId: string; toParticipantId: string; actorId: string }): Promise<{ previousOwner: RoomMemberRecord; owner: RoomMemberRecord }> {
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.roomId);
      const previous = await activeRoomOwner(trx, input.roomId);
      if (!previous || previous.participant_id !== input.fromParticipantId || input.actorId !== input.fromParticipantId) {
        throw new Error("room_owner_transfer_source_invalid");
      }
      await requireActiveWorkspaceMember(trx, input.actorId);
      assertRoomAction(previous, input.actorId, "transfer_ownership");
      await requireActiveWorkspaceMember(trx, input.toParticipantId);
      const next = await requireActiveRoomMember(trx, input.roomId, input.toParticipantId);
      const now = nowIso();
      await trx.updateTable("room_members").set({ role: "admin", updated_at: now }).where("id", "=", previous.id).execute();
      await trx.updateTable("room_members").set({ role: "owner", updated_at: now }).where("id", "=", next.id).execute();
      return {
        previousOwner: roomMemberFromRow({ ...previous, role: "admin", updated_at: now }),
        owner: roomMemberFromRow({ ...next, role: "owner", updated_at: now })
      };
    });
  }

  async recoverOwnerlessRoom(input: { roomId: string; ownerParticipantId: string; actorId: string }): Promise<RoomMemberRecord> {
    assertHumanParticipantId(input.ownerParticipantId, "room_owner_participant_id_invalid");
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.roomId);
      const actor = await requireActiveWorkspaceMember(trx, input.actorId);
      assertWorkspaceAction(actor, input.actorId, "recover_ownerless_room");
      if (await activeRoomOwner(trx, input.roomId)) throw new Error(`room_owner_already_exists:${input.roomId}`);
      await requireActiveWorkspaceMember(trx, input.ownerParticipantId);
      const current = await activeRoomMember(trx, input.roomId, input.ownerParticipantId);
      const now = nowIso();
      if (current) {
        await trx.updateTable("room_members").set({ role: "owner", updated_at: now }).where("id", "=", current.id).execute();
        return roomMemberFromRow({ ...current, role: "owner", updated_at: now });
      }
      return insertRoomMember(trx, {
        roomId: input.roomId,
        participantId: input.ownerParticipantId,
        role: "owner",
        actorId: input.actorId,
        now
      });
    });
  }

  async listOwnerlessRoomIds(): Promise<string[]> {
    const result = await sql<{ id: string }>`SELECT rooms.id
      FROM rooms
      WHERE NOT EXISTS (
        SELECT 1 FROM room_members
        WHERE room_members.room_id = rooms.id
          AND room_members.role = 'owner'
          AND room_members.removed_at IS NULL
      )
      ORDER BY rooms.updated_at DESC`.execute(this.db);
    return result.rows.map((row) => row.id);
  }

  async getRoomAgent(roomId: string, agentId: string): Promise<RoomAgentPermissionRecord | undefined> {
    const row = await activeRoomAgent(this.db, roomId, agentId);
    return row ? roomAgentFromRow(row) : undefined;
  }

  async listRoomAgents(roomId: string, input: { includeRemoved?: boolean } = {}): Promise<RoomAgentPermissionRecord[]> {
    let query = this.db.selectFrom("room_agents").selectAll().where("room_id", "=", roomId);
    if (!input.includeRemoved) query = query.where("removed_at", "is", null);
    return (await query.orderBy("joined_at", "asc").execute()).map(roomAgentFromRow);
  }

  async setRoomAgentPermissions(input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean; actorId: string }): Promise<RoomAgentPermissionRecord> {
    if ((input.canEdit || input.canExecute) && !input.canView) throw new Error("room_agent_view_required");
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.roomId);
      const actor = await requireCurrentRoomHuman(trx, input.roomId, input.actorId);
      assertRoomManagement(actor, input.actorId, undefined, "agent");
      await requireAgent(trx, input.agentId);
      const current = await activeRoomAgent(trx, input.roomId, input.agentId);
      const now = nowIso();
      if (!current) return insertRoomAgent(trx, { ...input, now });
      await trx.updateTable("room_agents").set({
        can_view: input.canView ? 1 : 0,
        can_edit: input.canEdit ? 1 : 0,
        can_execute: input.canExecute ? 1 : 0,
        updated_at: now
      }).where("id", "=", current.id).where("removed_at", "is", null).execute();
      return roomAgentFromRow({
        ...current,
        can_view: input.canView ? 1 : 0,
        can_edit: input.canEdit ? 1 : 0,
        can_execute: input.canExecute ? 1 : 0,
        updated_at: now
      });
    });
  }

  async removeRoomAgent(input: { roomId: string; agentId: string; actorId: string }): Promise<RoomAgentPermissionRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.roomId);
      const actor = await requireCurrentRoomHuman(trx, input.roomId, input.actorId);
      assertRoomManagement(actor, input.actorId, undefined, "agent");
      const current = await activeRoomAgent(trx, input.roomId, input.agentId);
      if (!current) return undefined;
      const now = nowIso();
      await trx.updateTable("room_agents").set({ removed_at: now, removed_by_participant_id: input.actorId, updated_at: now })
        .where("id", "=", current.id).where("removed_at", "is", null).execute();
      return roomAgentFromRow({ ...current, removed_at: now, removed_by_participant_id: input.actorId, updated_at: now });
    });
  }

  async getAgentWorkspacePermission(agentId: string, permission: AgentWorkspacePermission = "room.create"): Promise<AgentWorkspacePermissionRecord | undefined> {
    const row = await this.db.selectFrom("agent_workspace_permissions").selectAll()
      .where("agent_id", "=", agentId).where("permission", "=", permission).where("revoked_at", "is", null).executeTakeFirst();
    return row ? agentWorkspacePermissionFromRow(row) : undefined;
  }

  async setAgentWorkspacePermission(input: { agentId: string; permission: AgentWorkspacePermission; allowed: boolean; actorId: string }): Promise<AgentWorkspacePermissionRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      await lockWorkspace(trx);
      const actor = await requireActiveWorkspaceMember(trx, input.actorId);
      assertWorkspaceAction(actor, input.actorId, "manage_agent_room_create");
      await requireAgent(trx, input.agentId);
      const current = await activeAgentWorkspacePermission(trx, input.agentId, input.permission);
      if (input.allowed && current) return agentWorkspacePermissionFromRow(current);
      if (!input.allowed && !current) return undefined;
      const now = nowIso();
      if (!input.allowed && current) {
        await trx.updateTable("agent_workspace_permissions").set({ revoked_at: now, revoked_by_participant_id: input.actorId, updated_at: now })
          .where("id", "=", current.id).where("revoked_at", "is", null).execute();
        return agentWorkspacePermissionFromRow({ ...current, revoked_at: now, revoked_by_participant_id: input.actorId, updated_at: now });
      }
      return insertAgentWorkspacePermission(trx, { agentId: input.agentId, permission: input.permission, actorId: input.actorId, now });
    });
  }

  async getResourceAccessBoundary(resourceKind: string, resourceId: string): Promise<ResourceAccessBoundaryRecord | undefined> {
    if (!isRoomShareableResourceKind(resourceKind)) return undefined;
    const row = await this.db.selectFrom("resource_access_boundaries").selectAll()
      .where("resource_kind", "=", resourceKind).where("resource_id", "=", resourceId).executeTakeFirst();
    return row ? resourceBoundaryFromRow(row) : undefined;
  }

  /** Records provenance without moving or copying the underlying resource. */
  async ensureResourceAccessBoundary(input: {
    resourceKind: RoomShareableResourceKind;
    resourceId: string;
    sourceRoomId: string;
    ownerParticipantId: string;
    creatorParticipantId?: string;
    resourceCreatedAt?: string;
    actorId: string;
  }): Promise<ResourceAccessBoundaryRecord> {
    if (!input.resourceId.trim()) throw new Error("resource_access_boundary_resource_id_required");
    assertHumanParticipantId(input.ownerParticipantId, "resource_access_boundary_owner_invalid");
    assertHumanParticipantId(input.actorId, "resource_access_boundary_actor_invalid");
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.sourceRoomId);
      const actor = await requireCurrentRoomHuman(trx, input.sourceRoomId, input.actorId);
      assertRoomAction(actor.room, input.actorId, "edit");
      if (input.ownerParticipantId !== input.actorId) await requireActiveWorkspaceMember(trx, input.ownerParticipantId);
      const existing = await resourceBoundary(trx, input.resourceKind, input.resourceId);
      if (existing) {
        if (existing.source_room_id !== input.sourceRoomId) throw new Error("resource_access_boundary_source_conflict");
        return resourceBoundaryFromRow(existing);
      }
      const now = nowIso();
      const record: ResourceAccessBoundaryRecord = {
        id: createId("resource-boundary"),
        resource_kind: input.resourceKind,
        resource_id: input.resourceId,
        source_room_id: input.sourceRoomId,
        owner_participant_id: input.ownerParticipantId,
        ...(input.creatorParticipantId ? { creator_participant_id: input.creatorParticipantId } : {}),
        ...(input.resourceCreatedAt ? { resource_created_at: input.resourceCreatedAt } : {}),
        boundary_registered_at: now,
        updated_at: now
      };
      await trx.insertInto("resource_access_boundaries").values({
        ...record,
        creator_participant_id: record.creator_participant_id ?? null,
        resource_created_at: record.resource_created_at ?? null
      }).execute();
      return record;
    });
  }

  async listRoomResourceShares(resourceAccessBoundaryId: string, input: { includeRevoked?: boolean } = {}): Promise<RoomResourceShareRecord[]> {
    let query = this.db.selectFrom("room_resource_shares").selectAll().where("resource_access_boundary_id", "=", resourceAccessBoundaryId);
    if (!input.includeRevoked) query = query.where("revoked_at", "is", null);
    return (await query.orderBy("created_at", "asc").execute()).map(roomResourceShareFromRow);
  }

  async shareResource(input: { resourceAccessBoundaryId: string; sourceRoomId: string; targetRoomId: string; actorId: string }): Promise<RoomResourceShareRecord> {
    if (input.sourceRoomId === input.targetRoomId) throw new Error("room_resource_share_same_room");
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.sourceRoomId);
      await lockRoom(trx, input.targetRoomId);
      const sourceActor = await requireCurrentRoomHuman(trx, input.sourceRoomId, input.actorId);
      const targetActor = await requireCurrentRoomHuman(trx, input.targetRoomId, input.actorId);
      assertRoomAction(sourceActor.room, input.actorId, "share");
      assertRoomAction(targetActor.room, input.actorId, "share");
      const boundary = await trx.selectFrom("resource_access_boundaries").selectAll().where("id", "=", input.resourceAccessBoundaryId).executeTakeFirst();
      if (!boundary || boundary.source_room_id !== input.sourceRoomId) throw new Error("room_resource_share_source_invalid");
      const current = await activeRoomResourceShare(trx, input.resourceAccessBoundaryId, input.targetRoomId);
      if (current) return roomResourceShareFromRow(current);
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
      await trx.insertInto("room_resource_shares").values({ ...record, revoked_at: null, revoked_by_participant_id: null }).execute();
      return record;
    });
  }

  async revokeRoomResourceShare(input: { resourceAccessBoundaryId: string; sourceRoomId: string; targetRoomId: string; actorId: string }): Promise<RoomResourceShareRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      await lockRoom(trx, input.sourceRoomId);
      await lockRoom(trx, input.targetRoomId);
      const sourceActor = await requireCurrentRoomHuman(trx, input.sourceRoomId, input.actorId);
      const targetActor = await requireCurrentRoomHuman(trx, input.targetRoomId, input.actorId);
      assertRoomAction(sourceActor.room, input.actorId, "share");
      assertRoomAction(targetActor.room, input.actorId, "share");
      const boundary = await trx.selectFrom("resource_access_boundaries").selectAll().where("id", "=", input.resourceAccessBoundaryId).executeTakeFirst();
      if (!boundary || boundary.source_room_id !== input.sourceRoomId) throw new Error("room_resource_share_source_invalid");
      const current = await activeRoomResourceShare(trx, input.resourceAccessBoundaryId, input.targetRoomId);
      if (!current) return undefined;
      const now = nowIso();
      await trx.updateTable("room_resource_shares").set({ revoked_at: now, revoked_by_participant_id: input.actorId, updated_at: now })
        .where("id", "=", current.id).where("revoked_at", "is", null).execute();
      return roomResourceShareFromRow({ ...current, revoked_at: now, revoked_by_participant_id: input.actorId, updated_at: now });
    });
  }

  async getResourceAccessMode(input: { resourceKind: string; resourceId: string; roomId: string; participantId: string }): Promise<ResourceAccessMode> {
    const boundary = await this.getResourceAccessBoundary(input.resourceKind, input.resourceId);
    // Resources from before Core 06 are deliberately not given an inferred
    // Room. Only the current Workspace Owner can use them until a later edit
    // or explicit share records their real origin.
    if (!boundary) return (await activeWorkspaceOwner(this.db))?.participant_id === input.participantId ? "legacy_owner" : "denied";
    if (boundary.source_room_id === input.roomId) return "source";
    const share = await activeRoomResourceShare(this.db, boundary.id, input.roomId);
    return share ? "shared" : "denied";
  }

  /** Compatibility helper; mutation callers must use `getResourceAccessMode`. */
  async isResourceAvailableInRoom(input: { resourceKind: string; resourceId: string; roomId: string; participantId: string }): Promise<boolean> {
    return (await this.getResourceAccessMode(input)) !== "denied";
  }

  /** Candidate IDs come only from Room boundaries, never UsageScope. */
  async listResourceIdsAvailableInRoom(input: { resourceKind: string; roomId: string }): Promise<string[]> {
    if (!isRoomShareableResourceKind(input.resourceKind)) return [];
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

  /** Workspace removal cannot leave an old Room membership visible here. */
  async listRoomIdsForHuman(participantId: string): Promise<string[]> {
    return (await this.db.selectFrom("room_members as room_member")
      .innerJoin("workspace_members as workspace_member", (join) => join
        .onRef("workspace_member.participant_id", "=", "room_member.participant_id")
        .on("workspace_member.removed_at", "is", null))
      .select("room_member.room_id")
      .where("room_member.participant_id", "=", participantId).where("room_member.removed_at", "is", null).execute())
      .map((row) => row.room_id);
  }

  async listRoomIdsForAgent(agentId: string): Promise<string[]> {
    return (await this.db.selectFrom("room_agents").select("room_id")
      .where("agent_id", "=", agentId).where("removed_at", "is", null).where("can_view", "=", 1).execute()).map((row) => row.room_id);
  }
}

async function lockWorkspace(db: DbExecutor): Promise<void> {
  await sql`UPDATE workspace_members SET updated_at = updated_at WHERE role = ${"owner"} AND removed_at IS NULL`.execute(db);
}

async function lockRoom(db: DbExecutor, roomId: string): Promise<void> {
  await sql`UPDATE rooms SET updated_at = updated_at WHERE id = ${roomId}`.execute(db);
  const room = await db.selectFrom("rooms").select("id").where("id", "=", roomId).executeTakeFirst();
  if (!room) throw new Error(`room_not_found:${roomId}`);
}

async function activeWorkspaceOwner(db: DbExecutor) {
  return db.selectFrom("workspace_members").selectAll().where("role", "=", "owner").where("removed_at", "is", null).executeTakeFirst();
}

async function activeWorkspaceMember(db: DbExecutor, participantId: string) {
  return db.selectFrom("workspace_members").selectAll().where("participant_id", "=", participantId).where("removed_at", "is", null).executeTakeFirst();
}

async function requireActiveWorkspaceMember(db: DbExecutor, participantId: string) {
  assertHumanParticipantId(participantId, "workspace_member_participant_id_invalid");
  const member = await activeWorkspaceMember(db, participantId);
  if (!member) throw new Error(`workspace_member_not_active:${participantId}`);
  return member;
}

async function activeRoomOwner(db: DbExecutor, roomId: string) {
  return db.selectFrom("room_members").selectAll().where("room_id", "=", roomId).where("role", "=", "owner").where("removed_at", "is", null).executeTakeFirst();
}

async function activeRoomMember(db: DbExecutor, roomId: string, participantId: string) {
  return db.selectFrom("room_members").selectAll().where("room_id", "=", roomId).where("participant_id", "=", participantId).where("removed_at", "is", null).executeTakeFirst();
}

async function requireActiveRoomMember(db: DbExecutor, roomId: string, participantId: string) {
  const member = await activeRoomMember(db, roomId, participantId);
  if (!member) throw new Error(`room_member_not_active:${roomId}:${participantId}`);
  return member;
}

async function requireCurrentRoomHuman(db: DbExecutor, roomId: string, participantId: string) {
  const workspace = await requireActiveWorkspaceMember(db, participantId);
  const room = await requireActiveRoomMember(db, roomId, participantId);
  return { workspace, room };
}

async function activeRoomAgent(db: DbExecutor, roomId: string, agentId: string) {
  return db.selectFrom("room_agents").selectAll().where("room_id", "=", roomId).where("agent_id", "=", agentId).where("removed_at", "is", null).executeTakeFirst();
}

async function activeAgentWorkspacePermission(db: DbExecutor, agentId: string, permission: AgentWorkspacePermission) {
  return db.selectFrom("agent_workspace_permissions").selectAll()
    .where("agent_id", "=", agentId).where("permission", "=", permission).where("revoked_at", "is", null).executeTakeFirst();
}

async function activeRoomResourceShare(db: DbExecutor, resourceAccessBoundaryId: string, targetRoomId: string) {
  return db.selectFrom("room_resource_shares").selectAll().where("resource_access_boundary_id", "=", resourceAccessBoundaryId)
    .where("target_room_id", "=", targetRoomId).where("revoked_at", "is", null).executeTakeFirst();
}

async function resourceBoundary(db: DbExecutor, resourceKind: RoomShareableResourceKind, resourceId: string) {
  return db.selectFrom("resource_access_boundaries").selectAll().where("resource_kind", "=", resourceKind).where("resource_id", "=", resourceId).executeTakeFirst();
}

async function requireAgent(db: DbExecutor, agentId: string) {
  const agent = await db.selectFrom("agents").select("id").where("id", "=", agentId).executeTakeFirst();
  if (!agent) throw new Error(`agent_not_found:${agentId}`);
  return agent;
}

function assertWorkspaceAction(record: WorkspaceDb["workspace_members"], participantId: string, action: "create_room" | "manage_agent_room_create" | "transfer_ownership" | "recover_ownerless_room"): void {
  const decision = evaluateWorkspacePermission({
    principal: { kind: "human", participantId },
    action,
    membership: { participantId: record.participant_id, role: record.role as WorkspaceRole }
  });
  if (!decision.allowed) throw new Error(`workspace_permission_denied:${action}:${decision.reason}`);
}

function assertWorkspaceManagement(actor: WorkspaceDb["workspace_members"], actorId: string, targetRole: WorkspaceRole): void {
  const decision = evaluateWorkspacePermission({
    principal: { kind: "human", participantId: actorId },
    action: "manage_members",
    membership: { participantId: actor.participant_id, role: actor.role as WorkspaceRole }
  });
  if (!decision.allowed) throw new Error(`workspace_permission_denied:manage_members:${decision.reason}`);
  const target = canManageWorkspaceTarget({ actorRole: actor.role as WorkspaceRole, targetRole });
  if (!target.allowed) throw new Error(`workspace_permission_denied:manage_members:${target.reason}`);
}

function assertRoomAction(record: WorkspaceDb["room_members"], participantId: string, action: "edit" | "share" | "transfer_ownership"): void {
  const decision = evaluateRoomPermission({
    principal: { kind: "human", participantId },
    action,
    humanMembership: { participantId: record.participant_id, role: record.role as RoomHumanRole }
  });
  if (!decision.allowed) throw new Error(`room_permission_denied:${action}:${decision.reason}`);
}

function assertRoomManagement(
  actor: { room: WorkspaceDb["room_members"] },
  actorId: string,
  targetRole?: RoomHumanRole,
  targetKind: "human" | "agent" = "human"
): void {
  const decision = evaluateRoomPermission({
    principal: { kind: "human", participantId: actorId },
    action: "manage_members",
    humanMembership: { participantId: actor.room.participant_id, role: actor.room.role as RoomHumanRole }
  });
  if (!decision.allowed) throw new Error(`room_permission_denied:manage_members:${decision.reason}`);
  const target = canManageRoomTarget({ actorRole: actor.room.role as RoomHumanRole, targetKind, ...(targetRole ? { targetRole } : {}) });
  if (!target.allowed) throw new Error(`room_permission_denied:manage_members:${target.reason}`);
}

function assertHumanParticipantId(participantId: string, errorCode: string): void {
  if (!isHumanParticipantId(participantId)) throw new Error(errorCode);
}

async function insertWorkspaceMember(db: DbExecutor, input: { participantId: string; role: WorkspaceRole; actorId: string; now: string }): Promise<WorkspaceMemberRecord> {
  const record: WorkspaceMemberRecord = {
    id: createId("workspace-member"),
    participant_id: input.participantId,
    role: input.role,
    joined_at: input.now,
    created_by_participant_id: input.actorId,
    updated_at: input.now
  };
  await db.insertInto("workspace_members").values({ ...record, removed_at: null, removed_by_participant_id: null }).execute();
  return record;
}

async function insertRoomMember(db: DbExecutor, input: { roomId: string; participantId: string; role: RoomHumanRole; actorId: string; now: string }): Promise<RoomMemberRecord> {
  const record: RoomMemberRecord = {
    id: createId("room-member"),
    room_id: input.roomId,
    participant_id: input.participantId,
    role: input.role,
    joined_at: input.now,
    created_by_participant_id: input.actorId,
    updated_at: input.now
  };
  await db.insertInto("room_members").values({ ...record, removed_at: null, removed_by_participant_id: null }).execute();
  return record;
}

async function insertRoomAgent(db: DbExecutor, input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean; actorId: string; now: string }): Promise<RoomAgentPermissionRecord> {
  const record: RoomAgentPermissionRecord = {
    id: createId("room-agent"),
    room_id: input.roomId,
    agent_id: input.agentId,
    can_view: input.canView,
    can_edit: input.canEdit,
    can_execute: input.canExecute,
    joined_at: input.now,
    created_by_participant_id: input.actorId,
    updated_at: input.now
  };
  await db.insertInto("room_agents").values({
    ...record,
    can_view: record.can_view ? 1 : 0,
    can_edit: record.can_edit ? 1 : 0,
    can_execute: record.can_execute ? 1 : 0,
    removed_at: null,
    removed_by_participant_id: null
  }).execute();
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
    id: row.id,
    participant_id: row.participant_id,
    role: row.role as WorkspaceRole,
    joined_at: row.joined_at,
    ...(row.removed_at ? { removed_at: row.removed_at } : {}),
    created_by_participant_id: row.created_by_participant_id,
    ...(row.removed_by_participant_id ? { removed_by_participant_id: row.removed_by_participant_id } : {}),
    updated_at: row.updated_at
  };
}

function roomMemberFromRow(row: WorkspaceDb["room_members"]): RoomMemberRecord {
  return {
    id: row.id,
    room_id: row.room_id,
    participant_id: row.participant_id,
    role: row.role as RoomHumanRole,
    joined_at: row.joined_at,
    ...(row.removed_at ? { removed_at: row.removed_at } : {}),
    created_by_participant_id: row.created_by_participant_id,
    ...(row.removed_by_participant_id ? { removed_by_participant_id: row.removed_by_participant_id } : {}),
    updated_at: row.updated_at
  };
}

function roomAgentFromRow(row: WorkspaceDb["room_agents"]): RoomAgentPermissionRecord {
  return {
    id: row.id,
    room_id: row.room_id,
    agent_id: row.agent_id,
    can_view: row.can_view === 1,
    can_edit: row.can_edit === 1,
    can_execute: row.can_execute === 1,
    joined_at: row.joined_at,
    ...(row.removed_at ? { removed_at: row.removed_at } : {}),
    created_by_participant_id: row.created_by_participant_id,
    ...(row.removed_by_participant_id ? { removed_by_participant_id: row.removed_by_participant_id } : {}),
    updated_at: row.updated_at
  };
}

function agentWorkspacePermissionFromRow(row: WorkspaceDb["agent_workspace_permissions"]): AgentWorkspacePermissionRecord {
  return {
    id: row.id,
    agent_id: row.agent_id,
    permission: row.permission as AgentWorkspacePermission,
    granted_at: row.granted_at,
    ...(row.revoked_at ? { revoked_at: row.revoked_at } : {}),
    granted_by_participant_id: row.granted_by_participant_id,
    ...(row.revoked_by_participant_id ? { revoked_by_participant_id: row.revoked_by_participant_id } : {}),
    updated_at: row.updated_at
  };
}

function resourceBoundaryFromRow(row: WorkspaceDb["resource_access_boundaries"]): ResourceAccessBoundaryRecord {
  return {
    id: row.id,
    resource_kind: row.resource_kind as RoomShareableResourceKind,
    resource_id: row.resource_id,
    source_room_id: row.source_room_id,
    owner_participant_id: row.owner_participant_id,
    ...(row.creator_participant_id ? { creator_participant_id: row.creator_participant_id } : {}),
    ...(row.resource_created_at ? { resource_created_at: row.resource_created_at } : {}),
    boundary_registered_at: row.boundary_registered_at,
    updated_at: row.updated_at
  };
}

function roomResourceShareFromRow(row: WorkspaceDb["room_resource_shares"]): RoomResourceShareRecord {
  return {
    id: row.id,
    resource_access_boundary_id: row.resource_access_boundary_id,
    source_room_id: row.source_room_id,
    target_room_id: row.target_room_id,
    shared_by_participant_id: row.shared_by_participant_id,
    created_at: row.created_at,
    ...(row.revoked_at ? { revoked_at: row.revoked_at } : {}),
    ...(row.revoked_by_participant_id ? { revoked_by_participant_id: row.revoked_by_participant_id } : {}),
    updated_at: row.updated_at
  };
}
