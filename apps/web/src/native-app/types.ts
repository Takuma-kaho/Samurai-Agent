import type { ActivityInboxItem, BackendRunRecord, MessageRecord, ResourceRef } from "@samurai-agent/core-schemas";

export const organizationRoles = ["owner", "admin", "member", "guest"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export type OrganizationState = "active" | "archived" | "deleted";
export type WorkspaceState = "active" | "archived" | "read_only";

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
}

export interface NativeWorkspace {
  id: string;
  organizationId: string;
  name: string;
  state: WorkspaceState;
  access: "granted" | "none";
  role?: OrganizationRole;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  /** Server may provide the public Room projection for an already granted workspace. */
  rooms?: NativeRoom[];
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
  sourceOrganizationId: string;
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
  targetOrganizationId: string;
  schemaVersion?: number;
  integrityHash?: string;
  status: "restored" | "failed";
  restoredAt?: string;
  eventId?: string;
  failureCode?: string;
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
  organizationId?: string;
  workspaceId?: string;
  roomId?: string;
}

export type NativeLoadingState = "idle" | "loading" | "ready" | "error";
export type NativeNavigationStatus =
  | "connection-required"
  | "loading"
  | "network-error"
  | "permission-denied"
  | "zero-organization"
  | "no-workspace-access"
  | "no-room"
  | "archived"
  | "ready";
