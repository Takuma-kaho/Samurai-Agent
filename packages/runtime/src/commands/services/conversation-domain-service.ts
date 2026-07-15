import {
  supportedLocales,
  type ActivityInboxItem, type ApprovalRequest, type ArtifactRecord, type AuditRecord,
  type BackendEventRecord, type BackendRunRecord, type JsonValue, type MemoryFrontmatter,
  type MessagePresentationRecord, type MessageRecord, type OperationRecord, type PolicyDecisionRecord,
  type ReflectionRunRecord, type ReflectionSuggestionRecord, type ResourceRef, type RollbackPoint,
  type SessionRecord, type SupportedLocale, type ToolRunRecord, type WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";

interface SessionCreateInput { title?: string; ui_locale?: SupportedLocale; output_locale?: SupportedLocale }
interface ChatTurnInput {
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

  createSession(payload: Record<string, JsonValue>) {
    return this.host.createSession({
      title: optionalString(payload.title),
      ui_locale: locale(payload.ui_locale),
      output_locale: locale(payload.output_locale)
    });
  }

  async runTurn(payload: Record<string, JsonValue>) {
    const sessionId = optionalString(payload.session_id) || (await this.createSession(payload)).id;
    const content = optionalString(payload.content) || optionalString(payload.user_intent) || optionalString(payload.target_instruction);
    if (!content) throw this.host.conflict("domain_command_chat_content_required");
    return this.host.runChatTurn({
      sessionId, content, backend_id: optionalString(payload.backend_id), input_locale: locale(payload.input_locale),
      output_locale: locale(payload.output_locale), attachments: resourceRefs(payload.attachments),
      temporary_context: temporaryContexts(payload.temporary_context), metadata: recordValue(payload.metadata)
    });
  }

  reindexSearch() { return this.host.reindexSessionSearch(); }
}
function recordValue(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function temporaryContexts(value: JsonValue | undefined): TemporaryContextInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.kind !== "desktop_screenshot") return [];
    const id = optionalString(item.id), mime_type = optionalString(item.mime_type), created_at = optionalString(item.created_at), expires_at = optionalString(item.expires_at);
    if (!id || !mime_type || !created_at || !expires_at) return [];
    return [{ id, kind: "desktop_screenshot" as const, mime_type, created_at, expires_at, label: optionalString(item.label), source_name: optionalString(item.source_name), data_url: optionalString(item.data_url), file_path: optionalString(item.file_path), metadata: item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata as Record<string, JsonValue> : undefined }];
  });
}

function optionalString(value: JsonValue | undefined): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function locale(value: JsonValue | undefined): SupportedLocale | undefined { return typeof value === "string" && supportedLocales.includes(value as SupportedLocale) ? value as SupportedLocale : undefined; }
function resourceRefs(value: JsonValue | undefined): ResourceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const kind = typeof item.kind === "string" ? item.kind : ""; const id = typeof item.id === "string" ? item.id : ""; const uri = typeof item.uri === "string" ? item.uri : "";
    return kind && id && uri ? [{ kind, id, uri, ...(typeof item.label === "string" ? { label: item.label } : {}) }] : [];
  });
}
