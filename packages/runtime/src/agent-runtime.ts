import { createArtifactDraft, type ArtifactKind } from "@samurai-agent/artifacts";
import { createTaskFingerprint } from "./learning/task-evaluation";
import {
  isSamuraiToolBridgeObservedProviderTool,
  normalizeSamuraiToolBridgeName,
  samuraiToolBridgeActionId,
  samuraiToolBridgeDescriptors,
  samuraiToolBridgeTools,
  samuraiToolBridgeWriteTools
} from "./provider-tool-bridge-composition.js";
import { RuntimeDomainApi } from "./runtime-domain-api.js";
import { resolveTemporaryContext as resolveTemporaryContextPort } from "./context/temporary-context-port.js";
import { buildKnowledgeWikiContext as buildKnowledgeWikiContextPort, type WikiContextPage } from "./context/workspace-context-candidates.js";
import { normalizeExternalAssistHints } from "./context/external-assist-context.js";
import { buildContextPreview as buildContextPreviewWithPorts } from "./context/context-preview.js";
import { WorkspaceContextPreviewAdapter } from "./context/workspace-context-preview-adapter.js";
import { fileRef, memoryRef } from "./context/resource-refs.js";
import { activeMemoryPreviewEntry } from "./context/context-assembly.js";
import {
  skillRef,
  skillSupportFileRef
} from "./context/skill-context.js";
import { expectedBackendOutputs, gatewayBoundaryRuntimeSnapshot } from "./host/turn-preparation-policy.js";
import { EnvironmentToolBridgeAdapter } from "./host/tool-bridge-adapter.js";
import { workspaceBackendInput } from "./host/workspace-backend-input.js";
import { runtimeOperationIds } from "./runtime-operation-composition.js";
import { executeGeneratedSurfaceAction } from "./generated-surface-action-ingress.js";
import {
  isArtifactRecordResource,
  isMemoryFrontmatterResource,
  operationAuditRuntimeResult,
  runtimeToolCallResult,
  runtimeToolWorkspaceEvents,
  runtimeWriteResource,
  type RuntimeToolCallResult,
  type RuntimeToolQueryResult
} from "./provider-result-projector.js";
import { routeGatewayInbound, runDueAutomation, type GatewayInboundInput } from "./domain-ingress-coordinator.js";
import {
  collectionRecordCreateCommandId,
  collectionRecordPatchCommandId,
  collectionRecordsQueryId,
  collectionSchemaDocsQueryId,
  collectionSchemaQueryId,
  collectionSchemaSaveCommandId
} from "./collection-compatibility-dispatch.js";
import { assertSafeBrowserUrl, BrowserUrlSafetyError, isNonNetworkBrowserRequest } from "./browser-url-safety.js";
export * from "./collections/safe-collection";
export * from "./context/user-model";
export * from "./context/session-compaction";
export * from "./context/federated-retrieval";
export * from "./context/progressive-skills";
export * from "./learning/task-evaluation";
export * from "./automation/schedule-policy";
import { buildActivityInboxItems } from "@samurai-agent/audit";
import { proposalCapabilityManifest } from "@samurai-agent/capability-registry";
import {
  PluginRuntimeRegistry,
  collectionManageCompatibilityEntry,
  listDomainCommandEntries,
  listDomainQueryEntries,
  getDomainCommandEntry,
  getDeprecatedDomainCommandEntry,
  getDomainCommandForProviderToolName,
  getDomainCommandForSurfaceOperationKind,
  getDomainQueryEntry,
  getDomainQueryForProviderToolName,
  getDomainQueryForSurfaceOperationKind,
  requireDomainCommandEntry,
  requireDomainQueryEntry,
  validateDomainCommandInput,
  validateDomainOutput,
  validateDomainQueryInput,
  type DomainCommandEntry,
  type DomainCommandInputSource,
  type DomainCommandOutputRenderKind,
  type DomainQueryEntry
} from "@samurai-agent/action-catalog";
import {
  DomainOperationError,
  DomainOperationRegistry,
  isSessionCompatibleOperation,
  type DomainCommandId,
  type DomainOperationId,
  type DomainOperationInput,
  type DomainOperationOutput,
  type DomainRuntimeCapability,
  type DomainResourceTarget,
  type DomainQueryId,
  type TrustedDomainContext
} from "@samurai-agent/domain-operations";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import {
  AgentBackendRegistry,
  ClaudeCodeBackend,
  CodexBackend,
  type AgentBackend,
  type AgentBackendStatus,
  type BackendOutputEvent,
  type BackendRunInput,
  type BackendToolCallStartedEvent,
  type TemporaryContextAttachment
} from "@samurai-agent/agent-backends";
import {
  type ActivityInboxItem,
  type ActivityContextRef,
  type ActivityRecord,
  type AgentBackendKind,
  type AgentRecord,
  type ApprovalRequest,
  type ArtifactRecord,
  type ArtifactRevisionRecord,
  type AuditRecord,
  type AutomationJobRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type ClientEventRecord,
  type CollectionPatch,
  type CollectionRecord,
  type CollectionSchema,
  CollectionSchemaSchema,
  ContextFreezeResponseSchema,
  type ActorIdentity,
  type ExternalAssistHint,
  type ExternalAssistRecord,
  type GatewayBoundaryPolicy,
  type GatewayBoundaryRuntimeSnapshot,
  type GatewayConcurrencyLockRecord,
  type GatewayRepairAction,
  type GatewayRepairResult,
  type GatewaySandboxInstanceRecord,
  type GatewaySandboxWorkspaceSyncDirection,
  type GatewaySandboxWorkspaceSyncRecord,
  type GatewaySandboxWorkspaceSyncResult,
  type GrantRecord,
  type GeneratedSurfaceDefinition,
  type GeneratedSurfaceActionDeclaration,
  SurfaceInteractionRecordSchema,
  type GatewayChannel,
  type HostContextAssembly,
  type ContextHandoff,
  type InstructionSource,
  type JsonValue,
  type MemoryFrontmatter,
  type MessageEnvelope,
  type MessageRecord,
  type MessagePresentationRecord,
  type OperationRecord,
  type ObjectiveRecord,
  ObjectiveRecordSchema,
  type WorkItemRecord,
  WorkItemRecordSchema,
  type ExternalSendRecord,
  type GatewayInboundMessageRecord,
  type GatewayDeliveryRecord,
  type GatewayPairingPolicyRecord,
  type GatewayPairingRecord,
  type GatewayRoutingPolicyRecord,
  type PolicyDecisionRecord,
  type PolicyEvaluationInput,
  ProvenanceSchema,
  type ContextFreezeResponse,
  type ContextPreview,
  type KnowledgeWikiGraph,
  type KnowledgeWikiLintReport,
  KnowledgeWikiLintReportSchema,
  type LearningEvaluationRecord,
  type LearningEvidenceState,
  type LearningUsageState,
  type SkillOptimizationRun,
  type OptimizationCandidate,
  type LearningJobReportRecord,
  type ReflectionRunRecord,
  type ReflectionSuggestionRecord,
  type ResourceRef,
  type ResourceTranslationRecord,
  type RollbackPoint,
  type SessionRecord,
  type CuratorLifecycleAction,
  type CuratorLifecycleReport,
  type CuratorReviewReport,
  type EvaluationTraceReport,
  type SurfaceRendererRegistryEntry,
  type WikiFrontmatter,
  type NewWorkspaceChangeRecord,
  type WorkspaceChangeRecord,
  type ToolRunRecord,
  type UsageScopeRef,
  type Principal,
  type WorkspaceExecutionRequest,
  type WorkspaceFilePort,
  type TrustedWorkspaceContext,
  GatewayRepairResultSchema,
  GatewaySandboxWorkspaceSyncResultSchema,
  gatewayChannels,
  type SkillFrontmatter,
  type SupportedLocale,
  createId,
  nowIso,
  stableHash,
  stableStringify
} from "@samurai-agent/core-schemas";
import {
  Core05BackgroundReviewOrchestrator,
  core05BackgroundReviewPrompt,
  deriveLearningCandidateSignals,
  learningBudgetDecision,
  learningCandidateKey,
  parseCore05BackgroundReviewResult,
  restrictCore05BackgroundReviewResult,
  skillConsolidationPrompt,
  parseSkillConsolidationResult,
  type SkillConsolidationRunner,
  learningRetryDelayMs,
  type Core05BackgroundReviewResult,
  type Core05BackgroundReviewRunner,
  type Core05ReviewSnapshot
} from "@samurai-agent/learning";
import {
  createGatewayEnvelope,
  createSandboxCommandAdapter,
  createSandboxLifecycleAdapter,
  createSandboxWorkspaceSyncAdapter,
  createHttpMcpToolAdapter,
  createPooledStdioMcpToolAdapter,
  cronMemoryReviewGatewayContext,
  executeSandboxCommand,
  executeSandboxLifecycleAction,
  executeSandboxWorkspaceSync,
  executeMcpToolInvocation,
  expirePairing,
  GatewayFormalWorkspaceIngress,
  gatewayMcpConfigToBoundaryRef,
  httpMcpServerConfigFromGatewayConfig,
  revokePairing,
  rotatePairingCode,
  stdioMcpServerConfigFromGatewayConfig,
  webGatewayContext,
  type GatewayContext,
  type McpToolExecutionResult,
  type PooledMcpToolAdapter,
  type SandboxCommandExecutionResult,
  type SandboxCommandExecutionInput,
  type SandboxWorkspaceSyncExecutionResult
} from "@samurai-agent/gateway";
import { isSupportedLocale } from "@samurai-agent/localization";
import { agentParticipantId, collectionRecordResourceId, delegatedParticipant, isRoomShareableResourceKind, localOwnerParticipantId, principalParticipantId as roomPrincipalParticipantId, type ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { buildMemoryFrontmatter, createRoomTopicMemory, createTopicMemory, retrieveActiveMemoryWithReport } from "@samurai-agent/memory";
import { builtinSurfaceRendererRegistryEntries, createSurfaceRenderSpec, negotiateSurfaceRenderSpec, type MessageSubmitOperation, type RuntimeEventSink, type SurfaceOperation, type SurfaceOperationDispatchPlan, type SurfaceOperationResultEnvelope, type SurfaceOperationResultKind, type SurfaceRenderKind, type SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import type {
  ArchiveMemoryResult,
  AutomationRunRecord,
  CollectionRecordResolution,
  CollectionReindexResult,
  CollectionRecordWithFilePath,
  CollectionSchemaWithFilePath,
  SkillSupportFile,
  SkillWithFilePath,
  WikiReindexResult,
  WikiWithFilePath,
  RuntimeWorkspacePort
} from "./composition/runtime-workspace-ports";
import { handleBackendToolCall, type BackendToolBoundaryFeedback } from "./backend/feedback";
import { normalizeBackendOutputEvent } from "./backend/event-bridge";
import { SamuraiNativeBackend } from "./backend/native-backend";
import { DomainCommandConflictError, DomainCommandIdempotencyKeyRequiredError, DomainCommandOutcomeUnknownError, DomainCommandReplayError, DurableDomainCommandBus } from "./commands/domain-command-bus";
import { createDomainOperationPorts } from "./domain-operation-composition";
import {
  commandIdForSurfaceOperation,
  isCollectionActionRunSurface,
  isCollectionRecordCreateSurface,
  isCollectionRecordDeleteSurface,
  isCollectionSchemaSaveOperation,
  isCollectionViewPresentSurface,
  isMessagePresentationUpdateSurface,
  queryIdForSurfaceOperation,
  surfaceOperationArtifactKind,
  surfaceOperationEffect,
  surfaceOperationResultKind
} from "./surface-operation-dispatch.js";
export { planSurfaceOperationDispatch } from "./surface-operation-dispatch.js";
import { DurableWorkCoordinator } from "./execution/durable-work-coordinator";
import { ExecutionDomainService } from "./commands/services/execution-domain-service";
import { PluginDomainService } from "./commands/services/plugin-domain-service";
import { SettingsDomainService } from "./commands/services/settings-domain-service";
import { ObjectiveDomainService } from "./commands/services/objective-domain-service";
import { PresentationDomainService } from "./commands/services/presentation-domain-service";
import { TranslationDomainService } from "./commands/services/translation-domain-service";
import { LearningDomainService } from "./commands/services/learning-domain-service";
import { LearningResourceUseDomainService } from "./commands/services/learning-resource-use-domain-service";
import { LearningResourceVersionDomainService } from "./commands/services/learning-resource-version-domain-service";
import { AppliedLearningEvaluationDomainService } from "./commands/services/applied-learning-evaluation-domain-service";
import { Core05BackgroundReviewMutationDomainService } from "./commands/services/core05-background-review-mutation-domain-service";
import {
  SystemDomainService,
  type ReflectionTarget,
  type SystemMcpCallRequest,
  type SystemSandboxExecRequest
} from "./commands/services/system-domain-service";
import { ClientEventDomainService } from "./commands/services/client-event-domain-service";
import { GatewayDomainService } from "./commands/services/gateway-domain-service";
import { WikiDomainService } from "./commands/services/wiki-domain-service";
import { AutomationDomainService } from "./commands/services/automation-domain-service";
import { Core09AutomationDomainService } from "./commands/services/core09-automation-domain-service";
import { DomainOperationTelemetryService } from "./commands/services/domain-operation-telemetry-service";
import { GeneratedSurfaceDomainService } from "./commands/services/generated-surface-domain-service";
import { SkillDomainService } from "./commands/services/skill-domain-service";
import { CollectionDomainService, type CollectionTriggerMutationRequest } from "./commands/services/collection-domain-service";
import { ConversationDomainService } from "./commands/services/conversation-domain-service";
import { FileDomainService } from "./commands/services/file-domain-service";
import { BrowserDomainService } from "./commands/services/browser-domain-service";
import { ExternalSendDomainService } from "./commands/services/external-send-domain-service";
import { ExternalAppConnectionDomainService } from "./commands/services/external-app-connection-domain-service";
import { RoomAgentDomainService } from "./commands/services/room-agent-domain-service";
import { RoomAuthorizationError, RoomAuthorizationService } from "./commands/services/room-authorization-service";
import { RoomResourceCatalog } from "./commands/services/room-resource-catalog";
import { ActivityIngestService } from "./activity/activity-ingest-service";
import { ActivityHistoryQueryService } from "./activity/activity-history-query-service";
import { ActivityHistoryDomainService } from "./commands/services/activity-history-domain-service";
import { ResourceVersionDomainService } from "./commands/services/resource-version-domain-service";
import { WorkspaceContextDomainService } from "./commands/services/workspace-context-domain-service";
import { HumanChangeRequestDomainService } from "./commands/services/human-change-request-domain-service";
import { ResourceTransferDomainService } from "./commands/services/resource-transfer-domain-service";
import { ResourceRedactionDomainService } from "./commands/services/resource-redaction-domain-service";
import { ExternalAppContextResolver } from "./external-app/external-app-context-resolver";
import { ExternalAppIngress } from "./external-app/external-app-ingress";
import { ReferenceExternalAppAdapter } from "./external-app/reference-adapter";
import { ResourceMutationActivityService, ResourceMutationEvidenceError, type ResourceMutationActivityScope } from "./activity/resource-mutation-activity-service";
import { createRuntimeAgentHost, type HostExternalAssistSyncInput, type RuntimeHostCompositionDependencies } from "./composition/runtime-host";
import { BackendToolBridgeService, type BackendToolBridgeCallResult } from "./host/backend-tool-bridge-service";
import { LearningEvidenceAssembler } from "./learning/learning-evidence-assembler";
import type {
  AdmittedTurn,
  BackendBoundTurn,
  TurnRequest,
  WorkspaceExecutionOutcome
} from "./host/host-types";
import type { AgentHost } from "./host/agent-host";
import { MemoryDomainService } from "./commands/services/memory-domain-service";
import { ArtifactDomainService, type ArtifactMutationInput } from "./commands/services/artifact-domain-service";
import { collectionRecordBoundaryId, createSearchReadStore, SearchDomainService } from "./commands/services/search-domain-service";
export {
  HttpExternalAssistProvider,
  LocalFileExternalAssistProvider,
  createExternalAssistProviderFromEnv,
  createExternalAssistProvidersFromEnv,
  describeExternalAssistProviderConfig,
  type HttpExternalAssistProviderOptions,
  type LocalFileExternalAssistProviderOptions
} from "./backend/external-assist-provider";
export type { ExternalAssistProviderConfigDiagnostics } from "@samurai-agent/core-schemas";
export {
  NativeContextBuilder,
  NativePromptBuilder,
  NativeToolExecutor,
  NativeToolLoop,
  SamuraiNativeBackend,
  type SamuraiNativeBackendComponents
} from "./backend/native-backend";
export {
  FakeProviderAdapter,
  ProviderRegistry,
  ProviderRequestError,
  createProviderRegistryFromEnv,
  type ProviderAdapter,
  type ProviderDiagnostics,
  type ProviderInput,
  type ProviderOutput,
  type ProviderToolCall
} from "./backend/provider";
export { generatedSurfaceCsp } from "./presentation/generated-surface";
import { ProviderRequestError, type ProviderAdapter, type ProviderDiagnostics, type ProviderInput, type ProviderOutput } from "./backend/provider";
export type { GatewayContext } from "@samurai-agent/gateway";

export interface RunChatTurnInput {
  sessionId: string;
  content: string;
  agent_id?: string;
  backend_id?: string;
  input_locale?: SupportedLocale;
  output_locale?: SupportedLocale;
  attachments?: ResourceRef[];
  temporary_context?: TemporaryContextAttachment[];
  metadata?: Record<string, unknown>;
  gateway_context?: GatewayContext;
  gateway_boundary_policy?: GatewayBoundaryPolicy;
  /** Internal trusted context only. HTTP payloads cannot set these values. */
  trusted_participant_context?: true;
  trusted_requester_participant_id?: string;
  /** Stable key supplied by the ingress; transport retries must reuse it. */
  idempotency_key?: string;
}

export interface RunChatTurnResult {
  session: SessionRecord;
  messages: MessageRecord[];
  messagePresentations: MessagePresentationRecord[];
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
  reflectionRuns: ReflectionRunRecord[];
  reflectionSuggestions: ReflectionSuggestionRecord[];
  toolRuns: ToolRunRecord[];
}

type RuntimeToolDispatchOutcome =
  | { kind: "unhandled" }
  | { kind: "handled"; value: RuntimeToolCallResult | RuntimeToolQueryResult }
  | { kind: "query_failed"; failure: RuntimeToolFailure }
  | { kind: "failed"; toolRun: ToolRunRecord };

interface BackendToolEventHandlingResult {
  operations: OperationRecord[];
  artifacts: ArtifactRecord[];
  memories: MemoryFrontmatter[];
  collectionSchemas: CollectionSchemaWithFilePath[];
  toolRuns: ToolRunRecord[];
  workspaceChanges: WorkspaceChangeRecord[];
}

type RuntimeToolFailureCode = RuntimeRequestError["code"] | DomainOperationError["code"] | "internal_error";

interface RuntimeToolFailure {
  code: RuntimeToolFailureCode;
  reason: "runtime_tool_failed";
  retryable: boolean;
  summary: string;
}

type BackendEventRecorder = (event: BackendOutputEvent) => Promise<BackendEventRecord>;

export interface ArchiveMemoryInput {
  memoryId: string;
  sessionId: string;
  actorIdentity?: OperationRecord["actor_identity"];
  decidedBy?: string;
}

export interface ArchiveMemoryRuntimeResult {
  memory: ArchiveMemoryResult["after"]["frontmatter"] & { file_path: string };
  content: string;
  operation: OperationRecord;
  auditRecord?: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
  changed: boolean;
  warning?: string;
}

export interface RuntimeWriteResult<TResource> {
  resource: TResource;
  operation: OperationRecord;
  policyDecision?: PolicyDecisionRecord;
  auditRecord?: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

interface RecordedMutationInput<TResource, TExtra extends Record<string, unknown> = {}> {
  /** Native App compatibility may supply these; Room-first mutations do not. */
  session?: SessionRecord;
  envelope?: MessageEnvelope;
  context?: GatewayContext;
  /** The handler's server-resolved Context; never supplied by a public DTO. */
  trustedContext?: TrustedDomainContext;
  operationName: string;
  proposedEffects: string[];
  /** A human-readable server-side input summary when there is no Message. */
  inputSummary?: string;
  inputRef?: OperationRecord["input_ref"];
  targetResourceRefs?: OperationRecord["target_resource_refs"];
  /**
   * Resource identities known before the write starts.  They are registered
   * against the current Room before a filesystem or index mutation can run.
   */
  boundaryResourceRefs?: ResourceRef[];
  /** Used only by an operation that persists its Room boundary in the same
   * resource transaction, or explicitly creates Workspace-scoped Knowledge. */
  resultResourceBoundaryMode?: "managed_by_operation";
  /** A scope move atomically replaces the source Resource's Room boundary.
   * Its source ref must be checked before the write, but must not be
   * re-registered against the old Room after that write. */
  skipPostMutationTargetBoundaryCheck?: boolean;
  /** Core08 Resource writes also leave durable Activity/Change/Usage evidence. */
  core08Evidence?: {
    changeType: WorkspaceChangeRecord["change_type"];
    stage?: "modified" | "reverted";
  };
  execute: (operation: OperationRecord, activity?: ActivityRecord) => Promise<{
    resource: TResource;
    ref: NonNullable<OperationRecord["result_ref"]>;
    rollbackPoint?: RollbackPoint;
    summary: string;
  } & TExtra>;
}

export type SkillRuntimeResult = RuntimeWriteResult<SkillWithFilePath>;
export type SkillSupportRuntimeResult = RuntimeWriteResult<SkillSupportFile>;
export interface SkillViewRuntimeResult {
  skill: SkillWithFilePath;
  content: string;
  file_refs: Array<{ path: string; file_path: string }>;
  disclosure_level: "body" | "support";
  usage: {
    skill_id: string;
    run_id: string;
    resource_id: string;
    content_hash: string;
    stage: "body_loaded" | "support_loaded";
    metadata: Record<string, JsonValue>;
  };
}
export type WikiRuntimeResult = RuntimeWriteResult<WikiWithFilePath>;
export type CollectionSchemaRuntimeResult = RuntimeWriteResult<CollectionSchemaWithFilePath>;
export type CollectionRecordRuntimeResult = RuntimeWriteResult<CollectionRecordWithFilePath>;
export type CollectionDeleteRuntimeResult = RuntimeWriteResult<CollectionRecordWithFilePath>;
export type CollectionReindexRuntimeResult = RuntimeWriteResult<CollectionReindexResult>;
export interface CollectionPluginActionResult {
  collection_id: string;
  action_id: string;
  action_kind: string;
  catalog_action_id: string;
  handler_id?: string;
  status: "completed";
  output?: JsonValue;
}
export type CollectionPluginActionRuntimeResult = RuntimeWriteResult<CollectionPluginActionResult>;
export interface CollectionInstructionActionResult {
  collection_id: string;
  action_id: string;
  action_kind: string;
  status: "completed";
  backend_run_id: string;
  session_id: string;
  custom_view?: Record<string, JsonValue>;
  output?: JsonValue;
}
export type CollectionInstructionActionRuntimeResult = RuntimeWriteResult<CollectionInstructionActionResult> & { chat?: RunChatTurnResult };
export interface CollectionActionDescriptor {
  collection_id: string;
  action_id: string;
  action_kind: string;
  title?: string;
  description?: string;
  implementation_target: string;
  catalog_action_id?: string;
  handler_id?: string;
  ui_display_category: string;
  resource_kinds: string[];
  availability: "available" | "action_missing" | "handler_missing" | "unsupported";
  unsupported_reason?: string;
  definition: Record<string, JsonValue>;
}
export type CollectionActionRuntimeResult = CollectionRecordRuntimeResult | CollectionPatchRuntimeResult | CollectionReindexRuntimeResult | CollectionPluginActionRuntimeResult | CollectionInstructionActionRuntimeResult;
export type AutomationJobRuntimeResult = RuntimeWriteResult<AutomationJobRecord>;
export type ExternalSendRuntimeResult = RuntimeWriteResult<ExternalSendRecord>;

export interface AutomationSchedulePreview {
  schedule: string;
  normalized: string;
  from: string;
  one_shot: boolean;
  next_run_at: string;
}

export interface GatewayInboundRuntimeResult {
  inbound: GatewayInboundMessageRecord;
  pairing?: GatewayPairingRecord;
  boundaryPolicy?: GatewayBoundaryPolicy;
  concurrencyLock?: GatewayConcurrencyLockRecord;
  session?: SessionRecord;
  chat?: RunChatTurnResult;
  deliveries?: GatewayDeliveryRecord[];
}

export interface FileActionRuntimeResult extends RuntimeWriteResult<{
  path: string;
  content?: string;
  entries?: Array<{ path: string; kind: "file" | "directory"; size?: number }>;
  metadata?: { size: number; modified_at: string; content_hash: string };
  provenance?: { artifact_ids: string[]; workspace_change_ids: string[] };
}> {}

export interface RollbackRestoreRuntimeResult extends RuntimeWriteResult<{
  rollback_point_id: string;
  path: string;
  action: "written" | "deleted";
}> {}

export interface BrowserActionRuntimeResult extends RuntimeWriteResult<{
  url: string;
  title?: string;
  text?: string;
  snapshot_kind?: "html_snapshot";
  screenshot_ref?: string;
  file_path?: string;
  adapter_id?: string;
  mime_type?: string;
  width?: number;
  height?: number;
}> {}

type StructuredSurfaceOperation = Extract<SurfaceOperation, {
  kind: "form.submit" | "table.patch" | "chart.request" | "artifact.request" | "custom_view.action";
}>;

export interface SurfaceArtifactRuntimeResult extends RuntimeWriteResult<ArtifactRecord> {
  sourceArtifact?: ArtifactRecord;
  workspaceChange: WorkspaceChangeRecord;
}

export type SurfaceOperationRuntimeResult = SurfaceOperationResultEnvelope<
  RunChatTurnResult | CollectionViewRuntimeResult | CollectionRecordRuntimeResult | CollectionPatchRuntimeResult | CollectionDeleteRuntimeResult | CollectionActionRuntimeResult | SurfaceArtifactRuntimeResult | MessagePresentationRecord
>;

export interface CollectionViewRuntimeResult {
  collection_id: string;
  view_id: string;
  schema: CollectionSchemaWithFilePath;
  record_count: number;
}

export interface DomainCommandRuntimeInput {
  command_id: string;
  /** Dynamic transport input. The registry owns object and schema validation. */
  payload?: unknown;
  input_source?: DomainCommandInputSource;
  idempotency_key?: string;
}

export interface DomainQueryRuntimeInput {
  query_id: string;
  /** Dynamic transport input. The registry owns object and schema validation. */
  payload?: unknown;
  input_source?: DomainCommandInputSource;
}

/** A fixed Runtime API command keeps its generated operation DTO through dispatch. */
export interface TypedDomainCommandRuntimeInput<Id extends DomainCommandId> {
  command_id: Id;
  payload: DomainOperationInput<Id>;
  idempotency_key?: string;
}

/** A fixed Runtime API query keeps its generated operation DTO through dispatch. */
export interface TypedDomainQueryRuntimeInput<Id extends DomainQueryId> {
  query_id: Id;
  payload: DomainOperationInput<Id>;
}

/**
 * Values selected by a trusted ingress after transport authentication and
 * resource lookup. They are intentionally separate from an operation payload.
 */
export interface TrustedDomainRuntimeContext {
  /**
   * Optional assertion supplied by a trusted ingress.  The effective actor is
   * always selected from the input source below; an ingress can never inject
   * an arbitrary actor id into a Domain handler.
   */
  actorIdentity?: TrustedActorIdentity;
  /**
   * Server-only participant selected after authentication or persisted Run
   * lookup. It is never accepted from an operation payload or HTTP body.
   */
  participant?: import("@samurai-agent/room-permissions").ParticipantPrincipal;
  /** Server-created correlation root shared by a multi-command ingress chain. */
  correlationId?: string;
  /** The server-loaded Connection that authenticated an external request. */
  connectionId?: string;
  /** Room selected by an authenticated transport, never by operation payload. */
  roomId?: string;
  sessionId?: string;
  sessionRef?: import("@samurai-agent/core-schemas").SessionRef;
  source?: import("@samurai-agent/core-schemas").TrustedWorkspaceSource;
  runId?: string;
  envelopeId?: string;
  surfaceOperation?: {
    id: string;
    kind: string;
  };
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Stable key selected by the trusted ingress for retry-safe external work. */
  idempotencyKey?: string;
  /** The active External App Connection's server-loaded Room allow-list.
   * Public command input never controls this field. */
  externalAllowedRoomIds?: readonly string[];
  /** Runtime API adapters must receive an explicit Room for Room content. */
  requireExplicitRoom?: boolean;
}

/** Actors that the Runtime can assign without consulting a user payload. */
export type TrustedActorIdentity = Extract<ActorIdentity, "owner" | "owner_scheduled" | "paired_contact" | "external_app">;

export interface DomainCommandRuntimeResult<TResult = unknown> {
  command: DomainCommandEntry;
  ok: true;
  contract_version: string;
  execution_id: string;
  input_source: DomainCommandInputSource;
  payload: Record<string, JsonValue>;
  render_spec?: SurfaceRenderSpec;
  render_specs: SurfaceRenderSpec[];
  result: TResult;
}

export interface DomainQueryRuntimeResult<TResult = unknown> {
  query: DomainQueryEntry;
  ok: true;
  contract_version: string;
  execution_id: string;
  input_source: DomainCommandInputSource;
  payload: Record<string, JsonValue>;
  render_spec?: SurfaceRenderSpec;
  render_specs: SurfaceRenderSpec[];
  result: TResult;
}

type DomainDispatchEntry = DomainCommandEntry | DomainQueryEntry;

type FileActionResource = FileActionRuntimeResult["resource"];
type BrowserActionResource = BrowserActionRuntimeResult["resource"];

export interface CollectionPatchRuntimeResult extends RuntimeWriteResult<CollectionRecordWithFilePath> {
  before: CollectionRecordWithFilePath;
}

export interface AutomationRunRuntimeResult {
  automationRun: AutomationRunRecord;
  operation?: OperationRecord;
  policyDecision?: PolicyDecisionRecord;
  auditRecord?: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
  memoryReviewTrace?: ReflectionRuntimeResult;
  curatorResult?: ReflectionRuntimeResult;
  /** Authorization blocks are a durable terminal result, not a retryable failure. */
  blocked?: true;
}

export interface ReflectionRuntimeResult {
  reflectionRun: ReflectionRunRecord;
  suggestions: ReflectionSuggestionRecord[];
  learningEvaluations?: LearningEvaluationRecord[];
  curatorReport?: CuratorLifecycleReport;
  curatorReviewReport?: CuratorReviewReport;
  evaluationReport?: EvaluationTraceReport;
}

export interface BackendStreamSyncResult {
  run: BackendRunRecord;
  status: "synced" | "unsupported" | "timeout" | "max_events";
  events: BackendEventRecord[];
  persisted_event_count: number;
  skipped_duplicate_count: number;
  timed_out: boolean;
  max_events_reached: boolean;
}

interface ReflectionArtifactSnapshot {
  artifact: ArtifactRecord;
  content?: string;
  content_truncated: boolean;
}

export interface BackendRunErrorPayload {
  session: SessionRecord;
  messages: MessageRecord[];
  backendRun: BackendRunRecord;
  backendEvents: BackendEventRecord[];
  workspaceChanges: WorkspaceChangeRecord[];
}

export interface ResourceVersionConflictPayload {
  conflict: "resource_version";
  expected_version: number;
  actual_version: number;
  latest_resource: CollectionRecordWithFilePath;
  retry: {
      command_id: DomainOperationId;
    expected_version: number;
  };
}

export interface ExternalAssistPrefetchInput {
  sessionId: string;
  query: string;
  recentMessages: MessageRecord[];
  sessionSearch: Array<{ kind: string; id: string; title: string; summary: string }>;
}

export interface ExternalAssistSyncInput {
  sessionId: string;
  runId: string;
  inputMessageId: string;
  query: string;
  userContent: string;
  assistantContent: string;
}

export interface ExternalAssistProvider {
  readonly id: string;
  prefetch(input: ExternalAssistPrefetchInput): Promise<ExternalAssistHint[]>;
  syncTurn?(input: ExternalAssistSyncInput): Promise<ExternalAssistHint[] | void>;
}

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: RuntimeRequestErrorCode,
    message: string,
    readonly payload?: ArchiveMemoryRuntimeResult | BackendRunErrorPayload | ResourceVersionConflictPayload | DeprecatedOperationPayload | DomainCommandReplayPayload | ResourceMutationEvidenceFailurePayload,
    readonly diagnostics?: ProviderDiagnostics
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

function providerDiagnosticsFromBackendEvents(events: BackendEventRecord[]): ProviderDiagnostics | undefined {
  const terminal = [...events].reverse().find((event) => event.event_type === "run_failed");
  if (!terminal) return undefined;
  const payload = terminal.payload;
  const reason = payload.reason;
  const supportedReason = reason === "not_configured"
    || reason === "auth_failed"
    || reason === "rate_limited"
    || reason === "temporary_unavailable"
    || reason === "model_not_found"
    || reason === "invalid_model"
    || reason === "invalid_response"
    || reason === "network"
    || reason === "unknown"
    ? reason
    : undefined;
  if (!supportedReason && typeof payload.provider !== "string" && typeof payload.model !== "string" && typeof payload.status !== "number") {
    return undefined;
  }
  return {
    ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
    ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    ...(typeof payload.status === "number" ? { status: payload.status } : {}),
    reason: supportedReason ?? "unknown",
    retryable: payload.retryable === true
  };
}

function requireSessionBoundRun(run: BackendRunRecord): asserts run is BackendRunRecord & { session_id: string } {
  if (!run.session_id) {
    throw new RuntimeRequestError("conflict", `session_bound_run_required:${run.id}`);
  }
}

export type RuntimeRequestErrorCode =
  | "bad_request" | "validation" | "gone" | "not_found" | "conflict" | "forbidden" | "unavailable"
  | "outcome_unknown" | "internal" | "provider_not_configured" | "provider_failed" | "backend_cancelled"
  | "backend_execution_root_not_ready" | "domain_command_failed" | "resource_mutation_evidence_failed"
  | "workspace_change_notification_failed";

export interface DeprecatedOperationPayload {
  deprecated_operation_id: string;
  replacement: { kind: "effective_inventory"; target: "/api/domain/commands/effective" };
}

export interface DomainCommandReplayPayload {
  conflict: "domain_command_replay";
  code: string;
  retryable: boolean;
  details?: JsonValue;
}

export interface ResourceMutationEvidenceFailurePayload {
  operation_id: string;
  resource_ref?: ResourceRef;
  failure_stage: "workspace_change" | "resource_usage" | "activity_finalize";
}

export interface AgentRuntimeWorkspaceOptions {
  domainCommandRunningTimeoutMs?: number;
  backendWorkingDirectoryMode?: "workspace" | "repo";
  repoRoot?: string;
  resolveTemporaryContextRef?: (ref: ResourceRef) => Promise<TemporaryContextAttachment | undefined> | TemporaryContextAttachment | undefined;
  /** Core 05 accepts only the strict non-destructive Mutation Plan. */
  core05BackgroundReviewRunner?: Core05BackgroundReviewRunner;
  /** Optional stronger Backend, selected only for explicit correction or contradiction candidates. */
  backgroundReviewConflictBackendId?: string;
  backgroundReviewBackendId?: string;
  enableBackendBackgroundReview?: boolean;
  deferHost?: boolean;
  skillConsolidationRunner?: SkillConsolidationRunner;
  browserAdapter?: BrowserAdapter;
  pdfExportAdapter?: PdfExportAdapter;
  hostFactory?: (dependencies: RuntimeHostCompositionDependencies) => AgentHost;
  /** Injected by the production composition root; Host code never logs directly. */
  productionLogger?: (message: string, metadata: Record<string, unknown>) => void;
  /** Injected by the application composition root; Runtime never implements filesystem access. */
  filePort?: WorkspaceFilePort;
}

export interface BrowserAdapter {
  readonly id: string;
  interact(input: { url: string; action: "navigate" | "click" | "input"; selector?: string; value?: string }): Promise<{ url: string; title?: string; text?: string }>;
  screenshot(input: { url: string }): Promise<{ bytes: Uint8Array; mime_type: "image/png" | "image/jpeg"; width?: number; height?: number }>;
}

export interface PdfExportAdapter {
  readonly id: string;
  export(input: { title: string; content: string; source_artifact: ArtifactRecord }): Promise<Uint8Array>;
}

export function createDefaultAgentBackendRegistry(
  provider?: ProviderAdapter,
  env: NodeJS.ProcessEnv = process.env,
  options: { repoRoot?: string } = {}
): AgentBackendRegistry {
  const artifactMcpScript = resolveArtifactMcpScriptPath(env.SAMURAI_ARTIFACT_MCP_SCRIPT, options.repoRoot);
  return new AgentBackendRegistry([
    new SamuraiNativeBackend(provider),
    new ClaudeCodeBackend({
      command: env.SAMURAI_CLAUDE_CODE_COMMAND,
      args: splitArgs(env.SAMURAI_CLAUDE_CODE_ARGS),
      artifactMcpScript,
      resumeArgs: splitOptionalArgs(env.SAMURAI_CLAUDE_CODE_RESUME_ARGS)
    }),
    new CodexBackend({
      command: env.SAMURAI_CODEX_COMMAND,
      args: splitOptionalArgs(env.SAMURAI_CODEX_ARGS),
      artifactMcpScript,
      resumeArgs: splitOptionalArgs(env.SAMURAI_CODEX_RESUME_ARGS)
    })
  ]);
}

function resolveArtifactMcpScriptPath(value: string | undefined, repoRoot: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return repoRoot ? path.resolve(repoRoot, "scripts/samurai-artifact-mcp.mjs") : undefined;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot ?? process.cwd(), trimmed);
}

function defaultBackendId(env: NodeJS.ProcessEnv = process.env): string {
  return env.SAMURAI_BACKEND_DEFAULT?.trim() || "samurai-native";
}

function hasExplicitDefaultBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SAMURAI_BACKEND_DEFAULT?.trim());
}

function defaultBackendIdFromStatuses(statuses: AgentBackendStatus[]): string {
  const runnable = statuses.filter((status) => isRunnableBackendStatus(status));
  return (
    runnable.find((status) => status.id === "codex")?.id
    ?? runnable.find((status) => status.id === "claude-code")?.id
    ?? runnable.find((status) => status.kind === "codex" || status.kind === "claude_code" || status.kind === "external")?.id
    ?? runnable.find((status) => status.id === "samurai-native")?.id
    ?? "samurai-native"
  );
}

function splitArgs(value: string | undefined): string[] {
  return value?.split(" ").map((item) => item.trim()).filter(Boolean) ?? [];
}

function splitOptionalArgs(value: string | undefined): string[] | undefined {
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  return splitArgs(value);
}

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRuntimeToolQueryResult(
  value: RuntimeToolCallResult | RuntimeToolQueryResult
): value is RuntimeToolQueryResult {
  return "queryOnly" in value && value.queryOnly === true;
}

export class AgentRuntime {
  private readonly backendRegistry: AgentBackendRegistry;
  private readonly stdioMcpProcessPool: PooledMcpToolAdapter;
  private readonly pluginRegistry: PluginRuntimeRegistry;
  private readonly externalAssistProviders: ExternalAssistProvider[];
  private readonly contextPreviewAdapter: WorkspaceContextPreviewAdapter;
  private readonly backendToolBridgeService: BackendToolBridgeService;
  private readonly backgroundTaskFailures: Array<{ error: unknown; runId?: string }> = [];
  private readonly backgroundReviewBackends = new Map<string, AgentBackend>();
  private backgroundTasksClosing = false;
  private backgroundShutdownPromise: Promise<void> | undefined;
  private readonly domainCommandBus: DurableDomainCommandBus;
  private readonly domainOperationTelemetry: DomainOperationTelemetryService;
  private readonly domainOperationRegistry: DomainOperationRegistry;
  /** Per-request Room context; avoids mutable global authorization state. */
  private readonly activeDomainContext = new AsyncLocalStorage<TrustedDomainContext>();
  private readonly runtimeDomainApi: RuntimeDomainApi;
  private readonly durableWorkCoordinator: DurableWorkCoordinator;
  private readonly executionDomainService: ExecutionDomainService;
  private readonly pluginDomainService: PluginDomainService;
  private readonly settingsDomainService: SettingsDomainService;
  private readonly objectiveDomainService: ObjectiveDomainService;
  private readonly presentationDomainService: PresentationDomainService;
  private readonly translationDomainService: TranslationDomainService;
  private readonly learningDomainService: LearningDomainService;
  private readonly learningResourceUseDomainService: LearningResourceUseDomainService;
  private readonly learningResourceVersionDomainService: LearningResourceVersionDomainService;
  private readonly appliedLearningEvaluationDomainService: AppliedLearningEvaluationDomainService;
  private readonly core05BackgroundReviewMutationDomainService: Core05BackgroundReviewMutationDomainService;
  private readonly systemDomainService: SystemDomainService;
  private readonly clientEventDomainService: ClientEventDomainService;
  private readonly gatewayDomainService: GatewayDomainService;
  private readonly wikiDomainService: WikiDomainService;
  private readonly automationDomainService: AutomationDomainService;
  private readonly core09AutomationDomainService: Core09AutomationDomainService;
  private readonly generatedSurfaceDomainService: GeneratedSurfaceDomainService;
  private readonly skillDomainService: SkillDomainService<SkillWithFilePath>;
  private readonly collectionDomainService: CollectionDomainService;
  private readonly memoryDomainService: MemoryDomainService;
  private readonly artifactDomainService: ArtifactDomainService;
  private readonly conversationDomainService: ConversationDomainService;
  private readonly fileDomainService: FileDomainService;
  private readonly browserDomainService: BrowserDomainService;
  private readonly externalSendDomainService: ExternalSendDomainService;
  private readonly externalAppConnectionDomainService: ExternalAppConnectionDomainService;
  private readonly roomAgentDomainService: RoomAgentDomainService;
  private readonly roomAuthorizationService: RoomAuthorizationService;
  private readonly activityIngest: ActivityIngestService;
  private readonly activityHistoryDomainService: ActivityHistoryDomainService;
  private readonly resourceVersionDomainService: ResourceVersionDomainService;
  private readonly workspaceContextDomainService: WorkspaceContextDomainService;
  private readonly humanChangeRequestDomainService: HumanChangeRequestDomainService;
  private readonly resourceTransferDomainService: ResourceTransferDomainService;
  private readonly resourceRedactionDomainService: ResourceRedactionDomainService;
  private readonly resourceMutationActivity: ResourceMutationActivityService;
  private readonly learningEvidenceAssembler: LearningEvidenceAssembler;
  /** Identity cache only for an already live-checked pre-Core 06 Run. */
  private readonly legacyRunRequesterIds = new Map<string, string>();
  private agentHost: AgentHost | undefined;

  constructor(
    private readonly store: RuntimeWorkspacePort,
    private readonly emit: RuntimeEventSink = () => undefined,
    private readonly provider?: ProviderAdapter,
    backendRegistry?: AgentBackendRegistry,
    pluginRegistry?: PluginRuntimeRegistry,
    externalAssistProvider?: ExternalAssistProvider | ExternalAssistProvider[],
    private readonly workspaceOptions: AgentRuntimeWorkspaceOptions = {}
  ) {
    const runWebMutation = <TResource, TExtra extends Record<string, unknown> = {}>(
      input: Omit<RecordedMutationInput<TResource, TExtra>, "context">
    ) => this.runRecordedMutation<TResource, TExtra>({ ...input, context: webGatewayContext });
    this.domainCommandBus = new DurableDomainCommandBus(this.store, workspaceOptions.domainCommandRunningTimeoutMs);
    this.learningEvidenceAssembler = new LearningEvidenceAssembler({
      getBackendRun: (id) => this.store.getBackendRun(id),
      getSession: (id) => this.store.getSession(id),
      getRoom: (id) => this.store.getRoom(id),
      getAgent: (id) => this.store.getAgent(id),
      listMessages: (sessionId) => this.store.listMessages(sessionId),
      listBackendEvents: (input) => this.store.listBackendEvents(input),
      listToolRuns: (input) => this.store.listToolRuns(input),
      listWorkspaceChanges: (sessionId) => this.store.listWorkspaceChanges(sessionId),
      listArtifactsForSession: (sessionId) => this.store.listArtifactsForSession(sessionId),
      listLearningResourceUses: (input) => this.store.listLearningResourceUses(input)
    });
    this.domainOperationTelemetry = new DomainOperationTelemetryService({
      getBackendRun: (id) => this.store.getBackendRun(id),
      listWorkspaceChanges: (sessionId) => this.store.listWorkspaceChanges(sessionId),
      saveWorkspaceChange: (change) => this.store.saveWorkspaceChange(change),
      emitWorkspaceChange: async (change) => { await this.emit("workspace.change.created", change); }
    });
    this.runtimeDomainApi = new RuntimeDomainApi({
      command: (input, trusted) => this.runDomainCommandWithTrustedContext(input as DomainCommandRuntimeInput, trusted as TrustedDomainRuntimeContext),
      query: (input, trusted) => this.runRuntimeApiDomainQuery(input, trusted as TrustedDomainRuntimeContext)
    });
    this.presentationDomainService = new PresentationDomainService({
      getPresentation: (id) => this.store.getMessagePresentation(id),
      presentView: (input) => this.presentCollectionView(input),
      applyViewState: (spec, viewState) => applyCollectionPresentationViewState(spec, collectionPresentationUserViewStatePatch(viewState)),
      viewStateFromSpec: (spec) => collectionRenderSpecViewState(spec),
      updateViewState: (input) => this.store.updateMessagePresentationViewState(input),
      savePresentation: (record) => this.store.saveMessagePresentation(record)
    }, (id) => new RuntimeRequestError("not_found", `Message presentation not found: ${id}`));
    this.backendRegistry = backendRegistry ?? createDefaultAgentBackendRegistry(provider);
    this.durableWorkCoordinator = new DurableWorkCoordinator(this.store, {
      cancelRun: (runId) => this.requireAgentHost().cancelRun(runId)
    });
    this.executionDomainService = new ExecutionDomainService({
      store: {
        getObjective: (id, roomId) => this.store.getObjective(id, roomId),
        saveWorkItem: (record, roomId) => this.store.saveWorkItem(record, roomId),
        createWorkspaceBackup: () => this.store.createWorkspaceBackup(),
        restoreWorkspaceBackup: (backupId) => this.store.restoreWorkspaceBackup(backupId),
        repairWorkspace: (options) => this.store.repairWorkspace(options)
      },
      coordinator: {
        followUp: (workItemId, instruction, roomId) => this.durableWorkCoordinator.followUp(workItemId, instruction, roomId),
        steer: (workItemId, instruction, roomId) => this.durableWorkCoordinator.steer(workItemId, instruction, roomId)
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.pluginRegistry = pluginRegistry ?? new PluginRuntimeRegistry();
    this.backendToolBridgeService = new BackendToolBridgeService({
      getRun: (runId) => this.store.getBackendRun(runId),
      listEvents: (runId) => this.store.listBackendEvents({ runId }),
      buildRunInput: (run) => this.buildResumeToolRunInput(run, {}),
      recordEvent: (run, event) => this.requireAgentHost().recordToolBridgeEvent({ run, event }),
      executeRuntimeTool: (input) => this.handleRuntimeToolCall(input.run, input.runInput, input.event),
      executeProviderQuery: (input) => this.handleProviderDomainQueryToolCall(input.run, input.runInput, input.event, input.queryId, input.args),
      runReadOnlyTool: (input) => this.runReadOnlyBackendTool(input.toolName, input.toolInput, { runId: input.runId }),
      executeBackendToolStarted: (input) => this.handleBackendToolStartedEvent(input),
      createError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.pluginDomainService = new PluginDomainService({
      plugins: {
        setEnabled: (pluginId, enabled) => this.pluginRegistry.setPluginEnabled(pluginId, enabled),
        findStatus: (pluginId) => this.pluginRegistry.listPluginStatuses().find((item) => item.manifest_id === pluginId),
        saveState: (input) => this.store.savePluginState(input)
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.settingsDomainService = new SettingsDomainService(
      { patch: (patch) => this.store.patchSettings(patch) },
      { getRoom: (id) => this.store.getRoom(id), getAgent: (id) => this.store.getAgent(id) },
      (code, message) => new RuntimeRequestError(code, message)
    );
    this.roomAuthorizationService = new RoomAuthorizationService(this.store);
    this.activityIngest = new ActivityIngestService(this.store, this.roomAuthorizationService);
    this.activityHistoryDomainService = new ActivityHistoryDomainService(
      new ActivityHistoryQueryService(this.store, this.roomAuthorizationService),
      (context) => this.resourceMutationActivityContext(context)
    );
    this.resourceVersionDomainService = new ResourceVersionDomainService({
      listArtifactRevisions: (artifactId) => this.store.listArtifactRevisions(artifactId),
      getCollectionSchema: (collectionId) => this.store.getCollectionSchema(collectionId),
      getCollectionRecord: (collectionId, recordId) => this.store.getCollectionRecord(collectionId, recordId),
      getWiki: (id) => this.store.getWiki(id),
      getSkill: (id) => this.store.getSkill(id),
      getMemory: (id) => this.store.getMemory(id)
    }, this.roomAuthorizationService);
    this.workspaceContextDomainService = new WorkspaceContextDomainService({
      getRoom: (id) => this.store.getRoom(id),
      getWorkspaceContext: () => this.store.getWorkspaceContext(),
      getRoomContext: (roomId) => this.store.getRoomContext(roomId)
    }, this.roomAuthorizationService);
    this.humanChangeRequestDomainService = new HumanChangeRequestDomainService(
      this.activityIngest,
      (context) => this.resourceMutationActivityContext(context)
    );
    this.resourceMutationActivity = new ResourceMutationActivityService(this.store, this.activityIngest);
    const roomResourceCatalog = new RoomResourceCatalog(
      this.store,
      (input) => this.resolveWorkspacePath(input).relativePath,
      async (relativePath) => {
        return this.filePort().isFile(this.resolveWorkspacePath(relativePath).absolutePath);
      }
    );
    this.roomAgentDomainService = new RoomAgentDomainService(
      this.store,
      this.roomAuthorizationService,
      roomResourceCatalog,
      (backendId) => Boolean(this.backendRegistry.get(backendId)),
      (code, message) => new RuntimeRequestError(code, message)
    );
    this.objectiveDomainService = new ObjectiveDomainService({
      objectives: {
        save: (record) => this.store.saveObjective(record, record.room_id),
        transition: (objectiveId, action, roomId) => this.durableWorkCoordinator.transitionObjective(objectiveId, action, roomId)
      }
    });
    this.translationDomainService = new TranslationDomainService({
      translations: {
        saveTranslation: (record) => this.store.saveResourceTranslation(record),
        saveAutomationJob: (input) => this.saveAutomationJob(input)
      },
      sources: {
        loadArtifact: async (id) => {
          const resource = await this.store.getArtifact(id); const content = resource ? await this.store.readArtifactContent(id) : undefined;
          return resource && content !== undefined ? { ref: resource.file_ref, source_locale: resource.locale, content } : undefined;
        },
        loadMemory: async (id) => {
          const resource = await this.store.getMemory(id); const content = resource ? await this.store.readMemoryContent(id) : undefined;
          return resource && content !== undefined ? { ref: memoryRef(resource), source_locale: resource.content_locale, content } : undefined;
        },
        loadWiki: async (id) => {
          const resource = await this.store.getWiki(id); const content = resource ? await this.store.readWikiContent(id) : undefined;
          return resource && content !== undefined ? { ref: wikiRef(resource), source_locale: resource.content_locale, content } : undefined;
        },
        loadSkill: async (id) => {
          const resource = await this.store.getSkill(id); const content = resource ? await this.store.readSkillMarkdown(id) : undefined;
          return resource && content !== undefined ? { ref: skillRef(resource), content } : undefined;
        },
        loadCollectionRecord: async (ref) => {
          const target = collectionRecordTargetFromRef(ref);
          const resource = target ? await this.store.getCollectionRecord(target.collectionId, target.recordId) : undefined;
          return resource ? { ref: collectionRecordRef(resource), source_locale: localeFromJson(resource.data.content_locale), content: JSON.stringify(resource.data, null, 2) } : undefined;
        }
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.learningResourceUseDomainService = new LearningResourceUseDomainService({
      getRun: (id) => this.store.getBackendRun(id),
      resolveActivityContext: async (run) => {
        if (!run.agent_id || !run.session_id) return undefined;
        const [session, agent] = await Promise.all([this.store.getSession(run.session_id), this.store.getAgent(run.agent_id)]);
        if (!session?.room_id || session.id !== run.session_id || !agent) return undefined;
        return { room_id: session.room_id, session_id: session.id, agent_id: agent.id };
      },
      getResource: async ({ resourceKind, resourceId }) => {
        if (resourceKind === "memory") {
          const resource = await this.store.getMemory(resourceId);
          return resource ? {
            resource_kind: "memory" as const,
            resource_id: resource.id,
            resource_version: resource.version,
            content_hash: resource.content_hash,
            usage_scope: resource.usage_scope,
            evidence_state: resource.evidence_state,
            usage_state: resource.usage_state
          } : undefined;
        }
        if (resourceKind === "wiki") {
          const resource = await this.store.getWiki(resourceId);
          return resource ? {
            resource_kind: "wiki" as const,
            resource_id: resource.id,
            resource_version: resource.version,
            content_hash: resource.content_hash,
            usage_scope: resource.usage_scope,
            evidence_state: resource.evidence_state,
            usage_state: resource.usage_state
          } : undefined;
        }
        const resource = await this.store.getSkill(resourceId);
        return resource ? {
          resource_kind: "skill" as const,
          resource_id: resource.id,
          resource_version: resource.frontmatter.version,
          content_hash: resource.frontmatter.content_hash,
          usage_scope: resource.frontmatter.usage_scope,
          evidence_state: resource.frontmatter.evidence_state,
          usage_state: resource.frontmatter.usage_state
        } : undefined;
      },
      listUses: (input) => this.store.listLearningResourceUses(input),
      recordUse: (record) => this.store.recordLearningResourceUse(record),
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.learningResourceVersionDomainService = new LearningResourceVersionDomainService({
      getVersion: (input) => this.store.getLearningResourceVersion(input),
      getCurrentVersion: (input) => this.store.getCurrentLearningResourceVersion(input),
      listVersions: (input) => this.store.listLearningResourceVersions(input),
      readHistoricalVersion: (input) => this.store.readLearningResourceVersionContent(input),
      readCurrentDocument: async ({ resourceKind, resourceId }) => {
        if (resourceKind === "memory") return this.store.readMemoryMarkdown(resourceId);
        if (resourceKind === "wiki") return this.store.readWikiMarkdown(resourceId);
        return this.store.readSkillMarkdown(resourceId);
      },
      readCurrentContent: async ({ resourceKind, resourceId }) => {
        if (resourceKind === "memory") return this.store.readMemoryContent(resourceId);
        if (resourceKind === "wiki") return this.store.readWikiContent(resourceId);
        const markdown = await this.store.readSkillMarkdown(resourceId);
        return markdown ? skillBodyFromMarkdown(markdown) : undefined;
      },
      getCurrentResource: async ({ resourceKind, resourceId }) => {
        if (resourceKind === "memory") {
          const resource = await this.store.getMemory(resourceId);
          return resource ? {
            file_path: resource.file_path,
            version: resource.version,
            content_hash: resource.content_hash,
            source_run_ids: resource.source_run_ids,
            usage_scope: resource.usage_scope,
            evidence_state: resource.evidence_state,
            usage_state: resource.usage_state,
            pinned: resource.pinned
          } : undefined;
        }
        if (resourceKind === "wiki") {
          const resource = await this.store.getWiki(resourceId);
          return resource ? {
            file_path: resource.file_path,
            version: resource.version,
            content_hash: resource.content_hash,
            source_run_ids: resource.source_run_ids,
            usage_scope: resource.usage_scope,
            evidence_state: resource.evidence_state,
            usage_state: resource.usage_state,
            pinned: resource.pinned
          } : undefined;
        }
        const resource = await this.store.getSkill(resourceId);
        return resource ? {
          file_path: resource.file_path,
          version: resource.frontmatter.version,
          content_hash: resource.frontmatter.content_hash,
          source_run_ids: resource.frontmatter.source_run_ids,
          usage_scope: resource.frontmatter.usage_scope,
          evidence_state: resource.frontmatter.evidence_state,
          usage_state: resource.frontmatter.usage_state,
          pinned: resource.frontmatter.pinned
        } : undefined;
      },
      writeCurrentResource: async ({ resourceKind, resourceId, content, version, contentHash, usageScope, evidenceState, usageState, pinned, archive }) => {
        if (resourceKind === "memory") {
          if (archive) {
            const archived = await this.store.archiveMemory(resourceId);
            if (!archived) return undefined;
          } else {
            const replaced = await this.store.replaceMemoryContent(resourceId, content);
            if (!replaced) return undefined;
          }
          const resource = await this.store.patchMemoryLearningMetadata({
            id: resourceId,
            metadata: {
              version,
              content_hash: contentHash,
              ...(usageScope === undefined ? {} : { usage_scope: usageScope }),
              ...(evidenceState === undefined ? {} : { evidence_state: evidenceState }),
              ...(usageState === undefined ? {} : { usage_state: usageState }),
              ...(pinned === undefined ? {} : { pinned })
            }
          });
          return resource ? { file_path: resource.file_path, content_hash: resource.content_hash ?? contentHash } : undefined;
        }
        if (resourceKind === "wiki") {
          const replaced = archive
            ? await this.store.setWikiState(resourceId, "archived")
            : await this.store.updateWikiPage({ id: resourceId, content });
          if (!replaced) return undefined;
          const resource = await this.store.patchWikiLearningMetadata({
            id: resourceId,
            metadata: {
              version,
              content_hash: contentHash,
              ...(usageScope === undefined ? {} : { usage_scope: usageScope }),
              ...(evidenceState === undefined ? {} : { evidence_state: evidenceState }),
              ...(usageState === undefined ? {} : { usage_state: usageState }),
              ...(pinned === undefined ? {} : { pinned })
            }
          });
          return resource ? { file_path: resource.file_path, content_hash: resource.content_hash ?? contentHash } : undefined;
        }
        const replaced = archive
          ? await this.store.updateSkillState(resourceId, "archived")
          : await this.store.replaceSkillContent(resourceId, content);
        if (!replaced) return undefined;
        const resource = await this.store.patchSkillLearningMetadata({
          id: resourceId,
          metadata: {
            version,
            content_hash: contentHash,
            ...(usageScope === undefined ? {} : { usage_scope: usageScope }),
            ...(evidenceState === undefined ? {} : { evidence_state: evidenceState }),
            ...(usageState === undefined ? {} : { usage_state: usageState }),
            ...(pinned === undefined ? {} : { pinned })
          }
        });
        return resource ? { file_path: resource.file_path, content_hash: resource.frontmatter.content_hash ?? contentHash } : undefined;
      },
      restoreCurrentDocument: async ({ resourceKind, resourceId, markdown, version }) => {
        if (resourceKind === "memory") {
          const resource = await this.store.restoreMemoryVersionMarkdown({ id: resourceId, markdown, version });
          return resource ? { file_path: resource.file_path, content_hash: resource.content_hash ?? "" } : undefined;
        }
        if (resourceKind === "wiki") {
          const resource = await this.store.restoreWikiVersionMarkdown({ id: resourceId, markdown, version });
          return resource ? { file_path: resource.file_path, content_hash: resource.content_hash ?? "" } : undefined;
        }
        const resource = await this.store.restoreSkillVersionMarkdown({ id: resourceId, markdown, version });
        return resource ? { file_path: resource.file_path, content_hash: resource.frontmatter.content_hash ?? "" } : undefined;
      },
      saveVersion: (input) => this.store.saveLearningResourceVersion(input),
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.core05BackgroundReviewMutationDomainService = new Core05BackgroundReviewMutationDomainService(this.store);
    this.appliedLearningEvaluationDomainService = new AppliedLearningEvaluationDomainService({
      isLearningEnabled: async () => (await this.store.getSettings()).learning_enabled,
      listUses: (input) => this.store.listLearningResourceUses(input),
      listEvaluations: (input) => this.store.listLearningEvaluations(input),
      getRun: (id) => this.store.getBackendRun(id),
      assertRunAccess: (run) => this.assertRunAgentExecution(run),
      assertResourceAccess: async ({ run, resourceKind, resourceId, activityContext, action }) => {
        const access = await this.roomReadAccessForRun(run);
        if (access.roomId !== activityContext.room_id || run.session_id !== activityContext.session_id || run.agent_id !== activityContext.agent_id) {
          throw new RuntimeRequestError("forbidden", "learning_evaluation_activity_context_invalid");
        }
        try {
          await this.roomAuthorizationService.assertResource(access.principal, {
            roomId: access.roomId,
            action,
            resourceKind,
            resourceId
          });
        } catch (error) {
          if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
          throw error;
        }
      },
      listToolRuns: (input) => this.store.listToolRuns(input),
      listMessages: (sessionId) => this.store.listMessages(sessionId),
      getResource: async ({ resourceKind, resourceId }) => {
        if (resourceKind === "memory") {
          const resource = await this.store.getMemory(resourceId);
          return resource ? {
            ref: { ...memoryRef(resource), ...(resource.version ? { version: resource.version } : {}) },
            current_version: resource.version
          } : undefined;
        }
        if (resourceKind === "wiki") {
          const resource = await this.store.getWiki(resourceId);
          return resource ? {
            ref: { ...wikiRef(resource), ...(resource.version ? { version: resource.version } : {}) },
            current_version: resource.version,
            predicted_result: resource.experience_rule?.predicted_result
          } : undefined;
        }
        const resource = await this.store.getSkill(resourceId);
        return resource ? {
          ref: { ...skillRef(resource), ...(resource.frontmatter.version ? { version: resource.frontmatter.version } : {}) },
          current_version: resource.frontmatter.version
        } : undefined;
      },
      markRefuted: async ({ run, ...input }) => {
        const access = await this.roomReadAccessForRun(run);
        if (access.roomId !== input.activityContext.room_id || run.session_id !== input.activityContext.session_id || run.agent_id !== input.activityContext.agent_id) {
          throw new RuntimeRequestError("forbidden", "learning_evaluation_activity_context_invalid");
        }
        const delegated = delegatedParticipant(access.principal);
        const ownerParticipantId = delegated.kind === "agent"
          ? delegated.requestedByParticipantId
          : delegated.participantId;
        return this.core05BackgroundReviewMutationDomainService.markRefuted({
          ...input,
          ownership: {
            roomId: access.roomId,
            ownerParticipantId,
            creatorParticipantId: delegated.kind === "agent"
              ? agentParticipantId(delegated.agentId)
              : delegated.participantId
          }
        });
      },
      createReflectionRun: (record) => this.store.createReflectionRun(record),
      updateReflectionRun: (record) => this.store.updateReflectionRun(record),
      saveEvaluation: (record) => this.store.saveLearningEvaluation(record),
      saveSuggestion: (record) => this.store.saveReflectionSuggestion(record),
      saveJobReport: (record) => this.store.saveLearningJobReport(record)
    });
    this.learningDomainService = new LearningDomainService({
      learning: {
        saveCuratorState: (input) => this.store.saveCuratorState(input),
        restoreSnapshot: (snapshotId, options) => this.store.restoreLearningSnapshot(snapshotId, options),
        createSnapshot: (runId) => this.store.createLearningSnapshot(runId),
        listSnapshots: () => this.store.listLearningSnapshots(),
        pruneSnapshots: (retain) => this.store.pruneLearningSnapshots(retain)
      },
      curator: {
        // Explicit Curator commands already carry a trusted Session. Reuse
        // that boundary and never create a scheduler-owned synthetic Session.
        ensureSession: async () => {
          const context = this.activeDomainContext.getStore();
          if (!context?.sessionId || !context.roomId || !context.participant) {
            throw new RuntimeRequestError("forbidden", "curator_room_session_required");
          }
          const session = await this.store.getSession(context.sessionId);
          if (!session || session.room_id !== context.roomId) throw new RuntimeRequestError("forbidden", "curator_session_room_mismatch");
          try {
            await this.roomAuthorizationService.assertResource(context.participant, {
              roomId: context.roomId,
              action: "edit",
              resourceKind: "session",
              resourceId: session.id
            });
          } catch (error) {
            if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
            throw error;
          }
          return session;
        },
        // Curator reads only the resources explicitly available in the
        // trusted Session's Room. No workspace-wide fallback is allowed.
        getState: () => this.store.getCuratorState(),
        listMemory: async () => {
          const context = this.activeDomainContext.getStore();
          const resourceIds = context?.roomId ? await this.store.listResourceIdsAvailableInRoom({ resourceKind: "memory", roomId: context.roomId }) : [];
          return this.store.listMemory({ resourceIds, includeLegacy: false });
        },
        listSkills: async () => {
          const context = this.activeDomainContext.getStore();
          const resourceIds = context?.roomId ? await this.store.listResourceIdsAvailableInRoom({ resourceKind: "skill", roomId: context.roomId }) : [];
          return this.store.listSkills({ resourceIds, includeLegacy: false });
        },
        listSkillUsage: ({ skillIds }) => this.store.listSkillUsage({ skillIds }),
        listWiki: async () => {
          const context = this.activeDomainContext.getStore();
          const resourceIds = context?.roomId ? await this.store.listResourceIdsAvailableInRoom({ resourceKind: "wiki", roomId: context.roomId }) : [];
          return this.store.listWiki({ activeOnly: false, resourceIds, includeLegacy: false });
        },
        createReflectionRun: (run) => this.store.createReflectionRun(run),
        updateReflectionRun: (run) => this.store.updateReflectionRun(run), createSnapshot: (runId) => this.store.createLearningSnapshot(runId),
        restoreSnapshot: async (id) => { await this.store.restoreLearningSnapshot(id); }, saveState: (input) => this.store.saveCuratorState(input),
        saveSuggestion: async (value) => { await this.store.saveReflectionSuggestion(value); }, saveJobReport: async (value) => { await this.store.saveLearningJobReport(value); },
        archiveResourceVersion: async ({ roomId, ...input }) => {
          if (!roomId) throw new RuntimeRequestError("conflict", "curator_room_context_required");
          // A legacy resource becomes formally Room-bound before this write.
          // `ensureResourceAccessBoundary` repeats the Owner's current Room
          // membership inside its database transaction.
          await this.store.ensureResourceAccessBoundary({
            resourceKind: input.resourceKind,
            resourceId: input.resourceId,
            sourceRoomId: roomId,
            ownerParticipantId: localOwnerParticipantId,
            creatorParticipantId: localOwnerParticipantId,
            actorId: localOwnerParticipantId
          });
          await this.learningResourceVersionDomainService.archive(input);
        },
        errorMessage: (error) => errorMessage(error), nextRunAt: (fromMs) => nextRunFromSchedule("weekly", fromMs)
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.systemDomainService = new SystemDomainService({
      operations: {
        getSession: (id) => this.store.getSession(id),
        getBackendRun: (id) => this.store.getBackendRun(id),
        listMessages: (sessionId) => this.store.listMessages(sessionId),
        listBackendRuns: (sessionId) => this.store.listBackendRuns(sessionId),
        listToolRuns: (runId) => this.store.listToolRuns(runId ? { runId } : {}),
        listWorkspaceChanges: (sessionId) => this.store.listWorkspaceChanges(sessionId),
        listBackendEvents: (input) => this.store.listBackendEvents(input),
        loadArtifacts: (input) => this.loadReflectionArtifacts(input as Parameters<AgentRuntime["loadReflectionArtifacts"]>[0]),
        executeReflection: (input) => this.runReflectionForCompletedTurn(input as Parameters<AgentRuntime["runReflectionForCompletedTurn"]>[0]),
        getReflectionSuggestion: async (sessionId, suggestionId) => {
          const runs = await this.store.listReflectionRuns(sessionId);
          for (const run of runs) {
            const suggestion = (await this.store.listReflectionSuggestions(run.id)).find((item) => item.id === suggestionId);
            if (suggestion) return suggestion;
          }
          return undefined;
        },
        updateReflectionSuggestion: (suggestion) => this.store.updateReflectionSuggestion(suggestion),
        ensureReflectionSession: () => this.ensureSessionForContext(webGatewayContext, "Workspace operations"),
        createReflectionEnvelope: (content) => createGatewayEnvelope(webGatewayContext, content),
        runReflectionMutation: (input) => this.runRecordedMutation<ReflectionTarget>({ ...input, context: webGatewayContext }),
        createMemoryTarget: async (input) => {
          const resource = await createTopicMemory(this.store, input.envelope as Parameters<typeof createTopicMemory>[1], input.title, input.content);
          return { resource, ref: memoryRef(resource) };
        },
        createWikiTarget: async (input) => {
          const result = await this.createWikiProposal({
            title: input.title, content: input.content, source_refs: input.sourceRefs,
            provenance: { kind: "generated_local", summary: "Applied from reflection suggestion.", verified: false }
          });
          return { resource: result.resource, ref: result.operation.result_ref!, rollbackPoint: result.rollbackPoint };
        },
        createSkillTarget: async (input) => {
          const result = await this.createSkillCandidate({
            title: input.title, description: summarize(input.content), content: input.content,
            tags: ["reflection"], source_refs: input.sourceRefs,
            provenance_detail: { kind: "generated_local", summary: "Applied from reflection suggestion.", verified: false }
          });
          return { resource: result.resource, ref: result.operation.result_ref!, rollbackPoint: result.rollbackPoint };
        },
        createReflectionRollback: (operation, refs, after) => this.createRollbackPoint(operation, refs, {}, after),
        now: () => nowIso()
      },
      rollback: {
        get: (id) => this.store.getRollbackPoint(id),
        resolve: (value) => this.resolveWorkspacePath(value),
        read: (value) => this.filePort().readTextIfExists(value),
        write: (value, content) => this.filePort().writeText(value, content),
        remove: (value) => this.filePort().remove(value),
        ensureParent: (value) => this.filePort().ensureParent(value),
        runMutation: (input) => runWebMutation(input),
        createRollback: (operation, refs, before, after) => this.createRollbackPoint(operation, refs, before, after),
        fileRef: (value) => fileRef(value),
        requestError: (code, message) => new RuntimeRequestError(code, message)
      },
      tools: {
        executeSandbox: (context, input) => this.executeSandboxDomainOperation(context, input),
        callMcp: (context, input) => this.executeMcpDomainOperation(context, input)
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.clientEventDomainService = new ClientEventDomainService({
      events: {
        acknowledge: (eventId) => this.store.ackClientEvent(eventId),
        deliver: (eventId) => this.store.markClientEventDelivered(eventId),
        expire: (now) => this.store.expireClientEvents({ now }),
        fail: (eventId, errorCode) => this.store.failClientEvent(eventId, errorCode),
        save: (event: ClientEventRecord) => this.store.saveClientEvent(event)
      },
      notFoundError: () => new RuntimeRequestError("not_found", "client_event_not_found")
    });
    this.gatewayDomainService = new GatewayDomainService({
      gateway: {
        expireConcurrencyLocks: (now) => this.store.expireGatewayConcurrencyLocks(now),
        deleteSandbox: (id) => this.deleteGatewaySandboxInstance(id),
        recreateSandbox: (id) => this.recreateGatewaySandboxInstance(id),
        syncSandbox: (id, input) => this.syncGatewaySandboxWorkspace(id, input),
        repairState: (input) => this.repairGatewayState(input)
      },
      policy: {
        getMcpConfig: (id) => this.store.getGatewayMcpConfig(id),
        saveMcpConfig: (record) => this.store.saveGatewayMcpConfig(record),
        listPairingPolicies: () => this.store.listGatewayPairingPolicies(),
        getPairingPolicy: (channel) => this.store.getGatewayPairingPolicy(channel),
        savePairingPolicy: (record) => this.store.saveGatewayPairingPolicy(record),
        emitPairingPolicySaved: async (record) => { await this.emit("gateway.pairing_policy.saved", record); },
        listRoutingPolicies: () => this.store.listGatewayRoutingPolicies(),
        getRoutingPolicy: (channel) => this.store.getGatewayRoutingPolicy(channel),
        saveRoutingPolicy: (record) => this.store.saveGatewayRoutingPolicy(record),
        emitRoutingPolicySaved: async (record) => { await this.emit("gateway.routing_policy.saved", record); }
      },
      pairing: {
        get: (id) => this.store.getGatewayPairing(id),
        save: (record) => this.store.saveGatewayPairing(record),
        expireAll: (now) => this.store.expireGatewayPairings(now),
        emitUpdated: async (record) => { await this.emit("gateway.pairing.updated", record); }
      },
      inbound: {
        expirePairings: () => this.gatewayDomainService.expirePairingsPrimitive(nowIso()),
        getRoutingPolicy: (channel) => this.gatewayDomainService.getRoutingPolicy(channel),
        getPairingPolicy: (channel) => this.gatewayDomainService.getPairingPolicy(channel),
        saveInbound: (record) => this.store.saveGatewayInboundMessage(record),
        emit: async (name, payload) => { await this.emit(
          name as Parameters<AgentRuntime["emit"]>[0],
          payload as Parameters<AgentRuntime["emit"]>[1]
        ); },
        findDuplicate: (input) => this.findRecentGatewayInboundDuplicate(input.channel, input.sourceIdentity, input.body, input.windowMs, input.externalMessageId),
        isRateLimited: (input) => this.isGatewayRateLimited(input.channel, input.sourceIdentity, input.windowMs, input.maxMessages),
        findPairing: (input) => this.store.findGatewayPairing(input),
        getPairing: (id) => this.store.getGatewayPairing(id),
        savePairing: (record) => this.store.saveGatewayPairing(record),
        saveBoundaryPolicy: (policy) => this.store.saveGatewayBoundaryPolicy(policy),
        acquireLock: (policy, inbound) => this.acquireGatewayConcurrencyLock(policy, inbound),
        releaseLock: async (lockKey) => { await this.store.releaseGatewayConcurrencyLock(lockKey); },
        ensureSession: (context, title) => this.ensureSessionForContext(context, title),
        runChat: (input) => this.runChatTurn({ sessionId: input.sessionId, content: input.body, backend_id: input.backendId,
          input_locale: input.inputLocale as SupportedLocale | undefined, output_locale: input.outputLocale as SupportedLocale | undefined,
          metadata: input.metadata, gateway_context: input.context, gateway_boundary_policy: input.boundaryPolicy, idempotency_key: input.idempotencyKey }),
        enqueueDeliveries: (input) => this.enqueueGatewayReplyDeliveries({ ...input, chat: input.chat as RunChatTurnResult }),
        errorMessage: (error) => safeRuntimeErrorMessage(error, "gateway_inbound_failed"),
        conflictError: (message) => new RuntimeRequestError("conflict", message)
      },
      notFoundError: (message) => new RuntimeRequestError("not_found", message)
    });
    this.wikiDomainService = new WikiDomainService({
      wiki: {
        get: (id) => this.store.getWiki(id),
        readContent: (id) => this.store.readWikiContent(id),
        save: (record, content) => this.store.saveWikiPage(record, content),
        copy: (input) => this.store.copyWikiPage(input),
        move: (input) => this.store.moveWikiPage(input),
        update: (input) => this.store.updateWikiPage(input),
        setState: (id, state, expectedResourceVersion) => this.store.setWikiState(id, state, expectedResourceVersion),
        reindex: () => this.store.reindexWiki(),
        defaultOutputLocale: async () => (await this.store.getSettings()).output_locale,
        runMutation: (input) => runWebMutation(input),
        createRollback: (operation, refs, before, after) => this.createRollbackPoint(operation, refs, before, after),
        requestError: (code, message) => new RuntimeRequestError(code, message),
        mapWriteError: (error) => hasErrorName(error, "ManagedResourceVersionConflictError") || hasErrorName(error, "ManagedResourceScopeTransferError")
          ? new RuntimeRequestError("conflict", error.message)
          : error instanceof Error ? error : new Error(String(error))
      }
    });
    this.automationDomainService = new AutomationDomainService({
      automation: {
        releaseLock: (jobId, lockOwnerToken, now) => this.store.releaseAutomationJobLock(jobId, { lockOwnerToken, ...(now ? { now } : {}) }),
        requeue: (jobId, nextRunAt) => this.store.requeueAutomationJob(jobId, { nextRunAt })
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.core09AutomationDomainService = new Core09AutomationDomainService({
      store: {
        saveAutomationJob: (job) => this.store.saveAutomationJob(job),
        getAutomationJob: (id) => this.store.getAutomationJob(id),
        acquireAutomationJobLock: (id, input) => this.store.acquireAutomationJobLock(id, input),
        createAutomationRun: (run) => this.store.createAutomationRun(run),
        attachAutomationRunEvidence: (input) => this.store.attachAutomationRunEvidence(input),
        attachAutomationRunBackendRun: (input) => this.store.attachAutomationRunBackendRun(input),
        settleAutomationRun: (input) => this.store.settleAutomationRun(input),
        listExpiredAutomationRunClaims: (now) => this.store.listExpiredAutomationRunClaims(now),
        getExternalAppConnection: (id) => this.store.getExternalAppConnection(id),
        getExternalAppConnectionByConnector: (input) => this.store.getExternalAppConnectionByConnector(input)
      },
      roomAuthorization: this.roomAuthorizationService,
      mutation: {
        runMutation: (input) => this.runRecordedMutation({
          ...input,
          context: this.gatewayContextForTrustedDomainContext(input.trustedContext)
        })
      },
      execution: {
        reindexWiki: () => this.store.reindexWiki(),
        runInstruction: (input) => this.runAutomationInstructionWorkspaceExecution(input),
        runCollectionTrigger: (input) => this.collectionDomainService.executeTriggerJob(input.job, input.context),
        retryAt: (failureCount) => nextRetryAt(failureCount)
      },
      sessionlessMemoryReview: () => this.runLegacySessionlessMemoryReview(),
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.externalAppConnectionDomainService = new ExternalAppConnectionDomainService({
      workspaceId: "workspace",
      store: {
        saveExternalAppConnection: (record) => this.store.saveExternalAppConnection(record),
        getExternalAppConnection: (id) => this.store.getExternalAppConnection(id),
        revokeExternalAppConnection: (input) => this.store.revokeExternalAppConnection(input)
      },
      roomAuthorization: this.roomAuthorizationService,
      mutation: {
        runMutation: (input) => this.runRecordedMutation({
          ...input,
          context: this.gatewayContextForTrustedDomainContext(input.trustedContext)
        })
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.generatedSurfaceDomainService = new GeneratedSurfaceDomainService({
      surfaces: {
        getSurface: (id) => this.store.getGeneratedSurface(id),
        getRevision: (id) => this.store.getGeneratedSurfaceRevision(id),
        readBundle: (id) => this.store.readGeneratedSurfaceBundle(id),
        saveRevision: (input) => this.store.saveGeneratedSurfaceRevision(input),
        saveInteraction: (record) => this.store.saveSurfaceInteraction(record),
        updateState: (id, state) => this.store.updateGeneratedSurfaceState(id, state),
      },
      runMutation: <TExtra extends Record<string, unknown>>(input: import("./commands/services/generated-surface-domain-service").GeneratedSurfaceMutationInput<TExtra>) => this.runRecordedMutation<GeneratedSurfaceDefinition, TExtra>({
        ...input,
        context: webGatewayContext,
        trustedContext: input.trustedContext,
        core08Evidence: { changeType: "other" }
      }),
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.skillDomainService = new SkillDomainService({
      optimization: {
        repoRoot: () => path.resolve(this.workspaceOptions.repoRoot ?? process.cwd()),
        getSkill: (id) => this.store.getSkill(id),
        readMarkdown: (id) => this.store.readSkillMarkdown(id),
        listUses: (input) => this.store.listLearningResourceUses(input),
        getBackendRun: (id) => this.store.getBackendRun(id),
        getSession: (id) => this.store.getSession(id),
        acquireLock: (input) => this.store.acquireSkillOptimizationLock(input),
        getLock: (skillId) => this.store.getSkillOptimizationLock(skillId),
        releaseLock: (input) => this.store.releaseSkillOptimizationLock(input),
        saveDataset: (record) => this.store.saveSkillOptimizationDataset(record),
        saveObjective: (record, roomId) => this.store.saveObjective(record, roomId),
        getObjective: (id, roomId) => this.store.getObjective(id, roomId),
        updateObjective: (record, roomId) => this.store.updateObjective(record, roomId),
        saveWorkItem: (record, roomId) => this.store.saveWorkItem(record, roomId),
        getWorkItem: (id, roomId) => this.store.getWorkItem(id, roomId),
        claimWorkItem: (input) => this.store.claimWorkItem(input),
        completeWorkItem: (input) => this.store.completeWorkItem(input),
        failWorkItem: (input) => this.store.failWorkItem(input),
        getRun: (id) => this.store.getSkillOptimizationRun(id),
        saveRun: (record) => this.store.saveSkillOptimizationRun(record),
        getCandidate: (id) => this.store.getOptimizationCandidate(id),
        saveCandidate: (record) => this.store.saveOptimizationCandidate(record),
        saveEvaluation: (record) => this.store.saveOptimizationEvaluation(record),
        getSnapshot: (id) => this.store.getSkillOptimizationSnapshot(id),
        saveSnapshot: (record) => this.store.saveSkillOptimizationSnapshot(record),
        listPromotions: () => this.store.listOptimizationPromotions(),
        savePromotion: (record) => this.store.saveOptimizationPromotion(record),
        replaceContentIfUnchanged: (input) => this.store.replaceSkillContentIfUnchanged(input),
        savePresentations: (input) => this.saveSkillOptimizationPresentations(input),
        hostComplete: async (input) => {
          if (!this.provider) throw new RuntimeRequestError("provider_not_configured", "GEPAのHost LLMが未設定です。");
          const session = input.sessionId ? await this.store.getSession(input.sessionId) : undefined;
          const content = input.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n").trim();
          const output = await this.generateProviderOutput({
            envelope: createGatewayEnvelope(webGatewayContext, content || "GEPA候補を改善してください。", session?.ui_locale ?? "ja", session?.output_locale ?? "ja"),
            activeMemory: [], knowledgeWiki: [], collectionNotes: [], selectedSkills: [], sessionSearch: [],
            availableTools: [], recentMessages: [], temporaryContext: []
          });
          if (!output.content.trim()) throw new Error("gepa_host_empty_response");
          return { content: output.content };
        },
        requestError: (code, message) => new RuntimeRequestError(code, message),
        errorMessage: (error, fallback) => safeRuntimeErrorMessage(error, fallback)
      },
      queries: {
        getSkill: (id) => this.store.getSkill(id),
        getRun: (id) => this.store.getBackendRun(id),
        getSession: (id) => this.store.getSession(id),
        getAgent: (id) => this.store.getAgent(id),
        readSupportFile: (input) => this.store.readSkillSupportFile(input),
        readMarkdown: (id) => this.store.readSkillMarkdown(id),
        listSupportFiles: (id) => this.store.listSkillSupportFileRefs(id)
      },
      usage: {
        listUses: (input) => this.store.listLearningResourceUses(input),
        recordUse: (record) => this.store.recordLearningResourceUse(record),
        incrementSkillUsage: (input) => this.store.recordSkillUsage(input)
      },
      mutation: {
        getSkill: (id) => this.store.getSkill(id),
        readMarkdown: (id) => this.store.readSkillMarkdown(id),
        patchSkill: (input) => this.store.patchSkill(input),
        copySkill: (input) => this.store.copySkill(input),
        moveSkill: (input) => this.store.moveSkill(input),
        updateState: (id, state) => this.store.updateSkillState(id, state),
        saveMarkdown: (input) => this.store.saveSkillMarkdown(input),
        listSupportFiles: (id) => this.store.listSkillSupportFiles(id),
        writeSupportFile: (input) => this.store.writeSkillSupportFile(input),
        ensureSession: () => this.ensureSessionForContext(webGatewayContext, "Workspace operations"),
        createEnvelope: (content) => createGatewayEnvelope(webGatewayContext, content),
        runMutation: (input) => runWebMutation(input),
        createRollback: (operation, refs, before, after) => this.createRollbackPoint(operation, refs, before, after),
        requestError: (code, message) => new RuntimeRequestError(code, message),
        mapWriteError: (error) => hasErrorName(error, "ManagedResourceVersionConflictError") || hasErrorName(error, "ManagedResourceScopeTransferError")
          ? new RuntimeRequestError("conflict", error.message)
          : error instanceof Error ? error : new Error(String(error)),
        contract: (id) => requireDomainCommandEntry(id)
      },
      conflictError: (message) => new RuntimeRequestError("conflict", message)
    });
    this.resourceTransferDomainService = new ResourceTransferDomainService({
      wiki: this.wikiDomainService,
      skill: this.skillDomainService,
      roomAuthorization: this.roomAuthorizationService
    });
    this.resourceRedactionDomainService = new ResourceRedactionDomainService({
      wiki: this.wikiDomainService,
      skill: this.skillDomainService,
      roomAuthorization: this.roomAuthorizationService
    });
    this.conversationDomainService = new ConversationDomainService({
      createSession: (context, input) => {
        const requesterParticipantId = trustedRequesterParticipantId(context);
        return this.createSession({
          ...input,
          ...(context.roomId && input.room_id === undefined ? { room_id: context.roomId } : {}),
          trusted_participant_context: true,
          ...(requesterParticipantId ? { trusted_requester_participant_id: requesterParticipantId } : {})
        });
      },
      runChatTurn: (context, input) => {
        const requesterParticipantId = trustedRequesterParticipantId(context);
        return this.runChatTurn({
          ...input,
          idempotency_key: input.idempotencyKey,
          trusted_participant_context: true,
          ...(requesterParticipantId ? { trusted_requester_participant_id: requesterParticipantId } : {})
        });
      },
      reindexSessionSearch: () => this.store.reindexSessionSearch(),
      conflict: (message) => new RuntimeRequestError("conflict", message)
    });
    this.fileDomainService = new FileDomainService({
      resolve: (input) => this.resolveWorkspacePath(input),
      readText: (absolutePath) => this.filePort().readText(absolutePath),
      readBytes: (absolutePath) => this.filePort().readBytes(absolutePath),
      stat: (absolutePath) => this.filePort().stat(absolutePath),
      assertReadablePath: (workspacePath) => this.assertActiveFilePathAccess(workspacePath, "read"),
      listAccessibleFilePaths: (workspacePath) => this.listActiveRoomFilePaths(workspacePath.relativePath),
      listArtifactsForPath: (relativePath) => this.listActiveRoomArtifactsForPath(relativePath),
      listChangesForPath: (relativePath) => this.listActiveRoomChangesForPath(relativePath)
    }, {
      readTextIfExists: (absolutePath) => this.filePort().readTextIfExists(absolutePath),
      writeText: (absolutePath, content) => this.filePort().writeText(absolutePath, content),
      ensureParent: (absolutePath) => this.filePort().ensureParent(absolutePath),
      assertWritablePath: (workspacePath) => this.assertActiveFilePathAccess(workspacePath, "edit"),
      reindexCollections: async () => { await this.store.reindexCollections(); },
      isManagedCollectionPath: (relativePath) => isManagedCollectionWorkspacePath(relativePath)
    }, {
      runMutation: (input) => this.runRecordedMutation({ ...input, context: webGatewayContext }),
      createRollback: (operation, refs, before, after) => this.createRollbackPoint(operation, refs, before, after),
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.browserDomainService = new BrowserDomainService({
      readPage: (url) => readBrowserPage(url)
    }, {
      interact: async (input) => {
        const adapter = this.workspaceOptions.browserAdapter;
        if (!adapter) throw new RuntimeRequestError("provider_not_configured", "browser_interact_adapter_unavailable");
        const url = await safeBrowserUrl(input.url);
        return { adapterId: adapter.id, ...(await adapter.interact({ ...input, url })) };
      },
      screenshot: async (input) => {
        const adapter = this.workspaceOptions.browserAdapter;
        if (!adapter) throw new RuntimeRequestError("provider_not_configured", "browser_screenshot_adapter_unavailable");
        const url = await safeBrowserUrl(input.url);
        const capture = await adapter.screenshot({ ...input, url });
        return { adapterId: adapter.id, bytes: capture.bytes, mimeType: capture.mime_type, width: capture.width, height: capture.height };
      }
    }, {
      resolve: (input) => this.resolveWorkspacePath(input),
      ensureParent: (absolutePath) => this.filePort().ensureParent(absolutePath),
      readBytesIfExists: (absolutePath) => this.filePort().readBytesIfExists(absolutePath),
      readTextIfExists: (absolutePath) => this.filePort().readTextIfExists(absolutePath),
      write: (absolutePath, content) => typeof content === "string"
        ? this.filePort().writeText(absolutePath, content)
        : this.filePort().writeBytes(absolutePath, content)
    }, {
      ensureSession: () => this.ensureSessionForContext(webGatewayContext, "Workspace operations"),
      createEnvelope: (_session, content) => createGatewayEnvelope(webGatewayContext, content),
      runMutation: (input) => this.runRecordedMutation({ ...input, context: webGatewayContext }),
      createRollback: (operation, refs, before, after) => this.createRollbackPoint(operation, refs, before, after),
      stableHash: (value) => stableHash(value)
    });
    this.externalSendDomainService = new ExternalSendDomainService({
      get: (id) => this.store.getExternalSend(id),
      save: (record) => this.store.saveExternalSend(record),
      dispatch: (record, dryRun) => dispatchExternalSendAdapter(record, dryRun),
      claimDispatch: (input) => this.store.claimExternalSendDispatch(input),
      settleDispatch: (input) => this.store.settleExternalSendDispatch(input),
      markOutcomeUnknown: (input) => this.store.markExternalSendOutcomeUnknown(input)
    }, {
      ensureSession: () => this.ensureSessionForContext(webGatewayContext, "Workspace operations"),
      createEnvelope: (_session, content) => createGatewayEnvelope(webGatewayContext, content),
      getForCurrentRoom: (id) => this.getExternalSendForActiveRoom(id),
      assertCurrentRoomExecution: async () => { await this.assertActiveDomainRoomAction("execute"); },
      runMutation: (input) => this.runRecordedMutation({ ...input, context: webGatewayContext }),
      createRollback: (operation, refs, before, after) => this.createRollbackPoint(operation, refs, before, after),
      createId: () => createId("send"), now: () => nowIso(),
      defaultDryRun: () => process.env.SAMURAI_EXTERNAL_SEND_DISPATCH !== "true",
      notFound: (message) => new RuntimeRequestError("not_found", message)
    });
    this.collectionDomainService = new CollectionDomainService({
      actions: {
        resolveRecordData: (schema, record) => this.collectionActionResolvedRecordData(schema, record as CollectionRecordWithFilePath),
        runInstruction: (input) => this.runCollectionInstructionWorkspaceExecution(input),
        runPlugin: (input) => this.pluginRegistry.executeAction(input.catalogActionId, input.payload, input.context)
      },
      queries: {
        getSchema: (id) => this.store.getCollectionSchema(id),
        listRecords: (schema, input) => this.collectionManageGetItems(schema, input),
        schemaDocs: () => collectionSchemaDocs(),
        presentView: (input) => this.presentCollectionView(input)
      },
      mutation: {
        getSchema: (id) => this.store.getCollectionSchema(id),
        saveSchema: (schema) => this.store.saveCollectionSchema(schema),
        updateSchema: (schema, expectedResourceVersion) => this.store.updateCollectionSchema(schema, expectedResourceVersion),
        saveRecord: async (record, trigger) => this.store.saveCollectionRecord(
          record,
          trigger ? await this.collectionTriggerWriteRequest(trigger) : undefined
        ),
        getRecord: (collectionId, recordId) => this.store.getCollectionRecord(collectionId, recordId),
        deleteRecord: (collectionId, recordId, expectedVersion) => this.store.deleteCollectionRecord(collectionId, recordId, expectedVersion),
        applyRecordPatch: async (input) => {
          const { trigger, ...patchInput } = input;
          return this.store.applyCollectionRecordPatch({
            ...patchInput,
            ...(trigger ? { trigger: await this.collectionTriggerWriteRequest(trigger) } : {})
          });
        },
        mapPatchError: (error) => isCollectionRecordVersionConflictError(error)
          ? new RuntimeRequestError("conflict", error.message, resourceVersionConflictPayload(error))
          : error instanceof Error ? error : new Error(String(error)),
        reindex: () => this.store.reindexCollections(),
      runMutation: <T, Extra extends Record<string, unknown>>(input: Omit<RecordedMutationInput<T, Extra>, "context" | "core08Evidence"> & { trustedContext: TrustedDomainContext; inputSummary: string; evidenceKind?: "resource_change" | "derived_repair" }) => this.runRecordedMutation<T, Extra>({
        ...input,
        context: this.gatewayContextForTrustedDomainContext(input.trustedContext),
          trustedContext: input.trustedContext,
          ...(input.evidenceKind === "derived_repair" ? {} : { core08Evidence: { changeType: "collection_changed" } })
        }),
        createRollback: (operation, refs, before, after) => this.createRollbackPoint(operation, refs, before, after),
        contract: (id) => requireDomainCommandEntry(id)
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.memoryDomainService = new MemoryDomainService({
      memories: {
        getSession: (id) => this.store.getSession(id),
        writeRoomTopicMemory: async (input) => {
          if (!input.context.roomId) throw new RuntimeRequestError("conflict", "memory_room_context_required");
          const settings = await this.store.getSettings();
          return createRoomTopicMemory(this.store, {
            id: input.memoryId,
            topic: input.topicKind,
            content: input.content,
            // A normal chat keeps the optional Session reference so the
            // compatibility archive/read facade can find the Room-scoped
            // Memory without turning Session into its owner. Session-free
            // Workspace execution remains correlated to its Run instead.
            source: input.context.sessionId
              ? `session:${input.context.sessionId}`
              : input.context.runId
                ? `run:${input.context.runId}`
                : `context:${input.context.correlationId}`,
            sourceLocale: input.inputLocale ?? settings.ui_locale,
            contentLocale: input.outputLocale ?? settings.output_locale,
            sourceKind: instructionSourceForDomainInput(input.context.inputSource),
            instructionAuthority: input.context.actorId,
            roomId: input.context.roomId
          });
        },
        memoryRef: (memory) => memoryRef(memory),
        createRollback: (operation, refs, after) => this.createRollbackPoint(operation, refs, {}, after),
        emitCandidate: async (memory) => { await this.emit("memory.candidate.created", memory); },
        runMutation: (input) => this.runRecordedMutation<MemoryFrontmatter>({ ...input, context: webGatewayContext })
      },
      archive: {
        getMemory: (id) => this.store.getMemory(id),
        listMemoryForSession: (sessionId) => this.store.listMemoryForSession(sessionId, { includeArchived: true }),
        archive: (id) => this.store.archiveMemory(id),
        saveOperation: (operation) => this.store.saveOperation(operation),
        updateOperation: (operation) => this.store.updateOperation(operation),
        createRollback: (operation, refs, before, after) => this.createRollbackPoint(operation, refs, before, after),
        rebuildActivity: () => this.rebuildActivity(),
        emitOperation: async (operation) => { await this.emit("operation.created", operation); },
        capabilityId: proposalCapabilityManifest.id
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    this.artifactDomainService = new ArtifactDomainService({
      contract: (id) => requireDomainCommandEntry(id as Parameters<typeof requireDomainCommandEntry>[0]),
      defaultLocales: async () => {
        const settings = await this.store.getSettings();
        return { inputLocale: settings.ui_locale, outputLocale: settings.output_locale };
      },
      runMutation: <TExtra extends Record<string, unknown>>(input: ArtifactMutationInput<TExtra>) => this.runRecordedMutation<ArtifactRecord, TExtra>({
        ...input,
        context: this.gatewayContextForTrustedDomainContext(input.trustedContext),
        trustedContext: input.trustedContext,
        core08Evidence: { changeType: "artifact_created" },
        execute: async (operation) => {
          const result = await input.execute(operation);
          const { extra, ...base } = result;
          return { ...base, ...extra };
        }
      }),
      getArtifact: (id) => this.store.getArtifact(id),
      readContent: (id) => this.store.readArtifactContent(id),
      getRevision: (id) => this.store.getArtifactRevision(id),
      readRevisionContent: (id) => this.store.readArtifactRevisionContent(id),
      createRevision: (input) => this.store.createArtifactRevision(input),
      repairRevisionSource: (id) => this.store.repairArtifactRevisionSource(id),
      createDraft: (input) => createArtifactDraft({ store: this.store, ...input }),
      createRollback: (operation, refs, before, after) => this.createRollbackPoint(operation, refs, before, after),
      exportPdf: async (input) => {
        const adapter = this.workspaceOptions.pdfExportAdapter;
        if (!adapter) throw new RuntimeRequestError("provider_not_configured", "pdf_export_adapter_unavailable");
        return { adapterId: adapter.id, bytes: await adapter.export({ title: input.title, content: input.content, source_artifact: input.source }) };
      },
      requestError: (code, message) => new RuntimeRequestError(code, message)
    });
    const searchDomainService = new SearchDomainService(createSearchReadStore(this.store), this.roomAuthorizationService);
    this.domainOperationRegistry = new DomainOperationRegistry(createDomainOperationPorts({
      artifactDomainService: this.artifactDomainService,
      automationDomainService: this.automationDomainService,
      core09AutomationDomainService: this.core09AutomationDomainService,
      browserDomainService: this.browserDomainService,
      clientEventDomainService: this.clientEventDomainService,
      collectionDomainService: this.collectionDomainService,
      conversationDomainService: this.conversationDomainService,
      executionDomainService: this.executionDomainService,
      externalSendDomainService: this.externalSendDomainService,
      externalAppConnectionDomainService: this.externalAppConnectionDomainService,
      fileDomainService: this.fileDomainService,
      gatewayDomainService: this.gatewayDomainService,
      generatedSurfaceDomainService: this.generatedSurfaceDomainService,
      learningDomainService: this.learningDomainService,
      learningResourceUseDomainService: this.learningResourceUseDomainService,
      learningResourceVersionDomainService: this.learningResourceVersionDomainService,
      appliedLearningEvaluationDomainService: this.appliedLearningEvaluationDomainService,
      core05BackgroundReviewMutationDomainService: this.core05BackgroundReviewMutationDomainService,
      memoryDomainService: this.memoryDomainService,
      objectiveDomainService: this.objectiveDomainService,
      pluginDomainService: this.pluginDomainService,
      presentationDomainService: this.presentationDomainService,
      settingsDomainService: this.settingsDomainService,
      skillDomainService: this.skillDomainService,
      systemDomainService: this.systemDomainService,
      translationDomainService: this.translationDomainService,
      wikiDomainService: this.wikiDomainService,
      searchDomainService,
      roomAgentDomainService: this.roomAgentDomainService,
      activityHistoryDomainService: this.activityHistoryDomainService,
      resourceVersionDomainService: this.resourceVersionDomainService,
      workspaceContextDomainService: this.workspaceContextDomainService,
      humanChangeRequestDomainService: this.humanChangeRequestDomainService,
      resourceTransferDomainService: this.resourceTransferDomainService,
      resourceRedactionDomainService: this.resourceRedactionDomainService
    }));
    this.externalAssistProviders = normalizeExternalAssistProviders(externalAssistProvider);
    this.contextPreviewAdapter = new WorkspaceContextPreviewAdapter(this.store, {
      externalAssistProviders: this.externalAssistProviders,
      sessionNotFound: (sessionId) => new RuntimeRequestError("not_found", `Session not found: ${sessionId}`)
    }, this.roomAuthorizationService);
    this.stdioMcpProcessPool = createPooledStdioMcpToolAdapter({
      resolveConfig: async (input) => {
        const config = await this.store.getGatewayMcpConfigByServerName(input.server_name);
        return config ? stdioMcpServerConfigFromGatewayConfig(config) : undefined;
      }
    });
    if (!this.workspaceOptions.deferHost) {
      const hostFactory = this.workspaceOptions.hostFactory ?? createRuntimeAgentHost;
      this.agentHost = hostFactory(this.getHostCompositionDependencies());
    }
  }

  /** Composition root access: it receives typed adapters, never this Runtime instance. */
  getHostCompositionDependencies(): RuntimeHostCompositionDependencies {
    return {
      core: {
        store: this.store,
        backendRegistry: this.backendRegistry,
        emit: this.emit
      },
      preparation: {
        prepareRequest: (request) => this.prepareHostRequest(request),
        assertCurrentRunAccess: (turn) => this.assertCurrentRunAccess(turn),
        assertRunAccess: (run) => run.session_id
          ? this.assertRunAgentExecution(run)
          : this.assertWorkspaceRunAgentExecution(run),
        contextPreviewPortsForTurn: (turn) => this.contextPreviewPortsForTurn(turn),
        prepareResumeInput: async ({ run, resumeInput }) => {
          if (run.session_id) await this.assertRunAgentExecution(run);
          else await this.assertWorkspaceRunAgentExecution(run);
          const gatewayBoundaryPolicy = await this.gatewayBoundaryPolicyForRun(run);
          return {
            backendInput: await this.buildResumeToolRunInput(run, resumeInput, gatewayBoundaryPolicy),
            ...(gatewayBoundaryPolicy ? { gatewayBoundaryPolicy } : {})
          };
        },
        recordActivityResourceUses: (turn, preview) => this.recordActivityResourceUses(turn, preview),
        recordLearningResourceUses: (turn, preview) => this.recordLearningResourceUses(turn, preview),
        linkActivityToRun: ({ activityId, run }) => this.linkActivityToRun(activityId, run),
        linkWorkspaceActivityToRun: ({ context, run }) => this.linkWorkspaceActivityToRun(context, run),
        observeRecoveredRun: (run) => this.captureActivityForStoredRun(run),
        workingDirectory: () => this.backendWorkingDirectory(),
        workingDirectoryMode: () => this.backendWorkingDirectoryMode(),
        backendExecutionRoot: (runId) => this.backendExecutionRoot(runId),
        cleanupBackendExecutionRoot: (runId) => this.cleanupBackendExecutionRoot(runId),
        resolveDefaultBackendId: () => this.defaultBackendIdForRun()
      },
      execution: {
        handleBackendToolStartedEvent: (input) => this.handleBackendToolStartedEvent(input),
        registerToolBridgeToken: async (runId, token) => {
          this.backendToolBridgeService.registerToken(runId, token);
        },
        clearRunState: async (runId) => {
          const current = await this.store.getBackendRun(runId);
          if (!current || isSettledBackendRun(current)) {
            this.backendToolBridgeService.clearToken(runId);
          }
        }
      },
      postTurn: {
        saveGeneratedSurfacePresentations: async (input) => { await this.saveGeneratedSurfacePresentations(input); },
        runExternalAssistSync: (input: HostExternalAssistSyncInput) => this.runExternalAssistSync(input),
        registerLearningCandidate: ({ runId }) => this.registerLearningCandidateForCompletedRun(runId)
      },
      diagnostics: {
        formatError: (error) => safeRuntimeErrorMessage(error),
        logError: (message, metadata) => this.workspaceOptions.productionLogger?.(message, metadata)
      }
    };
  }

  attachAgentHost(host: AgentHost): void {
    if (this.agentHost) throw new Error("agent_host_already_attached");
    this.agentHost = host;
  }

  private requireAgentHost(): AgentHost {
    if (!this.agentHost) throw new Error("agent_host_not_composed");
    return this.agentHost;
  }

  private async prepareHostRequest(request: TurnRequest): Promise<TurnRequest> {
    if (request.gatewayBoundaryPolicy) await this.store.saveGatewayBoundaryPolicy(request.gatewayBoundaryPolicy);
    const [session, settings] = await Promise.all([this.store.getSession(request.sessionId), this.store.getSettings()]);
    if (!session) throw new RuntimeRequestError("not_found", `Session not found: ${request.sessionId}`);
    if (!session.room_id) throw new RuntimeRequestError("conflict", `session_room_missing:${session.id}`);
    const room = await this.store.getRoom(session.room_id);
    if (!room) throw new RuntimeRequestError("conflict", `room_not_found:${session.room_id}`);
    const agentId = request.agentId?.trim() || settings.default_agent_id;
    if (!agentId) throw new RuntimeRequestError("conflict", "default_agent_missing");
    const agent = await this.store.getAgent(agentId);
    if (!agent) throw new RuntimeRequestError("conflict", `agent_not_found:${agentId}`);
    if (!agent.enabled) throw new RuntimeRequestError("conflict", `agent_disabled:${agent.id}`);
    if (!request.requestedByParticipantId) {
      throw new RuntimeRequestError("forbidden", "room_participant_authentication_required");
    }
    try {
      await this.roomAuthorizationService.assertAgentExecution({
        requesterParticipantId: request.requestedByParticipantId,
        roomId: room.id,
        agentId: agent.id
      });
      await this.roomAuthorizationService.assertResource(
        { kind: "human", participantId: request.requestedByParticipantId },
        { roomId: room.id, action: "execute", resourceKind: "session", resourceId: session.id }
      );
    } catch (error) {
      if (error instanceof RoomAuthorizationError) {
        throw new RuntimeRequestError("forbidden", error.message);
      }
      throw error;
    }
    const requestedBackendId = request.backendId?.trim();
    // Workspaces created before Agent routing selected the first runnable
    // Backend when neither a Backend nor an Agent was supplied. Preserve that
    // one compatibility path without mutating the default Agent binding.
    const useLegacyDefaultBackend = !requestedBackendId
      && !request.agentId?.trim()
      && agent.id === settings.default_agent_id
      && settings.default_backend_id === undefined
      && !this.backendRegistry.get(agent.backend_id);
    const temporaryContext = await resolveTemporaryContextPort({
      resolve: (ref) => this.workspaceOptions.resolveTemporaryContextRef?.(ref),
      conflict: (message) => new RuntimeRequestError("conflict", message)
    },
    request.envelope.attachments,
    request.temporaryContext);
    return {
      ...request,
      roomId: room.id,
      agentId: agent.id,
      requestedByParticipantId: request.requestedByParticipantId,
      agent,
      // backend_id is a one-turn compatibility override. It never writes the
      // Agent record; agent.backend_id remains the durable binding.
      backendId: requestedBackendId || (useLegacyDefaultBackend ? this.selectedBackendIdForRun() : agent.backend_id),
      temporaryContext,
      metadata: {
        ...jsonRecord(request.metadata ?? {}),
        room_id: room.id,
        requested_by_participant_id: request.requestedByParticipantId,
        agent_id: agent.id,
        agent_name: agent.name,
        agent_role: agent.role,
        agent_instructions: agent.instructions,
        agent_backend_id: agent.backend_id,
        backend_selection: requestedBackendId
          ? "compatibility_input"
          : useLegacyDefaultBackend
            ? "legacy_default_backend"
            : "agent_binding"
      }
    };
  }

  private async assertCurrentRunAccess(turn: AdmittedTurn): Promise<void> {
    await this.assertRunAgentExecution(turn.run, turn.request.agentId, turn.request.requestedByParticipantId);
  }

  private contextPreviewPortsForTurn(turn: AdmittedTurn) {
    const roomId = turn.session.room_id;
    const agentId = turn.run.agent_id ?? turn.request.agentId;
    const requestedByParticipantId = turn.run.requested_by_participant_id
      ?? turn.request.requestedByParticipantId
      ?? this.legacyRunRequesterIds.get(turn.run.id);
    if (!roomId || !agentId) throw new RuntimeRequestError("conflict", `run_room_agent_missing:${turn.run.id}`);
    if (!requestedByParticipantId) throw new RuntimeRequestError("forbidden", `run_requester_missing:${turn.run.id}`);
    return this.contextPreviewAdapter.portsForAccess({
      roomId,
      principal: {
        kind: "agent",
        agentId,
        requestedByParticipantId
      }
    });
  }

  private async assertRunAgentExecution(run: BackendRunRecord, requestedAgentId?: string, requestedByParticipantId?: string): Promise<void> {
    requireSessionBoundRun(run);
    const session = await this.store.getSession(run.session_id);
    const roomId = session?.room_id;
    const agentId = run.agent_id ?? requestedAgentId;
    const requesterParticipantId = await this.requesterParticipantIdForRun(run, requestedByParticipantId);
    if (!roomId || !agentId) throw new RuntimeRequestError("conflict", `run_room_agent_missing:${run.id}`);
    try {
      await this.roomAuthorizationService.assertAgentExecution({ requesterParticipantId, roomId, agentId });
      await this.roomAuthorizationService.assertResource({
        kind: "agent",
        agentId,
        requestedByParticipantId: requesterParticipantId
      }, { roomId, action: "execute", resourceKind: "session", resourceId: session.id });
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
  }

  /** Re-checks a Room-scoped Run without consulting the app-owned Session. */
  private async assertWorkspaceRunAgentExecution(run: BackendRunRecord): Promise<void> {
    if (!run.room_id || !run.principal) throw new RuntimeRequestError("conflict", `run_room_principal_missing:${run.id}`);
    const principal = principalFromTrustedWorkspace(run.principal);
    if (principal.kind === "system") throw new RuntimeRequestError("forbidden", "system_principal_not_authorized");
    try {
      await this.roomAuthorizationService.assertRoom(principal, run.room_id, "execute");
      const delegated = delegatedParticipant(principal);
      const requesterParticipantId = delegated.kind === "agent" ? delegated.requestedByParticipantId : delegated.participantId;
      const agentId = run.agent_id ?? (delegated.kind === "agent" ? delegated.agentId : undefined);
      if (agentId) {
        await this.roomAuthorizationService.assertAgentExecution({
          requesterParticipantId,
          roomId: run.room_id,
          agentId
        });
      }
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
  }

  /** Re-resolves a Run's current Room principal before post-run reads. */
  private async roomReadAccessForRun(run: BackendRunRecord): Promise<{ principal: ParticipantPrincipal; roomId: string }> {
    requireSessionBoundRun(run);
    const session = await this.store.getSession(run.session_id);
    const roomId = session?.room_id;
    const agentId = run.agent_id;
    if (!roomId || !agentId) throw new RuntimeRequestError("conflict", `run_room_agent_missing:${run.id}`);
    const requestedByParticipantId = await this.requesterParticipantIdForRun(run);
    await this.assertRunAgentExecution(run, agentId, requestedByParticipantId);
    return {
      principal: { kind: "agent", agentId, requestedByParticipantId },
      roomId
    };
  }

  private async requesterParticipantIdForRun(run: BackendRunRecord, suppliedRequesterId?: string): Promise<string> {
    const requester = run.requested_by_participant_id
      ?? suppliedRequesterId
      ?? this.legacyRunRequesterIds.get(run.id);
    if (requester) return requester;
    const legacyRequester = await this.legacyRequesterParticipantIdForRun(run);
    this.legacyRunRequesterIds.set(run.id, legacyRequester);
    return legacyRequester;
  }

  private async recordLearningResourceUses(turn: AdmittedTurn, preview: ContextPreview): Promise<void> {
    const activityContext = turn.session.room_id && turn.run.agent_id
      ? { room_id: turn.session.room_id, session_id: turn.session.id, agent_id: turn.run.agent_id }
      : undefined;
    for (const skill of preview.selected_skills) {
      const resource = await this.store.getSkill(skill.id);
      const contentHash = resource?.frontmatter.content_hash ?? stableHash({ id: skill.id, title: skill.title, description: skill.description });
      await this.store.recordLearningResourceUse({
        id: learningResourceUseRecordId({ runId: turn.run.id, resourceKind: "skill", resourceId: skill.id, stage: "selected", contentHash }), run_id: turn.run.id, session_id: turn.session.id, resource_kind: "skill", resource_id: skill.id,
        ...(resource?.frontmatter.version ? { resource_version: resource.frontmatter.version } : {}),
        content_hash: contentHash, ...(resource?.frontmatter.usage_scope ? { usage_scope: resource.frontmatter.usage_scope } : {}), stage: "selected",
        ...(activityContext ? { activity_context: activityContext } : {}), metadata: { disclosure_level: skill.disclosure_level }, created_at: nowIso()
      });
    }
    for (const memory of preview.active_memory) {
      const resource = await this.store.getMemory(memory.id);
      const contentHash = resource?.content_hash ?? stableHash(memory.content);
      await this.store.recordLearningResourceUse({
        id: learningResourceUseRecordId({ runId: turn.run.id, resourceKind: "memory", resourceId: memory.id, stage: "selected", contentHash }), run_id: turn.run.id, session_id: turn.session.id, resource_kind: "memory", resource_id: memory.id,
        ...(resource?.version ? { resource_version: resource.version } : {}), content_hash: contentHash,
        ...(resource?.usage_scope ? { usage_scope: resource.usage_scope } : {}), stage: "selected", ...(activityContext ? { activity_context: activityContext } : {}), metadata: { state: memory.state, selection_reason: memory.selection_reason }, created_at: nowIso()
      });
      await this.store.recordLearningResourceUse({
        id: learningResourceUseRecordId({ runId: turn.run.id, resourceKind: "memory", resourceId: memory.id, stage: "body_loaded", contentHash }), run_id: turn.run.id, session_id: turn.session.id, resource_kind: "memory", resource_id: memory.id,
        ...(resource?.version ? { resource_version: resource.version } : {}), content_hash: contentHash,
        ...(resource?.usage_scope ? { usage_scope: resource.usage_scope } : {}), stage: "body_loaded", ...(activityContext ? { activity_context: activityContext } : {}), metadata: { state: memory.state, selection_reason: memory.selection_reason }, created_at: nowIso()
      });
    }
    for (const wiki of preview.knowledge_wiki) {
      const resource = await this.store.getWiki(wiki.id);
      const contentHash = resource?.content_hash ?? stableHash(wiki.content);
      await this.store.recordLearningResourceUse({
        id: learningResourceUseRecordId({ runId: turn.run.id, resourceKind: "wiki", resourceId: wiki.id, stage: "selected", contentHash }), run_id: turn.run.id, session_id: turn.session.id, resource_kind: "wiki", resource_id: wiki.id,
        ...(resource?.version ? { resource_version: resource.version } : {}), content_hash: contentHash,
        ...(resource?.usage_scope ? { usage_scope: resource.usage_scope } : {}), stage: "selected", ...(activityContext ? { activity_context: activityContext } : {}), metadata: { slug: wiki.slug }, created_at: nowIso()
      });
      await this.store.recordLearningResourceUse({
        id: learningResourceUseRecordId({ runId: turn.run.id, resourceKind: "wiki", resourceId: wiki.id, stage: "body_loaded", contentHash }), run_id: turn.run.id, session_id: turn.session.id, resource_kind: "wiki", resource_id: wiki.id,
        ...(resource?.version ? { resource_version: resource.version } : {}), content_hash: contentHash,
        ...(resource?.usage_scope ? { usage_scope: resource.usage_scope } : {}), stage: "body_loaded", ...(activityContext ? { activity_context: activityContext } : {}), metadata: { slug: wiki.slug }, created_at: nowIso()
      });
    }
    for (const result of preview.session_search) {
      const resourceId = `${result.kind}:${result.id}`;
      const contentHash = stableHash(result.summary);
      await this.store.recordLearningResourceUse({
        id: learningResourceUseRecordId({ runId: turn.run.id, resourceKind: "session_result", resourceId, stage: "selected", contentHash }), run_id: turn.run.id, session_id: turn.session.id, resource_kind: "session_result", resource_id: resourceId,
        content_hash: contentHash, stage: "selected", ...(activityContext ? { activity_context: activityContext } : {}), metadata: { kind: result.kind, title: result.title }, created_at: nowIso()
      });
    }
  }

  /** Core07 records actual context use independently from legacy Learning Evidence. */
  private async recordActivityResourceUses(turn: AdmittedTurn, preview: ContextPreview): Promise<void> {
    const activityId = turn.request.activityId;
    if (!activityId) return;
    const activity = await this.store.getActivity(activityId);
    if (!activity || activity.status !== "recording") return;
    const context = activityTrustedContext(activity);
    const usageScope = { kind: "room" as const, room_id: activity.room_id };
    const record = async (input: {
      resourceRef: ResourceRef;
      stage: "referenced" | "read";
      resourceVersion?: string;
      contentHash?: string;
    }) => this.activityIngest.recordResourceUsage({
      context,
      activityId,
      id: activityResourceUsageId({ activityId, stage: input.stage, resourceRef: input.resourceRef, contentHash: input.contentHash }),
      resourceRef: input.resourceRef,
      stage: input.stage,
      usageScope,
      ...(input.resourceVersion ? { resourceVersion: input.resourceVersion } : {}),
      ...(input.contentHash ? { contentHash: input.contentHash } : {})
    });
    for (const skill of preview.selected_skills) {
      const resource = await this.store.getSkill(skill.id);
      const contentHash = resource?.frontmatter.content_hash;
      await record({
        resourceRef: resource ? { ...skillRef(resource), ...(resource.frontmatter.version ? { version: resource.frontmatter.version } : {}) } : { kind: "skill", id: skill.id, uri: `skill/${skill.id}`, label: skill.title },
        stage: "referenced",
        ...(resource?.frontmatter.version ? { resourceVersion: resource.frontmatter.version } : {}),
        ...(contentHash ? { contentHash } : {})
      });
    }
    for (const memory of preview.active_memory) {
      const resource = await this.store.getMemory(memory.id);
      const contentHash = resource?.content_hash ?? core07Hash(memory.content);
      await record({
        resourceRef: resource ? { ...memoryRef(resource), ...(resource.version ? { version: resource.version } : {}) } : { kind: "memory", id: memory.id, uri: `memory/${memory.id}`, label: memory.topic },
        stage: "read",
        ...(resource?.version ? { resourceVersion: resource.version } : {}),
        contentHash
      });
    }
    for (const wiki of preview.knowledge_wiki) {
      const resource = await this.store.getWiki(wiki.id);
      const contentHash = resource?.content_hash ?? core07Hash(wiki.content);
      await record({
        resourceRef: resource ? { ...wikiRef(resource), ...(resource.version ? { version: resource.version } : {}) } : { kind: "wiki", id: wiki.id, uri: `wiki/${wiki.id}`, label: wiki.title },
        stage: "read",
        ...(resource?.version ? { resourceVersion: resource.version } : {}),
        contentHash
      });
    }
    for (const result of preview.session_search) {
      const resourceRef = { kind: `session_search:${result.kind}`, id: result.id, uri: `session-search/${result.kind}/${result.id}`, label: result.title };
      await record({ resourceRef, stage: "referenced", contentHash: core07Hash(result.summary) });
    }
  }

  /** Links one Activity to its Run, then records only durable outcomes and real changes. */
  private async captureActivityForRun(activityId: string, run: BackendRunRecord): Promise<void> {
    const activity = await this.store.getActivity(activityId);
    if (!activity) throw new Error("activity_not_found");
    if (activity.status !== "recording") return;
    const context = activityTrustedContext(activity);
    await this.activityIngest.linkBackendRun({ context, activityId, backendRunId: run.id });
    if (!isSettledBackendRun(run)) return;

    const [toolRuns, workspaceChanges, existingUsage] = await Promise.all([
      this.store.listToolRuns({ runId: run.id }),
      this.store.listWorkspaceChanges().then((items) => items.filter((item) => item.run_id === run.id)),
      this.store.listResourceUsage({ activityId })
    ]);
    const usageScope = { kind: "room" as const, room_id: activity.room_id };
    for (const toolRun of toolRuns) {
      for (const resourceRef of toolRun.resource_refs) {
        await this.activityIngest.recordResourceUsage({
          context,
          activityId,
          id: activityResourceUsageId({ activityId, stage: "referenced", resourceRef, sourceId: toolRun.id }),
          resourceRef,
          stage: "referenced",
          usageScope
        });
      }
    }
    for (const change of workspaceChanges) {
      // Core08 may have recorded the mutation while the Backend Run was still
      // active. Replaying the Run must retain that one evidence record rather
      // than append a second identical `modified` usage.
      if (existingUsage.some((usage) => usage.workspace_change_id === change.id && usage.stage === "modified")) {
        continue;
      }
      await this.activityIngest.recordResourceUsage({
        context,
        activityId,
        id: activityResourceUsageId({ activityId, stage: "modified", resourceRef: change.resource_ref, sourceId: change.id }),
        resourceRef: change.resource_ref,
        stage: "modified",
        usageScope,
        ...((change.domain_operation_id ?? change.legacy_operation_id) ? { domainOperationId: change.domain_operation_id ?? change.legacy_operation_id } : {}),
        workspaceChangeId: change.id
      });
    }
    const domainOperationIds = workspaceChanges
      .map((change) => change.domain_operation_id ?? change.legacy_operation_id)
      .filter((id): id is string => Boolean(id));
    const terminal = activityTerminalOutcome(run);
    await this.activityIngest.finalizeActivity({
      context,
      activityId,
      status: terminal.status,
      ...(terminal.resultSummary ? { resultSummary: terminal.resultSummary } : {}),
      ...(terminal.failure ? { failure: terminal.failure } : {}),
      backendRunId: run.id,
      domainOperationIds
    });
  }

  private async linkActivityToRun(activityId: string, run: BackendRunRecord): Promise<void> {
    const activity = await this.store.getActivity(activityId);
    if (!activity) throw new Error("activity_not_found");
    await this.activityIngest.linkBackendRun({ context: activityTrustedContext(activity), activityId, backendRunId: run.id });
  }

  private async linkWorkspaceActivityToRun(context: TrustedWorkspaceContext, run: BackendRunRecord): Promise<void> {
    const activity = await this.store.getActivityByIdempotency({
      workspaceId: context.workspace_id,
      idempotencyKey: `workspace:${context.correlation_id}`
    });
    if (!activity) throw new Error("activity_not_found");
    await this.activityIngest.linkBackendRun({ context: activityTrustedContext(activity), activityId: activity.id, backendRunId: run.id });
  }

  /** A Host exception is never projected as a successful Activity. */
  private async finalizeActivityAfterHostError(activityId: string, error: unknown): Promise<void> {
    const activity = await this.store.getActivity(activityId);
    if (!activity || activity.status !== "recording") return;
    await this.activityIngest.finalizeActivity({
      context: activityTrustedContext(activity),
      activityId,
      status: "outcome_unknown",
      failure: {
        code: "activity_host_execution_interrupted",
        summary: summarize(safeRuntimeErrorMessage(error), 2_000) || "Host execution did not settle an Activity outcome."
      }
    });
  }

  private async captureActivityForStoredRun(run: BackendRunRecord): Promise<void> {
    let activity = await this.store.getActivityByBackendRunId(run.id);
    // A crash can happen after the Run is admitted but before its Activity
    // link commits. The idempotency key is the only safe fallback; it does not
    // invent a Session or search across Rooms.
    if (!activity && run.request_idempotency_key) {
      const idempotencyKey = run.session_id
        ? `chat:${run.session_id}:${run.request_idempotency_key}`
        : `workspace:${run.request_idempotency_key}`;
      activity = await this.store.getActivityByIdempotency({ workspaceId: "workspace", idempotencyKey });
    }
    if (activity) await this.captureActivityForRun(activity.id, run);
  }

  /** Completion is cheap: it stores typed evidence signals only and never calls a review model. */
  private async registerLearningCandidateForCompletedRun(runId: string): Promise<void> {
    const settings = await this.store.getSettings();
    if (!settings.learning_enabled) return;
    const evidence = await this.learningEvidenceAssembler.assemble(runId);
    if (!evidence) return;
    const signals = deriveLearningCandidateSignals(evidence);
    if (evidence.used_learning_resources.some((resource) => resource.stage === "applied")) {
      await this.appliedLearningEvaluationDomainService.run({ sourceRunId: runId });
    } else if (signals.some((signal) => signal.kind === "user_correction" || signal.kind === "user_negation")) {
      await this.appliedLearningEvaluationDomainService.run({ sessionId: evidence.session.id });
    }
    if (signals.length === 0) return;
    await this.store.createLearningReviewCandidate({
      id: createId("reflection"),
      kind: "background_review",
      source_run_id: evidence.backend_run.id,
      session_id: evidence.session.id,
      activity_context: evidence.activity_context,
      status: "queued",
      candidate_key: learningCandidateKey(evidence.backend_run.id),
      candidate_signals: signals,
      input_summary: `Queued ${signals.length} Learning candidate signal(s) for Room ${evidence.activity_context.room_id}.`,
      started_at: nowIso()
    });
  }

  shutdownMcpProcessPool(): Promise<void> {
    if (this.backgroundShutdownPromise) {
      return this.backgroundShutdownPromise;
    }
    this.backgroundTasksClosing = true;
    this.backgroundShutdownPromise = (async () => {
      const timeoutMs = parseTimeout(process.env.SAMURAI_BACKGROUND_SHUTDOWN_TIMEOUT_MS) ?? 30_000;
      const deadline = Date.now() + timeoutMs;
      const cancellationEntries = [...this.backgroundReviewBackends.entries()];
      const settledRunIds = new Set<string>();
      const cancellationTasks = cancellationEntries.map(([runId, backend]) => Promise.resolve()
        .then(() => backend.cancelRun?.(runId))
        .catch((error) => {
          const failure = new Error(`background_cancel_failed:${runId}`);
          Object.assign(failure, { cause: error, runId });
          this.backgroundTaskFailures.push({ error: failure, runId });
        })
        .finally(() => settledRunIds.add(runId)));
      const cancellationSettled = await settleWithin(cancellationTasks, Math.max(0, deadline - Date.now()));
      if (!cancellationSettled) {
        const pendingRunIds = cancellationEntries.map(([runId]) => runId).filter((runId) => !settledRunIds.has(runId));
        const timeoutError = new Error(`background_cancel_timeout:${timeoutMs}ms`);
        Object.assign(timeoutError, { run_ids: pendingRunIds });
        this.backgroundTaskFailures.push({ error: timeoutError });
      }
      const cleanupErrors: unknown[] = [];
      if (this.backgroundTaskFailures.length > 0) {
        const failure = new Error(`background_tasks_failed:${this.backgroundTaskFailures.length}`);
        Object.assign(failure, { failures: [...this.backgroundTaskFailures] });
        cleanupErrors.push(failure);
      }
      let closeError: unknown;
      try {
        await this.stdioMcpProcessPool.closeAll();
      } catch (error) {
        closeError = error;
      }
      if (closeError) cleanupErrors.push(closeError);
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "background_tasks_shutdown_failed");
    })();
    return this.backgroundShutdownPromise;
  }

  async startup(): Promise<void> {
    await this.requireAgentHost().recover();
  }

  async shutdown(): Promise<void> {
    await this.requireAgentHost().shutdown();
    await this.shutdownMcpProcessPool();
  }

  getDomainOperationBindingIdentity(id: string) {
    return this.domainOperationRegistry.bindingIdentity(id);
  }

  getMcpProcessPoolStats(): ReturnType<PooledMcpToolAdapter["stats"]> {
    return this.stdioMcpProcessPool.stats();
  }

  async listAgentBackends(sessionId?: string): Promise<AgentBackendStatus[]> {
    const [statuses, runs] = await Promise.all([
      Promise.resolve(this.backendRegistry.statuses()),
      sessionId ? this.store.listBackendRuns(sessionId) : this.store.listBackendRuns()
    ]);
    return statuses.map((status) => backendStatusWithRunHistory(status, runs));
  }

  /** External-send records are owned by the Room of their persisted Operation. */
  private async getExternalSendForActiveRoom(id: string): Promise<ExternalSendRecord | undefined> {
    const context = await this.assertActiveDomainRoomAction("execute");
    const operationIds = (await this.store.listOperationsForRoom(context.roomId!)).map((operation) => operation.id);
    return this.store.getExternalSend(id, { operationIds });
  }

  /** Rechecks the live principal immediately before an external side effect. */
  private async assertActiveDomainRoomAction(action: "read" | "edit" | "execute"): Promise<TrustedDomainContext> {
    const context = this.activeDomainContext.getStore();
    if (!context?.participant || !context.roomId) {
      throw new RuntimeRequestError("forbidden", "room_participant_required");
    }
    try {
      await this.roomAuthorizationService.assertRoom(context.participant, context.roomId, action);
      if (context.sessionId) {
        await this.roomAuthorizationService.assertResource(context.participant, {
          roomId: context.roomId,
          action,
          resourceKind: "session",
          resourceId: context.sessionId
        });
      }
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
    return context;
  }

  private backendWorkingDirectoryMode(): "workspace" | "repo" {
    return this.workspaceOptions.backendWorkingDirectoryMode ?? "workspace";
  }

  private defaultBackendIdForRun(): string {
    if (hasExplicitDefaultBackend()) {
      return defaultBackendId();
    }
    return defaultBackendIdFromStatuses(this.backendRegistry.statuses());
  }

  private selectedBackendIdForRun(preferred?: string): string {
    if (preferred) {
      const status = this.backendRegistry.statuses().find((item) => item.id === preferred);
      if (status && isRunnableBackendStatus(status)) return preferred;
    }
    return this.defaultBackendIdForRun();
  }

  private backendWorkingDirectory(): string {
    return this.backendWorkingDirectoryMode() === "repo"
      ? path.resolve(this.workspaceOptions.repoRoot ?? process.cwd())
      : this.store.rootDir;
  }

  private backendExecutionRootPath(runId: string): string {
    const root = path.resolve(this.store.rootDir);
    const backendRoot = path.join(
      tmpdir(),
      "samurai-agent-backend-workspaces",
      createHash("sha256").update(`${root}\0${runId}`).digest("hex").slice(0, 32)
    );
    const resolvedBackendRoot = path.resolve(backendRoot);
    if (resolvedBackendRoot === root
      || resolvedBackendRoot.startsWith(`${root}${path.sep}`)
      || root.startsWith(`${resolvedBackendRoot}${path.sep}`)) {
      throw new RuntimeRequestError("conflict", "backend_execution_root_not_separated");
    }
    return resolvedBackendRoot;
  }

  private async backendExecutionRoot(runId: string): Promise<string> {
    const backendRoot = this.backendExecutionRootPath(runId);
    await mkdir(backendRoot, { recursive: true, mode: 0o700 });
    return backendRoot;
  }

  private async cleanupBackendExecutionRoot(runId: string): Promise<void> {
    await rm(this.backendExecutionRootPath(runId), { recursive: true, force: true });
  }

  async previewContext(input: { sessionId: string; query?: string }): Promise<ContextPreview> {
    const access = await this.localOwnerContextAccess(input.sessionId);
    return buildContextPreviewWithPorts({
      sessionId: input.sessionId,
      query: input.query ?? "",
      ports: this.contextPreviewAdapter.portsForAccess(access)
    });
  }

  async freezeContext(input: { sessionId: string; query?: string }): Promise<ContextFreezeResponse> {
    const preview = await this.previewContext(input);
    const freezeSnapshot = preview.freeze_snapshot;
    if (!freezeSnapshot) {
      throw new RuntimeRequestError("conflict", "freeze_snapshot_missing");
    }
    return ContextFreezeResponseSchema.parse({
      session_id: preview.session_id,
      query: preview.query,
      freeze_snapshot: freezeSnapshot,
      context_assembly: preview.context_assembly,
      session_summary: preview.session_summary,
      source_refs: [
        freezeSnapshot.soul.file_ref,
        ...(freezeSnapshot.profile ? [freezeSnapshot.profile.file_ref] : []),
        ...freezeSnapshot.memory_refs,
        ...freezeSnapshot.wiki_refs,
        ...freezeSnapshot.skill_refs
      ],
      stable_hash: freezeSnapshot.stable_hash,
      created_at: freezeSnapshot.created_at
    });
  }

  async previewActiveMemory(input: { query?: string; sessionId?: string }): Promise<{
    active_memory: ContextPreview["active_memory"];
    report: ContextPreview["active_memory_report"];
  }> {
    const access = await this.localOwnerContextAccess(input.sessionId);
    const settings = await this.store.getSettings();
    const result = await this.contextPreviewAdapter.portsForAccess(access).memory.retrieve(input.query ?? "", {
      room_id: access.roomId,
      session_id: input.sessionId ?? (await this.store.listSessions({ roomIds: [access.roomId] }))[0]?.id ?? "preview",
      agent_id: settings.default_agent_id ?? "preview"
    });
    const output = {
      active_memory: result.candidates.map(activeMemoryPreviewEntry),
      report: result.report
    };
    return output;
  }

  async previewKnowledgeWiki(input: { query?: string; sessionId?: string }): Promise<{
    knowledge_wiki: ContextPreview["knowledge_wiki"];
    report: ContextPreview["knowledge_wiki_report"];
    graph: KnowledgeWikiGraph;
  }> {
    const access = await this.localOwnerContextAccess(input.sessionId);
    const settings = await this.store.getSettings();
    const context = await this.contextPreviewAdapter.portsForAccess(access).wiki.build(input.query ?? "", {
      room_id: access.roomId,
      session_id: input.sessionId ?? (await this.store.listSessions({ roomIds: [access.roomId] }))[0]?.id ?? "preview",
      agent_id: settings.default_agent_id ?? "preview"
    });
    return {
      knowledge_wiki: context.entries,
      report: context.report,
      graph: knowledgeWikiGraph(context.pages, true)
    };
  }

  async previewKnowledgeWikiGraph(input: { activeOnly?: boolean; sessionId?: string } = {}): Promise<KnowledgeWikiGraph> {
    const access = await this.localOwnerContextAccess(input.sessionId);
    const pages = await this.listCurrentRoomResources(access, "wiki", (candidates) =>
      this.store.listWiki({ activeOnly: input.activeOnly ?? true, ...candidates })
    );
    return knowledgeWikiGraph(pages, input.activeOnly ?? true);
  }

  private async localOwnerContextAccess(sessionId?: string): Promise<{ principal: ParticipantPrincipal; roomId: string }> {
    const settings = await this.store.getSettings();
    const session = sessionId ? await this.store.getSession(sessionId) : undefined;
    const roomId = session?.room_id ?? settings.default_room_id;
    if (!roomId) throw new RuntimeRequestError("conflict", "room_context_required");
    try {
      await this.roomAuthorizationService.assertRoom({ kind: "human", participantId: localOwnerParticipantId }, roomId, "read");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
    return { principal: { kind: "human", participantId: localOwnerParticipantId }, roomId };
  }

  private async filterCurrentRoomResources<T extends { id: string }>(
    access: { principal: ParticipantPrincipal; roomId: string },
    resourceKind: string,
    values: T[]
  ): Promise<T[]> {
    const results = await Promise.all(values.map(async (value): Promise<T | undefined> => {
      try {
        await this.roomAuthorizationService.assertResource(access.principal, { roomId: access.roomId, action: "read", resourceKind, resourceId: value.id });
        return value;
      } catch (error) {
        if (error instanceof RoomAuthorizationError) return undefined;
        throw error;
      }
    }));
    const allowed: T[] = [];
    for (const value of results) if (value !== undefined) allowed.push(value);
    return allowed;
  }

  private async listCurrentRoomResources<T extends { id: string }>(
    access: { principal: ParticipantPrincipal; roomId: string },
    resourceKind: string,
    load: (candidates: { resourceIds: string[]; includeLegacy: boolean }) => Promise<T[]>
  ): Promise<T[]> {
    const candidates = await this.roomAuthorizationService.resourceCandidateAccess(access.principal, access.roomId, resourceKind);
    return this.filterCurrentRoomResources(access, resourceKind, await load(candidates));
  }

  async inspectKnowledgeWikiQuality(input: { sessionId?: string } = {}): Promise<KnowledgeWikiLintReport> {
    const access = await this.localOwnerContextAccess(input.sessionId);
    const pages = await this.listCurrentRoomResources(access, "wiki", (candidates) =>
      this.store.listWiki({ activeOnly: true, ...candidates })
    );
    const aliases = new Map<string, string>();
    const duplicateIndex = new Map<string, string[]>();
    for (const page of pages) {
      aliases.set(page.slug.toLowerCase(), page.id);
      aliases.set(page.title.trim().toLowerCase(), page.id);
      const key = page.title.trim().toLowerCase();
      duplicateIndex.set(key, [...(duplicateIndex.get(key) ?? []), page.id]);
    }
    const brokenLinks: Array<{ from_wiki_id: string; target: string }> = [];
    const backlinks: Record<string, Array<{ from_wiki_id: string; label: string }>> = {};
    const connected = new Set<string>();
    for (const page of pages) {
      const content = await this.store.readWikiContent(page.id) ?? "";
      for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const label = match[1]?.trim() ?? "";
        const targetId = aliases.get(label.toLowerCase());
        if (!targetId) {
          brokenLinks.push({ from_wiki_id: page.id, target: label });
          continue;
        }
        connected.add(page.id);
        connected.add(targetId);
        backlinks[targetId] = [...(backlinks[targetId] ?? []), { from_wiki_id: page.id, label }];
      }
    }
    return KnowledgeWikiLintReportSchema.parse({
      generated_at: nowIso(),
      active_pages: pages.length,
      broken_links: brokenLinks,
      duplicate_groups: [...duplicateIndex.entries()].filter(([, ids]) => ids.length > 1).map(([key, wiki_ids]) => ({ key, wiki_ids })),
      orphan_wiki_ids: pages.length > 1 ? pages.filter((page) => !connected.has(page.id)).map((page) => page.id) : [],
      backlinks
    });
  }

  async runReflection(input: { sessionId: string; sourceRunId?: string }): Promise<ReflectionRuntimeResult> {
    const result = await this.runDomainCommandWithTrustedContext({
      command_id: runtimeOperationIds.reflectionRun,
      idempotency_key: createId("reflection_request"),
      payload: input.sourceRunId ? { source_run_id: input.sourceRunId } : {}
    }, { sessionId: input.sessionId });
    return result.result as ReflectionRuntimeResult;
  }

  async runCuratorJob(input: { respectIdleGate?: boolean } = {}): Promise<ReflectionRuntimeResult> {
    const result = await this.runDomainCommand({
      command_id: runtimeOperationIds.curatorRun,
      idempotency_key: createId("curator_run_request"),
      payload: input.respectIdleGate === undefined ? {} : { respect_idle_gate: input.respectIdleGate }
    }, await this.localOwnerLearningContext());
    return result.result as ReflectionRuntimeResult;
  }

  async applyCuratorSkillAction(input: { skillId: string; action: Exclude<CuratorLifecycleAction, "review">; sessionId?: string }): Promise<SkillRuntimeResult> {
    const result = await this.runDomainCommand({
      command_id: runtimeOperationIds.skillLifecycleApply,
      idempotency_key: createId("skill_lifecycle_request"),
      payload: { skill_id: input.skillId, action: input.action }
    }, input.sessionId ? { sessionId: input.sessionId } : undefined);
    return result.result as SkillRuntimeResult;
  }

  async runEvaluationJob(): Promise<ReflectionRuntimeResult> {
    const result = await this.runDomainCommand({ command_id: runtimeOperationIds.evaluationRun, input_source: "runtime_api", idempotency_key: createId("evaluation_request"), payload: {} }, await this.localOwnerLearningContext());
    return result.result as ReflectionRuntimeResult;
  }

  /** Manual Learning controls must reuse a real Room Session; they never create one implicitly. */
  private async localOwnerLearningContext(): Promise<TrustedDomainRuntimeContext> {
    const settings = await this.store.getSettings();
    const roomId = settings.default_room_id;
    if (!roomId) throw new RuntimeRequestError("conflict", "learning_room_context_required");
    const participant = { kind: "human" as const, participantId: localOwnerParticipantId };
    try {
      await this.roomAuthorizationService.assertRoom(participant, roomId, "execute");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
    const session = (await this.store.listSessions({ roomIds: [roomId] }))[0];
    if (!session) throw new RuntimeRequestError("unavailable", "learning_session_required");
    try {
      await this.roomAuthorizationService.assertResource(participant, {
        roomId,
        action: "execute",
        resourceKind: "session",
        resourceId: session.id
      });
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
    return { participant, roomId, sessionId: session.id };
  }

  async createSession(input: {
    title?: string;
    ui_locale?: SupportedLocale;
    output_locale?: SupportedLocale;
    room_id?: string;
    /** Internal trusted context only. HTTP payloads cannot set these values. */
    trusted_participant_context?: true;
    trusted_requester_participant_id?: string;
  } = {}): Promise<SessionRecord> {
    const settings = await this.store.getSettings();
    const roomId = input.room_id ?? settings.default_room_id;
    if (!roomId || !(await this.store.getRoom(roomId))) {
      throw new RuntimeRequestError("conflict", `room_not_found:${roomId ?? "default"}`);
    }
    const requesterParticipantId = input.trusted_participant_context
      ? input.trusted_requester_participant_id
      : localOwnerParticipantId;
    if (!requesterParticipantId) {
      throw new RuntimeRequestError("forbidden", "room_participant_authentication_required");
    }
    try {
      await this.roomAuthorizationService.assertRoom({ kind: "human", participantId: requesterParticipantId }, roomId, "execute");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: "web:owner:main",
      room_id: roomId,
      title: input.title ?? "New chat",
      ui_locale: input.ui_locale ?? settings.ui_locale,
      output_locale: input.output_locale ?? settings.output_locale,
      created_at: now,
      updated_at: now
    };

    await this.store.createSession(session);
    await this.store.ensureResourceAccessBoundary({
      resourceKind: "session", resourceId: session.id, sourceRoomId: roomId,
      ownerParticipantId: requesterParticipantId, actorId: requesterParticipantId
    });
    await this.emit("session.created", session);
    return session;
  }

  /**
   * Server HTTP adapters use this for legacy read routes that have not yet
   * become Domain queries. The actor is deliberately fixed to the trusted
   * local Owner ingress; a request body never selects a participant.
   */
  async assertLocalOwnerRoomAccess(input: {
    roomId?: string;
    sessionId?: string;
    resource?: { kind: string; id: string };
    action?: "read" | "edit" | "execute";
  }): Promise<{ roomId: string }> {
    let roomId = input.roomId;
    let session: SessionRecord | undefined;
    if (input.sessionId) {
      session = await this.store.getSession(input.sessionId);
      if (!session) throw new RuntimeRequestError("not_found", `Session not found: ${input.sessionId}`);
      if (!session.room_id) throw new RuntimeRequestError("conflict", `session_room_missing:${session.id}`);
      if (roomId && roomId !== session.room_id) {
        // A Session itself can be explicitly shared for read-only history
        // access. It never changes the Session's own Room and cannot be used
        // as a write or execution context in another Room.
        if (input.action && input.action !== "read" || !input.resource) {
          throw new RuntimeRequestError("conflict", `room_session_mismatch:${roomId}:${session.id}`);
        }
      } else {
        roomId = session.room_id;
      }
    }
    if (!roomId && input.resource) {
      // A persisted source Room is safe to resolve server-side. We never
      // substitute a Workspace-wide default when the resource is unbounded.
      roomId = (await this.store.getResourceAccessBoundary(input.resource.kind, input.resource.id))?.source_room_id;
    }
    if (!roomId) throw new RuntimeRequestError("conflict", "room_access_context_required");
    const principal: ParticipantPrincipal = { kind: "human", participantId: localOwnerParticipantId };
    const action = input.action ?? "read";
    try {
      await this.roomAuthorizationService.assertRoom(principal, roomId, action);
      const resource = input.resource ?? (session ? { kind: "session", id: session.id } : undefined);
      if (resource) {
        await this.roomAuthorizationService.assertResource(principal, {
          roomId,
          action,
          resourceKind: resource.kind,
          resourceId: resource.id
        });
      }
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
    return { roomId };
  }

  /**
   * A Run is the canonical access anchor once it has no App Session. Legacy
   * Runs resolve their Session first; Room-first Runs use the persisted Room
   * and never fall back to a default Session or Room.
   */
  async assertLocalOwnerBackendRunAccess(
    run: Pick<BackendRunRecord, "session_id" | "room_id">,
    action: "read" | "edit" | "execute" = "read"
  ): Promise<{ roomId: string }> {
    if (run.session_id) return this.assertLocalOwnerRoomAccess({ sessionId: run.session_id, action });
    if (!run.room_id) throw new RuntimeRequestError("conflict", "backend_run_room_missing");
    return this.assertLocalOwnerRoomAccess({ roomId: run.room_id, action });
  }

  async listLocalOwnerVisibleRoomIds(): Promise<Set<string>> {
    return this.roomAuthorizationService.visibleRoomIds({ kind: "human", participantId: localOwnerParticipantId });
  }

  /** First-stage candidate boundary for legacy HTTP reads. */
  async localOwnerResourceCandidates(input: { roomId?: string; sessionId?: string }, resourceKind: string): Promise<{
    roomId: string;
    resourceIds: string[];
    includeLegacy: boolean;
  }> {
    const access = await this.assertLocalOwnerRoomAccess(input);
    const candidates = await this.roomAuthorizationService.resourceCandidateAccess(
      { kind: "human", participantId: localOwnerParticipantId },
      access.roomId,
      resourceKind
    );
    return { roomId: access.roomId, ...candidates };
  }

  /** Candidate-first Session listing for the remaining local HTTP read route. */
  async listLocalOwnerRoomSessions(input: { roomId?: string; sessionId?: string }): Promise<SessionRecord[]> {
    const candidates = await this.localOwnerResourceCandidates(input, "session");
    const sessions = candidates.includeLegacy
      ? await this.store.listSessions({ roomIds: [candidates.roomId] })
      : await this.store.listSessions({ ids: candidates.resourceIds });
    const allowed = await Promise.all(sessions.map(async (session) => {
      try {
        await this.assertLocalOwnerRoomAccess({ roomId: candidates.roomId, resource: { kind: "session", id: session.id } });
        return session;
      } catch (error) {
        if (error instanceof RuntimeRequestError && error.code === "forbidden") return undefined;
        throw error;
      }
    }));
    return allowed.filter((session): session is SessionRecord => Boolean(session));
  }

  async runBackendToolBridgeCall(input: {
    runId: string;
    token: string;
    toolName: string;
    toolCallId: string;
    toolInput: Record<string, JsonValue>;
  }): Promise<BackendToolBridgeCallResult> {
    const run = await this.store.getBackendRun(input.runId);
    if (run) {
      if (run.session_id) await this.assertRunAgentExecution(run);
      else await this.assertWorkspaceRunAgentExecution(run);
    }
    return this.backendToolBridgeService.run(input);
  }

  private async runReadOnlyBackendTool(
    toolName: string,
    input: Record<string, JsonValue>,
    trusted: Pick<TrustedDomainRuntimeContext, "runId">
  ): Promise<JsonValue> {
    const query = getDomainQueryForProviderToolName(toolName);
    if (query) {
      if (!trusted.runId) throw new RuntimeRequestError("internal", "provider_query_trusted_run_id_required");
      const queryResult = await this.runDomainQueryWithTrustedContext({
        query_id: query.id,
        input_source: "provider_tool_call",
        payload: normalizeProviderDomainQueryPayload(query.id, input)
      }, trusted);
      return jsonSafe(queryResult.result);
    }
    if (toolName === "samurai.collection.manage") {
      return this.runCollectionManageCompatibility(input, "provider_tool_call", undefined, { runId: trusted.runId });
    }
    throw new RuntimeRequestError("conflict", "tool_bridge_tool_not_allowed");
  }

  private async resolveCollectionPresentationDescriptor(input: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
    const collectionId = typeof input.collection_id === "string" ? input.collection_id.trim() : "";
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const viewId = typeof input.view_id === "string" ? input.view_id.trim() : "";
    const recordId = typeof input.record_id === "string" ? input.record_id.trim() : "";
    const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
    const access = await this.collectionReadAccess();
    const schemas = await this.listCurrentRoomResources(access, "collection_schema", (candidates) => this.store.listCollectionSchemas(candidates));
    const recentPresentation = sessionId ? await this.latestCollectionPresentation(sessionId) : undefined;
    const recentSchema = recentPresentation
      ? schemas.find((schema) => schema.id === recentPresentation.collection_id)
      : undefined;
    let matches = collectionId
      ? schemas.filter((schema) => schema.id === collectionId)
      : matchCollectionSchemas(schemas, query);
    if (matches.length === 0) {
      return {
        status: "not_found",
        query,
        message: "No matching Collection was found.",
        candidates: schemas.slice(0, 8).map((schema) => collectionSchemaSearchResult(schema))
      };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        query,
        message: "Multiple Collections matched. Ask the user which one to open.",
        candidates: matches.slice(0, 8).map((schema) => collectionSchemaSearchResult(schema))
      };
    }
    const schema = matches[0]!;
    const records = await this.listAccessibleCollectionRecords(access, schema.id);
    const recentState = recentPresentation?.collection_id === schema.id ? recentPresentation.view_state : undefined;
    const requestedViewId = viewId
      || (recentPresentation?.collection_id === schema.id ? recentPresentation.view_id : "");
    const viewConfig = genericCollectionViewConfig(schema, requestedViewId || undefined);
    const resolvedViewId = String(viewConfig.id);
    const viewState = reusableCollectionViewState(recentState);
    return {
      status: "ready",
      kind: "collection_app",
      collection_id: schema.id,
      view_id: resolvedViewId,
      renderer: String(viewConfig.renderer),
      ...(recordId ? { record_id: recordId } : {}),
      title: collectionDisplayTitle(schema),
      subtitle: `${schema.id} ・ ${records.length}件`,
      record_count: records.length,
      ...(Object.keys(viewState).length > 0 ? { view_state: viewState } : {})
    };
  }

  private async latestCollectionPresentation(sessionId: string): Promise<MessagePresentationRecord | undefined> {
    const presentations = await this.store.listMessagePresentations({ sessionId });
    return presentations
      .filter((presentation) => presentation.kind === "collection_app")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.created_at.localeCompare(left.created_at))[0];
  }

  private async saveGeneratedSurfacePresentations(input: {
    sessionId: string;
    messageId: string;
    runId: string;
  }): Promise<MessagePresentationRecord[]> {
    const surfaces = (await this.store.listGeneratedSurfaces(input.sessionId))
      .filter((surface) => surface.generation_run_id === input.runId && surface.state !== "archived");
    const now = nowIso();
    const presentations: MessagePresentationRecord[] = [];
    for (const surface of surfaces) {
      const presentation: MessagePresentationRecord = {
        id: createId("presentation"),
        session_id: input.sessionId,
        message_id: input.messageId,
        kind: "generated_surface",
        title: surface.title,
        subtitle: `独自UI ・ revision ${surface.current_revision}`,
        collection_id: "",
        view_id: surface.id,
        renderer: "generated_surface",
        surface_id: surface.id,
        revision_id: surface.current_revision_id,
        preview_url: surface.preview_url,
        view_state: {
          surface_id: surface.id,
          revision_id: surface.current_revision_id,
          preview_url: surface.preview_url,
          renderer: "generated_surface"
        },
        created_at: now,
        updated_at: now
      };
      await this.store.saveMessagePresentation(presentation);
      await this.store.saveSurfaceInteraction(SurfaceInteractionRecordSchema.parse({
        id: createId("surface_interaction"),
        kind: "opened",
        session_id: input.sessionId,
        message_id: input.messageId,
        surface_id: surface.id,
        revision_id: surface.current_revision_id,
        created_at: now
      }));
      presentations.push(presentation);
    }
    return presentations;
  }

  private async saveSkillOptimizationPresentations(input: {
    sessionId: string;
    run: SkillOptimizationRun;
    candidates: OptimizationCandidate[];
  }): Promise<void> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) return;
    const now = nowIso();
    const hasPassedCandidate = input.candidates.some((candidate) => candidate.status === "passed");
    const message: MessageRecord = {
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: hasPassedCandidate
        ? "Skill改善候補ができた。内容を確認して、反映するか選べるよ。"
        : "Skill改善候補を作ったけど、完了条件を満たさなかった。元のSkillは変えていないよ。",
      input_locale: session.ui_locale,
      output_locale: session.output_locale,
      created_at: now
    };
    await this.store.saveMessage(message);
    for (const candidate of input.candidates) {
      await this.store.saveMessagePresentation({
        id: createId("presentation"),
        session_id: session.id,
        message_id: message.id,
        kind: "skill_optimization",
        title: "Skill改善候補",
        subtitle: `${candidate.status === "passed" ? "確認待ち" : "不合格"} ・ holdout ${candidate.holdout_delta >= 0 ? "+" : ""}${candidate.holdout_delta.toFixed(1)}点`,
        collection_id: "",
        view_id: input.run.id,
        renderer: "skill_optimization",
        view_state: {
          optimization_run_id: input.run.id,
          candidate_id: candidate.id,
          skill_id: candidate.skill_id,
          candidate_status: candidate.status,
          baseline_holdout_score: candidate.baseline_holdout_score,
          holdout_score: candidate.holdout_score,
          holdout_delta: candidate.holdout_delta,
          feedback: candidate.feedback
        },
        created_at: now,
        updated_at: now
      });
    }
    await this.emit("message.created", message);
  }

  async runChatTurn(input: RunChatTurnInput): Promise<RunChatTurnResult> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeRequestError("not_found", `Session not found: ${input.sessionId}`);
    const settings = await this.store.getSettings();
    const gatewayContext = input.gateway_context ?? webGatewayContext;
    const requesterParticipantId = input.trusted_participant_context
      ? input.trusted_requester_participant_id
      : requesterParticipantIdForGatewayContext(gatewayContext);
    if (!requesterParticipantId) {
      throw new RuntimeRequestError("forbidden", "room_participant_authentication_required");
    }
    if (session.room_id) {
      // A legacy Session receives its formal boundary when it is first edited,
      // but never before confirming the requester is still a participant of
      // that Room. Otherwise a Workspace Owner who is not in the Room could
      // turn a denied attempt into a boundary visible to Room members.
      try {
        await this.roomAuthorizationService.assertResource(
          { kind: "human", participantId: requesterParticipantId },
          { roomId: session.room_id, action: "execute", resourceKind: "session", resourceId: session.id }
        );
      } catch (error) {
        if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
        throw error;
      }
      await this.store.ensureResourceAccessBoundary({
        resourceKind: "session",
        resourceId: session.id,
        sourceRoomId: session.room_id,
        ownerParticipantId: requesterParticipantId,
        actorId: requesterParticipantId
      });
    }
    const envelope = createGatewayEnvelope(
      gatewayContext,
      input.content,
      input.input_locale ?? session.ui_locale ?? settings.ui_locale,
      input.output_locale ?? session.output_locale ?? settings.output_locale,
      input.metadata,
      input.attachments
    );
    // Compatibility callers may omit a key. This key is unique per call, so
    // it does not promise idempotency across transport retries.
    const idempotencyKey = input.idempotency_key?.trim() || `compat:${createId("idempotency")}`;
    const activity = session.room_id
      ? await this.activityIngest.startActivity({
          context: chatActivityTrustedContext(session, requesterParticipantId, idempotencyKey, input.agent_id),
          idempotencyKey: `chat:${session.id}:${idempotencyKey}`,
          instructionSummary: summarize(input.content, 2_000) || "Chat turn"
        })
      : undefined;
    let outcome: Awaited<ReturnType<AgentHost["runTurn"]>>;
    try {
      outcome = await this.requireAgentHost().runTurn({
        sessionId: input.sessionId,
        content: input.content,
        agentId: input.agent_id,
        envelope,
        backendId: input.backend_id,
        requestedByParticipantId: requesterParticipantId,
        idempotencyKey,
        metadata: jsonRecord(input.metadata ?? {}),
        temporaryContext: input.temporary_context,
        gatewayBoundaryPolicy: input.gateway_boundary_policy,
        ...(activity ? { activityId: activity.id } : {})
      });
    } catch (error) {
      if (activity) await this.finalizeActivityAfterHostError(activity.id, error);
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("backend_not_registered:") || message.startsWith("backend_not_ready:")) {
        throw new RuntimeRequestError("conflict", message);
      }
      throw error;
    }
    // Host returns only after settlement/post-turn completion. Re-read the
    // durable Run before projecting the legacy facade result so diagnostics
    // and recovery corrections are never based on an in-memory snapshot.
    const committedRun = await this.store.getBackendRun(outcome.run.id) ?? outcome.run;
    if (activity) await this.captureActivityForRun(activity.id, committedRun);
    await this.assertRunAgentExecution(committedRun);
    const result = await this.projectChatTurn(committedRun);
    if (outcome.kind === "failed") {
      throw new RuntimeRequestError(
        outcome.run.error_code === "provider_not_configured" ? "provider_not_configured" : "provider_failed",
        safeRuntimeErrorMessage(outcome.error),
        { session: result.session, messages: result.messages, backendRun: result.backendRun, backendEvents: result.backendEvents, workspaceChanges: result.workspaceChanges },
        providerDiagnosticsFromBackendEvents(result.backendEvents)
      );
    }
    if (outcome.kind === "cancelled") {
      throw new RuntimeRequestError("backend_cancelled", outcome.reason, { session: result.session, messages: result.messages, backendRun: result.backendRun, backendEvents: result.backendEvents, workspaceChanges: result.workspaceChanges });
    }
    if (outcome.kind === "outcome_unknown") {
      throw new RuntimeRequestError("outcome_unknown", safeRuntimeErrorMessage(outcome.error), { session: result.session, messages: result.messages, backendRun: result.backendRun, backendEvents: result.backendEvents, workspaceChanges: result.workspaceChanges });
    }
    return result;
  }

  private async projectChatTurn(run: BackendRunRecord): Promise<RunChatTurnResult> {
    requireSessionBoundRun(run);
    const session = await this.store.getSession(run.session_id);
    if (!session) throw new RuntimeRequestError("not_found", `Session not found: ${run.session_id}`);
    if (!session.room_id || !run.agent_id) throw new RuntimeRequestError("conflict", `run_room_agent_missing:${run.id}`);
    const requesterParticipantId = await this.requesterParticipantIdForRun(run);
    const access = {
      principal: {
        kind: "agent" as const,
        agentId: run.agent_id,
        requestedByParticipantId: requesterParticipantId
      },
      roomId: session.room_id
    };
    const memoryCandidates = await this.roomAuthorizationService.resourceCandidateAccess(access.principal, access.roomId, "memory");
    const [messages, backendEvents, workspaceChanges, toolRuns, operations, artifacts, presentations, reflections, sessionMemories, roomMemories] = await Promise.all([
      this.store.listMessages(session.id),
      this.store.listBackendEvents({ runId: run.id }),
      this.store.listWorkspaceChanges(session.id).then((items) => items.filter((item) => item.run_id === run.id)),
      this.store.listToolRuns({ runId: run.id }),
      this.store.listOperations(session.id),
      this.store.listArtifactsForSession(session.id),
      run.output_message_id ? this.store.listMessagePresentations({ sessionId: session.id, messageId: run.output_message_id }) : Promise.resolve([]),
      this.store.listReflectionRuns(session.id),
      this.store.listMemoryForSession(session.id, { includeArchived: true, ...memoryCandidates }),
      this.store.listMemory({ includeArchived: true, ...memoryCandidates })
    ]);
    const storedMemories = [
      ...sessionMemories,
      ...roomMemories.filter((memory) =>
        memory.source === `run:${run.id}`
        || memory.source_run_ids?.includes(run.id)
        || (typeof memory.origin_activity_context === "object"
          && memory.origin_activity_context !== null
          && "run_id" in memory.origin_activity_context
          && memory.origin_activity_context.run_id === run.id)
      )
    ].filter((memory, index, all) => all.findIndex((candidate) => candidate.id === memory.id) === index);
    // `file_path` is a Workspace Store read-model detail. Keep it out of the
    // Chat/Domain result, whose public contract is MemoryFrontmatter only.
    const memories = (await this.filterCurrentRoomResources(access, "memory", storedMemories))
      .map(({ file_path: _filePath, ...memory }) => memory);
    const operationIds = new Set(workspaceChanges.map((change) => change.domain_operation_id ?? change.legacy_operation_id).filter((id): id is string => Boolean(id)));
    const scopedOperations = operations.filter((operation) => operationIds.has(operation.id));
    const artifactIds = new Set(workspaceChanges.filter((change) => change.change_type === "artifact_created").map((change) => change.resource_ref.id));
    const scopedArtifacts = artifacts.filter((artifact) => artifactIds.has(artifact.id) || artifactIds.has(artifact.file_ref.id));
    const reflectionRuns = reflections.filter((reflection) => reflection.source_run_id === run.id);
    const reflectionSuggestions = (await Promise.all(
      reflectionRuns.map((reflection) => this.store.listReflectionSuggestions(reflection.id))
    )).flat();
    const userMessage = messages.find((message) => message.id === run.input_message_id);
    const outputMessage = run.output_message_id ? messages.find((message) => message.id === run.output_message_id) : undefined;
    return {
      session,
      messages: [userMessage, outputMessage].filter((message): message is MessageRecord => Boolean(message)),
      messagePresentations: presentations,
      backendRun: run,
      backendEvents,
      workspaceChanges,
      operations: scopedOperations,
      policyDecisions: [],
      artifacts: scopedArtifacts,
      memories,
      approvalRequests: [],
      auditRecords: [],
      rollbackPoints: [],
      activity: [],
      reflectionRuns,
      reflectionSuggestions,
      toolRuns
    };
  }

  async runWorkspaceExecution(input: WorkspaceExecutionRequest): Promise<WorkspaceExecutionOutcome> {
    const principal = principalFromTrustedWorkspace(input.context.principal);
    if (!input.context.room_id) throw new RuntimeRequestError("forbidden", "room_context_required");
    assertTrustedExternalAppContext(principal, input.context.source, input.context.session_ref);
    if (principal.kind === "system") throw new RuntimeRequestError("forbidden", "system_principal_not_authorized");
    try {
      await this.roomAuthorizationService.assertRoom(principal, input.context.room_id, "execute");
      const delegated = delegatedParticipant(principal);
      if (delegated.kind === "agent" && input.agent_id && input.agent_id !== delegated.agentId) {
        throw new RuntimeRequestError("forbidden", "agent_principal_mismatch");
      }
      const requestedByParticipantId = delegated.kind === "agent" ? delegated.requestedByParticipantId : delegated.participantId;
      const effectiveAgentId = input.agent_id ?? (delegated.kind === "agent" ? delegated.agentId : undefined);
      if (effectiveAgentId) {
        await this.roomAuthorizationService.assertAgentExecution({
          requesterParticipantId: requestedByParticipantId,
          roomId: input.context.room_id,
          agentId: effectiveAgentId
        });
      }
      const activity = await this.activityIngest.startActivity({
        context: input.context,
        idempotencyKey: `workspace:${input.context.correlation_id}`,
        instructionSummary: summarize(input.input_summary ?? "Workspace execution", 2_000)
      });
      try {
        const outcome = await this.requireAgentHost().runWorkspaceExecution({
          ...input,
          ...(effectiveAgentId ? { agent_id: effectiveAgentId } : {})
        });
        const committedRun = await this.store.getBackendRun(outcome.run.id) ?? outcome.run;
        await this.captureActivityForRun(activity.id, committedRun);
        return outcome;
      } catch (error) {
        await this.finalizeActivityAfterHostError(activity.id, error);
        throw error;
      }
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
  }

  async cancelBackendRun(runId: string): Promise<BackendRunRecord> {
    const run = await this.store.getBackendRun(runId);
    if (!run) throw new RuntimeRequestError("not_found", "backend_run_not_found");
    if (run.session_id) await this.assertRunAgentExecution(run);
    else await this.assertWorkspaceRunAgentExecution(run);
    const cancelled = await this.requireAgentHost().cancelRun(runId);
    await this.captureActivityForStoredRun(cancelled);
    const lockKey = typeof cancelled.metadata.gateway_boundary_concurrency_lock_key === "string"
      ? cancelled.metadata.gateway_boundary_concurrency_lock_key.trim()
      : "";
    if (!lockKey) return cancelled;
    const released = await this.store.releaseGatewayConcurrencyLock(lockKey);
    if (!released) return cancelled;
    const updated = {
      ...cancelled,
      metadata: {
        ...cancelled.metadata,
        gateway_concurrency_lock_status: released.status,
        ...(released.released_at ? { gateway_concurrency_lock_released_at: released.released_at } : {})
      }
    };
    return await this.store.updateRunMetadata({ runId: cancelled.id, metadata: updated.metadata });
  }

  async resumeBackendRun(runId: string, input: Record<string, JsonValue> = {}): Promise<BackendRunRecord> {
    try {
      const run = await this.store.getBackendRun(runId);
      if (!run) throw new RuntimeRequestError("not_found", "backend_run_not_found");
      if (run.session_id) await this.assertRunAgentExecution(run);
      else await this.assertWorkspaceRunAgentExecution(run);
      const resumed = await this.requireAgentHost().resumeRun(runId, input);
      await this.captureActivityForStoredRun(resumed);
      return resumed;
    } catch (error) {
      if (String(error).includes("run_not_found")) throw new RuntimeRequestError("not_found", "backend_run_not_found");
      throw error;
    }
  }

  async syncBackendStream(runId: string, input: { maxEvents?: number; timeoutMs?: number } = {}): Promise<BackendStreamSyncResult> {
    const before = await this.store.listBackendEvents({ runId });
    const existingRun = await this.store.getBackendRun(runId);
    if (!existingRun) throw new RuntimeRequestError("not_found", "backend_run_not_found");
    if (existingRun.session_id) await this.assertRunAgentExecution(existingRun);
    else await this.assertWorkspaceRunAgentExecution(existingRun);
    const run = await this.requireAgentHost().syncRun(runId);
    await this.captureActivityForStoredRun(run);
    const syncEventId = `control:sync:${run.id}:${run.current_attempt ?? 1}`;
    const syncEvent = await this.store.appendCore02Event({
      id: syncEventId,
      run_id: run.id,
      ...(run.session_id ? { session_id: run.session_id } : {}),
      event_type: "backend_stream_synced",
      sequence: 1,
      attempt_no: run.current_attempt ?? 1,
      source_event_id: syncEventId,
      payload: {
        reason: "stream_sync_completed",
        run_status: run.status
      },
      resource_refs: [],
      created_at: nowIso()
    });
    if (!syncEvent.duplicate) await this.emit("backend.event.created", syncEvent.event);
    const after = await this.store.listBackendEvents({ runId });
    const persisted = after.filter((event) => !before.some((previous) => previous.id === event.id));
    const unsupported = persisted.some((event) => event.event_type === "backend_stream_unavailable");
    return {
      run,
      status: unsupported ? "unsupported" : "synced",
      events: persisted,
      persisted_event_count: persisted.length,
      skipped_duplicate_count: 0,
      timed_out: false,
      max_events_reached: Boolean(input.maxEvents && persisted.length >= input.maxEvents)
    };
  }

  async runSurfaceOperation(input: SurfaceOperation): Promise<SurfaceOperationRuntimeResult> {
    const query = getDomainQueryForSurfaceOperationKind(input.kind);
    if (query && isCollectionViewPresentSurface(input)) {
      const queryResult = await this.runDomainQueryWithTrustedContext({
        query_id: query.id,
        input_source: "surface_operation",
        payload: {
          collection_id: input.collection_id,
          view_id: input.view_id
        }
      }, surfaceOperationTrustedContext(input));
      const result = queryResult.result as CollectionViewRuntimeResult & { render_spec?: SurfaceRenderSpec };
      const renderSpec = result.render_spec ?? queryResult.render_specs[0];
      if (!renderSpec) {
        throw new RuntimeRequestError("conflict", `domain_query_render_spec_missing:${query.id}`);
      }
      return {
        operation: input,
        result_kind: "collection_view",
        render_spec: renderSpec,
        render_specs: queryResult.render_specs.length > 0 ? queryResult.render_specs : [renderSpec],
        result
      };
    }
    const command = requireDomainCommandEntry(commandIdForSurfaceOperation(input.kind));
    if (!command.allowed_sources.includes("surface_operation")) throw new RuntimeRequestError("conflict", `domain_command_source_not_allowed:${command.id}:surface_operation`);
    return this.executeSurfaceOperation(input);
  }

  private async runSurfaceDomainCommand<TResult>(
    commandId: string,
    surfaceOperation: SurfaceOperation,
    payload: Record<string, unknown>
  ): Promise<TResult> {
    const output = await this.runDomainCommandWithTrustedContext({
      command_id: commandId,
      input_source: "surface_operation",
      idempotency_key: surfaceOperation.id,
      payload
    }, surfaceOperationTrustedContext(surfaceOperation));
    return output.result as TResult;
  }

  /** Keeps post-command rendering inside the same live Room boundary. */
  private async withSurfaceReadContext<T>(input: SurfaceOperation, work: () => Promise<T>): Promise<T> {
    const commandId = commandIdForSurfaceOperation(input.kind);
    const context = await this.trustedDomainContext("surface_operation", {}, surfaceOperationTrustedContext(input), commandId);
    if (!context.participant || !context.roomId) {
      throw new RuntimeRequestError("forbidden", "room_context_required");
    }
    try {
      await this.roomAuthorizationService.assertRoom(context.participant, context.roomId, "read");
      if (context.sessionId) {
        await this.roomAuthorizationService.assertResource(context.participant, {
          roomId: context.roomId,
          action: "read",
          resourceKind: "session",
          resourceId: context.sessionId
        });
      }
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
    return this.activeDomainContext.run(context, work);
  }

  private async executeSurfaceOperation(input: SurfaceOperation, surfaceAccessEstablished = false): Promise<SurfaceOperationRuntimeResult> {
    if (input.kind === "message.submit" && !surfaceAccessEstablished) {
      return this.withSurfaceReadContext(input, () => this.executeSurfaceOperation(input, true));
    }
    if (input.kind === "message.submit") {
      if (!input.session_id) {
        throw new RuntimeRequestError("conflict", "surface_operation_session_required");
      }
      const collectionSchemasBefore = await this.listActiveCollectionSchemas();
      const result = await this.runSurfaceDomainCommand<RunChatTurnResult>(commandIdForSurfaceOperation(input.kind), input, {
        content: input.content,
        backend_id: input.backend_id,
        input_locale: input.input_locale,
        output_locale: input.output_locale,
        attachments: input.attachments,
        metadata: input.metadata ?? {}
      });
      const chatRender = negotiatedRenderSpec(input, chatTurnRenderSpec(result));
      const renderSpecs = [chatRender];
      const collectionRenderSpecs = await this.collectionRenderSpecsFromWorkspaceChanges(input, result, collectionSchemasBefore);
      renderSpecs.push(...collectionRenderSpecs);
      for (const operation of result.operations) {
        const collectionId = isCollectionSchemaSaveOperation(operation) && operation.result_ref?.kind === "collection_schema"
          ? operation.result_ref.id
          : operation.operation === "collection.manage" && operation.result_ref?.kind === "collection"
            ? operation.result_ref.id
            : "";
        if (!collectionId) {
          continue;
        }
        if (renderSpecs.some((spec) => isCollectionRenderSpecForId(spec, collectionId))) {
          continue;
        }
        const schema = await this.getAccessibleCollectionSchema(collectionId);
        if (!schema) {
          continue;
        }
        const view = await this.presentCollectionView({
          collectionId: schema.id,
          viewId: defaultGenericCollectionViewId(schema)
        });
        renderSpecs.push(negotiatedRenderSpec(input, view.render_spec));
      }
      const eventDescriptors = collectionPresentationDescriptorsFromBackendEvents(result.backendEvents);
      for (const descriptor of eventDescriptors) {
        if (descriptor.status !== "ready") {
          continue;
        }
        const descriptorState = collectionDescriptorViewState(descriptor);
        const existingIndex = renderSpecs.findIndex((spec) => isCollectionRenderSpecForId(spec, descriptor.collection_id));
        if (existingIndex >= 0 && renderSpecs[existingIndex]) {
          renderSpecs[existingIndex] = negotiatedRenderSpec(
            input,
            applyCollectionPresentationViewState(renderSpecs[existingIndex], descriptorState)
          );
          continue;
        }
        const view = await this.presentCollectionView({
          collectionId: descriptor.collection_id,
          viewId: descriptor.view_id
        });
        renderSpecs.push(negotiatedRenderSpec(
          input,
          applyCollectionPresentationViewState(view.render_spec, descriptorState)
        ));
      }
      const agentMessageId = result.messages.find((message) => message.role === "agent")?.id;
      const descriptorPresentations = await this.saveMessagePresentationsForBackendEvents({
        sessionId: result.session.id,
        messageId: agentMessageId,
        backendEvents: result.backendEvents
      });
      const renderSpecPresentations = await this.saveMessagePresentationsForRenderSpecs({
        sessionId: result.session.id,
        messageId: agentMessageId,
        renderSpecs: renderSpecs.filter((spec) => !descriptorPresentations.some((presentation) =>
          presentation.collection_id === collectionRenderSpecCollectionId(spec)
          && presentation.view_id === collectionRenderSpecViewId(spec, presentation.collection_id)
        ))
      });
      result.messagePresentations = mergePresentations(descriptorPresentations, renderSpecPresentations);
      return {
        operation: input,
        result_kind: "chat_turn",
        render_spec: chatRender,
        render_specs: renderSpecs,
        result
      };
    }

    if (isCollectionRecordCreateSurface(input)) {
      const result = await this.runSurfaceDomainCommand<CollectionRecordRuntimeResult>(commandIdForSurfaceOperation(input.kind), input, {
        record_id: input.record_id,
        collection_id: input.collection_id,
        data: input.data,
        resource_refs: []
      });
      const resolution = await this.resolveCollectionRecordRefs(result.resource.collection_id, result.resource.id);
      const renderSpec = negotiatedRenderSpec(input, collectionRecordRenderSpec(result.resource, "Collection record", resolution));
      return {
        operation: input,
        result_kind: "collection_record",
        render_spec: renderSpec,
        render_specs: [renderSpec],
        result
      };
    }

    if (isCollectionViewPresentSurface(input)) {
      const result = await this.presentCollectionView({
        collectionId: input.collection_id,
        viewId: input.view_id
      });
      const renderSpec = negotiatedRenderSpec(input, result.render_spec);
      return {
        operation: input,
        result_kind: "collection_view",
        render_spec: renderSpec,
        render_specs: [renderSpec],
        result: {
          collection_id: result.collection_id,
          view_id: result.view_id,
          schema: result.schema,
          record_count: result.record_count
        }
      };
    }

    if (isMessagePresentationUpdateSurface(input)) {
      const domainResult = await this.runSurfaceDomainCommand<{ presentation: MessagePresentationRecord; render_spec: SurfaceRenderSpec; render_specs: SurfaceRenderSpec[] }>(commandIdForSurfaceOperation(input.kind), input, {
        presentation_id: input.presentation_id,
        view_state: input.view_state
      });
      const renderSpec = negotiatedRenderSpec(input, domainResult.render_spec);
      return {
        operation: input,
        result_kind: "message_presentation",
        render_spec: renderSpec,
        render_specs: [renderSpec],
        result: domainResult.presentation
      };
    }

    if (input.kind === "collection.record.patch") {
      if (input.expected_version === undefined) {
        throw new RuntimeRequestError("conflict", "collection_patch_expected_version_required");
      }
      const result = await this.runSurfaceDomainCommand<CollectionPatchRuntimeResult>(commandIdForSurfaceOperation(input.kind), input, {
        collection_id: input.collection_id,
        record_id: input.record_id,
        patch_id: input.patch_id,
        changes: input.changes,
        expected_version: input.expected_version
      });
      const resolution = await this.resolveCollectionRecordRefs(result.resource.collection_id, result.resource.id);
      const renderSpec = negotiatedRenderSpec(input, collectionRecordRenderSpec(result.resource, "Collection patch applied", resolution));
      return {
        operation: input,
        result_kind: "collection_patch",
        render_spec: renderSpec,
        render_specs: [renderSpec],
        result
      };
    }

    if (isCollectionRecordDeleteSurface(input)) {
      const result = await this.runSurfaceDomainCommand<CollectionDeleteRuntimeResult>(commandIdForSurfaceOperation(input.kind), input, {
        collection_id: input.collection_id,
        record_id: input.record_id,
        expected_version: input.expected_version,
        view_id: input.view_id
      });
      const view = await this.presentCollectionView({
        collectionId: input.collection_id,
        viewId: input.view_id
      });
      const renderSpec = negotiatedRenderSpec(input, view.render_spec);
      return {
        operation: input,
        result_kind: "collection_delete",
        render_spec: renderSpec,
        render_specs: [renderSpec],
        result
      };
    }

    if (isCollectionActionRunSurface(input)) {
      const result = await this.runSurfaceDomainCommand<CollectionActionRuntimeResult>(commandIdForSurfaceOperation(input.kind), input, {
        collection_id: input.collection_id,
        action_id: input.action_id,
        backend_id: input.backend_id,
        record_id: input.record_id,
        payload: input.payload
      });
      const view = await this.presentCollectionView({
        collectionId: input.collection_id,
        viewId: input.view_id
      });
      const renderSpec = negotiatedRenderSpec(input, view.render_spec);
      const actionChat = "chat" in result ? result.chat : undefined;
      const actionCustomView = collectionActionGeneratedCustomViewRenderSpec(input, renderSpec, result);
      const actionCustomViewRenderSpec = actionCustomView ? negotiatedRenderSpec(input, actionCustomView) : undefined;
      const chatRenderSpec = actionChat ? negotiatedRenderSpec(input, chatTurnRenderSpec(actionChat)) : undefined;
      return {
        operation: input,
        result_kind: "collection_action",
        render_spec: renderSpec,
        render_specs: [renderSpec, actionCustomViewRenderSpec, chatRenderSpec].filter((spec): spec is SurfaceRenderSpec => Boolean(spec)),
        result
      };
    }

    return this.runStructuredSurfaceOperation(input as StructuredSurfaceOperation);
  }

  private async saveMessagePresentationsForRenderSpecs(input: {
    sessionId: string;
    messageId?: string;
    renderSpecs: SurfaceRenderSpec[];
  }): Promise<MessagePresentationRecord[]> {
    if (!input.messageId) {
      return [];
    }
    return this.presentationDomainService.saveUnique(input.renderSpecs
      .map((spec) => messagePresentationFromRenderSpec(spec, input.sessionId, input.messageId!))
      .filter((record): record is MessagePresentationRecord => Boolean(record)));
  }

  private async saveMessagePresentationsForBackendEvents(input: {
    sessionId: string;
    messageId?: string;
    backendEvents: BackendEventRecord[];
  }): Promise<MessagePresentationRecord[]> {
    if (!input.messageId) {
      return [];
    }
    const presentations: MessagePresentationRecord[] = [];
    for (const event of input.backendEvents) {
      if (event.event_type !== "tool_call_output") {
        continue;
      }
      const descriptor = messagePresentationDescriptorFromToolOutput(event.payload);
      if (!descriptor || descriptor.status !== "ready") {
        continue;
      }
      presentations.push(messagePresentationFromDescriptor(descriptor, input.sessionId, input.messageId));
    }
    return this.presentationDomainService.saveUnique(presentations);
  }

  private async resolveDirectCollectionPresentation(input: MessageSubmitOperation): Promise<CollectionPresentationResolution | undefined> {
    const expectedOutputs = expectedBackendOutputs(input.content);
    if (expectedOutputs.includes("collection_schema")) {
      return undefined;
    }
    if (!expectedOutputs.includes("collection_view") && !shouldUpdateCollectionViewOutput(input.content)) {
      return undefined;
    }
    const descriptor = await this.resolveCollectionPresentationDescriptor({
      query: input.content,
      session_id: input.session_id ?? ""
    });
    const presentation = messagePresentationDescriptorFromToolOutput(descriptor);
    if (presentation?.status === "ready") {
      return presentation;
    }
    if (descriptor.status === "ambiguous") {
      const candidates = Array.isArray(descriptor.candidates)
        ? descriptor.candidates.filter((candidate): candidate is Record<string, JsonValue> => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate))
        : [];
      return {
        status: "ambiguous",
        query: typeof descriptor.query === "string" ? descriptor.query : input.content,
        message: typeof descriptor.message === "string" ? descriptor.message : "Multiple Collections matched.",
        candidates
      };
    }
    return undefined;
  }

  private async runDirectCollectionPresentationAmbiguitySurfaceOperation(
    input: MessageSubmitOperation,
    ambiguity: CollectionPresentationAmbiguity
  ): Promise<SurfaceOperationRuntimeResult> {
    const session = await this.store.getSession(input.session_id ?? "");
    if (!session) {
      throw new Error(`Session not found: ${input.session_id}`);
    }
    const settings = await this.store.getSettings();
    const inputLocale = input.input_locale ?? session.ui_locale ?? settings.ui_locale;
    const outputLocale = input.output_locale ?? session.output_locale ?? settings.output_locale;
    const envelope = createGatewayEnvelope(webGatewayContext, input.content, inputLocale, outputLocale, {
      ...(input.metadata ?? {}),
      surface_operation_id: input.id,
      surface_operation_kind: input.kind,
      collection_present_resolution: "ambiguous",
      collection_present_candidates: ambiguity.candidates as unknown as JsonValue
    });
    const userMessage = await this.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "user",
      content: input.content,
      input_locale: envelope.input_locale,
      output_locale: envelope.output_locale,
      envelope,
      created_at: envelope.received_at
    });
    const agentContent = collectionPresentationAmbiguityMessage(ambiguity.candidates, outputLocale);
    const agentMessage = await this.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: agentContent,
      input_locale: envelope.input_locale,
      output_locale: envelope.output_locale,
      created_at: nowIso()
    });
    let backendRun: BackendRunRecord = {
      id: createId("run"),
      session_id: session.id,
      input_message_id: userMessage.id,
      output_message_id: agentMessage.id,
      backend_id: "samurai_runtime",
      backend_kind: "mock",
      status: "completed",
      started_at: envelope.received_at,
      completed_at: nowIso(),
      input_summary: summarize(input.content),
      output_summary: "Collection presentation needs user choice",
      metadata: {
        context_intent: "workspace_task",
        expected_outputs: ["collection_view"],
        collection_present_resolution: "ambiguous",
        collection_present_query: ambiguity.query,
        collection_present_candidates: ambiguity.candidates as unknown as JsonValue
      }
    };
    backendRun = await this.store.saveBackendRun(backendRun);
    await this.emit("backend.run.created", backendRun);
    await this.emit("backend.run.updated", backendRun);
    const result: RunChatTurnResult = {
      session,
      messages: [userMessage, agentMessage],
      messagePresentations: [],
      backendRun,
      backendEvents: [],
      workspaceChanges: [],
      operations: [],
      policyDecisions: [],
      artifacts: [],
      memories: [],
      approvalRequests: [],
      auditRecords: [],
      rollbackPoints: [],
      activity: [],
      reflectionRuns: [],
      reflectionSuggestions: [],
      toolRuns: []
    };
    const chatRender = negotiatedRenderSpec(input, chatTurnRenderSpec(result));
    return {
      operation: input,
      result_kind: "chat_turn",
      render_spec: chatRender,
      render_specs: [chatRender],
      result
    };
  }

  private async runDirectCollectionPresentationSurfaceOperation(
    input: MessageSubmitOperation,
    descriptor: CollectionPresentationDescriptor
  ): Promise<SurfaceOperationRuntimeResult> {
    const session = await this.store.getSession(input.session_id ?? "");
    if (!session) {
      throw new Error(`Session not found: ${input.session_id}`);
    }
    const settings = await this.store.getSettings();
    const inputLocale = input.input_locale ?? session.ui_locale ?? settings.ui_locale;
    const outputLocale = input.output_locale ?? session.output_locale ?? settings.output_locale;
    const envelope = createGatewayEnvelope(webGatewayContext, input.content, inputLocale, outputLocale, {
      ...(input.metadata ?? {}),
      surface_operation_id: input.id,
      surface_operation_kind: input.kind,
      collection_present_resolution: "workspace_index"
    });
    const userMessage = await this.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "user",
      content: input.content,
      input_locale: envelope.input_locale,
      output_locale: envelope.output_locale,
      envelope,
      created_at: envelope.received_at
    });
    const agentMessage = await this.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: `${descriptor.title ?? descriptor.collection_id}を開きました。`,
      input_locale: envelope.input_locale,
      output_locale: envelope.output_locale,
      created_at: nowIso()
    });
    let backendRun: BackendRunRecord = {
      id: createId("run"),
      session_id: session.id,
      input_message_id: userMessage.id,
      output_message_id: agentMessage.id,
      backend_id: "samurai_runtime",
      backend_kind: "mock",
      status: "completed",
      started_at: envelope.received_at,
      completed_at: nowIso(),
      input_summary: summarize(input.content),
      output_summary: `${descriptor.collection_id} presented`,
      metadata: {
        context_intent: "workspace_task",
        expected_outputs: ["collection_view"],
        collection_present_resolution: "workspace_index",
        collection_id: descriptor.collection_id,
        view_id: descriptor.view_id
      }
    };
    backendRun = await this.store.saveBackendRun(backendRun);
    await this.emit("backend.run.created", backendRun);
    await this.emit("backend.run.updated", backendRun);
    const presentation = await this.store.saveMessagePresentation(messagePresentationFromDescriptor(descriptor, session.id, agentMessage.id));
    const view = await this.presentCollectionView({
      collectionId: descriptor.collection_id,
      viewId: descriptor.view_id
    });
    const viewSpec = applyCollectionPresentationViewState(view.render_spec, collectionDescriptorViewState(descriptor));
    const chatRender = negotiatedRenderSpec(input, chatTurnRenderSpec({
      session,
      messages: [userMessage, agentMessage],
      messagePresentations: [presentation],
      backendRun,
      backendEvents: [],
      workspaceChanges: [],
      operations: [],
      policyDecisions: [],
      artifacts: [],
      memories: [],
      approvalRequests: [],
      auditRecords: [],
      rollbackPoints: [],
      activity: [],
      reflectionRuns: [],
      reflectionSuggestions: [],
      toolRuns: []
    }));
    const appRender = negotiatedRenderSpec(input, viewSpec);
    const output: SurfaceOperationRuntimeResult = {
      operation: input,
      result_kind: "chat_turn",
      render_spec: chatRender,
      render_specs: [chatRender, appRender],
      result: {
        session,
        messages: [userMessage, agentMessage],
        messagePresentations: [presentation],
        backendRun,
        backendEvents: [],
        workspaceChanges: [],
        operations: [],
        policyDecisions: [],
        artifacts: [],
        memories: [],
        approvalRequests: [],
        auditRecords: [],
        rollbackPoints: [],
        activity: [],
        reflectionRuns: [],
        reflectionSuggestions: [],
        toolRuns: []
      }
    };
    return output;
  }

  private async collectionRenderSpecsFromWorkspaceChanges(input: SurfaceOperation, result: RunChatTurnResult, schemasBefore: CollectionSchemaWithFilePath[]): Promise<SurfaceRenderSpec[]> {
    if (input.kind !== "message.submit") {
      return [];
    }
    const beforeById = new Map(schemasBefore.map((schema) => [schema.id, collectionSchemaSignature(schema)]));
    // Domain writes update their own Collection index. A chat response must
    // not trigger a Workspace-wide filesystem reindex merely to discover
    // renderable changes from another Room.
    const schemasAfter = await this.listActiveCollectionSchemas();
    const changedCollectionIds = new Set<string>();
    const runtimeSavedCollectionIds = new Set<string>();
    for (const operation of result.operations) {
      if (isCollectionSchemaSaveOperation(operation)) {
        runtimeSavedCollectionIds.add(operation.result_ref.id);
        changedCollectionIds.add(operation.result_ref.id);
      }
    }
    for (const schema of schemasAfter) {
      if (beforeById.get(schema.id) === collectionSchemaSignature(schema)) {
        continue;
      }
      if (runtimeSavedCollectionIds.has(schema.id)) {
        continue;
      }
      changedCollectionIds.add(schema.id);
    }
    const renderSpecs: SurfaceRenderSpec[] = [];
    for (const collectionId of changedCollectionIds) {
      try {
        const view = await this.presentCollectionView({ collectionId });
        renderSpecs.push(negotiatedRenderSpec(input, view.render_spec));
      } catch {
        // Invalid or unsupported files stay in the workspace, but should not break chat.
      }
    }
    return renderSpecs;
  }

  async runDomainCommand(
    input: DomainCommandRuntimeInput,
    trusted: TrustedDomainRuntimeContext = {}
  ): Promise<DomainCommandRuntimeResult> {
    return this.runDomainCommandWithTrustedContext(input, trusted);
  }

  /** Runtime API adapters use this after they have resolved trusted resources. */
  async runRuntimeApiDomainCommand(
    input: Omit<DomainCommandRuntimeInput, "input_source">,
    trusted: TrustedDomainRuntimeContext = {}
  ): Promise<DomainCommandRuntimeResult> {
    return this.runDomainCommandWithTrustedContext({ ...input, input_source: "runtime_api" }, { ...trusted, requireExplicitRoom: true });
  }

  /** Generated Surface ingress resolves the declared target, dispatches it once, then records interaction. */
  async runGeneratedSurfaceAction(input: {
    surfaceId: string;
    revisionId?: string;
    actionId: string;
    interactionId: string;
    messageId?: string;
    confirmed?: boolean;
    actionPayload?: Record<string, JsonValue>;
  }, trusted: TrustedDomainRuntimeContext = {}): Promise<{ surface: GeneratedSurfaceDefinition; action: GeneratedSurfaceActionDeclaration; command: unknown; interaction: unknown }> {
    const persistedSurface = await this.store.getGeneratedSurface(input.surfaceId);
    if (!persistedSurface) throw new RuntimeRequestError("not_found", "generated_surface_not_found");
    // Session and SessionRef are provenance only. The resource boundary below
    // selects the Room and is rechecked for every resolve, dispatch, and log.
    const { sessionId: _legacySessionId, ...withoutSession } = trusted;
    const resolutionPayload = {
      surface_id: input.surfaceId,
      ...(input.revisionId ? { revision_id: input.revisionId } : {}),
      action_id: input.actionId
    };
    const surfaceSessionRef = withoutSession.sessionRef ?? persistedSurface.session_ref;
    const ingressTrusted: TrustedDomainRuntimeContext = {
      ...withoutSession,
      ...(surfaceSessionRef ? { sessionRef: surfaceSessionRef } : {}),
      correlationId: withoutSession.correlationId ?? stableHash({
        ingress: "generated_surface_action",
        surface_id: input.surfaceId,
        revision_id: input.revisionId ?? null,
        action_id: input.actionId,
        interaction_id: input.interactionId
      })
    };
    const boundaryContext = await this.trustedDomainContext(
      "generated_surface",
      resolutionPayload,
      ingressTrusted,
      runtimeOperationIds.generatedSurfaceActionRun
    );
    if (!boundaryContext.roomId || !boundaryContext.participant) {
      throw new RuntimeRequestError("forbidden", "generated_surface_room_context_required");
    }
    const actionTrusted: TrustedDomainRuntimeContext = {
      ...ingressTrusted,
      participant: boundaryContext.participant,
      roomId: boundaryContext.roomId,
      ...(boundaryContext.source ? { source: boundaryContext.source } : {}),
      ...(boundaryContext.sessionRef ? { sessionRef: boundaryContext.sessionRef } : {})
    };
    const resolvedResult = await this.runDomainCommandWithTrustedContext({
      command_id: runtimeOperationIds.generatedSurfaceActionRun,
      input_source: "generated_surface",
      idempotency_key: `generated_surface_action:${stableHash({
        surface_id: input.surfaceId,
        revision_id: input.revisionId ?? null,
        action_id: input.actionId,
        interaction_id: input.interactionId,
        phase: "resolve"
      })}`,
      payload: resolutionPayload
    }, actionTrusted);
    const resolvedRecord = unknownRecord(resolvedResult.result);
    const surface = resolvedRecord.surface as GeneratedSurfaceDefinition | undefined;
    const action = unknownRecord(resolvedRecord.action);
    const command = unknownRecord(resolvedRecord.command);
    const targetCommandId = typeof command.result === "object" && command.result !== null
      ? stringRecordValue(command.result, "command_id")
      : undefined;
    const payloadTemplate = typeof command.result === "object" && command.result !== null
      ? recordPayload(unknownRecord(command.result).payload_template as JsonValue | undefined)
      : {};
    if (!surface || !targetCommandId || typeof action.id !== "string") {
      throw new RuntimeRequestError("internal", "generated_surface_action_resolution_invalid");
    }
    if (action.requires_confirmation && input.confirmed !== true) {
      throw new RuntimeRequestError("conflict", "generated_surface_action_confirmation_required");
    }
    const revisionId = input.revisionId ?? surface.current_revision_id;
    const ingressResult = await executeGeneratedSurfaceAction({
      resolved: {
        surface,
        revisionId,
        action: action as GeneratedSurfaceActionDeclaration,
        payloadTemplate
      },
      interactionId: input.interactionId,
      actionPayload: input.actionPayload ?? {},
      dispatch: async (request) => this.runDomainCommandWithTrustedContext({
        command_id: request.commandId,
        input_source: "generated_surface",
        idempotency_key: request.idempotencyKey,
        payload: request.payload
      }, actionTrusted),
      recordInteraction: async (request) => this.runDomainCommandWithTrustedContext({
        command_id: runtimeOperationIds.generatedSurfaceInteractionRecord,
        input_source: "generated_surface",
        idempotency_key: `${surface.id}:${revisionId}:${input.interactionId}:interaction`,
        payload: {
          surface_id: surface.id,
          revision_id: revisionId,
          interaction_id: input.interactionId,
          message_id: input.messageId,
          kind: "action",
          command_id: request.commandId,
          command_result: request.error
            ? { status: "failed", error: safeRuntimeErrorMessage(request.error, "generated_surface_action_failed") }
            : jsonSafe((request.result as DomainCommandRuntimeResult | undefined)?.result),
          user_feedback: request.error
            ? safeRuntimeErrorMessage(request.error, "generated_surface_action_failed")
            : undefined
        }
      }, actionTrusted)
    });
    return {
      surface,
      action: action as GeneratedSurfaceActionDeclaration,
      command: (ingressResult.command as DomainCommandRuntimeResult).result,
      interaction: (ingressResult.interaction as DomainCommandRuntimeResult).result
    };
  }

  /**
   * Fixed Runtime API adapters use this after parsing the DTO from the generated
   * operation contract. Dynamic `/api/domain` dispatch intentionally uses the
   * untyped method above because its operation id is transport data.
   */
  async runTypedRuntimeApiDomainCommand<Id extends DomainCommandId>(
    input: TypedDomainCommandRuntimeInput<Id>,
    trusted: TrustedDomainRuntimeContext = {}
  ): Promise<DomainCommandRuntimeResult<DomainOperationOutput<Id>>> {
    const result = await this.runRuntimeApiDomainCommand(input, trusted);
    // The same literal id selected the generated input/output schemas in the
    // registry, which validated both before this dynamic-boundary type recovery.
    return result as DomainCommandRuntimeResult<DomainOperationOutput<Id>>;
  }

  private async runDomainCommandWithTrustedContext(
    input: DomainCommandRuntimeInput,
    trusted: TrustedDomainRuntimeContext
  ): Promise<DomainCommandRuntimeResult> {
    const deprecated = getDeprecatedDomainCommandEntry(input.command_id);
    if (deprecated) {
      throw new RuntimeRequestError("gone", `deprecated_operation:${input.command_id}`, {
        deprecated_operation_id: deprecated.id,
        replacement: deprecated.replacement
      });
    }
    const command = getDomainCommandEntry(input.command_id);
    if (!command) {
      throw new RuntimeRequestError("not_found", `domain_command_not_found:${input.command_id}`);
    }
    if (command.availability !== "active" || command.id === "collection.manage") {
      throw new RuntimeRequestError("unavailable", `domain_command_unavailable:${command.id}`);
    }
    if (!this.domainOperationAvailable(command)) {
      throw new RuntimeRequestError("unavailable", `domain_operation_unavailable:${command.id}`);
    }
    const inputSource = input.input_source ?? "runtime_api";
    if (!command.allowed_sources.includes(inputSource)) {
      throw new RuntimeRequestError("forbidden", `domain_command_source_not_allowed:${command.id}:${inputSource}`);
    }
    const payload = jsonDefinedRecord(input.payload === undefined ? {} : input.payload);
    assertNoTrustedContextPayloadFields(payload, trustedContextPayloadFieldsForOperation(command.id));
    const inputIssue = validateDomainCommandInput(command, payload);
    if (inputIssue) {
      throw new RuntimeRequestError("validation", `domain_command_input_invalid:${command.id}:${inputIssue.path}:${inputIssue.message}`);
    }
    let result: unknown;
    const trustedContext = await this.trustedDomainContext(inputSource, payload, {
      ...trusted,
      ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {})
    }, command.id);
    try {
      await this.assertDomainOperationAuthorized(command, payload, trustedContext);
    } catch (error) {
      await this.recordDomainAccessAuditSafely(command, payload, { error: safeRuntimeErrorMessage(error, "room_authorization_denied") }, trustedContext, {
        allowed: false,
        reason: safeRuntimeErrorMessage(error, "room_authorization_denied")
      });
      throw error;
    }
    if (!trustedContext.sessionId && isPersistedSessionCompatibilityOperation(command.id)) {
      throw new RuntimeRequestError("unavailable", `session_compatibility_required:${command.id}`);
    }
    if (!this.domainOperationAvailable(command)) {
      throw new RuntimeRequestError("unavailable", `domain_operation_unavailable:${command.id}`);
    }
    try {
      result = await this.domainCommandBus.execute({
        commandId: command.id,
        contractVersion: command.contract_version,
        inputSource,
        payload,
        idempotencyKey: input.idempotency_key,
        workspaceId: stableHash(this.store.rootDir),
        sessionId: trustedContext.sessionId,
        actorId: trustedContext.actorId,
        correlationId: trustedContext.correlationId,
        executionClass: command.idempotency_policy === "external" ? "external" : "internal"
      }, () => this.executeDomainCommand(command, payload, trustedContext));
    } catch (error) {
      await this.recordDomainAccessAuditSafely(command, payload, { error: safeRuntimeErrorMessage(error, "domain_command_failed") }, trustedContext, {
        allowed: true,
        reason: "execution_failed"
      });
      if (error instanceof DomainCommandIdempotencyKeyRequiredError) {
        throw new RuntimeRequestError("bad_request", error.code);
      }
      if (error instanceof DomainCommandOutcomeUnknownError) {
        throw new RuntimeRequestError("outcome_unknown", error.message);
      }
      if (error instanceof DomainCommandReplayError) {
        throw new RuntimeRequestError(parseRuntimeRequestErrorCode(error.code), error.message, {
          conflict: "domain_command_replay",
          code: error.code,
          retryable: error.retryable,
          ...(error.details === undefined ? {} : { details: error.details })
        });
      }
      if (error instanceof DomainCommandConflictError) {
        throw new RuntimeRequestError("conflict", error.message);
      }
      if (error instanceof DomainOperationError) {
        if (error.handlerCause instanceof RuntimeRequestError) throw error.handlerCause;
        throw runtimeRequestErrorFromDomainOperationError(error);
      }
      throw error;
    }
    await this.recordResourceAccessBoundaries(result, command, trustedContext);
    await this.recordBackendDomainOperationTelemetrySafely(result, trustedContext);
    await this.attachDomainCorrelationSafely(result, trustedContext);
    await this.recordDomainAccessAuditSafely(command, payload, result, trustedContext, { allowed: true, reason: "allowed" });
    const renderSpecs = assertDomainCommandRenderSpecs(command, await this.domainCommandRenderSpecs(command, result));
    const output: DomainCommandRuntimeResult = {
      command,
      ok: true,
      contract_version: command.contract_version,
      execution_id: input.idempotency_key ?? stableHash({ command_id: command.id, contract_version: command.contract_version, payload }),
      input_source: inputSource,
      payload,
      render_spec: renderSpecs[0],
      render_specs: renderSpecs,
      result
    };
    const outputIssue = validateDomainOutput(command, output);
    if (outputIssue) throw new RuntimeRequestError("internal", `domain_command_output_invalid:${command.id}:${outputIssue.path}:${outputIssue.message}`);
    return output;
  }

  async runDomainQuery(
    input: DomainQueryRuntimeInput,
    trusted: TrustedDomainRuntimeContext = {}
  ): Promise<DomainQueryRuntimeResult> {
    return this.runDomainQueryWithTrustedContext(input, { ...trusted, requireExplicitRoom: true });
  }

  /**
   * Internal-only Core09 adapter factory. It has no HTTP, MCP, OAuth, or
   * credential surface; a real transport must authenticate before it reaches
   * this boundary.
   */
  createExternalAppIngress(workspaceId = "workspace"): ExternalAppIngress {
    const resolver = new ExternalAppContextResolver({
      workspaceId,
      connections: {
        getExternalAppConnection: ({ workspaceId: targetWorkspaceId, connectionId }) =>
          targetWorkspaceId === workspaceId ? this.store.getExternalAppConnection(connectionId) : Promise.resolve(undefined),
        getExternalAppConnectionByConnector: (input) => this.store.getExternalAppConnectionByConnector(input)
      },
      roomAuthorization: this.roomAuthorizationService
    });
    return new ExternalAppIngress({
      resolver,
      runtime: {
        runDomainQuery: (input, trusted) => this.runDomainQuery(input, trusted),
        runDomainCommand: (input, trusted) => this.runDomainCommand(input, trusted)
      },
      activityIngest: this.activityIngest
    });
  }

  /** Room authorization adapter for the external-integration HTTP/MCP
   * boundary. It reuses the same service as Native App and Core09. */
  externalIntegrationRoomAuthorization(): {
    assertRoom(principal: { kind: "human" | "agent"; participantId?: string; agentId?: string; requestedByParticipantId?: string }, roomId: string, action: "read" | "edit" | "execute" | "manage_settings"): Promise<void>;
  } {
    return {
      assertRoom: (principal, roomId, action) => this.roomAuthorizationService.assertRoom(
        principal.kind === "human"
          ? { kind: "human", participantId: principal.participantId ?? "" }
          : { kind: "agent", agentId: principal.agentId ?? "", requestedByParticipantId: principal.requestedByParticipantId ?? "" },
        roomId,
        action
      )
    };
  }

  /** Fixture-only proof of the Core09 boundary; this is not a transport protocol. */
  createReferenceExternalAppAdapter(): ReferenceExternalAppAdapter {
    return new ReferenceExternalAppAdapter(this.createExternalAppIngress());
  }

  /** Gateway may delegate to the same formal ingress without entering Chat dispatch. */
  createGatewayFormalWorkspaceIngress(): GatewayFormalWorkspaceIngress {
    return new GatewayFormalWorkspaceIngress(this.createExternalAppIngress());
  }

  /** Runtime API adapters use this after they have resolved trusted resources. */
  async runRuntimeApiDomainQuery(
    input: Omit<DomainQueryRuntimeInput, "input_source">,
    trusted: TrustedDomainRuntimeContext = {}
  ): Promise<DomainQueryRuntimeResult> {
    return this.runDomainQueryWithTrustedContext({ ...input, input_source: "runtime_api" }, { ...trusted, requireExplicitRoom: true });
  }

  /** Fixed Runtime API query adapters use a generated operation DTO. */
  async runTypedRuntimeApiDomainQuery<Id extends DomainQueryId>(
    input: TypedDomainQueryRuntimeInput<Id>,
    trusted: TrustedDomainRuntimeContext = {}
  ): Promise<DomainQueryRuntimeResult<DomainOperationOutput<Id>>> {
    const result = await this.runRuntimeApiDomainQuery(input, trusted);
    // See the command variant: registry validation is the sole dynamic boundary.
    return result as DomainQueryRuntimeResult<DomainOperationOutput<Id>>;
  }

  private async runDomainQueryWithTrustedContext(
    input: DomainQueryRuntimeInput,
    trusted: TrustedDomainRuntimeContext
  ): Promise<DomainQueryRuntimeResult> {
    const query = getDomainQueryEntry(input.query_id);
    if (!query) {
      throw new RuntimeRequestError("not_found", `domain_query_not_found:${input.query_id}`);
    }
    if (!this.domainOperationAvailable(query)) {
      throw new RuntimeRequestError("unavailable", `domain_operation_unavailable:${query.id}`);
    }
    const inputSource = input.input_source ?? "runtime_api";
    // Formal External App queries are a strict read boundary: not even an
    // audit-row projection may turn them into a Workspace write.
    const recordQueryAudit = inputSource !== "external_app";
    if (!query.allowed_sources.includes(inputSource)) {
      throw new RuntimeRequestError("forbidden", `domain_query_source_not_allowed:${query.id}:${inputSource}`);
    }
    const payload = jsonDefinedRecord(input.payload === undefined ? {} : input.payload);
    // Workspace startup Context names its target Room in the public Query DTO
    // so the contract is self-describing. The handler separately requires it
    // to equal the already-authorized trusted Room; it never becomes authority.
    assertNoTrustedContextPayloadFields(payload, query.id === runtimeOperationIds.workspaceContextGet ? ["room_id"] : []);
    const inputIssue = validateDomainQueryInput(query, payload);
    if (inputIssue) {
      throw new RuntimeRequestError("validation", `domain_query_input_invalid:${query.id}:${inputIssue.path}:${inputIssue.message}`);
    }
    const trustedContext = await this.trustedDomainContext(inputSource, payload, trusted, query.id);
    try {
      await this.assertDomainOperationAuthorized(query, payload, trustedContext);
    } catch (error) {
      if (recordQueryAudit) {
        await this.recordDomainAccessAuditSafely(query, payload, { error: safeRuntimeErrorMessage(error, "room_authorization_denied") }, trustedContext, {
          allowed: false,
          reason: safeRuntimeErrorMessage(error, "room_authorization_denied")
        });
      }
      throw error;
    }
    if (!trustedContext.sessionId && isSessionCompatibleOperation(query.id)) {
      throw new RuntimeRequestError("unavailable", `session_compatibility_required:${query.id}`);
    }
    let result: unknown;
    try {
      result = await this.activeDomainContext.run(
        trustedContext,
        async () => (await this.domainOperationRegistry.execute(trustedContext, query.id, payload)).value
      );
    } catch (error) {
      if (recordQueryAudit) {
        await this.recordDomainAccessAuditSafely(query, payload, { error: safeRuntimeErrorMessage(error, "domain_query_failed") }, trustedContext, {
          allowed: true,
          reason: "execution_failed"
        });
      }
      if (error instanceof DomainOperationError) {
        if (error.handlerCause instanceof RuntimeRequestError) throw error.handlerCause;
        throw runtimeRequestErrorFromDomainOperationError(error);
      }
      throw error;
    }
    if (recordQueryAudit) {
      await this.recordDomainAccessAuditSafely(query, payload, result, trustedContext, { allowed: true, reason: "allowed" });
    }
    const renderSpecs = assertDomainQueryRenderSpecs(query, await this.domainQueryRenderSpecs(query, result));
    const output: DomainQueryRuntimeResult = {
      query,
      ok: true,
      contract_version: query.contract_version,
      execution_id: stableHash({ query_id: query.id, contract_version: query.contract_version, payload }),
      input_source: inputSource,
      payload,
      render_spec: renderSpecs[0],
      render_specs: renderSpecs,
      result
    };
    const outputIssue = validateDomainOutput(query, output);
    if (outputIssue) throw new RuntimeRequestError("internal", `domain_query_output_invalid:${query.id}:${outputIssue.path}:${outputIssue.message}`);
    return output;
  }

  async listEffectiveDomainOperations(
    sessionId: string,
    source: DomainCommandInputSource,
    principal: ParticipantPrincipal
  ): Promise<{ commands: DomainCommandEntry[]; queries: DomainQueryEntry[] }> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new RuntimeRequestError("not_found", `Session not found: ${sessionId}`);
    if (!session.room_id) throw new RuntimeRequestError("conflict", `session_room_missing:${session.id}`);
    return this.listEffectiveDomainOperationsForRoom({
      roomId: session.room_id,
      source,
      principal,
      sessionRef: { app_id: "samurai-native", session_id: session.id }
    });
  }

  /**
   * Room-first operation inventory.  A missing SessionRef only hides the
   * closed legacy/Core08 compatibility set; it never creates a fake Session.
   */
  async listEffectiveDomainOperationsForRoom(input: {
    roomId: string;
    source: DomainCommandInputSource;
    sessionRef?: import("@samurai-agent/core-schemas").SessionRef;
    principal: ParticipantPrincipal;
  }): Promise<{ commands: DomainCommandEntry[]; queries: DomainQueryEntry[] }> {
    await this.roomAuthorizationService.assertRoom(input.principal, input.roomId, "read");
    const includeSessionCompatible = input.sessionRef !== undefined;
    const available = <T extends DomainCommandEntry | DomainQueryEntry>(entries: T[]): T[] => entries.filter((entry) =>
      this.domainOperationAvailable(entry) && (includeSessionCompatible || !isSessionCompatibleOperation(entry.id))
    );
    return {
      commands: available(listDomainCommandEntries(input.source)),
      queries: available(listDomainQueryEntries(input.source))
    };
  }

  private domainOperationAvailable(entry: DomainCommandEntry | DomainQueryEntry): boolean {
    const available = this.effectiveDomainCapabilities();
    return entry.runtime_requirements.every((requirement) => available.has(requirement));
  }

  private effectiveDomainCapabilities(): Set<DomainRuntimeCapability> {
    const capabilities = new Set<DomainRuntimeCapability>();
    if (this.backendRegistry.statuses().some((status) => status.enabled && status.configured && (status.connection_state === "ready" || status.connection_state === "unverified"))) capabilities.add("agent_backend");
    if (this.workspaceOptions.pdfExportAdapter) capabilities.add("pdf_export");
    if (this.workspaceOptions.browserAdapter) capabilities.add("browser_adapter");
    if (this.pluginRegistry.listPluginStatuses().some((status) => status.enabled
      && status.missing_handler_ids.length === 0
      && (status.source === "built_in" || status.entrypoint_status === "ready"))) {
      capabilities.add("plugin_runtime");
    }
    return capabilities;
  }

  private async domainCommandRenderSpecs(command: DomainDispatchEntry, result: unknown): Promise<SurfaceRenderSpec[]> {
    if (command.output_render_kinds.length === 0) return [];
    const surfaceOperationSpecs = surfaceOperationRuntimeRenderSpecs(result);
    if (surfaceOperationSpecs.length > 0) {
      return surfaceOperationSpecs;
    }
    if (isRunChatTurnResult(result)) {
      return [chatTurnRenderSpec(result)];
    }
    if (isGatewayInboundRuntimeResult(result)) {
      const specs = [gatewayInboundRenderSpec(result)];
      if (result.chat) {
        specs.unshift(chatTurnRenderSpec(result.chat));
      }
      return specs;
    }
    if (isCollectionRecordRuntimeResult(result)) {
      if (isResourceDeletionResult(result)) return [];
      const resolution = await this.resolveCollectionRecordRefs(result.resource.collection_id, result.resource.id);
      return [collectionRecordRenderSpec(result.resource, command.title, resolution)];
    }
    const resourceSpec = resourceRenderSpec(command, result);
    return resourceSpec ? [resourceSpec] : [];
  }

  private async domainQueryRenderSpecs(query: DomainQueryEntry, result: unknown): Promise<SurfaceRenderSpec[]> {
    return this.domainCommandRenderSpecs(query, result);
  }

  private async executeDomainCommand(
    entry: DomainCommandEntry,
    payload: Record<string, JsonValue>,
    context: TrustedDomainContext
  ): Promise<unknown> {
    return this.activeDomainContext.run(
      context,
      async () => (await this.domainOperationRegistry.execute(context, entry.id, payload)).value
    );
  }

  private async assertDomainOperationAuthorized(
    entry: DomainCommandEntry | DomainQueryEntry,
    payload: Record<string, JsonValue>,
    context: TrustedDomainContext
  ): Promise<void> {
    const principal = context.participant;
    // An unbound Gateway contact may only create or update its transport
    // admission record. It is deliberately not a general system bypass:
    // Room content remains unavailable until a future verified participant is
    // resolved by the trusted execution path.
    if (entry.access.scope === "gateway_admission") {
      if (context.inputSource !== "gateway_inbound") {
        throw new RuntimeRequestError("forbidden", "gateway_admission_source_required");
      }
      if (!principal || (principal.kind === "system" && principalParticipantId(principal) !== "system:unbound-gateway")) {
        throw new RuntimeRequestError("forbidden", "gateway_admission_principal_required");
      }
      return;
    }
    // The scheduler starts an Automation attempt but is never its authority.
    // Core09AutomationDomainService takes the durable lock, reloads the Job,
    // and then resolves the saved principal/Connection and current Room
    // permission before any executor runs.
    if (entry.access.scope === "automation_execution") {
      if (context.inputSource !== "automation" && context.inputSource !== "scheduled_context") {
        throw new RuntimeRequestError("forbidden", "automation_scheduler_source_required");
      }
      return;
    }
    if (!principal) throw new RuntimeRequestError("forbidden", "room_participant_required");
    // Collaboration has explicit target checks in RoomAgentDomainService. It
    // is deliberately not inferred from a command name here.
    if (entry.access.scope === "room_collaboration") return;
    try {
      if (entry.id === runtimeOperationIds.clientEventSave && typeof payload.room_id === "string") {
        const roomId = payload.room_id.trim();
        if (!roomId || context.roomId !== roomId) {
          throw new RuntimeRequestError("forbidden", "client_event_room_context_mismatch");
        }
        await this.roomAuthorizationService.assertRoom(principal, roomId, "read");
      }
      if (entry.access.scope === "workspace_control" || entry.access.scope === "legacy_owner") {
        await this.roomAuthorizationService.assertWorkspace(
          principal,
          entry.access.scope === "legacy_owner" ? "use_legacy_resources" : "manage_settings"
        );
        return;
      }
      const roomId = context.roomId;
      if (!roomId) throw new RuntimeRequestError("forbidden", "room_context_required");
      const action = entry.access.action;
      await this.roomAuthorizationService.assertRoom(principal, roomId, action);
      // A Session is a resource too. This keeps old unbounded Sessions
      // Owner-only and blocks a removed participant before any handler can
      // load its messages, runs, or related Workspace state.
      if (context.sessionId) {
        await this.roomAuthorizationService.assertResource(principal, {
          roomId,
          action,
          resourceKind: "session",
          resourceId: context.sessionId
        });
      }
      // Rollback points do not own separate content files. Their immutable
      // access boundary is the Room of the original operation, so a Session
      // from another Room cannot restore or inspect their changes.
      if (entry.id === runtimeOperationIds.rollbackRestore) {
        const rollbackPointId = stringPayload(payload.rollback_point_id);
        const rollbackPoint = rollbackPointId ? await this.store.getRollbackPoint(rollbackPointId) : undefined;
        const operation = rollbackPoint ? await this.store.getOperation(rollbackPoint.operation_id) : undefined;
        if (!operation || operation.room_id !== roomId) {
          throw new RuntimeRequestError("forbidden", "room_rollback_access_denied");
        }
      }
      const targets = await this.existingDomainResourceTargets(entry.access.target, payload);
      for (const target of targets) {
        await this.roomAuthorizationService.assertResource(principal, {
          roomId,
          action,
          resourceKind: target.kind,
          resourceId: target.id
        });
      }
      if (entry.id === runtimeOperationIds.learningBackgroundReviewApply) {
        await this.assertBackgroundReviewMutationAuthorization(payload, context);
      }
      return;
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
  }

  private async existingDomainResourceTargets(
    target: DomainResourceTarget | readonly DomainResourceTarget[] | undefined,
    payload: Record<string, JsonValue>
  ): Promise<Array<{ kind: string; id: string }>> {
    if (!target) return [];
    const targets = Array.isArray(target) ? target : [target];
    const resolved = await Promise.all(targets.map(async (item) => {
      if ("resourceRefField" in item) {
        const ref = unknownRecord(payload[item.resourceRefField]);
        const kind = typeof ref.kind === "string" ? ref.kind.trim() : "";
        const id = typeof ref.id === "string" ? ref.id.trim() : "";
        if (!kind || !id || !item.allowedKinds.includes(kind as "artifact" | "memory" | "wiki" | "skill" | "collection_record")) return undefined;
        if (kind !== "collection_record") return { kind, id };
        const uri = typeof ref.uri === "string" ? ref.uri : "";
        const collectionTarget = collectionRecordTargetFromRef({ kind, id, uri });
        return collectionTarget ? {
          kind,
          id: collectionRecordResourceId(collectionTarget.collectionId, collectionTarget.recordId)
        } : undefined;
      }
      if ("kindField" in item) {
        const kind = stringPayload(payload[item.kindField]);
        const id = stringPayload(payload[item.idField]);
        return kind && id && item.allowedKinds.includes(kind as "memory" | "wiki" | "skill") ? { kind, id } : undefined;
      }
      if (item.kind === "collection_record") {
        const collectionId = stringPayload(payload[item.collectionIdField]);
        const recordId = stringPayload(payload[item.recordIdField]);
        if (!collectionId || !recordId) return undefined;
        if (item.onlyIfExisting && !await this.store.getCollectionRecord(collectionId, recordId)) return undefined;
        return { kind: item.kind, id: collectionRecordResourceId(collectionId, recordId) };
      }
      const id = stringPayload(payload[item.idField]);
      if (!id) return undefined;
      if (item.onlyIfExisting && item.kind === "collection_schema" && !await this.store.getCollectionSchema(id)) return undefined;
      if (item.onlyIfExisting && item.kind === "file") {
        // A deleted file can still have a durable Room boundary. Treat that
        // boundary as an existing resource too, otherwise another Room could
        // recreate the same path before the post-write boundary check.
        const [exists, boundary] = await Promise.all([
          this.workspaceFileExists(id),
          this.store.getResourceAccessBoundary("file", id)
        ]);
        if (!exists && !boundary) return undefined;
      }
      return { kind: item.kind, id };
    }));
    return resolved.filter((item): item is { kind: string; id: string } => Boolean(item));
  }

  /**
   * The Background Review plan contains its affected resources inside a typed
   * mutation list, rather than one top-level resource ID.  Check those
   * targets here before the mutation service can load or change a document.
   */
  private async assertBackgroundReviewMutationAuthorization(
    payload: Record<string, JsonValue>,
    context: TrustedDomainContext
  ): Promise<void> {
    if (!context.participant || !context.roomId || !context.sessionId || !context.runId) {
      throw new RuntimeRequestError("forbidden", "background_review_room_run_required");
    }
    const reflectionRunId = stringPayload(payload.reflection_run_id);
    const reflectionRun = reflectionRunId ? await this.store.getReflectionRun(reflectionRunId) : undefined;
    const sourceRun = await this.store.getBackendRun(context.runId);
    if (!reflectionRun || !sourceRun || reflectionRun.source_run_id !== sourceRun.id
      || reflectionRun.session_id !== context.sessionId || reflectionRun.activity_context?.room_id !== context.roomId) {
      throw new RuntimeRequestError("forbidden", "background_review_source_context_invalid");
    }
    await this.assertRunAgentExecution(sourceRun);
    // A plan can create new Resources, so execute permission alone is not
    // enough. This is deliberately evaluated again at application time.
    await this.roomAuthorizationService.assertRoom(context.participant, context.roomId, "edit");
    const mutations = Array.isArray(payload.mutations) ? payload.mutations : [];
    for (const rawMutation of mutations) {
      const mutation = unknownRecord(rawMutation);
      const kind = typeof mutation.kind === "string" ? mutation.kind : "";
      const resourceKind = typeof mutation.resource_kind === "string" ? mutation.resource_kind : undefined;
      const resourceId = typeof mutation.resource_id === "string" ? mutation.resource_id : undefined;
      if (!resourceKind || !resourceId || !["memory", "wiki", "skill"].includes(resourceKind)) continue;
      await this.roomAuthorizationService.assertResource(context.participant, {
        roomId: context.roomId,
        action: kind === "resource_evidence_append" ? "edit" : "read",
        resourceKind,
        resourceId
      });
    }
  }

  private async attachDomainCorrelation(result: unknown, context: TrustedDomainContext): Promise<void> {
    const operationCandidates = domainResultOperations(result);
    for (const candidate of operationCandidates) {
      const operation = await this.store.getOperation(candidate.id);
      if (!operation) continue;
      const participant = context.participant;
      const updatedOperation = {
        ...operation,
        correlation_id: context.correlationId,
        ...(participant ? { participant_id: principalParticipantId(participant), participant_kind: participant.kind } : {}),
        ...(participant ? { requested_by_participant_id: requesterParticipantId(participant) } : {}),
        ...(context.roomId ? { room_id: context.roomId } : {})
      };
      if (JSON.stringify(updatedOperation) !== JSON.stringify(operation)) await this.store.updateOperation(updatedOperation);
      for (const audit of await this.store.listAuditRecordsForOperation(operation.id)) {
        await this.store.updateAuditRecord({
          ...audit,
          ...(participant ? { participant_id: principalParticipantId(participant), participant_kind: participant.kind } : {}),
          ...(participant ? { requested_by_participant_id: requesterParticipantId(participant) } : {}),
          ...(context.roomId ? { room_id: context.roomId } : {})
        });
      }
      const changes = await this.store.listWorkspaceChangesForOperation(operation.id);
      for (const change of changes) {
        if ((change.domain_operation_id === operation.id || change.legacy_operation_id === operation.id) && change.correlation_id !== context.correlationId) {
          await this.store.setWorkspaceChangeCorrelation(change.id, context.correlationId);
        }
      }
    }
  }

  private async recordBackendDomainOperationTelemetry(result: unknown, context: TrustedDomainContext): Promise<void> {
    if (!context.runId) return;
    const write = operationAuditRuntimeResult(result);
    const resourceRef = write?.resourceRefs[0] ?? write?.operation.result_ref;
    if (!write || !resourceRef) return;
    await this.domainOperationTelemetry.record({
      runId: context.runId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      correlationId: context.correlationId,
      operation: write.operation,
      resourceRef
    });
  }

  /** Telemetry is a projection of a committed Operation, never its success condition. */
  private async recordBackendDomainOperationTelemetrySafely(result: unknown, context: TrustedDomainContext): Promise<void> {
    try {
      await this.recordBackendDomainOperationTelemetry(result, context);
    } catch {
      // A later recovery pass can rebuild telemetry from the Run and Operation.
    }
  }

  /** Correlation repair is useful for diagnostics but cannot invalidate a completed write. */
  private async attachDomainCorrelationSafely(result: unknown, context: TrustedDomainContext): Promise<void> {
    try {
      await this.attachDomainCorrelation(result, context);
    } catch {
      // The Operation retains its immutable correlation_id even if a legacy
      // WorkspaceChange projection could not be updated immediately.
    }
  }

  /**
   * Registers known Room-resource identities before a mutation starts, then
   * repeats the check for the result before the Operation is settled.  This
   * closes the former "write first, discover another Room later" path.
   */
  private async ensureRecordedMutationResourceAccessBoundaries(
    refs: ResourceRef[],
    context: TrustedDomainContext | undefined,
    resource: unknown
  ): Promise<void> {
    if (!context?.participant || context.participant.kind === "system" || !context.roomId) return;
    const delegated = delegatedParticipant(context.participant);
    if (delegated.kind === "system") return;
    const ownerParticipantId = delegated.kind === "agent"
      ? delegated.requestedByParticipantId
      : delegated.participantId;
    const record = unknownRecord(resource);
    for (const ref of uniqueResourceRefs(refs)) {
      const resourceKind = canonicalRoomResourceKind(ref.kind);
      if (!resourceKind || isRoomPermissionMetadataKind(ref.kind)) continue;
      const collectionTarget = ref.kind === "collection_record" ? collectionRecordTargetFromRef(ref) : undefined;
      const resourceId = ref.kind === "collection_record"
        ? collectionTarget
          ? collectionRecordResourceId(collectionTarget.collectionId, collectionTarget.recordId)
          : typeof record.collection_id === "string" && ref.id === record.id
            ? collectionRecordResourceId(record.collection_id, ref.id)
            : ref.id
        : ref.id;
      await this.store.ensureResourceAccessBoundary({
        resourceKind,
        resourceId,
        sourceRoomId: context.roomId,
        ownerParticipantId,
        creatorParticipantId: principalParticipantId(context.participant),
        ...(typeof record.created_at === "string" ? { resourceCreatedAt: record.created_at } : {}),
        actorId: ownerParticipantId
      });
    }
  }

  private async recordResourceAccessBoundaries(
    result: unknown,
    command: DomainCommandEntry,
    context: TrustedDomainContext
  ): Promise<void> {
    // RuntimeWriteResult is settled by runRecordedMutation, which establishes
    // its boundary before marking the Operation complete.  Repeating it here
    // used to turn a successful write into a late room-conflict response.
    if (operationAuditRuntimeResult(result)?.operation) return;
    if (!context.participant || context.participant.kind === "system") return;
    const operation = operationAuditRuntimeResult(result)?.operation;
    const output = unknownRecord(result);
    const outputSession = unknownRecord(output.session);
    const sessionId = context.sessionId ?? operation?.session_id
      ?? (typeof outputSession.id === "string" ? outputSession.id : undefined)
      ?? (command.output_resource_kind === "session" && typeof output.id === "string" ? output.id : undefined);
    const session = sessionId ? await this.store.getSession(sessionId) : undefined;
    const roomId = context.roomId ?? session?.room_id;
    if (!roomId) return;
    const delegated = delegatedParticipant(context.participant);
    const ownerParticipantId = delegated.kind === "agent"
      ? delegated.requestedByParticipantId
      : delegated.participantId;
    const refs = [...(operationAuditRuntimeResult(result)?.resourceRefs ?? [])];
    const resource = runtimeWriteResource(result);
    const resourceRecord = unknownRecord(resource);
    if (typeof resourceRecord.id === "string") {
      const resourceId = command.output_resource_kind === "collection_record" && typeof resourceRecord.collection_id === "string"
        ? collectionRecordResourceId(resourceRecord.collection_id, resourceRecord.id)
        : resourceRecord.id;
      refs.push({ kind: command.output_resource_kind, id: resourceId, uri: `domain/${command.output_resource_kind}/${resourceId}` });
    }
    // Some commands intentionally return their resource directly rather than
    // through the legacy RuntimeWrite envelope. In particular, Session create
    // and Generated Surface create/revise must still establish their Room
    // boundary before a later read, revision, or export can occur.
    const directResource = command.output_resource_kind === "generated_surface"
      ? unknownRecord(output.definition)
      : output;
    if (canonicalRoomResourceKind(command.output_resource_kind) && typeof directResource.id === "string") {
      const resourceId = command.output_resource_kind === "collection_record" && typeof directResource.collection_id === "string"
        ? collectionRecordResourceId(directResource.collection_id, directResource.id)
        : directResource.id;
      refs.push({ kind: command.output_resource_kind, id: resourceId, uri: `domain/${command.output_resource_kind}/${resourceId}` });
    }
    if (session) refs.push({ kind: "session", id: session.id, uri: `sessions/${session.id}` });
    for (const ref of refs) {
      const resourceKind = canonicalRoomResourceKind(ref.kind);
      if (!ref.id || !resourceKind || isRoomPermissionMetadataKind(ref.kind)) continue;
      const resourceId = ref.kind === "collection_record"
        && typeof resourceRecord.collection_id === "string"
        && ref.id === resourceRecord.id
        ? collectionRecordResourceId(resourceRecord.collection_id, ref.id)
        : ref.id;
      await this.store.ensureResourceAccessBoundary({
        resourceKind,
        resourceId,
        sourceRoomId: roomId,
        ownerParticipantId,
        creatorParticipantId: principalParticipantId(context.participant),
        ...(typeof resourceRecord.created_at === "string" ? { resourceCreatedAt: resourceRecord.created_at } : {}),
        actorId: ownerParticipantId
      });
    }
  }

  private async recordDomainAccessAudit(
    entry: DomainCommandEntry | DomainQueryEntry,
    payload: Record<string, JsonValue>,
    result: unknown,
    context: TrustedDomainContext,
    decision: { allowed: boolean; reason: string }
  ): Promise<void> {
    const participant = context.participant;
    const write = operationAuditRuntimeResult(result);
    const output = unknownRecord(result);
    const createdRoomId = entry.id === runtimeOperationIds.roomCreate && typeof output.id === "string" ? output.id : undefined;
    const roomId = context.roomId ?? createdRoomId;
    const affectedResources = uniqueResourceRefs([
      ...(write?.resourceRefs ?? []),
      ...(context.sessionId ? [{ kind: "session", id: context.sessionId, uri: `sessions/${context.sessionId}` } satisfies ResourceRef] : [])
    ]);
    const accessScope = entry.access.scope === "workspace_control" || entry.access.scope === "legacy_owner"
      ? "workspace"
      : entry.access.scope === "room_content" && (entry.access.target || context.sessionId)
        ? "resource"
        : roomId ? "room" : "workspace";
    const accessAction = entry.access.scope === "room_content"
      ? entry.access.action
      : entry.access.scope === "workspace_control"
        ? "manage_settings"
        : entry.access.scope === "legacy_owner"
          ? "use_legacy_resources"
        : entry.id;
    await this.store.saveAuditRecord({
      id: createId("audit"),
      actor_identity: context.actorId as ActorIdentity,
      ...(participant ? { participant_id: principalParticipantId(participant), participant_kind: participant.kind } : {}),
      ...(participant ? { requested_by_participant_id: requesterParticipantId(participant) } : {}),
      ...(roomId ? { room_id: roomId } : {}),
      ...(participant ? { principal: trustedPrincipalFromParticipant(participant) } : {}),
      ...(context.source ? { source: context.source } : {}),
      ...(context.sessionRef ? { session_ref: context.sessionRef } : {}),
      operation_id: write?.operation.id ?? `domain:${entry.id}:${context.correlationId}`,
      capability_id: proposalCapabilityManifest.id,
      instruction_source: instructionSourceForDomainInput(context.inputSource),
      inputs_summary: summarize(`${entry.id} ${JSON.stringify(jsonSafe(payload))}`, 500),
      outputs_summary: summarize(`${entry.id} ${JSON.stringify(jsonSafe(output))}`, 500),
      room_access_scope: accessScope,
      room_access_action: accessAction,
      room_access_allowed: decision.allowed,
      room_access_reason: decision.reason,
      affected_resources: affectedResources,
      created_at: nowIso()
    });
  }

  /** An audit write must not mask the access decision that it records. */
  private async recordDomainAccessAuditSafely(
    entry: DomainCommandEntry | DomainQueryEntry,
    payload: Record<string, JsonValue>,
    result: unknown,
    context: TrustedDomainContext,
    decision: { allowed: boolean; reason: string }
  ): Promise<void> {
    try {
      await this.recordDomainAccessAudit(entry, payload, result, context, decision);
    } catch {
      // The original access or execution outcome remains authoritative. Audit
      // persistence failure is visible through normal Workspace diagnostics.
    }
  }

  private async backendWorkspaceChangesForOperation(runId: string, sessionId: string | undefined, operationId: string): Promise<WorkspaceChangeRecord[]> {
    return (await this.store.listWorkspaceChanges(sessionId)).filter((change) =>
      change.run_id === runId && (change.domain_operation_id === operationId || change.legacy_operation_id === operationId)
    );
  }

  private async trustedDomainContext(
    inputSource: DomainCommandInputSource,
    payload: Record<string, JsonValue>,
    trusted: TrustedDomainRuntimeContext = {},
    operationId?: string
  ): Promise<TrustedDomainContext> {
    assertNoTrustedContextPayloadFields(
      payload,
      operationId === runtimeOperationIds.workspaceContextGet
        ? ["room_id"]
        : trustedContextPayloadFieldsForOperation(operationId ?? "")
    );
    const { runId, envelopeId, surfaceOperation, signal, deadlineAt, idempotencyKey, roomId: trustedRoomId, sessionRef, source, connectionId, externalAllowedRoomIds, requireExplicitRoom } = trusted;
    assertTrustedRuntimeContextActive({ signal, deadlineAt });
    const actorIdentity = trustedActorIdentityForSource(inputSource);
    if (trusted.actorIdentity !== undefined && trusted.actorIdentity !== actorIdentity) {
      throw new RuntimeRequestError("forbidden", `domain_actor_source_mismatch:${inputSource}`);
    }
    let sessionId = trusted.sessionId;
    let run: BackendRunRecord | undefined;
    if (runId) {
      run = await this.store.getBackendRun(runId);
      if (!run) throw new RuntimeRequestError("not_found", `Backend run not found: ${runId}`);
      if (sessionId && run.session_id && run.session_id !== sessionId) {
        throw new RuntimeRequestError("conflict", `domain_run_session_mismatch:${runId}`);
      }
      sessionId = run.session_id ?? sessionId;
      if (trustedRoomId && run.room_id && trustedRoomId !== run.room_id) {
        throw new RuntimeRequestError("conflict", `domain_run_room_mismatch:${runId}`);
      }
    }
    if (inputSource === "provider_tool_call" && !run) {
      throw new RuntimeRequestError("forbidden", "provider_room_run_required");
    }
    const session = sessionId ? await this.store.getSession(sessionId) : undefined;
    if (sessionId && !session) throw new RuntimeRequestError("not_found", `Session not found: ${sessionId}`);
    const participant = await this.resolveTrustedParticipant({ inputSource, actorIdentity, trusted, run });
    assertTrustedExternalAppContext(participant, source, sessionRef);
    const payloadRoomId = operationId === runtimeOperationIds.clientEventSave && typeof payload.room_id === "string"
      ? payload.room_id.trim()
      : undefined;
    if (trustedRoomId && payloadRoomId && trustedRoomId !== payloadRoomId) {
      throw new RuntimeRequestError("conflict", `domain_payload_room_mismatch:${operationId ?? "unknown"}`);
    }
    // A Session-create command is the single legitimate operation without a
    // pre-existing Session. Its Room may be selected by the public DTO, or by
    // the server-owned default Room when the local UI starts a new chat.
    const requestedRoomId = trustedRoomId ?? payloadRoomId;
    if (session?.room_id && requestedRoomId && session.room_id !== requestedRoomId) {
      throw new RuntimeRequestError("conflict", `domain_session_room_mismatch:${session.id}`);
    }
    const targetRoomIds = new Set<string>();
    if (!session?.room_id && !requestedRoomId && operationId) {
      const entry = getDomainCommandEntry(operationId) ?? getDomainQueryEntry(operationId);
      if (entry?.access.scope === "room_content") {
        for (const target of await this.existingDomainResourceTargets(entry.access.target, payload)) {
          const boundary = await this.store.getResourceAccessBoundary(target.kind, target.id);
          if (boundary) targetRoomIds.add(boundary.source_room_id);
        }
      }
    }
    if (targetRoomIds.size > 1) {
      throw new RuntimeRequestError("conflict", `domain_resource_rooms_conflict:${operationId ?? "unknown"}`);
    }
    const roomId = trustedRoomId ?? run?.room_id ?? session?.room_id ?? requestedRoomId
      ?? [...targetRoomIds][0]
      // The compatibility Domain Command ingress may use the persisted local
      // default. Runtime API adapters set requireExplicitRoom and must supply
      // the authenticated Room separately.
      ?? (!requireExplicitRoom && (inputSource === "runtime_api" || inputSource === "surface_operation" || inputSource === "generated_surface") && actorIdentity === "owner"
        ? (await this.store.getSettings()).default_room_id
        : undefined)
      // Creating a Native App Session is an explicit compatibility command.
      // It may select the persisted local default; no Room Resource operation
      // receives that fallback.
      ?? (operationId === runtimeOperationIds.sessionCreate ? (await this.store.getSettings()).default_room_id : undefined);
    return {
      inputSource,
      workspaceId: stableHash(this.store.rootDir),
      actorId: actorIdentity,
      participant,
      ...(roomId ? { roomId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionRef ? { sessionRef } : {}),
      ...(source ? { source } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(runId ? { runId } : {}),
      ...(envelopeId ? { envelopeId } : {}),
      ...(inputSource === "external_app" && externalAllowedRoomIds ? { externalAllowedRoomIds: [...new Set(externalAllowedRoomIds)] } : {}),
      ...(surfaceOperation ? { surfaceOperation } : {}),
      ...(signal ? { signal } : {}),
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      correlationId: trusted.correlationId ?? stableHash({
        input_source: inputSource,
        session_id: sessionId ?? null,
        run_id: runId ?? null,
        envelope_id: envelopeId ?? null,
        surface_operation_id: surfaceOperation?.id ?? null,
        surface_operation_kind: surfaceOperation?.kind ?? null,
        actor_id: actorIdentity,
        participant_id: principalParticipantId(participant),
        connection_id: connectionId ?? null,
        room_id: roomId ?? null,
        payload
      })
    };
  }

  private async resolveTrustedParticipant(input: {
    inputSource: DomainCommandInputSource;
    actorIdentity: TrustedActorIdentity;
    trusted: TrustedDomainRuntimeContext;
    run?: BackendRunRecord;
  }): Promise<ParticipantPrincipal> {
    if (input.run) {
      const persistedPrincipal = input.run.principal ? principalFromTrustedWorkspace(input.run.principal) : undefined;
      let resolved: ParticipantPrincipal;
      if (input.run.agent_id) {
        resolved = {
          kind: "agent",
          agentId: input.run.agent_id,
          requestedByParticipantId: input.run.requested_by_participant_id
            ?? (persistedPrincipal ? requesterParticipantId(persistedPrincipal) : await this.legacyRequesterParticipantIdForRun(input.run))
        };
      } else if (persistedPrincipal) {
        resolved = persistedPrincipal;
      } else {
        throw new RuntimeRequestError("conflict", `run_principal_missing:${input.run.id}`);
      }
      if (input.trusted.participant && !sameParticipant(input.trusted.participant, resolved)) {
        throw new RuntimeRequestError("forbidden", `domain_participant_run_mismatch:${input.run.id}`);
      }
      return resolved;
    }
    if (input.trusted.participant) return input.trusted.participant;
    if (input.actorIdentity === "owner" || input.actorIdentity === "owner_scheduled") {
      return { kind: "human", participantId: localOwnerParticipantId };
    }
    // A paired external contact has no Core 06 participant binding yet. It
    // must not inherit the local Owner's access through a transport label.
    return { kind: "system", participantId: "system:unbound-gateway" };
  }

  /**
   * Pre-Core 06 Runs never had a requester field. They may be resumed only
   * for the local participant while that participant is still the Room Owner;
   * no transport or Agent field is reinterpreted as a human identity.
   */
  private async legacyRequesterParticipantIdForRun(run: BackendRunRecord): Promise<string> {
    requireSessionBoundRun(run);
    const session = await this.store.getSession(run.session_id);
    if (!session?.room_id) throw new RuntimeRequestError("forbidden", `legacy_run_room_missing:${run.id}`);
    const [workspaceMember, roomMember] = await Promise.all([
      this.store.getWorkspaceMember(localOwnerParticipantId),
      this.store.getRoomMember(session.room_id, localOwnerParticipantId)
    ]);
    if (workspaceMember?.role !== "owner" || roomMember?.role !== "owner") {
      throw new RuntimeRequestError("forbidden", `legacy_run_requester_unavailable:${run.id}`);
    }
    return localOwnerParticipantId;
  }

  listSurfaceRenderers(): SurfaceRendererRegistryEntry[] {
    const byId = new Map<string, SurfaceRendererRegistryEntry>();
    for (const renderer of builtinSurfaceRendererRegistryEntries) {
      byId.set(renderer.id, renderer);
    }
    for (const renderer of this.pluginRegistry.listRenderers()) {
      if (!byId.has(renderer.id)) {
        byId.set(renderer.id, renderer);
      }
    }
    return [...byId.values()];
  }

  private async runStructuredSurfaceOperation(input: StructuredSurfaceOperation): Promise<SurfaceOperationResultEnvelope<SurfaceArtifactRuntimeResult>> {
    if (!input.session_id) {
      throw new RuntimeRequestError("conflict", "surface_operation_session_required");
    }
    const session = await this.store.getSession(input.session_id);
    if (!session) {
      throw new RuntimeRequestError("not_found", `Session not found: ${input.session_id}`);
    }
    if (!session.room_id) {
      throw new RuntimeRequestError("conflict", `surface_operation_room_required:${session.id}`);
    }
    const surfaceRoomId = session.room_id;

    const settings = await this.store.getSettings();
    const inputLocale = input.input_locale ?? session.ui_locale ?? settings.ui_locale;
    const outputLocale = input.output_locale ?? session.output_locale ?? settings.output_locale;
    const sourceArtifact = input.kind === "artifact.request" && input.artifact_id
      ? await this.store.getArtifact(input.artifact_id)
      : undefined;
    if (input.kind === "artifact.request" && input.action !== "create" && !input.artifact_id) {
      throw new RuntimeRequestError("conflict", "artifact_id_required");
    }
    if (input.kind === "artifact.request" && input.action !== "create" && input.artifact_id && !sourceArtifact) {
      throw new RuntimeRequestError("not_found", `Artifact not found: ${input.artifact_id}`);
    }
    const sourceContent = sourceArtifact ? await this.store.readArtifactContent(sourceArtifact.id) : undefined;
    const result = await this.runSurfaceDomainCommand<RuntimeWriteResult<ArtifactRecord>>(
      runtimeOperationIds.artifactCreate,
      input,
      {
        title: surfaceOperationArtifactTitle(input, sourceArtifact),
        content: surfaceOperationArtifactContent(input, sourceArtifact, sourceContent),
        kind: surfaceOperationArtifactKind(input),
        input_locale: inputLocale,
        output_locale: outputLocale,
        metadata: surfaceOperationArtifactMetadata(input, sourceArtifact, sourceContent)
      }
    );

    // Core08's Artifact mutation already records a direct Activity/Change
    // trace. The legacy Surface adapter only supplies its old run-backed
    // fallback if that evidence is unavailable; it must not duplicate it.
    const existingWorkspaceChange = (await this.store.listWorkspaceChanges(session.id)).find((change) =>
      (change.domain_operation_id === result.operation.id || change.legacy_operation_id === result.operation.id)
      && change.resource_ref.id === result.resource.id
    );
    const workspaceChange = existingWorkspaceChange ?? await (async () => {
      const surfaceRun = await this.store.saveBackendRun({
        id: createId("run"),
        session_id: session.id,
        room_id: surfaceRoomId,
        input_message_id: input.id,
        backend_id: "surface-operation",
        backend_kind: "samurai_native",
        status: "completed",
        started_at: result.operation.created_at,
        completed_at: nowIso(),
        input_summary: summarize(surfaceOperationPrompt(input), 220),
        output_summary: surfaceOperationWorkspaceSummary(input, result.resource),
        metadata: {
          surface_operation_id: input.id,
          surface_operation_kind: input.kind,
          operation_id: result.operation.id
        }
      });
      const change = await this.store.saveWorkspaceChange({
        id: createId("change"),
        run_id: surfaceRun.id,
        session_id: session.id,
        room_id: surfaceRoomId,
        domain_operation_id: result.operation.id,
        resource_ref: result.resource.file_ref,
        change_type: "artifact_created",
        summary: surfaceOperationWorkspaceSummary(input, result.resource),
        created_at: nowIso()
      });
      await this.emit("workspace.change.created", change);
      return change;
    })();
    const surfaceResult: SurfaceArtifactRuntimeResult = {
      ...result,
      workspaceChange,
      ...(sourceArtifact ? { sourceArtifact } : {})
    };

    return {
      operation: input,
      result_kind: surfaceOperationResultKind(input),
      render_spec: negotiatedRenderSpec(input, surfaceArtifactRenderSpec(input, surfaceResult.resource, surfaceResult)),
      result: surfaceResult
    };
  }

  async archiveMemory(input: ArchiveMemoryInput): Promise<ArchiveMemoryRuntimeResult> {
    return await this.runtimeDomainApi.archiveMemory(input) as ArchiveMemoryRuntimeResult;
  }

  async viewSkill(input: { skillId: string; runId: string; path?: string }): Promise<SkillViewRuntimeResult> {
    return await this.runtimeDomainApi.viewSkill(input) as SkillViewRuntimeResult;
  }

  async recordSkillUsage(input: { skillId: string; runId: string; resourceId: string; contentHash: string; stage: "body_loaded" | "support_loaded"; metadata: Record<string, JsonValue> }): Promise<{ use_record: Awaited<ReturnType<RuntimeWorkspacePort["recordLearningResourceUse"]>> }> {
    return await this.runtimeDomainApi.recordSkillUsage(input) as { use_record: Awaited<ReturnType<RuntimeWorkspacePort["recordLearningResourceUse"]>> };
  }

  async recordAppliedLearningResource(input: {
    runId: string;
    resourceKind: "memory" | "wiki" | "skill";
    resourceId: string;
    resourceVersion: string;
    contentHash: string;
    decisionSummary: string;
    matchedConditions: string[];
  }): Promise<{ use_record: Awaited<ReturnType<RuntimeWorkspacePort["recordLearningResourceUse"]>> }> {
    return await this.runtimeDomainApi.recordAppliedLearningResource(input) as { use_record: Awaited<ReturnType<RuntimeWorkspacePort["recordLearningResourceUse"]>> };
  }

  async restoreLearningResourceVersion(input: {
    resourceKind: "memory" | "wiki" | "skill";
    resourceId: string;
    targetVersion: string;
    sessionId?: string;
    reason?: string;
  }): Promise<{ resource_version: Awaited<ReturnType<RuntimeWorkspacePort["saveLearningResourceVersion"]>> }> {
    return await this.runtimeDomainApi.restoreLearningResourceVersion(input) as { resource_version: Awaited<ReturnType<RuntimeWorkspacePort["saveLearningResourceVersion"]>> };
  }

  async updateLearningResourceVersion(input: {
    resourceKind: "memory" | "wiki" | "skill";
    resourceId: string;
    changeReason: string;
    sessionId?: string;
    content?: string;
    usageScope?: UsageScopeRef;
    evidenceState?: LearningEvidenceState;
    usageState?: LearningUsageState;
    pinned?: boolean;
  }): Promise<{ resource_version: Awaited<ReturnType<RuntimeWorkspacePort["saveLearningResourceVersion"]>> }> {
    return await this.runtimeDomainApi.updateLearningResourceVersion(input) as { resource_version: Awaited<ReturnType<RuntimeWorkspacePort["saveLearningResourceVersion"]>> };
  }

  async restoreRollbackPoint(id: string): Promise<RollbackRestoreRuntimeResult> {
    return await this.runtimeDomainApi.restoreRollbackPoint(id) as RollbackRestoreRuntimeResult;
  }

  async listGatewayPairingPolicies(): Promise<GatewayPairingPolicyRecord[]> {
    return this.gatewayDomainService.listPairingPolicies();
  }

  async getGatewayPairingPolicy(channel: GatewayPairingPolicyRecord["channel"]): Promise<GatewayPairingPolicyRecord> {
    return this.gatewayDomainService.getPairingPolicy(channel);
  }

  async saveGatewayPairingPolicy(policy: GatewayPairingPolicySaveInput): Promise<GatewayPairingPolicyRecord> {
    return this.gatewayDomainService.savePairingPolicy(normalizeGatewayPairingPolicyRequest(policy));
  }

  async listGatewayRoutingPolicies(): Promise<GatewayRoutingPolicyRecord[]> {
    return this.gatewayDomainService.listRoutingPolicies();
  }

  async getGatewayRoutingPolicy(channel: GatewayRoutingPolicyRecord["channel"]): Promise<GatewayRoutingPolicyRecord> {
    return this.gatewayDomainService.getRoutingPolicy(channel);
  }

  async saveGatewayRoutingPolicy(policy: GatewayRoutingPolicySaveInput): Promise<GatewayRoutingPolicyRecord> {
    return this.gatewayDomainService.saveRoutingPolicy(normalizeGatewayRoutingPolicyRequest(policy));
  }

  async approveGatewayPairing(pairingId: string): Promise<GatewayPairingRecord> {
    const result = await this.runDomainCommand({
      command_id: runtimeOperationIds.gatewayPairingApprove,
      input_source: "runtime_api",
      idempotency_key: `gateway-pairing-approve:${pairingId}`,
      payload: { pairing_id: pairingId }
    });
    return result.result as GatewayPairingRecord;
  }

  async repairGatewayState(input: { dryRun?: boolean; now?: string } = {}): Promise<GatewayRepairResult> {
    const dryRun = input.dryRun !== false;
    const checkedAt = input.now ?? nowIso();
    const [pendingPairings, acquiredLocks] = await Promise.all([
      this.store.listGatewayPairings("pending"),
      this.store.listGatewayConcurrencyLocks({ status: "acquired", limit: 500 })
    ]);
    const expiredPairings = pendingPairings.filter((pairing) =>
      pairing.expires_at && Date.parse(pairing.expires_at) <= Date.parse(checkedAt)
    );
    const expiredLocks = acquiredLocks.filter((lock) => Date.parse(lock.expires_at) <= Date.parse(checkedAt));
    const plannedActions: GatewayRepairAction[] = [
      ...expiredPairings.map((pairing) => gatewayRepairPairingAction(pairing, "planned")),
      ...expiredLocks.map((lock) => gatewayRepairLockAction(lock, "planned"))
    ];
    if (dryRun) {
      return GatewayRepairResultSchema.parse({
        dry_run: true,
        checked_at: checkedAt,
        applied_count: 0,
        actions: plannedActions
      });
    }

    const [appliedPairings, appliedLocks] = await Promise.all([
      this.gatewayDomainService.expirePairingsPrimitive(checkedAt),
      this.store.expireGatewayConcurrencyLocks(checkedAt)
    ]);
    const appliedPairingIds = new Set(appliedPairings.map((pairing) => pairing.id));
    const appliedLockKeys = new Set(appliedLocks.map((lock) => lock.lock_key));
    const actions: GatewayRepairAction[] = [
      ...expiredPairings.map((pairing) => gatewayRepairPairingAction(
        pairing,
        appliedPairingIds.has(pairing.id) ? "applied" : "skipped",
        appliedPairings.find((applied) => applied.id === pairing.id)
      )),
      ...expiredLocks.map((lock) => gatewayRepairLockAction(
        lock,
        appliedLockKeys.has(lock.lock_key) ? "applied" : "skipped",
        appliedLocks.find((applied) => applied.lock_key === lock.lock_key)
      ))
    ];
    return GatewayRepairResultSchema.parse({
      dry_run: false,
      checked_at: checkedAt,
      applied_count: actions.filter((action) => action.status === "applied").length,
      actions
    });
  }

  async recreateGatewaySandboxInstance(idOrKey: string): Promise<GatewaySandboxInstanceRecord> {
    const instance = await this.store.getGatewaySandboxInstance(idOrKey);
    if (!instance) {
      throw new RuntimeRequestError("not_found", `Gateway sandbox instance not found: ${idOrKey}`);
    }
    const now = nowIso();
    const lifecycle = await executeSandboxLifecycleAction(
      instance.sandbox,
      {
        action: "recreate",
        instance_key: instance.instance_key,
        remote_workspace_root: remoteWorkspaceRootForSandboxInstance(instance),
        timeout_ms: instance.sandbox.timeout_ms,
        metadata: instance.metadata
      },
      createSandboxLifecycleAdapter()
    );
    const recreated: GatewaySandboxInstanceRecord = {
      ...instance,
      status: lifecycle.status === "failed" ? "failed" : "recreated",
      updated_at: now,
      last_used_at: now,
      deleted_at: undefined,
      metadata: {
        ...instance.metadata,
        lifecycle_action: "recreate",
        lifecycle_status: lifecycle.status,
        lifecycle_reason: lifecycle.reason ?? null,
        lifecycle_error: lifecycle.error ?? null,
        lifecycle_command: lifecycle.command ?? null,
        lifecycle_resource_refs: (lifecycle.resource_refs ?? []) as unknown as JsonValue
      }
    };
    return this.store.saveGatewaySandboxInstance(recreated);
  }

  async deleteGatewaySandboxInstance(idOrKey: string): Promise<GatewaySandboxInstanceRecord> {
    const instance = await this.store.getGatewaySandboxInstance(idOrKey);
    if (!instance) {
      throw new RuntimeRequestError("not_found", `Gateway sandbox instance not found: ${idOrKey}`);
    }
    const now = nowIso();
    const lifecycle = await executeSandboxLifecycleAction(
      instance.sandbox,
      {
        action: "delete",
        instance_key: instance.instance_key,
        remote_workspace_root: remoteWorkspaceRootForSandboxInstance(instance),
        timeout_ms: instance.sandbox.timeout_ms,
        metadata: instance.metadata
      },
      createSandboxLifecycleAdapter()
    );
    const deleted: GatewaySandboxInstanceRecord = {
      ...instance,
      status: lifecycle.status === "failed" ? "failed" : "deleted",
      updated_at: now,
      deleted_at: lifecycle.status === "failed" ? instance.deleted_at : now,
      metadata: {
        ...instance.metadata,
        lifecycle_action: "delete",
        lifecycle_status: lifecycle.status,
        lifecycle_reason: lifecycle.reason ?? null,
        lifecycle_error: lifecycle.error ?? null,
        lifecycle_command: lifecycle.command ?? null,
        lifecycle_resource_refs: (lifecycle.resource_refs ?? []) as unknown as JsonValue
      }
    };
    return this.store.saveGatewaySandboxInstance(deleted);
  }

  async syncGatewaySandboxWorkspace(
    idOrKey: string,
    input: { direction?: GatewaySandboxWorkspaceSyncDirection; dryRun?: boolean } = {}
  ): Promise<GatewaySandboxWorkspaceSyncResult> {
    const instance = await this.store.getGatewaySandboxInstance(idOrKey);
    if (!instance) {
      throw new RuntimeRequestError("not_found", `Gateway sandbox instance not found: ${idOrKey}`);
    }
    if (instance.status === "deleted") {
      throw new RuntimeRequestError("conflict", "gateway_sandbox_instance_deleted");
    }
    const dryRun = input.dryRun !== false;
    const now = nowIso();
    const direction = input.direction ?? defaultSandboxWorkspaceSyncDirection(instance);
    const workspaceRoot = instance.workspace_root?.trim() || undefined;
    const remoteWorkspaceRoot = remoteWorkspaceRootForSandboxInstance(instance);
    const worktreeRootError = sandboxWorktreeRootError(workspaceRoot, this.store.rootDir);
    const execution = dryRun
      ? undefined
      : worktreeRootError || !workspaceRoot
        ? undefined
        : await executeSandboxWorkspaceSync(
          instance.sandbox,
          {
            direction,
            workspace_root: workspaceRoot,
            remote_workspace_root: remoteWorkspaceRoot,
            timeout_ms: instance.sandbox.timeout_ms,
            metadata: instance.metadata
          },
          createSandboxWorkspaceSyncAdapter({ workspaceRootRole: "agent_worktree", coreWorkspaceRoot: this.store.rootDir })
        );
    const sync: GatewaySandboxWorkspaceSyncRecord = {
      id: createId("gateway_sandbox_sync"),
      instance_id: instance.id,
      instance_key: instance.instance_key,
      direction,
      status: dryRun ? "planned" : worktreeRootError ? "failed" : executionStatusForWorkspaceSync(execution),
      workspace_root: workspaceRoot,
      remote_workspace_root: remoteWorkspaceRoot,
      file_count: execution?.file_count,
      byte_count: execution?.byte_count,
      error: worktreeRootError ?? execution?.error,
      started_at: now,
      completed_at: dryRun ? undefined : now,
      metadata: {
        sandbox_backend: instance.backend,
        sandbox_scope: instance.scope,
        sandbox_mode: instance.sandbox.mode,
        workspace_access: instance.sandbox.workspace_access,
        network_access: instance.sandbox.network_access,
        sync_adapter: "gateway",
        sync_reason: worktreeRootError ?? execution?.reason ?? null,
        resource_refs: (execution?.resource_refs ?? []) as unknown as JsonValue,
        requires_external_daemon: instance.backend === "ssh" || instance.backend === "remote",
        dry_run: dryRun
      }
    };
    const parsed = GatewaySandboxWorkspaceSyncResultSchema.parse({
      dry_run: dryRun,
      sync
    });
    if (dryRun) {
      return parsed;
    }
    const saved = await this.store.saveGatewaySandboxWorkspaceSync(parsed.sync);
    return GatewaySandboxWorkspaceSyncResultSchema.parse({
      dry_run: false,
      sync: saved
    });
  }

  async handleGatewayInbound(input: GatewayInboundInput): Promise<GatewayInboundRuntimeResult> {
    return routeGatewayInbound<GatewayInboundRuntimeResult>({ run: (request) => this.runDomainCommand(request) }, input);
  }


  private async enqueueGatewayReplyDeliveries(input: { channel: GatewayChannel; inbound: GatewayInboundMessageRecord; sessionKey: string; chat: RunChatTurnResult }): Promise<GatewayDeliveryRecord[]> {
    const text = [...input.chat.messages].reverse().find((message) => message.role === "agent")?.content ?? "";
    const payloads = buildGatewayReplyPayloads(text, input.chat.artifacts, input.channel);
    const now = nowIso();
    return Promise.all(payloads.map((payload, index) => this.store.enqueueGatewayDelivery({
      id: createId("gateway_delivery"),
      inbound_id: input.inbound.id,
      session_key: input.sessionKey,
      channel: input.channel,
      status: "pending",
      idempotency_key: `gateway-reply:${input.inbound.id}:${index + 1}`,
      payload,
      attempt: 0,
      max_attempts: 3,
      created_at: now,
      updated_at: now
    })));
  }

  private async acquireGatewayConcurrencyLock(
    policy: GatewayBoundaryPolicy,
    inbound: GatewayInboundMessageRecord
  ): Promise<{ acquired: true; lock: GatewayConcurrencyLockRecord } | { acquired: false; lock: GatewayConcurrencyLockRecord }> {
    const lockPolicy = policy.concurrency_lock;
    if (!lockPolicy) {
      const now = nowIso();
      return {
        acquired: true,
        lock: {
          id: createId("gateway_lock"),
          lock_key: `${policy.session_key}:none`,
          scope: "session",
          policy_id: policy.id,
          owner_ref: gatewayInboundRef(inbound),
          status: "released",
          acquired_at: now,
          expires_at: now,
          released_at: now,
          metadata: {}
        }
      };
    }
    return this.store.acquireGatewayConcurrencyLock({
      lockKey: lockPolicy.key,
      scope: lockPolicy.scope,
      policyId: policy.id,
      ownerRef: gatewayInboundRef(inbound),
      ttlMs: lockPolicy.ttl_ms,
      metadata: {
        source_channel: policy.source_channel,
        source_identity: policy.source_identity ?? null
      }
    });
  }

  private async ensureGatewaySandboxInstance(policy: GatewayBoundaryPolicy): Promise<GatewaySandboxInstanceRecord | undefined> {
    if (policy.sandbox.mode === "off" || policy.sandbox.backend === "none") {
      return undefined;
    }
    const now = nowIso();
    const instanceKey = gatewaySandboxInstanceKey(policy);
    const existing = await this.store.getGatewaySandboxInstance(instanceKey);
    const instance: GatewaySandboxInstanceRecord = {
      id: existing?.id ?? createId("gateway_sandbox"),
      instance_key: instanceKey,
      scope: policy.sandbox.scope,
      backend: policy.sandbox.backend,
      status: "ready",
      sandbox: policy.sandbox,
      session_key: policy.sandbox.scope === "session" ? policy.session_key : undefined,
      owner_ref: gatewayBoundaryPolicyRef(policy),
      workspace_root: typeof policy.sandbox.metadata.workspace_root === "string"
        ? policy.sandbox.metadata.workspace_root
        : undefined,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_used_at: now,
      deleted_at: undefined,
      metadata: {
        ...(existing?.metadata ?? {}),
        source_channel: policy.source_channel,
        source_identity: policy.source_identity ?? null,
        boundary_policy_id: policy.id
      }
    };
    return this.store.saveGatewaySandboxInstance(instance);
  }

  async saveAutomationJob(input: {
    title: string;
    kind: AutomationJobRecord["kind"];
    schedule: string;
    target_instruction: string;
    delivery_target?: Record<string, JsonValue>;
    enabled?: boolean;
    next_run_at?: string;
    max_attempts?: number;
  }): Promise<AutomationJobRuntimeResult> {
    // Native compatibility picks the persisted local Room before the command;
    // the public DTO itself never chooses a Room or Authority.
    const result = await this.runDomainCommandWithTrustedContext({
      command_id: runtimeOperationIds.automationJobSave,
      input_source: "runtime_api",
      idempotency_key: `automation_job_save:${stableHash(input)}`,
      payload: input
    }, await this.collectionCompatibilityContext());
    return result.result as AutomationJobRuntimeResult;
  }

  previewAutomationSchedule(schedule: string, from = nowIso()): AutomationSchedulePreview {
    const normalized = schedule.trim().toLowerCase() || "daily";
    const parsedFrom = Date.parse(from);
    const fromMs = Number.isFinite(parsedFrom) ? parsedFrom : Date.now();
    return {
      schedule,
      normalized,
      from: new Date(fromMs).toISOString(),
      one_shot: isOneShotSchedule(normalized),
      next_run_at: nextRunFromSchedule(normalized, fromMs)
    };
  }

  async runDueAutomationJobs(
    now = nowIso(),
    context: Pick<TrustedDomainRuntimeContext, "signal" | "deadlineAt"> = {}
  ): Promise<AutomationRunRuntimeResult[]> {
    assertTrustedRuntimeContextActive(context);
    await this.core09AutomationDomainService.recoverInterruptedRuns(now);
    assertTrustedRuntimeContextActive(context);
    const jobs = await this.store.listAutomationJobs({ dueAt: now, enabledOnly: true });
    assertTrustedRuntimeContextActive(context);
    return runDueAutomation<AutomationRunRuntimeResult>({
      dispatcher: { run: (request, ingress) => this.runDomainCommandWithTrustedContext(request, ingress ?? context) },
      jobs,
      now,
      signal: context.signal,
      deadlineAt: context.deadlineAt,
      isLockedError: (error) => error instanceof RuntimeRequestError && error.message === "automation_job_locked"
    });
  }

  async applyReflectionSuggestion(input: { suggestionId: string; sessionId?: string }): Promise<RuntimeWriteResult<MemoryFrontmatter | WikiWithFilePath | SkillWithFilePath>> {
    return await this.runtimeDomainApi.applyReflectionSuggestion(input) as RuntimeWriteResult<MemoryFrontmatter | WikiWithFilePath | SkillWithFilePath>;
  }

  async createSkillCandidate(input: {
    title: string;
    description: string;
    content: string;
    tags?: string[];
    required_capabilities?: string[];
    source_refs?: SkillFrontmatter["source_refs"];
    provenance_detail?: SkillFrontmatter["provenance_detail"];
    usage_scope?: SkillFrontmatter["usage_scope"];
  }): Promise<SkillRuntimeResult> {
    return await this.runtimeDomainApi.createSkillCandidate(input) as SkillRuntimeResult;
  }

  async saveSkillProject(input: { candidateId: string }): Promise<SkillRuntimeResult> {
    return await this.runtimeDomainApi.saveSkillProject(input) as SkillRuntimeResult;
  }

  async saveSkillSupportFile(input: { skillId: string; path: string; content: string }): Promise<SkillSupportRuntimeResult> {
    return await this.runtimeDomainApi.saveSkillSupportFile(input) as SkillSupportRuntimeResult;
  }

  async createWikiProposal(input: {
    title: string;
    content: string;
    slug?: string;
    tags?: string[];
    content_locale?: SupportedLocale;
    source_refs?: WikiFrontmatter["source_refs"];
    provenance?: WikiFrontmatter["provenance"];
  }): Promise<WikiRuntimeResult> {
    return await this.runtimeDomainApi.createWikiProposal(input) as WikiRuntimeResult;
  }

  async acceptWikiPage(id: string): Promise<WikiRuntimeResult> {
    return await this.runtimeDomainApi.wikiAction("accept", id) as WikiRuntimeResult;
  }

  async rejectWikiPage(id: string): Promise<WikiRuntimeResult> {
    return await this.runtimeDomainApi.wikiAction("reject", id) as WikiRuntimeResult;
  }

  async archiveWikiPage(id: string): Promise<WikiRuntimeResult> {
    return await this.runtimeDomainApi.wikiAction("archive", id) as WikiRuntimeResult;
  }

  async patchWikiPage(input: {
    id: string;
    title?: string;
    content?: string;
    tags?: string[];
    content_locale?: SupportedLocale;
    source_refs?: WikiFrontmatter["source_refs"];
    provenance?: WikiFrontmatter["provenance"];
  }): Promise<WikiRuntimeResult> {
    return await this.runtimeDomainApi.patchWikiPage(input) as WikiRuntimeResult;
  }

  async reindexWiki(): Promise<RuntimeWriteResult<WikiReindexResult>> {
    return await this.runtimeDomainApi.reindexWiki() as RuntimeWriteResult<WikiReindexResult>;
  }

  async saveCollectionSchema(schema: CollectionSchema): Promise<CollectionSchemaRuntimeResult> {
    return await this.runLocalCollectionCommand(runtimeOperationIds.collectionSchemaSave, schema, createId("collection_schema_save_request"));
  }

  async reindexCollections(): Promise<CollectionReindexRuntimeResult> {
    return await this.runLocalCollectionCommand(requireDomainCommandEntry("collection.reindex").id, {}, createId("collection_reindex_request"));
  }

  async createCollectionRecord(record: CollectionRecord): Promise<CollectionRecordRuntimeResult> {
    return await this.runLocalCollectionCommand(collectionRecordCreateCommandId(), {
      collection_id: record.collection_id,
      record_id: record.id,
      data: record.data,
      resource_refs: record.resource_refs
    }, `collection_record_create_request:${stableHash(record)}`);
  }

  private async collectionManageGetItems(schema: CollectionSchemaWithFilePath, options: { ids?: string[]; fields?: string[] } = {}): Promise<{
    collection_id: string; count: number; items: Record<string, JsonValue>[]; linked_data: JsonValue; schema_fields: JsonValue;
  }> {
    const access = await this.collectionReadAccess(schema.id);
    await this.assertCollectionResource(access, "collection_schema", schema.id);
    const candidates = options.ids && options.ids.length > 0
      ? (await Promise.all(options.ids.map((id) => this.getAccessibleCollectionRecord(access, schema.id, id)))).filter((record): record is CollectionRecordWithFilePath => Boolean(record))
      : await this.listAccessibleCollectionRecords(access, schema.id);
    const loaded = await this.filterCollectionRecordsForRoom(access, candidates);
    const linkedData = await this.genericCollectionLinkedData(schema, loaded, access);
    const records = loaded.map((record) => genericCollectionRecordRenderData(record, schema, loaded, linkedData));
    const projected = options.fields && options.fields.length > 0
      ? records.map((record) => projectCollectionManageFields(record, options.fields ?? []))
      : records;
    return {
      collection_id: schema.id,
      count: projected.length,
      items: projected,
      linked_data: linkedData as unknown as JsonValue,
      schema_fields: genericCollectionSchemaFields(schema, linkedData) as unknown as JsonValue
    };
  }

  private async collectionActionResolvedRecordData(schema: CollectionSchemaWithFilePath, record: CollectionRecordWithFilePath): Promise<Record<string, JsonValue> | undefined> {
    const result = await this.collectionManageGetItems(schema, { ids: [record.id] });
    const items = Array.isArray(result.items) ? result.items : [];
    const item = recordPayload(items[0]);
    return Object.keys(item).length > 0 ? item : undefined;
  }

  async presentCollectionView(input: { collectionId: string; viewId?: string }): Promise<CollectionViewRuntimeResult & { render_spec: SurfaceRenderSpec }> {
    const access = await this.collectionReadAccess(input.collectionId);
    const schema = await this.getAccessibleCollectionSchema(input.collectionId, access);
    if (!schema) {
      throw new RuntimeRequestError("not_found", `Collection schema not found: ${input.collectionId}`);
    }
    const records = await this.listAccessibleCollectionRecords(access, input.collectionId);
    const linkedData = await this.genericCollectionLinkedData(schema, records, access);
    const renderSpec = genericCollectionRenderSpec(schema, records, input.viewId, linkedData);
    return {
      collection_id: input.collectionId,
      view_id: String(renderSpec.props.view_id ?? input.viewId ?? "default"),
      schema,
      record_count: records.length,
      render_spec: renderSpec
    };
  }

  async runCollectionManageCompatibility(
    input: Record<string, JsonValue>,
    inputSource: DomainCommandInputSource,
    idempotencyKey?: string,
    trusted: TrustedDomainRuntimeContext = {}
  ): Promise<JsonValue> {
    if (!this.activeCollectionRoomAccess()) {
      const context = await this.trustedDomainContext(inputSource, {}, trusted);
      if (!context.participant || !context.roomId) {
        throw new RuntimeRequestError("forbidden", "room_context_required");
      }
      try {
        await this.roomAuthorizationService.assertRoom(context.participant, context.roomId, "read");
      } catch (error) {
        if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
        throw error;
      }
      return this.activeDomainContext.run(context, () =>
        this.runCollectionManageCompatibility(input, inputSource, idempotencyKey, trusted)
      );
    }
    const action = stringPayload(input.action);
    const collectionId = stringPayload(input.collection_id) || stringPayload(input.slug) || stringPayload(input.id);
    if (action === "schemaDocs") {
      const result = await this.runDomainQuery({
        query_id: collectionSchemaDocsQueryId(),
        input_source: inputSource,
        payload: {}
      }, trusted);
      return jsonSafe({ action, ...(unknownRecord(result.result)) });
    }
    if (action === "getSchema") {
      const result = await this.runDomainQuery({
        query_id: collectionSchemaQueryId(),
        input_source: inputSource,
        payload: { collection_id: collectionId }
      }, trusted);
      return jsonSafe({ action, ...(unknownRecord(result.result)) });
    }
    if (action === "getItems") {
      const ids = jsonStringArray(input.ids);
      const fields = jsonStringArray(input.fields);
      const result = await this.runDomainQuery({
        query_id: collectionRecordsQueryId(),
        input_source: inputSource,
        payload: {
          collection_id: collectionId,
          ...(ids ? { ids } : {}),
          ...(fields ? { fields } : {})
        }
      }, trusted);
      return jsonSafe({ action, ...(unknownRecord(result.result)) });
    }
    if (action === "putSchema") {
      const schemaInput = recordPayload(input.schema) && Object.keys(recordPayload(input.schema)).length > 0
        ? recordPayload(input.schema)
        : input;
      const schema = CollectionSchemaSchema.parse(schemaInput);
      const result = await this.runDomainCommand({
        command_id: collectionSchemaSaveCommandId(),
        input_source: inputSource,
        idempotency_key: idempotencyKey,
        payload: schema as unknown as Record<string, unknown>
      }, trusted);
      const resource = unknownRecord(unknownRecord(result.result).resource);
      return jsonSafe({ action, collection_id: schema.id, schema: Object.keys(resource).length > 0 ? resource : result.result, status: "written" });
    }
    if (!collectionId) {
      throw new RuntimeRequestError("conflict", "collection_manage_collection_id_required");
    }
    const schemaResult = await this.runDomainQuery({
      query_id: collectionSchemaQueryId(),
      input_source: inputSource,
      payload: { collection_id: collectionId }
    }, trusted);
    const schemaRecord = unknownRecord(unknownRecord(schemaResult.result).schema);
    const schema = CollectionSchemaSchema.parse(schemaRecord);
    if (action === "patchSchema") {
      const patches = validateAppEditPatch(input.patches ?? input.patch, schema);
      const nextSchema = buildAppEditPatchedSchema(schema, patches, { viewId: stringPayload(input.view_id) });
      if (!nextSchema) {
        return jsonSafe({ action, collection_id: schema.id, status: "unchanged", schema });
      }
      const result = await this.runDomainCommand({
        command_id: collectionSchemaSaveCommandId(),
        input_source: inputSource,
        idempotency_key: idempotencyKey,
        payload: nextSchema as unknown as Record<string, unknown>
      }, trusted);
      const resource = unknownRecord(unknownRecord(result.result).resource);
      return jsonSafe({ action, collection_id: schema.id, status: "patched", schema: Object.keys(resource).length > 0 ? resource : result.result });
    }
    if (action === "putItems") {
      const items = Array.isArray(input.items)
        ? input.items.filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item) && isJsonValue(item))
        : [];
      if (items.length === 0) throw new RuntimeRequestError("conflict", "collection_manage_items_required");
      return jsonSafe({ action, ...(await this.collectionManagePutItemsViaCommands(schema, items, collectionManagePutMode(input.mode), inputSource, idempotencyKey, trusted)) });
    }
    throw new RuntimeRequestError("conflict", `collection_manage_action_unsupported:${action || "missing"}`);
  }

  private async collectionManagePutItemsViaCommands(
    schema: CollectionSchema,
    items: Array<Record<string, JsonValue>>,
    mode: "create" | "upsert" | "merge",
    inputSource: DomainCommandInputSource,
    idempotencyKey?: string,
    trusted: TrustedDomainRuntimeContext = {}
  ): Promise<Record<string, JsonValue>> {
    const access = await this.collectionWriteAccess(schema.id);
    const written: string[] = [];
    const rejected: Array<Record<string, JsonValue>> = [];
    for (const item of items) {
      const recordId = stringPayload(item.id) || stringPayload(item.record_id);
      if (!recordId) {
        rejected.push({ id: "(missing)", problem: "record_id_required" });
        continue;
      }
      const computedProblem = collectionComputedWriteProblem(schema, item);
      if (computedProblem) {
        rejected.push({ id: recordId, problem: computedProblem });
        continue;
      }
      try {
        const boundaryId = collectionRecordBoundaryId(schema.id, recordId);
        const boundary = await this.store.getResourceAccessBoundary("collection_record", boundaryId);
        let existing: CollectionRecordWithFilePath | undefined;
        if (boundary) {
          await this.assertCollectionResourceForAction(access, "edit", "collection_record", boundaryId);
          existing = await this.store.getCollectionRecord(schema.id, recordId);
        } else {
          try {
            // Only the current Workspace Owner may inspect an unbounded
            // legacy record. A Room editor may still create a fresh record
            // beneath a Collection schema they can edit.
            await this.assertCollectionResourceForAction(access, "edit", "collection_record", boundaryId);
            existing = await this.store.getCollectionRecord(schema.id, recordId);
          } catch (error) {
            if (mode === "merge") throw error;
          }
        }
        if (mode === "create" && existing) {
          rejected.push({ id: recordId, problem: "record_already_exists" });
          continue;
        }
        if (mode === "merge" && !existing) {
          rejected.push({ id: recordId, problem: "record_not_found" });
          continue;
        }
        const data = mode === "merge" && existing
          ? { ...existing.data, ...collectionManageRecordData(item) }
          : collectionManageRecordData(item);
        if (existing && mode !== "create") {
          await this.runDomainCommand({
            command_id: collectionRecordPatchCommandId(),
            input_source: inputSource,
            idempotency_key: idempotencyKey ? `${idempotencyKey}:${recordId}` : undefined,
            payload: {
              collection_id: schema.id,
              record_id: recordId,
              patch_id: `${recordId}:${stableHash(data)}`,
              expected_version: existing.version,
              changes: data
            }
          }, trusted);
        } else {
          await this.runDomainCommand({
            command_id: collectionRecordCreateCommandId(),
            input_source: inputSource,
            idempotency_key: idempotencyKey ? `${idempotencyKey}:${recordId}` : undefined,
            payload: {
              collection_id: schema.id,
              record_id: recordId,
              data,
              resource_refs: resourceRefsPayload(item.resource_refs)
            }
          }, trusted);
        }
        written.push(recordId);
      } catch (error) {
        rejected.push({ id: recordId, problem: safeRuntimeErrorMessage(error, "collection_record_write_failed") });
      }
    }
    return { collection_id: schema.id, mode, written, rejected };
  }

  private activeCollectionRoomAccess(): { principal: ParticipantPrincipal; roomId: string } | undefined {
    const context = this.activeDomainContext.getStore();
    return context?.participant && context.roomId
      ? { principal: context.participant, roomId: context.roomId }
      : undefined;
  }

  /**
   * Collection calls outside a Domain operation are legacy local-Owner
   * adapters. They resolve a concrete source/default Room first; they never
   * fall back to a Workspace-wide Collection scan.
   */
  private async collectionReadAccess(collectionId?: string): Promise<{ principal: ParticipantPrincipal; roomId: string }> {
    const active = this.activeCollectionRoomAccess();
    if (active) return active;
    if (collectionId) {
      const boundary = await this.store.getResourceAccessBoundary("collection_schema", collectionId);
      if (boundary) {
        const access = { principal: { kind: "human" as const, participantId: localOwnerParticipantId }, roomId: boundary.source_room_id };
        try {
          await this.roomAuthorizationService.assertResource(access.principal, {
            roomId: access.roomId,
            action: "read",
            resourceKind: "collection_schema",
            resourceId: collectionId
          });
        } catch (error) {
          if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
          throw error;
        }
        return access;
      }
    }
    return this.localOwnerContextAccess();
  }

  private async listActiveCollectionSchemas(): Promise<CollectionSchemaWithFilePath[]> {
    const access = await this.collectionReadAccess();
    return this.listCurrentRoomResources(access, "collection_schema", (candidates) => this.store.listCollectionSchemas(candidates));
  }

  private async getAccessibleCollectionSchema(
    collectionId: string,
    access?: { principal: ParticipantPrincipal; roomId: string }
  ): Promise<CollectionSchemaWithFilePath | undefined> {
    const resolvedAccess = access ?? await this.collectionReadAccess(collectionId);
    await this.assertCollectionResource(resolvedAccess, "collection_schema", collectionId);
    return this.store.getCollectionSchema(collectionId);
  }

  private async assertCollectionResource(
    access: { principal: ParticipantPrincipal; roomId: string },
    resourceKind: "collection_schema" | "collection_record",
    resourceId: string
  ): Promise<void> {
    try {
      await this.roomAuthorizationService.assertResource(access.principal, {
        roomId: access.roomId,
        action: "read",
        resourceKind,
        resourceId
      });
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
  }

  private async assertCollectionResourceForAction(
    access: { principal: ParticipantPrincipal; roomId: string },
    action: "read" | "edit" | "execute",
    resourceKind: "collection_schema" | "collection_record",
    resourceId: string
  ): Promise<void> {
    try {
      await this.roomAuthorizationService.assertResource(access.principal, {
        roomId: access.roomId,
        action,
        resourceKind,
        resourceId
      });
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
  }

  private async collectionWriteAccess(collectionId: string): Promise<{ principal: ParticipantPrincipal; roomId: string }> {
    const access = await this.collectionReadAccess(collectionId);
    await this.assertCollectionResourceForAction(access, "edit", "collection_schema", collectionId);
    return access;
  }

  private async collectionResourceAllowed(
    access: { principal: ParticipantPrincipal; roomId: string },
    resourceKind: "collection_schema" | "collection_record",
    resourceId: string
  ): Promise<boolean> {
    try {
      await this.assertCollectionResource(access, resourceKind, resourceId);
      return true;
    } catch (error) {
      if (error instanceof RuntimeRequestError && error.code === "forbidden") return false;
      throw error;
    }
  }

  private async filterCollectionRecordsForRoom(
    access: { principal: ParticipantPrincipal; roomId: string },
    records: CollectionRecordWithFilePath[]
  ): Promise<CollectionRecordWithFilePath[]> {
    // The caller has already queried only Room-bound candidates. This is the
    // mandatory second check immediately before a record reaches a renderer.
    const allowed = await Promise.all(records.map(async (record) =>
      await this.collectionResourceAllowed(access, "collection_record", collectionRecordBoundaryId(record.collection_id, record.id))
        ? record
        : undefined
    ));
    return allowed.filter((record): record is CollectionRecordWithFilePath => Boolean(record));
  }

  private async listAccessibleCollectionRecords(
    access: { principal: ParticipantPrincipal; roomId: string },
    collectionId: string
  ): Promise<CollectionRecordWithFilePath[]> {
    const candidates = await this.roomAuthorizationService.resourceCandidateAccess(
      access.principal,
      access.roomId,
      "collection_record"
    );
    return this.filterCollectionRecordsForRoom(
      access,
      await this.store.listCollectionRecords(collectionId, candidates)
    );
  }

  private async getAccessibleCollectionRecord(
    access: { principal: ParticipantPrincipal; roomId: string },
    collectionId: string,
    recordId: string
  ): Promise<CollectionRecordWithFilePath | undefined> {
    const boundaryId = collectionRecordBoundaryId(collectionId, recordId);
    if (!await this.collectionResourceAllowed(access, "collection_record", boundaryId)) return undefined;
    return this.store.getCollectionRecord(collectionId, recordId);
  }

  private async resolveCollectionRecordRefs(
    collectionId: string,
    recordId: string,
    access?: { principal: ParticipantPrincipal; roomId: string }
  ): Promise<CollectionRecordResolution> {
    const resolvedAccess = access ?? await this.collectionReadAccess(collectionId);
    await this.assertCollectionResource(resolvedAccess, "collection_schema", collectionId);
    await this.assertCollectionResource(resolvedAccess, "collection_record", collectionRecordBoundaryId(collectionId, recordId));
    const candidates = await this.roomAuthorizationService.resourceCandidateAccess(resolvedAccess.principal, resolvedAccess.roomId, "collection_record");
    const resolution = await this.store.resolveCollectionRecordRefs(collectionId, recordId, candidates);
    const resolvedRefs = (await Promise.all(resolution.resolved_refs.map(async (ref) =>
      await this.collectionResourceAllowed(resolvedAccess, "collection_record", collectionRecordBoundaryId(ref.target_collection_id, ref.target_record_id))
        ? ref
        : undefined
    ))).filter((ref): ref is CollectionRecordResolution["resolved_refs"][number] => Boolean(ref));
    return { ...resolution, resolved_refs: resolvedRefs };
  }

  /** Legacy HTTP adapter with an explicit Room/session selector and final recheck. */
  async resolveLocalOwnerCollectionRecordRefs(input: {
    collectionId: string;
    recordId: string;
    roomId?: string;
    sessionId?: string;
  }): Promise<CollectionRecordResolution> {
    const resourceId = collectionRecordBoundaryId(input.collectionId, input.recordId);
    const { roomId } = await this.assertLocalOwnerRoomAccess({
      ...(input.roomId ? { roomId: input.roomId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      resource: { kind: "collection_record", id: resourceId }
    });
    const access = { principal: { kind: "human" as const, participantId: localOwnerParticipantId }, roomId };
    return this.resolveCollectionRecordRefs(input.collectionId, input.recordId, access);
  }

  private async genericCollectionLinkedData(
    schema: CollectionSchema,
    records: CollectionRecordWithFilePath[] = [],
    access: { principal: ParticipantPrincipal; roomId: string }
  ): Promise<GenericCollectionLinkedData> {
    const refOptions: Record<string, Array<Record<string, JsonValue>>> = {};
    const refRecords: Record<string, Record<string, Record<string, JsonValue>>> = {};
    const embedRecords: Record<string, Record<string, JsonValue> | null> = {};
    const targetCollections = new Set<string>();
    const missingRefs: Array<Record<string, JsonValue>> = [];
    for (const ref of schema.refs) {
      const field = collectionDefinitionFieldRuntime(ref);
      if (!field) {
        continue;
      }
      const targetCollectionId = collectionDefinitionStringRuntime(ref, "collection_id")
        ?? collectionDefinitionStringRuntime(ref, "target_collection_id")
        ?? schema.id;
      if (!await this.collectionResourceAllowed(access, "collection_schema", targetCollectionId)) continue;
      const [targetSchema, permittedRecords] = await Promise.all([
        this.getAccessibleCollectionSchema(targetCollectionId, access),
        this.listAccessibleCollectionRecords(access, targetCollectionId)
      ]);
      targetCollections.add(targetCollectionId);
      const targetRecordIds = new Set(permittedRecords.map((record) => record.id));
      refOptions[field] = permittedRecords.map((record) => genericCollectionRefOption(record));
      refRecords[field] = Object.fromEntries(permittedRecords.map((record) => [
        record.id,
        genericCollectionRecordRenderData(record, targetSchema ?? schema, permittedRecords)
      ]));
      const refId = collectionDefinitionStringRuntime(ref, "id") ?? field;
      for (const record of records) {
        const targetRecordId = record.data[field];
        if (typeof targetRecordId !== "string" || !targetRecordId.trim() || targetRecordIds.has(targetRecordId)) {
          continue;
        }
        missingRefs.push({
          collection_id: schema.id,
          record_id: record.id,
          field,
          ref_id: refId,
          target_collection_id: targetCollectionId,
          target_record_id: targetRecordId,
          message: `Missing referenced record: ${targetCollectionId}/${targetRecordId}`
        });
      }
    }
    for (const embed of schema.embeds) {
      const field = collectionDefinitionFieldRuntime(embed);
      if (!field) {
        continue;
      }
      const targetCollectionId = collectionDefinitionStringRuntime(embed, "collection_id")
        ?? collectionDefinitionStringRuntime(embed, "target_collection_id")
        ?? collectionDefinitionStringRuntime(embed, "to");
      const targetRecordId = collectionDefinitionStringRuntime(embed, "record_id")
        ?? collectionDefinitionStringRuntime(embed, "target_record_id")
        ?? collectionDefinitionStringRuntime(embed, "target_id");
      if (!targetCollectionId || !targetRecordId) {
        continue;
      }
      if (!await this.collectionResourceAllowed(access, "collection_schema", targetCollectionId)) continue;
      const [targetSchema, permittedTarget] = await Promise.all([
        this.getAccessibleCollectionSchema(targetCollectionId, access),
        this.getAccessibleCollectionRecord(access, targetCollectionId, targetRecordId)
      ]);
      targetCollections.add(targetCollectionId);
      embedRecords[field] = permittedTarget ? genericCollectionRecordRenderData(permittedTarget, targetSchema ?? schema, [permittedTarget]) : null;
      if (!permittedTarget) {
        missingRefs.push({
          collection_id: schema.id,
          field,
          embed_id: collectionDefinitionStringRuntime(embed, "id") ?? field,
          target_collection_id: targetCollectionId,
          target_record_id: targetRecordId,
          message: `Missing embedded record: ${targetCollectionId}/${targetRecordId}`
        });
      }
    }
    return {
      ref_options: refOptions,
      ref_records: refRecords,
      embed_records: embedRecords,
      target_collection_ids: [...targetCollections],
      missing_refs: missingRefs
    };
  }

  async applyCollectionPatch(input: { collectionId: string; recordId: string; patch: CollectionPatch }): Promise<CollectionPatchRuntimeResult> {
    const access = await this.collectionWriteAccess(input.collectionId);
    await this.assertCollectionResourceForAction(access, "edit", "collection_record", collectionRecordBoundaryId(input.collectionId, input.recordId));
    const expectedVersion = input.patch.expected_version
      ?? (await this.store.getCollectionRecord(input.collectionId, input.recordId))?.version;
    if (expectedVersion === undefined) {
      throw new RuntimeRequestError("not_found", `Collection record not found: ${input.collectionId}/${input.recordId}`);
    }
    const payload = {
      collection_id: input.collectionId,
      record_id: input.recordId,
      patch_id: input.patch.id,
      changes: input.patch.changes,
      expected_version: expectedVersion
    };
    return await this.runLocalCollectionCommand(runtimeOperationIds.collectionPatchApply, payload, `collection_patch_apply:${stableHash(payload)}`);
  }

  async deleteCollectionRecord(input: { collectionId: string; recordId: string; expectedVersion: number; viewId?: string }): Promise<CollectionDeleteRuntimeResult> {
    const payload = {
      collection_id: input.collectionId,
      record_id: input.recordId,
      expected_version: input.expectedVersion,
      ...(input.viewId ? { view_id: input.viewId } : {})
    };
    return await this.runLocalCollectionCommand(requireDomainCommandEntry("collection.record.delete").id, payload, `collection_record_delete:${stableHash(payload)}`);
  }

  async listCollectionActions(collectionId?: string): Promise<CollectionActionDescriptor[]> {
    const schema = collectionId ? await this.getAccessibleCollectionSchema(collectionId) : undefined;
    const schemas = collectionId ? (schema ? [schema] : []) : await this.listActiveCollectionSchemas();
    return schemas.flatMap((item) =>
      item.actions.map((action) => collectionActionDescriptor(item.id, action, this.pluginRegistry))
    );
  }

  async runCollectionAction(input: {
    collectionId: string;
    actionId: string;
    backendId?: string;
    recordId?: string;
    sessionId?: string;
    payload?: Record<string, unknown>;
  }): Promise<CollectionActionRuntimeResult> {
    const payload = {
      collection_id: input.collectionId,
      action_id: input.actionId,
      ...(input.backendId === undefined ? {} : { backend_id: input.backendId }),
      ...(input.recordId === undefined ? {} : { record_id: input.recordId }),
      payload: jsonRecord(input.payload ?? {})
    };
    return await this.runLocalCollectionCommand(
      requireDomainCommandEntry("collection.action.run").id,
      payload,
      `collection_action_run_request:${stableHash(payload)}`,
      input.sessionId
    );
  }

  /** Native App compatibility resolves a trusted Room first, then uses Core08. */
  private async runLocalCollectionCommand<T>(
    commandId: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    sessionId?: string
  ): Promise<T> {
    const result = await this.runDomainCommandWithTrustedContext({
      command_id: commandId,
      idempotency_key: idempotencyKey,
      payload
    }, await this.collectionCompatibilityContext(sessionId));
    return result.result as T;
  }

  private async collectionCompatibilityContext(sessionId?: string): Promise<TrustedDomainRuntimeContext> {
    const session = sessionId ? await this.store.getSession(sessionId) : undefined;
    if (sessionId && !session) throw new RuntimeRequestError("not_found", `Session not found: ${sessionId}`);
    const settings = await this.store.getSettings();
    const roomId = session?.room_id ?? settings.default_room_id;
    if (!roomId) throw new RuntimeRequestError("forbidden", "collection_room_context_required");
    return {
      participant: { kind: "human", participantId: localOwnerParticipantId },
      roomId,
      source: { kind: "native_app", app_id: "samurai-native" },
      ...(session ? { sessionId: session.id, sessionRef: { app_id: "samurai-native", session_id: session.id } } : {})
    };
  }

  /**
   * Authorization is checked before Store starts its file transaction.  Store
   * receives only the immutable snapshot it must persist with the job.
   */
  private async collectionTriggerWriteRequest(input: CollectionTriggerMutationRequest) {
    return {
      event: input.event,
      operationId: input.operation.id,
      delivery: await this.core09AutomationDomainService.prepareCollectionTriggerDelivery(input.trustedContext)
    };
  }

  /** Collection AI actions use the Session-free Workspace Execution boundary. */
  private async runCollectionInstructionWorkspaceExecution(input: {
    context: TrustedDomainContext;
    prompt: string;
    backendId?: string;
    metadata: Record<string, JsonValue>;
    customView: boolean;
  }): Promise<{ backendRun: { id: string; status: string }; outputText: string; customView?: Record<string, JsonValue> }> {
    const { context } = input;
    if (!context.roomId || !context.participant) {
      throw new RuntimeRequestError("forbidden", "collection_action_room_context_required");
    }
    const settings = await this.store.getSettings();
    const outcome = await this.runWorkspaceExecution({
      context: {
        workspace_id: context.workspaceId,
        room_id: context.roomId,
        principal: trustedPrincipalFromParticipant(context.participant),
        source: context.source ?? { kind: "native_app" },
        correlation_id: `collection-action:${context.correlationId}:${String(input.metadata.collection_action_operation_id ?? stableHash(input.prompt))}`,
        ...(context.sessionRef ? { session_ref: context.sessionRef } : {})
      },
      ...(input.backendId ? { backend_id: input.backendId } : {}),
      input_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      input_summary: input.prompt,
      metadata: input.metadata
    });
    if (outcome.kind !== "completed") {
      throw new RuntimeRequestError("conflict", `collection_instruction_execution_${outcome.kind}`);
    }
    const outputText = outcome.output.content;
    return {
      backendRun: outcome.run,
      outputText,
      ...(input.customView ? { customView: collectionActionCustomViewOutput(outputText) } : {})
    };
  }

  /** Scheduled natural-language Automation uses the same Room-first Host as Collection actions. */
  private async runAutomationInstructionWorkspaceExecution(input: {
    context: TrustedDomainContext;
    job: AutomationJobRecord;
    run: AutomationRunRecord;
  }): Promise<{ backendRunId: string; status: string; summary: string; error?: string }> {
    const { context, job, run } = input;
    if (!context.roomId || !context.participant) {
      throw new RuntimeRequestError("forbidden", "automation_room_context_required");
    }
    const settings = await this.store.getSettings();
    const outcome = await this.runWorkspaceExecution({
      context: {
        workspace_id: context.workspaceId,
        room_id: context.roomId,
        principal: trustedPrincipalFromParticipant(context.participant),
        source: context.source ?? { kind: "host" },
        correlation_id: `automation:${job.id}:${job.next_run_at ?? run.started_at}:${run.id}`,
        ...(context.sessionRef ? { session_ref: context.sessionRef } : {})
      },
      input_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      input_summary: job.target_instruction,
      metadata: {
        automation_job_id: job.id,
        automation_run_id: run.id,
        automation_kind: job.kind,
        automation_target_instruction: job.target_instruction,
        delivery_target: job.delivery_target
      }
    });
    if (outcome.kind === "completed" && job.kind === "resource_translation" && job.delivery_target.channel === "resource_translation") {
      await this.saveAutomationTranslation({
        context,
        job,
        run,
        translatedText: outcome.output.content
      });
    }
    return {
      backendRunId: outcome.run.id,
      status: outcome.run.status,
      summary: outcome.kind === "completed" ? outcome.output.content : "",
      ...(outcome.kind === "failed" || outcome.kind === "outcome_unknown"
        ? { error: outcome.error.message }
        : outcome.kind === "cancelled"
          ? { error: outcome.reason }
          : outcome.kind === "waiting"
            ? { error: `automation_backend_waiting_for_input:${outcome.waiting.prompt}` }
      : {})
    };
  }

  private async saveAutomationTranslation(input: {
    context: TrustedDomainContext;
    job: AutomationJobRecord;
    run: AutomationRunRecord;
    translatedText: string;
  }): Promise<void> {
    const target = resourceTranslationAutomationTarget(input.job.delivery_target);
    if (!target) throw new RuntimeRequestError("conflict", "resource_translation_target_invalid");
    const source = await this.translationDomainService.loadSource(target.sourceRef, target.sourceLocale);
    if (!source) throw this.translationDomainService.translationSourceNotFoundError(target.sourceRef);
    if (target.originalHash && source.original_hash !== target.originalHash) {
      throw new RuntimeRequestError("conflict", "resource_translation_source_changed");
    }
    const now = nowIso();
    await this.runDomainCommandWithTrustedContext({
      command_id: runtimeOperationIds.resourceTranslationSave,
      input_source: "automation",
      idempotency_key: `automation-translation:${input.run.id}`,
      payload: {
        id: `translation:${input.run.id}`,
        source_ref: source.ref,
        source_locale: source.source_locale,
        target_locale: target.targetLocale,
        status: "draft",
        original_hash: source.original_hash,
        translated_text: input.translatedText,
        created_at: now,
        updated_at: now
      }
    }, input.context);
  }


  async runMemoryReviewAutomation(): Promise<AutomationRunRuntimeResult> {
    return await this.runtimeDomainApi.runMemoryReviewAutomation() as AutomationRunRuntimeResult;
  }

  /**
   * Legacy Native compatibility keeps the explicit memory-review command
   * usable while the standard Worker owns ordinary scheduling. It selects a
   * visible Room candidate, then reuses the same persisted Session/Run
   * boundary and Core05 review path; it never creates a synthetic Session.
   */
  private async runLegacySessionlessMemoryReview(): Promise<DomainOperationOutput<"automation.memory_review.run">> {
    const trustedContext = this.activeDomainContext.getStore();
    const operation = await this.createOperation(
      undefined,
      undefined,
      "automation.memory_review.run",
      ["Review queued Learning evidence for one visible Room.", "Apply only evidence-backed Core05 mutations."],
      {
        context: cronMemoryReviewGatewayContext,
        trustedContext,
        inputSummary: "Run the explicit Memory Review compatibility command."
      }
    );
    const startedAt = nowIso();
    const startedRun: AutomationRunRecord = {
      id: createId("automationrun"),
      kind: "memory_review",
      source: "runtime_compatibility_worker",
      status: "started",
      operation_id: operation.id,
      workspace_id: stableHash(this.store.rootDir),
      started_at: startedAt
    };
    await this.store.createAutomationRun(startedRun);
    operation.input_ref = {
      kind: "automation_run",
      id: startedRun.id,
      uri: `automation-runs/${startedRun.id}`,
      label: "Memory Review"
    };
    operation.target_resource_refs = [operation.input_ref];
    operation.updated_at = nowIso();
    await this.store.updateOperation(operation);
    try {
      const memoryReviewTrace = await this.runCore05PendingRoomReview();
      const settledStatus = memoryReviewTrace.reflectionRun.status === "failed" ? "failed" : "completed";
      const settledRun: AutomationRunRecord = {
        ...startedRun,
        status: settledStatus,
        ...(settledStatus === "failed" ? { error_code: "memory_review_failed", error: memoryReviewTrace.reflectionRun.error ?? "memory_review_failed" } : {}),
        completed_at: nowIso()
      };
      await this.store.updateAutomationRun(settledRun);
      operation.status = settledStatus;
      operation.result_ref = { kind: "automation_run", id: settledRun.id, uri: `automation-runs/${settledRun.id}`, label: "Memory Review" };
      operation.updated_at = nowIso();
      if (settledStatus === "failed") operation.error = settledRun.error ?? "memory_review_failed";
      await this.store.updateOperation(operation);
      return {
        resource: settledRun,
        operation,
        activity: await this.rebuildActivity(),
        automationRun: settledRun,
        memoryReviewTrace
      };
    } catch (error) {
      const failedRun: AutomationRunRecord = {
        ...startedRun,
        status: "failed",
        error_code: "memory_review_failed",
        error: safeRuntimeErrorMessage(error),
        completed_at: nowIso()
      };
      await this.store.updateAutomationRun(failedRun).catch(() => undefined);
      operation.status = "failed";
      operation.error = failedRun.error;
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation).catch(() => undefined);
      throw error;
    }
  }

  private async saveMessage(message: MessageRecord): Promise<MessageRecord> {
    const saved = await this.store.saveMessage(message);
    await this.emit("message.created", saved);
    return saved;
  }

  private async gatewayBoundaryPolicyForRun(run: BackendRunRecord): Promise<GatewayBoundaryPolicy | undefined> {
    const policyId = stringPayload(run.metadata.gateway_boundary_policy_id);
    return policyId ? this.store.getGatewayBoundaryPolicy(policyId) : undefined;
  }

  private async buildResumeToolRunInput(
    run: BackendRunRecord,
    resumeInput: Record<string, JsonValue>,
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy
  ): Promise<BackendRunInput> {
    if (!run.session_id) {
      const content = typeof resumeInput.content === "string" ? resumeInput.content : JSON.stringify(resumeInput);
      const backendRoot = await this.backendExecutionRoot(run.id);
      const workingDirectory = this.backendWorkingDirectoryMode() === "workspace"
        ? backendRoot
        : this.backendWorkingDirectory();
      return {
        ...workspaceBackendInput(run, nowIso, content || run.input_summary, resumeInput),
        workspace_root: backendRoot,
        working_directory: workingDirectory,
        ...(gatewayBoundaryPolicy ? { gateway_boundary: gatewayBoundaryRuntimeSnapshot(gatewayBoundaryPolicy, nowIso()) } : {})
      };
    }
    requireSessionBoundRun(run);
    const [session, messages, settings, agent] = await Promise.all([
      this.store.getSession(run.session_id),
      this.store.listMessages(run.session_id),
      this.store.getSettings(),
      run.agent_id ? this.store.getAgent(run.agent_id) : Promise.resolve(undefined)
    ]);
    if (!session) {
      throw new RuntimeRequestError("not_found", "session_not_found");
    }
    const inputMessage = messages.find((message) => message.id === run.input_message_id && message.role === "user")
      ?? messages.find((message) => message.role === "user");
    const inputLocale = inputMessage?.input_locale ?? session.ui_locale ?? settings.ui_locale;
    const outputLocale = inputMessage?.output_locale ?? session.output_locale ?? settings.output_locale;
    const userInput = inputMessage?.content || run.input_summary || "Resume backend run";
    const envelope = inputMessage?.envelope ?? createGatewayEnvelope(webGatewayContext, userInput, inputLocale, outputLocale, run.metadata);
    const workspaceRoot = await this.backendExecutionRoot(run.id);
    const workingDirectory = this.backendWorkingDirectoryMode() === "workspace"
      ? workspaceRoot
      : this.backendWorkingDirectory();
    return {
      run_id: run.id,
      session_id: run.session_id,
      ...(session.room_id ? { room_id: session.room_id } : {}),
      ...(agent ? { agent_context: agentBackendContext(agent) } : {}),
      input_message_id: run.input_message_id,
      workspace_root: workspaceRoot,
      working_directory: workingDirectory,
      envelope,
      user_input: userInput,
      input_locale: inputLocale,
      output_locale: outputLocale,
      active_memory: [],
      gateway_boundary: gatewayBoundaryPolicy ? gatewayBoundaryRuntimeSnapshot(gatewayBoundaryPolicy, nowIso()) : undefined,
      recent_messages: messages.slice(-10),
      metadata: {
        ...run.metadata,
        workspace_root: workspaceRoot,
        working_directory: workingDirectory
      }
    };
  }

  private async handleBackendToolStartedEvent(input: {
    run: BackendRunRecord;
    runInput: BackendRunInput;
    event: BackendToolCallStartedEvent;
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy;
    recordEvent: BackendEventRecorder;
  }): Promise<BackendToolEventHandlingResult> {
    const providerToolName = stringPayload(input.event.payload.provider_tool_name);
    const toolCallId = stringPayload(input.event.payload.tool_call_id) || input.event.tool_call_id;
    if (!toolCallId) throw new RuntimeRequestError("bad_request", "tool_call_id_required");
    const requestedActionId = stringPayload(input.event.payload.action_id);
    const result: BackendToolEventHandlingResult = {
      operations: [],
      artifacts: [],
      memories: [],
      collectionSchemas: [],
      toolRuns: [],
      workspaceChanges: []
    };
    try {
      if (input.run.session_id) await this.assertRunAgentExecution(input.run);
      else await this.assertWorkspaceRunAgentExecution(input.run);
    } catch (error) {
      const reason = error instanceof RuntimeRequestError ? error.message : safeRuntimeErrorMessage(error);
      const toolRun = await this.store.saveToolRun({
        id: createId("toolrun"), run_id: input.run.id, session_id: input.run.session_id, tool_call_id: toolCallId,
        provider_tool_name: providerToolName || "unknown_tool", action_id: stringPayload(input.event.payload.action_id) || "unknown_tool",
        status: "ignored", input_summary: summarize(JSON.stringify(input.event.payload.input ?? {}), 220),
        output_summary: reason, error_code: "room_authorization_denied", resource_refs: [], created_at: nowIso()
      });
      result.toolRuns.push(toolRun);
      await input.recordEvent({
        event_type: "tool_call_output",
        payload: { status: "ignored", reason, error_code: "room_authorization_denied" },
        tool_call_id: toolCallId
      });
      return result;
    }
    if (isSamuraiToolBridgeObservedProviderTool(providerToolName, input.event.payload)) {
      const actionId = samuraiToolBridgeActionId(normalizeSamuraiToolBridgeName(providerToolName));
      const toolRun = await this.store.saveToolRun({
        id: createId("toolrun"),
        run_id: input.run.id,
        session_id: input.run.session_id,
        tool_call_id: toolCallId,
        provider_tool_name: providerToolName,
        action_id: actionId,
        status: "ignored",
        input_summary: summarize(JSON.stringify(input.event.payload.input ?? {}), 220),
        output_summary: "samurai_tool_bridge_already_executed",
        resource_refs: [],
        created_at: nowIso()
      });
      result.toolRuns.push(toolRun);
      await input.recordEvent({
        event_type: "tool_call_output",
        payload: {
          status: "ignored",
          provider_tool_name: providerToolName,
          action_id: actionId,
          reason: "samurai_tool_bridge_already_executed",
          already_executed: true,
          tool_origin: "samurai_tool_bridge"
        },
        tool_call_id: toolCallId
      });
      return result;
    }
    const boundaryDecision = gatewayBoundaryToolDecision(input.gatewayBoundaryPolicy, providerToolName, requestedActionId);
    const boundaryFeedback = gatewayBoundaryToolFeedback(boundaryDecision);

    if (!boundaryDecision.allowed) {
      const boundaryChange = gatewayBoundaryToolBlockedChange(input.run, boundaryDecision);
      await this.store.saveWorkspaceChange(boundaryChange);
      result.workspaceChanges.push(boundaryChange);
      await this.emit("workspace.change.created", boundaryChange);
      const toolRun = await this.store.saveToolRun({
        id: createId("toolrun"),
        run_id: input.run.id,
        session_id: input.run.session_id,
        tool_call_id: toolCallId,
        provider_tool_name: providerToolName || "unknown_tool",
        action_id: boundaryDecision.action_id,
        status: "ignored",
        input_summary: summarize(providerToolName || "unknown_tool"),
        output_summary: "gateway_boundary_tool_not_allowed",
        resource_refs: boundaryFeedback.resourceRefs,
        created_at: nowIso()
      });
      result.toolRuns.push(toolRun);
      await input.recordEvent({
        event_type: "tool_call_output",
        payload: {
          status: "ignored",
          provider_tool_name: providerToolName || "unknown_tool",
          action_id: boundaryDecision.action_id,
          reason: "gateway_boundary_tool_not_allowed",
          gateway_boundary: boundaryFeedback.payload
        },
        resource_refs: boundaryFeedback.resourceRefs,
        tool_call_id: toolCallId
      });
      return result;
    }

    const runtimeToolAttempt = await this.dispatchRuntimeToolCall({
      run: input.run,
      runInput: input.runInput,
      event: input.event,
      providerToolName,
      requestedActionId,
      boundaryDecision,
      boundary: boundaryFeedback,
      gatewayBoundaryPolicy: input.gatewayBoundaryPolicy,
      recordEvent: input.recordEvent
    });
    if (runtimeToolAttempt.kind === "failed") {
      result.toolRuns.push(runtimeToolAttempt.toolRun);
      return result;
    }
    if (runtimeToolAttempt.kind === "query_failed") {
      // Queries remain read-only: they do not create Operations or ToolRuns.
      // A normal Provider event still needs one terminal result so the caller
      // can observe a typed rejection instead of losing the tool call.
      await input.recordEvent({
        event_type: "tool_call_output",
        payload: {
          status: "failed",
          provider_tool_name: providerToolName,
          action_id: boundaryDecision.action_id,
          error_code: runtimeToolAttempt.failure.code,
          reason: runtimeToolAttempt.failure.reason,
          retryable: runtimeToolAttempt.failure.retryable,
          gateway_boundary: boundaryFeedback.payload
        },
        resource_refs: boundaryFeedback.resourceRefs,
        tool_call_id: toolCallId
      });
      return result;
    }
    if (runtimeToolAttempt.kind === "handled") {
      const runtimeTool = runtimeToolAttempt.value;
      if (isRuntimeToolQueryResult(runtimeTool)) {
        // Query results are persisted as the Provider terminal event only;
        // unlike Commands, they intentionally produce no Operation or ToolRun.
        await input.recordEvent({
          event_type: "tool_call_output",
          payload: runtimeTool.outputPayload ?? {
            status: "completed",
            action_id: boundaryDecision.action_id,
            gateway_boundary: boundaryFeedback.payload
          },
          resource_refs: withGatewayBoundaryRefs(runtimeTool.resourceRefs ?? [], boundaryFeedback),
          tool_call_id: toolCallId
        });
        return result;
      }
      result.operations.push(runtimeTool.operation);
      result.toolRuns.push(runtimeTool.toolRun);
      result.artifacts.push(...(runtimeTool.artifacts ?? []));
      result.memories.push(...(runtimeTool.memories ?? []));
      result.collectionSchemas.push(...(runtimeTool.collectionSchemas ?? []));
      for (const change of runtimeTool.workspaceChanges ?? []) {
        result.workspaceChanges.push(change);
      }
      const resourceRefs = runtimeTool.resourceRefs ?? (runtimeTool.operation.result_ref ? [runtimeTool.operation.result_ref] : []);
      for (const runtimeEvent of runtimeTool.events ?? []) {
        await input.recordEvent(runtimeEvent);
      }
      await input.recordEvent({
        event_type: "tool_call_output",
        payload: runtimeTool.outputPayload ?? {
          status: "completed",
          action_id: runtimeTool.operation.operation,
          resource_id: runtimeTool.operation.result_ref?.id ?? runtimeTool.operation.id,
          gateway_boundary: boundaryFeedback.payload
        },
        resource_refs: withGatewayBoundaryRefs(resourceRefs, boundaryFeedback),
        tool_call_id: toolCallId
      });
      return result;
    }

    const feedback = await handleBackendToolCall({
      store: this.store,
      run: input.run,
      runInput: input.runInput,
      event: input.event,
      boundary: boundaryFeedback
    });
    result.operations.push(...feedback.operations);
    result.artifacts.push(...feedback.artifacts);
    result.memories.push(...feedback.memories);
    result.toolRuns.push(...feedback.toolRuns);
    for (const change of feedback.workspaceChanges) {
      await this.store.saveWorkspaceChange(change);
      result.workspaceChanges.push(change);
      await this.emit("workspace.change.created", change);
    }
    for (const feedbackEvent of feedback.events) {
      await input.recordEvent(feedbackEvent);
    }
    return result;
  }

  /**
   * A provider tool call has exactly one terminal outcome. In particular, a
   * failed Runtime dispatch is handled here and cannot fall through to the
   * legacy feedback adapter for the same tool-call id.
   */
  private async dispatchRuntimeToolCall(input: {
    run: BackendRunRecord;
    runInput: BackendRunInput;
    event: BackendToolCallStartedEvent;
    providerToolName: string;
    requestedActionId: string;
    boundaryDecision: GatewayBoundaryToolDecision;
    boundary: BackendToolBoundaryFeedback;
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy;
    recordEvent: BackendEventRecorder;
  }): Promise<RuntimeToolDispatchOutcome> {
    try {
      const value = await this.handleRuntimeToolCall(
        input.run,
        input.runInput,
        input.event,
        input.boundary,
        input.gatewayBoundaryPolicy
      );
      return value ? { kind: "handled", value } : { kind: "unhandled" };
    } catch (error) {
      const failure = normalizeRuntimeToolFailure(error);
      const toolCallId = stringPayload(input.event.payload.tool_call_id) || input.event.tool_call_id;
      if (!toolCallId) throw new RuntimeRequestError("bad_request", "tool_call_id_required");
      const mappedQuery = getDomainQueryEntry(input.requestedActionId)
        ?? getDomainQueryForProviderToolName(input.providerToolName);
      if (mappedQuery) {
        return { kind: "query_failed", failure };
      }
      const generatedSurfaceFailure = /generated[._]surface/i.test(
        `${input.providerToolName} ${input.requestedActionId} ${input.boundaryDecision.action_id}`
      );
      const retryCount = typeof input.run.metadata.generated_surface_retry_count === "number"
        ? input.run.metadata.generated_surface_retry_count
        : 0;
      const retryable = generatedSurfaceFailure && retryCount < 1;
      if (retryable) {
        const updatedRun = {
          ...input.run,
          metadata: {
            ...input.run.metadata,
            generated_surface_retry_count: retryCount + 1
          }
        };
        Object.assign(input.run, updatedRun);
        await this.store.commitCore02RunTransition({ expectedRun: input.run, nextRun: updatedRun });
        await this.emit("backend.run.updated", updatedRun);
      }
      const toolRun = await this.store.saveToolRun({
        id: createId("toolrun"),
        run_id: input.run.id,
        session_id: input.run.session_id,
        tool_call_id: toolCallId,
        provider_tool_name: input.providerToolName || "unknown_tool",
        action_id: input.boundaryDecision.action_id,
        status: "failed",
        input_summary: summarize(JSON.stringify(input.event.payload.input ?? {}), 220),
        output_summary: failure.summary,
        error_code: failure.code,
        resource_refs: input.boundary.resourceRefs,
        created_at: nowIso()
      });
      await input.recordEvent({
        event_type: "tool_call_output",
        payload: {
          status: "failed",
          provider_tool_name: input.providerToolName,
          action_id: input.boundaryDecision.action_id,
          error_code: failure.code,
          reason: failure.reason,
          retryable,
          retry_count: retryCount,
          gateway_boundary: input.boundary.payload
        },
        resource_refs: input.boundary.resourceRefs,
        tool_call_id: toolCallId
      });
      return { kind: "failed", toolRun };
    }
  }

  private async handleRuntimeToolCall(
    run: BackendRunRecord,
    runInput: BackendRunInput,
    event: BackendToolCallStartedEvent,
    boundary?: BackendToolBoundaryFeedback,
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy
  ): Promise<RuntimeToolCallResult | RuntimeToolQueryResult | undefined> {
    if (run.session_id) await this.assertRunAgentExecution(run);
    else await this.assertWorkspaceRunAgentExecution(run);
    const providerToolName = stringPayload(event.payload.provider_tool_name);
    const providerCommand = providerToolName ? getDomainCommandForProviderToolName(providerToolName) : undefined;
    const providerQuery = providerToolName ? getDomainQueryForProviderToolName(providerToolName) : undefined;
    const toolName = stringPayload(event.payload.action_id) || providerCommand?.id || providerQuery?.id || providerToolName;
    const args = runtimeToolArguments(event.payload, toolName);
    const toolCallId = stringPayload(event.payload.tool_call_id) || event.tool_call_id;
    if (!toolCallId) throw new RuntimeRequestError("bad_request", "tool_call_id_required");
    // The bridge event keeps the canonical bridge name in `provider_tool_name`
    // while `action_id` is the compatibility operation id (`collection.manage`).
    // Resolve the compatibility adapter from the provider name so both direct
    // bridge calls and provider-emitted bridge events use the same path.
    if (normalizeSamuraiToolBridgeName(providerToolName || toolName) === "samurai.collection.manage") {
      if (!run.session_id) throw new RuntimeRequestError("unavailable", "session_compatibility_required:collection.manage");
      const output = await this.runCollectionManageCompatibility(
        args,
        "provider_tool_call",
        providerToolIdempotencyKey(run.id, run.current_attempt ?? 1, toolCallId, "collection.manage"),
        { runId: run.id }
      );
      const session = await this.store.getSession(run.session_id);
      if (!session) throw new RuntimeRequestError("not_found", "session_not_found");
      const operation = await this.createOperation(session, runInput.envelope, "collection.manage", ["Run the legacy Collection compatibility adapter."]);
      const completedOperation = { ...operation, status: "completed" as const, updated_at: nowIso() };
      await this.store.updateOperation(completedOperation);
      const toolRun = await this.store.saveToolRun({
        id: createId("toolrun"),
        run_id: run.id,
        session_id: run.session_id,
        tool_call_id: toolCallId,
        provider_tool_name: providerToolName || toolName,
        action_id: "collection.manage",
        status: "completed",
        input_summary: summarize(JSON.stringify(args), 220),
        output_summary: summarize(JSON.stringify(output), 220),
        resource_refs: [],
        created_at: nowIso()
      });
      return {
        operation: completedOperation,
        toolRun,
        outputPayload: { status: "completed", action_id: "collection.manage", output },
        resourceRefs: withGatewayBoundaryRefs([], boundary)
      };
    }
    const mappedQuery = getDomainQueryEntry(toolName)
      ?? providerQuery
      ?? getDomainQueryForProviderToolName(toolName)
      ?? getDomainQueryForProviderToolName(normalizeSamuraiToolBridgeName(toolName));
    if (mappedQuery && mappedQuery.allowed_sources.includes("provider_tool_call")) {
      return this.handleProviderDomainQueryToolCall(run, runInput, event, mappedQuery.id, args, boundary);
    }
    const normalizedToolName = normalizeSamuraiToolBridgeName(toolName);
    const mappedCommand = getDomainCommandEntry(toolName)
      ?? providerCommand
      ?? getDomainCommandForProviderToolName(toolName)
      ?? getDomainCommandForProviderToolName(normalizedToolName);
    if (mappedCommand && mappedCommand.input_sources.includes("provider_tool_call")) {
      const effectiveCommandId = mappedCommand.id;
      const effectiveCommand = requireDomainCommandEntry(effectiveCommandId);
      if (effectiveCommand.output_resource_kind === "memory" && (await this.store.getSettings()).memory_capture_mode === "off") {
        return undefined;
      }
      const commandArgs = effectiveCommand.output_resource_kind === "generated_surface"
        ? normalizeGeneratedSurfaceCommandPayload(effectiveCommand, args, runInput)
        : normalizeProviderDomainCommandPayload(effectiveCommand, args, {
          inputLocale: runInput.input_locale,
          outputLocale: runInput.output_locale,
          runId: run.id,
          userInput: runInput.user_input,
          providerToolName: providerToolName || toolName,
          toolCallId
        });
      const domainResult = await this.runDomainCommandWithTrustedContext({
        command_id: effectiveCommandId,
        input_source: "provider_tool_call",
        idempotency_key: providerToolIdempotencyKey(run.id, run.current_attempt ?? 1, toolCallId, effectiveCommandId),
        payload: commandArgs
      }, { runId: run.id, sessionId: run.session_id, envelopeId: runInput.input_message_id });
      const directRuntimeTool = runtimeToolCallResult(domainResult.result);
      if (directRuntimeTool) return directRuntimeTool;
      const generatedSurface = unknownRecord(unknownRecord(domainResult.result).definition);
      if (typeof generatedSurface.id === "string" && typeof generatedSurface.preview_url === "string") {
        const sessionId = run.session_id;
        if (!sessionId) throw new RuntimeRequestError("unavailable", `session_compatibility_required:${effectiveCommandId}`);
        const session = await this.store.getSession(sessionId);
        if (!session) throw new RuntimeRequestError("not_found", "session_not_found");
        const generatedRef: ResourceRef = {
          kind: "generated_surface",
          id: generatedSurface.id,
          uri: `surfaces/${generatedSurface.id}`,
          label: typeof generatedSurface.title === "string" ? generatedSurface.title : "Generated Surface"
        };
        const operation = await this.createOperation(session, runInput.envelope, effectiveCommandId, [
          "Create a Generated Surface revision."
        ], { targetResourceRefs: [generatedRef] });
        const completedOperation = { ...operation, status: "completed" as const, result_ref: generatedRef, updated_at: nowIso() };
        await this.store.updateOperation(completedOperation);
        const toolRun = await this.store.saveToolRun({
          id: createId("toolrun"),
          run_id: run.id,
          session_id: run.session_id,
          tool_call_id: toolCallId,
          provider_tool_name: providerToolName || toolName,
          action_id: effectiveCommandId,
          status: "completed",
          input_summary: summarize(JSON.stringify(args), 220),
          output_summary: `Saved Generated Surface ${generatedSurface.id}.`,
          resource_refs: [generatedRef],
          created_at: nowIso()
        });
        return {
          operation: completedOperation,
          toolRun,
          resourceRefs: [generatedRef],
          outputPayload: {
            status: "completed",
            action_id: effectiveCommandId,
            surface_id: generatedSurface.id,
            revision_id: typeof generatedSurface.current_revision_id === "string" ? generatedSurface.current_revision_id : "",
            preview_url: generatedSurface.preview_url
          }
        };
      }
      const writeResult = operationAuditRuntimeResult(domainResult.result);
      if (!writeResult) {
        return undefined;
      }
      const toolRun = await this.store.saveToolRun({
        id: createId("toolrun"),
        run_id: run.id,
        session_id: run.session_id,
        tool_call_id: toolCallId,
        provider_tool_name: providerToolName || toolName,
        action_id: writeResult.operation.operation,
        status: writeResult.operation.status === "denied" ? "ignored" : "completed",
        input_summary: summarize(JSON.stringify(args), 220),
        output_summary: writeResult.auditRecord?.outputs_summary ?? `Completed ${writeResult.operation.operation}.`,
        resource_refs: withGatewayBoundaryRefs(writeResult.resourceRefs, boundary),
        created_at: nowIso()
      });
      const resource = runtimeWriteResource(domainResult.result);
      const artifacts = isArtifactRecordResource(resource) ? [resource] : [];
      const memories = isMemoryFrontmatterResource(resource) ? [resource] : [];
      const collectionSchema = resource && typeof resource === "object" && isCollectionSchemaRenderResource(resource as Record<string, unknown>)
        ? resource as CollectionSchemaWithFilePath
        : undefined;
      const collectionManageOutput = isCollectionManageResource(resource)
        ? {
            status: "completed",
            provider_tool_name: providerToolName || toolName,
            action_id: mappedCommand.id,
            output_summary: summarize(JSON.stringify(resource), 220),
            output: resource
          }
        : undefined;
      const workspaceChanges = await this.backendWorkspaceChangesForOperation(run.id, run.session_id, writeResult.operation.id);
      return {
        operation: writeResult.operation,
        toolRun,
        resourceRefs: writeResult.resourceRefs,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(memories.length > 0 ? { memories } : {}),
        events: runtimeToolWorkspaceEvents(resource, withGatewayBoundaryRefs(writeResult.resourceRefs, boundary), toolCallId),
        ...(collectionSchema ? { collectionSchemas: [collectionSchema] } : {}),
        ...(collectionManageOutput ? { outputPayload: collectionManageOutput } : {}),
        ...(workspaceChanges.length > 0 ? { workspaceChanges } : {})
      };
    }
    return undefined;
  }

  private async handleProviderDomainQueryToolCall(
    run: BackendRunRecord,
    runInput: BackendRunInput,
    event: BackendToolCallStartedEvent,
    queryId: string,
    args: Record<string, JsonValue>,
    boundary?: BackendToolBoundaryFeedback
  ): Promise<RuntimeToolQueryResult | undefined> {
    const queryResult = await this.runDomainQueryWithTrustedContext({
      query_id: queryId,
      input_source: "provider_tool_call",
      payload: normalizeProviderDomainQueryPayload(queryId, args)
    }, { runId: run.id, sessionId: run.session_id, envelopeId: runInput.input_message_id });
    if (queryId === runtimeOperationIds.skillView) {
      await this.recordProviderSkillViewUsage(run, event, queryId, queryResult.result);
    }
    // A Collection view query is also a presentation request. Project its
    // validated query result into the existing tool-output descriptor rather
    // than bypassing the Domain Query contract for a provider-specific path.
    const presentation = queryResult.query.output_resource_kind === "collection_view"
      ? collectionPresentationDescriptorFromQueryResult(queryResult.result, args)
      : undefined;
    return {
      queryOnly: true,
      outputPayload: {
        status: "completed",
        query_id: queryId,
        result: jsonSafe(presentation ?? queryResult.result),
        render_specs: jsonSafe(presentation ? [] : queryResult.render_specs)
      },
      resourceRefs: withGatewayBoundaryRefs([], boundary)
    };
  }

  private async recordProviderSkillViewUsage(
    run: BackendRunRecord,
    event: BackendToolCallStartedEvent,
    queryId: string,
    value: unknown
  ): Promise<void> {
    if (!isRecord(value) || !isRecord(value.usage)) {
      throw new RuntimeRequestError("conflict", "skill_view_usage_missing");
    }
    const usage = value.usage;
    const skillId = typeof usage.skill_id === "string" ? usage.skill_id : undefined;
    const resourceId = typeof usage.resource_id === "string" ? usage.resource_id : undefined;
    const contentHash = typeof usage.content_hash === "string" ? usage.content_hash : undefined;
    const stage = usage.stage === "body_loaded" || usage.stage === "support_loaded" ? usage.stage : undefined;
    const usageMetadata = isRecord(usage.metadata) ? jsonRecord(usage.metadata) : undefined;
    if (!skillId || !resourceId || !contentHash || !stage || !usageMetadata) {
      throw new RuntimeRequestError("conflict", "skill_view_usage_invalid");
    }
    const providerToolName = typeof event.payload.provider_tool_name === "string" ? event.payload.provider_tool_name : undefined;
    const existing = (await this.store.listLearningResourceUses({ runId: run.id, resourceId }))
      .find((record) => record.stage === stage);
    if (existing) return;
    await this.recordSkillUsage({
      skillId,
      runId: run.id,
      resourceId,
      contentHash,
      stage,
      metadata: {
        ...usageMetadata,
        provider_query_id: queryId,
        provider_tool_call_id: event.tool_call_id,
        ...(providerToolName ? { provider_tool_name: providerToolName } : {})
      }
    });
  }

  private async executeSandboxDomainOperation(context: TrustedDomainContext, request: SystemSandboxExecRequest): Promise<RuntimeToolCallResult> {
    if (!context.runId) throw new RuntimeRequestError("conflict", "sandbox_exec_requires_trusted_backend_run");
    const run = await this.store.getBackendRun(context.runId);
    if (!run) throw new RuntimeRequestError("not_found", "backend_run_not_found");
    const policy = await this.gatewayBoundaryPolicyForRun(run);
    if (!policy) throw new RuntimeRequestError("conflict", "sandbox_exec_requires_gateway_boundary");
    const sandboxInstance = await this.ensureGatewaySandboxInstance(policy);
    const execution = await executeSandboxCommand(
      policy,
      {
        command: request.command,
        args: request.args,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: request.environment,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        secret_env: request.secretEnvironment,
        secret_files: request.secretFiles.map((file) => ({
          secret_ref_id: file.secretRefId,
          filename: file.filename,
          ...(file.environmentName === undefined ? {} : { env: file.environmentName }),
          ...(file.mode === undefined ? {} : { mode: file.mode })
        })),
        ...(request.timeoutMs === undefined ? {} : { timeout_ms: request.timeoutMs }),
        metadata: request.toolCallId === undefined ? {} : { tool_call_id: request.toolCallId }
      },
      createSandboxCommandAdapter(),
      { workspaceRoot: this.store.rootDir, fileRoot: this.store.rootDir, env: process.env }
    );
    return this.saveSandboxExecExecution(
      run,
      request.toolCallId,
      request,
      execution,
      gatewayBoundaryToolFeedback({
        allowed: true,
          action_id: runtimeOperationIds.sandboxExec,
          provider_tool_name: runtimeOperationIds.sandboxExec,
        reason: "explicit_allow",
        policy
      }),
      sandboxInstance
    );
  }

  private async saveSandboxExecExecution(
    run: BackendRunRecord,
    toolCallId: string | undefined,
    request: SystemSandboxExecRequest,
    execution: SandboxCommandExecutionResult,
    boundary?: BackendToolBoundaryFeedback,
    sandboxInstance?: GatewaySandboxInstanceRecord
  ): Promise<RuntimeToolCallResult> {
    requireSessionBoundRun(run);
    const executionRef = sandboxExecutionResourceRef(createId("sandbox_exec"), execution.command);
    const outputRefs = normalizeMcpExecutionResourceRefs(execution.resource_refs);
    const sandboxInstanceRef = sandboxInstance ? gatewaySandboxInstanceRef(sandboxInstance) : undefined;
    const resourceRefs = [executionRef, ...outputRefs, ...(sandboxInstanceRef ? [sandboxInstanceRef] : [])];
    const now = nowIso();
    const session = await this.store.getSession(run.session_id);
    const requesterParticipantId = run.agent_id ? await this.requesterParticipantIdForRun(run) : undefined;
    const operation: OperationRecord = {
      id: createId("operation"),
      session_id: run.session_id,
      capability_id: proposalCapabilityManifest.id,
      operation: runtimeOperationIds.sandboxExec,
      actor_identity: "system",
      ...(run.agent_id && requesterParticipantId ? { participant_id: agentParticipantId(run.agent_id), participant_kind: "agent" as const, requested_by_participant_id: requesterParticipantId } : {}),
      ...(session?.room_id ? { room_id: session.room_id } : {}),
      instruction_source: "tool_output",
      instruction_authority: "backend_runtime",
      channel: "gateway",
      input_hash: stableHash({
        run_id: run.id,
        tool_call_id: toolCallId,
        command: execution.command,
        args: request.args
      }),
      input_ref: {
        kind: "backend_run",
        id: run.id,
        uri: `backend-runs/${run.id}`,
        label: "Backend sandbox tool call"
      },
      target_resource_refs: resourceRefs,
      proposed_effects: [`Execute sandbox command ${execution.command} inside the Gateway boundary.`],
      status: sandboxOperationStatus(execution.status),
      result_ref: execution.status === "completed" ? executionRef : undefined,
      error: execution.status === "completed" ? undefined : execution.error ?? execution.reason,
      created_at: now,
      updated_at: now
    };
    await this.store.saveOperation(operation);
    await this.emit("operation.created", operation);
    const toolRun = await this.store.saveToolRun({
      id: createId("toolrun"),
      run_id: run.id,
      session_id: run.session_id,
      tool_call_id: toolCallId,
      provider_tool_name: runtimeOperationIds.sandboxExec,
      action_id: runtimeOperationIds.sandboxExec,
      status: sandboxToolRunStatus(execution.status),
      input_summary: summarize(`${execution.command} ${request.args.join(" ")}`, 220),
      output_summary: summarize(execution.error ?? execution.stderr ?? execution.stdout ?? execution.reason ?? execution.status, 220),
      resource_refs: withGatewayBoundaryRefs(resourceRefs, boundary),
      created_at: nowIso()
    });
    return {
      operation,
      toolRun,
      resourceRefs,
      outputPayload: {
        status: execution.status,
        action_id: runtimeOperationIds.sandboxExec,
        command: execution.command,
        exit_code: execution.exit_code ?? null,
        signal: execution.signal ?? null,
        stdout: execution.stdout ?? "",
        stderr: execution.stderr ?? "",
        reason: execution.reason ?? null,
        error: execution.error ?? null,
        secret_resolution: jsonDefined(execution.secret_resolution),
        sandbox: jsonDefined(execution.sandbox),
        sandbox_instance: sandboxInstance
          ? {
            id: sandboxInstance.id,
            instance_key: sandboxInstance.instance_key,
            scope: sandboxInstance.scope,
            backend: sandboxInstance.backend,
            status: sandboxInstance.status
          }
          : null,
        gateway_boundary: boundary?.payload ?? {}
      }
    };
  }

  private async executeMcpDomainOperation(context: TrustedDomainContext, request: SystemMcpCallRequest): Promise<RuntimeToolCallResult> {
    if (!context.runId) throw new RuntimeRequestError("conflict", "mcp_call_requires_trusted_backend_run");
    const run = await this.store.getBackendRun(context.runId);
    if (!run) throw new RuntimeRequestError("not_found", "backend_run_not_found");
    const policy = await this.gatewayBoundaryPolicyForRun(run);
    if (!policy) throw new RuntimeRequestError("conflict", "mcp_call_requires_gateway_boundary");
    const serverName = request.serverName;
    const toolName = request.toolName;
    const configured = await this.store.getGatewayMcpConfigByServerName(serverName);
    const hasBoundaryRef = policy.mcp_config_refs.some((ref) =>
      ref.server_name === serverName || (configured ? ref.id === configured.id : false)
    );
    const executionPolicy = configured && hasBoundaryRef
      ? {
          ...policy,
          mcp_config_refs: policy.mcp_config_refs.map((ref) =>
            ref.server_name === serverName || ref.id === configured.id ? gatewayMcpConfigToBoundaryRef(configured) : ref
          )
        }
      : policy;
    const resolveConfig = async (name: string) => name === configured?.server_name
      ? configured
      : await this.store.getGatewayMcpConfigByServerName(name);
    const httpAdapter = createHttpMcpToolAdapter({
      resolveConfig: async (request) => {
        const config = await resolveConfig(request.server_name);
        return config ? httpMcpServerConfigFromGatewayConfig(config) : undefined;
      }
    });
    const adapter = {
      invoke: async (request: Parameters<PooledMcpToolAdapter["invoke"]>[0]) => {
        const config = await resolveConfig(request.server_name);
        return config?.transport === "http" ? httpAdapter.invoke(request) : this.stdioMcpProcessPool.invoke(request);
      }
    };
    const execution = await executeMcpToolInvocation(
      executionPolicy,
      { server_name: serverName, tool_name: toolName, input: request.input },
      adapter,
      { env: process.env, fileRoot: this.store.rootDir }
    );
    return this.saveMcpToolExecution(
      run,
      request.toolCallId,
      request,
      execution,
      gatewayBoundaryToolFeedback({
        allowed: true,
        action_id: runtimeOperationIds.mcpCall,
        provider_tool_name: runtimeOperationIds.mcpCall,
        reason: "explicit_allow",
        policy
      }),
      configured
    );
  }

  private async saveMcpToolExecution(
    run: BackendRunRecord,
    toolCallId: string | undefined,
    request: SystemMcpCallRequest,
    execution: McpToolExecutionResult,
    boundary?: BackendToolBoundaryFeedback,
    configured?: Awaited<ReturnType<RuntimeWorkspacePort["getGatewayMcpConfigByServerName"]>>
  ): Promise<RuntimeToolCallResult> {
    requireSessionBoundRun(run);
    const configRef = configured ? gatewayMcpConfigResourceRef(configured.id, configured.server_name) : gatewayMcpServerResourceRef(execution.server_name);
    const outputRefs = normalizeMcpExecutionResourceRefs(execution.resource_refs);
    const resourceRefs = [configRef, ...outputRefs];
    const now = nowIso();
    const session = await this.store.getSession(run.session_id);
    const requesterParticipantId = run.agent_id ? await this.requesterParticipantIdForRun(run) : undefined;
    const operation: OperationRecord = {
      id: createId("operation"),
      session_id: run.session_id,
      capability_id: proposalCapabilityManifest.id,
      operation: runtimeOperationIds.mcpCall,
      actor_identity: "system",
      ...(run.agent_id && requesterParticipantId ? { participant_id: agentParticipantId(run.agent_id), participant_kind: "agent" as const, requested_by_participant_id: requesterParticipantId } : {}),
      ...(session?.room_id ? { room_id: session.room_id } : {}),
      instruction_source: "tool_output",
      instruction_authority: "backend_runtime",
      channel: "gateway",
      input_hash: stableHash({
        run_id: run.id,
        tool_call_id: toolCallId,
        server_name: execution.server_name,
        tool_name: execution.tool_name,
        input: request.input
      }),
      input_ref: {
        kind: "backend_run",
        id: run.id,
        uri: `backend-runs/${run.id}`,
        label: "Backend tool call"
      },
      target_resource_refs: resourceRefs,
      proposed_effects: [`Call MCP tool ${execution.server_name}/${execution.tool_name} inside the Gateway boundary.`],
      status: mcpOperationStatus(execution.status),
      result_ref: execution.status === "completed" ? configRef : undefined,
      error: execution.status === "completed" ? undefined : execution.error ?? execution.reason,
      created_at: now,
      updated_at: now
    };
    await this.store.saveOperation(operation);
    await this.emit("operation.created", operation);
    const toolRun = await this.store.saveToolRun({
      id: createId("toolrun"),
      run_id: run.id,
      session_id: run.session_id,
      tool_call_id: toolCallId,
      provider_tool_name: runtimeOperationIds.mcpCall,
      action_id: `${execution.server_name}/${execution.tool_name}`,
      status: mcpToolRunStatus(execution.status),
      input_summary: summarize(`${execution.server_name}/${execution.tool_name}`),
      output_summary: summarize(execution.error ?? execution.reason ?? JSON.stringify(execution.output ?? { status: execution.status }), 220),
      resource_refs: withGatewayBoundaryRefs(resourceRefs, boundary),
      created_at: nowIso()
    });
    return {
      operation,
      toolRun,
      resourceRefs,
      outputPayload: {
        status: execution.status,
        action_id: runtimeOperationIds.mcpCall,
        server_name: execution.server_name,
        tool_name: execution.tool_name,
        reason: execution.reason ?? null,
        error: execution.error ?? null,
        output: execution.output ?? null,
        secret_resolution: jsonDefined(execution.secret_resolution),
        sandbox: jsonDefined(execution.sandbox),
        gateway_boundary: boundary?.payload ?? {}
      }
    };
  }

  private resolveWorkspacePath(inputPath: string): { absolutePath: string; relativePath: string } {
    const normalized = inputPath.replaceAll("\\", "/").replace(/^\/+/, "");
    const absolutePath = path.resolve(this.store.rootDir, normalized);
    const root = path.resolve(this.store.rootDir);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new RuntimeRequestError("forbidden", "path_outside_workspace");
    }
    return {
      absolutePath,
      relativePath: path.relative(root, absolutePath) || "."
    };
  }

  private filePort(): WorkspaceFilePort {
    const filePort = this.workspaceOptions.filePort ?? this.store.filePort;
    if (!filePort) throw new RuntimeRequestError("unavailable", "workspace_file_port_unavailable");
    return filePort;
  }

  /** A new file is authorized by Room edit; an existing file keeps its Resource boundary. */
  private async workspaceFileExists(inputPath: string): Promise<boolean> {
    return this.filePort().isFile(this.resolveWorkspacePath(inputPath).absolutePath);
  }

  /**
   * File-listing is candidate-first: the filesystem is never enumerated to
   * discover another Room's paths. The final Room check runs before stat/read.
   */
  private async listActiveRoomFilePaths(directoryPath: string): Promise<string[]> {
    const context = this.activeDomainContext.getStore();
    if (!context?.participant || !context.roomId) {
      throw new RuntimeRequestError("forbidden", "room_context_required");
    }
    const candidates = await this.roomAuthorizationService.resourceCandidateAccess(
      context.participant,
      context.roomId,
      "file"
    );
    const root = directoryPath === "." ? "" : `${directoryPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")}/`;
    const allowed: string[] = [];
    for (const candidate of candidates.resourceIds) {
      const normalized = this.resolveWorkspacePath(candidate).relativePath;
      if (root && !normalized.startsWith(root)) continue;
      try {
        await this.roomAuthorizationService.assertResource(context.participant, {
          roomId: context.roomId,
          action: "read",
          resourceKind: "file",
          resourceId: normalized
        });
        allowed.push(normalized);
      } catch (error) {
        if (error instanceof RoomAuthorizationError) continue;
        throw error;
      }
    }
    return allowed.sort();
  }

  /** Converts an internal absolute path back to the only stable file Resource ID. */
  private workspaceRelativePath(pathInput: string): string {
    const root = path.resolve(this.store.rootDir);
    const absolutePath = path.resolve(pathInput);
    if (absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`)) {
      return path.relative(root, absolutePath) || ".";
    }
    return this.resolveWorkspacePath(pathInput).relativePath;
  }

  /** Direct filesystem calls repeat the common Room decision at the last responsible moment. */
  private async assertActiveFilePathAccess(pathInput: string, action: "read" | "edit"): Promise<void> {
    const context = await this.assertActiveDomainRoomAction(action);
    try {
      await this.roomAuthorizationService.assertResource(context.participant!, {
        roomId: context.roomId!,
        action,
        resourceKind: "file",
        resourceId: this.workspaceRelativePath(pathInput)
      });
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
  }

  /** File provenance is a Room read too: never scan artifacts from another Room. */
  private async listActiveRoomArtifactsForPath(relativePath: string): Promise<ArtifactRecord[]> {
    const context = await this.assertActiveDomainRoomAction("read");
    const access = { principal: context.participant!, roomId: context.roomId! };
    await this.roomAuthorizationService.assertResource(access.principal, {
      roomId: access.roomId,
      action: "read",
      resourceKind: "file",
      resourceId: relativePath
    });
    const artifacts = await this.listCurrentRoomResources(access, "artifact", (candidates) =>
      this.store.listArtifacts({ artifactIds: candidates.resourceIds })
    );
    return artifacts.filter((artifact) => artifact.file_ref.uri === relativePath);
  }

  /** Changes belong to Sessions, so read only the current Room's Sessions first. */
  private async listActiveRoomChangesForPath(relativePath: string): Promise<WorkspaceChangeRecord[]> {
    const context = await this.assertActiveDomainRoomAction("read");
    const access = { principal: context.participant!, roomId: context.roomId! };
    await this.roomAuthorizationService.assertResource(access.principal, {
      roomId: access.roomId,
      action: "read",
      resourceKind: "file",
      resourceId: relativePath
    });
    const sessions = await this.store.listSessions({ roomIds: [access.roomId] });
    const changes = (await Promise.all(sessions.map((session) => this.store.listWorkspaceChanges(session.id)))).flat();
    return changes.filter((change) => change.resource_ref.uri === relativePath);
  }

  private async runExternalAssistSync(input: ExternalAssistSyncInput & { role: "assistive" | "disabled" }): Promise<ExternalAssistRecord[]> {
    if (input.role === "disabled" || this.externalAssistProviders.length === 0) {
      return [];
    }
    return Promise.all(this.externalAssistProviders.map(async (provider) => {
      const now = nowIso();
      if (!provider.syncTurn) {
        return this.store.saveExternalAssistRecord({
          id: createId("external_assist"),
          phase: "sync",
          status: "skipped",
          provider_id: provider.id,
          session_id: input.sessionId,
          run_id: input.runId,
          input_message_id: input.inputMessageId,
          query: input.query,
          role: input.role,
          hints: [],
          isolated_from_memory: true,
          included_in_active_memory: false,
          created_at: now,
          updated_at: now
        });
      }
      try {
        const hints = normalizeExternalAssistHints(await provider.syncTurn(input) ?? []);
        return this.store.saveExternalAssistRecord({
          id: createId("external_assist"),
          phase: "sync",
          status: "completed",
          provider_id: provider.id,
          session_id: input.sessionId,
          run_id: input.runId,
          input_message_id: input.inputMessageId,
          query: input.query,
          role: input.role,
          hints,
          isolated_from_memory: true,
          included_in_active_memory: false,
          created_at: now,
          updated_at: now
        });
      } catch (error) {
        return this.store.saveExternalAssistRecord({
          id: createId("external_assist"),
          phase: "sync",
          status: "failed",
          provider_id: provider.id,
          session_id: input.sessionId,
          run_id: input.runId,
          input_message_id: input.inputMessageId,
          query: input.query,
          role: input.role,
          hints: [],
          error: safeRuntimeErrorMessage(error),
          isolated_from_memory: true,
          included_in_active_memory: false,
          created_at: now,
          updated_at: now
        });
      }
    }));
  }

  private async runCore05ReflectionForCompletedTurn(input: {
    kind: ReflectionRunRecord["kind"];
    session: SessionRecord;
    sourceRunId?: string;
    backendRun?: BackendRunRecord;
    userMessage?: MessageRecord;
    agentMessage?: MessageRecord;
    backendEvents: BackendEventRecord[];
    workspaceChanges: WorkspaceChangeRecord[];
    toolRuns: ToolRunRecord[];
    transcriptMessages?: MessageRecord[];
    artifacts?: ReflectionArtifactSnapshot[];
    /** Existing queued candidates from the same idle Room may share one Review call. */
    batchCandidates?: ReflectionRunRecord[];
    abortSignal?: AbortSignal;
  }): Promise<ReflectionRuntimeResult> {
    const sourceRun = input.backendRun ?? (input.sourceRunId ? await this.store.getBackendRun(input.sourceRunId) : await this.latestCompletedAgentRunForSession(input.session.id));
    const sourceRunId = input.sourceRunId ?? sourceRun?.id;
    const now = nowIso();
    const skipped = (summary: string): ReflectionRuntimeResult => ({
      reflectionRun: {
        id: createId("reflection"),
        kind: "background_review",
        ...(sourceRunId ? { source_run_id: sourceRunId } : {}),
        session_id: input.session.id,
        status: "completed",
        input_summary: summarize(input.userMessage?.content ?? input.session.title),
        output_summary: summary,
        started_at: now,
        completed_at: now
      },
      suggestions: []
    });
    if (!sourceRunId || !sourceRun || sourceRun.session_id !== input.session.id) return skipped("Skipped Background Review: no completed source Run is available.");
    const candidate = await this.store.getReflectionRunByCandidateKey(learningCandidateKey(sourceRunId));
    if (!candidate) return skipped("Skipped Background Review: this Run has no Learning candidate signals.");
    if (candidate.session_id !== input.session.id || !candidate.activity_context) {
      const failed = await this.store.updateReflectionRun({
        ...candidate,
        status: "failed",
        error: "background_review_activity_context_required",
        completed_at: nowIso()
      });
      return { reflectionRun: failed, suggestions: [] };
    }
    if (candidate.status === "completed" || candidate.status === "started") return { reflectionRun: candidate, suggestions: [] };
    try {
      await this.assertRunAgentExecution(sourceRun);
    } catch (error) {
      const deferred = await this.store.updateReflectionRun({
        ...candidate,
        status: "deferred",
        deferred_reason: "background_review_room_access_revoked",
        output_summary: "Background Review is deferred because its original Room access is no longer active.",
        completed_at: undefined
      });
      return { reflectionRun: deferred, suggestions: [] };
    }
    const settings = await this.store.getSettings();
    if (!settings.learning_enabled) {
      const deferred = await this.store.updateReflectionRun({
        ...candidate,
        status: "deferred",
        deferred_reason: "learning_disabled",
        output_summary: "Learning is disabled; the candidate remains deferred.",
        completed_at: undefined
      });
      return { reflectionRun: deferred, suggestions: [] };
    }
    if (!this.workspaceOptions.core05BackgroundReviewRunner && !this.workspaceOptions.enableBackendBackgroundReview) {
      const deferred = await this.store.updateReflectionRun({
        ...candidate,
        status: "deferred",
        deferred_reason: "background_review_not_configured",
        output_summary: "Learning review is not configured; the candidate remains deferred.",
        completed_at: undefined
      });
      return { reflectionRun: deferred, suggestions: [] };
    }
    // Budget accounting is Room-local. A review must not inspect another
    // Room's run summaries simply to decide whether it may start here.
    const roomSessions = await this.store.listSessions({ roomIds: [candidate.activity_context.room_id] });
    const [allReflectionRunLists, roomBackendRunLists] = await Promise.all([
      Promise.all(roomSessions.map((roomSession) => this.store.listReflectionRuns(roomSession.id))),
      Promise.all(roomSessions.map((roomSession) => this.store.listBackendRuns(roomSession.id)))
    ]);
    const allReflectionRuns = allReflectionRunLists.flat();
    const budget = learningBudgetDecision({
      normal_runs: roomBackendRunLists.flat(),
      source_run: sourceRun,
      ratio: settings.learning_budget_ratio,
      window_days: settings.learning_budget_window_days,
      already_spent: allReflectionRuns
        .filter((run) => run.id !== candidate.id && run.kind === "background_review" && run.status === "completed")
        .map((run) => ({ unit: run.budget_unit, amount: run.budget_estimate }))
    });
    if (!budget.allowed) {
      const deferred = await this.store.updateReflectionRun({
        ...candidate,
        status: "deferred",
        deferred_reason: budget.deferred_reason,
        budget_unit: budget.unit,
        budget_estimate: budget.estimate,
        output_summary: "Learning budget exceeded; the candidate remains deferred.",
        completed_at: undefined
      });
      return { reflectionRun: deferred, suggestions: [] };
    }
    let reflectionRun = await this.store.updateReflectionRun({
      ...candidate,
      status: "started",
      deferred_reason: undefined,
      budget_unit: budget.unit,
      budget_estimate: budget.estimate,
      output_summary: undefined,
      completed_at: undefined,
      error: undefined
    });
    try {
      throwIfAborted(input.abortSignal);
      const reflectionActivityContext = reflectionRun.activity_context;
      if (!reflectionActivityContext) throw new Error("background_review_activity_context_required");
      const evidence = await this.learningEvidenceAssembler.assemble(sourceRunId);
      if (!evidence || evidence.session.id !== input.session.id || evidence.activity_context.room_id !== reflectionActivityContext.room_id) {
        throw new Error("background_review_activity_context_required");
      }
      const relatedEvidence = (await Promise.all((input.batchCandidates ?? [])
        .filter((queued) => queued.id !== reflectionRun.id && queued.activity_context?.room_id === evidence.activity_context.room_id && Boolean(queued.source_run_id))
        .map(async (queued) => ({ candidate: queued, evidence: await this.learningEvidenceAssembler.assemble(queued.source_run_id!) }))))
        .filter((entry): entry is { candidate: ReflectionRunRecord; evidence: NonNullable<Awaited<ReturnType<LearningEvidenceAssembler["assemble"]>>> } => Boolean(entry.evidence && entry.evidence.activity_context.room_id === evidence.activity_context.room_id));
      const snapshot = await this.buildCore05ReviewSnapshot(evidence, relatedEvidence.map((entry) => entry.evidence));
      const batchCandidates = [reflectionRun, ...relatedEvidence.map((entry) => entry.candidate)];
      const needsConflictReview = batchCandidates.some((queued) => queued.candidate_signals?.some((signal) => signal.kind === "user_correction" || signal.kind === "user_negation"));
      const reviewRunner: Core05BackgroundReviewRunner = this.workspaceOptions.core05BackgroundReviewRunner
        ?? { run: (reviewSnapshot, signal) => this.runCore05BackgroundReviewWithBackend(reviewSnapshot, sourceRun, needsConflictReview, signal) };
      const explicitRule = batchCandidates.some((queued) => queued.candidate_signals?.some((signal) => signal.kind === "explicit_experience_rule"));
      const explicitMemory = batchCandidates.some((queued) => queued.candidate_signals?.some((signal) => signal.kind === "explicit_memory_save"));
      const result = await new Core05BackgroundReviewOrchestrator(reviewRunner).createMutationPlan({
        snapshot,
        activityContext: evidence.activity_context,
        hasExplicitRuleInstruction: explicitRule,
        hasExplicitMemoryInstruction: explicitMemory,
        signal: input.abortSignal
      });
      // Resource files and their history span several repositories, so the
      // Domain Operation cannot make every mutation one database transaction.
      // Keep a Room-scoped compensation point around the real write path.
      const compensationSnapshot = await this.store.createLearningSnapshot(reflectionRun.id);
      let applied: { suggestions: ReflectionSuggestionRecord[] };
      try {
        applied = await this.runtimeDomainApi.applyCore05BackgroundReview({
          reflectionRunId: reflectionRun.id,
          sessionId: evidence.session.id,
          sourceRunId: sourceRun.id,
          mutations: result.mutations
        }) as { suggestions: ReflectionSuggestionRecord[] };
      } catch (error) {
        try {
          await this.store.restoreLearningSnapshot(compensationSnapshot.id, {
            allowRoomScope: true,
            roomId: evidence.activity_context.room_id
          });
          await this.store.rollbackBackgroundReviewMetadata(reflectionRun.id);
        } catch (rollbackError) {
          const failure = new Error("background_review_compensation_failed", { cause: rollbackError });
          Object.assign(failure, { originalError: error });
          throw failure;
        }
        throw error;
      }
      const suggestions = applied.suggestions;
      reflectionRun = await this.store.updateReflectionRun({
        ...reflectionRun,
        status: "completed",
        output_summary: result.summary || (suggestions.length ? `Applied ${suggestions.length} Core 05 learning change(s).` : "No learning changes."),
        completed_at: nowIso()
      });
      await Promise.all(relatedEvidence.map(async ({ candidate: queued }) => {
        const current = await this.store.getReflectionRun(queued.id);
        if (!current || !["queued", "deferred"].includes(current.status)) return;
        await this.store.updateReflectionRun({
          ...current,
          status: "completed",
          output_summary: `Reviewed together with Room candidate ${reflectionRun.id}.`,
          completed_at: reflectionRun.completed_at
        });
      }));
      await this.store.saveLearningJobReport({
        id: createId("learning_job_report"),
        job_kind: "background_review",
        run_id: reflectionRun.id,
        target_resource_count: snapshot.memory_catalog.length + snapshot.knowledge_catalog.length + snapshot.skill_catalog.length,
        mutation_count: suggestions.length,
        archive_count: 0,
        restore_count: 0,
        patch_count: result.mutations.filter((mutation) => mutation.kind === "resource_evidence_append").length,
        merge_count: 0,
        skipped_reasons: result.mutations.length === 0 ? { no_learning_change: 1 } : {},
        evaluation_count: 0,
        duration_ms: Math.max(0, Date.parse(reflectionRun.completed_at ?? nowIso()) - Date.parse(reflectionRun.started_at)),
        created_at: nowIso()
      });
      return { reflectionRun, suggestions };
    } catch (error) {
      const status = error instanceof Error && error.message === "background_review_aborted" ? "deferred" : "failed";
      reflectionRun = await this.store.updateReflectionRun({
        ...reflectionRun,
        status,
        ...(status === "deferred" ? { deferred_reason: "background_review_aborted" } : { error: errorMessage(error) }),
        ...(status === "failed" ? { completed_at: nowIso() } : {})
      });
      return { reflectionRun, suggestions: [] };
    }
  }

  /** Existing Automation calls this only when a candidate Room has no active Backend Run. */
  private async runCore05PendingRoomReview(): Promise<ReflectionRuntimeResult> {
    // Scheduled work uses the local owner's current Room memberships as its
    // candidate boundary. It never scans queued review records from a Room
    // that the scheduler's human principal cannot currently enter.
    const visibleRoomIds = await this.listLocalOwnerVisibleRoomIds();
    const visibleSessions = await this.store.listSessions({ roomIds: [...visibleRoomIds] });
    const candidates = (await Promise.all(visibleSessions.map((session) => this.store.listReflectionRuns(session.id))))
      .flat()
      .filter((candidate) => candidate.kind === "background_review" && (candidate.status === "queued" || candidate.status === "deferred") && Boolean(candidate.source_run_id) && Boolean(candidate.activity_context))
      .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));
    const candidate = candidates[0];
    const skipped = (summary: string): ReflectionRuntimeResult => {
      const now = nowIso();
      return {
        reflectionRun: {
          id: createId("reflection"),
          kind: "background_review",
          session_id: candidate?.session_id ?? "automation",
          status: "completed",
          input_summary: "Core 05 Learning candidate scan",
          output_summary: summary,
          started_at: now,
          completed_at: now
        },
        suggestions: []
      };
    };
    if (!candidate?.source_run_id || !candidate.activity_context || !candidate.session_id) return skipped("Skipped Background Review: no queued Learning candidate exists.");
    const roomCandidates = candidates.filter((queued) => queued.activity_context?.room_id === candidate.activity_context?.room_id);
    const [sourceRun, session] = await Promise.all([
      this.store.getBackendRun(candidate.source_run_id),
      this.store.getSession(candidate.session_id)
    ]);
    if (!sourceRun || !session || session.id !== sourceRun.session_id || session.room_id !== candidate.activity_context.room_id) {
      const failed = await this.store.updateReflectionRun({
        ...candidate,
        status: "failed",
        error: "background_review_source_context_invalid",
        completed_at: nowIso()
      });
      return { reflectionRun: failed, suggestions: [] };
    }
    try {
      await this.assertRunAgentExecution(sourceRun);
    } catch {
      const deferred = await this.store.updateReflectionRun({
        ...candidate,
        status: "deferred",
        deferred_reason: "background_review_room_access_revoked",
        output_summary: "Background Review is deferred because its original Room access is no longer active.",
        completed_at: undefined
      });
      return { reflectionRun: deferred, suggestions: [] };
    }
    const roomSessions = await this.store.listSessions({ roomIds: [session.room_id] });
    const roomBackendRuns = (await Promise.all(roomSessions.map((roomSession) => this.store.listBackendRuns(roomSession.id)))).flat();
    const roomHasActiveRun = roomBackendRuns.some((run) => ["queued", "running", "waiting_for_backend_input"].includes(run.status));
    if (roomHasActiveRun) {
      const deferred = await this.store.updateReflectionRun({
        ...candidate,
        status: "deferred",
        deferred_reason: "background_review_room_active",
        output_summary: "Background Review waits until this Room is idle.",
        completed_at: undefined
      });
      return { reflectionRun: deferred, suggestions: [] };
    }
    const [messages, backendEvents, workspaceChanges, toolRuns] = await Promise.all([
      this.store.listMessages(session.id),
      this.store.listBackendEvents({ runId: sourceRun.id }),
      this.store.listWorkspaceChanges(session.id),
      this.store.listToolRuns({ runId: sourceRun.id })
    ]);
    return this.runCore05ReflectionForCompletedTurn({
      kind: "scheduled",
      session,
      sourceRunId: sourceRun.id,
      backendRun: sourceRun,
      userMessage: [...messages].reverse().find((message) => message.role === "user"),
      agentMessage: [...messages].reverse().find((message) => message.role === "agent"),
      backendEvents,
      workspaceChanges,
      toolRuns,
      transcriptMessages: messages,
      batchCandidates: roomCandidates
    });
  }

  private async buildCore05ReviewSnapshot(
    evidence: Awaited<ReturnType<LearningEvidenceAssembler["assemble"]>> extends infer T ? Exclude<T, undefined> : never,
    pendingRoomEvidence: Array<Awaited<ReturnType<LearningEvidenceAssembler["assemble"]>> extends infer T ? Exclude<T, undefined> : never> = []
  ): Promise<Core05ReviewSnapshot> {
    const access = await this.roomReadAccessForRun(evidence.backend_run);
    if (access.roomId !== evidence.activity_context.room_id) {
      throw new RuntimeRequestError("forbidden", "background_review_activity_room_mismatch");
    }
    const [memory, wiki, skills] = await Promise.all([
      this.listCurrentRoomResources(access, "memory", (candidates) =>
        this.store.listMemory({ activityContext: evidence.activity_context, ...candidates })
      ),
      this.listCurrentRoomResources(access, "wiki", (candidates) =>
        this.store.listWiki({ activeOnly: false, activityContext: evidence.activity_context, ...candidates })
      ),
      this.listCurrentRoomResources(access, "skill", (candidates) =>
        this.store.listSkills({ activityContext: evidence.activity_context, ...candidates })
      )
    ]);
    return {
      evidence,
      pending_room_evidence: pendingRoomEvidence,
      memory_catalog: memory.map((resource) => ({
        id: resource.id,
        title: resource.topic,
        version: resource.version,
        evidence_state: resource.evidence_state,
        usage_state: resource.usage_state,
        usage_scope: resource.usage_scope
      })),
      knowledge_catalog: wiki.map((resource) => ({
        id: resource.id,
        title: resource.title,
        version: resource.version,
        evidence_state: resource.evidence_state,
        usage_state: resource.usage_state,
        usage_scope: resource.usage_scope,
        summary: resource.knowledge_kind === "experience_rule" ? resource.experience_rule?.summary : resource.tags.join(", ")
      })),
      skill_catalog: skills.map((resource) => ({
        id: resource.id,
        title: resource.title,
        version: resource.frontmatter.version,
        evidence_state: resource.frontmatter.evidence_state,
        usage_state: resource.frontmatter.usage_state,
        usage_scope: resource.frontmatter.usage_scope,
        summary: resource.description
      })),
      applied_resources: evidence.used_learning_resources.filter((entry) => entry.stage === "applied")
    };
  }

  private async runCore05BackgroundReviewWithBackend(snapshot: Core05ReviewSnapshot, sourceRun: BackendRunRecord, needsConflictReview: boolean, abortSignal?: AbortSignal): Promise<Core05BackgroundReviewResult> {
    throwIfAborted(abortSignal);
    if (this.backgroundTasksClosing) throw new Error("background_review_aborted");
    const backend = this.backendRegistry.get(
      (needsConflictReview ? this.workspaceOptions.backgroundReviewConflictBackendId : undefined)
      ?? this.workspaceOptions.backgroundReviewBackendId
      ?? sourceRun.backend_id
    );
    if (!backend) return { reviewer: "background-review-unavailable", summary: "No review Backend was available.", mutations: [] };
    const sourceAgent = sourceRun.agent_id ? await this.store.getAgent(sourceRun.agent_id) : undefined;
    const prompt = core05BackgroundReviewPrompt(snapshot);
    const reviewRunId = createId("review_run");
    const textParts: string[] = [];
    this.backgroundReviewBackends.set(reviewRunId, backend);
    try {
      for await (const event of backend.runTurn({
        run_id: reviewRunId,
        session_id: snapshot.evidence.activity_context.session_id,
        room_id: snapshot.evidence.activity_context.room_id,
        ...(sourceAgent ? { agent_context: agentBackendContext(sourceAgent) } : {}),
        backend_session_id: `review:${snapshot.evidence.activity_context.room_id}:${snapshot.evidence.activity_context.session_id}:${snapshot.evidence.activity_context.agent_id}:${backend.id}`,
        input_message_id: createId("review_message"),
        workspace_root: this.store.rootDir,
        working_directory: this.backendWorkingDirectory(),
        envelope: createGatewayEnvelope(webGatewayContext, prompt),
        user_input: prompt,
        input_locale: "en",
        output_locale: "en",
        active_memory: [],
        recent_messages: [],
        available_tools: [],
        metadata: { background_review: true, core05: true, source_run_id: sourceRun.id },
        context_intent: "workspace_task"
      })) {
        throwIfAborted(abortSignal);
        if (event.event_type === "text_delta" && typeof event.payload.text === "string") textParts.push(event.payload.text);
      }
    } finally {
      this.backgroundReviewBackends.delete(reviewRunId);
    }
    const text = textParts.join("").trim();
    return text ? parseCore05BackgroundReviewResult(text) : { reviewer: backend.id, summary: "Review Backend returned no mutations.", mutations: [] };
  }

  private async runReflectionForCompletedTurn(input: {
    kind: ReflectionRunRecord["kind"];
    session: SessionRecord;
    sourceRunId?: string;
    backendRun?: BackendRunRecord;
    userMessage?: MessageRecord;
    agentMessage?: MessageRecord;
    backendEvents: BackendEventRecord[];
    workspaceChanges: WorkspaceChangeRecord[];
    toolRuns: ToolRunRecord[];
    transcriptMessages?: MessageRecord[];
    artifacts?: ReflectionArtifactSnapshot[];
    abortSignal?: AbortSignal;
  }): Promise<ReflectionRuntimeResult> {
    return this.runCore05ReflectionForCompletedTurn(input);
  }
  private async latestCompletedAgentRunForSession(sessionId: string): Promise<BackendRunRecord | undefined> {
    return (await this.store.listBackendRuns(sessionId)).find((run) => run.status === "completed" && Boolean(run.agent_id));
  }

  private async runSkillConsolidationWithBackend(input: { group_key: string; packages: Array<{ id: string; title: string; description: string; markdown: string; support_files: Array<{ path: string; content: string }> }> }, session: { id: string }) {
    const backend = this.backendRegistry.get(this.selectedBackendIdForRun((await this.store.getSettings()).default_backend_id));
    if (!backend) return undefined;
    const prompt = skillConsolidationPrompt(input);
    const envelope = createGatewayEnvelope(cronMemoryReviewGatewayContext, prompt, "en", "en");
    const textParts: string[] = [];
    for await (const event of backend.runTurn({
      run_id: createId("consolidation_run"),
      session_id: session.id,
      input_message_id: createId("consolidation_message"),
      workspace_root: this.store.rootDir,
      working_directory: this.backendWorkingDirectory(),
      envelope,
      user_input: prompt,
      input_locale: "en",
      output_locale: "en",
      active_memory: [],
      recent_messages: [],
      available_tools: [],
      metadata: { skill_consolidation: true, group_key: input.group_key },
      context_intent: "workspace_task"
    })) {
      if (event.event_type === "text_delta" && typeof event.payload.text === "string") textParts.push(event.payload.text);
    }
    const text = textParts.join("").trim();
    return text ? parseSkillConsolidationResult(text) : undefined;
  }

  private async loadReflectionArtifacts(input: {
    sessionId: string;
    sourceRunId?: string;
    workspaceChanges: WorkspaceChangeRecord[];
  }): Promise<ReflectionArtifactSnapshot[]> {
    const artifacts = await this.store.listArtifactsForSession(input.sessionId);
    const sourceArtifactIds = new Set(
      input.workspaceChanges
        .filter((change) => !input.sourceRunId || change.run_id === input.sourceRunId)
        .filter((change) => change.resource_ref.kind === "artifact")
        .map((change) => change.resource_ref.id)
    );
    const selected = (input.sourceRunId && sourceArtifactIds.size > 0
      ? artifacts.filter((artifact) => sourceArtifactIds.has(artifact.id))
      : artifacts
    ).slice(0, 5);

    const snapshots: ReflectionArtifactSnapshot[] = [];
    for (const artifact of selected) {
      const content = await this.store.readArtifactContent(artifact.id).catch(() => undefined);
      const text = typeof content === "string" ? content : undefined;
      snapshots.push({
        artifact,
        content: text ? summarize(text, 1200) : undefined,
        content_truncated: text ? text.length > 1200 : false
      });
    }
    return snapshots;
  }


  private async createOperation(
    session: SessionRecord | undefined,
    envelope: MessageEnvelope | undefined,
    operationName: string,
    proposedEffects: string[],
    options: {
      context?: GatewayContext;
      trustedContext?: TrustedDomainContext;
      inputSummary?: string;
      inputRef?: OperationRecord["input_ref"];
      targetResourceRefs?: OperationRecord["target_resource_refs"];
    } = {}
  ): Promise<OperationRecord> {
    const now = nowIso();
    const context = options.context ?? webGatewayContext;
    const trustedContext = options.trustedContext ?? this.activeDomainContext.getStore();
    const domainParticipant = trustedContext?.participant;
    const participantId = domainParticipant ? principalParticipantId(domainParticipant) : requesterParticipantIdForGatewayContext(context);
    const requestedByParticipantId = domainParticipant ? requesterParticipantId(domainParticipant) : participantId;
    const operationId = createId("operation");
    const inputRef = options.inputRef
      ?? (envelope ? {
        kind: "message",
        id: envelope.id,
        uri: `messages/${envelope.id}`,
        label: context.source === "cron" ? "Scheduled context" : "User message"
      } : trustedContext?.runId ? {
        kind: "backend_run",
        id: trustedContext.runId,
        uri: `backend-runs/${trustedContext.runId}`,
        label: "Workspace execution"
      } : {
        kind: "workspace_context",
        id: trustedContext?.correlationId ?? operationId,
        uri: "workspace/context",
        label: "Trusted Workspace context"
      });
    const operation: OperationRecord = {
      id: operationId,
      ...(session?.id ? { session_id: session.id } : trustedContext?.sessionId ? { session_id: trustedContext.sessionId } : {}),
      ...(trustedContext?.runId ? { run_id: trustedContext.runId } : {}),
      capability_id: proposalCapabilityManifest.id,
      operation: operationName,
      actor_identity: context.actor_identity,
      ...(participantId ? {
        participant_id: participantId,
        participant_kind: domainParticipant?.kind ?? "human" as const,
        ...(requestedByParticipantId ? { requested_by_participant_id: requestedByParticipantId } : {})
      } : {}),
      ...(trustedContext?.roomId ? { room_id: trustedContext.roomId } : session?.room_id ? { room_id: session.room_id } : {}),
      ...(domainParticipant ? { principal: trustedPrincipalFromParticipant(domainParticipant) } : {}),
      ...(trustedContext?.source ? { source: trustedContext.source } : {}),
      ...(trustedContext?.sessionRef ? { session_ref: trustedContext.sessionRef } : {}),
      instruction_source: context.instruction_source,
      instruction_authority: context.actor_identity,
      channel: context.channel,
      input_hash: stableHash({
        envelope: envelope ?? null,
        input_summary: options.inputSummary ?? null,
        correlation_id: trustedContext?.correlationId ?? null,
        operationName,
        proposedEffects
      }),
      input_ref: inputRef,
      target_resource_refs: options.targetResourceRefs ?? [],
      proposed_effects: proposedEffects,
      status: "created",
      ...(trustedContext?.correlationId ? { correlation_id: trustedContext.correlationId } : {}),
      created_at: now,
      updated_at: now
    };

    await this.store.saveOperation(operation);
    await this.emit("operation.created", operation);
    return operation;
  }

  private async ensureSessionForContext(
    context: GatewayContext,
    title: string,
    options: { roomId?: string } = {}
  ): Promise<SessionRecord> {
    const domainContext = this.activeDomainContext.getStore();
    if (domainContext?.sessionId) {
      const session = await this.store.getSession(domainContext.sessionId);
      if (!session?.room_id) throw new RuntimeRequestError("conflict", `session_room_missing:${domainContext.sessionId}`);
      if (options.roomId && session.room_id !== options.roomId) {
        throw new RuntimeRequestError("conflict", `scheduled_session_room_mismatch:${session.id}`);
      }
      if (domainContext.roomId && session.room_id !== domainContext.roomId) {
        throw new RuntimeRequestError("conflict", `domain_session_room_mismatch:${domainContext.sessionId}`);
      }
      if (!domainContext.participant) throw new RuntimeRequestError("forbidden", "room_participant_required");
      try {
        await this.roomAuthorizationService.assertResource(domainContext.participant, {
          roomId: session.room_id,
          action: "edit",
          resourceKind: "session",
          resourceId: session.id
        });
      } catch (error) {
        if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
        throw error;
      }
      return session;
    }
    const participantId = requesterParticipantIdForGatewayContext(context);
    // Every reuse is a fresh authorization decision. A transport label or an
    // Agent Backend's in-memory session is never enough to keep using a Room.
    if (!participantId) throw new RuntimeRequestError("forbidden", "room_participant_authentication_required");
    const principal: ParticipantPrincipal = { kind: "human", participantId };
    const requestedRoomId = options.roomId;
    if (requestedRoomId) {
      try {
        await this.roomAuthorizationService.assertRoom(principal, requestedRoomId, "edit");
      } catch (error) {
        if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
        throw error;
      }
    }
    const visibleRoomIds = requestedRoomId
      ? new Set([requestedRoomId])
      : await this.roomAuthorizationService.visibleRoomIds(principal);
    const existing = (await this.store.listSessions({ roomIds: [...visibleRoomIds] })).find((session) => session.session_key === context.session_key);
    if (existing) {
      if (!existing.room_id) throw new RuntimeRequestError("conflict", `session_room_missing:${existing.id}`);
      try {
        await this.roomAuthorizationService.assertResource(principal, {
          roomId: existing.room_id,
          action: "edit",
          resourceKind: "session",
          resourceId: existing.id
        });
      } catch (error) {
        if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
        throw error;
      }
      return existing;
    }
    const settings = await this.store.getSettings();
    const roomId = requestedRoomId ?? settings.default_room_id;
    if (!roomId || !await this.store.getRoom(roomId)) {
      throw new RuntimeRequestError("conflict", `room_not_found:${roomId ?? "default"}`);
    }
    try {
      await this.roomAuthorizationService.assertRoom(principal, roomId, "edit");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new RuntimeRequestError("forbidden", error.message);
      throw error;
    }
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: context.session_key,
      room_id: roomId,
      title,
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now,
      updated_at: now
    };
    await this.store.createSession(session);
    await this.store.ensureResourceAccessBoundary({
      resourceKind: "session", resourceId: session.id, sourceRoomId: roomId,
      ownerParticipantId: participantId, actorId: participantId
    });
    await this.emit("session.created", session);
    return session;
  }

  private async findRecentGatewayInboundDuplicate(
    channel: GatewayInboundMessageRecord["channel"],
    sourceIdentity: string,
    body: string,
    duplicateWindowMs = 60_000,
    externalMessageId?: string
  ): Promise<GatewayInboundMessageRecord | undefined> {
    const cutoff = Date.now() - duplicateWindowMs;
    const recent = await this.store.listGatewayInboundMessages({ limit: 50 });
    return recent.find((message) =>
      message.channel === channel
      && message.source_identity === sourceIdentity
      && (externalMessageId
        ? stringPayload(message.metadata.message_id) === externalMessageId || stringPayload(message.metadata.idempotency_key) === externalMessageId
        : message.body === body)
      && message.status !== "failed"
      && Date.parse(message.created_at) >= cutoff
    );
  }

  private async isGatewayRateLimited(
    channel: GatewayInboundMessageRecord["channel"],
    sourceIdentity: string,
    windowMs = 60_000,
    maxMessages = 20
  ): Promise<boolean> {
    const cutoff = Date.now() - windowMs;
    const recent = await this.store.listGatewayInboundMessages({ limit: 200 });
    const count = recent.filter((message) =>
      message.channel === channel
      && message.source_identity === sourceIdentity
      && Date.parse(message.created_at) >= cutoff
    ).length;
    return count >= maxMessages;
  }

  private resourceMutationActivityContext(context: TrustedDomainContext | undefined): TrustedWorkspaceContext {
    if (!context?.participant || !context.roomId) {
      throw new RuntimeRequestError("forbidden", "resource_mutation_room_context_required");
    }
    const principal = trustedPrincipalFromParticipant(context.participant);
    const source = context.source ?? (principal.kind === "external_app"
      ? { kind: "external_app" as const, app_id: principal.app_id }
      : { kind: "host" as const });
    return {
      // Core07 Activity records use this stable Workspace identity. Domain
      // Command execution has its own idempotency namespace, so never use its
      // root hash as a second Activity workspace identity here.
      workspace_id: "workspace",
      room_id: context.roomId,
      principal,
      source,
      correlation_id: context.correlationId,
      ...(context.sessionRef ? { session_ref: context.sessionRef } : {}),
      ...(context.runId ? { run_id: context.runId } : {})
    };
  }

  /** Operation labels follow the server-owned ingress, never a public payload. */
  private gatewayContextForTrustedDomainContext(context: TrustedDomainContext): GatewayContext {
    if (context.inputSource === "external_app" || context.participant?.kind === "external_app") {
      return {
        source: "webhook",
        actor_identity: "external_app",
        instruction_source: "external_content",
        channel: "external_app",
        session_key: `external_app:${context.source?.app_id ?? "unknown"}:${context.source?.connector_id ?? "unknown"}`
      };
    }
    if (context.inputSource === "automation" || context.inputSource === "scheduled_context") {
      return cronMemoryReviewGatewayContext;
    }
    return webGatewayContext;
  }

  private async runRecordedMutation<TResource, TExtra extends Record<string, unknown> = {}>(input: RecordedMutationInput<TResource, TExtra>): Promise<RuntimeWriteResult<TResource> & TExtra> {
    const trustedContext = input.trustedContext ?? this.activeDomainContext.getStore();
    const operation = await this.createOperation(input.session, input.envelope, input.operationName, input.proposedEffects, {
      context: input.context,
      trustedContext,
      inputSummary: input.inputSummary,
      inputRef: input.inputRef,
      targetResourceRefs: input.targetResourceRefs
    });
    let activityScope: ResourceMutationActivityScope | undefined;
    let resourceCommitted = false;

    try {
      if (input.core08Evidence) {
        activityScope = await this.resourceMutationActivity.begin({
          context: this.resourceMutationActivityContext(trustedContext),
          operation,
          instructionSummary: input.inputSummary ?? input.operationName
        });
      }
      await this.ensureRecordedMutationResourceAccessBoundaries([
        ...(input.targetResourceRefs ?? []),
        ...(input.boundaryResourceRefs ?? [])
      ], trustedContext, undefined);
      const execution = await input.execute(operation, activityScope?.activity);
      await this.ensureRecordedMutationResourceAccessBoundaries([
        ...(input.skipPostMutationTargetBoundaryCheck ? [] : input.targetResourceRefs ?? []),
        ...(input.boundaryResourceRefs ?? []),
        ...(input.resultResourceBoundaryMode === "managed_by_operation" ? [] : [execution.ref])
      ], trustedContext, execution.resource);
      operation.status = "completed";
      operation.result_ref = execution.ref;
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      resourceCommitted = true;
      if (input.core08Evidence && activityScope) {
        const change = await this.resourceMutationActivity.recordCommitted({
          scope: activityScope,
          operation,
          resourceRef: execution.ref,
          changeType: input.core08Evidence.changeType,
          ...(input.core08Evidence.stage ? { stage: input.core08Evidence.stage } : {}),
          summary: execution.summary,
          ...((resourceContentHash(execution.resource) ? { contentHash: resourceContentHash(execution.resource) } : {}))
        });
        try {
          await this.emit("workspace.change.created", change);
        } catch (error) {
          // Delivery is not the evidence itself.  Preserve the committed
          // Resource/Operation and report this separately so a retry cannot
          // create another revision merely because a client missed an event.
          throw new RuntimeRequestError(
            "workspace_change_notification_failed",
            `workspace_change_notification_failed:${safeRuntimeErrorMessage(error)}`
          );
        }
      }
      let activity: ActivityInboxItem[] = [];
      try {
        activity = await this.rebuildActivity();
      } catch {
        // Activity projection is downstream of the authoritative Operation.
        // It must not convert a committed Workspace mutation into a failure.
      }
      const { resource, ref: _ref, rollbackPoint, summary: _summary, ...extra } = execution;
      return {
        resource,
        operation,
        ...(rollbackPoint ? { rollbackPoint } : {}),
        activity,
        ...((extra as unknown) as TExtra)
      };
    } catch (error) {
      if (error instanceof ResourceMutationEvidenceError) {
        throw new RuntimeRequestError(
          "resource_mutation_evidence_failed",
          error.message,
          {
            operation_id: operation.id,
            ...(operation.result_ref ? { resource_ref: operation.result_ref } : {}),
            failure_stage: error.stage
          }
        );
      }
      if (resourceCommitted) {
        // The Resource and Operation are authoritative at this point.  A
        // post-commit error is intentionally replayed as failure rather than
        // re-running the mutation or rewriting its completed Operation.
        if (error instanceof RuntimeRequestError) throw error;
        throw new RuntimeRequestError("internal", `resource_mutation_post_commit_failed:${safeRuntimeErrorMessage(error)}`);
      }
      operation.status = "failed";
      operation.error = safeRuntimeErrorMessage(error);
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      if (input.core08Evidence) {
        await this.resourceMutationActivity.recordFailed({
          scope: activityScope,
          operation,
          code: "resource_mutation_failed",
          summary: operation.error
        });
      }
      if (error instanceof RuntimeRequestError) {
        throw error;
      }
      throw new RuntimeRequestError("conflict", operation.error);
    }
  }

  private createPolicyInput(operation: OperationRecord): PolicyEvaluationInput {
    return {
      capability_id: operation.capability_id,
      operation: operation.operation,
      actor_identity: operation.actor_identity,
      instruction_source: operation.instruction_source,
      instruction_authority: operation.instruction_authority,
      channel: operation.channel,
      target_resource_refs: operation.target_resource_refs,
      proposed_effects: operation.proposed_effects,
      prior_grants: [],
      recent_history: [],
      input_hash: operation.input_hash
    };
  }

  private async createRollbackPoint(
    operation: OperationRecord,
    affectedResources: RollbackPoint["affected_resources"],
    beforeSnapshot: RollbackPoint["before_snapshot"],
    afterSnapshot: RollbackPoint["after_snapshot"]
  ): Promise<RollbackPoint> {
    const now = nowIso();
    const expiresAt = new Date(Date.parse(now) + 1000 * 60 * 60 * 24 * 7).toISOString();
    const point: RollbackPoint = {
      id: createId("rollback"),
      operation_id: operation.id,
      affected_resources: affectedResources,
      before_snapshot: beforeSnapshot,
      after_snapshot: afterSnapshot,
      reversible: true,
      irreversible_effects: [],
      created_at: now,
      expires_at: expiresAt
    };
    return this.store.saveRollbackPoint(point);
  }

  private async generateProviderOutput(input: ProviderInput): Promise<ProviderOutput> {
    if (!this.provider) {
      throw new RuntimeRequestError("provider_not_configured", "No LLM provider is configured.");
    }

    try {
      return await this.provider.generate(input);
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        throw new RuntimeRequestError(error.code, redactSecretLikeString(error.message), undefined, {
          ...error.diagnostics,
          provider: error.diagnostics.provider ?? this.provider.id,
          model: error.diagnostics.model ?? this.provider.model
        });
      }
      throw new RuntimeRequestError("provider_failed", safeRuntimeErrorMessage(error, "Provider failed."));
    }
  }

  private async rebuildActivity(): Promise<ActivityInboxItem[]> {
    const activity = buildActivityInboxItems(await this.store.readActivityInputs());
    await this.emit("activity.updated", activity);
    return activity;
  }
}

function isRunnableBackendStatus(status: AgentBackendStatus): boolean {
  return status.configured
    && status.enabled !== false
    && (status.connection_state === "ready" || status.connection_state === "unverified");
}

function createEnvelope(
  userIntent: string,
  inputLocale: SupportedLocale,
  outputLocale: SupportedLocale,
  metadata: Record<string, unknown> = {}
): MessageEnvelope {
  return {
    id: createId("envelope"),
    source: "web",
    actor_identity: "owner",
    session_key: "web:owner:main",
    user_intent: userIntent,
    attachments: [],
    input_locale: isSupportedLocale(inputLocale) ? inputLocale : "ja",
    output_locale: isSupportedLocale(outputLocale) ? outputLocale : "ja",
    metadata: jsonRecord(metadata),
    received_at: nowIso()
  };
}

function summarize(value: string, maxLength = 160): string {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function chatActivityTrustedContext(
  session: SessionRecord,
  participantId: string,
  idempotencyKey: string,
  agentId?: string
): TrustedWorkspaceContext {
  if (!session.room_id) throw new Error("activity_context_room_required");
  return {
    // Matches the existing Native App-to-Host adapter's Workspace identity.
    workspace_id: "workspace",
    room_id: session.room_id,
    principal: agentId
      ? { kind: "agent", agent_id: agentId, requested_by_participant_id: participantId }
      : { kind: "human", participant_id: participantId },
    source: { kind: "native_app", app_id: "samurai-native" },
    correlation_id: `activity:chat:${session.id}:${idempotencyKey}`,
    session_ref: { app_id: "samurai-native", session_id: session.id }
  };
}

function activityTrustedContext(activity: ActivityRecord): TrustedWorkspaceContext {
  return {
    workspace_id: activity.workspace_id,
    room_id: activity.room_id,
    principal: activity.principal,
    source: activity.source,
    correlation_id: `activity:${activity.id}`,
    ...(activity.session_ref ? { session_ref: activity.session_ref } : {}),
    ...(activity.backend_run_id ? { run_id: activity.backend_run_id } : {})
  };
}

function activityResourceUsageId(input: {
  activityId: string;
  stage: "referenced" | "read" | "applied" | "modified" | "reverted";
  resourceRef: ResourceRef;
  contentHash?: string;
  sourceId?: string;
}): string {
  return `activity_use_${core07Hash({
    activity_id: input.activityId,
    stage: input.stage,
    resource_ref: input.resourceRef,
    content_hash: input.contentHash ?? null,
    source_id: input.sourceId ?? null
  })}`;
}

function core07Hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function resourceContentHash(resource: unknown): string | undefined {
  const record = unknownRecord(resource);
  return typeof record.content_hash === "string" && record.content_hash.trim()
    ? record.content_hash
    : undefined;
}


function activityTerminalOutcome(run: BackendRunRecord): {
  status: Exclude<ActivityRecord["status"], "recording">;
  resultSummary?: string;
  failure?: { code: string; summary: string };
} {
  if (run.status === "completed") {
    return { status: "completed", resultSummary: summarize(run.output_summary ?? "Backend run completed.", 2_000) || "Backend run completed." };
  }
  if (run.status === "cancelled") {
    return { status: "cancelled", failure: { code: run.error_code ?? "backend_cancelled", summary: "Backend run was cancelled." } };
  }
  if (run.status === "failed") {
    return { status: "failed", failure: { code: run.error_code ?? "backend_failed", summary: summarize(run.output_summary ?? "Backend run failed.", 2_000) || "Backend run failed." } };
  }
  return { status: "outcome_unknown", failure: { code: run.error_code ?? "backend_outcome_unknown", summary: "Backend run outcome is unknown." } };
}

function surfaceOperationPrompt(operation: SurfaceOperation): string {
  if (operation.kind === "form.submit") {
    return `Handle submitted form ${operation.form_id}: ${JSON.stringify(operation.values)}`;
  }
  if (operation.kind === "table.patch") {
    return `Handle table patch ${operation.table_id}${operation.row_id ? ` row ${operation.row_id}` : ""}: ${JSON.stringify(operation.changes)}`;
  }
  if (operation.kind === "chart.request") {
    return `Create or update chart ${operation.chart_id ?? operation.title}: ${operation.query}`;
  }
  if (operation.kind === "artifact.request") {
    return `Artifact ${operation.action}: ${operation.title ?? operation.artifact_id ?? "untitled"}\n${operation.instruction}`;
  }
  if (operation.kind === "custom_view.action") {
    return `Handle custom view action ${operation.view_id}/${operation.action_id}: ${JSON.stringify(operation.payload)}`;
  }
  return `Handle surface operation ${operation.kind}.`;
}

function surfaceOperationRef(operation: StructuredSurfaceOperation): ResourceRef {
  return {
    kind: "surface_operation",
    id: operation.id,
    uri: `surface-operations/${operation.id}`,
    label: operation.kind
  };
}

function negotiatedRenderSpec(operation: SurfaceOperation, spec: SurfaceRenderSpec): SurfaceRenderSpec {
  return negotiateSurfaceRenderSpec(spec, operation.renderer_capabilities);
}

function surfaceOperationArtifactTitle(operation: StructuredSurfaceOperation, sourceArtifact?: ArtifactRecord): string {
  if (operation.kind === "form.submit") {
    return `Form submission: ${operation.form_id}`;
  }
  if (operation.kind === "table.patch") {
    return `Table patch: ${operation.table_id}`;
  }
  if (operation.kind === "chart.request") {
    return operation.title;
  }
  if (operation.kind === "custom_view.action") {
    return `Custom view action: ${operation.view_id}/${operation.action_id}`;
  }
  if (operation.title) {
    return operation.title;
  }
  if (sourceArtifact) {
    return `${sourceArtifact.title} ${operation.action}`;
  }
  return "Artifact request";
}

type GatewayPairingPolicySaveRequest = Parameters<GatewayDomainService["savePairingPolicy"]>[0];
type GatewayRoutingPolicySaveRequest = Parameters<GatewayDomainService["saveRoutingPolicy"]>[0];
type GatewayPairingPolicySaveInput = GatewayPairingPolicySaveRequest | GatewayPairingPolicyRecord;
type GatewayRoutingPolicySaveInput = GatewayRoutingPolicySaveRequest | GatewayRoutingPolicyRecord;

function normalizeGatewayPairingPolicyRequest(input: GatewayPairingPolicySaveInput): GatewayPairingPolicySaveRequest {
  if ("trust_mode" in input) {
    return {
      channel: input.channel,
      status: input.status,
      trustMode: input.trust_mode,
      allowlist: input.allowlist,
      allowedTools: input.allowed_tools,
      pairingTtlMs: input.pairing_ttl_ms,
      duplicateWindowMs: input.duplicate_window_ms,
      rateLimitWindowMs: input.rate_limit_window_ms,
      rateLimitMax: input.rate_limit_max,
      metadata: input.metadata
    };
  }
  return input;
}

function normalizeGatewayRoutingPolicyRequest(input: GatewayRoutingPolicySaveInput): GatewayRoutingPolicySaveRequest {
  if ("session_key_strategy" in input) {
    return {
      channel: input.channel,
      status: input.status,
      sessionKeyStrategy: input.session_key_strategy,
      defaultAccountId: input.default_account_id,
      defaultThreadId: input.default_thread_id,
      defaultRoute: input.default_route,
      metadata: input.metadata
    };
  }
  return input;
}

function surfaceOperationArtifactContent(
  operation: StructuredSurfaceOperation,
  sourceArtifact?: ArtifactRecord,
  sourceContent?: string
): string {
  if (operation.kind === "form.submit") {
    return JSON.stringify({
      kind: "form_submission",
      form_id: operation.form_id,
      submit_label: operation.submit_label ?? null,
      values: operation.values
    }, null, 2);
  }
  if (operation.kind === "table.patch") {
    return JSON.stringify({
      kind: "table_patch",
      table_id: operation.table_id,
      row_id: operation.row_id ?? null,
      changes: operation.changes,
      rows: [{ ...operation.changes, id: operation.row_id ?? "pending" }]
    }, null, 2);
  }
  if (operation.kind === "chart.request") {
    return JSON.stringify({
      kind: "chart_request",
      chart_id: operation.chart_id ?? createId("chart"),
      title: operation.title,
      query: operation.query,
      data_refs: operation.data_refs,
      data: []
    }, null, 2);
  }
  if (operation.kind === "custom_view.action") {
    return JSON.stringify({
      kind: "custom_view_action",
      view_id: operation.view_id,
      action_id: operation.action_id,
      payload: operation.payload
    }, null, 2);
  }

  const title = surfaceOperationArtifactTitle(operation, sourceArtifact);
  const sourceSection = sourceArtifact
    ? `\n\n## Source Artifact\n\n- id: ${sourceArtifact.id}\n- title: ${sourceArtifact.title}\n- path: ${sourceArtifact.file_ref.uri}`
    : "";
  const currentContent = sourceContent?.trim()
    ? `\n\n## Current Content\n\n${sourceContent.trim()}`
    : "";
  return [
    `# ${title}`,
    `Action: ${operation.action}`,
    "",
    "## Instruction",
    operation.instruction.trim(),
    sourceSection.trim(),
    currentContent.trim()
  ].filter(Boolean).join("\n");
}

function surfaceOperationArtifactMetadata(
  operation: StructuredSurfaceOperation,
  sourceArtifact?: ArtifactRecord,
  sourceContent?: string
): Record<string, JsonValue> {
  const structuredPayload = operation.kind === "form.submit"
    ? { kind: "form_submission", form_id: operation.form_id, submit_label: operation.submit_label ?? null, values: operation.values }
    : operation.kind === "table.patch"
      ? { kind: "table_patch", table_id: operation.table_id, row_id: operation.row_id ?? null, changes: operation.changes, rows: [{ ...operation.changes, id: operation.row_id ?? "pending" }] }
      : operation.kind === "chart.request"
        ? { kind: "chart_request", chart_id: operation.chart_id ?? "", title: operation.title, query: operation.query, data_refs: operation.data_refs, data: [] }
        : operation.kind === "custom_view.action"
          ? { kind: "custom_view_action", view_id: operation.view_id, action_id: operation.action_id, payload: operation.payload }
          : undefined;
  return jsonRecord({
    ...(operation.metadata ?? {}),
    source_artifact_id: sourceArtifact?.id,
    source_artifact_uri: sourceArtifact?.file_ref.uri,
    source_artifact_hash: sourceContent ? stableHash(sourceContent) : undefined,
    structured_payload: structuredPayload
  });
}

function surfaceOperationWorkspaceSummary(operation: StructuredSurfaceOperation, artifact: ArtifactRecord): string {
  return `${operation.kind} saved as artifact ${artifact.title}.`;
}

function surfaceArtifactRenderSpec(
  operation: StructuredSurfaceOperation,
  artifact: ArtifactRecord,
  result: SurfaceArtifactRuntimeResult
): SurfaceRenderSpec {
  const refs = uniqueResourceRefs([
    artifact.file_ref,
    ...(result.sourceArtifact ? [result.sourceArtifact.file_ref] : [])
  ]);
  const artifactFallback = {
    kind: "artifact" as const,
    title: artifact.title,
    message: "Open the generated artifact if this surface renderer is unavailable.",
    props: {
      artifact_id: artifact.id,
      file_path: artifact.file_ref.uri,
      title: artifact.title
    }
  };

  if (operation.kind === "form.submit") {
    return createSurfaceRenderSpec({
      kind: "form",
      priority: "primary",
      state: "ready",
      title: operation.form_id,
      resource_refs: refs,
      props: {
        form_id: operation.form_id,
        fields: Object.entries(operation.values).map(([name, value]) => ({
          name,
          label: name,
          type: surfaceFormFieldType(value),
          default_value: value
        })),
        ...(operation.submit_label ? { submit_label: operation.submit_label } : {}),
        operation_kind: "form.submit",
        submitted: true,
        artifact_id: artifact.id
      },
      fallback: artifactFallback
    });
  }
  if (operation.kind === "table.patch") {
    return createSurfaceRenderSpec({
      kind: "table",
      priority: "primary",
      state: "ready",
      title: operation.table_id,
      resource_refs: refs,
      props: {
        table_id: operation.table_id,
        columns: Object.keys(operation.changes).map((key) => ({ key, label: key, type: "json" })),
        rows: [{ ...operation.changes, id: operation.row_id ?? artifact.id }],
        patchable: true,
        artifact_id: artifact.id
      },
      fallback: artifactFallback
    });
  }
  if (operation.kind === "chart.request") {
    return createSurfaceRenderSpec({
      kind: "chart",
      priority: "primary",
      state: "ready",
      title: operation.title,
      resource_refs: refs,
      props: {
        chart_id: operation.chart_id ?? artifact.id,
        chart_type: "table",
        data_refs: operation.data_refs,
        data: []
      },
      fallback: artifactFallback
    });
  }
  if (operation.kind === "custom_view.action") {
    const customViewContract = customViewSandboxContract(operation, refs);
    return createSurfaceRenderSpec({
      kind: "custom_view",
      priority: "primary",
      state: "ready",
      title: operation.view_id,
      resource_refs: refs,
      props: {
        view_id: operation.view_id,
        renderer: typeof operation.payload.renderer === "string" ? operation.payload.renderer : "generic",
        sandbox: customViewContract.sandbox,
        capability: customViewContract.capability,
        actions: [],
        data: {
          ...operation.payload,
          action_id: operation.action_id,
          artifact_id: artifact.id
        }
      },
      fallback: artifactFallback
    });
  }
  return createSurfaceRenderSpec({
    kind: "artifact",
    priority: "primary",
    state: "ready",
    title: artifact.title,
    resource_refs: refs,
    props: {
      artifact_id: artifact.id,
      file_path: artifact.file_ref.uri,
      title: artifact.title,
      action: operation.action,
      source_artifact_id: result.sourceArtifact?.id ?? null
    }
  });
}

function customViewSandboxContract(operation: { id?: string; view_id: string; action_id: string; allowed_action_ids?: string[] }, resourceRefs: ResourceRef[]): {
  sandbox: Record<string, JsonValue>;
  capability: Record<string, JsonValue>;
} {
  const allowedActions = operation.allowed_action_ids?.length ? operation.allowed_action_ids : [operation.action_id];
  return {
    sandbox: {
      mode: "iframe",
      allow_scripts: true,
      allow_forms: false,
      allow_same_origin: false,
      network_access: "read",
      workspace_access: "read"
    },
    capability: {
      token_id: `custom_view:${stableHash(`${operation.id ?? ""}:${operation.view_id}:${operation.action_id}`).slice(0, 16)}`,
      allowed_actions: allowedActions,
      read_resource_refs: resourceRefs.map((ref) => jsonSafe(ref)),
      write_operations: ["custom_view.action"],
      network_access: "read",
      data_url: customViewDataUrl(resourceRefs),
      data_capabilities: ["read", "write"]
    }
  };
}

function customViewDataUrl(resourceRefs: ResourceRef[]): string {
  const collectionRef = resourceRefs.find((ref) => ref.kind === "collection");
  const collectionId = collectionRef?.id
    ?? resourceRefs
      .map((ref) => ref.uri.match(/^collections\/([^/]+)/)?.[1])
      .find((id): id is string => Boolean(id))
    ?? "";
  return collectionId ? `/api/collections/${encodeURIComponent(collectionId)}/view-data` : "";
}

function surfaceFormFieldType(value: JsonValue): "text" | "textarea" | "number" | "select" | "checkbox" | "date" | "datetime" | "file" | "hidden" {
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "checkbox";
  }
  if (typeof value === "object" && value !== null) {
    return "textarea";
  }
  return "text";
}

function chatTurnRenderSpec(result: RunChatTurnResult): SurfaceRenderSpec {
  const agentMessage = result.messages.find((message) => message.role === "agent");
  return createSurfaceRenderSpec({
    kind: "chat",
    priority: "primary",
    state: result.backendRun.status === "failed" ? "error" : result.backendRun.status === "waiting_for_backend_input" ? "loading" : "ready",
    title: result.session.title,
    resource_refs: [
      {
        kind: "session",
        id: result.session.id,
        uri: `sessions/${result.session.id}`,
        label: result.session.title
      },
      {
        kind: "backend_run",
        id: result.backendRun.id,
        uri: `backend-runs/${result.backendRun.id}`,
        label: result.backendRun.input_summary
      },
      ...result.artifacts.map((artifact) => artifact.file_ref)
    ],
    props: {
      session_id: result.session.id,
      backend_run_id: result.backendRun.id,
      backend_status: result.backendRun.status,
      message_ids: result.messages.map((message) => message.id),
      primary_message_id: agentMessage?.id ?? null,
      artifact_ids: result.artifacts.map((artifact) => artifact.id),
      memory_ids: result.memories.map((memory) => memory.id),
      reflection_suggestion_ids: result.reflectionSuggestions.map((suggestion) => suggestion.id)
    },
    errors: result.backendRun.status === "failed"
      ? [{
          code: result.backendRun.error_code ?? "backend_failed",
          message: result.backendRun.output_summary ?? "Backend run failed.",
          retryable: true
        }]
      : undefined,
    fallback: result.backendRun.status === "failed"
      ? {
          kind: "run_history",
          title: "Run history",
          message: "Open run history to inspect the failed backend trace.",
          props: {
            run_ids: [result.backendRun.id],
            selected_run_id: result.backendRun.id
          }
        }
      : undefined
  });
}

const APP_EDIT_FIELD_TYPES = ["string", "text", "date", "datetime", "boolean", "number", "enum"] as const;
const GENERIC_COLLECTION_RENDERER = "collection_table";
const COLLECTION_RENDERERS = ["collection_table", "collection_gallery", "calendar_view", "collection_kanban"] as const;
type CollectionRenderer = (typeof COLLECTION_RENDERERS)[number];
const FUTURE_COLLECTION_RENDERERS = ["collection_gallery", "calendar_view", "collection_kanban", "study_deck", "document_reader"] as const;

type AppEditFieldType = (typeof APP_EDIT_FIELD_TYPES)[number];
type AppEditPatch =
  | { op: "add_field"; field: { id: string; type: AppEditFieldType; label?: string; required?: boolean; enum_values?: string[]; default_value?: JsonValue } }
  | { op: "add_derived_field"; field: { id: string; type: AppEditFieldType; label?: string; expression: JsonValue } }
  | { op: "update_field"; field_id: string; changes: { label?: string; enum_values?: string[]; type?: AppEditFieldType } }
  | { op: "hide_field"; field_id: string }
  | { op: "update_view"; view_id?: string; renderer?: CollectionRenderer; hidden_fields?: string[]; emphasized_fields?: string[]; density?: "comfortable" | "compact"; allow_delete?: boolean }
  | { op: "set_sort"; field_id: string; direction: "asc" | "desc"; completed_last?: boolean }
  | { op: "set_group"; field_id: string }
  | { op: "set_permissions"; allow_delete?: boolean };

interface AppEditPatchOptions {
  viewId?: string;
  targetDescription?: string;
  renderer?: string;
}

type GenericCollectionLinkedData = {
  ref_options: Record<string, Array<Record<string, JsonValue>>>;
  ref_records: Record<string, Record<string, Record<string, JsonValue>>>;
  embed_records: Record<string, Record<string, JsonValue> | null>;
  target_collection_ids: string[];
  missing_refs: Array<Record<string, JsonValue>>;
};

const emptyGenericCollectionLinkedData: GenericCollectionLinkedData = {
  ref_options: {},
  ref_records: {},
  embed_records: {},
  target_collection_ids: [],
  missing_refs: []
};

function genericCollectionRenderSpec(
  schema: CollectionSchema,
  records: CollectionRecordWithFilePath[],
  requestedViewId?: string,
  linkedData: GenericCollectionLinkedData = emptyGenericCollectionLinkedData
): SurfaceRenderSpec {
  const viewConfig = genericCollectionViewConfig(schema, requestedViewId);
  const viewOptions = genericCollectionViewOptions(schema);
  const recordData = records.map((record) => genericCollectionRecordRenderData(record, schema, records, linkedData));
  const refs = records.map(collectionRecordRef);
  const title = schema.labels?.ja ?? schema.labels?.en ?? schema.id;
  const recordIds = recordData.map((record) => String(record.id));
  const viewState = collectionViewState({
    collectionId: schema.id,
    viewConfig,
    renderer: String(viewConfig.renderer),
    recordCount: recordData.length
  });
  return createSurfaceRenderSpec({
    kind: "custom_view",
    priority: "secondary",
    state: "ready",
    title,
    resource_refs: refs.length > 0 ? refs : [{
      kind: "collection",
      id: schema.id,
      uri: `collections/${schema.id}`,
      label: schema.id
    }],
    props: {
      view_id: String(viewConfig.id),
      renderer: String(viewConfig.renderer),
      renderer_version: "1",
      view_state: viewState,
      schema_ref: `collections/${schema.id}/schema.json`,
      actions: genericCollectionActions(schema, String(viewConfig.id)),
      data: {
        collection_id: schema.id,
        records: recordData,
        schema_fields: genericCollectionSchemaFields(schema, linkedData),
        view_config: viewConfig,
        view_options: viewOptions,
        view_state: viewState,
        linked_data: linkedData as unknown as JsonValue,
        counts: {
          total: recordData.length
        },
        record_ids: recordIds
      }
    },
    fallback: {
      kind: "collection",
      title: schema.id,
      message: "Open this Collection if the app renderer is unavailable.",
      props: {
        collection_id: schema.id,
        schema_id: schema.id,
        record_ids: recordIds
      }
    }
  });
}

function collectionActionGeneratedCustomViewRenderSpec(
  operation: Extract<SurfaceOperation, { kind: "collection.action.run" }>,
  collectionRenderSpec: SurfaceRenderSpec,
  actionResult: CollectionActionRuntimeResult
): SurfaceRenderSpec | undefined {
  const customView = collectionActionResultCustomView(actionResult);
  if (!customView) {
    return undefined;
  }
  const viewId = stringPayload(customView.view_id)
    || `${operation.collection_id}_${operation.action_id}_custom`;
  const renderer = stringPayload(customView.renderer) || "generic";
  const actions = collectionActionGeneratedCustomViewActions(customView);
  const allowedActionIds = actions.map((action) => stringPayload(action.id)).filter(Boolean);
  const contract = customViewSandboxContract({
    id: operation.id,
    view_id: viewId,
    action_id: operation.action_id,
    allowed_action_ids: allowedActionIds.length > 0 ? allowedActionIds : [operation.action_id]
  }, collectionRenderSpec.resource_refs);
  const collectionData = recordPayload(collectionRenderSpec.props.data);
  const sourceViewState = recordPayload(collectionData.view_state);
  const data: Record<string, JsonValue> = {
    ...customView,
    collection_id: operation.collection_id,
    source_collection_view_id: String(collectionRenderSpec.props.view_id ?? ""),
    source_action_id: operation.action_id,
    source_view_state: sourceViewState,
    source_collection: collectionData
  };
  return createSurfaceRenderSpec({
    kind: "custom_view",
    priority: "primary",
    state: "ready",
    title: stringPayload(customView.title) || collectionRenderSpec.title || operation.action_id,
    resource_refs: collectionRenderSpec.resource_refs,
    props: {
      view_id: viewId,
      renderer,
      renderer_version: stringPayload(customView.renderer_version) || "1",
      sandbox: contract.sandbox,
      capability: contract.capability,
      actions,
      data
    },
    fallback: {
      kind: "collection",
      title: collectionRenderSpec.title || operation.collection_id,
      message: "Open the source Collection if this custom view is unavailable.",
      props: {
        collection_id: operation.collection_id,
        view_id: String(collectionRenderSpec.props.view_id ?? "")
      }
    }
  });
}

function collectionActionResultCustomView(result: CollectionActionRuntimeResult): Record<string, JsonValue> | undefined {
  const resource = unknownRecord(result.resource);
  const customView = recordPayload(resource.custom_view as JsonValue | undefined);
  return Object.keys(customView).length > 0 ? customView : undefined;
}

function collectionActionGeneratedCustomViewActions(customView: Record<string, JsonValue>): Array<Record<string, JsonValue>> {
  if (!Array.isArray(customView.actions)) {
    return [];
  }
  return customView.actions.flatMap((item) => {
    const action = recordPayload(item);
    const id = stringPayload(action.id);
    const label = stringPayload(action.label);
    if (!id || !label) {
      return [];
    }
    return [{
      id,
      label,
      operation_kind: "custom_view.action",
      ...(stringPayload(action.action_kind) ? { action_kind: stringPayload(action.action_kind) } : {}),
      ...(stringPayload(action.description) ? { description: stringPayload(action.description) } : {}),
      ...(stringPayload(action.scope) === "collection" || stringPayload(action.scope) === "record" ? { scope: stringPayload(action.scope) } : {})
    }];
  });
}

function isCollectionRenderSpecForId(spec: SurfaceRenderSpec, collectionId: string): boolean {
  if (!collectionId || spec.kind !== "custom_view" || !isCollectionRenderer(String(spec.props.renderer ?? ""))) {
    return false;
  }
  const data = spec.props.data;
  return typeof data === "object"
    && data !== null
    && !Array.isArray(data)
    && (data as Record<string, unknown>).collection_id === collectionId;
}

interface CollectionPresentationDescriptor {
  status: "ready";
  kind: "collection_app";
  collection_id: string;
  view_id: string;
  renderer: string;
  title?: string;
  subtitle?: string;
  record_count?: number;
  record_id?: string;
  view_state?: Record<string, JsonValue>;
}

function collectionPresentationDescriptorFromQueryResult(
  result: unknown,
  providerInput: Record<string, JsonValue>
): CollectionPresentationDescriptor {
  const output = recordPayload(jsonSafe(result));
  const collectionId = stringPayload(output.collection_id);
  const viewId = stringPayload(output.view_id);
  const schema = CollectionSchemaSchema.safeParse(output.schema);
  const recordCount = output.record_count;
  const renderSpec = recordPayload(output.render_spec);
  const renderSpecProps = recordPayload(renderSpec.props);
  const renderer = stringPayload(renderSpecProps.renderer);
  if (!collectionId || !viewId || !schema.success || typeof recordCount !== "number" || !Number.isInteger(recordCount)
    || recordCount < 0 || !renderer || !isMessagePresentationRenderer(renderer)) {
    throw new RuntimeRequestError("internal", "collection_view_query_output_invalid");
  }
  const recordId = stringPayload(providerInput.record_id);
  const viewState = recordPayload(renderSpecProps.view_state);
  return {
    status: "ready",
    kind: "collection_app",
    collection_id: collectionId,
    view_id: viewId,
    renderer,
    title: collectionDisplayTitle(schema.data),
    subtitle: `${collectionId} ・ ${recordCount}件`,
    record_count: recordCount,
    ...(recordId ? { record_id: recordId } : {}),
    ...(Object.keys(viewState).length > 0 ? { view_state: viewState } : {})
  };
}

interface CollectionPresentationAmbiguity {
  status: "ambiguous";
  query: string;
  message: string;
  candidates: Array<Record<string, JsonValue>>;
}

type CollectionPresentationResolution = CollectionPresentationDescriptor | CollectionPresentationAmbiguity;

function messagePresentationDescriptorFromToolOutput(payload: Record<string, JsonValue>): CollectionPresentationDescriptor | undefined {
  const output = payload.output && typeof payload.output === "object" && !Array.isArray(payload.output)
    ? payload.output as Record<string, JsonValue>
    : payload;
  if (output.status !== "ready" || output.kind !== "collection_app") {
    return undefined;
  }
  const collectionId = typeof output.collection_id === "string" ? output.collection_id.trim() : "";
  if (!collectionId) {
    return undefined;
  }
  const viewId = typeof output.view_id === "string" && output.view_id.trim() ? output.view_id.trim() : `${collectionId}_table`;
  const renderer = typeof output.renderer === "string" && output.renderer.trim() ? output.renderer.trim() : GENERIC_COLLECTION_RENDERER;
  if (!isMessagePresentationRenderer(renderer)) {
    return undefined;
  }
  const recordCount = typeof output.record_count === "number" && Number.isFinite(output.record_count) && output.record_count >= 0
    ? output.record_count
    : undefined;
  const recordId = typeof output.record_id === "string" && output.record_id.trim() ? output.record_id.trim() : undefined;
  const viewState = output.view_state && typeof output.view_state === "object" && !Array.isArray(output.view_state)
    ? output.view_state as Record<string, JsonValue>
    : undefined;
  return {
    status: "ready",
    kind: "collection_app",
    collection_id: collectionId,
    view_id: viewId,
    renderer,
    ...(typeof output.title === "string" && output.title.trim() ? { title: output.title.trim() } : {}),
    ...(typeof output.subtitle === "string" && output.subtitle.trim() ? { subtitle: output.subtitle.trim() } : {}),
    ...(recordCount !== undefined ? { record_count: recordCount } : {}),
    ...(recordId ? { record_id: recordId } : {}),
    ...(viewState ? { view_state: viewState } : {})
  };
}

function isMessagePresentationRenderer(renderer: string): boolean {
  return isCollectionRenderer(renderer);
}

function collectionPresentationDescriptorsFromBackendEvents(events: BackendEventRecord[]): CollectionPresentationDescriptor[] {
  return events
    .filter((event) => event.event_type === "tool_call_output")
    .map((event) => messagePresentationDescriptorFromToolOutput(event.payload))
    .filter((descriptor): descriptor is CollectionPresentationDescriptor => Boolean(descriptor));
}

function messagePresentationFromDescriptor(descriptor: CollectionPresentationDescriptor, sessionId: string, messageId: string): MessagePresentationRecord {
  const now = nowIso();
  const viewState = collectionDescriptorViewState(descriptor);
  return {
    id: createId("presentation"),
    session_id: sessionId,
    message_id: messageId,
    kind: "collection_app",
    title: descriptor.title ?? descriptor.collection_id,
    subtitle: descriptor.subtitle ?? `${descriptor.collection_id} ・ 0件`,
    collection_id: descriptor.collection_id,
    view_id: descriptor.view_id,
    renderer: descriptor.renderer,
    ...(Object.keys(viewState).length > 0 ? { view_state: viewState } : {}),
    created_at: now,
    updated_at: now
  };
}

function collectionDescriptorViewState(descriptor: CollectionPresentationDescriptor): Record<string, JsonValue> {
  return {
    collection_id: descriptor.collection_id,
    view_id: descriptor.view_id,
    renderer: descriptor.renderer,
    ...(typeof descriptor.record_count === "number" ? { record_count: descriptor.record_count } : {}),
    ...(descriptor.view_state ?? {}),
    ...(descriptor.record_id
      ? {
          record_id: descriptor.record_id,
          selected_record_id: descriptor.record_id
        }
      : {})
  };
}

function collectionPresentationAmbiguityMessage(candidates: Array<Record<string, JsonValue>>, outputLocale: SupportedLocale): string {
  const candidateLines = candidates.slice(0, 8).map((candidate) => {
    const title = typeof candidate.title === "string" && candidate.title.trim()
      ? candidate.title.trim()
      : typeof candidate.collection_id === "string" && candidate.collection_id.trim()
        ? candidate.collection_id.trim()
        : typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : "Untitled";
    const id = typeof candidate.collection_id === "string" && candidate.collection_id.trim()
      ? candidate.collection_id.trim()
      : typeof candidate.id === "string" && candidate.id.trim()
        ? candidate.id.trim()
        : "";
    return id && id !== title ? `- ${title} (${id})` : `- ${title}`;
  });
  if (outputLocale === "ja") {
    return [
      "候補が複数あります。どれを開くか教えてください。",
      ...candidateLines
    ].join("\n").trim();
  }
  return [
    "Multiple matches were found. Tell me which one to open.",
    ...candidateLines
  ].join("\n").trim();
}

function mergePresentations(primary: MessagePresentationRecord[], fallback: MessagePresentationRecord[]): MessagePresentationRecord[] {
  const merged: MessagePresentationRecord[] = [];
  const seen = new Set<string>();
  for (const presentation of [...primary, ...fallback]) {
    const key = `${presentation.message_id}:${presentation.collection_id}:${presentation.view_id}:${presentation.renderer}:${String(presentation.view_state?.record_id ?? "")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(presentation);
  }
  return merged;
}

function applyCollectionPresentationViewState(spec: SurfaceRenderSpec, viewState?: Record<string, JsonValue>): SurfaceRenderSpec {
  const patch = jsonRecordOrEmpty(viewState);
  if (Object.keys(patch).length === 0 || spec.kind !== "custom_view") {
    return spec;
  }
  const nextState = {
    ...collectionRenderSpecViewState(spec),
    ...patch
  };
  const collectionId = collectionRenderSpecCollectionId(spec);
  const viewId = typeof nextState.view_id === "string" && nextState.view_id.trim()
    ? nextState.view_id.trim()
    : collectionRenderSpecViewId(spec, collectionId);
  const renderer = typeof nextState.renderer === "string" && nextState.renderer.trim()
    ? nextState.renderer.trim()
    : typeof spec.props.renderer === "string" && spec.props.renderer.trim()
      ? spec.props.renderer.trim()
      : GENERIC_COLLECTION_RENDERER;
  const data = spec.props.data;
  const dataRecord = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, JsonValue>
    : undefined;
  const nextData = dataRecord
    ? {
        ...dataRecord,
        view_config: {
          ...jsonRecordOrEmpty(dataRecord.view_config),
          id: viewId,
          renderer
        },
        view_state: nextState
      }
    : data;
  return {
    ...spec,
    props: {
      ...spec.props,
      view_id: viewId,
      renderer,
      view_state: nextState,
      ...(nextData !== data ? { data: nextData as JsonValue } : {})
    }
  };
}

function collectionPresentationUserViewStatePatch(viewState: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(viewState).filter(([key]) => ![
    "collection_id",
    "view_id",
    "renderer",
    "record_count"
  ].includes(key))) as Record<string, JsonValue>;
}

function messagePresentationFromRenderSpec(spec: SurfaceRenderSpec, sessionId: string, messageId: string): MessagePresentationRecord | undefined {
  if (spec.kind !== "custom_view" || !isCollectionRenderer(String(spec.props.renderer ?? ""))) {
    return undefined;
  }
  const collectionId = collectionRenderSpecCollectionId(spec);
  if (!collectionId) {
    return undefined;
  }
  const records = collectionRenderSpecRecords(spec);
  const viewState = collectionRenderSpecViewState(spec);
  const now = nowIso();
  return {
    id: createId("presentation"),
    session_id: sessionId,
    message_id: messageId,
    kind: "collection_app",
    title: typeof spec.title === "string" && spec.title.trim() ? spec.title : collectionId,
    subtitle: `${collectionId} ・ ${records.length}件`,
    collection_id: collectionId,
    view_id: collectionRenderSpecViewId(spec, collectionId),
    renderer: typeof spec.props.renderer === "string" ? spec.props.renderer : GENERIC_COLLECTION_RENDERER,
    ...(Object.keys(viewState).length > 0 ? { view_state: viewState } : {}),
    created_at: now,
    updated_at: now
  };
}

function collectionViewState(input: {
  collectionId: string;
  viewConfig: Record<string, JsonValue>;
  renderer: string;
  recordCount: number;
  extra?: Record<string, JsonValue>;
}): Record<string, JsonValue> {
  const state: Record<string, JsonValue> = {
    collection_id: input.collectionId,
    view_id: String(input.viewConfig.id ?? `${input.collectionId}_table`),
    renderer: input.renderer,
    record_count: input.recordCount,
    ...(input.extra ?? {})
  };
  for (const [sourceKey, targetKey] of [
    ["sort", "sort"],
    ["filter", "filter"],
    ["filters", "filter"],
    ["group", "group"],
    ["group_by", "group"],
    ["selected_record_id", "selected_record_id"]
  ] as const) {
    if (state[targetKey] !== undefined) {
      continue;
    }
    const value = input.viewConfig[sourceKey];
    if (isJsonValue(value) && value !== undefined) {
      state[targetKey] = value;
    }
  }
  return state;
}

function collectionRenderSpecViewState(spec: SurfaceRenderSpec): Record<string, JsonValue> {
  const collectionId = collectionRenderSpecCollectionId(spec);
  const renderer = typeof spec.props.renderer === "string" ? spec.props.renderer : GENERIC_COLLECTION_RENDERER;
  const records = collectionRenderSpecRecords(spec);
  const data = spec.props.data;
  const dataViewState = data && typeof data === "object" && !Array.isArray(data)
    ? jsonRecordOrEmpty((data as Record<string, unknown>).view_state)
    : {};
  const propsViewState = jsonRecordOrEmpty(spec.props.view_state);
  return {
    collection_id: collectionId,
    view_id: collectionRenderSpecViewId(spec, collectionId),
    renderer,
    record_count: records.length,
    ...dataViewState,
    ...propsViewState
  };
}

function jsonRecordOrEmpty(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter(([, item]) => isJsonValue(item))) as Record<string, JsonValue>;
}

function collectionRenderSpecCollectionId(spec: SurfaceRenderSpec): string {
  const data = spec.props.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const collectionId = (data as Record<string, unknown>).collection_id;
    if (typeof collectionId === "string" && collectionId.trim()) {
      return collectionId;
    }
  }
  const fallbackProps = spec.fallback?.props;
  if (fallbackProps && typeof fallbackProps === "object" && !Array.isArray(fallbackProps)) {
    const collectionId = (fallbackProps as Record<string, unknown>).collection_id;
    if (typeof collectionId === "string" && collectionId.trim()) {
      return collectionId;
    }
  }
  return spec.resource_refs.find((item) => item.kind === "collection" && item.id)?.id ?? "";
}

function collectionRenderSpecViewId(spec: SurfaceRenderSpec, collectionId: string): string {
  if (typeof spec.props.view_id === "string" && spec.props.view_id.trim()) {
    return spec.props.view_id;
  }
  const data = spec.props.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const viewConfig = (data as Record<string, unknown>).view_config;
    if (viewConfig && typeof viewConfig === "object" && !Array.isArray(viewConfig)) {
      const viewId = (viewConfig as Record<string, unknown>).id;
      if (typeof viewId === "string" && viewId.trim()) {
        return viewId;
      }
    }
  }
  return `${collectionId}_table`;
}

function collectionRenderSpecRecords(spec: SurfaceRenderSpec): Array<Record<string, unknown>> {
  const data = spec.props.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [];
  }
  const records = (data as Record<string, unknown>).records;
  return Array.isArray(records) ? records.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function collectionSchemaSignature(schema: CollectionSchemaWithFilePath): string {
  const { file_path: _filePath, ...schemaBody } = schema;
  return JSON.stringify(schemaBody);
}

function collectionDisplayTitle(schema: CollectionSchema): string {
  return schema.labels?.ja ?? schema.labels?.en ?? schema.id;
}

function collectionSchemaSearchResult(schema: CollectionSchemaWithFilePath): Record<string, JsonValue> {
  const viewConfig = genericCollectionViewConfig(schema);
  return {
    kind: "collection_schema",
    collection_id: schema.id,
    id: schema.id,
    title: collectionDisplayTitle(schema),
    description: schema.descriptions?.ja ?? schema.descriptions?.en ?? "",
    file_path: schema.file_path,
    view_id: String(viewConfig.id),
    renderer: String(viewConfig.renderer)
  };
}

function matchCollectionSchemas(schemas: CollectionSchemaWithFilePath[], query: string): CollectionSchemaWithFilePath[] {
  const exactIdentityMatches = exactIdentityCollectionSchemaMatches(schemas, query);
  if (exactIdentityMatches.length > 0) {
    return exactIdentityMatches;
  }
  const normalizedQuery = normalizeCollectionSearchText(query);
  if (!normalizedQuery) {
    return schemas;
  }
  const exact = schemas.filter((schema) => collectionSchemaSearchTexts(schema).some((text) => text === normalizedQuery));
  if (exact.length > 0) {
    return exact;
  }
  const substringMatches = schemas.filter((schema) => collectionSchemaSearchTexts(schema).some((text) => text.includes(normalizedQuery) || normalizedQuery.includes(text)));
  if (substringMatches.length > 0) {
    return substringMatches;
  }
  const queryTerms = collectionSearchTermsFromQuery(query);
  if (queryTerms.length === 0) {
    return [];
  }
  return schemas.filter((schema) => {
    const texts = collectionSchemaSearchTexts(schema);
    return queryTerms.some((term) => texts.some((text) => text.includes(term) || term.includes(text)));
  });
}

function exactIdentityCollectionSchemaMatches(schemas: CollectionSchemaWithFilePath[], query: string): CollectionSchemaWithFilePath[] {
  const normalizedQuery = normalizeCollectionExactIdentityText(query);
  if (!normalizedQuery) {
    return [];
  }
  let bestLength = 0;
  const matches: CollectionSchemaWithFilePath[] = [];
  const seen = new Set<string>();
  for (const schema of schemas) {
    const identityTexts = collectionSchemaExactIdentityTexts(schema);
    const matchedLength = identityTexts.reduce((best, text) => {
      if (!isSpecificCollectionExactIdentityText(text)) {
        return best;
      }
      if (normalizedQuery === text || normalizedQuery.includes(text)) {
        return Math.max(best, text.length);
      }
      return best;
    }, 0);
    if (matchedLength === 0) {
      continue;
    }
    if (matchedLength > bestLength) {
      bestLength = matchedLength;
      matches.length = 0;
      seen.clear();
    }
    if (matchedLength === bestLength && !seen.has(schema.id)) {
      matches.push(schema);
      seen.add(schema.id);
    }
  }
  return matches;
}

function isSpecificCollectionExactIdentityText(text: string): boolean {
  return text.length >= 8 || /[0-9_]/.test(text);
}

function collectionSchemaExactIdentityTexts(schema: CollectionSchema): string[] {
  const seen = new Set<string>();
  return [schema.id, ...localizedRecordValues(schema.labels)]
    .map((value) => normalizeCollectionExactIdentityText(value))
    .filter((text) => {
      if (!text || seen.has(text)) {
        return false;
      }
      seen.add(text);
      return true;
    });
}

function collectionSchemaSearchTexts(schema: CollectionSchema): string[] {
  const fields = genericCollectionSchemaFields(schema)
    .flatMap((field) => [field.id, field.label])
    .map((item) => typeof item === "string" ? item : "")
    .filter(Boolean);
  return collectionSearchTextsWithAliases([...collectionSchemaIdentitySearchTexts(schema), ...fields]);
}

function collectionSchemaIdentitySearchTexts(schema: CollectionSchema): string[] {
  return collectionSearchTextsWithAliases([
    schema.id,
    ...localizedRecordValues(schema.labels),
    ...localizedRecordValues(schema.descriptions)
  ]);
}

function localizedRecordValues(value: Record<string, string> | undefined): string[] {
  return Object.values(value ?? {}).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function shouldUseRecentCollectionForViewRequest(query: string, matches: CollectionSchemaWithFilePath[]): boolean {
  if (!shouldUpdateCollectionViewOutput(query)) {
    return false;
  }
  if (matches.length === 0) {
    return true;
  }
  const normalizedQuery = normalizeCollectionSearchText(query);
  const hasCollectionIdentity = matches.some((schema) =>
    collectionSchemaIdentitySearchTexts(schema)
      .some((text) => text.length >= 2 && normalizedQuery.includes(text))
  );
  return !hasCollectionIdentity;
}

function collectionViewIdAfterPatch(schema: CollectionSchema, patches: AppEditPatch[], fallbackViewId: string): string {
  const viewPatch = [...patches].reverse().find((patch): patch is Extract<AppEditPatch, { op: "update_view" }> => patch.op === "update_view");
  if (viewPatch?.view_id) {
    return viewPatch.view_id;
  }
  if (viewPatch?.renderer) {
    return collectionViewIdForRenderer(schema, viewPatch.renderer);
  }
  return fallbackViewId;
}

function reusableCollectionViewState(value?: Record<string, JsonValue>): Record<string, JsonValue> {
  if (!value) {
    return {};
  }
  const allowed = new Set(["search", "sort", "filter", "group", "selected_date", "selected_record_id"]);
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => allowed.has(key) && isJsonValue(item))) as Record<string, JsonValue>;
}

function collectionSortStateFromQuery(schema: CollectionSchema, query: string): Record<string, JsonValue> | undefined {
  if (!/(順|並び|並べ|sort|高い|低い|大きい|小さい|多い|少ない|新しい|古い|昇順|降順|ordenar|ordem|orden|trier|tri|sortieren|정렬|排序|puntuación|pontuação|score|rating)/i.test(query)) {
    return undefined;
  }
  const field = collectionSchemaFieldFromQuery(schema, query)
    ?? collectionPreferredSortField(schema, query);
  if (!field) {
    return undefined;
  }
  return {
    field_id: String(field.id ?? ""),
    direction: collectionSortDirectionFromQuery(field, query)
  };
}

function collectionFilterStateFromQuery(schema: CollectionSchema, query: string): Record<string, JsonValue> | undefined {
  const normalizedQuery = normalizeCollectionSearchText(query);
  if (!normalizedQuery) {
    return undefined;
  }
  for (const field of genericCollectionSchemaFields(schema).filter((item) => item.type === "enum")) {
    const values = collectionSchemaEnumValues(field)
      .map((value) => ({
        value,
        aliases: collectionEnumValueSearchAliases(value)
          .filter((alias) => isCollectionEnumFilterAlias(alias))
          .sort((left, right) => right.length - left.length)
      }))
      .filter((item) => item.aliases.length > 0)
      .sort((left, right) => (right.aliases[0]?.length ?? 0) - (left.aliases[0]?.length ?? 0));
    const match = values.find((item) => item.aliases.some((alias) =>
      normalizedQuery.includes(alias) && !isAmbiguousViewVerbFilterAlias(query, alias)
    ));
    if (match) {
      return {
        field_id: String(field.id ?? ""),
        value: match.value
      };
    }
  }
  return undefined;
}

function isAmbiguousViewVerbFilterAlias(query: string, alias: string): boolean {
  const ambiguousAliases = new Set([
    normalizeCollectionSearchText("見たい"),
    normalizeCollectionSearchText("見た")
  ]);
  if (!ambiguousAliases.has(alias)) {
    return false;
  }
  return !hasCollectionFilterIntent(query);
}

function hasCollectionFilterIntent(query: string): boolean {
  return /(観たい|読みたい|観た|見た(?!い)|読んだ|完了|済み|だけ|のみ|絞|フィルタ|filter|ステータス|状態|status|todo|to watch|watchlist|want to watch|want to read|wishlist|pending|not done|unwatched|unread|watched|seen|done|completed|pendiente|por ver|quiero ver|quero ver|à voir|a voir|보고싶은|읽고싶은|想看|想读|想讀|未看|未読|未讀)/i.test(query);
}

function collectionEnumValueSearchAliases(value: string): string[] {
  const normalized = normalizeCollectionSearchText(value);
  if (!normalized) {
    return [];
  }
  const aliases = new Set<string>([normalized]);
  for (const group of collectionMultilingualSearchTermGroups) {
    const normalizedGroup = group.map((term) => normalizeCollectionSearchText(term)).filter((term) => term.length >= 2);
    if (normalizedGroup.includes(normalized)) {
      for (const term of normalizedGroup) {
        aliases.add(term);
      }
    }
  }
  return Array.from(aliases);
}

function isCollectionEnumFilterAlias(alias: string): boolean {
  if (!alias) {
    return false;
  }
  return /[^\x00-\x7F]/.test(alias) ? alias.length >= 2 : alias.length >= 4;
}

function collectionSchemaFieldFromQuery(schema: CollectionSchema, query: string): Record<string, JsonValue> | undefined {
  const normalizedQuery = normalizeCollectionSearchText(query);
  return genericCollectionSchemaFields(schema).find((field) =>
    collectionSchemaFieldSearchTexts(field)
      .some((text) => text.length >= 2 && normalizedQuery.includes(text))
  );
}

function collectionPreferredSortField(schema: CollectionSchema, query: string): Record<string, JsonValue> | undefined {
  const fields = genericCollectionSchemaFields(schema);
  if (/評価|rating|score|点数|スコア|puntuación|pontuação|bewertung|평점|评分|評分/i.test(query)) {
    return fields.find((field) => collectionSchemaFieldSearchTexts(field).some((text) => /評価|rating|score|点数|スコア/.test(text)));
  }
  if (/日付|期限|date|day|due|deadline|新しい|古い|fecha|data|datum|날짜|日期/i.test(query)) {
    return collectionSchemaDateField(schema);
  }
  if (/タイトル|名前|title|name|título|titulo|nome|nom|제목|名称|名稱/i.test(query)) {
    return fields.find((field) => collectionSchemaFieldSearchTexts(field).some((text) => /タイトル|名前|title|name/.test(text)));
  }
  return undefined;
}

function collectionSortDirectionFromQuery(field: Record<string, JsonValue>, query: string): "asc" | "desc" {
  if (/昇順|低い|小さい|少ない|古い|asc|ascending|a-z|ascendente|crescente|croissant|aufsteigend|오름차순|升序/i.test(query)) {
    return "asc";
  }
  if (/降順|高い|大きい|多い|新しい|最近|desc|descending|z-a|descendente|decrescente|décroissant|decroissant|absteigend|내림차순|降序/i.test(query)) {
    return "desc";
  }
  const type = String(field.type ?? "");
  const texts = collectionSchemaFieldSearchTexts(field).join(" ");
  if (type === "string" || type === "text" || /タイトル|名前|title|name/.test(texts)) {
    return "asc";
  }
  return "desc";
}

function collectionSchemaFieldSearchTexts(field: Record<string, JsonValue>): string[] {
  return [field.id, field.label]
    .map((item) => typeof item === "string" ? normalizeCollectionSearchText(item) : "")
    .filter(Boolean);
}

function collectionSchemaEnumValues(field: Record<string, JsonValue>): string[] {
  return Array.isArray(field.enum_values)
    ? field.enum_values.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeCollectionSearchText(value: string): string {
  return normalizeCollectionSearchTextBase(value)
    .replace(/アプリ|collection|コレクション|一覧|ログ/g, "")
    .replace(/\bapp\b/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeCollectionExactIdentityText(value: string): string {
  return normalizeCollectionSearchTextBase(value)
    .replace(/\s+/g, "")
    .trim();
}

function normalizeCollectionSearchTextBase(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function collectionSearchTermsFromQuery(query: string): string[] {
  const stripped = collectionGenericSearchTerms.reduce(
    (text, term) => text.split(term).join(" "),
    normalizeCollectionSearchTextBase(query)
  )
    .replace(/[をにへとがはもでやの]/g, " ")
    .replace(/[^\p{L}\p{N}_]+/gu, " ");
  const seen = new Set<string>();
  return stripped
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .flatMap((term) => collectionSearchTextAliases(term))
    .filter((term) => {
      if (seen.has(term)) {
        return false;
      }
      seen.add(term);
      return true;
    });
}

function collectionSearchTextsWithAliases(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  return values
    .flatMap((value) => collectionSearchTextAliases(value ?? ""))
    .filter((text) => {
      if (!text || seen.has(text)) {
        return false;
      }
      seen.add(text);
      return true;
    });
}

function collectionSearchTextAliases(value: string): string[] {
  const normalized = normalizeCollectionSearchText(value);
  if (!normalized) {
    return [];
  }
  const aliases = new Set<string>([normalized]);
  for (const group of collectionMultilingualSearchTermGroups) {
    const normalizedGroup = group.map((term) => normalizeCollectionSearchText(term)).filter((term) => term.length >= 2);
    if (normalizedGroup.some((term) => normalized.includes(term) || term.includes(normalized))) {
      for (const term of normalizedGroup) {
        aliases.add(term);
      }
    }
  }
  return Array.from(aliases);
}

const collectionGenericSearchTerms = [
  "前に作った",
  "前作った",
  "作った",
  "既存",
  "過去",
  "最近",
  "この",
  "その",
  "あの",
  "開いて",
  "表示して",
  "見せて",
  "出して",
  "呼び出して",
  "ください",
  "お願い",
  "観た",
  "見た",
  "みた",
  "読んだ",
  "行った",
  "使った",
  "すべて",
  "全部",
  "だけ",
  "のみ",
  "アプリ",
  "コレクション",
  "一覧",
  "ログ",
  "カレンダー",
  "ギャラリー",
  "カンバン",
  "テーブル",
  "評価順",
  "日付順",
  "期限順",
  "タイトル順",
  "名前順",
  "並び",
  "並べ",
  "絞り",
  "open",
  "show",
  "present",
  "view",
  "display",
  "list",
  "table",
  "gallery",
  "calendar",
  "kanban",
  "sort",
  "filter",
  "app",
  "application",
  "collection",
  "log",
  "tracker",
  "my",
  "the",
  "打开",
  "開啟",
  "显示",
  "顯示",
  "展示",
  "列出",
  "列表",
  "应用",
  "應用",
  "集合",
  "日志",
  "日誌",
  "记录",
  "紀錄",
  "日历",
  "日曆",
  "画廊",
  "圖庫",
  "看板",
  "表格",
  "열어",
  "열기",
  "보여",
  "표시",
  "목록",
  "앱",
  "컬렉션",
  "로그",
  "기록",
  "캘린더",
  "갤러리",
  "칸반",
  "테이블",
  "abrir",
  "abre",
  "mostrar",
  "muestra",
  "muéstrame",
  "ver",
  "lista",
  "aplicación",
  "aplicacion",
  "colección",
  "coleccion",
  "tabla",
  "calendario",
  "galería",
  "galeria",
  "aplicação",
  "aplicacao",
  "coleção",
  "colecao",
  "calendário",
  "ouvrir",
  "afficher",
  "montre",
  "voir",
  "liste",
  "application",
  "tableau",
  "calendrier",
  "galerie",
  "öffnen",
  "offnen",
  "anzeigen",
  "zeigen",
  "anwendung",
  "sammlung",
  "tabelle",
  "kalender"
];

const collectionMultilingualSearchTermGroups = [
  ["映画", "鑑賞", "movie", "movies", "film", "films", "cinema", "película", "peliculas", "películas", "filme", "filmes", "cinéma", "kino", "영화", "电影", "電影"],
  ["読書", "書籍", "book", "books", "reading", "libro", "libros", "livro", "livros", "livre", "livres", "buch", "bücher", "책", "도서", "书籍", "書籍"],
  ["タスク", "作業", "todo", "to-do", "task", "tasks", "tarea", "tareas", "tarefa", "tarefas", "tâche", "tâches", "aufgabe", "aufgaben", "작업", "할일", "任务", "任務"],
  ["予定", "日程", "イベント", "schedule", "schedules", "event", "events", "appointment", "appointments", "agenda", "calendario", "calendário", "calendrier", "termin", "termine", "일정", "予定表", "日程表", "日历", "日曆"],
  ["支出", "出費", "経費", "expense", "expenses", "spending", "cost", "costs", "gasto", "gastos", "despesa", "despesas", "dépense", "dépenses", "ausgabe", "ausgaben", "지출", "费用", "費用"],
  ["メモ", "ノート", "memo", "memos", "note", "notes", "nota", "notas", "notiz", "notizen", "메모", "노트", "笔记", "筆記"],
  ["場所", "店舗", "店", "place", "places", "location", "locations", "store", "stores", "restaurant", "restaurants", "lugar", "lugares", "local", "locais", "lieu", "lieux", "ort", "orte", "장소", "가게", "地点", "地點", "店铺", "店鋪"],
  ["評価", "点数", "rating", "ratings", "score", "scores", "puntuación", "pontuação", "bewertung", "평점", "評価点", "评分", "評分"],
  ["状態", "ステータス", "進捗", "status", "state", "progress", "estado", "statut", "zustand", "상태", "状态", "狀態"],
  ["観た", "見た", "視聴済み", "読んだ", "完了", "済み", "done", "completed", "watched", "seen", "finished", "visto", "vista", "vistos", "vistas", "assistido", "assistida", "assistidos", "assistidas", "vu", "vue", "vus", "vues", "gesehen", "gelesen", "완료", "봤다", "읽었다", "已看", "看过", "看過", "已读", "已讀"],
  ["観たい", "見たい", "読みたい", "あとで", "未完了", "未視聴", "未読", "todo", "to-do", "to watch", "watchlist", "want to watch", "want to read", "wishlist", "pending", "not done", "unwatched", "unread", "pendiente", "pendientes", "por ver", "quiero ver", "quero ver", "a voir", "à voir", "voir plus tard", "ungelesen", "보고싶은", "읽고싶은", "想看", "想读", "想讀", "未看", "未读", "未讀"],
  ["視聴中", "見ている", "読書中", "途中", "進行中", "作業中", "in progress", "inprogress", "watching", "reading", "current", "ongoing", "viendo", "leyendo", "assistindo", "lendo", "en cours", "laufend", "진행중", "보는중", "읽는중", "正在看", "正在读", "正在讀"],
  ["保留", "保留中", "一時停止", "中断", "paused", "on hold", "hold", "deferred", "suspended", "pausado", "pausada", "suspendu", "suspendue", "pausiert", "보류", "일시정지", "暂停", "暫停"]
];

function genericCollectionRecordRenderData(
  record: CollectionRecordWithFilePath,
  schema: CollectionSchema,
  records: CollectionRecordWithFilePath[] = [record],
  linkedData: GenericCollectionLinkedData = emptyGenericCollectionLinkedData
): Record<string, JsonValue> {
  const fieldIds = new Set(genericCollectionStoredSchemaFields(schema, linkedData).map((field) => String(field.id)).filter(Boolean));
  const storedData = Object.fromEntries(Object.entries(record.data).filter(([key, value]) => fieldIds.has(key) && isJsonValue(value)));
  for (const [field, value] of Object.entries(linkedData.embed_records)) {
    if (value === null || isJsonValue(value)) {
      storedData[field] = value;
    }
  }
  return {
    id: record.id,
    version: record.version,
    file_path: record.file_path,
    updated_at: record.updated_at,
    ...storedData,
    ...collectionDerivedRenderValues(schema, record, records, linkedData)
  };
}

function genericCollectionSchemaFields(schema: CollectionSchema, linkedData: GenericCollectionLinkedData = emptyGenericCollectionLinkedData): Array<Record<string, JsonValue>> {
  return [
    ...genericCollectionStoredSchemaFields(schema, linkedData),
    ...genericCollectionDerivedSchemaFields(schema)
  ];
}

function genericCollectionStoredSchemaFields(schema: CollectionSchema, linkedData: GenericCollectionLinkedData = emptyGenericCollectionLinkedData): Array<Record<string, JsonValue>> {
  const fields = new Map<string, Record<string, JsonValue>>();
  const addField = (field: Record<string, JsonValue>) => {
    const id = String(field.id ?? "");
    if (!id) {
      return;
    }
    const existing = fields.get(id);
    fields.set(id, {
      ...(existing ?? {}),
      ...field,
      label: existing?.label ?? field.label ?? id
    });
  };
  for (const field of schema.fields.map((item) => normalizeGenericSchemaField(item))) {
    addField(field);
  }
  for (const ref of schema.refs.map((item) => normalizeGenericRefField(item, schema, linkedData)).filter((field) => Boolean(field.id))) {
    addField(ref);
  }
  for (const embed of schema.embeds.map((item) => normalizeGenericEmbedField(item)).filter((field) => Boolean(field.id))) {
    addField(embed);
  }
  return [...fields.values()];
}

function genericCollectionEditableSchemaFields(schema: CollectionSchema, linkedData: GenericCollectionLinkedData = emptyGenericCollectionLinkedData): Array<Record<string, JsonValue>> {
  return genericCollectionStoredSchemaFields(schema, linkedData).filter((field) => field.read_only !== true && field.derived !== true);
}

function genericCollectionDerivedSchemaFields(schema: CollectionSchema): Array<Record<string, JsonValue>> {
  return schema.derived_fields
    .map((field) => normalizeGenericDerivedField(field))
    .filter((field) => Boolean(field.id));
}

function normalizeGenericSchemaField(field: Record<string, JsonValue>): Record<string, JsonValue> {
  const id = String(field.id ?? field.name ?? "");
  const type: AppEditFieldType = APP_EDIT_FIELD_TYPES.includes(field.type as AppEditFieldType)
    ? field.type as AppEditFieldType
    : "string";
  return { ...field, id, type };
}

function normalizeGenericRefField(ref: Record<string, JsonValue>, schema: CollectionSchema, linkedData: GenericCollectionLinkedData): Record<string, JsonValue> {
  const field = collectionDefinitionFieldRuntime(ref);
  if (!field) {
    return {};
  }
  const targetCollectionId = collectionDefinitionStringRuntime(ref, "collection_id")
    ?? collectionDefinitionStringRuntime(ref, "target_collection_id")
    ?? schema.id;
  return {
    ...ref,
    id: field,
    field,
    type: "ref",
    source: "collection_ref",
    target_collection_id: targetCollectionId,
    ref_id: collectionDefinitionStringRuntime(ref, "id") ?? field,
    label: ref.label ?? ref.title ?? field,
    required: ref.required === true,
    options: linkedData.ref_options[field] ?? []
  };
}

function normalizeGenericEmbedField(embed: Record<string, JsonValue>): Record<string, JsonValue> {
  const field = collectionDefinitionFieldRuntime(embed);
  if (!field) {
    return {};
  }
  return {
    ...embed,
    id: field,
    field,
    type: "json",
    source: "collection_embed",
    embed_id: collectionDefinitionStringRuntime(embed, "id") ?? field,
    label: embed.label ?? embed.title ?? field,
    required: embed.required === true,
    read_only: true
  };
}

function collectionDefinitionFieldRuntime(definition: Record<string, JsonValue>): string | undefined {
  return collectionDefinitionStringRuntime(definition, "field")
    ?? collectionDefinitionStringRuntime(definition, "field_id")
    ?? collectionDefinitionStringRuntime(definition, "id")
    ?? collectionDefinitionStringRuntime(definition, "name");
}

function collectionDefinitionStringRuntime(definition: Record<string, JsonValue>, key: string): string | undefined {
  const value = definition[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function genericCollectionRefOption(record: CollectionRecordWithFilePath): Record<string, JsonValue> {
  const label = collectionRecordDisplayLabel(record);
  return {
    value: record.id,
    label,
    record_id: record.id,
    collection_id: record.collection_id
  };
}

function collectionRecordDisplayLabel(record: CollectionRecordWithFilePath): string {
  for (const key of ["display", "title", "name", "label"]) {
    const value = record.data[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  const firstString = Object.values(record.data).find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return firstString ?? record.id;
}

function normalizeGenericDerivedField(field: Record<string, JsonValue>): Record<string, JsonValue> {
  const normalized = normalizeGenericSchemaField(field);
  return {
    ...normalized,
    derived: true,
    read_only: true,
    source: "derived_field"
  };
}

function collectionDerivedRenderValues(schema: CollectionSchema, record: CollectionRecordWithFilePath, records: CollectionRecordWithFilePath[], linkedData: GenericCollectionLinkedData = emptyGenericCollectionLinkedData): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const field of genericCollectionDerivedSchemaFields(schema)) {
    const id = String(field.id ?? "");
    if (!id) {
      continue;
    }
    const expression = collectionDerivedExpression(field);
    const value = evaluateCollectionDerivedExpression(expression, {
      record,
      records,
      now: new Date(),
      linkedData
    });
    if (isJsonValue(value)) {
      values[id] = value;
    }
  }
  return values;
}

function collectionDerivedExpression(field: Record<string, JsonValue>): JsonValue {
  if (field.expression !== undefined) return field.expression;
  if (field.formula !== undefined) return field.formula;
  if (field.value !== undefined) return field.value;
  return null;
}

function evaluateCollectionDerivedExpression(
  expression: JsonValue,
  context: { record: CollectionRecordWithFilePath; records: CollectionRecordWithFilePath[]; now: Date; linkedData?: GenericCollectionLinkedData },
  depth = 0
): JsonValue {
  if (depth > 8) {
    return null;
  }
  if (expression === null || typeof expression === "string" || typeof expression === "number" || typeof expression === "boolean") {
    return expression;
  }
  if (Array.isArray(expression)) {
    return expression.map((item) => evaluateCollectionDerivedExpression(item, context, depth + 1));
  }
  const op = typeof expression.op === "string" ? expression.op : "";
  if (op === "literal") {
    return isJsonValue(expression.value) ? expression.value : null;
  }
  if (op === "field") {
    return collectionDerivedRecordValue(context.record, String(expression.field_id ?? expression.field ?? ""), context.linkedData);
  }
  if (op === "concat") {
    const args = Array.isArray(expression.args) ? expression.args : [];
    const separator = typeof expression.separator === "string" ? expression.separator : "";
    return args.map((item) => collectionDerivedText(evaluateCollectionDerivedExpression(item, context, depth + 1))).join(separator);
  }
  if (op === "add" || op === "sum_values") {
    return collectionDerivedArgs(expression, context, depth).reduce<number>((total, value) => total + collectionDerivedNumber(value), 0);
  }
  if (op === "subtract") {
    const args = collectionDerivedArgs(expression, context, depth).map(collectionDerivedNumber);
    return args.length === 0 ? 0 : args.slice(1).reduce((total, value) => total - value, args[0] ?? 0);
  }
  if (op === "multiply") {
    return collectionDerivedArgs(expression, context, depth).map(collectionDerivedNumber).reduce((total, value) => total * value, 1);
  }
  if (op === "divide") {
    const args = collectionDerivedArgs(expression, context, depth).map(collectionDerivedNumber);
    const denominator = args[1] ?? 0;
    return denominator === 0 ? null : (args[0] ?? 0) / denominator;
  }
  if (op === "percent") {
    const numerator = collectionDerivedNumber(evaluateCollectionDerivedExpression(expression.numerator ?? null, context, depth + 1));
    const denominator = collectionDerivedNumber(evaluateCollectionDerivedExpression(expression.denominator ?? null, context, depth + 1));
    return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10;
  }
  if (op === "days_until") {
    const value = collectionDerivedRecordValue(context.record, String(expression.field_id ?? expression.field ?? ""), context.linkedData);
    const date = collectionDerivedDate(value);
    if (!date) return null;
    const today = Date.UTC(context.now.getUTCFullYear(), context.now.getUTCMonth(), context.now.getUTCDate());
    const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return Math.ceil((target - today) / 86_400_000);
  }
  if (op === "sum" || op === "average" || op === "count" || op === "completion_rate") {
    return evaluateCollectionAggregateExpression(expression, context);
  }
  return null;
}

function collectionDerivedArgs(expression: Record<string, JsonValue>, context: { record: CollectionRecordWithFilePath; records: CollectionRecordWithFilePath[]; now: Date; linkedData?: GenericCollectionLinkedData }, depth: number): JsonValue[] {
  const args = Array.isArray(expression.args)
    ? expression.args
    : [expression.left, expression.right].filter((item): item is JsonValue => item !== undefined && isJsonValue(item));
  return args.map((item) => evaluateCollectionDerivedExpression(item, context, depth + 1));
}

function evaluateCollectionAggregateExpression(expression: Record<string, JsonValue>, context: { record: CollectionRecordWithFilePath; records: CollectionRecordWithFilePath[]; linkedData?: GenericCollectionLinkedData }): JsonValue {
  const fieldId = String(expression.field_id ?? expression.field ?? "");
  const filtered = context.records.filter((record) => collectionRecordMatchesDerivedFilter(record, expression.filter));
  if (expression.op === "count") {
    return filtered.length;
  }
  if (expression.op === "completion_rate") {
    const statusField = fieldId || "completed";
    const completedValue = expression.completed_value ?? true;
    if (filtered.length === 0) return 0;
    const completed = filtered.filter((record) => collectionDerivedRecordValue(record, statusField, context.linkedData) === completedValue).length;
    return Math.round((completed / filtered.length) * 1000) / 10;
  }
  if (!fieldId) {
    return null;
  }
  const values = filtered.map((record) => collectionDerivedNumber(collectionDerivedRecordValue(record, fieldId, context.linkedData)));
  if (expression.op === "sum") {
    return values.reduce((total, value) => total + value, 0);
  }
  if (expression.op === "average") {
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
  }
  return null;
}

function collectionRecordMatchesDerivedFilter(record: CollectionRecordWithFilePath, filter: JsonValue | undefined): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    return true;
  }
  const fieldId = String(filter.field_id ?? filter.field ?? "");
  if (!fieldId) {
    return true;
  }
  return collectionDerivedRecordValue(record, fieldId) === filter.value;
}

function collectionDerivedRecordValue(record: CollectionRecordWithFilePath, fieldId: string, linkedData: GenericCollectionLinkedData = emptyGenericCollectionLinkedData): JsonValue {
  if (fieldId.includes(".")) {
    const [refField, ...pathParts] = fieldId.split(".");
    const targetId = record.data[refField ?? ""];
    const target = typeof targetId === "string" ? linkedData.ref_records[refField ?? ""]?.[targetId] : undefined;
    if (target && pathParts.length > 0) {
      return jsonPathValue(target, pathParts);
    }
  }
  const value = record.data[fieldId];
  return isJsonValue(value) ? value : null;
}

function jsonPathValue(root: Record<string, JsonValue>, pathParts: string[]): JsonValue {
  let current: JsonValue = root;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = current[part] ?? null;
  }
  return isJsonValue(current) ? current : null;
}

function collectionManagePutMode(value: JsonValue | undefined): "create" | "upsert" | "merge" {
  return value === "create" || value === "merge" || value === "upsert" ? value : "upsert";
}

function collectionManageRecordData(item: Record<string, JsonValue>): Record<string, JsonValue> {
  const { id: _id, record_id: _recordId, collection_id: _collectionId, resource_refs: _resourceRefs, ...data } = item;
  return data;
}

function collectionComputedWriteProblem(schema: CollectionSchema, item: Record<string, JsonValue>): string | undefined {
  const derived = new Set(schema.derived_fields.map((field) => collectionDefinitionFieldRuntime(field)).filter((id): id is string => Boolean(id)));
  const embeds = new Set(schema.embeds.map((field) => collectionDefinitionFieldRuntime(field)).filter((id): id is string => Boolean(id)));
  for (const key of Object.keys(item)) {
    if (derived.has(key)) {
      return `'${key}' is derived — computed by the host`;
    }
    if (embeds.has(key)) {
      return `'${key}' is an embed — computed by the host`;
    }
  }
  return undefined;
}

function projectCollectionManageFields(record: Record<string, JsonValue>, fields: string[]): Record<string, JsonValue> {
  const keep = new Set(["id", ...fields]);
  return Object.fromEntries(Object.entries(record).filter(([key]) => keep.has(key)));
}

function collectionSchemaDocs(): JsonValue {
  return {
    actions: ["getItems", "putItems", "schemaDocs", "getSchema", "putSchema", "patchSchema"],
    record_io: "Use getItems for computed-aware reads and putItems for schema-validated writes. Raw file I/O remains an escape hatch.",
    computed_fields: "derived and embed fields are host-computed and must not be written by putItems.",
    put_modes: ["create", "upsert", "merge"],
    supported_renderers: [...COLLECTION_RENDERERS]
  };
}

function collectionManageResultRef(payload: Record<string, JsonValue>, fallbackId: string): ResourceRef {
  const collectionId = stringPayload(payload.collection_id) || fallbackId;
  const action = stringPayload(payload.action) || "manage";
  return {
    kind: "collection",
    id: collectionId,
    uri: `collections/${collectionId}`,
    label: `Collection ${action}`
  };
}

function jsonStringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isCollectionManageResource(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { action?: unknown }).action === "string";
}

function collectionDerivedNumber(value: JsonValue): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function collectionDerivedText(value: JsonValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function collectionDerivedDate(value: JsonValue): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) {
    return undefined;
  }
  const date = new Date(`${match[0]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function genericCollectionViewConfig(schema: CollectionSchema, requestedViewId?: string): Record<string, JsonValue> {
  const configured = requestedViewId
    ? (schema.views ?? []).find((view) => view.id === requestedViewId) ?? syntheticCollectionViewForId(schema, requestedViewId)
    : undefined;
  const fallbackConfigured = (schema.views ?? [])[0]
    ?? (schema.views ?? []).find((view) => view.renderer === GENERIC_COLLECTION_RENDERER)
    ?? syntheticCollectionViewForRenderer(schema, GENERIC_COLLECTION_RENDERER);
  const candidate = configured ?? fallbackConfigured;
  return normalizeGenericCollectionViewConfig(schema, candidate);
}

function normalizeGenericCollectionViewConfig(schema: CollectionSchema, configured: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  const id = typeof configured?.id === "string" ? configured.id : defaultGenericCollectionViewId(schema);
  const requestedRenderer = typeof configured?.renderer === "string" && isCollectionRenderer(configured.renderer)
    ? configured.renderer
    : GENERIC_COLLECTION_RENDERER;
  const renderer = collectionRendererSupportedBySchema(schema, requestedRenderer)
    ? requestedRenderer
    : GENERIC_COLLECTION_RENDERER;
  const fieldIds = genericCollectionEditableSchemaFields(schema).map((field) => String(field.id)).filter(Boolean);
  const kanbanGroupField = renderer === "collection_kanban" ? collectionSchemaEnumField(schema) : undefined;
  const kanbanGroupBy = typeof configured?.group_by === "string" && configured.group_by.trim()
    ? configured.group_by.trim()
    : typeof configured?.group === "string" && configured.group.trim()
      ? configured.group.trim()
      : kanbanGroupField
        ? String(kanbanGroupField.id ?? "")
        : "";
  return {
    ...(configured ?? {}),
    id,
    renderer,
    ...(renderer !== requestedRenderer ? {
      requested_renderer: requestedRenderer,
      fallback_reason: collectionRendererFallbackReason(schema, requestedRenderer)
    } : {}),
    density: configured?.density === "compact" ? "compact" : "comfortable",
    allow_delete: configured?.allow_delete !== false,
    ...(kanbanGroupBy ? { group_by: kanbanGroupBy } : {}),
    hidden_fields: Array.isArray(configured?.hidden_fields) ? configured.hidden_fields.filter((item): item is string => typeof item === "string") : [],
    editable_fields: Array.isArray(configured?.editable_fields) ? configured.editable_fields.filter((item): item is string => typeof item === "string") : fieldIds
  };
}

function genericCollectionViewOptions(schema: CollectionSchema): Array<Record<string, JsonValue>> {
  const byRenderer = new Map<string, Record<string, JsonValue>>();
  for (const view of schema.views ?? []) {
    const normalized = normalizeGenericCollectionViewConfig(schema, view);
    const renderer = String(normalized.renderer ?? "");
    if (!isCollectionRenderer(renderer) || normalized.fallback_reason) {
      continue;
    }
    if (!byRenderer.has(renderer)) {
      byRenderer.set(renderer, collectionViewOption(normalized));
    }
  }
  for (const renderer of COLLECTION_RENDERERS) {
    if (byRenderer.has(renderer)) {
      continue;
    }
    const normalized = normalizeGenericCollectionViewConfig(schema, syntheticCollectionViewForRenderer(schema, renderer));
    if (normalized.fallback_reason) {
      continue;
    }
    byRenderer.set(renderer, collectionViewOption(normalized));
  }
  return [...byRenderer.values()];
}

function collectionViewOption(viewConfig: Record<string, JsonValue>): Record<string, JsonValue> {
  const renderer = String(viewConfig.renderer ?? GENERIC_COLLECTION_RENDERER);
  return {
    id: String(viewConfig.id ?? ""),
    renderer,
    label: collectionRendererLabel(renderer)
  };
}

function syntheticCollectionViewForId(schema: CollectionSchema, viewId: string): Record<string, JsonValue> | undefined {
  return (COLLECTION_RENDERERS as readonly string[])
    .map((renderer) => syntheticCollectionViewForRenderer(schema, renderer))
    .find((view) => view.id === viewId);
}

function syntheticCollectionViewForRenderer(schema: CollectionSchema, renderer: string): Record<string, JsonValue> {
  return {
    id: collectionViewIdForRenderer(schema, renderer),
    renderer
  };
}

function collectionViewIdForRenderer(schema: CollectionSchema, renderer: string): string {
  const configured = (schema.views ?? []).find((view) => view.renderer === renderer && typeof view.id === "string");
  if (typeof configured?.id === "string" && configured.id) {
    return configured.id;
  }
  const suffix: Record<string, string> = {
    collection_table: "table",
    collection_gallery: "gallery",
    calendar_view: "calendar",
    collection_kanban: "kanban"
  };
  return `${schema.id}_${suffix[renderer] ?? "table"}`;
}

function collectionRendererLabel(renderer: string): string {
  if (renderer === "collection_gallery") return "Gallery";
  if (renderer === "calendar_view") return "Calendar";
  if (renderer === "collection_kanban") return "Kanban";
  return "Table";
}

function collectionRendererSupportedBySchema(schema: CollectionSchema, renderer: string): boolean {
  if (renderer === "calendar_view") {
    return collectionSchemaDateField(schema) !== undefined;
  }
  if (renderer === "collection_kanban") {
    return collectionSchemaEnumField(schema) !== undefined;
  }
  return renderer === "collection_table" || renderer === "collection_gallery";
}

function collectionRendererFallbackReason(schema: CollectionSchema, renderer: string): string {
  if (renderer === "calendar_view" && !collectionSchemaDateField(schema)) {
    return "calendar_renderer_requires_date_field";
  }
  if (renderer === "collection_kanban" && !collectionSchemaEnumField(schema)) {
    return "kanban_renderer_requires_enum_field";
  }
  return "unsupported_collection_renderer";
}

function collectionSchemaDateField(schema: CollectionSchema): Record<string, JsonValue> | undefined {
  return genericCollectionSchemaFields(schema).find((field) => {
    const type = String(field.type ?? "");
    const id = String(field.id ?? "").toLowerCase();
    return type === "date" || type === "datetime" || /date|day|due|deadline|watched_at|created_at|updated_at|期限|日付/.test(id);
  });
}

function collectionSchemaEnumField(schema: CollectionSchema): Record<string, JsonValue> | undefined {
  return genericCollectionSchemaFields(schema).find((field) => {
    const type = String(field.type ?? "");
    const id = String(field.id ?? "").toLowerCase();
    return type === "enum" || /status|state|stage|phase|状態|進捗/.test(id);
  });
}

function defaultGenericCollectionViewId(schema: CollectionSchema): string {
  const firstView = (schema.views ?? [])[0];
  return typeof firstView?.id === "string" && firstView.id ? firstView.id : `${schema.id}_table`;
}

function isCollectionRenderer(renderer: string): renderer is CollectionRenderer {
  return (COLLECTION_RENDERERS as readonly string[]).includes(renderer);
}

type GenericCollectionUiAction = {
  id: string;
  label: string;
  operation_kind: "collection.record.create" | "collection.record.patch" | "collection.record.delete" | "collection.view.present" | "collection.action.run";
  action_kind?: string;
  description?: string;
  scope?: "collection" | "record";
};

function genericCollectionActions(schema: CollectionSchema, viewId: string): GenericCollectionUiAction[] {
  const actions: GenericCollectionUiAction[] = [
    { id: "collection.create", label: "追加", operation_kind: "collection.record.create" },
    { id: "collection.patch", label: "更新", operation_kind: "collection.record.patch" },
    { id: "collection.refresh", label: "更新", operation_kind: "collection.view.present" }
  ];
  if (collectionDeleteAllowed(schema, viewId)) {
    actions.push({ id: "collection.delete", label: "削除", operation_kind: "collection.record.delete" });
  }
  const existingIds = new Set(actions.map((action) => action.id));
  for (const action of schema.actions) {
    const id = collectionActionString(action, "id")
      ?? collectionActionString(action, "name")
      ?? collectionActionString(action, "action_id");
    if (!id || existingIds.has(id)) {
      continue;
    }
    const actionKind = collectionActionKind(action);
    actions.push({
      id,
      label: collectionActionString(action, "label")
        ?? collectionActionString(action, "title")
        ?? id,
      operation_kind: "collection.action.run",
      ...(actionKind ? { action_kind: actionKind } : {}),
      ...(collectionActionString(action, "description") ? { description: collectionActionString(action, "description") } : {}),
      ...(collectionActionScope(action, actionKind) ? { scope: collectionActionScope(action, actionKind) } : {})
    });
    existingIds.add(id);
  }
  return actions;
}

function collectionDeleteAllowed(schema: CollectionSchema | undefined, viewId?: string): boolean {
  if (!schema) {
    return false;
  }
  const permissions = unknownRecord(schema.permissions);
  if (permissions.delete === false) {
    return false;
  }
  const view = (schema.views ?? []).find((item) => item.id === viewId) ?? (schema.views ?? [])[0];
  return view?.allow_delete !== false;
}

function assertCollectionDeleteAllowed(schema: CollectionSchema, viewId?: string): void {
  if (!collectionDeleteAllowed(schema, viewId)) {
    throw new RuntimeRequestError("forbidden", "collection_record_delete_not_allowed");
  }
}

function buildAppEditPatchedSchema(schema: CollectionSchema, patches: AppEditPatch[], options: AppEditPatchOptions = {}): CollectionSchema | undefined {
  const fields = [...schema.fields];
  const derivedFields = [...schema.derived_fields];
  const currentView = genericCollectionViewConfig(schema, options.viewId);
  const nextView: Record<string, JsonValue> = { ...currentView };
  const originalViewId = String(nextView.id ?? options.viewId ?? defaultGenericCollectionViewId(schema));
  const fieldIndex = () => new Map(fields.map((field, index) => [String(field.id ?? field.name ?? ""), index]));
  const derivedFieldIndex = () => new Map(derivedFields.map((field, index) => [String(field.id ?? field.name ?? ""), index]));
  for (const patch of patches) {
    if (patch.op === "add_field") {
      if (!fieldIndex().has(patch.field.id)) {
        fields.push(appEditFieldToCollectionField(patch.field));
      }
    } else if (patch.op === "add_derived_field") {
      if (!derivedFieldIndex().has(patch.field.id)) {
        derivedFields.push(appEditDerivedFieldToCollectionField(patch.field));
      }
    } else if (patch.op === "update_field") {
      const index = fieldIndex().get(patch.field_id);
      if (index !== undefined) {
        fields[index] = { ...fields[index], ...patch.changes };
      }
    } else if (patch.op === "hide_field") {
      nextView.hidden_fields = uniqueStrings([...(Array.isArray(nextView.hidden_fields) ? nextView.hidden_fields : []), patch.field_id]);
    } else if (patch.op === "update_view") {
      if (patch.renderer) {
        nextView.renderer = patch.renderer;
        if (!patch.view_id) {
          nextView.id = collectionViewIdForRenderer({ ...schema, fields }, patch.renderer);
        }
      }
      if (patch.view_id) nextView.id = patch.view_id;
      if (patch.hidden_fields) nextView.hidden_fields = uniqueStrings(patch.hidden_fields);
      if (patch.emphasized_fields) nextView.emphasized_fields = uniqueStrings(patch.emphasized_fields);
      if (patch.density) nextView.density = patch.density;
      if (typeof patch.allow_delete === "boolean") nextView.allow_delete = patch.allow_delete;
    } else if (patch.op === "set_sort") {
      nextView.sort = { field_id: patch.field_id, direction: patch.direction, completed_last: patch.completed_last !== false };
    } else if (patch.op === "set_group") {
      nextView.group_by = patch.field_id;
    }
  }
  const schemaWithFields = { ...schema, fields };
  const normalizedView = normalizeGenericCollectionViewConfig(schemaWithFields, nextView);
  if (normalizedView.fallback_reason) {
    throw new RuntimeRequestError("conflict", `app_edit_view_renderer_not_supported:${normalizedView.fallback_reason}`);
  }
  const nextViewId = String(normalizedView.id ?? originalViewId);
  const otherViews = (schema.views ?? []).filter((view) => view.id !== originalViewId && view.id !== nextViewId);
  const permissionsPatch = patches.find((patch): patch is Extract<AppEditPatch, { op: "set_permissions" }> =>
    patch.op === "set_permissions" && typeof patch.allow_delete === "boolean"
  );
  const nextPermissions = permissionsPatch
    ? { ...(schema.permissions ?? {}), delete: permissionsPatch.allow_delete as boolean }
    : schema.permissions;
  const changed = JSON.stringify(fields) !== JSON.stringify(schema.fields)
    || JSON.stringify(derivedFields) !== JSON.stringify(schema.derived_fields)
    || JSON.stringify(normalizedView) !== JSON.stringify(currentView)
    || JSON.stringify(nextPermissions) !== JSON.stringify(schema.permissions);
  if (!changed) {
    return undefined;
  }
  return CollectionSchemaSchema.parse({
    ...schema,
    fields,
    derived_fields: derivedFields,
    views: [...otherViews, normalizedView],
    permissions: nextPermissions
  });
}

function validateAppEditPatch(value: unknown, schema: CollectionSchema): AppEditPatch[] {
  if (!Array.isArray(value)) {
    throw new RuntimeRequestError("conflict", "app_edit_patch_array_required");
  }
  const fieldIds = new Set(schema.fields.map((field) => String(field.id ?? field.name ?? "")).filter(Boolean));
  const derivedFieldIds = new Set(schema.derived_fields.map((field) => String(field.id ?? field.name ?? "")).filter(Boolean));
  const required = new Set(schema.fields.flatMap((field) => field.required === true ? [String(field.id ?? field.name ?? "")] : []));
  let addCount = 0;
  const patches: AppEditPatch[] = [];
  for (const item of value) {
    const patch = normalizeAppEditPatch(item);
    if (patch.op === "add_field") {
      addCount += 1;
      if (addCount > 3) throw new RuntimeRequestError("conflict", "app_edit_patch_too_many_fields");
      if (fieldIds.has(patch.field.id)) throw new RuntimeRequestError("conflict", `app_edit_field_exists:${patch.field.id}`);
      if (patch.field.type === "enum" && (!patch.field.enum_values || patch.field.enum_values.length === 0)) {
        throw new RuntimeRequestError("conflict", `app_edit_enum_values_required:${patch.field.id}`);
      }
      fieldIds.add(patch.field.id);
      if (patch.field.required === true) {
        required.add(patch.field.id);
      }
    } else if (patch.op === "add_derived_field") {
      addCount += 1;
      if (addCount > 3) throw new RuntimeRequestError("conflict", "app_edit_patch_too_many_fields");
      if (fieldIds.has(patch.field.id) || derivedFieldIds.has(patch.field.id)) throw new RuntimeRequestError("conflict", `app_edit_field_exists:${patch.field.id}`);
      if (!isValidCollectionDerivedExpression(patch.field.expression)) throw new RuntimeRequestError("conflict", `app_edit_invalid_derived_expression:${patch.field.id}`);
      derivedFieldIds.add(patch.field.id);
    } else if (patch.op === "hide_field") {
      if (!fieldIds.has(patch.field_id)) throw new RuntimeRequestError("conflict", `app_edit_unknown_field:${patch.field_id}`);
      if (required.has(patch.field_id)) throw new RuntimeRequestError("conflict", `app_edit_required_field_visible:${patch.field_id}`);
    } else if (patch.op === "update_field") {
      if (!fieldIds.has(patch.field_id)) throw new RuntimeRequestError("conflict", `app_edit_unknown_field:${patch.field_id}`);
      if (patch.changes.type === "enum" && (!patch.changes.enum_values || patch.changes.enum_values.length === 0)) {
        throw new RuntimeRequestError("conflict", `app_edit_enum_values_required:${patch.field_id}`);
      }
    } else if (patch.op === "set_sort" || patch.op === "set_group") {
      if (!fieldIds.has(patch.field_id)) throw new RuntimeRequestError("conflict", `app_edit_unknown_field:${patch.field_id}`);
    } else if (patch.op === "update_view") {
      for (const fieldId of [...(patch.hidden_fields ?? []), ...(patch.emphasized_fields ?? [])]) {
        if (!fieldIds.has(fieldId)) throw new RuntimeRequestError("conflict", `app_edit_unknown_field:${fieldId}`);
        if ((patch.hidden_fields ?? []).includes(fieldId) && required.has(fieldId)) {
          throw new RuntimeRequestError("conflict", `app_edit_required_field_visible:${fieldId}`);
        }
      }
    }
    patches.push(patch);
  }
  return patches;
}

function normalizeAppEditPatch(value: unknown): AppEditPatch {
  const item = unknownRecord(value);
  const op = String(item.op ?? "");
  if (op === "delete_field" || op === "remove_field") {
    const fieldId = String(item.field_id ?? item.id ?? "");
    return { op: "hide_field", field_id: requireAppFieldId(fieldId) };
  }
  if (op === "add_field") {
    const field = unknownRecord(item.field);
    const type = requireAppFieldType(String(field.type ?? "string"));
    const enumValues = Array.isArray(field.enum_values) ? uniqueStrings(field.enum_values) : undefined;
    return {
      op,
      field: {
        id: requireAppFieldId(String(field.id ?? "")),
        type,
        ...(typeof field.label === "string" ? { label: field.label } : {}),
        ...(field.required === true ? { required: true } : {}),
        ...(enumValues ? { enum_values: enumValues } : {}),
        ...(isJsonValue(field.default_value) ? { default_value: field.default_value } : {})
      }
    };
  }
  if (op === "add_derived_field") {
    const field = unknownRecord(item.field);
    const type = requireAppFieldType(String(field.type ?? "number"));
    const expression = isJsonValue(field.expression) ? field.expression : field.formula;
    if (!isJsonValue(expression)) {
      throw new RuntimeRequestError("conflict", "app_edit_derived_expression_required");
    }
    return {
      op,
      field: {
        id: requireAppFieldId(String(field.id ?? "")),
        type,
        ...(typeof field.label === "string" ? { label: field.label } : {}),
        expression
      }
    };
  }
  if (op === "update_field") {
    const changes = unknownRecord(item.changes);
    return {
      op,
      field_id: requireAppFieldId(String(item.field_id ?? "")),
      changes: {
        ...(typeof changes.label === "string" ? { label: changes.label } : {}),
        ...(typeof changes.type === "string" ? { type: requireAppFieldType(changes.type) } : {}),
        ...(Array.isArray(changes.enum_values) ? { enum_values: uniqueStrings(changes.enum_values) } : {})
      }
    };
  }
  if (op === "hide_field") return { op, field_id: requireAppFieldId(String(item.field_id ?? "")) };
  if (op === "set_sort") return { op, field_id: requireAppFieldId(String(item.field_id ?? "")), direction: item.direction === "desc" ? "desc" : "asc", completed_last: item.completed_last !== false };
  if (op === "set_group") return { op, field_id: requireAppFieldId(String(item.field_id ?? "")) };
  if (op === "set_permissions") return { op, ...(typeof item.allow_delete === "boolean" ? { allow_delete: item.allow_delete } : {}) };
  if (op === "update_view") {
    return {
      op,
      ...(typeof item.view_id === "string" ? { view_id: requireAppFieldId(item.view_id) } : {}),
      ...(typeof item.renderer === "string" && isCollectionRenderer(item.renderer) ? { renderer: item.renderer } : {}),
      ...(Array.isArray(item.hidden_fields) ? { hidden_fields: uniqueStrings(item.hidden_fields).map(requireAppFieldId) } : {}),
      ...(Array.isArray(item.emphasized_fields) ? { emphasized_fields: uniqueStrings(item.emphasized_fields).map(requireAppFieldId) } : {}),
      ...(item.density === "compact" || item.density === "comfortable" ? { density: item.density } : {}),
      ...(typeof item.allow_delete === "boolean" ? { allow_delete: item.allow_delete } : {})
    };
  }
  throw new RuntimeRequestError("conflict", `app_edit_unknown_op:${op}`);
}

function appEditFieldToCollectionField(field: Extract<AppEditPatch, { op: "add_field" }>["field"]): Record<string, JsonValue> {
  return {
    id: field.id,
    type: field.type,
    ...(field.label ? { label: field.label } : {}),
    ...(field.required === true ? { required: true } : {}),
    ...(field.enum_values ? { enum_values: field.enum_values } : {}),
    ...(Object.prototype.hasOwnProperty.call(field, "default_value") && isJsonValue(field.default_value) ? { default_value: field.default_value } : {})
  };
}

function appEditDerivedFieldToCollectionField(field: Extract<AppEditPatch, { op: "add_derived_field" }>["field"]): Record<string, JsonValue> {
  return {
    id: field.id,
    type: field.type,
    derived: true,
    read_only: true,
    ...(field.label ? { label: field.label } : {}),
    expression: field.expression
  };
}

function isValidCollectionDerivedExpression(expression: JsonValue, depth = 0): boolean {
  if (depth > 8) return false;
  if (expression === null || typeof expression === "string" || typeof expression === "number" || typeof expression === "boolean") return true;
  if (Array.isArray(expression)) return expression.every((item) => isValidCollectionDerivedExpression(item, depth + 1));
  const op = typeof expression.op === "string" ? expression.op : "";
  if (!["literal", "field", "concat", "add", "sum_values", "subtract", "multiply", "divide", "percent", "days_until", "count", "sum", "average", "completion_rate"].includes(op)) {
    return false;
  }
  const expressionKeys = ["args", "left", "right", "numerator", "denominator"] as const;
  return expressionKeys.every((key) => {
    const value = expression[key];
    if (value === undefined) return true;
    return isJsonValue(value) && isValidCollectionDerivedExpression(value, depth + 1);
  });
}

function inferAppFieldType(value: JsonValue): AppEditFieldType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function requireAppFieldId(value: string): string {
  if (!isValidAppFieldId(value)) throw new RuntimeRequestError("conflict", `app_edit_invalid_field:${value}`);
  return value;
}

function isValidAppFieldId(value: string): boolean {
  return /^[a-z][a-z0-9_]{1,39}$/.test(value);
}

function requireAppFieldType(value: string): AppEditFieldType {
  if (!APP_EDIT_FIELD_TYPES.includes(value as AppEditFieldType)) throw new RuntimeRequestError("conflict", `app_edit_invalid_field_type:${value}`);
  return value as AppEditFieldType;
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function collectionRecordRenderSpec(record: CollectionRecordWithFilePath, title = "Collection record", resolution?: CollectionRecordResolution): SurfaceRenderSpec {
  return createSurfaceRenderSpec({
    kind: "collection_record",
    priority: "primary",
    state: "ready",
    title,
    resource_refs: [
      {
        kind: "collection_record",
        id: record.id,
        uri: record.file_path,
        label: `${record.collection_id}/${record.id}`
      }
    ],
    props: {
      collection_id: record.collection_id,
      record_id: record.id,
      file_path: record.file_path,
      data: record.data,
      record_resource_refs: record.resource_refs,
      resolved_refs: jsonSafe(resolution?.resolved_refs ?? []),
      missing_refs: jsonSafe(resolution?.missing_refs ?? []),
      embed_fields: jsonSafe(resolution?.embed_fields ?? [])
    }
  });
}

function resourceRenderSpec(command: DomainDispatchEntry, result: unknown): SurfaceRenderSpec | undefined {
  const resultRecord = unknownRecord(result);
  const generatedSurface = unknownRecord(resultRecord.definition);
  if (typeof generatedSurface.id === "string" && typeof generatedSurface.preview_url === "string" && typeof generatedSurface.current_revision_id === "string") {
    return createSurfaceRenderSpec({
      kind: "custom_view",
      priority: "primary",
      state: "ready",
      title: typeof generatedSurface.title === "string" ? generatedSurface.title : command.title,
      resource_refs: [{ kind: "generated_surface", id: generatedSurface.id, uri: `surfaces/${generatedSurface.id}`, label: typeof generatedSurface.title === "string" ? generatedSurface.title : generatedSurface.id }],
      props: {
        view_id: generatedSurface.id,
        renderer: "generated_surface",
        surface_id: generatedSurface.id,
        revision_id: generatedSurface.current_revision_id,
        preview_url: generatedSurface.preview_url,
        actions: jsonSafe(generatedSurface.actions ?? []),
        sandbox: {
          mode: "iframe",
          allow_scripts: true,
          allow_forms: false,
          allow_same_origin: false,
          network_access: "none",
          workspace_access: "none"
        },
        csp: "strict"
      }
    });
  }
  const resource = unknownRecord(resultRecord.resource);
  if (isArtifactRenderResource(resource)) {
    const mimeType = stringRecordValue(resource.metadata, "mime_type");
    return createSurfaceRenderSpec({
      kind: "artifact",
      priority: "primary",
      state: "ready",
      title: resource.title,
      resource_refs: [resource.file_ref],
      props: {
        artifact_id: resource.id,
        file_path: resource.file_ref.uri,
        title: resource.title,
        ...(mimeType ? { mime_type: mimeType } : {})
      }
    });
  }
  if (isMemoryRenderResource(resource)) {
    return memoryRenderSpec(resource, command.title);
  }
  const archivedMemory = unknownRecord(resultRecord.memory);
  if (isMemoryRenderResource(archivedMemory)) {
    return memoryRenderSpec(archivedMemory, command.title);
  }
  if (isWikiRenderResource(resource)) {
    return createSurfaceRenderSpec({
      kind: "knowledge_wiki",
      priority: "primary",
      state: "ready",
      title: resource.title,
      resource_refs: [wikiRef(resource)],
      props: {
        wiki_ids: [resource.id],
        active_only: resource.state === "active",
        state: resource.state,
        slug: resource.slug
      }
    });
  }
  if (isSkillRenderResource(resource)) {
    return createSurfaceRenderSpec({
      kind: "skill",
      priority: "primary",
      state: "ready",
      title: resource.title,
      resource_refs: [skillRef(resource)],
      props: {
        skill_ids: [resource.id],
        disclosure_level: "catalog",
        state: resource.state
      }
    });
  }
  if (isSkillSupportFileRenderResource(resource)) {
    return createSurfaceRenderSpec({
      kind: "skill",
      priority: "primary",
      state: "ready",
      title: resource.path,
      resource_refs: [skillSupportFileRef(resource)],
      props: {
        skill_ids: [resource.skill_id],
        disclosure_level: "support",
        support_file_path: resource.path
      }
    });
  }
  if (isCollectionSchemaRenderResource(resource)) {
    return createSurfaceRenderSpec({
      kind: "collection",
      priority: "primary",
      state: "ready",
      title: resource.id,
      resource_refs: [{
        kind: "collection_schema",
        id: resource.id,
        uri: resource.file_path,
        label: resource.id
      }],
      props: {
        collection_id: resource.id,
        schema_id: resource.id,
        record_ids: []
      }
    });
  }
  if (isCollectionReindexRenderResource(resource)) {
    return createSurfaceRenderSpec({
      kind: "collection",
      priority: "secondary",
      state: "ready",
      title: "Collection index",
      resource_refs: [{
        kind: "collection_index",
        id: "collections",
        uri: "collections",
        label: "Collection index"
      }],
      props: {
        collection_id: "collections",
        record_ids: [],
        indexed_schema_count: resource.schemas.indexed,
        indexed_record_count: resource.records.indexed,
        schema_files: resource.schemas.files,
        record_files: resource.records.files,
        schema_error_count: resource.schemas.errors.length,
        record_error_count: resource.records.errors.length
      }
    });
  }
  if (isWikiReindexRenderResource(resource)) {
    return createSurfaceRenderSpec({
      kind: "knowledge_wiki",
      priority: "secondary",
      state: "ready",
      title: "Knowledge Wiki index",
      resource_refs: [{
        kind: "wiki_index",
        id: "active",
        uri: "wiki/pages",
        label: "Knowledge Wiki index"
      }],
      props: {
        wiki_ids: [],
        active_only: true,
        active_count: resource.active,
        indexed_count: resource.indexed
      }
    });
  }
  return operationStatusRenderSpec(command, resultRecord);
}

function assertDomainCommandRenderSpecs(command: DomainDispatchEntry, specs: SurfaceRenderSpec[]): SurfaceRenderSpec[] {
  for (const spec of specs) {
    if (!command.output_render_kinds.includes(spec.kind as DomainCommandOutputRenderKind)) {
      throw new Error(`Domain command ${command.id} returned undeclared render kind: ${spec.kind}`);
    }
  }
  return specs;
}

function assertDomainQueryRenderSpecs(query: DomainQueryEntry, specs: SurfaceRenderSpec[]): SurfaceRenderSpec[] {
  for (const spec of specs) {
    if (!query.output_render_kinds.includes(spec.kind as DomainCommandOutputRenderKind)) {
      throw new Error(`Domain query ${query.id} returned undeclared render kind: ${spec.kind}`);
    }
  }
  return specs;
}

function gatewayInboundRenderSpec(result: GatewayInboundRuntimeResult): SurfaceRenderSpec {
  const refs: ResourceRef[] = [{
    kind: "gateway_inbound",
    id: result.inbound.id,
    uri: `gateway/inbound/${result.inbound.id}`,
    label: result.inbound.source_identity
  }];
  if (result.pairing) {
    refs.push({
      kind: "gateway_pairing",
      id: result.pairing.id,
      uri: `gateway/pairings/${result.pairing.id}`,
      label: result.pairing.source_identity
    });
  }
  if (result.boundaryPolicy) {
    refs.push({
      kind: "gateway_boundary_policy",
      id: result.boundaryPolicy.id,
      uri: `gateway/boundary-policies/${result.boundaryPolicy.id}`,
      label: result.boundaryPolicy.session_key
    });
  }
  return createSurfaceRenderSpec({
    kind: "gateway",
    priority: result.chat ? "secondary" : "primary",
    state: result.inbound.status === "failed" ? "error" : result.inbound.status === "blocked" ? "loading" : "ready",
    title: `Gateway ${result.inbound.channel}`,
    resource_refs: refs,
    props: {
      status: result.inbound.status,
      inbound_id: result.inbound.id,
      source_identity: result.inbound.source_identity,
      trusted: result.inbound.trusted,
      ...(result.pairing ? { pairing_id: result.pairing.id } : {}),
      ...(result.boundaryPolicy ? { boundary_policy_id: result.boundaryPolicy.id } : {}),
      ...(result.inbound.session_key ? { session_key: result.inbound.session_key } : {})
    }
  });
}

function memoryRenderSpec(memory: MemoryFrontmatter & { file_path?: string }, title?: string): SurfaceRenderSpec {
  return createSurfaceRenderSpec({
    kind: "memory",
    priority: "primary",
    state: memory.state === "archived" ? "empty" : "ready",
    title: title ?? memory.topic,
    resource_refs: [memoryRef(memory)],
    props: {
      memory_ids: [memory.id],
      topic: memory.topic,
      state: memory.state
    }
  });
}

function operationStatusRenderSpec(command: DomainDispatchEntry, resultRecord: Record<string, unknown>): SurfaceRenderSpec | undefined {
  const operation = unknownRecord(resultRecord.operation);
  if (!isOperationRenderResource(operation)) {
    return undefined;
  }
  return createSurfaceRenderSpec({
    kind: "status_timeline",
    priority: "secondary",
    state: operation.status === "failed" || operation.status === "denied" ? "error" : "ready",
    title: command.title,
    resource_refs: [{
      kind: "operation",
      id: operation.id,
      uri: `operations/${operation.id}`,
      label: operation.operation
    }],
    props: {
      status: operation.status,
      event_ids: [],
      operation_id: operation.id,
      operation_name: operation.operation,
      command_id: command.id
    }
  });
}

function isRunChatTurnResult(value: unknown): value is RunChatTurnResult {
  const record = unknownRecord(value);
  return Boolean(unknownRecord(record.session).id)
    && Boolean(unknownRecord(record.backendRun).id)
    && Array.isArray(record.messages);
}

function isGatewayInboundRuntimeResult(value: unknown): value is GatewayInboundRuntimeResult {
  const record = unknownRecord(value);
  const inbound = unknownRecord(record.inbound);
  return typeof inbound.id === "string" && typeof inbound.status === "string" && typeof inbound.channel === "string";
}

function surfaceOperationRuntimeRenderSpecs(value: unknown): SurfaceRenderSpec[] {
  const record = unknownRecord(value);
  const specs = Array.isArray(record.render_specs)
    ? record.render_specs.filter(isSurfaceRenderSpec)
    : [];
  if (specs.length > 0) {
    return specs;
  }
  return isSurfaceRenderSpec(record.render_spec) ? [record.render_spec] : [];
}

function isSurfaceRenderSpec(value: unknown): value is SurfaceRenderSpec {
  const record = unknownRecord(value);
  return typeof record.kind === "string" && typeof record.props === "object" && record.props !== null;
}

function isCollectionRecordRuntimeResult(value: unknown): value is CollectionRecordRuntimeResult | CollectionPatchRuntimeResult {
  const record = unknownRecord(value);
  const resource = unknownRecord(record.resource);
  return typeof resource.id === "string"
    && typeof resource.collection_id === "string"
    && typeof resource.file_path === "string"
    && typeof resource.data === "object";
}

function isArtifactRenderResource(value: Record<string, unknown>): value is ArtifactRecord {
  const fileRef = unknownRecord(value.file_ref);
  return typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.kind === "string"
    && typeof fileRef.kind === "string"
    && typeof fileRef.id === "string"
    && typeof fileRef.uri === "string";
}

function isMemoryRenderResource(value: Record<string, unknown>): value is MemoryFrontmatter & { file_path?: string } {
  return typeof value.id === "string"
    && typeof value.topic === "string"
    && typeof value.state === "string"
    && typeof value.source_locale === "string"
    && typeof value.content_locale === "string";
}

function isWikiRenderResource(value: Record<string, unknown>): value is WikiWithFilePath {
  return typeof value.id === "string"
    && typeof value.slug === "string"
    && typeof value.title === "string"
    && typeof value.state === "string"
    && typeof value.file_path === "string";
}

function isSkillRenderResource(value: unknown): value is SkillWithFilePath {
  const record = unknownRecord(value);
  return typeof record.id === "string"
    && typeof record.title === "string"
    && typeof record.state === "string"
    && typeof record.file_path === "string"
    && (Array.isArray(record.allowed_scopes) || Array.isArray(unknownRecord(record.frontmatter).allowed_scopes));
}

function isSkillSupportFileRenderResource(value: unknown): value is SkillSupportFile {
  const record = unknownRecord(value);
  return typeof record.skill_id === "string"
    && typeof record.path === "string"
    && typeof record.file_path === "string";
}

function isCollectionSchemaRenderResource(value: Record<string, unknown>): value is CollectionSchemaWithFilePath {
  return typeof value.id === "string"
    && typeof value.version === "string"
    && typeof value.file_path === "string"
    && typeof value.labels === "object";
}

function isCollectionReindexRenderResource(value: unknown): value is CollectionReindexResult {
  const record = unknownRecord(value);
  const schemas = unknownRecord(record.schemas);
  const records = unknownRecord(record.records);
  return typeof schemas.files === "number"
    && typeof schemas.indexed === "number"
    && Array.isArray(schemas.errors)
    && typeof records.files === "number"
    && typeof records.indexed === "number"
    && Array.isArray(records.errors);
}

function isWikiReindexRenderResource(value: unknown): value is WikiReindexResult {
  const record = unknownRecord(value);
  return typeof record.indexed === "number" && typeof record.active === "number";
}

function isOperationRenderResource(value: Record<string, unknown>): value is Pick<OperationRecord, "id" | "operation" | "status"> {
  return typeof value.id === "string" && typeof value.operation === "string" && typeof value.status === "string";
}

function isResourceDeletionResult(value: { rollbackPoint?: RollbackPoint }): boolean {
  const rollback = value.rollbackPoint;
  if (!rollback) return false;
  return Object.keys(rollback.before_snapshot).length > 0
    && Object.keys(rollback.after_snapshot).length === 0;
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecordValue(value: unknown, key: string): string | undefined {
  const record = unknownRecord(value);
  return typeof record[key] === "string" ? record[key] : undefined;
}

function stringPayload(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function optionalStringPayload(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordPayload(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function browserInteractionActionPayload(value: JsonValue | undefined): "navigate" | "click" | "input" | undefined {
  return value === "navigate" || value === "click" || value === "input" ? value : undefined;
}

export function gatewayMessageLimit(channel: GatewayChannel): number {
  if (channel === "slack") return 4_000;
  if (channel === "telegram") return 4_096;
  if (channel === "line") return 5_000;
  return 20_000;
}

export function splitGatewayMessage(text: string, limit: number): string[] {
  const characters = [...text];
  if (characters.length === 0) return [""];
  if (!Number.isInteger(limit) || limit < 1) throw new Error("gateway_message_limit_invalid");
  const parts: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let end = Math.min(offset + limit, characters.length);
    if (end < characters.length) {
      const window = characters.slice(offset, end).join("");
      const newline = window.lastIndexOf("\n");
      const space = window.lastIndexOf(" ");
      const boundary = Math.max(newline, space);
      if (boundary >= Math.floor(limit * 0.6)) end = offset + [...window.slice(0, boundary + 1)].length;
    }
    const part = characters.slice(offset, end).join("");
    if (part) parts.push(part);
    offset = end;
  }
  return parts.length > 0 ? parts : [""];
}

export function buildGatewayReplyPayloads(text: string, artifacts: ArtifactRecord[], channel: GatewayChannel): Array<Record<string, JsonValue>> {
  const parts = splitGatewayMessage(text, gatewayMessageLimit(channel));
  const deliverableArtifacts = artifacts
    .filter((artifact) => artifact.kind === "pdf" || artifact.kind === "image")
    .map((artifact) => ({ id: artifact.id, kind: artifact.kind, title: artifact.title, resource_ref: artifact.file_ref }));
  return parts.map((part, index) => ({
    text: part,
    sequence: index + 1,
    total: parts.length,
    ...(index === parts.length - 1 && deliverableArtifacts.length > 0 ? { artifacts: deliverableArtifacts } : {})
  }));
}

function requiredPayloadId(payload: Record<string, JsonValue>, key: string): string {
  const id = stringPayload(payload[key]) || stringPayload(payload.id);
  if (!id) {
    throw new RuntimeRequestError("conflict", `domain_command_${key}_required`);
  }
  return id;
}

function domainStringArrayPayload(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function booleanPayload(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberPayload(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerPayload(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function resourceVersionConflictPayload(error: CollectionRecordVersionConflictErrorLike): ResourceVersionConflictPayload {
  return {
    conflict: "resource_version",
    expected_version: error.expectedVersion,
    actual_version: error.latest.version,
    latest_resource: error.latest,
    retry: {
      command_id: runtimeOperationIds.collectionPatchApply,
      expected_version: error.latest.version
    }
  };
}

type CollectionRecordVersionConflictErrorLike = Error & {
  expectedVersion: number;
  latest: CollectionRecordWithFilePath;
};

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

function isCollectionRecordVersionConflictError(error: unknown): error is CollectionRecordVersionConflictErrorLike {
  if (!hasErrorName(error, "CollectionRecordVersionConflictError")) return false;
  const candidate = error as Error & { expectedVersion?: unknown; latest?: unknown };
  return typeof candidate.expectedVersion === "number" && Boolean(candidate.latest) && typeof candidate.latest === "object";
}

function supportedLocalePayload(value: JsonValue | undefined): SupportedLocale | undefined {
  return typeof value === "string" && isSupportedLocale(value) ? value : undefined;
}

function resourceRefsPayload(value: JsonValue | undefined): ResourceRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(resourceRefFromJson).filter((ref): ref is ResourceRef => Boolean(ref));
}

function wikiSourceRefsPayload(value: JsonValue | undefined): WikiFrontmatter["source_refs"] | undefined {
  return Array.isArray(value) ? resourceRefsPayload(value) : undefined;
}

function skillSourceRefsPayload(value: JsonValue | undefined): SkillFrontmatter["source_refs"] | undefined {
  return Array.isArray(value) ? resourceRefsPayload(value) : undefined;
}

function wikiProvenancePayload(value: JsonValue | undefined): WikiFrontmatter["provenance"] | undefined {
  const parsed = ProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function skillProvenancePayload(value: JsonValue | undefined): SkillFrontmatter["provenance_detail"] | undefined {
  const parsed = ProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isCuratorLifecycleApplyAction(value: string): value is Exclude<CuratorLifecycleAction, "review"> {
  return value === "mark_stale" || value === "archive" || value === "reactivate";
}

function automationJobKindPayload(value: JsonValue | undefined): AutomationJobRecord["kind"] {
  return value === "memory_review"
    || value === "skill_curator"
    || value === "wiki_reindex"
    || value === "daily_digest"
    || value === "resource_translation"
    || value === "custom_instruction"
    ? value
    : "custom_instruction";
}

function actorIdentityPayload(value: JsonValue | undefined): ActorIdentity | undefined {
  return value === "owner"
    || value === "owner_scheduled"
    || value === "paired_contact"
    || value === "external_unknown"
    || value === "webhook_source"
    || value === "system"
    ? value
    : undefined;
}

function gatewayChannelPayload(value: JsonValue | undefined): GatewayChannel {
  return typeof value === "string" && gatewayChannels.includes(value as GatewayChannel) ? value as GatewayChannel : "webhook";
}

function runtimeToolArguments(payload: Record<string, JsonValue>, actionId: string): Record<string, JsonValue> {
  const explicitArguments = recordPayload(payload.arguments);
  if (Object.keys(explicitArguments).length > 0) {
    return explicitArguments;
  }
  const input = recordPayload(payload.input);
  if (getDomainCommandEntry(actionId)?.provider_tool_names?.includes("mcp.call")) {
    const nestedInput = recordPayload(input.input);
    return {
      server_name: stringPayload(payload.server_name) || stringPayload(input.server_name),
      tool_name: stringPayload(payload.tool_name) || stringPayload(input.tool_name),
      input: Object.keys(nestedInput).length > 0 ? nestedInput : input
    };
  }
  return input;
}

function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, jsonSafe(entry, key)]));
}

function jsonDefinedRecord(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value)) {
    throw new RuntimeRequestError("validation", "domain_payload_must_be_object");
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => [key, jsonDefined(entry)]));
}

function domainResultOperations(result: unknown): Array<{ id: string }> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const candidates: unknown[] = [];
  if ("operation" in result) candidates.push(result.operation);
  if ("operations" in result && Array.isArray(result.operations)) candidates.push(...result.operations);
  return candidates.flatMap((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && "id" in candidate && typeof candidate.id === "string" ? [{ id: candidate.id }] : []);
}

function jsonSafe(value: unknown, key?: string): JsonValue {
  if (key && isSecretLikeMetadataKey(key)) {
    return "[redacted]";
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? redactSecretLikeString(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonSafe(entry));
  }
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([entryKey, entry]) => [entryKey, jsonSafe(entry, entryKey)]));
  }
  return null;
}

function jsonDefined(value: unknown): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(jsonDefined);
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, jsonDefined(entry)]));
  }
  return null;
}

function isSecretLikeMetadataKey(key: string): boolean {
  return /secret|token|api[_-]?key|password|credential|authorization/i.test(key);
}

function redactSecretLikeString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bkey\s*=\s*["']?[^"',\s}]+/gi, "key=[redacted]")
    .replace(/\b(api[_-]?key|authorization|token|secret|password|credential|cookie)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
    .replace(/\b(?=[A-Za-z0-9.-]*(?:secret|token|password|credential))(?=[A-Za-z0-9.-]*[-.])[A-Za-z0-9.-]{12,}\b/gi, "[redacted]");
}

function safeRuntimeErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error) {
    return redactSecretLikeString(error.message);
  }
  if (typeof error === "string") {
    return redactSecretLikeString(error);
  }
  return fallback;
}

function runtimeRequestErrorFromDomainOperationError(error: DomainOperationError): RuntimeRequestError {
  const code: RuntimeRequestError["code"] = error.code === "invalid_input"
    ? "validation"
    : error.code === "invalid_output" || error.code === "internal"
      ? "internal"
      : error.code === "source_not_allowed"
        ? "forbidden"
        : error.code;
  return new RuntimeRequestError(code, error.message);
}

function parseRuntimeRequestErrorCode(code: string): RuntimeRequestErrorCode {
  switch (code) {
    case "bad_request": case "validation": case "gone": case "not_found": case "conflict":
    case "forbidden": case "unavailable": case "outcome_unknown": case "internal":
    case "provider_not_configured": case "provider_failed": case "backend_cancelled":
    case "backend_execution_root_not_ready": case "domain_command_failed":
    case "resource_mutation_evidence_failed": case "workspace_change_notification_failed":
      return code;
    default:
      return "internal";
  }
}

/**
 * Tool-call failures cross provider, Gateway, Automation, and persisted backend
 * event boundaries. Preserve only the typed error code there: raw exception
 * messages may contain provider details or secrets and are not a tool protocol.
 */
function normalizeRuntimeToolFailure(error: unknown): RuntimeToolFailure {
  const code: RuntimeToolFailureCode = error instanceof RuntimeRequestError || error instanceof DomainOperationError
    ? error.code
    : "internal_error";
  return {
    code,
    reason: "runtime_tool_failed",
    retryable: code === "provider_failed",
    summary: `runtime_tool_failed:${code}`
  };
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isProviderDiagnosticReason(value: unknown): value is ProviderDiagnostics["reason"] {
  return (
    value === "not_configured" ||
    value === "auth_failed" ||
    value === "rate_limited" ||
    value === "temporary_unavailable" ||
    value === "model_not_found" ||
    value === "invalid_model" ||
    value === "invalid_response" ||
    value === "network" ||
    value === "unknown"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface GatewayBoundaryToolDecision {
  allowed: boolean;
  action_id: string;
  provider_tool_name: string;
  reason: "no_policy" | "wildcard" | "explicit_allow" | "tool_not_allowed";
  policy?: GatewayBoundaryPolicy;
}

function gatewayBoundaryToolDecision(policy: GatewayBoundaryPolicy | undefined, providerToolName: string, requestedActionId?: string): GatewayBoundaryToolDecision {
  const actionId = requestedActionId || gatewayBoundaryActionId(providerToolName);
  if (!policy) {
    return {
      allowed: true,
      action_id: actionId,
      provider_tool_name: providerToolName || "unknown_tool",
      reason: "no_policy"
    };
  }
  if (policy.allowed_tools.includes("*")) {
    return {
      allowed: true,
      action_id: actionId,
      provider_tool_name: providerToolName || "unknown_tool",
      reason: "wildcard",
      policy
    };
  }
  const allowed = policy.allowed_tools.includes(actionId);
  return {
    allowed,
    action_id: actionId,
    provider_tool_name: providerToolName || "unknown_tool",
    reason: allowed ? "explicit_allow" : "tool_not_allowed",
    policy
  };
}

function gatewayBoundaryToolFeedback(decision: GatewayBoundaryToolDecision): BackendToolBoundaryFeedback {
  const policy = decision.policy;
  return {
    payload: {
      decision: decision.allowed ? "allowed" : "denied",
      action_id: decision.action_id,
      provider_tool_name: decision.provider_tool_name,
      reason: decision.reason,
      policy_id: policy?.id ?? null,
      source_channel: policy?.source_channel ?? null,
      source_identity: policy?.source_identity ?? null,
      session_key: policy?.session_key ?? null,
      allowed_tools: policy?.allowed_tools ?? [],
      sandbox_mode: policy?.sandbox.mode ?? null,
      sandbox_backend: policy?.sandbox.backend ?? null,
      workspace_access: policy?.sandbox.workspace_access ?? null,
      network_access: policy?.sandbox.network_access ?? null
    },
    resourceRefs: policy ? [gatewayBoundaryPolicyRef(policy)] : []
  };
}

function gatewayBoundaryToolBlockedChange(run: BackendRunRecord, decision: GatewayBoundaryToolDecision): NewWorkspaceChangeRecord {
  if (!run.room_id) throw new RuntimeRequestError("conflict", `gateway_boundary_backend_run_room_missing:${run.id}`);
  const policyRef = decision.policy ? gatewayBoundaryPolicyRef(decision.policy) : backendRunRef(run);
  return {
    id: createId("change"),
    run_id: run.id,
    session_id: run.session_id,
    room_id: run.room_id,
    resource_ref: policyRef,
    change_type: "other",
    summary: `Gateway boundary blocked tool ${decision.provider_tool_name} (${decision.action_id}).`,
    created_at: nowIso()
  };
}

function gatewayBoundaryPolicyRef(policy: GatewayBoundaryPolicy): ResourceRef {
  return {
    kind: "gateway_boundary_policy",
    id: policy.id,
    uri: `gateway/boundary-policies/${policy.id}`,
    label: `${policy.source_channel}:${policy.session_key}`
  };
}

function withGatewayBoundaryRefs(refs: ResourceRef[], boundary: BackendToolBoundaryFeedback | undefined): ResourceRef[] {
  return uniqueResourceRefs(boundary ? [...refs, ...boundary.resourceRefs] : refs);
}

function gatewayMcpConfigResourceRef(id: string, serverName: string): ResourceRef {
  return {
    kind: "gateway_mcp_config",
    id,
    uri: `gateway/mcp-configs/${id}`,
    label: serverName
  };
}

function gatewayMcpServerResourceRef(serverName: string): ResourceRef {
  return {
    kind: "gateway_mcp_config",
    id: stableHash(`gateway-mcp:${serverName}`).slice(0, 16),
    uri: `gateway/mcp-configs/by-server/${encodeURIComponent(serverName)}`,
    label: serverName
  };
}

function gatewaySandboxInstanceRef(instance: GatewaySandboxInstanceRecord): ResourceRef {
  return {
    kind: "gateway_sandbox_instance",
    id: instance.id,
    uri: `gateway/sandbox-instances/${encodeURIComponent(instance.instance_key)}`,
    label: `${instance.backend}:${instance.scope}`
  };
}

function gatewaySandboxInstanceKey(policy: GatewayBoundaryPolicy): string {
  const scopeKey = policy.sandbox.scope === "shared"
    ? "shared"
    : policy.sandbox.scope === "agent"
      ? "agent"
      : policy.session_key;
  return `${policy.sandbox.backend}:${policy.sandbox.scope}:${scopeKey}`;
}

function defaultSandboxWorkspaceSyncDirection(instance: GatewaySandboxInstanceRecord): GatewaySandboxWorkspaceSyncDirection {
  const configured = instance.sandbox.metadata.workspace_sync_direction;
  if (configured === "seed_to_sandbox" || configured === "pull_from_sandbox" || configured === "mirror") {
    return configured;
  }
  if (instance.sandbox.workspace_access === "read") {
    return "seed_to_sandbox";
  }
  if (instance.sandbox.workspace_access === "write") {
    return "pull_from_sandbox";
  }
  return "mirror";
}

function remoteWorkspaceRootForSandboxInstance(instance: GatewaySandboxInstanceRecord): string | undefined {
  const remoteRoot = instance.sandbox.metadata.remote_workspace_root;
  if (typeof remoteRoot === "string" && remoteRoot.trim()) {
    return remoteRoot;
  }
  const workspaceRoot = instance.sandbox.metadata.sandbox_workspace_root;
  if (typeof workspaceRoot === "string" && workspaceRoot.trim()) {
    return workspaceRoot;
  }
  if (instance.backend === "docker") {
    return "/workspace";
  }
  if (instance.backend === "ssh" || instance.backend === "remote") {
    return "~/samurai-agent/workspace";
  }
  return undefined;
}

function sandboxWorktreeRootError(worktreeRoot: string | undefined, coreRoot: string): string | undefined {
  if (!worktreeRoot) {
    return "sandbox_worktree_required";
  }
  const resolvedWorktreeRoot = path.resolve(worktreeRoot);
  const resolvedCoreRoot = path.resolve(coreRoot);
  if (
    resolvedWorktreeRoot === resolvedCoreRoot
    || resolvedWorktreeRoot.startsWith(`${resolvedCoreRoot}${path.sep}`)
    || resolvedCoreRoot.startsWith(`${resolvedWorktreeRoot}${path.sep}`)
  ) {
    return "sandbox_core_workspace_root_not_allowed";
  }
  return undefined;
}

function executionStatusForWorkspaceSync(execution: SandboxWorkspaceSyncExecutionResult | undefined): GatewaySandboxWorkspaceSyncRecord["status"] {
  if (!execution) {
    return "planned";
  }
  if (execution.status === "completed" || execution.status === "failed" || execution.status === "skipped") {
    return execution.status;
  }
  return "failed";
}

function sandboxExecutionResourceRef(id: string, command: string): ResourceRef {
  return {
    kind: "gateway_sandbox_execution",
    id,
    uri: `gateway/sandbox-executions/${id}`,
    label: command
  };
}

function normalizeMcpExecutionResourceRefs(refs: McpToolExecutionResult["resource_refs"]): ResourceRef[] {
  return refs.map((ref, index) => ({
    kind: ref.kind,
    id: ref.id ?? stableHash({ uri: ref.uri, index }).slice(0, 16),
    uri: ref.uri,
    ...(ref.label ? { label: ref.label } : {})
  }));
}

function sandboxCommandInputFromArgs(args: Record<string, JsonValue>): SandboxCommandExecutionInput {
  return {
    command: stringPayload(args.command),
    args: stringArrayPayload(args.args),
    cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    env: stringRecordPayload(args.env),
    stdin: typeof args.stdin === "string" ? args.stdin : undefined,
    secret_env: stringRecordPayload(args.secret_env),
    secret_files: sandboxSecretFilePayload(args.secret_files),
    timeout_ms: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    metadata: recordPayload(args.metadata)
  };
}

function stringArrayPayload(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => typeof entry === "string" ? [entry] : []);
}

function stringRecordPayload(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, entry]) => typeof entry === "string" ? [[key, entry] as const] : []);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function sandboxSecretFilePayload(value: JsonValue | undefined): SandboxCommandExecutionInput["secret_files"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, JsonValue>;
    if (typeof record.secret_ref_id !== "string" || typeof record.filename !== "string") {
      return [];
    }
    return [{
      secret_ref_id: record.secret_ref_id,
      filename: record.filename,
      ...(typeof record.env === "string" ? { env: record.env } : {}),
      ...(typeof record.mode === "number" ? { mode: record.mode } : {})
    }];
  });
}

function mcpOperationStatus(status: McpToolExecutionResult["status"]): OperationRecord["status"] {
  if (status === "completed") {
    return "completed";
  }
  if (status === "blocked") {
    return "denied";
  }
  return "failed";
}

function mcpToolRunStatus(status: McpToolExecutionResult["status"]): ToolRunRecord["status"] {
  if (status === "completed") {
    return "completed";
  }
  if (status === "blocked") {
    return "ignored";
  }
  return "failed";
}

function sandboxOperationStatus(status: SandboxCommandExecutionResult["status"]): OperationRecord["status"] {
  if (status === "completed") {
    return "completed";
  }
  if (status === "blocked") {
    return "denied";
  }
  return "failed";
}

function sandboxToolRunStatus(status: SandboxCommandExecutionResult["status"]): ToolRunRecord["status"] {
  if (status === "completed") {
    return "completed";
  }
  if (status === "blocked") {
    return "ignored";
  }
  return "failed";
}

function gatewayBoundaryActionId(providerToolName: string): string {
  return getDomainCommandForProviderToolName(providerToolName)?.id ?? (providerToolName || "unknown_tool");
}

function knowledgeWikiGraph(pages: WikiContextPage[], activeOnly: boolean): KnowledgeWikiGraph {
  const filtered = activeOnly ? pages.filter((page) => page.state === "active") : pages;
  return {
    active_only: activeOnly,
    nodes: filtered.map((page) => ({
      id: page.id,
      slug: page.slug,
      title: page.title,
      state: page.state,
      source_ref_count: page.source_refs.length
    })),
    edges: filtered.flatMap((page) => page.source_refs.map((ref) => ({
      from_wiki_id: page.id,
      relation: "source_ref" as const,
      to_ref: ref
    })))
  };
}

function normalizeExternalAssistProviders(provider?: ExternalAssistProvider | ExternalAssistProvider[]): ExternalAssistProvider[] {
  const providers = Array.isArray(provider) ? provider : provider ? [provider] : [];
  const seen = new Set<string>();
  return providers.filter((item) => {
    const id = item.id.trim();
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function normalizeGeneratedSurfaceCommandPayload(
  command: DomainCommandEntry,
  args: Record<string, JsonValue>,
  runInput: BackendRunInput
): Record<string, JsonValue> {
  assertProviderGeneratedSurfaceServerFieldsAbsent(args);
  const suppliedBundle = recordPayload(args.bundle);
  const actionValues = Array.isArray(suppliedBundle.actions)
    ? suppliedBundle.actions
    : Array.isArray(args.actions)
      ? args.actions
      : [];
  const actions = actionValues.filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const suppliedRequest = recordPayload(args.request);
  const selectedSkillRefs: ResourceRef[] = (runInput.selected_skills ?? []).map((skill) => ({
    kind: "skill",
    id: skill.id,
    uri: `skills/${skill.id}.md`,
    label: skill.title
  }));
  const request = {
    // The provider describes a view; it never owns the user's instruction.
    user_intent: runInput.user_input,
    source_resource_refs: resourceRefsPayload(suppliedRequest.source_resource_refs ?? args.source_resource_refs),
    allowed_domain_commands: Array.isArray(suppliedRequest.allowed_domain_commands)
      ? suppliedRequest.allowed_domain_commands
      : actions.map((action) => typeof action.command_id === "string" ? action.command_id : "").filter(Boolean),
    selected_knowledge_refs: resourceRefsPayload(suppliedRequest.selected_knowledge_refs ?? args.selected_knowledge_refs),
    // Selected skills are determined by Host context assembly, not a tool argument.
    selected_skill_refs: selectedSkillRefs,
    client_capabilities: Object.keys(recordPayload(suppliedRequest.client_capabilities ?? args.client_capabilities)).length > 0
      ? recordPayload(suppliedRequest.client_capabilities ?? args.client_capabilities)
      : { generated_surface: true, iframe: true },
    expected_lifetime: surfaceExpectedLifetime(suppliedRequest.expected_lifetime ?? args.expected_lifetime),
    fallback_chain: surfaceFallbackChain(suppliedRequest.fallback_chain ?? args.fallback_chain)
  };
  const bundle: Record<string, JsonValue> = Object.keys(suppliedBundle).length > 0
    ? suppliedBundle
    : {
        title: stringPayload(args.title),
        html: stringPayload(args.html),
        ...(typeof args.css === "string" ? { css: args.css } : {}),
        ...(typeof args.script === "string" ? { script: args.script } : {}),
        actions: actions as unknown as JsonValue,
        ...(Array.isArray(args.assets) ? { assets: args.assets } : {}),
        ...(args.input_data_schema && typeof args.input_data_schema === "object" && !Array.isArray(args.input_data_schema)
          ? { input_data_schema: args.input_data_schema }
          : {})
      };
  const isRevision = Object.hasOwn(recordPayload(command.input_schema.properties), "surface_id");
  if (!isRevision) {
    return { request, bundle };
  }
  const surfaceId = stringRecordValue(runInput.metadata.active_app_context, "generated_surface_id");
  if (!surfaceId) throw new RuntimeRequestError("conflict", "generated_surface_active_context_required");
  return { surface_id: surfaceId, request, bundle };
}

function surfaceExpectedLifetime(value: JsonValue | undefined): "message" | "session" | "pinned" {
  return value === "message" || value === "pinned" ? value : "session";
}

function surfaceFallbackChain(value: JsonValue | undefined): Array<"built_in_surface" | "artifact" | "text"> {
  if (!Array.isArray(value)) return ["built_in_surface", "artifact", "text"];
  const chain = value.filter((item): item is "built_in_surface" | "artifact" | "text" => item === "built_in_surface" || item === "artifact" || item === "text");
  return chain.length > 0 ? chain : ["built_in_surface", "artifact", "text"];
}

function surfaceOperationTrustedContext(input: SurfaceOperation): TrustedDomainRuntimeContext {
  const sessionId = "session_id" in input && typeof input.session_id === "string" ? input.session_id : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    surfaceOperation: { id: input.id, kind: input.kind }
  };
}

const providerServerOwnedContextFields = [
  "workspace_id",
  "actor_id",
  "actor_identity",
  "participant_id",
  "participant_kind",
  "requested_by_participant_id",
  "trusted_participant_context",
  "trusted_requester_participant_id",
  "correlation_id",
  "source",
  "input_source",
  "session_id",
  "envelope_id",
  "input_message_id",
  "run_id",
  "producer_run_id",
  "prompt_fingerprint",
  "created_at"
] as const;

const generatedSurfaceRequestServerOwnedFields = new Set<string>([
  ...providerServerOwnedContextFields,
  "id",
  "surface_id"
]);

function normalizeProviderDomainCommandPayload(
  command: DomainCommandEntry,
  args: Record<string, JsonValue>,
  trusted: { inputLocale?: SupportedLocale; outputLocale?: SupportedLocale; runId: string; userInput?: string; providerToolName: string; toolCallId?: string }
): Record<string, JsonValue> {
  assertProviderDomainServerFieldsAbsent("command", command.id, args);
  const properties = recordPayload(command.input_schema.properties);
  // Preserve every domain field. The generated operation schema is the one
  // authority that rejects unknown fields and malformed known values.
  const payload: Record<string, JsonValue> = { ...args };
  if (Object.hasOwn(properties, "input_locale") && trusted.inputLocale) payload.input_locale = trusted.inputLocale;
  if (Object.hasOwn(properties, "output_locale") && trusted.outputLocale) payload.output_locale = trusted.outputLocale;
  if (Object.hasOwn(properties, "metadata")) {
    if (args.metadata === undefined || isRecord(args.metadata)) {
      payload.metadata = {
        ...recordPayload(args.metadata),
        ...(trusted.toolCallId ? { tool_call_id: trusted.toolCallId } : {})
      };
    }
  }
  if (command.provider_tool_names?.includes("remember_topic") && typeof payload.content !== "string" && trusted.userInput?.trim()) {
    payload.content = trusted.userInput.trim();
  }
  return payload;
}

function normalizeProviderDomainQueryPayload(
  queryId: string,
  args: Record<string, JsonValue>
): Record<string, JsonValue> {
  const query = requireDomainQueryEntry(queryId);
  assertProviderDomainServerFieldsAbsent("query", query.id, args);
  if (query.output_resource_kind === "collection_view") {
    // Older provider tools can include display-only fields. They remain
    // available to the presentation projection, but do not enter the strict
    // Domain Query input contract.
    const { query: _query, record_id: _recordId, ...payload } = args;
    return payload;
  }
  // Do not sanitize unknown tool fields: the operation schema must reject them.
  return { ...args };
}

function assertProviderDomainServerFieldsAbsent(
  operationKind: "command" | "query",
  operationId: string,
  args: Record<string, JsonValue>
): void {
  for (const key of providerServerOwnedContextFields) {
    if (args[key] !== undefined) {
      throw new RuntimeRequestError("conflict", `untrusted_provider_${operationKind}_field:${operationId}:${key}`);
    }
  }
}

function assertProviderGeneratedSurfaceServerFieldsAbsent(args: Record<string, JsonValue>): void {
  const request = recordPayload(args.request);
  for (const key of generatedSurfaceRequestServerOwnedFields) {
    if (request[key] !== undefined) {
      throw new RuntimeRequestError("conflict", `untrusted_generated_surface_request_field:${key}`);
    }
  }
  for (const key of [...providerServerOwnedContextFields, "surface_id"] as const) {
    if (args[key] !== undefined) {
      throw new RuntimeRequestError("conflict", `untrusted_generated_surface_field:${key}`);
    }
  }
}

export { samuraiToolBridgeDescriptors, samuraiToolBridgeTools, samuraiToolBridgeWriteTools } from "./provider-tool-bridge-composition.js";

function toolBridgeEndpointUrl(runId: string): string {
  const explicit = process.env.SAMURAI_TOOL_BRIDGE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\{run_id\}/g, encodeURIComponent(runId));
  }
  const port = process.env.PORT?.trim() || "4317";
  return `http://127.0.0.1:${port}/api/backend-runs/${encodeURIComponent(runId)}/tool-calls`;
}

function shouldUpdateCollectionViewOutput(query: string): boolean {
  return false;
}

function artifactTitleFromUserInput(query: string): string {
  const trimmed = summarize(query.replace(/\s+/g, " "), 60);
  if (/作業メモ|work\s*memo/i.test(query)) {
    return "作業メモ";
  }
  if (/議事録|minutes/i.test(query)) {
    return "議事録";
  }
  if (/提案書|proposal/i.test(query)) {
    return "提案書";
  }
  if (/レポート|報告書|report/i.test(query)) {
    return "レポート";
  }
  if (/メール|email/i.test(query)) {
    return "メール文";
  }
  return trimmed || "作成内容";
}

function hasCreatedArtifact(artifacts: ArtifactRecord[], workspaceChanges: WorkspaceChangeRecord[]): boolean {
  return artifacts.length > 0 || workspaceChanges.some((change) => change.change_type === "artifact_created");
}

function artifactKindPayload(value: JsonValue | undefined): ArtifactKind | undefined {
  return typeof value === "string" && artifactKindValues.includes(value as ArtifactKind) ? value as ArtifactKind : undefined;
}

const artifactKindValues: ArtifactKind[] = ["markdown", "document", "table", "chart", "graph", "image", "pdf", "structured_draft", "generated_report", "note"];

function meaningfulBackendRunSummary(summary: string | undefined): string {
  const trimmed = summary?.trim() ?? "";
  if (!trimmed || trimmed === "Codex completed.") {
    return "";
  }
  return trimmed;
}

function approvePairing(pairing: GatewayPairingRecord): GatewayPairingRecord {
  const now = nowIso();
  return {
    ...pairing,
    status: "approved",
    pairing_code: undefined,
    resolved_at: now,
    updated_at: now
  };
}

function rejectPairing(pairing: GatewayPairingRecord): GatewayPairingRecord {
  const now = nowIso();
  return {
    ...pairing,
    status: "rejected",
    pairing_code: undefined,
    resolved_at: now,
    updated_at: now
  };
}


function fileRollbackSnapshot(snapshot: RollbackPoint["before_snapshot"]): { path: string; content: string | null } | undefined {
  const snapshotPath = snapshot.path;
  const content = snapshot.content;
  if (typeof snapshotPath !== "string") {
    return undefined;
  }
  if (typeof content === "string" || content === null) {
    return {
      path: snapshotPath,
      content
    };
  }
  return undefined;
}

function createCronMemoryReviewEnvelope(): MessageEnvelope {
  return createGatewayEnvelope(cronMemoryReviewGatewayContext, "Run scheduled memory review.");
}

function backendRunRef(run: BackendRunRecord): ResourceRef {
  return {
    kind: "backend_run",
    id: run.id,
    uri: `backend-runs/${run.id}`,
    label: run.input_summary
  };
}

function toolRunRef(toolRun: ToolRunRecord): ResourceRef {
  return {
    kind: "tool_run",
    id: toolRun.id,
    uri: `tool-runs/${toolRun.id}`,
    label: `${toolRun.provider_tool_name}:${toolRun.status}`
  };
}

function backendStatusWithRunHistory(status: AgentBackendStatus, runs: BackendRunRecord[]): AgentBackendStatus {
  const backendRuns = runs.filter((run) => run.backend_id === status.id);
  const latest = backendRuns[0];
  const latestFailure = backendRuns.find((run) => run.status === "failed");
  const recentFailureCount = backendRuns.slice(0, 20).filter((run) => run.status === "failed").length;
  if (!latest) {
    return status;
  }
  return {
    ...status,
    metadata: {
      ...(status.metadata ?? {}),
      last_run_id: latest.id,
      last_run_status: latest.status,
      last_run_at: latest.completed_at ?? latest.started_at,
      recent_failure_count: recentFailureCount,
      ...(latestFailure ? { last_failure_run_id: latestFailure.id } : {}),
      ...(latestFailure?.error_code ? { last_error_code: latestFailure.error_code } : {})
    }
  };
}

function uniqueResourceRefs(refs: ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  const unique: ResourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}:${ref.uri}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}




function wikiRef(wiki: WikiWithFilePath) {
  return {
    kind: "wiki",
    id: wiki.id,
    uri: wiki.file_path,
    label: wiki.title
  };
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || createId("wiki_slug");
}

function collectionSchemaRef(schema: CollectionSchemaWithFilePath) {
  return {
    kind: "collection_schema",
    id: schema.id,
    uri: schema.file_path,
    version: schema.version,
    label: schema.id
  };
}

function collectionRecordRef(record: CollectionRecordWithFilePath) {
  return {
    kind: "collection_record",
    id: record.id,
    uri: record.file_path,
    label: `${record.collection_id}/${record.id}`
  };
}

function findCollectionAction(schema: CollectionSchema, actionId: string): Record<string, JsonValue> | undefined {
  return schema.actions.find((action) => {
    const id = collectionActionString(action, "id")
      ?? collectionActionString(action, "name")
      ?? collectionActionString(action, "action_id");
    return id === actionId;
  });
}

function collectionActionKind(action: Record<string, JsonValue>): string {
  return collectionActionString(action, "kind")
    ?? collectionActionString(action, "type")
    ?? "custom_instruction";
}

function collectionActionString(action: Record<string, JsonValue>, key: string): string | undefined {
  const value = action[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function collectionActionRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function isInstructionCollectionActionKind(kind: string): boolean {
  return ["custom_instruction", "instruction", "backend_instruction", "chat"].includes(kind);
}

function collectionActionInstruction(action: Record<string, JsonValue>, payload: Record<string, JsonValue>): string | undefined {
  return collectionActionString(action, "instruction")
    ?? collectionActionString(action, "target_instruction")
    ?? collectionActionString(action, "prompt")
    ?? (typeof payload.instruction === "string" && payload.instruction.trim() ? payload.instruction : undefined);
}

function collectionActionOutputSurface(action: Record<string, JsonValue>, payload: Record<string, JsonValue>): string | undefined {
  return collectionActionString(action, "output_surface")
    ?? collectionActionString(action, "surface")
    ?? (typeof payload.output_surface === "string" && payload.output_surface.trim() ? payload.output_surface.trim() : undefined);
}

function collectionActionCustomViewOutput(content: string): Record<string, JsonValue> | undefined {
  const parsed = parseJsonObjectFromText(content);
  if (!parsed) {
    return undefined;
  }
  const nested = recordPayload(parsed.custom_view);
  const output = Object.keys(nested).length > 0 ? nested : parsed;
  const html = stringPayload(output.html) || stringPayload(output.srcdoc);
  if (!html.trim()) {
    return undefined;
  }
  return {
    ...output,
    html
  };
}

function parseJsonObjectFromText(text: string): Record<string, JsonValue> | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(body) as unknown;
    const record = unknownRecord(parsed);
    return Object.keys(record).length > 0 ? jsonRecord(record) : undefined;
  } catch {
    return undefined;
  }
}

function collectionActionInstructionPrompt(input: {
  collectionId: string;
  actionId: string;
  instruction: string;
  record?: CollectionRecordWithFilePath;
  resolvedRecordData?: Record<string, JsonValue>;
  payload: Record<string, JsonValue>;
  outputSurface?: string;
}): string {
  return [
    `Run Collection action ${input.collectionId}/${input.actionId}.`,
    `Instruction:\n${input.instruction}`,
    input.outputSurface === "custom_view"
      ? "Return a JSON object with custom_view.html for the generated Workspace UI. Example: {\"custom_view\":{\"title\":\"...\",\"html\":\"<main>...</main>\",\"actions\":[]}}"
      : "",
    input.record ? `Record:\n${JSON.stringify({
      id: input.record.id,
      collection_id: input.record.collection_id,
      data: input.resolvedRecordData ?? input.record.data
    }, null, 2)}` : "",
    Object.keys(input.payload).length > 0 ? `Payload:\n${JSON.stringify(input.payload, null, 2)}` : ""
  ].filter(Boolean).join("\n\n");
}

function collectionActionScope(action: Record<string, JsonValue>, kind: string): "collection" | "record" {
  const declared = collectionActionString(action, "scope");
  if (declared === "collection" || declared === "record") {
    return declared;
  }
  if (["patch_record", "patch"].includes(kind) || collectionActionString(action, "record_id")) {
    return "record";
  }
  const resourceKinds = collectionActionStringArray(action.resource_kinds) ?? [];
  if (resourceKinds.includes("collection_record") && !resourceKinds.includes("collection_schema") && !resourceKinds.includes("collection_index")) {
    return "record";
  }
  return "collection";
}

function collectionActionDescriptor(collectionId: string, action: Record<string, JsonValue>, pluginRegistry: PluginRuntimeRegistry): CollectionActionDescriptor {
  const actionId = collectionActionString(action, "id")
    ?? collectionActionString(action, "name")
    ?? collectionActionString(action, "action_id")
    ?? "unnamed_action";
  const actionKind = collectionActionKind(action);
  const implementationTarget = collectionActionImplementationTarget(action, actionKind);
  const catalogActionId = isPluginCollectionAction(action, actionKind) ? collectionActionCatalogId(action, actionId) : undefined;
  const catalogAction = catalogActionId ? pluginRegistry.getAction(catalogActionId) : undefined;
  const handlerRegistered = catalogActionId ? pluginRegistry.hasRegisteredHandler(catalogActionId) : false;
  const builtIn = implementationTarget === "runtime" && isBuiltInCollectionActionKind(actionKind);
  const availability = builtIn
    ? "available"
    : catalogActionId
      ? catalogAction
        ? handlerRegistered ? "available" : "handler_missing"
        : "action_missing"
      : "unsupported";
  return {
    collection_id: collectionId,
    action_id: actionId,
    action_kind: actionKind,
    title: collectionActionString(action, "title"),
    description: collectionActionString(action, "description"),
    implementation_target: implementationTarget,
    catalog_action_id: catalogActionId,
    handler_id: catalogAction?.handler_id ?? collectionActionString(action, "handler_id"),
    ui_display_category: collectionActionString(action, "ui_display_category") ?? "collection",
    resource_kinds: collectionActionStringArray(action.resource_kinds) ?? catalogAction?.resource_kinds ?? ["collection_record"],
    availability,
    unsupported_reason: availability === "unsupported" ? `collection_action_kind_unsupported:${actionKind}` : undefined,
    definition: action
  };
}

function isBuiltInCollectionActionKind(kind: string): boolean {
  return ["patch_record", "patch", "create_record", "create", "reindex", "reindex_collection"].includes(kind)
    || isInstructionCollectionActionKind(kind);
}

function isPluginCollectionAction(action: Record<string, JsonValue>, kind: string): boolean {
  const target = collectionActionImplementationTarget(action, kind);
  return target === "plugin" || target === "external" || kind === "plugin" || kind === "plugin_action";
}

function collectionActionImplementationTarget(action: Record<string, JsonValue>, kind: string): string {
  return collectionActionString(action, "implementation_target")
    ?? collectionActionString(action, "target")
    ?? (kind === "plugin" || kind === "plugin_action" ? "plugin" : "runtime");
}

function collectionActionCatalogId(action: Record<string, JsonValue>, fallback: string): string {
  return collectionActionString(action, "catalog_action_id")
    ?? collectionActionString(action, "action_catalog_id")
    ?? collectionActionString(action, "plugin_action_id")
    ?? fallback;
}

function collectionActionStringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;
}

function collectionActionExecutionRef(collectionId: string, actionId: string, operationId: string) {
  return {
    kind: "collection_action",
    id: `${collectionId}/${actionId}/${operationId}`,
    uri: `collections/${collectionId}/actions/${actionId}`,
    label: `${collectionId}/${actionId}`
  };
}

function collectionRecordTargetFromRef(ref: ResourceRef): { collectionId: string; recordId: string } | undefined {
  const uriMatch = ref.uri.match(/^collections\/([^/]+)\/records\/([^/]+)\.json$/);
  if (uriMatch) {
    const collectionId = uriMatch[1];
    if (collectionId) {
      return { collectionId, recordId: ref.id };
    }
  }
  const labelMatch = ref.label?.match(/^([^/]+)\/([^/]+)$/);
  if (labelMatch) {
    const collectionId = labelMatch[1];
    const recordId = labelMatch[2];
    if (collectionId && recordId) {
      return { collectionId, recordId };
    }
  }
  return undefined;
}

function resourceRefFromJson(value: JsonValue | undefined): ResourceRef | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  const uri = typeof value.uri === "string" ? value.uri : undefined;
  if (!kind || !id || !uri) return undefined;
  return { kind, id, uri,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}) };
}

function resourceTranslationAutomationTarget(value: Record<string, JsonValue>): {
  sourceRef: ResourceRef;
  sourceLocale?: SupportedLocale;
  targetLocale: SupportedLocale;
  originalHash?: string;
} | undefined {
  const sourceRef = resourceRefFromJson(value.source_ref);
  const targetLocale = localeFromJson(value.target_locale);
  if (!sourceRef || !targetLocale) return undefined;
  const sourceLocale = localeFromJson(value.source_locale);
  const originalHash = typeof value.original_hash === "string" && value.original_hash.trim()
    ? value.original_hash
    : undefined;
  return {
    sourceRef,
    ...(sourceLocale ? { sourceLocale } : {}),
    targetLocale,
    ...(originalHash ? { originalHash } : {})
  };
}

function localeFromJson(value: JsonValue | undefined): SupportedLocale | undefined {
  return typeof value === "string" && ["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"].includes(value)
    ? value as SupportedLocale
    : undefined;
}

function isManagedCollectionWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  return /^collections\/[^/]+\/schema\.json$/.test(normalized)
    || /^collections\/[^/]+\/records\/[^/]+\.json$/.test(normalized);
}

function gatewayInboundRef(inbound: GatewayInboundMessageRecord) {
  return {
    kind: "gateway_inbound",
    id: inbound.id,
    uri: `gateway-inbound/${inbound.id}`,
    label: `${inbound.channel}:${inbound.source_identity}`
  };
}

function gatewayPairingRef(pairing: GatewayPairingRecord): ResourceRef {
  return {
    kind: "gateway_pairing",
    id: pairing.id,
    uri: `gateway-pairings/${pairing.id}`,
    label: `${pairing.channel}:${pairing.source_identity}`
  };
}

function gatewayConcurrencyLockRef(lock: GatewayConcurrencyLockRecord): ResourceRef {
  return {
    kind: "gateway_concurrency_lock",
    id: lock.id,
    uri: `gateway-concurrency-locks/${encodeURIComponent(lock.lock_key)}`,
    label: lock.lock_key
  };
}

function gatewayRepairPairingAction(
  pairing: GatewayPairingRecord,
  status: GatewayRepairAction["status"],
  applied?: GatewayPairingRecord
): GatewayRepairAction {
  return {
    action: "expire_pairing",
    status,
    reason: "pending_pairing_expired",
    target_ref: gatewayPairingRef(pairing),
    before_status: pairing.status,
    after_status: applied?.status ?? (status === "applied" ? "expired" : undefined),
    metadata: {
      channel: pairing.channel,
      session_key: pairing.session_key,
      expires_at: pairing.expires_at ?? null
    }
  };
}

function gatewayRepairLockAction(
  lock: GatewayConcurrencyLockRecord,
  status: GatewayRepairAction["status"],
  applied?: GatewayConcurrencyLockRecord
): GatewayRepairAction {
  return {
    action: "expire_concurrency_lock",
    status,
    reason: "concurrency_lock_expired",
    target_ref: gatewayConcurrencyLockRef(lock),
    before_status: lock.status,
    after_status: applied?.status ?? (status === "applied" ? "expired" : undefined),
    metadata: {
      lock_key: lock.lock_key,
      scope: lock.scope,
      policy_id: lock.policy_id ?? null,
      expires_at: lock.expires_at
    }
  };
}

function automationJobRef(job: AutomationJobRecord) {
  return {
    kind: "automation_job",
    id: job.id,
    uri: `automation-jobs/${job.id}`,
    label: job.title
  };
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function readBrowserPage(url: string): Promise<{ url: string; title?: string; html: string; text: string; adapter: "playwright" | "fetch" }> {
  const safeUrl = await safeBrowserUrl(url);
  const playwrightPage = await readBrowserPageWithPlaywright(safeUrl).catch(() => undefined);
  if (playwrightPage) {
    return playwrightPage;
  }
  const response = await fetch(safeUrl, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new RuntimeRequestError("forbidden", "browser_redirect_blocked");
  }
  const html = await response.text();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  return {
    url,
    title,
    html,
    text: htmlToText(html).slice(0, 20_000),
    adapter: "fetch"
  };
}

async function readBrowserPageWithPlaywright(url: string): Promise<{ url: string; title?: string; html: string; text: string; adapter: "playwright" } | undefined> {
  if (process.env.SAMURAI_BROWSER_ADAPTER !== "playwright") {
    return undefined;
  }
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const imported = await dynamicImport("playwright").catch(() => undefined) as { chromium?: { launch: (options: { headless: boolean }) => Promise<{
    newPage: () => Promise<{
      goto: (targetUrl: string, options: { waitUntil: "networkidle"; timeout: number }) => Promise<unknown>;
      title: () => Promise<string>;
      content: () => Promise<string>;
      route?: (pattern: string, handler: (route: {
        request: () => { url: () => string };
        abort: () => Promise<void>;
        continue: () => Promise<void>;
      }) => Promise<void>) => Promise<void>;
      locator: (selector: string) => { innerText: (options: { timeout: number }) => Promise<string> };
    }>;
    close: () => Promise<void>;
  }> } } | undefined;
  if (!imported?.chromium) {
    return undefined;
  }
  const browser = await imported.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    if (!page.route) throw new BrowserUrlSafetyError("network_guard_unavailable");
    let blockedRequest: BrowserUrlSafetyError | undefined;
    await page.route("**/*", async (route) => {
      const target = route.request().url();
      if (isNonNetworkBrowserRequest(target)) {
        await route.continue();
        return;
      }
      try {
        await assertSafeBrowserUrl(target);
        await route.continue();
      } catch (error) {
        blockedRequest = error instanceof BrowserUrlSafetyError ? error : new BrowserUrlSafetyError("invalid");
        await route.abort();
      }
    });
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    } catch (error) {
      if (blockedRequest) throw blockedRequest;
      throw error;
    }
    if (blockedRequest) throw blockedRequest;
    const [title, html, text] = await Promise.all([
      page.title(),
      page.content(),
      page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")
    ]);
    return {
      url,
      title,
      html,
      text: text.slice(0, 20_000),
      adapter: "playwright"
    };
  } finally {
    await browser.close();
  }
}

async function safeBrowserUrl(value: string): Promise<string> {
  if (isNonNetworkBrowserRequest(value.trim())) {
    try {
      return new URL(value.trim()).toString();
    } catch {
      throw new RuntimeRequestError("forbidden", "browser_url_invalid");
    }
  }
  try {
    return (await assertSafeBrowserUrl(value)).toString();
  } catch (error) {
    if (error instanceof BrowserUrlSafetyError) {
      throw new RuntimeRequestError("forbidden", `browser_url_${error.reason}`);
    }
    throw error;
  }
}

function nextRunFromSchedule(schedule: string, fromMs = Date.now()): string {
  const normalized = schedule.trim().toLowerCase();
  if (isOneShotSchedule(normalized)) {
    return new Date(fromMs).toISOString();
  }
  if (normalized.includes("weekly")) {
    return new Date(fromMs + 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (normalized.includes("hourly")) {
    return new Date(fromMs + 60 * 60 * 1000).toISOString();
  }
  const everyHours = normalized.match(/every\s+(\d+(?:\.\d+)?)\s+hours?/);
  if (everyHours) {
    return new Date(fromMs + Number(everyHours[1]) * 60 * 60 * 1000).toISOString();
  }
  return new Date(fromMs + 24 * 60 * 60 * 1000).toISOString();
}

function isOneShotSchedule(schedule: string): boolean {
  return ["once", "one-shot", "oneshot"].includes(schedule.trim().toLowerCase());
}

function nextRetryAt(failureCount: number): string {
  return new Date(Date.now() + learningRetryDelayMs(failureCount)).toISOString();
}

type ExternalSendDispatchAdapterResult = { dispatched: boolean; adapter: string; transport?: string; status?: number; dry_run: boolean; message: string; idempotency_guaranteed?: boolean; outcome_unknown?: boolean };

interface SmtpResponse {
  code: number;
  lines: string[];
}

interface SmtpClientConnection {
  readResponse(): Promise<SmtpResponse>;
  writeCommand(command: string): Promise<void>;
  writeData(data: string): Promise<void>;
  startTls?(host: string): Promise<void>;
  close(): void;
}

type SmtpClientConnectionFactory = (config: SmtpTransportConfig) => Promise<SmtpClientConnection>;

interface SmtpTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  startTls: boolean;
  timeoutMs: number;
  heloName: string;
  username?: string;
  password?: string;
  from: string;
}

let smtpClientConnectionFactory: SmtpClientConnectionFactory = createNodeSmtpClientConnection;

export function setExternalSendSmtpClientConnectionFactoryForTest(factory?: SmtpClientConnectionFactory): void {
  smtpClientConnectionFactory = factory ?? createNodeSmtpClientConnection;
}

async function dispatchExternalSendAdapter(send: ExternalSendRecord, dryRun: boolean): Promise<ExternalSendDispatchAdapterResult> {
  if (send.channel === "email") {
    return dispatchEmailSmtpExternalSend(send, dryRun);
  }
  if (send.channel === "telegram") {
    return dispatchTelegramExternalSend(send, dryRun);
  }
  if (send.channel === "line") {
    return dispatchLineExternalSend(send, dryRun);
  }
  if (send.channel === "slack" && slackBotToken() && externalSendTargetString(send, "channel_id", "channel")) {
    return dispatchSlackApiExternalSend(send, dryRun);
  }
  return dispatchHttpExternalSend(send, dryRun);
}

async function dispatchEmailSmtpExternalSend(send: ExternalSendRecord, dryRun: boolean): Promise<ExternalSendDispatchAdapterResult> {
  const config = smtpTransportConfig(send);
  if (!config) {
    return {
      dispatched: false,
      adapter: "email",
      transport: "smtp",
      dry_run: true,
      message: "Email dispatch is prepared but SMTP transport is not configured."
    };
  }
  const recipients = emailRecipients(send);
  if (recipients.length === 0) {
    throw new RuntimeRequestError("conflict", "email_recipient_required");
  }
  if (dryRun) {
    return externalSendDryRunResult("email", "smtp");
  }
  try {
    await sendSmtpMessage(config, {
      from: config.from,
      to: recipients,
      subject: send.title,
      body: send.body,
      idempotencyKey: send.id
    });
    return {
      dispatched: true,
      adapter: "email",
      transport: "smtp",
      dry_run: false,
      idempotency_guaranteed: false,
      message: "email smtp dispatched."
    };
  } catch (error) {
    return externalSendFailureResult("email", "smtp", error);
  }
}

async function sendSmtpMessage(config: SmtpTransportConfig, message: { from: string; to: string[]; subject: string; body: string; idempotencyKey: string }): Promise<void> {
  const connection = await smtpClientConnectionFactory(config);
  try {
    await expectSmtpResponse(connection, [220], "greeting");
    await smtpCommand(connection, `EHLO ${config.heloName}`, [250], "ehlo");
    if (config.startTls && connection.startTls) {
      await smtpCommand(connection, "STARTTLS", [220], "starttls");
      await connection.startTls(config.host);
      await smtpCommand(connection, `EHLO ${config.heloName}`, [250], "ehlo_tls");
    }
    if (config.username && config.password) {
      const auth = Buffer.from(`\0${config.username}\0${config.password}`, "utf8").toString("base64");
      await smtpCommand(connection, `AUTH PLAIN ${auth}`, [235], "auth");
    }
    await smtpCommand(connection, `MAIL FROM:<${message.from}>`, [250], "mail_from");
    for (const recipient of message.to) {
      await smtpCommand(connection, `RCPT TO:<${recipient}>`, [250, 251], "rcpt_to");
    }
    await smtpCommand(connection, "DATA", [354], "data");
    await connection.writeData(formatSmtpMessage(message));
    await expectSmtpResponse(connection, [250], "data_complete");
    await connection.writeCommand("QUIT");
  } finally {
    connection.close();
  }
}

async function smtpCommand(connection: SmtpClientConnection, command: string, expected: number[], stage: string): Promise<void> {
  await connection.writeCommand(command);
  await expectSmtpResponse(connection, expected, stage);
}

async function expectSmtpResponse(connection: SmtpClientConnection, expected: number[], stage: string): Promise<SmtpResponse> {
  const response = await connection.readResponse();
  if (!expected.includes(response.code)) {
    throw new Error(`smtp_${stage}_failed:${response.code}`);
  }
  return response;
}

function formatSmtpMessage(message: { from: string; to: string[]; subject: string; body: string; idempotencyKey: string }): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to.join(", ")}`,
    `Subject: ${smtpHeaderValue(message.subject)}`,
    `X-Samurai-Idempotency-Key: ${smtpHeaderValue(message.idempotencyKey)}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  const body = message.body.replace(/\r?\n/g, "\r\n").split("\r\n").map((line) => line.startsWith(".") ? `.${line}` : line).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n.\r\n`;
}

function smtpHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim() || "External send";
}

function smtpTransportConfig(send: ExternalSendRecord): SmtpTransportConfig | undefined {
  const host = envString("SAMURAI_EMAIL_SMTP_HOST");
  const from = externalSendTargetString(send, "from") ?? envString("SAMURAI_EMAIL_FROM") ?? envString("SAMURAI_EMAIL_SMTP_FROM");
  if (!host || !from) {
    return undefined;
  }
  const secure = envBoolean("SAMURAI_EMAIL_SMTP_SECURE", smtpPort() === 465);
  return {
    host,
    port: smtpPort(secure),
    secure,
    startTls: envBoolean("SAMURAI_EMAIL_SMTP_STARTTLS", !secure),
    timeoutMs: envNumber("SAMURAI_EMAIL_SMTP_TIMEOUT_MS", 10_000),
    heloName: envString("SAMURAI_EMAIL_SMTP_HELO") ?? "samurai-agent.local",
    username: envString("SAMURAI_EMAIL_SMTP_USER"),
    password: envString("SAMURAI_EMAIL_SMTP_PASSWORD"),
    from
  };
}

function smtpPort(secure = false): number {
  return envNumber("SAMURAI_EMAIL_SMTP_PORT", secure ? 465 : 587);
}

function emailRecipients(send: ExternalSendRecord): string[] {
  return [
    ...externalSendTargetStringList(send, "to", "recipient", "email"),
    ...externalSendTargetStringList(send, "cc"),
    ...externalSendTargetStringList(send, "bcc")
  ];
}

function externalSendTargetStringList(send: ExternalSendRecord, ...keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = send.target[key];
    if (typeof value === "string") {
      values.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    } else if (Array.isArray(value)) {
      values.push(...value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []));
    }
  }
  return [...new Set(values)];
}

async function dispatchHttpExternalSend(send: ExternalSendRecord, dryRun: boolean): Promise<ExternalSendDispatchAdapterResult> {
  const url = externalSendTargetString(send, "url");
  if (!url) {
    throw new RuntimeRequestError("conflict", `${send.channel}_url_required`);
  }
  if (dryRun) {
    return {
      dispatched: false,
      adapter: send.channel,
      transport: "http",
      dry_run: true,
      message: "Dry run recorded. Set SAMURAI_EXTERNAL_SEND_DISPATCH=true to enable dispatch."
    };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": send.id },
      body: JSON.stringify(send.channel === "slack" ? { text: `*${send.title}*\n${send.body}` } : { title: send.title, body: send.body })
    });
    return {
      dispatched: response.ok,
      adapter: send.channel,
      transport: "http",
      status: response.status,
      dry_run: false,
      idempotency_guaranteed: false,
      message: response.ok ? `${send.channel} dispatched.` : `${send.channel} dispatch failed.`
    };
  } catch (error) {
    return {
      dispatched: false,
      adapter: send.channel,
      transport: "http",
      dry_run: false,
      outcome_unknown: true,
      message: safeExternalSendDispatchError(error, `${send.channel} dispatch failed.`)
    };
  }
}

async function dispatchSlackApiExternalSend(send: ExternalSendRecord, dryRun: boolean): Promise<ExternalSendDispatchAdapterResult> {
  const token = slackBotToken();
  const channel = externalSendTargetString(send, "channel_id", "channel");
  if (!channel) {
    throw new RuntimeRequestError("conflict", "slack_channel_required");
  }
  if (!token) {
    throw new RuntimeRequestError("conflict", "slack_bot_token_required");
  }
  if (dryRun) {
    return externalSendDryRunResult("slack", "api");
  }
  try {
    const response = await fetch(slackApiUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": send.id
      },
      body: JSON.stringify({
        channel,
        text: `*${send.title}*\n${send.body}`,
        ...(externalSendTargetString(send, "thread_ts") ? { thread_ts: externalSendTargetString(send, "thread_ts") } : {})
      })
    });
    const body = await safeJsonResponse(response);
    const dispatched = response.ok && body?.ok !== false;
    return {
      dispatched,
      adapter: "slack",
      transport: "api",
      status: response.status,
      dry_run: false,
      idempotency_guaranteed: false,
      message: dispatched ? "slack api dispatched." : "slack api dispatch failed."
    };
  } catch (error) {
    return externalSendFailureResult("slack", "api", error);
  }
}

async function dispatchTelegramExternalSend(send: ExternalSendRecord, dryRun: boolean): Promise<ExternalSendDispatchAdapterResult> {
  const chatId = externalSendTargetString(send, "chat_id", "chatId", "to");
  if (!chatId) {
    throw new RuntimeRequestError("conflict", "telegram_chat_id_required");
  }
  const token = telegramBotToken();
  if (!token) {
    throw new RuntimeRequestError("conflict", "telegram_bot_token_required");
  }
  if (dryRun) {
    return externalSendDryRunResult("telegram", "api");
  }
  try {
    const response = await fetch(`${telegramApiBaseUrl()}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": send.id },
      body: JSON.stringify({
        chat_id: chatId,
        text: `${send.title}\n\n${send.body}`,
        ...(externalSendTargetString(send, "message_thread_id", "thread_id") ? { message_thread_id: externalSendTargetString(send, "message_thread_id", "thread_id") } : {}),
        ...(externalSendTargetString(send, "parse_mode") ? { parse_mode: externalSendTargetString(send, "parse_mode") } : {})
      })
    });
    const body = await safeJsonResponse(response);
    const dispatched = response.ok && body?.ok !== false;
    return {
      dispatched,
      adapter: "telegram",
      transport: "api",
      status: response.status,
      dry_run: false,
      idempotency_guaranteed: false,
      message: dispatched ? "telegram api dispatched." : "telegram api dispatch failed."
    };
  } catch (error) {
    return externalSendFailureResult("telegram", "api", error);
  }
}

async function dispatchLineExternalSend(send: ExternalSendRecord, dryRun: boolean): Promise<ExternalSendDispatchAdapterResult> {
  const replyToken = externalSendTargetString(send, "reply_token", "replyToken");
  const to = externalSendTargetString(send, "to", "user_id", "group_id", "room_id");
  if (!replyToken && !to) {
    throw new RuntimeRequestError("conflict", "line_target_required");
  }
  const token = lineChannelAccessToken();
  if (!token) {
    throw new RuntimeRequestError("conflict", "line_channel_access_token_required");
  }
  if (dryRun) {
    return externalSendDryRunResult("line", "api");
  }
  const endpoint = `${lineApiBaseUrl()}/${replyToken ? "reply" : "push"}`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": send.id
      },
      body: JSON.stringify(replyToken
        ? { replyToken, messages: [lineTextMessage(send)] }
        : { to, messages: [lineTextMessage(send)] })
    });
    return {
      dispatched: response.ok,
      adapter: "line",
      transport: "api",
      status: response.status,
      dry_run: false,
      idempotency_guaranteed: false,
      message: response.ok ? "line api dispatched." : "line api dispatch failed."
    };
  } catch (error) {
    return externalSendFailureResult("line", "api", error);
  }
}

function externalSendDryRunResult(adapter: string, transport: string): ExternalSendDispatchAdapterResult {
  return {
    dispatched: false,
    adapter,
    transport,
    dry_run: true,
    idempotency_guaranteed: true,
    message: "Dry run recorded. Set SAMURAI_EXTERNAL_SEND_DISPATCH=true to enable dispatch."
  };
}

function externalSendFailureResult(adapter: string, transport: string, error: unknown): ExternalSendDispatchAdapterResult {
  return {
    dispatched: false,
    adapter,
    transport,
    dry_run: false,
    outcome_unknown: true,
    message: safeExternalSendDispatchError(error, `${adapter} dispatch failed.`)
  };
}

function lineTextMessage(send: ExternalSendRecord) {
  return {
    type: "text",
    text: `${send.title}\n\n${send.body}`
  };
}

async function safeJsonResponse(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await response.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function externalSendTargetString(send: ExternalSendRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = send.target[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

async function createNodeSmtpClientConnection(config: SmtpTransportConfig): Promise<SmtpClientConnection> {
  const socket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
    : netConnect({ host: config.host, port: config.port });
  const connection = new NodeSmtpClientConnection(socket, config.timeoutMs);
  await connection.waitForConnect();
  return connection;
}

class NodeSmtpClientConnection implements SmtpClientConnection {
  private socket: Socket | TLSSocket;
  private readonly timeoutMs: number;
  private buffer = "";
  private readonly lines: string[] = [];
  private pendingLine?: {
    resolve: (line: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(socket: Socket | TLSSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attachSocket(socket);
  }

  waitForConnect(): Promise<void> {
    if ((this.socket as TLSSocket).encrypted) {
      return this.waitForSocketEvent("secureConnect");
    }
    if (!this.socket.connecting) {
      return Promise.resolve();
    }
    return this.waitForSocketEvent("connect");
  }

  async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      if (/^\d{3}\s/.test(line) || !/^\d{3}-/.test(line)) {
        break;
      }
    }
    const code = Number(lines.at(-1)?.slice(0, 3));
    if (!Number.isFinite(code)) {
      throw new Error("smtp_invalid_response");
    }
    return { code, lines };
  }

  async writeCommand(command: string): Promise<void> {
    await this.writeRaw(`${command}\r\n`);
  }

  async writeData(data: string): Promise<void> {
    await this.writeRaw(data);
  }

  async startTls(host: string): Promise<void> {
    const nextSocket = tlsConnect({ socket: this.socket, servername: host });
    this.socket.removeAllListeners("data");
    this.socket = nextSocket;
    this.attachSocket(nextSocket);
    await this.waitForConnect();
  }

  close(): void {
    if (this.pendingLine) {
      clearTimeout(this.pendingLine.timer);
      this.pendingLine.reject(new Error("smtp_connection_closed"));
    }
    this.pendingLine = undefined;
    this.socket.end();
  }

  private waitForSocketEvent(event: "connect" | "secureConnect"): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("smtp_connect_timeout"));
      }, this.timeoutMs);
      timer.unref?.();
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off(event, onReady);
        this.socket.off("error", onError);
      };
      this.socket.once(event, onReady);
      this.socket.once("error", onError);
    });
  }

  private attachSocket(socket: Socket | TLSSocket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.flushLines();
    });
    socket.on("error", (error) => {
      this.pendingLine?.reject(error);
      this.pendingLine = undefined;
    });
  }

  private readLine(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLine = undefined;
        reject(new Error("smtp_response_timeout"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pendingLine = { resolve, reject, timer };
    });
  }

  private flushLines(): void {
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) {
        return;
      }
      const rawLine = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (this.pendingLine) {
        clearTimeout(this.pendingLine.timer);
        const pending = this.pendingLine;
        this.pendingLine = undefined;
        pending.resolve(line);
      } else {
        this.lines.push(line);
      }
    }
  }

  private writeRaw(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

function slackBotToken(): string | undefined {
  return envString("SAMURAI_SLACK_BOT_TOKEN");
}

function providerToolIdempotencyKey(
  runId: string,
  attemptNo: number,
  toolCallId: string,
  commandId: string
): string {
  return `${runId}:${attemptNo}:${toolCallId}:${commandId}`;
}

function slackApiUrl(): string {
  return envString("SAMURAI_SLACK_API_URL") ?? "https://slack.com/api/chat.postMessage";
}

function telegramBotToken(): string | undefined {
  return envString("SAMURAI_TELEGRAM_BOT_TOKEN");
}

function telegramApiBaseUrl(): string {
  return (envString("SAMURAI_TELEGRAM_API_BASE_URL") ?? "https://api.telegram.org").replace(/\/+$/, "");
}

function lineChannelAccessToken(): string | undefined {
  return envString("SAMURAI_LINE_CHANNEL_ACCESS_TOKEN");
}

function lineApiBaseUrl(): string {
  return (envString("SAMURAI_LINE_API_BASE_URL") ?? "https://api.line.me/v2/bot/message").replace(/\/+$/, "");
}

function envString(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function envBoolean(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "yes";
}

function envNumber(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("background_review_aborted");
}

function assertTrustedRuntimeContextActive(context: Pick<TrustedDomainRuntimeContext, "signal" | "deadlineAt">): void {
  if (context.signal?.aborted) throw new RuntimeRequestError("unavailable", "runtime_context_aborted");
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
    throw new RuntimeRequestError("unavailable", "runtime_context_deadline_exceeded");
  }
}

const trustedContextPayloadFields = new Set([
  "workspace_id",
  "actor_id",
  "actor_identity",
  "participant_id",
  "participant_kind",
  "requested_by_participant_id",
  "correlation_id",
  "source",
  "input_source",
  "session_id",
  "envelope_id",
  "run_id",
  "backend_run_id",
  "room_id",
  "source_room_id",
  "principal",
  "app_id",
  "connector_id",
  "delegated_by",
  "session_ref"
]);

// `session.create` is an explicit compatibility operation. Chat itself must
// receive an already-created App Session and may never create one implicitly.
const sessionCreatingCompatibilityOperationIds = new Set(["session.create"]);

function isPersistedSessionCompatibilityOperation(operationId: string): boolean {
  return isSessionCompatibleOperation(operationId) && !sessionCreatingCompatibilityOperationIds.has(operationId);
}

function assertNoTrustedContextPayloadFields(payload: Record<string, JsonValue>, allowed: readonly string[] = []): void {
  const allowedFields = new Set(allowed);
  const field = Object.keys(payload).find((key) => trustedContextPayloadFields.has(key) && !allowedFields.has(key));
  if (field) throw new RuntimeRequestError("bad_request", `untrusted_domain_context:${field}`);
}

function trustedContextPayloadFieldsForOperation(operationId: string): readonly string[] {
  if (operationId === runtimeOperationIds.externalAppConnectionCreate) return ["app_id", "connector_id"];
  if (operationId === runtimeOperationIds.clientEventSave) return ["room_id"];
  return [];
}

function trustedActorIdentityForSource(inputSource: DomainCommandInputSource): TrustedActorIdentity {
  switch (inputSource) {
    case "automation":
    case "scheduled_context":
      return "owner_scheduled";
    case "gateway_inbound":
      return "paired_contact";
    case "external_app":
      return "external_app";
    case "surface_operation":
    case "provider_tool_call":
    case "runtime_api":
    case "generated_surface":
      return "owner";
  }
}

function sameParticipant(left: ParticipantPrincipal, right: ParticipantPrincipal): boolean {
  if (left.kind !== right.kind || principalParticipantId(left) !== principalParticipantId(right)) return false;
  if (left.kind === "external_app" && right.kind === "external_app") {
    return left.appId === right.appId && left.connectorId === right.connectorId && sameParticipant(left.delegatedBy, right.delegatedBy);
  }
  if (left.kind !== "agent" || right.kind !== "agent") return true;
  return left.agentId === right.agentId && left.requestedByParticipantId === right.requestedByParticipantId;
}

/** Agent participant IDs are derived from their Agent record and never trusted twice. */
function principalParticipantId(participant: ParticipantPrincipal): string {
  return roomPrincipalParticipantId(participant);
}

function principalFromTrustedWorkspace(principal: Principal): ParticipantPrincipal {
  switch (principal.kind) {
    case "human":
      return { kind: "human", participantId: principal.participant_id };
    case "agent":
      return {
        kind: "agent",
        agentId: principal.agent_id,
        requestedByParticipantId: principal.requested_by_participant_id
      };
    case "external_app": {
      const delegatedBy = principalFromTrustedWorkspace(principal.delegated_by);
      if (delegatedBy.kind !== "human" && delegatedBy.kind !== "agent") {
        throw new RuntimeRequestError("forbidden", "external_app_delegation_invalid");
      }
      return {
        kind: "external_app",
        appId: principal.app_id,
        delegatedBy,
        ...(principal.connector_id ? { connectorId: principal.connector_id } : {})
      };
    }
    case "system":
      return { kind: "system", participantId: `system:${principal.system_id}` };
  }
}

/** A trusted transport may select a Principal only for its own app identity. */
function assertTrustedExternalAppContext(
  participant: ParticipantPrincipal,
  source: TrustedDomainRuntimeContext["source"],
  sessionRef: TrustedDomainRuntimeContext["sessionRef"]
): void {
  const externalSource = source?.kind === "external_app" ? source : undefined;
  if (participant.kind === "external_app") {
    if (!externalSource || !externalSource.app_id || externalSource.app_id !== participant.appId) {
      throw new RuntimeRequestError("forbidden", "external_app_context_mismatch");
    }
    if (participant.connectorId && externalSource.connector_id !== participant.connectorId) {
      throw new RuntimeRequestError("forbidden", "external_app_connector_mismatch");
    }
  } else if (externalSource) {
    throw new RuntimeRequestError("forbidden", "external_app_principal_required");
  }
  if (source?.app_id && sessionRef && source.app_id !== sessionRef.app_id) {
    throw new RuntimeRequestError("forbidden", "session_ref_app_mismatch");
  }
}

function trustedPrincipalFromParticipant(participant: ParticipantPrincipal): Principal {
  switch (participant.kind) {
    case "human":
      return { kind: "human", participant_id: participant.participantId };
    case "agent":
      return {
        kind: "agent",
        agent_id: participant.agentId,
        requested_by_participant_id: participant.requestedByParticipantId
      };
    case "external_app":
      return {
        kind: "external_app",
        app_id: participant.appId,
        delegated_by: trustedDelegatedPrincipalFromParticipant(participant.delegatedBy),
        ...(participant.connectorId ? { connector_id: participant.connectorId } : {})
      };
    case "system":
      return { kind: "system", system_id: participant.participantId };
  }
}

function trustedDelegatedPrincipalFromParticipant(
  participant: Extract<ParticipantPrincipal, { kind: "human" | "agent" }>
): Extract<Principal, { kind: "human" | "agent" }> {
  if (participant.kind === "human") {
    return { kind: "human", participant_id: participant.participantId };
  }
  return {
    kind: "agent",
    agent_id: participant.agentId,
    requested_by_participant_id: participant.requestedByParticipantId
  };
}

function requesterParticipantId(participant: ParticipantPrincipal): string {
  const delegated = delegatedParticipant(participant);
  return delegated.kind === "agent" ? delegated.requestedByParticipantId : delegated.participantId;
}

function canonicalRoomResourceKind(kind: string) {
  const canonical = kind === "knowledge_wiki" ? "wiki" : kind;
  return isRoomShareableResourceKind(canonical) ? canonical : undefined;
}

function requesterParticipantIdForGatewayContext(context: GatewayContext): string | undefined {
  return context.actor_identity === "owner" || context.actor_identity === "owner_scheduled"
    ? localOwnerParticipantId
    : undefined;
}

/** Domain Context is server-owned; an unbound system principal never becomes an Owner. */
function trustedRequesterParticipantId(context: TrustedDomainContext): string | undefined {
  const participant = context.participant;
  if (!participant || participant.kind === "system") return undefined;
  return requesterParticipantId(participant);
}

function isRoomPermissionMetadataKind(kind: string): boolean {
  return kind === "room" || kind === "agent" || kind === "workspace_member" || kind === "room_member"
    || kind === "room_agent" || kind === "agent_workspace_permission" || kind === "room_resource_share"
    || kind === "resource_access_boundary";
}

function instructionSourceForDomainInput(inputSource: DomainCommandInputSource): InstructionSource {
  if (inputSource === "provider_tool_call") return "agent_reasoning";
  if (inputSource === "external_app") return "external_content";
  if (inputSource === "gateway_inbound") return "paired_identity_message";
  if (inputSource === "automation" || inputSource === "scheduled_context") return "scheduled_context";
  if (inputSource === "generated_surface") return "owner_approved_policy";
  return "owner_instruction";
}

async function settleWithin(tasks: Iterable<Promise<unknown>>, timeoutMs: number): Promise<boolean> {
  const pending = Promise.allSettled(tasks).then(() => true);
  if (timeoutMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([pending, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeExternalSendDispatchError(error: unknown, fallback: string): string {
  const message = safeRuntimeErrorMessage(error, fallback);
  return [
    slackBotToken(),
    telegramBotToken(),
    lineChannelAccessToken(),
    envString("SAMURAI_EMAIL_SMTP_PASSWORD")
  ].filter((value): value is string => Boolean(value)).reduce(
    (current, secret) => current.split(secret).join("[redacted]"),
    message
  );
}

function isSettledBackendRun(run: BackendRunRecord): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "outcome_unknown";
}

function agentBackendContext(agent: AgentRecord): { id: string; name: string; role: string; instructions: string; authority: "supporting_context" } {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    authority: "supporting_context"
  };
}

function activityContextForReview(
  session: SessionRecord,
  backendRun?: BackendRunRecord
): ActivityContextRef | undefined {
  if (!session.room_id || !backendRun?.agent_id || backendRun.session_id !== session.id) return undefined;
  return {
    room_id: session.room_id,
    session_id: session.id,
    agent_id: backendRun.agent_id
  };
}

function usageScopeAllowsActivity(
  scope: UsageScopeRef | undefined,
  activityContext?: { room_id: string; session_id: string; agent_id: string }
): boolean {
  const resolved = scope ?? { kind: "workspace" as const };
  if (resolved.kind === "workspace") return true;
  if (!activityContext) return false;
  if (resolved.kind === "room") return resolved.room_id === activityContext.room_id;
  if (resolved.kind === "agent") return resolved.agent_id === activityContext.agent_id;
  return resolved.session_id === activityContext.session_id;
}

function sameUsageScope(left: UsageScopeRef, right: UsageScopeRef): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "workspace") return true;
  if (left.kind === "room" && right.kind === "room") return left.room_id === right.room_id;
  if (left.kind === "agent" && right.kind === "agent") return left.agent_id === right.agent_id;
  return left.kind === "session" && right.kind === "session" && left.session_id === right.session_id;
}

function skillBodyFromMarkdown(markdown: string): string {
  const closingFrontmatter = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (closingFrontmatter?.[1] ?? markdown).trim();
}

function learningResourceUseRecordId(input: {
  runId: string;
  resourceKind: string;
  resourceId: string;
  stage: string;
  contentHash: string;
}): string {
  return `learning_use_${stableHash({
    run_id: input.runId,
    resource_kind: input.resourceKind,
    resource_id: input.resourceId,
    stage: input.stage,
    content_hash: input.contentHash
  })}`;
}
