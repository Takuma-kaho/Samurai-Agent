<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import Archive from "lucide-vue-next/dist/esm/icons/archive.js";
import ArrowDown from "lucide-vue-next/dist/esm/icons/arrow-down.js";
import ArrowLeft from "lucide-vue-next/dist/esm/icons/arrow-left.js";
import ArrowUp from "lucide-vue-next/dist/esm/icons/arrow-up.js";
import Brain from "lucide-vue-next/dist/esm/icons/brain.js";
import BookOpen from "lucide-vue-next/dist/esm/icons/book-open.js";
import CalendarClock from "lucide-vue-next/dist/esm/icons/calendar-clock.js";
import ChevronRight from "lucide-vue-next/dist/esm/icons/chevron-right.js";
import Clock3 from "lucide-vue-next/dist/esm/icons/clock-3.js";
import Copy from "lucide-vue-next/dist/esm/icons/copy.js";
import Eye from "lucide-vue-next/dist/esm/icons/eye.js";
import FileInput from "lucide-vue-next/dist/esm/icons/file-input.js";
import FileText from "lucide-vue-next/dist/esm/icons/file-text.js";
import Maximize2 from "lucide-vue-next/dist/esm/icons/maximize-2.js";
import PanelLeft from "lucide-vue-next/dist/esm/icons/panel-left.js";
import PanelRightOpen from "lucide-vue-next/dist/esm/icons/panel-right-open.js";
import Pencil from "lucide-vue-next/dist/esm/icons/pencil.js";
import Plus from "lucide-vue-next/dist/esm/icons/plus.js";
import RotateCcw from "lucide-vue-next/dist/esm/icons/rotate-ccw.js";
import Save from "lucide-vue-next/dist/esm/icons/save.js";
import Search from "lucide-vue-next/dist/esm/icons/search.js";
import Settings from "lucide-vue-next/dist/esm/icons/settings.js";
import Table2 from "lucide-vue-next/dist/esm/icons/table-2.js";
import WandSparkles from "lucide-vue-next/dist/esm/icons/wand-sparkles.js";
import ThumbsDown from "lucide-vue-next/dist/esm/icons/thumbs-down.js";
import ThumbsUp from "lucide-vue-next/dist/esm/icons/thumbs-up.js";
import Trash2 from "lucide-vue-next/dist/esm/icons/trash-2.js";
import X from "lucide-vue-next/dist/esm/icons/x.js";
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
  JsonValue,
  MemoryFrontmatter,
  MessageRecord,
  MessagePresentationRecord,
  OperationRecord,
  PolicyDecisionRecord,
  RollbackPoint,
  SessionRecord,
  SettingsRecord,
  SupportedLocale,
  WikiFrontmatter,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import { supportedLocales } from "@samurai-agent/core-schemas";
import { type LocaleKey, t } from "@samurai-agent/localization";
import type { SurfaceRenderKind, SurfaceRendererCapabilities, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  api,
  ApiError,
  createIdempotencyKey,
  getApiBaseUrl,
  type AgentBackendStatus,
  type ApprovalLifecyclePayload,
  type ArchiveMemoryPayload,
  type MemoryDetail,
  type AutomationRunSummary,
  type SkillIndexEntry,
  type WikiDetail,
  type ProviderErrorPayload,
  type DesktopWorkspaceConnectionState,
  type DesktopWorkspaceServerStatus,
  type SearchResult,
  type SessionDetail,
  type SurfaceContractPayload
} from "./lib/api";
import CollectionWorkspaceView from "./components/CollectionWorkspaceView.vue";
import GeneratedSurfaceCard from "./components/GeneratedSurfaceCard.vue";
import SkillOptimizationCard from "./components/SkillOptimizationCard.vue";
import WorkspacePanels from "./components/WorkspacePanels.vue";
import ContextDrawer from "./components/ContextDrawer.vue";
import WorkspaceCanvas from "./components/WorkspaceCanvas.vue";
import AppSidebar from "./components/AppSidebar.vue";
import {
  artifactContentUrl,
  isArtifactPreviewable,
  isImageArtifact,
  isPdfArtifact,
  markdownPreviewHtml,
  toJsonValue
} from "./lib/surface-view-helpers";
import { useResizableLayout } from "./lib/use-resizable-layout";
import { isCollectionSurfaceSpec as isCollectionTableSurfaceSpec, useCollectionWorkspace } from "./lib/use-collection-workspace";
import { useChatAttachments } from "./lib/use-chat-attachments";
import { useAgentStream, type PendingAgentStreamItem, type WorkActivityItem } from "./lib/use-agent-stream";
import { useWorkSummary, type WorkSummaryBlock } from "./lib/use-work-summary";
import { useChatScroll } from "./lib/use-chat-scroll";
import { useSurfaceWorkspace, surfaceChartRefs, surfaceCustomViewPayload, surfaceFields, surfaceTableColumns, surfaceTableRows } from "./lib/use-surface-workspace";
import { useApprovalWorkflow } from "./lib/use-approval-workflow";
import {
  backendDisplayLabel,
  backendEventPayload,
  backendEventSummary,
  backendRunContextSummary,
  backendRunNote,
  backendRunStatusLabel,
  draftSessionTitle,
  formatProviderNoticeDetails,
  isInitialTitle,
  isInternalSessionTitle,
  normalizeProviderNotice,
  resultDisplayTitle as formatResultDisplayTitle,
  sessionDisplayTitle as formatSessionDisplayTitle,
  type ProviderErrorReason,
  type ProviderNotice
} from "./lib/app-view-helpers";
import { persistSettings, readStoredSettings } from "./lib/settings-storage";
import { useMessageActions } from "./lib/use-message-actions";
import { collectionDefaultViewId, collectionListErrorMessage, collectionSchemaRenderer, collectionSchemaTitle } from "./lib/collection-list-state";
import { useDisclosureState } from "./lib/use-disclosure-state";
import { connectAppSocket } from "./lib/connect-app-socket";
import { appendById, mergeById } from "./lib/array-state";
import {
  appCollectionData,
  appCollectionRecords,
  appCollectionViewConfig,
  collectionPresentationForSpec,
  collectionPresentationOpenOperation,
  collectionPresentationPreviewSpec,
  withPresentationViewState
} from "./lib/collection-view-state";

type ViewMode = "chat" | "search" | "settings" | "runs" | "memory" | "collections" | "wiki" | "skills" | "automations";
type ChatDisplayMessage = {
  id: string;
  role: MessageRecord["role"];
  content: string;
  presentations: MessagePresentationRecord[];
  state?: "pending" | "loading";
  created_at?: string;
  activityItems?: WorkActivityItem[];
  streamItems?: PendingAgentStreamItem[];
};
const settings = ref<SettingsRecord>({
  ui_locale: "ja",
  output_locale: "ja",
  memory_capture_mode: "auto",
  knowledge_wiki_capture_mode: "auto",
  skill_capture_mode: "auto",
  external_provider_role: "assistive",
  updated_at: new Date().toISOString()
});
const workspaceConnectionState = ref<DesktopWorkspaceConnectionState>({ connections: [] });
const workspaceConnectionLoading = ref(false);
const workspaceConnectionError = ref<string | null>(null);
const workspaceServerStatus = ref<DesktopWorkspaceServerStatus | null>(null);
const workspaceConnectionAvailable = computed(() => typeof window !== "undefined" && Boolean(
  window.samuraiDesktop?.listWorkspaceConnections
  && window.samuraiDesktop?.upsertWorkspaceConnection
  && window.samuraiDesktop?.selectWorkspaceConnection
  && window.samuraiDesktop?.getWorkspaceServerStatus
));
const sessions = ref<SessionRecord[]>([]);
const activeSession = ref<SessionRecord | null>(null);
const messages = ref<MessageRecord[]>([]);
const messagePresentations = ref<MessagePresentationRecord[]>([]);
const artifacts = ref<ArtifactRecord[]>([]);
const activity = ref<ActivityInboxItem[]>([]);
const auditRecords = ref<AuditRecord[]>([]);
const backendRuns = ref<BackendRunRecord[]>([]);
const backendEvents = ref<BackendEventRecord[]>([]);
const workspaceChanges = ref<WorkspaceChangeRecord[]>([]);
const agentBackends = ref<AgentBackendStatus[]>([]);
const operations = ref<OperationRecord[]>([]);
const policyDecisions = ref<PolicyDecisionRecord[]>([]);
const approvalRequests = ref<ApprovalRequest[]>([]);
const rollbackPoints = ref<RollbackPoint[]>([]);
const memory = ref<Array<MemoryFrontmatter & { file_path: string }>>([]);
const surfaceContract = ref<SurfaceContractPayload | null>(null);
const surfaceContractError = ref(false);
const lastSurfaceRenderSpec = ref<SurfaceRenderSpec | null>(null);
const lastSurfaceRenderSpecs = ref<SurfaceRenderSpec[]>([]);
const searchResults = ref<SearchResult[]>([]);
const collectionSchemas = ref<Array<CollectionSchema & { file_path: string }>>([]);
const collectionListLoading = ref(false);
const collectionListError = ref<string | null>(null);
const wikiPages = ref<Array<WikiFrontmatter & { file_path: string }>>([]);
const wikiDetail = ref<WikiDetail | null>(null);
const wikiDiagnostics = ref<Record<string, unknown> | null>(null);
const skills = ref<SkillIndexEntry[]>([]);
const skillDetail = ref<{ skill: SkillIndexEntry; markdown: string } | null>(null);
const automationJobs = ref<AutomationJobRecord[]>([]);
const automationRuns = ref<AutomationRunSummary[]>([]);
const managementLoading = ref(false);
const managementError = ref<string | null>(null);
const selectedManagementContext = ref<{ kind: "wiki" | "skill" | "automation"; id: string; title: string } | null>(null);
const prompt = ref("");
const promptInput = ref<HTMLInputElement | null>(null);
const { attachmentInput, selectedAttachments, openAttachmentPicker, handleAttachmentSelection, removeAttachment, clearAttachments, formatFileSize } = useChatAttachments();
const chatLayoutRef = ref<HTMLDivElement | null>(null);
const { chatScrollRef, chatScrollState, chatScrollFrameClass, scheduleChatScrollCheck, updateChatScrollState, disposeChatScroll } = useChatScroll();
const searchQuery = ref("");
const viewMode = ref<ViewMode>("chat");
const drawerOpen = ref(false);
const sidebarCollapsed = ref(false);
const { isBackendEventOpen, isBackendRunOpen, toggleBackendEvent, toggleBackendRun } = useDisclosureState();
const settingsReturnMode = ref<ViewMode>("chat");
const loading = ref(false);
const initializing = ref(true);
const sessionLoadError = ref(false);
const pendingUserMessage = ref<ChatDisplayMessage | null>(null);
const pendingUserMessageStartIndex = ref(0);
const pendingChatOperation = ref<{ idempotencyKey: string; content: string } | null>(null);
const {
  agentResponsePending,
  pendingAgentReceivedContent,
  pendingAgentDisplayedContent,
  pendingAgentActivity,
  pendingAgentStreamItems,
  pendingAgentRunId,
  resetPendingAgentResponse,
  stopPendingAgentTyping,
  flushPendingAgentTyping,
  pendingAgentDisplayedPlainText,
  appendPendingAgentText,
  appendPendingAgentActivity,
  codexStyleStreamItemsForEvents
} = useAgentStream(streamingActivityItem);
const { messageFeedback, expandedMessageIds, copyMessage, setMessageFeedback, toggleMessageExpanded } = useMessageActions();
const providerNotice = ref<ProviderNotice | null>(null);
const providerNoticeDetailsOpen = ref(false);
const providerNoticeTitle = computed(() => (providerNotice.value ? label(`provider_error.${providerNotice.value.reason}.title` as LocaleKey) : ""));
const providerNoticeBody = computed(() => (providerNotice.value ? label(`provider_error.${providerNotice.value.reason}.body` as LocaleKey) : ""));
const providerNoticeDetails = computed(() => formatProviderNoticeDetails(providerNotice.value));
const activeMessagePresentationId = ref<string | null>(null);
const backendStorageKey = "samurai-agent.selected-backend-id";
const frontendSurfaceKinds = ["chat", "status_timeline", "form", "table", "chart", "artifact", "memory", "run_history", "custom_view"] as const satisfies readonly SurfaceRenderKind[];
const preferredExternalBackendIds = ["codex", "claude-code"] as const;
const selectedBackendId = ref("codex");
const backendPickerOpen = ref(false);
const fallbackBackends: AgentBackendStatus[] = [
  {
    id: "samurai-native",
    kind: "samurai_native",
    label: "Samurai Native",
    configured: true
  }
];

const label = (key: LocaleKey) => t(settings.value.ui_locale, key);
const captureModes: SettingsRecord["memory_capture_mode"][] = ["auto", "manual", "off"];
const externalProviderRoles: SettingsRecord["external_provider_role"][] = ["assistive", "disabled"];
const backendOptions = computed(() => (agentBackends.value.length > 0 ? agentBackends.value : fallbackBackends));
const selectedBackendLabel = computed(() => {
  const backend = backendOptions.value.find((item) => item.id === selectedBackendId.value);
  return backend ? backendDisplayLabel(backend) : selectedBackendId.value;
});

function envelopeRenderSpecs(envelope: { render_spec: SurfaceRenderSpec; render_specs?: SurfaceRenderSpec[] }): SurfaceRenderSpec[] {
  return envelope.render_specs && envelope.render_specs.length > 0 ? envelope.render_specs : [envelope.render_spec];
}
const surfaceRendererByKind = computed(() => new Map((surfaceContract.value?.renderers ?? []).map((renderer) => [renderer.kind, renderer])));
const surfaceCommandById = computed(() => new Map((surfaceContract.value?.commands ?? []).map((command) => [command.id, command])));
const frontendRendererCapabilities = computed<SurfaceRendererCapabilities>(() => {
  const availableKinds = new Set<SurfaceRenderKind>(surfaceContract.value?.render_kinds ?? [...frontendSurfaceKinds]);
  const supportedKinds = frontendSurfaceKinds.filter((kind) => availableKinds.has(kind));
  return {
    protocol_version: surfaceContract.value?.protocol_version ?? "1",
    supported_kinds: supportedKinds.length > 0 ? [...supportedKinds] : [...frontendSurfaceKinds],
    custom_view_renderers: [
      { renderer: "generic", versions: ["1"] },
      { renderer: "collection_table", versions: ["1"] },
      { renderer: "collection_gallery", versions: ["1"] },
      { renderer: "calendar_view", versions: ["1"] },
      { renderer: "collection_kanban", versions: ["1"] }
    ]
  };
});
let syncCollectionDraftsBridge: (spec: SurfaceRenderSpec) => void = () => undefined;
const {
  activeArtifact,
  activeMemory,
  activeSurfaceSpec,
  canvasMode,
  memoryContent,
  openArtifact,
  openMemory,
  closeWorkspaceCanvas,
  setCanvasMode,
  openSurfaceSpec,
  prepareSurfaceDraft,
  formDraftValue,
  setFormDraftValue,
  tableDraftValue,
  setTableDraftValue,
  runArtifactSurfaceOperation,
  submitSurfaceForm,
  saveSurfaceTableRow,
  runCustomViewAction
} = useSurfaceWorkspace({
  activeSession,
  settings,
  surfaceContract,
  frontendRendererCapabilities,
  loading,
  lastSurfaceRenderSpec,
  activeMessagePresentationId,
  reloadActiveSession,
  isCollectionSurface: isCollectionTableSurfaceSpec,
  syncCollectionDrafts: (spec) => syncCollectionDraftsBridge(spec),
  isArtifactRecordLike
});
const {
  collectionAppError,
  collectionNewDraft,
  collectionSaving,
  collectionWorkspaceController,
  syncCollectionDrafts,
  collectionSurfaceErrorMessage
} = useCollectionWorkspace({
  activeSurfaceSpec,
  activeMessagePresentationId,
  messagePresentations,
  lastSurfaceRenderSpec,
  lastSurfaceRenderSpecs,
  frontendRendererCapabilities,
  activeSession,
  selectedBackendId,
  activeArtifact,
  activeMemory,
  ensureSurfaceContract: ensureTaskSurfaceContract,
  openSurfaceSpec,
  reloadActiveSession,
  setCanvasMode
});
syncCollectionDraftsBridge = syncCollectionDrafts;
const artifactCommandSurfaceKinds = computed(() => supportedCommandSurfaceKinds("artifact.create", ["artifact"]));
const activeWorkspaceSurfaceKind = computed<SurfaceRenderKind | undefined>(() => {
  if (activeSurfaceSpec.value) {
    return activeSurfaceSpec.value.kind;
  }
  if (activeArtifact.value) {
    return artifactCommandSurfaceKinds.value[0] ?? "artifact";
  }
  if (activeMemory.value) {
    return "memory";
  }
  return undefined;
});
const currentMessages = computed<ChatDisplayMessage[]>(() => {
  const presentationsByMessage = new Map<string, MessagePresentationRecord[]>();
  for (const presentation of messagePresentations.value) {
    const items = presentationsByMessage.get(presentation.message_id) ?? [];
    items.push(presentation);
    presentationsByMessage.set(presentation.message_id, items);
  }
  const displayMessages = messages.value.map(
    (message): ChatDisplayMessage => ({
      id: message.id,
      role: message.role,
      content: message.content,
      presentations: presentationsByMessage.get(message.id) ?? [],
      created_at: message.created_at
    })
  );
  if (pendingUserMessage.value && !hasPersistedPendingUserMessage()) {
    displayMessages.push(pendingUserMessage.value);
  }
  if (agentResponsePending.value) {
    displayMessages.push({
      id: "pending-agent-response",
      role: "agent",
      content: pendingAgentDisplayedPlainText(),
      presentations: [],
      state: "loading",
      activityItems: pendingAgentActivity.value,
      streamItems: pendingAgentStreamItems.value
    });
  }
  return displayMessages;
});
const operationsById = computed(() => new Map(operations.value.map((operation) => [operation.id, operation])));
const approvalsById = computed(() => new Map(approvalRequests.value.map((request) => [request.id, request])));
const policyDecisionMap = computed(() => new Map(policyDecisions.value.map((decision) => [decision.id, decision])));
const {
  approveRequest,
  denyRequest,
  restoreWorkspaceChange,
  archiveMemoryItem,
  approveActivity,
  denyActivity,
  refreshAuditContext,
  applyApprovalLifecycle,
  applyArchiveMemory,
  activityLabel,
  auditStatus,
  approvalRequestLabel,
  approvalRequestTitle,
  approvalRequestReason,
  approvalRequestCommandText,
  pendingApprovalChoice,
  setPendingApprovalChoice,
  submitPendingApproval
} = useApprovalWorkflow({
  activeSession,
  activeMemory,
  approvalRequests,
  operations,
  auditRecords,
  policyDecisions,
  rollbackPoints,
  activity,
  memory,
  loading,
  operationsById,
  approvalsById,
  label,
  reloadActiveSession
});
const activeActivity = computed(() =>
  activity.value.filter((item) => {
    if (!activeSession.value || !item.operation_id) {
      return true;
    }
    return operationsById.value.get(item.operation_id)?.session_id === activeSession.value.id;
  })
);
const {
  latestBackendEvents,
  latestBackendRun,
  hasActivity,
  pendingLegacyApprovals,
  workSummaryBlock,
  workSummaryCodexStreamItems,
  visibleWorkChanges,
  hiddenWorkChangeCount,
  firstReversibleWorkRollback,
  workSummaryMessageId,
  workChangesExpanded,
  changeResourceLabel,
  resourceKindLabel,
  resourceDisplayName,
  resourceLineLabel,
  resourceExtensionLabel,
  changeStatsLabel,
  workSummaryChangeTitle,
  workSummaryStatsLabel,
  isWorkSummaryMessage,
  hasNewerUserMessage,
  isWorkActivityVisible,
  toggleWorkActivity,
  runDurationLabel
} = useWorkSummary({
  activeSession,
  backendRuns,
  backendEvents,
  workspaceChanges,
  artifacts,
  rollbackPoints,
  approvalRequests,
  operationsById,
  currentMessages,
  label,
  codexStyleStreamItemsForEvents,
  backendEventSummary
});
const firstMemory = computed(() => memory.value[0]);
const hasWorkspaceCanvas = computed(() => Boolean(activeArtifact.value || activeMemory.value || activeSurfaceSpec.value));
const {
  appShellStyle,
  beginSidebarResize,
  beginWorkspaceResize,
  finishSidebarResize,
  finishWorkspaceResize,
  handleSidebarResizerKeydown,
  handleWorkspaceResizerKeydown,
  isResizingSidebar,
  isResizingWorkspace,
  sidebarWidthMin,
  sidebarWidthMax,
  sidebarWidth,
  workspaceSplitMin,
  workspaceSplitMax,
  workspaceSplitPercent,
  workspaceSplitStyle
} = useResizableLayout({ chatLayoutRef, hasWorkspaceCanvas, sidebarCollapsed });
const isDraftChat = computed(() => !activeSession.value && currentMessages.value.length === 0 && viewMode.value === "chat");
const desktopDeepLinkHashHandler = () => {
  void applyDesktopDeepLinkHash();
};

onMounted(async () => {
  const storedSettings = readStoredSettings();
  if (storedSettings) {
    settings.value = storedSettings;
  }
  void loadWorkspaceConnections();
  connectSocket();
  await Promise.all([loadSettings(), loadAgentBackends(), loadSurfaceContract(), loadSessionsWithRetry()]);
  window.addEventListener("hashchange", desktopDeepLinkHashHandler);
  await applyDesktopDeepLinkHash();
});

onUnmounted(() => {
  window.removeEventListener("hashchange", desktopDeepLinkHashHandler);
  stopPendingAgentTyping();
  disposeChatScroll();
  finishWorkspaceResize();
  finishSidebarResize();
  clearAttachments();
});

watch(
  [() => currentMessages.value.length, () => artifacts.value.length, () => memory.value.length, () => selectedAttachments.value.length, hasWorkspaceCanvas, viewMode],
  () => scheduleChatScrollCheck()
);

watch(activeSurfaceSpec, (spec) => {
  if (spec) prepareSurfaceDraft(spec);
});

async function loadSessions() {
  sessions.value = await api.listSessions();
  const currentSession = activeSession.value ? sessions.value.find((session) => session.id === activeSession.value?.id) : undefined;
  if (currentSession) {
    await openSession(currentSession.id);
    return;
  }
  startDraftChat();
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

async function loadSettings() {
  try {
    settings.value = await api.getSettings();
    persistSettings(settings.value);
  } catch {
    persistSettings(settings.value);
  }
}

function startDraftChat() {
  activeSession.value = null;
  messages.value = [];
  messagePresentations.value = [];
  pendingUserMessage.value = null;
  resetPendingAgentResponse();
  artifacts.value = [];
  operations.value = [];
  auditRecords.value = [];
  backendRuns.value = [];
  backendEvents.value = [];
  workspaceChanges.value = [];
  policyDecisions.value = [];
  approvalRequests.value = [];
  rollbackPoints.value = [];
  memory.value = [];
  activity.value = [];
  activeArtifact.value = null;
  activeMemory.value = null;
  activeSurfaceSpec.value = null;
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

async function applyDesktopDeepLinkHash() {
  const target = parseDesktopDeepLinkHash(window.location.hash);
  if (!target) {
    return;
  }
  try {
    if (target.kind === "workspace") {
      viewMode.value = "chat";
      return;
    }
    if (target.kind === "session" && target.id) {
      await openSession(target.id);
      return;
    }
    if (target.kind === "artifact" && target.id) {
      await openArtifact(target.id);
      viewMode.value = "chat";
      return;
    }
    if (target.kind === "run" && target.id) {
      await openBackendRunDeepLink(target.id);
      return;
    }
    if (target.kind === "run") {
      await loadRuns();
    }
  } catch {
    viewMode.value = "chat";
  }
}

async function openBackendRunDeepLink(runId: string) {
  const run = await api.getBackendRun(runId);
  await openSession(run.session_id);
  await loadRuns();
  openBackendRunIds.value = new Set([...openBackendRunIds.value, run.id]);
}

function parseDesktopDeepLinkHash(hash: string): { kind: "workspace" | "session" | "artifact" | "run"; id?: string } | null {
  const match = hash.match(/^#\/(workspace|session|artifact|run)(?:\/([^/?#]+))?/);
  if (!match) {
    return null;
  }
  const kind = match[1] as "workspace" | "session" | "artifact" | "run";
  const id = match[2] ? decodeURIComponent(match[2]) : undefined;
  return { kind, id };
}

async function sendMessage() {
  if (prompt.value.trim().length === 0 || loading.value) {
    return;
  }
  const content = prompt.value.trim();
  const operation = pendingChatOperation.value?.content === content
    ? pendingChatOperation.value
    : { idempotencyKey: createIdempotencyKey(), content };
  pendingChatOperation.value = operation;
  prompt.value = "";
  loading.value = true;
  pendingUserMessageStartIndex.value = messages.value.length;
  pendingUserMessage.value = {
    id: `pending-user-${Date.now()}`,
    role: "user",
    content,
    presentations: [],
    state: "pending"
  };
  resetPendingAgentResponse();
  agentResponsePending.value = true;
  try {
    providerNotice.value = null;
    providerNoticeDetailsOpen.value = false;
    const session = activeSession.value ?? await api.createSession({
      title: draftSessionTitle(content),
      ui_locale: settings.value.ui_locale,
      output_locale: settings.value.output_locale
    });
    activeSession.value = session;
    promoteSessionToTop(session);
    const envelope = await api.submitChatSurfaceOperation({
      idempotencyKey: operation.idempotencyKey,
      sessionId: session.id,
      content,
      inputLocale: settings.value.ui_locale,
      outputLocale: settings.value.output_locale,
      backendId: selectedBackendId.value,
      rendererCapabilities: frontendRendererCapabilities.value,
      metadata: {
        frontend_surface_contract_version: surfaceContract.value?.protocol_version ?? "1",
        ...(activeAppContext() ? { active_app_context: activeAppContext() } : {})
      }
    });
    const result = envelope.result;
    const renderSpecs = envelopeRenderSpecs(envelope);
    lastSurfaceRenderSpec.value = envelope.render_spec;
    lastSurfaceRenderSpecs.value = renderSpecs;
    const appSpec = renderSpecs.find((spec) => isTaskListSurfaceSpec(spec) || isCollectionTableSurfaceSpec(spec));
    if (appSpec) {
      const appPresentation = isCollectionTableSurfaceSpec(appSpec)
        ? collectionPresentationForSpec(appSpec, result.messagePresentations ?? [])
        : undefined;
      openSurfaceSpec(appPresentation ? withPresentationViewState(appSpec, appPresentation) : appSpec);
      activeMessagePresentationId.value = appPresentation?.id ?? null;
    }
    pendingUserMessage.value = null;
    flushPendingAgentTyping();
    resetPendingAgentResponse();
    activeSession.value = result.session;
    promoteSessionToTop(result.session);
    messages.value = appendById(messages.value, result.messages);
    messagePresentations.value = appendById(messagePresentations.value, result.messagePresentations ?? []);
    artifacts.value = [...result.artifacts, ...artifacts.value];
    backendRuns.value = [result.backendRun, ...backendRuns.value.filter((item) => item.id !== result.backendRun.id)];
    backendEvents.value = mergeById(result.backendEvents, backendEvents.value);
    workspaceChanges.value = mergeById(result.workspaceChanges, workspaceChanges.value);
    auditRecords.value = [...result.auditRecords, ...auditRecords.value];
    operations.value = [...result.operations, ...operations.value];
    policyDecisions.value = [...result.policyDecisions, ...policyDecisions.value];
    approvalRequests.value = [...result.approvalRequests, ...approvalRequests.value];
    rollbackPoints.value = [...result.rollbackPoints, ...rollbackPoints.value];
    activity.value = result.activity;
    await reloadActiveSession();
    clearAttachments();
    pendingChatOperation.value = null;
  } catch (error) {
    pendingUserMessage.value = null;
    resetPendingAgentResponse();
    prompt.value = content;
    if (error instanceof ApiError && isRecord(error.body)) {
      if (error.body.error === "provider_not_configured" || error.body.error === "provider_failed") {
        providerNotice.value = normalizeProviderNotice(error.body);
        applyProviderErrorState(error.body as ProviderErrorPayload);
        return;
      }
    }
    throw error;
  } finally {
    loading.value = false;
  }
}

function activeAppContext(): Record<string, JsonValue> | undefined {
  const spec = activeSurfaceSpec.value;
  if (spec?.props.renderer === "generated_surface") {
    return {
      generated_surface_id: typeof spec.props.surface_id === "string" ? spec.props.surface_id : "",
      generated_surface_revision_id: typeof spec.props.revision_id === "string" ? spec.props.revision_id : ""
    };
  }
  if (!spec || (!isTaskListSurfaceSpec(spec) && !isCollectionTableSurfaceSpec(spec))) {
    return selectedManagementContext.value
      ? { resource_kind: selectedManagementContext.value.kind, resource_id: selectedManagementContext.value.id, title: selectedManagementContext.value.title }
      : undefined;
  }
  const data = appCollectionData(spec);
  return {
    renderer: String(spec.props.renderer),
    view_id: String(spec.props.view_id ?? appCollectionViewConfig(spec).id ?? ""),
    collection_id: String(data.collection_id ?? ""),
    record_ids: appCollectionRecords(spec).map((record) => String(record.id ?? "")),
    schema_fields: toJsonValue(appCollectionSchemaFields(spec)),
    counts: toJsonValue(data.counts ?? {})
  };
}

function schedulePromptFocus() {
  void nextTick(() => {
    promptInput.value?.focus();
    updateChatScrollState();
  });
}

async function loadAgentBackends() {
  try {
    agentBackends.value = await api.listAgentBackends();
  } catch {
    agentBackends.value = [];
  }
  chooseInitialBackend();
}

async function loadSurfaceContract() {
  try {
    surfaceContract.value = await api.getSurfaceContract();
    surfaceContractError.value = false;
  } catch {
    surfaceContract.value = null;
    surfaceContractError.value = true;
  }
}

function hasSurfaceOperationKind(kind: string): boolean {
  return (surfaceContract.value?.commands ?? []).some((command) => command.surface_operation_kinds?.includes(kind));
}

function missingTaskSurfaceOperationKinds(extraKinds: string[] = []): string[] {
  return [
    "collection.view.present",
    "collection.record.create",
    "collection.record.patch",
    "collection.record.delete",
    ...extraKinds
  ].filter((kind) => !hasSurfaceOperationKind(kind));
}

async function ensureTaskSurfaceContract(extraKinds: string[] = []): Promise<void> {
  if (!surfaceContract.value && !surfaceContractError.value) {
    await loadSurfaceContract();
  }
  const missing = missingTaskSurfaceOperationKinds(extraKinds);
  if (missing.length > 0) {
    throw new Error(`task_surface_contract_missing:${missing.join(",")}`);
  }
}

function chooseInitialBackend() {
  const stored = settings.value.default_backend_id || readStoredBackendId();
  const storedBackend = backendOptions.value.find((backend) => backend.id === stored);
  const preferredBackend = preferredExternalBackendIds
    .map((id) => backendOptions.value.find((backend) => backend.id === id && isRunnableBackend(backend)))
    .find((backend): backend is AgentBackendStatus => Boolean(backend));
  const nextBackend = (
    storedBackend && storedBackend.id !== "samurai-native" && isRunnableBackend(storedBackend)
      ? storedBackend
      : preferredBackend
        ?? (storedBackend && isRunnableBackend(storedBackend) ? storedBackend : undefined)
        ?? backendOptions.value.find(isRunnableBackend)
        ?? backendOptions.value[0]
  );
  if (nextBackend) {
    selectedBackendId.value = nextBackend.id;
  }
}

function isRunnableBackend(backend: AgentBackendStatus): boolean {
  return backend.configured
    && backend.enabled !== false
    && (backend.connection_state === undefined || backend.connection_state === "ready" || backend.connection_state === "unverified");
}

async function setSelectedBackend(id: string) {
  selectedBackendId.value = id;
  backendPickerOpen.value = false;
  settings.value = await api.patchSettings({ default_backend_id: id });
  persistSettings(settings.value);
  try {
    window.localStorage.setItem(backendStorageKey, id);
  } catch {
    // localStorage can be unavailable in private/restricted contexts.
  }
}

function backendLabel(id: string, fallback?: string): string {
  return agentBackends.value.find((backend) => backend.id === id)?.label ?? fallback ?? id;
}

function supportedCommandSurfaceKinds(commandId: string, fallback: SurfaceRenderKind[]): SurfaceRenderKind[] {
  const command = surfaceCommandById.value.get(commandId);
  const supportedKinds = new Set(frontendRendererCapabilities.value.supported_kinds);
  const kinds = (command?.output_render_kinds ?? fallback).filter((kind) => supportedKinds.has(kind));
  return kinds.length > 0 ? kinds : fallback;
}

function surfaceRendererLabel(kind?: SurfaceRenderKind): string {
  if (!kind) {
    return "";
  }
  return surfaceRendererByKind.value.get(kind)?.title ?? kind.replace(/_/g, " ");
}

function toggleBackendPicker() {
  backendPickerOpen.value = !backendPickerOpen.value;
}

function readStoredBackendId(): string | undefined {
  try {
    return window.localStorage.getItem(backendStorageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function applyStreamingRun(run: BackendRunRecord) {
  if (!agentResponsePending.value || (activeSession.value && run.session_id !== activeSession.value.id)) {
    return;
  }
  pendingAgentRunId.value = run.id;
  if (run.output_message_id && messages.value.some((message) => message.id === run.output_message_id)) {
    flushPendingAgentTyping();
    resetPendingAgentResponse();
  }
}

function applyStreamingEvent(event: BackendEventRecord) {
  if (!agentResponsePending.value) {
    return;
  }
  if (pendingAgentRunId.value && event.run_id !== pendingAgentRunId.value) {
    return;
  }
  if (!pendingAgentRunId.value) {
    pendingAgentRunId.value = event.run_id;
  }
  if (event.event_type === "agent_reasoning" && typeof event.payload.text === "string") {
    appendPendingAgentText("reasoning_text", event.payload.text);
    return;
  }
  if (event.event_type === "host_progress" && typeof event.payload.text === "string") {
    if (event.payload.display_kind === "reasoning_summary") {
      appendPendingAgentText("reasoning_text", event.payload.text);
    } else {
      appendPendingAgentActivity({ kind: "workspace_prepared", label: event.payload.text }, event);
    }
    return;
  }
  if (event.event_type === "text_delta" && typeof event.payload.text === "string") {
    appendPendingAgentText("assistant_text", event.payload.text);
    return;
  }
  const activity = streamingActivityItem(event);
  if (activity) {
    appendPendingAgentActivity(activity, event);
  }
}

function streamingActivityItem(event: BackendEventRecord): WorkActivityItem | undefined {
  if (event.event_type === "tool_call_started" || event.event_type === "tool_call_output") {
    const payload = isRecord(event.payload) ? event.payload : {};
    const toolName = typeof payload.provider_tool_name === "string" ? payload.provider_tool_name : "";
    if (toolName === "samurai.artifact.create" || toolName === "mcp__samurai__artifact_create" || payload.action_id === "artifact.create") {
      return { kind: "artifact_created", label: "成果物を作成" };
    }
    if (toolName === "exec_command" || payload.action_id === "sandbox.exec") {
      return { kind: "command_run", label: "コマンドを実行" };
    }
    if (toolName.includes("search") || toolName.includes("grep") || toolName.includes("rg")) {
      return { kind: "code_searched", label: "コードを検索" };
    }
    return { kind: "workspace_prepared", label: event.event_type === "tool_call_output" ? "作業結果を確認" : "ツールを準備" };
  }
  if (event.event_type === "artifact_created") {
    return { kind: "artifact_created", label: "成果物を作成" };
  }
  if (event.event_type === "backend_waiting_for_native_input") {
    return { kind: "waiting", label: "確認待ち" };
  }
  return undefined;
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
    await loadRuns();
  }
}

async function loadRuns() {
  if (activeSession.value) {
    backendRuns.value = await api.listBackendRuns(activeSession.value.id);
    backendEvents.value = await Promise.all(backendRuns.value.map((run) => api.listBackendEvents(run.id))).then((groups) => groups.flat());
    workspaceChanges.value = await api.listWorkspaceChanges(activeSession.value.id);
  }
  const payload = await api.getAudit();
  auditRecords.value = payload.auditRecords;
  operations.value = payload.operations;
  policyDecisions.value = payload.policyDecisions;
  approvalRequests.value = payload.approvalRequests;
  rollbackPoints.value = payload.rollbackPoints;
  viewMode.value = "runs";
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

async function loadCollections() {
  collectionListLoading.value = true;
  collectionListError.value = null;
  try {
    collectionSchemas.value = await api.listCollectionSchemas();
    viewMode.value = "collections";
  } catch (error) {
    collectionListError.value = collectionListErrorMessage(error);
    viewMode.value = "collections";
  } finally {
    collectionListLoading.value = false;
  }
}

async function loadWiki() {
  managementLoading.value = true;
  managementError.value = null;
  try {
    [wikiPages.value, wikiDiagnostics.value] = await Promise.all([api.listWiki(), api.getWikiDiagnostics()]);
    viewMode.value = "wiki";
    if (!wikiDetail.value && wikiPages.value[0]) await openWiki(wikiPages.value[0].id);
  } catch (error) {
    managementError.value = error instanceof Error ? error.message : "Knowledge Wikiを読み込めませんでした";
    viewMode.value = "wiki";
  } finally { managementLoading.value = false; }
}

async function openWiki(id: string) { wikiDetail.value = await api.getWiki(id); }
async function saveWiki(id: string, input: { title: string; content: string }) { await api.patchWiki(id, input); wikiPages.value = await api.listWiki(); await openWiki(id); }
async function archiveWiki(id: string) { await api.archiveWiki(id); wikiDetail.value = null; wikiPages.value = await api.listWiki(); }
async function reindexWiki() { await api.reindexWiki(); [wikiPages.value, wikiDiagnostics.value] = await Promise.all([api.listWiki(), api.getWikiDiagnostics()]); }

async function loadSkills() {
  managementLoading.value = true;
  managementError.value = null;
  try {
    skills.value = await api.listSkills();
    viewMode.value = "skills";
    if (!skillDetail.value && skills.value[0]) await openSkill(skills.value[0].id);
  } catch (error) {
    managementError.value = error instanceof Error ? error.message : "Skillを読み込めませんでした";
    viewMode.value = "skills";
  } finally { managementLoading.value = false; }
}

async function openSkill(id: string) { skillDetail.value = await api.getSkill(id); }
async function saveSkill(id: string, input: { title: string; description: string; content: string }) { await api.patchSkill(id, input); skills.value = await api.listSkills(); await openSkill(id); }
async function setSkillActive(id: string, active: boolean) { await api.setSkillActive(id, active); skills.value = await api.listSkills(); await openSkill(id); }

async function loadAutomations() {
  managementLoading.value = true;
  managementError.value = null;
  try {
    [automationJobs.value, automationRuns.value] = await Promise.all([api.listAutomationJobs(), api.listAutomationRuns()]);
    viewMode.value = "automations";
  } catch (error) {
    managementError.value = error instanceof Error ? error.message : "Automationを読み込めませんでした";
    viewMode.value = "automations";
  } finally { managementLoading.value = false; }
}

async function setAutomationStatus(id: string, status: "enabled" | "disabled") { await api.setAutomationStatus(id, status); [automationJobs.value, automationRuns.value] = await Promise.all([api.listAutomationJobs(), api.listAutomationRuns()]); }

function useManagementResourceInChat(kind: "wiki" | "skill" | "automation", id: string, title: string) {
  selectedManagementContext.value = { kind, id, title };
  prompt.value = `${title}を文脈にして、`;
  viewMode.value = "chat";
  schedulePromptFocus();
}

async function openCollectionApp(schema: CollectionSchema & { file_path: string }) {
  collectionAppError.value = null;
  try {
    const viewId = collectionDefaultViewId(schema);
    const envelope = await api.runSurfaceOperation({
      id: `surface_collection_open_${schema.id}_${Date.now()}`,
      kind: "collection.view.present",
      collection_id: schema.id,
      view_id: viewId,
      renderer_capabilities: frontendRendererCapabilities.value
    });
    const spec = envelope.render_spec;
    if (isCollectionTableSurfaceSpec(spec) || isTaskListSurfaceSpec(spec)) {
      openSurfaceSpec(spec);
      viewMode.value = "chat";
      return;
    }
    throw new Error("collection_render_spec_required");
  } catch (error) {
    collectionListError.value = collectionListErrorMessage(error);
  }
}

async function openMessagePresentation(presentation: MessagePresentationRecord) {
  collectionAppError.value = null;
  try {
    if (presentation.kind === "generated_surface" && presentation.surface_id) {
      const detail = await api.getGeneratedSurface(presentation.surface_id);
      const revisionId = presentation.revision_id ?? detail.surface.current_revision_id;
      const spec = generatedSurfaceRenderSpec(detail.surface, revisionId);
      openSurfaceSpec(spec);
      activeMessagePresentationId.value = presentation.id;
      viewMode.value = "chat";
      return;
    }
    const operation = collectionPresentationOpenOperation(presentation, `surface_presentation_open_${presentation.collection_id}_${Date.now()}`);
    const envelope = await api.runSurfaceOperation({
      ...operation,
      renderer_capabilities: frontendRendererCapabilities.value
    });
    const spec = envelope.render_spec;
    if (isCollectionTableSurfaceSpec(spec) || isTaskListSurfaceSpec(spec)) {
      openSurfaceSpec(withPresentationViewState(spec, presentation));
      activeMessagePresentationId.value = presentation.id;
      viewMode.value = "chat";
      return;
    }
    throw new Error("collection_render_spec_required");
  } catch (error) {
    collectionAppError.value = collectionSurfaceErrorMessage(error);
  }
}

function generatedSurfaceRenderSpec(surface: NonNullable<Awaited<ReturnType<typeof api.getGeneratedSurface>>>["surface"], revisionId: string): SurfaceRenderSpec {
  const revision = surface.current_revision_id === revisionId ? surface.current_revision_id : revisionId;
  const apiBase = getApiBaseUrl() ?? "";
  return {
    id: `generated_surface_${surface.id}_${revision}`,
    kind: "custom_view",
    title: surface.title,
    props: {
      renderer: "generated_surface",
      renderer_version: "1",
      surface_id: surface.id,
      revision_id: revision,
      preview_url: `${apiBase}/api/generated-surfaces/${encodeURIComponent(surface.id)}/revisions/${encodeURIComponent(revision)}/preview`,
      actions: surface.actions,
      input_data_schema: surface.input_data_schema,
      data: {}
    },
    priority: "primary",
    resource_refs: surface.source_refs
  };
}

async function pinGeneratedSurface(presentationOrSpec: MessagePresentationRecord | SurfaceRenderSpec) {
  const surfaceId = "surface_id" in presentationOrSpec ? presentationOrSpec.surface_id : presentationOrSpec.props.surface_id;
  if (typeof surfaceId !== "string" || !surfaceId) return;
  await api.runDomainCommand("generated_surface.state", { surface_id: surfaceId, action: "pin" });
  await reloadActiveSession();
}

async function reviseGeneratedSurface(spec: SurfaceRenderSpec) {
  const surfaceId = typeof spec.props.surface_id === "string" ? spec.props.surface_id : "";
  if (!surfaceId) return;
  selectedManagementContext.value = null;
  prompt.value = `この独自UIを修正して（surface_id: ${surfaceId}）：`;
  activeSurfaceSpec.value = spec;
  viewMode.value = "chat";
  schedulePromptFocus();
}

async function exportGeneratedSurface(spec: SurfaceRenderSpec, format: "html" | "zip") {
  const surfaceId = typeof spec.props.surface_id === "string" ? spec.props.surface_id : "";
  const revisionId = typeof spec.props.revision_id === "string" ? spec.props.revision_id : "";
  if (!surfaceId || !revisionId) return;
  const base = getApiBaseUrl() ?? "";
  const url = `${base}/api/generated-surfaces/${encodeURIComponent(surfaceId)}/export?revision_id=${encodeURIComponent(revisionId)}&format=${format}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

async function runGeneratedSurfaceAction(spec: SurfaceRenderSpec, action: { id: string; label: string }, payload: Record<string, JsonValue> = {}) {
  const surfaceId = typeof spec.props.surface_id === "string" ? spec.props.surface_id : "";
  const revisionId = typeof spec.props.revision_id === "string" ? spec.props.revision_id : "";
  if (!surfaceId || !revisionId) return;
  await api.runGeneratedSurfaceAction(surfaceId, action.id, {
    revision_id: revisionId,
    interaction_id: `surface_interaction_${Date.now()}`,
    action_payload: payload
  });
  await reloadActiveSession();
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

async function patchSettings(patch: Partial<Omit<SettingsRecord, "updated_at">>) {
  settings.value = await api.patchSettings(patch);
  persistSettings(settings.value);
}

async function loadWorkspaceConnections(): Promise<void> {
  const bridge = workspaceConnectionBridge();
  if (!bridge) return;
  workspaceConnectionLoading.value = true;
  workspaceConnectionError.value = null;
  try {
    workspaceConnectionState.value = await bridge.listWorkspaceConnections();
    await refreshWorkspaceServerStatus();
  } catch {
    workspaceConnectionError.value = settings.value.ui_locale === "ja" ? "接続先一覧を読み込めませんでした。" : "Could not load Workspace Server connections.";
  } finally {
    workspaceConnectionLoading.value = false;
  }
}

async function selectWorkspaceConnection(connectionId: string): Promise<void> {
  const bridge = workspaceConnectionBridge();
  if (!bridge) return;
  workspaceConnectionLoading.value = true;
  workspaceConnectionError.value = null;
  try {
    workspaceConnectionState.value = await bridge.selectWorkspaceConnection(connectionId);
    await refreshWorkspaceServerStatus();
  } catch {
    workspaceConnectionError.value = settings.value.ui_locale === "ja" ? "接続先を切り替えられませんでした。" : "Could not switch the Workspace Server connection.";
  } finally {
    workspaceConnectionLoading.value = false;
  }
}

async function saveWorkspaceConnection(input: { label: string; serverUrl: string; workspaceId: string; accountId: string; privateKey?: string }): Promise<void> {
  const bridge = workspaceConnectionBridge();
  if (!bridge) return;
  workspaceConnectionLoading.value = true;
  workspaceConnectionError.value = null;
  try {
    workspaceConnectionState.value = await bridge.upsertWorkspaceConnection(input);
    await refreshWorkspaceServerStatus();
  } catch {
    workspaceConnectionError.value = settings.value.ui_locale === "ja" ? "接続先を保存できませんでした。" : "Could not save the Workspace Server connection.";
    throw new Error("workspace_connection_save_failed");
  } finally {
    workspaceConnectionLoading.value = false;
  }
}

async function registerWorkspaceServerAccount(): Promise<void> {
  const bridge = workspaceConnectionBridge();
  if (!bridge?.registerWorkspaceServerAccount) return;
  workspaceConnectionLoading.value = true;
  workspaceConnectionError.value = null;
  try {
    await bridge.registerWorkspaceServerAccount("Samurai Account");
    await refreshWorkspaceServerStatus();
  } catch {
    workspaceConnectionError.value = settings.value.ui_locale === "ja" ? "本人情報をサーバーへ登録できませんでした。" : "Could not register this account with the server.";
  } finally {
    workspaceConnectionLoading.value = false;
  }
}

async function refreshWorkspaceServerStatus(): Promise<void> {
  const bridge = workspaceConnectionBridge();
  if (!bridge?.getWorkspaceServerStatus) return;
  workspaceServerStatus.value = await bridge.getWorkspaceServerStatus();
}

const workspaceServerStatusDisplay = computed<{ message: string; tone: "ready" | "warning" | "error" } | undefined>(() => {
  const status = workspaceServerStatus.value;
  if (!status?.connection) return undefined;
  if (status.health?.status !== 200) return {
    tone: "error",
    message: settings.value.ui_locale === "ja" ? "接続先サーバーに到達できません。" : "The selected server is unreachable."
  };
  if (!status.identityAvailable) return {
    tone: "warning",
    message: settings.value.ui_locale === "ja" ? "この端末の本人情報が未登録です。秘密鍵を安全に登録してください。" : "This device has no registered identity. Add the private key securely."
  };
  if (status.workspace?.status === 200) {
    const rooms = status.rooms?.body;
    const roomCount = rooms && typeof rooms === "object" && Array.isArray((rooms as { rooms?: unknown }).rooms)
      ? (rooms as { rooms: unknown[] }).rooms.length
      : undefined;
    return {
      tone: "ready",
      message: settings.value.ui_locale === "ja"
        ? `接続済み${roomCount === undefined ? "" : `：${roomCount} Room`}`
        : `Connected${roomCount === undefined ? "" : `: ${roomCount} Rooms`}`
    };
  }
  return {
    tone: "warning",
    message: settings.value.ui_locale === "ja" ? "本人情報の登録または権限の確認が必要です。" : "Account registration or access confirmation is required."
  };
});

function workspaceConnectionBridge(): NonNullable<Window["samuraiDesktop"]> | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.samuraiDesktop;
  if (!bridge?.listWorkspaceConnections || !bridge.upsertWorkspaceConnection || !bridge.selectWorkspaceConnection) return undefined;
  return bridge as NonNullable<Window["samuraiDesktop"]>;
}

async function reviewWorkSummary(block: WorkSummaryBlock) {
  const artifact = block.artifacts[0] ?? artifacts.value.find((item) => block.changes.some((change) => change.change.resource_ref.id === item.id));
  if (artifact) {
    await openArtifact(artifact.id);
    return;
  }
  const surface = block.changes[0]?.change.resource_ref;
  if (surface) {
    activeSurfaceSpec.value = {
      id: `workspace_change_review_${surface.id}`,
      kind: "custom_view",
      title: label("workspace_change.review"),
      props: {
        renderer: "workspace-change-review",
        data: block.changes.map((item) => ({
          file: resourceDisplayName(item.change.resource_ref),
          summary: item.change.summary,
          change_type: item.change.change_type
        }))
      },
      priority: "secondary",
      resource_refs: block.changes.map((item) => item.change.resource_ref)
    };
    activeArtifact.value = null;
    activeMemory.value = null;
    canvasMode.value = "app";
    persistCanvasMode(canvasMode.value);
  }
}

async function applySessionDetail(detail: SessionDetail) {
  activeSession.value = detail.session;
  updateSessionInPlace(detail.session);
  messages.value = detail.messages;
  messagePresentations.value = detail.messagePresentations ?? [];
  operations.value = detail.operations;
  artifacts.value = detail.artifacts;
  auditRecords.value = detail.auditRecords;
  backendRuns.value = detail.backendRuns;
  backendEvents.value = detail.backendEvents;
  workspaceChanges.value = detail.workspaceChanges;
  memory.value = detail.memory;
  activity.value = detail.activity;
  if (activeArtifact.value && !detail.artifacts.some((artifact) => artifact.id === activeArtifact.value?.artifact.id)) {
    activeArtifact.value = null;
    activeSurfaceSpec.value = null;
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

function memoryExcerpt(id: string): string {
  return (memoryContent.value[id] ?? "").replace(/\s+/g, " ").slice(0, 150);
}

function artifactPreview(artifact: ArtifactRecord): string {
  const preview = artifact.metadata.preview;
  return typeof preview === "string" ? preview.replace(/\s+/g, " ").trim().slice(0, 140) : "";
}

function artifactActionText(artifact: ArtifactRecord): string {
  return `${label("artifact.workspace_result")} / ${resourceDisplayName(artifact.file_ref)}`;
}

function memoryStateLabel(state: MemoryFrontmatter["state"]): string {
  return label(`memory.state.${state}` as LocaleKey);
}

function searchKindLabel(kind: SearchResult["kind"]): string {
  return label(`search.kind.${kind}` as LocaleKey);
}

function isTaskListSurfaceSpec(spec: SurfaceRenderSpec): boolean {
  return spec.kind === "custom_view" && spec.props.renderer === "task_list";
}

function appCollectionSchemaFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  const fields = appCollectionData(spec).schema_fields;
  return Array.isArray(fields) ? fields.filter(isRecord) as Array<Record<string, JsonValue>> : [];
}

const sessionDisplayTitle = (session: SessionRecord) => formatSessionDisplayTitle(session, label("session.fallback_title"));
const resultDisplayTitle = (result: SearchResult) => formatResultDisplayTitle(result, label("session.fallback_title"));
const localeDisplayName = (locale: SupportedLocale) => label(`locale.${locale}` as LocaleKey);
const captureModeLabel = (mode: SettingsRecord["memory_capture_mode"]) => label(`settings.capture.${mode}` as LocaleKey);
const externalProviderRoleLabel = (role: SettingsRecord["external_provider_role"]) => label(`settings.external_provider.${role}` as LocaleKey);

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
  connectAppSocket({
    activeSession, activity, approvalRequests, operations, policyDecisions, backendRuns, backendEvents,
    workspaceChanges, settings, promoteSession: promoteSessionToTop, applyStreamingRun, applyStreamingEvent,
    persistSettings, reloadActiveSession,
    acceptSession: (session) => !isInternalSessionTitle(session.title)
      && (!isInitialTitle(session.title) || activeSession.value?.id === session.id)
  });
}
function hasPersistedPendingUserMessage(): boolean {
  if (!pendingUserMessage.value) {
    return false;
  }
  return messages.value
    .slice(pendingUserMessageStartIndex.value)
    .some((message) => message.role === "user" && message.content === pendingUserMessage.value?.content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArtifactRecordLike(value: unknown): value is ArtifactRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && isRecord(value.file_ref);
}

function applyProviderErrorState(payload: ProviderErrorPayload) {
  if (payload.session) {
    activeSession.value = payload.session;
    promoteSessionToTop(payload.session);
  }
  if (payload.messages?.length) {
    messages.value = mergeById(messages.value, payload.messages);
  }
  if (payload.backendRun) {
    backendRuns.value = [payload.backendRun, ...backendRuns.value.filter((item) => item.id !== payload.backendRun?.id)];
  }
  if (payload.backendEvents?.length) {
    backendEvents.value = mergeById(payload.backendEvents, backendEvents.value);
  }
  if (payload.workspaceChanges?.length) {
    workspaceChanges.value = mergeById(payload.workspaceChanges, workspaceChanges.value);
  }
}

</script>

<template>
  <main class="app-shell" :class="{ 'has-drawer': drawerOpen, 'sidebar-collapsed': sidebarCollapsed, 'is-resizing-sidebar': isResizingSidebar }" :style="appShellStyle">
    <AppSidebar
      v-model:collapsed="sidebarCollapsed"
      :view-mode="viewMode"
      :is-draft-chat="isDraftChat"
      :initializing="initializing"
      :session-load-error="sessionLoadError"
      :sessions="sessions"
      :active-session="activeSession"
      :sidebar-width="sidebarWidth"
      :sidebar-width-min="sidebarWidthMin"
      :sidebar-width-max="sidebarWidthMax"
      :label="label"
      :start-draft-chat="startDraftChat"
      :load-sessions-with-retry="loadSessionsWithRetry"
      :session-display-title="sessionDisplayTitle"
      :open-session="openSession"
      :open-settings="openSettings"
      :begin-sidebar-resize="beginSidebarResize"
      :handle-sidebar-resizer-keydown="handleSidebarResizerKeydown"
      @search="viewMode = 'search'"
    />
    <section class="main-stage">
      <header class="stage-header">
        <div class="stage-heading" :class="{ 'is-chat': viewMode === 'chat' }">
          <button v-if="viewMode === 'settings'" class="icon-button stage-back-button" type="button" :title="label('action.back')" :aria-label="label('action.back')" @click="returnFromSettings">
            <ArrowLeft :size="16" />
          </button>
          <div v-if="viewMode !== 'chat'" class="stage-title">
            <span v-if="viewMode === 'search'">{{ label("search.title") }}</span>
            <span v-else-if="viewMode === 'settings'">{{ label("settings.title") }}</span>
            <span v-else-if="viewMode === 'runs'">{{ label("run_history.title") }}</span>
            <span v-else-if="viewMode === 'collections'">Collections</span>
            <span v-else-if="viewMode === 'wiki'">Knowledge Wiki</span>
            <span v-else-if="viewMode === 'skills'">Skills</span>
            <span v-else-if="viewMode === 'automations'">Automations</span>
            <span v-else>{{ label("memory.title") }}</span>
          </div>
          <div v-else class="backend-picker">
            <button
              class="stage-backend-trigger"
              type="button"
              :aria-label="label('backend.select')"
              :aria-expanded="backendPickerOpen"
              :title="label('backend.select')"
              @click="toggleBackendPicker"
            >
              <span>{{ selectedBackendLabel }}</span>
            </button>
            <div v-if="backendPickerOpen" class="backend-menu" role="listbox" :aria-label="label('backend.select')">
              <button
                v-for="backend in backendOptions"
                :key="backend.id"
                class="backend-menu-item"
                :class="{ active: backend.id === selectedBackendId }"
                type="button"
                role="option"
                :aria-selected="backend.id === selectedBackendId"
                @click="setSelectedBackend(backend.id)"
              >
                <span>{{ backendDisplayLabel(backend) }}</span>
                <small v-if="!backend.configured">off</small>
              </button>
            </div>
          </div>
        </div>
        <div class="stage-actions">
          <button class="icon-button" type="button" :title="label('memory.title')" :aria-label="label('memory.title')" @click="loadMemory">
            <Brain :size="17" />
          </button>
          <button class="icon-button" type="button" :title="label('run_history.title')" :aria-label="label('run_history.title')" @click="loadRuns">
            <Clock3 :size="17" />
          </button>
          <button class="icon-button" type="button" title="Collections" aria-label="Collections" @click="loadCollections">
            <Table2 :size="17" />
          </button>
          <button class="icon-button" type="button" title="Knowledge Wiki" aria-label="Knowledge Wiki" @click="loadWiki">
            <BookOpen :size="17" />
          </button>
          <button class="icon-button" type="button" title="Skills" aria-label="Skills" @click="loadSkills">
            <WandSparkles :size="17" />
          </button>
          <button class="icon-button" type="button" title="Automations" aria-label="Automations" @click="loadAutomations">
            <CalendarClock :size="17" />
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
                      :class="[
                        message.role === 'user' ? 'message-user' : 'message-agent',
                        { 'message-pending': message.state === 'pending', 'message-loading': message.state === 'loading', 'is-expanded': expandedMessageIds.has(message.id) }
                      ]"
                    >
                      <template v-if="message.state !== 'loading'">
                        <template v-if="isWorkSummaryMessage(message) && workSummaryBlock">
                          <div class="work-turn-shell">
                            <template v-if="workSummaryBlock.pendingRequests.length > 0">
                              <div class="approval-panel-stack">
                                <section v-for="request in workSummaryBlock.pendingRequests" :key="request.id" class="approval-panel">
                                  <p class="approval-question">{{ approvalRequestReason(request) }}</p>
                                  <code v-if="approvalRequestCommandText(request)" class="approval-command">{{ approvalRequestCommandText(request) }}</code>
                                  <div class="approval-options" role="radiogroup" :aria-label="approvalRequestTitle()">
                                    <button
                                      class="approval-option"
                                      :class="{ 'is-selected': pendingApprovalChoice(request) === 'allow' }"
                                      type="button"
                                      role="radio"
                                      :aria-checked="pendingApprovalChoice(request) === 'allow'"
                                      @click="setPendingApprovalChoice(request, 'allow')"
                                    >
                                      <span class="approval-option-index">1</span>
                                      <span>{{ label("pending_request.option_allow") }}</span>
                                      <span class="approval-option-arrows"><ArrowUp :size="16" /><ArrowDown :size="16" /></span>
                                    </button>
                                    <button
                                      v-if="approvalRequestCommandText(request)"
                                      class="approval-option"
                                      :class="{ 'is-selected': pendingApprovalChoice(request) === 'allow_prefix' }"
                                      type="button"
                                      role="radio"
                                      :aria-checked="pendingApprovalChoice(request) === 'allow_prefix'"
                                      @click="setPendingApprovalChoice(request, 'allow_prefix')"
                                    >
                                      <span class="approval-option-index">2</span>
                                      <span>{{ label("pending_request.option_allow_prefix") }}</span>
                                    </button>
                                    <button
                                      class="approval-option"
                                      :class="{ 'is-selected': pendingApprovalChoice(request) === 'deny' }"
                                      type="button"
                                      role="radio"
                                      :aria-checked="pendingApprovalChoice(request) === 'deny'"
                                      @click="setPendingApprovalChoice(request, 'deny')"
                                    >
                                      <span class="approval-option-icon"><Pencil :size="16" /></span>
                                      <span>{{ label("pending_request.option_deny") }}</span>
                                    </button>
                                  </div>
                                  <div class="approval-submit-row">
                                    <button class="approval-skip-button" type="button" :disabled="loading" @click="denyRequest(request)">
                                      {{ label("pending_request.skip") }}
                                    </button>
                                    <button class="approval-submit-button" type="button" :disabled="loading" @click="submitPendingApproval(request)">
                                      {{ label("pending_request.submit") }}
                                      <span class="approval-submit-key">↩</span>
                                    </button>
                                  </div>
                                </section>
                              </div>
                            </template>
                            <template v-else>
                              <button class="work-duration-row" type="button" :aria-expanded="isWorkActivityVisible(message, workSummaryBlock)" @click="toggleWorkActivity(workSummaryBlock)">
                                <span>{{ workSummaryBlock.summary }}</span>
                                <ChevronRight :size="16" :class="{ open: isWorkActivityVisible(message, workSummaryBlock) }" />
                              </button>

                              <div v-if="isWorkActivityVisible(message, workSummaryBlock) && workSummaryCodexStreamItems.length > 0" class="codex-stream-list">
                                <div
                                  v-for="item in workSummaryCodexStreamItems"
                                  :key="item.id"
                                  :class="[
                                    'codex-stream-item',
                                    item.kind === 'activity' ? 'is-activity' : 'is-text',
                                    item.kind === 'reasoning_text' ? 'is-reasoning' : ''
                                  ]"
                                >
                                  <template v-if="item.kind === 'activity'">
                                    <FileInput :size="14" />
                                    <span>{{ item.activity.label }}</span>
                                  </template>
                                  <p v-else class="message-body">{{ item.displayedText }}</p>
                                </div>
                              </div>
                              <div v-else-if="isWorkActivityVisible(message, workSummaryBlock)" class="work-activity-list">
                                <div v-for="item in workSummaryBlock.activityItems" :key="item.kind" class="work-activity-item">
                                  <FileInput :size="14" />
                                  <span>{{ item.label }}</span>
                                </div>
                              </div>

                              <div class="work-turn-divider"></div>

                              <p class="message-body">{{ message.content }}</p>

                              <div v-if="workSummaryBlock.artifacts.length > 0" class="work-card-stack">
                                <button v-for="artifact in workSummaryBlock.artifacts" :key="artifact.id" class="codex-artifact-card" type="button" @click="openArtifact(artifact.id)">
                                  <span class="codex-card-icon"><FileText :size="19" /></span>
                                  <span class="codex-card-main">
                                    <strong>{{ resourceDisplayName(artifact.file_ref) }}</strong>
                                    <small>{{ resourceKindLabel(artifact.file_ref) }} ・ {{ resourceExtensionLabel(artifact.file_ref) }}</small>
                                  </span>
                                  <em>{{ label("artifact.open_in_workspace") }}</em>
                                </button>
                              </div>

                              <div v-if="message.presentations.length > 0" class="work-card-stack">
                                <template v-for="presentation in message.presentations" :key="presentation.id">
                                  <GeneratedSurfaceCard
                                    v-if="presentation.kind === 'generated_surface'"
                                    :presentation="presentation"
                                    :open-label="label('artifact.open_in_workspace')"
                                    :pin-surface="pinGeneratedSurface"
                                    @open="openMessagePresentation(presentation)"
                                  />
                                  <SkillOptimizationCard
                                    v-else-if="presentation.kind === 'skill_optimization'"
                                    :presentation="presentation"
                                    @changed="reloadActiveSession"
                                  />
                                  <CollectionWorkspaceView
                                    v-else
                                    mode="card"
                                    :spec="collectionPresentationPreviewSpec(presentation)"
                                    :presentation="presentation"
                                    :saving="collectionSaving"
                                    :error="collectionAppError"
                                    :new-draft="collectionNewDraft"
                                    :controller="collectionWorkspaceController"
                                    :open-label="label('artifact.open_in_workspace')"
                                    @open="openMessagePresentation(presentation)"
                                  />
                                </template>
                              </div>

                              <section v-if="workSummaryBlock.changes.length > 0" class="codex-change-card">
                                <header class="codex-change-head">
                                  <span class="codex-card-icon"><FileInput :size="20" /></span>
                                  <span class="codex-card-main">
                                    <strong>{{ workSummaryChangeTitle(workSummaryBlock) }}</strong>
                                    <small v-if="workSummaryStatsLabel(workSummaryBlock)" class="change-stat-total">
                                      <span class="stat-added">+{{ workSummaryBlock.added ?? 0 }}</span>
                                      <span class="stat-removed">-{{ workSummaryBlock.removed ?? 0 }}</span>
                                    </small>
                                  </span>
                                  <span class="codex-card-actions">
                                    <button v-if="firstReversibleWorkRollback" type="button" :disabled="loading" @click="restoreWorkspaceChange(firstReversibleWorkRollback)">
                                      {{ label("workspace_change.restore") }}
                                      <RotateCcw :size="14" />
                                    </button>
                                    <button type="button" :disabled="loading" @click="reviewWorkSummary(workSummaryBlock)">
                                      {{ label("workspace_change.review") }}
                                    </button>
                                  </span>
                                </header>
                                <div class="codex-change-list">
                                  <div v-for="item in visibleWorkChanges" :key="item.change.id" class="codex-change-row">
                                    <span>
                                      <strong>{{ changeResourceLabel(item.change) }}</strong>
                                      <small>{{ resourceKindLabel(item.change.resource_ref) }} / {{ item.change.summary }}</small>
                                    </span>
                                    <em v-if="changeStatsLabel(item)">
                                      <span class="stat-added">+{{ item.added ?? 0 }}</span>
                                      <span class="stat-removed">-{{ item.removed ?? 0 }}</span>
                                    </em>
                                  </div>
                                  <button v-if="hiddenWorkChangeCount > 0" class="show-more-files" type="button" @click="workChangesExpanded = true">
                                    {{ label("workspace_change.show_more").replace("{count}", String(hiddenWorkChangeCount)) }}
                                  </button>
                                </div>
                              </section>

                              <footer class="message-footer">
                                <button type="button" :title="label('message.copy')" :aria-label="label('message.copy')" @click="copyMessage(message)">
                                  <Copy :size="14" />
                                </button>
                                <button
                                  type="button"
                                  :class="{ 'is-active': messageFeedback[message.id] === 'up' }"
                                  :title="label('message.good')"
                                  :aria-label="label('message.good')"
                                  @click="setMessageFeedback(message, 'up')"
                                >
                                  <ThumbsUp :size="14" />
                                </button>
                                <button
                                  type="button"
                                  :class="{ 'is-active': messageFeedback[message.id] === 'down' }"
                                  :title="label('message.bad')"
                                  :aria-label="label('message.bad')"
                                  @click="setMessageFeedback(message, 'down')"
                                >
                                  <ThumbsDown :size="14" />
                                </button>
                                <button
                                  type="button"
                                  :class="{ 'is-active': expandedMessageIds.has(message.id) }"
                                  :title="label('message.expand')"
                                  :aria-label="label('message.expand')"
                                  @click="toggleMessageExpanded(message)"
                                >
                                  <Maximize2 :size="14" />
                                </button>
                              </footer>
                            </template>
                          </div>
                        </template>
                        <template v-else>
                          <p class="message-body">{{ message.content }}</p>
                          <div v-if="message.role === 'agent' && message.presentations.length > 0" class="work-card-stack">
                            <template v-for="presentation in message.presentations" :key="presentation.id">
                              <GeneratedSurfaceCard
                                v-if="presentation.kind === 'generated_surface'"
                                :presentation="presentation"
                                :open-label="label('artifact.open_in_workspace')"
                                :pin-surface="pinGeneratedSurface"
                                @open="openMessagePresentation(presentation)"
                              />
                              <SkillOptimizationCard
                                v-else-if="presentation.kind === 'skill_optimization'"
                                :presentation="presentation"
                                @changed="reloadActiveSession"
                              />
                              <CollectionWorkspaceView
                                v-else
                                mode="card"
                                :spec="collectionPresentationPreviewSpec(presentation)"
                                :presentation="presentation"
                                :saving="collectionSaving"
                                :error="collectionAppError"
                                :new-draft="collectionNewDraft"
                                :controller="collectionWorkspaceController"
                                :open-label="label('artifact.open_in_workspace')"
                                @open="openMessagePresentation(presentation)"
                              />
                            </template>
                          </div>
                          <footer v-if="message.role === 'agent'" class="message-footer">
                            <button type="button" :title="label('message.copy')" :aria-label="label('message.copy')" @click="copyMessage(message)">
                              <Copy :size="14" />
                            </button>
                            <button
                              type="button"
                              :class="{ 'is-active': messageFeedback[message.id] === 'up' }"
                              :title="label('message.good')"
                              :aria-label="label('message.good')"
                              @click="setMessageFeedback(message, 'up')"
                            >
                              <ThumbsUp :size="14" />
                            </button>
                            <button
                              type="button"
                              :class="{ 'is-active': messageFeedback[message.id] === 'down' }"
                              :title="label('message.bad')"
                              :aria-label="label('message.bad')"
                              @click="setMessageFeedback(message, 'down')"
                            >
                              <ThumbsDown :size="14" />
                            </button>
                            <button
                              type="button"
                              :class="{ 'is-active': expandedMessageIds.has(message.id) }"
                              :title="label('message.expand')"
                              :aria-label="label('message.expand')"
                              @click="toggleMessageExpanded(message)"
                            >
                              <Maximize2 :size="14" />
                            </button>
                          </footer>
                        </template>
                      </template>
                      <div v-else class="streaming-message" :aria-label="label('chat.waiting')">
                        <div v-if="message.streamItems?.length" class="codex-stream-list">
                          <div
                            v-for="item in message.streamItems"
                            :key="item.id"
                            :class="[
                              'codex-stream-item',
                              item.kind === 'activity' ? 'is-activity' : 'is-text',
                              item.kind === 'reasoning_text' ? 'is-reasoning' : ''
                            ]"
                          >
                            <template v-if="item.kind === 'activity'">
                              <FileInput :size="14" />
                              <span>{{ item.activity.label }}</span>
                            </template>
                            <p v-else-if="item.displayedText" class="message-body">{{ item.displayedText }}</p>
                          </div>
                        </div>
                        <div v-else class="typing-dots">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                      </div>
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

          <WorkspaceCanvas
            :open="hasWorkspaceCanvas"
            :active-workspace-surface-kind="activeWorkspaceSurfaceKind"
            :active-artifact="activeArtifact"
            :active-memory="activeMemory"
            :active-surface-spec="activeSurfaceSpec"
            :canvas-mode="canvasMode"
            :loading="loading"
            :label="label"
            :surface-renderer-label="surfaceRendererLabel"
            :set-canvas-mode="setCanvasMode"
            :run-artifact-surface-operation="runArtifactSurfaceOperation"
            :surface-fields="surfaceFields"
            :form-draft-value="formDraftValue"
            :set-form-draft-value="setFormDraftValue"
            :submit-surface-form="submitSurfaceForm"
            :surface-table-columns="surfaceTableColumns"
            :surface-table-rows="surfaceTableRows"
            :table-draft-value="tableDraftValue"
            :set-table-draft-value="setTableDraftValue"
            :save-surface-table-row="saveSurfaceTableRow"
            :surface-custom-view-payload="surfaceCustomViewPayload"
            :surface-chart-refs="surfaceChartRefs"
            :is-collection-surface="isCollectionTableSurfaceSpec"
            :collection-saving="collectionSaving"
            :collection-error="collectionAppError"
            :collection-new-draft="collectionNewDraft"
            :collection-controller="collectionWorkspaceController"
            :run-custom-view-action="runCustomViewAction"
            :run-generated-surface-action="runGeneratedSurfaceAction"
            :pin-generated-surface="pinGeneratedSurface"
            :revise-generated-surface="reviseGeneratedSurface"
            :export-generated-surface="exportGeneratedSurface"
            :is-pdf-artifact="isPdfArtifact"
            :is-image-artifact="isImageArtifact"
            :is-artifact-previewable="isArtifactPreviewable"
            :artifact-content-url="artifactContentUrl"
            :markdown-preview-html="markdownPreviewHtml"
            :memory-state-label="memoryStateLabel"
            @close="closeWorkspaceCanvas"
          />
        </div>
      </section>

      <WorkspacePanels
        v-else
        v-model:search-query="searchQuery"
        :view-mode="viewMode"
        :label="label"
        :search-results="searchResults"
        :run-search="runSearch"
        :choose-result="chooseResult"
        :search-kind-label="searchKindLabel"
        :result-display-title="resultDisplayTitle"
        :settings="settings"
        :supported-locales="supportedLocales"
        :capture-modes="captureModes"
        :external-provider-roles="externalProviderRoles"
        :patch-settings="patchSettings"
        :workspace-connection-available="workspaceConnectionAvailable"
        :workspace-connection-loading="workspaceConnectionLoading"
        :workspace-connection-error="workspaceConnectionError"
        :workspace-server-status="workspaceServerStatusDisplay"
        :active-workspace-connection-id="workspaceConnectionState.activeConnectionId"
        :workspace-connections="workspaceConnectionState.connections"
        :select-workspace-connection="selectWorkspaceConnection"
        :save-workspace-connection="saveWorkspaceConnection"
        :register-workspace-server-account="registerWorkspaceServerAccount"
        :locale-display-name="localeDisplayName"
        :capture-mode-label="captureModeLabel"
        :external-provider-role-label="externalProviderRoleLabel"
        :backend-runs="backendRuns"
        :pending-legacy-approval-count="pendingLegacyApprovals.length"
        :is-backend-run-open="isBackendRunOpen"
        :toggle-backend-run="toggleBackendRun"
        :backend-label="backendLabel"
        :backend-run-note="(run) => backendRunNote(run, label)"
        :backend-run-status-label="(run) => backendRunStatusLabel(run, label)"
        :collection-list-loading="collectionListLoading"
        :collection-list-error="collectionListError"
        :collection-schemas="collectionSchemas"
        :open-collection-app="openCollectionApp"
        :collection-schema-title="collectionSchemaTitle"
        :collection-schema-renderer="collectionSchemaRenderer"
        :memory="memory"
        :active-memory="activeMemory"
        :active-session="activeSession"
        :memory-state-label="memoryStateLabel"
        :memory-excerpt="memoryExcerpt"
        :open-memory="openMemory"
        :archive-memory-item="archiveMemoryItem"
        :management-loading="managementLoading"
        :management-error="managementError"
        :wiki-pages="wikiPages"
        :wiki-detail="wikiDetail"
        :wiki-diagnostics="wikiDiagnostics"
        :skills="skills"
        :skill-detail="skillDetail"
        :automation-jobs="automationJobs"
        :automation-runs="automationRuns"
        :open-wiki="openWiki"
        :save-wiki="saveWiki"
        :archive-wiki="archiveWiki"
        :reindex-wiki="reindexWiki"
        :open-skill="openSkill"
        :save-skill="saveSkill"
        :set-skill-active="setSkillActive"
        :set-automation-status="setAutomationStatus"
        :use-management-resource-in-chat="useManagementResourceInChat"
      />
    </section>

    <ContextDrawer
      :open="drawerOpen"
      :label="label"
      :latest-backend-run="latestBackendRun"
      :latest-backend-events="latestBackendEvents"
      :last-surface-render-spec="lastSurfaceRenderSpec"
      :memory="memory"
      :first-memory="firstMemory"
        :backend-run-context-summary="backendRunContextSummary"
        :backend-run-status-label="(run) => backendRunStatusLabel(run, label)"
      :surface-renderer-label="surfaceRendererLabel"
      :is-backend-event-open="isBackendEventOpen"
      :toggle-backend-event="toggleBackendEvent"
      :backend-event-summary="backendEventSummary"
      :backend-event-payload="backendEventPayload"
      :memory-excerpt="memoryExcerpt"
      :memory-state-label="memoryStateLabel"
      :open-memory="openMemory"
      @close="drawerOpen = false"
    />
  </main>
</template>
