import {
  PublicAccountInvitationNotificationsPageSchema,
  PublicAccountWorkspaceNotificationSummariesSchema,
  PublicCompletionResourceBodySchema,
  PublicCompletionResourceDetailSchema,
  PublicCompletionResourceMutationResponseSchema,
  PublicCompletionResourcePageSchema,
  PublicNotificationMarkReadResultSchema,
  PublicNotificationPageSchema,
  PublicNotificationSchema,
  PublicNotificationSummarySchema,
  PublicShareDelegationSchema,
  PublicShareDraftCreateInputSchema,
  PublicShareDraftDiscardInputSchema,
  PublicShareDraftDiscardResultSchema,
  PublicShareDraftSchema,
  PublicShareDraftUpdateInputSchema,
  PublicShareDraftViewInputSchema,
  PublicShareImportInputSchema,
  PublicShareImportResultSchema,
  PublicShareImportStatusInputSchema,
  PublicShareListInputSchema,
  PublicShareManifestSchema,
  PublicShareLocatorSchema,
  PublicShareOriginSchema,
  PublicSharePageSchema,
  PublicSharePublishInputSchema,
  PublicSharePublishResultSchema,
  PublicShareRevokeInputSchema,
  PublicShareRevokeResultSchema,
  PublicShareVisibilitySchema,
  PublicSearchItemSchema,
  PublicTargetSchema,
  PublicWorkspaceSearchPageSchema,
  type PublicSearchItem,
  type PublicShareDraftCreateInput,
  type PublicShareDraftDiscardInput,
  type PublicShareDraftUpdateInput,
  type PublicShareImportInput,
  type PublicShareImportStatusInput,
  type PublicShareListInput,
  type PublicSharePublishInput,
  type PublicShareRevokeInput,
  type PublicTarget
} from "@samurai-agent/domain-api";

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const shareLocatorPattern = /^[A-Za-z0-9_-]{43}$/;
const allowedWorkspaceSearchTypes = ["room", "conversation", "knowledge"] as const;
const supportedPersonalPreferenceLocales = ["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"] as const;
type PersonalPreferenceLocale = (typeof supportedPersonalPreferenceLocales)[number];
const completionResourceKinds = ["knowledge", "skill"] as const;
type CompletionResourceKind = (typeof completionResourceKinds)[number];
const completionKnowledgeKinds = ["fact", "decision", "explanation", "experience_rule"] as const;
type CompletionKnowledgeKind = (typeof completionKnowledgeKinds)[number];
type WorkspaceSearchType = (typeof allowedWorkspaceSearchTypes)[number];

export interface WorkspaceContextTargetRequest {
  connectionId: string;
  workspaceId: string;
  roomId?: string;
  selectionGeneration?: number;
}

export type WorkspaceContextTarget =
  | { kind: "room"; roomId: string }
  | { kind: "work"; roomId: string; workId: string; messageId?: string }
  | { kind: "knowledge"; roomId: string; resourceId: string }
  | { kind: "interaction_request"; roomId: string; requestId: string }
  | { kind: "invitation"; invitationId: string };

export interface WorkspaceContextSearchRequest {
  target?: WorkspaceContextTargetRequest;
  body: {
    q: string;
    types?: WorkspaceSearchType[];
    room_id?: string;
    limit?: number;
    cursor?: string;
  };
}

export interface WorkspaceNotificationListRequest {
  target?: WorkspaceContextTargetRequest;
  body: { unread_only?: boolean; limit?: number; cursor?: string };
}

export interface WorkspaceNotificationSummaryRequest {
  target?: WorkspaceContextTargetRequest;
}

export interface WorkspaceChatPersonalPreferences {
  schema_version: 1;
  revision: number;
  display_name: string;
  output_locale: PersonalPreferenceLocale | null;
  instructions: string;
}

export interface WorkspaceNotificationReadRequest {
  target?: WorkspaceContextTargetRequest;
  notificationIds: string[];
  operationId: string;
  body: { notification_ids: string[] };
}

export interface AccountWorkspaceNotificationSummaryRequest {
  target?: WorkspaceContextTargetRequest;
  workspaceIds: string[];
  body: { workspace_ids: string[] };
}

export interface AccountInvitationNotificationListRequest {
  target?: WorkspaceContextTargetRequest;
  body: { limit?: number; cursor?: string };
}

export interface AccountInvitationNotificationReadRequest {
  target?: WorkspaceContextTargetRequest;
  notificationIds: string[];
  operationId: string;
  body: { notification_ids: string[] };
}

/**
 * Sanitize the optional private preference snapshot carried by the chat turn
 * request. It is intentionally separate from the general chat request parser
 * so no other IPC/API operation can accidentally accept this value.
 */
export function workspaceChatPersonalPreferencesRequest(input: unknown): WorkspaceChatPersonalPreferences | undefined {
  const value = strictRecord(input, "personal_preferences_invalid");
  if (Object.prototype.hasOwnProperty.call(value, "personal_preferences")) throw new Error("personal_preferences_invalid");
  if (!Object.prototype.hasOwnProperty.call(value, "personalPreferences")) return undefined;
  const candidate = strictRecord(value.personalPreferences, "personal_preferences_invalid");
  assertAllowedKeys(candidate, ["schema_version", "revision", "display_name", "output_locale", "instructions"], "personal_preferences_invalid");
  if (candidate.schema_version !== 1
    || typeof candidate.revision !== "number"
    || !Number.isSafeInteger(candidate.revision)
    || candidate.revision < 0
    || typeof candidate.display_name !== "string"
    || typeof candidate.instructions !== "string") {
    throw new Error("personal_preferences_invalid");
  }
  const displayName = candidate.display_name.trim();
  if (!displayName || displayName.length > 200 || candidate.instructions.length > 20_000) {
    throw new Error("personal_preferences_invalid");
  }
  const outputLocale = candidate.output_locale;
  if (outputLocale !== null
    && (typeof outputLocale !== "string" || !(supportedPersonalPreferenceLocales as readonly string[]).includes(outputLocale))) {
    throw new Error("personal_preferences_invalid");
  }
  return {
    schema_version: 1,
    revision: candidate.revision,
    display_name: displayName,
    output_locale: outputLocale as PersonalPreferenceLocale | null,
    instructions: candidate.instructions
  };
}

export interface WorkspaceAgentCompletionResourceListRequest {
  scopeKind: "agent";
  agentId: string;
  kind?: CompletionResourceKind;
  includeArchived?: boolean;
  cursor?: string;
  target?: WorkspaceContextTargetRequest;
}

export interface WorkspaceAgentCompletionResourceIdRequest {
  scopeKind: "agent";
  agentId: string;
  resourceId: string;
  kind?: CompletionResourceKind;
  version?: number;
  target?: WorkspaceContextTargetRequest;
}

export interface WorkspaceAgentCompletionResourceWriteRequest {
  scopeKind: "agent";
  agentId: string;
  operationId: string;
  target?: WorkspaceContextTargetRequest;
  body: {
    scope_kind: "agent";
    agent_id: string;
    kind: CompletionResourceKind;
    knowledge_kind?: CompletionKnowledgeKind;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
    reason: string;
  };
}

export interface WorkspaceAgentCompletionResourceUpdateRequest extends WorkspaceAgentCompletionResourceWriteRequest {
  resourceId: string;
  body: WorkspaceAgentCompletionResourceWriteRequest["body"] & { expected_version: number };
}

export interface WorkspaceAgentCompletionResourceArchiveRequest {
  scopeKind: "agent";
  agentId: string;
  resourceId: string;
  operationId: string;
  target?: WorkspaceContextTargetRequest;
  body: {
    scope_kind: "agent";
    agent_id: string;
    archived: boolean;
    expected_version: number;
    reason: string;
  };
}

/**
 * Preload-facing strict sanitizer for the Agent completion resource family.
 * It is intentionally a closed union of fields used by the fixed IPC
 * methods; Workspace/Room fields never enter an Agent request.
 */
export function workspaceCompletionAgentInputRequest(input: unknown): Record<string, unknown> {
  const value = strictRecord(input, "completion_agent_input_invalid");
  assertAllowedKeys(value, [
    "scopeKind", "agentId", "roomId", "kind", "includeArchived", "cursor", "resourceId", "version",
    "title", "content", "metadata", "knowledgeKind", "reason", "expectedVersion", "operationId", "archived", "target"
  ], "completion_agent_input_invalid");
  if (value.scopeKind !== "agent") throw new Error("completion_agent_scope_invalid");
  const agentId = requiredId(value.agentId, "completion_agent_id_invalid");
  if (value.roomId !== undefined) throw new Error("completion_agent_scope_room_forbidden");
  const kind = value.kind === undefined ? undefined : completionKind(value.kind);
  const includeArchived = value.includeArchived === undefined
    ? undefined
    : typeof value.includeArchived === "boolean" ? value.includeArchived : (() => { throw new Error("completion_agent_include_archived_invalid"); })();
  const cursor = value.cursor === undefined ? undefined : requiredId(value.cursor, "completion_agent_cursor_invalid");
  const resourceId = value.resourceId === undefined ? undefined : requiredId(value.resourceId, "completion_agent_resource_id_invalid");
  const version = value.version === undefined ? undefined : requiredAgentNumberValue(value.version, "completion_agent_version_invalid");
  const title = value.title === undefined ? undefined : requiredText(value.title, "completion_agent_title_invalid", 200);
  const content = value.content === undefined ? undefined : requiredCompletionContent(value.content);
  const knowledgeKind = value.knowledgeKind === undefined ? undefined : completionKnowledgeKind(value.knowledgeKind);
  const metadata = value.metadata === undefined ? undefined : completionJsonObject(value.metadata, "completion_agent_metadata_invalid");
  const reason = value.reason === undefined ? undefined : requiredText(value.reason, "completion_agent_reason_invalid", 4_000);
  const expectedVersion = value.expectedVersion === undefined ? undefined : requiredAgentNumberValue(value.expectedVersion, "completion_agent_expected_version_invalid");
  const operationId = value.operationId === undefined ? undefined : requiredId(value.operationId, "completion_agent_operation_id_invalid");
  const archived = value.archived === undefined ? undefined : requiredAgentBooleanValue(value.archived, "completion_agent_archived_invalid");
  const target = sanitizeTarget(value.target);
  return {
    scopeKind: "agent",
    agentId,
    ...(kind === undefined ? {} : { kind }),
    ...(includeArchived === undefined ? {} : { includeArchived }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(version === undefined ? {} : { version }),
    ...(title === undefined ? {} : { title }),
    ...(content === undefined ? {} : { content }),
    ...(knowledgeKind === undefined ? {} : { knowledgeKind }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(reason === undefined ? {} : { reason }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(archived === undefined ? {} : { archived }),
    ...(target ? { target } : {})
  };
}

export type WorkspaceAgentCompletionOperation = "list" | "get" | "body" | "create" | "update" | "archive";

export function workspaceCompletionAgentInputForOperation(input: unknown, operation: WorkspaceAgentCompletionOperation): Record<string, unknown> {
  const keys = {
    list: ["scopeKind", "agentId", "kind", "includeArchived", "cursor", "target"],
    get: ["scopeKind", "agentId", "resourceId", "kind", "target"],
    body: ["scopeKind", "agentId", "resourceId", "kind", "version", "target"],
    create: ["scopeKind", "agentId", "kind", "knowledgeKind", "title", "content", "metadata", "reason", "operationId", "target"],
    update: ["scopeKind", "agentId", "resourceId", "kind", "knowledgeKind", "title", "content", "metadata", "reason", "expectedVersion", "operationId", "target"],
    archive: ["scopeKind", "agentId", "resourceId", "archived", "expectedVersion", "reason", "operationId", "target"]
  } satisfies Record<WorkspaceAgentCompletionOperation, readonly string[]>;
  assertAgentCompletionOperationKeys(input, keys[operation]);
  return workspaceCompletionAgentInputRequest(input);
}

export function workspaceAgentCompletionResourceListRequest(input: unknown): WorkspaceAgentCompletionResourceListRequest {
  assertAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "kind", "includeArchived", "cursor", "target"]);
  const value = workspaceCompletionAgentInputRequest(input);
  return {
    scopeKind: "agent",
    agentId: value.agentId as string,
    ...(value.kind === undefined ? {} : { kind: value.kind as CompletionResourceKind }),
    ...(value.includeArchived === undefined ? {} : { includeArchived: value.includeArchived as boolean }),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
    ...(value.target === undefined ? {} : { target: value.target as WorkspaceContextTargetRequest })
  };
}

export function workspaceAgentCompletionResourceIdRequest(input: unknown): WorkspaceAgentCompletionResourceIdRequest {
  assertAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "resourceId", "kind", "version", "target"]);
  const value = workspaceCompletionAgentInputRequest(input);
  return {
    scopeKind: "agent",
    agentId: value.agentId as string,
    resourceId: requiredAgentValue(value, "resourceId", "completion_agent_resource_id_invalid"),
    ...(value.kind === undefined ? {} : { kind: value.kind as CompletionResourceKind }),
    ...(value.version === undefined ? {} : { version: value.version as number }),
    ...(value.target === undefined ? {} : { target: value.target as WorkspaceContextTargetRequest })
  };
}

export function workspaceAgentCompletionResourceCreateRequest(input: unknown): WorkspaceAgentCompletionResourceWriteRequest {
  assertAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "kind", "knowledgeKind", "title", "content", "metadata", "reason", "operationId", "target"]);
  const value = workspaceCompletionAgentInputRequest(input);
  const kind = requiredAgentKind(value);
  const knowledgeKind = completionWriteKnowledgeKind(value, kind);
  return {
    scopeKind: "agent",
    agentId: value.agentId as string,
    operationId: requiredAgentValue(value, "operationId", "completion_agent_operation_id_invalid"),
    ...(value.target === undefined ? {} : { target: value.target as WorkspaceContextTargetRequest }),
    body: {
      scope_kind: "agent",
      agent_id: value.agentId as string,
      kind,
      ...(knowledgeKind === undefined ? {} : { knowledge_kind: knowledgeKind }),
      title: requiredAgentValue(value, "title", "completion_agent_title_invalid"),
      content: requiredAgentValue(value, "content", "completion_agent_content_invalid"),
      metadata: (value.metadata as Record<string, unknown> | undefined) ?? {},
      reason: requiredAgentValue(value, "reason", "completion_agent_reason_invalid")
    }
  };
}

export function workspaceAgentCompletionResourceUpdateRequest(input: unknown): WorkspaceAgentCompletionResourceUpdateRequest {
  assertAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "resourceId", "kind", "knowledgeKind", "title", "content", "metadata", "reason", "expectedVersion", "operationId", "target"]);
  const value = workspaceCompletionAgentInputRequest(input);
  const kind = requiredAgentKind(value);
  const knowledgeKind = completionWriteKnowledgeKind(value, kind);
  return {
    scopeKind: "agent",
    agentId: value.agentId as string,
    resourceId: requiredAgentValue(value, "resourceId", "completion_agent_resource_id_invalid"),
    operationId: requiredAgentValue(value, "operationId", "completion_agent_operation_id_invalid"),
    ...(value.target === undefined ? {} : { target: value.target as WorkspaceContextTargetRequest }),
    body: {
      scope_kind: "agent",
      agent_id: value.agentId as string,
      kind,
      ...(knowledgeKind === undefined ? {} : { knowledge_kind: knowledgeKind }),
      title: requiredAgentValue(value, "title", "completion_agent_title_invalid"),
      content: requiredAgentValue(value, "content", "completion_agent_content_invalid"),
      metadata: (value.metadata as Record<string, unknown> | undefined) ?? {},
      reason: requiredAgentValue(value, "reason", "completion_agent_reason_invalid"),
      expected_version: requiredAgentNumber(value, "expectedVersion", "completion_agent_expected_version_invalid")
    }
  };
}

export function workspaceAgentCompletionResourceArchiveRequest(input: unknown): WorkspaceAgentCompletionResourceArchiveRequest {
  assertAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "resourceId", "archived", "expectedVersion", "reason", "operationId", "target"]);
  const value = workspaceCompletionAgentInputRequest(input);
  return {
    scopeKind: "agent",
    agentId: value.agentId as string,
    resourceId: requiredAgentValue(value, "resourceId", "completion_agent_resource_id_invalid"),
    operationId: requiredAgentValue(value, "operationId", "completion_agent_operation_id_invalid"),
    ...(value.target === undefined ? {} : { target: value.target as WorkspaceContextTargetRequest }),
    body: {
      scope_kind: "agent",
      agent_id: value.agentId as string,
      archived: requiredAgentBoolean(value, "archived", "completion_agent_archived_invalid"),
      expected_version: requiredAgentNumber(value, "expectedVersion", "completion_agent_expected_version_invalid"),
      reason: requiredAgentValue(value, "reason", "completion_agent_reason_invalid")
    }
  };
}

export function sanitizeAgentCompletionResourceListResponse(value: unknown, agentId: string): unknown {
  const parsed = PublicCompletionResourcePageSchema.safeParse(value);
  if (!parsed.success) throw new Error("completion_agent_response_invalid");
  for (const resource of parsed.data.resources) assertAgentCompletionResourceScope(resource, agentId);
  return parsed.data;
}

export function sanitizeAgentCompletionResourceDetailResponse(value: unknown, agentId: string): unknown {
  const parsed = PublicCompletionResourceDetailSchema.safeParse(value);
  if (!parsed.success) throw new Error("completion_agent_response_invalid");
  assertAgentCompletionResourceScope(parsed.data.resource, agentId);
  return parsed.data;
}

export function sanitizeAgentCompletionResourceBodyResponse(value: unknown, agentId: string): unknown {
  const parsed = PublicCompletionResourceBodySchema.safeParse(value);
  if (!parsed.success) throw new Error("completion_agent_response_invalid");
  assertAgentCompletionResourceScope(parsed.data.resource, agentId);
  return parsed.data;
}

export function sanitizeAgentCompletionResourceMutationResponse(value: unknown, agentId: string): unknown {
  const parsed = PublicCompletionResourceMutationResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("completion_agent_response_invalid");
  assertAgentCompletionResourceScope(parsed.data.resource, agentId);
  return parsed.data;
}

function assertAgentCompletionResourceScope(resource: { scope: { kind: string; agentId?: string }; kind: string; aiManaged: boolean }, agentId: string): void {
  if (resource.scope.kind !== "agent" || resource.scope.agentId !== agentId || (resource.kind !== "knowledge" && resource.kind !== "skill") || resource.aiManaged) {
    throw new Error("completion_agent_response_scope_invalid");
  }
}

function assertAgentCompletionOperationKeys(input: unknown, keys: readonly string[]): void {
  const value = strictRecord(input, "completion_agent_input_invalid");
  assertAllowedKeys(value, keys, "completion_agent_input_invalid");
}

function completionKind(value: unknown): CompletionResourceKind {
  if (typeof value !== "string" || !(completionResourceKinds as readonly string[]).includes(value)) throw new Error("completion_agent_kind_invalid");
  return value as CompletionResourceKind;
}

function completionKnowledgeKind(value: unknown): CompletionKnowledgeKind {
  if (typeof value !== "string" || !(completionKnowledgeKinds as readonly string[]).includes(value)) throw new Error("completion_agent_knowledge_kind_invalid");
  return value as CompletionKnowledgeKind;
}

function completionWriteKnowledgeKind(value: Record<string, unknown>, kind: CompletionResourceKind): CompletionKnowledgeKind | undefined {
  if (kind === "skill") {
    if (value.knowledgeKind !== undefined) throw new Error("completion_agent_skill_knowledge_kind_forbidden");
    return undefined;
  }
  return completionKnowledgeKind(value.knowledgeKind);
}

function requiredAgentValue(value: Record<string, unknown>, key: string, errorCode: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate) throw new Error(errorCode);
  return candidate;
}

function requiredAgentNumber(value: Record<string, unknown>, key: string, errorCode: string): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) throw new Error(errorCode);
  return candidate;
}

function requiredAgentBoolean(value: Record<string, unknown>, key: string, errorCode: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") throw new Error(errorCode);
  return candidate;
}

function requiredAgentNumberValue(value: unknown, errorCode: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(errorCode);
  return value;
}

function requiredAgentBooleanValue(value: unknown, errorCode: string): boolean {
  if (typeof value !== "boolean") throw new Error(errorCode);
  return value;
}

function requiredAgentKind(value: Record<string, unknown>): CompletionResourceKind {
  return completionKind(value.kind);
}

function requiredCompletionContent(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8 * 1024 * 1024) throw new Error("completion_agent_content_invalid");
  return value.trim();
}

function completionJsonObject(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isCompletionJsonObject(value)) throw new Error(errorCode);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(errorCode);
  }
  if (encoded.length > 200_000) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function isCompletionJsonObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isCompletionJsonValue);
}

function isCompletionJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCompletionJsonValue);
  return isCompletionJsonObject(value);
}

export interface WorkspaceShareDraftCreateRequest {
  target?: WorkspaceContextTargetRequest;
  operationId: string;
  body: PublicShareDraftCreateInput;
}

export interface WorkspaceShareDraftViewRequest {
  target?: WorkspaceContextTargetRequest;
  body: { draft_id: string };
}

export interface WorkspaceShareDraftUpdateRequest {
  target?: WorkspaceContextTargetRequest;
  operationId: string;
  body: PublicShareDraftUpdateInput;
}

export interface WorkspaceShareDraftDiscardRequest {
  target?: WorkspaceContextTargetRequest;
  operationId: string;
  body: PublicShareDraftDiscardInput;
}

export interface WorkspaceShareListRequest {
  target?: WorkspaceContextTargetRequest;
  body: PublicShareListInput;
}

export interface WorkspaceSharePublishRequest {
  target?: WorkspaceContextTargetRequest;
  operationId: string;
  body: PublicSharePublishInput;
}

export interface WorkspaceShareRevokeRequest {
  target?: WorkspaceContextTargetRequest;
  operationId: string;
  body: PublicShareRevokeInput;
}

export interface WorkspaceShareImportRequest {
  target?: WorkspaceContextTargetRequest;
  operationId: string;
  body: PublicShareImportInput;
}

export interface WorkspaceShareImportStatusRequest {
  target?: WorkspaceContextTargetRequest;
  operationId: string;
  body: PublicShareImportStatusInput;
}

export interface WorkspaceShareLinkViewRequest {
  target?: WorkspaceContextTargetRequest;
  sourceUrl: string;
  sourceOrigin: string;
  locator: string;
}

export interface WorkspaceShareLinkImportRequest {
  target?: WorkspaceContextTargetRequest;
  sourceUrl: string;
  sourceOrigin: string;
  locator: string;
  targetRoomId?: string;
  operationId: string;
}

export interface WorkspaceShareLinkView {
  sourceUrl: string;
  sourceOrigin: string;
  locator: string;
  title: string;
  visibility: "restricted" | "public";
  manifest: WorkspaceShareManifest;
  contentHash: string;
  publishedAt: string;
}

export interface WorkspaceShareLinkClaim {
  claimId: string;
  shareId: string;
  recipientAccountId: string;
  targetOrigin: string;
  targetWorkspaceId: string;
  operationId: string;
  contentHash: string;
  createdAt: string;
}

export interface WorkspaceContextSearchItem {
  type: WorkspaceSearchType;
  id: string;
  roomId: string;
  title: string;
  snippet: string;
  updatedAt: string;
  target: WorkspaceContextTarget;
}

export interface WorkspaceContextSearchPage {
  items: WorkspaceContextSearchItem[];
  nextCursor: string | null;
}

export type WorkspaceNotificationActionState = "not_required" | "pending" | "resolved";

export interface WorkspaceNotification {
  id: string;
  kind: string;
  createdAt: string;
  readAt: string | null;
  title: string;
  summary: string;
  target: WorkspaceContextTarget | null;
  actionState: WorkspaceNotificationActionState;
}

export interface WorkspaceNotificationPage {
  items: WorkspaceNotification[];
  nextCursor: string | null;
}

export interface WorkspaceNotificationSummary {
  unreadCount: number;
  asOf: string;
}

export interface WorkspaceNotificationMarkReadResult {
  updatedIds: string[];
  alreadyReadIds: string[];
  readAt: string;
}

export interface AccountWorkspaceNotificationSummary {
  workspaceId: string;
  unreadCount: number;
  asOf: string;
}

export interface AccountWorkspaceNotificationSummaries {
  items: AccountWorkspaceNotificationSummary[];
}

export type WorkspaceShareKind = "room_knowledge" | "agent";
export type WorkspaceShareVisibility = "restricted" | "public";

export interface WorkspaceShareResourceFile {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  byteSize: number;
  sha256: string;
}

export interface WorkspaceShareResourceEntry {
  entryId: string;
  kind: "knowledge" | "skill";
  title: string;
  content: string;
  knowledgeKind?: "fact" | "decision" | "explanation" | "experience_rule";
  files: WorkspaceShareResourceFile[];
}

export interface WorkspaceShareManifest {
  formatVersion: 1;
  kind: WorkspaceShareKind;
  title: string;
  entries: WorkspaceShareResourceEntry[];
  agent?: { name: string; role: string; instructions: string };
}

export interface WorkspaceShareDraft {
  draftId: string;
  version: number;
  manifest: WorkspaceShareManifest;
  contentHash: string;
  visibility: WorkspaceShareVisibility;
  /** Recipient IDs and removed source locations never cross the Desktop bridge. */
  recipientCount: number;
  removedReferenceCount: number;
}

export interface WorkspaceShareSummary {
  shareId: string;
  version: number;
  title: string;
  status: "draft" | "active" | "revoked";
  visibility: WorkspaceShareVisibility;
  recipientCount: number;
  createdAt: string;
  publishedAt: string | null;
  revokedAt: string | null;
}

export interface WorkspaceSharePage {
  items: WorkspaceShareSummary[];
  nextCursor: string | null;
}

export interface WorkspaceSharePublishResult {
  shareId: string;
  version: number;
  /** A newly-issued public locator URL is safe to display after publish. */
  url: string;
  contentHash: string;
  publishedAt: string;
}

export interface WorkspaceShareRevokeResult {
  shareId: string;
  version: number;
  status: "revoked";
  revokedAt: string;
}

export interface WorkspaceShareImportResult {
  importId: string;
  kind: WorkspaceShareKind;
  status: "staging" | "committed" | "failed";
  phase: "fetch" | "files" | "commit" | "done" | "cleanup";
  retryable: boolean;
  failureCode: string | null;
  createdResourceIds: string[];
  createdAgentId: string | null;
  committedAt: string | null;
}

export interface WorkspaceShareDeepLink {
  kind: "share";
  sourceUrl: string;
  locator: string;
}

/**
 * Validate the renderer input for the new Workspace search query.  This
 * returns a Domain API body rather than forwarding the renderer object, so
 * account/workspace metadata and arbitrary keys cannot enter the signed body.
 */
export function workspaceContextSearchRequest(input: unknown): WorkspaceContextSearchRequest {
  const value = strictRecord(input, "workspace_context_search_input_invalid");
  assertAllowedKeys(value, ["query", "types", "roomId", "limit", "cursor", "target"], "workspace_context_search_input_invalid");
  const query = requiredText(value.query, "workspace_context_search_query_invalid", 512);
  const types = optionalSearchTypes(value.types);
  const roomId = value.roomId === undefined ? undefined : requiredId(value.roomId, "workspace_context_search_room_id_invalid");
  const page = pageInput(value, "workspace_context_search");
  const target = sanitizeTarget(value.target);
  return {
    ...(target ? { target } : {}),
    body: {
      q: query,
      ...(types ? { types } : {}),
      ...(roomId ? { room_id: roomId } : {}),
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor })
    }
  };
}

export function workspaceNotificationListRequest(input?: unknown): WorkspaceNotificationListRequest {
  const value = strictRecord(input === undefined ? {} : input, "workspace_notification_list_input_invalid");
  assertAllowedKeys(value, ["unreadOnly", "limit", "cursor", "target"], "workspace_notification_list_input_invalid");
  if (value.unreadOnly !== undefined && typeof value.unreadOnly !== "boolean") {
    throw new Error("workspace_notification_unread_only_invalid");
  }
  const page = pageInput(value, "workspace_notification");
  const target = sanitizeTarget(value.target);
  return {
    ...(target ? { target } : {}),
    body: {
      ...(value.unreadOnly === undefined ? {} : { unread_only: value.unreadOnly }),
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor })
    }
  };
}

export function workspaceNotificationSummaryRequest(input?: unknown): WorkspaceNotificationSummaryRequest {
  const value = strictRecord(input === undefined ? {} : input, "workspace_notification_summary_input_invalid");
  assertAllowedKeys(value, ["target"], "workspace_notification_summary_input_invalid");
  const target = sanitizeTarget(value.target);
  return target ? { target } : {};
}

export function workspaceNotificationReadRequest(input: unknown): WorkspaceNotificationReadRequest {
  const value = strictRecord(input, "workspace_notification_read_input_invalid");
  assertAllowedKeys(value, ["notificationIds", "operationId", "target"], "workspace_notification_read_input_invalid");
  const notificationIds = requiredIds(value.notificationIds, "workspace_notification_ids_invalid");
  const operationId = requiredId(value.operationId, "workspace_notification_operation_id_invalid");
  const target = sanitizeTarget(value.target);
  return {
    ...(target ? { target } : {}),
    notificationIds,
    operationId,
    body: { notification_ids: notificationIds }
  };
}

export function accountWorkspaceNotificationSummaryRequest(input: unknown): AccountWorkspaceNotificationSummaryRequest {
  const value = strictRecord(input, "account_workspace_notification_summary_input_invalid");
  assertAllowedKeys(value, ["workspaceIds", "target"], "account_workspace_notification_summary_input_invalid");
  const workspaceIds = requiredIds(value.workspaceIds, "account_workspace_notification_workspace_ids_invalid");
  const target = sanitizeTarget(value.target);
  return {
    ...(target ? { target } : {}),
    workspaceIds,
    body: { workspace_ids: workspaceIds }
  };
}

export function accountInvitationNotificationListRequest(input?: unknown): AccountInvitationNotificationListRequest {
  const value = strictRecord(input === undefined ? {} : input, "account_invitation_notification_list_input_invalid");
  assertAllowedKeys(value, ["limit", "cursor", "target"], "account_invitation_notification_list_input_invalid");
  const page = pageInput(value, "account_invitation_notification");
  const target = sanitizeTarget(value.target);
  return {
    ...(target ? { target } : {}),
    body: {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor })
    }
  };
}

export function accountInvitationNotificationReadRequest(input: unknown): AccountInvitationNotificationReadRequest {
  const value = strictRecord(input, "account_invitation_notification_read_input_invalid");
  assertAllowedKeys(value, ["notificationIds", "operationId", "target"], "account_invitation_notification_read_input_invalid");
  const notificationIds = requiredIds(value.notificationIds, "account_invitation_notification_ids_invalid");
  const operationId = requiredId(value.operationId, "account_invitation_notification_operation_id_invalid");
  const target = sanitizeTarget(value.target);
  return {
    ...(target ? { target } : {}),
    notificationIds,
    operationId,
    body: { notification_ids: notificationIds }
  };
}

/**
 * The preload validates these requests before crossing the renderer/Main IPC
 * boundary.  Main receives that normalized `{ target, body, ... }` shape and
 * must validate it again without treating it as the original renderer input.
 * Keeping this conversion here preserves a single strict request contract on
 * both sides of the boundary and avoids rejecting every real Electron call
 * as an already-sanitized object.
 */
export function workspaceContextSearchRequestFromPreload(input: unknown): WorkspaceContextSearchRequest {
  const value = strictRecord(input, "workspace_context_search_input_invalid");
  assertAllowedKeys(value, ["target", "body"], "workspace_context_search_input_invalid");
  const body = strictRecord(value.body, "workspace_context_search_input_invalid");
  assertAllowedKeys(body, ["q", "types", "room_id", "limit", "cursor"], "workspace_context_search_input_invalid");
  return workspaceContextSearchRequest({
    ...(value.target === undefined ? {} : { target: value.target }),
    query: body.q,
    ...(body.types === undefined ? {} : { types: body.types }),
    ...(body.room_id === undefined ? {} : { roomId: body.room_id }),
    ...(body.limit === undefined ? {} : { limit: body.limit }),
    ...(body.cursor === undefined ? {} : { cursor: body.cursor })
  });
}

export function workspaceNotificationListRequestFromPreload(input?: unknown): WorkspaceNotificationListRequest {
  const value = strictRecord(input === undefined ? {} : input, "workspace_notification_list_input_invalid");
  assertAllowedKeys(value, ["target", "body"], "workspace_notification_list_input_invalid");
  const body = strictRecord(value.body, "workspace_notification_list_input_invalid");
  assertAllowedKeys(body, ["unread_only", "limit", "cursor"], "workspace_notification_list_input_invalid");
  return workspaceNotificationListRequest({
    ...(value.target === undefined ? {} : { target: value.target }),
    ...(body.unread_only === undefined ? {} : { unreadOnly: body.unread_only }),
    ...(body.limit === undefined ? {} : { limit: body.limit }),
    ...(body.cursor === undefined ? {} : { cursor: body.cursor })
  });
}

export function workspaceNotificationSummaryRequestFromPreload(input?: unknown): WorkspaceNotificationSummaryRequest {
  const value = strictRecord(input === undefined ? {} : input, "workspace_notification_summary_input_invalid");
  assertAllowedKeys(value, ["target", "body"], "workspace_notification_summary_input_invalid");
  const body = value.body === undefined ? {} : strictRecord(value.body, "workspace_notification_summary_input_invalid");
  assertAllowedKeys(body, [], "workspace_notification_summary_input_invalid");
  return workspaceNotificationSummaryRequest(value.target === undefined ? {} : { target: value.target });
}

export function workspaceNotificationReadRequestFromPreload(input: unknown): WorkspaceNotificationReadRequest {
  const value = strictRecord(input, "workspace_notification_read_input_invalid");
  assertAllowedKeys(value, ["target", "notificationIds", "operationId", "body"], "workspace_notification_read_input_invalid");
  const body = strictRecord(value.body, "workspace_notification_read_input_invalid");
  assertAllowedKeys(body, ["notification_ids"], "workspace_notification_read_input_invalid");
  const request = workspaceNotificationReadRequest({
    ...(value.target === undefined ? {} : { target: value.target }),
    notificationIds: value.notificationIds,
    operationId: value.operationId
  });
  if (JSON.stringify(request.body) !== JSON.stringify(body)) throw new Error("workspace_notification_read_input_invalid");
  return request;
}

export function accountWorkspaceNotificationSummaryRequestFromPreload(input: unknown): AccountWorkspaceNotificationSummaryRequest {
  const value = strictRecord(input, "account_workspace_notification_summary_input_invalid");
  assertAllowedKeys(value, ["target", "workspaceIds", "body"], "account_workspace_notification_summary_input_invalid");
  const body = strictRecord(value.body, "account_workspace_notification_summary_input_invalid");
  assertAllowedKeys(body, ["workspace_ids"], "account_workspace_notification_summary_input_invalid");
  const request = accountWorkspaceNotificationSummaryRequest({
    ...(value.target === undefined ? {} : { target: value.target }),
    workspaceIds: value.workspaceIds
  });
  if (JSON.stringify(request.body) !== JSON.stringify(body)) throw new Error("account_workspace_notification_summary_input_invalid");
  return request;
}

export function accountInvitationNotificationListRequestFromPreload(input?: unknown): AccountInvitationNotificationListRequest {
  const value = strictRecord(input === undefined ? {} : input, "account_invitation_notification_list_input_invalid");
  assertAllowedKeys(value, ["target", "body"], "account_invitation_notification_list_input_invalid");
  const body = strictRecord(value.body, "account_invitation_notification_list_input_invalid");
  assertAllowedKeys(body, ["limit", "cursor"], "account_invitation_notification_list_input_invalid");
  return accountInvitationNotificationListRequest({
    ...(value.target === undefined ? {} : { target: value.target }),
    ...(body.limit === undefined ? {} : { limit: body.limit }),
    ...(body.cursor === undefined ? {} : { cursor: body.cursor })
  });
}

export function accountInvitationNotificationReadRequestFromPreload(input: unknown): AccountInvitationNotificationReadRequest {
  const value = strictRecord(input, "account_invitation_notification_read_input_invalid");
  assertAllowedKeys(value, ["target", "notificationIds", "operationId", "body"], "account_invitation_notification_read_input_invalid");
  const body = strictRecord(value.body, "account_invitation_notification_read_input_invalid");
  assertAllowedKeys(body, ["notification_ids"], "account_invitation_notification_read_input_invalid");
  const request = accountInvitationNotificationReadRequest({
    ...(value.target === undefined ? {} : { target: value.target }),
    notificationIds: value.notificationIds,
    operationId: value.operationId
  });
  if (JSON.stringify(request.body) !== JSON.stringify(body)) throw new Error("account_invitation_notification_read_input_invalid");
  return request;
}

export function workspaceShareDraftCreateRequest(input: unknown): WorkspaceShareDraftCreateRequest {
  const value = workspaceShareInputRecord(
    input,
    ["sourceKind", "sourceId", "resourceRefs", "baseShareId", "operationId", "target"],
    "workspace_share_draft_create_input_invalid"
  );
  const operationId = requiredId(value.operationId, "workspace_share_operation_id_invalid");
  const hasBase = Object.prototype.hasOwnProperty.call(value, "baseShareId");
  const hasSource = Object.prototype.hasOwnProperty.call(value, "sourceKind")
    || Object.prototype.hasOwnProperty.call(value, "sourceId")
    || Object.prototype.hasOwnProperty.call(value, "resourceRefs");
  if (hasBase === hasSource) throw new Error("workspace_share_draft_create_input_invalid");
  const body = hasBase
    ? { base_share_id: requiredId(value.baseShareId, "workspace_share_base_id_invalid") }
    : {
      source_kind: normalizeWorkspaceShareKind(value.sourceKind),
      source_id: requiredId(value.sourceId, "workspace_share_source_id_invalid"),
      resource_refs: normalizeWorkspaceShareResourceRefs(value.resourceRefs)
    };
  const parsed = PublicShareDraftCreateInputSchema.safeParse(body);
  if (!parsed.success) throw new Error("workspace_share_draft_create_input_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), operationId, body: parsed.data };
}

export function workspaceShareDraftViewRequest(input: unknown): WorkspaceShareDraftViewRequest {
  const value = workspaceShareInputRecord(input, ["draftId", "target"], "workspace_share_draft_view_input_invalid");
  const parsed = PublicShareDraftViewInputSchema.safeParse({
    draft_id: requiredId(value.draftId, "workspace_share_draft_id_invalid")
  });
  if (!parsed.success) throw new Error("workspace_share_draft_view_input_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), body: parsed.data };
}

export function workspaceShareDraftUpdateRequest(input: unknown): WorkspaceShareDraftUpdateRequest {
  const value = workspaceShareInputRecord(input, ["draftId", "expectedVersion", "manifest", "visibility", "recipientAccountIds", "operationId", "target"], "workspace_share_draft_update_input_invalid");
  const operationId = requiredId(value.operationId, "workspace_share_operation_id_invalid");
  const parsed = PublicShareDraftUpdateInputSchema.safeParse({
    draft_id: requiredId(value.draftId, "workspace_share_draft_id_invalid"),
    expected_version: normalizeWorkspaceShareVersion(value.expectedVersion, "workspace_share_expected_version_invalid"),
    manifest: normalizeWorkspaceShareManifestInput(value.manifest),
    visibility: normalizeWorkspaceShareVisibility(value.visibility),
    recipient_account_ids: normalizeWorkspaceShareRecipients(value.recipientAccountIds)
  });
  if (!parsed.success) throw new Error("workspace_share_draft_update_input_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), operationId, body: parsed.data };
}

export function workspaceShareDraftDiscardRequest(input: unknown): WorkspaceShareDraftDiscardRequest {
  const value = workspaceShareInputRecord(input, ["draftId", "expectedVersion", "operationId", "target"], "workspace_share_draft_discard_input_invalid");
  const operationId = requiredId(value.operationId, "workspace_share_operation_id_invalid");
  const parsed = PublicShareDraftDiscardInputSchema.safeParse({
    draft_id: requiredId(value.draftId, "workspace_share_draft_id_invalid"),
    expected_version: normalizeWorkspaceShareVersion(value.expectedVersion, "workspace_share_expected_version_invalid")
  });
  if (!parsed.success) throw new Error("workspace_share_draft_discard_input_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), operationId, body: parsed.data };
}

export function workspaceShareListRequest(input: unknown): WorkspaceShareListRequest {
  const value = workspaceShareInputRecord(input, ["sourceKind", "sourceId", "limit", "cursor", "target"], "workspace_share_list_input_invalid");
  const page = pageInput(value, "workspace_share_list");
  const parsed = PublicShareListInputSchema.safeParse({
    source_kind: normalizeWorkspaceShareKind(value.sourceKind),
    source_id: requiredId(value.sourceId, "workspace_share_source_id_invalid"),
    ...(page.limit === undefined ? {} : { limit: page.limit }),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor })
  });
  if (!parsed.success) throw new Error("workspace_share_list_input_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), body: parsed.data };
}

export function workspaceSharePublishRequest(input: unknown): WorkspaceSharePublishRequest {
  const value = workspaceShareInputRecord(input, ["draftId", "expectedVersion", "expectedContentHash", "operationId", "target"], "workspace_share_publish_input_invalid");
  const operationId = requiredId(value.operationId, "workspace_share_operation_id_invalid");
  const parsed = PublicSharePublishInputSchema.safeParse({
    draft_id: requiredId(value.draftId, "workspace_share_draft_id_invalid"),
    expected_version: normalizeWorkspaceShareVersion(value.expectedVersion, "workspace_share_expected_version_invalid"),
    expected_content_hash: normalizeWorkspaceShareHash(value.expectedContentHash, "workspace_share_expected_content_hash_invalid")
  });
  if (!parsed.success) throw new Error("workspace_share_publish_input_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), operationId, body: parsed.data };
}

export function workspaceShareRevokeRequest(input: unknown): WorkspaceShareRevokeRequest {
  const value = workspaceShareInputRecord(input, ["shareId", "expectedVersion", "operationId", "target"], "workspace_share_revoke_input_invalid");
  const operationId = requiredId(value.operationId, "workspace_share_operation_id_invalid");
  const parsed = PublicShareRevokeInputSchema.safeParse({
    share_id: requiredId(value.shareId, "workspace_share_id_invalid"),
    expected_version: normalizeWorkspaceShareVersion(value.expectedVersion, "workspace_share_expected_version_invalid")
  });
  if (!parsed.success) throw new Error("workspace_share_revoke_input_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), operationId, body: parsed.data };
}

export function workspaceShareImportRequest(input: unknown): WorkspaceShareImportRequest {
  const value = workspaceShareInputRecord(
    input,
    ["sourceOrigin", "locator", "claimId", "contentHash", "delegation", "targetRoomId", "operationId", "target"],
    "workspace_share_import_input_invalid"
  );
  const operationId = requiredId(value.operationId, "workspace_share_operation_id_invalid");
  const sourceOrigin = normalizeWorkspaceShareOrigin(value.sourceOrigin, "workspace_share_source_origin_invalid");
  const locator = normalizeWorkspaceShareLocator(value.locator, "workspace_share_locator_invalid");
  const claimId = requiredId(value.claimId, "workspace_share_claim_id_invalid");
  const contentHash = normalizeWorkspaceShareHash(value.contentHash, "workspace_share_content_hash_invalid");
  const delegation = normalizeWorkspaceShareDelegation(value.delegation);
  const targetRoomId = value.targetRoomId === undefined
    ? undefined
    : requiredId(value.targetRoomId, "workspace_share_target_room_id_invalid");
  const parsed = PublicShareImportInputSchema.safeParse({
    source_origin: sourceOrigin,
    locator,
    claim_id: claimId,
    content_hash: contentHash,
    delegation,
    ...(targetRoomId === undefined ? {} : { target_room_id: targetRoomId })
  });
  if (!parsed.success) throw new Error("workspace_share_import_input_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), operationId, body: parsed.data };
}

export function workspaceShareImportStatusRequest(input: unknown): WorkspaceShareImportStatusRequest {
  const value = workspaceShareInputRecord(input, ["operationId", "target"], "workspace_share_import_status_input_invalid");
  const operationId = requiredId(value.operationId, "workspace_share_operation_id_invalid");
  const parsed = PublicShareImportStatusInputSchema.safeParse({ operation_id: operationId });
  if (!parsed.success) throw new Error("workspace_share_import_status_input_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), operationId, body: parsed.data };
}

export function workspaceShareLinkViewRequest(input: unknown): WorkspaceShareLinkViewRequest {
  const value = workspaceShareInputRecord(input, ["sourceUrl", "target"], "workspace_share_link_input_invalid");
  const source = parseShareSourceUrl(value.sourceUrl);
  if (!source) throw new Error("workspace_share_link_source_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), ...source };
}

export function workspaceShareLinkImportRequest(input: unknown): WorkspaceShareLinkImportRequest {
  const value = workspaceShareInputRecord(input, ["sourceUrl", "targetRoomId", "operationId", "target"], "workspace_share_link_import_input_invalid");
  const source = parseShareSourceUrl(value.sourceUrl);
  if (!source) throw new Error("workspace_share_link_source_invalid");
  const operationId = requiredId(value.operationId, "workspace_share_operation_id_invalid");
  const targetRoomId = value.targetRoomId === undefined ? undefined : requiredId(value.targetRoomId, "workspace_share_target_room_id_invalid");
  const target = sanitizeTarget(value.target);
  return { ...(target ? { target } : {}), ...source, ...(targetRoomId ? { targetRoomId } : {}), operationId };
}

export function sanitizeWorkspaceContextSearchResponse(value: unknown): WorkspaceContextSearchPage {
  const result = domainResult(value, "workspace_context_search_response_invalid");
  const parsed = PublicWorkspaceSearchPageSchema.safeParse(result);
  if (!parsed.success) throw new Error("workspace_context_search_response_invalid");
  return {
    items: parsed.data.items.map((item, index) => sanitizeSearchItem(item, index)),
    nextCursor: parsed.data.next_cursor
  };
}

export function sanitizeWorkspaceNotificationPageResponse(value: unknown, invitationOnly = false): WorkspaceNotificationPage {
  const result = domainResult(value, invitationOnly
    ? "account_invitation_notification_response_invalid"
    : "workspace_notification_response_invalid");
  const parsed = (invitationOnly ? PublicAccountInvitationNotificationsPageSchema : PublicNotificationPageSchema).safeParse(result);
  if (!parsed.success) {
    throw new Error(invitationOnly
      ? "account_invitation_notification_response_invalid"
      : "workspace_notification_response_invalid");
  }
  return {
    items: parsed.data.items.map((item, index) => sanitizeNotification(item, index)),
    nextCursor: parsed.data.next_cursor
  };
}

export function sanitizeWorkspaceNotificationSummaryResponse(value: unknown): WorkspaceNotificationSummary {
  const result = domainResult(value, "workspace_notification_summary_response_invalid");
  const parsed = PublicNotificationSummarySchema.safeParse(result);
  if (!parsed.success) throw new Error("workspace_notification_summary_response_invalid");
  return { unreadCount: parsed.data.unread_count, asOf: parsed.data.as_of };
}

export function sanitizeWorkspaceNotificationMarkReadResponse(value: unknown, requestedIds: readonly string[]): WorkspaceNotificationMarkReadResult {
  const result = domainResult(value, "workspace_notification_mark_read_response_invalid");
  const parsed = PublicNotificationMarkReadResultSchema.safeParse(result);
  if (!parsed.success) throw new Error("workspace_notification_mark_read_response_invalid");
  const updatedIds = parsed.data.updated_ids.map((id) => requiredId(id, "workspace_notification_response_id_invalid"));
  const alreadyReadIds = parsed.data.already_read_ids.map((id) => requiredId(id, "workspace_notification_response_id_invalid"));
  assertReadResultScope(updatedIds, alreadyReadIds, requestedIds);
  return { updatedIds, alreadyReadIds, readAt: parsed.data.read_at };
}

export function sanitizeAccountWorkspaceNotificationSummariesResponse(
  value: unknown,
  requestedWorkspaceIds: readonly string[]
): AccountWorkspaceNotificationSummaries {
  const result = domainResult(value, "account_workspace_notification_summary_response_invalid");
  const parsed = PublicAccountWorkspaceNotificationSummariesSchema.safeParse(result);
  if (!parsed.success) throw new Error("account_workspace_notification_summary_response_invalid");
  const requested = new Set(requestedWorkspaceIds);
  const items = parsed.data.items.map((item) => ({
    workspaceId: requiredId(item.workspace_id, "account_workspace_notification_workspace_id_invalid"),
    unreadCount: item.unread_count,
    asOf: item.as_of
  }));
  if (new Set(items.map((item) => item.workspaceId)).size !== items.length
    || items.some((item) => !requested.has(item.workspaceId))) {
    throw new Error("account_workspace_notification_summary_response_scope_invalid");
  }
  return { items };
}

export function sanitizeAccountInvitationNotificationMarkReadResponse(value: unknown, requestedIds: readonly string[]): WorkspaceNotificationMarkReadResult {
  return sanitizeWorkspaceNotificationMarkReadResponse(value, requestedIds);
}

export function sanitizeWorkspaceShareDraftResponse(value: unknown): WorkspaceShareDraft {
  const result = domainResult(value, "workspace_share_draft_response_invalid");
  const parsed = PublicShareDraftSchema.safeParse(result);
  if (!parsed.success) throw new Error("workspace_share_draft_response_invalid");
  return {
    draftId: requiredId(parsed.data.draft_id, "workspace_share_draft_id_invalid"),
    version: normalizeWorkspaceShareVersion(parsed.data.version, "workspace_share_draft_version_invalid"),
    manifest: sanitizeWorkspaceShareManifest(parsed.data.manifest),
    contentHash: normalizeWorkspaceShareHash(parsed.data.content_hash, "workspace_share_content_hash_invalid"),
    visibility: parsed.data.visibility,
    recipientCount: parsed.data.recipient_account_ids.length,
    removedReferenceCount: parsed.data.removed_references.length
  };
}

export function sanitizeWorkspaceShareDraftDiscardResponse(value: unknown): { draftId: string; discarded: true } {
  const result = domainResult(value, "workspace_share_draft_discard_response_invalid");
  const parsed = PublicShareDraftDiscardResultSchema.safeParse(result);
  if (!parsed.success) throw new Error("workspace_share_draft_discard_response_invalid");
  return { draftId: requiredId(parsed.data.draft_id, "workspace_share_draft_id_invalid"), discarded: true };
}

export function sanitizeWorkspaceSharePageResponse(value: unknown): WorkspaceSharePage {
  const result = domainResult(value, "workspace_share_list_response_invalid");
  const parsed = PublicSharePageSchema.safeParse(result);
  if (!parsed.success) throw new Error("workspace_share_list_response_invalid");
  return {
    items: parsed.data.items.map((item) => sanitizeWorkspaceShareSummary(item)),
    nextCursor: parsed.data.next_cursor
  };
}

export function sanitizeWorkspaceSharePublishResponse(value: unknown): WorkspaceSharePublishResult {
  const result = domainResult(value, "workspace_share_publish_response_invalid");
  const parsed = PublicSharePublishResultSchema.safeParse(result);
  if (!parsed.success) throw new Error("workspace_share_publish_response_invalid");
  return {
    shareId: requiredId(parsed.data.share_id, "workspace_share_id_invalid"),
    version: normalizeWorkspaceShareVersion(parsed.data.version, "workspace_share_version_invalid"),
    url: sanitizeWorkspaceShareUrl(parsed.data.url, "workspace_share_publish_url_invalid"),
    contentHash: normalizeWorkspaceShareHash(parsed.data.content_hash, "workspace_share_content_hash_invalid"),
    publishedAt: parsed.data.published_at
  };
}

export function sanitizeWorkspaceShareRevokeResponse(value: unknown): WorkspaceShareRevokeResult {
  const result = domainResult(value, "workspace_share_revoke_response_invalid");
  const parsed = PublicShareRevokeResultSchema.safeParse(result);
  if (!parsed.success) throw new Error("workspace_share_revoke_response_invalid");
  return {
    shareId: requiredId(parsed.data.share_id, "workspace_share_id_invalid"),
    version: normalizeWorkspaceShareVersion(parsed.data.version, "workspace_share_version_invalid"),
    status: "revoked",
    revokedAt: parsed.data.revoked_at
  };
}

export function sanitizeWorkspaceShareImportResponse(value: unknown): WorkspaceShareImportResult {
  const result = domainResult(value, "workspace_share_import_response_invalid");
  const parsed = PublicShareImportResultSchema.safeParse(result);
  if (!parsed.success) throw new Error("workspace_share_import_response_invalid");
  return {
    importId: requiredId(parsed.data.import_id, "workspace_share_import_id_invalid"),
    kind: parsed.data.kind,
    status: parsed.data.status,
    phase: parsed.data.phase,
    retryable: parsed.data.retryable,
    failureCode: parsed.data.failure_code === null
      ? null
      : requiredId(parsed.data.failure_code, "workspace_share_failure_code_invalid"),
    createdResourceIds: parsed.data.created_resource_ids.map((id) => requiredId(id, "workspace_share_created_resource_id_invalid")),
    createdAgentId: parsed.data.created_agent_id === null
      ? null
      : requiredId(parsed.data.created_agent_id, "workspace_share_created_agent_id_invalid"),
    committedAt: parsed.data.committed_at
  };
}

/** Sanitize the fixed source-server projection; no source IDs, paths, or
 * recipient metadata are accepted even if a server accidentally includes it. */
export function sanitizeWorkspaceShareLinkViewResponse(
  value: unknown,
  source: Pick<WorkspaceShareLinkViewRequest, "sourceUrl" | "sourceOrigin" | "locator">
): WorkspaceShareLinkView {
  const record = strictRecord(value, "workspace_share_link_view_response_invalid");
  assertAllowedKeys(record, ["title", "visibility", "manifest", "content_hash", "published_at"], "workspace_share_link_view_response_invalid");
  const title = requiredText(record.title, "workspace_share_link_title_invalid", 200);
  const visibility = normalizeWorkspaceShareVisibility(record.visibility);
  const parsedManifest = PublicShareManifestSchema.safeParse(record.manifest);
  if (!parsedManifest.success) throw new Error("workspace_share_link_manifest_invalid");
  const manifest = sanitizeWorkspaceShareManifest(parsedManifest.data);
  const contentHash = normalizeWorkspaceShareHash(record.content_hash, "workspace_share_link_content_hash_invalid");
  if (typeof record.published_at !== "string" || !Number.isFinite(Date.parse(record.published_at))) throw new Error("workspace_share_link_published_at_invalid");
  return {
    sourceUrl: source.sourceUrl,
    sourceOrigin: source.sourceOrigin,
    locator: source.locator,
    title,
    visibility,
    manifest,
    contentHash,
    publishedAt: new Date(record.published_at).toISOString()
  };
}

/** Claim metadata stays in Main/Browser bridge and is never returned to the
 * renderer. It is used only to build the one fixed delegation payload. */
export function sanitizeWorkspaceShareLinkClaimResponse(value: unknown): WorkspaceShareLinkClaim {
  const record = strictRecord(value, "workspace_share_link_claim_response_invalid");
  assertAllowedKeys(record, ["claim_id", "share_id", "recipient_account_id", "target_origin", "target_workspace_id", "operation_id", "content_hash", "created_at"], "workspace_share_link_claim_response_invalid");
  const claimId = requiredId(record.claim_id, "workspace_share_claim_id_invalid");
  const shareId = requiredId(record.share_id, "workspace_share_id_invalid");
  const recipientAccountId = requiredId(record.recipient_account_id, "workspace_share_recipient_account_id_invalid");
  const targetOrigin = normalizeWorkspaceShareOrigin(record.target_origin, "workspace_share_target_origin_invalid");
  const targetWorkspaceId = requiredId(record.target_workspace_id, "workspace_share_target_workspace_id_invalid");
  const operationId = requiredId(record.operation_id, "workspace_share_operation_id_invalid");
  const contentHash = normalizeWorkspaceShareHash(record.content_hash, "workspace_share_content_hash_invalid");
  if (typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) throw new Error("workspace_share_claim_created_at_invalid");
  return { claimId, shareId, recipientAccountId, targetOrigin, targetWorkspaceId, operationId, contentHash, createdAt: new Date(record.created_at).toISOString() };
}

/**
 * Parse only the safe share handoff URL.  This helper never fetches the URL,
 * claims a share, or starts an import; it returns syntax-only metadata for
 * Main to route to the renderer.
 */
export function parseSamuraiShareDeepLink(value: unknown): WorkspaceShareDeepLink | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "samurai:" || parsed.hostname !== "share"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== ""
    || parsed.hash
    || parsed.searchParams.getAll("source").length !== 1
    || [...parsed.searchParams.keys()].some((key) => key !== "source")) {
    return undefined;
  }
  const source = parseShareSourceUrl(parsed.searchParams.get("source"));
  return source
    ? { kind: "share", sourceUrl: source.sourceUrl, locator: source.locator }
    : undefined;
}

function parseShareSourceUrl(value: unknown): { sourceUrl: string; sourceOrigin: string; locator: string } | undefined {
  if (typeof value !== "string" || !value || value.length > 4_096) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || value.includes("?") || value.includes("#")) return undefined;
  const match = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(parsed.pathname);
  const locator = match?.[1];
  if (!locator || !shareLocatorPattern.test(locator)) return undefined;
  return { sourceUrl: parsed.toString(), sourceOrigin: new URL("/", parsed.origin).toString(), locator };
}

function workspaceShareInputRecord(value: unknown, allowedKeys: readonly string[], errorCode: string): Record<string, unknown> {
  const record = strictRecord(value, errorCode);
  assertAllowedKeys(record, allowedKeys, errorCode);
  if ("workspaceId" in record || "accountId" in record || "connectionId" in record) throw new Error(errorCode);
  return record;
}

function normalizeWorkspaceShareKind(value: unknown): WorkspaceShareKind {
  if (value !== "room_knowledge" && value !== "agent") throw new Error("workspace_share_kind_invalid");
  return value;
}

function normalizeWorkspaceShareVersion(value: unknown, errorCode: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(errorCode);
  return value;
}

function normalizeWorkspaceShareHash(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(errorCode);
  return value;
}

function normalizeWorkspaceShareOrigin(value: unknown, errorCode: string): string {
  const parsed = PublicShareOriginSchema.safeParse(value);
  if (!parsed.success) throw new Error(errorCode);
  return parsed.data;
}

function normalizeWorkspaceShareLocator(value: unknown, errorCode: string): string {
  const parsed = PublicShareLocatorSchema.safeParse(value);
  if (!parsed.success) throw new Error(errorCode);
  return parsed.data;
}

function normalizeWorkspaceShareResourceRefs(value: unknown): Array<{ id: string; version: number }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) {
    throw new Error("workspace_share_resource_refs_invalid");
  }
  const refs = value.map((item, index) => {
    const record = workspaceShareInputRecord(item, ["id", "version"], `workspace_share_resource_ref_${index}_invalid`);
    return {
      id: requiredId(record.id, `workspace_share_resource_ref_${index}_id_invalid`),
      version: normalizeWorkspaceShareVersion(record.version, `workspace_share_resource_ref_${index}_version_invalid`)
    };
  });
  if (new Set(refs.map((ref) => ref.id)).size !== refs.length) throw new Error("workspace_share_resource_refs_invalid");
  return refs;
}

function normalizeWorkspaceShareDelegation(value: unknown): PublicShareDelegationInput {
  const record = workspaceShareInputRecord(value, ["payload", "publicKey", "signature"], "workspace_share_delegation_invalid");
  const payload = workspaceShareInputRecord(
    record.payload,
    ["version", "sourceOrigin", "shareId", "claimId", "recipientAccountId", "targetOrigin", "targetWorkspaceId", "operationId", "contentHash", "issuedAt", "expiresAt"],
    "workspace_share_delegation_payload_invalid"
  );
  const candidate = {
    payload: {
      version: payload.version,
      source_origin: normalizeWorkspaceShareOrigin(payload.sourceOrigin, "workspace_share_delegation_source_origin_invalid"),
      share_id: requiredId(payload.shareId, "workspace_share_delegation_share_id_invalid"),
      claim_id: requiredId(payload.claimId, "workspace_share_delegation_claim_id_invalid"),
      recipient_account_id: requiredId(payload.recipientAccountId, "workspace_share_delegation_recipient_account_id_invalid"),
      target_origin: normalizeWorkspaceShareOrigin(payload.targetOrigin, "workspace_share_delegation_target_origin_invalid"),
      target_workspace_id: requiredId(payload.targetWorkspaceId, "workspace_share_delegation_workspace_id_invalid"),
      operation_id: requiredId(payload.operationId, "workspace_share_delegation_operation_id_invalid"),
      content_hash: normalizeWorkspaceShareHash(payload.contentHash, "workspace_share_delegation_content_hash_invalid"),
      issued_at: payload.issuedAt,
      expires_at: payload.expiresAt
    },
    public_key: requiredShareBlob(record.publicKey, "workspace_share_delegation_public_key_invalid"),
    signature: requiredShareBlob(record.signature, "workspace_share_delegation_signature_invalid")
  };
  const parsed = PublicShareDelegationSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("workspace_share_delegation_invalid");
  return parsed.data;
}

type PublicShareDelegationInput = {
  payload: {
    version: 1;
    source_origin: string;
    share_id: string;
    claim_id: string;
    recipient_account_id: string;
    target_origin: string;
    target_workspace_id: string;
    operation_id: string;
    content_hash: string;
    issued_at: string;
    expires_at: string;
  };
  public_key: string;
  signature: string;
};

function requiredShareBlob(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) throw new Error(errorCode);
  return value.trim();
}

function normalizeWorkspaceShareVisibility(value: unknown): "restricted" | "public" {
  const parsed = PublicShareVisibilitySchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_share_visibility_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareRecipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error("workspace_share_recipient_ids_invalid");
  const recipients = value.map((item) => requiredId(item, "workspace_share_recipient_id_invalid"));
  if (new Set(recipients).size !== recipients.length) throw new Error("workspace_share_recipient_ids_invalid");
  return recipients;
}

function normalizeWorkspaceShareManifestInput(value: unknown): import("@samurai-agent/domain-api").PublicShareManifest {
  const record = workspaceShareInputRecord(value, ["formatVersion", "kind", "title", "entries", "agent"], "workspace_share_manifest_input_invalid");
  const entries = Array.isArray(record.entries)
    ? record.entries.map((entry, index) => {
      const item = workspaceShareInputRecord(entry, ["entryId", "kind", "title", "content", "knowledgeKind", "files"], `workspace_share_manifest_entry_${index}_invalid`);
      const files = item.files === undefined ? [] : Array.isArray(item.files)
        ? item.files.map((file, fileIndex) => {
          const fileRecord = workspaceShareInputRecord(file, ["path", "encoding", "content", "byteSize", "sha256"], `workspace_share_manifest_file_${index}_${fileIndex}_invalid`);
          return {
            path: fileRecord.path,
            encoding: fileRecord.encoding,
            content: fileRecord.content,
            byte_size: fileRecord.byteSize,
            sha256: fileRecord.sha256
          };
        })
        : (() => { throw new Error("workspace_share_manifest_files_invalid"); })();
      return {
        entry_id: requiredId(item.entryId, "workspace_share_manifest_entry_id_invalid"),
        kind: item.kind,
        title: item.title,
        content: item.content,
        ...(item.knowledgeKind === undefined ? {} : { knowledge_kind: item.knowledgeKind }),
        files
      };
    })
    : (() => { throw new Error("workspace_share_manifest_entries_invalid"); })();
  const agent = record.agent === undefined ? undefined : (() => {
    const agent = workspaceShareInputRecord(record.agent, ["name", "role", "instructions"], "workspace_share_manifest_agent_invalid");
    return { name: agent.name, role: agent.role, instructions: agent.instructions };
  })();
  const parsed = PublicShareManifestSchema.safeParse({
    format_version: record.formatVersion,
    kind: record.kind,
    title: record.title,
    entries,
    ...(agent === undefined ? {} : { agent })
  });
  if (!parsed.success) throw new Error("workspace_share_manifest_input_invalid");
  return parsed.data;
}

function sanitizeWorkspaceShareManifest(value: {
  format_version: 1;
  kind: WorkspaceShareKind;
  title: string;
  entries: Array<{
    entry_id: string;
    kind: "knowledge" | "skill";
    title: string;
    content: string;
    knowledge_kind?: "fact" | "decision" | "explanation" | "experience_rule";
    files: Array<{ path: string; encoding: "utf8" | "base64"; content: string; byte_size: number; sha256: string }>;
  }>;
  agent?: { name: string; role: string; instructions: string };
}): WorkspaceShareManifest {
  return {
    formatVersion: 1,
    kind: value.kind,
    title: value.title,
    entries: value.entries.map((entry) => ({
      entryId: requiredId(entry.entry_id, "workspace_share_manifest_entry_id_invalid"),
      kind: entry.kind,
      title: entry.title,
      content: entry.content,
      ...(entry.knowledge_kind === undefined ? {} : { knowledgeKind: entry.knowledge_kind }),
      files: entry.files.map((file) => ({
        path: file.path,
        encoding: file.encoding,
        content: file.content,
        byteSize: file.byte_size,
        sha256: normalizeWorkspaceShareHash(file.sha256, "workspace_share_manifest_file_hash_invalid")
      }))
    })),
    ...(value.agent === undefined ? {} : { agent: value.agent })
  };
}

function sanitizeWorkspaceShareSummary(value: {
  share_id: string;
  version: number;
  title: string;
  status: "draft" | "active" | "revoked";
  visibility: WorkspaceShareVisibility;
  recipient_account_ids: string[];
  url: string | null;
  created_at: string;
  published_at: string | null;
  revoked_at: string | null;
}): WorkspaceShareSummary {
  if (value.url !== null) sanitizeWorkspaceShareUrl(value.url, "workspace_share_summary_url_invalid");
  return {
    shareId: requiredId(value.share_id, "workspace_share_id_invalid"),
    version: normalizeWorkspaceShareVersion(value.version, "workspace_share_version_invalid"),
    title: value.title,
    status: value.status,
    visibility: value.visibility,
    recipientCount: value.recipient_account_ids.length,
    createdAt: value.created_at,
    publishedAt: value.published_at,
    revokedAt: value.revoked_at
  };
}

function sanitizeWorkspaceShareUrl(value: string, errorCode: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(errorCode);
  }
  if (parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !/^\/s\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname)) {
    throw new Error(errorCode);
  }
  return parsed.toString();
}

function sanitizeTarget(value: unknown): WorkspaceContextTargetRequest | undefined {
  if (value === undefined) return undefined;
  const target = strictRecord(value, "workspace_context_target_invalid");
  assertAllowedKeys(target, ["connectionId", "workspaceId", "roomId", "selectionGeneration"], "workspace_context_target_invalid");
  const connectionId = requiredId(target.connectionId, "workspace_context_target_connection_invalid");
  const workspaceId = requiredId(target.workspaceId, "workspace_context_target_workspace_invalid");
  const roomId = target.roomId === undefined ? undefined : requiredId(target.roomId, "workspace_context_target_room_invalid");
  const selectionGeneration = target.selectionGeneration;
  if (selectionGeneration !== undefined
    && (typeof selectionGeneration !== "number" || !Number.isSafeInteger(selectionGeneration) || selectionGeneration < 0)) {
    throw new Error("workspace_context_target_generation_invalid");
  }
  return {
    connectionId,
    workspaceId,
    ...(roomId === undefined ? {} : { roomId }),
    ...(selectionGeneration === undefined ? {} : { selectionGeneration })
  };
}

function sanitizeSearchItem(value: PublicSearchItem, index: number): WorkspaceContextSearchItem {
  const parsed = PublicSearchItemSchema.safeParse(value);
  if (!parsed.success) throw new Error(`workspace_context_search_item_${index}_invalid`);
  const roomId = requiredId(parsed.data.room_id, `workspace_context_search_item_${index}_room_invalid`);
  const target = sanitizePublicTarget(parsed.data.target, `workspace_context_search_item_${index}_target_invalid`);
  if (target.kind === "invitation" || target.roomId !== roomId) throw new Error("workspace_context_search_target_scope_invalid");
  return {
    type: parsed.data.type,
    id: requiredId(parsed.data.id, `workspace_context_search_item_${index}_id_invalid`),
    roomId,
    title: parsed.data.title,
    snippet: parsed.data.snippet,
    updatedAt: parsed.data.updated_at,
    target
  };
}

function sanitizeNotification(value: unknown, index: number): WorkspaceNotification {
  const parsed = PublicNotificationSchema.safeParse(value);
  if (!parsed.success) throw new Error(`workspace_notification_${index}_invalid`);
  return {
    id: requiredId(parsed.data.id, `workspace_notification_${index}_id_invalid`),
    kind: parsed.data.kind,
    createdAt: parsed.data.created_at,
    readAt: parsed.data.read_at,
    title: parsed.data.title,
    summary: parsed.data.summary,
    target: parsed.data.target === null ? null : sanitizePublicTarget(parsed.data.target, `workspace_notification_${index}_target_invalid`),
    actionState: parsed.data.action_state
  };
}

function sanitizePublicTarget(value: PublicTarget, field: string): WorkspaceContextTarget {
  const parsed = PublicTargetSchema.safeParse(value);
  if (!parsed.success) throw new Error(field);
  switch (parsed.data.kind) {
    case "room": return { kind: "room", roomId: requiredId(parsed.data.room_id, `${field}_room_id`) };
    case "work": return {
      kind: "work",
      roomId: requiredId(parsed.data.room_id, `${field}_room_id`),
      workId: requiredId(parsed.data.work_id, `${field}_work_id`),
      ...(parsed.data.message_id === undefined ? {} : { messageId: requiredId(parsed.data.message_id, `${field}_message_id`) })
    };
    case "knowledge": return {
      kind: "knowledge",
      roomId: requiredId(parsed.data.room_id, `${field}_room_id`),
      resourceId: requiredId(parsed.data.resource_id, `${field}_resource_id`)
    };
    case "interaction_request": return {
      kind: "interaction_request",
      roomId: requiredId(parsed.data.room_id, `${field}_room_id`),
      requestId: requiredId(parsed.data.request_id, `${field}_request_id`)
    };
    case "invitation": return { kind: "invitation", invitationId: requiredId(parsed.data.invitation_id, `${field}_invitation_id`) };
  }
}

function strictRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function assertAllowedKeys(value: Record<string, unknown>, keys: readonly string[], errorCode: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(errorCode);
}

function requiredText(value: unknown, errorCode: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(errorCode);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(errorCode);
  return normalized;
}

function requiredId(value: unknown, errorCode: string): string {
  if (typeof value !== "string") throw new Error(errorCode);
  const normalized = value.trim();
  if (!opaqueIdPattern.test(normalized)) throw new Error(errorCode);
  return normalized;
}

function requiredIds(value: unknown, errorCode: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error(errorCode);
  const ids = value.map((item) => requiredId(item, errorCode));
  if (new Set(ids).size !== ids.length) throw new Error(errorCode);
  return ids;
}

function optionalSearchTypes(value: unknown): WorkspaceSearchType[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("workspace_context_search_types_invalid");
  const types = value.map((item) => {
    if (typeof item !== "string" || !(allowedWorkspaceSearchTypes as readonly string[]).includes(item)) {
      throw new Error("workspace_context_search_types_invalid");
    }
    return item as WorkspaceSearchType;
  });
  if (new Set(types).size !== types.length) throw new Error("workspace_context_search_types_invalid");
  return types;
}

function pageInput(value: Record<string, unknown>, prefix: string): { limit?: number; cursor?: string } {
  const limit = value.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error(`${prefix}_limit_invalid`);
  }
  const cursor = value.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor.trim() || cursor.length > 4_096)) {
    throw new Error(`${prefix}_cursor_invalid`);
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor: (cursor as string).trim() })
  };
}

function domainResult(value: unknown, errorCode: string): unknown {
  const envelope = strictRecord(value, errorCode);
  if (!("result" in envelope)) throw new Error(errorCode);
  return envelope.result;
}

function assertReadResultScope(updatedIds: readonly string[], alreadyReadIds: readonly string[], requestedIds: readonly string[]): void {
  const requested = new Set(requestedIds);
  if (new Set(updatedIds).size !== updatedIds.length
    || new Set(alreadyReadIds).size !== alreadyReadIds.length
    || updatedIds.some((id) => !requested.has(id))
    || alreadyReadIds.some((id) => !requested.has(id))
    || updatedIds.some((id) => alreadyReadIds.includes(id))
    || new Set([...updatedIds, ...alreadyReadIds]).size !== requested.size) {
    throw new Error("workspace_notification_mark_read_response_scope_invalid");
  }
}
