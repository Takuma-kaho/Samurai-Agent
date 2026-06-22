<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  Archive,
  ArrowLeft,
  ArrowUp,
  Brain,
  Clock3,
  Eye,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  X
} from "lucide-vue-next";
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
import { supportedLocales } from "@samurai-agent/core-schemas";
import { type LocaleKey, t } from "@samurai-agent/localization";
import { io } from "socket.io-client";
import { api, ApiError, type ApprovalLifecyclePayload, type ArchiveMemoryPayload, type ArtifactDetail, type MemoryDetail, type SearchResult, type SessionDetail } from "./lib/api";

type ViewMode = "chat" | "search" | "settings" | "audit" | "memory";
type PromptAttachment = {
  id: string;
  name: string;
  previewUrl: string;
  size: number;
  type: string;
};
type ChatScrollState = {
  canScroll: boolean;
  atTop: boolean;
  atBottom: boolean;
};
type ChatDisplayMessage = {
  id: string;
  role: MessageRecord["role"];
  content: string;
  state?: "pending" | "loading";
};
type ProviderErrorReason =
  | "not_configured"
  | "auth_failed"
  | "rate_limited"
  | "temporary_unavailable"
  | "model_not_found"
  | "invalid_model"
  | "invalid_response"
  | "network"
  | "unknown";
type ProviderNotice = {
  error: "provider_not_configured" | "provider_failed";
  reason: ProviderErrorReason;
  provider?: string;
  model?: string;
  status?: number;
  retryable: boolean;
};

const settings = ref<SettingsRecord>({
  theme: "system",
  ui_locale: "ja",
  output_locale: "ja",
  updated_at: new Date().toISOString()
});
const sessions = ref<SessionRecord[]>([]);
const activeSession = ref<SessionRecord | null>(null);
const messages = ref<MessageRecord[]>([]);
const artifacts = ref<ArtifactRecord[]>([]);
const activity = ref<ActivityInboxItem[]>([]);
const auditRecords = ref<AuditRecord[]>([]);
const operations = ref<OperationRecord[]>([]);
const policyDecisions = ref<PolicyDecisionRecord[]>([]);
const approvalRequests = ref<ApprovalRequest[]>([]);
const rollbackPoints = ref<RollbackPoint[]>([]);
const memory = ref<Array<MemoryFrontmatter & { file_path: string }>>([]);
const searchResults = ref<SearchResult[]>([]);
const prompt = ref("");
const attachmentInput = ref<HTMLInputElement | null>(null);
const promptInput = ref<HTMLInputElement | null>(null);
const selectedAttachments = ref<PromptAttachment[]>([]);
const chatScrollRef = ref<HTMLDivElement | null>(null);
const chatLayoutRef = ref<HTMLDivElement | null>(null);
const chatScrollState = ref<ChatScrollState>({
  canScroll: false,
  atTop: true,
  atBottom: true
});
const searchQuery = ref("");
const viewMode = ref<ViewMode>("chat");
const drawerOpen = ref(false);
const sidebarCollapsed = ref(false);
const settingsReturnMode = ref<ViewMode>("chat");
const loading = ref(false);
const initializing = ref(true);
const sessionLoadError = ref(false);
const pendingUserMessage = ref<ChatDisplayMessage | null>(null);
const agentResponsePending = ref(false);
const providerNotice = ref<ProviderNotice | null>(null);
const providerNoticeDetailsOpen = ref(false);
const providerNoticeTitle = computed(() => (providerNotice.value ? label(`provider_error.${providerNotice.value.reason}.title` as LocaleKey) : ""));
const providerNoticeBody = computed(() => (providerNotice.value ? label(`provider_error.${providerNotice.value.reason}.body` as LocaleKey) : ""));
const providerNoticeDetails = computed(() => {
  if (!providerNotice.value) {
    return "";
  }
  const detail = [
    providerNotice.value.provider ? `provider=${providerNotice.value.provider}` : "",
    providerNotice.value.model ? `model=${providerNotice.value.model}` : "",
    providerNotice.value.status ? `status=${providerNotice.value.status}` : "",
    `retryable=${providerNotice.value.retryable ? "true" : "false"}`
  ].filter(Boolean);
  return detail.join(" / ");
});
const activeArtifact = ref<ArtifactDetail | null>(null);
const activeMemory = ref<MemoryDetail | null>(null);
const memoryContent = ref<Record<string, string>>({});
const workspaceSplitMin = 32;
const workspaceSplitMax = 68;
const workspaceSplitDefault = 50;
const workspaceSplitStorageKey = "samurai-agent.workspace-split-percent";
const workspaceSplitPercent = ref(readWorkspaceSplitPercent());
const isResizingWorkspace = ref(false);
let systemThemeMedia: MediaQueryList | undefined;
let chatScrollResizeObserver: ResizeObserver | undefined;
let observedChatScrollElement: HTMLDivElement | null = null;
let previousBodyCursor = "";
let previousBodyUserSelect = "";

const label = (key: LocaleKey) => t(settings.value.ui_locale, key);
const currentMessages = computed<ChatDisplayMessage[]>(() => {
  const displayMessages = messages.value.map(
    (message): ChatDisplayMessage => ({
      id: message.id,
      role: message.role,
      content: message.content
    })
  );
  if (pendingUserMessage.value) {
    displayMessages.push(pendingUserMessage.value);
  }
  if (agentResponsePending.value) {
    displayMessages.push({
      id: "pending-agent-response",
      role: "agent",
      content: "",
      state: "loading"
    });
  }
  return displayMessages;
});
const operationsById = computed(() => new Map(operations.value.map((operation) => [operation.id, operation])));
const approvalsById = computed(() => new Map(approvalRequests.value.map((request) => [request.id, request])));
const policyDecisionMap = computed(() => new Map(policyDecisions.value.map((decision) => [decision.id, decision])));
const activeActivity = computed(() =>
  activity.value.filter((item) => {
    if (!activeSession.value || !item.operation_id) {
      return true;
    }
    return operationsById.value.get(item.operation_id)?.session_id === activeSession.value.id;
  })
);
const hasActivity = computed(() => activeActivity.value.length > 0);
const firstMemory = computed(() => memory.value[0]);
const hasWorkspaceCanvas = computed(() => Boolean(activeArtifact.value || activeMemory.value));
const isDraftChat = computed(() => !activeSession.value && currentMessages.value.length === 0 && viewMode.value === "chat");
const chatScrollFrameClass = computed(() => ({
  "has-top-fade": chatScrollState.value.canScroll && !chatScrollState.value.atTop,
  "has-bottom-fade": chatScrollState.value.canScroll && !chatScrollState.value.atBottom
}));
const workspaceSplitStyle = computed<Record<string, string>>(() => ({
  "--workspace-chat-percent": `${workspaceSplitPercent.value}%`,
  "--workspace-canvas-percent": `${100 - workspaceSplitPercent.value}%`
}));

onMounted(async () => {
  settings.value = await api.getSettings();
  systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeMedia.addEventListener("change", handleSystemThemeChange);
  applyTheme(settings.value.theme);
  connectSocket();
  await loadSessionsWithRetry();
});

onUnmounted(() => {
  systemThemeMedia?.removeEventListener("change", handleSystemThemeChange);
  chatScrollResizeObserver?.disconnect();
  finishWorkspaceResize();
  clearAttachments();
});

watch(
  () => settings.value.theme,
  (theme) => applyTheme(theme)
);

watch(
  [() => currentMessages.value.length, () => artifacts.value.length, () => memory.value.length, () => selectedAttachments.value.length, hasWorkspaceCanvas, viewMode],
  () => scheduleChatScrollCheck()
);

async function loadSessions() {
  sessions.value = await api.listSessions();
  if (sessions.value.length === 0) {
    startDraftChat();
    return;
  }
  const currentSession = activeSession.value ? sessions.value.find((session) => session.id === activeSession.value?.id) : undefined;
  if (currentSession) {
    await openSession(currentSession.id);
    return;
  }
  if (sessions.value[0]) {
    await openSession(sessions.value[0].id);
  }
}

async function loadSessionsWithRetry() {
  const retryDelays = [250, 600, 1000];
  initializing.value = true;
  sessionLoadError.value = false;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      await loadSessions();
      sessionLoadError.value = false;
      initializing.value = false;
      return;
    } catch {
      if (attempt === retryDelays.length) {
        sessionLoadError.value = true;
        initializing.value = false;
        return;
      }
      await wait(retryDelays[attempt] ?? 0);
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function startDraftChat() {
  activeSession.value = null;
  messages.value = [];
  pendingUserMessage.value = null;
  agentResponsePending.value = false;
  artifacts.value = [];
  operations.value = [];
  auditRecords.value = [];
  policyDecisions.value = [];
  approvalRequests.value = [];
  rollbackPoints.value = [];
  memory.value = [];
  activity.value = [];
  activeArtifact.value = null;
  activeMemory.value = null;
  prompt.value = "";
  clearAttachments();
  viewMode.value = "chat";
  schedulePromptFocus();
}

async function openSession(sessionId: string) {
  const detail = await api.getSession(sessionId);
  await applySessionDetail(detail);
  await refreshAuditContext();
  viewMode.value = "chat";
}

async function sendMessage() {
  if (prompt.value.trim().length === 0 || loading.value) {
    return;
  }
  const content = prompt.value.trim();
  prompt.value = "";
  loading.value = true;
  pendingUserMessage.value = {
    id: `pending-user-${Date.now()}`,
    role: "user",
    content,
    state: "pending"
  };
  agentResponsePending.value = true;
  try {
    providerNotice.value = null;
    providerNoticeDetailsOpen.value = false;
    const result = activeSession.value
      ? await api.sendMessage(activeSession.value.id, content, settings.value.output_locale)
      : await api.startChat(content, settings.value.ui_locale, settings.value.output_locale);
    pendingUserMessage.value = null;
    agentResponsePending.value = false;
    activeSession.value = result.session;
    promoteSessionToTop(result.session);
    messages.value.push(...result.messages);
    artifacts.value = [...result.artifacts, ...artifacts.value];
    auditRecords.value = [...result.auditRecords, ...auditRecords.value];
    operations.value = [...result.operations, ...operations.value];
    policyDecisions.value = [...result.policyDecisions, ...policyDecisions.value];
    approvalRequests.value = [...result.approvalRequests, ...approvalRequests.value];
    rollbackPoints.value = [...result.rollbackPoints, ...rollbackPoints.value];
    activity.value = result.activity;
    await reloadActiveSession();
    clearAttachments();
  } catch (error) {
    pendingUserMessage.value = null;
    agentResponsePending.value = false;
    prompt.value = content;
    if (error instanceof ApiError && isRecord(error.body)) {
      if (error.body.error === "provider_not_configured" || error.body.error === "provider_failed") {
        providerNotice.value = normalizeProviderNotice(error.body);
        return;
      }
    }
    throw error;
  } finally {
    loading.value = false;
  }
}

function schedulePromptFocus() {
  void nextTick(() => {
    promptInput.value?.focus();
    updateChatScrollState();
  });
}

function openAttachmentPicker() {
  attachmentInput.value?.click();
}

function handleAttachmentSelection(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  clearAttachments();
  selectedAttachments.value = files.map((file) => ({
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    previewUrl: URL.createObjectURL(file),
    size: file.size,
    type: file.type
  }));
  input.value = "";
}

function removeAttachment(id: string) {
  const attachment = selectedAttachments.value.find((item) => item.id === id);
  if (attachment) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
  selectedAttachments.value = selectedAttachments.value.filter((item) => item.id !== id);
}

function clearAttachments() {
  selectedAttachments.value.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
  selectedAttachments.value = [];
}

function formatFileSize(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function scheduleChatScrollCheck() {
  void nextTick(() => {
    bindChatScrollObserver();
    updateChatScrollState();
  });
}

function bindChatScrollObserver() {
  const element = chatScrollRef.value;
  if (observedChatScrollElement === element) {
    return;
  }
  chatScrollResizeObserver?.disconnect();
  observedChatScrollElement = element;
  if (!element) {
    return;
  }
  chatScrollResizeObserver = new ResizeObserver(() => updateChatScrollState());
  chatScrollResizeObserver.observe(element);
}

function updateChatScrollState() {
  const element = chatScrollRef.value;
  if (!element) {
    chatScrollState.value = {
      canScroll: false,
      atTop: true,
      atBottom: true
    };
    return;
  }
  const threshold = 2;
  const canScroll = element.scrollHeight > element.clientHeight + threshold;
  const atTop = element.scrollTop <= threshold;
  const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;
  chatScrollState.value = {
    canScroll,
    atTop,
    atBottom
  };
}

function readWorkspaceSplitPercent(): number {
  if (typeof window === "undefined") {
    return workspaceSplitDefault;
  }
  try {
    const stored = window.localStorage.getItem(workspaceSplitStorageKey);
    if (!stored) {
      return workspaceSplitDefault;
    }
    return normalizeWorkspaceSplitPercent(Number(stored));
  } catch {
    return workspaceSplitDefault;
  }
}

function normalizeWorkspaceSplitPercent(value: number): number {
  const normalized = Number.isFinite(value) ? value : workspaceSplitDefault;
  return Math.min(workspaceSplitMax, Math.max(workspaceSplitMin, Math.round(normalized * 10) / 10));
}

function persistWorkspaceSplitPercent() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(workspaceSplitStorageKey, String(workspaceSplitPercent.value));
  } catch {
    // localStorage can be unavailable in private/restricted contexts.
  }
}

function setWorkspaceSplitPercent(value: number, persist = false) {
  workspaceSplitPercent.value = normalizeWorkspaceSplitPercent(value);
  if (persist) {
    persistWorkspaceSplitPercent();
  }
}

function beginWorkspaceResize(event: PointerEvent) {
  if (!hasWorkspaceCanvas.value || !chatLayoutRef.value) {
    return;
  }
  event.preventDefault();
  isResizingWorkspace.value = true;
  previousBodyCursor = document.body.style.cursor;
  previousBodyUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  updateWorkspaceSplitFromPointer(event);
  window.addEventListener("pointermove", handleWorkspaceResizeMove);
  window.addEventListener("pointerup", finishWorkspaceResize);
  window.addEventListener("pointercancel", finishWorkspaceResize);
}

function handleWorkspaceResizeMove(event: PointerEvent) {
  if (!isResizingWorkspace.value) {
    return;
  }
  event.preventDefault();
  updateWorkspaceSplitFromPointer(event);
}

function updateWorkspaceSplitFromPointer(event: PointerEvent) {
  const rect = chatLayoutRef.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0) {
    return;
  }
  const percent = ((event.clientX - rect.left) / rect.width) * 100;
  setWorkspaceSplitPercent(percent);
}

function finishWorkspaceResize() {
  if (!isResizingWorkspace.value) {
    return;
  }
  isResizingWorkspace.value = false;
  document.body.style.cursor = previousBodyCursor;
  document.body.style.userSelect = previousBodyUserSelect;
  window.removeEventListener("pointermove", handleWorkspaceResizeMove);
  window.removeEventListener("pointerup", finishWorkspaceResize);
  window.removeEventListener("pointercancel", finishWorkspaceResize);
  persistWorkspaceSplitPercent();
}

function handleWorkspaceResizerKeydown(event: KeyboardEvent) {
  if (!hasWorkspaceCanvas.value) {
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setWorkspaceSplitPercent(workspaceSplitPercent.value - 4, true);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    setWorkspaceSplitPercent(workspaceSplitPercent.value + 4, true);
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    setWorkspaceSplitPercent(workspaceSplitMin, true);
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    setWorkspaceSplitPercent(workspaceSplitMax, true);
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setWorkspaceSplitPercent(workspaceSplitDefault, true);
  }
}

async function runSearch() {
  viewMode.value = "search";
  searchResults.value = await api.search(searchQuery.value);
}

async function chooseResult(result: SearchResult) {
  if (result.kind === "session") {
    await openSession(result.id);
    viewMode.value = "chat";
    return;
  }
  if (result.kind === "message" && result.session_id) {
    await openSession(result.session_id);
    viewMode.value = "chat";
    return;
  }
  if (result.kind === "artifact") {
    if (result.session_id) {
      await openSession(result.session_id);
    }
    await openArtifact(result.id);
    viewMode.value = "chat";
    return;
  }
  if (result.kind === "audit") {
    if (result.session_id) {
      await openSession(result.session_id);
    }
    await loadAudit();
  }
}

async function loadAudit() {
  const payload = await api.getAudit();
  auditRecords.value = payload.auditRecords;
  operations.value = payload.operations;
  policyDecisions.value = payload.policyDecisions;
  approvalRequests.value = payload.approvalRequests;
  rollbackPoints.value = payload.rollbackPoints;
  viewMode.value = "audit";
}

async function loadMemory() {
  if (activeSession.value) {
    await reloadActiveSession();
  } else {
    memory.value = await api.listMemory();
    await hydrateMemoryContent(memory.value);
  }
  viewMode.value = "memory";
}

function openSettings() {
  if (viewMode.value !== "settings") {
    settingsReturnMode.value = viewMode.value;
  }
  viewMode.value = "settings";
}

function returnFromSettings() {
  viewMode.value = settingsReturnMode.value === "settings" ? "chat" : settingsReturnMode.value;
}

function retryProviderRequest() {
  void sendMessage();
}

async function patchSettings(patch: Partial<Pick<SettingsRecord, "theme" | "ui_locale" | "output_locale">>) {
  settings.value = await api.patchSettings(patch);
}

async function openArtifact(id: string) {
  activeArtifact.value = await api.getArtifact(id);
  activeMemory.value = null;
}

async function openMemory(id: string) {
  activeMemory.value = await api.getMemory(id);
  activeArtifact.value = null;
  memoryContent.value = {
    ...memoryContent.value,
    [id]: activeMemory.value.content
  };
}

function closeWorkspaceCanvas() {
  activeArtifact.value = null;
  activeMemory.value = null;
}

async function archiveMemoryItem(id: string) {
  if (!activeSession.value) {
    return;
  }
  const payload = await api.archiveMemory(id, activeSession.value.id);
  applyArchiveMemory(payload);
  await reloadActiveSession();
}

async function approveActivity(item: ActivityInboxItem) {
  if (!item.approval_request_id) {
    return;
  }
  await handleApprovalLifecycle(() => api.approveApprovalRequest(item.approval_request_id!));
}

async function denyActivity(item: ActivityInboxItem) {
  if (!item.approval_request_id) {
    return;
  }
  await handleApprovalLifecycle(() => api.denyApprovalRequest(item.approval_request_id!, label("approval.denied_reason")));
}

async function handleApprovalLifecycle(action: () => Promise<ApprovalLifecyclePayload>) {
  try {
    applyApprovalLifecycle(await action());
  } catch (error) {
    if (error instanceof ApiError && isApprovalLifecyclePayload(error.body)) {
      applyApprovalLifecycle(error.body);
      return;
    }
    throw error;
  }
}

async function refreshAuditContext() {
  const payload = await api.getAudit();
  auditRecords.value = payload.auditRecords;
  operations.value = mergeById(payload.operations, operations.value);
  policyDecisions.value = payload.policyDecisions;
  approvalRequests.value = payload.approvalRequests;
  rollbackPoints.value = payload.rollbackPoints;
}

function applyApprovalLifecycle(payload: ApprovalLifecyclePayload) {
  approvalRequests.value = [payload.approvalRequest, ...approvalRequests.value.filter((item) => item.id !== payload.approvalRequest.id)];
  operations.value = [payload.operation, ...operations.value.filter((item) => item.id !== payload.operation.id)];
  auditRecords.value = [payload.auditRecord, ...auditRecords.value.filter((item) => item.id !== payload.auditRecord.id)];
  activity.value = payload.activity;
}

function applyArchiveMemory(payload: ArchiveMemoryPayload) {
  operations.value = [payload.operation, ...operations.value.filter((item) => item.id !== payload.operation.id)];
  auditRecords.value = [payload.auditRecord, ...auditRecords.value.filter((item) => item.id !== payload.auditRecord.id)];
  if (payload.rollbackPoint) {
    rollbackPoints.value = [payload.rollbackPoint, ...rollbackPoints.value.filter((item) => item.id !== payload.rollbackPoint?.id)];
  }
  activity.value = payload.activity;
  memory.value = memory.value.filter((item) => item.id !== payload.memory.id);
  if (activeMemory.value?.memory.id === payload.memory.id) {
    activeMemory.value = null;
  }
}

async function applySessionDetail(detail: SessionDetail) {
  activeSession.value = detail.session;
  updateSessionInPlace(detail.session);
  messages.value = detail.messages;
  operations.value = detail.operations;
  artifacts.value = detail.artifacts;
  auditRecords.value = detail.auditRecords;
  memory.value = detail.memory;
  activity.value = detail.activity;
  if (activeArtifact.value && !detail.artifacts.some((artifact) => artifact.id === activeArtifact.value?.artifact.id)) {
    activeArtifact.value = null;
  }
  if (activeMemory.value && !detail.memory.some((item) => item.id === activeMemory.value?.memory.id)) {
    activeMemory.value = null;
  }
  await hydrateMemoryContent(detail.memory);
}

async function reloadActiveSession() {
  if (!activeSession.value) {
    return;
  }
  await applySessionDetail(await api.getSession(activeSession.value.id));
}

async function hydrateMemoryContent(items: Array<MemoryFrontmatter & { file_path: string }>) {
  const missing = items.filter((item) => memoryContent.value[item.id] === undefined);
  if (missing.length === 0) {
    return;
  }
  const details = await Promise.all(missing.map((item) => api.getMemory(item.id).catch(() => undefined)));
  memoryContent.value = {
    ...memoryContent.value,
    ...Object.fromEntries(details.filter((item): item is MemoryDetail => Boolean(item)).map((item) => [item.memory.id, item.content]))
  };
}

function activityLabel(item: ActivityInboxItem): string {
  return label(`activity.type.${item.activity_type}` as LocaleKey);
}

function auditStatus(audit: AuditRecord): string {
  const operation = operationsById.value.get(audit.operation_id);
  const approval = operation?.approval_request_id ? approvalsById.value.get(operation.approval_request_id) : undefined;
  if (approval?.status === "pending") {
    return label("approval.status.pending");
  }
  if (approval?.status === "approved" && operation?.status === "deferred") {
    return label("approval.status.approved_deferred");
  }
  if (approval?.status === "denied" || operation?.status === "denied") {
    return label("approval.status.denied");
  }
  if (approval?.status === "expired") {
    return label("approval.status.expired");
  }
  if (approval?.status === "cancelled") {
    return label("approval.status.cancelled");
  }
  if (operation?.status === "completed") {
    return label("approval.status.completed");
  }
  if (operation?.status === "deferred") {
    return label("approval.status.deferred");
  }
  return label("approval.status.recorded");
}

function memoryExcerpt(id: string): string {
  return (memoryContent.value[id] ?? "").replace(/\s+/g, " ").slice(0, 150);
}

function artifactPreview(artifact: ArtifactRecord): string {
  const preview = artifact.metadata.preview;
  return typeof preview === "string" ? preview.replace(/\s+/g, " ").trim().slice(0, 140) : "";
}

function memoryStateLabel(state: MemoryFrontmatter["state"]): string {
  return label(`memory.state.${state}` as LocaleKey);
}

function searchKindLabel(kind: SearchResult["kind"]): string {
  return label(`search.kind.${kind}` as LocaleKey);
}

function sessionDisplayTitle(session: SessionRecord): string {
  return displayTitle(session.title);
}

function resultDisplayTitle(result: SearchResult): string {
  return displayTitle(result.title);
}

function localeDisplayName(locale: SupportedLocale): string {
  return label(`locale.${locale}` as LocaleKey);
}

function displayTitle(title: string): string {
  return isInitialTitle(title) ? label("session.fallback_title") : title;
}

function isInitialTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "" || normalized === "new chat" || normalized === "untitled chat";
}

function updateSessionInPlace(session: SessionRecord) {
  const index = sessions.value.findIndex((item) => item.id === session.id);
  if (index === -1) {
    sessions.value = [...sessions.value, session];
    return;
  }
  sessions.value = sessions.value.map((item) => (item.id === session.id ? session : item));
}

function promoteSessionToTop(session: SessionRecord) {
  sessions.value = [session, ...sessions.value.filter((item) => item.id !== session.id)];
}

function connectSocket() {
  const socket = io();
  socket.on("session.created", (session: SessionRecord) => {
    if (isInitialTitle(session.title)) {
      return;
    }
    updateSessionInPlace(session);
  });
  socket.on("activity.updated", (items: ActivityInboxItem[]) => {
    activity.value = items;
  });
  socket.on("approval.requested", (request: ApprovalRequest) => {
    approvalRequests.value = [request, ...approvalRequests.value.filter((item) => item.id !== request.id)];
  });
  socket.on("operation.created", (operation: OperationRecord) => {
    operations.value = [operation, ...operations.value.filter((item) => item.id !== operation.id)];
  });
  socket.on("policy.decided", (decision: PolicyDecisionRecord) => {
    policyDecisions.value = [decision, ...policyDecisions.value.filter((item) => item.id !== decision.id)];
  });
  socket.on("settings.updated", (next: SettingsRecord) => {
    settings.value = next;
  });
  socket.on("artifact.created", () => {
    void reloadActiveSession();
  });
  socket.on("memory.candidate.created", () => {
    void reloadActiveSession();
  });
}

function applyTheme(theme: SettingsRecord["theme"]) {
  const systemDark = systemThemeMedia?.matches ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.body.dataset.theme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

function handleSystemThemeChange() {
  if (settings.value.theme === "system") {
    applyTheme("system");
  }
}

function mergeById<T extends { id: string }>(primary: T[], fallback: T[]): T[] {
  return [...new Map([...primary, ...fallback].map((item) => [item.id, item])).values()];
}

function isApprovalLifecyclePayload(value: unknown): value is ApprovalLifecyclePayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "approvalRequest" in value &&
    "operation" in value &&
    "auditRecord" in value &&
    "activity" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProviderNotice(value: Record<string, unknown>): ProviderNotice {
  const error = value.error === "provider_not_configured" ? "provider_not_configured" : "provider_failed";
  const reason = isProviderErrorReason(value.reason) ? value.reason : error === "provider_not_configured" ? "not_configured" : "unknown";
  return {
    error,
    reason,
    provider: typeof value.provider === "string" ? value.provider : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    status: typeof value.status === "number" ? value.status : undefined,
    retryable: value.retryable === true
  };
}

function isProviderErrorReason(value: unknown): value is ProviderErrorReason {
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
</script>

<template>
  <main class="app-shell" :class="{ 'has-drawer': drawerOpen, 'sidebar-collapsed': sidebarCollapsed }">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-symbol">S</div>
        <div class="brand-name">{{ label("app.name") }}</div>
        <button
          class="sidebar-toggle icon-button"
          type="button"
          :title="sidebarCollapsed ? label('nav.expand_sidebar') : label('nav.collapse_sidebar')"
          :aria-label="sidebarCollapsed ? label('nav.expand_sidebar') : label('nav.collapse_sidebar')"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          <PanelLeftOpen v-if="sidebarCollapsed" :size="16" />
          <PanelLeftClose v-else :size="16" />
        </button>
      </div>

      <nav class="nav-block">
        <button
          class="nav-item"
          :class="{ 'is-active': isDraftChat }"
          type="button"
          :title="label('nav.new_chat')"
          :aria-label="label('nav.new_chat')"
          @click="startDraftChat"
        >
          <Plus :size="16" />
          <span>{{ label("nav.new_chat") }}</span>
        </button>
        <button
          class="nav-item"
          :class="{ 'is-active': viewMode === 'search' }"
          type="button"
          :title="label('nav.search')"
          :aria-label="label('nav.search')"
          @click="viewMode = 'search'"
        >
          <Search :size="16" />
          <span>{{ label("nav.search") }}</span>
        </button>
      </nav>

      <section class="session-list" :aria-label="label('nav.sessions')">
        <div class="section-label">{{ label("nav.sessions") }}</div>
        <div v-if="initializing" class="session-state">
          <span class="state-pulse" aria-hidden="true"></span>
          <span>{{ label("session.loading") }}</span>
        </div>
        <div v-else-if="sessionLoadError" class="session-state is-error">
          <span>{{ label("session.load_failed") }}</span>
          <button type="button" @click="loadSessionsWithRetry">{{ label("session.reload") }}</button>
        </div>
        <button
          v-for="session in sessions"
          :key="session.id"
          class="session-item"
          :class="{ 'is-current': viewMode === 'chat' && activeSession?.id === session.id }"
          type="button"
          :title="sessionDisplayTitle(session)"
          @click="openSession(session.id)"
        >
          <span>{{ sessionDisplayTitle(session) }}</span>
        </button>
      </section>

      <div class="sidebar-footer">
        <button
          class="nav-item footer-button"
          :class="{ 'is-active': viewMode === 'settings' }"
          type="button"
          :title="label('nav.settings')"
          :aria-label="label('nav.settings')"
          @click="openSettings"
        >
          <Settings :size="16" />
          <span>{{ label("nav.settings") }}</span>
        </button>
      </div>
    </aside>

    <section class="main-stage">
      <header class="stage-header">
        <div class="stage-heading" :class="{ 'is-chat': viewMode === 'chat' }">
          <button v-if="viewMode === 'settings'" class="icon-button stage-back-button" type="button" :title="label('action.back')" :aria-label="label('action.back')" @click="returnFromSettings">
            <ArrowLeft :size="16" />
          </button>
          <div v-if="viewMode !== 'chat'" class="stage-title">
            <span v-if="viewMode === 'search'">{{ label("search.title") }}</span>
            <span v-else-if="viewMode === 'settings'">{{ label("settings.title") }}</span>
            <span v-else-if="viewMode === 'audit'">{{ label("audit.title") }}</span>
            <span v-else>{{ label("memory.title") }}</span>
          </div>
        </div>
        <div class="stage-actions">
          <button class="icon-button" type="button" :title="label('memory.title')" :aria-label="label('memory.title')" @click="loadMemory">
            <Brain :size="17" />
          </button>
          <button class="icon-button" type="button" :title="label('audit.title')" :aria-label="label('audit.title')" @click="loadAudit">
            <ShieldCheck :size="17" />
          </button>
          <button class="icon-button" :class="{ 'has-badge': hasActivity }" type="button" :title="label('context.title')" :aria-label="label('context.title')" @click="drawerOpen = !drawerOpen">
            <PanelRightOpen :size="17" />
          </button>
        </div>
      </header>

      <section v-if="viewMode === 'chat'" class="chat-stage" :class="{ 'has-workspace': hasWorkspaceCanvas }">
        <div
          ref="chatLayoutRef"
          class="chat-layout"
          :class="{ 'has-workspace': hasWorkspaceCanvas, 'is-resizing-workspace': isResizingWorkspace }"
          :style="workspaceSplitStyle"
        >
          <div class="chat-column" :class="{ 'is-empty': isDraftChat }">
            <div class="chat-scroll-frame" :class="chatScrollFrameClass">
              <div ref="chatScrollRef" class="chat-scroll" @scroll="updateChatScrollState">
                <div v-if="currentMessages.length === 0" class="empty-composition">
                  <h1>{{ label("chat.empty_title") }}</h1>
                </div>

                <div v-else class="conversation-frame">
                  <div class="conversation">
                    <article
                      v-for="message in currentMessages"
                      :key="message.id"
                      class="message"
                      :class="[message.role === 'user' ? 'message-user' : 'message-agent', { 'message-pending': message.state === 'pending', 'message-loading': message.state === 'loading' }]"
                    >
                      <p v-if="message.state !== 'loading'">{{ message.content }}</p>
                      <div v-else class="typing-dots" :aria-label="label('chat.waiting')">
                        <span></span>
                        <span></span>
                        <span></span>
                      </div>
                    </article>

                    <article v-for="artifact in artifacts.slice(0, 3)" :key="artifact.id" class="artifact-card artifact-notice feed-card lit-surface">
                      <button class="feed-card-main" type="button" @click="openArtifact(artifact.id)">
                        <span class="artifact-created">{{ label("artifact.created") }}</span>
                        <strong class="feed-card-title">{{ artifact.title }}</strong>
                        <span v-if="artifactPreview(artifact)" class="feed-card-summary">{{ artifactPreview(artifact) }}</span>
                      </button>
                    </article>
                  </div>
                </div>
                <div v-if="providerNotice" class="provider-notice lit-surface">
                  <div class="provider-notice-main">
                    <strong>{{ providerNoticeTitle }}</strong>
                    <span>{{ providerNoticeBody }}</span>
                  </div>
                  <div class="provider-notice-actions">
                    <button type="button" @click="retryProviderRequest">{{ label("provider_error.retry") }}</button>
                    <button v-if="providerNoticeDetails" type="button" @click="providerNoticeDetailsOpen = !providerNoticeDetailsOpen">
                      {{ providerNoticeDetailsOpen ? label("provider_error.hide_details") : label("provider_error.show_details") }}
                    </button>
                  </div>
                  <code v-if="providerNoticeDetailsOpen && providerNoticeDetails" class="provider-notice-details">{{ providerNoticeDetails }}</code>
                </div>
              </div>
            </div>
            <div class="prompt-dock">
              <form class="prompt-card lit-surface" @submit.prevent="sendMessage">
                <div v-if="selectedAttachments.length > 0" class="attachment-strip">
                  <div v-for="attachment in selectedAttachments" :key="attachment.id" class="attachment-chip">
                    <img v-if="attachment.type.startsWith('image/')" :src="attachment.previewUrl" :alt="label('chat.attachment_image')" />
                    <div class="attachment-meta">
                      <span>{{ attachment.name }}</span>
                      <small>{{ formatFileSize(attachment.size) }}</small>
                    </div>
                    <button type="button" :aria-label="label('chat.remove_attachment')" @click="removeAttachment(attachment.id)">
                      <X :size="13" />
                    </button>
                  </div>
                </div>
                <button class="prompt-action attach-button" type="button" :aria-label="label('chat.attach')" @click="openAttachmentPicker">
                  <Plus :size="16" />
                </button>
                <input ref="attachmentInput" class="file-input" type="file" accept="image/*" multiple @change="handleAttachmentSelection" />
                <input ref="promptInput" v-model="prompt" :placeholder="label('chat.placeholder')" :aria-label="label('chat.placeholder')" />
                <button class="prompt-action send-button" type="submit" :aria-label="label('chat.send')" :disabled="loading">
                  <ArrowUp :size="16" />
                </button>
              </form>
            </div>
          </div>

          <button
            class="workspace-resizer"
            :class="{ open: hasWorkspaceCanvas }"
            type="button"
            role="separator"
            aria-orientation="vertical"
            :aria-label="label('workspace.resize')"
            :aria-valuemin="workspaceSplitMin"
            :aria-valuemax="workspaceSplitMax"
            :aria-valuenow="Math.round(workspaceSplitPercent)"
            :aria-hidden="!hasWorkspaceCanvas"
            :disabled="!hasWorkspaceCanvas"
            :tabindex="hasWorkspaceCanvas ? 0 : -1"
            @pointerdown="beginWorkspaceResize"
            @keydown="handleWorkspaceResizerKeydown"
          />

          <aside class="workspace-canvas" :class="{ open: hasWorkspaceCanvas }" :aria-hidden="!hasWorkspaceCanvas">
            <div v-if="hasWorkspaceCanvas" class="workspace-canvas-inner">
              <header class="workspace-head">
                <div>
                  <span v-if="activeMemory" class="artifact-type">{{ label("memory.title") }}</span>
                  <h2>{{ activeArtifact ? activeArtifact.artifact.title : activeMemory?.memory.topic }}</h2>
                </div>
                <button class="icon-button" type="button" :title="label('action.close')" :aria-label="label('action.close')" @click="closeWorkspaceCanvas">
                  <X :size="16" />
                </button>
              </header>

              <template v-if="activeArtifact">
                <pre class="document-surface">{{ activeArtifact.content }}</pre>
              </template>

              <template v-else-if="activeMemory">
                <div class="workspace-meta">
                  <span>{{ memoryStateLabel(activeMemory.memory.state) }}</span>
                  <span>{{ label("memory.source") }}: {{ activeMemory.memory.source }}</span>
                </div>
                <pre class="document-surface">{{ activeMemory.content }}</pre>
              </template>
            </div>
          </aside>
        </div>
      </section>

      <section v-else-if="viewMode === 'search'" class="panel-stage">
        <form class="search-row lit-surface" @submit.prevent="runSearch">
          <Search :size="17" />
          <input v-model="searchQuery" :placeholder="label('search.placeholder')" />
        </form>
        <div class="result-list">
          <div v-if="searchResults.length === 0" class="empty-note">{{ label("search.empty") }}</div>
          <button v-for="result in searchResults" :key="`${result.kind}-${result.id}`" class="result-item lit-surface" type="button" @click="chooseResult(result)">
            <span class="result-kind">{{ searchKindLabel(result.kind) }}</span>
            <strong>{{ resultDisplayTitle(result) }}</strong>
            <span>{{ result.summary }}</span>
          </button>
        </div>
      </section>

      <section v-else-if="viewMode === 'settings'" class="panel-stage settings-stage">
        <div class="settings-group lit-surface">
          <div class="settings-head">{{ label("settings.theme") }}</div>
          <div class="segmented">
            <button :class="{ active: settings.theme === 'light' }" type="button" @click="patchSettings({ theme: 'light' })">
              <Sun :size="16" />
              {{ label("theme.light") }}
            </button>
            <button :class="{ active: settings.theme === 'dark' }" type="button" @click="patchSettings({ theme: 'dark' })">
              <Moon :size="16" />
              {{ label("theme.dark") }}
            </button>
            <button :class="{ active: settings.theme === 'system' }" type="button" @click="patchSettings({ theme: 'system' })">
              <Monitor :size="16" />
              {{ label("theme.system") }}
            </button>
          </div>
        </div>

        <div class="settings-group lit-surface">
          <div class="settings-head">{{ label("settings.language") }}</div>
          <label>
            <span>{{ label("settings.ui_locale") }}</span>
            <select :value="settings.ui_locale" @change="patchSettings({ ui_locale: ($event.target as HTMLSelectElement).value as SupportedLocale })">
              <option v-for="locale in supportedLocales" :key="locale" :value="locale">{{ localeDisplayName(locale) }}</option>
            </select>
          </label>
          <label>
            <span>{{ label("settings.output_locale") }}</span>
            <select :value="settings.output_locale" @change="patchSettings({ output_locale: ($event.target as HTMLSelectElement).value as SupportedLocale })">
              <option v-for="locale in supportedLocales" :key="locale" :value="locale">{{ localeDisplayName(locale) }}</option>
            </select>
          </label>
        </div>
      </section>

      <section v-else-if="viewMode === 'audit'" class="panel-stage">
        <div v-if="auditRecords.length === 0" class="empty-note">{{ label("audit.empty") }}</div>
        <article v-for="audit in auditRecords" :key="audit.id" class="audit-item lit-surface">
          <Clock3 :size="16" />
          <div>
            <strong>{{ auditStatus(audit) }}</strong>
            <p>{{ audit.inputs_summary }}</p>
            <span>{{ audit.outputs_summary }}</span>
          </div>
        </article>
      </section>

      <section v-else class="panel-stage">
        <div v-if="memory.length === 0" class="empty-note">{{ label("memory.empty") }}</div>
        <article v-for="item in memory" :key="item.id" class="memory-item lit-surface">
          <span class="status-pill">{{ memoryStateLabel(item.state) }}</span>
          <strong>{{ item.topic }}</strong>
          <p>{{ memoryExcerpt(item.id) || item.source }}</p>
          <div class="memory-actions">
            <button type="button" @click="openMemory(item.id)">
              <Eye :size="14" />
              {{ label("memory.open") }}
            </button>
            <button v-if="activeSession" type="button" @click="archiveMemoryItem(item.id)">
              <Archive :size="14" />
              {{ label("memory.archive") }}
            </button>
          </div>
        </article>
        <article v-if="activeMemory" class="memory-detail lit-surface">
          <div class="drawer-card-head">
            <span>{{ activeMemory.memory.topic }}</span>
            <span class="status-pill">{{ memoryStateLabel(activeMemory.memory.state) }}</span>
          </div>
          <pre class="document-surface">{{ activeMemory.content }}</pre>
        </article>
      </section>
    </section>

    <aside class="context-drawer" :class="{ open: drawerOpen }" :aria-hidden="!drawerOpen">
      <header class="drawer-header">
        <div class="drawer-title">{{ label("context.title") }}</div>
        <button class="icon-button" type="button" :title="label('action.close')" :aria-label="label('action.close')" @click="drawerOpen = false">
          <X :size="16" />
        </button>
      </header>

      <section class="drawer-card lit-surface">
        <div class="drawer-card-head">
          <span>{{ label("activity.title") }}</span>
          <span class="status-pill">{{ activeActivity.length }}</span>
        </div>
        <p v-if="activeActivity.length === 0">{{ label("activity.empty") }}</p>
        <ol v-else class="activity-list">
          <li v-for="item in activeActivity.slice(0, 6)" :key="item.id">
            <span>{{ activityLabel(item) }}</span>
            <strong>{{ activityLabel(item) }}</strong>
            <p>{{ item.summary }}</p>
            <div v-if="item.activity_type === 'approval_required'" class="approval-actions">
              <button type="button" @click="approveActivity(item)">{{ label("approval.approve") }}</button>
              <button type="button" @click="denyActivity(item)">{{ label("approval.deny") }}</button>
            </div>
          </li>
        </ol>
      </section>

      <section class="drawer-card lit-surface">
        <div class="drawer-card-head">
          <span>{{ label("memory.title") }}</span>
          <span class="status-pill">{{ memory.length }}</span>
        </div>
        <p v-if="!firstMemory">{{ label("memory.empty") }}</p>
        <div v-else class="drawer-memory">
          <strong>{{ firstMemory.topic }}</strong>
          <p>{{ memoryExcerpt(firstMemory.id) || memoryStateLabel(firstMemory.state) }}</p>
          <button type="button" @click="openMemory(firstMemory.id)">{{ label("memory.open") }}</button>
        </div>
      </section>
    </aside>
  </main>
</template>
