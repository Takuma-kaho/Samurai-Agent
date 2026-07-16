import {
  supportedLocales,
  type ActivityInboxItem, type ApprovalRequest, type ArtifactRecord, type AuditRecord,
  type BackendEventRecord, type BackendRunRecord, type JsonValue, type MemoryFrontmatter,
  type MessagePresentationRecord, type MessageRecord, type OperationRecord, type PolicyDecisionRecord,
  type ReflectionRunRecord, type ReflectionSuggestionRecord, type ResourceRef, type RollbackPoint,
  type SessionRecord, type SupportedLocale, type ToolRunRecord, type WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";

interface SessionCreateInput { title?: string; ui_locale?: SupportedLocale; output_locale?: SupportedLocale }
export interface ChatTurnInput {
  sessionId: string; content: string; backend_id?: string; input_locale?: SupportedLocale; output_locale?: SupportedLocale;
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
  createSession(input: SessionCreateInput): Promise<SessionRecord>;
  runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult>;
  reindexSessionSearch(): Promise<{ mode: "fts5_trigram" | "fts5" | "like"; indexed: number }>;
  conflict(message: string): Error;
}

export class ConversationDomainService {
  constructor(private readonly host: ConversationHostPort) {}

  createChatSession(input: SessionCreateInput) { return this.host.createSession(input); }
  executeChatTurn(input: ChatTurnInput) { return this.host.runChatTurn(input); }

  createSession(payload: Record<string, JsonValue>) {
    return this.host.createSession({
      title: optionalString(payload.title),
      ui_locale: locale(payload.ui_locale),
      output_locale: locale(payload.output_locale)
    });
  }

  reindexSearch() { return this.host.reindexSessionSearch(); }
}
function optionalString(value: JsonValue | undefined): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function locale(value: JsonValue | undefined): SupportedLocale | undefined { return typeof value === "string" && supportedLocales.includes(value as SupportedLocale) ? value as SupportedLocale : undefined; }
