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
  OperationRecord,
  PolicyDecisionRecord,
  RollbackPoint,
  SessionRecord,
  SettingsRecord,
  SurfaceRendererRegistryEntry,
  SupportedLocale,
  ResourceRef,
  WikiFrontmatter,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import type {
  SurfaceOperation,
  SurfaceOperationResultEnvelope,
  SurfaceRenderKind,
  SurfaceRendererCapabilities
} from "@samurai-agent/ui-protocol";

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
  status: "started" | "completed" | "failed";
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
  workspaceId: string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspaceConnectionState {
  activeConnectionId?: string;
  connections: DesktopWorkspaceConnection[];
}

export interface DesktopWorkspaceServerStatus {
  connection?: DesktopWorkspaceConnection;
  identityAvailable: boolean;
  health?: { status: number; body: unknown };
  workspace?: { status: number; body: unknown };
  rooms?: { status: number; body: unknown };
}

declare global {
  interface Window {
    samuraiDesktop?: {
      apiBaseUrl?: string;
      workspaceServerUrl?: string;
      workspaceId?: string;
      accountId?: string;
      listWorkspaceConnections?: () => Promise<DesktopWorkspaceConnectionState>;
      upsertWorkspaceConnection?: (input: {
        label: string;
        serverUrl: string;
        workspaceId: string;
        accountId: string;
        privateKey?: string;
      }) => Promise<DesktopWorkspaceConnectionState>;
      selectWorkspaceConnection?: (connectionId: string) => Promise<DesktopWorkspaceConnectionState>;
      registerWorkspaceServerAccount?: (displayName?: string) => Promise<unknown>;
      getWorkspaceServerStatus?: () => Promise<DesktopWorkspaceServerStatus>;
    };
  }
}

export function getApiBaseUrl(): string | undefined {
  const value = typeof window === "undefined" ? undefined : window.samuraiDesktop?.apiBaseUrl;
  return value ? value.replace(/\/$/, "") : undefined;
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
  createSession(input: Partial<Pick<SessionRecord, "title" | "ui_locale" | "output_locale">> = {}) {
    return request<SessionRecord>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  listSessions() {
    return request<SessionRecord[]>("/api/chat/sessions");
  },
  getSession(sessionId: string) {
    return request<SessionDetail>(`/api/chat/sessions/${sessionId}`);
  },
  listAgentBackends() {
    return request<AgentBackendStatus[]>("/api/agent-backends");
  },
  getSurfaceContract(source?: DomainCommandInputSource) {
    return request<SurfaceContractPayload>(source ? `/api/surface/contract?source=${encodeURIComponent(source)}` : "/api/surface/contract");
  },
  runDomainCommand<T = unknown>(commandId: string, payload: Record<string, JsonValue>, idempotencyKey = createIdempotencyKey()) {
    return request<{ command: SurfaceCommandEntry; result: T; render_spec?: unknown; render_specs?: unknown[] }>(`/api/domain/commands/${encodeURIComponent(commandId)}/run`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ payload })
    });
  },
  getGeneratedSurface(surfaceId: string) {
    return request<GeneratedSurfaceDetail>(`/api/generated-surfaces/${encodeURIComponent(surfaceId)}`);
  },
  runGeneratedSurfaceAction(surfaceId: string, actionId: string, payload: { revision_id?: string; interaction_id?: string; message_id?: string; action_payload?: Record<string, JsonValue> }) {
    return request(`/api/generated-surfaces/${encodeURIComponent(surfaceId)}/actions/${encodeURIComponent(actionId)}/run`, {
      method: "POST",
      body: JSON.stringify({ payload })
    });
  },
  getGeneratedSurfaceBundle(surfaceId: string, revisionId: string) {
    return request<{ revision: GeneratedSurfaceRevisionRecord; bundle: { html: string; css?: string; script?: string }; csp: string }>(`/api/generated-surfaces/${encodeURIComponent(surfaceId)}/revisions/${encodeURIComponent(revisionId)}/bundle`);
  },
  listSkillOptimizationRuns(skillId?: string) {
    return request<SkillOptimizationRun[]>(skillId ? `/api/skill-optimizations?skill_id=${encodeURIComponent(skillId)}` : "/api/skill-optimizations");
  },
  getSkillOptimization(runId: string) {
    return request<SkillOptimizationDetail>(`/api/skill-optimizations/${encodeURIComponent(runId)}`);
  },
  runSurfaceOperation<T>(operation: SurfaceOperation) {
    return request<SurfaceOperationResultEnvelope<T>>("/api/surface/operations", {
      method: "POST",
      body: JSON.stringify(operation)
    });
  },
  updateMessagePresentationViewState(presentationId: string, viewState: Record<string, JsonValue>) {
    return request<SurfaceOperationResultEnvelope<MessagePresentationRecord>>("/api/surface/operations", {
      method: "POST",
      body: JSON.stringify({
        id: `surface_presentation_state_${presentationId}_${Date.now()}`,
        kind: "message.presentation.update",
        presentation_id: presentationId,
        view_state: viewState
      })
    });
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
    return request<ChatSurfaceOperationResult>("/api/surface/operations", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        id: input.idempotencyKey,
        kind: "message.submit",
        session_id: input.sessionId,
        content: input.content,
        input_locale: input.inputLocale,
        output_locale: input.outputLocale,
        renderer_capabilities: input.rendererCapabilities,
        metadata: input.metadata,
        attachments: input.attachments ?? [],
        ...(input.backendId ? { backend_id: input.backendId } : {})
      })
    });
  },
  sendMessage(sessionId: string, content: string, outputLocale: SupportedLocale, idempotencyKey: string, backendId?: string) {
    return request<ChatTurnResult>(`/api/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        content,
        output_locale: outputLocale,
        ...(backendId ? { backend_id: backendId } : {})
      })
    });
  },
  startChat(content: string, uiLocale: SupportedLocale, outputLocale: SupportedLocale, idempotencyKey: string, backendId?: string) {
    return request<ChatTurnResult>("/api/chat/messages", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        content,
        ui_locale: uiLocale,
        output_locale: outputLocale,
        ...(backendId ? { backend_id: backendId } : {})
      })
    });
  },
  search(query: string) {
    return request<SearchResult[]>(`/api/search?q=${encodeURIComponent(query)}`);
  },
  getArtifact(id: string) {
    return request<ArtifactDetail>(`/api/artifacts/${id}`);
  },
  getAudit() {
    return request<AuditPayload>("/api/audit");
  },
  getActivity() {
    return request<ActivityInboxItem[]>("/api/activity");
  },
  listBackendRuns(sessionId?: string) {
    return request<BackendRunRecord[]>(sessionId ? `/api/backend-runs?session_id=${encodeURIComponent(sessionId)}` : "/api/backend-runs");
  },
  getBackendRun(runId: string) {
    return request<BackendRunRecord>(`/api/backend-runs/${encodeURIComponent(runId)}`);
  },
  listBackendEvents(runId: string) {
    return request<BackendEventRecord[]>(`/api/backend-runs/${runId}/events`);
  },
  listWorkspaceChanges(sessionId?: string) {
    return request<WorkspaceChangeRecord[]>(sessionId ? `/api/workspace-changes?session_id=${encodeURIComponent(sessionId)}` : "/api/workspace-changes");
  },
  listMemory() {
    return request<Array<MemoryFrontmatter & { file_path: string }>>("/api/memory");
  },
  getMemory(id: string) {
    return request<MemoryDetail>(`/api/memory/${id}`);
  },
  archiveMemory(id: string, sessionId: string) {
    return request<ArchiveMemoryPayload>(`/api/memory/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId })
    });
  },
  listSkills() {
    return request<SkillIndexEntry[]>("/api/skills");
  },
  getSkill(id: string) {
    return request<{ skill: SkillIndexEntry; markdown: string }>(`/api/skills/${id}`);
  },
  patchSkill(id: string, input: { title?: string; description?: string; content?: string; tags?: string[] }) {
    return request<RuntimeWritePayload<SkillIndexEntry>>(`/api/skills/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  setSkillActive(id: string, active: boolean) {
    return request<RuntimeWritePayload<SkillIndexEntry>>(`/api/skills/${id}/state`, { method: "POST", body: JSON.stringify({ state: active ? "active" : "disabled" }) });
  },
  listWiki() {
    return request<Array<WikiFrontmatter & { file_path: string }>>("/api/wiki");
  },
  getWiki(id: string) {
    return request<WikiDetail>(`/api/wiki/${id}`);
  },
  createWikiProposal(input: { title: string; content: string; slug?: string; tags?: string[]; content_locale?: SupportedLocale }) {
    return request<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>("/api/wiki/proposals", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  acceptWiki(id: string) {
    return request<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>(`/api/wiki/${id}/accept`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  rejectWiki(id: string) {
    return request<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>(`/api/wiki/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  patchWiki(id: string, input: Partial<Pick<WikiFrontmatter, "title" | "tags" | "content_locale">> & { content?: string }) {
    return request<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>(`/api/wiki/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },
  archiveWiki(id: string) {
    return request<RuntimeWritePayload<WikiFrontmatter & { file_path: string }>>(`/api/wiki/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  reindexWiki() {
    return request<RuntimeWritePayload<{ active: number; total: number }>>("/api/wiki/reindex", {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  getWikiGraph(query?: string) {
    return request<Record<string, unknown>>(`/api/wiki/graph${query ? `?query=${encodeURIComponent(query)}` : ""}`);
  },
  getWikiDiagnostics() {
    return request<Record<string, unknown>>("/api/wiki/lint");
  },
  getWikiBacklinks(id: string) {
    return request<Array<{ from_wiki_id: string; label: string }>>(`/api/wiki/${id}/backlinks`);
  },
  createSkillCandidate(input: { title: string; description: string; content?: string; tags?: string[]; required_capabilities?: string[] }) {
    return request<RuntimeWritePayload<SkillIndexEntry>>("/api/skills/candidates", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  saveSkillProject(candidateId: string) {
    return request<RuntimeWritePayload<SkillIndexEntry>>("/api/skills/projects", {
      method: "POST",
      body: JSON.stringify({ candidate_id: candidateId })
    });
  },
  saveCollectionSchema(schema: CollectionSchema) {
    return request<RuntimeWritePayload<CollectionSchema & { file_path: string }>>("/api/collections/schemas", {
      method: "POST",
      body: JSON.stringify(schema)
    });
  },
  listCollectionSchemas() {
    return request<Array<CollectionSchema & { file_path: string }>>("/api/collections/schemas");
  },
  getCollectionSchema(collectionId: string) {
    return request<CollectionSchema & { file_path: string }>(`/api/collections/${collectionId}/schema`);
  },
  createCollectionRecord(collectionId: string, input: Partial<CollectionRecord> & { data: CollectionRecord["data"] }) {
    return request<RuntimeWritePayload<CollectionRecord & { file_path: string }>>(`/api/collections/${collectionId}/records`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  listCollectionRecords(collectionId: string) {
    return request<Array<CollectionRecord & { file_path: string }>>(`/api/collections/${collectionId}/records`);
  },
  applyCollectionPatch(collectionId: string, recordId: string, input: { id?: string; changes: Record<string, unknown>; created_at?: string }) {
    return request<RuntimeWritePayload<CollectionRecord & { file_path: string }>>(
      `/api/collections/${collectionId}/records/${recordId}/patches`,
      {
        method: "POST",
        body: JSON.stringify(input)
      }
    );
  },
  deleteCollectionRecord(collectionId: string, recordId: string) {
    return request<CollectionRecord & { file_path: string }>(`/api/collections/${collectionId}/records/${recordId}`, {
      method: "DELETE"
    });
  },
  listCollectionNotes(collectionId: string) {
    return request<Array<{ file_path: string; content: string }>>(`/api/collections/${collectionId}/notes`);
  },
  runMemoryReviewAutomation() {
    return request<AutomationRunPayload>("/api/automation/memory-review/run", {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  listAutomationJobs() {
    return request<AutomationJobRecord[]>("/api/automation/jobs");
  },
  listAutomationRuns() {
    return request<AutomationRunSummary[]>("/api/automation/runs");
  },
  setAutomationStatus(id: string, status: "enabled" | "disabled") {
    return request<RuntimeWritePayload<AutomationJobRecord>>(`/api/automation/jobs/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
  },
  getSettings() {
    return request<SettingsRecord>("/api/settings");
  },
  patchSettings(patch: Partial<Omit<SettingsRecord, "updated_at">>) {
    return request<SettingsRecord>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  },
  approveApprovalRequest(id: string) {
    return request<ApprovalLifecyclePayload>(`/api/approval-requests/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  denyApprovalRequest(id: string, reason = "Denied by owner.") {
    return request<ApprovalLifecyclePayload>(`/api/approval-requests/${id}/deny`, {
      method: "POST",
      body: JSON.stringify({ reason })
    });
  },
  restoreRollbackPoint(id: string) {
    return request<unknown>(`/api/rollback/${id}/restore`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }
};

async function readJson(response: Response): Promise<unknown> {
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
