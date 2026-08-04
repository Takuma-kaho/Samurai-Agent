import {
  AgentRecordSchema,
  RoomRecordSchema,
  createId,
  nowIso,
  type AgentRecord,
  type RoomRecord
} from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import type {
  AgentWorkspacePermissionRecord,
  ResourceAccessBoundaryRecord,
  RoomAgentPermissionRecord,
  RoomMemberRecord,
  RoomResourceShareRecord,
  WorkspaceMemberRecord,
  WorkspaceStore
} from "@samurai-agent/workspace-store";
import type { RoomHumanRole, WorkspaceRole } from "@samurai-agent/room-permissions";
import { RoomAuthorizationService } from "./room-authorization-service.js";

export type RoomAgentStorePort = Pick<WorkspaceStore,
  | "createRoomWithOwner"
  | "getRoom"
  | "listRooms"
  | "patchRoom"
  | "createAgent"
  | "getAgent"
  | "listAgents"
  | "patchAgent"
  | "bindAgentBackend"
  | "getWorkspaceMember"
  | "listWorkspaceMembers"
  | "addWorkspaceMember"
  | "changeWorkspaceMemberRole"
  | "removeWorkspaceMember"
  | "transferWorkspaceOwnership"
  | "getRoomMember"
  | "listRoomMembers"
  | "addRoomMember"
  | "changeRoomMemberRole"
  | "removeRoomMember"
  | "transferRoomOwnership"
  | "recoverOwnerlessRoom"
  | "listRoomAgents"
  | "setRoomAgentPermissions"
  | "removeRoomAgent"
  | "setAgentWorkspacePermission"
  | "getResourceAccessBoundary"
  | "ensureResourceAccessBoundary"
  | "listRoomResourceShares"
  | "shareResource"
  | "revokeRoomResourceShare"
>;

export interface RoomParticipantList {
  humans: RoomMemberRecord[];
  agents: RoomAgentPermissionRecord[];
}

/**
 * Domain API for Room participation and Agent identity.
 *
 * Every method receives a server-built context. Actor IDs are intentionally
 * absent from every public DTO: the authorization adapter reads only current
 * membership rows and the persisted Run requester.
 */
export class RoomAgentDomainService {
  constructor(
    private readonly store: RoomAgentStorePort,
    private readonly authorization: RoomAuthorizationService,
    private readonly backendRegistered: (backendId: string) => boolean,
    private readonly requestError: (code: "not_found" | "conflict" | "forbidden", message: string) => Error
  ) {}

  async createRoom(context: TrustedDomainContext, input: { name: string }): Promise<RoomRecord> {
    const principal = this.principal(context);
    if (principal.kind === "agent") {
      await this.authorization.assertWorkspace(principal, "create_room");
      await this.authorization.assertWorkspace({ kind: "human", participantId: principal.requestedByParticipantId }, "create_room");
    } else {
      await this.authorization.assertWorkspace(principal, "create_room");
    }
    const now = nowIso();
    const ownerParticipantId = principal.kind === "agent" ? principal.requestedByParticipantId : principal.participantId;
    return this.store.createRoomWithOwner(RoomRecordSchema.parse({
      id: createId("room"), name: input.name, created_at: now, updated_at: now
    }), ownerParticipantId);
  }

  async patchRoom(context: TrustedDomainContext, input: { id: string; name: string }): Promise<RoomRecord> {
    await this.authorization.assertRoom(this.principal(context), input.id, "manage_settings");
    const room = await this.store.patchRoom(input);
    if (!room) throw this.requestError("not_found", `room_not_found:${input.id}`);
    return room;
  }

  async listRooms(context: TrustedDomainContext): Promise<RoomRecord[]> {
    const visible = await this.authorization.visibleRoomIds(this.principal(context));
    return (await this.store.listRooms()).filter((room) => visible.has(room.id));
  }

  async viewRoom(context: TrustedDomainContext, id: string): Promise<RoomRecord> {
    await this.authorization.assertRoom(this.principal(context), id, "read");
    const room = await this.store.getRoom(id);
    if (!room) throw this.requestError("not_found", `room_not_found:${id}`);
    return room;
  }

  async listWorkspaceMembers(context: TrustedDomainContext): Promise<WorkspaceMemberRecord[]> {
    await this.authorization.assertWorkspace(this.principal(context), "manage_members");
    return this.store.listWorkspaceMembers();
  }

  async addWorkspaceMember(context: TrustedDomainContext, input: { participantId: string; role: Exclude<WorkspaceRole, "owner"> }): Promise<WorkspaceMemberRecord> {
    const principal = this.principal(context);
    await this.authorization.assertWorkspaceMemberManagement({ principal, targetRole: input.role });
    return this.store.addWorkspaceMember({ ...input, actorId: principal.participantId });
  }

  async changeWorkspaceMemberRole(context: TrustedDomainContext, input: { participantId: string; role: Exclude<WorkspaceRole, "owner"> }): Promise<WorkspaceMemberRecord> {
    const principal = this.principal(context);
    const target = await this.store.getWorkspaceMember(input.participantId);
    if (!target) throw this.requestError("not_found", `workspace_member_not_found:${input.participantId}`);
    await this.authorization.assertWorkspaceMemberManagement({ principal, targetRole: target.role });
    await this.authorization.assertWorkspaceMemberManagement({ principal, targetRole: input.role });
    const changed = await this.store.changeWorkspaceMemberRole({ ...input, actorId: principal.participantId });
    if (!changed) throw this.requestError("not_found", `workspace_member_not_found:${input.participantId}`);
    return changed;
  }

  async removeWorkspaceMember(context: TrustedDomainContext, participantId: string): Promise<WorkspaceMemberRecord> {
    const principal = this.principal(context);
    const target = await this.store.getWorkspaceMember(participantId);
    if (!target) throw this.requestError("not_found", `workspace_member_not_found:${participantId}`);
    await this.authorization.assertWorkspaceMemberManagement({ principal, targetRole: target.role });
    const removed = await this.store.removeWorkspaceMember({ participantId, actorId: principal.participantId });
    if (!removed) throw this.requestError("not_found", `workspace_member_not_found:${participantId}`);
    return removed;
  }

  async transferWorkspaceOwnership(context: TrustedDomainContext, toParticipantId: string): Promise<{ previousOwner: WorkspaceMemberRecord; owner: WorkspaceMemberRecord }> {
    const principal = this.principal(context);
    if (principal.kind !== "human") throw this.requestError("forbidden", "workspace_owner_transfer_human_required");
    await this.authorization.assertWorkspace(principal, "transfer_ownership");
    return this.store.transferWorkspaceOwnership({
      fromParticipantId: principal.participantId,
      toParticipantId,
      actorId: principal.participantId
    });
  }

  async setAgentRoomCreatePermission(context: TrustedDomainContext, input: { agentId: string; allowed: boolean }): Promise<AgentWorkspacePermissionRecord | undefined> {
    const principal = this.principal(context);
    await this.authorization.assertWorkspace(principal, "manage_agent_room_create");
    if (!await this.store.getAgent(input.agentId)) throw this.requestError("not_found", `agent_not_found:${input.agentId}`);
    return this.store.setAgentWorkspacePermission({
      agentId: input.agentId,
      permission: "room.create",
      allowed: input.allowed,
      actorId: principal.participantId
    });
  }

  async listRoomParticipants(context: TrustedDomainContext, roomId: string): Promise<RoomParticipantList> {
    await this.authorization.assertRoom(this.principal(context), roomId, "read");
    const [humans, agents] = await Promise.all([this.store.listRoomMembers(roomId), this.store.listRoomAgents(roomId)]);
    return { humans, agents };
  }

  async addRoomMember(context: TrustedDomainContext, input: { roomId: string; participantId: string; role: Exclude<RoomHumanRole, "owner"> }): Promise<RoomMemberRecord> {
    const principal = this.principal(context);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "human", targetRole: input.role });
    return this.store.addRoomMember({ ...input, actorId: principal.participantId });
  }

  async changeRoomMemberRole(context: TrustedDomainContext, input: { roomId: string; participantId: string; role: Exclude<RoomHumanRole, "owner"> }): Promise<RoomMemberRecord> {
    const principal = this.principal(context);
    const target = await this.store.getRoomMember(input.roomId, input.participantId);
    if (!target) throw this.requestError("not_found", `room_member_not_found:${input.roomId}:${input.participantId}`);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "human", targetRole: target.role });
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "human", targetRole: input.role });
    const changed = await this.store.changeRoomMemberRole(input);
    if (!changed) throw this.requestError("not_found", `room_member_not_found:${input.roomId}:${input.participantId}`);
    return changed;
  }

  async removeRoomMember(context: TrustedDomainContext, input: { roomId: string; participantId: string }): Promise<RoomMemberRecord> {
    const principal = this.principal(context);
    const target = await this.store.getRoomMember(input.roomId, input.participantId);
    if (!target) throw this.requestError("not_found", `room_member_not_found:${input.roomId}:${input.participantId}`);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "human", targetRole: target.role });
    const removed = await this.store.removeRoomMember({ ...input, actorId: principal.participantId });
    if (!removed) throw this.requestError("not_found", `room_member_not_found:${input.roomId}:${input.participantId}`);
    return removed;
  }

  async setRoomAgentPermissions(context: TrustedDomainContext, input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean }): Promise<RoomAgentPermissionRecord> {
    const principal = this.principal(context);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "agent" });
    if (!await this.store.getAgent(input.agentId)) throw this.requestError("not_found", `agent_not_found:${input.agentId}`);
    return this.store.setRoomAgentPermissions({ ...input, actorId: principal.participantId });
  }

  async removeRoomAgent(context: TrustedDomainContext, input: { roomId: string; agentId: string }): Promise<RoomAgentPermissionRecord> {
    const principal = this.principal(context);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "agent" });
    const removed = await this.store.removeRoomAgent({ ...input, actorId: principal.participantId });
    if (!removed) throw this.requestError("not_found", `room_agent_not_found:${input.roomId}:${input.agentId}`);
    return removed;
  }

  async transferRoomOwnership(context: TrustedDomainContext, input: { roomId: string; toParticipantId: string }): Promise<{ previousOwner: RoomMemberRecord; owner: RoomMemberRecord }> {
    const principal = this.principal(context);
    if (principal.kind !== "human") throw this.requestError("forbidden", "room_owner_transfer_human_required");
    await this.authorization.assertRoom(principal, input.roomId, "transfer_ownership");
    return this.store.transferRoomOwnership({ roomId: input.roomId, fromParticipantId: principal.participantId, toParticipantId: input.toParticipantId });
  }

  async recoverOwnerlessRoom(context: TrustedDomainContext, input: { roomId: string; ownerParticipantId: string }): Promise<RoomMemberRecord> {
    const principal = this.principal(context);
    await this.authorization.assertWorkspace(principal, "recover_ownerless_room");
    return this.store.recoverOwnerlessRoom(input);
  }

  async shareResource(context: TrustedDomainContext, input: { sourceRoomId: string; targetRoomId: string; resourceKind: string; resourceId: string }): Promise<RoomResourceShareRecord> {
    const principal = this.principal(context);
    if (principal.kind !== "human") throw this.requestError("forbidden", "room_share_human_required");
    await this.authorization.assertShare(principal, input.sourceRoomId, input.targetRoomId);
    await this.authorization.assertResource(principal, {
      roomId: input.sourceRoomId,
      action: "read",
      resourceKind: input.resourceKind,
      resourceId: input.resourceId
    });
    const boundary = await this.store.ensureResourceAccessBoundary({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      sourceRoomId: input.sourceRoomId,
      ownerParticipantId: principal.participantId,
      actorId: principal.participantId
    });
    return this.store.shareResource({
      resourceAccessBoundaryId: boundary.id,
      sourceRoomId: input.sourceRoomId,
      targetRoomId: input.targetRoomId,
      actorId: principal.participantId
    });
  }

  async revokeResourceShare(context: TrustedDomainContext, input: { sourceRoomId: string; targetRoomId: string; resourceKind: string; resourceId: string }): Promise<RoomResourceShareRecord> {
    const principal = this.principal(context);
    if (principal.kind !== "human") throw this.requestError("forbidden", "room_share_human_required");
    await this.authorization.assertShare(principal, input.sourceRoomId, input.targetRoomId);
    const boundary = await this.requireBoundary(input.resourceKind, input.resourceId);
    if (boundary.source_room_id !== input.sourceRoomId) throw this.requestError("conflict", "room_resource_share_source_invalid");
    const revoked = await this.store.revokeRoomResourceShare({
      resourceAccessBoundaryId: boundary.id,
      targetRoomId: input.targetRoomId,
      actorId: principal.participantId
    });
    if (!revoked) throw this.requestError("not_found", "room_resource_share_not_found");
    return revoked;
  }

  async listResourceShares(context: TrustedDomainContext, input: { sourceRoomId: string; resourceKind: string; resourceId: string }): Promise<RoomResourceShareRecord[]> {
    const principal = this.principal(context);
    if (principal.kind !== "human") throw this.requestError("forbidden", "room_share_human_required");
    await this.authorization.assertRoom(principal, input.sourceRoomId, "share");
    const boundary = await this.requireBoundary(input.resourceKind, input.resourceId);
    if (boundary.source_room_id !== input.sourceRoomId) throw this.requestError("not_found", "room_resource_boundary_not_found");
    return this.store.listRoomResourceShares(boundary.id);
  }

  async createAgent(context: TrustedDomainContext, input: { name: string; role: string; instructions: string; backendId: string; enabled?: boolean }): Promise<AgentRecord> {
    await this.authorization.assertWorkspace(this.principal(context), "manage_settings");
    this.assertBackend(input.backendId);
    const now = nowIso();
    return this.store.createAgent(AgentRecordSchema.parse({
      id: createId("agent"), name: input.name, role: input.role, instructions: input.instructions,
      backend_id: input.backendId, enabled: input.enabled ?? true, created_at: now, updated_at: now
    }));
  }

  async patchAgent(context: TrustedDomainContext, input: { id: string; name?: string; role?: string; instructions?: string; enabled?: boolean }): Promise<AgentRecord> {
    await this.authorization.assertWorkspace(this.principal(context), "manage_settings");
    const agent = await this.store.patchAgent(input);
    if (!agent) throw this.requestError("not_found", `agent_not_found:${input.id}`);
    return agent;
  }

  async bindAgentBackend(context: TrustedDomainContext, input: { id: string; backendId: string }): Promise<AgentRecord> {
    await this.authorization.assertWorkspace(this.principal(context), "manage_settings");
    this.assertBackend(input.backendId);
    const agent = await this.store.bindAgentBackend({ id: input.id, backend_id: input.backendId });
    if (!agent) throw this.requestError("not_found", `agent_not_found:${input.id}`);
    return agent;
  }

  async listAgents(context: TrustedDomainContext): Promise<AgentRecord[]> {
    await this.authorization.assertWorkspace(this.principal(context), "manage_settings");
    return this.store.listAgents();
  }

  async viewAgent(context: TrustedDomainContext, id: string): Promise<AgentRecord> {
    await this.authorization.assertWorkspace(this.principal(context), "manage_settings");
    const agent = await this.store.getAgent(id);
    if (!agent) throw this.requestError("not_found", `agent_not_found:${id}`);
    return agent;
  }

  private principal(context: TrustedDomainContext) {
    if (!context.participant) throw this.requestError("forbidden", "room_participant_required");
    return context.participant;
  }

  private async requireBoundary(resourceKind: string, resourceId: string): Promise<ResourceAccessBoundaryRecord> {
    const boundary = await this.store.getResourceAccessBoundary(resourceKind, resourceId);
    if (!boundary) throw this.requestError("not_found", "room_resource_boundary_not_found");
    return boundary;
  }

  private assertBackend(backendId: string): void {
    if (!this.backendRegistered(backendId)) throw this.requestError("conflict", `backend_not_registered:${backendId}`);
  }
}
