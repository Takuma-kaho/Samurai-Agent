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
}

export function nativeWorkspaceTargetKey(target: NativeWorkspaceTarget): string {
  return `${target.connectionId}\n${target.workspaceId}`;
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
  canExecute?: boolean;
  canManage?: boolean;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
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
