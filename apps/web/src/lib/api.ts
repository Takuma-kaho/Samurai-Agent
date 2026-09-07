import type {
  ActivityInboxItem,
  ApprovalRequest,
  AutomationJobRecord,
  ArtifactRecord,
  AuditRecord,
  BackendEventRecord,
  BackendRunRecord,
  CollectionRecord,
  CollectionSchema,
  GeneratedSurfaceDefinition,
  GeneratedSurfaceRevisionRecord,
  OptimizationCandidate,
  OptimizationEvaluation,
  OptimizationPromotion,
  SkillOptimizationDataset,
  SkillOptimizationRun,
  SkillOptimizationSnapshot,
  JsonValue,
  MemoryFrontmatter,
  MessageRecord,
  MessagePresentationRecord,
  ObjectiveRecord,
  OperationRecord,
  PolicyDecisionRecord,
  RollbackPoint,
  SessionRecord,
  SettingsRecord,
  SurfaceRendererRegistryEntry,
  SupportedLocale,
  ResourceRef,
  WorkItemRecord,
  WikiFrontmatter,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import type {
  SurfaceOperation,
  SurfaceOperationResultEnvelope,
  SurfaceRenderKind,
  SurfaceRendererCapabilities
} from "@samurai-agent/ui-protocol";
import { browserWorkspaceBridge } from "./workspace-browser-bridge";

export interface SessionDetail {
  session: SessionRecord;
  messages: MessageRecord[];
  messagePresentations?: MessagePresentationRecord[];
  operations: OperationRecord[];
  artifacts: ArtifactRecord[];
  auditRecords: AuditRecord[];
  backendRuns: BackendRunRecord[];
  backendEvents: BackendEventRecord[];
  workspaceChanges: WorkspaceChangeRecord[];
  memory: Array<MemoryFrontmatter & { file_path: string }>;
  activity: ActivityInboxItem[];
}

export interface ArtifactDetail {
  artifact: ArtifactRecord;
  content: string;
  operation?: OperationRecord;
  auditRecords: AuditRecord[];
}

export interface MemoryDetail {
  memory: MemoryFrontmatter & { file_path: string };
  content: string;
}

export interface WorkspaceKnowledgeMemoryPage {
  memory: MemoryFrontmatter & { file_path: string };
  content: string;
  scope?: { kind: "workspace" | "room"; roomId?: string };
  metadata?: Record<string, JsonValue>;
}

export interface WorkspaceKnowledgeMemoryArchivePayload {
  memory: MemoryFrontmatter & { file_path: string };
  content: string;
  changed: boolean;
  replayed?: boolean;
}

export interface WikiDetail {
  wiki: WikiFrontmatter & { file_path: string };
  content: string;
}

export interface ChatTurnResult {
  session: SessionRecord;
  messages: MessageRecord[];
  messagePresentations?: MessagePresentationRecord[];
  backendRun: BackendRunRecord;
  backendEvents: BackendEventRecord[];
  workspaceChanges: WorkspaceChangeRecord[];
  operations: OperationRecord[];
  policyDecisions: PolicyDecisionRecord[];
  artifacts: ArtifactRecord[];
  memories: MemoryFrontmatter[];
  approvalRequests: ApprovalRequest[];
  auditRecords: AuditRecord[];
  rollbackPoints: RollbackPoint[];
  activity: ActivityInboxItem[];
}

export interface GeneratedSurfaceDetail {
  surface: GeneratedSurfaceDefinition;
  revisions: GeneratedSurfaceRevisionRecord[];
  interactions: Array<Record<string, JsonValue>>;
}

export interface GeneratedSurfaceBundleDetail {
  surface: GeneratedSurfaceDefinition;
  revision: GeneratedSurfaceRevisionRecord;
  bundle: {
    html: string;
    css?: string;
    script?: string;
    assets?: Array<{ path: string; content_base64: string; mime_type: string }>;
  };
  csp: string;
}

export interface GeneratedSurfaceExportPayload {
  file_name: string;
  content_type: string;
  content_base64: string;
}

export interface SkillOptimizationDetail {
  run: SkillOptimizationRun;
  dataset?: SkillOptimizationDataset;
  candidates: OptimizationCandidate[];
  evaluations: OptimizationEvaluation[];
  promotions: OptimizationPromotion[];
  snapshots: SkillOptimizationSnapshot[];
}

export interface AgentBackendStatus {
  id: string;
  kind: "mock" | "samurai_native" | "claude_code" | "codex" | "external";
  label: string;
  configured: boolean;
  enabled?: boolean;
  connection_state?: "ready" | "unconfigured" | "disabled" | "degraded" | "unverified";
  session_policy?: { acquisition: "provider_event" | "start_session" | "none"; resume: "native" | "unsupported" | "replay_forbidden" };
  execution_owner?: "host" | "backend" | "tool_bridge";
  supports?: { start_session: boolean; resume_run: boolean; cancel_run: boolean; stream_events: boolean };
  reason?: string;
}

/**
 * Public Domain Query projection used by the Native Agent settings surface.
 * Runtime capabilities, session policy, metadata, credentials, and diagnostics
 * intentionally do not belong to this renderer-facing DTO.
 */
export interface AgentBackendAvailability {
  id: string;
  kind: "mock" | "samurai_native" | "claude_code" | "codex" | "external";
  label: string;
  configured: boolean;
  enabled: boolean;
  connection_state: "ready" | "unconfigured" | "disabled" | "degraded" | "unverified";
  reason?: string;
}

export type DomainCommandInputSource =
  | "surface_operation"
  | "provider_tool_call"
  | "runtime_api"
  | "gateway_inbound"
  | "automation"
  | "generated_surface"
  | "scheduled_context";

export interface SurfaceCommandEntry {
  id: string;
  title: string;
  description: string;
  runtime_method: string;
  handler_id: string;
  implementation_target: string;
  ui_display_category: string;
  input_sources: DomainCommandInputSource[];
  surface_operation_kinds?: string[];
  provider_tool_names?: string[];
  writes_workspace: boolean;
  output_resource_kind: string;
  output_render_kinds: SurfaceRenderKind[];
  resource_kinds: string[];
  proposed_effects: string[];
}

export interface SurfaceContractPayload {
  protocol_version: string;
  renderers: SurfaceRendererRegistryEntry[];
  render_kinds: SurfaceRenderKind[];
  commands: SurfaceCommandEntry[];
  input_sources: DomainCommandInputSource[];
}

export type ChatSurfaceOperationResult = SurfaceOperationResultEnvelope<ChatTurnResult>;

export interface HealthPayload {
  ok: boolean;
  db?: {
    ok: boolean;
    path: string;
    sizeBytes?: number;
    reason?: string;
  };
  llm?: unknown;
  backends?: AgentBackendStatus[];
  workspaceRoot?: string;
  workspaceDataDir?: string;
  workspaceWarnings?: Array<{ code: string; message: string; path: string }>;
  backendWorkingDirectoryMode?: "workspace" | "repo";
}

export interface ProviderErrorPayload {
  error: "provider_not_configured" | "provider_failed";
  reason?: string;
  provider?: string;
  model?: string;
  status?: number;
  retryable?: boolean;
  session?: SessionRecord;
  messages?: MessageRecord[];
  backendRun?: BackendRunRecord;
  backendEvents?: BackendEventRecord[];
  workspaceChanges?: WorkspaceChangeRecord[];
}

export interface SearchResult {
  kind: "session" | "message" | "artifact" | "audit";
  id: string;
  title: string;
  summary: string;
  session_id?: string;
  operation_id?: string;
}

export interface AuditPayload {
  auditRecords: AuditRecord[];
  operations: OperationRecord[];
  policyDecisions: PolicyDecisionRecord[];
  approvalRequests: ApprovalRequest[];
  rollbackPoints: RollbackPoint[];
  workspaceEntries?: WorkspaceAuditEntry[];
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
  details: Record<string, JsonValue>;
  createdAt: string;
}

export interface ApprovalLifecyclePayload {
  approvalRequest: ApprovalRequest;
  operation: OperationRecord;
  auditRecord: AuditRecord;
  activity: ActivityInboxItem[];
}

export interface ArchiveMemoryPayload {
  memory: MemoryFrontmatter & { file_path: string };
  content: string;
  operation: OperationRecord;
  auditRecord: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
  changed: boolean;
  warning?: string;
}

export interface SkillIndexEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  state: "candidate" | "project" | "active" | "stale" | "archived" | "pinned";
  required_capabilities: string[];
  file_path: string;
}

export interface AutomationRunSummary {
  id: string;
  kind: string;
  source: string;
  status: "started" | "completed" | "failed" | "blocked";
  session_id?: string;
  backend_run_id?: string;
  started_at: string;
  completed_at?: string;
  error?: string;
}

export interface RuntimeWritePayload<TResource> {
  resource: TResource;
  operation: OperationRecord;
  policyDecision: PolicyDecisionRecord;
  auditRecord: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

export interface AutomationRunPayload {
  automationRun: {
    id: string;
    kind: string;
    source: string;
    session_id?: string;
    status: "started" | "completed" | "failed";
    operation_id?: string;
    started_at: string;
    completed_at?: string;
    error?: string;
  };
  operation: OperationRecord;
  policyDecision: PolicyDecisionRecord;
  auditRecord: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: unknown
  ) {
    super(`${status} ${statusText}`);
    this.name = "ApiError";
  }
}

export interface DesktopWorkspaceConnection {
  id: string;
  label: string;
  serverUrl: string;
  /** Legacy active Workspace mirror; target-aware registries may omit it. */
  workspaceId?: string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Workspace IDs are server-local.  Every renderer-side navigation operation
 * therefore carries the connection and Workspace together.
 */
export interface DesktopWorkspaceTarget {
  connectionId: string;
  workspaceId: string;
}

export type DesktopWorkspaceConnectionAvailability = "unknown" | "connected" | "reconnecting" | "offline";

/** Sanitized account-scoped Workspace projection used by the unified switcher. */
export interface DesktopWorkspaceDirectoryEntry {
  connectionId: string;
  workspaceId: string;
  target?: DesktopWorkspaceTarget;
  accountId?: string;
  serverUrl?: string;
  serverLabel?: string;
  connectionLabel?: string;
  organizationId?: string;
  name: string;
  state?: "active" | "archived" | "read_only";
  role?: "owner" | "admin" | "member" | "guest";
  access?: "granted" | "none";
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  availability?: DesktopWorkspaceConnectionAvailability;
  error?: string;
}

export interface DesktopWorkspaceDirectoryError {
  connectionId: string;
  serverUrl?: string;
  serverLabel?: string;
  code: string;
  message: string;
}

export interface DesktopWorkspaceDirectoryResult {
  workspaces: DesktopWorkspaceDirectoryEntry[];
  errors?: DesktopWorkspaceDirectoryError[];
  connections?: DesktopWorkspaceConnectionState;
}

/** Renderer-safe contract for the long-running Server-to-Server transfer. */
export interface DesktopWorkspaceTransferInput {
  source: DesktopWorkspaceTarget;
  destination: DesktopWorkspaceTarget;
  operationId?: string;
}

export interface DesktopWorkspaceTransferStatusInput extends DesktopWorkspaceTransferInput {
  transferId: string;
}

export interface DesktopWorkspaceBundleExportInput {
  workspaceId: string;
  expectedWorkspaceVersion?: number;
  operationId?: string;
}

export interface DesktopWorkspaceBundleRestoreInput {
  bundleId: string;
  targetWorkspaceId?: string;
  operationId?: string;
}

export interface DesktopWorkspaceConnectionState {
  activeConnectionId?: string;
  activeTarget?: DesktopWorkspaceTarget;
  connections: DesktopWorkspaceConnection[];
}

export interface DesktopWorkspaceServerStatus {
  connection?: DesktopWorkspaceConnection;
  identityAvailable: boolean;
  health?: { status: number; body: unknown };
  workspace?: { status: number; body: unknown };
  rooms?: { status: number; body: unknown };
}

export interface DesktopWorkspaceRoom {
  id: string;
  workspaceId: string;
  parentRoomId?: string;
  name: string;
  version: number;
  /** Public Room kind; the internal continuation Session is never exposed. */
  kind?: "normal" | "agent_dm";
  defaultAgentId?: string;
  defaultAgentVersion?: number;
  /** State of the configured default Agent, when the Server includes it. */
  defaultAgentEnabled?: boolean;
  defaultAgentCanExecute?: boolean;
  /** Capability for this Room only; it does not grant access to descendants. */
  canManage?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Minimal authorized Agent directory used by the Room work surface. */
export interface DesktopWorkspaceAgent {
  id: string;
  workspaceId: string;
  displayName: string;
  role?: string;
  backendId?: string;
  enabled: boolean;
  status?: string;
  canExecute?: boolean;
  version?: number;
  /** Only present after an explicit agent.view/editor request. */
  instructions?: string;
  description?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DesktopWorkspaceRoomAgentMember {
  id: string;
  roomId: string;
  agentId: string;
  canView: boolean;
  canEdit: boolean;
  canExecute: boolean;
  version: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  removed: boolean;
}

export interface DesktopWorkspaceRoomAgentMemberList {
  roomId: string;
  agents: DesktopWorkspaceRoomAgentMember[];
}

/** Public Room work projections.  Session and Backend Session identifiers are
 * intentionally absent: the Room/Work IDs are the only renderer references. */
export type DesktopWorkspaceRoomWorkStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "stopping"
  | "cancelled"
  | "outcome_unknown";

export type DesktopWorkspaceRoomWorkAssigneeStatus =
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
export type DesktopWorkspaceRoomWorkInstructionKind = "initial" | "reply" | "comment_apply" | "delegated";
export type DesktopWorkspaceRoomWorkInstructionStatus = "pending" | "accepted" | "queued" | "delivered" | "applied" | "failed" | "rejected";
export type DesktopWorkspaceRoomWorkControlAction = "stop" | "assignee.stop" | "assignee.reassign";
export type DesktopWorkspaceRoomWorkControlStatus = "accepted" | "pending" | "requested" | "running" | "completed" | "confirmed" | "failed" | "unconfirmed" | "rejected";

export interface DesktopWorkspaceRoomWorkAssignee {
  id: string;
  workId: string;
  agentId: string;
  parentAssigneeId?: string;
  status: DesktopWorkspaceRoomWorkAssigneeStatus;
  instructionVersion: number;
  generation: number;
  agentConfigurationVersion?: number;
  attempt?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspaceRoomWorkInstruction {
  id: string;
  workId: string;
  assigneeId?: string;
  kind: DesktopWorkspaceRoomWorkInstructionKind;
  instruction: string;
  attachments: ResourceRef[];
  version: number;
  generation: number;
  status: DesktopWorkspaceRoomWorkInstructionStatus;
  acceptedAt?: string;
  deliveredAt?: string;
  appliedAt?: string;
  createdBy: string;
  sourceCommentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspaceRoomWorkComment {
  id: string;
  workId: string;
  authorId: string;
  body: string;
  attachments: ResourceRef[];
  version: number;
  reactionCount?: number;
  appliedInstructionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspaceRoomWorkControl {
  id: string;
  operationId?: string;
  workId: string;
  assigneeId?: string;
  targetAgentId?: string;
  action: DesktopWorkspaceRoomWorkControlAction;
  status: DesktopWorkspaceRoomWorkControlStatus;
  generation: number;
  version: number;
  stopRequestStatus?: "requested" | "accepted" | "rejected";
  terminalStatus?: "pending" | "confirmed" | "unconfirmed";
  unconfirmedAssigneeIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface DesktopWorkspaceRoomWork {
  id: string;
  roomId: string;
  objectiveId?: string;
  requesterId: string;
  frontAgentId?: string;
  defaultAgentId: string;
  defaultAgentVersion?: number;
  title: string;
  objective: string;
  completionCriteria?: string[];
  kind?: "human";
  status: DesktopWorkspaceRoomWorkStatus;
  stopState?: "none" | "requested" | "confirmed" | "unconfirmed";
  instructionVersion: number;
  generation: number;
  version: number;
  assignees: DesktopWorkspaceRoomWorkAssignee[];
  executionReservations?: DesktopWorkspaceRoomWorkExecutionReservation[];
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspaceRoomWorkExecutionReservation {
  id: string;
  workId: string;
  assignmentId: string;
  roomId: string;
  generation: number;
  status: "reserved" | "claimed" | "released" | "cancelled";
  scheduledAt: string;
  claimedAt?: string;
  releasedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspaceRoomWorkReaction {
  id: string;
  workId: string;
  commentId: string;
  reaction: "like";
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspaceRoomWorkView extends DesktopWorkspaceRoomWork {
  instructions: DesktopWorkspaceRoomWorkInstruction[];
  comments: DesktopWorkspaceRoomWorkComment[];
  reactions: DesktopWorkspaceRoomWorkReaction[];
  controls: DesktopWorkspaceRoomWorkControl[];
}

export interface DesktopWorkspaceRoomDefaultAgent {
  roomId: string;
  agentId: string;
  agentVersion: number;
  enabled: boolean;
  canExecute: boolean;
  version: number;
  updatedAt: string;
}

/** DM metadata only.  The DM body is obtained through the normal Room work
 * APIs after the server has checked the caller's explicit membership. */
export interface DesktopWorkspaceAgentDm {
  id: string;
  roomId: string;
  workspaceId: string;
  kind: "agent_dm";
  agentId: string;
  agentVersion: number;
  version: number;
  visibility?: "private";
  membershipMode?: "explicit_participants";
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspaceRoomWorkListResult {
  works: DesktopWorkspaceRoomWork[];
  /** Echoed request scope so a late response cannot be rendered in another Room. */
  roomId?: string;
  nextCursor?: string;
}

export interface DesktopWorkspacePublicEvent {
  eventId: string;
  eventType: string;
  eventVersion: string;
  cursor: string;
  occurredAt: string;
  actor: { kind: "human" | "agent" | "system"; id?: string };
  scope: { workspaceId?: string; roomId?: string };
  resources: ResourceRef[];
  operationId?: string;
  correlationId?: string;
  payload: Record<string, JsonValue>;
}

export interface DesktopWorkspacePublicEventPage {
  events: DesktopWorkspacePublicEvent[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface DesktopWorkspaceRoomMembership {
  workspaceId: string;
  roomId: string;
  accountId: string;
  role: "owner" | "admin" | "member" | "guest";
  state: "active" | "revoked";
  version: number;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface DesktopWorkspaceLearningScope {
  kind: "workspace" | "room";
  roomId?: string;
}

export interface DesktopWorkspaceLearningSettings {
  workspaceId: string;
  id: string;
  scope: DesktopWorkspaceLearningScope;
  enabled: boolean;
  engineId?: string;
  model?: string;
  currencyLimit?: number;
  tokenLimit?: number;
  currencyUsed: number;
  tokensUsed: number;
  currencyReserved: number;
  tokensReserved: number;
  version: number;
  updatedAt: string;
}

export interface WorkspaceCompletionResourceView {
  workspaceId: string;
  id: string;
  scope: { kind: "workspace" | "room"; roomId?: string };
  kind: "knowledge" | "skill" | "policy";
  knowledgeKind?: "fact" | "decision" | "explanation" | "experience_rule";
  title: string;
  evidenceState: string;
  lifecycleState: string;
  aiProtection: "editable" | "fixed";
  creationSource: string;
  aiManaged: boolean;
  version: number;
  currentConfirmedVersion?: number;
  currentProvisionalVersion?: number;
  candidateVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCompletionResourceDetail {
  resource: WorkspaceCompletionResourceView;
  current_version: { version: number; metadata: Record<string, JsonValue>; contentHash: string; reason: string; createdAt: string };
  versions: Array<Record<string, JsonValue>>;
  evidence: Array<Record<string, JsonValue>>;
}

export interface WorkspaceCompletionResourceBody {
  resource: WorkspaceCompletionResourceView;
  version: WorkspaceCompletionResourceDetail["current_version"];
  content: string;
}

export interface WorkspaceKnowledgeWikiPage {
  wiki: WikiFrontmatter & { file_path: string };
  content: string;
  scope?: { kind: "workspace" | "room"; roomId?: string };
  metadata?: Record<string, JsonValue>;
}

export interface DesktopRoomMovePreview {
  allowed: boolean;
  reason?: string;
  blockingAccountIds: string[];
  requiredAncestorRoomIds: string[];
}

export interface DesktopRoomMemberPreview {
  allowed: boolean;
  reason?: string;
  affectedRoomIds: string[];
  blockingOwnerRoomIds: string[];
}

export interface DesktopWorkspaceRealtimeEvent {
  type: "event" | "access_changed" | "access_revoked" | "room_access_changed" | "room_access_revoked";
  workspaceId: string;
  connectionId?: string;
  roomId?: string;
  kind?: string;
  eventId?: string;
  eventVersion?: string;
  cursor?: string;
  operationId?: string;
  correlationId?: string;
}

export interface WorkspaceAttachmentUploadResult {
  file: {
    path: string;
    version: number;
    sha256: string;
    size: number;
  };
  /** Server-issued reference; local paths are never accepted by Room work APIs. */
  resource_ref: ResourceRef;
  replayed?: boolean;
}

declare global {
  interface Window {
    samuraiDesktop?: {
      apiBaseUrl?: string;
      workspaceServerUrl?: string;
      workspaceId?: string;
      accountId?: string;
      listWorkspaceConnections?: () => Promise<DesktopWorkspaceConnectionState>;
      /** Account-scoped, sanitized Workspace directory across connections. */
      listWorkspaceDirectory?: () => Promise<DesktopWorkspaceDirectoryResult>;
      /** Optional per-connection fallback for older Desktop builds. */
      listWorkspaceAccountWorkspaces?: (input: { connectionId: string }) => Promise<DesktopWorkspaceDirectoryResult | unknown>;
      /** Workspace-first account-scoped creation; Organization is optional. */
      createWorkspace?: (input: { name: string; workspaceId?: string; operationId?: string }) => Promise<unknown>;
      /** Standalone Bundle portability. Organization association is optional. */
      exportWorkspaceBundle?: (input: DesktopWorkspaceBundleExportInput) => Promise<unknown>;
      restoreWorkspaceBundle?: (input: DesktopWorkspaceBundleRestoreInput) => Promise<unknown>;
      /** Server-to-Server transfer lifecycle. Browser fallback intentionally omits these. */
      preflightWorkspaceTransfer?: (input: DesktopWorkspaceTransferInput) => Promise<unknown>;
      executeWorkspaceTransfer?: (input: DesktopWorkspaceTransferStatusInput) => Promise<unknown>;
      getWorkspaceTransferStatus?: (input: DesktopWorkspaceTransferStatusInput) => Promise<unknown>;
      /** Restart-safe, credential-free transfer checkpoints from Desktop. */
      listWorkspaceTransfers?: () => Promise<unknown>;
      /** Commit the already verified transfer target in the Desktop registry. */
      cutoverWorkspaceTarget?: (input: DesktopWorkspaceTransferInput & { lastRoomId?: string }) => Promise<unknown>;
      upsertWorkspaceConnection?: (input: {
        label: string;
        serverUrl: string;
        workspaceId?: string;
        accountId: string;
        targets?: DesktopWorkspaceTarget[];
      }) => Promise<DesktopWorkspaceConnectionState>;
      selectWorkspaceConnection?: (connectionId: string) => Promise<DesktopWorkspaceConnectionState>;
      /**
       * Target-aware selector.  The string form remains accepted by old
       * preload builds and is only safe after selecting the matching
       * connection separately.
       */
      selectWorkspaceCandidate?: (input: string | DesktopWorkspaceTarget) => Promise<DesktopWorkspaceConnectionState | unknown>;
      selectWorkspaceTarget?: (target: DesktopWorkspaceTarget) => Promise<DesktopWorkspaceConnectionState | unknown>;
      importActiveWorkspaceIdentityFromClipboard?: () => Promise<DesktopWorkspaceConnectionState>;
      registerWorkspaceServerAccount?: (displayName?: string) => Promise<unknown>;
      getWorkspaceServerStatus?: (target?: Partial<DesktopWorkspaceTarget>) => Promise<DesktopWorkspaceServerStatus | unknown>;
      // Account-scoped Organization control-plane bridge. These methods only
      // carry sanitized projections; the preload keeps signing credentials in
      // the main process.
      selectOrganizationCandidate?: (input: { organizationId: string }) => Promise<unknown>;
      listOrganizations?: () => Promise<unknown>;
      getOrganization?: (input: { organizationId: string }) => Promise<unknown>;
      createOrganization?: (input: Record<string, unknown>) => Promise<unknown>;
      patchOrganization?: (input: Record<string, unknown>) => Promise<unknown>;
      deleteOrganization?: (input: Record<string, unknown>) => Promise<unknown>;
      listOrganizationMembers?: (input: { organizationId: string }) => Promise<unknown>;
      changeOrganizationMemberRole?: (input: Record<string, unknown>) => Promise<unknown>;
      removeOrganizationMember?: (input: Record<string, unknown>) => Promise<unknown>;
      leaveOrganization?: (input: Record<string, unknown>) => Promise<unknown>;
      listOrganizationInvitations?: (input: { organizationId: string }) => Promise<unknown>;
      createOrganizationInvitation?: (input: Record<string, unknown>) => Promise<unknown>;
      acceptOrganizationInvitation?: (input: Record<string, unknown>) => Promise<unknown>;
      revokeOrganizationInvitation?: (input: Record<string, unknown>) => Promise<unknown>;
      reissueOrganizationInvitation?: (input: Record<string, unknown>) => Promise<unknown>;
      extendOrganizationInvitation?: (input: Record<string, unknown>) => Promise<unknown>;
      listOrganizationWorkspaces?: (input: { organizationId: string }) => Promise<unknown>;
      createOrganizationWorkspace?: (input: Record<string, unknown>) => Promise<unknown>;
      attachOrganizationWorkspace?: (input: Record<string, unknown>) => Promise<unknown>;
      detachOrganizationWorkspace?: (input: Record<string, unknown>) => Promise<unknown>;
      /** Alias used by the first target-aware Desktop preload. */
      attachWorkspaceToOrganization?: (input: Record<string, unknown>) => Promise<unknown>;
      detachWorkspaceFromOrganization?: (input: Record<string, unknown>) => Promise<unknown>;
      patchOrganizationWorkspace?: (input: Record<string, unknown>) => Promise<unknown>;
      grantOrganizationWorkspaceMember?: (input: Record<string, unknown>) => Promise<unknown>;
      revokeOrganizationWorkspaceMember?: (input: Record<string, unknown>) => Promise<unknown>;
      setOrganizationWorkspaceLifecycle?: (input: Record<string, unknown>) => Promise<unknown>;
      previewOrganizationWorkspaceMove?: (input: Record<string, unknown>) => Promise<unknown>;
      moveOrganizationWorkspace?: (input: Record<string, unknown>) => Promise<unknown>;
      exportOrganizationWorkspaceBundle?: (input: Record<string, unknown>) => Promise<unknown>;
      restoreOrganizationBundle?: (input: Record<string, unknown>) => Promise<unknown>;
      getWorkspaceSettings?: () => Promise<SettingsRecord>;
      patchWorkspaceSettings?: (input: { patch: Partial<Omit<SettingsRecord, "updated_at">>; operationId: string }) => Promise<{ settings: SettingsRecord; replayed?: boolean }>;
      listWorkspaceRooms?: () => Promise<{ rooms: DesktopWorkspaceRoom[] }>;
      /** Authorized minimal Agent directory; instructions and credentials never cross this seam. */
      listWorkspaceAgents?: (input?: { target?: DesktopWorkspaceTarget }) => Promise<{ agents: DesktopWorkspaceAgent[] }>;
      viewWorkspaceAgent?: (input: { agentId: string; target?: DesktopWorkspaceTarget }) => Promise<DesktopWorkspaceAgent>;
      createWorkspaceAgent?: (input: { name: string; role: string; instructions: string; backendId: string; enabled: boolean; operationId: string; target?: DesktopWorkspaceTarget }) => Promise<DesktopWorkspaceAgent & { replayed?: boolean }>;
      patchWorkspaceAgent?: (input: { agentId: string; name?: string; role?: string; instructions?: string; enabled?: boolean; expectedVersion?: number; operationId: string; target?: DesktopWorkspaceTarget }) => Promise<DesktopWorkspaceAgent & { replayed?: boolean }>;
      bindWorkspaceAgentBackend?: (input: { agentId: string; backendId: string; expectedVersion?: number; operationId: string; target?: DesktopWorkspaceTarget }) => Promise<DesktopWorkspaceAgent & { replayed?: boolean }>;
      listWorkspaceRoomAgentMembers?: (input: { roomId: string; target?: DesktopWorkspaceTarget }) => Promise<DesktopWorkspaceRoomAgentMemberList>;
      setWorkspaceRoomAgentPermission?: (input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean; operationId: string; target?: DesktopWorkspaceTarget }) => Promise<DesktopWorkspaceRoomAgentMember & { replayed?: boolean }>;
      removeWorkspaceRoomAgent?: (input: { roomId: string; agentId: string; operationId: string; target?: DesktopWorkspaceTarget }) => Promise<DesktopWorkspaceRoomAgentMember & { replayed?: boolean }>;
      /** Room work API: the renderer carries Room/Work IDs, never Session IDs. */
      listWorkspaceRoomWorks?: (input: { roomId: string; status?: DesktopWorkspaceRoomWorkStatus; cursor?: string; limit?: number }) => Promise<DesktopWorkspaceRoomWorkListResult>;
      getWorkspaceRoomWork?: (input: { roomId: string; workId: string }) => Promise<DesktopWorkspaceRoomWorkView>;
      createWorkspaceRoomWork?: (input: { roomId: string; instruction?: string; attachments?: ResourceRef[]; agentId?: string; operationId: string }) => Promise<DesktopWorkspaceRoomWork & { replayed?: boolean }>;
      replyWorkspaceRoomWork?: (input: { roomId: string; workId: string; assigneeId?: string; instruction?: string; attachments?: ResourceRef[]; expectedVersion?: number; expectedGeneration?: number; operationId: string }) => Promise<DesktopWorkspaceRoomWorkInstruction & { replayed?: boolean }>;
      createWorkspaceRoomWorkComment?: (input: { roomId: string; workId: string; body?: string; attachments?: ResourceRef[]; expectedVersion?: number; operationId: string }) => Promise<DesktopWorkspaceRoomWorkComment & { replayed?: boolean }>;
      applyWorkspaceRoomWorkComment?: (input: { roomId: string; workId: string; commentId: string; commentVersion: number; assigneeId?: string; expectedVersion?: number; expectedGeneration?: number; operationId: string }) => Promise<DesktopWorkspaceRoomWorkInstruction & { replayed?: boolean }>;
      reactWorkspaceRoomWorkComment?: (input: { roomId: string; workId: string; commentId: string; reaction?: "like"; enabled?: boolean; expectedVersion?: number; operationId: string }) => Promise<DesktopWorkspaceRoomWorkReaction & { replayed?: boolean }>;
      stopWorkspaceRoomWork?: (input: { roomId: string; workId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number; operationId: string }) => Promise<DesktopWorkspaceRoomWorkControl & { replayed?: boolean }>;
      stopWorkspaceRoomWorkAssignee?: (input: { roomId: string; workId: string; assigneeId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number; operationId: string }) => Promise<DesktopWorkspaceRoomWorkControl & { replayed?: boolean }>;
      reassignWorkspaceRoomWork?: (input: { roomId: string; workId: string; assigneeId: string; agentId: string; expectedVersion?: number; expectedGeneration?: number; operationId: string }) => Promise<DesktopWorkspaceRoomWorkAssignee & { replayed?: boolean }>;
      /** Name used by the Native Room work adapter. */
      reassignWorkspaceRoomWorkAssignee?: (input: { roomId: string; workId: string; assigneeId: string; agentId: string; expectedVersion?: number; expectedGeneration?: number; operationId: string }) => Promise<DesktopWorkspaceRoomWorkAssignee & { replayed?: boolean }>;
      setWorkspaceRoomDefaultAgent?: (input: { roomId: string; agentId: string; expectedVersion?: number; operationId: string; target?: DesktopWorkspaceTarget }) => Promise<DesktopWorkspaceRoomDefaultAgent & { replayed?: boolean }>;
      openWorkspaceAgentDm?: (input: { agentId: string; operationId: string; target?: DesktopWorkspaceTarget }) => Promise<DesktopWorkspaceAgentDm & { replayed?: boolean }>;
      listWorkspaceEvents?: (input: { roomId?: string; afterCursor?: string; limit?: number }) => Promise<DesktopWorkspacePublicEventPage>;
      listWorkspaceAgentBackends?: (input?: { target?: DesktopWorkspaceTarget }) => Promise<AgentBackendAvailability[]>;
      getWorkspaceSurfaceContract?: (source?: DomainCommandInputSource) => Promise<SurfaceContractPayload>;
      listWorkspaceChatSessions?: () => Promise<SessionRecord[]>;
      createWorkspaceChatSession?: (input: { roomId: string; title?: string; uiLocale?: SupportedLocale; outputLocale?: SupportedLocale; operationId: string }) => Promise<SessionRecord>;
      getWorkspaceChatSession?: (input: { sessionId: string }) => Promise<SessionDetail>;
      sendWorkspaceChatMessage?: (input: {
        sessionId: string;
        content: string;
        idempotencyKey: string;
        inputLocale?: SupportedLocale;
        outputLocale?: SupportedLocale;
        backendId?: string;
        metadata?: Record<string, JsonValue>;
        attachments?: ResourceRef[];
      }) => Promise<ChatTurnResult | ChatSurfaceOperationResult>;
      writeWorkspaceAttachment?: (input: {
        roomId: string;
        path: string;
        contentBase64: string;
        expectedVersion: number;
        operationId: string;
        target?: DesktopWorkspaceTarget;
      }) => Promise<WorkspaceAttachmentUploadResult>;
      listWorkspaceCompletionResources?: (input: { scopeKind: "workspace" | "room"; roomId?: string; kind?: "knowledge" | "skill"; includeArchived?: boolean }) => Promise<{ resources: WorkspaceCompletionResourceView[]; next_cursor?: string }>;
      getWorkspaceCompletionResource?: (input: { resourceId: string }) => Promise<WorkspaceCompletionResourceDetail>;
      getWorkspaceCompletionResourceBody?: (input: { resourceId: string }) => Promise<WorkspaceCompletionResourceBody>;
      createWorkspaceCompletionResource?: (input: {
        scopeKind: "workspace" | "room";
        roomId?: string;
        kind: "knowledge" | "skill";
        knowledgeKind?: "fact" | "decision" | "explanation" | "experience_rule";
        title: string;
        content: string;
        metadata?: Record<string, JsonValue>;
        reason: string;
        operationId: string;
      }) => Promise<{ resource: WorkspaceCompletionResourceView; replayed?: boolean }>;
      updateWorkspaceCompletionResource?: (input: {
        resourceId: string;
        scopeKind: "workspace" | "room";
        roomId?: string;
        kind: "knowledge" | "skill";
        knowledgeKind?: "fact" | "decision" | "explanation" | "experience_rule";
        title: string;
        content: string;
        metadata?: Record<string, JsonValue>;
        reason: string;
        expectedVersion: number;
        operationId: string;
      }) => Promise<{ resource: WorkspaceCompletionResourceView; replayed?: boolean }>;
      setWorkspaceCompletionResourceFixed?: (input: { resourceId: string; fixed: boolean; expectedVersion: number; reason: string; operationId: string }) => Promise<{ resource: WorkspaceCompletionResourceView; replayed?: boolean }>;
      archiveWorkspaceCompletionResource?: (input: { resourceId: string; archived: boolean; expectedVersion: number; reason: string; operationId: string }) => Promise<{ resource: WorkspaceCompletionResourceView; replayed?: boolean }>;
      searchWorkspaceCompletionKnowledge?: (input: { roomId: string; query: string; limit?: number }) => Promise<{ resources: Array<WorkspaceCompletionResourceView & { rank?: number }>; next_cursor?: string }>;
      listWorkspaceCompletionSkills?: (input: { roomId: string }) => Promise<{ skills: WorkspaceCompletionResourceView[]; next_cursor?: string }>;
      getWorkspaceCompletionSkill?: (input: { resourceId: string }) => Promise<{ resource: WorkspaceCompletionResourceView; version: WorkspaceCompletionResourceDetail["current_version"]; content: string; support_files?: Array<Record<string, JsonValue>> }>;
      listWorkspaceSkillOptimizations?: (input: { skillId?: string; roomId?: string; limit?: number }) => Promise<SkillOptimizationRun[]>;
      getWorkspaceSkillOptimization?: (input: { runId: string }) => Promise<SkillOptimizationDetail>;
      startWorkspaceSkillOptimization?: (input: { skillId: string; roomId?: string; objective?: string; goldenExamples?: JsonValue[]; syntheticExamples?: JsonValue[]; operationId: string }) => Promise<{ run: SkillOptimizationRun; dataset: SkillOptimizationDataset; objective: ObjectiveRecord; work_item: WorkItemRecord }>;
      runWorkspaceSkillOptimizationAction?: (input: { runId: string; action: "cancel" | "promote" | "reject" | "rollback"; candidateId?: string; promotionId?: string; snapshotId?: string; operationId: string }) => Promise<Record<string, unknown>>;
      listWorkspaceKnowledgeWiki?: (input: { roomId: string; includeArchived?: boolean }) => Promise<{ pages: WorkspaceKnowledgeWikiPage[] }>;
      getWorkspaceKnowledgeWiki?: (input: { wikiId: string }) => Promise<WorkspaceKnowledgeWikiPage>;
      createWorkspaceKnowledgeWiki?: (input: { roomId: string; title: string; content: string; slug?: string; tags?: string[]; contentLocale?: SupportedLocale; knowledgeKind?: "fact" | "decision" | "explanation" | "experience_rule"; reason: string; operationId: string }) => Promise<{ wiki: WorkspaceKnowledgeWikiPage; replayed?: boolean }>;
      updateWorkspaceKnowledgeWiki?: (input: { wikiId: string; title?: string; content?: string; tags?: string[]; contentLocale?: SupportedLocale; reason: string; operationId: string }) => Promise<{ wiki: WorkspaceKnowledgeWikiPage; replayed?: boolean }>;
      setWorkspaceKnowledgeWikiState?: (input: { wikiId: string; state: "accept" | "reject" | "archive"; reason: string; operationId: string }) => Promise<{ wiki: WorkspaceKnowledgeWikiPage; replayed?: boolean }>;
      reindexWorkspaceKnowledgeWiki?: (input: { roomId: string }) => Promise<{ active: number; total: number; links: number }>;
      getWorkspaceKnowledgeWikiGraph?: (input: { roomId: string; query?: string }) => Promise<Record<string, unknown>>;
      getWorkspaceKnowledgeWikiLint?: (input: { roomId: string }) => Promise<Record<string, unknown>>;
      getWorkspaceKnowledgeWikiBacklinks?: (input: { roomId: string; wikiId: string }) => Promise<Array<{ from_wiki_id: string; label: string }>>;
      listWorkspaceKnowledgeMemory?: (input: { roomId: string; includeArchived?: boolean }) => Promise<{ memories: WorkspaceKnowledgeMemoryPage[] }>;
      getWorkspaceKnowledgeMemory?: (input: { memoryId: string }) => Promise<WorkspaceKnowledgeMemoryPage>;
      searchWorkspaceKnowledgeMemory?: (input: { roomId: string; query: string; limit?: number }) => Promise<{ memories: Array<WorkspaceKnowledgeMemoryPage & { rank?: number }> }>;
      archiveWorkspaceKnowledgeMemory?: (input: { memoryId: string; reason: string; operationId: string }) => Promise<WorkspaceKnowledgeMemoryArchivePayload>;
      listWorkspaceCollectionSchemas?: (input: { roomId: string }) => Promise<{ schemas: Array<CollectionSchema & { file_path: string; resource_version: number; room_id: string }> }>;
      getWorkspaceCollectionSchema?: (input: { roomId: string; collectionId: string }) => Promise<{ schema: CollectionSchema & { file_path: string; resource_version: number; room_id: string } }>;
      saveWorkspaceCollectionSchema?: (input: { roomId: string; schema: CollectionSchema; expectedVersion?: number; operationId: string }) => Promise<{ schema: CollectionSchema & { file_path: string; resource_version: number; room_id: string }; replayed?: boolean }>;
      listWorkspaceCollectionRecords?: (input: { roomId: string; collectionId: string }) => Promise<{ records: Array<CollectionRecord & { file_path: string }> }>;
      createWorkspaceCollectionRecord?: (input: { roomId: string; collectionId: string; recordId: string; data: Record<string, JsonValue>; operationId: string }) => Promise<{ record: CollectionRecord & { file_path: string }; replayed?: boolean }>;
      patchWorkspaceCollectionRecord?: (input: { roomId: string; collectionId: string; recordId: string; patchId?: string; changes: Record<string, JsonValue>; expectedVersion?: number; operationId: string }) => Promise<{ record: CollectionRecord & { file_path: string }; replayed?: boolean }>;
      deleteWorkspaceCollectionRecord?: (input: { roomId: string; collectionId: string; recordId: string; expectedVersion: number; operationId: string }) => Promise<{ record: CollectionRecord & { file_path: string }; replayed?: boolean }>;
      listWorkspaceCollectionNotes?: (input: { roomId: string; collectionId: string }) => Promise<{ notes: Array<{ file_path: string; content: string; collection_id: string; role: "context_only" }> }>;
      reindexWorkspaceCollections?: (input: { roomId: string }) => Promise<Record<string, unknown>>;
      runWorkspaceCollectionSurfaceOperation?: (input: { roomId: string; operation: SurfaceOperation }) => Promise<SurfaceOperationResultEnvelope>;
      listWorkspaceArtifacts?: (input: { roomId: string }) => Promise<{ artifacts: ArtifactRecord[] }>;
      getWorkspaceArtifact?: (input: { roomId: string; artifactId: string }) => Promise<ArtifactDetail>;
      createWorkspaceArtifact?: (input: { roomId: string; title: string; content: string | Record<string, JsonValue> | JsonValue[]; kind?: ArtifactRecord["kind"]; locale?: SupportedLocale; sourceLocales?: SupportedLocale[]; metadata?: Record<string, JsonValue>; operationId: string }) => Promise<{ artifact: ArtifactRecord; content: string; replayed?: boolean }>;
      runWorkspaceArtifactSurfaceOperation?: (input: { roomId: string; operation: SurfaceOperation }) => Promise<SurfaceOperationResultEnvelope>;
      getWorkspaceGeneratedSurface?: (input: { roomId: string; surfaceId: string }) => Promise<GeneratedSurfaceDetail>;
      getWorkspaceGeneratedSurfaceBundle?: (input: { roomId: string; surfaceId: string; revisionId: string }) => Promise<GeneratedSurfaceBundleDetail>;
      runWorkspaceGeneratedSurfaceAction?: (input: { roomId: string; surfaceId: string; actionId: string; revisionId?: string; interactionId?: string; messageId?: string; confirmed?: boolean; actionPayload?: Record<string, JsonValue>; operationId: string }) => Promise<Record<string, unknown>>;
      runWorkspaceGeneratedSurfaceState?: (input: { roomId: string; surfaceId: string; action: "pin" | "unpin" | "archive"; interactionId?: string; messageId?: string; operationId: string }) => Promise<GeneratedSurfaceDefinition>;
      exportWorkspaceGeneratedSurface?: (input: { roomId: string; surfaceId: string; revisionId?: string; format: "html" | "zip" }) => Promise<GeneratedSurfaceExportPayload>;
      listWorkspaceAutomationJobs?: (input: { roomId?: string }) => Promise<{ jobs: AutomationJobRecord[] }>;
      createWorkspaceAutomationJob?: (input: {
        roomId: string;
        title: string;
        kind: string;
        schedule: string;
        targetInstruction: string;
        deliveryTarget?: Record<string, JsonValue>;
        enabled?: boolean;
        nextRunAt?: string;
        maxAttempts?: number;
        connectionId?: string;
        sessionRef?: Record<string, JsonValue>;
        operationId: string;
      }) => Promise<{ job: AutomationJobRecord; replayed?: boolean }>;
      listWorkspaceAutomationRuns?: (input: { roomId?: string }) => Promise<{ runs: AutomationRunSummary[] }>;
      listWorkspaceAutomationJobRuns?: (input: { jobId: string }) => Promise<{ runs: AutomationRunSummary[] }>;
      setWorkspaceAutomationManagement?: (input: { jobId: string; state: "allowed" | "manager_stopped"; operationId: string }) => Promise<{ job: AutomationJobRecord; replayed?: boolean }>;
      runWorkspaceAutomationNow?: (input: { roomId: string; kind?: string; operationId: string }) => Promise<{ job: AutomationJobRecord; replayed?: boolean }>;
      listWorkspaceRoomMembers?: (roomId: string) => Promise<{ members: DesktopWorkspaceRoomMembership[] }>;
      createWorkspaceRoom?: (input: {
        name: string;
        parentRoomId?: string;
        expectedWorkspaceVersion: number;
        operationId: string;
      }) => Promise<{ room: DesktopWorkspaceRoom; replayed?: boolean }>;
      previewWorkspaceRoomMove?: (input: {
        roomId: string;
        parentRoomId: string | null;
      }) => Promise<{ preview: DesktopRoomMovePreview }>;
      moveWorkspaceRoom?: (input: {
        roomId: string;
        parentRoomId: string | null;
        expectedRoomVersion: number;
        expectedWorkspaceVersion: number;
        operationId: string;
      }) => Promise<{ room: DesktopWorkspaceRoom; affected_room_ids: string[]; replayed?: boolean }>;
      previewWorkspaceRoomMember?: (input: {
        roomId: string;
        accountId: string;
        role: "owner" | "admin" | "member" | "guest";
        state: "active" | "revoked";
      }) => Promise<{ preview: DesktopRoomMemberPreview }>;
      setWorkspaceRoomMember?: (input: {
        roomId: string;
        accountId: string;
        role: "owner" | "admin" | "member" | "guest";
        state: "active" | "revoked";
        expectedVersion: number;
        operationId: string;
      }) => Promise<{ member: DesktopWorkspaceRoomMembership; affected_room_ids: string[]; replayed?: boolean }>;
      getWorkspaceLearningSettings?: (roomId: string) => Promise<{
        settings: DesktopWorkspaceLearningSettings;
        workspace_settings?: DesktopWorkspaceLearningSettings;
        room_settings?: DesktopWorkspaceLearningSettings;
      }>;
      updateWorkspaceLearningSettings?: (input: {
        scopeKind: "workspace" | "room";
        roomId?: string;
        enabled?: boolean;
        engineId?: string;
        model?: string;
        secretRef?: string;
        currencyLimit?: number;
        tokenLimit?: number;
        clearEngineId?: boolean;
        clearModel?: boolean;
        clearSecretRef?: boolean;
        clearCurrencyLimit?: boolean;
        clearTokenLimit?: boolean;
        removeOverride?: boolean;
        expectedVersion?: number;
        operationId: string;
      }) => Promise<{ settings: DesktopWorkspaceLearningSettings; replayed?: boolean }>;
      searchWorkspace?: (input: { roomId: string; query: string }) => Promise<SearchResult[]>;
      getWorkspaceAudit?: () => Promise<AuditPayload>;
      listWorkspaceActivity?: (input: { roomId: string }) => Promise<ActivityInboxItem[]>;
      listWorkspaceBackendRuns?: (input: { sessionId?: string }) => Promise<BackendRunRecord[]>;
      getWorkspaceBackendRun?: (input: { runId: string }) => Promise<BackendRunRecord>;
      listWorkspaceBackendEvents?: (input: { runId: string }) => Promise<BackendEventRecord[]>;
      cancelWorkspaceBackendRun?: (input: { runId: string; operationId: string }) => Promise<BackendRunRecord>;
      retryWorkspaceBackendRun?: (input: { runId: string; operationId: string }) => Promise<ChatSurfaceOperationResult>;
      listWorkspaceChanges?: (input: { sessionId?: string }) => Promise<WorkspaceChangeRecord[]>;
      onWorkspaceServerEvent?: (listener: (event: DesktopWorkspaceRealtimeEvent | undefined) => void) => () => void;
    };
  }
}

export function getApiBaseUrl(): string | undefined {
  const value = typeof window === "undefined" ? undefined : window.samuraiDesktop?.apiBaseUrl;
  return value ? value.replace(/\/$/, "") : undefined;
}

let activeWorkspaceRoomId: string | undefined;

/** AppWorkspace sets this after the signed Room list is loaded. The bridge
 * never accepts a Room from an arbitrary URL or renderer payload. */
export function setActiveWorkspaceRoomId(roomId: string | undefined): void {
  activeWorkspaceRoomId = roomId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(roomId) ? roomId : undefined;
}

function activeWorkspaceBridge(): NonNullable<Window["samuraiDesktop"]> | undefined {
  if (typeof window === "undefined") return undefined;
  return window.samuraiDesktop ?? browserWorkspaceBridge();
}

export function getWorkspaceClientBridge(): NonNullable<Window["samuraiDesktop"]> | undefined {
  return activeWorkspaceBridge();
}

function workspaceRequestRequired<T>(feature: string): Promise<T> {
  return Promise.reject(new ApiError(503, "Workspace Server connection required", {
    error: "workspace_connection_required",
    feature
  }));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiEndpoint(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const body = await readJson(response);

  if (!response.ok) {
    throw new ApiError(response.status, response.statusText, body);
  }
  return body as T;
}

/** 1回の送信操作に割り当て、通信再試行では呼び出し側が同じ値を渡すキー。 */
export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

function apiEndpoint(path: string): string {
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  const baseUrl = getApiBaseUrl();
  return baseUrl ? `${baseUrl}${path.startsWith("/") ? path : `/${path}`}` : path;
}

export const api = {
  getHealth() {
    return request<HealthPayload>("/api/health");
  },
  createSession(input: Partial<Pick<SessionRecord, "title" | "ui_locale" | "output_locale">> & { room_id?: string } = {}) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.createWorkspaceChatSession) {
      if (!input.room_id) return Promise.reject(new ApiError(400, "Room is required", { error: "room_id_required" }));
      return bridge.createWorkspaceChatSession({
        roomId: input.room_id,
        operationId: createIdempotencyKey(),
        ...(input.title ? { title: input.title } : {}),
        ...(input.ui_locale ? { uiLocale: input.ui_locale } : {}),
        ...(input.output_locale ? { outputLocale: input.output_locale } : {})
      });
    }
    return workspaceRequestRequired<SessionRecord>("chat.session.create");
  },
  listSessions() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceChatSessions) return bridge.listWorkspaceChatSessions();
    return workspaceRequestRequired<SessionRecord[]>("chat.session.list");
  },
  listWorkspaceAgents() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceAgents) return bridge.listWorkspaceAgents();
    return workspaceRequestRequired<{ agents: DesktopWorkspaceAgent[] }>("agent.list");
  },
  listRoomWorks(input: { roomId: string; status?: DesktopWorkspaceRoomWorkStatus; cursor?: string; limit?: number }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceRoomWorks) return bridge.listWorkspaceRoomWorks(input);
    return workspaceRequestRequired<DesktopWorkspaceRoomWorkListResult>("room.work.list");
  },
  getRoomWork(input: { roomId: string; workId: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceRoomWork) return bridge.getWorkspaceRoomWork(input);
    return workspaceRequestRequired<DesktopWorkspaceRoomWorkView>("room.work.view");
  },
  createRoomWork(input: { roomId: string; instruction?: string; attachments?: ResourceRef[]; agentId?: string; operationId?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.createWorkspaceRoomWork) return bridge.createWorkspaceRoomWork({ ...input, operationId: input.operationId ?? createIdempotencyKey() });
    return workspaceRequestRequired<DesktopWorkspaceRoomWork & { replayed?: boolean }>("room.work.create");
  },
  replyRoomWork(input: { roomId: string; workId: string; assigneeId?: string; instruction?: string; attachments?: ResourceRef[]; expectedVersion?: number; expectedGeneration?: number; operationId?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.replyWorkspaceRoomWork) return bridge.replyWorkspaceRoomWork({ ...input, operationId: input.operationId ?? createIdempotencyKey() });
    return workspaceRequestRequired<DesktopWorkspaceRoomWorkInstruction & { replayed?: boolean }>("room.work.reply");
  },
  createRoomWorkComment(input: { roomId: string; workId: string; body?: string; attachments?: ResourceRef[]; expectedVersion?: number; operationId?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.createWorkspaceRoomWorkComment) return bridge.createWorkspaceRoomWorkComment({ ...input, operationId: input.operationId ?? createIdempotencyKey() });
    return workspaceRequestRequired<DesktopWorkspaceRoomWorkComment & { replayed?: boolean }>("room.work.comment.create");
  },
  reactRoomWorkComment(input: { roomId: string; workId: string; commentId: string; reaction?: "like"; enabled?: boolean; expectedVersion?: number; operationId?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.reactWorkspaceRoomWorkComment) return bridge.reactWorkspaceRoomWorkComment({ ...input, operationId: input.operationId ?? createIdempotencyKey() });
    return workspaceRequestRequired<DesktopWorkspaceRoomWorkReaction & { replayed?: boolean }>("room.work.comment.reaction.set");
  },
  applyRoomWorkComment(input: { roomId: string; workId: string; commentId: string; commentVersion: number; assigneeId?: string; expectedVersion?: number; expectedGeneration?: number; operationId?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.applyWorkspaceRoomWorkComment) return bridge.applyWorkspaceRoomWorkComment({ ...input, operationId: input.operationId ?? createIdempotencyKey() });
    return workspaceRequestRequired<DesktopWorkspaceRoomWorkInstruction & { replayed?: boolean }>("room.work.comment.apply");
  },
  stopRoomWork(input: { roomId: string; workId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number; operationId?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.stopWorkspaceRoomWork) return bridge.stopWorkspaceRoomWork({ ...input, operationId: input.operationId ?? createIdempotencyKey() });
    return workspaceRequestRequired<DesktopWorkspaceRoomWorkControl & { replayed?: boolean }>("room.work.stop");
  },
  stopRoomWorkAssignee(input: { roomId: string; workId: string; assigneeId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number; operationId?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.stopWorkspaceRoomWorkAssignee) return bridge.stopWorkspaceRoomWorkAssignee({ ...input, operationId: input.operationId ?? createIdempotencyKey() });
    return workspaceRequestRequired<DesktopWorkspaceRoomWorkControl & { replayed?: boolean }>("room.work.assignee.stop");
  },
  reassignRoomWork(input: { roomId: string; workId: string; assigneeId: string; agentId: string; expectedVersion?: number; expectedGeneration?: number; operationId?: string }) {
    const bridge = activeWorkspaceBridge();
    const operationId = input.operationId ?? createIdempotencyKey();
    if (bridge?.reassignWorkspaceRoomWorkAssignee) return bridge.reassignWorkspaceRoomWorkAssignee({ ...input, operationId });
    if (bridge?.reassignWorkspaceRoomWork) return bridge.reassignWorkspaceRoomWork({ ...input, operationId });
    return workspaceRequestRequired<DesktopWorkspaceRoomWorkAssignee & { replayed?: boolean }>("room.work.assignee.reassign");
  },
  setRoomDefaultAgent(input: { roomId: string; agentId: string; expectedVersion?: number; operationId?: string; target?: DesktopWorkspaceTarget }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.setWorkspaceRoomDefaultAgent) return bridge.setWorkspaceRoomDefaultAgent({ ...input, operationId: input.operationId ?? createIdempotencyKey() });
    return workspaceRequestRequired<DesktopWorkspaceRoomDefaultAgent & { replayed?: boolean }>("room.default_agent.set");
  },
  openAgentDm(input: { agentId: string; operationId?: string; target?: DesktopWorkspaceTarget }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.openWorkspaceAgentDm) return bridge.openWorkspaceAgentDm({ ...input, operationId: input.operationId ?? createIdempotencyKey() });
    return workspaceRequestRequired<DesktopWorkspaceAgentDm & { replayed?: boolean }>("agent.dm.open");
  },
  listWorkspaceEvents(input: { roomId?: string; afterCursor?: string; limit?: number } = {}) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceEvents) return bridge.listWorkspaceEvents(input);
    return workspaceRequestRequired<DesktopWorkspacePublicEventPage>("workspace.events.list");
  },
  getSession(sessionId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceChatSession) return bridge.getWorkspaceChatSession({ sessionId });
    return workspaceRequestRequired<SessionDetail>("chat.session.get");
  },
  listAgentBackends(input?: { target?: DesktopWorkspaceTarget }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceAgentBackends) return bridge.listWorkspaceAgentBackends(input);
    return workspaceRequestRequired<AgentBackendAvailability[]>("agent-backends.list");
  },
  getSurfaceContract(source?: DomainCommandInputSource) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceSurfaceContract) return bridge.getWorkspaceSurfaceContract(source);
    return workspaceRequestRequired<SurfaceContractPayload>("surface.contract");
  },
  runDomainCommand<T = unknown>(commandId: string, payload: Record<string, JsonValue>, idempotencyKey = createIdempotencyKey()) {
    const bridge = activeWorkspaceBridge();
    if (commandId === "generated_surface.state" && bridge?.runWorkspaceGeneratedSurfaceState && activeWorkspaceRoomId && typeof payload.surface_id === "string" && (payload.action === "pin" || payload.action === "unpin" || payload.action === "archive")) {
      return bridge.runWorkspaceGeneratedSurfaceState({
        roomId: activeWorkspaceRoomId,
        surfaceId: payload.surface_id,
        action: payload.action,
        ...(typeof payload.interaction_id === "string" ? { interactionId: payload.interaction_id } : {}),
        ...(typeof payload.message_id === "string" ? { messageId: payload.message_id } : {}),
        operationId: idempotencyKey
      }) as Promise<T>;
    }
    return workspaceRequestRequired<{ command: SurfaceCommandEntry; result: T; render_spec?: unknown; render_specs?: unknown[] }>("domain.command.run");
  },
  getGeneratedSurface(surfaceId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceGeneratedSurface && activeWorkspaceRoomId) return bridge.getWorkspaceGeneratedSurface({ roomId: activeWorkspaceRoomId, surfaceId });
    return workspaceRequestRequired<GeneratedSurfaceDetail>("generated-surface.get");
  },
  runGeneratedSurfaceAction(surfaceId: string, actionId: string, payload: { revision_id?: string; interaction_id?: string; message_id?: string; confirmed?: boolean; action_payload?: Record<string, JsonValue> }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.runWorkspaceGeneratedSurfaceAction && activeWorkspaceRoomId) {
      return bridge.runWorkspaceGeneratedSurfaceAction({
        roomId: activeWorkspaceRoomId,
        surfaceId,
        actionId,
        ...(payload.revision_id ? { revisionId: payload.revision_id } : {}),
        ...(payload.interaction_id ? { interactionId: payload.interaction_id } : {}),
        ...(payload.message_id ? { messageId: payload.message_id } : {}),
        ...(payload.confirmed === true ? { confirmed: true } : {}),
        ...(payload.action_payload ? { actionPayload: payload.action_payload } : {}),
        operationId: createIdempotencyKey()
      });
    }
    return workspaceRequestRequired<Record<string, unknown>>("generated-surface.action.run");
  },
  getGeneratedSurfaceBundle(surfaceId: string, revisionId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceGeneratedSurfaceBundle && activeWorkspaceRoomId) return bridge.getWorkspaceGeneratedSurfaceBundle({ roomId: activeWorkspaceRoomId, surfaceId, revisionId });
    return workspaceRequestRequired<GeneratedSurfaceBundleDetail>("generated-surface.bundle.get");
  },
  exportGeneratedSurface(surfaceId: string, revisionId: string, format: "html" | "zip") {
    const bridge = activeWorkspaceBridge();
    if (bridge?.exportWorkspaceGeneratedSurface && activeWorkspaceRoomId) return bridge.exportWorkspaceGeneratedSurface({ roomId: activeWorkspaceRoomId, surfaceId, revisionId, format });
    return workspaceRequestRequired<GeneratedSurfaceExportPayload>("generated-surface.export");
  },
  listSkillOptimizationRuns(skillId?: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceSkillOptimizations) {
      return bridge.listWorkspaceSkillOptimizations({
        ...(skillId ? { skillId } : {}),
        ...(activeWorkspaceRoomId ? { roomId: activeWorkspaceRoomId } : {})
      });
    }
    return workspaceRequestRequired<SkillOptimizationRun[]>("skill-optimization.list");
  },
  getSkillOptimization(runId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceSkillOptimization) return bridge.getWorkspaceSkillOptimization({ runId });
    return workspaceRequestRequired<SkillOptimizationDetail>("skill-optimization.get");
  },
  startSkillOptimization(input: { skillId: string; objective?: string; goldenExamples?: JsonValue[]; syntheticExamples?: JsonValue[] }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.startWorkspaceSkillOptimization) {
      return bridge.startWorkspaceSkillOptimization({
        skillId: input.skillId,
        ...(activeWorkspaceRoomId ? { roomId: activeWorkspaceRoomId } : {}),
        ...(input.objective ? { objective: input.objective } : {}),
        ...(input.goldenExamples ? { goldenExamples: input.goldenExamples } : {}),
        ...(input.syntheticExamples ? { syntheticExamples: input.syntheticExamples } : {}),
        operationId: createIdempotencyKey()
      });
    }
    return workspaceRequestRequired<SkillOptimizationDetail>("skill-optimization.start");
  },
  runSkillOptimizationAction(input: { runId: string; action: "cancel" | "promote" | "reject" | "rollback"; candidateId?: string; promotionId?: string; snapshotId?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.runWorkspaceSkillOptimizationAction) {
      return bridge.runWorkspaceSkillOptimizationAction({ ...input, operationId: createIdempotencyKey() });
    }
    return workspaceRequestRequired<Record<string, unknown>>(`skill-optimization.${input.action}`);
  },
  runSurfaceOperation<T>(operation: SurfaceOperation) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.runWorkspaceCollectionSurfaceOperation && activeWorkspaceRoomId && operation.kind.startsWith("collection.")) {
      return bridge.runWorkspaceCollectionSurfaceOperation({ roomId: activeWorkspaceRoomId, operation }) as Promise<SurfaceOperationResultEnvelope<T>>;
    }
    if (bridge?.runWorkspaceArtifactSurfaceOperation && activeWorkspaceRoomId && operation.kind === "artifact.request") {
      return bridge.runWorkspaceArtifactSurfaceOperation({ roomId: activeWorkspaceRoomId, operation }) as Promise<SurfaceOperationResultEnvelope<T>>;
    }
    return workspaceRequestRequired<SurfaceOperationResultEnvelope<T>>("surface.operation.run");
  },
  updateMessagePresentationViewState(presentationId: string, viewState: Record<string, JsonValue>) {
    void presentationId;
    void viewState;
    return workspaceRequestRequired<SurfaceOperationResultEnvelope<MessagePresentationRecord>>("message.presentation.update");
  },
  submitChatSurfaceOperation(input: {
    idempotencyKey: string;
    sessionId: string;
    content: string;
    inputLocale?: SupportedLocale;
    outputLocale: SupportedLocale;
    backendId?: string;
    rendererCapabilities?: SurfaceRendererCapabilities;
    metadata?: Record<string, JsonValue>;
    attachments?: ResourceRef[];
  }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.sendWorkspaceChatMessage) {
      return bridge.sendWorkspaceChatMessage({
        sessionId: input.sessionId,
        content: input.content,
        idempotencyKey: input.idempotencyKey,
        ...(input.inputLocale ? { inputLocale: input.inputLocale } : {}),
        outputLocale: input.outputLocale,
        ...(input.backendId ? { backendId: input.backendId } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {})
      }).then((result) => {
        const envelope = result as ChatSurfaceOperationResult;
        return envelope.result && envelope.render_spec
          ? envelope
          : { result, render_spec: undefined, render_specs: [] };
      });
    }
    return workspaceRequestRequired<ChatSurfaceOperationResult>("chat.message.submit");
  },
  uploadWorkspaceAttachment(input: {
    roomId: string;
    path: string;
    contentBase64: string;
    expectedVersion: number;
    operationId: string;
    target?: DesktopWorkspaceTarget;
  }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.writeWorkspaceAttachment) return bridge.writeWorkspaceAttachment(input);
    return workspaceRequestRequired<WorkspaceAttachmentUploadResult>("workspace.file.attachment.write");
  },
  sendMessage(sessionId: string, content: string, outputLocale: SupportedLocale, idempotencyKey: string, backendId?: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.sendWorkspaceChatMessage) {
      return bridge.sendWorkspaceChatMessage({
        sessionId,
        content,
        outputLocale,
        idempotencyKey,
        ...(backendId ? { backendId } : {})
      }).then((payload) => isChatSurfaceEnvelope(payload) ? payload.result : payload);
    }
    return workspaceRequestRequired<ChatTurnResult>("chat.message.send");
  },
  startChat(content: string, uiLocale: SupportedLocale, outputLocale: SupportedLocale, idempotencyKey: string, backendId?: string) {
    return workspaceRequestRequired<ChatTurnResult>("chat.message.start");
  },
  search(query: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.searchWorkspace && activeWorkspaceRoomId) return bridge.searchWorkspace({ roomId: activeWorkspaceRoomId, query });
    return workspaceRequestRequired<SearchResult[]>("workspace.search");
  },
  getArtifact(id: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceArtifact && activeWorkspaceRoomId) {
      return bridge.getWorkspaceArtifact({ roomId: activeWorkspaceRoomId, artifactId: id });
    }
    return workspaceRequestRequired<ArtifactDetail>("artifact.get");
  },
  getAudit() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceAudit) return bridge.getWorkspaceAudit();
    return workspaceRequestRequired<AuditPayload>("workspace.audit");
  },
  getActivity() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceActivity && activeWorkspaceRoomId) return bridge.listWorkspaceActivity({ roomId: activeWorkspaceRoomId });
    return workspaceRequestRequired<ActivityInboxItem[]>("workspace.activity");
  },
  listBackendRuns(sessionId?: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceBackendRuns) return bridge.listWorkspaceBackendRuns(sessionId ? { sessionId } : {});
    return workspaceRequestRequired<BackendRunRecord[]>("runtime.runs.list");
  },
  getBackendRun(runId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceBackendRun) return bridge.getWorkspaceBackendRun({ runId });
    return workspaceRequestRequired<BackendRunRecord>("runtime.run.get");
  },
  cancelBackendRun(runId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.cancelWorkspaceBackendRun) return bridge.cancelWorkspaceBackendRun({ runId, operationId: createIdempotencyKey() });
    return workspaceRequestRequired<BackendRunRecord>("runtime.run.cancel");
  },
  retryBackendRun(runId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.retryWorkspaceBackendRun) return bridge.retryWorkspaceBackendRun({ runId, operationId: createIdempotencyKey() });
    return workspaceRequestRequired<BackendRunRecord>("runtime.run.retry");
  },
  listBackendEvents(runId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceBackendEvents) return bridge.listWorkspaceBackendEvents({ runId });
    return workspaceRequestRequired<BackendEventRecord[]>("runtime.events.list");
  },
  listWorkspaceChanges(sessionId?: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceChanges) return bridge.listWorkspaceChanges(sessionId ? { sessionId } : {});
    return workspaceRequestRequired<WorkspaceChangeRecord[]>("runtime.changes.list");
  },
  listMemory() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceKnowledgeMemory && activeWorkspaceRoomId) {
      return bridge.listWorkspaceKnowledgeMemory({ roomId: activeWorkspaceRoomId }).then((result) => result.memories.map((page) => page.memory));
    }
    return workspaceRequestRequired<Array<MemoryFrontmatter & { file_path: string }>>("knowledge-memory.list");
  },
  getMemory(id: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceKnowledgeMemory && activeWorkspaceRoomId) {
      return bridge.getWorkspaceKnowledgeMemory({ memoryId: id }).then((page) => ({ memory: page.memory, content: page.content }));
    }
    return workspaceRequestRequired<MemoryDetail>("knowledge-memory.get");
  },
  archiveMemory(id: string, sessionId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.archiveWorkspaceKnowledgeMemory && activeWorkspaceRoomId) {
      return bridge.archiveWorkspaceKnowledgeMemory({ memoryId: id, reason: "Memory archived by owner", operationId: createIdempotencyKey() });
    }
    return workspaceRequestRequired<ArchiveMemoryPayload>("knowledge-memory.archive");
  },
  listSkills() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceCompletionSkills && activeWorkspaceRoomId) {
      return bridge.listWorkspaceCompletionSkills({ roomId: activeWorkspaceRoomId }).then((result) => result.skills.map((skill) => skillIndexFromCompletion(skill)));
    }
    return workspaceRequestRequired<SkillIndexEntry[]>("skill.list");
  },
  getSkill(id: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceCompletionSkill && activeWorkspaceRoomId) {
      return bridge.getWorkspaceCompletionSkill({ resourceId: id }).then((detail) => ({
        skill: skillIndexFromCompletion(detail.resource, detail.version.metadata),
        markdown: detail.content
      }));
    }
    return workspaceRequestRequired<{ skill: SkillIndexEntry; markdown: string }>("skill.get");
  },
  patchSkill(id: string, input: { title?: string; description?: string; content?: string; tags?: string[] }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceCompletionSkill && bridge.updateWorkspaceCompletionResource && activeWorkspaceRoomId) {
      return bridge.getWorkspaceCompletionSkill({ resourceId: id }).then((detail) => {
        const metadata = { ...detail.version.metadata, ...(input.description === undefined ? {} : { description: input.description }), ...(input.tags === undefined ? {} : { tags: input.tags }) };
        return bridge.updateWorkspaceCompletionResource!({
          resourceId: id,
          scopeKind: detail.resource.scope.kind,
          ...(detail.resource.scope.kind === "room" ? { roomId: detail.resource.scope.roomId } : {}),
          kind: "skill",
          title: input.title ?? detail.resource.title,
          content: input.content ?? detail.content,
          metadata,
          reason: "ユーザーがSkill本文を編集",
          expectedVersion: detail.resource.version,
          operationId: createIdempotencyKey()
        });
      });
    }
    return workspaceRequestRequired<RuntimeWritePayload<SkillIndexEntry>>("skill.update");
  },
  setSkillActive(id: string, active: boolean) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceCompletionSkill && bridge.archiveWorkspaceCompletionResource && activeWorkspaceRoomId) {
      return bridge.getWorkspaceCompletionSkill({ resourceId: id }).then((detail) => bridge.archiveWorkspaceCompletionResource!({
        resourceId: id,
        archived: !active,
        expectedVersion: detail.resource.version,
        reason: active ? "ユーザーがSkillを再開" : "ユーザーがSkillを停止",
        operationId: createIdempotencyKey()
      }));
    }
    return workspaceRequestRequired<RuntimeWritePayload<SkillIndexEntry>>("skill.state");
  },
  listWiki() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceKnowledgeWiki && activeWorkspaceRoomId) {
      return bridge.listWorkspaceKnowledgeWiki({ roomId: activeWorkspaceRoomId }).then((result) => result.pages.map((page) => page.wiki));
    }
    return workspaceRequestRequired<Array<WikiFrontmatter & { file_path: string }>>("knowledge-wiki.list");
  },
  getWiki(id: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceKnowledgeWiki && activeWorkspaceRoomId) {
      return bridge.getWorkspaceKnowledgeWiki({ wikiId: id });
    }
    return workspaceRequestRequired<WikiDetail>("knowledge-wiki.get");
  },
  createWikiProposal(input: { title: string; content: string; slug?: string; tags?: string[]; content_locale?: SupportedLocale }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.createWorkspaceKnowledgeWiki && activeWorkspaceRoomId) {
      return bridge.createWorkspaceKnowledgeWiki({
        roomId: activeWorkspaceRoomId, title: input.title, content: input.content, ...(input.slug ? { slug: input.slug } : {}),
        ...(input.tags ? { tags: input.tags } : {}), ...(input.content_locale ? { contentLocale: input.content_locale } : {}),
        reason: "Knowledge Wiki proposal created", operationId: createIdempotencyKey()
      });
    }
    return workspaceRequestRequired<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>("knowledge-wiki.create");
  },
  acceptWiki(id: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.setWorkspaceKnowledgeWikiState && activeWorkspaceRoomId) {
      return bridge.setWorkspaceKnowledgeWikiState({ wikiId: id, state: "accept", reason: "Knowledge Wiki proposal accepted", operationId: createIdempotencyKey() });
    }
    return workspaceRequestRequired<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>("knowledge-wiki.accept");
  },
  rejectWiki(id: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.setWorkspaceKnowledgeWikiState && activeWorkspaceRoomId) {
      return bridge.setWorkspaceKnowledgeWikiState({ wikiId: id, state: "reject", reason: "Knowledge Wiki proposal rejected", operationId: createIdempotencyKey() });
    }
    return workspaceRequestRequired<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>("knowledge-wiki.reject");
  },
  patchWiki(id: string, input: Partial<Pick<WikiFrontmatter, "title" | "tags" | "content_locale">> & { content?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.updateWorkspaceKnowledgeWiki && activeWorkspaceRoomId) {
      return bridge.updateWorkspaceKnowledgeWiki({ wikiId: id, ...(input.title ? { title: input.title } : {}), ...(input.content ? { content: input.content } : {}), ...(input.tags ? { tags: input.tags } : {}), ...(input.content_locale ? { contentLocale: input.content_locale } : {}), reason: "Knowledge Wiki page updated", operationId: createIdempotencyKey() });
    }
    return workspaceRequestRequired<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>("knowledge-wiki.update");
  },
  archiveWiki(id: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.setWorkspaceKnowledgeWikiState && activeWorkspaceRoomId) {
      return bridge.setWorkspaceKnowledgeWikiState({ wikiId: id, state: "archive", reason: "Knowledge Wiki page archived", operationId: createIdempotencyKey() });
    }
    return workspaceRequestRequired<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>("knowledge-wiki.archive");
  },
  reindexWiki() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.reindexWorkspaceKnowledgeWiki && activeWorkspaceRoomId) {
      return bridge.reindexWorkspaceKnowledgeWiki({ roomId: activeWorkspaceRoomId });
    }
    return workspaceRequestRequired<RuntimeWritePayload<{ active: number; total: number }>>("knowledge-wiki.reindex");
  },
  getWikiGraph(query?: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceKnowledgeWikiGraph && activeWorkspaceRoomId) {
      return bridge.getWorkspaceKnowledgeWikiGraph({ roomId: activeWorkspaceRoomId, ...(query ? { query } : {}) });
    }
    return workspaceRequestRequired<Record<string, unknown>>("knowledge-wiki.graph");
  },
  getWikiDiagnostics() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceKnowledgeWikiLint && activeWorkspaceRoomId) {
      return bridge.getWorkspaceKnowledgeWikiLint({ roomId: activeWorkspaceRoomId });
    }
    return workspaceRequestRequired<Record<string, unknown>>("knowledge-wiki.lint");
  },
  getWikiBacklinks(id: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceKnowledgeWikiBacklinks && activeWorkspaceRoomId) {
      return bridge.getWorkspaceKnowledgeWikiBacklinks({ roomId: activeWorkspaceRoomId, wikiId: id });
    }
    return workspaceRequestRequired<Array<{ from_wiki_id: string; label: string }>>("knowledge-wiki.backlinks");
  },
  createSkillCandidate(input: { title: string; description: string; content?: string; tags?: string[]; required_capabilities?: string[] }) {
    void input;
    return workspaceRequestRequired<RuntimeWritePayload<SkillIndexEntry>>("skill.candidate.create");
  },
  saveSkillProject(candidateId: string) {
    void candidateId;
    return workspaceRequestRequired<RuntimeWritePayload<SkillIndexEntry>>("skill.project.save");
  },
  saveCollectionSchema(schema: CollectionSchema) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.saveWorkspaceCollectionSchema && activeWorkspaceRoomId) {
      return bridge.saveWorkspaceCollectionSchema({ schema, roomId: activeWorkspaceRoomId, operationId: createIdempotencyKey() });
    }
    void schema;
    return workspaceRequestRequired<RuntimeWritePayload<CollectionSchema & { file_path: string }>>("collection.schema.save");
  },
  listCollectionSchemas() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceCollectionSchemas && activeWorkspaceRoomId) {
      return bridge.listWorkspaceCollectionSchemas({ roomId: activeWorkspaceRoomId }).then((result) => result.schemas);
    }
    return workspaceRequestRequired<Array<CollectionSchema & { file_path: string }>>("collection.schema.list");
  },
  getCollectionSchema(collectionId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceCollectionSchema && activeWorkspaceRoomId) {
      return bridge.getWorkspaceCollectionSchema({ roomId: activeWorkspaceRoomId, collectionId }).then((result) => result.schema);
    }
    void collectionId;
    return workspaceRequestRequired<CollectionSchema & { file_path: string }>("collection.schema.get");
  },
  createCollectionRecord(collectionId: string, input: Partial<CollectionRecord> & { data: CollectionRecord["data"] }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.createWorkspaceCollectionRecord && activeWorkspaceRoomId) {
      return bridge.createWorkspaceCollectionRecord({
        roomId: activeWorkspaceRoomId,
        collectionId,
        recordId: input.id ?? `record_${Date.now()}`,
        data: input.data,
        operationId: createIdempotencyKey()
      });
    }
    void collectionId;
    void input;
    return workspaceRequestRequired<RuntimeWritePayload<CollectionRecord & { file_path: string }>>("collection.record.create");
  },
  listCollectionRecords(collectionId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceCollectionRecords && activeWorkspaceRoomId) {
      return bridge.listWorkspaceCollectionRecords({ roomId: activeWorkspaceRoomId, collectionId }).then((result) => result.records);
    }
    void collectionId;
    return workspaceRequestRequired<Array<CollectionRecord & { file_path: string }>>("collection.record.list");
  },
  applyCollectionPatch(collectionId: string, recordId: string, input: { id?: string; changes: Record<string, unknown>; created_at?: string }) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.patchWorkspaceCollectionRecord && activeWorkspaceRoomId) {
      return bridge.patchWorkspaceCollectionRecord({
        roomId: activeWorkspaceRoomId,
        collectionId,
        recordId,
        ...(input.id ? { patchId: input.id } : {}),
        changes: input.changes as Record<string, JsonValue>,
        operationId: createIdempotencyKey()
      });
    }
    void collectionId;
    void recordId;
    void input;
    return workspaceRequestRequired<RuntimeWritePayload<CollectionRecord & { file_path: string }>>("collection.record.patch");
  },
  deleteCollectionRecord(collectionId: string, recordId: string, expectedVersion: number) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.deleteWorkspaceCollectionRecord && activeWorkspaceRoomId) {
      return bridge.deleteWorkspaceCollectionRecord({ roomId: activeWorkspaceRoomId, collectionId, recordId, expectedVersion, operationId: createIdempotencyKey() });
    }
    void collectionId;
    void recordId;
    void expectedVersion;
    return workspaceRequestRequired<CollectionRecord & { file_path: string }>("collection.record.delete");
  },
  listCollectionNotes(collectionId: string) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceCollectionNotes && activeWorkspaceRoomId) {
      return bridge.listWorkspaceCollectionNotes({ roomId: activeWorkspaceRoomId, collectionId }).then((result) => result.notes);
    }
    void collectionId;
    return workspaceRequestRequired<Array<{ file_path: string; content: string }>>("collection.notes.list");
  },
  runMemoryReviewAutomation() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.runWorkspaceAutomationNow && activeWorkspaceRoomId) {
      return bridge.runWorkspaceAutomationNow({ roomId: activeWorkspaceRoomId, kind: "memory_review", operationId: createIdempotencyKey() });
    }
    return workspaceRequestRequired<AutomationRunPayload>("automation.memory-review.run");
  },
  listAutomationJobs() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceAutomationJobs && activeWorkspaceRoomId) {
      return bridge.listWorkspaceAutomationJobs({ roomId: activeWorkspaceRoomId }).then((result) => result.jobs);
    }
    return workspaceRequestRequired<AutomationJobRecord[]>("automation.jobs.list");
  },
  listAutomationRuns() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.listWorkspaceAutomationRuns && activeWorkspaceRoomId) {
      return bridge.listWorkspaceAutomationRuns({ roomId: activeWorkspaceRoomId }).then((result) => result.runs);
    }
    return workspaceRequestRequired<AutomationRunSummary[]>("automation.runs.list");
  },
  setAutomationStatus(id: string, status: "enabled" | "disabled") {
    const bridge = activeWorkspaceBridge();
    if (bridge?.setWorkspaceAutomationManagement && activeWorkspaceRoomId) {
      return bridge.setWorkspaceAutomationManagement({ jobId: id, state: status === "enabled" ? "allowed" : "manager_stopped", operationId: createIdempotencyKey() });
    }
    void id;
    void status;
    return workspaceRequestRequired<RuntimeWritePayload<AutomationJobRecord>>("automation.job.status");
  },
  getSettings() {
    const bridge = activeWorkspaceBridge();
    if (bridge?.getWorkspaceSettings) return bridge.getWorkspaceSettings();
    return workspaceRequestRequired<SettingsRecord>("workspace.settings.get");
  },
  patchSettings(patch: Partial<Omit<SettingsRecord, "updated_at">>) {
    const bridge = activeWorkspaceBridge();
    if (bridge?.patchWorkspaceSettings) {
      return bridge.patchWorkspaceSettings({ patch, operationId: createIdempotencyKey() }).then((result) => result.settings);
    }
    return workspaceRequestRequired<SettingsRecord>("workspace.settings.patch");
  },
  approveApprovalRequest(id: string) {
    void id;
    return workspaceRequestRequired<ApprovalLifecyclePayload>("approval.request.approve");
  },
  denyApprovalRequest(id: string, reason = "Denied by owner.") {
    void id;
    void reason;
    return workspaceRequestRequired<ApprovalLifecyclePayload>("approval.request.deny");
  },
  restoreRollbackPoint(id: string) {
    void id;
    return workspaceRequestRequired<unknown>("rollback.restore");
  }
};

function isChatSurfaceEnvelope(value: ChatTurnResult | ChatSurfaceOperationResult): value is ChatSurfaceOperationResult {
  return "result" in value && !!value.result && typeof value.result === "object";
}

function skillIndexFromCompletion(
  resource: WorkspaceCompletionResourceView,
  metadata: Record<string, JsonValue> = {}
): SkillIndexEntry {
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((value): value is string => typeof value === "string") : [];
  const requiredCapabilities = Array.isArray(metadata.required_capabilities)
    ? metadata.required_capabilities.filter((value): value is string => typeof value === "string")
    : [];
  const state: SkillIndexEntry["state"] = resource.lifecycleState === "archived"
    ? "archived"
    : resource.aiProtection === "fixed" ? "pinned" : "active";
  return {
    id: resource.id,
    title: resource.title,
    description: typeof metadata.description === "string" ? metadata.description : resource.title,
    tags,
    state,
    required_capabilities: requiredCapabilities,
    file_path: `completion/skills/${resource.id}`
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (typeof response.text !== "function" && typeof response.json === "function") {
    return response.json();
  }
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
