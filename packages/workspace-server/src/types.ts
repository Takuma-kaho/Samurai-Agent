import type { ResourceRef } from "@samurai-agent/core-schemas";

export const workspaceServerModes = ["hosted", "self_host"] as const;
export type WorkspaceServerMode = (typeof workspaceServerModes)[number];

export const workspaceMembershipRoles = ["owner", "admin", "member", "guest"] as const;
export type WorkspaceMembershipRole = (typeof workspaceMembershipRoles)[number];

export const workspaceMembershipStates = ["active", "revoked"] as const;
export type WorkspaceMembershipState = (typeof workspaceMembershipStates)[number];

export const workspaceStates = ["active", "read_only", "archived"] as const;
export type WorkspaceState = (typeof workspaceStates)[number];

export const workspaceAgentStatuses = ["active", "disabled", "revoked"] as const;
export type WorkspaceAgentStatus = (typeof workspaceAgentStatuses)[number];

export const workspaceConnectionStatuses = ["active", "revoked", "expired"] as const;
export type WorkspaceConnectionStatus = (typeof workspaceConnectionStatuses)[number];

export const workspaceTransferStates = ["preparing", "exported", "imported", "committed", "rolled_back", "failed"] as const;
export type WorkspaceTransferState = (typeof workspaceTransferStates)[number];

export type WorkspaceRecordPayload = Record<string, unknown>;

/**
 * Request provenance is created by the authenticated Server boundary.  It is
 * deliberately not a transport payload: callers cannot turn themselves into
 * a human, a Connection, or the maintenance identity by posting JSON.
 */
export const workspaceCallerKinds = ["human", "connection", "maintenance"] as const;
export type WorkspaceCallerKind = (typeof workspaceCallerKinds)[number];

export interface WorkspaceHumanCaller {
  kind: "human";
  principalAccountId: string;
  requestId: string;
  operationId: string;
  timestamp: string;
  canonicalPayloadHash: string;
  signature: string;
}

export interface WorkspaceConnectionCaller {
  kind: "connection";
  principalAccountId: string;
  connectionId: string;
  requestId: string;
  operationId: string;
  timestamp: string;
}

export interface WorkspaceMaintenanceCaller {
  kind: "maintenance";
  principalAccountId: string;
  operationId: string;
}

export type WorkspaceCaller = WorkspaceHumanCaller | WorkspaceConnectionCaller | WorkspaceMaintenanceCaller;

export interface WorkspaceRequestContext {
  workspaceId: string;
  accountId: string;
  /** A caller-provided identifier that lets retries return the original result. */
  operationId: string;
  /** Present only when a trusted ingress or the scheduler constructed it. */
  caller?: WorkspaceCaller;
  /** Present only while the Server-owned completion migration run is active.
   * It is never parsed from an HTTP request body or header. */
  migrationRunId?: string;
  /** Internal-only completion migration capability. HTTP input never maps to
   * this field; PostgreSQL checks it together with the Run ID and owner. */
  migrationOperation?: "completion_backfill" | "completion_rollback";
}

/** Internal principal shape used by the formal external-ingress boundary.
 * Transport adapters may construct this value, but they cannot use it to
 * bypass the Workspace Server's Room checks. */
export type WorkspaceExternalRoomPrincipal =
  | { kind: "human"; participantId: string }
  | { kind: "agent"; agentId: string; requestedByParticipantId: string };

export type WorkspaceExternalRoomAction = "read" | "edit" | "execute" | "manage_settings";

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
  /** Undefined means this Room is directly under the Workspace. */
  parentRoomId?: string;
  name: string;
  version: number;
  /** Current caller capability; it does not grant access to any other Room. */
  canManage?: boolean;
  /** Current caller capability for starting a Runtime turn in this Room. */
  canExecute?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAgent {
  workspaceId: string;
  id: string;
  displayName: string;
  description: string;
  /** Canonical v1 Agent fields; older callers may omit these compatibility fields. */
  role?: string;
  instructions?: string;
  enabled?: boolean;
  /** Backend selected by the Workspace owner for this Agent. */
  backendId: string;
  status: WorkspaceAgentStatus;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAgentRoomPermission {
  workspaceId: string;
  roomId: string;
  agentId: string;
  canView: boolean;
  canEdit: boolean;
  canExecute: boolean;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Only non-secret Connection metadata is persisted. Credential material stays
 * in an operator-owned secure store and is never part of this descriptor. */
export interface WorkspaceConnectionDescriptor {
  workspaceId: string;
  id: string;
  agentId?: string;
  principalAccountId: string;
  connectorId: string;
  appId: string;
  status: WorkspaceConnectionStatus;
  expiresAt: string;
  revokedAt?: string;
  allowedRoomIds: string[];
  roomLimit: number;
  ingressClasses: string[];
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRoomCreateResult {
  room: WorkspaceRoom;
  /** True only when this operation id returned its durable original result. */
  replayed: boolean;
}

/** A Room membership change can revoke the same Account from descendant Rooms. */
export interface WorkspaceRoomMemberChangeResult {
  member: WorkspaceRoomMembership;
  /** Only Rooms the caller may manage. Never use this as an authorization source. */
  affectedRoomIds: string[];
  /** Server-internal channels that need a subscription recheck after commit. */
  revalidationRoomIds: string[];
  replayed: boolean;
}

export interface WorkspaceRoomMoveResult {
  room: WorkspaceRoom;
  /** Only Rooms the caller may manage whose visible path changed. */
  affectedRoomIds: string[];
  /** Server-internal channels that need a post-commit event. */
  revalidationRoomIds: string[];
  replayed: boolean;
}

export interface WorkspaceRoomMovePreview {
  allowed: boolean;
  reason?: string;
  blockingAccountIds: string[];
  requiredAncestorRoomIds: string[];
}

export interface WorkspaceRoomMemberChangePreview {
  allowed: boolean;
  reason?: string;
  affectedRoomIds: string[];
  blockingOwnerRoomIds: string[];
}

export interface WorkspaceMembershipChangeResult {
  member: WorkspaceMembership;
  /** Server-internal Room channels affected by Workspace revocation. */
  revalidationRoomIds: string[];
  replayed: boolean;
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

/** Public, versioned Event shape. Legacy numeric ids stay internal to the old API. */
export interface WorkspacePublicEvent {
  eventId: string;
  eventType: string;
  eventVersion: string;
  cursor: string;
  occurredAt: string;
  actor: { kind: "human" | "agent" | "system"; id?: string };
  scope: { organizationId?: string; workspaceId: string; roomId?: string };
  resources: ResourceRef[];
  operationId?: string;
  correlationId?: string;
  payload: WorkspaceRecordPayload;
}

export interface WorkspacePublicEventPage {
  events: WorkspacePublicEvent[];
  nextCursor?: string;
  hasMore: boolean;
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

/** Knowledge has an explicit Workspace or Room scope.  A Workspace is never
 * represented by a synthetic root Room. */
export const workspaceLearningScopeKinds = ["workspace", "room"] as const;
export type WorkspaceLearningScopeKind = (typeof workspaceLearningScopeKinds)[number];

export const workspaceLearningResourceKinds = ["knowledge", "memory", "skill", "workspace_rule"] as const;
export type WorkspaceLearningResourceKind = (typeof workspaceLearningResourceKinds)[number];

export const workspaceLearningResourceStates = ["active", "provisional", "archived", "conflict"] as const;
export type WorkspaceLearningResourceState = (typeof workspaceLearningResourceStates)[number];

export const workspaceLearningActivityOutcomes = ["completed", "failed", "cancelled", "outcome_unknown"] as const;
export type WorkspaceLearningActivityOutcome = (typeof workspaceLearningActivityOutcomes)[number];

export const workspaceLearningVerificationStates = ["confirmed", "failed", "not_run", "unknown"] as const;
export type WorkspaceLearningVerificationState = (typeof workspaceLearningVerificationStates)[number];

export const workspaceLearningFailureStates = ["none", "resolved", "unresolved"] as const;
export type WorkspaceLearningFailureState = (typeof workspaceLearningFailureStates)[number];

export const workspaceLearningJobStatuses = ["queued", "running", "completed", "failed", "blocked"] as const;
export type WorkspaceLearningJobStatus = (typeof workspaceLearningJobStatuses)[number];

export const workspaceLearningJobPriorities = ["normal", "high"] as const;
export type WorkspaceLearningJobPriority = (typeof workspaceLearningJobPriorities)[number];

export const workspaceLearningChangeKinds = [
  "created", "updated", "evidence_appended", "conflict_recorded", "archived", "restored", "copied", "moved", "promoted", "fixed", "unfixed"
] as const;
export type WorkspaceLearningChangeKind = (typeof workspaceLearningChangeKinds)[number];

export interface WorkspaceLearningScope {
  kind: WorkspaceLearningScopeKind;
  /** Required only for Room-scoped data. */
  roomId?: string;
}

/** Immutable, finalized work evidence. Session identifiers belong in provenance
 * payload only and are not a parent or authorization source. */
export interface WorkspaceLearningActivity {
  workspaceId: string;
  roomId: string;
  id: string;
  groupKey: string;
  principalAccountId: string;
  sourceKind: string;
  sourceId?: string;
  correctionOfActivityId?: string;
  instructionSummary: string;
  resultSummary?: string;
  outcome: WorkspaceLearningActivityOutcome;
  verificationState: WorkspaceLearningVerificationState;
  failureState: WorkspaceLearningFailureState;
  explicitRemember: boolean;
  payload: WorkspaceRecordPayload;
  createdAt: string;
  finalizedAt: string;
}

/** Current projection of a versioned reusable resource. */
export interface WorkspaceLearningResource {
  workspaceId: string;
  id: string;
  scope: WorkspaceLearningScope;
  kind: WorkspaceLearningResourceKind;
  state: WorkspaceLearningResourceState;
  /** Workspace rules with this flag are injected before all other Knowledge. */
  isAbsoluteRule: boolean;
  /** Human-only explicit fixed state. A normal human edit does not set this. */
  aiUpdateLocked: boolean;
  /** AI-created Room Knowledge remains visibly provisional until later use or
   * an explicit human action establishes stronger confidence. */
  confidence?: number;
  /** The narrow review Job/Attempt that created the automatic projection. */
  sourceJobId?: string;
  sourceAttemptId?: string;
  title: string;
  content: string;
  payload: WorkspaceRecordPayload;
  version: number;
  createdBy: string;
  updatedBy: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Append-only revision metadata and body for a reusable resource. */
export interface WorkspaceLearningResourceVersion {
  workspaceId: string;
  id: string;
  resourceId: string;
  version: number;
  changeKind: WorkspaceLearningChangeKind;
  scope: WorkspaceLearningScope;
  state: WorkspaceLearningResourceState;
  aiUpdateLocked: boolean;
  confidence?: number;
  sourceJobId?: string;
  sourceAttemptId?: string;
  title: string;
  content: string;
  payload: WorkspaceRecordPayload;
  contentHash: string;
  reason: string;
  actorAccountId: string;
  createdAt: string;
}

export interface WorkspaceLearningEvidence {
  workspaceId: string;
  id: string;
  resourceId: string;
  resourceVersion: number;
  /** Human direct edits have no synthetic Room Activity. */
  activityId?: string;
  kind: "activity" | "human_correction" | "explicit_remember" | "use_outcome" | "human_edit";
  summary: string;
  createdAt: string;
}

/** A later, confirmed outcome of Knowledge use. It is evidence for a future
 * review, not permission for a model to edit the resource directly. */
export interface WorkspaceLearningResourceUse {
  workspaceId: string;
  id: string;
  resourceId: string;
  resourceVersion: number;
  activityId: string;
  outcome: "confirmed_success" | "confirmed_failure" | "unknown";
  /** An unknown outcome is never overwritten. Its later confirmation is a
   * second, append-only row pointing back to the original observation. */
  supersedesUseId?: string;
  summary: string;
  createdAt: string;
}

export interface WorkspaceLearningResourceLink {
  workspaceId: string;
  id: string;
  fromResourceId: string;
  toResourceId: string;
  relation: "conflicts" | "copied_from" | "moved_from" | "promoted_from" | "derived_from";
  createdAt: string;
}

export interface WorkspaceLearningJob {
  workspaceId: string;
  roomId: string;
  id: string;
  kind: "review" | "curator";
  status: WorkspaceLearningJobStatus;
  priority: WorkspaceLearningJobPriority;
  groupKey: string;
  highWatermarkActivityId: string;
  nextRunAt: string;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  blockedReason?: string;
  engineId?: string;
  model?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkspaceLearningJobAttempt {
  workspaceId: string;
  id: string;
  jobId: string;
  attemptNo: number;
  workerId: string;
  engineId?: string;
  model?: string;
  status: "running" | "completed" | "failed" | "blocked";
  inputHash: string;
  outputHash?: string;
  output?: WorkspaceRecordPayload;
  errorCode?: string;
  usage: { currency?: number; tokens?: number };
  reservation: { currency: number; tokens: number };
  startedAt: string;
  completedAt?: string;
}

/** Workspace defaults or an explicit Room override. Secret material never
 * appears here; `secretRef` is opaque operator-owned configuration only. */
export interface WorkspaceLearningSettings {
  workspaceId: string;
  id: string;
  scope: WorkspaceLearningScope;
  enabled: boolean;
  engineId?: string;
  model?: string;
  secretRef?: string;
  currencyLimit?: number;
  tokenLimit?: number;
  currencyUsed: number;
  tokensUsed: number;
  currencyReserved: number;
  tokensReserved: number;
  version: number;
  updatedBy: string;
  updatedAt: string;
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
