import type {
  ActivityInboxItem,
  ApprovalRequest,
  ArtifactRecord,
  AuditRecord,
  BackendEventRecord,
  BackendRunRecord,
  CollectionRecord,
  CollectionSchema,
  MemoryFrontmatter,
  MessageRecord,
  OperationRecord,
  PolicyDecisionRecord,
  RollbackPoint,
  SessionRecord,
  SettingsRecord,
  SupportedLocale,
  WikiFrontmatter,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";

export interface SessionDetail {
  session: SessionRecord;
  messages: MessageRecord[];
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

export interface AgentBackendStatus {
  id: string;
  kind: "mock" | "samurai_native" | "claude_code" | "codex" | "external";
  label: string;
  configured: boolean;
  reason?: string;
}

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
  workspaceDataDir?: string;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  const body = await readJson(response);

  if (!response.ok) {
    throw new ApiError(response.status, response.statusText, body);
  }
  return body as T;
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
  sendMessage(sessionId: string, content: string, outputLocale: SupportedLocale, backendId?: string) {
    return request<ChatTurnResult>(`/api/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        output_locale: outputLocale,
        ...(backendId ? { backend_id: backendId } : {})
      })
    });
  },
  startChat(content: string, uiLocale: SupportedLocale, outputLocale: SupportedLocale, backendId?: string) {
    return request<ChatTurnResult>("/api/chat/messages", {
      method: "POST",
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
  getCollectionSchema(collectionId: string) {
    return request<CollectionSchema & { file_path: string }>(`/api/collections/${collectionId}/schema`);
  },
  createCollectionRecord(collectionId: string, input: Partial<CollectionRecord> & { data: CollectionRecord["data"] }) {
    return request<RuntimeWritePayload<CollectionRecord & { file_path: string }>>(`/api/collections/${collectionId}/records`, {
      method: "POST",
      body: JSON.stringify(input)
    });
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
  listCollectionNotes(collectionId: string) {
    return request<Array<{ file_path: string; content: string }>>(`/api/collections/${collectionId}/notes`);
  },
  runMemoryReviewAutomation() {
    return request<AutomationRunPayload>("/api/automation/memory-review/run", {
      method: "POST",
      body: JSON.stringify({})
    });
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
