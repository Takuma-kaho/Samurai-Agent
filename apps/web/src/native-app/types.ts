import type { ActivityInboxItem, BackendRunRecord, MessageRecord, ResourceRef } from "@samurai-agent/core-schemas";

export const organizationRoles = ["owner", "admin", "member", "guest"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export type OrganizationState = "active" | "archived" | "deleted";
export type WorkspaceState = "active" | "archived" | "read_only";

/**
 * A Workspace ID is only meaningful together with the connection that
 * authorized it.  Keep this value small and serializable because it is also
 * used as the key for local navigation hints.
 */
export interface NativeWorkspaceTarget {
  connectionId: string;
  workspaceId: string;
  /** Optional Room scope. Omitted for Workspace-level and legacy callers. */
  roomId?: string;
  /** Immutable selection generation supplied by the caller when available. */
  selectionGeneration?: number;
}

export function nativeWorkspaceTargetKey(target: NativeWorkspaceTarget): string {
  return `${target.connectionId}\n${target.workspaceId}`;
}

/** Stable identity for an asynchronous operation's complete navigation scope. */
export function nativeWorkspaceTargetIdentityKey(target: NativeWorkspaceTarget): string {
  return JSON.stringify([
    target.connectionId,
    target.workspaceId,
    target.roomId ?? null,
    target.selectionGeneration ?? null
  ]);
}

/**
 * Compare the scope a caller captured with the scope currently reported by a
 * bridge. Older bridges do not report Room/generation yet, so those optional
 * fields remain compatible wildcards; whenever the bridge reports them they
 * are compared instead of being inferred.
 */
export function nativeWorkspaceTargetMatches(
  expected: NativeWorkspaceTarget,
  actual: NativeWorkspaceTarget
): boolean {
  if (expected.connectionId !== actual.connectionId || expected.workspaceId !== actual.workspaceId) return false;
  if (expected.roomId !== undefined && actual.roomId !== undefined && expected.roomId !== actual.roomId) return false;
  if (expected.selectionGeneration !== undefined
    && actual.selectionGeneration !== undefined
    && expected.selectionGeneration !== actual.selectionGeneration) return false;
  return true;
}

export type NativeConnectionAvailability = "unknown" | "connected" | "reconnecting" | "offline";

/**
 * This is the UI projection, not an authority object.  The Server decides
 * whether a workspace can be opened every time it is selected.
 */
export interface NativeOrganization {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  state: OrganizationState;
  role: OrganizationRole;
  workspaceCount?: number;
  createdAt?: string;
  updatedAt?: string;
  workspaces?: NativeWorkspace[];
  /** The connection is optional for legacy organization projections. */
  connectionId?: string;
  serverOrigin?: string;
}

export interface NativeWorkspace {
  id: string;
  /** Organization is an optional management association, not an access gate. */
  organizationId?: string;
  name: string;
  state: WorkspaceState;
  access: "granted" | "none";
  role?: OrganizationRole;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  /** Server may provide the public Room projection for an already granted workspace. */
  rooms?: NativeRoom[];
  /** The authorized connection/Workspace pair. Required for new directory rows. */
  target?: NativeWorkspaceTarget;
  /** Sanitized connection context shown as secondary metadata only. */
  connectionId?: string;
  serverOrigin?: string;
  serverLabel?: string;
  accountId?: string;
  availability?: NativeConnectionAvailability;
  connectionError?: string;
}

export interface NativeRoom {
  id: string;
  workspaceId: string;
  name: string;
  parentRoomId?: string;
  /** Server-issued Room membership capabilities. Missing values are unknown. */
  canView?: boolean;
  canEdit?: boolean;
  canExecute?: boolean;
  canManage?: boolean;
  canStop?: boolean;
  capabilities?: NativeRoomCapabilities;
  /** Room-facing projection. The continuation Session is intentionally absent. */
  kind?: "normal" | "agent_dm";
  defaultAgentId?: string;
  defaultAgentVersion?: number;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface NativeRoomCapabilities {
  canView?: boolean;
  canEdit?: boolean;
  canExecute?: boolean;
  canManage?: boolean;
  canStop?: boolean;
}

export type NativeRoomWorkStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "stopping"
  | "cancelled"
  | "outcome_unknown";

export type NativeRoomWorkAssigneeStatus =
  | "queued"
  | "ready"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "stopping"
  | "cancelled"
  | "outcome_unknown";

export type NativeRoomWorkResultResourceKind =
  | "artifact"
  | "artifact_revision"
  | "generated_surface"
  | "generated_surface_revision";

export type NativeRoomWorkResultState = "created" | "updated";

/** A validated Server result reference that is safe to turn into a Room tool entry. */
export interface NativeRoomWorkResultResourceRef {
  kind: NativeRoomWorkResultResourceKind;
  id: string;
  uri: string;
  /** Required by Server for revision refs; identifies the Artifact/Surface they belong to. */
  parentId?: string;
  version?: string;
  label?: string;
  connectionId?: string;
  workspaceId?: string;
  roomId?: string;
}

export interface NativeRoomWorkAssignmentResult {
  resourceRefs?: NativeRoomWorkResultResourceRef[];
  state?: NativeRoomWorkResultState;
  summary?: string;
}

/** The only resource shapes that can be opened directly from a Room Work result. */
export interface NativeArtifactWorkspaceInitialResource {
  kind: "artifact" | "generated_surface";
  id: string;
  uri: string;
  revisionId?: string;
  label?: string;
  connectionId?: string;
  workspaceId?: string;
  roomId?: string;
}

export type NativeRoomWorkInstructionStatus = "pending" | "accepted" | "queued" | "delivered" | "applied" | "failed" | "rejected";

export interface NativeRoomWorkAssignee {
  id: string;
  workId: string;
  agentId: string;
  parentAssigneeId?: string;
  status: NativeRoomWorkAssigneeStatus;
  instructionVersion: number;
  generation: number;
  version: number;
  result?: NativeRoomWorkAssignmentResult;
  createdAt?: string;
  updatedAt?: string;
}

export interface NativeRoomWorkInstruction {
  id: string;
  workId: string;
  assigneeId?: string;
  kind: "initial" | "reply" | "comment_apply" | "delegated";
  instruction: string;
  attachments: ResourceRef[];
  /**
   * Server-canonical Knowledge/Skill versions used for this instruction.
   * These are intentionally distinct from file attachments: a resource can
   * be read by the worker without becoming a user-uploaded file.
   */
  resourceRefs?: ResourceRef[];
  version: number;
  generation: number;
  status: NativeRoomWorkInstructionStatus;
  createdBy: string;
  sourceCommentId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * The renderer may name only a stable Knowledge/Skill version.  The public
 * API resolves URI and label server-side before a Room Work is persisted.
 */
export interface NativeRoomWorkResourceRefInput {
  kind: "knowledge" | "skill";
  id: string;
  version: number;
  /** Display-only title; it is never sent as an authority field. */
  label?: string;
}

export interface NativeRoomWorkComment {
  id: string;
  workId: string;
  authorId: string;
  body: string;
  attachments: ResourceRef[];
  version: number;
  reactionCount?: number;
  appliedInstructionIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface NativeRoomWorkReaction {
  id: string;
  workId: string;
  commentId: string;
  reaction: "like";
  enabled: boolean;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export type NativeRoomWorkControlAction = "stop" | "assignee.stop" | "assignee.reassign";
export type NativeRoomWorkControlStatus = "pending" | "requested" | "accepted" | "running" | "completed" | "confirmed" | "failed" | "unconfirmed" | "rejected";

export interface NativeRoomWorkControl {
  id: string;
  operationId?: string;
  workId: string;
  assigneeId?: string;
  targetAgentId?: string;
  action: NativeRoomWorkControlAction;
  status: NativeRoomWorkControlStatus;
  generation: number;
  version: number;
  unconfirmedAssigneeIds: string[];
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

/** Public Room work projection; no Session ID or external conversation ID is accepted. */
export interface NativeRoomWork {
  id: string;
  roomId: string;
  requesterId: string;
  defaultAgentId: string;
  title: string;
  objective: string;
  status: NativeRoomWorkStatus;
  instructionVersion: number;
  generation: number;
  version: number;
  assignees: NativeRoomWorkAssignee[];
  /** Latest server-canonical resource set for the Work, if projected. */
  resourceRefs?: ResourceRef[];
  stopState?: "none" | "requested" | "confirmed" | "unconfirmed";
  instructions?: NativeRoomWorkInstruction[];
  comments?: NativeRoomWorkComment[];
  reactions?: NativeRoomWorkReaction[];
  controls?: NativeRoomWorkControl[];
  /** Optional server-provided result projection. Absence is not success. */
  resultSummary?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NativeRoomDefaultAgent {
  roomId: string;
  agentId: string;
  agentVersion?: number;
  enabled: boolean;
  canExecute: boolean;
  version?: number;
  updatedAt?: string;
}

export interface NativeAgent {
  id: string;
  displayName: string;
  role?: string;
  backendId?: string;
  enabled: boolean;
  status?: string;
  canExecute?: boolean;
  version?: number;
  /** Returned only by an explicitly opened agent.view/editor request. */
  instructions?: string;
  description?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Server-owned, renderer-safe backend projection used by Room creation. */
export interface NativeAgentBackend {
  id: string;
  label: string;
  kind?: string;
  configured: boolean;
  enabled: boolean;
  connectionState?: "ready" | "unconfigured" | "disabled" | "degraded" | "unverified";
  reason?: string;
}

export interface NativeRoomAgentPermission {
  canView: boolean;
  canEdit: boolean;
  canExecute: boolean;
}

/** Room-local Agent membership. The Server keeps disabled rows for history. */
export interface NativeRoomAgentMember extends NativeRoomAgentPermission {
  id: string;
  roomId: string;
  agentId: string;
  version: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  removed: boolean;
}

export interface NativeRoomNewAgentInput {
  name: string;
  role: string;
  instructions: string;
  backendId: string;
  enabled: boolean;
  permission?: NativeRoomAgentPermission;
}

export interface NativeRoomCreateInput {
  name: string;
  parentRoomId?: string;
  /** The renderer's complete connection + Workspace selection snapshot. */
  target: NativeWorkspaceTarget;
  expectedWorkspaceVersion: number;
  defaultAgentId?: string;
  defaultAgentVersion?: number;
  newAgent?: NativeRoomNewAgentInput;
  agentPermission?: NativeRoomAgentPermission;
  operationId: string;
}

export interface NativeAgentDm {
  id: string;
  roomId: string;
  workspaceId: string;
  kind: "agent_dm";
  agentId: string;
  roomName?: string;
  agentVersion?: number;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Small renderer-safe seam for the Room work API.  The Desktop/browser bridge
 * can implement these methods later without making Session a UI input.  A
 * generic operation method is retained for bridges that expose one endpoint.
 */
export interface NativeRoomWorkBridge {
  listWorkspaceAgents?: (input?: { target?: NativeWorkspaceTarget }) => Promise<unknown>;
  viewWorkspaceAgent?: (input: { agentId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  createWorkspaceAgent?: (input: { name: string; role: string; instructions: string; backendId: string; enabled: boolean; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  patchWorkspaceAgent?: (input: { agentId: string; name?: string; role?: string; instructions?: string; enabled?: boolean; expectedVersion?: number; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  bindWorkspaceAgentBackend?: (input: { agentId: string; backendId: string; expectedVersion?: number; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  listWorkspaceRoomAgentMembers?: (input: { roomId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  setWorkspaceRoomAgentPermission?: (input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  removeWorkspaceRoomAgent?: (input: { roomId: string; agentId: string; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  listWorkspaceAgentBackends?: (input?: { target?: NativeWorkspaceTarget }) => Promise<unknown>;
  createWorkspaceRoom?: (input: NativeRoomCreateInput) => Promise<unknown>;
  listWorkspaceRoomWorks?: (input: { roomId: string; status?: NativeRoomWorkStatus; cursor?: string; limit?: number; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  getWorkspaceRoomWork?: (input: { roomId: string; workId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  createWorkspaceRoomWork?: (input: { roomId: string; instruction?: string; attachments?: ResourceRef[]; resourceRefs?: NativeRoomWorkResourceRefInput[]; agentId?: string; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  replyWorkspaceRoomWork?: (input: { roomId: string; workId: string; assigneeId?: string; instruction?: string; attachments?: ResourceRef[]; resourceRefs?: NativeRoomWorkResourceRefInput[]; expectedVersion?: number; expectedGeneration?: number; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  createWorkspaceRoomWorkComment?: (input: { roomId: string; workId: string; body?: string; attachments?: ResourceRef[]; expectedVersion?: number; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  applyWorkspaceRoomWorkComment?: (input: { roomId: string; workId: string; commentId: string; commentVersion: number; expectedVersion?: number; expectedGeneration?: number; assigneeId?: string; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  reactWorkspaceRoomWorkComment?: (input: { roomId: string; workId: string; commentId: string; reaction: "like"; enabled?: boolean; expectedVersion?: number; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  setWorkspaceRoomDefaultAgent?: (input: { roomId: string; agentId: string; expectedVersion?: number; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  stopWorkspaceRoomWork?: (input: { roomId: string; workId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  stopWorkspaceRoomWorkAssignee?: (input: { roomId: string; workId: string; assigneeId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  reassignWorkspaceRoomWorkAssignee?: (input: { roomId: string; workId: string; assigneeId: string; agentId: string; expectedVersion?: number; expectedGeneration?: number; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  delegateWorkspaceRoomWorkAssignee?: (input: {
    roomId: string;
    workId: string;
    assigneeId: string;
    agentId: string;
    instruction: string;
    dependencyAssigneeIds?: string[];
    attachments?: ResourceRef[];
    expectedVersion?: number;
    expectedGeneration?: number;
    operationId: string;
    target?: NativeWorkspaceTarget;
  }) => Promise<unknown>;
  openWorkspaceAgentDm?: (input: { agentId: string; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
  runWorkspaceRoomWorkOperation?: (input: { operation: string; roomId: string; payload: Record<string, unknown>; operationId: string; target?: NativeWorkspaceTarget }) => Promise<unknown>;
}

export interface NativeOrganizationMember {
  id: string;
  organizationId: string;
  accountId: string;
  displayName?: string;
  role: OrganizationRole;
  state: "active" | "removed";
  createdAt?: string;
  updatedAt?: string;
}

export interface NativeOrganizationInvitation {
  id: string;
  organizationId: string;
  recipientAccountId?: string;
  role: OrganizationRole;
  state: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt?: string;
}

export interface NativeWorkspaceMembership {
  id: string;
  organizationId: string;
  workspaceId: string;
  accountId: string;
  role: OrganizationRole;
  state: "active" | "revoked";
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface NativeWorkspaceMoveMember {
  accountId: string;
  workspaceRole: OrganizationRole;
  targetOrganizationRole?: OrganizationRole;
  willAddAsGuest: boolean;
}

export interface NativeWorkspaceMovePreview {
  operationId: string;
  sourceOrganizationId: string;
  targetOrganizationId: string;
  workspaceId: string;
  workspaceVersion?: number;
  workspaceState?: WorkspaceState;
  existingMembers: NativeWorkspaceMoveMember[];
  missingMembers: NativeWorkspaceMoveMember[];
  requiresGuestConfirmation: boolean;
  writeBlocked: boolean;
  failureConditions: string[];
  expiresAt?: string;
  createdAt?: string;
}

export interface NativeWorkspaceMoveResult {
  operationId: string;
  workspaceId: string;
  sourceOrganizationId: string;
  targetOrganizationId: string;
  status: "preflight" | "queued" | "running" | "committed" | "failed" | "rolled_back";
  guestMembershipAccountIds: string[];
  eventId?: string;
  committedAt?: string;
  failureCode?: string;
}

export interface NativeWorkspaceBundleExport {
  bundleId: string;
  workspaceId: string;
  /** Organization provenance is optional for standalone exports. */
  sourceOrganizationId?: string;
  schemaVersion?: number;
  integrityHash?: string;
  fileCount?: number;
  byteSize?: number;
  manifest?: Record<string, unknown>;
  createdAt?: string;
}

export interface NativeWorkspaceBundleRestoreResult {
  bundleId: string;
  workspaceId: string;
  sourceOrganizationId?: string;
  /** Legacy Organization restore route only; generic restore never sets this. */
  targetOrganizationId?: string;
  schemaVersion?: number;
  integrityHash?: string;
  status: "restored" | "failed";
  restoredAt?: string;
  eventId?: string;
  failureCode?: string;
}

/** The durable states returned by a Workspace Server transfer checkpoint. */
export type NativeWorkspaceTransferServerState =
  | "preparing"
  | "exported"
  | "imported"
  | "committed"
  | "rolled_back"
  | "failed";

/**
 * Server-to-Server transfer is a separate lifecycle from same-Server
 * Organization management.  These projections are intentionally
 * transport-neutral so the Desktop bridge can add the long-running transfer
 * implementation without exposing credentials to the renderer.
 *
 * The first group is the Desktop/UI checkpoint vocabulary.  The Server
 * vocabulary is included as well because a restarted renderer may receive a
 * public Server status before Desktop has translated it into a local
 * checkpoint.  Consumers should use `serverState` when it is present.
 */
export type NativeWorkspaceTransferState =
  | "preflight"
  | "restoring"
  | "verified"
  | "cutover"
  | "source_archived"
  | NativeWorkspaceTransferServerState;

export interface NativeWorkspaceTransferPreflight {
  transferId: string;
  source: NativeWorkspaceTarget;
  destination: NativeWorkspaceTarget;
  workspaceId: string;
  workspaceName?: string;
  sourceVersion?: number;
  dataByteSize?: number;
  writeBlocked: boolean;
  organizationReleased: boolean;
  sourceWillArchive: boolean;
  failureConditions: string[];
  expiresAt?: string;
}

export interface NativeWorkspaceTransferStatus {
  transferId: string;
  source: NativeWorkspaceTarget;
  destination: NativeWorkspaceTarget;
  state: NativeWorkspaceTransferState;
  /** Exact durable state returned by the Server, when this came from Server status. */
  serverState?: NativeWorkspaceTransferServerState;
  workspaceId: string;
  workspaceName?: string;
  dataByteSize?: number;
  writeBlocked?: boolean;
  organizationReleased?: boolean;
  /** Server confirmation only; absence is not confirmation. */
  sourceArchived?: boolean;
  sourceWorkspaceState?: WorkspaceState | "deleted";
  /** Presence is exposed as a boolean only; receipt contents never reach Renderer. */
  receiptPresent?: boolean;
  /** Target ID reported by the Server; it is validated against destination when present. */
  targetWorkspaceId?: string;
  targetRestored?: boolean;
  targetCleanupRequired?: boolean;
  integrityHash?: string;
  failureCode?: string;
  message?: string;
  updatedAt?: string;
}

export interface NativeChatMessage {
  id: string;
  role: MessageRecord["role"];
  content: string;
  createdAt?: string;
  pending?: boolean;
  failed?: boolean;
  retryable?: boolean;
  /** Public references only. Internal Session/run identifiers stay out of the UI. */
  evidence?: NativeEvidenceReference[];
}

export interface NativeEvidenceReference {
  id: string;
  kind: "activity" | "event" | "file" | "knowledge" | "run";
  label: string;
  status?: string;
  createdAt?: string;
  details?: string;
}

export interface NativeEvidenceBundle {
  messageId?: string;
  activity: ActivityInboxItem[];
  backendRuns: BackendRunRecord[];
  artifacts: Array<{ id: string; title?: string; kind?: string }>;
  memories: Array<{ id: string; title?: string; state?: string }>;
  resources?: ResourceRef[];
}

export interface NativeSelectionCandidate {
  serverOrigin: string;
  accountId: string;
  /** Desktop connection ID; old v1 preferences may omit this value. */
  connectionId?: string;
  organizationId?: string;
  workspaceId?: string;
  roomId?: string;
}

export interface NativeWorkspaceDirectoryError {
  connectionId: string;
  serverOrigin?: string;
  serverLabel?: string;
  code: string;
  message: string;
}

export type NativeLoadingState = "idle" | "loading" | "ready" | "error";
export type NativeNavigationStatus =
  | "connection-required"
  | "loading"
  | "network-error"
  | "permission-denied"
  | "zero-organization"
  | "no-workspace-access"
  | "no-workspace"
  | "server-offline"
  | "reauthorizing"
  | "no-room"
  | "archived"
  | "ready";
