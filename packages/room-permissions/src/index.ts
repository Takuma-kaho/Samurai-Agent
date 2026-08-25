/**
 * Pure Room-participation vocabulary and decisions.
 *
 * This package deliberately knows nothing about database, HTTP, UI, or a
 * particular resource repository.  It is the one place that defines who a
 * participant is and what a current membership may do.
 */
export const participantKinds = ["human", "agent", "external_app", "system"] as const;
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
  "use_legacy_resources",
  "transfer_ownership",
  "recover_ownerless_room"
] as const;
export type WorkspaceAction = (typeof workspaceActions)[number];

export const agentWorkspacePermissions = ["room.create"] as const;
export type AgentWorkspacePermission = (typeof agentWorkspacePermissions)[number];

/** Resources that may have an origin Room and explicit cross-Room shares. */
export const roomShareableResourceKinds = [
  "session",
  "artifact",
  "memory",
  "wiki",
  "skill",
  "collection_schema",
  "collection_record",
  "file",
  "generated_surface"
] as const;
export type RoomShareableResourceKind = (typeof roomShareableResourceKinds)[number];
/** Session and Generated Surface shares remain readable/revocable only. */
export const newRoomShareableResourceKinds = roomShareableResourceKinds.filter(
  (kind) => kind !== "session" && kind !== "generated_surface"
) as Exclude<RoomShareableResourceKind, "session" | "generated_surface">[];

/**
 * A persisted or legacy share reference.  `session` remains here solely so
 * old rows can be inspected or revoked; it is not a valid new-share target.
 */
export type RoomShareableResourceReference =
  | { kind: Exclude<RoomShareableResourceKind, "collection_record" | "file">; id: string }
  | { kind: "collection_record"; collectionId: string; recordId: string }
  | { kind: "file"; path: string };

/** Public input shape for creating a new Room-to-Room share. */
export type NewRoomShareableResourceReference =
  | { kind: Exclude<RoomShareableResourceKind, "session" | "generated_surface" | "collection_record" | "file">; id: string }
  | { kind: "collection_record"; collectionId: string; recordId: string }
  | { kind: "file"; path: string };

/** Persisted boundary identity after path and composite IDs are canonicalized. */
export interface CanonicalRoomShareableResourceReference {
  kind: RoomShareableResourceKind;
  resourceId: string;
}

/** A share grants use/read in its target Room; it never changes the source. */
export const resourceAccessModes = ["source", "shared", "workspace", "legacy_owner", "denied"] as const;
export type ResourceAccessMode = (typeof resourceAccessModes)[number];

export const permissionReasons = [
  "allowed",
  "principal_kind_not_supported",
  "participant_id_invalid",
  "workspace_membership_missing",
  "workspace_membership_removed",
  "workspace_role_denied",
  "room_membership_missing",
  "room_membership_removed",
  "room_role_denied",
  "agent_not_in_room",
  "agent_not_found",
  "agent_disabled",
  "agent_room_permission_denied",
  "agent_workspace_permission_denied",
  "external_app_delegation_invalid",
  "target_role_protected",
  "owner_transfer_required"
] as const;
export type PermissionReason = (typeof permissionReasons)[number];

export interface HumanPrincipal {
  kind: "human";
  /** A stable, canonical `human:<id>` participant ID. */
  participantId: string;
}

export interface AgentPrincipal {
  kind: "agent";
  /** Stable Agent record ID. Its participant ID is always derived, never supplied twice. */
  agentId: string;
  /** The human whose current Room permission initiated this execution. */
  requestedByParticipantId: string;
}

/** External apps are transport principals, never Room members. */
export interface ExternalAppPrincipal {
  kind: "external_app";
  appId: string;
  /** Authenticated connector provenance; never a Room permission by itself. */
  connectorId?: string;
  delegatedBy: HumanPrincipal | AgentPrincipal;
}

/** System is an origin label, never a Room permission bypass. */
export interface SystemPrincipal {
  kind: "system";
  participantId: string;
}

export type ParticipantPrincipal = HumanPrincipal | AgentPrincipal | ExternalAppPrincipal | SystemPrincipal;

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

/** One fixed identifier for the local-only Core 06 migration seed. */
export const localOwnerParticipantId = "human:local-owner" as const;

/** Creates the only valid public representation of a human participant ID. */
export function humanParticipantId(id: string): string {
  return `human:${normalizedId(id)}`;
}

/** Agent participant IDs are always derived from the Agent record ID. */
export function agentParticipantId(agentId: string): string {
  return `agent:${normalizedId(agentId)}`;
}

export function isHumanParticipantId(value: string): boolean {
  return /^human:[^\s:][^\s]*$/.test(value);
}

export function isAgentParticipantId(value: string): boolean {
  return /^agent:[^\s:][^\s]*$/.test(value);
}

export function isExternalAppPrincipal(value: ParticipantPrincipal): value is ExternalAppPrincipal {
  return value.kind === "external_app";
}

/** The delegated identity is the only identity used for Room permission. */
export function delegatedParticipant(principal: ParticipantPrincipal): HumanPrincipal | AgentPrincipal | SystemPrincipal {
  return principal.kind === "external_app" ? principal.delegatedBy : principal;
}

export function principalParticipantId(principal: ParticipantPrincipal): string {
  const delegated = delegatedParticipant(principal);
  return delegated.kind === "agent" ? agentParticipantId(delegated.agentId) : delegated.participantId;
}

export function isRoomShareableResourceKind(value: string): value is RoomShareableResourceKind {
  return (roomShareableResourceKinds as readonly string[]).includes(value);
}

/**
 * A collision-safe identity for a Collection record.  Slash concatenation is
 * ambiguous when either source ID contains a slash, so new boundaries use a
 * length-prefixed tuple instead.
 */
export function collectionRecordResourceId(collectionId: string, recordId: string): string {
  const collection = normalizedId(collectionId);
  const record = normalizedId(recordId);
  return `collection:${collection.length}:${collection}${record.length}:${record}`;
}

/** Parses only the collision-safe identity emitted by collectionRecordResourceId. */
export function parseCollectionRecordResourceId(value: string): { collectionId: string; recordId: string } | undefined {
  if (!value.startsWith("collection:")) return undefined;
  let offset = "collection:".length;
  const collectionLength = readLength(value, offset);
  if (!collectionLength) return undefined;
  offset = collectionLength.next;
  const collectionId = value.slice(offset, offset + collectionLength.value);
  if (collectionId.length !== collectionLength.value) return undefined;
  offset += collectionLength.value;
  const recordLength = readLength(value, offset);
  if (!recordLength) return undefined;
  offset = recordLength.next;
  const recordId = value.slice(offset, offset + recordLength.value);
  return recordId.length === recordLength.value && offset + recordLength.value === value.length
    ? { collectionId, recordId }
    : undefined;
}

/** Legacy pre-Core-06 boundary identity, used only when reading an old row. */
export function legacyCollectionRecordResourceId(collectionId: string, recordId: string): string {
  return `${normalizedId(collectionId)}/${normalizedId(recordId)}`;
}

/** The file path is canonicalized by the Workspace path service, not here. */
export function canonicalRoomShareableResourceReference(
  reference: Exclude<RoomShareableResourceReference, { kind: "file" }>
): CanonicalRoomShareableResourceReference {
  if (reference.kind === "collection_record") {
    return { kind: reference.kind, resourceId: collectionRecordResourceId(reference.collectionId, reference.recordId) };
  }
  return { kind: reference.kind, resourceId: normalizedId(reference.id) };
}

/** Numeric hierarchy makes the pyramid explicit and reviewable. */
export const workspaceRoleRank: Readonly<Record<WorkspaceRole, number>> = Object.freeze({
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3
});

export const roomHumanRoleRank: Readonly<Record<RoomHumanRole, number>> = Object.freeze({
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3
});

const workspaceMinimumRole: Readonly<Record<WorkspaceAction, WorkspaceRole>> = Object.freeze({
  create_room: "member",
  manage_members: "admin",
  manage_settings: "admin",
  manage_agent_room_create: "admin",
  // Pre-Core 06 data has no inferred Room origin. It is deliberately
  // available only to the current Workspace Owner until a real boundary is
  // recorded by an edit or explicit share.
  use_legacy_resources: "owner",
  transfer_ownership: "owner",
  recover_ownerless_room: "owner"
});

const roomMinimumRole: Readonly<Record<RoomAction, RoomHumanRole>> = Object.freeze({
  read: "guest",
  edit: "member",
  execute: "member",
  share: "member",
  manage_members: "admin",
  manage_settings: "admin",
  transfer_ownership: "owner",
  // This action exists for a complete operation vocabulary. Actual recovery
  // is authorized by the Workspace Owner because an ownerless Room has no
  // Room role to consult.
  recover_owner: "owner"
});

export function evaluateWorkspacePermission(input: {
  principal: ParticipantPrincipal;
  action: WorkspaceAction;
  membership?: CurrentWorkspaceMembership;
  agentPermission?: CurrentAgentWorkspacePermission;
}): PermissionDecision {
  if (input.principal.kind === "external_app") {
    if (!input.principal.appId.trim()) return denied(input.action, "external_app_delegation_invalid");
    return evaluateWorkspacePermission({ ...input, principal: input.principal.delegatedBy });
  }
  if (input.principal.kind === "system") return denied(input.action, "principal_kind_not_supported");
  if (input.principal.kind === "agent") {
    if (input.action !== "create_room") return denied(input.action, "principal_kind_not_supported");
    if (!input.agentPermission || input.agentPermission.agentId !== input.principal.agentId || input.agentPermission.revokedAt) {
      return denied(input.action, "agent_workspace_permission_denied");
    }
    return allowed(input.action);
  }
  if (!isHumanParticipantId(input.principal.participantId)) return denied(input.action, "participant_id_invalid");
  if (!input.membership) return denied(input.action, "workspace_membership_missing");
  if (input.membership.removedAt) return denied(input.action, "workspace_membership_removed");
  if (input.membership.participantId !== input.principal.participantId) return denied(input.action, "workspace_membership_missing");
  return roleAtLeast(workspaceRoleRank, input.membership.role, workspaceMinimumRole[input.action])
    ? allowed(input.action)
    : denied(input.action, "workspace_role_denied");
}

export function evaluateRoomPermission(input: {
  principal: ParticipantPrincipal;
  action: RoomAction;
  humanMembership?: CurrentRoomMembership;
  agentMembership?: CurrentRoomAgentMembership;
}): PermissionDecision {
  if (input.principal.kind === "external_app") {
    if (!input.principal.appId.trim()) return denied(input.action, "external_app_delegation_invalid");
    return evaluateRoomPermission({ ...input, principal: input.principal.delegatedBy });
  }
  if (input.principal.kind === "system") return denied(input.action, "principal_kind_not_supported");
  if (input.principal.kind === "agent") {
    if (!input.principal.agentId.trim() || !isHumanParticipantId(input.principal.requestedByParticipantId)) {
      return denied(input.action, "participant_id_invalid");
    }
    const membership = input.agentMembership;
    if (!membership || membership.agentId !== input.principal.agentId || membership.removedAt) {
      return denied(input.action, "agent_not_in_room");
    }
    const permitted = input.action === "read" ? membership.canView
      : input.action === "edit" ? membership.canEdit && membership.canView
      : input.action === "execute" ? membership.canExecute && membership.canView
      : false;
    return permitted ? allowed(input.action) : denied(input.action, "agent_room_permission_denied");
  }
  if (!isHumanParticipantId(input.principal.participantId)) return denied(input.action, "participant_id_invalid");
  const membership = input.humanMembership;
  if (!membership) return denied(input.action, "room_membership_missing");
  if (membership.removedAt) return denied(input.action, "room_membership_removed");
  if (membership.participantId !== input.principal.participantId) return denied(input.action, "room_membership_missing");
  return roleAtLeast(roomHumanRoleRank, membership.role, roomMinimumRole[input.action])
    ? allowed(input.action)
    : denied(input.action, "room_role_denied");
}

/**
 * Target protection is separate from generic manage-members permission. An
 * Admin can manage only Members, Guests, and Agents; the Owner alone may
 * change an Admin or transfer ownership.
 */
export function canManageRoomTarget(input: {
  actorRole: RoomHumanRole;
  targetKind: "human" | "agent";
  targetRole?: RoomHumanRole;
}): PermissionDecision {
  if (input.actorRole === "owner") return allowed("manage_members");
  if (input.actorRole === "admin" && input.targetKind === "agent") return allowed("manage_members");
  if (input.actorRole === "admin" && input.targetKind === "human" && input.targetRole !== "owner" && input.targetRole !== "admin") {
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

function roleAtLeast<R extends string>(rank: Readonly<Record<R, number>>, actual: R, minimum: R): boolean {
  return rank[actual] >= rank[minimum];
}

function readLength(value: string, offset: number): { value: number; next: number } | undefined {
  const separator = value.indexOf(":", offset);
  if (separator < offset + 1) return undefined;
  const digits = value.slice(offset, separator);
  if (!/^\d+$/.test(digits)) return undefined;
  const length = Number(digits);
  return Number.isSafeInteger(length) && length >= 0 ? { value: length, next: separator + 1 } : undefined;
}

function allowed(action: PermissionDecision["action"]): PermissionDecision {
  return { allowed: true, reason: "allowed", action };
}

function denied(action: PermissionDecision["action"], reason: PermissionReason): PermissionDecision {
  return { allowed: false, reason, action };
}

function normalizedId(value: string): string {
  const normalized = value.trim();
  if (!normalized || /\s/.test(normalized)) throw new Error("participant_id_required");
  return normalized;
}
