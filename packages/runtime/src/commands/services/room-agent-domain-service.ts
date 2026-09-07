import {
  AgentRecordSchema,
  RoomRecordSchema,
  createId,
  nowIso,
  type AgentRecord,
  type RoomRecord
} from "@samurai-agent/core-schemas";
import type {
  AgentDm,
  RoomDefaultAgent,
  RoomWork,
  RoomWorkAssignee,
  RoomWorkComment,
  RoomWorkControl,
  RoomWorkInstruction,
  RoomWorkReaction,
  RoomWorkView,
  TrustedDomainContext
} from "@samurai-agent/domain-operations";
import type {
  AgentWorkspacePermissionRecord,
  ResourceAccessBoundaryRecord,
  RoomAgentPermissionRecord,
  RoomMemberRecord,
  RoomResourceShareRecord,
  RuntimeRoomAgentPort,
  WorkspaceMemberRecord
} from "../../composition/runtime-workspace-ports";
import { delegatedParticipant, type NewRoomShareableResourceReference, type RoomHumanRole, type RoomShareableResourceReference, type WorkspaceRole } from "@samurai-agent/room-permissions";
import { RoomAuthorizationService } from "./room-authorization-service.js";
import { RoomResourceCatalog } from "./room-resource-catalog.js";
export type RoomAgentStorePort = RuntimeRoomAgentPort;

export interface RoomParticipantList {
  humans: RoomMemberRecord[];
  agents: RoomAgentPermissionRecord[];
}

/**
 * A current-membership snapshot used by the human-work control policy.
 *
 * This is intentionally a small, persistence-neutral shape.  The policy
 * never consumes Workspace role alone: both the actor and the original
 * requester must still have current Room membership.
 */
export interface HumanWorkMembershipSnapshot {
  participantId: string;
  role: RoomHumanRole;
  removedAt?: string;
}

export interface HumanWorkControlPolicyInput {
  actorParticipantId: string;
  requesterParticipantId: string;
  actorWorkspaceMembership?: HumanWorkMembershipSnapshot;
  requesterWorkspaceMembership?: HumanWorkMembershipSnapshot;
  actorRoomMembership?: HumanWorkMembershipSnapshot;
  requesterRoomMembership?: HumanWorkMembershipSnapshot;
}

export interface HumanWorkControlPolicyDecision {
  allowed: boolean;
  reason:
    | "allowed"
    | "workspace_membership_required"
    | "requester_membership_required"
    | "room_membership_required"
    | "room_role_denied";
}

/**
 * Pure policy for stopping/reassigning human Room work.
 *
 * The requester is not re-authorized for execution here.  A current
 * requester membership is only the continuity/control precondition; the
 * Owner/Admin exception is still based on an explicit current Room role.
 */
export function evaluateHumanWorkControlPolicy(input: HumanWorkControlPolicyInput): HumanWorkControlPolicyDecision {
  const current = (membership: HumanWorkMembershipSnapshot | undefined, participantId: string): boolean => Boolean(
    membership
      && !membership.removedAt
      && membership.participantId === participantId
  );
  const actorRoomMembership = input.actorRoomMembership;
  if (!current(input.actorWorkspaceMembership, input.actorParticipantId)) {
    return { allowed: false, reason: "workspace_membership_required" };
  }
  if (!current(input.requesterWorkspaceMembership, input.requesterParticipantId)) {
    return { allowed: false, reason: "requester_membership_required" };
  }
  if (!actorRoomMembership || !current(actorRoomMembership, input.actorParticipantId)) {
    return { allowed: false, reason: "room_membership_required" };
  }
  if (!current(input.requesterRoomMembership, input.requesterParticipantId)) {
    return { allowed: false, reason: "requester_membership_required" };
  }
  if (input.actorParticipantId === input.requesterParticipantId) {
    return { allowed: true, reason: "allowed" };
  }
  if (actorRoomMembership.role === "owner" || actorRoomMembership.role === "admin") {
    return { allowed: true, reason: "allowed" };
  }
  return { allowed: false, reason: "room_role_denied" };
}

export function assertHumanWorkControlPolicy(input: HumanWorkControlPolicyInput): HumanWorkControlPolicyDecision {
  const decision = evaluateHumanWorkControlPolicy(input);
  if (!decision.allowed) throw new Error(`human_work_control_denied:${decision.reason}`);
  return decision;
}

/** Runtime can inject this pure policy as a testable port without coupling it to a Store. */
export interface HumanWorkControlPolicyPort {
  evaluate(input: HumanWorkControlPolicyInput): HumanWorkControlPolicyDecision;
  assert(input: HumanWorkControlPolicyInput): HumanWorkControlPolicyDecision;
}

export const humanWorkControlPolicyPort: HumanWorkControlPolicyPort = Object.freeze({
  evaluate: evaluateHumanWorkControlPolicy,
  assert: assertHumanWorkControlPolicy
});

/**
 * Human-work operations are Server/Store-owned.  Runtime only exposes the
 * adapter boundary; it does not create a second aggregate or route these
 * calls through the skill-optimization worker.
 */
interface HumanWorkStoreAdapter {
  openAgentDm?(context: TrustedDomainContext, input: { agentId: string }): Promise<AgentDm>;
  setRoomDefaultAgent?(context: TrustedDomainContext, input: { roomId: string; agentId: string; expectedVersion?: number }): Promise<RoomDefaultAgent>;
  createRoomWork?(context: TrustedDomainContext, input: { roomId: string; instruction?: string; attachments: unknown[]; agentId?: string }): Promise<RoomWork>;
  listRoomWorks?(context: TrustedDomainContext, input: { roomId: string; status?: RoomWork["status"]; cursor?: string; limit: number }): Promise<RoomWork[]>;
  viewRoomWork?(context: TrustedDomainContext, input: { roomId: string; workId: string }): Promise<RoomWorkView>;
  replyToRoomWork?(context: TrustedDomainContext, input: { roomId: string; workId: string; assigneeId?: string; instruction?: string; attachments: unknown[]; expectedVersion?: number; expectedGeneration?: number }): Promise<RoomWorkInstruction>;
  createRoomWorkComment?(context: TrustedDomainContext, input: { roomId: string; workId: string; body?: string; attachments: unknown[]; expectedVersion?: number }): Promise<RoomWorkComment>;
  applyRoomWorkComment?(context: TrustedDomainContext, input: { roomId: string; workId: string; commentId: string; commentVersion: number; expectedVersion?: number; expectedGeneration?: number; assigneeId?: string }): Promise<RoomWorkInstruction>;
  setRoomWorkCommentReaction?(context: TrustedDomainContext, input: { roomId: string; workId: string; commentId: string; reaction: "like"; enabled: boolean; expectedVersion?: number }): Promise<RoomWorkReaction>;
  stopRoomWork?(context: TrustedDomainContext, input: { roomId: string; workId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number }): Promise<RoomWorkControl>;
  stopRoomWorkAssignee?(context: TrustedDomainContext, input: { roomId: string; workId: string; assigneeId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number }): Promise<RoomWorkControl>;
  reassignRoomWorkAssignee?(context: TrustedDomainContext, input: { roomId: string; workId: string; assigneeId: string; agentId: string; expectedVersion?: number; expectedGeneration?: number }): Promise<RoomWorkAssignee>;
  getHumanWorkRequester?(context: TrustedDomainContext, input: { roomId: string; workId: string }): Promise<string | undefined>;
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
    private readonly resourceCatalog: RoomResourceCatalog,
    private readonly backendRegistered: (backendId: string) => boolean,
    private readonly requestError: (code: "not_found" | "conflict" | "forbidden", message: string) => Error
  ) {}

  async createRoom(context: TrustedDomainContext, input: { name: string }): Promise<RoomRecord> {
    const principal = delegatedParticipant(this.principal(context));
    if (principal.kind === "agent") {
      await this.authorization.assertWorkspace(principal, "create_room");
      await this.authorization.assertWorkspace({ kind: "human", participantId: principal.requestedByParticipantId }, "create_room");
    } else if (principal.kind === "human") {
      await this.authorization.assertWorkspace(principal, "create_room");
    } else {
      throw this.requestError("forbidden", "room_participant_required");
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
    const principal = this.humanPrincipal(context);
    await this.authorization.assertWorkspaceMemberManagement({ principal, targetRole: input.role });
    return this.store.addWorkspaceMember({ ...input, actorId: principal.participantId });
  }

  async changeWorkspaceMemberRole(context: TrustedDomainContext, input: { participantId: string; role: Exclude<WorkspaceRole, "owner"> }): Promise<WorkspaceMemberRecord> {
    const principal = this.humanPrincipal(context);
    const target = await this.store.getWorkspaceMember(input.participantId);
    if (!target) throw this.requestError("not_found", `workspace_member_not_found:${input.participantId}`);
    await this.authorization.assertWorkspaceMemberManagement({ principal, targetRole: target.role });
    await this.authorization.assertWorkspaceMemberManagement({ principal, targetRole: input.role });
    const changed = await this.store.changeWorkspaceMemberRole({ ...input, actorId: principal.participantId });
    if (!changed) throw this.requestError("not_found", `workspace_member_not_found:${input.participantId}`);
    return changed;
  }

  async removeWorkspaceMember(context: TrustedDomainContext, participantId: string): Promise<WorkspaceMemberRecord> {
    const principal = this.humanPrincipal(context);
    const target = await this.store.getWorkspaceMember(participantId);
    if (!target) throw this.requestError("not_found", `workspace_member_not_found:${participantId}`);
    await this.authorization.assertWorkspaceMemberManagement({ principal, targetRole: target.role });
    const removed = await this.store.removeWorkspaceMember({ participantId, actorId: principal.participantId });
    if (!removed) throw this.requestError("not_found", `workspace_member_not_found:${participantId}`);
    return removed;
  }

  async transferWorkspaceOwnership(context: TrustedDomainContext, toParticipantId: string): Promise<{ previousOwner: WorkspaceMemberRecord; owner: WorkspaceMemberRecord }> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertWorkspace(principal, "transfer_ownership");
    return this.store.transferWorkspaceOwnership({
      fromParticipantId: principal.participantId,
      toParticipantId,
      actorId: principal.participantId
    });
  }

  async setAgentRoomCreatePermission(context: TrustedDomainContext, input: { agentId: string; allowed: boolean }): Promise<AgentWorkspacePermissionRecord | undefined> {
    const principal = this.humanPrincipal(context);
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

  /**
   * Human work is a Workspace Server aggregate.  These methods only perform
   * the Runtime-side authorization and forward the already validated input;
   * no Objective/Session/work row is created in this service.
   */
  async createRoomWork(context: TrustedDomainContext, input: {
    roomId: string;
    instruction?: string;
    attachments: unknown[];
    agentId?: string;
  }): Promise<RoomWork> {
    const principal = this.principal(context);
    await this.authorization.assertRoom(principal, input.roomId, "execute");
    if (input.agentId) {
      const delegated = delegatedParticipant(principal);
      if (delegated.kind !== "human" && delegated.kind !== "agent") {
        throw this.requestError("forbidden", "room_human_participant_required");
      }
      await this.authorization.assertAgentExecution({
        requesterParticipantId: delegated.kind === "human" ? delegated.participantId : delegated.requestedByParticipantId,
        roomId: input.roomId,
        agentId: input.agentId
      });
    }
    const store = this.humanWorkStore();
    if (!store.createRoomWork) return this.humanWorkStoreUnavailable("createRoomWork");
    return store.createRoomWork(context, input);
  }

  async listRoomWorks(context: TrustedDomainContext, input: {
    roomId: string;
    status?: RoomWork["status"];
    cursor?: string;
    limit: number;
  }): Promise<RoomWork[]> {
    await this.authorization.assertRoom(this.principal(context), input.roomId, "read");
    const store = this.humanWorkStore();
    if (!store.listRoomWorks) return this.humanWorkStoreUnavailable("listRoomWorks");
    return store.listRoomWorks(context, input);
  }

  async viewRoomWork(context: TrustedDomainContext, input: { roomId: string; workId: string }): Promise<RoomWorkView> {
    await this.authorization.assertRoom(this.principal(context), input.roomId, "read");
    const store = this.humanWorkStore();
    if (!store.viewRoomWork) return this.humanWorkStoreUnavailable("viewRoomWork");
    return store.viewRoomWork(context, input);
  }

  async replyToRoomWork(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    assigneeId?: string;
    instruction?: string;
    attachments: unknown[];
    expectedVersion?: number;
    expectedGeneration?: number;
  }): Promise<RoomWorkInstruction> {
    await this.authorization.assertRoom(this.principal(context), input.roomId, "execute");
    const store = this.humanWorkStore();
    if (!store.replyToRoomWork) return this.humanWorkStoreUnavailable("replyToRoomWork");
    return store.replyToRoomWork(context, input);
  }

  async createRoomWorkComment(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    body?: string;
    attachments: unknown[];
    expectedVersion?: number;
  }): Promise<RoomWorkComment> {
    await this.authorization.assertRoom(this.principal(context), input.roomId, "edit");
    const store = this.humanWorkStore();
    if (!store.createRoomWorkComment) return this.humanWorkStoreUnavailable("createRoomWorkComment");
    return store.createRoomWorkComment(context, input);
  }

  async applyRoomWorkComment(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    commentId: string;
    commentVersion: number;
    expectedVersion?: number;
    expectedGeneration?: number;
    assigneeId?: string;
  }): Promise<RoomWorkInstruction> {
    await this.authorization.assertRoom(this.principal(context), input.roomId, "execute");
    const store = this.humanWorkStore();
    if (!store.applyRoomWorkComment) return this.humanWorkStoreUnavailable("applyRoomWorkComment");
    return store.applyRoomWorkComment(context, input);
  }

  async setRoomWorkCommentReaction(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    commentId: string;
    reaction: "like";
    enabled: boolean;
    expectedVersion?: number;
  }): Promise<RoomWorkReaction> {
    await this.authorization.assertRoom(this.principal(context), input.roomId, "edit");
    const store = this.humanWorkStore();
    if (!store.setRoomWorkCommentReaction) return this.humanWorkStoreUnavailable("setRoomWorkCommentReaction");
    return store.setRoomWorkCommentReaction(context, input);
  }

  async setRoomDefaultAgent(context: TrustedDomainContext, input: {
    roomId: string;
    agentId: string;
    expectedVersion?: number;
  }): Promise<RoomDefaultAgent> {
    await this.authorization.assertRoom(this.principal(context), input.roomId, "manage_settings");
    if (!await this.store.getAgent(input.agentId)) throw this.requestError("not_found", `agent_not_found:${input.agentId}`);
    const store = this.humanWorkStore();
    if (!store.setRoomDefaultAgent) return this.humanWorkStoreUnavailable("setRoomDefaultAgent");
    return store.setRoomDefaultAgent(context, input);
  }

  /** Stop admission is deliberately separate from generic Room execute. */
  async stopRoomWork(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    reason?: string;
    expectedVersion?: number;
    expectedGeneration?: number;
  }): Promise<RoomWorkControl> {
    await this.assertHumanWorkControl(context, input.roomId, input.workId);
    const store = this.humanWorkStore();
    if (!store.stopRoomWork) return this.humanWorkStoreUnavailable("stopRoomWork");
    return store.stopRoomWork(context, input);
  }

  async stopRoomWorkAssignee(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    assigneeId: string;
    reason?: string;
    expectedVersion?: number;
    expectedGeneration?: number;
  }): Promise<RoomWorkControl> {
    await this.assertHumanWorkControl(context, input.roomId, input.workId);
    const store = this.humanWorkStore();
    if (!store.stopRoomWorkAssignee) return this.humanWorkStoreUnavailable("stopRoomWorkAssignee");
    return store.stopRoomWorkAssignee(context, input);
  }

  async reassignRoomWorkAssignee(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    assigneeId: string;
    agentId: string;
    expectedVersion?: number;
    expectedGeneration?: number;
  }): Promise<RoomWorkAssignee> {
    await this.assertHumanWorkControl(context, input.roomId, input.workId);
    const delegated = delegatedParticipant(this.principal(context));
    if (delegated.kind !== "human" && delegated.kind !== "agent") {
      throw this.requestError("forbidden", "room_human_participant_required");
    }
    await this.authorization.assertAgentExecution({
      requesterParticipantId: delegated.kind === "human" ? delegated.participantId : delegated.requestedByParticipantId,
      roomId: input.roomId,
      agentId: input.agentId
    });
    const store = this.humanWorkStore();
    if (!store.reassignRoomWorkAssignee) return this.humanWorkStoreUnavailable("reassignRoomWorkAssignee");
    return store.reassignRoomWorkAssignee(context, input);
  }

  async openAgentDm(context: TrustedDomainContext, input: { agentId: string }): Promise<AgentDm> {
    const principal = this.principal(context);
    const delegated = delegatedParticipant(principal);
    if (delegated.kind !== "human" && delegated.kind !== "agent") {
      throw this.requestError("forbidden", "room_human_participant_required");
    }
    const requesterParticipantId = delegated.kind === "human" ? delegated.participantId : delegated.requestedByParticipantId;
    await this.authorization.assertWorkspace({ kind: "human", participantId: requesterParticipantId }, "create_room");
    if (delegated.kind === "agent") await this.authorization.assertWorkspace(delegated, "create_room");
    const store = this.humanWorkStore();
    if (!store.openAgentDm) return this.humanWorkStoreUnavailable("openAgentDm");
    return store.openAgentDm(context, input);
  }

  async addRoomMember(context: TrustedDomainContext, input: { roomId: string; participantId: string; role: Exclude<RoomHumanRole, "owner"> }): Promise<RoomMemberRecord> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "human", targetRole: input.role });
    return this.store.addRoomMember({ ...input, actorId: principal.participantId });
  }

  async changeRoomMemberRole(context: TrustedDomainContext, input: { roomId: string; participantId: string; role: Exclude<RoomHumanRole, "owner"> }): Promise<RoomMemberRecord> {
    const principal = this.humanPrincipal(context);
    const target = await this.store.getRoomMember(input.roomId, input.participantId);
    if (!target) throw this.requestError("not_found", `room_member_not_found:${input.roomId}:${input.participantId}`);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "human", targetRole: target.role });
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "human", targetRole: input.role });
    const changed = await this.store.changeRoomMemberRole({ ...input, actorId: principal.participantId });
    if (!changed) throw this.requestError("not_found", `room_member_not_found:${input.roomId}:${input.participantId}`);
    return changed;
  }

  async removeRoomMember(context: TrustedDomainContext, input: { roomId: string; participantId: string }): Promise<RoomMemberRecord> {
    const principal = this.humanPrincipal(context);
    const target = await this.store.getRoomMember(input.roomId, input.participantId);
    if (!target) throw this.requestError("not_found", `room_member_not_found:${input.roomId}:${input.participantId}`);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "human", targetRole: target.role });
    const removed = await this.store.removeRoomMember({ ...input, actorId: principal.participantId });
    if (!removed) throw this.requestError("not_found", `room_member_not_found:${input.roomId}:${input.participantId}`);
    return removed;
  }

  async setRoomAgentPermissions(context: TrustedDomainContext, input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean }): Promise<RoomAgentPermissionRecord> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "agent" });
    if (!await this.store.getAgent(input.agentId)) throw this.requestError("not_found", `agent_not_found:${input.agentId}`);
    return this.store.setRoomAgentPermissions({ ...input, actorId: principal.participantId });
  }

  async removeRoomAgent(context: TrustedDomainContext, input: { roomId: string; agentId: string }): Promise<RoomAgentPermissionRecord> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertRoomMemberManagement({ principal, roomId: input.roomId, targetKind: "agent" });
    const removed = await this.store.removeRoomAgent({ ...input, actorId: principal.participantId });
    if (!removed) throw this.requestError("not_found", `room_agent_not_found:${input.roomId}:${input.agentId}`);
    return removed;
  }

  async transferRoomOwnership(context: TrustedDomainContext, input: { roomId: string; toParticipantId: string }): Promise<{ previousOwner: RoomMemberRecord; owner: RoomMemberRecord }> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertRoom(principal, input.roomId, "transfer_ownership");
    return this.store.transferRoomOwnership({ roomId: input.roomId, fromParticipantId: principal.participantId, toParticipantId: input.toParticipantId, actorId: principal.participantId });
  }

  async recoverOwnerlessRoom(context: TrustedDomainContext, input: { roomId: string; ownerParticipantId: string }): Promise<RoomMemberRecord> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertWorkspace(principal, "recover_ownerless_room");
    return this.store.recoverOwnerlessRoom({ ...input, actorId: principal.participantId });
  }

  async listOwnerlessRooms(context: TrustedDomainContext): Promise<RoomRecord[]> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertWorkspace(principal, "recover_ownerless_room");
    const ids = await this.store.listOwnerlessRoomIds();
    const rooms = await Promise.all(ids.map((id) => this.store.getRoom(id)));
    return rooms.filter((room): room is RoomRecord => Boolean(room));
  }

  async shareResource(context: TrustedDomainContext, input: { sourceRoomId: string; targetRoomId: string; resource: NewRoomShareableResourceReference }): Promise<RoomResourceShareRecord> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertShare(principal, input.sourceRoomId, input.targetRoomId);
    const resource = await this.resourceCatalog.resolve(input.resource);
    if (!resource) throw this.requestError("not_found", "room_resource_not_found");
    if (resource.sourceRoomId && resource.sourceRoomId !== input.sourceRoomId) {
      throw this.requestError("conflict", "room_resource_source_room_mismatch");
    }
    await this.authorization.assertResource(principal, {
      roomId: input.sourceRoomId,
      action: "read",
      resourceKind: resource.kind,
      resourceId: resource.resourceId
    });
    const existing = await this.store.getResourceAccessBoundary(resource.kind, resource.resourceId);
    if (existing && existing.source_room_id !== input.sourceRoomId) {
      throw this.requestError("conflict", "room_resource_source_room_mismatch");
    }
    const boundary = await this.store.ensureResourceAccessBoundary({
      resourceKind: resource.kind,
      resourceId: resource.resourceId,
      sourceRoomId: input.sourceRoomId,
      ownerParticipantId: principal.participantId,
      ...(resource.resourceCreatedAt ? { resourceCreatedAt: resource.resourceCreatedAt } : {}),
      actorId: principal.participantId
    });
    return this.store.shareResource({
      resourceAccessBoundaryId: boundary.id,
      sourceRoomId: input.sourceRoomId,
      targetRoomId: input.targetRoomId,
      actorId: principal.participantId
    });
  }

  async revokeResourceShare(context: TrustedDomainContext, input: { sourceRoomId: string; targetRoomId: string; resource: RoomShareableResourceReference }): Promise<RoomResourceShareRecord> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertShare(principal, input.sourceRoomId, input.targetRoomId);
    const resource = this.resourceCatalog.canonicalize(input.resource);
    const boundary = await this.requireBoundary(resource.kind, resource.resourceId);
    if (boundary.source_room_id !== input.sourceRoomId) throw this.requestError("conflict", "room_resource_share_source_invalid");
    const revoked = await this.store.revokeRoomResourceShare({
      resourceAccessBoundaryId: boundary.id,
      sourceRoomId: input.sourceRoomId,
      targetRoomId: input.targetRoomId,
      actorId: principal.participantId
    });
    if (!revoked) throw this.requestError("not_found", "room_resource_share_not_found");
    return revoked;
  }

  async listResourceShares(context: TrustedDomainContext, input: { sourceRoomId: string; resource: RoomShareableResourceReference }): Promise<RoomResourceShareRecord[]> {
    const principal = this.humanPrincipal(context);
    await this.authorization.assertRoom(principal, input.sourceRoomId, "share");
    const resource = this.resourceCatalog.canonicalize(input.resource);
    const boundary = await this.requireBoundary(resource.kind, resource.resourceId);
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

  private humanWorkStore(): HumanWorkStoreAdapter {
    return this.store as unknown as HumanWorkStoreAdapter;
  }

  private humanWorkStoreUnavailable(method: string): never {
    throw this.requestError("conflict", `domain_operation_requires_workspace_server:${method}`);
  }

  private async assertHumanWorkControl(context: TrustedDomainContext, roomId: string, workId: string): Promise<void> {
    const actor = this.humanPrincipal(context);
    const [actorWorkspace, actorRoom] = await Promise.all([
      this.store.getWorkspaceMember(actor.participantId),
      this.store.getRoomMember(roomId, actor.participantId)
    ]);
    const store = this.humanWorkStore();
    // The transport context carries only the actor.  Without the persisted
    // requester lookup, treating the actor as requester would let a member
    // stop/reassign another person's work.  Fail closed until the Server
    // aggregate supplies this identity and its current memberships.
    if (!store.getHumanWorkRequester) return this.humanWorkStoreUnavailable("getHumanWorkRequester");
    const requesterParticipantId = (await store.getHumanWorkRequester(context, { roomId, workId }))?.trim() ?? "";
    if (!requesterParticipantId) return this.humanWorkStoreUnavailable("getHumanWorkRequester");
    const [requesterWorkspace, requesterRoom] = requesterParticipantId === actor.participantId
      ? [actorWorkspace, actorRoom]
      : await Promise.all([
          this.store.getWorkspaceMember(requesterParticipantId),
          this.store.getRoomMember(roomId, requesterParticipantId)
        ]);
    const membership = (record: WorkspaceMemberRecord | RoomMemberRecord | undefined): HumanWorkMembershipSnapshot | undefined => record
      ? {
          participantId: record.participant_id,
          role: record.role as RoomHumanRole,
          ...(record.removed_at ? { removedAt: record.removed_at } : {})
        }
      : undefined;
    const decision = humanWorkControlPolicyPort.evaluate({
      actorParticipantId: actor.participantId,
      requesterParticipantId,
      actorWorkspaceMembership: membership(actorWorkspace),
      requesterWorkspaceMembership: membership(requesterWorkspace),
      actorRoomMembership: membership(actorRoom),
      requesterRoomMembership: membership(requesterRoom)
    });
    if (!decision.allowed) throw this.requestError("forbidden", `human_work_control_denied:${decision.reason}`);
  }

  private principal(context: TrustedDomainContext) {
    if (!context.participant) throw this.requestError("forbidden", "room_participant_required");
    return context.participant;
  }

  private humanPrincipal(context: TrustedDomainContext) {
    const principal = delegatedParticipant(this.principal(context));
    if (principal.kind !== "human") throw this.requestError("forbidden", "room_human_participant_required");
    return principal;
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
