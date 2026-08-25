/**
 * Runtimeが利用するWorkspaceの能力境界。
 *
 * ここにはRuntimeが実際に呼び出す操作だけを置き、Store実装やDB型は公開しない。
 * 実装側はPostgreSQLの正式なWorkspace境界、または同じ契約を実装する
 * テスト用Portでこの契約を満たす。Runtimeは保存方式を直接参照しない。
 */
import type { BackendRunRecord, JsonValue, RoomRecord, WorkspaceFilePort } from "@samurai-agent/core-schemas";
import type { AgentWorkspacePermission, ResourceAccessMode, RoomHumanRole, RoomShareableResourceKind, WorkspaceRole } from "@samurai-agent/room-permissions";
import type { HostStorePort } from "../host/host-types";
import type { DomainCommandExecutionPort } from "../commands/domain-command-bus";
import type { ExecutionStorePort, WorkspaceBackupRecord, WorkspaceRepairResult, WorkspaceRestoreResult } from "../commands/services/execution-domain-service";
import type { ArtifactDraftStorePort } from "@samurai-agent/artifacts";
import type { MemoryRetrievalPort, MemoryWritePort } from "@samurai-agent/memory";

export type { WorkspaceBackupRecord, WorkspaceRepairResult, WorkspaceRestoreResult } from "../commands/services/execution-domain-service";

export interface WorkspaceMemberRecord {
  id: string;
  participant_id: string;
  role: WorkspaceRole;
  joined_at: string;
  removed_at?: string;
  created_by_participant_id: string;
  removed_by_participant_id?: string;
  updated_at: string;
}
export interface RoomMemberRecord {
  id: string;
  room_id: string;
  participant_id: string;
  role: RoomHumanRole;
  joined_at: string;
  removed_at?: string;
  created_by_participant_id: string;
  removed_by_participant_id?: string;
  updated_at: string;
}
export interface RoomAgentPermissionRecord {
  id: string;
  room_id: string;
  agent_id: string;
  can_view: boolean;
  can_edit: boolean;
  can_execute: boolean;
  joined_at: string;
  removed_at?: string;
  created_by_participant_id: string;
  removed_by_participant_id?: string;
  updated_at: string;
}
export interface AgentWorkspacePermissionRecord {
  id: string;
  agent_id: string;
  permission: AgentWorkspacePermission;
  granted_at: string;
  revoked_at?: string;
  granted_by_participant_id: string;
  revoked_by_participant_id?: string;
  updated_at: string;
}
export interface ResourceAccessBoundaryRecord {
  id: string;
  resource_kind: RoomShareableResourceKind;
  resource_id: string;
  source_room_id: string;
  owner_participant_id: string;
  creator_participant_id?: string;
  resource_created_at?: string;
  boundary_registered_at: string;
  updated_at: string;
}
export interface RoomResourceShareRecord {
  id: string;
  resource_access_boundary_id: string;
  source_room_id: string;
  target_room_id: string;
  shared_by_participant_id: string;
  created_at: string;
  revoked_at?: string;
  revoked_by_participant_id?: string;
  updated_at: string;
}

export type MemoryWithFilePath = import("@samurai-agent/core-schemas").MemoryFrontmatter & { file_path: string };
export interface SkillIndexEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  state: import("@samurai-agent/core-schemas").SkillFrontmatter["state"];
  allowed_scopes: import("@samurai-agent/core-schemas").SkillFrontmatter["allowed_scopes"];
  required_capabilities: string[];
  owner_pinned: boolean;
  frontmatter: import("@samurai-agent/core-schemas").SkillFrontmatter;
  file_path?: string;
}
export type SkillWithFilePath = SkillIndexEntry & { file_path: string; resource_version: number };
export type WikiWithFilePath = import("@samurai-agent/core-schemas").WikiFrontmatter & { file_path: string; resource_version: number };
export type CollectionSchemaWithFilePath = import("@samurai-agent/core-schemas").CollectionSchema & { file_path: string; resource_version?: number };
export type CollectionRecordWithFilePath = Omit<import("@samurai-agent/core-schemas").CollectionRecord, "version"> & { version: number; file_path: string };
export interface SkillSupportFile { skill_id: string; path: string; file_path: string; content: string; }
export interface SkillSupportFileRef { skill_id: string; path: string; file_path: string; }
export type UsageScopeQueryContext = import("@samurai-agent/core-schemas").ActivityContextRef;
export interface ManagedResourceBoundary { sourceRoomId: string; ownerParticipantId: string; creatorParticipantId?: string; resourceCreatedAt?: string; }
export interface SearchResult { kind: "session" | "message" | "artifact" | "audit"; id: string; title: string; summary: string; session_id?: string; operation_id?: string; }
export interface CollectionResolvedRef { ref_id: string; field: string; target_collection_id: string; target_record_id: string; record: CollectionRecordWithFilePath; resource_ref: import("@samurai-agent/core-schemas").ResourceRef; }
export interface CollectionMissingRef { ref_id: string; field: string; target_collection_id: string; target_record_id?: string; reason: "empty" | "invalid" | "not_found"; }
export interface CollectionResolvedEmbed { embed_id: string; field: string; value: import("@samurai-agent/core-schemas").JsonValue; }
export interface CollectionRecordResolution { collection_id: string; record_id: string; resolved_refs: CollectionResolvedRef[]; missing_refs: CollectionMissingRef[]; embed_fields: CollectionResolvedEmbed[]; }
export interface CollectionTriggerEffect {
  id: string;
  event: "record.created" | "record.patched";
  action_id: string;
  action_kind: string;
  status: "queued" | "ignored";
  reason?: string;
  record_ref: import("@samurai-agent/core-schemas").ResourceRef;
}
/** Runtime-authorized snapshot persisted with a Collection-trigger job. */
export interface CollectionTriggerDelivery {
  workspaceId: string;
  roomId: string;
  authority: NonNullable<import("@samurai-agent/core-schemas").AutomationJobRecord["authority"]>;
  createdPrincipalSnapshot: NonNullable<import("@samurai-agent/core-schemas").AutomationJobRecord["created_principal_snapshot"]>;
  sourceSnapshot: NonNullable<import("@samurai-agent/core-schemas").AutomationJobRecord["source_snapshot"]>;
  connectionId?: string;
  sessionRef?: NonNullable<import("@samurai-agent/core-schemas").AutomationJobRecord["session_ref"]>;
}
export interface CollectionTriggerWriteRequest {
  event: CollectionTriggerEffect["event"];
  operationId: string;
  delivery: CollectionTriggerDelivery;
}
export interface WikiReindexResult {
  active: number;
  total: number;
  files: number;
  indexed: number;
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: Array<{ file_path: string; message: string }>;
}
export interface CollectionReindexResult {
  schemas: { files: number; indexed: number; created: number; updated: number; removed: number; skipped: number; errors: Array<{ file_path: string; message: string }> };
  records: { files: number; indexed: number; created: number; updated: number; removed: number; skipped: number; errors: Array<{ file_path: string; message: string }> };
}
export interface ArchiveMemoryResult { before: { frontmatter: import("@samurai-agent/core-schemas").MemoryFrontmatter; file_path: string; state: import("@samurai-agent/core-schemas").MemoryFrontmatter["state"]; updated_at: string }; after: { frontmatter: import("@samurai-agent/core-schemas").MemoryFrontmatter; file_path: string; state: import("@samurai-agent/core-schemas").MemoryFrontmatter["state"]; updated_at: string }; content: string; changed: boolean; warning?: string; }
export interface CollectionRoomCandidateOptions { resourceIds?: string[]; includeLegacy?: boolean; }
export interface AutomationRunSettlementInput { jobId: string; runId: string; lockOwnerToken: string; outcome: "completed" | "failed" | "blocked" | "manager_stopped"; now: string; nextRunAt?: string; retryAfterAt?: string; errorCode?: string; error?: string; }
export interface AutomationRunClaim { job: import("@samurai-agent/core-schemas").AutomationJobRecord; run: import("@samurai-agent/core-schemas").AutomationRunRecord; }
export type AutomationRunRecord = import("@samurai-agent/core-schemas").AutomationRunRecord;
export type SessionSearchIndexMode = "fts5_trigram" | "fts5" | "like";

export interface RuntimeWorkspaceOperationsPort {
  getRoom:(id: string) => Promise<RoomRecord | undefined>;
  listRooms:() => Promise<RoomRecord[]>;
  patchRoom:(input: { id: string; name: string; }) => Promise<RoomRecord | undefined>;
  createAgent:(record: import("@samurai-agent/core-schemas").AgentRecord) => Promise<import("@samurai-agent/core-schemas").AgentRecord>;
  getAgent:(id: string) => Promise<import("@samurai-agent/core-schemas").AgentRecord | undefined>;
  listAgents:() => Promise<import("@samurai-agent/core-schemas").AgentRecord[]>;
  patchAgent:(input: { id: string; name?: string; role?: string; instructions?: string; enabled?: boolean; }) => Promise<import("@samurai-agent/core-schemas").AgentRecord | undefined>;
  bindAgentBackend:(input: { id: string; backend_id: string; }) => Promise<import("@samurai-agent/core-schemas").AgentRecord | undefined>;
  createRoomWithOwner:(room: RoomRecord, ownerParticipantId: string) => Promise<RoomRecord>;
  getWorkspaceMember:(participantId: string) => Promise<WorkspaceMemberRecord | undefined>;
  listWorkspaceMembers:(input?: { includeRemoved?: boolean; }) => Promise<WorkspaceMemberRecord[]>;
  addWorkspaceMember:(input: { participantId: string; role: Exclude<import("@samurai-agent/room-permissions").WorkspaceRole, "owner">; actorId: string; }) => Promise<WorkspaceMemberRecord>;
  changeWorkspaceMemberRole:(input: { participantId: string; role: Exclude<import("@samurai-agent/room-permissions").WorkspaceRole, "owner">; actorId: string; }) => Promise<WorkspaceMemberRecord | undefined>;
  removeWorkspaceMember:(input: { participantId: string; actorId: string; }) => Promise<WorkspaceMemberRecord | undefined>;
  transferWorkspaceOwnership:(input: { fromParticipantId: string; toParticipantId: string; actorId: string; }) => Promise<{ previousOwner: WorkspaceMemberRecord; owner: WorkspaceMemberRecord; }>;
  getRoomMember:(roomId: string, participantId: string) => Promise<RoomMemberRecord | undefined>;
  listRoomMembers:(roomId: string, input?: { includeRemoved?: boolean; }) => Promise<RoomMemberRecord[]>;
  addRoomMember:(input: { roomId: string; participantId: string; role: Exclude<import("@samurai-agent/room-permissions").RoomHumanRole, "owner">; actorId: string; }) => Promise<RoomMemberRecord>;
  changeRoomMemberRole:(input: { roomId: string; participantId: string; role: Exclude<import("@samurai-agent/room-permissions").RoomHumanRole, "owner">; actorId: string; }) => Promise<RoomMemberRecord | undefined>;
  removeRoomMember:(input: { roomId: string; participantId: string; actorId: string; }) => Promise<RoomMemberRecord | undefined>;
  transferRoomOwnership:(input: { roomId: string; fromParticipantId: string; toParticipantId: string; actorId: string; }) => Promise<{ previousOwner: RoomMemberRecord; owner: RoomMemberRecord; }>;
  recoverOwnerlessRoom:(input: { roomId: string; ownerParticipantId: string; actorId: string; }) => Promise<RoomMemberRecord>;
  listOwnerlessRoomIds:() => Promise<string[]>;
  getRoomAgent:(roomId: string, agentId: string) => Promise<RoomAgentPermissionRecord | undefined>;
  listRoomAgents:(roomId: string, input?: { includeRemoved?: boolean; }) => Promise<RoomAgentPermissionRecord[]>;
  setRoomAgentPermissions:(input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean; actorId: string; }) => Promise<RoomAgentPermissionRecord>;
  removeRoomAgent:(input: { roomId: string; agentId: string; actorId: string; }) => Promise<RoomAgentPermissionRecord | undefined>;
  getAgentWorkspacePermission:(agentId: string, permission?: import("@samurai-agent/room-permissions").AgentWorkspacePermission) => Promise<AgentWorkspacePermissionRecord | undefined>;
  setAgentWorkspacePermission:(input: { agentId: string; permission: import("@samurai-agent/room-permissions").AgentWorkspacePermission; allowed: boolean; actorId: string; }) => Promise<AgentWorkspacePermissionRecord | undefined>;
  getResourceAccessBoundary:(resourceKind: string, resourceId: string) => Promise<ResourceAccessBoundaryRecord | undefined>;
  ensureResourceAccessBoundary:(input: { resourceKind: import("@samurai-agent/room-permissions").RoomShareableResourceKind; resourceId: string; sourceRoomId: string; ownerParticipantId: string; creatorParticipantId?: string; resourceCreatedAt?: string; actorId: string; }) => Promise<ResourceAccessBoundaryRecord>;
  listRoomResourceShares:(resourceAccessBoundaryId: string, input?: { includeRevoked?: boolean; }) => Promise<RoomResourceShareRecord[]>;
  shareResource:(input: { resourceAccessBoundaryId: string; sourceRoomId: string; targetRoomId: string; actorId: string; }) => Promise<RoomResourceShareRecord>;
  revokeRoomResourceShare:(input: { resourceAccessBoundaryId: string; sourceRoomId: string; targetRoomId: string; actorId: string; }) => Promise<RoomResourceShareRecord | undefined>;
  getResourceAccessMode:(input: { resourceKind: string; resourceId: string; roomId: string; participantId: string; }) => Promise<import("@samurai-agent/room-permissions").ResourceAccessMode>;
  listResourceIdsAvailableInRoom:(input: { resourceKind: string; roomId: string; }) => Promise<string[]>;
  listRoomIdsForHuman:(participantId: string) => Promise<string[]>;
  listRoomIdsForAgent:(agentId: string) => Promise<string[]>;
  createSession:(session: import("@samurai-agent/core-schemas").SessionRecord) => Promise<import("@samurai-agent/core-schemas").SessionRecord>;
  listSessions:(input?: { ids?: string[]; roomIds?: string[]; }) => Promise<import("@samurai-agent/core-schemas").SessionRecord[]>;
  getSession:(sessionId: string) => Promise<import("@samurai-agent/core-schemas").SessionRecord | undefined>;
  saveMessage:(message: import("@samurai-agent/core-schemas").MessageRecord) => Promise<import("@samurai-agent/core-schemas").MessageRecord>;
  listMessages:(sessionId: string) => Promise<import("@samurai-agent/core-schemas").MessageRecord[]>;
  saveMessagePresentation:(presentation: import("@samurai-agent/core-schemas").MessagePresentationRecord) => Promise<import("@samurai-agent/core-schemas").MessagePresentationRecord>;
  getMessagePresentation:(id: string) => Promise<import("@samurai-agent/core-schemas").MessagePresentationRecord | undefined>;
  updateMessagePresentationViewState:(input: { id: string; viewState: Record<string, import("@samurai-agent/core-schemas").JsonValue>; updatedAt?: string; }) => Promise<import("@samurai-agent/core-schemas").MessagePresentationRecord | undefined>;
  listMessagePresentations:(input: { sessionId: string; messageId?: string; }) => Promise<import("@samurai-agent/core-schemas").MessagePresentationRecord[]>;
  saveOperation:(operation: import("@samurai-agent/core-schemas").OperationRecord) => Promise<import("@samurai-agent/core-schemas").OperationRecord>;
  updateOperation:(operation: import("@samurai-agent/core-schemas").OperationRecord) => Promise<import("@samurai-agent/core-schemas").OperationRecord>;
  getOperation:(operationId: string) => Promise<import("@samurai-agent/core-schemas").OperationRecord | undefined>;
  listOperations:(sessionId?: string) => Promise<import("@samurai-agent/core-schemas").OperationRecord[]>;
  listOperationsForRoom:(roomId: string) => Promise<import("@samurai-agent/core-schemas").OperationRecord[]>;
  saveBackendRun:(run: BackendRunRecord) => Promise<BackendRunRecord>;
  commitCore02RunTransition:(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; }) => Promise<BackendRunRecord>;
  updateRunMetadata:(input: { runId: string; metadata: Record<string, JsonValue> }) => Promise<BackendRunRecord>;
  getBackendRun:(runId: string) => Promise<BackendRunRecord | undefined>;
  listBackendRuns:(sessionId?: string) => Promise<BackendRunRecord[]>;
  appendCore02Event:(event: import("@samurai-agent/core-schemas").BackendEventRecord) => Promise<{ event: import("@samurai-agent/core-schemas").BackendEventRecord; duplicate: boolean; }>;
  listBackendEvents:(input?: { runId?: string; sessionId?: string; afterSequence?: number; limit?: number; }) => Promise<import("@samurai-agent/core-schemas").BackendEventRecord[]>;
  saveWorkspaceChange:(changeInput: import("@samurai-agent/core-schemas").NewWorkspaceChangeRecord) => Promise<import("@samurai-agent/core-schemas").WorkspaceChangeRecord>;
  setWorkspaceChangeCorrelation:(changeId: string, correlationId: string) => Promise<void>;
  listWorkspaceChanges:(sessionId?: string) => Promise<import("@samurai-agent/core-schemas").WorkspaceChangeRecord[]>;
  listWorkspaceChangesForOperation:(operationId: string) => Promise<import("@samurai-agent/core-schemas").WorkspaceChangeRecord[]>;
  saveToolRun:(run: import("@samurai-agent/core-schemas").ToolRunRecord) => Promise<import("@samurai-agent/core-schemas").ToolRunRecord>;
  listToolRuns:(input?: { runId?: string; sessionId?: string; }) => Promise<import("@samurai-agent/core-schemas").ToolRunRecord[]>;
  getActivity:(id: string) => Promise<import("@samurai-agent/core-schemas").ActivityRecord | undefined>;
  getActivityByIdempotency:(input: { workspaceId: string; idempotencyKey: string; }) => Promise<import("@samurai-agent/core-schemas").ActivityRecord | undefined>;
  getActivityByBackendRunId:(backendRunId: string) => Promise<import("@samurai-agent/core-schemas").ActivityRecord | undefined>;
  listResourceUsage:(input: { activityId: string; workspaceJobAttemptId?: string; }) => Promise<import("@samurai-agent/core-schemas").ResourceUsageRecord[]>;
  saveClientEvent:(event: import("@samurai-agent/core-schemas").ClientEventRecord) => Promise<import("@samurai-agent/core-schemas").ClientEventRecord>;
  markClientEventDelivered:(eventId: string, deliveredAt?: string) => Promise<import("@samurai-agent/core-schemas").ClientEventRecord | undefined>;
  ackClientEvent:(eventId: string, ackedAt?: string) => Promise<import("@samurai-agent/core-schemas").ClientEventRecord | undefined>;
  failClientEvent:(eventId: string, errorCode: string, failedAt?: string) => Promise<import("@samurai-agent/core-schemas").ClientEventRecord | undefined>;
  expireClientEvents:(input?: { now?: string; }) => Promise<import("@samurai-agent/core-schemas").ClientEventRecord[]>;
  saveObjective:(record: import("@samurai-agent/core-schemas").ObjectiveRecord, roomId?: string) => Promise<import("@samurai-agent/core-schemas").ObjectiveRecord>;
  getObjective:(id: string, roomId?: string) => Promise<import("@samurai-agent/core-schemas").ObjectiveRecord | undefined>;
  updateObjective:(record: import("@samurai-agent/core-schemas").ObjectiveRecord, roomId?: string) => Promise<import("@samurai-agent/core-schemas").ObjectiveRecord>;
  saveWorkItem:(record: import("@samurai-agent/core-schemas").WorkItemRecord, roomId?: string) => Promise<import("@samurai-agent/core-schemas").WorkItemRecord>;
  getWorkItem:(id: string, roomId?: string) => Promise<import("@samurai-agent/core-schemas").WorkItemRecord | undefined>;
  claimWorkItem:(input: { workerId: string; leaseMs: number; roomId?: string; now?: string; }) => Promise<import("@samurai-agent/core-schemas").WorkItemRecord | undefined>;
  completeWorkItem:(input: { workItemId: string; workerId: string; roomId?: string; now?: string; }) => Promise<import("@samurai-agent/core-schemas").WorkItemRecord | undefined>;
  failWorkItem:(input: { workItemId: string; workerId: string; roomId?: string; failureKind: "retryable" | "non_retryable" | "cancelled"; error: string; now?: string; baseRetryMs?: number; }) => Promise<import("@samurai-agent/core-schemas").WorkItemRecord | undefined>;
  getArtifact:(id: string) => Promise<import("@samurai-agent/core-schemas").ArtifactRecord | undefined>;
  listArtifacts:(input?: { artifactIds?: readonly string[]; }) => Promise<import("@samurai-agent/core-schemas").ArtifactRecord[]>;
  listArtifactsForSession:(sessionId: string) => Promise<import("@samurai-agent/core-schemas").ArtifactRecord[]>;
  createArtifactRevision:(input: { artifactId: string; content: string | Uint8Array; producerRunId?: string; extension?: string; baseRevisionId?: string; expectedRevision?: number; editorSource?: import("@samurai-agent/core-schemas").ArtifactRevisionRecord["editor_source"]; changeSummary?: string; provenance?: Record<string, import("@samurai-agent/core-schemas").JsonValue>; }) => Promise<{ artifact: import("@samurai-agent/core-schemas").ArtifactRecord; revision: import("@samurai-agent/core-schemas").ArtifactRevisionRecord; }>;
  listArtifactRevisions:(artifactId: string) => Promise<import("@samurai-agent/core-schemas").ArtifactRevisionRecord[]>;
  getArtifactRevision:(revisionId: string) => Promise<import("@samurai-agent/core-schemas").ArtifactRevisionRecord | undefined>;
  readArtifactRevisionContent:(revisionId: string) => Promise<Uint8Array | undefined>;
  repairArtifactRevisionSource:(artifactId: string) => Promise<{ repaired: boolean; revision?: import("@samurai-agent/core-schemas").ArtifactRevisionRecord; }>;
  readArtifactContent:(id: string) => Promise<string | undefined>;
  saveGeneratedSurfaceRevision:(input: { definition: import("@samurai-agent/core-schemas").GeneratedSurfaceDefinition; revision: import("@samurai-agent/core-schemas").GeneratedSurfaceRevisionRecord; html: string; css?: string; script?: string; assets?: Array<{ path: string; content: string; encoding?: "utf8" | "base64"; }>; }) => Promise<{ definition: import("@samurai-agent/core-schemas").GeneratedSurfaceDefinition; revision: import("@samurai-agent/core-schemas").GeneratedSurfaceRevisionRecord; }>;
  getGeneratedSurface:(id: string) => Promise<import("@samurai-agent/core-schemas").GeneratedSurfaceDefinition | undefined>;
  listGeneratedSurfaces:(sessionId?: string) => Promise<import("@samurai-agent/core-schemas").GeneratedSurfaceDefinition[]>;
  getGeneratedSurfaceRevision:(id: string) => Promise<import("@samurai-agent/core-schemas").GeneratedSurfaceRevisionRecord | undefined>;
  readGeneratedSurfaceBundle:(revisionId: string) => Promise<{ html: string; css?: string; script?: string; } | undefined>;
  updateGeneratedSurfaceState:(id: string, state: import("@samurai-agent/core-schemas").GeneratedSurfaceDefinition["state"], updatedAt?: string) => Promise<import("@samurai-agent/core-schemas").GeneratedSurfaceDefinition | undefined>;
  saveSurfaceInteraction:(record: import("@samurai-agent/core-schemas").SurfaceInteractionRecord) => Promise<import("@samurai-agent/core-schemas").SurfaceInteractionRecord>;
  saveMemory:(frontmatter: import("@samurai-agent/core-schemas").MemoryFrontmatter, content: string) => Promise<import("@samurai-agent/core-schemas").MemoryFrontmatter>;
  replaceMemoryContent:(id: string, content: string) => Promise<MemoryWithFilePath | undefined>;
  patchMemoryLearningMetadata:(input: { id: string; metadata: Partial<Pick<import("@samurai-agent/core-schemas").MemoryFrontmatter, "evidence_state" | "usage_state" | "usage_scope" | "origin_activity_context" | "source_run_ids" | "source_refs" | "provenance" | "version" | "content_hash" | "pinned">>; }) => Promise<MemoryWithFilePath | undefined>;
  listMemory:(options?: { includeArchived?: boolean; activityContext?: UsageScopeQueryContext; resourceIds?: string[]; includeLegacy?: boolean; }) => Promise<MemoryWithFilePath[]>;
  listMemoryForSession:(sessionId: string, options?: { includeArchived?: boolean; activityContext?: UsageScopeQueryContext; resourceIds?: string[]; includeLegacy?: boolean; }) => Promise<MemoryWithFilePath[]>;
  searchMemory:(query: string, limit?: number, options?: { includeArchived?: boolean; activityContext?: UsageScopeQueryContext; resourceIds?: string[]; includeLegacy?: boolean; }) => Promise<MemoryWithFilePath[]>;
  getMemory:(id: string) => Promise<MemoryWithFilePath | undefined>;
  readMemoryContent:(id: string) => Promise<string | undefined>;
  readMemoryMarkdown:(id: string) => Promise<string | undefined>;
  restoreMemoryVersionMarkdown:(input: { id: string; markdown: string; version: string; }) => Promise<MemoryWithFilePath | undefined>;
  archiveMemory:(id: string) => Promise<ArchiveMemoryResult | undefined>;
  saveWikiPage:(frontmatter: import("@samurai-agent/core-schemas").WikiFrontmatter, content: string) => Promise<WikiWithFilePath>;
  listWiki:(options?: { activeOnly?: boolean; activityContext?: UsageScopeQueryContext; resourceIds?: string[]; includeLegacy?: boolean; }) => Promise<WikiWithFilePath[]>;
  searchWiki:(query: string, limit?: number, options?: { activeOnly?: boolean; activityContext?: UsageScopeQueryContext; resourceIds?: string[]; includeLegacy?: boolean; }) => Promise<WikiWithFilePath[]>;
  getWiki:(id: string) => Promise<WikiWithFilePath | undefined>;
  readWikiContent:(id: string) => Promise<string | undefined>;
  readWikiMarkdown:(id: string) => Promise<string | undefined>;
  copyWikiPage:(input: { source_id: string; target_id: string; target_slug: string; target_usage_scope: NonNullable<import("@samurai-agent/core-schemas").WikiFrontmatter["usage_scope"]>; expected_source_resource_version: number; target_boundary?: ManagedResourceBoundary; }) => Promise<WikiWithFilePath | undefined>;
  moveWikiPage:(input: { id: string; source_room_id: string; target_room_id: string; expected_resource_version: number; }) => Promise<WikiWithFilePath | undefined>;
  updateWikiPage:(input: { id: string; title?: string; content?: string; tags?: string[]; content_locale?: import("@samurai-agent/core-schemas").WikiFrontmatter["content_locale"]; source_refs?: import("@samurai-agent/core-schemas").WikiFrontmatter["source_refs"]; provenance?: import("@samurai-agent/core-schemas").WikiFrontmatter["provenance"]; usage_scope?: import("@samurai-agent/core-schemas").WikiFrontmatter["usage_scope"]; pinned?: boolean; expected_resource_version?: number; }) => Promise<WikiWithFilePath | undefined>;
  patchWikiLearningMetadata:(input: { id: string; metadata: Partial<Pick<import("@samurai-agent/core-schemas").WikiFrontmatter, "knowledge_kind" | "experience_rule" | "evidence_state" | "usage_state" | "usage_scope" | "origin_activity_context" | "source_run_ids" | "source_refs" | "provenance" | "version" | "content_hash" | "pinned">>; }) => Promise<WikiWithFilePath | undefined>;
  restoreWikiVersionMarkdown:(input: { id: string; markdown: string; version: string; }) => Promise<WikiWithFilePath | undefined>;
  setWikiState:(id: string, state: import("@samurai-agent/core-schemas").WikiFrontmatter["state"], expectedResourceVersion?: number) => Promise<WikiWithFilePath | undefined>;
  saveSkillOptimizationRun:(input: import("@samurai-agent/core-schemas").SkillOptimizationRun) => Promise<import("@samurai-agent/core-schemas").SkillOptimizationRun>;
  getSkillOptimizationRun:(id: string) => Promise<import("@samurai-agent/core-schemas").SkillOptimizationRun | undefined>;
  saveSkillOptimizationDataset:(input: import("@samurai-agent/core-schemas").SkillOptimizationDataset) => Promise<import("@samurai-agent/core-schemas").SkillOptimizationDataset>;
  saveOptimizationCandidate:(input: import("@samurai-agent/core-schemas").OptimizationCandidate) => Promise<import("@samurai-agent/core-schemas").OptimizationCandidate>;
  getOptimizationCandidate:(id: string) => Promise<import("@samurai-agent/core-schemas").OptimizationCandidate | undefined>;
  saveOptimizationEvaluation:(input: import("@samurai-agent/core-schemas").OptimizationEvaluation) => Promise<import("@samurai-agent/core-schemas").OptimizationEvaluation>;
  saveSkillOptimizationSnapshot:(input: import("@samurai-agent/core-schemas").SkillOptimizationSnapshot) => Promise<import("@samurai-agent/core-schemas").SkillOptimizationSnapshot>;
  getSkillOptimizationSnapshot:(id: string) => Promise<import("@samurai-agent/core-schemas").SkillOptimizationSnapshot | undefined>;
  saveOptimizationPromotion:(input: import("@samurai-agent/core-schemas").OptimizationPromotion) => Promise<import("@samurai-agent/core-schemas").OptimizationPromotion>;
  listOptimizationPromotions:(input?: { skillId?: string; candidateId?: string; }) => Promise<import("@samurai-agent/core-schemas").OptimizationPromotion[]>;
  acquireSkillOptimizationLock:(input: { skillId: string; runId: string; acquiredAt?: string; }) => Promise<boolean>;
  getSkillOptimizationLock:(skillId: string) => Promise<{ skill_id: string; run_id: string; acquired_at: string; } | undefined>;
  releaseSkillOptimizationLock:(input: { skillId: string; runId: string; }) => Promise<boolean>;
  saveSkillMarkdown:(input: { state: "candidate" | "project"; skillId: string; markdown: string; }) => Promise<SkillWithFilePath>;
  copySkill:(input: { source_id: string; target_id: string; target_usage_scope: NonNullable<import("@samurai-agent/core-schemas").SkillFrontmatter["usage_scope"]>; expected_source_resource_version: number; target_boundary?: ManagedResourceBoundary; }) => Promise<SkillWithFilePath | undefined>;
  moveSkill:(input: { id: string; source_room_id: string; target_room_id: string; expected_resource_version: number; }) => Promise<SkillWithFilePath | undefined>;
  listSkills:(options?: { activityContext?: UsageScopeQueryContext; resourceIds?: string[]; includeLegacy?: boolean; }) => Promise<SkillWithFilePath[]>;
  getSkill:(id: string) => Promise<SkillWithFilePath | undefined>;
  readSkillMarkdown:(id: string) => Promise<string | undefined>;
  patchSkill:(input: { id: string; title?: string; description?: string; tags?: string[]; content?: string; pinned?: boolean; usage_scope?: import("@samurai-agent/core-schemas").SkillFrontmatter["usage_scope"]; expected_resource_version?: number; }) => Promise<SkillWithFilePath | undefined>;
  updateSkillState:(id: string, state: import("@samurai-agent/core-schemas").SkillFrontmatter["state"]) => Promise<SkillWithFilePath | undefined>;
  replaceSkillContent:(id: string, content: string) => Promise<SkillWithFilePath | undefined>;
  patchSkillLearningMetadata:(input: { id: string; metadata: Partial<Pick<import("@samurai-agent/core-schemas").SkillFrontmatter, "evidence_state" | "usage_state" | "usage_scope" | "origin_activity_context" | "source_run_ids" | "source_refs" | "provenance_detail" | "version" | "content_hash" | "pinned" | "created_at" | "updated_at">>; }) => Promise<SkillWithFilePath | undefined>;
  restoreSkillVersionMarkdown:(input: { id: string; markdown: string; version: string; }) => Promise<SkillWithFilePath | undefined>;
  replaceSkillContentIfUnchanged:(input: { id: string; expectedContentHash: string; content: string; lockRunId?: string; }) => Promise<SkillWithFilePath | undefined>;
  recordSkillUsage:(input: { skillId: string; runId?: string; usedAt?: string; }) => Promise<import("@samurai-agent/core-schemas").SkillUsageRecord>;
  listSkillUsage:(input?: { skillIds?: string[]; }) => Promise<import("@samurai-agent/core-schemas").SkillUsageRecord[]>;
  writeSkillSupportFile:(input: { skillId: string; path: string; content: string; }) => Promise<SkillSupportFile>;
  readSkillSupportFile:(input: { skillId: string; path: string; }) => Promise<SkillSupportFile | undefined>;
  listSkillSupportFiles:(skillId: string) => Promise<SkillSupportFile[]>;
  listSkillSupportFileRefs:(skillId: string) => Promise<SkillSupportFileRef[]>;
  searchSkills:(query: string, limit?: number, options?: { states?: import("@samurai-agent/core-schemas").SkillFrontmatter["state"][]; activityContext?: UsageScopeQueryContext; resourceIds?: string[]; includeLegacy?: boolean; }) => Promise<SkillWithFilePath[]>;
  recordLearningResourceUse:(record: import("@samurai-agent/core-schemas").LearningResourceUseRecord) => Promise<import("@samurai-agent/core-schemas").LearningResourceUseRecord>;
  listLearningResourceUses:(input?: { runId?: string; sessionId?: string; resourceKind?: string; resourceId?: string; resourceIds?: string[]; activityContext?: import("@samurai-agent/core-schemas").ActivityContextRef; }) => Promise<import("@samurai-agent/core-schemas").LearningResourceUseRecord[]>;
  saveLearningEvaluation:(record: import("@samurai-agent/core-schemas").LearningEvaluationRecord) => Promise<import("@samurai-agent/core-schemas").LearningEvaluationRecord>;
  listLearningEvaluations:(input?: { resourceId?: string; resourceIds?: string[]; taskClass?: string; activityContext?: import("@samurai-agent/core-schemas").ActivityContextRef; }) => Promise<import("@samurai-agent/core-schemas").LearningEvaluationRecord[]>;
  saveLearningResourceVersion:(input: { record: import("@samurai-agent/core-schemas").LearningResourceVersionRecord; previousContent?: string; }) => Promise<import("@samurai-agent/core-schemas").LearningResourceVersionRecord>;
  getLearningResourceVersion:(input: { resourceKind: import("@samurai-agent/core-schemas").LearningResourceVersionRecord["resource_kind"]; resourceId: string; version: string; }) => Promise<import("@samurai-agent/core-schemas").LearningResourceVersionRecord | undefined>;
  getCurrentLearningResourceVersion:(input: { resourceKind: import("@samurai-agent/core-schemas").LearningResourceVersionRecord["resource_kind"]; resourceId: string; }) => Promise<import("@samurai-agent/core-schemas").LearningResourceVersionRecord | undefined>;
  listLearningResourceVersions:(input?: { resourceKind?: import("@samurai-agent/core-schemas").LearningResourceVersionRecord["resource_kind"]; resourceId?: string; resourceIds?: string[]; }) => Promise<import("@samurai-agent/core-schemas").LearningResourceVersionRecord[]>;
  readLearningResourceVersionContent:(input: { resourceKind: import("@samurai-agent/core-schemas").LearningResourceVersionRecord["resource_kind"]; resourceId: string; version: string; }) => Promise<string | undefined>;
  createLearningSnapshot:(runId: string) => Promise<import("@samurai-agent/core-schemas").LearningSnapshotRecord>;
  listLearningSnapshots:() => Promise<import("@samurai-agent/core-schemas").LearningSnapshotRecord[]>;
  pruneLearningSnapshots:(retain?: number) => Promise<{ retained: number; removed: string[]; }>;
  restoreLearningSnapshot:(id: string, options?: { allowRoomScope?: boolean; roomId?: string; }) => Promise<import("@samurai-agent/core-schemas").LearningSnapshotRecord | undefined>;
  saveBackgroundReviewChange:(record: import("@samurai-agent/core-schemas").BackgroundReviewChangeRecord) => Promise<import("@samurai-agent/core-schemas").BackgroundReviewChangeRecord>;
  rollbackBackgroundReviewMetadata:(reviewRunId: string) => Promise<void>;
  saveLearningJobReport:(record: import("@samurai-agent/core-schemas").LearningJobReportRecord) => Promise<import("@samurai-agent/core-schemas").LearningJobReportRecord>;
  getCuratorState:() => Promise<import("@samurai-agent/core-schemas").CuratorStateRecord>;
  saveCuratorState:(patch?: Partial<Omit<import("@samurai-agent/core-schemas").CuratorStateRecord, "id" | "updated_at">>) => Promise<import("@samurai-agent/core-schemas").CuratorStateRecord>;
  createReflectionRun:(run: import("@samurai-agent/core-schemas").ReflectionRunRecord) => Promise<import("@samurai-agent/core-schemas").ReflectionRunRecord>;
  createLearningReviewCandidate:(run: import("@samurai-agent/core-schemas").ReflectionRunRecord) => Promise<import("@samurai-agent/core-schemas").ReflectionRunRecord>;
  updateReflectionRun:(run: import("@samurai-agent/core-schemas").ReflectionRunRecord) => Promise<import("@samurai-agent/core-schemas").ReflectionRunRecord>;
  getReflectionRun:(id: string) => Promise<import("@samurai-agent/core-schemas").ReflectionRunRecord | undefined>;
  getReflectionRunByCandidateKey:(candidateKey: string) => Promise<import("@samurai-agent/core-schemas").ReflectionRunRecord | undefined>;
  listReflectionRuns:(sessionId?: string) => Promise<import("@samurai-agent/core-schemas").ReflectionRunRecord[]>;
  saveReflectionSuggestion:(suggestion: import("@samurai-agent/core-schemas").ReflectionSuggestionRecord) => Promise<import("@samurai-agent/core-schemas").ReflectionSuggestionRecord>;
  updateReflectionSuggestion:(suggestion: import("@samurai-agent/core-schemas").ReflectionSuggestionRecord) => Promise<import("@samurai-agent/core-schemas").ReflectionSuggestionRecord>;
  listReflectionSuggestions:(reflectionRunId?: string) => Promise<import("@samurai-agent/core-schemas").ReflectionSuggestionRecord[]>;
  saveExternalAssistRecord:(record: import("@samurai-agent/core-schemas").ExternalAssistRecord) => Promise<import("@samurai-agent/core-schemas").ExternalAssistRecord>;
  saveCollectionSchema:(schemaInput: import("@samurai-agent/core-schemas").CollectionSchema) => Promise<CollectionSchemaWithFilePath>;
  getCollectionSchema:(collectionId: string) => Promise<CollectionSchemaWithFilePath | undefined>;
  listCollectionSchemas:(options?: CollectionRoomCandidateOptions) => Promise<CollectionSchemaWithFilePath[]>;
  updateCollectionSchema:(schemaInput: import("@samurai-agent/core-schemas").CollectionSchema, expectedResourceVersion?: number) => Promise<CollectionSchemaWithFilePath>;
  saveCollectionRecord:(recordInput: import("@samurai-agent/core-schemas").CollectionRecord, trigger?: CollectionTriggerWriteRequest) => Promise<CollectionRecordWithFilePath>;
  deleteCollectionRecord:(collectionId: string, recordId: string, expectedVersion: number) => Promise<CollectionRecordWithFilePath>;
  getCollectionRecord:(collectionId: string, recordId: string) => Promise<CollectionRecordWithFilePath | undefined>;
  listCollectionRecords:(collectionId?: string, options?: CollectionRoomCandidateOptions) => Promise<CollectionRecordWithFilePath[]>;
  resolveCollectionRecordRefs:(collectionId: string, recordId: string, options?: CollectionRoomCandidateOptions) => Promise<CollectionRecordResolution>;
  evaluateCollectionTriggers:(input: { collectionId: string; recordId: string; event: CollectionTriggerEffect["event"]; }) => Promise<CollectionTriggerEffect[]>;
  applyCollectionRecordPatch:(input: { collectionId: string; recordId: string; patch: import("@samurai-agent/core-schemas").CollectionPatch; trigger?: CollectionTriggerWriteRequest; }) => Promise<{ before: CollectionRecordWithFilePath; after: CollectionRecordWithFilePath; }>;
  saveAutomationJob:(job: import("@samurai-agent/core-schemas").AutomationJobRecord) => Promise<import("@samurai-agent/core-schemas").AutomationJobRecord>;
  getAutomationJob:(id: string) => Promise<import("@samurai-agent/core-schemas").AutomationJobRecord | undefined>;
  listAutomationJobs:(input?: { dueAt?: string; enabledOnly?: boolean; }) => Promise<import("@samurai-agent/core-schemas").AutomationJobRecord[]>;
  acquireAutomationJobLock:(jobId: string, input: { lockedUntil: string; lockOwnerToken: string; now?: string; }) => Promise<import("@samurai-agent/core-schemas").AutomationJobRecord | undefined>;
  releaseAutomationJobLock:(jobId: string, input: { lockOwnerToken: string; now?: string; }) => Promise<import("@samurai-agent/core-schemas").AutomationJobRecord | undefined>;
  requeueAutomationJob:(jobId: string, input?: { nextRunAt?: string; now?: string; }) => Promise<import("@samurai-agent/core-schemas").AutomationJobRecord | undefined>;
  createAutomationRun:(run: import("@samurai-agent/core-schemas").AutomationRunRecord) => Promise<import("@samurai-agent/core-schemas").AutomationRunRecord>;
  updateAutomationRun:(run: import("@samurai-agent/core-schemas").AutomationRunRecord) => Promise<import("@samurai-agent/core-schemas").AutomationRunRecord>;
  attachAutomationRunEvidence:(input: { jobId: string; runId: string; lockOwnerToken: string; operationId: string; activityId?: string; }) => Promise<import("@samurai-agent/core-schemas").AutomationRunRecord | undefined>;
  attachAutomationRunBackendRun:(input: { jobId: string; runId: string; lockOwnerToken: string; backendRunId: string; }) => Promise<import("@samurai-agent/core-schemas").AutomationRunRecord | undefined>;
  settleAutomationRun:(input: AutomationRunSettlementInput) => Promise<AutomationRunClaim | undefined>;
  listExpiredAutomationRunClaims:(now?: string) => Promise<AutomationRunClaim[]>;
  saveExternalAppConnection:(input: import("@samurai-agent/core-schemas").ExternalAppConnectionRecord) => Promise<import("@samurai-agent/core-schemas").ExternalAppConnectionRecord>;
  getExternalAppConnection:(id: string) => Promise<import("@samurai-agent/core-schemas").ExternalAppConnectionRecord | undefined>;
  getExternalAppConnectionByConnector:(input: { workspaceId: string; connectorId: string; }) => Promise<import("@samurai-agent/core-schemas").ExternalAppConnectionRecord | undefined>;
  revokeExternalAppConnection:(input: { id: string; revokedAt: string; updatedAt?: string; }) => Promise<import("@samurai-agent/core-schemas").ExternalAppConnectionRecord | undefined>;
  saveExternalSend:(send: import("@samurai-agent/core-schemas").ExternalSendRecord) => Promise<import("@samurai-agent/core-schemas").ExternalSendRecord>;
  getExternalSend:(id: string, input?: { operationIds?: string[]; }) => Promise<import("@samurai-agent/core-schemas").ExternalSendRecord | undefined>;
  claimExternalSendDispatch:(input: { id: string; now: string; lease_until: string; }) => Promise<{ record: import("@samurai-agent/core-schemas").ExternalSendRecord; claim_token: string; } | undefined>;
  settleExternalSendDispatch:(input: { record: import("@samurai-agent/core-schemas").ExternalSendRecord; claim_token: string; }) => Promise<import("@samurai-agent/core-schemas").ExternalSendRecord>;
  markExternalSendOutcomeUnknown:(input: { id: string; claim_token: string; now: string; message: string; dispatch_result?: Record<string, import("@samurai-agent/core-schemas").JsonValue>; }) => Promise<import("@samurai-agent/core-schemas").ExternalSendRecord>;
  saveGatewayPairingPolicy:(policy: import("@samurai-agent/core-schemas").GatewayPairingPolicyRecord) => Promise<import("@samurai-agent/core-schemas").GatewayPairingPolicyRecord>;
  getGatewayPairingPolicy:(channel: import("@samurai-agent/core-schemas").GatewayPairingPolicyRecord["channel"]) => Promise<import("@samurai-agent/core-schemas").GatewayPairingPolicyRecord | undefined>;
  listGatewayPairingPolicies:(input?: { status?: import("@samurai-agent/core-schemas").GatewayPairingPolicyRecord["status"]; }) => Promise<import("@samurai-agent/core-schemas").GatewayPairingPolicyRecord[]>;
  saveGatewayRoutingPolicy:(policy: import("@samurai-agent/core-schemas").GatewayRoutingPolicyRecord) => Promise<import("@samurai-agent/core-schemas").GatewayRoutingPolicyRecord>;
  getGatewayRoutingPolicy:(channel: import("@samurai-agent/core-schemas").GatewayRoutingPolicyRecord["channel"]) => Promise<import("@samurai-agent/core-schemas").GatewayRoutingPolicyRecord | undefined>;
  listGatewayRoutingPolicies:(input?: { status?: import("@samurai-agent/core-schemas").GatewayRoutingPolicyRecord["status"]; }) => Promise<import("@samurai-agent/core-schemas").GatewayRoutingPolicyRecord[]>;
  saveGatewayPairing:(pairing: import("@samurai-agent/core-schemas").GatewayPairingRecord) => Promise<import("@samurai-agent/core-schemas").GatewayPairingRecord>;
  getGatewayPairing:(id: string) => Promise<import("@samurai-agent/core-schemas").GatewayPairingRecord | undefined>;
  findGatewayPairing:(input: { channel: import("@samurai-agent/core-schemas").GatewayPairingRecord["channel"]; sourceIdentity: string; status?: import("@samurai-agent/core-schemas").GatewayPairingRecord["status"]; sessionKey?: string; }) => Promise<import("@samurai-agent/core-schemas").GatewayPairingRecord | undefined>;
  listGatewayPairings:(input?: import("@samurai-agent/core-schemas").GatewayPairingRecord["status"] | { status?: import("@samurai-agent/core-schemas").GatewayPairingRecord["status"]; channel?: import("@samurai-agent/core-schemas").GatewayPairingRecord["channel"]; sourceIdentity?: string; sessionKey?: string; limit?: number; }) => Promise<import("@samurai-agent/core-schemas").GatewayPairingRecord[]>;
  expireGatewayPairings:(now?: string) => Promise<import("@samurai-agent/core-schemas").GatewayPairingRecord[]>;
  saveGatewayInboundMessage:(message: import("@samurai-agent/core-schemas").GatewayInboundMessageRecord) => Promise<import("@samurai-agent/core-schemas").GatewayInboundMessageRecord>;
  listGatewayInboundMessages:(input?: { status?: import("@samurai-agent/core-schemas").GatewayInboundMessageRecord["status"]; limit?: number; }) => Promise<import("@samurai-agent/core-schemas").GatewayInboundMessageRecord[]>;
  enqueueGatewayDelivery:(input: import("@samurai-agent/core-schemas").GatewayDeliveryRecord) => Promise<import("@samurai-agent/core-schemas").GatewayDeliveryRecord>;
  saveGatewayBoundaryPolicy:(policy: import("@samurai-agent/core-schemas").GatewayBoundaryPolicy) => Promise<import("@samurai-agent/core-schemas").GatewayBoundaryPolicy>;
  getGatewayBoundaryPolicy:(id: string) => Promise<import("@samurai-agent/core-schemas").GatewayBoundaryPolicy | undefined>;
  saveGatewayMcpConfig:(config: import("@samurai-agent/core-schemas").GatewayMcpConfigRecord) => Promise<import("@samurai-agent/core-schemas").GatewayMcpConfigRecord>;
  getGatewayMcpConfig:(id: string) => Promise<import("@samurai-agent/core-schemas").GatewayMcpConfigRecord | undefined>;
  getGatewayMcpConfigByServerName:(serverName: string) => Promise<import("@samurai-agent/core-schemas").GatewayMcpConfigRecord | undefined>;
  acquireGatewayConcurrencyLock:(input: { lockKey: string; scope: import("@samurai-agent/core-schemas").GatewayConcurrencyLockRecord["scope"]; policyId?: string; ownerRef?: import("@samurai-agent/core-schemas").GatewayConcurrencyLockRecord["owner_ref"]; ttlMs: number; metadata?: Record<string, import("@samurai-agent/core-schemas").JsonValue>; now?: string; }) => Promise<{ acquired: true; lock: import("@samurai-agent/core-schemas").GatewayConcurrencyLockRecord; } | { acquired: false; lock: import("@samurai-agent/core-schemas").GatewayConcurrencyLockRecord; }>;
  releaseGatewayConcurrencyLock:(lockKey: string, now?: string) => Promise<import("@samurai-agent/core-schemas").GatewayConcurrencyLockRecord | undefined>;
  expireGatewayConcurrencyLocks:(now?: string) => Promise<import("@samurai-agent/core-schemas").GatewayConcurrencyLockRecord[]>;
  listGatewayConcurrencyLocks:(input?: { status?: import("@samurai-agent/core-schemas").GatewayConcurrencyLockRecord["status"]; limit?: number; }) => Promise<import("@samurai-agent/core-schemas").GatewayConcurrencyLockRecord[]>;
  saveGatewaySandboxInstance:(instance: import("@samurai-agent/core-schemas").GatewaySandboxInstanceRecord) => Promise<import("@samurai-agent/core-schemas").GatewaySandboxInstanceRecord>;
  getGatewaySandboxInstance:(idOrKey: string) => Promise<import("@samurai-agent/core-schemas").GatewaySandboxInstanceRecord | undefined>;
  saveGatewaySandboxWorkspaceSync:(sync: import("@samurai-agent/core-schemas").GatewaySandboxWorkspaceSyncRecord) => Promise<import("@samurai-agent/core-schemas").GatewaySandboxWorkspaceSyncRecord>;
  getSettings:() => Promise<import("@samurai-agent/core-schemas").SettingsRecord>;
  patchSettings:(patch: Partial<Omit<import("@samurai-agent/core-schemas").SettingsRecord, "updated_at">>) => Promise<import("@samurai-agent/core-schemas").SettingsRecord>;
  getWorkspaceContext:() => Promise<{ workspace_name?: string; rules: string[]; updated_at: string; }>;
  getRoomContext:(roomId: string) => Promise<{ room_id: string; purpose?: string; work_goal?: string; updated_at: string; } | undefined>;
  savePluginState:(input: { manifestId: string; enabled: boolean; version: string; }) => Promise<{ manifest_id: string; enabled: boolean; version: string; updated_at: string; }>;
  saveResourceTranslation:(record: import("@samurai-agent/core-schemas").ResourceTranslationRecord) => Promise<import("@samurai-agent/core-schemas").ResourceTranslationRecord>;
  saveAuditRecord:(record: import("@samurai-agent/core-schemas").AuditRecord) => Promise<import("@samurai-agent/core-schemas").AuditRecord>;
  updateAuditRecord:(record: import("@samurai-agent/core-schemas").AuditRecord) => Promise<import("@samurai-agent/core-schemas").AuditRecord>;
  listAuditRecords:() => Promise<import("@samurai-agent/core-schemas").AuditRecord[]>;
  listAuditRecordsForOperation:(operationId: string) => Promise<import("@samurai-agent/core-schemas").AuditRecord[]>;
  saveRollbackPoint:(point: import("@samurai-agent/core-schemas").RollbackPoint) => Promise<import("@samurai-agent/core-schemas").RollbackPoint>;
  getRollbackPoint:(id: string) => Promise<import("@samurai-agent/core-schemas").RollbackPoint | undefined>;
  reindexSessionSearch:() => Promise<{ mode: SessionSearchIndexMode; indexed: number; }>;
  search:(query: string, input?: { sessionIds?: string[]; }) => Promise<SearchResult[]>;
  readActivityInputs:() => Promise<{ approvals: import("@samurai-agent/core-schemas").ApprovalRequest[]; operations: import("@samurai-agent/core-schemas").OperationRecord[]; decisions: import("@samurai-agent/core-schemas").PolicyDecisionRecord[]; audits: import("@samurai-agent/core-schemas").AuditRecord[]; rollbacks: import("@samurai-agent/core-schemas").RollbackPoint[]; }>;
  repairWorkspace:(options?: { dryRun?: boolean; }) => Promise<WorkspaceRepairResult>;
  createWorkspaceBackup:() => Promise<WorkspaceBackupRecord>;
  restoreWorkspaceBackup:(backupId: string) => Promise<WorkspaceRestoreResult>;
  rootDir: string;
  reindexWiki:() => Promise<WikiReindexResult>;
  reindexCollections:() => Promise<CollectionReindexResult>;
}

export interface RuntimeActivityStorePort {
  createActivity(record: import("@samurai-agent/core-schemas").ActivityRecord): Promise<import("@samurai-agent/core-schemas").ActivityRecord>;
  getActivity(id: string): Promise<import("@samurai-agent/core-schemas").ActivityRecord | undefined>;
  getOperation(id: string): Promise<{ room_id?: string } | undefined>;
  linkActivityBackendRun(input: { activityId: string; backendRunId: string; now: string }): Promise<import("@samurai-agent/core-schemas").ActivityRecord>;
  recordResourceUsage(record: import("@samurai-agent/core-schemas").ResourceUsageRecord): Promise<import("@samurai-agent/core-schemas").ResourceUsageRecord>;
  finalizeActivity(input: {
    activityId: string;
    status: Exclude<import("@samurai-agent/core-schemas").ActivityRecord["status"], "recording">;
    resultSummary?: string;
    verification?: import("@samurai-agent/core-schemas").ActivityRecord["verification"];
    failure?: import("@samurai-agent/core-schemas").ActivityRecord["failure"];
    backendRunId?: string;
    domainOperationIds?: string[];
    now: string;
  }): Promise<import("@samurai-agent/core-schemas").ActivityRecord>;
  ingestFinalizedActivity(input: {
    activity: import("@samurai-agent/core-schemas").ActivityRecord;
    resourceUsage: import("@samurai-agent/core-schemas").ResourceUsageRecord[];
    finalization: {
      status: Exclude<import("@samurai-agent/core-schemas").ActivityRecord["status"], "recording">;
      resultSummary?: string;
      verification?: import("@samurai-agent/core-schemas").ActivityRecord["verification"];
      failure?: import("@samurai-agent/core-schemas").ActivityRecord["failure"];
      backendRunId?: string;
      domainOperationIds?: string[];
      now: string;
    };
    signal?: AbortSignal;
  }): Promise<import("@samurai-agent/core-schemas").ActivityRecord>;
}

export interface RuntimeActivityQueryPort {
  listActivities(input: {
    workspaceId: string;
    roomId?: string;
    principalId?: string;
    sourceKind?: import("@samurai-agent/core-schemas").ActivityRecord["source"]["kind"];
    sourceId?: string;
    status?: import("@samurai-agent/core-schemas").ActivityRecord["status"];
    createdAfter?: string;
    createdBefore?: string;
    limit?: number;
  }): Promise<import("@samurai-agent/core-schemas").ActivityRecord[]>;
  listResourceUsage(input: { activityId: string; workspaceJobAttemptId?: string }): Promise<import("@samurai-agent/core-schemas").ResourceUsageRecord[]>;
  getWorkspaceJob(id: string): Promise<import("@samurai-agent/core-schemas").WorkspaceJobRecord | undefined>;
  listWorkspaceJobs(input: { workspaceId: string; roomId?: string; rootActivityId?: string; status?: import("@samurai-agent/core-schemas").WorkspaceJobRecord["status"] }): Promise<import("@samurai-agent/core-schemas").WorkspaceJobRecord[]>;
  listWorkspaceJobAttempts(workspaceJobId: string): Promise<import("@samurai-agent/core-schemas").WorkspaceJobAttemptRecord[]>;
}

export interface RuntimeResourceMutationActivityPort {
  getActivityByBackendRunId(backendRunId: string): Promise<import("@samurai-agent/core-schemas").ActivityRecord | undefined>;
  commitResourceMutationEvidence(input: {
    change: import("@samurai-agent/core-schemas").NewWorkspaceChangeRecord;
    resourceUsage: import("@samurai-agent/core-schemas").ResourceUsageRecord;
    directActivity?: { activityId: string; resultSummary: string; domainOperationIds: string[]; now: string };
  }): Promise<{ change: import("@samurai-agent/core-schemas").WorkspaceChangeRecord }>;
}

export interface RuntimeDurableWorkPort {
  listWorkItems(input?: { objectiveId?: string; status?: import("@samurai-agent/core-schemas").WorkItemRecord["status"]; roomId?: string }): Promise<import("@samurai-agent/core-schemas").WorkItemRecord[]>;
  saveWorkDependency(record: import("@samurai-agent/core-schemas").WorkDependencyRecord, roomId?: string): Promise<import("@samurai-agent/core-schemas").WorkDependencyRecord>;
}

export interface RuntimeWorkspaceContextPreviewPort {
  listExternalAssistRecords(input: { sessionId: string; limit: number }): Promise<import("@samurai-agent/core-schemas").ExternalAssistRecord[]>;
  listCollectionNotes(collectionId: string): Promise<Array<{ collection_id: string; file_path: string; content: string; role: "context_only" }>>;
}

export type RuntimeRoomAgentPort = Pick<RuntimeWorkspaceOperationsPort,
  "createRoomWithOwner" | "getRoom" | "listRooms" | "patchRoom" | "getAgent" | "listAgents" | "createAgent" |
  "patchAgent" | "bindAgentBackend" | "getWorkspaceMember" | "listWorkspaceMembers" | "addWorkspaceMember" |
  "changeWorkspaceMemberRole" | "removeWorkspaceMember" | "transferWorkspaceOwnership" | "getRoomMember" |
  "listRoomMembers" | "addRoomMember" | "changeRoomMemberRole" | "removeRoomMember" | "transferRoomOwnership" |
  "recoverOwnerlessRoom" | "listOwnerlessRoomIds" | "getRoomAgent" | "listRoomAgents" | "setRoomAgentPermissions" |
  "removeRoomAgent" | "getAgentWorkspacePermission" | "setAgentWorkspacePermission" | "getResourceAccessBoundary" |
  "ensureResourceAccessBoundary" | "listRoomResourceShares" | "shareResource" | "revokeRoomResourceShare" | "getResourceAccessMode" |
  "listResourceIdsAvailableInRoom" | "listRoomIdsForHuman" | "listRoomIdsForAgent">;

export type RuntimeRoomAuthorizationPort = Pick<RuntimeWorkspaceOperationsPort,
  "getWorkspaceMember" | "getRoomMember" | "getRoomAgent" | "getAgentWorkspacePermission" | "getAgent" |
  "listRoomIdsForHuman" | "listRoomIdsForAgent" | "listResourceIdsAvailableInRoom" | "getResourceAccessMode">;

export type RuntimeResourceCatalogPort = Pick<RuntimeWorkspaceOperationsPort,
  "getSession" | "getOperation" | "getArtifact" | "getMemory" | "getWiki" | "getSkill" | "getCollectionSchema" |
  "getCollectionRecord" | "getGeneratedSurface" | "getResourceAccessBoundary">;

/**
 * The production Runtime depends on this capability intersection, not on a
 * concrete storage implementation. Composition roots adapt their storage implementation
 * to it without granting Runtime access to the storage internals.
 */
export type RuntimeWorkspacePort = HostStorePort & DomainCommandExecutionPort & ExecutionStorePort & ArtifactDraftStorePort &
  Pick<MemoryRetrievalPort, "readMemoryContent"> & MemoryWritePort & RuntimeWorkspaceOperationsPort & RuntimeActivityStorePort &
  RuntimeActivityQueryPort & RuntimeResourceMutationActivityPort & RuntimeDurableWorkPort & RuntimeWorkspaceContextPreviewPort & {
    readonly filePort?: WorkspaceFilePort;
  };

/**
 * The TypeScript intersection above protects compilation, but adapters cross
 * a process/package boundary at runtime. Keep a small explicit admission
 * check for the capabilities required by the Host lifecycle so a partially
 * wired adapter fails at the composition root instead of during a turn.
 */
const runtimeWorkspacePortRequiredMethods = [
  "commitTurnSettlement",
  "getSession",
  "admitTurn",
  "admitWorkspaceRun",
  "commitWorkspaceRunSettlement",
  "releaseRunLease",
  "getBackendRun",
  "listBackendEvents",
  "listMessages",
  "commitCore02RunTransition",
  "commitCore02BackendSession",
  "commitCore02LifecycleEvent",
  "appendCore02Event",
  "getSessionRunReservation",
  "listCore02RecoveryCandidates",
  "appendHostDiagnostic",
  "claimDomainCommandExecution",
  "updateDomainCommandExecution",
  "heartbeatDomainCommandExecution",
  "getDomainCommandExecution",
  "compareAndSetDomainCommandExecution",
  "createActivity",
  "getActivity",
  "finalizeActivity",
  "ingestFinalizedActivity",
  "listActivities",
  "listWorkspaceJobs",
  "getWorkspaceJob",
  "listWorkspaceJobAttempts",
  "getObjective",
  "saveWorkItem",
  "createWorkspaceBackup",
  "restoreWorkspaceBackup",
  "repairWorkspace",
  "searchMemory",
  "readMemoryContent",
  "saveMemory",
  "writeArtifactContent",
  "saveArtifactMetadata",
  "getRoom",
  "getAgent",
  "getResourceAccessMode",
  "getResourceAccessBoundary",
  "getSettings"
] as const;

export function assertRuntimeWorkspacePort(value: unknown): asserts value is RuntimeWorkspacePort {
  if (!value || typeof value !== "object") {
    throw new Error("runtime_workspace_port_missing");
  }
  const candidate = value as Record<string, unknown>;
  const missing: string[] = runtimeWorkspacePortRequiredMethods.filter((name) => typeof candidate[name] !== "function");
  if (typeof candidate.rootDir !== "string" || !candidate.rootDir.trim()) missing.push("rootDir");
  if (missing.length > 0) throw new Error(`runtime_workspace_port_incomplete:${missing.join(",")}`);
}
