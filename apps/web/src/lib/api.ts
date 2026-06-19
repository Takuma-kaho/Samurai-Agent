import type {
  ActivityInboxItem,
  ApprovalRequest,
  ArtifactRecord,
  AuditRecord,
  MemoryFrontmatter,
  MessageRecord,
  OperationRecord,
  PolicyDecisionRecord,
  RollbackPoint,
  SessionRecord,
  SettingsRecord,
  SupportedLocale
} from "@samurai-agent/core-schemas";

export interface SessionDetail {
  session: SessionRecord;
  messages: MessageRecord[];
  operations: OperationRecord[];
  artifacts: ArtifactRecord[];
  auditRecords: AuditRecord[];
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

export interface ChatTurnResult {
  session: SessionRecord;
  messages: MessageRecord[];
  operations: OperationRecord[];
  policyDecisions: PolicyDecisionRecord[];
  artifacts: ArtifactRecord[];
  memories: MemoryFrontmatter[];
  approvalRequests: ApprovalRequest[];
  auditRecords: AuditRecord[];
  rollbackPoints: RollbackPoint[];
  activity: ActivityInboxItem[];
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
  sendMessage(sessionId: string, content: string, outputLocale: SupportedLocale) {
    return request<ChatTurnResult>(`/api/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        output_locale: outputLocale
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
  getSettings() {
    return request<SettingsRecord>("/api/settings");
  },
  patchSettings(patch: Partial<Pick<SettingsRecord, "theme" | "ui_locale" | "output_locale">>) {
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
