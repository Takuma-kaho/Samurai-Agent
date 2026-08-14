export const workspaceServerModes = ["hosted", "self_host"] as const;
export type WorkspaceServerMode = (typeof workspaceServerModes)[number];

export const workspaceMembershipRoles = ["owner", "admin", "member", "guest"] as const;
export type WorkspaceMembershipRole = (typeof workspaceMembershipRoles)[number];

export const workspaceMembershipStates = ["active", "revoked"] as const;
export type WorkspaceMembershipState = (typeof workspaceMembershipStates)[number];

export const workspaceStates = ["active", "read_only", "archived"] as const;
export type WorkspaceState = (typeof workspaceStates)[number];

export const workspaceTransferStates = ["preparing", "exported", "imported", "committed", "rolled_back", "failed"] as const;
export type WorkspaceTransferState = (typeof workspaceTransferStates)[number];

export type WorkspaceRecordPayload = Record<string, unknown>;

export interface WorkspaceRequestContext {
  workspaceId: string;
  accountId: string;
  /** A caller-provided identifier that lets retries return the original result. */
  operationId: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  accountId: string;
  role: WorkspaceMembershipRole;
  state: WorkspaceMembershipState;
  version: number;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface WorkspaceRoomMembership extends WorkspaceMembership {
  roomId: string;
}

export interface WorkspaceAccount {
  id: string;
  publicKey: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  state: WorkspaceState;
  hostingMode: WorkspaceServerMode;
  storageNamespace: string;
  databasePlacement: "shared" | "dedicated";
  version: number;
  role: WorkspaceMembershipRole;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRoom {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  workspaceId: string;
  roomId: string;
  recordType: string;
  id: string;
  version: number;
  payload: WorkspaceRecordPayload;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceEvent {
  id: number;
  workspaceId: string;
  roomId: string;
  kind: string;
  recordType?: string;
  recordId?: string;
  operationId: string;
  payload: WorkspaceRecordPayload;
  createdAt: string;
}

export interface WorkspaceFile {
  workspaceId: string;
  roomId: string;
  path: string;
  version: number;
  sha256: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceJob {
  workspaceId: string;
  roomId: string;
  id: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked";
  version: number;
  idempotencyKey: string;
  payload: WorkspaceRecordPayload;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  roomId?: string;
  workspaceRole: WorkspaceMembershipRole;
  roomRole?: WorkspaceMembershipRole;
  version: number;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
  acceptedAt?: string;
}

export interface WorkspaceAuditEntry {
  id: number;
  workspaceId: string;
  roomId?: string;
  actorAccountId: string;
  action: string;
  outcome: "completed" | "rejected" | "failed";
  operationId?: string;
  subjectKind?: string;
  subjectId?: string;
  beforeVersion?: number;
  afterVersion?: number;
  details: WorkspaceRecordPayload;
  createdAt: string;
}

export interface WorkspaceBundleV3Manifest {
  format_version: 3;
  workspace_id: string;
  exported_at: string;
  source: { hosting_mode: WorkspaceServerMode; database_placement: "shared" | "dedicated" };
  /** Schema migration level used to create this portable snapshot. */
  schema_version?: number;
  /** Present for a transfer so source and target can prove the same Bundle. */
  transfer_id?: string;
  files: Record<string, string>;
  record_counts: Record<string, number>;
  integrity_hash: string;
}

/** A target-side confirmation bound to one exported Bundle and transfer id. */
export interface WorkspaceTransferReceipt {
  format_version: 1;
  transfer_id: string;
  source_workspace_id: string;
  source_integrity_hash: string;
  target_workspace_id: string;
  imported_at: string;
  target_integrity_hash: string;
}
