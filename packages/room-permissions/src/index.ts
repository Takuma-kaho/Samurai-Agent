/**
 * Pure Room-permission vocabulary and decisions.
 *
 * This package deliberately knows nothing about SQLite, HTTP, or UI. Callers
 * resolve current membership records, then pass those facts here for one
 * deterministic decision.
 */
export const participantKinds = ["human", "agent", "system"] as const;
export type ParticipantKind = (typeof participantKinds)[number];

export const workspaceRoles = ["owner", "admin", "member", "guest"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

export const roomHumanRoles = ["owner", "admin", "member", "guest"] as const;
export type RoomHumanRole = (typeof roomHumanRoles)[number];

export const roomActions = [
  "read",
  "edit",
  "execute",
  "share",
  "manage_members",
  "manage_settings",
  "transfer_ownership",
  "recover_owner"
] as const;
export type RoomAction = (typeof roomActions)[number];

export const workspaceActions = [
  "create_room",
  "manage_members",
  "manage_settings",
  "manage_agent_room_create",
  "transfer_ownership",
  "recover_ownerless_room"
] as const;
export type WorkspaceAction = (typeof workspaceActions)[number];

export const agentWorkspacePermissions = ["room.create"] as const;
export type AgentWorkspacePermission = (typeof agentWorkspacePermissions)[number];

export const permissionReasons = [
  "allowed",
  "principal_kind_not_supported",
  "workspace_membership_missing",
  "workspace_membership_removed",
  "workspace_role_denied",
  "room_membership_missing",
  "room_membership_removed",
  "room_role_denied",
  "agent_not_in_room",
  "agent_room_permission_denied",
  "agent_workspace_permission_denied",
  "target_role_protected",
  "owner_transfer_required"
] as const;
export type PermissionReason = (typeof permissionReasons)[number];

export interface HumanPrincipal {
  kind: "human";
  participantId: string;
}

export interface AgentPrincipal {
  kind: "agent";
  /** Stable participant ID, distinct from the Agent record ID. */
  participantId: string;
  agentId: string;
  /** The human whose current Room permission initiated this execution. */
  requestedByParticipantId: string;
}

export interface SystemPrincipal {
  kind: "system";
  participantId: string;
}

export type ParticipantPrincipal = HumanPrincipal | AgentPrincipal | SystemPrincipal;

export interface CurrentWorkspaceMembership {
  participantId: string;
  role: WorkspaceRole;
  removedAt?: string;
}

export interface CurrentRoomMembership {
  participantId: string;
  role: RoomHumanRole;
  removedAt?: string;
}

export interface CurrentRoomAgentMembership {
  agentId: string;
  canView: boolean;
  canEdit: boolean;
  canExecute: boolean;
  removedAt?: string;
}

export interface CurrentAgentWorkspacePermission {
  agentId: string;
  permission: AgentWorkspacePermission;
  revokedAt?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason: PermissionReason;
  action: RoomAction | WorkspaceAction | AgentWorkspacePermission;
}

/** One fixed identifier for the local-only migration seed. */
export const localOwnerParticipantId = "human:local-owner";

export function humanParticipantId(id: string): string {
  return `human:${normalizedId(id)}`;
}

export function agentParticipantId(agentId: string): string {
  return `agent:${normalizedId(agentId)}`;
}

export function evaluateWorkspacePermission(input: {
  principal: ParticipantPrincipal;
  action: WorkspaceAction;
  membership?: CurrentWorkspaceMembership;
  agentPermission?: CurrentAgentWorkspacePermission;
}): PermissionDecision {
  if (input.principal.kind === "system") {
    return denied(input.action, "principal_kind_not_supported");
  }
  if (input.principal.kind === "agent") {
    if (input.action !== "create_room") return denied(input.action, "principal_kind_not_supported");
    if (!input.agentPermission || input.agentPermission.agentId !== input.principal.agentId || input.agentPermission.revokedAt) {
      return denied(input.action, "agent_workspace_permission_denied");
    }
    return allowed(input.action);
  }
  if (!input.membership) return denied(input.action, "workspace_membership_missing");
  if (input.membership.removedAt) return denied(input.action, "workspace_membership_removed");
  if (input.membership.participantId !== input.principal.participantId) return denied(input.action, "workspace_membership_missing");
  if (workspaceRoleAllows(input.membership.role, input.action)) return allowed(input.action);
  return denied(input.action, "workspace_role_denied");
}

export function evaluateRoomPermission(input: {
  principal: ParticipantPrincipal;
  action: RoomAction;
  humanMembership?: CurrentRoomMembership;
  agentMembership?: CurrentRoomAgentMembership;
}): PermissionDecision {
  if (input.principal.kind === "system") return denied(input.action, "principal_kind_not_supported");
  if (input.principal.kind === "agent") {
    const membership = input.agentMembership;
    if (!membership || membership.agentId !== input.principal.agentId) return denied(input.action, "agent_not_in_room");
    if (membership.removedAt) return denied(input.action, "agent_not_in_room");
    const permitted = input.action === "read" ? membership.canView
      : input.action === "edit" ? membership.canEdit && membership.canView
      : input.action === "execute" ? membership.canExecute && membership.canView
      : false;
    return permitted ? allowed(input.action) : denied(input.action, "agent_room_permission_denied");
  }
  const membership = input.humanMembership;
  if (!membership) return denied(input.action, "room_membership_missing");
  if (membership.removedAt) return denied(input.action, "room_membership_removed");
  if (membership.participantId !== input.principal.participantId) return denied(input.action, "room_membership_missing");
  return roomRoleAllows(membership.role, input.action)
    ? allowed(input.action)
    : denied(input.action, "room_role_denied");
}

/**
 * Target protection is separate from a generic manage-members decision.
 * In particular, an Admin cannot alter an Owner or another Admin.
 */
export function canManageRoomTarget(input: {
  actorRole: RoomHumanRole;
  targetKind: "human" | "agent";
  targetRole?: RoomHumanRole;
}): PermissionDecision {
  if (input.actorRole === "owner") return allowed("manage_members");
  if (input.actorRole === "admin" && input.targetKind === "agent") return allowed("manage_members");
  if (input.actorRole === "admin" && (input.targetRole === "member" || input.targetRole === "guest" || input.targetRole === undefined)) {
    return allowed("manage_members");
  }
  return denied("manage_members", "target_role_protected");
}

export function canManageWorkspaceTarget(input: {
  actorRole: WorkspaceRole;
  targetRole: WorkspaceRole;
}): PermissionDecision {
  if (input.actorRole === "owner" && input.targetRole !== "owner") return allowed("manage_members");
  if (input.actorRole === "admin" && (input.targetRole === "member" || input.targetRole === "guest")) return allowed("manage_members");
  return denied("manage_members", input.targetRole === "owner" ? "owner_transfer_required" : "target_role_protected");
}

function workspaceRoleAllows(role: WorkspaceRole, action: WorkspaceAction): boolean {
  if (role === "owner") return true;
  if (role === "admin") return action === "create_room"
    || action === "manage_members"
    || action === "manage_settings"
    || action === "manage_agent_room_create";
  if (role === "member") return action === "create_room";
  return false;
}

function roomRoleAllows(role: RoomHumanRole, action: RoomAction): boolean {
  if (role === "owner") return true;
  if (role === "admin") return action === "read"
    || action === "edit"
    || action === "execute"
    || action === "share"
    || action === "manage_members"
    || action === "manage_settings";
  if (role === "member") return action === "read" || action === "edit" || action === "execute" || action === "share";
  return action === "read";
}

function allowed(action: PermissionDecision["action"]): PermissionDecision {
  return { allowed: true, reason: "allowed", action };
}

function denied(action: PermissionDecision["action"], reason: PermissionReason): PermissionDecision {
  return { allowed: false, reason, action };
}

function normalizedId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("participant_id_required");
  return normalized;
}
