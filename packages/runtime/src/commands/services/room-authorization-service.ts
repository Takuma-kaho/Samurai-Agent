import {
  canManageRoomTarget,
  canManageWorkspaceTarget,
  evaluateRoomPermission,
  evaluateWorkspacePermission,
  type ParticipantPrincipal,
  type PermissionDecision,
  type RoomAction,
  type RoomHumanRole,
  type WorkspaceAction,
  type WorkspaceRole
} from "@samurai-agent/room-permissions";
import { delegatedParticipant, principalParticipantId } from "@samurai-agent/room-permissions";
import type {
  AgentWorkspacePermissionRecord,
  RoomAgentPermissionRecord,
  RoomMemberRecord,
  WorkspaceMemberRecord,
  WorkspaceStore
} from "@samurai-agent/workspace-store";

export class RoomAuthorizationError extends Error {
  constructor(
    readonly scope: "workspace" | "room" | "resource",
    readonly action: string,
    readonly reason: string
  ) {
    super(`room_authorization_denied:${scope}:${action}:${reason}`);
    this.name = "RoomAuthorizationError";
  }
}

type RoomAuthorizationStore = Pick<WorkspaceStore,
  | "getWorkspaceMember"
  | "getRoomMember"
  | "getRoomAgent"
  | "getAgentWorkspacePermission"
  | "listRoomIdsForHuman"
  | "listRoomIdsForAgent"
  | "listResourceIdsAvailableInRoom"
  | "getResourceAccessMode"
>;

export interface RoomResourceCandidateAccess {
  /** Resource IDs whose source Room or active share permits this Room. */
  resourceIds: string[];
  /** Pre-Core 06 resources deliberately remain available only to the active Workspace Owner. */
  includeLegacy: boolean;
}

/** Runtime adapter that obtains current membership facts and delegates every decision to the pure module. */
export class RoomAuthorizationService {
  constructor(private readonly store: RoomAuthorizationStore) {}

  async assertWorkspace(principal: ParticipantPrincipal, action: WorkspaceAction): Promise<void> {
    const decision = await this.workspaceDecision(principal, action);
    if (!decision.allowed) throw new RoomAuthorizationError("workspace", action, decision.reason);
  }

  async workspaceDecision(principal: ParticipantPrincipal, action: WorkspaceAction) {
    const delegated = delegatedParticipant(principal);
    const [membership, agentPermission] = await Promise.all([
      delegated.kind === "human" ? this.store.getWorkspaceMember(delegated.participantId) : Promise.resolve(undefined),
      delegated.kind === "agent" ? this.store.getAgentWorkspacePermission(delegated.agentId) : Promise.resolve(undefined)
    ]);
    return evaluateWorkspacePermission({
      principal,
      action,
      ...(membership ? { membership: workspaceMembership(membership) } : {}),
      ...(agentPermission ? { agentPermission: workspaceAgentPermission(agentPermission) } : {})
    });
  }

  async assertRoom(principal: ParticipantPrincipal, roomId: string, action: RoomAction): Promise<void> {
    const decision = await this.roomDecision(principal, roomId, action);
    if (!decision.allowed) throw new RoomAuthorizationError("room", action, decision.reason);
  }

  async roomDecision(principal: ParticipantPrincipal, roomId: string, action: RoomAction) {
    const delegated = delegatedParticipant(principal);
    // Workspace membership is a prerequisite, never a grant for Room content.
    // This closes the stale Room-membership path after Workspace removal.
    if (delegated.kind === "human") {
      const workspace = await this.store.getWorkspaceMember(delegated.participantId);
      if (!workspace) return deniedRoomDecision(action, "workspace_membership_missing");
    }
    const membership = delegated.kind === "human"
      ? await this.store.getRoomMember(roomId, delegated.participantId)
      : undefined;
    const agentMembership = delegated.kind === "agent"
      ? await this.store.getRoomAgent(roomId, delegated.agentId)
      : undefined;
    const decision = evaluateRoomPermission({
      principal,
      action,
      ...(membership ? { humanMembership: roomMembership(membership) } : {}),
      ...(agentMembership ? { agentMembership: roomAgentMembership(agentMembership) } : {})
    });
    if (!decision.allowed || delegated.kind !== "agent") return decision;

    // An Agent acts only within a currently permitted human request. This is
    // re-evaluated for each read, write, and tool execution after admission.
    const [workspaceRequester, requester] = await Promise.all([
      this.store.getWorkspaceMember(delegated.requestedByParticipantId),
      this.store.getRoomMember(roomId, delegated.requestedByParticipantId)
    ]);
    if (!workspaceRequester) return deniedRoomDecision(action, "workspace_membership_missing");
    const requesterDecision = evaluateRoomPermission({
      principal: { kind: "human", participantId: delegated.requestedByParticipantId },
      action,
      ...(requester ? { humanMembership: roomMembership(requester) } : {})
    });
    return requesterDecision.allowed ? decision : requesterDecision;
  }

  async assertAgentExecution(input: { requesterParticipantId: string; roomId: string; agentId: string }): Promise<void> {
    await this.assertRoom({ kind: "human", participantId: input.requesterParticipantId }, input.roomId, "execute");
    await this.assertRoom({
      kind: "agent",
      agentId: input.agentId,
      requestedByParticipantId: input.requesterParticipantId
    }, input.roomId, "execute");
  }

  async assertRoomMemberManagement(input: {
    principal: ParticipantPrincipal;
    roomId: string;
    targetKind: "human" | "agent";
    targetRole?: RoomHumanRole;
  }): Promise<void> {
    const delegated = delegatedParticipant(input.principal);
    if (delegated.kind !== "human") throw new RoomAuthorizationError("room", "manage_members", "principal_kind_not_supported");
    await this.assertRoom(input.principal, input.roomId, "manage_members");
    const actor = await this.store.getRoomMember(input.roomId, delegated.participantId);
    if (!actor) throw new RoomAuthorizationError("room", "manage_members", "room_membership_missing");
    const target = canManageRoomTarget({ actorRole: actor.role, targetKind: input.targetKind, ...(input.targetRole ? { targetRole: input.targetRole } : {}) });
    if (!target.allowed) throw new RoomAuthorizationError("room", "manage_members", target.reason);
  }

  async assertWorkspaceMemberManagement(input: {
    principal: ParticipantPrincipal;
    targetRole: WorkspaceRole;
  }): Promise<void> {
    const delegated = delegatedParticipant(input.principal);
    if (delegated.kind !== "human") throw new RoomAuthorizationError("workspace", "manage_members", "principal_kind_not_supported");
    await this.assertWorkspace(input.principal, "manage_members");
    const actor = await this.store.getWorkspaceMember(delegated.participantId);
    if (!actor) throw new RoomAuthorizationError("workspace", "manage_members", "workspace_membership_missing");
    const target = canManageWorkspaceTarget({ actorRole: actor.role, targetRole: input.targetRole });
    if (!target.allowed) throw new RoomAuthorizationError("workspace", "manage_members", target.reason);
  }

  async assertShare(principal: ParticipantPrincipal, sourceRoomId: string, targetRoomId: string): Promise<void> {
    await this.assertRoom(principal, sourceRoomId, "share");
    await this.assertRoom(principal, targetRoomId, "share");
  }

  async assertResource(principal: ParticipantPrincipal, input: {
    roomId: string;
    action: Extract<RoomAction, "read" | "edit" | "execute">;
    resourceKind: string;
    resourceId: string;
  }): Promise<void> {
    await this.assertRoom(principal, input.roomId, input.action);
    const mode = await this.store.getResourceAccessMode({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      roomId: input.roomId,
      participantId: principalParticipantId(principal)
    });
    if (mode === "denied" || (mode === "shared" && input.action === "edit") || (mode === "workspace" && input.action !== "read")) {
      throw new RoomAuthorizationError("resource", input.action, "resource_access_boundary_denied");
    }
  }

  /**
   * Returns the first-stage search boundary.  This does not grant access by
   * itself: every returned candidate still goes through `assertResource` just
   * before it is returned or loaded into Agent context.
   */
  async resourceCandidateAccess(
    principal: ParticipantPrincipal,
    roomId: string,
    resourceKind: string
  ): Promise<RoomResourceCandidateAccess> {
    await this.assertRoom(principal, roomId, "read");
    const participantId = principalParticipantId(principal);
    const [membership, resourceIds] = await Promise.all([
      this.store.getWorkspaceMember(participantId),
      this.store.listResourceIdsAvailableInRoom({ roomId, resourceKind })
    ]);
    return { resourceIds, includeLegacy: membership?.role === "owner" };
  }

  async visibleRoomIds(principal: ParticipantPrincipal): Promise<Set<string>> {
    const delegated = delegatedParticipant(principal);
    if (delegated.kind === "human") return new Set(await this.store.listRoomIdsForHuman(delegated.participantId));
    if (delegated.kind === "agent") {
      const [agentRooms, requesterRooms] = await Promise.all([
        this.store.listRoomIdsForAgent(delegated.agentId),
        this.store.listRoomIdsForHuman(delegated.requestedByParticipantId)
      ]);
      const requesterSet = new Set(requesterRooms);
      return new Set(agentRooms.filter((roomId) => requesterSet.has(roomId)));
    }
    return new Set();
  }
}

function deniedRoomDecision(action: RoomAction, reason: "workspace_membership_missing"): PermissionDecision {
  return { allowed: false, action, reason };
}

function workspaceMembership(record: WorkspaceMemberRecord) {
  return { participantId: record.participant_id, role: record.role, ...(record.removed_at ? { removedAt: record.removed_at } : {}) };
}

function roomMembership(record: RoomMemberRecord) {
  return { participantId: record.participant_id, role: record.role, ...(record.removed_at ? { removedAt: record.removed_at } : {}) };
}

function roomAgentMembership(record: RoomAgentPermissionRecord) {
  return { agentId: record.agent_id, canView: record.can_view, canEdit: record.can_edit, canExecute: record.can_execute, ...(record.removed_at ? { removedAt: record.removed_at } : {}) };
}

function workspaceAgentPermission(record: AgentWorkspacePermissionRecord) {
  return { agentId: record.agent_id, permission: record.permission, ...(record.revoked_at ? { revokedAt: record.revoked_at } : {}) };
}
