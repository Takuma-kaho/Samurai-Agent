import {
  type ActivityInboxItem, type ApprovalRequest, type ArtifactRecord, type AuditRecord,
  type BackendEventRecord, type BackendRunRecord, type JsonValue, type MemoryFrontmatter,
  type MessagePresentationRecord, type MessageRecord, type OperationRecord, type PolicyDecisionRecord,
  type ReflectionRunRecord, type ReflectionSuggestionRecord, type ResourceRef, type RollbackPoint,
  type SessionRecord, type SupportedLocale, type ToolRunRecord, type WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";

interface SessionCreateHostInput { title?: string; ui_locale?: SupportedLocale; output_locale?: SupportedLocale }
export interface CreateSessionInput { title?: string; uiLocale?: SupportedLocale; outputLocale?: SupportedLocale }
export interface ChatTurnInput {
  sessionId: string; content: string; idempotencyKey: string; backend_id?: string; input_locale?: SupportedLocale; output_locale?: SupportedLocale;
  attachments: ResourceRef[]; temporary_context: TemporaryContextInput[]; metadata: Record<string, JsonValue>;
}
interface TemporaryContextInput { id: string; kind: "desktop_screenshot"; label?: string; source_name?: string; mime_type: string; data_url?: string; file_path?: string; created_at: string; expires_at: string; metadata?: Record<string, JsonValue> }

export interface ChatTurnResult {
  session: SessionRecord; messages: MessageRecord[]; messagePresentations: MessagePresentationRecord[];
  backendRun: BackendRunRecord; backendEvents: BackendEventRecord[]; workspaceChanges: WorkspaceChangeRecord[];
  operations: OperationRecord[]; policyDecisions: PolicyDecisionRecord[]; artifacts: ArtifactRecord[];
  memories: MemoryFrontmatter[]; approvalRequests: ApprovalRequest[]; auditRecords: AuditRecord[];
  rollbackPoints: RollbackPoint[]; activity: ActivityInboxItem[]; reflectionRuns: ReflectionRunRecord[];
  reflectionSuggestions: ReflectionSuggestionRecord[]; toolRuns: ToolRunRecord[];
}

export interface ConversationHostPort {
  createSession(input: SessionCreateHostInput): Promise<SessionRecord>;
  runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult>;
  reindexSessionSearch(): Promise<{ mode: "fts5_trigram" | "fts5" | "like"; indexed: number }>;
  conflict(message: string): Error;
}

export class ConversationDomainService {
  constructor(private readonly host: ConversationHostPort) {}

  createChatSession(input: SessionCreateHostInput) { return this.host.createSession(input); }
  executeChatTurn(input: ChatTurnInput) { return this.host.runChatTurn(input); }

  createSession(input: CreateSessionInput) {
    return this.host.createSession({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.uiLocale === undefined ? {} : { ui_locale: input.uiLocale }),
      ...(input.outputLocale === undefined ? {} : { output_locale: input.outputLocale })
    });
  }

  reindexSearch() { return this.host.reindexSessionSearch(); }
}
