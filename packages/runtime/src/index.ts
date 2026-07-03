import { createArtifactDraft, type ArtifactKind, type ArtifactPayload } from "@samurai-agent/artifacts";
import { buildActivityInboxItems, createAuditRecord } from "@samurai-agent/audit";
import { getCapabilityManifest, proposalCapabilityManifest } from "@samurai-agent/capability-registry";
import {
  PluginRuntimeRegistry,
  getDomainCommandForProviderToolName,
  getDomainCommandForSurfaceOperationKind,
  requireDomainCommandEntry,
  type DomainCommandEntry,
  type DomainCommandInputSource,
  type DomainCommandOutputRenderKind
} from "@samurai-agent/action-catalog";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import path from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import {
  AgentBackendRegistry,
  ClaudeCodeBackend,
  CodexBackend,
  type AgentBackendStatus,
  type BackendOutputEvent,
  type BackendToolBridge,
  type BackendRunInput
} from "@samurai-agent/agent-backends";
import {
  type ActivityInboxItem,
  type AgentBackendKind,
  type ApprovalRequest,
  type ArtifactRecord,
  type AuditRecord,
  type AutomationJobRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type CollectionPatch,
  type CollectionRecord,
  type CollectionSchema,
  CollectionSchemaSchema,
  ContextFreezeResponseSchema,
  type ActorIdentity,
  CuratorLifecycleReportSchema,
  CuratorReviewReportSchema,
  EvaluationTraceReportSchema,
  type CuratorStateRecord,
  type ExternalAssistHint,
  type ExternalAssistRecord,
  type ExternalSendChannel,
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
  type GatewayChannel,
  type HostContextAssembly,
  type ContextHandoff,
  type InstructionSource,
  type JsonValue,
  type MemoryFrontmatter,
  type MessageEnvelope,
  type MessageRecord,
  type OperationRecord,
  type ExternalSendRecord,
  type GatewayInboundMessageRecord,
  type GatewayPairingPolicyRecord,
  type GatewayPairingRecord,
  type GatewayRoutingPolicyRecord,
  type PolicyDecisionRecord,
  type PolicyEvaluationInput,
  ProvenanceSchema,
  type ContextFreezeResponse,
  type ContextPreview,
  type KnowledgeWikiGraph,
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
  type SkillState,
  type SurfaceRendererRegistryEntry,
  type WikiFrontmatter,
  type WorkspaceChangeRecord,
  type ToolRunRecord,
  SkillFrontmatterSchema,
  GatewayRepairResultSchema,
  GatewaySandboxWorkspaceSyncResultSchema,
  externalSendChannels,
  gatewayChannels,
  type SkillFrontmatter,
  type SupportedLocale,
  createId,
  nowIso,
  stableHash
} from "@samurai-agent/core-schemas";
import {
  createDefaultGatewayBoundaryPolicy,
  createGatewayEnvelope,
  createSandboxCommandAdapter,
  createSandboxLifecycleAdapter,
  createSandboxWorkspaceSyncAdapter,
  createDefaultGatewayPairingPolicy,
  createDefaultGatewayRoutingPolicy,
  createHttpMcpToolAdapter,
  createPooledStdioMcpToolAdapter,
  cronMemoryReviewGatewayContext,
  executeSandboxCommand,
  executeSandboxLifecycleAction,
  executeSandboxWorkspaceSync,
  executeMcpToolInvocation,
  evaluateGatewayPairingPolicy,
  expirePairing,
  gatewayContextForPairing,
  gatewayMcpConfigToBoundaryRef,
  httpMcpServerConfigFromGatewayConfig,
  revokePairing,
  rotatePairingCode,
  resolveGatewaySessionRouting,
  sessionKeyForExternalSource,
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
import { createSessionMemory, createTopicMemory, loadFreezeSnapshot, retrieveActiveMemoryWithReport, type MemoryCandidate } from "@samurai-agent/memory";
import { evaluatePolicy } from "@samurai-agent/policy-engine";
import { builtinSurfaceRendererRegistryEntries, createSurfaceRenderSpec, negotiateSurfaceRenderSpec, type RuntimeEventSink, type SurfaceOperation, type SurfaceOperationDispatchPlan, type SurfaceOperationResultEnvelope, type SurfaceOperationResultKind, type SurfaceRenderKind, type SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import type {
  ArchiveMemoryResult,
  AutomationRunRecord,
  CollectionRecordResolution,
  CollectionTriggerEffect,
  CollectionReindexResult,
  CollectionRecordWithFilePath,
  CollectionSchemaWithFilePath,
  SkillSupportFile,
  SkillWithFilePath,
  WikiReindexResult,
  WikiWithFilePath,
  WorkspaceStore
} from "@samurai-agent/workspace-store";
import { handleBackendToolCall, type BackendToolBoundaryFeedback } from "./backend-feedback";
import { BackendEventBridge, normalizeBackendOutputEvent } from "./backend-event-bridge";
import { SamuraiNativeBackend } from "./native-backend";
export {
  HttpExternalAssistProvider,
  LocalFileExternalAssistProvider,
  createExternalAssistProviderFromEnv,
  createExternalAssistProvidersFromEnv,
  describeExternalAssistProviderConfig,
  type HttpExternalAssistProviderOptions,
  type LocalFileExternalAssistProviderOptions
} from "./external-assist-provider";
export type { ExternalAssistProviderConfigDiagnostics } from "@samurai-agent/core-schemas";
export {
  NativeContextBuilder,
  NativePromptBuilder,
  NativeToolExecutor,
  NativeToolLoop,
  SamuraiNativeBackend,
  type SamuraiNativeBackendComponents
} from "./native-backend";
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
} from "./provider";
import { ProviderRequestError, type ProviderAdapter, type ProviderDiagnostics, type ProviderInput, type ProviderOutput, type ProviderToolCall } from "./provider";
export type { GatewayContext } from "@samurai-agent/gateway";

export interface RunChatTurnInput {
  sessionId: string;
  content: string;
  backend_id?: string;
  input_locale?: SupportedLocale;
  output_locale?: SupportedLocale;
  metadata?: Record<string, unknown>;
  gateway_context?: GatewayContext;
  gateway_boundary_policy?: GatewayBoundaryPolicy;
}

export interface RunChatTurnResult {
  session: SessionRecord;
  messages: MessageRecord[];
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

interface RuntimeToolCallResult {
  operation: OperationRecord;
  toolRun: ToolRunRecord;
  outputPayload?: Record<string, JsonValue>;
  resourceRefs?: ResourceRef[];
  artifacts?: ArtifactRecord[];
  memories?: MemoryFrontmatter[];
  workspaceChanges?: WorkspaceChangeRecord[];
  events?: BackendOutputEvent[];
}

interface BackendToolEventHandlingResult {
  operations: OperationRecord[];
  artifacts: ArtifactRecord[];
  memories: MemoryFrontmatter[];
  toolRuns: ToolRunRecord[];
  workspaceChanges: WorkspaceChangeRecord[];
}

type BackendEventRecorder = (event: BackendOutputEvent) => Promise<BackendEventRecord>;

export type ApprovalLifecycleStatus = "approved" | "denied" | "expired";

export interface ApprovalLifecycleResult {
  approvalRequest: ApprovalRequest;
  operation: OperationRecord;
  auditRecord: AuditRecord;
  activity: ActivityInboxItem[];
  status: ApprovalLifecycleStatus;
}

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
  auditRecord: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
  changed: boolean;
  warning?: string;
}

export interface RuntimeWriteResult<TResource> {
  resource: TResource;
  operation: OperationRecord;
  policyDecision: PolicyDecisionRecord;
  auditRecord: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

export type SkillRuntimeResult = RuntimeWriteResult<SkillWithFilePath>;
export type SkillSupportRuntimeResult = RuntimeWriteResult<SkillSupportFile>;
export type WikiRuntimeResult = RuntimeWriteResult<WikiWithFilePath>;
export type CollectionSchemaRuntimeResult = RuntimeWriteResult<CollectionSchemaWithFilePath>;
export type CollectionRecordRuntimeResult = RuntimeWriteResult<CollectionRecordWithFilePath>;
export type CollectionDeleteRuntimeResult = RuntimeWriteResult<CollectionRecordWithFilePath>;
export type CollectionReindexRuntimeResult = RuntimeWriteResult<CollectionReindexResult>;
export type GrantRuntimeResult = RuntimeWriteResult<GrantRecord>;
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
export type CollectionActionRuntimeResult = CollectionRecordRuntimeResult | CollectionPatchRuntimeResult | CollectionReindexRuntimeResult | CollectionPluginActionRuntimeResult;
export type AutomationJobRuntimeResult = RuntimeWriteResult<AutomationJobRecord>;
export type ExternalSendRuntimeResult = RuntimeWriteResult<ExternalSendRecord>;

export interface AutomationSchedulePreview {
  schedule: string;
  normalized: string;
  from: string;
  one_shot: boolean;
  next_run_at: string;
}

export interface ResourceTranslationJobRuntimeDetails {
  translation: ResourceTranslationRecord;
  backendRunId: string;
  source_ref: ResourceRef;
  source_locale: SupportedLocale;
  target_locale: SupportedLocale;
  original_hash: string;
}

export interface GatewayInboundRuntimeResult {
  inbound: GatewayInboundMessageRecord;
  pairing?: GatewayPairingRecord;
  boundaryPolicy?: GatewayBoundaryPolicy;
  concurrencyLock?: GatewayConcurrencyLockRecord;
  session?: SessionRecord;
  chat?: RunChatTurnResult;
}

export interface FileActionRuntimeResult extends RuntimeWriteResult<{
  path: string;
  content?: string;
  entries?: Array<{ path: string; kind: "file" | "directory"; size?: number }>;
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
  screenshot_ref?: string;
  file_path?: string;
}> {}

type StructuredSurfaceOperation = Extract<SurfaceOperation, {
  kind: "form.submit" | "table.patch" | "chart.request" | "artifact.request" | "custom_view.action";
}>;

export interface SurfaceArtifactRuntimeResult extends RuntimeWriteResult<ArtifactRecord> {
  sourceArtifact?: ArtifactRecord;
  workspaceChange: WorkspaceChangeRecord;
}

export type SurfaceOperationRuntimeResult = SurfaceOperationResultEnvelope<
  RunChatTurnResult | CollectionViewRuntimeResult | CollectionRecordRuntimeResult | CollectionPatchRuntimeResult | CollectionDeleteRuntimeResult | SurfaceArtifactRuntimeResult
>;

export interface CollectionViewRuntimeResult {
  collection_id: string;
  view_id: string;
  schema: CollectionSchemaWithFilePath;
  record_count: number;
}

export interface DomainCommandRuntimeInput {
  command_id: string;
  payload?: Record<string, unknown>;
  input_source?: DomainCommandInputSource;
}

export interface DomainCommandRuntimeResult<TResult = unknown> {
  command: DomainCommandEntry;
  input_source: DomainCommandInputSource;
  payload: Record<string, JsonValue>;
  render_spec?: SurfaceRenderSpec;
  render_specs: SurfaceRenderSpec[];
  result: TResult;
}

type FileActionResource = FileActionRuntimeResult["resource"];
type BrowserActionResource = BrowserActionRuntimeResult["resource"];

export interface CollectionPatchRuntimeResult extends RuntimeWriteResult<CollectionRecordWithFilePath> {
  before: CollectionRecordWithFilePath;
}

export interface AutomationRunRuntimeResult {
  automationRun: AutomationRunRecord;
  operation: OperationRecord;
  policyDecision: PolicyDecisionRecord;
  auditRecord: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
  memoryReviewTrace?: ReflectionRuntimeResult;
  curatorResult?: ReflectionRuntimeResult;
}

export interface ReflectionRuntimeResult {
  reflectionRun: ReflectionRunRecord;
  suggestions: ReflectionSuggestionRecord[];
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

export interface EvaluationJudgeResult {
  summary: string;
  scoreAdjustments?: Array<{ run_id: string; score_delta: number; reason: string }>;
}

export interface EvaluationJudgeProvider {
  readonly id: string;
  judge(input: { report: EvaluationTraceReport }): Promise<EvaluationJudgeResult>;
}

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "forbidden" | "provider_not_configured" | "provider_failed" | "backend_cancelled",
    message: string,
    readonly payload?: ApprovalLifecycleResult | ArchiveMemoryRuntimeResult | BackendRunErrorPayload,
    readonly diagnostics?: ProviderDiagnostics
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

interface OperationPlan {
  operation: string;
  proposedEffects: string[];
  toolCall?: ProviderToolCall;
  artifact?: {
    title: string;
    content: string;
    preview?: string;
  };
}

interface AgentRuntimeWorkspaceOptions {
  backendWorkingDirectoryMode?: "workspace" | "repo";
  repoRoot?: string;
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
      streamProbeArgs: splitProbeArgs(env.SAMURAI_CLAUDE_CODE_STREAM_PROBE_ARGS),
      streamProbeTimeoutMs: parseTimeout(env.SAMURAI_CLAUDE_CODE_STREAM_PROBE_TIMEOUT_MS),
      resumeArgs: splitOptionalArgs(env.SAMURAI_CLAUDE_CODE_RESUME_ARGS)
    }),
    new CodexBackend({
      command: env.SAMURAI_CODEX_COMMAND,
      args: splitOptionalArgs(env.SAMURAI_CODEX_ARGS),
      artifactMcpScript,
      streamProbeArgs: splitProbeArgs(env.SAMURAI_CODEX_STREAM_PROBE_ARGS),
      streamProbeTimeoutMs: parseTimeout(env.SAMURAI_CODEX_STREAM_PROBE_TIMEOUT_MS),
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

function splitArgs(value: string | undefined): string[] {
  return value?.split(" ").map((item) => item.trim()).filter(Boolean) ?? [];
}

function splitProbeArgs(value: string | undefined): string[] | undefined {
  const args = splitArgs(value);
  return args.length > 0 ? args : undefined;
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

function commandRenderKind(command: DomainCommandEntry, renderKind: SurfaceRenderKind): SurfaceRenderKind {
  if (!command.output_render_kinds.includes(renderKind as DomainCommandOutputRenderKind)) {
    throw new Error(`Domain command ${command.id} does not declare render kind: ${renderKind}`);
  }
  return renderKind;
}

export function planSurfaceOperationDispatch(operation: SurfaceOperation): SurfaceOperationDispatchPlan {
  if (operation.kind === "message.submit") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("chat.turn.run");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "host_chat",
      runtimeMethod: command.runtime_method,
      operationName: command.id,
      resultKind: "chat_turn",
      renderKind: commandRenderKind(command, "chat"),
      requiresSession: true,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  if (operation.kind === "collection.record.create") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("collection.record.create");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "collection_engine",
      runtimeMethod: command.runtime_method,
      operationName: command.id,
      resultKind: "collection_record",
      renderKind: commandRenderKind(command, "collection_record"),
      requiresSession: false,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  if (operation.kind === "collection.view.present") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("collection.view.present");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "collection_engine",
      runtimeMethod: command.runtime_method,
      operationName: command.id,
      resultKind: "collection_view",
      renderKind: commandRenderKind(command, "custom_view"),
      requiresSession: false,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  if (operation.kind === "collection.record.patch") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("collection.patch.apply");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "collection_engine",
      runtimeMethod: command.runtime_method,
      operationName: command.id,
      resultKind: "collection_patch",
      renderKind: commandRenderKind(command, "collection_record"),
      requiresSession: false,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  if (operation.kind === "collection.record.delete") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("collection.record.delete");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "collection_engine",
      runtimeMethod: command.runtime_method,
      operationName: command.id,
      resultKind: "collection_delete",
      renderKind: commandRenderKind(command, "custom_view"),
      requiresSession: false,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  const structuredOperation = operation as StructuredSurfaceOperation;
  const command = getDomainCommandForSurfaceOperationKind(structuredOperation.kind) ?? requireDomainCommandEntry("artifact.create");
  return surfaceDispatchPlan(structuredOperation, {
    dispatchTarget: "artifact_pipeline",
    runtimeMethod: command.runtime_method,
    operationName: command.id,
    resultKind: surfaceOperationResultKind(structuredOperation),
    renderKind: commandRenderKind(command, surfaceOperationRenderKind(structuredOperation)),
    requiresSession: true,
    writesWorkspace: command.writes_workspace,
    outputResourceKind: surfaceOperationArtifactKind(structuredOperation),
    proposedEffects: [surfaceOperationEffect(structuredOperation)]
  });
}

export class AgentRuntime {
  private readonly backendRegistry: AgentBackendRegistry;
  private readonly stdioMcpProcessPool: PooledMcpToolAdapter;
  private readonly pluginRegistry: PluginRuntimeRegistry;
  private readonly externalAssistProviders: ExternalAssistProvider[];
  private readonly backendToolBridgeTokens = new Map<string, string>();
  private readonly backendEventSequences = new Map<string, number>();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly emit: RuntimeEventSink = () => undefined,
    private readonly provider?: ProviderAdapter,
    backendRegistry?: AgentBackendRegistry,
    pluginRegistry?: PluginRuntimeRegistry,
    externalAssistProvider?: ExternalAssistProvider | ExternalAssistProvider[],
    private readonly evaluationJudgeProvider?: EvaluationJudgeProvider,
    private readonly workspaceOptions: AgentRuntimeWorkspaceOptions = {}
  ) {
    this.backendRegistry = backendRegistry ?? createDefaultAgentBackendRegistry(provider);
    this.pluginRegistry = pluginRegistry ?? new PluginRuntimeRegistry();
    this.externalAssistProviders = normalizeExternalAssistProviders(externalAssistProvider);
    this.stdioMcpProcessPool = createPooledStdioMcpToolAdapter({
      resolveConfig: async (input) => {
        const config = await this.store.getGatewayMcpConfigByServerName(input.server_name);
        return config ? stdioMcpServerConfigFromGatewayConfig(config) : undefined;
      }
    });
  }

  async shutdownMcpProcessPool(): Promise<void> {
    await this.stdioMcpProcessPool.closeAll();
  }

  getMcpProcessPoolStats(): ReturnType<PooledMcpToolAdapter["stats"]> {
    return this.stdioMcpProcessPool.stats();
  }

  async listAgentBackends(): Promise<AgentBackendStatus[]> {
    const [statuses, runs] = await Promise.all([
      Promise.resolve(this.backendRegistry.statuses()),
      this.store.listBackendRuns()
    ]);
    return statuses.map((status) => backendStatusWithRunHistory(status, runs));
  }

  private backendWorkingDirectoryMode(): "workspace" | "repo" {
    return this.workspaceOptions.backendWorkingDirectoryMode ?? "workspace";
  }

  private backendWorkingDirectory(): string {
    return this.backendWorkingDirectoryMode() === "repo"
      ? path.resolve(this.workspaceOptions.repoRoot ?? process.cwd())
      : this.store.rootDir;
  }

  async previewContext(input: { sessionId: string; query?: string }): Promise<ContextPreview> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) {
      throw new RuntimeRequestError("not_found", `Session not found: ${input.sessionId}`);
    }
    return this.buildContextPreview(session.id, input.query ?? "");
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

  async previewActiveMemory(input: { query?: string }): Promise<{
    active_memory: ContextPreview["active_memory"];
    report: ContextPreview["active_memory_report"];
  }> {
    const result = await retrieveActiveMemoryWithReport(this.store, input.query ?? "");
    return {
      active_memory: result.candidates.map(activeMemoryPreviewEntry),
      report: result.report
    };
  }

  async previewKnowledgeWiki(input: { query?: string }): Promise<{
    knowledge_wiki: ContextPreview["knowledge_wiki"];
    report: ContextPreview["knowledge_wiki_report"];
    graph: KnowledgeWikiGraph;
  }> {
    const context = await this.buildKnowledgeWikiContext(input.query ?? "");
    return {
      knowledge_wiki: context.entries,
      report: context.report,
      graph: knowledgeWikiGraph(context.pages, true)
    };
  }

  async previewKnowledgeWikiGraph(input: { activeOnly?: boolean } = {}): Promise<KnowledgeWikiGraph> {
    const pages = await this.store.listWiki({ activeOnly: input.activeOnly ?? true });
    return knowledgeWikiGraph(pages, input.activeOnly ?? true);
  }

  async runReflection(input: { sessionId: string; sourceRunId?: string }): Promise<ReflectionRuntimeResult> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) {
      throw new RuntimeRequestError("not_found", `Session not found: ${input.sessionId}`);
    }
    const messages = await this.store.listMessages(session.id);
    const userMessage = [...messages].reverse().find((message) => message.role === "user");
    const agentMessage = [...messages].reverse().find((message) => message.role === "agent");
    const toolRuns = await this.store.listToolRuns(input.sourceRunId ? { runId: input.sourceRunId } : {});
    const workspaceChanges = await this.store.listWorkspaceChanges(session.id);
    return this.runReflectionForCompletedTurn({
      kind: "manual",
      session,
      sourceRunId: input.sourceRunId,
      userMessage,
      agentMessage,
      backendEvents: await this.store.listBackendEvents(input.sourceRunId ? { runId: input.sourceRunId } : { sessionId: session.id }),
      workspaceChanges,
      toolRuns,
      transcriptMessages: messages,
      artifacts: await this.loadReflectionArtifacts({
        sessionId: session.id,
        sourceRunId: input.sourceRunId,
        workspaceChanges
      })
    });
  }

  async runCuratorJob(input: { respectIdleGate?: boolean } = {}): Promise<ReflectionRuntimeResult> {
    const session = await this.ensureSessionForContext(cronMemoryReviewGatewayContext, "Scheduled curator");
    const [curatorState, memories, skills, skillUsage, wikiPages, backendRuns] = await Promise.all([
      this.store.getCuratorState(),
      this.store.listMemory(),
      this.store.listSkills(),
      this.store.listSkillUsage(),
      this.store.listWiki({ activeOnly: false }),
      this.store.listBackendRuns()
    ]);
    const now = nowIso();
    const nowMs = Date.parse(now);
    const staleCutoffMs = nowMs - curatorState.stale_after_days * 24 * 60 * 60 * 1000;
    const archiveCutoffMs = nowMs - curatorState.archive_after_days * 24 * 60 * 60 * 1000;
    const usageBySkill = new Map(skillUsage.map((usage) => [usage.skill_id, usage]));
    let reflectionRun: ReflectionRunRecord = {
      id: createId("reflection"),
      kind: "curator",
      session_id: session.id,
      status: "started",
      input_summary: `Curate ${memories.length} memory item(s), ${skills.length} skill item(s), ${skillUsage.length} skill usage row(s), and ${wikiPages.length} wiki page(s).`,
      started_at: now
    };
    reflectionRun = await this.store.createReflectionRun(reflectionRun);
    const suggestions: ReflectionSuggestionRecord[] = [];
    const skillActions: CuratorLifecycleReport["skill_actions"] = [];
    const protectedSkills: CuratorLifecycleReport["protected_skills"] = [];
    const keepCandidates: CuratorReviewReport["keep_candidates"] = [];
    const memoryMergeGroups: CuratorReviewReport["memory_merge_groups"] = [];
    const skillConsolidationGroups: CuratorReviewReport["skill_consolidation_groups"] = [];
    const wikiPatchProposals: CuratorReviewReport["wiki_patch_proposals"] = [];
    const archiveCandidates: CuratorReviewReport["archive_candidates"] = [];
    const latestActivityMs = latestBackendRunActivityMs(backendRuns);
    const minIdleMs = curatorState.min_idle_hours * 60 * 60 * 1000;
    if (input.respectIdleGate && minIdleMs > 0 && latestActivityMs && nowMs - latestActivityMs < minIdleMs) {
      const idleSummary = `Curator skipped because workspace activity is newer than ${curatorState.min_idle_hours} idle hour(s).`;
      reflectionRun = await this.store.updateReflectionRun({
        ...reflectionRun,
        status: "completed",
        output_summary: idleSummary,
        completed_at: nowIso()
      });
      await this.store.saveCuratorState({
        last_run_at: now,
        last_run_summary: idleSummary,
        run_count: curatorState.run_count + 1
      });
      return {
        reflectionRun,
        suggestions,
        curatorReport: buildCuratorLifecycleReport({
          now,
          dryRun: true,
          paused: curatorState.paused,
          skippedReason: idleSummary,
          curatorState,
          memories,
          wikiPages,
          skills,
          skillUsage,
          suggestions,
          skillActions,
          protectedSkills
        }),
        curatorReviewReport: buildCuratorReviewReport({
          now,
          dryRun: true,
          keepCandidates,
          memoryMergeGroups,
          skillConsolidationGroups,
          wikiPatchProposals,
          archiveCandidates
        })
      };
    }
    if (curatorState.paused) {
      reflectionRun = await this.store.updateReflectionRun({
        ...reflectionRun,
        status: "completed",
        output_summary: "Curator is paused.",
        completed_at: nowIso()
      });
      await this.store.saveCuratorState({
        last_run_at: now,
        last_run_summary: "Curator is paused.",
        run_count: curatorState.run_count + 1
      });
      return {
        reflectionRun,
        suggestions,
        curatorReport: buildCuratorLifecycleReport({
          now,
          dryRun: true,
          paused: true,
          skippedReason: "Curator is paused.",
          curatorState,
          memories,
          wikiPages,
          skills,
          skillUsage,
          suggestions,
          skillActions,
          protectedSkills
        }),
        curatorReviewReport: buildCuratorReviewReport({
          now,
          dryRun: true,
          keepCandidates,
          memoryMergeGroups,
          skillConsolidationGroups,
          wikiPatchProposals,
          archiveCandidates
        })
      };
    }
    const memoryByTopic = new Map<string, typeof memories>();
    for (const memory of memories.filter((item) => item.state !== "archived")) {
      const key = memory.topic.trim().toLowerCase();
      memoryByTopic.set(key, [...(memoryByTopic.get(key) ?? []), memory]);
      if (memory.confidence < 0.5 || memory.state === "topic") {
        suggestions.push({
          id: createId("suggestion"),
          reflection_run_id: reflectionRun.id,
          suggestion_type: "memory_patch",
          status: "proposed",
          title: `Review memory: ${memory.topic}`,
          content: `Review whether this memory should be promoted, merged, or archived.\n\n${(await this.store.readMemoryContent(memory.id)) ?? ""}`,
          target_ref: memoryRef(memory),
          source_refs: [memoryRef(memory)],
          confidence: 0.62,
          created_at: now,
          updated_at: now
        });
      }
    }
    for (const relatedMemories of memoryByTopic.values()) {
      if (relatedMemories.length < 2) {
        continue;
      }
      const suggestionId = createId("suggestion");
      memoryMergeGroups.push({
        topic: relatedMemories[0]!.topic,
        memory_ids: relatedMemories.map((memory) => memory.id),
        reason: "Multiple active Memory entries share the same normalized topic.",
        suggestion_id: suggestionId
      });
      suggestions.push({
        id: suggestionId,
        reflection_run_id: reflectionRun.id,
        suggestion_type: "conflict",
        status: "proposed",
        title: `Merge or resolve memory topic: ${relatedMemories[0]!.topic}`,
        content: `Multiple Memory entries share this topic. Review whether they should be merged, promoted, or archived.\n\n${relatedMemories.map((memory) => `- ${memory.id}: ${memory.state} / confidence ${memory.confidence}`).join("\n")}`,
        source_refs: relatedMemories.map(memoryRef),
        confidence: 0.68,
        created_at: now,
        updated_at: now
      });
    }
    for (const wiki of wikiPages.filter((item) => item.state === "proposed" || (item.state === "active" && !item.provenance.verified)).slice(0, 20)) {
      const suggestionId = createId("suggestion");
      wikiPatchProposals.push({
        wiki_id: wiki.id,
        title: wiki.title,
        reason: wiki.state === "proposed" ? "Proposed page needs accept/reject review." : "Active page is not verified.",
        suggestion_id: suggestionId
      });
      suggestions.push({
        id: suggestionId,
        reflection_run_id: reflectionRun.id,
        suggestion_type: "knowledge_wiki",
        status: "proposed",
        title: `Review Knowledge Wiki: ${wiki.title}`,
        content: `Review this Knowledge Wiki page for acceptance, verification, or archival.\n\nState: ${wiki.state}\nVerified: ${wiki.provenance.verified ? "yes" : "no"}\n\n${(await this.store.readWikiContent(wiki.id)) ?? ""}`,
        target_ref: wikiRef(wiki),
        source_refs: [wikiRef(wiki)],
        confidence: wiki.state === "proposed" ? 0.64 : 0.7,
        created_at: now,
        updated_at: now
      });
    }
    for (const skill of skills.filter((item) => item.state !== "archived").slice(0, 50)) {
      const usage = usageBySkill.get(skill.id);
      const lastActivityAt = usage?.last_used_at ?? skill.frontmatter.last_reviewed_at;
      const lastActivityMs = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN;
      const inactiveSince = Number.isFinite(lastActivityMs) ? (lastActivityAt ?? "unknown") : "never";
      const pinned = skill.state === "pinned" || skill.frontmatter.owner_pinned;
      let curatorAction: "review" | "mark_stale" | "archive" | "reactivate" | undefined;
      if (pinned) {
        protectedSkills.push({
          skill_id: skill.id,
          title: skill.title,
          state: skill.state,
          reason: "owner_pinned"
        });
        keepCandidates.push({
          kind: "skill",
          id: skill.id,
          title: skill.title,
          reason: "Owner pinned Skill is protected from curator lifecycle changes."
        });
        continue;
      }
      if (usage?.last_used_at && Date.parse(usage.last_used_at) > staleCutoffMs && skill.state === "stale") {
        curatorAction = "reactivate";
      } else if (!Number.isFinite(lastActivityMs) || lastActivityMs <= archiveCutoffMs) {
        curatorAction = "archive";
      } else if (lastActivityMs <= staleCutoffMs && (skill.state === "active" || skill.state === "project" || skill.state === "candidate")) {
        curatorAction = "mark_stale";
      } else if (skill.state === "candidate" || skill.state === "project") {
        curatorAction = "review";
      }
      if (!curatorAction) {
        if (usage?.last_used_at && Date.parse(usage.last_used_at) > staleCutoffMs) {
          keepCandidates.push({
            kind: "skill",
            id: skill.id,
            title: skill.title,
            reason: "Recent usage keeps this Skill in normal selection."
          });
        }
        continue;
      }
      const suggestionId = createId("suggestion");
      const proposedState = proposedSkillStateForCuratorAction(curatorAction);
      const actionReason = curatorActionReason({
        action: curatorAction,
        usageCount: usage?.use_count ?? 0,
        inactiveSince,
        staleAfterDays: curatorState.stale_after_days,
        archiveAfterDays: curatorState.archive_after_days
      });
      skillActions.push({
        skill_id: skill.id,
        title: skill.title,
        current_state: skill.state,
        ...(proposedState ? { proposed_state: proposedState } : {}),
        action: curatorAction,
        reason: actionReason,
        usage_count: usage?.use_count ?? 0,
        ...(Number.isFinite(lastActivityMs) && lastActivityAt ? { last_activity_at: lastActivityAt } : {}),
        owner_pinned: false,
        suggestion_id: suggestionId
      });
      if (curatorAction === "archive") {
        archiveCandidates.push({
          kind: "skill",
          id: skill.id,
          title: skill.title,
          reason: actionReason,
          suggestion_id: suggestionId
        });
      }
      suggestions.push({
        id: suggestionId,
        reflection_run_id: reflectionRun.id,
        suggestion_type: "skill_patch",
        status: "proposed",
        title: `Review skill: ${skill.title}`,
        content: [
          `Curator action: ${curatorAction}`,
          proposedState ? `Proposed state: ${proposedState}` : "Proposed state: review_only",
          `Reason: ${actionReason}`,
          "",
          `Skill: ${skill.id}`,
          `State: ${skill.state}`,
          `Usage count: ${usage?.use_count ?? 0}`,
          `Last activity: ${inactiveSince}`,
          `Stale threshold days: ${curatorState.stale_after_days}`,
          `Archive threshold days: ${curatorState.archive_after_days}`,
          "",
          "This is a human-visible proposal. Do not delete or move the Skill automatically.",
          "",
          (await this.store.readSkillMarkdown(skill.id)) ?? ""
        ].join("\n"),
        target_ref: skillRef(skill),
        source_refs: [skillRef(skill)],
        confidence: curatorAction === "archive" ? 0.72 : curatorAction === "mark_stale" ? 0.66 : 0.58,
        created_at: now,
        updated_at: now
      });
    }
    for (const group of buildSkillConsolidationGroups(skills)) {
      const suggestionId = createId("suggestion");
      skillConsolidationGroups.push({
        group_key: group.groupKey,
        skill_ids: group.skills.map((skill) => skill.id),
        suggested_umbrella_title: group.suggestedTitle,
        reason: group.reason,
        suggestion_id: suggestionId
      });
      suggestions.push({
        id: suggestionId,
        reflection_run_id: reflectionRun.id,
        suggestion_type: "skill_patch",
        status: "proposed",
        title: `Consolidate skills: ${group.suggestedTitle}`,
        content: [
          "Curator review action: consolidate",
          `Group key: ${group.groupKey}`,
          `Suggested umbrella title: ${group.suggestedTitle}`,
          `Reason: ${group.reason}`,
          "",
          "Candidate Skills:",
          ...group.skills.map((skill) => `- ${skill.id}: ${skill.title} (${skill.state})`),
          "",
          "This is a human-visible proposal. Do not merge or archive automatically."
        ].join("\n"),
        source_refs: group.skills.map(skillRef),
        confidence: 0.68,
        created_at: now,
        updated_at: now
      });
    }
    for (const suggestion of suggestions) {
      await this.store.saveReflectionSuggestion(suggestion);
    }
    reflectionRun = await this.store.updateReflectionRun({
      ...reflectionRun,
      status: "completed",
      output_summary: `Curator created ${suggestions.length} suggestion(s).`,
      completed_at: nowIso()
    });
    await this.store.saveCuratorState({
      last_run_at: now,
      last_run_summary: reflectionRun.output_summary,
      run_count: curatorState.run_count + 1
    });
    return {
      reflectionRun,
      suggestions,
      curatorReport: buildCuratorLifecycleReport({
        now,
        dryRun: true,
        paused: false,
        curatorState,
        memories,
        wikiPages,
        skills,
        skillUsage,
        suggestions,
        skillActions,
        protectedSkills
      }),
      curatorReviewReport: buildCuratorReviewReport({
        now,
        dryRun: true,
        keepCandidates,
        memoryMergeGroups,
        skillConsolidationGroups,
        wikiPatchProposals,
        archiveCandidates
      })
    };
  }

  async applyCuratorSkillAction(input: { skillId: string; action: Exclude<CuratorLifecycleAction, "review"> }): Promise<SkillRuntimeResult> {
    const targetState = proposedSkillStateForCuratorAction(input.action);
    if (!targetState) {
      throw new RuntimeRequestError("conflict", "curator_review_has_no_state_transition");
    }
    const current = await this.store.getSkill(input.skillId);
    if (!current) {
      throw new RuntimeRequestError("not_found", `Skill not found: ${input.skillId}`);
    }
    if (current.state === "pinned" || current.frontmatter.owner_pinned) {
      throw new RuntimeRequestError("conflict", "curator_skill_is_pinned");
    }
    const beforeMarkdown = await this.store.readSkillMarkdown(input.skillId);
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Apply curator skill lifecycle: ${input.action} ${current.title}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "skill.lifecycle.apply",
      proposedEffects: [`Set Skill ${current.title} state to ${targetState}.`],
      targetResourceRefs: [skillRef(current)],
      execute: async (operation) => {
        const saved = await this.store.updateSkillState(input.skillId, targetState);
        if (!saved) {
          throw new RuntimeRequestError("not_found", `Skill not found: ${input.skillId}`);
        }
        const ref = skillRef(saved);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { skill: current as unknown as JsonValue, markdown: beforeMarkdown ?? "" },
          { skill: saved as unknown as JsonValue, action: input.action, target_state: targetState }
        );
        return {
          resource: saved,
          ref,
          rollbackPoint,
          summary: `Applied curator lifecycle ${input.action} to Skill ${saved.title}.`
        };
      }
    });
  }

  async runEvaluationJob(): Promise<ReflectionRuntimeResult> {
    const session = await this.ensureSessionForContext(cronMemoryReviewGatewayContext, "Scheduled evaluation");
    const [skills, backendRuns, backendEvents, workspaceChanges, toolRuns, auditRecords] = await Promise.all([
      this.store.listSkills(),
      this.store.listBackendRuns(),
      this.store.listBackendEvents(),
      this.store.listWorkspaceChanges(),
      this.store.listToolRuns(),
      this.store.listAuditRecords()
    ]);
    const now = nowIso();
    let reflectionRun: ReflectionRunRecord = {
      id: createId("reflection"),
      kind: "evaluation",
      session_id: session.id,
      status: "started",
      input_summary: `Evaluate ${backendRuns.length} backend run(s), ${backendEvents.length} backend event(s), ${workspaceChanges.length} workspace change(s), ${toolRuns.length} tool run(s), ${auditRecords.length} audit record(s), and ${skills.length} skill item(s).`,
      started_at: now
    };
    reflectionRun = await this.store.createReflectionRun(reflectionRun);
    const suggestions = this.createEvaluationTraceSuggestions(reflectionRun, {
      skills,
      backendRuns,
      backendEvents,
      workspaceChanges,
      toolRuns,
      auditRecords,
      now
    });
    const evaluationReport = await this.createEvaluationTraceReport({
      backendRuns,
      backendEvents,
      workspaceChanges,
      toolRuns,
      auditRecords,
      now
    });
    if (!suggestions.length && skills.length) {
      suggestions.push({
        id: createId("suggestion"),
        reflection_run_id: reflectionRun.id,
        suggestion_type: "skill_patch",
        status: "proposed",
        title: "Skill evaluation checkpoint",
        content: `No trace anomalies were found. Review ${skills.length} skill item(s) for freshness, coverage, and repeated manual work patterns.`,
        source_refs: [],
        confidence: 0.52,
        created_at: now,
        updated_at: now
      });
    }
    for (const suggestion of suggestions) {
      await this.store.saveReflectionSuggestion(suggestion);
    }
    reflectionRun = await this.store.updateReflectionRun({
      ...reflectionRun,
      status: "completed",
      output_summary: `Evaluation created ${suggestions.length} suggestion(s) and ${evaluationReport.run_scores.length} run score(s).`,
      completed_at: nowIso()
    });
    return { reflectionRun, suggestions, evaluationReport };
  }

  private async createEvaluationTraceReport(input: {
    backendRuns: BackendRunRecord[];
    backendEvents: BackendEventRecord[];
    workspaceChanges: WorkspaceChangeRecord[];
    toolRuns: ToolRunRecord[];
    auditRecords: AuditRecord[];
    now: string;
  }): Promise<EvaluationTraceReport> {
    const baseReport = buildEvaluationTraceReport(input);
    if (!this.evaluationJudgeProvider) {
      return baseReport;
    }
    try {
      const judge = await this.evaluationJudgeProvider.judge({ report: baseReport });
      return applyEvaluationJudgeResult(baseReport, this.evaluationJudgeProvider.id, judge);
    } catch (error) {
      return EvaluationTraceReportSchema.parse({
        ...baseReport,
        judge: {
          deterministic_status: "completed",
          external_status: "failed",
          provider_id: this.evaluationJudgeProvider.id,
          summary: safeRuntimeErrorMessage(error)
        }
      });
    }
  }

  async createSession(input: {
    title?: string;
    ui_locale?: SupportedLocale;
    output_locale?: SupportedLocale;
  } = {}): Promise<SessionRecord> {
    const settings = await this.store.getSettings();
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: "web:owner:main",
      title: input.title ?? "New chat",
      ui_locale: input.ui_locale ?? settings.ui_locale,
      output_locale: input.output_locale ?? settings.output_locale,
      created_at: now,
      updated_at: now
    };

    await this.store.createSession(session);
    await this.emit("session.created", session);
    return session;
  }

  async runBackendToolBridgeCall(input: {
    runId: string;
    token: string;
    toolName: string;
    toolCallId?: string;
    toolInput: Record<string, JsonValue>;
  }): Promise<{
    status: "completed";
    artifact_id?: string;
    title?: string;
    resource_ref?: ResourceRef;
    output?: JsonValue;
    tool_run_ids: string[];
  }> {
    const run = await this.store.getBackendRun(input.runId);
    if (!run) {
      throw new RuntimeRequestError("not_found", "backend_run_not_found");
    }
    if (run.status !== "running") {
      throw new RuntimeRequestError("conflict", "backend_run_not_running");
    }
    const expectedToken = this.backendToolBridgeTokens.get(run.id);
    if (!expectedToken || !timingSafeTokenEqual(expectedToken, input.token)) {
      throw new RuntimeRequestError("forbidden", "tool_bridge_token_invalid");
    }
    const providerToolName = normalizeSamuraiToolBridgeName(input.toolName);
    if (!samuraiToolBridgeTools.has(providerToolName)) {
      throw new RuntimeRequestError("conflict", "tool_bridge_tool_not_allowed");
    }
    const runInput = await this.buildResumeToolRunInput(run, {});
    await this.ensureBackendEventSequence(run.id);
    const eventBridge = new BackendEventBridge({
      runId: run.id,
      sessionId: run.session_id,
      nextSequence: () => this.allocateBackendEventSequence(run.id)
    });
    const recordEvent = async (event: BackendOutputEvent): Promise<BackendEventRecord> => {
      const { record, uiRecord } = eventBridge.project(event);
      await this.store.saveBackendEvent(record);
      if (uiRecord) {
        await this.emit("backend.event.created", uiRecord);
      }
      return record;
    };
    const toolCallId = input.toolCallId || createId("toolcall");
    const startedEvent = normalizeBackendOutputEvent({
      event_type: "tool_call_started",
      tool_call_id: toolCallId,
      payload: {
        provider_tool_name: providerToolName,
        action_id: "artifact.create",
        tool_origin: "samurai_tool_bridge",
        input: input.toolInput
      }
    });
    await recordEvent(startedEvent);
    if (providerToolName !== "samurai.artifact.create") {
      const output = await this.runReadOnlyBackendTool(providerToolName, input.toolInput);
      await recordEvent({
        event_type: "tool_call_output",
        tool_call_id: toolCallId,
        payload: {
          provider_tool_name: providerToolName,
          action_id: providerToolName,
          output_summary: summarize(JSON.stringify(output), 220),
          output
        }
      });
      return {
        status: "completed",
        output,
        tool_run_ids: []
      };
    }
    const feedback = await this.handleBackendToolStartedEvent({
      run,
      runInput,
      event: startedEvent,
      recordEvent
    });
    const artifact = feedback.artifacts[0];
    return {
      status: "completed",
      ...(artifact ? { artifact_id: artifact.id, title: artifact.title, resource_ref: artifact.file_ref } : {}),
      tool_run_ids: feedback.toolRuns.map((toolRun) => toolRun.id)
    };
  }

  private async runReadOnlyBackendTool(toolName: string, input: Record<string, JsonValue>): Promise<JsonValue> {
    const query = typeof input.query === "string" ? input.query : "";
    const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? Math.max(1, Math.min(Math.floor(input.limit), 8)) : 5;
    if (toolName === "samurai.session.search") {
      return (await this.store.search(query)).slice(0, limit).map((item) => ({
        kind: item.kind,
        id: item.id,
        title: item.title,
        summary: item.summary,
        ...(item.session_id ? { session_id: item.session_id } : {})
      }));
    }
    if (toolName === "samurai.memory.search") {
      return (await this.store.searchMemory(query, limit, { includeArchived: false })).map((item) => ({
        id: item.id,
        topic: item.topic,
        state: item.state,
        file_path: item.file_path
      }));
    }
    if (toolName === "samurai.wiki.search") {
      return (await this.store.searchWiki(query, limit, { activeOnly: true })).map((item) => ({
        id: item.id,
        slug: item.slug,
        title: item.title,
        file_path: item.file_path
      }));
    }
    if (toolName === "samurai.skill.search") {
      return (await this.store.searchSkills(query, limit, { states: ["active", "pinned", "project"] })).map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        tags: item.tags,
        file_path: item.file_path
      }));
    }
    if (toolName === "samurai.collection.search") {
      const collectionId = typeof input.collection_id === "string" && input.collection_id.trim() ? input.collection_id.trim() : TASKS_COLLECTION_ID;
      const records = await this.store.listCollectionRecords(collectionId);
      const normalizedQuery = query.trim().toLowerCase();
      return records
        .filter((record) => !normalizedQuery || JSON.stringify(record.data).toLowerCase().includes(normalizedQuery))
        .slice(0, limit)
        .map((record) => ({
          collection_id: record.collection_id,
          id: record.id,
          file_path: record.file_path,
          summary: summarize(JSON.stringify(record.data), 180),
          data: collectionId === TASKS_COLLECTION_ID ? taskSafeRecordData(record.data) : record.data
        }));
    }
    throw new RuntimeRequestError("conflict", "tool_bridge_tool_not_allowed");
  }

  async runChatTurn(input: RunChatTurnInput): Promise<RunChatTurnResult> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const settings = await this.store.getSettings();
    const inputLocale = input.input_locale ?? session.ui_locale ?? settings.ui_locale;
    const outputLocale = input.output_locale ?? session.output_locale ?? settings.output_locale;
    const context = input.gateway_context ?? webGatewayContext;
    const envelope = createGatewayEnvelope(context, input.content, inputLocale, outputLocale, input.metadata);
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

    const backendId = input.backend_id?.trim() || defaultBackendId();
    const backend = this.backendRegistry.get(backendId);
    if (!backend) {
      throw new RuntimeRequestError("conflict", `backend_not_registered:${backendId}`);
    }
    if (input.gateway_boundary_policy) {
      await this.store.saveGatewayBoundaryPolicy(input.gateway_boundary_policy);
    }
    const contextIntent = classifyBackendContextIntent(input.content);
    const expectedOutputs = expectedBackendOutputs(input.content);
    const thinExternalContext = shouldThinExternalBackendContext(backend.kind, contextIntent);
    const backendRunId = createId("run");
    const workspaceRoot = this.store.rootDir;
    const backendWorkingDirectoryMode = this.backendWorkingDirectoryMode();
    const workingDirectory = this.backendWorkingDirectory();
    const activeToolBridge = createBackendToolBridge({
      backendKind: backend.kind,
      runId: backendRunId,
      expectedOutputs,
      contextIntent,
      gatewayBoundaryPresent: Boolean(input.gateway_boundary_policy)
    });
    let backendRun: BackendRunRecord = {
      id: backendRunId,
      session_id: session.id,
      input_message_id: userMessage.id,
      backend_id: backend.id,
      backend_kind: backend.kind,
      status: "running",
      started_at: nowIso(),
      input_summary: summarize(input.content),
      metadata: {
        ...jsonRecord(input.metadata ?? {}),
        context_intent: contextIntent,
        ...(expectedOutputs.length > 0 ? { expected_outputs: expectedOutputs } : {}),
        workspace_root: workspaceRoot,
        working_directory: workingDirectory,
        backend_working_directory_mode: backendWorkingDirectoryMode,
        ...(activeToolBridge ? { tool_bridge_status: "enabled", tool_bridge_server: activeToolBridge.server_name } : {}),
        context_handoff_status: "preparing"
      }
    };
    if (activeToolBridge) {
      this.backendToolBridgeTokens.set(backendRun.id, activeToolBridge.token ?? "");
    }
    backendRun = await this.store.saveBackendRun(backendRun);
    await this.emit("backend.run.created", backendRun);

    const operations: OperationRecord[] = [];
    const artifacts: ArtifactRecord[] = [];
    const memories: MemoryFrontmatter[] = [];
    const backendEvents: BackendEventRecord[] = [];
    const workspaceChanges: WorkspaceChangeRecord[] = [];
    const toolRuns: ToolRunRecord[] = [];
    const textParts: string[] = [];
    this.backendEventSequences.set(backendRun.id, 1);
    const eventBridge = new BackendEventBridge({
      runId: backendRun.id,
      sessionId: session.id,
      nextSequence: () => this.allocateBackendEventSequence(backendRun.id)
    });
    const recordEvent = async (event: BackendOutputEvent): Promise<BackendEventRecord> => {
      const { record, uiRecord } = eventBridge.project(event);
      await this.store.saveBackendEvent(record);
      backendEvents.push(record);
      if (uiRecord) {
        await this.emit("backend.event.created", uiRecord);
      }
      return record;
    };
    const emitHostProgress = async (displayKind: "reasoning_summary" | "activity", text: string, activityKind?: string) => {
      await recordEvent({
        event_type: "host_progress",
        payload: {
          display_kind: displayKind,
          text,
          ...(activityKind ? { activity_kind: activityKind } : {})
        }
      });
    };

    await emitHostProgress("reasoning_summary", "関連する文脈を確認し、実行部へ渡す情報を絞っています。");
    await emitHostProgress("activity", "文脈候補を確認", "context_prepare");
    await emitHostProgress("reasoning_summary", "必要な情報はSamurai側に残し、実行部には参照先と使える道具を渡します。");
    const contextPreview = await this.buildContextPreview(session.id, input.content, {
      contextIntent,
      skipHeavyContext: thinExternalContext,
      onProgress: emitHostProgress
    });
    const freezeSnapshot = contextPreview.freeze_snapshot;
    const gatewayBoundary = input.gateway_boundary_policy ? gatewayBoundaryRuntimeSnapshot(input.gateway_boundary_policy) : undefined;
    const availableTools = applyGatewayBoundaryAllowedTools(contextPreview.available_tools, input.gateway_boundary_policy);
    const contextAssembly = applyGatewayBoundaryToContextAssembly(
      contextPreview.context_assembly,
      gatewayBoundary,
      contextPreview.available_tools,
      availableTools
    );
    const contextHandoff = buildContextHandoffForBackend({
      backendKind: backend.kind,
      contextIntent,
      contextPreview,
      contextAssembly,
      gatewayBoundaryPresent: Boolean(gatewayBoundary)
    });
    await emitHostProgress("activity", "参照先を準備", "context_handoff");
    const boundaryMetadata = gatewayBoundary ? gatewayBoundaryRuntimeMetadata(gatewayBoundary) : {};
    const runMetadata = {
      ...jsonRecord(input.metadata ?? {}),
      context_intent: contextIntent,
      ...(expectedOutputs.length > 0 ? { expected_outputs: expectedOutputs } : {}),
      workspace_root: workspaceRoot,
      working_directory: workingDirectory,
      backend_working_directory_mode: backendWorkingDirectoryMode,
      ...(activeToolBridge ? { tool_bridge_status: "enabled", tool_bridge_server: activeToolBridge.server_name } : {}),
      context_handoff_status: "ready",
      ...boundaryMetadata,
      ...contextAssemblyRuntimeMetadata(contextAssembly),
      ...contextHandoffRuntimeMetadata(contextHandoff),
      ...(freezeSnapshot
        ? {
            freeze_snapshot_id: freezeSnapshot.id,
            freeze_snapshot_hash: freezeSnapshot.stable_hash
          }
        : {})
    };
    backendRun = {
      ...backendRun,
      metadata: runMetadata
    };
    await this.store.updateBackendRun(backendRun);
    await this.emit("backend.run.updated", backendRun);

    const backendSession = await backend.startSession?.({
      session_id: session.id,
      session_key: session.session_key,
      output_locale: outputLocale,
      metadata: runMetadata
    });
    await emitHostProgress("activity", "実行部へ送信", "backend_send");
    if (backendSession) {
      backendRun = {
        ...backendRun,
        metadata: {
          ...backendRun.metadata,
          backend_session_id: backendSession.backend_session_id,
          backend_session_started_at: backendSession.started_at,
          backend_session_metadata: backendSession.metadata
        }
      };
      await this.store.updateBackendRun(backendRun);
      await this.emit("backend.run.updated", backendRun);
    }

    const activeMemory = contextPreview.active_memory;
    const recentMessages = (await this.store.listMessages(session.id)).slice(-10);
    const runInput: BackendRunInput = {
      run_id: backendRun.id,
      session_id: session.id,
      input_message_id: userMessage.id,
      workspace_root: workspaceRoot,
      working_directory: workingDirectory,
      envelope,
      user_input: input.content,
      input_locale: inputLocale,
      output_locale: outputLocale,
      active_memory: activeMemory.map((memory) => ({
        id: memory.id,
        topic: memory.topic,
        content: memory.content,
        state: memory.state,
        sensitive_level: memory.sensitive_level,
        priority: memory.priority,
        selection_reason: memory.selection_reason,
        conflicts_with: memory.conflicts_with
      })),
      freeze_snapshot: freezeSnapshot,
      gateway_boundary: gatewayBoundary,
      knowledge_wiki: contextPreview.knowledge_wiki,
      collection_notes: contextPreview.collection_notes,
      selected_skills: contextPreview.selected_skills,
      session_search: contextPreview.session_search,
      session_summary: contextPreview.session_summary,
      external_assist: contextPreview.external_assist,
      context_assembly: contextAssembly,
      context_handoff: contextHandoff,
      tool_bridge: activeToolBridge,
      available_tools: availableTools,
      recent_messages: recentMessages,
      metadata: backendRun.metadata,
      context_intent: contextIntent,
      expected_outputs: expectedOutputs
    };

    for (const skill of contextPreview.selected_skills) {
      await this.store.recordSkillUsage({ skillId: skill.id, runId: backendRun.id });
    }

    let failedEvent: BackendEventRecord | undefined;
    let waitingForBackendInput = false;

    const sessionMemory = await createSessionMemory(this.store, envelope, input.content);
    memories.push(sessionMemory);
    const sessionMemoryRef = memoryRef(sessionMemory);
    const sessionMemoryChange: WorkspaceChangeRecord = {
      id: createId("change"),
      run_id: backendRun.id,
      session_id: session.id,
      resource_ref: sessionMemoryRef,
      change_type: "memory_suggested",
      summary: `Captured session memory ${sessionMemory.topic}.`,
      created_at: nowIso()
    };
    await this.store.saveWorkspaceChange(sessionMemoryChange);
    workspaceChanges.push(sessionMemoryChange);
    await this.emit("workspace.change.created", sessionMemoryChange);
    await this.emit("memory.candidate.created", sessionMemory);

    for await (const rawEvent of backend.runTurn(runInput)) {
      const event = normalizeBackendOutputEvent(rawEvent);
      const record = await recordEvent(event);
      const updatedRun = applyBackendSessionMetadata(backendRun, event);
      if (updatedRun !== backendRun) {
        backendRun = updatedRun;
        await this.store.updateBackendRun(backendRun);
        await this.emit("backend.run.updated", backendRun);
      }
      if (event.event_type === "text_delta") {
        const text = typeof event.payload.text === "string" ? event.payload.text : "";
        if (text) {
          textParts.push(text);
        }
      }
      if (event.event_type === "tool_call_started") {
        const feedback = await this.handleBackendToolStartedEvent({
          run: backendRun,
          runInput,
          event,
          gatewayBoundaryPolicy: input.gateway_boundary_policy,
          recordEvent
        });
        operations.push(...feedback.operations);
        artifacts.push(...feedback.artifacts);
        memories.push(...feedback.memories);
        toolRuns.push(...feedback.toolRuns);
        workspaceChanges.push(...feedback.workspaceChanges);
      }
      if (event.event_type === "backend_waiting_for_native_input") {
        waitingForBackendInput = true;
        backendRun = {
          ...backendRun,
          status: "waiting_for_backend_input"
        };
        await this.store.updateBackendRun(backendRun);
        await this.emit("backend.run.updated", backendRun);
        break;
      }
      if (event.event_type === "run_failed") {
        failedEvent = record;
      }
      if (event.event_type === "run_completed") {
        backendRun = {
          ...backendRun,
          status: "completed",
          output_summary: typeof event.payload.output_summary === "string" ? event.payload.output_summary : summarize(textParts.join(" ")),
          completed_at: nowIso()
        };
      }
    }

    if (failedEvent) {
      const errorCode = typeof failedEvent.payload.error_code === "string" ? failedEvent.payload.error_code : "provider_failed";
      const wasCancelled = errorCode === "backend_cancelled";
      backendRun = {
        ...backendRun,
        status: wasCancelled ? "cancelled" : "failed",
        error_code: errorCode,
        completed_at: nowIso()
      };
      await this.store.updateBackendRun(backendRun);
      await this.emit("backend.run.updated", backendRun);
      this.backendToolBridgeTokens.delete(backendRun.id);
      this.backendEventSequences.delete(backendRun.id);
      const payload = { session, messages: [userMessage], backendRun, backendEvents, workspaceChanges };
      const code = wasCancelled ? "backend_cancelled" : backendRun.error_code === "provider_not_configured" ? "provider_not_configured" : "provider_failed";
      throw new RuntimeRequestError(code, typeof failedEvent.payload.message === "string" ? failedEvent.payload.message : "Provider failed.", payload, {
        reason: isProviderDiagnosticReason(failedEvent.payload.reason) ? failedEvent.payload.reason : code === "provider_not_configured" ? "not_configured" : "unknown",
        retryable: failedEvent.payload.retryable === true,
        provider: typeof failedEvent.payload.provider === "string" ? failedEvent.payload.provider : undefined,
        model: typeof failedEvent.payload.model === "string" ? failedEvent.payload.model : undefined,
        status: typeof failedEvent.payload.status === "number" ? failedEvent.payload.status : undefined
      });
    }

    const persistedRunState = await this.loadPersistedRunOutputs(backendRun);
    mergeUniqueById(operations, persistedRunState.operations);
    mergeUniqueById(artifacts, persistedRunState.artifacts);
    mergeUniqueById(workspaceChanges, persistedRunState.workspaceChanges);
    mergeUniqueById(toolRuns, persistedRunState.toolRuns);

    const agentContent = textParts.join("\n").trim();
    if (agentContent && expectedOutputs.includes("artifact") && !gatewayBoundary && !hasCreatedArtifact(artifacts, workspaceChanges)) {
      const fallbackArtifact = await this.createBackendArtifactFromText({
        run: backendRun,
        runInput,
        title: artifactTitleFromUserInput(input.content),
        content: agentContent,
        recordEvent
      });
      operations.push(...fallbackArtifact.operations);
      artifacts.push(...fallbackArtifact.artifacts);
      workspaceChanges.push(...fallbackArtifact.workspaceChanges);
    }
    const completedWithoutBody = !agentContent && !hasMeaningfulBackendOutput(backendEvents, workspaceChanges, artifacts);
    const visibleAgentContent = completedWithoutBody ? "結果本文を受け取れませんでした。実行ログを確認してください。" : agentContent;
    const agentMessage = await this.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: visibleAgentContent,
      input_locale: envelope.input_locale,
      output_locale: envelope.output_locale,
      created_at: nowIso()
    });

    backendRun = {
      ...backendRun,
      output_message_id: agentMessage.id,
      status: waitingForBackendInput ? "waiting_for_backend_input" : backendRun.status === "running" ? "completed" : backendRun.status,
      output_summary: meaningfulBackendRunSummary(backendRun.output_summary) || summarize(visibleAgentContent),
      completed_at: waitingForBackendInput ? undefined : (backendRun.completed_at ?? nowIso())
    };
    await this.store.updateBackendRun(backendRun);
    await this.emit("backend.run.updated", backendRun);
    if (!waitingForBackendInput) {
      this.backendToolBridgeTokens.delete(backendRun.id);
      this.backendEventSequences.delete(backendRun.id);
    }

    const externalAssistSyncRecords = waitingForBackendInput
      ? []
      : await this.runExternalAssistSync({
          sessionId: session.id,
          runId: backendRun.id,
          inputMessageId: userMessage.id,
          query: input.content,
          userContent: input.content,
          assistantContent: agentContent,
          role: settings.external_provider_role
        });
    if (externalAssistSyncRecords.length > 0) {
      const primaryExternalAssistSync = externalAssistSyncRecords[0];
      backendRun = {
        ...backendRun,
        metadata: {
          ...backendRun.metadata,
          ...(primaryExternalAssistSync ? {
            external_assist_sync_id: primaryExternalAssistSync.id,
            external_assist_sync_status: primaryExternalAssistSync.status,
            external_assist_sync_provider_id: primaryExternalAssistSync.provider_id
          } : {}),
          external_assist_sync_ids: externalAssistSyncRecords.map((record) => record.id),
          external_assist_sync_statuses: externalAssistSyncRecords.map((record) => record.status),
          external_assist_sync_provider_ids: externalAssistSyncRecords.map((record) => record.provider_id)
        }
      };
      await this.store.updateBackendRun(backendRun);
      await this.emit("backend.run.updated", backendRun);
    }
    const reflection = await this.runReflectionForCompletedTurn({
      kind: "chat_turn",
      session,
      backendRun,
      userMessage,
      agentMessage,
      backendEvents,
      workspaceChanges,
      toolRuns,
      transcriptMessages: await this.store.listMessages(session.id),
      artifacts: await this.loadReflectionArtifacts({
        sessionId: session.id,
        sourceRunId: backendRun.id,
        workspaceChanges
      })
    });

    return {
      session,
      messages: [userMessage, agentMessage],
      backendRun,
      backendEvents,
      workspaceChanges,
      operations,
      policyDecisions: [],
      artifacts,
      memories,
      approvalRequests: [],
      auditRecords: [],
      rollbackPoints: [],
      activity: [],
      reflectionRuns: [reflection.reflectionRun],
      reflectionSuggestions: reflection.suggestions,
      toolRuns
    };
  }

  async cancelBackendRun(runId: string): Promise<BackendRunRecord> {
    const run = await this.store.getBackendRun(runId);
    if (!run) {
      throw new RuntimeRequestError("not_found", "backend_run_not_found");
    }
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return run;
    }

    const backend = this.backendRegistry.get(run.backend_id);
    if (!backend) {
      throw new RuntimeRequestError("conflict", `backend_not_registered:${run.backend_id}`);
    }
    await backend.cancelRun?.(run.id);
    const cancelledAt = nowIso();
    const releasedGatewayLock = await this.releaseGatewayConcurrencyLockForRun(run, cancelledAt);
    const cancelledRun: BackendRunRecord = {
      ...run,
      status: "cancelled",
      error_code: "backend_cancelled",
      completed_at: cancelledAt,
      metadata: releasedGatewayLock
        ? {
          ...run.metadata,
          gateway_concurrency_lock_status: releasedGatewayLock.status,
          gateway_concurrency_lock_released_at: releasedGatewayLock.released_at ?? cancelledAt
        }
        : run.metadata
    };
    await this.store.updateBackendRun(cancelledRun);
    await this.emit("backend.run.updated", cancelledRun);
    return cancelledRun;
  }

  async syncBackendStream(runId: string, input: { maxEvents?: number; timeoutMs?: number } = {}): Promise<BackendStreamSyncResult> {
    let backendRun = await this.store.getBackendRun(runId);
    if (!backendRun) {
      throw new RuntimeRequestError("not_found", "backend_run_not_found");
    }
    const backend = this.backendRegistry.get(backendRun.backend_id);
    if (!backend) {
      throw new RuntimeRequestError("conflict", `backend_not_registered:${backendRun.backend_id}`);
    }
    const existingEvents = await this.store.listBackendEvents({ runId: backendRun.id });
    const eventBridge = new BackendEventBridge({
      runId: backendRun.id,
      sessionId: backendRun.session_id,
      startSequence: existingEvents.reduce((max, event) => Math.max(max, event.sequence), 0) + 1
    });
    const seen = new Set(existingEvents.map(backendEventSignature));
    const persistedEvents: BackendEventRecord[] = [];
    let skippedDuplicateCount = 0;
    const recordEvent = async (event: BackendOutputEvent, options: { allowDuplicate?: boolean } = {}): Promise<BackendEventRecord | undefined> => {
      const normalized = normalizeBackendStreamEvent(event);
      const signature = backendOutputEventSignature(normalized);
      if (!options.allowDuplicate && seen.has(signature)) {
        skippedDuplicateCount += 1;
        return undefined;
      }
      seen.add(signature);
      const { record, uiRecord } = eventBridge.project(normalized);
      await this.store.saveBackendEvent(record);
      persistedEvents.push(record);
      if (uiRecord) {
        await this.emit("backend.event.created", uiRecord);
      }
      return record;
    };

    if (!backend.streamEvents) {
      await recordEvent({
        event_type: "backend_stream_unavailable",
        payload: {
          reason: "stream_events_unsupported",
          backend_id: backend.id,
          backend_label: backend.label,
          supports_stream_events: false
        }
      }, { allowDuplicate: true });
      return {
        run: backendRun,
        status: "unsupported",
        events: persistedEvents,
        persisted_event_count: persistedEvents.length,
        skipped_duplicate_count: skippedDuplicateCount,
        timed_out: false,
        max_events_reached: false
      };
    }

    const maxEvents = Math.max(1, Math.min(500, input.maxEvents ?? 200));
    const timeoutMs = Math.max(100, Math.min(120_000, input.timeoutMs ?? 30_000));
    const stream = backend.streamEvents(backendRun.id);
    const iterator = stream[Symbol.asyncIterator]();
    const deadline = Date.now() + timeoutMs;
    let observedEvents = 0;
    let timedOut = false;
    let maxEventsReached = false;
    const textParts: string[] = [];

    try {
      while (observedEvents < maxEvents) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
          break;
        }
        const next = await nextBackendStreamEvent(iterator, remainingMs);
        if (next === "timeout") {
          timedOut = true;
          break;
        }
        if (next.done) {
          break;
        }
        observedEvents += 1;
        const normalized = normalizeBackendStreamEvent(next.value);
        const record = await recordEvent(normalized);
        if (!record) {
          continue;
        }
        backendRun = applyBackendSessionMetadata(backendRun, normalized);
        if (normalized.event_type === "text_delta" && typeof normalized.payload.text === "string") {
          textParts.push(normalized.payload.text);
        }
        if (normalized.event_type === "run_completed") {
          backendRun = {
            ...backendRun,
            status: "completed",
            output_summary: typeof normalized.payload.output_summary === "string" ? normalized.payload.output_summary : summarize(textParts.join(" ")),
            completed_at: nowIso()
          };
        } else if (normalized.event_type === "run_failed") {
          backendRun = {
            ...backendRun,
            status: "failed",
            error_code: typeof normalized.payload.error_code === "string" ? normalized.payload.error_code : "backend_stream_failed",
            completed_at: nowIso()
          };
        } else if (normalized.event_type === "backend_waiting_for_native_input") {
          backendRun = {
            ...backendRun,
            status: "waiting_for_backend_input",
            completed_at: undefined
          };
        }
        await this.store.updateBackendRun(backendRun);
        await this.emit("backend.run.updated", backendRun);
      }
      maxEventsReached = observedEvents >= maxEvents;
    } finally {
      await iterator.return?.();
    }

    const summaryEvent = await recordEvent({
      event_type: timedOut ? "backend_stream_unavailable" : "backend_stream_synced",
      payload: {
        reason: timedOut ? "stream_sync_timeout" : maxEventsReached ? "stream_sync_max_events" : "stream_sync_completed",
        backend_id: backend.id,
        observed_event_count: observedEvents,
        persisted_event_count: persistedEvents.length,
        skipped_duplicate_count: skippedDuplicateCount,
        max_events: maxEvents,
        timeout_ms: timeoutMs
      }
    }, { allowDuplicate: true });
    if (summaryEvent && summaryEvent.event_type === "backend_stream_unavailable") {
      await this.emit("backend.run.updated", backendRun);
    }

    return {
      run: backendRun,
      status: timedOut ? "timeout" : maxEventsReached ? "max_events" : "synced",
      events: persistedEvents,
      persisted_event_count: persistedEvents.length,
      skipped_duplicate_count: skippedDuplicateCount,
      timed_out: timedOut,
      max_events_reached: maxEventsReached
    };
  }

  async resumeBackendRun(runId: string, input: Record<string, JsonValue> = {}): Promise<BackendRunRecord> {
    const storedRun = await this.store.getBackendRun(runId);
    if (!storedRun) {
      throw new RuntimeRequestError("not_found", "backend_run_not_found");
    }
    let backendRun: BackendRunRecord = storedRun;
    if (backendRun.status !== "waiting_for_backend_input") {
      throw new RuntimeRequestError("conflict", "backend_run_not_waiting_for_input");
    }

    const backend = this.backendRegistry.get(backendRun.backend_id);
    if (!backend) {
      throw new RuntimeRequestError("conflict", `backend_not_registered:${backendRun.backend_id}`);
    }

    const existingEvents = await this.store.listBackendEvents({ runId: backendRun.id });
    const eventBridge = new BackendEventBridge({
      runId: backendRun.id,
      sessionId: backendRun.session_id,
      startSequence: existingEvents.reduce((max, event) => Math.max(max, event.sequence), 0) + 1
    });
    const textParts: string[] = [];
    backendRun = {
      ...backendRun,
      status: "running",
      metadata: {
        ...backendRun.metadata,
        resume_input: jsonSafe(input),
        resumed_at: nowIso()
      }
    };
    await this.store.updateBackendRun(backendRun);
    await this.emit("backend.run.updated", backendRun);

    const recordEvent = async (event: BackendOutputEvent): Promise<BackendEventRecord> => {
      const { record, uiRecord } = eventBridge.project(event);
      await this.store.saveBackendEvent(record);
      if (uiRecord) {
        await this.emit("backend.event.created", uiRecord);
      }
      return record;
    };

    await recordEvent({
      event_type: "backend_native_input_submitted",
      payload: {
        input: jsonSafe(input),
        submitted_at: nowIso()
      }
    });

    if (!backend.resumeRun) {
      const unsupported = await recordEvent({
        event_type: "run_failed",
        payload: {
          error_code: "backend_resume_unsupported",
          message: `${backend.label} does not support resume.`,
          reason: "resume_unsupported",
          retryable: false,
          backend_id: backend.id
        }
      });
      backendRun = {
        ...backendRun,
        status: "failed",
        error_code: typeof unsupported.payload.error_code === "string" ? unsupported.payload.error_code : "backend_resume_unsupported",
        completed_at: nowIso()
      };
      await this.store.updateBackendRun(backendRun);
      await this.emit("backend.run.updated", backendRun);
      return backendRun;
    }

    const gatewayBoundaryPolicy = await this.gatewayBoundaryPolicyForRun(backendRun);
    let resumeToolRunInput: BackendRunInput | undefined;
    const getResumeToolRunInput = async () => {
      resumeToolRunInput ??= await this.buildResumeToolRunInput(backendRun, jsonRecord(input), gatewayBoundaryPolicy);
      return resumeToolRunInput;
    };

    const backendResumeInput = {
      ...jsonRecord(input),
      ...(typeof backendRun.metadata.workspace_root === "string" ? { workspace_root: backendRun.metadata.workspace_root } : {}),
      ...(typeof backendRun.metadata.working_directory === "string" ? { working_directory: backendRun.metadata.working_directory } : {}),
      ...(typeof backendRun.metadata.backend_session_id === "string" ? { backend_session_id: backendRun.metadata.backend_session_id } : {})
    };
    for await (const rawEvent of backend.resumeRun(backendRun.id, backendResumeInput)) {
      const event = normalizeBackendOutputEvent(rawEvent);
      const record = await recordEvent(event);
      const updatedRun = applyBackendSessionMetadata(backendRun, event);
      if (updatedRun !== backendRun) {
        backendRun = updatedRun;
        await this.store.updateBackendRun(backendRun);
        await this.emit("backend.run.updated", backendRun);
      }
      if (event.event_type === "text_delta") {
        const text = typeof event.payload.text === "string" ? event.payload.text : "";
        if (text) {
          textParts.push(text);
        }
      }
      if (event.event_type === "tool_call_started") {
        await this.handleBackendToolStartedEvent({
          run: backendRun,
          runInput: await getResumeToolRunInput(),
          event,
          gatewayBoundaryPolicy,
          recordEvent
        });
      }
      if (event.event_type === "backend_waiting_for_native_input") {
        backendRun = { ...backendRun, status: "waiting_for_backend_input" };
        break;
      }
      if (event.event_type === "run_failed") {
        const errorCode = typeof record.payload.error_code === "string" ? record.payload.error_code : "backend_failed";
        backendRun = {
          ...backendRun,
          status: errorCode === "backend_cancelled" ? "cancelled" : "failed",
          error_code: errorCode,
          completed_at: nowIso()
        };
        break;
      }
      if (event.event_type === "run_completed") {
        backendRun = {
          ...backendRun,
          status: "completed",
          output_summary: typeof event.payload.output_summary === "string" ? event.payload.output_summary : summarize(textParts.join(" ")),
          completed_at: nowIso()
        };
        break;
      }
    }

    if (backendRun.status === "running") {
      backendRun = {
        ...backendRun,
        status: "completed",
        output_summary: summarize(textParts.join(" ")),
        completed_at: nowIso()
      };
    }
    await this.store.updateBackendRun(backendRun);
    await this.emit("backend.run.updated", backendRun);
    return backendRun;
  }

  async runSurfaceOperation(input: SurfaceOperation): Promise<SurfaceOperationRuntimeResult> {
    if (input.kind === "message.submit") {
      if (!input.session_id) {
        throw new RuntimeRequestError("conflict", "surface_operation_session_required");
      }
      const result = await this.runChatTurn({
        sessionId: input.session_id,
        content: input.content,
        backend_id: input.backend_id,
        input_locale: input.input_locale,
        output_locale: input.output_locale,
        metadata: {
          ...(input.metadata ?? {}),
          surface_operation_id: input.id,
          surface_operation_kind: input.kind,
          surface_operation_payload: jsonSafe(input)
        }
      });
      const chatRender = negotiatedRenderSpec(input, chatTurnRenderSpec(result));
      const renderSpecs = [chatRender];
      if (isTaskListAppRequest(input.content)) {
        await this.ensureTasksCollectionSchema();
        const records = await this.store.listCollectionRecords("tasks");
        const schema = await this.store.getCollectionSchema("tasks");
        renderSpecs.push(negotiatedRenderSpec(input, taskListRenderSpec(records, input.session_id, input.id, schema)));
      } else if (isActiveTaskListAppRequest(input)) {
        await this.ensureTasksCollectionSchema();
        await applyAppEditPatchToTasksStore(this.store, this.provider, input.content);
        const records = await this.store.listCollectionRecords("tasks");
        const schema = await this.store.getCollectionSchema("tasks");
        renderSpecs.push(negotiatedRenderSpec(input, taskListRenderSpec(records, input.session_id, input.id, schema)));
      }
      return {
        operation: input,
        result_kind: "chat_turn",
        render_spec: chatRender,
        render_specs: renderSpecs,
        result
      };
    }

    if (input.kind === "collection.record.create") {
      const now = nowIso();
      if (input.collection_id === TASKS_COLLECTION_ID) {
        validateTaskRecordCreateData(input.data);
      }
      const result = await this.createCollectionRecord({
        id: input.record_id,
        collection_id: input.collection_id,
        data: input.data,
        resource_refs: [],
        created_at: now,
        updated_at: now
      });
      const resolution = await this.store.resolveCollectionRecordRefs(result.resource.collection_id, result.resource.id);
      const renderSpec = negotiatedRenderSpec(input, collectionRecordRenderSpec(result.resource, "Collection record", resolution));
      return {
        operation: input,
        result_kind: "collection_record",
        render_spec: renderSpec,
        render_specs: [renderSpec],
        result
      };
    }

    if (input.kind === "collection.view.present") {
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

    if (input.kind === "collection.record.patch") {
      if (input.collection_id === TASKS_COLLECTION_ID) {
        validateTaskRecordPatchData(input.changes);
      }
      const result = await this.applyCollectionPatch({
        collectionId: input.collection_id,
        recordId: input.record_id,
        patch: {
          id: input.patch_id,
          record_id: input.record_id,
          changes: input.changes,
          source_operation_id: input.id,
          created_at: nowIso()
        }
      });
      const resolution = await this.store.resolveCollectionRecordRefs(result.resource.collection_id, result.resource.id);
      const renderSpec = negotiatedRenderSpec(input, collectionRecordRenderSpec(result.resource, "Collection patch applied", resolution));
      return {
        operation: input,
        result_kind: "collection_patch",
        render_spec: renderSpec,
        render_specs: [renderSpec],
        result
      };
    }

    if (input.kind === "collection.record.delete") {
      const result = await this.deleteCollectionRecord({
        collectionId: input.collection_id,
        recordId: input.record_id,
        viewId: input.view_id
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

    return this.runStructuredSurfaceOperation(input);
  }

  async runDomainCommand(input: DomainCommandRuntimeInput): Promise<DomainCommandRuntimeResult> {
    const command = requireDomainCommandEntry(input.command_id);
    const inputSource = input.input_source ?? "runtime_api";
    if (!command.input_sources.includes(inputSource)) {
      throw new RuntimeRequestError("conflict", `domain_command_source_not_allowed:${command.id}:${inputSource}`);
    }
    const payload = jsonRecord(input.payload ?? {});
    const result = await this.executeDomainCommand(command, payload);
    const renderSpecs = assertDomainCommandRenderSpecs(command, await this.domainCommandRenderSpecs(command, result));
    return {
      command,
      input_source: inputSource,
      payload,
      render_spec: renderSpecs[0],
      render_specs: renderSpecs,
      result
    };
  }

  private async domainCommandRenderSpecs(command: DomainCommandEntry, result: unknown): Promise<SurfaceRenderSpec[]> {
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
      const resolution = await this.store.resolveCollectionRecordRefs(result.resource.collection_id, result.resource.id);
      return [collectionRecordRenderSpec(result.resource, command.title, resolution)];
    }
    const resourceSpec = resourceRenderSpec(command, result);
    return resourceSpec ? [resourceSpec] : [];
  }

  private async executeDomainCommand(command: DomainCommandEntry, payload: Record<string, JsonValue>): Promise<unknown> {
    if (command.id === "chat.turn.run") {
      const sessionId = stringPayload(payload.session_id) || (await this.createSession({
        title: stringPayload(payload.title) || undefined,
        ui_locale: supportedLocalePayload(payload.ui_locale),
        output_locale: supportedLocalePayload(payload.output_locale)
      })).id;
      const content = stringPayload(payload.content) || stringPayload(payload.user_intent) || stringPayload(payload.target_instruction);
      if (!content) {
        throw new RuntimeRequestError("conflict", "domain_command_chat_content_required");
      }
      return this.runChatTurn({
        sessionId,
        content,
        backend_id: stringPayload(payload.backend_id) || undefined,
        input_locale: supportedLocalePayload(payload.input_locale),
        output_locale: supportedLocalePayload(payload.output_locale),
        metadata: {
          domain_command_id: command.id,
          domain_command_payload: payload
        }
      });
    }

    if (command.id === "gateway.inbound.route") {
      const sourceIdentity = stringPayload(payload.source_identity);
      const body = stringPayload(payload.body) || stringPayload(payload.content) || stringPayload(payload.user_intent);
      if (!sourceIdentity || !body) {
        throw new RuntimeRequestError("conflict", "domain_command_gateway_inbound_source_body_required");
      }
      return this.handleGatewayInbound({
        channel: gatewayChannelPayload(payload.channel),
        source_identity: sourceIdentity,
        body,
        source_label: stringPayload(payload.source_label) || undefined,
        account_id: stringPayload(payload.account_id) || undefined,
        thread_id: stringPayload(payload.thread_id) || undefined,
        route: stringPayload(payload.route) || undefined,
        metadata: recordPayload(payload.metadata),
        backend_id: stringPayload(payload.backend_id) || undefined,
        input_locale: supportedLocalePayload(payload.input_locale),
        output_locale: supportedLocalePayload(payload.output_locale)
      });
    }

    if (command.id === "artifact.create") {
      const sessionId = stringPayload(payload.session_id) || (await this.createSession({
        title: stringPayload(payload.title) || "Artifact command",
        ui_locale: supportedLocalePayload(payload.ui_locale),
        output_locale: supportedLocalePayload(payload.output_locale)
      })).id;
      const title = stringPayload(payload.title) || "Untitled artifact";
      const instruction = stringPayload(payload.instruction) || stringPayload(payload.content) || stringPayload(payload.body);
      if (!instruction) {
        throw new RuntimeRequestError("conflict", "domain_command_artifact_instruction_required");
      }
      if (payload.provider_tool_call === true) {
        const session = await this.store.getSession(sessionId);
        if (!session) {
          throw new RuntimeRequestError("not_found", `Session not found: ${sessionId}`);
        }
        const inputLocale = supportedLocalePayload(payload.input_locale) ?? session.ui_locale;
        const outputLocale = supportedLocalePayload(payload.output_locale) ?? session.output_locale;
        const context = {
          ...webGatewayContext,
          session_key: session.session_key
        };
        const createdEnvelope = createGatewayEnvelope(context, instruction, inputLocale, outputLocale, recordPayload(payload.metadata));
        const envelopeId = stringPayload(payload.envelope_id) || stringPayload(payload.input_message_id);
        const envelope = envelopeId ? { ...createdEnvelope, id: envelopeId } : createdEnvelope;
        return this.runAllowedWrite<ArtifactRecord, Record<string, unknown>>({
          session,
          envelope,
          context,
          operationName: command.id,
          proposedEffects: command.proposed_effects,
          execute: async (operation) => {
            const artifact = await createArtifactDraft({
              store: this.store,
              operation,
              title,
              content: instruction,
              kind: artifactKindPayload(payload.kind),
              locale: outputLocale,
              sourceLocales: [inputLocale],
              createdBy: "backend"
            });
            const rollbackPoint = await this.createRollbackPoint(operation, [artifact.file_ref], {}, { artifact_id: artifact.id });
            return {
              resource: artifact,
              ref: artifact.file_ref,
              rollbackPoint,
              summary: `Created artifact ${artifact.title}.`
            };
          }
        });
      }
      return this.runStructuredSurfaceOperation({
        id: stringPayload(payload.surface_operation_id) || createId("surface"),
        kind: "artifact.request",
        session_id: sessionId,
        action: "create",
        title,
        instruction,
        input_locale: supportedLocalePayload(payload.input_locale),
        output_locale: supportedLocalePayload(payload.output_locale),
        metadata: recordPayload(payload.metadata)
      });
    }

    if (command.id === "memory.session.create") {
      const content = stringPayload(payload.content) || stringPayload(payload.user_intent) || stringPayload(payload.target_instruction);
      if (!content) {
        throw new RuntimeRequestError("conflict", "domain_command_memory_content_required");
      }
      const requestedSessionId = stringPayload(payload.session_id);
      const session = requestedSessionId
        ? await this.store.getSession(requestedSessionId)
        : await this.createSession({
          title: stringPayload(payload.title) || undefined,
          ui_locale: supportedLocalePayload(payload.ui_locale),
          output_locale: supportedLocalePayload(payload.output_locale)
        });
      if (!session) {
        throw new RuntimeRequestError("not_found", `Session not found: ${requestedSessionId}`);
      }
      const context = {
        ...webGatewayContext,
        session_key: session.session_key
      };
      const createdEnvelope = createGatewayEnvelope(
        context,
        content,
        supportedLocalePayload(payload.input_locale) ?? session.ui_locale,
        supportedLocalePayload(payload.output_locale) ?? session.output_locale,
        recordPayload(payload.metadata)
      );
      const envelopeId = stringPayload(payload.envelope_id) || stringPayload(payload.input_message_id);
      const envelope = envelopeId ? { ...createdEnvelope, id: envelopeId } : createdEnvelope;
      return this.runAllowedWrite<MemoryFrontmatter, Record<string, unknown>>({
        session,
        envelope,
        context,
        operationName: command.id,
        proposedEffects: command.proposed_effects,
        execute: async (operation) => {
          const memory = await createSessionMemory(this.store, envelope, content);
          const ref = memoryRef(memory);
          const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { memory_id: memory.id });
          await this.emit("memory.candidate.created", memory);
          return {
            resource: memory,
            ref,
            rollbackPoint,
            summary: `Created session memory ${memory.topic}.`
          };
        }
      });
    }

    if (command.id === "memory.topic.create") {
      const content = stringPayload(payload.content) || stringPayload(payload.topic) || stringPayload(payload.user_intent) || stringPayload(payload.target_instruction);
      if (!content) {
        throw new RuntimeRequestError("conflict", "domain_command_memory_topic_required");
      }
      const requestedSessionId = stringPayload(payload.session_id);
      const session = requestedSessionId
        ? await this.store.getSession(requestedSessionId)
        : await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
      if (!session) {
        throw new RuntimeRequestError("not_found", `Session not found: ${requestedSessionId}`);
      }
      const context = {
        ...webGatewayContext,
        session_key: session.session_key
      };
      const createdEnvelope = createGatewayEnvelope(
        context,
        content,
        supportedLocalePayload(payload.input_locale),
        supportedLocalePayload(payload.output_locale),
        recordPayload(payload.metadata)
      );
      const envelopeId = stringPayload(payload.envelope_id) || stringPayload(payload.input_message_id);
      const envelope = envelopeId ? { ...createdEnvelope, id: envelopeId } : createdEnvelope;
      return this.runAllowedWrite<MemoryFrontmatter, Record<string, unknown>>({
        session,
        envelope,
        context,
        operationName: command.id,
        proposedEffects: command.proposed_effects,
        execute: async (operation) => {
          const memory = await createTopicMemory(this.store, envelope, stringPayload(payload.topic_kind) || "preference", content);
          const ref = memoryRef(memory);
          const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { memory_id: memory.id });
          await this.emit("memory.candidate.created", memory);
          return {
            resource: memory,
            ref,
            rollbackPoint,
            summary: `Created topic memory ${memory.topic}.`
          };
        }
      });
    }

    if (command.id === "memory.archive") {
      const sessionId = stringPayload(payload.session_id);
      if (!sessionId) {
        throw new RuntimeRequestError("conflict", "domain_command_memory_archive_session_id_required");
      }
      return this.archiveMemory({ memoryId: requiredPayloadId(payload, "memory_id"), sessionId });
    }

    if (command.id === "rollback.restore") {
      return this.restoreRollbackPoint(requiredPayloadId(payload, "rollback_point_id"));
    }

    if (command.id === "collection.record.create") {
      const collectionId = stringPayload(payload.collection_id);
      if (!collectionId) {
        throw new RuntimeRequestError("conflict", "domain_command_collection_id_required");
      }
      const now = nowIso();
      return this.createCollectionRecord({
        id: stringPayload(payload.record_id) || stringPayload(payload.id) || createId("collection_record"),
        collection_id: collectionId,
        data: recordPayload(payload.data),
        resource_refs: resourceRefsPayload(payload.resource_refs),
        created_at: now,
        updated_at: now
      });
    }

    if (command.id === "collection.view.present") {
      const collectionId = stringPayload(payload.collection_id);
      if (!collectionId) {
        throw new RuntimeRequestError("conflict", "domain_command_collection_id_required");
      }
      return this.presentCollectionView({
        collectionId,
        viewId: stringPayload(payload.view_id) || undefined
      });
    }

    if (command.id === "collection.patch.apply") {
      const collectionId = stringPayload(payload.collection_id);
      const recordId = stringPayload(payload.record_id);
      if (!collectionId || !recordId) {
        throw new RuntimeRequestError("conflict", "domain_command_collection_patch_target_required");
      }
      return this.applyCollectionPatch({
        collectionId,
        recordId,
        patch: {
          id: stringPayload(payload.patch_id) || stringPayload(payload.id) || createId("collection_patch"),
          record_id: recordId,
          changes: recordPayload(payload.changes),
          source_operation_id: stringPayload(payload.source_operation_id) || createId("domain_command"),
          created_at: nowIso()
        }
      });
    }

    if (command.id === "collection.record.delete") {
      const collectionId = stringPayload(payload.collection_id);
      const recordId = stringPayload(payload.record_id);
      if (!collectionId || !recordId) {
        throw new RuntimeRequestError("conflict", "domain_command_collection_delete_target_required");
      }
      return this.deleteCollectionRecord({
        collectionId,
        recordId,
        viewId: stringPayload(payload.view_id) || undefined
      });
    }

    if (command.id === "collection.schema.save") {
      return this.saveCollectionSchema(CollectionSchemaSchema.parse(payload));
    }

    if (command.id === "collection.action.run") {
      return this.runCollectionAction({
        collectionId: stringPayload(payload.collection_id),
        actionId: stringPayload(payload.action_id),
        recordId: stringPayload(payload.record_id) || undefined,
        payload: recordPayload(payload.payload)
      });
    }

    if (command.id === "collection.reindex") {
      return this.reindexCollections();
    }

    if (command.id === "wiki.proposal.create") {
      const title = stringPayload(payload.title);
      const content = stringPayload(payload.content);
      if (!title || !content) {
        throw new RuntimeRequestError("conflict", "domain_command_wiki_title_content_required");
      }
      return this.createWikiProposal({
        title,
        content,
        slug: stringPayload(payload.slug) || undefined,
        tags: domainStringArrayPayload(payload.tags),
        content_locale: supportedLocalePayload(payload.content_locale),
        source_refs: wikiSourceRefsPayload(payload.source_refs),
        provenance: wikiProvenancePayload(payload.provenance)
      });
    }

    if (command.id === "wiki.accept") {
      return this.acceptWikiPage(requiredPayloadId(payload, "wiki_id"));
    }
    if (command.id === "wiki.reject") {
      return this.rejectWikiPage(requiredPayloadId(payload, "wiki_id"));
    }
    if (command.id === "wiki.archive") {
      return this.archiveWikiPage(requiredPayloadId(payload, "wiki_id"));
    }
    if (command.id === "wiki.patch") {
      return this.patchWikiPage({
        id: requiredPayloadId(payload, "wiki_id"),
        title: stringPayload(payload.title) || undefined,
        content: typeof payload.content === "string" ? payload.content : undefined,
        tags: Array.isArray(payload.tags) ? domainStringArrayPayload(payload.tags) : undefined,
        content_locale: supportedLocalePayload(payload.content_locale),
        source_refs: wikiSourceRefsPayload(payload.source_refs),
        provenance: wikiProvenancePayload(payload.provenance)
      });
    }
    if (command.id === "wiki.reindex") {
      return this.reindexWiki();
    }

    if (command.id === "skill.candidate.create") {
      const title = stringPayload(payload.title);
      const content = stringPayload(payload.content);
      if (!title || !content) {
        throw new RuntimeRequestError("conflict", "domain_command_skill_title_content_required");
      }
      return this.createSkillCandidate({
        title,
        description: stringPayload(payload.description) || summarize(content),
        content,
        tags: domainStringArrayPayload(payload.tags),
        required_capabilities: domainStringArrayPayload(payload.required_capabilities),
        source_refs: skillSourceRefsPayload(payload.source_refs),
        provenance_detail: skillProvenancePayload(payload.provenance_detail)
      });
    }
    if (command.id === "skill.project.save") {
      return this.saveSkillProject({ candidateId: requiredPayloadId(payload, "candidate_id") });
    }
    if (command.id === "skill.support_file.save") {
      const skillId = requiredPayloadId(payload, "skill_id");
      const supportPath = stringPayload(payload.path);
      const content = stringPayload(payload.content);
      if (!supportPath) {
        throw new RuntimeRequestError("conflict", "domain_command_skill_support_path_required");
      }
      return this.saveSkillSupportFile({ skillId, path: supportPath, content });
    }
    if (command.id === "skill.lifecycle.apply") {
      const action = stringPayload(payload.action);
      if (!isCuratorLifecycleApplyAction(action)) {
        throw new RuntimeRequestError("conflict", "domain_command_skill_lifecycle_action_required");
      }
      return this.applyCuratorSkillAction({ skillId: requiredPayloadId(payload, "skill_id"), action });
    }

    if (command.id === "file.read" || command.id === "file.list" || command.id === "file.write" || command.id === "file.patch") {
      return this.runFileAction({
        operation: command.id,
        path: stringPayload(payload.path),
        content: typeof payload.content === "string" ? payload.content : undefined,
        search: typeof payload.search === "string" ? payload.search : undefined,
        replace: typeof payload.replace === "string" ? payload.replace : undefined
      });
    }

    if (command.id === "browser.navigate" || command.id === "browser.extract" || command.id === "browser.screenshot" || command.id === "browser.download_to_workspace") {
      return this.runBrowserAction({
        operation: command.id,
        url: stringPayload(payload.url),
        output_path: stringPayload(payload.output_path) || undefined
      });
    }

    if (command.id === "external.send.prepare") {
      const channel = externalSendChannelPayload(payload.channel);
      return this.prepareExternalSend({
        channel,
        target: recordPayload(payload.target),
        title: stringPayload(payload.title),
        body: stringPayload(payload.body)
      });
    }
    if (command.id === "external.send") {
      const body = stringPayload(payload.body) || stringPayload(payload.content) || stringPayload(payload.user_intent) || "External send requested by backend.";
      return this.prepareExternalSend({
        channel: externalSendChannelPayload(payload.channel),
        target: recordPayload(payload.target),
        title: stringPayload(payload.title) || "External send request",
        body
      });
    }
    if (command.id === "external.send.dispatch") {
      return this.dispatchExternalSend({
        sendId: stringPayload(payload.send_id) || stringPayload(payload.sendId),
        dryRun: booleanPayload(payload.dry_run)
      });
    }

    if (command.id === "automation.job.save") {
      return this.saveAutomationJob({
        title: stringPayload(payload.title),
        kind: automationJobKindPayload(payload.kind),
        schedule: stringPayload(payload.schedule),
        target_instruction: stringPayload(payload.target_instruction),
        delivery_target: recordPayload(payload.delivery_target),
        enabled: booleanPayload(payload.enabled),
        next_run_at: stringPayload(payload.next_run_at) || undefined,
        max_attempts: numberPayload(payload.max_attempts)
      });
    }
    if (command.id === "automation.job.run") {
      const jobId = requiredPayloadId(payload, "job_id");
      const job = await this.store.getAutomationJob(jobId);
      if (!job) {
        throw new RuntimeRequestError("not_found", `Automation job not found: ${jobId}`);
      }
      const now = stringPayload(payload.now) || nowIso();
      const locked = await this.store.acquireAutomationJobLock(job.id, {
        lockedUntil: new Date(Date.parse(now) + 15 * 60_000).toISOString(),
        now
      });
      if (!locked) {
        throw new RuntimeRequestError("conflict", "automation_job_locked");
      }
      return this.runAutomationJob(locked, now);
    }
    if (command.id === "automation.memory_review.run") {
      return this.runMemoryReviewAutomation();
    }

    if (command.id === "reflection.suggestion.apply") {
      return this.applyReflectionSuggestion({ suggestionId: stringPayload(payload.suggestion_id) || stringPayload(payload.id) });
    }

    if (command.id === "grant.create") {
      return this.createGrant({
        capabilityId: stringPayload(payload.capability_id) || undefined,
        operation: stringPayload(payload.operation),
        actorIdentity: actorIdentityPayload(payload.actor_identity),
        channel: stringPayload(payload.channel) || undefined,
        resourceScope: stringPayload(payload.resource_scope) || undefined,
        grantedBy: stringPayload(payload.granted_by) || undefined,
        reason: stringPayload(payload.reason) || undefined,
        expiresAt: stringPayload(payload.expires_at) || undefined
      });
    }
    if (command.id === "grant.revoke") {
      return this.revokeGrant({
        grantId: requiredPayloadId(payload, "grant_id"),
        revokedBy: stringPayload(payload.revoked_by) || undefined,
        reason: stringPayload(payload.reason) || undefined
      });
    }
    if (command.id === "workspace.delete") {
      const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
      const targetInstruction = stringPayload(payload.target_instruction)
        || stringPayload(payload.content)
        || stringPayload(payload.resource_id)
        || "workspace resource";
      const envelope = createGatewayEnvelope(webGatewayContext, `Request workspace delete: ${targetInstruction}`);
      const explicitTargetRef = resourceRefFromJson(payload.resource_ref);
      const targetResourceRefs = explicitTargetRef
        ? [explicitTargetRef]
        : resourceRefsPayload(payload.resource_refs);
      const operation = await this.createOperation(session, envelope, command.id, command.proposed_effects, {
        context: webGatewayContext,
        targetResourceRefs
      });
      const decision = await this.savePolicyDecision(evaluatePolicy({
        input: this.createPolicyInput(operation),
        manifest: getCapabilityManifest(operation.capability_id),
        grants: await this.store.listGrants(),
        operationId: operation.id
      }));
      operation.policy_decision_id = decision.id;
      operation.status = decision.decision === "deny" ? "denied" : "deferred";
      operation.result_ref = targetResourceRefs[0] ?? {
        kind: "workspace_resource",
        id: stableHash(targetInstruction),
        uri: `workspace/delete-requests/${stableHash(targetInstruction)}`,
        label: targetInstruction
      };
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      const auditRecord = await this.auditOperation(
        operation,
        decision,
        decision.decision === "deny"
          ? "Workspace delete request denied by policy."
          : "Workspace delete request recorded; v1 does not execute deletion.",
        targetResourceRefs,
        undefined
      );
      return {
        operation,
        policyDecision: decision,
        auditRecord,
        activity: await this.rebuildActivity(),
        status: operation.status
      };
    }
    if (command.id === "sandbox.exec" || command.id === "mcp.call") {
      throw new RuntimeRequestError("conflict", `domain_command_requires_backend_tool_context:${command.id}`);
    }

    throw new RuntimeRequestError("conflict", `domain_command_not_executable:${command.id}`);
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

  private async runStructuredSurfaceOperation(input: StructuredSurfaceOperation): Promise<SurfaceOperationRuntimeResult> {
    if (!input.session_id) {
      throw new RuntimeRequestError("conflict", "surface_operation_session_required");
    }
    const session = await this.store.getSession(input.session_id);
    if (!session) {
      throw new RuntimeRequestError("not_found", `Session not found: ${input.session_id}`);
    }

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
    const envelope = createGatewayEnvelope(webGatewayContext, surfaceOperationPrompt(input), inputLocale, outputLocale, {
      ...(input.metadata ?? {}),
      surface_operation_id: input.id,
      surface_operation_kind: input.kind,
      surface_operation_payload: jsonSafe(input),
      ...(sourceArtifact ? { source_artifact_id: sourceArtifact.id, source_artifact_uri: sourceArtifact.file_ref.uri } : {})
    });

    const result = await this.runAllowedWrite<ArtifactRecord, { sourceArtifact?: ArtifactRecord; workspaceChange: WorkspaceChangeRecord }>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "artifact.create",
      proposedEffects: [surfaceOperationEffect(input)],
      inputRef: surfaceOperationRef(input),
      targetResourceRefs: sourceArtifact ? [sourceArtifact.file_ref] : [],
      execute: async (operation) => {
        const artifact = await createArtifactDraft({
          store: this.store,
          operation,
          title: surfaceOperationArtifactTitle(input, sourceArtifact),
          content: surfaceOperationArtifactContent(input, sourceArtifact, sourceContent),
          kind: surfaceOperationArtifactKind(input),
          locale: outputLocale,
          sourceLocales: [inputLocale],
          createdBy: "surface_operation",
          metadata: surfaceOperationArtifactMetadata(input, sourceArtifact, sourceContent)
        });
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [artifact.file_ref],
          sourceArtifact ? { source_artifact: sourceArtifact as unknown as JsonValue } : {},
          {
            artifact_id: artifact.id,
            surface_operation_id: input.id,
            surface_operation_kind: input.kind
          }
        );
        const surfaceRun = await this.store.saveBackendRun({
          id: createId("run"),
          session_id: session.id,
          input_message_id: input.id,
          backend_id: "surface-operation",
          backend_kind: "samurai_native",
          status: "completed",
          started_at: operation.created_at,
          completed_at: nowIso(),
          input_summary: summarize(surfaceOperationPrompt(input), 220),
          output_summary: surfaceOperationWorkspaceSummary(input, artifact),
          metadata: {
            surface_operation_id: input.id,
            surface_operation_kind: input.kind,
            operation_id: operation.id
          }
        });
        const workspaceChange: WorkspaceChangeRecord = {
          id: createId("change"),
          run_id: surfaceRun.id,
          session_id: session.id,
          resource_ref: artifact.file_ref,
          change_type: "artifact_created",
          summary: surfaceOperationWorkspaceSummary(input, artifact),
          legacy_operation_id: operation.id,
          created_at: nowIso()
        };
        await this.store.saveWorkspaceChange(workspaceChange);
        return {
          resource: artifact,
          ref: artifact.file_ref,
          rollbackPoint,
          workspaceChange,
          ...(sourceArtifact ? { sourceArtifact } : {}),
          summary: surfaceOperationWorkspaceSummary(input, artifact)
        };
      }
    });

    return {
      operation: input,
      result_kind: surfaceOperationResultKind(input),
      render_spec: negotiatedRenderSpec(input, surfaceArtifactRenderSpec(input, result.resource, result)),
      result
    };
  }

  async approveRequest(approvalRequestId: string, decidedBy = "owner"): Promise<ApprovalLifecycleResult> {
    const approval = await this.store.getApprovalRequest(approvalRequestId);
    if (!approval) {
      throw new RuntimeRequestError("not_found", `Approval request not found: ${approvalRequestId}`);
    }
    const operation = await this.store.getOperation(approval.operation_id);
    if (!operation) {
      throw new RuntimeRequestError("not_found", `Operation not found: ${approval.operation_id}`);
    }

    this.assertApprovalCanBeDecided(approval, operation);

    if (Date.parse(approval.expires_at) <= Date.now()) {
      const result = await this.expireApprovalRequest(approval, operation, decidedBy);
      throw new RuntimeRequestError("conflict", "Approval request expired.", result);
    }

    const savedDecision = await this.getSavedDecisionForApproval(operation);
    const manifest = getCapabilityManifest(operation.capability_id);
    const decision = await this.savePolicyDecision(evaluatePolicy({
      input: savedDecision.policy_inputs,
      manifest,
      grants: await this.store.listGrants(),
      operationId: operation.id
    }));

    const approved: ApprovalRequest = {
      ...approval,
      status: decision.decision === "deny" ? "cancelled" : "approved",
      decided_by: decidedBy,
      decided_at: nowIso()
    };
    await this.store.updateApprovalRequest(approved);

    if (decision.decision !== "deny" && operation.operation === "external.send.dispatch") {
      return this.executeApprovedExternalDispatch(approved, operation, decision);
    }

    operation.policy_decision_id = decision.id;
    operation.status = decision.decision === "deny" ? "denied" : "deferred";
    operation.result_ref = {
      kind: "approval",
      id: approved.id,
      uri: `approval_requests/${approved.id}`,
      label: decision.decision === "deny" ? "Approval cancelled by policy" : "Approved without external execution"
    };
    operation.updated_at = nowIso();
    await this.store.updateOperation(operation);

    const audit = await this.auditOperation(
      operation,
      decision,
      decision.decision === "deny"
        ? "Approval was cancelled because policy re-evaluation denied the operation."
        : "Approval accepted. v1 deferred the external effect and recorded audit only.",
      [],
      undefined
    );
    return {
      approvalRequest: approved,
      operation,
      auditRecord: audit,
      activity: await this.rebuildActivity(),
      status: decision.decision === "deny" ? "denied" : "approved"
    };
  }

  async denyRequest(approvalRequestId: string, decidedBy = "owner", reason = "Denied by owner."): Promise<ApprovalLifecycleResult> {
    const approval = await this.store.getApprovalRequest(approvalRequestId);
    if (!approval) {
      throw new RuntimeRequestError("not_found", `Approval request not found: ${approvalRequestId}`);
    }
    const operation = await this.store.getOperation(approval.operation_id);
    if (!operation) {
      throw new RuntimeRequestError("not_found", `Operation not found: ${approval.operation_id}`);
    }

    this.assertApprovalCanBeDecided(approval, operation);

    if (Date.parse(approval.expires_at) <= Date.now()) {
      const result = await this.expireApprovalRequest(approval, operation, decidedBy);
      throw new RuntimeRequestError("conflict", "Approval request expired.", result);
    }

    const savedDecision = await this.getSavedDecisionForApproval(operation);
    const denied: ApprovalRequest = {
      ...approval,
      status: "denied",
      reason: reason.trim() || approval.reason,
      decided_by: decidedBy,
      decided_at: nowIso()
    };
    await this.store.updateApprovalRequest(denied);

    operation.status = "denied";
    operation.result_ref = {
      kind: "approval",
      id: denied.id,
      uri: `approval_requests/${denied.id}`,
      label: "Denied by owner"
    };
    operation.updated_at = nowIso();
    await this.store.updateOperation(operation);

    const audit = await this.auditOperation(operation, savedDecision, "Approval was denied. No external effect executed.", [], undefined);
    return {
      approvalRequest: denied,
      operation,
      auditRecord: audit,
      activity: await this.rebuildActivity(),
      status: "denied"
    };
  }

  async archiveMemory(input: ArchiveMemoryInput): Promise<ArchiveMemoryRuntimeResult> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) {
      throw new RuntimeRequestError("not_found", `Session not found: ${input.sessionId}`);
    }

    const memory = await this.store.getMemory(input.memoryId);
    if (!memory) {
      throw new RuntimeRequestError("not_found", `Memory not found: ${input.memoryId}`);
    }

    const sessionMemory = await this.store.listMemoryForSession(session.id, { includeArchived: true });
    if (!sessionMemory.some((item) => item.id === input.memoryId)) {
      throw new RuntimeRequestError("conflict", "memory_not_in_session");
    }

    const operation = await this.createMemoryArchiveOperation(session, memory, input.actorIdentity ?? "owner", input.decidedBy ?? "owner");
    const manifest = getCapabilityManifest(operation.capability_id);
    const decision = await this.savePolicyDecision(evaluatePolicy({
      input: this.createPolicyInput(operation),
      manifest,
      grants: await this.store.listGrants(),
      operationId: operation.id
    }));
    operation.policy_decision_id = decision.id;

    if (decision.decision === "deny") {
      operation.status = "denied";
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      const audit = await this.auditOperation(operation, decision, "Memory archive denied by policy.", [memoryRef(memory)], undefined);
      const activity = await this.rebuildActivity();
      throw new RuntimeRequestError("forbidden", "policy_denied", {
        memory,
        content: (await this.store.readMemoryContent(input.memoryId)) ?? "",
        operation,
        auditRecord: audit,
        activity,
        changed: false
      });
    }

    if (decision.decision !== "allow_auto" && decision.decision !== "allow_with_audit") {
      operation.status = "denied";
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      const audit = await this.auditOperation(operation, decision, "Memory archive requires approval and was not executed in this endpoint.", [memoryRef(memory)], undefined);
      const activity = await this.rebuildActivity();
      throw new RuntimeRequestError("forbidden", "policy_denied", {
        memory,
        content: (await this.store.readMemoryContent(input.memoryId)) ?? "",
        operation,
        auditRecord: audit,
        activity,
        changed: false
      });
    }

    const archive = await this.store.archiveMemory(input.memoryId);
    if (!archive) {
      throw new RuntimeRequestError("not_found", `Memory not found: ${input.memoryId}`);
    }

    const archivedMemory = {
      ...archive.after.frontmatter,
      file_path: archive.after.file_path
    };
    const ref = memoryRef(archivedMemory);
    let rollbackPoint: RollbackPoint | undefined;
    if (archive.changed) {
      rollbackPoint = await this.createRollbackPoint(
        operation,
        [ref],
        { memory: archive.before as unknown as JsonValue },
        { memory: archive.after as unknown as JsonValue }
      );
    }

    operation.status = "completed";
    operation.result_ref = ref;
    operation.updated_at = nowIso();
    await this.store.updateOperation(operation);

    const summary = archive.changed
      ? `Archived memory ${archive.after.frontmatter.topic}.${archive.warning ? ` Warning: ${archive.warning}` : ""}`
      : `Memory ${archive.after.frontmatter.topic} was already archived.`;
    const audit = await this.auditOperation(operation, decision, summary, [ref], rollbackPoint?.id);
    const activity = await this.rebuildActivity();

    return {
      memory: archivedMemory,
      content: archive.content,
      operation,
      auditRecord: audit,
      rollbackPoint,
      activity,
      changed: archive.changed,
      warning: archive.warning
    };
  }

  async runFileAction(input: {
    operation: "file.read" | "file.list" | "file.write" | "file.patch";
    path: string;
    content?: string;
    search?: string;
    replace?: string;
  }): Promise<FileActionRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const workspacePath = this.resolveWorkspacePath(input.path);
    const envelope = createGatewayEnvelope(webGatewayContext, `${input.operation}: ${workspacePath.relativePath}`);
    return this.runAllowedWrite<FileActionResource, Record<string, unknown>>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: input.operation,
      proposedEffects: [`${input.operation} ${workspacePath.relativePath} inside the workspace.`],
      targetResourceRefs: [fileRef(workspacePath.relativePath)],
      execute: async (operation) => {
        const ref = fileRef(workspacePath.relativePath);
        if (input.operation === "file.read") {
          const content = await readFile(workspacePath.absolutePath, "utf8");
          return {
            resource: { path: workspacePath.relativePath, content },
            ref,
            summary: `Read workspace file ${workspacePath.relativePath}.`
          };
        }
        if (input.operation === "file.list") {
          const entries = await listWorkspaceDirectory(workspacePath.absolutePath, workspacePath.relativePath);
          return {
            resource: { path: workspacePath.relativePath, entries },
            ref,
            summary: `Listed workspace directory ${workspacePath.relativePath}.`
          };
        }
        const before = await readFile(workspacePath.absolutePath, "utf8").catch(() => undefined);
        let nextContent = input.content ?? "";
        if (input.operation === "file.patch") {
          if (before === undefined) {
            throw new RuntimeRequestError("not_found", `File not found: ${workspacePath.relativePath}`);
          }
          const search = input.search ?? "";
          if (!search || !before.includes(search)) {
            throw new RuntimeRequestError("conflict", "file_patch_search_not_found");
          }
          nextContent = before.replace(search, input.replace ?? "");
        }
        await mkdir(path.dirname(workspacePath.absolutePath), { recursive: true });
        await writeFile(workspacePath.absolutePath, nextContent);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { path: workspacePath.relativePath, content: before ?? null },
          { path: workspacePath.relativePath, content: nextContent }
        );
        return {
          resource: { path: workspacePath.relativePath, content: nextContent },
          ref,
          rollbackPoint,
          summary: `${input.operation === "file.write" ? "Wrote" : "Patched"} workspace file ${workspacePath.relativePath}.`
        };
      }
    });
  }

  async restoreRollbackPoint(id: string): Promise<RollbackRestoreRuntimeResult> {
    const point = await this.store.getRollbackPoint(id);
    if (!point) {
      throw new RuntimeRequestError("not_found", `Rollback point not found: ${id}`);
    }
    if (!point.reversible) {
      throw new RuntimeRequestError("conflict", "rollback_not_reversible");
    }
    if (Date.parse(point.expires_at) < Date.now()) {
      throw new RuntimeRequestError("conflict", "rollback_expired");
    }
    const snapshot = fileRollbackSnapshot(point.before_snapshot);
    if (!snapshot) {
      throw new RuntimeRequestError("conflict", "rollback_restore_unsupported_snapshot");
    }
    const workspacePath = this.resolveWorkspacePath(snapshot.path);
    if (workspacePath.relativePath === ".") {
      throw new RuntimeRequestError("forbidden", "rollback_restore_requires_file_path");
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `rollback.restore: ${point.id}`);
    const ref = fileRef(workspacePath.relativePath);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "rollback.restore",
      proposedEffects: [`Restore rollback point ${point.id} for ${workspacePath.relativePath}.`],
      targetResourceRefs: [ref],
      execute: async (operation) => {
        const current = await readFile(workspacePath.absolutePath, "utf8").catch(() => undefined);
        if (snapshot.content === null) {
          await rm(workspacePath.absolutePath, { force: true });
        } else {
          await mkdir(path.dirname(workspacePath.absolutePath), { recursive: true });
          await writeFile(workspacePath.absolutePath, snapshot.content);
        }
        const restoreRollback = await this.createRollbackPoint(
          operation,
          [ref],
          { path: workspacePath.relativePath, content: current ?? null },
          { path: workspacePath.relativePath, content: snapshot.content }
        );
        return {
          resource: {
            rollback_point_id: point.id,
            path: workspacePath.relativePath,
            action: snapshot.content === null ? "deleted" : "written"
          },
          ref,
          rollbackPoint: restoreRollback,
          summary: `Restored rollback point ${point.id} for ${workspacePath.relativePath}.`
        };
      }
    });
  }

  async runBrowserAction(input: {
    operation: "browser.navigate" | "browser.extract" | "browser.screenshot" | "browser.download_to_workspace";
    url: string;
    output_path?: string;
  }): Promise<BrowserActionRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `${input.operation}: ${input.url}`);
    return this.runAllowedWrite<BrowserActionResource, Record<string, unknown>>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: input.operation,
      proposedEffects: [`${input.operation} ${input.url} without mutating external state.`],
      execute: async (operation) => {
        const page = await readBrowserPage(input.url);
        const ref = {
          kind: "browser_page",
          id: stableHash(input.url),
          uri: input.url,
          label: page.title || input.url
        };
        if (input.operation === "browser.download_to_workspace" || input.operation === "browser.screenshot") {
          const outputPath = input.output_path || path.posix.join("browser", `${stableHash(input.url)}.${input.operation === "browser.screenshot" ? "html" : "txt"}`);
          const workspacePath = this.resolveWorkspacePath(outputPath);
          await mkdir(path.dirname(workspacePath.absolutePath), { recursive: true });
          const content = input.operation === "browser.screenshot"
            ? renderBrowserSnapshotHtml(page)
            : page.text;
          const before = await readFile(workspacePath.absolutePath, "utf8").catch(() => undefined);
          await writeFile(workspacePath.absolutePath, content);
          const fileResourceRef = fileRef(workspacePath.relativePath);
          const rollbackPoint = await this.createRollbackPoint(
            operation,
            [fileResourceRef],
            { path: workspacePath.relativePath, content: before ?? null },
            { path: workspacePath.relativePath, content }
          );
          return {
            resource: {
              url: input.url,
              title: page.title,
              text: page.text,
              file_path: workspacePath.relativePath,
              ...(input.operation === "browser.screenshot" ? { screenshot_ref: workspacePath.relativePath } : {})
            },
            ref: fileResourceRef,
            rollbackPoint,
            summary: input.operation === "browser.screenshot"
              ? `Saved browser snapshot fallback for ${input.url}.`
              : `Downloaded browser content from ${input.url} into workspace.`
          };
        }
        return {
          resource: { url: input.url, title: page.title, text: page.text },
          ref,
          summary: `Read browser page ${input.url}.`
        };
      }
    });
  }

  async prepareExternalSend(input: {
    channel: ExternalSendRecord["channel"];
    target: Record<string, JsonValue>;
    title: string;
    body: string;
  }): Promise<ExternalSendRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Prepare external send: ${input.title}`);
    const now = nowIso();
    const draft: ExternalSendRecord = {
      id: createId("send"),
      channel: input.channel,
      status: "draft",
      target: input.target,
      title: input.title,
      body: input.body,
      created_at: now,
      updated_at: now
    };
    return this.runAllowedWrite<ExternalSendRecord, Record<string, unknown>>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "external.send.prepare",
      proposedEffects: ["Create an outbound send draft without dispatching."],
      execute: async (operation) => {
        const send = await this.store.saveExternalSend({ ...draft, operation_id: operation.id });
        const ref = externalSendRef(send);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { external_send: send as unknown as JsonValue });
        return { resource: send, ref, rollbackPoint, summary: `Prepared external send draft ${send.title}.` };
      }
    });
  }

  async createGrant(input: {
    capabilityId?: string;
    operation: string;
    actorIdentity?: GrantRecord["actor_identity"];
    channel?: string;
    resourceScope?: string;
    grantedBy?: string;
    reason?: string;
    expiresAt?: string;
  }): Promise<GrantRuntimeResult> {
    const capabilityId = input.capabilityId ?? proposalCapabilityManifest.id;
    const manifest = getCapabilityManifest(capabilityId);
    if (!manifest) {
      throw new RuntimeRequestError("not_found", `Capability manifest not found: ${capabilityId}`);
    }
    const capabilityOperation = manifest.operations.find((item) => item.operation === input.operation);
    if (!capabilityOperation) {
      throw new RuntimeRequestError("not_found", `Capability operation not found: ${input.operation}`);
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Create grant: ${capabilityId}/${input.operation}`);
    const now = nowIso();
    const grant: GrantRecord = {
      id: createId("grant"),
      capability_id: capabilityId,
      operation: input.operation,
      actor_identity: input.actorIdentity ?? "owner",
      channel: input.channel ?? "web",
      resource_scope: input.resourceScope ?? "*",
      manifest_version: manifest.version,
      risk_snapshot: capabilityOperation.risk,
      scope_snapshot: capabilityOperation.scope,
      external_impact_snapshot: capabilityOperation.external_impact,
      secret_requirement_snapshot: capabilityOperation.secret_requirement,
      granted_by: input.grantedBy ?? "owner",
      reason: input.reason?.trim() || `Grant ${input.operation} for ${input.actorIdentity ?? "owner"}.`,
      created_at: now,
      expires_at: input.expiresAt
    };
    return this.runAllowedWrite<GrantRecord, Record<string, unknown>>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "grant.create",
      proposedEffects: [`Create grant ${grant.id} for ${grant.capability_id}/${grant.operation}.`],
      targetResourceRefs: [grantRef(grant)],
      execute: async (operation) => {
        const saved = await this.store.saveGrant(grant);
        const ref = grantRef(saved);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { grant: saved as unknown as JsonValue });
        return { resource: saved, ref, rollbackPoint, summary: `Created grant ${saved.id} for ${saved.operation}.` };
      }
    });
  }

  async revokeGrant(input: {
    grantId: string;
    revokedBy?: string;
    reason?: string;
  }): Promise<GrantRuntimeResult> {
    const existing = await this.store.getGrant(input.grantId);
    if (!existing) {
      throw new RuntimeRequestError("not_found", `Grant not found: ${input.grantId}`);
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Revoke grant: ${existing.id}`);
    return this.runAllowedWrite<GrantRecord, Record<string, unknown>>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "grant.revoke",
      proposedEffects: [`Revoke grant ${existing.id} for ${existing.capability_id}/${existing.operation}.`],
      inputRef: grantRef(existing),
      targetResourceRefs: [grantRef(existing)],
      execute: async (operation) => {
        if (existing.revoked_at) {
          return {
            resource: existing,
            ref: grantRef(existing),
            summary: `Grant ${existing.id} was already revoked.`
          };
        }
        const revoked = await this.store.revokeGrant(existing.id, nowIso()) ?? existing;
        const ref = grantRef(revoked);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { grant: existing as unknown as JsonValue },
          { grant: revoked as unknown as JsonValue, revoked_by: input.revokedBy ?? "owner", reason: input.reason ?? "" }
        );
        return { resource: revoked, ref, rollbackPoint, summary: `Revoked grant ${revoked.id}.` };
      }
    });
  }

  async dispatchExternalSend(input: { sendId: string; dryRun?: boolean } ): Promise<ExternalSendRuntimeResult> {
    const existing = await this.store.getExternalSend(input.sendId);
    if (!existing) {
      throw new RuntimeRequestError("not_found", `External send not found: ${input.sendId}`);
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Dispatch external send: ${existing.title}`);
    return this.runAllowedWrite<ExternalSendRecord, Record<string, unknown>>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "external.send.dispatch",
      proposedEffects: ["Dispatch a prepared outbound send to an external channel."],
      inputRef: externalSendRef(existing),
      targetResourceRefs: [externalSendRef(existing)],
      execute: async (operation) => {
        const result = await dispatchExternalSendAdapter(existing, input.dryRun ?? process.env.SAMURAI_EXTERNAL_SEND_DISPATCH !== "true");
        const now = nowIso();
        const next: ExternalSendRecord = {
          ...existing,
          status: externalSendStatusFromDispatchResult(result),
          operation_id: operation.id,
          dispatch_result: result as Record<string, JsonValue>,
          updated_at: now,
          dispatched_at: result.dispatched ? now : undefined
        };
        const saved = await this.store.saveExternalSend(next);
        const ref = externalSendRef(saved);
        return { resource: saved, ref, summary: externalSendDispatchSummary(saved, result) };
      }
    });
  }

  async approveGatewayPairing(id: string): Promise<GatewayPairingRecord> {
    const pairing = await this.store.getGatewayPairing(id);
    if (!pairing) {
      throw new RuntimeRequestError("not_found", `Gateway pairing not found: ${id}`);
    }
    const freshPairing = expirePairing(pairing);
    if (freshPairing.status === "expired") {
      await this.store.saveGatewayPairing(freshPairing);
      await this.emit("gateway.pairing.updated", freshPairing);
      return freshPairing;
    }
    const approved = approvePairing(freshPairing);
    await this.store.saveGatewayPairing(approved);
    await this.emit("gateway.pairing.updated", approved);
    return approved;
  }

  async rejectGatewayPairing(id: string): Promise<GatewayPairingRecord> {
    const pairing = await this.store.getGatewayPairing(id);
    if (!pairing) {
      throw new RuntimeRequestError("not_found", `Gateway pairing not found: ${id}`);
    }
    const rejected = rejectPairing(pairing);
    await this.store.saveGatewayPairing(rejected);
    await this.emit("gateway.pairing.updated", rejected);
    return rejected;
  }

  async expireGatewayPairings(now = nowIso()): Promise<GatewayPairingRecord[]> {
    const expired = await this.store.expireGatewayPairings(now);
    for (const pairing of expired) {
      await this.emit("gateway.pairing.updated", pairing);
    }
    return expired;
  }

  async listGatewayPairingPolicies(): Promise<GatewayPairingPolicyRecord[]> {
    const saved = await this.store.listGatewayPairingPolicies();
    const byChannel = new Map(saved.map((policy) => [policy.channel, policy]));
    return gatewayPairingPolicyChannels.map((channel) => byChannel.get(channel) ?? createDefaultRuntimeGatewayPairingPolicy(channel));
  }

  async getGatewayPairingPolicy(channel: GatewayPairingPolicyRecord["channel"]): Promise<GatewayPairingPolicyRecord> {
    return (await this.store.getGatewayPairingPolicy(channel)) ?? createDefaultRuntimeGatewayPairingPolicy(channel);
  }

  async saveGatewayPairingPolicy(policy: GatewayPairingPolicyRecord): Promise<GatewayPairingPolicyRecord> {
    const saved = await this.store.saveGatewayPairingPolicy(policy);
    await this.emit("gateway.pairing_policy.saved", saved);
    return saved;
  }

  async listGatewayRoutingPolicies(): Promise<GatewayRoutingPolicyRecord[]> {
    const saved = await this.store.listGatewayRoutingPolicies();
    const byChannel = new Map(saved.map((policy) => [policy.channel, policy]));
    return gatewayRoutingPolicyChannels.map((channel) => byChannel.get(channel) ?? createDefaultGatewayRoutingPolicy(channel));
  }

  async getGatewayRoutingPolicy(channel: GatewayRoutingPolicyRecord["channel"]): Promise<GatewayRoutingPolicyRecord> {
    return (await this.store.getGatewayRoutingPolicy(channel)) ?? createDefaultGatewayRoutingPolicy(channel);
  }

  async saveGatewayRoutingPolicy(policy: GatewayRoutingPolicyRecord): Promise<GatewayRoutingPolicyRecord> {
    const saved = await this.store.saveGatewayRoutingPolicy(policy);
    await this.emit("gateway.routing_policy.saved", saved);
    return saved;
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
      this.expireGatewayPairings(checkedAt),
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
    const workspaceRoot = instance.workspace_root ?? this.store.rootDir;
    const remoteWorkspaceRoot = remoteWorkspaceRootForSandboxInstance(instance);
    const execution = dryRun
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
        createSandboxWorkspaceSyncAdapter()
      );
    const sync: GatewaySandboxWorkspaceSyncRecord = {
      id: createId("gateway_sandbox_sync"),
      instance_id: instance.id,
      instance_key: instance.instance_key,
      direction,
      status: dryRun ? "planned" : executionStatusForWorkspaceSync(execution),
      workspace_root: workspaceRoot,
      remote_workspace_root: remoteWorkspaceRoot,
      file_count: execution?.file_count,
      byte_count: execution?.byte_count,
      error: execution?.error,
      started_at: now,
      completed_at: dryRun ? undefined : now,
      metadata: {
        sandbox_backend: instance.backend,
        sandbox_scope: instance.scope,
        sandbox_mode: instance.sandbox.mode,
        workspace_access: instance.sandbox.workspace_access,
        network_access: instance.sandbox.network_access,
        sync_adapter: "gateway",
        sync_reason: execution?.reason ?? null,
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

  async rotateGatewayPairing(id: string): Promise<GatewayPairingRecord> {
    const pairing = await this.store.getGatewayPairing(id);
    if (!pairing) {
      throw new RuntimeRequestError("not_found", `Gateway pairing not found: ${id}`);
    }
    const freshPairing = expirePairing(pairing);
    if (freshPairing.status === "expired") {
      await this.store.saveGatewayPairing(freshPairing);
      await this.emit("gateway.pairing.updated", freshPairing);
      return freshPairing;
    }
    const rotated = rotatePairingCode(freshPairing);
    await this.store.saveGatewayPairing(rotated);
    await this.emit("gateway.pairing.updated", rotated);
    return rotated;
  }

  async revokeGatewayPairing(id: string): Promise<GatewayPairingRecord> {
    const pairing = await this.store.getGatewayPairing(id);
    if (!pairing) {
      throw new RuntimeRequestError("not_found", `Gateway pairing not found: ${id}`);
    }
    const revoked = revokePairing(pairing);
    await this.store.saveGatewayPairing(revoked);
    await this.emit("gateway.pairing.updated", revoked);
    return revoked;
  }

  async handleGatewayInbound(input: {
    channel: GatewayPairingRecord["channel"];
    source_identity: string;
    body: string;
    source_label?: string;
    account_id?: string;
    thread_id?: string;
    route?: string;
    metadata?: Record<string, JsonValue>;
    backend_id?: string;
    input_locale?: SupportedLocale;
    output_locale?: SupportedLocale;
  }): Promise<GatewayInboundRuntimeResult> {
    const sourceIdentity = normalizeGatewaySourceIdentity(input.source_identity);
    const body = input.body.trim();
    if (!sourceIdentity || !body) {
      throw new RuntimeRequestError("conflict", "gateway_source_and_body_required");
    }

    await this.expireGatewayPairings();
    const routingPolicy = await this.getGatewayRoutingPolicy(input.channel);
    const routingResolution = resolveGatewaySessionRouting(routingPolicy, {
      channel: input.channel,
      source_identity: sourceIdentity,
      source_label: input.source_label,
      account_id: input.account_id,
      thread_id: input.thread_id,
      route: input.route,
      metadata: input.metadata
    });
    const targetSessionKey = routingResolution.session_key;
    const pairingPolicy = await this.getGatewayPairingPolicy(input.channel);
    const pairingPolicyEvaluation = evaluateGatewayPairingPolicy(pairingPolicy, {
      channel: input.channel,
      source_identity: sourceIdentity
    });
    const inboundMetadata = gatewayInboundPolicyMetadata(
      input,
      sourceIdentity,
      targetSessionKey,
      pairingPolicy,
      pairingPolicyEvaluation,
      routingPolicy,
      routingResolution
    );

    if (!routingResolution.allowed) {
      const inbound = await this.store.saveGatewayInboundMessage({
        ...createGatewayInboundMessage({
          channel: input.channel,
          source_identity: sourceIdentity,
          body,
          metadata: inboundMetadata
        }),
        error: "gateway_routing_policy_disabled"
      });
      await this.emit("gateway.inbound.blocked", inbound);
      return { inbound };
    }

    const duplicate = await this.findRecentGatewayInboundDuplicate(
      input.channel,
      sourceIdentity,
      body,
      pairingPolicyEvaluation.duplicate_window_ms
    );
    if (duplicate) {
      return {
        inbound: duplicate,
        pairing: duplicate.pairing_id ? await this.store.getGatewayPairing(duplicate.pairing_id) : undefined
      };
    }

    if (!pairingPolicyEvaluation.allowed) {
      const inbound = await this.store.saveGatewayInboundMessage({
        ...createGatewayInboundMessage({
          channel: input.channel,
          source_identity: sourceIdentity,
          body,
          metadata: inboundMetadata
        }),
        error: gatewayPairingPolicyError(pairingPolicyEvaluation.reason)
      });
      await this.emit("gateway.inbound.blocked", inbound);
      return { inbound };
    }

    if (await this.isGatewayRateLimited(
      input.channel,
      sourceIdentity,
      pairingPolicyEvaluation.rate_limit_window_ms,
      pairingPolicyEvaluation.rate_limit_max
    )) {
      const inbound = await this.store.saveGatewayInboundMessage({
        ...createGatewayInboundMessage({
          channel: input.channel,
          source_identity: sourceIdentity,
          body,
          metadata: inboundMetadata
        }),
        error: "gateway_rate_limited"
      });
      await this.emit("gateway.inbound.blocked", inbound);
      return { inbound };
    }

    let pairing = await this.store.findGatewayPairing({
      channel: input.channel,
      sourceIdentity,
      status: "approved",
      sessionKey: targetSessionKey
    });
    if (!pairing) {
      const pending = await this.store.findGatewayPairing({
        channel: input.channel,
        sourceIdentity,
        status: "pending",
        sessionKey: targetSessionKey
      });
      const pendingPairing = pending ? {
        ...pending,
        metadata: {
          ...pending.metadata,
          ...inboundMetadata
        },
        updated_at: nowIso()
      } : createPendingPairing({
        channel: input.channel,
        source_identity: sourceIdentity,
        source_label: input.source_label,
        account_id: routingResolution.account_id,
        thread_id: routingResolution.thread_id,
        route: routingResolution.route,
        metadata: inboundMetadata,
        pairing_ttl_ms: pairingPolicyEvaluation.pairing_ttl_ms
      });
      if (pairingPolicyEvaluation.trusted_without_pairing) {
        pairing = await this.store.saveGatewayPairing(approvePairing({
          ...pendingPairing,
          metadata: {
            ...pendingPairing.metadata,
            gateway_pairing_policy_auto_approved: true
          }
        }));
        await this.emit("gateway.pairing.updated", pairing);
      } else {
        await this.store.saveGatewayPairing(pendingPairing);
        await this.emit("gateway.pairing.requested", pendingPairing);
      }
    }

    if (!pairing) {
      const pendingPairing = await this.store.findGatewayPairing({
        channel: input.channel,
        sourceIdentity,
        status: "pending",
        sessionKey: targetSessionKey
      });
      const inbound = await this.store.saveGatewayInboundMessage(createGatewayInboundMessage({
        channel: input.channel,
        source_identity: sourceIdentity,
        body,
        pairing: pendingPairing,
        metadata: inboundMetadata
      }));
      await this.emit("gateway.inbound.blocked", inbound);
      return { inbound, pairing: pendingPairing };
    }

    const inbound = await this.store.saveGatewayInboundMessage(createGatewayInboundMessage({
      channel: input.channel,
      source_identity: sourceIdentity,
      body,
      pairing,
      metadata: inboundMetadata
    }));

    const gatewayContext = gatewayContextForPairing(pairing);
    const boundaryPolicy = await this.store.saveGatewayBoundaryPolicy(createDefaultGatewayBoundaryPolicy({
      source_channel: input.channel,
      source_identity: sourceIdentity,
      session_key: pairing.session_key,
      allowlist: pairingPolicyEvaluation.allowlist_snapshot
    }));
    await this.emit("gateway.boundary_policy.saved", boundaryPolicy);
    const concurrencyLock = await this.acquireGatewayConcurrencyLock(boundaryPolicy, inbound);
    if (!concurrencyLock.acquired) {
      const blocked = await this.store.saveGatewayInboundMessage({
        ...inbound,
        status: "blocked",
        error: "gateway_concurrency_locked",
        updated_at: nowIso()
      });
      await this.emit("gateway.inbound.blocked", blocked);
      return { inbound: blocked, pairing, boundaryPolicy, concurrencyLock: concurrencyLock.lock };
    }

    const session = await this.ensureSessionForContext(gatewayContext, `Gateway ${pairing.source_label || pairing.source_identity}`);
    try {
      await this.emit("gateway.inbound.routed", inbound);
      const chat = await this.runChatTurn({
        sessionId: session.id,
        content: body,
        backend_id: input.backend_id,
        input_locale: input.input_locale,
        output_locale: input.output_locale,
        metadata: {
          ...(input.metadata ?? {}),
          gateway_inbound_id: inbound.id,
          gateway_channel: input.channel,
          gateway_source_identity: sourceIdentity,
          gateway_pairing_policy_id: pairingPolicy.id,
          gateway_pairing_policy_trust_mode: pairingPolicy.trust_mode,
          gateway_routing_policy_id: routingPolicy.id,
          gateway_routing_session_key_strategy: routingPolicy.session_key_strategy,
          gateway_boundary_policy_id: boundaryPolicy.id
        },
        gateway_context: gatewayContext,
        gateway_boundary_policy: boundaryPolicy
      });
      const processed = await this.store.saveGatewayInboundMessage({
        ...inbound,
        status: "processed",
        message_id: chat.messages.find((message) => message.role === "user")?.id,
        updated_at: nowIso()
      });
      await this.emit("gateway.inbound.processed", processed);
      return { inbound: processed, pairing, boundaryPolicy, concurrencyLock: concurrencyLock.lock, session, chat };
    } catch (error) {
      const failed = await this.store.saveGatewayInboundMessage({
        ...inbound,
        status: "failed",
        error: safeRuntimeErrorMessage(error, "gateway_inbound_failed"),
        updated_at: nowIso()
      });
      await this.emit("gateway.inbound.failed", failed);
      throw error;
    } finally {
      await this.store.releaseGatewayConcurrencyLock(concurrencyLock.lock.lock_key);
    }
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

  private async releaseGatewayConcurrencyLockForRun(run: BackendRunRecord, now: string): Promise<GatewayConcurrencyLockRecord | undefined> {
    const lockKey = typeof run.metadata.gateway_boundary_concurrency_lock_key === "string"
      ? run.metadata.gateway_boundary_concurrency_lock_key
      : undefined;
    if (!lockKey) {
      return undefined;
    }
    const lock = await this.store.getGatewayConcurrencyLock(lockKey);
    if (!lock || lock.status !== "acquired") {
      return undefined;
    }
    return this.store.releaseGatewayConcurrencyLock(lockKey, now);
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
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Save automation job: ${input.title}`);
    const now = nowIso();
    const job: AutomationJobRecord = {
      id: createId("automation"),
      title: input.title,
      kind: input.kind,
      status: input.enabled === false ? "disabled" : "enabled",
      schedule: input.schedule,
      target_instruction: input.target_instruction,
      delivery_target: input.delivery_target ?? { channel: "activity" },
      next_run_at: input.next_run_at ?? now,
      failure_count: 0,
      max_attempts: input.max_attempts ?? 3,
      created_at: now,
      updated_at: now
    };
    return this.runAllowedWrite<AutomationJobRecord, Record<string, unknown>>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "automation.job.save",
      proposedEffects: ["Save an automation job definition."],
      execute: async (operation) => {
        const saved = await this.store.saveAutomationJob(job);
        const ref = automationJobRef(saved);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { automation_job: saved as unknown as JsonValue });
        return { resource: saved, ref, rollbackPoint, summary: `Saved automation job ${saved.title}.` };
      }
    });
  }

  async saveResourceTranslationJob(input: {
    source_ref: ResourceRef;
    target_locale: SupportedLocale;
    source_locale?: SupportedLocale;
    schedule?: string;
    title?: string;
    enabled?: boolean;
    next_run_at?: string;
    max_attempts?: number;
  }): Promise<AutomationJobRuntimeResult> {
    const source = await this.loadTranslatableResource(input.source_ref, input.source_locale);
    if (!source) {
      throw new RuntimeRequestError("not_found", `Translatable resource not found: ${input.source_ref.kind}/${input.source_ref.id}`);
    }
    const schedule = input.schedule?.trim() || "once";
    return this.saveAutomationJob({
      title: input.title?.trim() || `Translate ${source.ref.kind}/${source.ref.id} to ${input.target_locale}`,
      kind: "resource_translation",
      schedule,
      target_instruction: `Translate ${source.ref.kind}/${source.ref.id} from ${source.source_locale} to ${input.target_locale}.`,
      delivery_target: {
        channel: "resource_translation",
        source_ref: source.ref as unknown as JsonValue,
        source_locale: source.source_locale,
        target_locale: input.target_locale,
        original_hash: source.original_hash,
        source_label: source.ref.label ?? source.ref.id
      },
      enabled: input.enabled,
      next_run_at: input.next_run_at,
      max_attempts: input.max_attempts
    });
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

  async runDueAutomationJobs(now = nowIso()): Promise<AutomationRunRuntimeResult[]> {
    const jobs = await this.store.listAutomationJobs({ dueAt: now, enabledOnly: true });
    const results: AutomationRunRuntimeResult[] = [];
    for (const job of jobs) {
      const locked = await this.store.acquireAutomationJobLock(job.id, {
        lockedUntil: new Date(Date.parse(now) + 15 * 60_000).toISOString(),
        now
      });
      if (!locked) {
        continue;
      }
      results.push(await this.runAutomationJob(locked, now));
    }
    return results;
  }

  async applyReflectionSuggestion(input: { suggestionId: string }): Promise<RuntimeWriteResult<MemoryFrontmatter | WikiWithFilePath | SkillWithFilePath>> {
    const suggestions = await this.store.listReflectionSuggestions();
    const suggestion = suggestions.find((item) => item.id === input.suggestionId);
    if (!suggestion) {
      throw new RuntimeRequestError("not_found", `Reflection suggestion not found: ${input.suggestionId}`);
    }
    if (suggestion.status !== "proposed") {
      throw new RuntimeRequestError("conflict", "reflection_suggestion_already_settled");
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Apply reflection suggestion: ${suggestion.title}`);
    return this.runAllowedWrite<MemoryFrontmatter | WikiWithFilePath | SkillWithFilePath, Record<string, unknown>>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "reflection.suggestion.apply",
      proposedEffects: [`Apply ${suggestion.suggestion_type} reflection suggestion.`],
      targetResourceRefs: suggestion.source_refs,
      execute: async (operation) => {
        const now = nowIso();
        if (suggestion.suggestion_type === "memory") {
          const memory = await createTopicMemory(this.store, envelope, suggestion.title || "reflection", suggestion.content);
          const ref = memoryRef(memory);
          const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { memory: memory as unknown as JsonValue });
          await this.store.updateReflectionSuggestion({ ...suggestion, status: "applied", updated_at: now });
          return { resource: memory, ref, rollbackPoint, summary: `Applied reflection suggestion as Memory ${memory.topic}.` };
        }
        if (suggestion.suggestion_type === "knowledge_wiki") {
          const wiki = await this.createWikiProposal({
            title: suggestion.title,
            content: suggestion.content,
            source_refs: suggestion.source_refs,
            provenance: { kind: "generated_local", summary: "Applied from reflection suggestion.", verified: false }
          });
          await this.store.updateReflectionSuggestion({ ...suggestion, status: "applied", target_ref: wiki.operation.result_ref, updated_at: now });
          return {
            resource: wiki.resource,
            ref: wiki.operation.result_ref!,
            rollbackPoint: wiki.rollbackPoint,
            summary: `Applied reflection suggestion as Knowledge Wiki proposal ${wiki.resource.title}.`
          };
        }
        if (suggestion.suggestion_type === "skill") {
          const skill = await this.createSkillCandidate({
            title: suggestion.title,
            description: summarize(suggestion.content),
            content: suggestion.content,
            tags: ["reflection"],
            source_refs: suggestion.source_refs,
            provenance_detail: {
              kind: "generated_local",
              summary: "Applied from reflection suggestion.",
              verified: false
            }
          });
          await this.store.updateReflectionSuggestion({ ...suggestion, status: "applied", target_ref: skill.operation.result_ref, updated_at: now });
          return {
            resource: skill.resource,
            ref: skill.operation.result_ref!,
            rollbackPoint: skill.rollbackPoint,
            summary: `Applied reflection suggestion as Skill candidate ${skill.resource.title}.`
          };
        }
        throw new RuntimeRequestError("conflict", "reflection_suggestion_type_not_applyable");
      }
    });
  }

  async createSkillCandidate(input: {
    title: string;
    description: string;
    content: string;
    tags?: string[];
    required_capabilities?: string[];
    source_refs?: SkillFrontmatter["source_refs"];
    provenance_detail?: SkillFrontmatter["provenance_detail"];
  }): Promise<SkillRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Create skill candidate: ${input.title}`);
    const skillId = createId("skill");
    const now = nowIso();
    const markdown = renderSkillMarkdown(
      {
        id: skillId,
        state: "candidate",
        title: input.title,
        description: input.description,
        tags: input.tags ?? [],
        provenance: "generated_local",
        trust_level: "generated_local",
        allowed_scopes: ["skill"],
        required_capabilities: input.required_capabilities ?? [],
        schedule_policy: {},
        secret_policy: {},
        owner_pinned: false,
        last_reviewed_at: now,
        source_refs: input.source_refs ?? [],
        provenance_detail: input.provenance_detail ?? {
          kind: "generated_local",
          summary: "Created from a local runtime operation.",
          verified: false
        }
      },
      input.content
    );

    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "skill.candidate.create",
      proposedEffects: ["Create a local skill candidate markdown file."],
      execute: async (operation) => {
        const skill = await this.store.saveSkillMarkdown({ state: "candidate", skillId, markdown });
        const ref = skillRef(skill);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { skill_id: skill.id });
        return { resource: skill, ref, rollbackPoint, summary: `Created skill candidate ${skill.title}.` };
      }
    });
  }

  async saveSkillProject(input: { candidateId: string }): Promise<SkillRuntimeResult> {
    const candidateMarkdown = await this.store.readSkillMarkdown(input.candidateId);
    if (!candidateMarkdown) {
      throw new RuntimeRequestError("not_found", `Skill candidate not found: ${input.candidateId}`);
    }
    const parsedCandidate = parseSkillMarkdown(candidateMarkdown);
    if (parsedCandidate.frontmatter.state !== "candidate") {
      throw new RuntimeRequestError("conflict", "skill_is_not_candidate");
    }

    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Save project skill from candidate: ${input.candidateId}`);
    const skillId = createId("skill");
    const markdown = renderSkillMarkdown(
      {
        ...parsedCandidate.frontmatter,
        id: skillId,
        state: "project",
        provenance: `candidate:${input.candidateId}`,
        last_reviewed_at: nowIso()
      },
      parsedCandidate.content
    );

    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "skill.project.save",
      proposedEffects: ["Create a project skill markdown file from an existing candidate."],
      execute: async (operation) => {
        const skill = await this.store.saveSkillMarkdown({ state: "project", skillId, markdown });
        const ref = skillRef(skill);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { skill_id: skill.id, candidate_id: input.candidateId });
        return { resource: skill, ref, rollbackPoint, summary: `Saved project skill ${skill.title}.` };
      }
    });
  }

  async saveSkillSupportFile(input: { skillId: string; path: string; content: string }): Promise<SkillSupportRuntimeResult> {
    const skill = await this.store.getSkill(input.skillId);
    if (!skill) {
      throw new RuntimeRequestError("not_found", `Skill not found: ${input.skillId}`);
    }
    const before = (await this.store.listSkillSupportFiles(input.skillId)).find((file) => file.path === input.path);
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Save Skill support file: ${skill.title}/${input.path}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "skill.support_file.save",
      proposedEffects: [`Save support file ${input.path} for Skill ${skill.title}.`],
      targetResourceRefs: [skillRef(skill)],
      execute: async (operation) => {
        const saved = await this.store.writeSkillSupportFile(input);
        const ref = skillSupportFileRef(saved);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { path: saved.file_path, content: before?.content ?? null },
          { path: saved.file_path, content: saved.content }
        );
        return {
          resource: saved,
          ref,
          rollbackPoint,
          summary: `Saved support file ${saved.path} for Skill ${skill.title}.`
        };
      }
    });
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
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Create wiki proposal: ${input.title}`);
    const now = nowIso();
    const wiki: WikiFrontmatter = {
      id: createId("wiki"),
      slug: slugify(input.slug ?? input.title),
      title: input.title,
      state: "proposed",
      content_locale: input.content_locale ?? session.output_locale,
      tags: input.tags ?? [],
      source_refs: input.source_refs ?? [],
      provenance: input.provenance ?? {
        kind: "user_authored",
        summary: "Created from an explicit local request.",
        verified: true
      },
      created_at: now,
      updated_at: now
    };

    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "wiki.proposal.create",
      proposedEffects: ["Create a proposed wiki markdown page."],
      execute: async (operation) => {
        const saved = await this.store.saveWikiPage(wiki, input.content);
        const ref = wikiRef(saved);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { wiki_id: saved.id });
        return { resource: saved, ref, rollbackPoint, summary: `Created wiki proposal ${saved.title}.` };
      }
    });
  }

  async acceptWikiPage(id: string): Promise<WikiRuntimeResult> {
    return this.updateWikiState(id, "active", "wiki.accept", "Accept a wiki proposal for active retrieval.", "Accepted wiki page");
  }

  async rejectWikiPage(id: string): Promise<WikiRuntimeResult> {
    return this.updateWikiState(id, "rejected", "wiki.reject", "Reject a wiki proposal without deleting its markdown.", "Rejected wiki page");
  }

  async archiveWikiPage(id: string): Promise<WikiRuntimeResult> {
    return this.updateWikiState(id, "archived", "wiki.archive", "Archive a wiki page without deleting its markdown.", "Archived wiki page");
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
    const current = await this.store.getWiki(input.id);
    if (!current) {
      throw new RuntimeRequestError("not_found", `Wiki page not found: ${input.id}`);
    }
    const beforeContent = await this.store.readWikiContent(input.id);
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Patch wiki page: ${current.title}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "wiki.patch",
      proposedEffects: ["Edit wiki page frontmatter or markdown content."],
      execute: async (operation) => {
        const saved = await this.store.updateWikiPage(input);
        if (!saved) {
          throw new RuntimeRequestError("not_found", `Wiki page not found: ${input.id}`);
        }
        const ref = wikiRef(saved);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { wiki: current as unknown as JsonValue, content: beforeContent ?? "" },
          { wiki: saved as unknown as JsonValue, content: input.content ?? beforeContent ?? "" }
        );
        return { resource: saved, ref, rollbackPoint, summary: `Updated wiki page ${saved.title}.` };
      }
    });
  }

  async reindexWiki(): Promise<RuntimeWriteResult<WikiReindexResult>> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, "Reindex wiki pages");
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "wiki.reindex",
      proposedEffects: ["Refresh the SQLite wiki index from markdown files."],
      execute: async () => {
        const result = await this.store.reindexWiki();
        const ref = {
          kind: "wiki_index",
          id: "active",
          uri: "wiki/pages",
          label: "Wiki index"
        };
        return { resource: result, ref, summary: `Reindexed ${result.active} active wiki pages.` };
      }
    });
  }

  async saveCollectionSchema(schema: CollectionSchema): Promise<CollectionSchemaRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Save collection schema: ${schema.id}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "collection.schema.save",
      proposedEffects: ["Create a collection schema file and SQLite index row."],
      execute: async (operation) => {
        const saved = await this.store.saveCollectionSchema(schema);
        const ref = collectionSchemaRef(saved);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { collection_id: saved.id, version: saved.version });
        return { resource: saved, ref, rollbackPoint, summary: `Saved collection schema ${saved.id}.` };
      }
    });
  }

  async ensureTasksCollectionSchema(): Promise<CollectionSchemaWithFilePath | CollectionSchemaRuntimeResult> {
    const existing = await this.store.getCollectionSchema(TASKS_COLLECTION_ID);
    if (existing) {
      ensureCompatibleTasksCollectionSchema(existing);
      return existing;
    }
    return this.saveCollectionSchema(createTasksCollectionSchema());
  }

  async reindexCollections(): Promise<CollectionReindexRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, "Reindex collections");
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "collection.reindex",
      proposedEffects: ["Refresh Collection SQLite indexes from schema and record files."],
      execute: async () => {
        const result = await this.store.reindexCollections();
        const ref = {
          kind: "collection_index",
          id: "collections",
          uri: "collections",
          label: "Collection index"
        };
        return {
          resource: result,
          ref,
          summary: `Reindexed ${result.schemas.indexed} collection schema(s) and ${result.records.indexed} record(s).`
        };
      }
    });
  }

  async createCollectionRecord(record: CollectionRecord): Promise<CollectionRecordRuntimeResult> {
    if (record.collection_id === TASKS_COLLECTION_ID) {
      validateTaskRecordCreateData(record.data);
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Create collection record: ${record.collection_id}/${record.id}`);
    const result = await this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "collection.record.create",
      proposedEffects: ["Create a collection record file and SQLite index row."],
      execute: async (operation) => {
        const saved = await this.store.saveCollectionRecord(record);
        const ref = collectionRecordRef(saved);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { collection_id: saved.collection_id, record_id: saved.id });
        return { resource: saved, ref, rollbackPoint, summary: `Created collection record ${saved.collection_id}/${saved.id}.` };
      }
    });
    await this.queueCollectionTriggerAutomations({
      collectionId: result.resource.collection_id,
      recordId: result.resource.id,
      event: "record.created"
    });
    return result;
  }

  async presentCollectionView(input: { collectionId: string; viewId?: string }): Promise<CollectionViewRuntimeResult & { render_spec: SurfaceRenderSpec }> {
    if (input.collectionId === TASKS_COLLECTION_ID) {
      await this.ensureTasksCollectionSchema();
      const [records, schema] = await Promise.all([
        this.store.listCollectionRecords(TASKS_COLLECTION_ID),
        this.store.getCollectionSchema(TASKS_COLLECTION_ID)
      ]);
      const savedSchema = schema;
      if (!savedSchema) {
        throw new RuntimeRequestError("not_found", `Collection schema not found: ${TASKS_COLLECTION_ID}`);
      }
      return {
        collection_id: TASKS_COLLECTION_ID,
        view_id: input.viewId ?? "task_list",
        schema: savedSchema,
        record_count: records.length,
        render_spec: taskListRenderSpec(records, undefined, undefined, savedSchema)
      };
    }
    const schema = await this.store.getCollectionSchema(input.collectionId);
    if (!schema) {
      throw new RuntimeRequestError("not_found", `Collection schema not found: ${input.collectionId}`);
    }
    const records = await this.store.listCollectionRecords(input.collectionId);
    return {
      collection_id: input.collectionId,
      view_id: input.viewId ?? "default",
      schema,
      record_count: records.length,
      render_spec: createSurfaceRenderSpec({
        kind: "collection",
        priority: "primary",
        state: "ready",
        title: schema.labels?.ja ?? schema.labels?.en ?? schema.id,
        resource_refs: records.map(collectionRecordRef),
        props: {
          collection_id: schema.id,
          schema_id: schema.id,
          record_ids: records.map((record) => record.id)
        }
      })
    };
  }

  async applyCollectionPatch(input: { collectionId: string; recordId: string; patch: CollectionPatch }): Promise<CollectionPatchRuntimeResult> {
    if (input.collectionId === TASKS_COLLECTION_ID) {
      validateTaskRecordPatchData(input.patch.changes);
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Apply collection patch: ${input.collectionId}/${input.recordId}`);
    const result = await this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "collection.patch.apply",
      proposedEffects: ["Apply a collection patch to an existing local record."],
      execute: async (operation) => {
        const patch = { ...input.patch, source_operation_id: operation.id };
        const patched = await this.store.applyCollectionRecordPatch({ ...input, patch });
        const ref = collectionRecordRef(patched.after);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { record: patched.before as unknown as JsonValue },
          { record: patched.after as unknown as JsonValue }
        );
        return {
          resource: patched.after,
          before: patched.before,
          ref,
          rollbackPoint,
          summary: `Applied collection patch ${patch.id}.`
        };
      }
    });
    await this.queueCollectionTriggerAutomations({
      collectionId: result.resource.collection_id,
      recordId: result.resource.id,
      event: "record.patched"
    });
    return { ...result, before: (result as CollectionPatchRuntimeResult).before };
  }

  async deleteCollectionRecord(input: { collectionId: string; recordId: string; viewId?: string }): Promise<CollectionDeleteRuntimeResult> {
    const schema = await this.store.getCollectionSchema(input.collectionId);
    if (!schema) {
      throw new RuntimeRequestError("not_found", `Collection schema not found: ${input.collectionId}`);
    }
    assertCollectionDeleteAllowed(schema, input.viewId);
    const record = await this.store.getCollectionRecord(input.collectionId, input.recordId);
    if (!record) {
      throw new RuntimeRequestError("not_found", `Collection record not found: ${input.collectionId}/${input.recordId}`);
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Delete collection record: ${input.collectionId}/${input.recordId}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "collection.record.delete",
      proposedEffects: ["Delete a collection record file and SQLite index row."],
      execute: async (operation) => {
        const deleted = await this.store.deleteCollectionRecord(input.collectionId, input.recordId);
        const ref = collectionRecordRef(deleted);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { record: record as unknown as JsonValue },
          {}
        );
        return { resource: deleted, ref, rollbackPoint, summary: `Deleted collection record ${deleted.collection_id}/${deleted.id}.` };
      }
    });
  }

  async listCollectionActions(collectionId?: string): Promise<CollectionActionDescriptor[]> {
    const schema = collectionId ? await this.store.getCollectionSchema(collectionId) : undefined;
    const schemas = collectionId ? (schema ? [schema] : []) : await this.store.listCollectionSchemas();
    return schemas.flatMap((item) =>
      item.actions.map((action) => collectionActionDescriptor(item.id, action, this.pluginRegistry))
    );
  }

  async runCollectionAction(input: {
    collectionId: string;
    actionId: string;
    recordId?: string;
    payload?: Record<string, unknown>;
  }): Promise<CollectionActionRuntimeResult> {
    const schema = await this.store.getCollectionSchema(input.collectionId);
    if (!schema) {
      throw new RuntimeRequestError("not_found", `Collection schema not found: ${input.collectionId}`);
    }
    const action = findCollectionAction(schema, input.actionId);
    if (!action) {
      throw new RuntimeRequestError("not_found", `Collection action not found: ${input.collectionId}/${input.actionId}`);
    }
    const kind = collectionActionKind(action);
    const payload = jsonRecord(input.payload ?? {});
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Run collection action: ${input.collectionId}/${input.actionId}`);
    let patchBefore: CollectionRecordWithFilePath | undefined;
    const result = await this.runAllowedWrite<CollectionRecordWithFilePath | CollectionReindexResult | CollectionPluginActionResult, Record<string, unknown>>({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "collection.action.run",
      proposedEffects: [`Run collection action ${input.collectionId}/${input.actionId}.`],
      execute: async (operation) => {
        if (kind === "patch_record" || kind === "patch") {
          const recordId = input.recordId ?? collectionActionString(action, "record_id") ?? stringPayload(payload.record_id);
          if (!recordId) {
            throw new RuntimeRequestError("conflict", "collection_action_record_id_required");
          }
          const changes = collectionActionRecord(payload.changes) ?? collectionActionRecord(action.changes);
          if (!changes) {
            throw new RuntimeRequestError("conflict", "collection_action_changes_required");
          }
          const patched = await this.store.applyCollectionRecordPatch({
            collectionId: input.collectionId,
            recordId,
            patch: {
              id: createId("collection_patch"),
              record_id: recordId,
              changes,
              source_operation_id: operation.id,
              created_at: nowIso()
            }
          });
          patchBefore = patched.before;
          const ref = collectionRecordRef(patched.after);
          const rollbackPoint = await this.createRollbackPoint(
            operation,
            [ref],
            { record: patched.before as unknown as JsonValue },
            { record: patched.after as unknown as JsonValue }
          );
          return {
            resource: patched.after,
            ref,
            rollbackPoint,
            summary: `Ran collection action ${input.actionId} and patched ${input.collectionId}/${recordId}.`
          };
        }
        if (kind === "create_record" || kind === "create") {
          const recordId = input.recordId ?? collectionActionString(action, "record_id") ?? (stringPayload(payload.record_id) || createId("collection_record"));
          const data = collectionActionRecord(payload.data) ?? collectionActionRecord(action.data);
          if (!data) {
            throw new RuntimeRequestError("conflict", "collection_action_data_required");
          }
          const now = nowIso();
          const saved = await this.store.saveCollectionRecord({
            id: recordId,
            collection_id: input.collectionId,
            data,
            resource_refs: [],
            created_at: now,
            updated_at: now
          });
          const ref = collectionRecordRef(saved);
          const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { collection_id: saved.collection_id, record_id: saved.id });
          return {
            resource: saved,
            ref,
            rollbackPoint,
            summary: `Ran collection action ${input.actionId} and created ${input.collectionId}/${recordId}.`
          };
        }
        if (kind === "reindex" || kind === "reindex_collection") {
          const resource = await this.store.reindexCollections();
          return {
            resource,
            ref: {
              kind: "collection_index",
              id: "collections",
              uri: "collections",
              label: "Collection index"
            },
            summary: `Ran collection action ${input.actionId} and reindexed collections.`
          };
        }
        if (isPluginCollectionAction(action, kind)) {
          const catalogActionId = collectionActionCatalogId(action, input.actionId);
          const pluginInput: Record<string, JsonValue> = {
            ...payload,
            collection_id: input.collectionId,
            action_id: input.actionId
          };
          const pluginRecordId = input.recordId ?? stringPayload(payload.record_id);
          if (pluginRecordId) {
            pluginInput.record_id = pluginRecordId;
          }
          const execution = await this.pluginRegistry.executeAction(catalogActionId, pluginInput, {
            collection_id: input.collectionId,
            action_id: input.actionId,
            action_kind: kind,
            operation_id: operation.id
          });
          if (execution.status !== "completed") {
            throw new RuntimeRequestError("conflict", `collection_plugin_action_failed:${execution.error ?? "unknown"}`);
          }
          const resource: CollectionPluginActionResult = {
            collection_id: input.collectionId,
            action_id: input.actionId,
            action_kind: kind,
            catalog_action_id: catalogActionId,
            handler_id: execution.handler_id,
            status: "completed",
            output: execution.output
          };
          return {
            resource,
            ref: collectionActionExecutionRef(input.collectionId, input.actionId, operation.id),
            summary: `Ran collection plugin action ${input.collectionId}/${input.actionId}.`
          };
        }
        throw new RuntimeRequestError("conflict", `collection_action_kind_unsupported:${kind}`);
      }
    });
    if (patchBefore) {
      await this.queueCollectionTriggerAutomations({
        collectionId: input.collectionId,
        recordId: (result.resource as CollectionRecordWithFilePath).id,
        event: "record.patched"
      });
      return { ...result, before: patchBefore } as CollectionPatchRuntimeResult;
    }
    if ("collection_id" in result.resource && "id" in result.resource) {
      await this.queueCollectionTriggerAutomations({
        collectionId: result.resource.collection_id,
        recordId: result.resource.id,
        event: "record.created"
      });
    }
    return result as CollectionRecordRuntimeResult | CollectionReindexRuntimeResult | CollectionPluginActionRuntimeResult;
  }

  private async runMemoryReviewTraceReflection(session: SessionRecord): Promise<ReflectionRuntimeResult> {
    const [sessions, backendRuns, workspaceChanges, toolRuns] = await Promise.all([
      this.store.listSessions(),
      this.store.listBackendRuns(),
      this.store.listWorkspaceChanges(),
      this.store.listToolRuns()
    ]);
    const recentSessionMessages = (await Promise.all(
      sessions.slice(0, 10).map((item) => this.store.listMessages(item.id))
    ))
      .flat()
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
      .slice(0, 30)
      .reverse();
    const recentRuns = backendRuns.slice(0, 8);
    const backendEvents = (await Promise.all(
      recentRuns.map((run) => this.store.listBackendEvents({ runId: run.id }))
    )).flat().slice(0, 80);
    const latestUser = [...recentSessionMessages].reverse().find((message) => message.role === "user");
    const latestAgent = [...recentSessionMessages].reverse().find((message) => message.role === "agent");
    const sourceRun = recentRuns[0];
    return this.runReflectionForCompletedTurn({
      kind: "scheduled",
      session,
      sourceRunId: sourceRun?.id,
      backendRun: sourceRun,
      userMessage: latestUser,
      agentMessage: latestAgent,
      backendEvents,
      workspaceChanges: workspaceChanges.slice(0, 50),
      toolRuns: toolRuns.slice(0, 50),
      transcriptMessages: recentSessionMessages,
      artifacts: await this.loadReflectionArtifacts({
        sessionId: sourceRun?.session_id ?? latestUser?.session_id ?? session.id,
        sourceRunId: sourceRun?.id,
        workspaceChanges
      })
    });
  }

  async runMemoryReviewAutomation(): Promise<AutomationRunRuntimeResult> {
    const startedAt = nowIso();
    let automationRun = await this.store.createAutomationRun({
      id: createId("automation_run"),
      kind: "memory_review",
      source: "cron",
      status: "started",
      started_at: startedAt
    });

    const session = await this.ensureSessionForContext(cronMemoryReviewGatewayContext, "Scheduled memory review");
    automationRun = await this.store.updateAutomationRun({ ...automationRun, session_id: session.id });

    const envelope = createCronMemoryReviewEnvelope();
    let traceResult: ReflectionRuntimeResult | undefined;
    let curatorResult: ReflectionRuntimeResult | undefined;
    try {
      const result = await this.runAllowedWrite({
        session,
        envelope,
        context: cronMemoryReviewGatewayContext,
        operationName: "automation.memory_review.run",
        inputRef: {
          kind: "automation_run",
          id: automationRun.id,
          uri: `automation-runs/${automationRun.id}`,
          label: "Automation run"
        },
        proposedEffects: ["Run scheduled memory review and deterministic curator without external effects."],
        execute: async (operation) => {
          traceResult = await this.runMemoryReviewTraceReflection(session);
          curatorResult = await this.runCuratorJob({ respectIdleGate: true });
          const ref = {
            kind: "automation_run",
            id: automationRun.id,
            uri: `automation-runs/${automationRun.id}`,
            label: "Memory review automation"
          };
          return {
            resource: automationRun,
            ref,
            summary: `Memory review automation read recent transcript/events, produced ${traceResult.suggestions.length} trace suggestion(s), and ran deterministic curator with ${curatorResult.suggestions.length} curator suggestion(s).`
          };
        }
      });
      automationRun = await this.store.updateAutomationRun({
        ...automationRun,
        status: "completed",
        operation_id: result.operation.id,
        completed_at: nowIso()
      });
      return { ...result, automationRun, memoryReviewTrace: traceResult, curatorResult };
    } catch (error) {
      automationRun = await this.store.updateAutomationRun({
        ...automationRun,
        status: "failed",
        completed_at: nowIso(),
        error: safeRuntimeErrorMessage(error)
      });
      throw error;
    }
  }

  private async runAutomationJob(job: AutomationJobRecord, runStartedAt = nowIso()): Promise<AutomationRunRuntimeResult> {
    let automationRun = await this.store.createAutomationRun({
      id: createId("automationrun"),
      kind: job.kind,
      source: "automation_job",
      status: "started",
      started_at: runStartedAt
    });
    const context: GatewayContext = {
      source: "cron",
      actor_identity: "owner_scheduled",
      instruction_source: "scheduled_context",
      channel: "cron",
      session_key: `cron:automation:${job.id}`
    };
    const session = await this.ensureSessionForContext(context, job.title);
    automationRun = await this.store.updateAutomationRun({ ...automationRun, session_id: session.id });
    const envelope = createGatewayEnvelope(context, job.target_instruction);
    try {
      const result = await this.runAllowedWrite({
        session,
        envelope,
        context,
        operationName: "automation.job.run",
        inputRef: automationJobRef(job),
        proposedEffects: [`Run automation job ${job.title}.`],
        execute: async (operation) => {
          let resource: AutomationRunRecord = automationRun;
          let summary = `Ran automation job ${job.title}.`;
          if (job.kind === "wiki_reindex") {
            const reindex = await this.store.reindexWiki();
            summary = `Reindexed Knowledge Wiki pages: ${reindex.active}/${reindex.total} active.`;
          } else if (job.kind === "skill_curator") {
            const curator = await this.runCuratorJob();
            summary = `Skill curator created ${curator.suggestions.length} review suggestion(s).`;
          } else if (job.kind === "memory_review") {
            const curator = await this.runCuratorJob();
            summary = `Memory review created ${curator.suggestions.length} curator suggestion(s).`;
          } else if (job.kind === "resource_translation") {
            const translation = await this.runResourceTranslationJob(job, session, context);
            automationRun = { ...automationRun, backend_run_id: translation.backendRunId };
            summary = `Translated ${translation.source_ref.kind}/${translation.source_ref.id} to ${translation.target_locale}.`;
          } else if (job.kind === "custom_instruction") {
            const collectionSummary = await this.runCollectionTriggerJob(job);
            if (collectionSummary) {
              summary = collectionSummary;
            } else {
              const instructionRun = await this.runAutomationInstructionJob(job, session, context);
              automationRun = { ...automationRun, backend_run_id: instructionRun.backendRunId };
              summary = instructionRun.summary;
            }
          } else if (job.kind === "daily_digest") {
            const instructionRun = await this.runAutomationInstructionJob(job, session, context);
            automationRun = { ...automationRun, backend_run_id: instructionRun.backendRunId };
            summary = instructionRun.summary;
          }
          const ref = {
            kind: "automation_run",
            id: automationRun.id,
            uri: `automation-runs/${automationRun.id}`,
            label: job.title
          };
          resource = await this.store.updateAutomationRun({
            ...automationRun,
            status: "completed",
            operation_id: operation.id,
            completed_at: nowIso()
          });
          await this.store.saveAutomationJob({
            ...job,
            status: isOneShotSchedule(job.schedule) ? "disabled" : job.status,
            last_run_at: nowIso(),
            next_run_at: isOneShotSchedule(job.schedule) ? undefined : nextRunFromSchedule(job.schedule),
            retry_after_at: undefined,
            locked_until: undefined,
            failure_count: 0,
            last_error: undefined,
            updated_at: nowIso()
          });
          return { resource, ref, summary };
        }
      });
      return { ...result, automationRun: result.resource };
    } catch (error) {
      const failureCount = (job.failure_count ?? 0) + 1;
      const retryable = failureCount < (job.max_attempts ?? 3);
      const errorText = safeRuntimeErrorMessage(error);
      automationRun = await this.store.updateAutomationRun({
        ...automationRun,
        status: "failed",
        completed_at: nowIso(),
        error: errorText
      });
      await this.store.saveAutomationJob({
        ...job,
        status: retryable ? "enabled" : "disabled",
        retry_after_at: retryable ? nextRetryAt(failureCount) : undefined,
        locked_until: undefined,
        failure_count: failureCount,
        last_error: errorText,
        updated_at: nowIso()
      });
      throw error;
    }
  }

  private async runCollectionTriggerJob(job: AutomationJobRecord): Promise<string | undefined> {
    const target = collectionTriggerDeliveryTarget(job.delivery_target);
    if (!target) {
      return undefined;
    }
    const schema = await this.store.getCollectionSchema(target.collectionId);
    if (!schema || !findCollectionAction(schema, target.actionId)) {
      return undefined;
    }
    await this.runCollectionAction({
      collectionId: target.collectionId,
      actionId: target.actionId,
      recordId: target.recordId,
      payload: {
        trigger_id: target.triggerId,
        event: target.event,
        action_kind: target.actionKind,
        automation_job_id: job.id
      }
    });
    return `Collection trigger ${target.triggerId} ran action ${target.collectionId}/${target.actionId}.`;
  }

  private async runResourceTranslationJob(
    job: AutomationJobRecord,
    session: SessionRecord,
    context: GatewayContext
  ): Promise<ResourceTranslationJobRuntimeDetails> {
    const target = resourceTranslationDeliveryTarget(job.delivery_target);
    if (!target) {
      throw new RuntimeRequestError("conflict", "invalid_resource_translation_job");
    }
    const source = await this.loadTranslatableResource(target.source_ref, target.source_locale);
    if (!source) {
      throw new RuntimeRequestError("not_found", `Translatable resource not found: ${target.source_ref.kind}/${target.source_ref.id}`);
    }
    if (target.original_hash && target.original_hash !== source.original_hash) {
      throw new RuntimeRequestError("conflict", "resource_translation_source_stale");
    }
    const instruction = [
      `Translate the following ${source.ref.kind} from ${source.source_locale} to ${target.target_locale}.`,
      "Return only the translated text. Keep names, code identifiers, paths, IDs, and structured keys unchanged.",
      "",
      source.content
    ].join("\n");
    const chat = await this.runChatTurn({
      sessionId: session.id,
      content: instruction,
      input_locale: source.source_locale,
      output_locale: target.target_locale,
      metadata: {
        automation_job_id: job.id,
        automation_job_kind: job.kind,
        automation_job_title: job.title,
        automation_schedule: job.schedule,
        automation_delivery_target: job.delivery_target,
        resource_translation_source_ref: source.ref,
        resource_translation_original_hash: source.original_hash,
        resource_translation_target_locale: target.target_locale
      },
      gateway_context: context
    });
    const translatedText = chat.messages.find((message) => message.role === "agent")?.content.trim() ?? "";
    const now = nowIso();
    const translation: ResourceTranslationRecord = await this.store.saveResourceTranslation({
      id: createId("translation"),
      source_ref: source.ref,
      source_locale: source.source_locale,
      target_locale: target.target_locale,
      status: translatedText ? "draft" : "missing",
      original_hash: source.original_hash,
      translated_text: translatedText,
      provenance: {
        kind: "generated_local",
        summary: `Generated by resource translation automation job ${job.id}.`,
        provider: chat.backendRun.backend_id,
        verified: false
      },
      created_at: now,
      updated_at: now
    });
    const change: WorkspaceChangeRecord = {
      id: createId("change"),
      run_id: chat.backendRun.id,
      session_id: session.id,
      resource_ref: resourceTranslationRef(translation),
      change_type: "other",
      summary: `Saved ${translation.target_locale} translation for ${source.ref.kind}/${source.ref.id}.`,
      created_at: nowIso()
    };
    await this.store.saveWorkspaceChange(change);
    await this.emit("workspace.change.created", change);
    return {
      translation,
      backendRunId: chat.backendRun.id,
      source_ref: source.ref,
      source_locale: source.source_locale,
      target_locale: target.target_locale,
      original_hash: source.original_hash
    };
  }

  private async loadTranslatableResource(sourceRef: ResourceRef, fallbackLocale?: SupportedLocale): Promise<{
    ref: ResourceRef;
    source_locale: SupportedLocale;
    content: string;
    original_hash: string;
  } | undefined> {
    if (sourceRef.kind === "artifact") {
      const artifact = await this.store.getArtifact(sourceRef.id);
      const content = artifact ? await this.store.readArtifactContent(sourceRef.id) : undefined;
      if (!artifact || content === undefined) {
        return undefined;
      }
      return translatableResource(artifact.file_ref, artifact.locale, content);
    }
    if (sourceRef.kind === "memory") {
      const memory = await this.store.getMemory(sourceRef.id);
      const content = memory ? await this.store.readMemoryContent(sourceRef.id) : undefined;
      if (!memory || content === undefined) {
        return undefined;
      }
      return translatableResource(memoryRef(memory), memory.content_locale, content);
    }
    if (sourceRef.kind === "wiki") {
      const wiki = await this.store.getWiki(sourceRef.id);
      const content = wiki ? await this.store.readWikiContent(sourceRef.id) : undefined;
      if (!wiki || content === undefined) {
        return undefined;
      }
      return translatableResource(wikiRef(wiki), wiki.content_locale, content);
    }
    if (sourceRef.kind === "skill") {
      const skill = await this.store.getSkill(sourceRef.id);
      const content = skill ? await this.store.readSkillMarkdown(sourceRef.id) : undefined;
      if (!skill || content === undefined) {
        return undefined;
      }
      return translatableResource(skillRef(skill), fallbackLocale ?? "ja", stripSkillFrontmatter(content));
    }
    if (sourceRef.kind === "collection_record") {
      const record = collectionRecordTargetFromRef(sourceRef);
      const collectionRecord = record ? await this.store.getCollectionRecord(record.collectionId, record.recordId) : undefined;
      if (!collectionRecord) {
        return undefined;
      }
      const content = JSON.stringify(collectionRecord.data, null, 2);
      return translatableResource(collectionRecordRef(collectionRecord), fallbackLocale ?? localeFromJson(collectionRecord.data.content_locale) ?? "ja", content);
    }
    return undefined;
  }

  private async runAutomationInstructionJob(
    job: AutomationJobRecord,
    session: SessionRecord,
    context: GatewayContext
  ): Promise<{ summary: string; backendRunId: string }> {
    const chat = await this.runChatTurn({
      sessionId: session.id,
      content: job.target_instruction,
      output_locale: session.output_locale,
      metadata: {
        automation_job_id: job.id,
        automation_job_kind: job.kind,
        automation_job_title: job.title,
        automation_schedule: job.schedule,
        automation_delivery_target: job.delivery_target
      },
      gateway_context: context
    });
    return {
      backendRunId: chat.backendRun.id,
      summary: `Automation instruction ran backend ${chat.backendRun.backend_id} with status ${chat.backendRun.status}.`
    };
  }

  private async queueCollectionTriggerAutomations(input: {
    collectionId: string;
    recordId: string;
    event: CollectionTriggerEffect["event"];
  }): Promise<AutomationJobRuntimeResult[]> {
    const effects = await this.store.evaluateCollectionTriggers({
      collectionId: input.collectionId,
      recordId: input.recordId,
      event: input.event
    });
    const queued = effects.filter((effect) => effect.status === "queued");
    const results: AutomationJobRuntimeResult[] = [];
    for (const effect of queued) {
      results.push(await this.saveAutomationJob({
        title: `Collection trigger ${input.collectionId}/${effect.id}`,
        kind: "custom_instruction",
        schedule: "once",
        target_instruction: `Run collection trigger ${effect.action_id} (${effect.action_kind}) for ${input.collectionId}/${input.recordId}.`,
        delivery_target: {
          channel: "collection_trigger",
          collection_id: input.collectionId,
          record_id: input.recordId,
          event: input.event,
          trigger_id: effect.id,
          action_id: effect.action_id,
          action_kind: effect.action_kind,
          record_ref: effect.record_ref as unknown as JsonValue
        },
        next_run_at: nowIso()
      }));
    }
    return results;
  }

  private async saveMessage(message: MessageRecord): Promise<MessageRecord> {
    const saved = await this.store.saveMessage(message);
    await this.emit("message.created", saved);
    return saved;
  }

  private async ensureBackendEventSequence(runId: string): Promise<void> {
    if (this.backendEventSequences.has(runId)) {
      return;
    }
    const existingEvents = await this.store.listBackendEvents({ runId });
    const nextSequence = existingEvents.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
    this.backendEventSequences.set(runId, nextSequence);
  }

  private allocateBackendEventSequence(runId: string): number {
    const sequence = this.backendEventSequences.get(runId) ?? 1;
    this.backendEventSequences.set(runId, sequence + 1);
    return sequence;
  }

  private async gatewayBoundaryPolicyForRun(run: BackendRunRecord): Promise<GatewayBoundaryPolicy | undefined> {
    const policyId = stringPayload(run.metadata.gateway_boundary_policy_id);
    return policyId ? this.store.getGatewayBoundaryPolicy(policyId) : undefined;
  }

  private async loadPersistedRunOutputs(run: BackendRunRecord): Promise<{
    operations: OperationRecord[];
    artifacts: ArtifactRecord[];
    workspaceChanges: WorkspaceChangeRecord[];
    toolRuns: ToolRunRecord[];
  }> {
    const [allChanges, allToolRuns, allOperations, allArtifacts] = await Promise.all([
      this.store.listWorkspaceChanges(run.session_id),
      this.store.listToolRuns({ sessionId: run.session_id }),
      this.store.listOperations(run.session_id),
      this.store.listArtifactsForSession(run.session_id)
    ]);
    const workspaceChanges = allChanges.filter((change) => change.run_id === run.id);
    const operationIds = new Set(workspaceChanges.map((change) => change.legacy_operation_id).filter((id): id is string => Boolean(id)));
    const artifactRefs = new Set(
      workspaceChanges
        .filter((change) => change.change_type === "artifact_created")
        .flatMap((change) => [change.resource_ref.id, change.resource_ref.uri])
        .filter(Boolean)
    );
    return {
      operations: allOperations.filter((operation) => operationIds.has(operation.id)),
      artifacts: allArtifacts.filter((artifact) => artifactRefs.has(artifact.id) || artifactRefs.has(artifact.file_ref.id) || artifactRefs.has(artifact.file_ref.uri)),
      workspaceChanges,
      toolRuns: allToolRuns.filter((toolRun) => toolRun.run_id === run.id)
    };
  }

  private async buildResumeToolRunInput(
    run: BackendRunRecord,
    resumeInput: Record<string, JsonValue>,
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy
  ): Promise<BackendRunInput> {
    const [session, messages, settings] = await Promise.all([
      this.store.getSession(run.session_id),
      this.store.listMessages(run.session_id),
      this.store.getSettings()
    ]);
    if (!session) {
      throw new RuntimeRequestError("not_found", "session_not_found");
    }
    const inputMessage = messages.find((message) => message.id === run.input_message_id && message.role === "user")
      ?? messages.find((message) => message.role === "user");
    const inputLocale = inputMessage?.input_locale ?? session.ui_locale ?? settings.ui_locale;
    const outputLocale = inputMessage?.output_locale ?? session.output_locale ?? settings.output_locale;
    const userInput = inputMessage?.content || run.input_summary || "Resume backend run";
    const envelope = inputMessage?.envelope ?? createGatewayEnvelope(webGatewayContext, userInput, inputLocale, outputLocale, {
      ...run.metadata,
      resume_input: resumeInput
    });
    const workspaceRoot = stringPayload(run.metadata.workspace_root) || this.store.rootDir;
    const workingDirectory = stringPayload(run.metadata.working_directory) || workspaceRoot;
    return {
      run_id: run.id,
      session_id: run.session_id,
      input_message_id: run.input_message_id,
      workspace_root: workspaceRoot,
      working_directory: workingDirectory,
      envelope,
      user_input: userInput,
      input_locale: inputLocale,
      output_locale: outputLocale,
      active_memory: [],
      gateway_boundary: gatewayBoundaryPolicy ? gatewayBoundaryRuntimeSnapshot(gatewayBoundaryPolicy) : undefined,
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
    event: BackendOutputEvent;
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy;
    recordEvent: BackendEventRecorder;
  }): Promise<BackendToolEventHandlingResult> {
    const providerToolName = stringPayload(input.event.payload.provider_tool_name);
    const requestedActionId = stringPayload(input.event.payload.action_id);
    const result: BackendToolEventHandlingResult = {
      operations: [],
      artifacts: [],
      memories: [],
      toolRuns: [],
      workspaceChanges: []
    };
    if (isSamuraiToolBridgeObservedProviderTool(providerToolName, input.event.payload)) {
      const toolRun = await this.store.saveToolRun({
        id: createId("toolrun"),
        run_id: input.run.id,
        session_id: input.run.session_id,
        tool_call_id: stringPayload(input.event.payload.tool_call_id) || input.event.tool_call_id,
        provider_tool_name: providerToolName,
        action_id: "artifact.create",
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
          action_id: "artifact.create",
          reason: "samurai_tool_bridge_already_executed",
          already_executed: true,
          tool_origin: "samurai_tool_bridge"
        },
        tool_call_id: input.event.tool_call_id
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
        tool_call_id: stringPayload(input.event.payload.tool_call_id) || input.event.tool_call_id,
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
        tool_call_id: input.event.tool_call_id
      });
      return result;
    }

    const runtimeTool = await this.handleRuntimeToolCall(input.run, input.runInput, input.event, boundaryFeedback, input.gatewayBoundaryPolicy).catch(async (error) => {
      await input.recordEvent({
        event_type: "tool_call_output",
        payload: {
          status: "failed",
          provider_tool_name: providerToolName,
          action_id: boundaryDecision.action_id,
          reason: safeRuntimeErrorMessage(error, "runtime_tool_failed"),
          gateway_boundary: boundaryFeedback.payload
        },
        resource_refs: boundaryFeedback.resourceRefs,
        tool_call_id: input.event.tool_call_id
      });
      return undefined;
    });
    if (runtimeTool) {
      result.operations.push(runtimeTool.operation);
      result.toolRuns.push(runtimeTool.toolRun);
      result.artifacts.push(...(runtimeTool.artifacts ?? []));
      result.memories.push(...(runtimeTool.memories ?? []));
      for (const change of runtimeTool.workspaceChanges ?? []) {
        await this.store.saveWorkspaceChange(change);
        result.workspaceChanges.push(change);
        await this.emit("workspace.change.created", change);
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
        tool_call_id: input.event.tool_call_id
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

  private async handleRuntimeToolCall(
    run: BackendRunRecord,
    runInput: BackendRunInput,
    event: BackendOutputEvent,
    boundary?: BackendToolBoundaryFeedback,
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy
  ): Promise<RuntimeToolCallResult | undefined> {
    const providerToolName = stringPayload(event.payload.provider_tool_name);
    const providerCommand = providerToolName ? getDomainCommandForProviderToolName(providerToolName) : undefined;
    const toolName = stringPayload(event.payload.action_id) || providerCommand?.id || providerToolName;
    const args = runtimeToolArguments(event.payload, toolName);
    const toolCallId = stringPayload(event.payload.tool_call_id) || event.tool_call_id;
    if (toolName === "sandbox.exec") {
      return this.handleSandboxExecToolCall(run, event, args, boundary, gatewayBoundaryPolicy);
    }
    if (toolName === "mcp.call") {
      return this.handleMcpToolCall(run, event, args, boundary, gatewayBoundaryPolicy);
    }
    if (toolName === "artifact.create" || toolName === "memory.topic.create") {
      return this.handleProviderDomainCommandToolCall(run, runInput, event, toolName, args, boundary);
    }
    let result:
      | FileActionRuntimeResult
      | BrowserActionRuntimeResult
      | ExternalSendRuntimeResult
      | AutomationJobRuntimeResult
      | RuntimeWriteResult<MemoryFrontmatter | WikiWithFilePath | SkillWithFilePath>
      | undefined;

    if (toolName === "file.read" || toolName === "file.list" || toolName === "file.write" || toolName === "file.patch") {
      result = await this.runFileAction({
        operation: toolName,
        path: stringPayload(args.path),
        content: typeof args.content === "string" ? args.content : undefined,
        search: typeof args.search === "string" ? args.search : undefined,
        replace: typeof args.replace === "string" ? args.replace : undefined
      });
    } else if (toolName === "browser.navigate" || toolName === "browser.extract" || toolName === "browser.screenshot" || toolName === "browser.download_to_workspace") {
      result = await this.runBrowserAction({
        operation: toolName,
        url: stringPayload(args.url),
        output_path: typeof args.output_path === "string" ? args.output_path : undefined
      });
    } else if (toolName === "external.send" || toolName === "external.send.prepare") {
      result = await this.prepareExternalSend({
        channel: externalSendChannelPayload(args.channel),
        target: recordPayload(args.target),
        title: stringPayload(args.title),
        body: stringPayload(args.body) || stringPayload(args.content) || stringPayload(args.user_intent) || "External send requested by backend."
      });
    } else if (toolName === "external.send.dispatch") {
      result = await this.dispatchExternalSend({
        sendId: stringPayload(args.send_id),
        dryRun: args.dry_run !== false
      });
    } else if (toolName === "reflection.suggestion.apply") {
      result = await this.applyReflectionSuggestion({ suggestionId: stringPayload(args.suggestion_id) });
    } else if (toolName === "workspace.delete") {
      const domainResult = await this.runDomainCommand({
        command_id: "workspace.delete",
        input_source: "provider_tool_call",
        payload: args
      });
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
        output_summary: writeResult.auditRecord.outputs_summary,
        resource_refs: withGatewayBoundaryRefs(writeResult.resourceRefs, boundary),
        created_at: nowIso()
      });
      return { operation: writeResult.operation, toolRun, resourceRefs: writeResult.resourceRefs };
    }

    if (!result) {
      return undefined;
    }
    const toolRun = await this.store.saveToolRun({
      id: createId("toolrun"),
      run_id: run.id,
      session_id: run.session_id,
      tool_call_id: toolCallId,
      provider_tool_name: providerToolName || toolName,
      action_id: result.operation.operation,
      status: "completed",
      input_summary: summarize(JSON.stringify(args), 220),
      output_summary: result.auditRecord.outputs_summary,
      resource_refs: withGatewayBoundaryRefs(result.operation.result_ref ? [result.operation.result_ref] : [], boundary),
      created_at: nowIso()
    });
    return { operation: result.operation, toolRun };
  }

  private async handleProviderDomainCommandToolCall(
    run: BackendRunRecord,
    runInput: BackendRunInput,
    event: BackendOutputEvent,
    commandId: "artifact.create" | "memory.topic.create",
    args: Record<string, JsonValue>,
    boundary?: BackendToolBoundaryFeedback
  ): Promise<RuntimeToolCallResult | undefined> {
    const providerToolName = stringPayload(event.payload.provider_tool_name) || commandId;
    const toolCallId = stringPayload(event.payload.tool_call_id) || event.tool_call_id;

    if (commandId === "artifact.create") {
      const title = stringPayload(args.title).trim();
      const content = stringPayload(args.content).trim() || stringPayload(args.instruction).trim();
      if (!title || !content) {
        return undefined;
      }
      args = {
        ...args,
        title,
        content,
        instruction: content
      };
    }

    if (commandId === "memory.topic.create") {
      const settings = await this.store.getSettings();
      if (settings.memory_capture_mode !== "suggest") {
        return undefined;
      }
      const topic = stringPayload(args.topic).trim() || stringPayload(args.topic_kind).trim() || "preference";
      const content = stringPayload(args.content).trim() || runInput.user_input;
      if (!content) {
        return undefined;
      }
      args = {
        ...args,
        topic_kind: topic,
        content
      };
    }

    const domainResult = await this.runDomainCommand({
      command_id: commandId,
      input_source: "provider_tool_call",
      payload: {
        ...args,
        session_id: run.session_id,
        envelope_id: runInput.input_message_id,
        provider_tool_call: true,
        input_locale: runInput.input_locale,
        output_locale: runInput.output_locale,
        metadata: {
          ...recordPayload(args.metadata),
          backend_run_id: run.id,
          provider_tool_name: providerToolName,
          ...(toolCallId ? { tool_call_id: toolCallId } : {})
        }
      }
    });
    const writeResult = operationAuditRuntimeResult(domainResult.result);
    if (!writeResult) {
      return undefined;
    }

    const resourceRefs = uniqueResourceRefs(writeResult.resourceRefs);
    const boundedResourceRefs = withGatewayBoundaryRefs(resourceRefs, boundary);
    const resource = runtimeWriteResource(domainResult.result);
    const artifacts = isArtifactRecordResource(resource) ? [resource] : [];
    const memories = isMemoryFrontmatterResource(resource) ? [resource] : [];
    const primaryResourceRef = resourceRefs[0] ?? writeResult.operation.result_ref;
    const workspaceChanges = primaryResourceRef
      ? [runtimeToolWorkspaceChange(run, writeResult.operation, primaryResourceRef, commandId, resource)]
      : [];
    const toolRun = await this.store.saveToolRun({
      id: createId("toolrun"),
      run_id: run.id,
      session_id: run.session_id,
      tool_call_id: toolCallId,
      provider_tool_name: providerToolName,
      action_id: writeResult.operation.operation,
      status: writeResult.operation.status === "denied" ? "ignored" : "completed",
      input_summary: summarize(JSON.stringify(args), 220),
      output_summary: writeResult.auditRecord.outputs_summary,
      resource_refs: boundedResourceRefs,
      created_at: nowIso()
    });

    return {
      operation: writeResult.operation,
      toolRun,
      resourceRefs,
      artifacts,
      memories,
      workspaceChanges,
      events: runtimeToolWorkspaceEvents(commandId, resource, boundedResourceRefs, toolCallId)
    };
  }

  private async createBackendArtifactFromText(input: {
    run: BackendRunRecord;
    runInput: BackendRunInput;
    title: string;
    content: string;
    recordEvent: (event: BackendOutputEvent) => Promise<BackendEventRecord>;
  }): Promise<{ operations: OperationRecord[]; artifacts: ArtifactRecord[]; workspaceChanges: WorkspaceChangeRecord[] }> {
    const domainResult = await this.runDomainCommand({
      command_id: "artifact.create",
      input_source: "provider_tool_call",
      payload: {
        session_id: input.run.session_id,
        envelope_id: input.runInput.input_message_id,
        title: input.title,
        content: input.content,
        instruction: input.content,
        provider_tool_call: true,
        input_locale: input.runInput.input_locale,
        output_locale: input.runInput.output_locale,
        metadata: {
          backend_run_id: input.run.id,
          expected_output_fallback: true
        }
      }
    });
    const writeResult = operationAuditRuntimeResult(domainResult.result);
    if (!writeResult) {
      return { operations: [], artifacts: [], workspaceChanges: [] };
    }
    const resourceRefs = uniqueResourceRefs(writeResult.resourceRefs);
    const resource = runtimeWriteResource(domainResult.result);
    const artifacts = isArtifactRecordResource(resource) ? [resource] : [];
    const primaryResourceRef = resourceRefs[0] ?? writeResult.operation.result_ref;
    const workspaceChanges = primaryResourceRef
      ? [runtimeToolWorkspaceChange(input.run, writeResult.operation, primaryResourceRef, "artifact.create", resource)]
      : [];
    for (const change of workspaceChanges) {
      await this.store.saveWorkspaceChange(change);
      await this.emit("workspace.change.created", change);
    }
    for (const event of runtimeToolWorkspaceEvents("artifact.create", resource, resourceRefs)) {
      await input.recordEvent(event);
    }
    return { operations: [writeResult.operation], artifacts, workspaceChanges };
  }

  private async handleSandboxExecToolCall(
    run: BackendRunRecord,
    event: BackendOutputEvent,
    args: Record<string, JsonValue>,
    boundary?: BackendToolBoundaryFeedback,
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy
  ): Promise<RuntimeToolCallResult | undefined> {
    if (!gatewayBoundaryPolicy) {
      return undefined;
    }
    const sandboxInstance = await this.ensureGatewaySandboxInstance(gatewayBoundaryPolicy);
    const execution = await executeSandboxCommand(
      gatewayBoundaryPolicy,
      sandboxCommandInputFromArgs(args),
      createSandboxCommandAdapter(),
      {
        workspaceRoot: this.store.rootDir,
        fileRoot: this.store.rootDir,
        env: process.env
      }
    );
    return this.saveSandboxExecExecution(run, stringPayload(event.payload.tool_call_id) || event.tool_call_id, args, execution, boundary, sandboxInstance);
  }

  private async saveSandboxExecExecution(
    run: BackendRunRecord,
    toolCallId: string | undefined,
    args: Record<string, JsonValue>,
    execution: SandboxCommandExecutionResult,
    boundary?: BackendToolBoundaryFeedback,
    sandboxInstance?: GatewaySandboxInstanceRecord
  ): Promise<RuntimeToolCallResult> {
    const executionRef = sandboxExecutionResourceRef(createId("sandbox_exec"), execution.command);
    const outputRefs = normalizeMcpExecutionResourceRefs(execution.resource_refs);
    const sandboxInstanceRef = sandboxInstance ? gatewaySandboxInstanceRef(sandboxInstance) : undefined;
    const resourceRefs = [executionRef, ...outputRefs, ...(sandboxInstanceRef ? [sandboxInstanceRef] : [])];
    const now = nowIso();
    const operation: OperationRecord = {
      id: createId("operation"),
      session_id: run.session_id,
      capability_id: proposalCapabilityManifest.id,
      operation: "sandbox.exec",
      actor_identity: "system",
      instruction_source: "tool_output",
      instruction_authority: "backend_runtime",
      channel: "gateway",
      input_hash: stableHash({
        run_id: run.id,
        tool_call_id: toolCallId,
        command: execution.command,
        args: args.args ?? []
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
      provider_tool_name: "sandbox.exec",
      action_id: "sandbox.exec",
      status: sandboxToolRunStatus(execution.status),
      input_summary: summarize(`${execution.command} ${(args.args as JsonValue[] | undefined)?.join?.(" ") ?? ""}`, 220),
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
        action_id: "sandbox.exec",
        command: execution.command,
        exit_code: execution.exit_code ?? null,
        signal: execution.signal ?? null,
        stdout: execution.stdout ?? "",
        stderr: execution.stderr ?? "",
        reason: execution.reason ?? null,
        error: execution.error ?? null,
        secret_resolution: execution.secret_resolution as unknown as JsonValue,
        sandbox: execution.sandbox as unknown as JsonValue,
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

  private async handleMcpToolCall(
    run: BackendRunRecord,
    event: BackendOutputEvent,
    args: Record<string, JsonValue>,
    boundary?: BackendToolBoundaryFeedback,
    gatewayBoundaryPolicy?: GatewayBoundaryPolicy
  ): Promise<RuntimeToolCallResult | undefined> {
    if (!gatewayBoundaryPolicy) {
      return undefined;
    }
    const serverName = stringPayload(args.server_name);
    const mcpToolName = stringPayload(args.tool_name);
    if (!serverName || !mcpToolName) {
      return undefined;
    }
    const toolInput = recordPayload(args.input);
    const configured = await this.store.getGatewayMcpConfigByServerName(serverName);
    const hasBoundaryRef = gatewayBoundaryPolicy.mcp_config_refs.some((ref) =>
      ref.server_name === serverName || (configured ? ref.id === configured.id : false)
    );
    const executionPolicy = configured && hasBoundaryRef
      ? {
          ...gatewayBoundaryPolicy,
          mcp_config_refs: gatewayBoundaryPolicy.mcp_config_refs.map((ref) =>
            ref.server_name === serverName || ref.id === configured.id ? gatewayMcpConfigToBoundaryRef(configured) : ref
          )
        }
      : gatewayBoundaryPolicy;
    const resolveConfig = async (serverName: string) => serverName === configured?.server_name
      ? configured
      : await this.store.getGatewayMcpConfigByServerName(serverName);
    const httpAdapter = createHttpMcpToolAdapter({
      resolveConfig: async (input) => {
        const config = await resolveConfig(input.server_name);
        return config ? httpMcpServerConfigFromGatewayConfig(config) : undefined;
      }
    });
    const adapter = {
      invoke: async (input: Parameters<PooledMcpToolAdapter["invoke"]>[0]) => {
        const config = await resolveConfig(input.server_name);
        if (config?.transport === "http") {
          return httpAdapter.invoke(input);
        }
        return this.stdioMcpProcessPool.invoke(input);
      }
    };
    const execution = await executeMcpToolInvocation(
      executionPolicy,
      {
        server_name: serverName,
        tool_name: mcpToolName,
        input: toolInput
      },
      adapter,
      {
        env: process.env,
        fileRoot: this.store.rootDir
      }
    );
    return this.saveMcpToolExecution(run, stringPayload(event.payload.tool_call_id) || event.tool_call_id, args, execution, boundary, configured);
  }

  private async saveMcpToolExecution(
    run: BackendRunRecord,
    toolCallId: string | undefined,
    args: Record<string, JsonValue>,
    execution: McpToolExecutionResult,
    boundary?: BackendToolBoundaryFeedback,
    configured?: Awaited<ReturnType<WorkspaceStore["getGatewayMcpConfigByServerName"]>>
  ): Promise<RuntimeToolCallResult> {
    const configRef = configured ? gatewayMcpConfigResourceRef(configured.id, configured.server_name) : gatewayMcpServerResourceRef(execution.server_name);
    const outputRefs = normalizeMcpExecutionResourceRefs(execution.resource_refs);
    const resourceRefs = [configRef, ...outputRefs];
    const now = nowIso();
    const operation: OperationRecord = {
      id: createId("operation"),
      session_id: run.session_id,
      capability_id: proposalCapabilityManifest.id,
      operation: "mcp.call",
      actor_identity: "system",
      instruction_source: "tool_output",
      instruction_authority: "backend_runtime",
      channel: "gateway",
      input_hash: stableHash({
        run_id: run.id,
        tool_call_id: toolCallId,
        server_name: execution.server_name,
        tool_name: execution.tool_name,
        input: args.input ?? {}
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
      provider_tool_name: "mcp.call",
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
        action_id: "mcp.call",
        server_name: execution.server_name,
        tool_name: execution.tool_name,
        reason: execution.reason ?? null,
        error: execution.error ?? null,
        output: execution.output ?? null,
        secret_resolution: execution.secret_resolution as unknown as JsonValue,
        sandbox: execution.sandbox as unknown as JsonValue,
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

  private async buildExternalAssistContext(input: {
    sessionId: string;
    query: string;
    role: "assistive" | "disabled";
    recentMessages: MessageRecord[];
    sessionSearch: Array<{ kind: string; id: string; title: string; summary: string }>;
  }): Promise<ContextPreview["external_assist"]> {
    const prefetchRecords = await this.runExternalAssistPrefetch(input);
    const records = await this.store.listExternalAssistRecords({ sessionId: input.sessionId, limit: 8 });
    const completedPrefetchRecords = prefetchRecords.filter((record) => record.status === "completed");
    const lastPrefetch = completedPrefetchRecords[0] ?? records.find((record) => record.phase === "prefetch" && record.status === "completed");
    const recentFailures = records.filter((record) => record.status === "failed").slice(0, 3);
    const hints = completedPrefetchRecords.length > 0
      ? completedPrefetchRecords.flatMap((record) => record.hints)
      : lastPrefetch?.status === "completed" ? lastPrefetch.hints : [];
    const note = externalAssistNote({
      role: input.role,
      providerId: externalAssistProviderLabel(this.externalAssistProviders),
      prefetchRecords,
      hintCount: hints.length,
      failureCount: recentFailures.length
    });
    return {
      role: input.role,
      isolated_from_memory: true,
      included_in_active_memory: false,
      note,
      hints,
      ...(lastPrefetch ? { last_prefetch: lastPrefetch } : {}),
      recent_failures: recentFailures
    };
  }

  private async runExternalAssistPrefetch(input: {
    sessionId: string;
    query: string;
    role: "assistive" | "disabled";
    recentMessages: MessageRecord[];
    sessionSearch: Array<{ kind: string; id: string; title: string; summary: string }>;
  }): Promise<ExternalAssistRecord[]> {
    if (input.role === "disabled" || this.externalAssistProviders.length === 0) {
      return [];
    }
    return Promise.all(this.externalAssistProviders.map(async (provider) => {
      const now = nowIso();
      try {
        const hints = normalizeExternalAssistHints(await provider.prefetch({
          sessionId: input.sessionId,
          query: input.query,
          recentMessages: input.recentMessages,
          sessionSearch: input.sessionSearch
        }));
        return this.store.saveExternalAssistRecord({
          id: createId("external_assist"),
          phase: "prefetch",
          status: "completed",
          provider_id: provider.id,
          session_id: input.sessionId,
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
          phase: "prefetch",
          status: "failed",
          provider_id: provider.id,
          session_id: input.sessionId,
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

  private async buildKnowledgeWikiContext(query: string): Promise<{
    pages: WikiWithFilePath[];
    entries: ContextPreview["knowledge_wiki"];
    report: ContextPreview["knowledge_wiki_report"];
  }> {
    const retrievedAt = nowIso();
    const matches = await this.store.searchWiki(query, 20, { activeOnly: false });
    const pages: WikiWithFilePath[] = [];
    const entries: ContextPreview["knowledge_wiki"] = [];
    const excluded: ContextPreview["knowledge_wiki_report"]["excluded"] = [];
    for (const wiki of matches) {
      const stateReason = knowledgeWikiExclusionReason(wiki);
      if (stateReason) {
        excluded.push({
          id: wiki.id,
          slug: wiki.slug,
          title: wiki.title,
          state: wiki.state,
          reason: stateReason
        });
        continue;
      }
      const content = (await this.store.readWikiContent(wiki.id)) ?? "";
      if (!content.trim()) {
        excluded.push({
          id: wiki.id,
          slug: wiki.slug,
          title: wiki.title,
          state: wiki.state,
          reason: "empty_content"
        });
        continue;
      }
      if (entries.length < 5) {
        pages.push(wiki);
        entries.push({
          id: wiki.id,
          slug: wiki.slug,
          title: wiki.title,
          content,
          source_refs: wiki.source_refs,
          provenance: wiki.provenance
        });
      }
    }
    return {
      pages,
      entries,
      report: {
        query,
        retrieved_at: retrievedAt,
        candidate_count: matches.length,
        included_count: entries.length,
        included_wiki_ids: entries.map((entry) => entry.id),
        excluded,
        source_refs: entries.flatMap((entry) => entry.source_refs)
      }
    };
  }

  private async buildTasksContextNotes(): Promise<Array<{ collection_id: string; file_path: string; content: string; role: "context_only" }>> {
    const schema = await this.store.getCollectionSchema(TASKS_COLLECTION_ID);
    if (!schema) {
      return [];
    }
    ensureCompatibleTasksCollectionSchema(schema);
    const records = await this.store.listCollectionRecords(TASKS_COLLECTION_ID);
    if (records.length === 0) {
      return [];
    }
    const taskRecords = records.map((record) => taskRecordRenderData(record, schema));
    const active = taskRecords.filter((record) => record.completed !== true);
    const completed = taskRecords.length - active.length;
    const lines = [
      `Tasks summary: ${active.length} active, ${completed} completed.`,
      ...active.slice(0, 8).map((record) => {
        const dueDate = typeof record.due_date === "string" && record.due_date ? ` due:${record.due_date}` : "";
        return `- ${record.title}${dueDate}`;
      })
    ];
    return [{
      collection_id: TASKS_COLLECTION_ID,
      file_path: `collections/${TASKS_COLLECTION_ID}`,
      content: lines.join("\n"),
      role: "context_only"
    }];
  }

  private async buildContextPreview(
    sessionId: string,
    query: string,
    options: {
      contextIntent?: BackendContextIntent;
      skipHeavyContext?: boolean;
      onProgress?: (displayKind: "reasoning_summary" | "activity", text: string, activityKind?: string) => Promise<void>;
    } = {}
  ): Promise<ContextPreview> {
    const skipHeavyContext = options.skipHeavyContext === true;
    const sessionSearchQuery = !skipHeavyContext && query.trim()
      ? timeboxContextStep(this.store.search(query), [], "session_search")
      : Promise.resolve(timeboxContextValue([], false));
    const [session, settings, activeMemoryResult, knowledgeWikiContext, skillCandidates, skillUsage, collectionSchemas, messages, operations, backendRuns, toolRuns, workspaceChanges, searchResults] = await Promise.all([
      this.store.getSession(sessionId),
      this.store.getSettings(),
      skipHeavyContext ? Promise.resolve(emptyActiveMemoryResult(query)) : timeboxContextStep(retrieveActiveMemoryWithReport(this.store, query), emptyActiveMemoryResult(query), "active_memory").then((result) => result.value),
      skipHeavyContext ? Promise.resolve(emptyKnowledgeWikiContext(query)) : timeboxContextStep(this.buildKnowledgeWikiContext(query), emptyKnowledgeWikiContext(query), "knowledge_wiki").then((result) => result.value),
      skipHeavyContext ? Promise.resolve([]) : timeboxContextStep(this.store.searchSkills(query, 12, { states: ["active", "pinned", "project"] }), [], "selected_skills").then((result) => result.value),
      skipHeavyContext ? Promise.resolve([]) : this.store.listSkillUsage(),
      skipHeavyContext ? Promise.resolve([]) : this.store.listCollectionSchemas(),
      this.store.listMessages(sessionId),
      this.store.listOperations(sessionId),
      this.store.listBackendRuns(sessionId),
      this.store.listToolRuns({ sessionId }),
      this.store.listWorkspaceChanges(sessionId),
      sessionSearchQuery
    ]);
    const sessionSearchTimedOut = searchResults.timedOut;
    const sessionSearchValues = searchResults.value;
    if (sessionSearchTimedOut) {
      await options.onProgress?.("reasoning_summary", "過去会話検索が遅いため、今回は軽い文脈のまま実行部へ進めます。");
    }
    await options.onProgress?.("activity", "参照候補を整理", "context_handoff");
    if (!session) {
      throw new RuntimeRequestError("not_found", `Session not found: ${sessionId}`);
    }
    const activeMemory = activeMemoryResult.candidates;
    const skillSelection = selectRuntimeSkills({
      candidates: skillCandidates,
      query,
      limit: hostContextAssemblyLimits.selected_skills
    });
    const selectedSkills = skillSelection.selected.map((item) => item.skill);
    const freezeSnapshot = skipHeavyContext
      ? undefined
      : await loadFreezeSnapshot(this.store, {
          memoryRefs: activeMemory.map((memory) => memoryRef(memory.frontmatter)),
          skillRefs: selectedSkills.map((skill) => skillRef(skill)),
          wikiRefs: knowledgeWikiContext.pages.map((wiki) => wikiRef(wiki))
        });
    const skillUsageById = new Map(skillUsage.map((usage) => [usage.skill_id, usage]));
    const skillSelectionById = new Map(skillSelection.selected.map((item) => [item.skill.id, item.selection]));
    const selectedSkillEntries = await Promise.all(
      selectedSkills.map(async (skill, index) => {
        const markdownContent = stripSkillFrontmatter((await this.store.readSkillMarkdown(skill.id)) ?? "");
        const supportFiles = await this.store.listSkillSupportFiles(skill.id);
        const matchedSupportFiles = selectSkillSupportFiles(supportFiles, query);
        const usage = skillUsageById.get(skill.id);
        const disclosureLevel = decideSkillDisclosureLevel({
          skill,
          index,
          query,
          content: markdownContent,
          matchedSupportFiles
        });
        return {
          id: skill.id,
          title: skill.title,
          description: skill.description,
          tags: skill.tags,
          allowed_scopes: skillAllowedScopes(skill),
          required_capabilities: skill.required_capabilities,
          disclosure_level: disclosureLevel,
          selection_reason: describeSkillSelection(disclosureLevel, index, matchedSupportFiles, usage, skillSelectionById.get(skill.id)),
          selection: skillSelectionById.get(skill.id),
          usage: usage
            ? {
                use_count: usage.use_count,
                ...(usage.last_used_at ? { last_used_at: usage.last_used_at } : {})
              }
            : undefined,
          content: disclosureLevel === "catalog" ? undefined : markdownContent,
          support_file_refs: supportFiles.map((file) => ({ path: file.path, file_path: file.file_path })),
          support_files: disclosureLevel === "support"
            ? matchedSupportFiles.map((file) => ({ path: file.path, file_path: file.file_path, content: file.content.trim() }))
            : undefined
        };
      })
    );
    const allCollectionNotes = (await Promise.all(
      collectionSchemas.map(async (schema) => {
        const notes = await this.store.listCollectionNotes(schema.id);
        return notes.map((note) => ({
          collection_id: schema.id,
          file_path: note.file_path,
          content: note.content.trim(),
          role: "context_only" as const
        }));
      })
    )).flat();
    const collectionNotes = selectCollectionNotes(allCollectionNotes, query);
    const taskContextNotes = skipHeavyContext ? [] : await this.buildTasksContextNotes();
    const collectionContextNotes = [...taskContextNotes, ...collectionNotes];
    const knowledgeWiki = knowledgeWikiContext.entries;
    const sessionSearchForBackend = shouldIncludeSessionSearchInBackendContext(query)
      ? sessionSearchValues.slice(0, hostContextAssemblyLimits.session_search)
      : [];
    const sessionSearch = sessionSearchForBackend.map((result) => ({
      kind: result.kind,
      id: result.id,
      title: result.title,
      summary: result.summary
    }));
    const recentMessageRecords = messages.slice(-10);
    const recentMessages = recentMessageRecords.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content
    }));
    const availableTools = proposalCapabilityManifest.agent_tools;
    const externalAssist = skipHeavyContext
      ? emptyExternalAssistContext(settings.external_provider_role, "External assist was skipped for this lightweight chat turn.")
      : await this.buildExternalAssistContext({
          sessionId,
          query,
          role: settings.external_provider_role,
          recentMessages: recentMessageRecords,
          sessionSearch
        });
    const lastMessage = messages.at(-1);
    const lastBackendRun = backendRuns[0];
    const contextAssembly = buildHostContextAssembly({
      sessionId,
      query,
      sessionFound: true,
      messageCount: messages.length,
      recentMessageCount: recentMessages.length,
      freezeSnapshotPresent: Boolean(freezeSnapshot),
      activeMemoryCount: activeMemory.length,
      activeMemoryCandidateCount: activeMemoryResult.report.candidate_count,
      knowledgeWikiCandidateCount: knowledgeWikiContext.report.candidate_count,
      knowledgeWikiIncludedCount: knowledgeWiki.length,
      collectionNoteCandidateCount: allCollectionNotes.length + taskContextNotes.length,
      collectionNoteIncludedCount: collectionContextNotes.length,
      selectedSkillCount: selectedSkillEntries.length,
      sessionSearchCandidateCount: sessionSearchValues.length,
      sessionSearchIncludedCount: sessionSearch.length,
      externalAssistRole: settings.external_provider_role,
      externalAssistHintCount: externalAssist.hints.length,
      externalAssistFailureCount: externalAssist.recent_failures.length,
      availableToolCount: availableTools.length,
      skippedSourceKinds: skipHeavyContext
        ? new Set(["freeze_snapshot", "active_memory", "knowledge_wiki", "collection_notes", "selected_skills", "session_search", "external_assist"])
        : sessionSearchTimedOut
          ? new Set(["session_search"])
        : undefined
    });

    return {
      session_id: sessionId,
      query,
      context_assembly: contextAssembly,
      session_summary: {
        session_key: session.session_key,
        title: session.title,
        ui_locale: session.ui_locale,
        output_locale: session.output_locale,
        message_count: messages.length,
        operation_count: operations.length,
        backend_run_count: backendRuns.length,
        tool_run_count: toolRuns.length,
        workspace_change_count: workspaceChanges.length,
        ...(lastMessage ? { last_message_at: lastMessage.created_at } : {}),
        ...(lastBackendRun ? { last_backend_run_id: lastBackendRun.id } : {}),
        ...(lastBackendRun ? { last_backend_run_status: lastBackendRun.status } : {})
      },
      external_assist: externalAssist,
      freeze_snapshot: freezeSnapshot,
      active_memory: activeMemory.map((memory) => ({
        ...activeMemoryPreviewEntry(memory)
      })),
      active_memory_report: activeMemoryResult.report,
      knowledge_wiki: knowledgeWiki,
      knowledge_wiki_report: knowledgeWikiContext.report,
      collection_notes: collectionContextNotes,
      skill_selection_report: skillSelection.report,
      selected_skills: selectedSkillEntries,
      session_search: sessionSearch,
      recent_messages: recentMessages,
      available_tools: availableTools
    };
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
  }): Promise<ReflectionRuntimeResult> {
    const startedAt = nowIso();
    let reflectionRun: ReflectionRunRecord = {
      id: createId("reflection"),
      kind: input.kind,
      source_run_id: input.sourceRunId ?? input.backendRun?.id,
      session_id: input.session.id,
      status: "started",
      input_summary: summarize(input.userMessage?.content ?? input.session.title),
      started_at: startedAt
    };
    reflectionRun = await this.store.createReflectionRun(reflectionRun);
    const suggestions = this.createReflectionSuggestions(reflectionRun, input);
    for (const suggestion of suggestions) {
      await this.store.saveReflectionSuggestion(suggestion);
    }
    reflectionRun = {
      ...reflectionRun,
      status: "completed",
      output_summary: suggestions.length ? `Created ${suggestions.length} reflection suggestion(s).` : "No reflection suggestions.",
      completed_at: nowIso()
    };
    reflectionRun = await this.store.updateReflectionRun(reflectionRun);
    return { reflectionRun, suggestions };
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

  private createReflectionSuggestions(
    reflectionRun: ReflectionRunRecord,
    input: {
      userMessage?: MessageRecord;
      agentMessage?: MessageRecord;
      backendRun?: BackendRunRecord;
      backendEvents: BackendEventRecord[];
      workspaceChanges: WorkspaceChangeRecord[];
      toolRuns: ToolRunRecord[];
      transcriptMessages?: MessageRecord[];
      artifacts?: ReflectionArtifactSnapshot[];
    }
  ): ReflectionSuggestionRecord[] {
    const now = nowIso();
    const backendEventRefs: ResourceRef[] = input.backendEvents.slice(0, 10).map((event) => ({
      kind: "backend_event",
      id: event.id,
      uri: `backend-events/${event.id}`,
      label: event.event_type
    }));
    const artifactRefs = (input.artifacts ?? []).map((snapshot) => snapshot.artifact.file_ref);
    const sourceRefs: ReflectionSuggestionRecord["source_refs"] = [
      ...(input.backendRun
        ? [{
            kind: "backend_run",
            id: input.backendRun.id,
            uri: `backend-runs/${input.backendRun.id}`,
            label: input.backendRun.input_summary
          }]
        : []),
      ...(input.userMessage
        ? [{
            kind: "message",
            id: input.userMessage.id,
            uri: `messages/${input.userMessage.id}`,
            label: "User message"
          }]
        : []),
      ...backendEventRefs,
      ...artifactRefs
    ];
    const suggestions: ReflectionSuggestionRecord[] = [];
    const userContent = input.userMessage?.content ?? "";
    const agentContent = input.agentMessage?.content ?? "";
    const transcriptSummary = renderReflectionTranscriptExcerpt(input.transcriptMessages ?? []);
    const artifactContext = renderReflectionArtifactContext(input.artifacts ?? []);
    const backendEventSummary = input.backendEvents.slice(0, 20)
      .map((event) => `${event.event_type}: ${summarize(JSON.stringify(event.payload), 160)}`)
      .join("\n");
    const toolRunRefs: ResourceRef[] = input.toolRuns.slice(0, 10).map((toolRun) => ({
      kind: "tool_run",
      id: toolRun.id,
      uri: `tool-runs/${toolRun.id}`,
      label: `${toolRun.provider_tool_name}:${toolRun.status}`
    }));
    if (/覚えて|今後|preference|remember|好み|文体/i.test(userContent)) {
      suggestions.push({
        id: createId("suggestion"),
        reflection_run_id: reflectionRun.id,
        suggestion_type: "memory",
        status: "proposed",
        title: "Memory candidate",
        content: userContent,
        source_refs: sourceRefs,
        confidence: 0.72,
        created_at: now,
        updated_at: now
      });
    }
    if (input.workspaceChanges.some((change) => change.change_type === "artifact_created") || /設計|調査|仕様|wiki|knowledge/i.test(userContent)) {
      suggestions.push({
        id: createId("suggestion"),
        reflection_run_id: reflectionRun.id,
        suggestion_type: "knowledge_wiki",
        status: "proposed",
        title: "Knowledge Wiki proposal",
        content: summarize(renderReflectionKnowledgeWikiProposal({
          userContent,
          agentContent,
          transcriptSummary,
          artifactContext,
          backendEventSummary
        }), 1400),
        source_refs: uniqueResourceRefs(sourceRefs),
        confidence: 0.6,
        created_at: now,
        updated_at: now
      });
    }
    const skillSignals = analyzeSkillCandidateSignals(userContent, agentContent, input.toolRuns);
    if (/手順|毎回|次回|次から|今後|skill|workflow|やり方/i.test(userContent) || skillSignals.shouldSuggest) {
      suggestions.push({
        id: createId("suggestion"),
        reflection_run_id: reflectionRun.id,
        suggestion_type: "skill",
        status: "proposed",
        title: skillSignals.title,
        content: skillCandidateContentFromTrace(userContent, input.toolRuns, skillSignals),
        source_refs: uniqueResourceRefs([...sourceRefs, ...toolRunRefs]),
        confidence: skillSignals.confidence,
        created_at: now,
        updated_at: now
      });
    }
    if (input.toolRuns.some((toolRun) => toolRun.status === "ignored" || toolRun.status === "failed")) {
      suggestions.push({
        id: createId("suggestion"),
        reflection_run_id: reflectionRun.id,
        suggestion_type: "conflict",
        status: "proposed",
        title: "Tool boundary review",
        content: input.toolRuns.filter((toolRun) => toolRun.status !== "completed").map((toolRun) => `${toolRun.provider_tool_name}: ${toolRun.output_summary}`).join("\n"),
        source_refs: sourceRefs,
        confidence: 0.58,
        created_at: now,
        updated_at: now
      });
    }
    return suggestions;
  }

  private createEvaluationTraceSuggestions(
    reflectionRun: ReflectionRunRecord,
    input: {
      skills: SkillWithFilePath[];
      backendRuns: BackendRunRecord[];
      backendEvents: BackendEventRecord[];
      workspaceChanges: WorkspaceChangeRecord[];
      toolRuns: ToolRunRecord[];
      auditRecords: AuditRecord[];
      now: string;
    }
  ): ReflectionSuggestionRecord[] {
    const eventsByRun = groupByRunId(input.backendEvents);
    const changesByRun = groupByRunId(input.workspaceChanges);
    const toolsByRun = groupByRunId(input.toolRuns);
    const suggestions: ReflectionSuggestionRecord[] = [];
    const seen = new Set<string>();
    const pushSuggestion = (suggestion: ReflectionSuggestionRecord, fingerprint: string) => {
      if (suggestions.length >= 20 || seen.has(fingerprint)) {
        return;
      }
      seen.add(fingerprint);
      suggestions.push(suggestion);
    };

    for (const run of input.backendRuns.slice(0, 30)) {
      const runEvents = eventsByRun.get(run.id) ?? [];
      const runChanges = changesByRun.get(run.id) ?? [];
      const meaningfulChanges = runChanges.filter((change) => !isAutomaticSessionMemoryChange(change));
      const runTools = toolsByRun.get(run.id) ?? [];
      const nonCompletedTools = runTools.filter((toolRun) => toolRun.status !== "completed");
      const sourceRefs = uniqueResourceRefs([
        backendRunRef(run),
        ...runTools.flatMap((toolRun) => toolRun.resource_refs),
        ...meaningfulChanges.map((change) => change.resource_ref)
      ]);

      if (run.status === "failed" || run.status === "cancelled") {
        pushSuggestion({
          id: createId("suggestion"),
          reflection_run_id: reflectionRun.id,
          suggestion_type: "skill_patch",
          status: "proposed",
          title: `Backend trace recovery: ${run.backend_id}`,
          content: renderEvaluationTraceSummary({
            run,
            events: runEvents,
            changes: meaningfulChanges,
            toolRuns: runTools,
            auditRecords: input.auditRecords,
            recommendation: "Add or update a Skill so this failure path has an explicit recovery checklist, retry condition, or fallback backend route."
          }),
          source_refs: sourceRefs,
          confidence: run.status === "failed" ? 0.76 : 0.62,
          created_at: input.now,
          updated_at: input.now
        }, `run-status:${run.id}:${run.status}`);
      }

      if (run.status === "waiting_for_backend_input") {
        pushSuggestion({
          id: createId("suggestion"),
          reflection_run_id: reflectionRun.id,
          suggestion_type: "skill_patch",
          status: "proposed",
          title: `Resume playbook needed: ${run.backend_id}`,
          content: renderEvaluationTraceSummary({
            run,
            events: runEvents,
            changes: meaningfulChanges,
            toolRuns: runTools,
            auditRecords: input.auditRecords,
            recommendation: "Document the backend native input, retry, and resume handoff so the Host can surface the next required action instead of leaving the run ambiguous."
          }),
          source_refs: sourceRefs,
          confidence: 0.72,
          created_at: input.now,
          updated_at: input.now
        }, `waiting:${run.id}`);
      }

      if (nonCompletedTools.length) {
        pushSuggestion({
          id: createId("suggestion"),
          reflection_run_id: reflectionRun.id,
          suggestion_type: "conflict",
          status: "proposed",
          title: `Tool boundary review: ${nonCompletedTools[0]?.provider_tool_name ?? run.backend_id}`,
          content: renderEvaluationTraceSummary({
            run,
            events: runEvents,
            changes: meaningfulChanges,
            toolRuns: nonCompletedTools,
            auditRecords: input.auditRecords,
            recommendation: "Review the selected tool names, allowed scopes, and policy boundary. Convert repeated ignored or failed tool calls into a Skill correction instead of silently retrying."
          }),
          source_refs: sourceRefs,
          confidence: 0.7,
          created_at: input.now,
          updated_at: input.now
        }, `tool-boundary:${run.id}:${nonCompletedTools.map((toolRun) => toolRun.provider_tool_name).join(",")}`);
      }

      if (shouldReviewNoActionTrace(run, runEvents, runTools, meaningfulChanges)) {
        pushSuggestion({
          id: createId("suggestion"),
          reflection_run_id: reflectionRun.id,
          suggestion_type: "skill_patch",
          status: "proposed",
          title: `No workspace effect trace: ${summarize(run.input_summary, 60)}`,
          content: renderEvaluationTraceSummary({
            run,
            events: runEvents,
            changes: meaningfulChanges,
            toolRuns: runTools,
            auditRecords: input.auditRecords,
            recommendation: "The request appears to ask for a workspace effect, but the trace has no concrete tool run or workspace change. Add a Skill or policy hint that maps this intent to the correct backend action."
          }),
          source_refs: sourceRefs,
          confidence: 0.6,
          created_at: input.now,
          updated_at: input.now
        }, `no-effect:${run.id}`);
      }
    }

    if (!suggestions.length && input.backendRuns.length && input.skills.length) {
      suggestions.push({
        id: createId("suggestion"),
        reflection_run_id: reflectionRun.id,
        suggestion_type: "skill_patch",
        status: "proposed",
        title: "Execution trace checkpoint",
        content: `Reviewed ${input.backendRuns.length} backend run(s), ${input.backendEvents.length} event(s), ${input.workspaceChanges.length} workspace change(s), and ${input.toolRuns.length} tool run(s). No anomalies were detected; use this checkpoint to sample Skill coverage against recent successful traces.`,
        source_refs: input.backendRuns.slice(0, 5).map(backendRunRef),
        confidence: 0.5,
        created_at: input.now,
        updated_at: input.now
      });
    }

    return suggestions;
  }

  private async createOperation(
    session: SessionRecord,
    envelope: MessageEnvelope,
    operationName: string,
    proposedEffects: string[],
    options: {
      context?: GatewayContext;
      inputRef?: OperationRecord["input_ref"];
      targetResourceRefs?: OperationRecord["target_resource_refs"];
    } = {}
  ): Promise<OperationRecord> {
    const now = nowIso();
    const context = options.context ?? webGatewayContext;
    const operation: OperationRecord = {
      id: createId("operation"),
      session_id: session.id,
      capability_id: proposalCapabilityManifest.id,
      operation: operationName,
      actor_identity: context.actor_identity,
      instruction_source: context.instruction_source,
      instruction_authority: context.actor_identity,
      channel: context.channel,
      input_hash: stableHash({
        envelope,
        operationName,
        proposedEffects
      }),
      input_ref: options.inputRef ?? {
        kind: "message",
        id: envelope.id,
        uri: `messages/${envelope.id}`,
        label: context.source === "cron" ? "Scheduled context" : "User message"
      },
      target_resource_refs: options.targetResourceRefs ?? [],
      proposed_effects: proposedEffects,
      status: "created",
      created_at: now,
      updated_at: now
    };

    await this.store.saveOperation(operation);
    await this.emit("operation.created", operation);
    return operation;
  }

  private async executeApprovedExternalDispatch(
    approval: ApprovalRequest,
    operation: OperationRecord,
    decision: PolicyDecisionRecord
  ): Promise<ApprovalLifecycleResult> {
    const sendId = operation.input_ref?.kind === "external_send" ? operation.input_ref.id : operation.target_resource_refs.find((ref) => ref.kind === "external_send")?.id;
    if (!sendId) {
      throw new RuntimeRequestError("conflict", "external_send_ref_missing");
    }
    const send = await this.store.getExternalSend(sendId);
    if (!send) {
      throw new RuntimeRequestError("not_found", `External send not found: ${sendId}`);
    }
    const result = await dispatchExternalSendAdapter(send, process.env.SAMURAI_EXTERNAL_SEND_DISPATCH !== "true");
    const now = nowIso();
    const saved = await this.store.saveExternalSend({
      ...send,
      status: externalSendStatusFromDispatchResult(result),
      operation_id: operation.id,
      approval_request_id: approval.id,
      dispatch_result: result as Record<string, JsonValue>,
      updated_at: now,
      dispatched_at: result.dispatched ? now : undefined
    });
    const ref = externalSendRef(saved);
    operation.policy_decision_id = decision.id;
    operation.approval_request_id = approval.id;
    operation.status = "completed";
    operation.result_ref = ref;
    operation.updated_at = now;
    await this.store.updateOperation(operation);
    const audit = await this.auditOperation(
      operation,
      decision,
      externalSendDispatchSummary(saved, result),
      [ref],
      undefined
    );
    return {
      approvalRequest: approval,
      operation,
      auditRecord: audit,
      activity: await this.rebuildActivity(),
      status: "approved"
    };
  }

  private async ensureSessionForContext(context: GatewayContext, title: string): Promise<SessionRecord> {
    const existing = (await this.store.listSessions()).find((session) => session.session_key === context.session_key);
    if (existing) {
      return existing;
    }
    const settings = await this.store.getSettings();
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: context.session_key,
      title,
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now,
      updated_at: now
    };
    await this.store.createSession(session);
    await this.emit("session.created", session);
    return session;
  }

  private async findRecentGatewayInboundDuplicate(
    channel: GatewayInboundMessageRecord["channel"],
    sourceIdentity: string,
    body: string,
    duplicateWindowMs = 60_000
  ): Promise<GatewayInboundMessageRecord | undefined> {
    const cutoff = Date.now() - duplicateWindowMs;
    const recent = await this.store.listGatewayInboundMessages({ limit: 50 });
    return recent.find((message) =>
      message.channel === channel
      && message.source_identity === sourceIdentity
      && message.body === body
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

  private async runAllowedWrite<TResource, TExtra extends Record<string, unknown> = Record<string, never>>(input: {
    session: SessionRecord;
    envelope: MessageEnvelope;
    context: GatewayContext;
    operationName: string;
    proposedEffects: string[];
    inputRef?: OperationRecord["input_ref"];
    targetResourceRefs?: OperationRecord["target_resource_refs"];
    execute: (operation: OperationRecord) => Promise<{
      resource: TResource;
      ref: NonNullable<OperationRecord["result_ref"]>;
      rollbackPoint?: RollbackPoint;
      summary: string;
    } & TExtra>;
  }): Promise<RuntimeWriteResult<TResource> & TExtra> {
    const operation = await this.createOperation(input.session, input.envelope, input.operationName, input.proposedEffects, {
      context: input.context,
      inputRef: input.inputRef,
      targetResourceRefs: input.targetResourceRefs
    });
    const manifest = getCapabilityManifest(operation.capability_id);
    const decision = await this.savePolicyDecision(evaluatePolicy({
      input: this.createPolicyInput(operation),
      manifest,
      grants: await this.store.listGrants(),
      operationId: operation.id
    }));
    operation.policy_decision_id = decision.id;

    if (decision.decision !== "allow_auto" && decision.decision !== "allow_with_audit") {
      operation.status = decision.decision === "deny" ? "denied" : "pending_approval";
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      const audit = await this.auditOperation(operation, decision, "Write operation was not executed by policy.", [], undefined);
      const approvalRequest = await this.createApprovalRequest(operation, decision);
      operation.approval_request_id = approvalRequest.id;
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      throw new RuntimeRequestError(decision.decision === "deny" ? "forbidden" : "conflict", "policy_blocked", {
        approvalRequest,
        operation,
        auditRecord: audit,
        activity: await this.rebuildActivity(),
        status: decision.decision === "deny" ? "denied" : "approved"
      });
    }

    try {
      const execution = await input.execute(operation);
      operation.status = "completed";
      operation.result_ref = execution.ref;
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      const audit = await this.auditOperation(operation, decision, execution.summary, [execution.ref], execution.rollbackPoint?.id);
      const activity = await this.rebuildActivity();
      const { resource, ref: _ref, rollbackPoint, summary: _summary, ...extra } = execution;
      return {
        resource,
        operation,
        policyDecision: decision,
        auditRecord: audit,
        ...(rollbackPoint ? { rollbackPoint } : {}),
        activity,
        ...((extra as unknown) as TExtra)
      };
    } catch (error) {
      operation.status = "failed";
      operation.error = safeRuntimeErrorMessage(error);
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      await this.auditOperation(operation, decision, "Write operation failed before completion.", [], undefined);
      throw new RuntimeRequestError("conflict", operation.error);
    }
  }

  private async updateWikiState(
    id: string,
    state: WikiFrontmatter["state"],
    operationName: string,
    effect: string,
    summaryPrefix: string
  ): Promise<WikiRuntimeResult> {
    const current = await this.store.getWiki(id);
    if (!current) {
      throw new RuntimeRequestError("not_found", `Wiki page not found: ${id}`);
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `${summaryPrefix}: ${current.title}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName,
      proposedEffects: [effect],
      targetResourceRefs: [wikiRef(current)],
      execute: async (operation) => {
        const saved = await this.store.setWikiState(id, state);
        if (!saved) {
          throw new RuntimeRequestError("not_found", `Wiki page not found: ${id}`);
        }
        const ref = wikiRef(saved);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { wiki: current as unknown as JsonValue },
          { wiki: saved as unknown as JsonValue }
        );
        return { resource: saved, ref, rollbackPoint, summary: `${summaryPrefix} ${saved.title}.` };
      }
    });
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

  private async createMemoryArchiveOperation(
    session: SessionRecord,
    memory: MemoryFrontmatter & { file_path: string },
    actorIdentity: OperationRecord["actor_identity"],
    decidedBy: string
  ): Promise<OperationRecord> {
    const now = nowIso();
    const ref = memoryRef(memory);
    const operation: OperationRecord = {
      id: createId("operation"),
      session_id: session.id,
      capability_id: proposalCapabilityManifest.id,
      operation: "memory.archive",
      actor_identity: actorIdentity,
      instruction_source: "owner_instruction",
      instruction_authority: decidedBy,
      channel: "web",
      input_hash: stableHash({
        memory_id: memory.id,
        session_id: session.id,
        operationName: "memory.archive"
      }),
      input_ref: ref,
      target_resource_refs: [ref],
      proposed_effects: ["Archive a session-linked memory so it no longer appears in normal memory views."],
      status: "created",
      created_at: now,
      updated_at: now
    };
    await this.store.saveOperation(operation);
    await this.emit("operation.created", operation);
    return operation;
  }

  private async savePolicyDecision(decision: PolicyDecisionRecord): Promise<PolicyDecisionRecord> {
    const saved = await this.store.savePolicyDecision(decision);
    await this.emit("policy.decided", saved);
    return saved;
  }

  private assertApprovalCanBeDecided(approval: ApprovalRequest, operation: OperationRecord): void {
    if (
      approval.status !== "pending" ||
      operation.status !== "pending_approval" ||
      operation.approval_request_id !== approval.id ||
      approval.operation_id !== operation.id
    ) {
      throw new RuntimeRequestError("conflict", "Approval request is no longer pending for this operation.");
    }
  }

  private async getSavedDecisionForApproval(operation: OperationRecord): Promise<PolicyDecisionRecord> {
    if (!operation.policy_decision_id) {
      throw new RuntimeRequestError("conflict", "Operation has no saved policy decision.");
    }

    const decision = await this.store.getPolicyDecision(operation.policy_decision_id);
    if (!decision) {
      throw new RuntimeRequestError("conflict", "Saved policy decision was not found.");
    }

    return decision;
  }

  private async expireApprovalRequest(
    approval: ApprovalRequest,
    operation: OperationRecord,
    decidedBy: string
  ): Promise<ApprovalLifecycleResult> {
    const decision = await this.getSavedDecisionForApproval(operation);
    const expired: ApprovalRequest = {
      ...approval,
      status: "expired",
      decided_by: decidedBy,
      decided_at: nowIso()
    };
    await this.store.updateApprovalRequest(expired);

    operation.status = "deferred";
    operation.result_ref = {
      kind: "approval",
      id: expired.id,
      uri: `approval_requests/${expired.id}`,
      label: "Approval expired without execution"
    };
    operation.updated_at = nowIso();
    await this.store.updateOperation(operation);

    const audit = await this.auditOperation(operation, decision, "Approval expired. v1 deferred the operation without execution.", [], undefined);
    return {
      approvalRequest: expired,
      operation,
      auditRecord: audit,
      activity: await this.rebuildActivity(),
      status: "expired"
    };
  }

  private async executeAllowedOperation(
    operation: OperationRecord,
    decision: PolicyDecisionRecord,
    envelope: MessageEnvelope,
    operationPlan: OperationPlan
  ): Promise<{
    resultRef?: OperationRecord["result_ref"];
    artifact?: ArtifactRecord;
    memory?: MemoryFrontmatter;
    rollbackPoint?: RollbackPoint;
    affectedResources: OperationRecord["target_resource_refs"];
    summary: string;
  }> {
    if (operation.operation === "artifact.create") {
      if (!operationPlan.artifact) {
        throw new RuntimeRequestError("conflict", "artifact_missing");
      }
      const artifact = await createArtifactDraft({
        store: this.store,
        operation,
        title: operationPlan.artifact.title,
        content: operationPlan.artifact.content,
        locale: envelope.output_locale,
        sourceLocales: [envelope.input_locale],
        createdBy: "runtime"
      });
      const affectedResources = [artifact.file_ref];
      const rollbackPoint = await this.createRollbackPoint(operation, affectedResources, {}, { artifact_id: artifact.id });
      return {
        resultRef: artifact.file_ref,
        artifact,
        rollbackPoint,
        affectedResources,
        summary: `Created artifact ${artifact.title}.`
      };
    }

    if (operation.operation === "memory.session.create") {
      const memory = await createSessionMemory(this.store, envelope, envelope.user_intent);
      const ref = {
        kind: "memory",
        id: memory.id,
        uri: `memory/${memory.state}/${memory.id}.md`,
        label: memory.topic
      };
      const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { memory_id: memory.id });
      return {
        resultRef: ref,
        memory,
        rollbackPoint,
        affectedResources: [ref],
        summary: "Created session memory."
      };
    }

    if (operation.operation === "memory.topic.create") {
      const memory = await createTopicMemory(this.store, envelope, "preference", envelope.user_intent);
      const ref = {
        kind: "memory",
        id: memory.id,
        uri: `memory/${memory.state}/${memory.id}.md`,
        label: memory.topic
      };
      const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { memory_id: memory.id });
      return {
        resultRef: ref,
        memory,
        rollbackPoint,
        affectedResources: [ref],
        summary: decision.decision === "allow_with_audit" ? "Created topic memory with visible audit." : "Created topic memory."
      };
    }

    return {
      affectedResources: [],
      summary: "No state change executed."
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

  private async createApprovalRequest(operation: OperationRecord, decision: PolicyDecisionRecord): Promise<ApprovalRequest> {
    const now = nowIso();
    const expiresAt = new Date(Date.parse(now) + 1000 * 60 * 60 * 24).toISOString();
    const request: ApprovalRequest = {
      id: createId("approval"),
      operation_id: operation.id,
      requested_level: decision.required_approval_level === "strong_approval" ? "strong_approval" : "approval",
      status: "pending",
      reason: decision.reason,
      requested_by: "runtime",
      created_at: now,
      expires_at: expiresAt
    };
    return this.store.saveApprovalRequest(request);
  }

  private async auditOperation(
    operation: OperationRecord,
    decision: PolicyDecisionRecord,
    outputsSummary: string,
    affectedResources: AuditRecord["affected_resources"],
    rollbackPointId?: string
  ): Promise<AuditRecord> {
    const audit = createAuditRecord({
      actor_identity: operation.actor_identity,
      operation_id: operation.id,
      capability_id: operation.capability_id,
      instruction_source: operation.instruction_source,
      inputs_summary: operation.proposed_effects.join(" "),
      outputs_summary: outputsSummary,
      policy_decision_id: decision.id,
      affected_resources: affectedResources,
      rollback_point_id: rollbackPointId
    });
    await this.store.saveAuditRecord(audit);
    await this.emit("audit.recorded", audit);
    return audit;
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

  private createOperationPlans(providerOutput: ProviderOutput): OperationPlan[] {
    const operations: OperationPlan[] = [
      {
        operation: "memory.session.create",
        proposedEffects: ["Keep the current user intent in session memory."]
      }
    ];

    for (const toolCall of providerOutput.toolCalls) {
      const plan = this.operationPlanFromToolCall(toolCall);
      if (!plan) {
        continue;
      }
      if (plan.operation === "artifact.create") {
        operations.unshift(plan);
      } else {
        operations.push(plan);
      }
    }

    return operations;
  }

  private operationPlanFromToolCall(toolCall: ProviderToolCall): OperationPlan | undefined {
    if (toolCall.name === "create_artifact") {
      const title = stringArg(toolCall.arguments.title).trim();
      const content = stringArg(toolCall.arguments.content).trim();
      if (!title || !content) {
        return undefined;
      }
      const command = getDomainCommandForProviderToolName(toolCall.name) ?? requireDomainCommandEntry("artifact.create");
      return {
        operation: command.id,
        proposedEffects: command.proposed_effects,
        toolCall,
        artifact: {
          title,
          content,
          ...(stringArg(toolCall.arguments.preview).trim() ? { preview: stringArg(toolCall.arguments.preview).trim() } : {})
        }
      };
    }

    if (toolCall.name === "remember_topic") {
      const command = getDomainCommandForProviderToolName(toolCall.name) ?? requireDomainCommandEntry("memory.topic.create");
      return {
        operation: command.id,
        proposedEffects: command.proposed_effects,
        toolCall
      };
    }

    if (toolCall.name === "request_external_send") {
      const command = getDomainCommandForProviderToolName(toolCall.name) ?? requireDomainCommandEntry("external.send");
      return {
        operation: command.id,
        proposedEffects: command.proposed_effects,
        toolCall
      };
    }

    if (toolCall.name === "request_delete") {
      const command = getDomainCommandForProviderToolName(toolCall.name) ?? requireDomainCommandEntry("workspace.delete");
      return {
        operation: command.id,
        proposedEffects: command.proposed_effects,
        toolCall
      };
    }

    return undefined;
  }

  private async rebuildActivity(): Promise<ActivityInboxItem[]> {
    const activity = buildActivityInboxItems(await this.store.readActivityInputs());
    await this.emit("activity.updated", activity);
    return activity;
  }
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

function latestBackendRunActivityMs(runs: BackendRunRecord[]): number | undefined {
  const timestamps = runs
    .flatMap((run) => [run.completed_at, run.started_at])
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return timestamps.length ? Math.max(...timestamps) : undefined;
}

function buildCuratorLifecycleReport(input: {
  now: string;
  dryRun: boolean;
  paused: boolean;
  skippedReason?: string;
  curatorState: CuratorStateRecord;
  memories: MemoryFrontmatter[];
  wikiPages: WikiWithFilePath[];
  skills: SkillWithFilePath[];
  skillUsage: Array<{ skill_id: string }>;
  suggestions: ReflectionSuggestionRecord[];
  skillActions: CuratorLifecycleReport["skill_actions"];
  protectedSkills: CuratorLifecycleReport["protected_skills"];
}): CuratorLifecycleReport {
  return CuratorLifecycleReportSchema.parse({
    id: `curator_report_${input.now.replace(/[^0-9A-Za-z]/g, "")}`,
    checked_at: input.now,
    dry_run: input.dryRun,
    paused: input.paused,
    ...(input.skippedReason ? { skipped_reason: input.skippedReason } : {}),
    thresholds: {
      stale_after_days: input.curatorState.stale_after_days,
      archive_after_days: input.curatorState.archive_after_days,
      min_idle_hours: input.curatorState.min_idle_hours
    },
    counts: {
      memory_items: input.memories.length,
      wiki_pages: input.wikiPages.length,
      skill_items: input.skills.length,
      skill_usage_rows: input.skillUsage.length,
      suggestions: input.suggestions.length
    },
    skill_actions: input.skillActions,
    protected_skills: input.protectedSkills
  });
}

function buildCuratorReviewReport(input: {
  now: string;
  dryRun: boolean;
  keepCandidates: CuratorReviewReport["keep_candidates"];
  memoryMergeGroups: CuratorReviewReport["memory_merge_groups"];
  skillConsolidationGroups: CuratorReviewReport["skill_consolidation_groups"];
  wikiPatchProposals: CuratorReviewReport["wiki_patch_proposals"];
  archiveCandidates: CuratorReviewReport["archive_candidates"];
}): CuratorReviewReport {
  return CuratorReviewReportSchema.parse({
    id: `curator_review_${input.now.replace(/[^0-9A-Za-z]/g, "")}`,
    checked_at: input.now,
    dry_run: input.dryRun,
    counts: {
      keep_candidates: input.keepCandidates.length,
      patch_candidates: input.wikiPatchProposals.length,
      consolidate_candidates: input.memoryMergeGroups.length + input.skillConsolidationGroups.length,
      archive_candidates: input.archiveCandidates.length
    },
    keep_candidates: input.keepCandidates,
    memory_merge_groups: input.memoryMergeGroups,
    skill_consolidation_groups: input.skillConsolidationGroups,
    wiki_patch_proposals: input.wikiPatchProposals,
    archive_candidates: input.archiveCandidates
  });
}

function buildSkillConsolidationGroups(skills: SkillWithFilePath[]): Array<{
  groupKey: string;
  suggestedTitle: string;
  reason: string;
  skills: SkillWithFilePath[];
}> {
  const groups = new Map<string, SkillWithFilePath[]>();
  for (const skill of skills) {
    if (skill.state === "archived" || skill.state === "pinned" || skill.frontmatter.owner_pinned) {
      continue;
    }
    const capability = skill.required_capabilities[0];
    const tag = skill.tags[0];
    const titleTerm = skillQueryTerms(`${skill.title} ${skill.description}`)[0];
    const key = normalizeSkillSearchText(capability ?? tag ?? titleTerm ?? "");
    if (!key || key.length < 3) {
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  return [...groups.entries()]
    .map(([groupKey, groupSkills]) => ({ groupKey, groupSkills }))
    .filter((entry) => entry.groupSkills.length >= 2)
    .map(({ groupKey, groupSkills }) => ({
      groupKey,
      suggestedTitle: `${groupSkills[0]!.title} umbrella`,
      reason: "Similar Skills share a capability, tag, or title term; review whether they should be consolidated under one reusable workflow.",
      skills: groupSkills.slice(0, 5)
    }));
}

function proposedSkillStateForCuratorAction(action: CuratorLifecycleAction): SkillState | undefined {
  if (action === "mark_stale") {
    return "stale";
  }
  if (action === "archive") {
    return "archived";
  }
  if (action === "reactivate") {
    return "project";
  }
  return undefined;
}

function curatorActionReason(input: {
  action: CuratorLifecycleAction;
  usageCount: number;
  inactiveSince: string;
  staleAfterDays: number;
  archiveAfterDays: number;
}): string {
  if (input.action === "archive") {
    return `No recent activity since ${input.inactiveSince}; exceeds archive threshold of ${input.archiveAfterDays} day(s).`;
  }
  if (input.action === "mark_stale") {
    return `No recent activity since ${input.inactiveSince}; exceeds stale threshold of ${input.staleAfterDays} day(s).`;
  }
  if (input.action === "reactivate") {
    return `Recent usage detected (${input.usageCount} run(s)); restore from stale to project state.`;
  }
  return "Needs human review before lifecycle transition.";
}

interface SkillCandidateSignals {
  repeated_tools: Array<{ name: string; count: number }>;
  failed_or_ignored_tools: ToolRunRecord[];
  correction_signals: string[];
  trace_looks_reusable: boolean;
  trace_needs_recovery: boolean;
  correction_needs_skill: boolean;
  shouldSuggest: boolean;
  title: string;
  confidence: number;
}

function analyzeSkillCandidateSignals(userContent: string, agentContent: string, toolRuns: ToolRunRecord[]): SkillCandidateSignals {
  const combinedText = `${userContent}\n${agentContent}`;
  const toolCounts = new Map<string, number>();
  for (const toolRun of toolRuns) {
    toolCounts.set(toolRun.provider_tool_name, (toolCounts.get(toolRun.provider_tool_name) ?? 0) + 1);
  }
  const repeatedTools = [...toolCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const failedOrIgnoredTools = toolRuns.filter((toolRun) => toolRun.status === "failed" || toolRun.status === "ignored");
  const correctionSignals = extractUserCorrectionSignals(combinedText);
  const traceLooksReusable = toolRuns.length >= 5 || (toolRuns.length >= 3 && repeatedTools.length > 0);
  const traceNeedsRecovery = failedOrIgnoredTools.length > 0 && (correctionSignals.length > 0 || /修正|直|もう一度|失敗|error|failed|retry|again/i.test(combinedText));
  const correctionNeedsSkill = correctionSignals.length > 0 && /次から|次回|今後|毎回|手順|ルール|忘れず|always|from now|next time|instead/i.test(combinedText);
  const shouldSuggest = traceLooksReusable || traceNeedsRecovery || correctionNeedsSkill;
  return {
    repeated_tools: repeatedTools,
    failed_or_ignored_tools: failedOrIgnoredTools,
    correction_signals: correctionSignals,
    trace_looks_reusable: traceLooksReusable,
    trace_needs_recovery: traceNeedsRecovery,
    correction_needs_skill: correctionNeedsSkill,
    shouldSuggest,
    title: traceNeedsRecovery
      ? "Skill candidate from corrected execution trace"
      : traceLooksReusable
        ? "Skill candidate from execution trace"
        : correctionNeedsSkill
          ? "Skill candidate from user correction"
          : "Skill candidate",
    confidence: traceNeedsRecovery ? 0.74 : traceLooksReusable ? 0.7 : correctionNeedsSkill ? 0.68 : 0.64
  };
}

function extractUserCorrectionSignals(text: string): string[] {
  const signals: string[] = [];
  const patterns = [
    /次から[^。.\n]*/gi,
    /次回[^。.\n]*/gi,
    /今後[^。.\n]*/gi,
    /毎回[^。.\n]*/gi,
    /修正[^。.\n]*/gi,
    /直し[^。.\n]*/gi,
    /instead[^.\n]*/gi,
    /from now[^.\n]*/gi,
    /next time[^.\n]*/gi
  ];
  for (const pattern of patterns) {
    const matches = text.match(pattern) ?? [];
    for (const match of matches) {
      const normalized = summarize(match, 120);
      if (normalized && !signals.includes(normalized)) {
        signals.push(normalized);
      }
    }
  }
  return signals.slice(0, 5);
}

function skillCandidateContentFromTrace(userContent: string, toolRuns: ToolRunRecord[], signals: SkillCandidateSignals): string {
  const toolSummary = toolRuns.slice(0, 8).map((toolRun, index) =>
    `${index + 1}. ${toolRun.provider_tool_name} -> ${toolRun.status}: ${toolRun.output_summary}`
  ).join("\n");
  const repeatedSummary = signals.repeated_tools.length
    ? signals.repeated_tools.map((tool) => `- ${tool.name}: ${tool.count} time(s)`).join("\n")
    : "- No repeated tool pattern detected.";
  const correctionSummary = signals.correction_signals.length
    ? signals.correction_signals.map((signal) => `- ${signal}`).join("\n")
    : "- No explicit user correction detected.";
  const recoverySummary = signals.failed_or_ignored_tools.length
    ? `\n\n## Recovery notes\n${signals.failed_or_ignored_tools.map((toolRun) => `- ${toolRun.provider_tool_name}: ${toolRun.output_summary}`).join("\n")}`
    : "";
  return [
    "# Candidate workflow",
    "",
    "## Trigger",
    summarize(userContent, 400) || "Reusable workflow detected from execution trace.",
    "",
    "## Reusable signals",
    repeatedSummary,
    "",
    "## User correction signals",
    correctionSummary,
    "",
    "## Observed tool sequence",
    toolSummary || "(no tool runs)",
    recoverySummary,
    "",
    "## Next-run checklist",
    "- Reuse the observed successful steps before inventing a new flow.",
    "- Apply the user correction before repeating the same workflow.",
    "- If a tool is ignored or failed, check the allowed scope or fallback route before retrying."
  ].filter(Boolean).join("\n");
}

function renderReflectionTranscriptExcerpt(messages: MessageRecord[]): string {
  const excerpt = messages.slice(-12)
    .map((message) => `${message.role}: ${summarize(message.content, 220)}`)
    .join("\n");
  return excerpt ? `Transcript excerpt:\n${excerpt}` : "";
}

function renderReflectionArtifactContext(artifacts: ReflectionArtifactSnapshot[]): string {
  if (!artifacts.length) {
    return "";
  }
  return [
    "Artifact context:",
    ...artifacts.map((snapshot) => [
      `Artifact: ${snapshot.artifact.title} (${snapshot.artifact.kind})`,
      `URI: ${snapshot.artifact.file_ref.uri}`,
      snapshot.content ? `Content:\n${snapshot.content}${snapshot.content_truncated ? "\n[truncated]" : ""}` : "Content: (unavailable or binary)"
    ].join("\n"))
  ].join("\n\n");
}

function renderReflectionKnowledgeWikiProposal(input: {
  userContent: string;
  agentContent: string;
  transcriptSummary: string;
  artifactContext: string;
  backendEventSummary: string;
}): string {
  return [
    input.userContent ? `User request:\n${input.userContent}` : "",
    input.agentContent ? `Agent response:\n${input.agentContent}` : "",
    input.transcriptSummary,
    input.artifactContext,
    input.backendEventSummary ? `Backend events:\n${input.backendEventSummary}` : ""
  ].filter(Boolean).join("\n\n");
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

function surfaceOperationResultKind(operation: StructuredSurfaceOperation): SurfaceOperationResultKind {
  if (operation.kind === "form.submit") {
    return "form_submission";
  }
  if (operation.kind === "table.patch") {
    return "table_patch";
  }
  if (operation.kind === "chart.request") {
    return "chart_request";
  }
  if (operation.kind === "custom_view.action") {
    return "custom_view_action";
  }
  return "artifact";
}

function surfaceOperationRenderKind(operation: StructuredSurfaceOperation): SurfaceRenderKind {
  if (operation.kind === "form.submit") {
    return "form";
  }
  if (operation.kind === "table.patch") {
    return "table";
  }
  if (operation.kind === "chart.request") {
    return "chart";
  }
  if (operation.kind === "custom_view.action") {
    return "custom_view";
  }
  return "artifact";
}

function surfaceDispatchPlan(operation: SurfaceOperation, input: {
  dispatchTarget: SurfaceOperationDispatchPlan["dispatch_target"];
  runtimeMethod: string;
  operationName: string;
  resultKind: SurfaceOperationResultKind;
  renderKind: SurfaceRenderKind;
  requiresSession: boolean;
  writesWorkspace: boolean;
  outputResourceKind: string;
  proposedEffects: string[];
}): SurfaceOperationDispatchPlan {
  return {
    operation_id: operation.id,
    operation_kind: operation.kind,
    dispatch_target: input.dispatchTarget,
    runtime_method: input.runtimeMethod,
    operation_name: input.operationName,
    result_kind: input.resultKind,
    render_kind: input.renderKind,
    requires_session: input.requiresSession,
    writes_workspace: input.writesWorkspace,
    output_resource_kind: input.outputResourceKind,
    proposed_effects: input.proposedEffects
  };
}

function negotiatedRenderSpec(operation: SurfaceOperation, spec: SurfaceRenderSpec): SurfaceRenderSpec {
  return negotiateSurfaceRenderSpec(spec, operation.renderer_capabilities);
}

function surfaceOperationEffect(operation: StructuredSurfaceOperation): string {
  if (operation.kind === "form.submit") {
    return `Persist submitted form ${operation.form_id} as a local structured artifact.`;
  }
  if (operation.kind === "table.patch") {
    return `Persist table patch ${operation.table_id} as a local table artifact.`;
  }
  if (operation.kind === "chart.request") {
    return `Persist chart request ${operation.chart_id ?? operation.title} as a local chart artifact.`;
  }
  if (operation.kind === "custom_view.action") {
    return `Persist custom view action ${operation.view_id}/${operation.action_id} as a local structured artifact.`;
  }
  return `Persist artifact ${operation.action} request as a local artifact.`;
}

function surfaceOperationArtifactKind(operation: StructuredSurfaceOperation): ArtifactKind {
  if (operation.kind === "table.patch") {
    return "table";
  }
  if (operation.kind === "chart.request") {
    return "chart";
  }
  if (operation.kind === "artifact.request" && operation.action === "export") {
    return "generated_report";
  }
  if (operation.kind === "artifact.request" && operation.action === "preview") {
    return "note";
  }
  if (operation.kind === "artifact.request") {
    return "document";
  }
  return "structured_draft";
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

function surfaceOperationArtifactContent(
  operation: StructuredSurfaceOperation,
  sourceArtifact?: ArtifactRecord,
  sourceContent?: string
): ArtifactPayload {
  if (operation.kind === "form.submit") {
    return {
      kind: "form_submission",
      form_id: operation.form_id,
      submit_label: operation.submit_label ?? null,
      values: operation.values
    };
  }
  if (operation.kind === "table.patch") {
    return {
      kind: "table_patch",
      table_id: operation.table_id,
      row_id: operation.row_id ?? null,
      changes: operation.changes,
      rows: [{ ...operation.changes, id: operation.row_id ?? "pending" }]
    };
  }
  if (operation.kind === "chart.request") {
    return {
      kind: "chart_request",
      chart_id: operation.chart_id ?? createId("chart"),
      title: operation.title,
      query: operation.query,
      data_refs: operation.data_refs,
      data: []
    };
  }
  if (operation.kind === "custom_view.action") {
    return {
      kind: "custom_view_action",
      view_id: operation.view_id,
      action_id: operation.action_id,
      payload: operation.payload
    };
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
  return jsonRecord({
    ...(operation.metadata ?? {}),
    surface_operation_id: operation.id,
    surface_operation_kind: operation.kind,
    surface_operation_payload: jsonSafe(operation),
    source_artifact_id: sourceArtifact?.id,
    source_artifact_uri: sourceArtifact?.file_ref.uri,
    source_artifact_hash: sourceContent ? stableHash(sourceContent) : undefined
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
    return createSurfaceRenderSpec({
      kind: "custom_view",
      priority: "primary",
      state: "ready",
      title: operation.view_id,
      resource_refs: refs,
      props: {
        view_id: operation.view_id,
        renderer: typeof operation.payload.renderer === "string" ? operation.payload.renderer : "generic",
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

const TASKS_COLLECTION_ID = "tasks";
const TASK_FIELD_IDS = ["title", "completed", "notes", "due_date", "order", "source_session_id", "source_message_id"] as const;
const REQUIRED_TASK_FIELD_IDS = ["title", "completed", "notes", "due_date", "order", "source_session_id", "source_message_id"] as const;
const APP_EDIT_FIELD_TYPES = ["string", "text", "date", "boolean", "number", "enum"] as const;
const TASK_INTERNAL_FIELD_IDS = ["source_session_id", "source_message_id", "order"] as const;

type AppEditFieldType = (typeof APP_EDIT_FIELD_TYPES)[number];
type AppEditPatch =
  | { op: "add_field"; field: { id: string; type: AppEditFieldType; label?: string; required?: boolean; enum_values?: string[]; default_value?: JsonValue } }
  | { op: "update_field"; field_id: string; changes: { label?: string; enum_values?: string[]; type?: AppEditFieldType } }
  | { op: "hide_field"; field_id: string }
  | { op: "update_view"; view_id?: string; hidden_fields?: string[]; emphasized_fields?: string[]; density?: "comfortable" | "compact"; allow_delete?: boolean }
  | { op: "set_sort"; field_id: string; direction: "asc" | "desc"; completed_last?: boolean }
  | { op: "set_group"; field_id: string }
  | { op: "set_permissions"; allow_delete?: boolean }
  | { op: "backfill_records"; field_id: string; value: JsonValue };

interface TaskRecordRenderData extends Record<string, JsonValue> {
  id: string;
  title: string;
  completed: boolean;
  notes: string;
  due_date: string;
  order: number;
  source_session_id: string;
  source_message_id: string;
  file_path: string;
  updated_at: string;
}

function isTaskListAppRequest(content: string): boolean {
  const normalized = content.toLowerCase();
  return [
    "タスク管理アプリ",
    "タスクアプリ",
    "task list",
    "task_list",
    "todo app",
    "todo list"
  ].some((keyword) => normalized.includes(keyword));
}

function createTasksCollectionSchema(): CollectionSchema {
  return {
    id: TASKS_COLLECTION_ID,
    version: "1",
    labels: { ja: "タスク", en: "Tasks" },
    descriptions: {
      ja: "タスク管理アプリの保存データ。",
      en: "Saved records for the task list app."
    },
    fields: [
      { id: "title", type: "string", required: true },
      { id: "completed", type: "boolean" },
      { id: "notes", type: "string" },
      { id: "due_date", type: "string" },
      { id: "order", type: "number" },
      { id: "source_session_id", type: "string" },
      { id: "source_message_id", type: "string" }
    ],
    refs: [],
    embeds: [],
    derived_fields: [],
    triggers: [],
    actions: [],
    views: [taskListViewConfig()],
    permissions: {}
  };
}

function ensureCompatibleTasksCollectionSchema(schema: CollectionSchema): void {
  const fieldIds = new Set(schema.fields.map((field) => {
    const id = field.id ?? field.name;
    return typeof id === "string" ? id : "";
  }));
  const missing = REQUIRED_TASK_FIELD_IDS.filter((id) => !fieldIds.has(id));
  if (missing.length > 0) {
    throw new RuntimeRequestError("conflict", `tasks_collection_schema_incompatible:${missing.join(",")}`);
  }
}

function validateTaskRecordCreateData(data: Record<string, JsonValue>): void {
  validateTaskRecordData(data, { requireTitle: true });
}

function validateTaskRecordPatchData(data: Record<string, JsonValue>): void {
  validateTaskRecordData(data, { requireTitle: false });
}

function validateTaskRecordData(data: Record<string, JsonValue>, options: { requireTitle: boolean }): void {
  const allowed = new Set<string>(TASK_FIELD_IDS);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key) && !isValidAppFieldId(key)) {
      throw new RuntimeRequestError("conflict", `tasks_unknown_field:${key}`);
    }
  }
  if (options.requireTitle || Object.prototype.hasOwnProperty.call(data, "title")) {
    if (typeof data.title !== "string" || data.title.trim().length === 0) {
      throw new RuntimeRequestError("conflict", "tasks_title_required");
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, "completed") && typeof data.completed !== "boolean") {
    throw new RuntimeRequestError("conflict", "tasks_completed_boolean_required");
  }
  for (const key of ["notes", "due_date", "source_session_id", "source_message_id"]) {
    if (Object.prototype.hasOwnProperty.call(data, key) && typeof data[key] !== "string") {
      throw new RuntimeRequestError("conflict", `tasks_${key}_string_required`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, "order") && typeof data.order !== "number") {
    throw new RuntimeRequestError("conflict", "tasks_order_number_required");
  }
}

function taskListRenderSpec(records: CollectionRecordWithFilePath[], sessionId?: string, sourceMessageId?: string, schema?: CollectionSchema): SurfaceRenderSpec {
  const viewConfig = taskListViewConfig(records, schema);
  const taskRecords = sortTaskRecords(records.map((record) => taskRecordRenderData(record, schema)), viewConfig);
  const activeCount = taskRecords.filter((record) => !record.completed).length;
  const completedCount = taskRecords.length - activeCount;
  const refs = records.map(collectionRecordRef);
  return createSurfaceRenderSpec({
    kind: "custom_view",
    priority: "secondary",
    state: "ready",
    title: "タスク",
    resource_refs: refs.length > 0 ? refs : [{
      kind: "collection",
      id: TASKS_COLLECTION_ID,
      uri: `collections/${TASKS_COLLECTION_ID}`,
      label: "tasks"
    }],
    props: {
      view_id: "task_list",
      renderer: "task_list",
      renderer_version: "1",
      schema_ref: `collections/${TASKS_COLLECTION_ID}/schema.json`,
      actions: taskListActions(schema),
      data: {
        collection_id: TASKS_COLLECTION_ID,
        records: taskRecords,
        schema_fields: taskSchemaFields(records, schema),
        view_config: viewConfig,
        counts: {
          total: taskRecords.length,
          active: activeCount,
          completed: completedCount
        },
        source_session_id: sessionId ?? "",
        source_message_id: sourceMessageId ?? "",
        record_ids: taskRecords.map((record) => record.id)
      }
    },
    fallback: {
      kind: "collection",
      title: "tasks",
      message: "Open the tasks Collection if this app renderer is unavailable.",
      props: {
        collection_id: TASKS_COLLECTION_ID,
        record_ids: taskRecords.map((record) => record.id)
      }
    }
  });
}

function taskRecordRenderData(record: CollectionRecordWithFilePath, schema?: CollectionSchema): TaskRecordRenderData {
  const data: TaskRecordRenderData = {
    id: record.id,
    title: typeof record.data.title === "string" ? record.data.title : "",
    completed: record.data.completed === true,
    notes: typeof record.data.notes === "string" ? record.data.notes : "",
    due_date: typeof record.data.due_date === "string" ? record.data.due_date : "",
    order: typeof record.data.order === "number" ? record.data.order : 0,
    source_session_id: typeof record.data.source_session_id === "string" ? record.data.source_session_id : "",
    source_message_id: typeof record.data.source_message_id === "string" ? record.data.source_message_id : "",
    file_path: record.file_path,
    updated_at: record.updated_at
  };
  for (const field of taskSchemaFields([record], schema)) {
    const key = typeof field.id === "string" ? field.id : "";
    if (!key || key in data) {
      continue;
    }
    const value = record.data[key];
    if (isJsonValue(value)) {
      data[key] = value;
    }
  }
  return data;
}

function taskSchemaFields(records: CollectionRecordWithFilePath[], schema?: CollectionSchema): Array<Record<string, JsonValue>> {
  const byId = new Map<string, Record<string, JsonValue>>();
  for (const field of schema?.fields ?? []) {
    const id = typeof field.id === "string" ? field.id : typeof field.name === "string" ? field.name : "";
    if (id && !TASK_INTERNAL_FIELD_IDS.includes(id as (typeof TASK_INTERNAL_FIELD_IDS)[number])) {
      byId.set(id, normalizeTaskSchemaField(field));
    }
  }
  for (const record of records) {
    for (const [key, value] of Object.entries(record.data)) {
      if (!byId.has(key) && isValidAppFieldId(key) && !TASK_INTERNAL_FIELD_IDS.includes(key as (typeof TASK_INTERNAL_FIELD_IDS)[number])) {
        byId.set(key, { id: key, type: inferAppFieldType(value) });
      }
    }
  }
  const baseFields: Array<Record<string, JsonValue>> = [
    { id: "title", type: "string", required: true },
    { id: "completed", type: "boolean" },
    { id: "notes", type: "text" },
    { id: "due_date", type: "date" }
  ];
  for (const field of baseFields) {
    const id = String(field.id);
    byId.set(id, { ...field, ...byId.get(id) });
  }
  return Array.from(byId.values()).filter((field) => !taskHiddenFields(schema).has(String(field.id)));
}

function taskListViewConfig(records?: CollectionRecordWithFilePath[], schema?: CollectionSchema): Record<string, JsonValue> {
  const configured = (schema?.views ?? []).find((view) => view.id === "task_list");
  const editableFields = taskSchemaFields(records ?? [], schema).map((field) => String(field.id)).filter((id) => id !== "completed");
  return {
    id: "task_list",
    renderer: "task_list",
    density: typeof configured?.density === "string" ? configured.density : "comfortable",
    allow_delete: configured?.allow_delete !== false,
    hidden_fields: Array.isArray(configured?.hidden_fields) ? configured.hidden_fields.filter((item): item is string => typeof item === "string") : [],
    emphasized_fields: Array.isArray(configured?.emphasized_fields) ? configured.emphasized_fields.filter((item): item is string => typeof item === "string") : [],
    sort: configured?.sort && typeof configured.sort === "object" && !Array.isArray(configured.sort) ? unknownRecord(configured.sort) as Record<string, JsonValue> : { field_id: "order", direction: "asc", completed_last: true },
    group_by: typeof configured?.group_by === "string" ? configured.group_by : "",
    editable_fields: editableFields
  };
}

function taskListActions(schema?: CollectionSchema): Array<{ id: string; label: string; operation_kind: "collection.record.create" | "collection.record.patch" | "collection.record.delete" }> {
  const actions: Array<{ id: string; label: string; operation_kind: "collection.record.create" | "collection.record.patch" | "collection.record.delete" }> = [
    { id: "task.create", label: "追加", operation_kind: "collection.record.create" },
    { id: "task.patch", label: "更新", operation_kind: "collection.record.patch" }
  ];
  if (collectionDeleteAllowed(schema, "task_list")) {
    actions.push({ id: "task.delete", label: "削除", operation_kind: "collection.record.delete" });
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
  const view = (schema.views ?? []).find((item) => item.id === (viewId ?? "task_list")) ?? (schema.views ?? [])[0];
  return view?.allow_delete !== false;
}

function assertCollectionDeleteAllowed(schema: CollectionSchema, viewId?: string): void {
  if (!collectionDeleteAllowed(schema, viewId)) {
    throw new RuntimeRequestError("forbidden", "collection_record_delete_not_allowed");
  }
}

function isActiveTaskListAppRequest(input: SurfaceOperation): boolean {
  const context = unknownRecord(input.metadata?.active_app_context);
  return input.kind === "message.submit"
    && context.renderer === "task_list"
    && context.collection_id === TASKS_COLLECTION_ID;
}

async function planAppEditPatch(provider: { generate(input: ProviderInput): Promise<ProviderOutput> } | undefined, schema: CollectionSchema, records: CollectionRecordWithFilePath[], content: string): Promise<AppEditPatch[]> {
  if (!provider) {
    throw new RuntimeRequestError("provider_not_configured", "App編集にはLLM設定が必要です。");
  }
  const envelope = createGatewayEnvelope(webGatewayContext, [
    "App Edit PatchだけをJSON配列で返してください。",
    "説明文、Markdown、コードフェンスは禁止です。",
    "対象はtasks Collectionのみです。",
    `ユーザー指示: ${content}`,
    `現在のfields: ${JSON.stringify(taskSchemaFields(records, schema))}`,
    `現在のview_config: ${JSON.stringify(taskListViewConfig(records, schema))}`,
    `許可op: add_field, update_field, hide_field, update_view, set_sort, set_group, set_permissions, backfill_records`,
    `許可field type: ${APP_EDIT_FIELD_TYPES.join(", ")}`
  ].join("\n"), "ja", "ja", { app_edit_patch: true });
  let output: ProviderOutput;
  try {
    output = await provider.generate({
      envelope,
      activeMemory: [],
      knowledgeWiki: [],
      collectionNotes: [],
      selectedSkills: [],
      sessionSearch: [],
      availableTools: [],
      recentMessages: []
    });
  } catch (error) {
    if (error instanceof ProviderRequestError && error.diagnostics.reason === "not_configured") {
      throw new RuntimeRequestError("provider_not_configured", "App編集にはLLM設定が必要です。");
    }
    throw error;
  }
  const parsed = parseAppEditPatchJson(output.content);
  return validateAppEditPatch(parsed, schema);
}

async function applyAppEditPatchToTasksStore(store: { getCollectionSchema(id: string): Promise<CollectionSchemaWithFilePath | undefined>; listCollectionRecords(id: string): Promise<CollectionRecordWithFilePath[]>; updateCollectionSchema(schema: CollectionSchema): Promise<CollectionSchemaWithFilePath> }, provider: { generate(input: ProviderInput): Promise<ProviderOutput> } | undefined, content: string): Promise<void> {
  const schema = await store.getCollectionSchema(TASKS_COLLECTION_ID);
  if (!schema) {
    return;
  }
  const records = await store.listCollectionRecords(TASKS_COLLECTION_ID);
  const patches = await planAppEditPatch(provider, schema, records, content);
  await applyAppEditPatch(store, schema, patches);
}

async function applyAppEditPatch(store: { updateCollectionSchema(schema: CollectionSchema): Promise<CollectionSchemaWithFilePath> }, schema: CollectionSchema, patches: AppEditPatch[]): Promise<void> {
  const fields = [...schema.fields];
  const currentView = taskListViewConfig([], schema);
  const nextView: Record<string, JsonValue> = { ...currentView };
  const fieldIndex = () => new Map(fields.map((field, index) => [String(field.id ?? field.name ?? ""), index]));
  for (const patch of patches) {
    if (patch.op === "add_field") {
      if (!fieldIndex().has(patch.field.id)) {
        fields.push(appEditFieldToCollectionField(patch.field));
      }
    } else if (patch.op === "update_field") {
      const index = fieldIndex().get(patch.field_id);
      if (index !== undefined) {
        fields[index] = { ...fields[index], ...patch.changes };
      }
    } else if (patch.op === "hide_field") {
      nextView.hidden_fields = uniqueStrings([...(Array.isArray(nextView.hidden_fields) ? nextView.hidden_fields : []), patch.field_id]);
    } else if (patch.op === "update_view") {
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
  const otherViews = (schema.views ?? []).filter((view) => view.id !== "task_list");
  const permissionsPatch = patches.find((patch): patch is Extract<AppEditPatch, { op: "set_permissions" }> =>
    patch.op === "set_permissions" && typeof patch.allow_delete === "boolean"
  );
  const nextPermissions = permissionsPatch
    ? { ...(schema.permissions ?? {}), delete: permissionsPatch.allow_delete as boolean }
    : schema.permissions;
  const changed = fields.length !== schema.fields.length
    || JSON.stringify(nextView) !== JSON.stringify(currentView)
    || JSON.stringify(nextPermissions) !== JSON.stringify(schema.permissions);
  if (!changed) {
    return;
  }
  await store.updateCollectionSchema({
    ...schema,
    fields,
    views: [...otherViews, nextView],
    permissions: nextPermissions
  });
}

function taskSafeRecordData(data: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => TASK_FIELD_IDS.includes(key as (typeof TASK_FIELD_IDS)[number]) || isValidAppFieldId(key)));
}

function parseAppEditPatchJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new RuntimeRequestError("conflict", "app_edit_patch_json_required");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new RuntimeRequestError("conflict", "app_edit_patch_json_required");
  }
}

function validateAppEditPatch(value: unknown, schema: CollectionSchema): AppEditPatch[] {
  if (!Array.isArray(value)) {
    throw new RuntimeRequestError("conflict", "app_edit_patch_array_required");
  }
  const fieldIds = new Set(schema.fields.map((field) => String(field.id ?? field.name ?? "")).filter(Boolean));
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
    } else if (patch.op === "hide_field") {
      if (!fieldIds.has(patch.field_id)) throw new RuntimeRequestError("conflict", `app_edit_unknown_field:${patch.field_id}`);
      if (required.has(patch.field_id as (typeof REQUIRED_TASK_FIELD_IDS)[number])) throw new RuntimeRequestError("conflict", `app_edit_required_field_visible:${patch.field_id}`);
    } else if (patch.op === "update_field") {
      if (!fieldIds.has(patch.field_id)) throw new RuntimeRequestError("conflict", `app_edit_unknown_field:${patch.field_id}`);
      if (patch.changes.type === "enum" && (!patch.changes.enum_values || patch.changes.enum_values.length === 0)) {
        throw new RuntimeRequestError("conflict", `app_edit_enum_values_required:${patch.field_id}`);
      }
    } else if (patch.op === "set_sort" || patch.op === "set_group" || patch.op === "backfill_records") {
      if (!fieldIds.has(patch.field_id)) throw new RuntimeRequestError("conflict", `app_edit_unknown_field:${patch.field_id}`);
    } else if (patch.op === "update_view") {
      for (const fieldId of [...(patch.hidden_fields ?? []), ...(patch.emphasized_fields ?? [])]) {
        if (!fieldIds.has(fieldId)) throw new RuntimeRequestError("conflict", `app_edit_unknown_field:${fieldId}`);
        if ((patch.hidden_fields ?? []).includes(fieldId) && required.has(fieldId as (typeof REQUIRED_TASK_FIELD_IDS)[number])) {
          throw new RuntimeRequestError("conflict", `app_edit_required_field_visible:${fieldId}`);
        }
      }
    }
    if (patch.op !== "backfill_records") {
      patches.push(patch);
    }
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
  if (op === "backfill_records") return { op, field_id: requireAppFieldId(String(item.field_id ?? "")), value: isJsonValue(item.value) ? item.value : "" };
  if (op === "update_view") {
    return {
      op,
      ...(typeof item.view_id === "string" ? { view_id: item.view_id } : {}),
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

function normalizeTaskSchemaField(field: Record<string, JsonValue>): Record<string, JsonValue> {
  const id = String(field.id ?? field.name ?? "");
  const type: AppEditFieldType = APP_EDIT_FIELD_TYPES.includes(field.type as AppEditFieldType) ? field.type as AppEditFieldType : id === "completed" ? "boolean" : id === "due_date" ? "date" : id === "notes" ? "text" : "string";
  return { ...field, id, type };
}

function taskHiddenFields(schema?: CollectionSchema): Set<string> {
  const view = (schema?.views ?? []).find((item) => item.id === "task_list");
  return new Set(Array.isArray(view?.hidden_fields) ? view.hidden_fields.filter((item): item is string => typeof item === "string") : []);
}

function sortTaskRecords(records: TaskRecordRenderData[], viewConfig: Record<string, JsonValue>): TaskRecordRenderData[] {
  const sort = unknownRecord(viewConfig.sort);
  const fieldId = typeof sort.field_id === "string" ? sort.field_id : "order";
  const direction = sort.direction === "desc" ? -1 : 1;
  const completedLast = sort.completed_last !== false;
  return [...records].sort((a, b) => {
    if (completedLast && a.completed !== b.completed) return a.completed ? 1 : -1;
    const av = a[fieldId];
    const bv = b[fieldId];
    const compared = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
    return compared * direction || a.order - b.order || a.title.localeCompare(b.title);
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

function resourceRenderSpec(command: DomainCommandEntry, result: unknown): SurfaceRenderSpec | undefined {
  const resultRecord = unknownRecord(result);
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

function assertDomainCommandRenderSpecs(command: DomainCommandEntry, specs: SurfaceRenderSpec[]): SurfaceRenderSpec[] {
  for (const spec of specs) {
    if (!command.output_render_kinds.includes(spec.kind as DomainCommandOutputRenderKind)) {
      throw new Error(`Domain command ${command.id} returned undeclared render kind: ${spec.kind}`);
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

function operationStatusRenderSpec(command: DomainCommandEntry, resultRecord: Record<string, unknown>): SurfaceRenderSpec | undefined {
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

function operationAuditRuntimeResult(value: unknown): { operation: OperationRecord; auditRecord: AuditRecord; resourceRefs: ResourceRef[] } | undefined {
  const record = unknownRecord(value);
  if (record.result && record.result !== value) {
    const nested = operationAuditRuntimeResult(record.result);
    if (nested) {
      return nested;
    }
  }
  const operation = unknownRecord(record.operation);
  const auditRecord = unknownRecord(record.auditRecord);
  if (
    typeof operation.id !== "string"
    || typeof operation.operation !== "string"
    || typeof operation.status !== "string"
    || typeof auditRecord.id !== "string"
    || typeof auditRecord.outputs_summary !== "string"
  ) {
    return undefined;
  }
  const resourceRefs = Array.isArray(operation.target_resource_refs)
    ? operation.target_resource_refs.filter(isResourceRef)
    : [];
  const resultRef = isResourceRef(operation.result_ref) ? operation.result_ref : undefined;
  return {
    operation: operation as unknown as OperationRecord,
    auditRecord: auditRecord as unknown as AuditRecord,
    resourceRefs: resultRef ? [resultRef, ...resourceRefs] : resourceRefs
  };
}

function runtimeWriteResource(value: unknown): unknown {
  const record = unknownRecord(value);
  if ("resource" in record) {
    return record.resource;
  }
  if (record.result && record.result !== value) {
    return runtimeWriteResource(record.result);
  }
  return undefined;
}

function isArtifactRecordResource(value: unknown): value is ArtifactRecord {
  const record = unknownRecord(value);
  return typeof record.id === "string"
    && typeof record.title === "string"
    && isResourceRef(record.file_ref);
}

function isMemoryFrontmatterResource(value: unknown): value is MemoryFrontmatter {
  const record = unknownRecord(value);
  return typeof record.id === "string"
    && typeof record.topic === "string"
    && typeof record.state === "string";
}

function runtimeToolWorkspaceChange(
  run: BackendRunRecord,
  operation: OperationRecord,
  resourceRef: ResourceRef,
  commandId: "artifact.create" | "memory.topic.create",
  resource: unknown
): WorkspaceChangeRecord {
  return {
    id: createId("change"),
    run_id: run.id,
    session_id: run.session_id,
    resource_ref: resourceRef,
    change_type: commandId === "artifact.create" ? "artifact_created" : "memory_suggested",
    summary: commandId === "artifact.create"
      ? `Created artifact ${isArtifactRecordResource(resource) ? resource.title : resourceRef.label ?? resourceRef.id}.`
      : `Suggested memory ${isMemoryFrontmatterResource(resource) ? resource.topic : resourceRef.label ?? resourceRef.id}.`,
    legacy_operation_id: operation.id,
    created_at: nowIso()
  };
}

function runtimeToolWorkspaceEvents(
  commandId: "artifact.create" | "memory.topic.create",
  resource: unknown,
  resourceRefs: ResourceRef[],
  toolCallId?: string
): BackendOutputEvent[] {
  if (commandId === "artifact.create") {
    const artifact = isArtifactRecordResource(resource) ? resource : undefined;
    return [
      {
        event_type: "artifact_created",
        payload: {
          artifact_id: artifact?.id ?? resourceRefs[0]?.id ?? "unknown",
          title: artifact?.title ?? resourceRefs[0]?.label ?? "Artifact"
        },
        resource_refs: resourceRefs,
        tool_call_id: toolCallId
      }
    ];
  }

  const memory = isMemoryFrontmatterResource(resource) ? resource : undefined;
  return [
    {
      event_type: "memory_suggested",
      payload: {
        memory_id: memory?.id ?? resourceRefs[0]?.id ?? "unknown",
        topic: memory?.topic ?? resourceRefs[0]?.label ?? "memory"
      },
      resource_refs: resourceRefs,
      tool_call_id: toolCallId
    }
  ];
}

function isResourceRef(value: unknown): value is ResourceRef {
  const record = unknownRecord(value);
  return typeof record.kind === "string" && typeof record.id === "string" && typeof record.uri === "string";
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringRecordValue(value: unknown, key: string): string | undefined {
  const record = unknownRecord(value);
  return typeof record[key] === "string" ? record[key] : undefined;
}

function stringPayload(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function recordPayload(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
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

function externalSendChannelPayload(value: JsonValue | undefined): ExternalSendChannel {
  return typeof value === "string" && externalSendChannels.includes(value as ExternalSendChannel) ? value as ExternalSendChannel : "webhook";
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
  if (actionId === "mcp.call") {
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
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry, key)]));
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
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, jsonSafe(entry, entryKey)]));
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

const gatewayPairingPolicyChannels = [...gatewayChannels];
const gatewayRoutingPolicyChannels = [...gatewayChannels];

function createDefaultRuntimeGatewayPairingPolicy(channel: GatewayPairingPolicyRecord["channel"]): GatewayPairingPolicyRecord {
  const base = createDefaultGatewayPairingPolicy(channel);
  const envAllowlist = gatewaySourceAllowlist();
  if (envAllowlist.length === 0) {
    return base;
  }
  return {
    ...base,
    allowlist: envAllowlist,
    metadata: {
      ...base.metadata,
      source: "env_gateway_allowlist",
      env_allowlist: true
    }
  };
}

function gatewayInboundPolicyMetadata(
  input: {
    channel: GatewayPairingRecord["channel"];
    source_label?: string;
    account_id?: string;
    thread_id?: string;
    route?: string;
    metadata?: Record<string, JsonValue>;
  },
  sourceIdentity: string,
  targetSessionKey: string,
  policy: GatewayPairingPolicyRecord,
  evaluation: ReturnType<typeof evaluateGatewayPairingPolicy>,
  routingPolicy: GatewayRoutingPolicyRecord,
  routingResolution: ReturnType<typeof resolveGatewaySessionRouting>
): Record<string, JsonValue> {
  const route = normalizeGatewayRoute(input.route);
  return {
    ...(input.metadata ?? {}),
    gateway_pairing_policy: {
      id: policy.id,
      channel: policy.channel,
      status: policy.status,
      trust_mode: policy.trust_mode,
      allowlist_snapshot: evaluation.allowlist_snapshot,
      reason: evaluation.reason ?? null,
      pairing_ttl_ms: evaluation.pairing_ttl_ms,
      duplicate_window_ms: evaluation.duplicate_window_ms,
      rate_limit_window_ms: evaluation.rate_limit_window_ms,
      rate_limit_max: evaluation.rate_limit_max
    },
    gateway_routing_policy: {
      id: routingPolicy.id,
      channel: routingPolicy.channel,
      status: routingPolicy.status,
      session_key_strategy: routingPolicy.session_key_strategy,
      default_account_id: routingPolicy.default_account_id ?? null,
      default_thread_id: routingPolicy.default_thread_id ?? null,
      default_route: routingPolicy.default_route,
      reason: routingResolution.reason ?? null
    },
    gateway_source_scope: {
      channel: input.channel,
      source_identity: sourceIdentity,
      source_label: input.source_label ?? sourceIdentity,
      account_id: routingResolution.account_id,
      thread_id: routingResolution.thread_id,
      requested_route: route,
      route: routingResolution.route,
      session_key: targetSessionKey
    }
  };
}

function gatewayPairingPolicyError(reason: ReturnType<typeof evaluateGatewayPairingPolicy>["reason"]): string {
  if (reason === "policy_disabled") {
    return "gateway_pairing_policy_disabled";
  }
  if (reason === "policy_blocked") {
    return "gateway_pairing_policy_blocked";
  }
  return "gateway_source_not_allowed";
}

function createPendingPairing(input: {
  channel: GatewayPairingRecord["channel"];
  source_identity: string;
  source_label?: string;
  account_id?: string;
  thread_id?: string;
  route?: string;
  metadata?: Record<string, JsonValue>;
  pairing_ttl_ms?: number;
}): GatewayPairingRecord {
  const now = nowIso();
  const route = normalizeGatewayRoute(input.route);
  const sessionKey = sessionKeyForExternalSource({
    channel: input.channel,
    source_identity: input.source_identity,
    source_label: input.source_label,
    account_id: input.account_id,
    thread_id: input.thread_id,
    route,
    metadata: input.metadata
  });
  return {
    id: createId("pairing"),
    channel: input.channel,
    source_identity: input.source_identity,
    source_label: input.source_label ?? input.source_identity,
    status: "pending",
    pairing_code: Math.random().toString(36).slice(2, 8).toUpperCase(),
    session_key: sessionKey,
    metadata: gatewayPairingRoutingMetadata(input, route),
    requested_at: now,
    expires_at: new Date(Date.parse(now) + (input.pairing_ttl_ms ?? 5 * 60_000)).toISOString(),
    updated_at: now
  };
}

function normalizeGatewaySourceIdentity(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new RuntimeRequestError("conflict", "gateway_source_identity_invalid");
  }
  return normalized;
}

function normalizeGatewayRoute(value: string | undefined): string {
  const normalized = value?.trim() || "main";
  if (!normalized || normalized.length > 80 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    return "main";
  }
  return normalized;
}

function gatewayPairingRoutingMetadata(input: {
  source_identity: string;
  account_id?: string;
  thread_id?: string;
  route?: string;
  metadata?: Record<string, JsonValue>;
}, route: string): Record<string, JsonValue> {
  return {
    ...(input.metadata ?? {}),
    routing: {
      account_id: input.account_id?.trim() || input.source_identity,
      thread_id: input.thread_id?.trim() || route,
      route
    }
  };
}

function gatewaySourceAllowlist(): string[] {
  return (process.env.SAMURAI_GATEWAY_SOURCE_ALLOWLIST ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyGatewayBoundaryAllowedTools(availableTools: string[], policy: GatewayBoundaryPolicy | undefined): string[] {
  if (!policy) {
    return availableTools;
  }
  if (policy.allowed_tools.includes("*")) {
    return availableTools;
  }
  if (policy.allowed_tools.length === 0) {
    return [];
  }
  const allowed = new Set(policy.allowed_tools);
  return availableTools.filter((tool) => allowed.has(tool));
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

function gatewayBoundaryToolBlockedChange(run: BackendRunRecord, decision: GatewayBoundaryToolDecision): WorkspaceChangeRecord {
  const policyRef = decision.policy ? gatewayBoundaryPolicyRef(decision.policy) : backendRunRef(run);
  return {
    id: createId("change"),
    run_id: run.id,
    session_id: run.session_id,
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
  return boundary ? [...refs, ...boundary.resourceRefs] : refs;
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
  if (providerToolName === "create_artifact") {
    return "artifact.create";
  }
  if (providerToolName === "remember_topic") {
    return "memory.topic.create";
  }
  if (providerToolName === "request_external_send") {
    return "external.send.prepare";
  }
  if (providerToolName === "request_delete") {
    return "workspace.delete";
  }
  return providerToolName || "unknown_tool";
}

function normalizeExternalAssistHints(hints: ExternalAssistHint[] | void): ExternalAssistHint[] {
  return (hints ?? []).slice(0, 5).map((hint, index) => ({
    id: hint.id?.trim() || createId("external_hint"),
    ...(hint.title?.trim() ? { title: hint.title.trim() } : {}),
    summary: hint.summary.trim() || `External assist hint ${index + 1}.`,
    ...(hint.source_uri?.trim() ? { source_uri: hint.source_uri.trim() } : {}),
    ...(hint.source_label?.trim() ? { source_label: hint.source_label.trim() } : {}),
    ...(typeof hint.confidence === "number" ? { confidence: Math.max(0, Math.min(1, hint.confidence)) } : {})
  }));
}

function activeMemoryPreviewEntry(memory: MemoryCandidate): ContextPreview["active_memory"][number] {
  return {
    id: memory.frontmatter.id,
    topic: memory.frontmatter.topic,
    content: memory.content,
    state: memory.frontmatter.state === "sensitive" ? "sensitive" : memory.frontmatter.state === "active" ? "active" : "topic",
    sensitive_level: memory.frontmatter.sensitive_level,
    priority: memory.priority,
    selection_reason: memory.selection_reason,
    conflicts_with: memory.frontmatter.conflicts_with
  };
}

function knowledgeWikiExclusionReason(wiki: WikiWithFilePath): ContextPreview["knowledge_wiki_report"]["excluded"][number]["reason"] | undefined {
  if (wiki.state === "proposed") {
    return "proposed";
  }
  if (wiki.state === "rejected") {
    return "rejected";
  }
  if (wiki.state === "archived") {
    return "archived";
  }
  if (wiki.state !== "active") {
    return "not_active";
  }
  return undefined;
}

function knowledgeWikiGraph(pages: WikiWithFilePath[], activeOnly: boolean): KnowledgeWikiGraph {
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

function externalAssistNote(input: {
  role: "assistive" | "disabled";
  providerId?: string;
  prefetchRecords?: ExternalAssistRecord[];
  hintCount: number;
  failureCount: number;
}): string {
  if (input.role === "disabled") {
    return "External provider assist is disabled for this workspace.";
  }
  if (!input.providerId) {
    return "External provider assist is enabled, but no external assist provider is registered.";
  }
  if (input.prefetchRecords?.some((record) => record.status === "failed")) {
    return "External provider assist failed non-fatally; accepted Memory and Session Search were still assembled.";
  }
  if (input.hintCount > 0) {
    return "External provider assist returned unverified hints. They are isolated from accepted Memory unless separately reviewed.";
  }
  if (input.failureCount > 0) {
    return "External provider assist has recent non-fatal failures. Accepted Memory and Session Search remain usable.";
  }
  return "External provider assist is enabled but returned no hint for this query.";
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

function externalAssistProviderLabel(providers: ExternalAssistProvider[]): string | undefined {
  if (providers.length === 0) {
    return undefined;
  }
  if (providers.length === 1) {
    return providers[0]?.id;
  }
  return providers.map((provider) => provider.id).join(", ");
}

const hostContextAssemblyLimits = {
  recent_messages: 10,
  knowledge_wiki: 5,
  collection_notes: 5,
  selected_skills: 5,
  session_search: 8
} as const;

const contextStepTimeoutMs = 2_000;

interface TimeboxedContextValue<T> {
  value: T;
  timedOut: boolean;
  step: string;
}

function timeboxContextValue<T>(value: T, timedOut: boolean, step = "context"): TimeboxedContextValue<T> {
  return { value, timedOut, step };
}

function timeboxContextStep<T>(promise: Promise<T>, fallback: T, step: string): Promise<TimeboxedContextValue<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimeboxedContextValue<T>>((resolve) => {
    timer = setTimeout(() => resolve(timeboxContextValue(fallback, true, step)), contextStepTimeoutMs);
  });
  return Promise.race([
    promise
      .then((value) => timeboxContextValue(value, false, step))
      .catch(() => timeboxContextValue(fallback, true, step)),
    timeout
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

type BackendContextIntent = "light_chat" | "contextual_chat" | "workspace_task";

interface BuildHostContextAssemblyInput {
  sessionId: string;
  query: string;
  sessionFound: boolean;
  messageCount: number;
  recentMessageCount: number;
  freezeSnapshotPresent: boolean;
  activeMemoryCandidateCount: number;
  activeMemoryCount: number;
  knowledgeWikiCandidateCount: number;
  knowledgeWikiIncludedCount: number;
  collectionNoteCandidateCount: number;
  collectionNoteIncludedCount: number;
  selectedSkillCount: number;
  sessionSearchCandidateCount: number;
  sessionSearchIncludedCount: number;
  externalAssistRole: "assistive" | "disabled";
  externalAssistHintCount: number;
  externalAssistFailureCount: number;
  availableToolCount: number;
  skippedSourceKinds?: Set<HostContextAssembly["sources"][number]["kind"]>;
}

function buildHostContextAssembly(input: BuildHostContextAssemblyInput): HostContextAssembly {
  const omissions = contextAssemblyOmissions(input);
  return {
    version: 1,
    assembled_at: nowIso(),
    session_id: input.sessionId,
    query: input.query,
    sources: [
      contextAssemblySource("session", input.sessionFound ? "included" : "missing", 1, input.sessionFound ? 1 : 0, input.sessionFound ? "Session record was loaded from Workspace Store." : "Session record was not found."),
      contextAssemblySource("recent_messages", contextAssemblyStatus(input.messageCount, input.recentMessageCount), input.messageCount, input.recentMessageCount, `Latest ${hostContextAssemblyLimits.recent_messages} message(s) are kept for backend context.`),
      contextAssemblySource("freeze_snapshot", input.freezeSnapshotPresent ? "included" : "missing", input.freezeSnapshotPresent ? 1 : 0, input.freezeSnapshotPresent ? 1 : 0, input.freezeSnapshotPresent ? "Profile snapshot was loaded for this turn." : "No profile snapshot could be loaded.", input.skippedSourceKinds),
      contextAssemblySource("active_memory", contextAssemblyStatus(input.activeMemoryCandidateCount, input.activeMemoryCount), input.activeMemoryCandidateCount, input.activeMemoryCount, "Only accepted active/topic/sensitive Memory candidates are included for normal backend context.", input.skippedSourceKinds),
      contextAssemblySource("knowledge_wiki", contextAssemblyStatus(input.knowledgeWikiCandidateCount, input.knowledgeWikiIncludedCount), input.knowledgeWikiCandidateCount, input.knowledgeWikiIncludedCount, "Only active Knowledge Wiki pages with readable content are included.", input.skippedSourceKinds),
      contextAssemblySource("collection_notes", contextAssemblyStatus(input.collectionNoteCandidateCount, input.collectionNoteIncludedCount), input.collectionNoteCandidateCount, input.collectionNoteIncludedCount, "Collection notes are selected as context-only hints.", input.skippedSourceKinds),
      contextAssemblySource("selected_skills", contextAssemblyStatus(input.selectedSkillCount, input.selectedSkillCount), input.selectedSkillCount, input.selectedSkillCount, "Skill index search selected reusable procedures with progressive disclosure.", input.skippedSourceKinds),
      contextAssemblySource("session_search", contextAssemblyStatus(input.sessionSearchCandidateCount, input.sessionSearchIncludedCount), input.sessionSearchCandidateCount, input.sessionSearchIncludedCount, `Session Search is capped at ${hostContextAssemblyLimits.session_search} result(s).`, input.skippedSourceKinds),
      contextAssemblySource(
        "external_assist",
        externalAssistSourceStatus(input.externalAssistRole, input.externalAssistHintCount),
        input.externalAssistHintCount + input.externalAssistFailureCount,
        input.externalAssistHintCount,
        externalAssistSourceReason(input.externalAssistRole, input.externalAssistHintCount, input.externalAssistFailureCount),
        input.skippedSourceKinds
      ),
      contextAssemblySource("available_tools", input.availableToolCount > 0 ? "included" : "empty", input.availableToolCount, input.availableToolCount, "Workspace tool catalog was exposed before any Gateway boundary filtering."),
      contextAssemblySource("gateway_boundary", "missing", 0, 0, "No Gateway boundary policy was attached to this preview.")
    ],
    omissions,
    limits: hostContextAssemblyLimits,
    gateway_boundary: {
      present: false,
      allowed_tools_count: 0,
      available_tools_before_boundary: input.availableToolCount,
      available_tools_after_boundary: input.availableToolCount,
      filtered_tool_count: 0,
      reason: "No Gateway boundary policy was attached to this preview."
    },
    quality_checks: [
      {
        id: "session_loaded",
        status: input.sessionFound ? "pass" : "fail",
        detail: input.sessionFound ? "Session context is available." : "Host cannot assemble context without a session."
      },
      {
        id: "active_wiki_only",
        status: "pass",
        detail: "Knowledge Wiki retrieval used active-only search."
      },
      {
        id: "external_assist_isolated",
        status: "pass",
        detail: "External assist is not included in accepted active Memory."
      },
      {
        id: "collection_notes_context_only",
        status: "pass",
        detail: "Collection notes remain context-only and do not relax schema validation."
      },
      {
        id: "available_tools_catalog",
        status: input.availableToolCount > 0 ? "pass" : "warning",
        detail: input.availableToolCount > 0 ? "Workspace tool catalog is available." : "No workspace tools are available to this run."
      },
      {
        id: "freeze_snapshot_loaded",
        status: input.freezeSnapshotPresent || input.skippedSourceKinds?.has("freeze_snapshot") ? "pass" : "warning",
        detail: input.skippedSourceKinds?.has("freeze_snapshot")
          ? "Profile snapshot was intentionally skipped for this lightweight turn."
          : input.freezeSnapshotPresent ? "Profile snapshot is pinned for this turn." : "Profile snapshot is missing for this turn."
      }
    ]
  };
}

function externalAssistSourceStatus(
  role: "assistive" | "disabled",
  hintCount: number
): HostContextAssembly["sources"][number]["status"] {
  if (role === "disabled") {
    return "disabled";
  }
  return hintCount > 0 ? "included" : "empty";
}

function externalAssistSourceReason(role: "assistive" | "disabled", hintCount: number, failureCount: number): string {
  if (role === "disabled") {
    return "External assist is disabled in workspace settings.";
  }
  if (hintCount > 0) {
    return "External assist returned unverified hints isolated from Memory.";
  }
  if (failureCount > 0) {
    return "External assist failed non-fatally; accepted Memory and Session Search remain available.";
  }
  return "External assist is enabled but returned no hint for this query.";
}

function contextAssemblyStatus(candidateCount: number, includedCount: number): HostContextAssembly["sources"][number]["status"] {
  if (candidateCount === 0 && includedCount === 0) {
    return "empty";
  }
  if (includedCount < candidateCount) {
    return "filtered";
  }
  return includedCount > 0 ? "included" : "empty";
}

function contextAssemblySource(
  kind: HostContextAssembly["sources"][number]["kind"],
  status: HostContextAssembly["sources"][number]["status"],
  candidateCount: number,
  includedCount: number,
  reason: string,
  skippedSourceKinds?: Set<HostContextAssembly["sources"][number]["kind"]>
): HostContextAssembly["sources"][number] {
  if (skippedSourceKinds?.has(kind)) {
    return {
      kind,
      status: "skipped",
      candidate_count: 0,
      included_count: 0,
      reason: "Skipped for lightweight external backend context."
    };
  }
  return {
    kind,
    status,
    candidate_count: Math.max(0, candidateCount),
    included_count: Math.max(0, includedCount),
    reason
  };
}

function contextAssemblyOmissions(input: BuildHostContextAssemblyInput): HostContextAssembly["omissions"] {
  const omissions: HostContextAssembly["omissions"] = [];
  if (input.messageCount > input.recentMessageCount) {
    omissions.push({
      kind: "recent_messages",
      count: input.messageCount - input.recentMessageCount,
      reason: `Older messages were omitted from the live backend context after the latest ${hostContextAssemblyLimits.recent_messages}.`
    });
  }
  if (input.knowledgeWikiCandidateCount > input.knowledgeWikiIncludedCount) {
    omissions.push({
      kind: "knowledge_wiki",
      count: input.knowledgeWikiCandidateCount - input.knowledgeWikiIncludedCount,
      reason: "Knowledge Wiki pages without readable active content were omitted."
    });
  }
  if (input.activeMemoryCandidateCount > input.activeMemoryCount) {
    omissions.push({
      kind: "active_memory",
      count: input.activeMemoryCandidateCount - input.activeMemoryCount,
      reason: "Session/provisional/archived/empty Memory candidates were excluded from normal backend context."
    });
  }
  if (input.collectionNoteCandidateCount > input.collectionNoteIncludedCount) {
    omissions.push({
      kind: "collection_notes",
      count: input.collectionNoteCandidateCount - input.collectionNoteIncludedCount,
      reason: "Collection notes outside the query match or context limit were omitted."
    });
  }
  if (input.sessionSearchCandidateCount > input.sessionSearchIncludedCount) {
    omissions.push({
      kind: "session_search",
      count: input.sessionSearchCandidateCount - input.sessionSearchIncludedCount,
      reason: `Session Search results were capped at ${hostContextAssemblyLimits.session_search}.`
    });
  }
  if (input.externalAssistFailureCount > 0) {
    omissions.push({
      kind: "external_assist",
      count: input.externalAssistFailureCount,
      reason: "External assist failures were isolated from accepted Memory and kept as diagnostics."
    });
  }
  if (!input.freezeSnapshotPresent && !input.skippedSourceKinds?.has("freeze_snapshot")) {
    omissions.push({
      kind: "freeze_snapshot",
      reason: "Freeze snapshot was not available for this turn."
    });
  }
  return omissions;
}

function shouldIncludeSessionSearchInBackendContext(query: string): boolean {
  const normalized = query.trim().replace(/[！!。.,、\s]/g, "").toLowerCase();
  if (!normalized) {
    return false;
  }
  const greetingOnly = new Set([
    "こんにちは",
    "こんばんは",
    "おはよう",
    "おはようございます",
    "やあ",
    "hi",
    "hello",
    "hey"
  ]);
  if (greetingOnly.has(normalized)) {
    return false;
  }
  return query.trim().length >= 12 || /続き|前回|さっき|以前|覚えて|探して|検索|session|history|履歴/i.test(query);
}

function classifyBackendContextIntent(query: string): BackendContextIntent {
  const trimmed = query.trim();
  const normalized = trimmed.replace(/[！!。.,、\s]/g, "").toLowerCase();
  if (!normalized) {
    return "light_chat";
  }
  if (/続き|前回|さっき|以前|この前|覚えて|思い出|探して|検索|履歴|history|session|remember|previous|last time/i.test(trimmed)) {
    return "contextual_chat";
  }
  if (/作って|作成|編集|修正|実装|調査|確認|レビュー|テスト|ビルド|実行|保存|更新|追加|削除|まとめて|書いて|生成|deploy|build|test|fix|implement|review|create|update|delete|search/i.test(trimmed)) {
    return "workspace_task";
  }
  const lightChatOnly = new Set([
    "こんにちは",
    "こんばんは",
    "おはよう",
    "おはようございます",
    "ありがとう",
    "ありがとうございます",
    "了解",
    "ok",
    "okay",
    "hi",
    "hello",
    "hey",
    "thanks",
    "thankyou",
    "thankyou"
  ]);
  if (lightChatOnly.has(normalized) || trimmed.length <= 8) {
    return "light_chat";
  }
  return trimmed.length >= 24 ? "workspace_task" : "contextual_chat";
}

function expectedBackendOutputs(query: string): Array<"artifact"> {
  return shouldCreateArtifactOutput(query) ? ["artifact"] : [];
}

function createBackendToolBridge(input: {
  backendKind: AgentBackendKind;
  runId: string;
  expectedOutputs: Array<"artifact">;
  contextIntent: BackendContextIntent;
  gatewayBoundaryPresent: boolean;
}): BackendToolBridge | undefined {
  if (input.gatewayBoundaryPresent) {
    return undefined;
  }
  const shouldExposeBridge = input.expectedOutputs.includes("artifact") || input.contextIntent === "workspace_task";
  if (!shouldExposeBridge) {
    return undefined;
  }
  if (input.backendKind !== "claude_code" && input.backendKind !== "codex" && input.backendKind !== "external") {
    return undefined;
  }
  return {
    enabled: true,
    server_name: "samurai",
    endpoint_url: toolBridgeEndpointUrl(input.runId),
    token: randomBytes(32).toString("hex"),
    token_env: "SAMURAI_TOOL_BRIDGE_TOKEN",
    tools: samuraiToolBridgeDescriptors
  };
}

const samuraiToolBridgeDescriptors: BackendToolBridge["tools"] = [{
  name: "samurai.artifact.create",
  provider_tool_name: "mcp__samurai__artifact_create",
  title: "Create Samurai Artifact",
  description: "Create a Samurai workspace Artifact from generated user-facing content.",
  input_schema: {
    type: "object",
    required: ["title", "content"],
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      kind: { type: "string", enum: ["markdown", "document", "table", "chart", "structured_draft", "generated_report", "note"] },
      metadata: { type: "object" }
    }
  }
}, {
  name: "samurai.session.search",
  provider_tool_name: "mcp__samurai__session_search",
  title: "Search Samurai Sessions",
  description: "Search previous Samurai sessions without injecting them into the prompt.",
  input_schema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      limit: { type: "number" }
    }
  }
}, {
  name: "samurai.memory.search",
  provider_tool_name: "mcp__samurai__memory_search",
  title: "Search Samurai Memory",
  description: "Search accepted Samurai Memory entries by topic.",
  input_schema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      limit: { type: "number" }
    }
  }
}, {
  name: "samurai.wiki.search",
  provider_tool_name: "mcp__samurai__wiki_search",
  title: "Search Samurai Knowledge Wiki",
  description: "Search active Knowledge Wiki pages and return refs.",
  input_schema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      limit: { type: "number" }
    }
  }
}, {
  name: "samurai.skill.search",
  provider_tool_name: "mcp__samurai__skill_search",
  title: "Search Samurai Skills",
  description: "Search reusable Samurai Skills and return catalog refs.",
  input_schema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      limit: { type: "number" }
    }
  }
}, {
  name: "samurai.collection.search",
  provider_tool_name: "mcp__samurai__collection_search",
  title: "Search Samurai Collections",
  description: "Search local Collection records and return read-only summaries.",
  input_schema: {
    type: "object",
    properties: {
      collection_id: { type: "string" },
      query: { type: "string" },
      limit: { type: "number" }
    }
  }
}];

const samuraiToolBridgeTools = new Set(samuraiToolBridgeDescriptors.map((tool) => tool.name));

function toolBridgeEndpointUrl(runId: string): string {
  const explicit = process.env.SAMURAI_TOOL_BRIDGE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\{run_id\}/g, encodeURIComponent(runId));
  }
  const port = process.env.PORT?.trim() || "4317";
  return `http://127.0.0.1:${port}/api/backend-runs/${encodeURIComponent(runId)}/tool-calls`;
}

function shouldCreateArtifactOutput(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) {
    return false;
  }
  if (/実装|修正|編集|コード|テスト|ビルド|デプロイ|commit|branch|pr|pull request|fix|implement|test|build|deploy|code/i.test(trimmed)) {
    return false;
  }
  if (/ファイル|保存|書き込|追加先|保存先|path|plans\/|\.md\b|markdown\s+file|save\s+as|write\s+(a\s+)?file/i.test(trimmed)) {
    return false;
  }
  const asksToCreate = /作って|作成|書いて|まとめて|生成|下書き|ドラフト|create|write|draft|generate/i.test(trimmed);
  if (!asksToCreate) {
    return false;
  }
  return /作業メモ|メモ|議事録|下書き|ドラフト|提案書|企画書|レポート|報告書|資料|ドキュメント|文章|メール文|表|一覧|memo|note|minutes|draft|proposal|report|document|table|email/i.test(trimmed);
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

function normalizeSamuraiToolBridgeName(name: string): string {
  const normalized = name.trim();
  const descriptor = samuraiToolBridgeDescriptors.find((tool) => tool.name === normalized || tool.provider_tool_name === normalized);
  if (descriptor) {
    return descriptor.name;
  }
  const aliases: Record<string, string> = {
    "artifact.create": "samurai.artifact.create",
    create_artifact: "samurai.artifact.create",
    artifact_create: "samurai.artifact.create",
    mcp__samurai__artifact_create: "samurai.artifact.create",
    session_search: "samurai.session.search",
    mcp__samurai__session_search: "samurai.session.search",
    memory_search: "samurai.memory.search",
    mcp__samurai__memory_search: "samurai.memory.search",
    wiki_search: "samurai.wiki.search",
    knowledge_wiki_search: "samurai.wiki.search",
    mcp__samurai__wiki_search: "samurai.wiki.search",
    skill_search: "samurai.skill.search",
    mcp__samurai__skill_search: "samurai.skill.search",
    collection_search: "samurai.collection.search",
    mcp__samurai__collection_search: "samurai.collection.search"
  };
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  return normalized;
}

function artifactKindPayload(value: JsonValue | undefined): ArtifactKind | undefined {
  return typeof value === "string" && artifactKindValues.includes(value as ArtifactKind) ? value as ArtifactKind : undefined;
}

const artifactKindValues: ArtifactKind[] = ["markdown", "document", "table", "chart", "image", "pdf", "structured_draft", "generated_report", "note"];

function isSamuraiToolBridgeObservedProviderTool(providerToolName: string, payload: Record<string, JsonValue>): boolean {
  if (payload.already_executed === true && payload.tool_origin === "samurai_tool_bridge") {
    return true;
  }
  return providerToolName === "mcp__samurai__artifact_create" && payload.tool_origin === "samurai_tool_bridge";
}

function timingSafeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function mergeUniqueById<T extends { id: string }>(target: T[], source: T[]): void {
  const ids = new Set(target.map((item) => item.id));
  for (const item of source) {
    if (!ids.has(item.id)) {
      target.push(item);
      ids.add(item.id);
    }
  }
}

function shouldThinExternalBackendContext(kind: AgentBackendKind, intent: BackendContextIntent): boolean {
  return intent === "light_chat" && (kind === "claude_code" || kind === "codex" || kind === "external");
}

function emptyActiveMemoryResult(query: string): Awaited<ReturnType<typeof retrieveActiveMemoryWithReport>> {
  return {
    candidates: [],
    report: {
      query,
      retrieved_at: nowIso(),
      candidate_count: 0,
      included_count: 0,
      included_memory_ids: [],
      excluded: [],
      sensitive_redactions: [],
      conflict_groups: [],
      resolution_suggestions: []
    }
  };
}

function emptyKnowledgeWikiContext(query: string): {
  pages: WikiWithFilePath[];
  entries: ContextPreview["knowledge_wiki"];
  report: ContextPreview["knowledge_wiki_report"];
} {
  return {
    pages: [],
    entries: [],
    report: {
      query,
      retrieved_at: nowIso(),
      candidate_count: 0,
      included_count: 0,
      included_wiki_ids: [],
      excluded: [],
      source_refs: []
    }
  };
}

function emptyExternalAssistContext(role: "assistive" | "disabled", note: string): ContextPreview["external_assist"] {
  return {
    role,
    isolated_from_memory: true,
    included_in_active_memory: false,
    note,
    hints: [],
    recent_failures: []
  };
}

function hasMeaningfulBackendOutput(
  events: BackendEventRecord[],
  workspaceChanges: WorkspaceChangeRecord[],
  artifacts: ArtifactRecord[]
): boolean {
  const userFacingChanges = workspaceChanges.filter((change) => change.change_type !== "memory_suggested");
  if (artifacts.length > 0 || userFacingChanges.length > 0) {
    return true;
  }
  return events.some((event) =>
    event.event_type !== "run_started"
    && event.event_type !== "run_completed"
    && event.event_type !== "agent_reasoning"
    && event.event_type !== "host_progress"
  );
}

function meaningfulBackendRunSummary(summary: string | undefined): string {
  const trimmed = summary?.trim() ?? "";
  if (!trimmed || trimmed === "Codex completed.") {
    return "";
  }
  return trimmed;
}

function applyGatewayBoundaryToContextAssembly(
  assembly: HostContextAssembly,
  boundary: GatewayBoundaryRuntimeSnapshot | undefined,
  availableToolsBeforeBoundary: string[],
  availableToolsAfterBoundary: string[]
): HostContextAssembly {
  if (!boundary) {
    return assembly;
  }
  const beforeCount = availableToolsBeforeBoundary.length;
  const afterCount = availableToolsAfterBoundary.length;
  const filteredCount = Math.max(0, beforeCount - afterCount);
  const sources = assembly.sources.map((source) => {
    if (source.kind === "available_tools") {
      return contextAssemblySource(
        "available_tools",
        filteredCount > 0 ? "filtered" : contextAssemblyStatus(beforeCount, afterCount),
        beforeCount,
        afterCount,
        filteredCount > 0 ? "Gateway boundary policy filtered the workspace tool catalog." : "Gateway boundary policy allowed the available workspace tools."
      );
    }
    if (source.kind === "gateway_boundary") {
      return contextAssemblySource(
        "gateway_boundary",
        "included",
        1,
        1,
        "Gateway boundary runtime snapshot is attached to this backend run."
      );
    }
    return source;
  });
  const omissions = filteredCount > 0
    ? [
        ...assembly.omissions,
        {
          kind: "available_tools" as const,
          count: filteredCount,
          reason: "Gateway boundary policy removed tools not allowed for this source."
        }
      ]
    : assembly.omissions;
  const gatewayBoundary: HostContextAssembly["gateway_boundary"] = {
    present: true,
    policy_id: boundary.policy_id,
    source_channel: boundary.source_channel,
    ...(boundary.source_identity ? { source_identity: boundary.source_identity } : {}),
    allowed_tools_count: boundary.allowed_tools.length,
    available_tools_before_boundary: beforeCount,
    available_tools_after_boundary: afterCount,
    filtered_tool_count: filteredCount,
    reason: filteredCount > 0 ? "Gateway boundary restricted available tools for this run." : "Gateway boundary did not remove any available tool for this run."
  };
  return {
    ...assembly,
    sources,
    omissions,
    gateway_boundary: gatewayBoundary,
    quality_checks: [
      ...assembly.quality_checks,
      {
        id: "gateway_boundary_applied",
        status: "pass",
        detail: filteredCount > 0
          ? `Gateway boundary filtered ${filteredCount} tool(s).`
          : "Gateway boundary was attached and required no tool filtering."
      }
    ]
  };
}

function contextAssemblyRuntimeMetadata(assembly: HostContextAssembly): Record<string, JsonValue> {
  return {
    context_assembly_version: assembly.version,
    context_assembly_sources: assembly.sources.map((source) => ({
      kind: source.kind,
      status: source.status,
      candidate_count: source.candidate_count,
      included_count: source.included_count
    })),
    context_assembly_gateway_boundary_present: assembly.gateway_boundary.present,
    context_assembly_filtered_tool_count: assembly.gateway_boundary.filtered_tool_count,
    context_assembly_quality_warnings: assembly.quality_checks
      .filter((check) => check.status !== "pass")
      .map((check) => ({ id: check.id, status: check.status, detail: check.detail }))
  };
}

function buildContextHandoffForBackend(input: {
  backendKind: AgentBackendKind;
  contextIntent: BackendContextIntent;
  contextPreview: ContextPreview;
  contextAssembly: HostContextAssembly;
  gatewayBoundaryPresent: boolean;
}): ContextHandoff {
  const pointerFirst = input.backendKind === "claude_code" || input.backendKind === "codex" || input.backendKind === "external";
  const sourceByKind = new Map(input.contextAssembly.sources.map((source) => [source.kind, source]));
  const modeFor = (kind: HostContextAssembly["sources"][number]["kind"], includedCount: number): ContextHandoff["sources"][number]["mode"] => {
    const source = sourceByKind.get(kind);
    if (!source || source.status === "skipped" || includedCount === 0) {
      return "skipped";
    }
    if (!pointerFirst) {
      return "inline";
    }
    return kind === "session" || kind === "recent_messages" ? "inline" : "pointer";
  };
  const refsFor = (kind: HostContextAssembly["sources"][number]["kind"]): ResourceRef[] => {
    switch (kind) {
      case "freeze_snapshot":
        return [
          input.contextPreview.freeze_snapshot?.soul.file_ref,
          input.contextPreview.freeze_snapshot?.profile?.file_ref,
          ...(input.contextPreview.freeze_snapshot?.memory_refs ?? []),
          ...(input.contextPreview.freeze_snapshot?.skill_refs ?? []),
          ...(input.contextPreview.freeze_snapshot?.wiki_refs ?? [])
        ].filter((ref): ref is ResourceRef => Boolean(ref));
      case "active_memory":
        return input.contextPreview.active_memory.map((memory) => ({
          kind: "memory",
          id: memory.id,
          uri: `memory/${memory.state}/${memory.id}.md`,
          label: memory.topic
        }));
      case "knowledge_wiki":
        return input.contextPreview.knowledge_wiki.map((wiki) => ({
          kind: "wiki",
          id: wiki.id,
          uri: `wiki/${wiki.slug}.md`,
          label: wiki.title
        }));
      case "collection_notes":
        return input.contextPreview.collection_notes.map((note) => fileRef(note.file_path));
      case "selected_skills":
        return input.contextPreview.selected_skills.flatMap((skill) => [
          {
            kind: "skill",
            id: skill.id,
            uri: `skills/${skill.id}/SKILL.md`,
            label: skill.title
          },
          ...(skill.support_file_refs ?? []).map((file) => ({
            kind: "skill_support_file",
            id: `${skill.id}:${file.path}`,
            uri: file.file_path,
            label: file.path
          }))
        ]);
      case "session_search":
        return input.contextPreview.session_search.map((result) => ({
          kind: result.kind,
          id: result.id,
          uri: `session-search/${result.kind}/${result.id}`,
          label: result.title
        }));
      case "external_assist":
        return input.contextPreview.external_assist.hints.map((hint) => ({
          kind: "external_assist",
          id: hint.id,
          uri: hint.source_uri ?? `external-assist/${hint.id}`,
          label: hint.title ?? hint.summary
        }));
      case "recent_messages":
        return input.contextPreview.recent_messages.map((message) => ({
          kind: "message",
          id: message.id,
          uri: `session/${input.contextPreview.session_id}/messages/${message.id}`,
          label: message.role
        }));
      case "available_tools":
        return input.contextPreview.available_tools.map((tool) => ({
          kind: "tool",
          id: stableHash(tool),
          uri: `tool/${tool}`,
          label: tool
        }));
      case "gateway_boundary":
        return input.gatewayBoundaryPresent
          ? [{
              kind: "gateway_boundary",
              id: input.contextPreview.session_id,
              uri: `session/${input.contextPreview.session_id}/gateway-boundary`,
              label: "Gateway Boundary"
            }]
          : [];
      case "session":
        return [{
          kind: "session",
          id: input.contextPreview.session_id,
          uri: `session/${input.contextPreview.session_id}`,
          label: input.contextPreview.session_summary.title
        }];
      default:
        return [];
    }
  };
  const sources = input.contextAssembly.sources.map((source) => {
    const refs = refsFor(source.kind);
    return {
      kind: source.kind,
      mode: modeFor(source.kind, source.included_count),
      candidate_count: source.candidate_count,
      included_count: source.included_count,
      reason: source.reason,
      refs
    };
  });
  const estimatedSize = JSON.stringify({
    query: input.contextPreview.query,
    sources: sources.map((source) => ({
      kind: source.kind,
      mode: source.mode,
      refs: source.refs.map((ref) => ref.uri)
    }))
  }).length;
  return {
    version: 1,
    strategy: pointerFirst ? "pointer_first" : "inline_context",
    sources,
    ...(estimatedSize > 16_000 ? { prompt_size_warning: `Context handoff is ${estimatedSize} characters before backend prompt formatting.` } : {})
  };
}

function contextHandoffRuntimeMetadata(handoff: ContextHandoff): Record<string, JsonValue> {
  return {
    context_handoff_version: handoff.version,
    context_handoff_strategy: handoff.strategy,
    context_handoff_sources: handoff.sources.map((source) => ({
      kind: source.kind,
      mode: source.mode,
      candidate_count: source.candidate_count,
      included_count: source.included_count,
      ref_count: source.refs.length,
      reason: source.reason
    })),
    ...(handoff.prompt_size_warning ? { context_handoff_prompt_size_warning: handoff.prompt_size_warning } : {})
  };
}

function gatewayBoundaryRuntimeSnapshot(policy: GatewayBoundaryPolicy): GatewayBoundaryRuntimeSnapshot {
  const secretRefIds = new Set<string>();
  for (const ref of policy.secret_refs) {
    secretRefIds.add(ref.id);
  }
  for (const mcp of policy.mcp_config_refs) {
    for (const ref of mcp.secret_refs) {
      secretRefIds.add(ref.id);
    }
  }
  return {
    policy_id: policy.id,
    source_channel: policy.source_channel,
    source_identity: policy.source_identity,
    session_key: policy.session_key,
    allowed_tools: policy.allowed_tools,
    mcp_config_refs: policy.mcp_config_refs.map((ref) => ({
      id: ref.id,
      server_name: ref.server_name,
      config_ref: ref.config_ref,
      allowed_tools: ref.allowed_tools,
      secret_ref_ids: ref.secret_refs.map((secretRef) => secretRef.id)
    })),
    secret_ref_ids: [...secretRefIds],
    sandbox: policy.sandbox,
    path_normalization: policy.path_normalization,
    allowlist: policy.allowlist,
    timeout_ms: policy.timeout_ms,
    concurrency_lock: policy.concurrency_lock,
    created_at: nowIso()
  };
}

function gatewayBoundaryRuntimeMetadata(snapshot: GatewayBoundaryRuntimeSnapshot): Record<string, JsonValue> {
  return {
    gateway_boundary_policy_id: snapshot.policy_id,
    gateway_boundary_source_channel: snapshot.source_channel,
    gateway_boundary_source_identity: snapshot.source_identity ?? null,
    gateway_boundary_allowed_tools: snapshot.allowed_tools,
    gateway_boundary_sandbox_mode: snapshot.sandbox.mode,
    gateway_boundary_sandbox_backend: snapshot.sandbox.backend,
    gateway_boundary_workspace_access: snapshot.sandbox.workspace_access,
    gateway_boundary_network_access: snapshot.sandbox.network_access,
    gateway_boundary_secret_ref_ids: snapshot.secret_ref_ids,
    gateway_boundary_mcp_config_ref_ids: snapshot.mcp_config_refs.map((ref) => ref.id),
    gateway_boundary_concurrency_lock_key: snapshot.concurrency_lock?.key ?? null
  };
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

function createGatewayInboundMessage(input: {
  channel: GatewayInboundMessageRecord["channel"];
  source_identity: string;
  body: string;
  pairing?: GatewayPairingRecord;
  metadata?: Record<string, JsonValue>;
}): GatewayInboundMessageRecord {
  const now = nowIso();
  const trusted = input.pairing?.status === "approved";
  return {
    id: createId("gateway_inbound"),
    channel: input.channel,
    source_identity: input.source_identity,
    body: input.body,
    status: trusted ? "routed" : "blocked",
    trusted,
    session_key: trusted ? input.pairing?.session_key : undefined,
    pairing_id: input.pairing?.id,
    metadata: input.metadata ?? {},
    created_at: now,
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

function renderSkillMarkdown(frontmatter: SkillFrontmatter, content: string): string {
  const parsed = SkillFrontmatterSchema.parse(frontmatter);
  return ["---", JSON.stringify(parsed, null, 2), "---", content.trim(), ""].join("\n");
}

function parseSkillMarkdown(markdown: string): { frontmatter: SkillFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("skill_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("skill_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  return {
    frontmatter: SkillFrontmatterSchema.parse(JSON.parse(rawFrontmatter)),
    content: contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim()
  };
}

function stripSkillFrontmatter(markdown: string): string {
  return parseSkillMarkdown(markdown).content.trim();
}

function memoryRef(memory: MemoryFrontmatter & { file_path?: string }) {
  return {
    kind: "memory",
    id: memory.id,
    uri: memory.file_path ?? `memory/${memory.state}/${memory.id}.md`,
    label: memory.topic
  };
}

function skillRef(skill: SkillWithFilePath) {
  return {
    kind: "skill",
    id: skill.id,
    uri: skill.file_path,
    label: skill.title
  };
}

function skillSupportFileRef(file: SkillSupportFile) {
  return {
    kind: "skill_support_file",
    id: `${file.skill_id}:${file.path}`,
    uri: file.file_path,
    label: file.path
  };
}

type SkillDisclosureLevel = "catalog" | "body" | "support";
type RuntimeSkillSelection = NonNullable<ContextPreview["selected_skills"][number]["selection"]>;

function selectRuntimeSkills(input: {
  candidates: SkillWithFilePath[];
  query: string;
  limit: number;
}): {
  selected: Array<{ skill: SkillWithFilePath; selection: RuntimeSkillSelection }>;
  report: ContextPreview["skill_selection_report"];
} {
  const availableCapabilities = availableRuntimeCapabilities();
  const availableCapabilitySet = new Set(availableCapabilities);
  const supportedScopes = supportedRuntimeScopes();
  const terms = skillQueryTerms(input.query);
  const evaluated = input.candidates.map((skill) => {
    const selection = evaluateSkillSelection(skill, terms, availableCapabilitySet, supportedScopes);
    const excludedReason = selection.missing_capabilities.length
      ? "missing_capability" as const
      : selection.unsupported_scopes.length
        ? "scope_unsupported" as const
        : undefined;
    return { skill, selection, excludedReason };
  });
  const selected = evaluated
    .filter((item) => !item.excludedReason)
    .sort((left, right) => right.selection.score - left.selection.score || left.skill.title.localeCompare(right.skill.title))
    .slice(0, input.limit)
    .map(({ skill, selection }) => ({ skill, selection }));
  return {
    selected,
    report: {
      query: input.query,
      candidate_count: input.candidates.length,
      selected_count: selected.length,
      selected_skill_ids: selected.map((item) => item.skill.id),
      available_capabilities: availableCapabilities,
      environment: {
        runtime: "local_workspace",
        platform: process.platform
      },
      excluded: evaluated
        .filter((item) => Boolean(item.excludedReason))
        .map((item) => ({
          id: item.skill.id,
          title: item.skill.title,
          reason: item.excludedReason!,
          missing_capabilities: item.selection.missing_capabilities,
          unsupported_scopes: item.selection.unsupported_scopes
        }))
    }
  };
}

function evaluateSkillSelection(
  skill: SkillWithFilePath,
  terms: string[],
  availableCapabilities: Set<string>,
  supportedScopes: Set<SkillFrontmatter["allowed_scopes"][number]>
): RuntimeSkillSelection {
  const allowedScopes = skillAllowedScopes(skill);
  const ownerPinned = skillOwnerPinned(skill);
  const catalog = normalizeSkillSearchText([
    skill.title,
    skill.description,
    skill.tags.join(" "),
    skill.required_capabilities.join(" "),
    allowedScopes.join(" ")
  ].join(" "));
  const matchedTerms = terms.filter((term) => catalog.includes(term));
  const matchedCapabilities = skill.required_capabilities.filter((capability) => availableCapabilities.has(capability));
  const missingCapabilities = skill.required_capabilities.filter((capability) => !availableCapabilities.has(capability));
  const unsupportedScopes = allowedScopes.filter((scope) => !supportedScopes.has(scope));
  const reasons: string[] = [];
  if (matchedTerms.length) {
    reasons.push(`Matched query terms: ${matchedTerms.join(", ")}.`);
  }
  if (matchedCapabilities.length) {
    reasons.push(`Required capabilities available: ${matchedCapabilities.join(", ")}.`);
  }
  if (missingCapabilities.length) {
    reasons.push(`Missing capabilities: ${missingCapabilities.join(", ")}.`);
  }
  if (unsupportedScopes.length) {
    reasons.push(`Unsupported scopes: ${unsupportedScopes.join(", ")}.`);
  }
  if (ownerPinned) {
    reasons.push("Owner pinned skill.");
  }
  if (!reasons.length) {
    reasons.push("Skill catalog matched the query.");
  }
  return {
    score: matchedTerms.length * 10 + matchedCapabilities.length * 6 + (ownerPinned ? 4 : 0) + stateSelectionBoost(skill.state),
    matched_terms: matchedTerms,
    matched_capabilities: matchedCapabilities,
    missing_capabilities: missingCapabilities,
    unsupported_scopes: unsupportedScopes,
    reasons
  };
}

function availableRuntimeCapabilities(): string[] {
  return [...new Set([
    ...proposalCapabilityManifest.agent_tools,
    ...proposalCapabilityManifest.operations.map((operation) => operation.operation)
  ])].sort();
}

function supportedRuntimeScopes(): Set<SkillFrontmatter["allowed_scopes"][number]> {
  return new Set([
    ...proposalCapabilityManifest.operations.map((operation) => operation.scope),
    "artifact",
    "collection",
    "memory",
    "session",
    "skill",
    "workspace"
  ]);
}

function skillAllowedScopes(skill: SkillWithFilePath): SkillFrontmatter["allowed_scopes"] {
  return Array.isArray(skill.allowed_scopes) ? skill.allowed_scopes : skill.frontmatter.allowed_scopes;
}

function skillOwnerPinned(skill: SkillWithFilePath): boolean {
  return Boolean(skill.owner_pinned ?? skill.frontmatter.owner_pinned);
}

function stateSelectionBoost(state: SkillWithFilePath["state"]): number {
  if (state === "pinned" || state === "active") {
    return 5;
  }
  if (state === "project") {
    return 3;
  }
  return 0;
}

function decideSkillDisclosureLevel(input: {
  skill: SkillWithFilePath;
  index: number;
  query: string;
  content: string;
  matchedSupportFiles: SkillSupportFile[];
}): SkillDisclosureLevel {
  void input;
  return "catalog";
}

function selectSkillSupportFiles(files: SkillSupportFile[], query: string): SkillSupportFile[] {
  const terms = skillQueryTerms(query);
  const wantsSupport = wantsSkillSupportDisclosure(query);
  const scored = files
    .map((file) => ({
      file,
      score: scoreSkillSupportFile(file, terms, wantsSupport)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  return scored.slice(0, 5).map((entry) => entry.file);
}

type CollectionContextNote = {
  collection_id: string;
  file_path: string;
  content: string;
  role: "context_only";
};

function selectCollectionNotes(notes: CollectionContextNote[], query: string): CollectionContextNote[] {
  const terms = skillQueryTerms(query);
  const scored = notes
    .filter((note) => note.content.trim().length > 0)
    .map((note, index) => ({
      note,
      score: scoreCollectionNote(note, terms, index)
    }))
    .filter((entry) => terms.length === 0 || entry.score > 0)
    .sort((left, right) => right.score - left.score || left.note.file_path.localeCompare(right.note.file_path));
  return scored.slice(0, 5).map((entry) => ({
    ...entry.note,
    content: truncateContextText(entry.note.content)
  }));
}

function scoreCollectionNote(note: CollectionContextNote, terms: string[], index: number): number {
  if (terms.length === 0) {
    return Math.max(1, 5 - index);
  }
  const haystack = normalizeSkillSearchText(`${note.collection_id} ${note.file_path} ${note.content}`);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function truncateContextText(content: string, maxLength = 4000): string {
  return content.length > maxLength ? `${content.slice(0, maxLength).trimEnd()}\n[truncated]` : content;
}

function scoreSkillSupportFile(file: SkillSupportFile, terms: string[], wantsSupport: boolean): number {
  const pathText = normalizeSkillSearchText(file.path);
  const contentText = normalizeSkillSearchText(file.content);
  let score = wantsSupport && isKnownSkillSupportPath(pathText) ? 2 : 0;
  for (const term of terms) {
    if (pathText.includes(term)) {
      score += 8;
    }
    if (contentText.includes(term)) {
      score += 3;
    }
  }
  return score;
}

function describeSkillSelection(
  level: SkillDisclosureLevel,
  index: number,
  supportFiles: SkillSupportFile[],
  usage?: { use_count: number; last_used_at?: string },
  selection?: RuntimeSkillSelection
): string {
  const usageNote = usage ? ` Usage: ${usage.use_count} prior run(s)${usage.last_used_at ? `, last used ${usage.last_used_at}` : ""}.` : "";
  const selectionNote = selection?.reasons.length ? ` ${selection.reasons.join(" ")}` : "";
  if (level === "support") {
    return `Matched support files: ${supportFiles.map((file) => file.path).join(", ")}.${selectionNote}${usageNote}`.trim();
  }
  if (level === "body") {
    return `${index === 0 ? "Top skill match; body disclosed." : "Skill body matched the request."}${selectionNote}${usageNote}`.trim();
  }
  return `Catalog match only; body and support files stay undisclosed until needed.${selectionNote}${usageNote}`.trim();
}

function wantsSkillSupportDisclosure(query: string): boolean {
  const normalized = normalizeSkillSearchText(query);
  return [
    "reference",
    "references",
    "template",
    "templates",
    "script",
    "scripts",
    "asset",
    "assets",
    "support",
    "style",
    "example",
    "examples",
    "補助",
    "資料",
    "詳細",
    "詳しく",
    "手順",
    "例",
    "使い方",
    "スタイル"
  ].some((hint) => normalized.includes(hint));
}

function isKnownSkillSupportPath(pathText: string): boolean {
  return [
    "references/",
    "templates/",
    "scripts/",
    "assets/",
    "examples/"
  ].some((prefix) => pathText.startsWith(prefix));
}

function skillQueryTerms(query: string): string[] {
  return normalizeSkillSearchText(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function normalizeSkillSearchText(value: string): string {
  return value.toLowerCase().normalize("NFKC");
}

function groupByRunId<T extends { run_id: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const existing = grouped.get(item.run_id) ?? [];
    existing.push(item);
    grouped.set(item.run_id, existing);
  }
  return grouped;
}

function backendRunRef(run: BackendRunRecord): ResourceRef {
  return {
    kind: "backend_run",
    id: run.id,
    uri: `backend-runs/${run.id}`,
    label: run.input_summary
  };
}

function normalizeBackendStreamEvent(event: BackendOutputEvent): BackendOutputEvent {
  const normalized = normalizeBackendOutputEvent(event);
  if (
    normalized.event_type === "run_failed"
    && (normalized.payload.error_code === "backend_stream_unavailable" || normalized.payload.reason === "stream_unavailable")
  ) {
    return {
      event_type: "backend_stream_unavailable",
      payload: normalized.payload,
      resource_refs: normalized.resource_refs,
      tool_call_id: normalized.tool_call_id
    };
  }
  return normalized;
}

function backendOutputEventSignature(event: BackendOutputEvent): string {
  const normalized = normalizeBackendOutputEvent(event);
  return stableHash(JSON.stringify({
    event_type: normalized.event_type,
    payload: normalized.payload,
    resource_refs: normalized.resource_refs ?? []
  }));
}

function backendEventSignature(event: BackendEventRecord): string {
  return stableHash(JSON.stringify({
    event_type: event.event_type,
    payload: event.payload,
    resource_refs: event.resource_refs
  }));
}

async function nextBackendStreamEvent(
  iterator: AsyncIterator<BackendOutputEvent>,
  timeoutMs: number
): Promise<IteratorResult<BackendOutputEvent> | "timeout"> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function toolRunRef(toolRun: ToolRunRecord): ResourceRef {
  return {
    kind: "tool_run",
    id: toolRun.id,
    uri: `tool-runs/${toolRun.id}`,
    label: `${toolRun.provider_tool_name}:${toolRun.status}`
  };
}

function applyBackendSessionMetadata(run: BackendRunRecord, event: BackendOutputEvent): BackendRunRecord {
  const backendSessionId = backendSessionIdFromPayload(event.payload, run.session_id);
  if (!backendSessionId || run.metadata.backend_session_id === backendSessionId) {
    return run;
  }
  return {
    ...run,
    metadata: {
      ...run.metadata,
      backend_session_id: backendSessionId,
      backend_session_observed_at: nowIso(),
      backend_session_source_event: event.event_type
    }
  };
}

function backendSessionIdFromPayload(payload: Record<string, JsonValue>, localSessionId: string): string | undefined {
  const candidate =
    stringPayload(payload.backend_session_id)
    || stringPayload(payload.backend_native_session_id)
    || stringPayload(payload.conversation_id)
    || stringPayload(payload.thread_id);
  if (candidate && candidate !== localSessionId) {
    return candidate;
  }
  const sessionId = stringPayload(payload.session_id);
  return sessionId && sessionId !== localSessionId ? sessionId : undefined;
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
    connection_state: status.connection_state === "ready" && latest.status === "failed" ? "degraded" : status.connection_state,
    reason: status.reason ?? (latest.status === "failed" ? latest.error_code ?? "latest_run_failed" : undefined),
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

function isAutomaticSessionMemoryChange(change: WorkspaceChangeRecord): boolean {
  return change.change_type === "memory_suggested" && change.summary.startsWith("Captured session memory ");
}

function shouldReviewNoActionTrace(
  run: BackendRunRecord,
  events: BackendEventRecord[],
  toolRuns: ToolRunRecord[],
  meaningfulChanges: WorkspaceChangeRecord[]
): boolean {
  if (run.status !== "completed" || toolRuns.length > 0 || meaningfulChanges.length > 0) {
    return false;
  }
  if (events.some((event) => ["artifact_created", "workspace_change_suggested", "skill_candidate_created"].includes(event.event_type))) {
    return false;
  }
  return looksLikeWorkspaceEffectIntent(run.input_summary);
}

function looksLikeWorkspaceEffectIntent(summary: string): boolean {
  return /作成|作って|保存|更新|追加|削除|変更|書いて|登録|反映|create|write|save|update|delete|add|artifact|collection|memory|wiki|skill|gateway|file/i.test(summary);
}

function buildEvaluationTraceReport(input: {
  backendRuns: BackendRunRecord[];
  backendEvents: BackendEventRecord[];
  workspaceChanges: WorkspaceChangeRecord[];
  toolRuns: ToolRunRecord[];
  auditRecords: AuditRecord[];
  now: string;
}): EvaluationTraceReport {
  const eventsByRun = groupByRunId(input.backendEvents);
  const changesByRun = groupByRunId(input.workspaceChanges);
  const toolsByRun = groupByRunId(input.toolRuns);
  const runScores = input.backendRuns.slice(0, 50).map((run) => {
    const events = eventsByRun.get(run.id) ?? [];
    const changes = (changesByRun.get(run.id) ?? []).filter((change) => !isAutomaticSessionMemoryChange(change));
    const toolRuns = toolsByRun.get(run.id) ?? [];
    return scoreEvaluationRun(run, events, changes, toolRuns);
  });
  const comparisons = compareEvaluationRuns(input.backendRuns, runScores);
  const findingCount = runScores.reduce((count, run) => count + run.findings.length, 0);
  return EvaluationTraceReportSchema.parse({
    id: `evaluation_report_${input.now.replace(/[^0-9A-Za-z]/g, "")}`,
    checked_at: input.now,
    judge: {
      deterministic_status: "completed",
      external_status: "not_configured",
      summary: "Deterministic trace review completed. External judge provider is not configured."
    },
    counts: {
      backend_runs: input.backendRuns.length,
      backend_events: input.backendEvents.length,
      workspace_changes: input.workspaceChanges.length,
      tool_runs: input.toolRuns.length,
      audit_records: input.auditRecords.length,
      findings: findingCount,
      comparisons: comparisons.length
    },
    run_scores: runScores,
    comparisons
  });
}

function scoreEvaluationRun(
  run: BackendRunRecord,
  events: BackendEventRecord[],
  changes: WorkspaceChangeRecord[],
  toolRuns: ToolRunRecord[]
): EvaluationTraceReport["run_scores"][number] {
  const findings: EvaluationTraceReport["run_scores"][number]["findings"] = [];
  const suggestedImprovements: string[] = [];
  let score = 100;
  const runRef = backendRunRef(run);
  if (run.status === "failed") {
    score -= 50;
    findings.push({ kind: "run_failed", severity: "critical", reason: run.error_code ?? "Backend run failed.", resource_refs: [runRef] });
    suggestedImprovements.push("Add a recovery checklist, fallback backend route, or retry condition for this failure path.");
  }
  if (run.status === "cancelled") {
    score -= 35;
    findings.push({ kind: "run_cancelled", severity: "warning", reason: "Backend run was cancelled before completion.", resource_refs: [runRef] });
    suggestedImprovements.push("Document cancellation handoff and safe resume/retry conditions.");
  }
  if (run.status === "waiting_for_backend_input") {
    score -= 30;
    findings.push({ kind: "waiting_for_input", severity: "warning", reason: "Backend is waiting for native input.", resource_refs: [runRef] });
    suggestedImprovements.push("Create or update a resume playbook so the next required action is explicit.");
  }
  const nonCompletedTools = toolRuns.filter((toolRun) => toolRun.status !== "completed");
  if (nonCompletedTools.length) {
    score -= Math.min(30, nonCompletedTools.length * 10);
    findings.push({
      kind: "tool_not_completed",
      severity: nonCompletedTools.some((toolRun) => toolRun.status === "failed") ? "critical" : "warning",
      reason: `${nonCompletedTools.length} tool run(s) were failed or ignored.`,
      resource_refs: [runRef, ...nonCompletedTools.slice(0, 5).map(toolRunRef)]
    });
    suggestedImprovements.push("Review allowed scopes, tool names, and recovery behavior before retrying.");
  }
  if (!events.length) {
    score -= 10;
    findings.push({ kind: "no_events", severity: "warning", reason: "No backend events were recorded for this run.", resource_refs: [runRef] });
    suggestedImprovements.push("Check backend event bridge coverage for this backend.");
  }
  if (shouldReviewNoActionTrace(run, events, toolRuns, changes)) {
    score -= 15;
    findings.push({ kind: "no_workspace_effect", severity: "warning", reason: "Request appears to need a workspace effect, but no meaningful workspace change was recorded.", resource_refs: [runRef] });
    suggestedImprovements.push("Map this intent to the correct workspace action, Skill, or policy hint.");
  }
  const normalizedScore = Math.max(0, Math.min(100, score));
  return {
    run_id: run.id,
    backend_id: run.backend_id,
    status: run.status,
    score: normalizedScore,
    verdict: normalizedScore >= 85 ? "pass" : normalizedScore >= 55 ? "warn" : "fail",
    findings,
    suggested_improvements: [...new Set(suggestedImprovements)]
  };
}

function compareEvaluationRuns(
  runs: BackendRunRecord[],
  scores: EvaluationTraceReport["run_scores"]
): EvaluationTraceReport["comparisons"] {
  const scoreByRun = new Map(scores.map((score) => [score.run_id, score]));
  const sortedRuns = [...runs].sort((left, right) =>
    Date.parse(left.started_at) - Date.parse(right.started_at)
  );
  const latestByInput = new Map<string, BackendRunRecord>();
  const comparisons: EvaluationTraceReport["comparisons"] = [];
  for (const run of sortedRuns) {
    const key = normalizeSkillSearchText(run.input_summary);
    const currentScore = scoreByRun.get(run.id);
    if (!key || !currentScore) {
      continue;
    }
    const baseline = latestByInput.get(key);
    if (!baseline) {
      comparisons.push({
        current_run_id: run.id,
        result: "no_baseline",
        reason: "No earlier run with the same normalized input summary."
      });
      latestByInput.set(key, run);
      continue;
    }
    const baselineScore = scoreByRun.get(baseline.id);
    const delta = currentScore.score - (baselineScore?.score ?? currentScore.score);
    comparisons.push({
      current_run_id: run.id,
      baseline_run_id: baseline.id,
      result: delta > 5 ? "improved" : delta < -5 ? "regressed" : "same",
      reason: `Score delta versus baseline: ${delta}.`
    });
    latestByInput.set(key, run);
  }
  return comparisons.slice(0, 50);
}

function applyEvaluationJudgeResult(
  report: EvaluationTraceReport,
  providerId: string,
  judge: EvaluationJudgeResult
): EvaluationTraceReport {
  const adjustments = new Map((judge.scoreAdjustments ?? []).map((item) => [item.run_id, item]));
  const runScores = report.run_scores.map((runScore) => {
    const adjustment = adjustments.get(runScore.run_id);
    if (!adjustment) {
      return runScore;
    }
    const nextScore = Math.max(0, Math.min(100, Math.round(runScore.score + adjustment.score_delta)));
    return {
      ...runScore,
      score: nextScore,
      verdict: nextScore >= 85 ? "pass" as const : nextScore >= 55 ? "warn" as const : "fail" as const,
      findings: [
        ...runScore.findings,
        {
          kind: "external_judge" as const,
          severity: "info" as const,
          reason: adjustment.reason,
          resource_refs: [{ kind: "backend_run" as const, id: runScore.run_id, uri: `backend-runs/${runScore.run_id}` }]
        }
      ]
    };
  });
  return EvaluationTraceReportSchema.parse({
    ...report,
    judge: {
      deterministic_status: "completed",
      external_status: "completed",
      provider_id: providerId,
      summary: judge.summary
    },
    counts: {
      ...report.counts,
      findings: runScores.reduce((count, run) => count + run.findings.length, 0)
    },
    run_scores: runScores
  });
}

function renderEvaluationTraceSummary(input: {
  run: BackendRunRecord;
  events: BackendEventRecord[];
  changes: WorkspaceChangeRecord[];
  toolRuns: ToolRunRecord[];
  auditRecords: AuditRecord[];
  recommendation: string;
}): string {
  return [
    "Execution trace review",
    "",
    `Run: ${input.run.id}`,
    `Backend: ${input.run.backend_id} (${input.run.backend_kind})`,
    `Status: ${input.run.status}`,
    `Input: ${input.run.input_summary}`,
    `Output: ${input.run.output_summary ?? "(none)"}`,
    `Error: ${input.run.error_code ?? "(none)"}`,
    "",
    `Events: ${summarizeEventTypes(input.events)}`,
    `Tool runs: ${summarizeToolRuns(input.toolRuns)}`,
    `Workspace changes: ${summarizeWorkspaceChanges(input.changes)}`,
    `Audit records available: ${input.auditRecords.length}`,
    "",
    `Recommendation: ${input.recommendation}`
  ].join("\n");
}

function summarizeEventTypes(events: BackendEventRecord[]): string {
  if (!events.length) {
    return "(none)";
  }
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.event_type, (counts.get(event.event_type) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([eventType, count]) => `${eventType} x${count}`).join(", ");
}

function summarizeToolRuns(toolRuns: ToolRunRecord[]): string {
  if (!toolRuns.length) {
    return "(none)";
  }
  return toolRuns.slice(0, 8).map((toolRun) =>
    `${toolRun.provider_tool_name}=${toolRun.status} (${summarize(toolRun.output_summary, 120)})`
  ).join("; ");
}

function summarizeWorkspaceChanges(changes: WorkspaceChangeRecord[]): string {
  if (!changes.length) {
    return "(none)";
  }
  return changes.slice(0, 8).map((change) =>
    `${change.change_type}: ${summarize(change.summary, 120)}`
  ).join("; ");
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
  return ["patch_record", "patch", "create_record", "create", "reindex", "reindex_collection"].includes(kind);
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

function collectionTriggerDeliveryTarget(deliveryTarget: Record<string, JsonValue>): {
  collectionId: string;
  recordId: string;
  actionId: string;
  triggerId: string;
  event: string;
  actionKind: string;
} | undefined {
  if (collectionActionString(deliveryTarget, "channel") !== "collection_trigger") {
    return undefined;
  }
  const collectionId = collectionActionString(deliveryTarget, "collection_id");
  const recordId = collectionActionString(deliveryTarget, "record_id");
  const actionId = collectionActionString(deliveryTarget, "action_id");
  if (!collectionId || !recordId || !actionId) {
    return undefined;
  }
  return {
    collectionId,
    recordId,
    actionId,
    triggerId: collectionActionString(deliveryTarget, "trigger_id") ?? actionId,
    event: collectionActionString(deliveryTarget, "event") ?? "record.created",
    actionKind: collectionActionString(deliveryTarget, "action_kind") ?? "custom_instruction"
  };
}

function resourceTranslationDeliveryTarget(deliveryTarget: Record<string, JsonValue>): {
  source_ref: ResourceRef;
  source_locale?: SupportedLocale;
  target_locale: SupportedLocale;
  original_hash?: string;
} | undefined {
  if (collectionActionString(deliveryTarget, "channel") !== "resource_translation") {
    return undefined;
  }
  const sourceRef = resourceRefFromJson(deliveryTarget.source_ref);
  const targetLocale = localeFromJson(deliveryTarget.target_locale);
  if (!sourceRef || !targetLocale) {
    return undefined;
  }
  return {
    source_ref: sourceRef,
    source_locale: localeFromJson(deliveryTarget.source_locale),
    target_locale: targetLocale,
    original_hash: collectionActionString(deliveryTarget, "original_hash")
  };
}

function translatableResource(ref: ResourceRef, sourceLocale: SupportedLocale, content: string): {
  ref: ResourceRef;
  source_locale: SupportedLocale;
  content: string;
  original_hash: string;
} {
  return {
    ref,
    source_locale: sourceLocale,
    content,
    original_hash: stableHash(content)
  };
}

function resourceTranslationRef(translation: Pick<ResourceTranslationRecord, "id" | "source_ref" | "target_locale">): ResourceRef {
  return {
    kind: "resource_translation",
    id: translation.id,
    uri: `resource-translations/${translation.id}`,
    label: `${translation.source_ref.kind}/${translation.source_ref.id} -> ${translation.target_locale}`
  };
}

function resourceRefFromJson(value: JsonValue | undefined): ResourceRef | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  const uri = typeof value.uri === "string" ? value.uri : undefined;
  if (!kind || !id || !uri) {
    return undefined;
  }
  return {
    kind,
    id,
    uri,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {})
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

function localeFromJson(value: JsonValue | undefined): SupportedLocale | undefined {
  return typeof value === "string" && ["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"].includes(value)
    ? value as SupportedLocale
    : undefined;
}

function fileRef(relativePath: string) {
  return {
    kind: "file",
    id: stableHash(relativePath),
    uri: relativePath,
    label: relativePath
  };
}

function externalSendRef(send: ExternalSendRecord) {
  return {
    kind: "external_send",
    id: send.id,
    uri: `external-sends/${send.id}`,
    label: send.title
  };
}

function grantRef(grant: Pick<GrantRecord, "id" | "capability_id" | "operation" | "resource_scope">): ResourceRef {
  return {
    kind: "grant",
    id: grant.id,
    uri: `grants/${grant.id}`,
    label: `${grant.capability_id}/${grant.operation}:${grant.resource_scope}`
  };
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
  const playwrightPage = await readBrowserPageWithPlaywright(url).catch(() => undefined);
  if (playwrightPage) {
    return playwrightPage;
  }
  const response = await fetch(url);
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
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
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

function renderBrowserSnapshotHtml(page: { url: string; title?: string; html: string; text: string; adapter: string }): string {
  return [
    "<!doctype html>",
    "<meta charset=\"utf-8\">",
    `<title>${escapeHtml(page.title || page.url)}</title>`,
    `<meta name=\"samurai-source-url\" content=\"${escapeHtml(page.url)}\">`,
    `<meta name=\"samurai-browser-adapter\" content=\"${escapeHtml(page.adapter)}\">`,
    page.html || `<pre>${escapeHtml(page.text)}</pre>`,
    ""
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

async function listWorkspaceDirectory(absolutePath: string, relativePath: string) {
  const entries = await readdir(absolutePath, { withFileTypes: true });
  return Promise.all(
    entries.map(async (entry) => {
      const childRelativePath = path.posix.join(relativePath.replaceAll(path.sep, "/"), entry.name).replace(/^\/+/, "");
      const childAbsolutePath = path.join(absolutePath, entry.name);
      const info = await stat(childAbsolutePath);
      return {
        path: childRelativePath,
        kind: entry.isDirectory() ? "directory" as const : "file" as const,
        ...(entry.isFile() ? { size: info.size } : {})
      };
    })
  );
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
  return new Date(fromMs + 24 * 60 * 60 * 1000).toISOString();
}

function isOneShotSchedule(schedule: string): boolean {
  return ["once", "one-shot", "oneshot"].includes(schedule.trim().toLowerCase());
}

function nextRetryAt(failureCount: number): string {
  const clamped = Math.max(1, Math.min(failureCount, 6));
  return new Date(Date.now() + 5 * 60 * 1000 * clamped).toISOString();
}

type ExternalSendDispatchAdapterResult = { dispatched: boolean; adapter: string; transport?: string; status?: number; dry_run: boolean; message: string };

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

function externalSendStatusFromDispatchResult(result: ExternalSendDispatchAdapterResult): ExternalSendRecord["status"] {
  if (result.dispatched) {
    return "dispatched";
  }
  return result.dry_run ? "approved" : "failed";
}

function externalSendDispatchSummary(send: ExternalSendRecord, result: ExternalSendDispatchAdapterResult): string {
  if (result.dispatched) {
    return `Dispatched external send ${send.title}.`;
  }
  if (result.dry_run) {
    return `Prepared external send ${send.title}; dispatch dry-run recorded.`;
  }
  return `External send ${send.title} dispatch failed.`;
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
      body: send.body
    });
    return {
      dispatched: true,
      adapter: "email",
      transport: "smtp",
      dry_run: false,
      message: "email smtp dispatched."
    };
  } catch (error) {
    return externalSendFailureResult("email", "smtp", error);
  }
}

async function sendSmtpMessage(config: SmtpTransportConfig, message: { from: string; to: string[]; subject: string; body: string }): Promise<void> {
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

function formatSmtpMessage(message: { from: string; to: string[]; subject: string; body: string }): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to.join(", ")}`,
    `Subject: ${smtpHeaderValue(message.subject)}`,
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify(send.channel === "slack" ? { text: `*${send.title}*\n${send.body}` } : { title: send.title, body: send.body })
    });
    return {
      dispatched: response.ok,
      adapter: send.channel,
      transport: "http",
      status: response.status,
      dry_run: false,
      message: response.ok ? `${send.channel} dispatched.` : `${send.channel} dispatch failed.`
    };
  } catch (error) {
    return {
      dispatched: false,
      adapter: send.channel,
      transport: "http",
      dry_run: false,
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
        "content-type": "application/json"
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
      headers: { "content-type": "application/json" },
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
        "content-type": "application/json"
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
    message: "Dry run recorded. Set SAMURAI_EXTERNAL_SEND_DISPATCH=true to enable dispatch."
  };
}

function externalSendFailureResult(adapter: string, transport: string, error: unknown): ExternalSendDispatchAdapterResult {
  return {
    dispatched: false,
    adapter,
    transport,
    dry_run: false,
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
