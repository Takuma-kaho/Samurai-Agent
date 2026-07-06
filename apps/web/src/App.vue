<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import Archive from "lucide-vue-next/dist/esm/icons/archive.js";
import ArrowDown from "lucide-vue-next/dist/esm/icons/arrow-down.js";
import ArrowLeft from "lucide-vue-next/dist/esm/icons/arrow-left.js";
import ArrowUp from "lucide-vue-next/dist/esm/icons/arrow-up.js";
import BarChart3 from "lucide-vue-next/dist/esm/icons/chart-column.js";
import Brain from "lucide-vue-next/dist/esm/icons/brain.js";
import ChevronRight from "lucide-vue-next/dist/esm/icons/chevron-right.js";
import Clock3 from "lucide-vue-next/dist/esm/icons/clock-3.js";
import Copy from "lucide-vue-next/dist/esm/icons/copy.js";
import Eye from "lucide-vue-next/dist/esm/icons/eye.js";
import FileInput from "lucide-vue-next/dist/esm/icons/file-input.js";
import FileText from "lucide-vue-next/dist/esm/icons/file-text.js";
import Maximize2 from "lucide-vue-next/dist/esm/icons/maximize-2.js";
import PanelLeftClose from "lucide-vue-next/dist/esm/icons/panel-left-close.js";
import PanelLeftOpen from "lucide-vue-next/dist/esm/icons/panel-left-open.js";
import PanelRightOpen from "lucide-vue-next/dist/esm/icons/panel-right-open.js";
import PanelsTopLeft from "lucide-vue-next/dist/esm/icons/panels-top-left.js";
import Pencil from "lucide-vue-next/dist/esm/icons/pencil.js";
import Plus from "lucide-vue-next/dist/esm/icons/plus.js";
import RotateCcw from "lucide-vue-next/dist/esm/icons/rotate-ccw.js";
import Save from "lucide-vue-next/dist/esm/icons/save.js";
import Search from "lucide-vue-next/dist/esm/icons/search.js";
import Settings from "lucide-vue-next/dist/esm/icons/settings.js";
import Table2 from "lucide-vue-next/dist/esm/icons/table-2.js";
import ThumbsDown from "lucide-vue-next/dist/esm/icons/thumbs-down.js";
import ThumbsUp from "lucide-vue-next/dist/esm/icons/thumbs-up.js";
import Trash2 from "lucide-vue-next/dist/esm/icons/trash-2.js";
import X from "lucide-vue-next/dist/esm/icons/x.js";
import type {
  ActivityInboxItem,
  ApprovalRequest,
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
  ResourceRef,
  RollbackPoint,
  SessionRecord,
  SettingsRecord,
  SupportedLocale,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import { supportedLocales } from "@samurai-agent/core-schemas";
import { type LocaleKey, t } from "@samurai-agent/localization";
import type { SurfaceOperation, SurfaceRenderKind, SurfaceRendererCapabilities, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import { io } from "socket.io-client";
import {
  api,
  ApiError,
  type AgentBackendStatus,
  type ApprovalLifecyclePayload,
  type ArchiveMemoryPayload,
  type ArtifactDetail,
  type MemoryDetail,
  type ProviderErrorPayload,
  type SearchResult,
  type SessionDetail,
  type SurfaceContractPayload
} from "./lib/api";
import CollectionWorkspaceView from "./components/CollectionWorkspaceView.vue";
import CustomViewFrame from "./components/CustomViewFrame.vue";
import {
  appCollectionData,
  appCollectionRecords,
  appCollectionViewConfig,
  collectionActionRunPayload,
  collectionCalendarDateSelection,
  collectionCreateDataForView,
  collectionCreateDraftForView,
  collectionDraftValueFromRaw,
  collectionKanbanColumnsForRecords,
  collectionKanbanDragPayload,
  collectionKanbanDropPatch,
  collectionPresentationOpenOperation,
  collectionPresentationForSpec,
  collectionPresentationPreviewSpec,
  collectionRenderer,
  collectionTableId,
  collectionTableViewId,
  collectionUserViewState,
  collectionViewState,
  withCollectionViewState,
  withPresentationViewState
} from "./lib/collection-view-state";

type ViewMode = "chat" | "search" | "settings" | "runs" | "memory" | "collections";
type CanvasMode = "preview" | "edit" | "app";
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
  presentations: MessagePresentationRecord[];
  state?: "pending" | "loading";
  created_at?: string;
  activityItems?: WorkActivityItem[];
  streamItems?: PendingAgentStreamItem[];
};
type WorkChangeCard = {
  change: WorkspaceChangeRecord;
  rollbackPoint?: RollbackPoint;
  added?: number;
  removed?: number;
};
type WorkSummaryBlock = {
  run?: BackendRunRecord;
  summary: string;
  artifacts: ArtifactRecord[];
  changes: WorkChangeCard[];
  activityItems: WorkActivityItem[];
  pendingRequests: ApprovalRequest[];
  added?: number;
  removed?: number;
};
type WorkActivityKind = "files_read" | "code_searched" | "command_run" | "browser_checked" | "artifact_created" | "workspace_prepared" | "memory_prepared" | "skill_prepared" | "waiting";
type WorkActivityItem = {
  kind: WorkActivityKind;
  label: string;
  count?: number;
};
type PendingAgentStreamItem =
  | {
      id: string;
      kind: "reasoning_text" | "assistant_text";
      receivedText: string;
      displayedText: string;
    }
  | {
      id: string;
      kind: "activity";
      activity: WorkActivityItem;
    };
type WorkChangeSummaryKind = "files" | "workspace";
type MessageFeedback = "up" | "down" | undefined;
type PendingApprovalChoice = "allow" | "allow_prefix" | "deny";
const settings = ref<SettingsRecord>({
  ui_locale: "ja",
  output_locale: "ja",
  memory_capture_mode: "suggest",
  knowledge_wiki_capture_mode: "suggest",
  skill_capture_mode: "suggest",
  external_provider_role: "assistive",
  updated_at: new Date().toISOString()
});
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
const pendingApprovalChoices = ref<Record<string, PendingApprovalChoice>>({});
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
const openBackendEventIds = ref<Set<string>>(new Set());
const openBackendRunIds = ref<Set<string>>(new Set());
const settingsReturnMode = ref<ViewMode>("chat");
const loading = ref(false);
const initializing = ref(true);
const sessionLoadError = ref(false);
const pendingUserMessage = ref<ChatDisplayMessage | null>(null);
const pendingUserMessageStartIndex = ref(0);
const agentResponsePending = ref(false);
const pendingAgentReceivedContent = ref("");
const pendingAgentDisplayedContent = ref("");
const pendingAgentActivity = ref<WorkActivityItem[]>([]);
const pendingAgentStreamItems = ref<PendingAgentStreamItem[]>([]);
const pendingAgentRunId = ref<string | undefined>();
const messageFeedback = ref<Record<string, MessageFeedback>>({});
const expandedMessageIds = ref<Set<string>>(new Set());
const openWorkActivityRunIds = ref<Set<string>>(new Set());
const workChangesExpanded = ref(false);
const providerNotice = ref<ProviderNotice | null>(null);
const providerNoticeDetailsOpen = ref(false);
const providerNoticeTitle = computed(() => (providerNotice.value ? label(`provider_error.${providerNotice.value.reason}.title` as LocaleKey) : ""));
const providerNoticeBody = computed(() => (providerNotice.value ? label(`provider_error.${providerNotice.value.reason}.body` as LocaleKey) : ""));
const providerNoticeDetails = computed(() => formatProviderNoticeDetails(providerNotice.value));
const activeArtifact = ref<ArtifactDetail | null>(null);
const activeMemory = ref<MemoryDetail | null>(null);
const activeSurfaceSpec = ref<SurfaceRenderSpec | null>(null);
const canvasModeStorageKey = "samurai-agent.workspace-canvas-mode";
const canvasMode = ref<CanvasMode>(readCanvasMode());
const surfaceFormDraft = ref<Record<string, Record<string, JsonValue>>>({});
const surfaceTableDraft = ref<Record<string, Record<string, Record<string, JsonValue>>>>({});
const taskDraftTitle = ref("");
const taskDrafts = ref<Record<string, Record<string, string>>>({});
const collectionDrafts = ref<Record<string, Record<string, string>>>({});
const collectionNewDraft = ref<Record<string, string>>({});
const collectionSaving = ref(false);
const collectionAppError = ref<string | null>(null);
const activeMessagePresentationId = ref<string | null>(null);
const collectionDraggedRecordId = ref<string | null>(null);
const taskSaving = ref(false);
const taskAppError = ref<string | null>(null);
const memoryContent = ref<Record<string, string>>({});
const settingsStorageKey = "samurai-agent.settings";
const backendStorageKey = "samurai-agent.selected-backend-id";
const workspaceSplitStorageKey = "samurai-agent.workspace-split-percent";
const workspaceSplitMin = 32;
const workspaceSplitMax = 68;
const workspaceSplitDefault = 50;
const frontendSurfaceKinds = ["chat", "status_timeline", "form", "table", "chart", "artifact", "memory", "run_history", "custom_view"] as const satisfies readonly SurfaceRenderKind[];
const preferredExternalBackendIds = ["codex", "claude-code"] as const;
let chatScrollResizeObserver: ResizeObserver | undefined;
let observedChatScrollElement: HTMLDivElement | null = null;
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
const captureModes: SettingsRecord["memory_capture_mode"][] = ["manual", "suggest", "off"];
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
const activeActivity = computed(() =>
  activity.value.filter((item) => {
    if (!activeSession.value || !item.operation_id) {
      return true;
    }
    return operationsById.value.get(item.operation_id)?.session_id === activeSession.value.id;
  })
);
const latestBackendEvents = computed(() => {
  if (!activeSession.value) {
    return backendEvents.value.slice(0, 8);
  }
  return backendEvents.value.filter((event) => event.session_id === activeSession.value?.id).slice(-8).reverse();
});
const latestBackendRun = computed(() => {
  const activeSessionId = activeSession.value?.id;
  return backendRuns.value
    .filter((run) => !activeSessionId || run.session_id === activeSessionId)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
});
const hasActivity = computed(() => latestBackendEvents.value.length > 0);
const pendingLegacyApprovals = computed(() =>
  approvalRequests.value.filter((request) => {
    if (request.status !== "pending") {
      return false;
    }
    const operation = operationsById.value.get(request.operation_id);
    return !activeSession.value || operation?.session_id === activeSession.value.id;
  })
);
const workSummaryBlock = computed<WorkSummaryBlock | undefined>(() => {
  const activeSessionId = activeSession.value?.id;
  const sessionRuns = backendRuns.value
    .filter((run) => !activeSessionId || run.session_id === activeSessionId)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const run = sessionRuns[0];
  const allRunChanges = workspaceChanges.value
    .filter((change) => (!activeSessionId || change.session_id === activeSessionId) && (!run || change.run_id === run.id))
    .map((change) => ({
      change,
      rollbackPoint: rollbackPoints.value.find((point) => point.affected_resources.some((ref) => ref.id === change.resource_ref.id)),
      ...workspaceChangeStats(change)
    }));
  const relevantChanges = allRunChanges.filter((item) => isUserFacingWorkChange(item.change));
  const relevantArtifacts = artifacts.value.filter((artifact) => !run || relevantChanges.some((item) => item.change.resource_ref.id === artifact.id || item.change.resource_ref.uri === artifact.file_ref.uri));
  const pendingRequests = pendingLegacyApprovals.value;
  if (!run && relevantArtifacts.length === 0 && relevantChanges.length === 0 && pendingRequests.length === 0) {
    return undefined;
  }
  const runEvents = run ? backendEvents.value.filter((event) => event.run_id === run.id).sort((a, b) => a.sequence - b.sequence) : [];
  const totals = relevantChanges.reduce(
    (sum, item) => ({
      added: sum.added + (item.added ?? 0),
      removed: sum.removed + (item.removed ?? 0),
      hasStats: sum.hasStats || item.added !== undefined || item.removed !== undefined
    }),
    { added: 0, removed: 0, hasStats: false }
  );
  return {
    run,
    summary: runDurationLabel(run),
    artifacts: relevantArtifacts.slice(0, 3),
    changes: relevantChanges,
    activityItems: summarizeWorkActivity(runEvents),
    pendingRequests,
    ...(totals.hasStats ? { added: totals.added, removed: totals.removed } : {})
  };
});
const workSummaryCodexStreamItems = computed(() => {
  const run = workSummaryBlock.value?.run;
  if (!run) {
    return [];
  }
  return codexStyleStreamItemsForEvents(
    backendEvents.value
      .filter((event) => event.run_id === run.id)
      .sort((a, b) => a.sequence - b.sequence)
  );
});
const visibleWorkChanges = computed(() => {
  const changes = workSummaryBlock.value?.changes ?? [];
  return workChangesExpanded.value ? changes : changes.slice(0, 3);
});
const hiddenWorkChangeCount = computed(() => Math.max(0, (workSummaryBlock.value?.changes.length ?? 0) - visibleWorkChanges.value.length));
const firstReversibleWorkRollback = computed(() => workSummaryBlock.value?.changes.find((item) => item.rollbackPoint?.reversible)?.rollbackPoint);
const workSummaryMessageId = computed(() => {
  const runMessageId = workSummaryBlock.value?.run?.output_message_id;
  if (runMessageId && currentMessages.value.some((message) => message.id === runMessageId)) {
    return runMessageId;
  }
  return [...currentMessages.value].reverse().find((message) => message.role === "agent" && message.state !== "loading")?.id ?? "";
});
const firstMemory = computed(() => memory.value[0]);
const hasWorkspaceCanvas = computed(() => Boolean(activeArtifact.value || activeMemory.value || activeSurfaceSpec.value));
const workspaceSplitPercent = ref(readWorkspaceSplitPercent());
const isResizingWorkspace = ref(false);
const workspaceSplitStyle = computed<Record<string, string>>(() => ({
  "--workspace-chat-percent": `${workspaceSplitPercent.value}%`,
  "--workspace-canvas-percent": `${100 - workspaceSplitPercent.value}%`
}));
const isDraftChat = computed(() => !activeSession.value && currentMessages.value.length === 0 && viewMode.value === "chat");
const chatScrollFrameClass = computed(() => ({
  "has-top-fade": chatScrollState.value.canScroll && !chatScrollState.value.atTop,
  "has-bottom-fade": chatScrollState.value.canScroll && !chatScrollState.value.atBottom
}));
let previousBodyCursor = "";
let previousBodyUserSelect = "";
let pendingAgentTypingTimer: number | undefined;

onMounted(async () => {
  const storedSettings = readStoredSettings();
  if (storedSettings) {
    settings.value = storedSettings;
  }
  connectSocket();
  await Promise.all([loadSettings(), loadAgentBackends(), loadSurfaceContract(), loadSessionsWithRetry()]);
});

onUnmounted(() => {
  stopPendingAgentTyping();
  chatScrollResizeObserver?.disconnect();
  finishWorkspaceResize();
  clearAttachments();
});

watch(
  [() => currentMessages.value.length, () => artifacts.value.length, () => memory.value.length, () => selectedAttachments.value.length, hasWorkspaceCanvas, viewMode],
  () => scheduleChatScrollCheck()
);

watch(activeSurfaceSpec, (spec) => {
  if (!spec) {
    return;
  }
  canvasMode.value = defaultCanvasMode(spec);
  persistCanvasMode(canvasMode.value);
  if (spec.kind === "form") {
    surfaceFormDraft.value = {
      ...surfaceFormDraft.value,
      [spec.id]: Object.fromEntries(surfaceFields(spec).map((field) => [field.name, toJsonValue(field.value)]))
    };
  }
  if (spec.kind === "table") {
    surfaceTableDraft.value = {
      ...surfaceTableDraft.value,
      [spec.id]: Object.fromEntries(surfaceTableRows(spec).map((row, index) => [surfaceRowKey(row, index), objectToJsonRecord(row)]))
    };
  }
  if (isTaskListSurfaceSpec(spec)) {
    syncTaskDrafts(spec);
  }
  if (isCollectionTableSurfaceSpec(spec)) {
    syncCollectionDrafts(spec);
  }
});

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

function resetPendingAgentResponse() {
  stopPendingAgentTyping();
  agentResponsePending.value = false;
  pendingAgentReceivedContent.value = "";
  pendingAgentDisplayedContent.value = "";
  pendingAgentActivity.value = [];
  pendingAgentStreamItems.value = [];
  pendingAgentRunId.value = undefined;
}

function stopPendingAgentTyping() {
  if (pendingAgentTypingTimer !== undefined) {
    window.clearTimeout(pendingAgentTypingTimer);
    pendingAgentTypingTimer = undefined;
  }
}

function flushPendingAgentTyping() {
  stopPendingAgentTyping();
  pendingAgentDisplayedContent.value = pendingAgentReceivedContent.value;
  pendingAgentStreamItems.value = pendingAgentStreamItems.value.map((item) => {
    if (item.kind === "activity") {
      return item;
    }
    return { ...item, displayedText: item.receivedText };
  });
}

function schedulePendingAgentTyping() {
  if (pendingAgentTypingTimer !== undefined) {
    return;
  }
  pendingAgentTypingTimer = window.setTimeout(tickPendingAgentTyping, 16);
}

function tickPendingAgentTyping() {
  pendingAgentTypingTimer = undefined;
  if (!agentResponsePending.value) {
    return;
  }
  const received = pendingAgentReceivedContent.value;
  const displayed = pendingAgentDisplayedContent.value;
  if (displayed.length >= received.length) {
    return;
  }
  const remaining = received.length - displayed.length;
  const step = remaining > 160 ? 8 : remaining > 60 ? 4 : 1;
  pendingAgentDisplayedContent.value = received.slice(0, displayed.length + step);
  const activeItem = pendingAgentStreamItems.value.find((item) => item.kind !== "activity" && item.displayedText.length < item.receivedText.length);
  if (activeItem && activeItem.kind !== "activity") {
    const itemRemaining = activeItem.receivedText.length - activeItem.displayedText.length;
    const itemStep = itemRemaining > 160 ? 8 : itemRemaining > 60 ? 4 : 1;
    pendingAgentStreamItems.value = pendingAgentStreamItems.value.map((item) => {
      if (item.id !== activeItem.id || item.kind === "activity") {
        return item;
      }
      return { ...item, displayedText: item.receivedText.slice(0, item.displayedText.length + itemStep) };
    });
  }
  if (pendingAgentDisplayedContent.value.length < received.length || pendingAgentStreamItems.value.some((item) => item.kind !== "activity" && item.displayedText.length < item.receivedText.length)) {
    pendingAgentTypingTimer = window.setTimeout(tickPendingAgentTyping, 18);
  }
}

function pendingAgentDisplayedPlainText(): string {
  if (pendingAgentStreamItems.value.length === 0) {
    return pendingAgentDisplayedContent.value;
  }
  return pendingAgentStreamItems.value
    .flatMap((item) => item.kind === "activity" ? [] : [item.displayedText])
    .filter(Boolean)
    .join("\n\n");
}

function appendPendingAgentText(kind: "reasoning_text" | "assistant_text", text: string) {
  if (!text) {
    return;
  }
  pendingAgentReceivedContent.value += text;
  const last = pendingAgentStreamItems.value.at(-1);
  if (last && last.kind === kind) {
    pendingAgentStreamItems.value = pendingAgentStreamItems.value.map((item) =>
      item.id === last.id && item.kind !== "activity"
        ? { ...item, receivedText: item.receivedText + text }
        : item
    );
  } else {
    pendingAgentStreamItems.value = [
      ...pendingAgentStreamItems.value,
      {
        id: `stream-text-${Date.now()}-${pendingAgentStreamItems.value.length}`,
        kind,
        receivedText: text,
        displayedText: ""
      }
    ];
  }
  schedulePendingAgentTyping();
}

function activityWithCount(activity: WorkActivityItem, count: number): WorkActivityItem {
  return {
    ...activity,
    count,
    label: count > 1 ? `${activity.label.replace(/\s+\d+件$/, "")} ${count}件` : activity.label.replace(/\s+\d+件$/, "")
  };
}

function appendStreamActivity(items: PendingAgentStreamItem[], activity: WorkActivityItem, id: string): PendingAgentStreamItem[] {
  const last = items.at(-1);
  if (last?.kind === "activity") {
    if (last.activity.kind === activity.kind && normalizedActivityLabel(last.activity.label) === normalizedActivityLabel(activity.label)) {
      const nextCount = (last.activity.count ?? 1) + 1;
      return items.map((item) =>
        item.id === last.id && item.kind === "activity"
          ? { ...item, activity: activityWithCount(activity, nextCount) }
          : item
      );
    }
    return [
      ...items,
      {
        id: `${id}-reasoning-bridge`,
        kind: "reasoning_text",
        receivedText: "作業結果を確認し、次の手順に進んでいます。",
        displayedText: "作業結果を確認し、次の手順に進んでいます。"
      },
      { id, kind: "activity", activity }
    ];
  }
  return [...items, { id, kind: "activity", activity }];
}

function normalizedActivityLabel(label: string): string {
  return label.replace(/\s+\d+件$/, "").trim();
}

function appendPendingAgentActivity(activity: WorkActivityItem, event: BackendEventRecord) {
  pendingAgentActivity.value = [...pendingAgentActivity.value.filter((item) => item.kind !== activity.kind), activity];
  pendingAgentStreamItems.value = appendStreamActivity(pendingAgentStreamItems.value, activity, `stream-activity-${event.id}`);
}

function codexStyleStreamItemsForEvents(events: BackendEventRecord[]): PendingAgentStreamItem[] {
  const items: PendingAgentStreamItem[] = [];
  const appendText = (kind: "reasoning_text" | "assistant_text", text: string, id: string) => {
    if (!text) {
      return;
    }
    const last = items.at(-1);
    if (last && last.kind === kind) {
      items[items.length - 1] = {
        ...last,
        receivedText: `${last.receivedText}${text}`,
        displayedText: `${last.displayedText}${text}`
      };
      return;
    }
    items.push({ id, kind, receivedText: text, displayedText: text });
  };
  for (const event of events) {
    if (event.event_type === "agent_reasoning" && typeof event.payload.text === "string") {
      appendText("reasoning_text", event.payload.text, `saved-reasoning-${event.id}`);
      continue;
    }
    if (event.event_type === "host_progress" && typeof event.payload.text === "string") {
      if (event.payload.display_kind === "reasoning_summary") {
        appendText("reasoning_text", event.payload.text, `saved-host-progress-${event.id}`);
      } else {
        items.splice(0, items.length, ...appendStreamActivity(items, { kind: "workspace_prepared", label: event.payload.text }, `saved-host-activity-${event.id}`));
      }
      continue;
    }
    if (event.event_type === "text_delta" && typeof event.payload.text === "string") {
      appendText("assistant_text", event.payload.text, `saved-text-${event.id}`);
      continue;
    }
    const activity = streamingActivityItem(event);
    if (activity) {
      items.splice(0, items.length, ...appendStreamActivity(items, activity, `saved-activity-${event.id}`));
    }
  }
  return items;
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

async function sendMessage() {
  if (prompt.value.trim().length === 0 || loading.value) {
    return;
  }
  const content = prompt.value.trim();
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
  if (!spec || (!isTaskListSurfaceSpec(spec) && !isCollectionTableSurfaceSpec(spec))) {
    return undefined;
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
  const stored = readStoredBackendId();
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
  return backend.configured && backend.enabled !== false;
}

function setSelectedBackend(id: string) {
  selectedBackendId.value = id;
  backendPickerOpen.value = false;
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

function isBackendEventOpen(id: string): boolean {
  return openBackendEventIds.value.has(id);
}

function toggleBackendEvent(id: string) {
  const next = new Set(openBackendEventIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  openBackendEventIds.value = next;
}

function isBackendRunOpen(id: string): boolean {
  return openBackendRunIds.value.has(id);
}

function toggleBackendRun(id: string) {
  const next = new Set(openBackendRunIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  openBackendRunIds.value = next;
}

function backendEventSummary(event: BackendEventRecord): string {
  const payload = event.payload;
  if (isRecord(payload)) {
    const candidates = [payload.text, payload.message, payload.output_summary, payload.error_code, payload.status, payload.reason];
    const summary = candidates.find((value) => typeof value === "string" && value.trim().length > 0);
    if (typeof summary === "string") {
      return summary.slice(0, 120);
    }
  }
  return event.event_type;
}

function backendEventPayload(event: BackendEventRecord): string {
  return JSON.stringify(event.payload, null, 2);
}

function backendRunNote(run: BackendRunRecord): string {
  return run.output_summary || run.error_code || "";
}

function backendRunContextSummary(run: BackendRunRecord | undefined): string {
  const handoffSources = contextHandoffSources(run);
  const sources = handoffSources.length > 0 ? handoffSources : contextAssemblySources(run);
  if (sources.length === 0) {
    return "文脈情報: 未使用";
  }
  const sourceLabel: Record<string, string> = {
    freeze_snapshot: "プロフィール",
    session_search: "過去会話検索",
    active_memory: "Memory",
    knowledge_wiki: "Knowledge Wiki",
    selected_skills: "Skill",
    collection_notes: "Collection",
    external_assist: "External assist",
    recent_messages: "直近会話",
    available_tools: "ツール",
    gateway_boundary: "Gateway"
  };
  const trackedKinds = new Set(["freeze_snapshot", "active_memory", "knowledge_wiki", "selected_skills", "session_search", "collection_notes", "external_assist", "recent_messages", "available_tools", "gateway_boundary"]);
  const parts: string[] = [];
  for (const source of sources.filter((item) => trackedKinds.has(item.kind))) {
    const mode = "mode" in source && source.mode === "pointer" ? "参照先" : "mode" in source && source.mode === "inline" ? "本文" : "";
    const status = source.status === "skipped" || ("mode" in source && source.mode === "skipped")
      ? "スキップ"
      : source.included_count > 0 ? `${mode || "使用"} ${source.included_count}件` : "未使用";
    parts.push(`${sourceLabel[source.kind] ?? source.kind}: ${status}`);
  }
  return parts.length > 0 ? parts.join(" / ") : "文脈情報: 未使用";
}

function contextHandoffSources(run: BackendRunRecord | undefined): Array<{ kind: string; included_count: number; candidate_count?: number; mode: string; status?: string }> {
  const value = run?.metadata?.context_handoff_sources;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.kind !== "string" || typeof item.included_count !== "number" || typeof item.mode !== "string") {
      return [];
    }
    return [{
      kind: item.kind,
      included_count: item.included_count,
      mode: item.mode,
      ...(typeof item.candidate_count === "number" ? { candidate_count: item.candidate_count } : {}),
      ...(item.mode === "skipped" ? { status: "skipped" } : {})
    }];
  });
}

function contextAssemblySources(run: BackendRunRecord | undefined): Array<{ kind: string; included_count: number; candidate_count?: number; status?: string }> {
  const value = run?.metadata?.context_assembly_sources;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.kind !== "string" || typeof item.included_count !== "number") {
      return [];
    }
    return [{
      kind: item.kind,
      included_count: item.included_count,
      ...(typeof item.candidate_count === "number" ? { candidate_count: item.candidate_count } : {}),
      ...(typeof item.status === "string" ? { status: item.status } : {})
    }];
  });
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

async function openArtifact(id: string) {
  activeArtifact.value = await api.getArtifact(id);
  activeMemory.value = null;
  activeSurfaceSpec.value = null;
  activeMessagePresentationId.value = null;
}

async function openMemory(id: string) {
  activeMemory.value = await api.getMemory(id);
  activeArtifact.value = null;
  activeSurfaceSpec.value = null;
  activeMessagePresentationId.value = null;
  memoryContent.value = {
    ...memoryContent.value,
    [id]: activeMemory.value.content
  };
}

function closeWorkspaceCanvas() {
  activeArtifact.value = null;
  activeMemory.value = null;
  activeSurfaceSpec.value = null;
  activeMessagePresentationId.value = null;
}

function openSurfaceSpec(spec: SurfaceRenderSpec) {
  activeSurfaceSpec.value = spec;
  activeArtifact.value = null;
  activeMemory.value = null;
  activeMessagePresentationId.value = null;
  setCanvasMode(defaultCanvasMode(spec));
  if (isTaskListSurfaceSpec(spec)) {
    syncTaskDrafts(spec);
  }
  if (isCollectionTableSurfaceSpec(spec)) {
    syncCollectionDrafts(spec);
  }
}

async function runArtifactSurfaceOperation(kind: "form" | "table" | "chart" | "custom_view") {
  if (!activeSession.value || !activeArtifact.value || loading.value) {
    return;
  }
  loading.value = true;
  try {
    const artifact = activeArtifact.value.artifact;
    const base = {
      id: `surface_${kind}_${Date.now()}`,
      session_id: activeSession.value.id,
      input_locale: settings.value.ui_locale,
      output_locale: settings.value.output_locale,
      renderer_capabilities: frontendRendererCapabilities.value,
      metadata: {
        frontend_surface_contract_version: surfaceContract.value?.protocol_version ?? "1",
        frontend_surface_action: kind,
        source_artifact_id: artifact.id
      }
    };
    const operation: SurfaceOperation = kind === "form"
      ? {
          ...base,
          kind: "form.submit",
          form_id: `artifact.${artifact.id}.review`,
          values: {
            artifact_id: artifact.id,
            title: artifact.title,
            kind: artifact.kind
          },
          submit_label: "Save"
        }
      : kind === "table"
        ? {
            ...base,
            kind: "table.patch",
            table_id: `artifact.${artifact.id}.table`,
            row_id: artifact.id,
            changes: {
              title: artifact.title,
              kind: artifact.kind,
              file_path: artifact.file_ref.uri
            }
          }
        : kind === "chart"
          ? {
              ...base,
              kind: "chart.request",
              chart_id: `artifact.${artifact.id}.chart`,
              title: `${artifact.title} chart`,
              query: `Summarize ${artifact.title} as chart-ready workspace data.`,
              data_refs: [artifact.file_ref.uri]
            }
          : {
              ...base,
              kind: "custom_view.action",
              view_id: `artifact.${artifact.id}.custom`,
              action_id: "open",
              payload: {
                renderer: "generic",
                artifact_id: artifact.id,
                title: artifact.title,
                file_path: artifact.file_ref.uri
              }
            };
    const envelope = await api.runSurfaceOperation<{ resource?: unknown; workspaceChange?: WorkspaceChangeRecord }>(operation);
    lastSurfaceRenderSpec.value = envelope.render_spec;
    activeSurfaceSpec.value = envelope.render_spec;
    await reloadActiveSession();
    if (isArtifactRecordLike(envelope.result.resource)) {
      activeArtifact.value = await api.getArtifact(envelope.result.resource.id);
    }
  } finally {
    loading.value = false;
  }
}

async function submitSurfaceForm(spec: SurfaceRenderSpec) {
  if (!activeSession.value || spec.kind !== "form" || loading.value) {
    return;
  }
  loading.value = true;
  try {
    const values = surfaceFormDraft.value[spec.id] ?? Object.fromEntries(surfaceFields(spec).map((field) => [field.name, toJsonValue(field.value)]));
    const envelope = await api.runSurfaceOperation<{ resource?: unknown; workspaceChange?: WorkspaceChangeRecord }>({
      id: `surface_form_submit_${Date.now()}`,
      kind: "form.submit",
      session_id: activeSession.value.id,
      form_id: String(spec.props.form_id),
      values,
      submit_label: typeof spec.props.submit_label === "string" ? spec.props.submit_label : undefined,
      input_locale: settings.value.ui_locale,
      output_locale: settings.value.output_locale,
      renderer_capabilities: frontendRendererCapabilities.value,
      metadata: {
        frontend_surface_contract_version: surfaceContract.value?.protocol_version ?? "1",
        source_render_spec_id: spec.id
      }
    });
    lastSurfaceRenderSpec.value = envelope.render_spec;
    activeSurfaceSpec.value = envelope.render_spec;
    await reloadActiveSession();
  } finally {
    loading.value = false;
  }
}

async function saveSurfaceTableRow(spec: SurfaceRenderSpec, row: Record<string, unknown>, rowIndex: number) {
  if (!activeSession.value || spec.kind !== "table" || loading.value) {
    return;
  }
  loading.value = true;
  try {
    const rowKey = surfaceRowKey(row, rowIndex);
    const draft = surfaceTableDraft.value[spec.id]?.[rowKey] ?? row;
    const envelope = await api.runSurfaceOperation<{ resource?: unknown; workspaceChange?: WorkspaceChangeRecord }>({
      id: `surface_table_patch_${Date.now()}`,
      kind: "table.patch",
      session_id: activeSession.value.id,
      table_id: String(spec.props.table_id),
      row_id: typeof row.id === "string" ? row.id : rowKey,
      changes: objectToJsonRecord(draft),
      input_locale: settings.value.ui_locale,
      output_locale: settings.value.output_locale,
      renderer_capabilities: frontendRendererCapabilities.value,
      metadata: {
        frontend_surface_contract_version: surfaceContract.value?.protocol_version ?? "1",
        source_render_spec_id: spec.id
      }
    });
    lastSurfaceRenderSpec.value = envelope.render_spec;
    activeSurfaceSpec.value = envelope.render_spec;
    await reloadActiveSession();
  } finally {
    loading.value = false;
  }
}

async function runCustomViewAction(spec: SurfaceRenderSpec, action: { id: string; label: string }, actionPayload: Record<string, JsonValue> = {}) {
  if (!activeSession.value || spec.kind !== "custom_view" || loading.value) {
    return;
  }
  loading.value = true;
  try {
    const envelope = await api.runSurfaceOperation<{ resource?: unknown; workspaceChange?: WorkspaceChangeRecord }>({
      id: `surface_custom_action_${Date.now()}`,
      kind: "custom_view.action",
      session_id: activeSession.value.id,
      view_id: String(spec.props.view_id),
      action_id: action.id,
      payload: {
        ...actionPayload,
        renderer: String(spec.props.renderer),
        source_render_spec_id: spec.id,
        data: toJsonValue(spec.props.data)
      },
      input_locale: settings.value.ui_locale,
      output_locale: settings.value.output_locale,
      renderer_capabilities: frontendRendererCapabilities.value,
      metadata: {
        frontend_surface_contract_version: surfaceContract.value?.protocol_version ?? "1"
      }
    });
    lastSurfaceRenderSpec.value = envelope.render_spec;
    activeSurfaceSpec.value = envelope.render_spec;
    await reloadActiveSession();
  } finally {
    loading.value = false;
  }
}

async function approveRequest(request: ApprovalRequest) {
  await handleApprovalLifecycle(() => api.approveApprovalRequest(request.id));
}

async function denyRequest(request: ApprovalRequest) {
  await handleApprovalLifecycle(() => api.denyApprovalRequest(request.id, label("approval.denied_reason")));
}

async function restoreWorkspaceChange(point: RollbackPoint) {
  if (loading.value || !point.reversible) {
    return;
  }
  loading.value = true;
  try {
    await api.restoreRollbackPoint(point.id);
    await reloadActiveSession();
  } finally {
    loading.value = false;
  }
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

function approvalRequestLabel(request: ApprovalRequest): string {
  if (request.status === "approved") {
    return label("approval.status.completed");
  }
  return request.status === "pending" ? label("approval.status.pending") : label(`approval.status.${request.status}` as LocaleKey);
}

function approvalRequestTitle(): string {
  return label("pending_request.title");
}

function approvalRequestReason(request: ApprovalRequest): string {
  if (!/approval|user-visible boundary|needs permission/i.test(request.reason)) {
    return request.reason;
  }
  const operation = operationsById.value.get(request.operation_id);
  const operationText = [
    operation?.capability_id,
    operation?.operation,
    ...(operation?.proposed_effects ?? []),
    ...(operation?.target_resource_refs.map((ref) => ref.kind) ?? [])
  ].join(" ");
  if (/command|shell|exec|terminal/i.test(operationText) || Boolean(approvalRequestCommandText(request))) {
    return label("pending_request.command_reason");
  }
  if (/write|patch|update|create|delete|file|artifact|memory|wiki|skill|collection/i.test(operationText)) {
    return label("pending_request.change_reason");
  }
  return label("pending_request.work_reason");
}

function approvalRequestCommandText(request: ApprovalRequest): string {
  const operation = operationsById.value.get(request.operation_id);
  if (!operation) {
    return "";
  }
  const commandLikeEffect = operation.proposed_effects.find((effect) => isCommandLikeText(effect));
  if (commandLikeEffect) {
    return commandLikeEffect;
  }
  return isCommandLikeText(operation.operation) ? operation.operation : "";
}

function isCommandLikeText(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  const text = value.trim();
  if (!text || /[.?!。！？]$/.test(text)) {
    return false;
  }
  return /^(?:CI=true\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*(?:pnpm|npm|yarn|bun|node|npx|go|cargo|python3?|pytest|rg|curl|git|vite|tsx|tsc|deno|make|bash|sh|zsh)\b/.test(text);
}

function pendingApprovalChoice(request: ApprovalRequest): PendingApprovalChoice {
  return pendingApprovalChoices.value[request.id] ?? "allow";
}

function setPendingApprovalChoice(request: ApprovalRequest, choice: PendingApprovalChoice) {
  pendingApprovalChoices.value = {
    ...pendingApprovalChoices.value,
    [request.id]: choice
  };
}

async function submitPendingApproval(request: ApprovalRequest) {
  if (pendingApprovalChoice(request) === "deny") {
    await denyRequest(request);
    return;
  }
  await approveRequest(request);
}

async function copyMessage(message: ChatDisplayMessage) {
  try {
    await navigator.clipboard.writeText(message.content);
  } catch {
    const textArea = document.createElement("textarea");
    textArea.value = message.content;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    textArea.remove();
  }
}

function setMessageFeedback(message: ChatDisplayMessage, value: "up" | "down") {
  messageFeedback.value = {
    ...messageFeedback.value,
    [message.id]: messageFeedback.value[message.id] === value ? undefined : value
  };
}

function toggleMessageExpanded(message: ChatDisplayMessage) {
  const next = new Set(expandedMessageIds.value);
  if (next.has(message.id)) {
    next.delete(message.id);
  } else {
    next.add(message.id);
  }
  expandedMessageIds.value = next;
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

function surfaceFields(spec: SurfaceRenderSpec): Array<{ name: string; label: string; type: string; value: unknown }> {
  const fields = Array.isArray(spec.props.fields) ? spec.props.fields : [];
  return fields.filter(isRecord).map((field) => ({
    name: typeof field.name === "string" ? field.name : "field",
    label: typeof field.label === "string" ? field.label : typeof field.name === "string" ? field.name : "Field",
    type: typeof field.type === "string" ? field.type : "text",
    value: field.default_value
  }));
}

function surfaceTableColumns(spec: SurfaceRenderSpec): Array<{ key: string; label: string }> {
  const columns = Array.isArray(spec.props.columns) ? spec.props.columns : [];
  return columns.filter(isRecord).map((column) => ({
    key: typeof column.key === "string" ? column.key : "value",
    label: typeof column.label === "string" ? column.label : typeof column.key === "string" ? column.key : "Value"
  }));
}

function surfaceTableRows(spec: SurfaceRenderSpec): Record<string, unknown>[] {
  const rows = Array.isArray(spec.props.rows) ? spec.props.rows : [];
  return rows.filter(isRecord);
}

function surfaceChartRefs(spec: SurfaceRenderSpec): string[] {
  return Array.isArray(spec.props.data_refs) ? spec.props.data_refs.filter((item): item is string => typeof item === "string") : [];
}

function surfaceCustomViewPayload(spec: SurfaceRenderSpec): string {
  return JSON.stringify(spec.props.data ?? spec.props, null, 2);
}

function isTaskListSurfaceSpec(spec: SurfaceRenderSpec): boolean {
  return spec.kind === "custom_view" && spec.props.renderer === "task_list";
}

function isCollectionTableSurfaceSpec(spec: SurfaceRenderSpec): boolean {
  return spec.kind === "custom_view" && collectionSurfaceRenderers.has(String(spec.props.renderer ?? ""));
}

const collectionSurfaceRenderers = new Set(["collection_table", "collection_gallery", "calendar_view", "collection_kanban"]);

function appCollectionSchemaFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  const fields = appCollectionData(spec).schema_fields;
  return Array.isArray(fields) ? fields.filter(isRecord) as Array<Record<string, JsonValue>> : [];
}

function collectionViewOptions(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  const options = appCollectionData(spec).view_options;
  if (Array.isArray(options)) {
    return options.filter(isRecord) as Array<Record<string, JsonValue>>;
  }
  return [{
    id: collectionTableViewId(spec),
    renderer: collectionRenderer(spec),
    label: collectionViewOptionLabel({ renderer: collectionRenderer(spec) })
  }];
}

function collectionViewOptionLabel(option: Record<string, unknown>): string {
  if (typeof option.label === "string" && option.label.trim()) {
    return option.label;
  }
  const renderer = String(option.renderer ?? "collection_table");
  if (renderer === "collection_gallery") return "Gallery";
  if (renderer === "calendar_view") return "Calendar";
  if (renderer === "collection_kanban") return "Kanban";
  return "Table";
}

function isActiveCollectionViewOption(spec: SurfaceRenderSpec, option: Record<string, unknown>): boolean {
  return String(option.id ?? "") === collectionTableViewId(spec);
}

async function switchCollectionView(spec: SurfaceRenderSpec, option: Record<string, JsonValue>) {
  const viewId = String(option.id ?? "");
  if (!viewId || viewId === collectionTableViewId(spec) || collectionSaving.value) {
    return;
  }
  const presentationId = activeMessagePresentationId.value;
  const previousState = collectionUserViewState(spec);
  collectionSaving.value = true;
  try {
    const envelope = await api.runSurfaceOperation({
      id: `surface_collection_view_switch_${Date.now()}`,
      kind: "collection.view.present",
      collection_id: collectionTableId(spec),
      view_id: viewId,
      renderer_capabilities: frontendRendererCapabilities.value
    });
    const nextSpec = envelope.render_spec;
    if (!isCollectionTableSurfaceSpec(nextSpec)) {
      throw new Error("collection_view_switch_render_spec_required");
    }
    openSurfaceSpec(nextSpec);
    activeMessagePresentationId.value = presentationId;
    lastSurfaceRenderSpec.value = nextSpec;
    lastSurfaceRenderSpecs.value = [nextSpec, ...lastSurfaceRenderSpecs.value.filter((item) => !(isCollectionTableSurfaceSpec(item) && collectionTableId(item) === collectionTableId(nextSpec)))];
    await updateActiveCollectionViewState({
      ...previousState,
      view_id: collectionTableViewId(nextSpec),
      renderer: collectionRenderer(nextSpec)
    });
  } catch (error) {
    collectionAppError.value = collectionSurfaceErrorMessage(error);
  } finally {
    collectionSaving.value = false;
  }
}

function collectionSearchQuery(spec: SurfaceRenderSpec): string {
  const value = collectionViewState(spec).search;
  return typeof value === "string" ? value : "";
}

function collectionSortState(spec: SurfaceRenderSpec): Record<string, JsonValue> {
  const stateSort = collectionViewState(spec).sort;
  if (isRecord(stateSort)) {
    return stateSort as Record<string, JsonValue>;
  }
  const configSort = appCollectionViewConfig(spec).sort;
  return isRecord(configSort) ? configSort as Record<string, JsonValue> : {};
}

function collectionSortFieldId(spec: SurfaceRenderSpec): string {
  const fieldId = collectionSortState(spec).field_id;
  return typeof fieldId === "string" ? fieldId : "";
}

function collectionSortDirection(spec: SurfaceRenderSpec): "asc" | "desc" {
  return collectionSortState(spec).direction === "desc" ? "desc" : "asc";
}

function collectionFilterState(spec: SurfaceRenderSpec): Record<string, JsonValue> {
  const value = collectionViewState(spec).filter;
  return isRecord(value) ? value as Record<string, JsonValue> : {};
}

function collectionFilterFieldId(spec: SurfaceRenderSpec): string {
  const fieldId = collectionFilterState(spec).field_id;
  return typeof fieldId === "string" ? fieldId : "";
}

function collectionFilterValue(spec: SurfaceRenderSpec): string {
  const value = collectionFilterState(spec).value;
  return typeof value === "string" ? value : "";
}

function collectionFilterField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  const stateField = collectionFilterFieldId(spec);
  if (stateField) {
    return collectionTableFields(spec).find((field) => collectionFieldId(field) === stateField);
  }
  return collectionEnumField(spec);
}

function collectionFilterOptions(spec: SurfaceRenderSpec): string[] {
  const field = collectionFilterField(spec);
  if (!field) return [];
  const fieldId = collectionFieldId(field);
  const configured = collectionEnumValues(field);
  const fromRecords = [...new Set(appCollectionRecords(spec).map((record) => collectionRecordText(record, fieldId)).filter(Boolean))];
  return configured.length > 0 ? configured : fromRecords;
}

function collectionGroupFieldId(spec: SurfaceRenderSpec): string {
  const stateGroup = collectionViewState(spec).group;
  if (typeof stateGroup === "string") {
    return stateGroup;
  }
  const configGroup = appCollectionViewConfig(spec).group ?? appCollectionViewConfig(spec).group_by;
  return typeof configGroup === "string" ? configGroup : "";
}

function collectionGroupFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  return collectionTableFields(spec).filter((field) => {
    const id = collectionFieldId(field);
    const type = collectionFieldType(field);
    return Boolean(id) && ["enum", "ref", "boolean", "date", "datetime", "string", "number"].includes(type);
  });
}

function collectionVisibleRecords(spec: SurfaceRenderSpec): Array<Record<string, unknown>> {
  const query = collectionSearchQuery(spec).trim().toLowerCase();
  const filterField = collectionFilterField(spec);
  const filterFieldId = filterField ? collectionFieldId(filterField) : "";
  const filterValue = collectionFilterValue(spec);
  const sortFieldId = collectionSortFieldId(spec);
  const direction = collectionSortDirection(spec) === "desc" ? -1 : 1;
  const records = appCollectionRecords(spec).filter((record) => {
    if (query && !collectionRecordSearchText(record).includes(query)) {
      return false;
    }
    if (filterFieldId && filterValue && collectionRecordText(record, filterFieldId) !== filterValue) {
      return false;
    }
    return true;
  });
  if (!sortFieldId) {
    return records;
  }
  return [...records].sort((left, right) => compareCollectionValues(left[sortFieldId], right[sortFieldId]) * direction);
}

function collectionStateSourceSpec(spec: SurfaceRenderSpec): SurfaceRenderSpec {
  return activeSurfaceSpec.value && isCollectionTableSurfaceSpec(activeSurfaceSpec.value) && collectionTableId(activeSurfaceSpec.value) === collectionTableId(spec)
    ? activeSurfaceSpec.value
    : spec;
}

function collectionSelectedRecordId(spec: SurfaceRenderSpec): string {
  const value = collectionViewState(collectionStateSourceSpec(spec)).selected_record_id;
  return typeof value === "string" ? value : "";
}

function collectionRecordId(record: Record<string, unknown>): string {
  return String(record.id ?? "");
}

function collectionRecordSelected(spec: SurfaceRenderSpec, record: Record<string, unknown>): boolean {
  const id = collectionRecordId(record);
  return Boolean(id) && collectionSelectedRecordId(spec) === id;
}

async function selectCollectionRecord(spec: SurfaceRenderSpec, record: Record<string, unknown>) {
  const id = collectionRecordId(record);
  if (!id || collectionSelectedRecordId(spec) === id) {
    return;
  }
  await updateActiveCollectionViewState({ selected_record_id: id });
}

function collectionRecordSearchText(record: Record<string, unknown>): string {
  return Object.values(record).map((value) => {
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }).join(" ").toLowerCase();
}

function compareCollectionValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left ?? "").localeCompare(String(right ?? ""), "ja", { numeric: true });
}

async function setCollectionSearchQuery(spec: SurfaceRenderSpec, search: string) {
  await updateActiveCollectionViewState({ search });
}

async function setCollectionSortField(spec: SurfaceRenderSpec, fieldId: string) {
  await updateActiveCollectionViewState({
    sort: fieldId ? { field_id: fieldId, direction: collectionSortDirection(spec) } : {}
  });
}

async function toggleCollectionSortDirection(spec: SurfaceRenderSpec) {
  const fieldId = collectionSortFieldId(spec);
  if (!fieldId) return;
  await updateActiveCollectionViewState({
    sort: { field_id: fieldId, direction: collectionSortDirection(spec) === "desc" ? "asc" : "desc" }
  });
}

async function setCollectionFilterValue(spec: SurfaceRenderSpec, value: string) {
  const field = collectionFilterField(spec);
  await updateActiveCollectionViewState({
    filter: field && value ? { field_id: collectionFieldId(field), value } : {}
  });
}

async function setCollectionGroupField(spec: SurfaceRenderSpec, fieldId: string) {
  await updateActiveCollectionViewState({ group: fieldId || null });
}

async function updateActiveCollectionViewState(patch: Record<string, JsonValue>) {
  if (!activeSurfaceSpec.value || !isCollectionTableSurfaceSpec(activeSurfaceSpec.value)) {
    return;
  }
  const nextSpec = withCollectionViewState(activeSurfaceSpec.value, patch);
  activeSurfaceSpec.value = nextSpec;
  await persistActiveCollectionPresentationState(nextSpec);
}

async function persistActiveCollectionPresentationState(spec: SurfaceRenderSpec) {
  if (!activeMessagePresentationId.value) {
    return;
  }
  try {
    const envelope = await api.updateMessagePresentationViewState(activeMessagePresentationId.value, collectionViewState(spec));
    const updated = envelope.result;
    messagePresentations.value = mergeById(messagePresentations.value, [updated]);
  } catch {
    // Workspace state can still move locally if the card state write fails.
  }
}

function collectionFieldId(field: Record<string, unknown>): string {
  return String(field.id ?? field.name ?? "");
}

function collectionRecordText(record: Record<string, unknown>, fieldId: string): string {
  const value = record[fieldId];
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function collectionFirstField(spec: SurfaceRenderSpec, options: { ids?: RegExp; types?: string[] } = {}): Record<string, JsonValue> | undefined {
  return collectionTableFields(spec).find((field) => {
    const id = collectionFieldId(field).toLowerCase();
    const type = collectionFieldType(field);
    return (!options.ids || options.ids.test(id)) && (!options.types || options.types.includes(type));
  });
}

function collectionTitleField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  return collectionFirstField(spec, { ids: /title|name|subject|label|作品|映画|本|名前|タイトル/, types: ["string", "text"] })
    ?? collectionFirstField(spec, { types: ["string", "text"] });
}

function collectionSummaryField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  return collectionFirstField(spec, { ids: /note|memo|summary|description|comment|感想|メモ|説明/, types: ["string", "text"] });
}

function collectionDateField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  return collectionFirstField(spec, { types: ["date", "datetime"] })
    ?? collectionFirstField(spec, { ids: /date|day|due|deadline|watched_at|created_at|updated_at|期限|日付/ });
}

function collectionCalendarFieldLabel(spec: SurfaceRenderSpec): string {
  const field = collectionDateField(spec);
  return field ? collectionFieldLabel(field) : "";
}

function collectionEnumField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  return collectionFirstField(spec, { ids: /status|state|stage|phase|状態|進捗/, types: ["enum"] })
    ?? collectionFirstField(spec, { types: ["enum"] });
}

function collectionRecordTitle(spec: SurfaceRenderSpec, record: Record<string, unknown>): string {
  const field = collectionTitleField(spec);
  return field ? collectionRecordText(record, collectionFieldId(field)) || String(record.id ?? "") : String(record.id ?? "");
}

function collectionRecordSummary(spec: SurfaceRenderSpec, record: Record<string, unknown>): string {
  const field = collectionSummaryField(spec);
  return field ? collectionRecordText(record, collectionFieldId(field)) : "";
}

function collectionDateKey(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function collectionDateKeyFromDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function collectionCalendarMonthDate(spec: SurfaceRenderSpec): Date {
  const selected = typeof collectionViewState(spec).selected_date === "string" ? String(collectionViewState(spec).selected_date) : "";
  const selectedDate = selected ? new Date(`${selected}T00:00:00`) : undefined;
  if (selectedDate && Number.isFinite(selectedDate.getTime())) {
    return selectedDate;
  }
  const field = collectionDateField(spec);
  const fieldId = field ? collectionFieldId(field) : "";
  const firstRecordDate = fieldId ? collectionVisibleRecords(spec).map((record) => collectionDateKey(record[fieldId])).find(Boolean) : "";
  const firstDate = firstRecordDate ? new Date(`${firstRecordDate}T00:00:00`) : undefined;
  return firstDate && Number.isFinite(firstDate.getTime()) ? firstDate : new Date();
}

function collectionCalendarMonthLabel(spec: SurfaceRenderSpec): string {
  const date = collectionCalendarMonthDate(spec);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function collectionCalendarMonthOffsetDate(spec: SurfaceRenderSpec, offset: number): string {
  const base = collectionCalendarMonthDate(spec);
  const target = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(base.getDate(), lastDay));
  return collectionDateKeyFromDate(target);
}

async function shiftCollectionCalendarMonth(spec: SurfaceRenderSpec, offset: number) {
  await updateActiveCollectionViewState({ selected_date: collectionCalendarMonthOffsetDate(spec, offset) });
}

function collectionSelectedDateKey(spec: SurfaceRenderSpec): string {
  const selected = typeof collectionViewState(spec).selected_date === "string" ? String(collectionViewState(spec).selected_date) : "";
  return selected || collectionDateKeyFromDate(collectionCalendarMonthDate(spec));
}

function collectionCalendarDays(spec: SurfaceRenderSpec): Array<{ key: string; date: string; day: number; inMonth: boolean; records: Array<Record<string, unknown>>; selected: boolean; today: boolean }> {
  const field = collectionDateField(spec);
  const fieldId = field ? collectionFieldId(field) : "";
  const monthDate = collectionCalendarMonthDate(spec);
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  const selected = collectionSelectedDateKey(spec);
  const today = collectionDateKeyFromDate(new Date());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const dateKey = collectionDateKeyFromDate(date);
    const records = fieldId ? collectionVisibleRecords(spec).filter((record) => collectionDateKey(record[fieldId]) === dateKey) : [];
    return {
      key: dateKey,
      date: dateKey,
      day: date.getDate(),
      inMonth: date.getMonth() === monthDate.getMonth(),
      records,
      selected: dateKey === selected,
      today: dateKey === today
    };
  });
}

function collectionSelectedDateRecords(spec: SurfaceRenderSpec): Array<Record<string, unknown>> {
  const selected = collectionSelectedDateKey(spec);
  const field = collectionDateField(spec);
  const fieldId = field ? collectionFieldId(field) : "";
  return selected && fieldId ? collectionVisibleRecords(spec).filter((record) => collectionDateKey(record[fieldId]) === selected) : [];
}

async function selectCollectionCalendarDate(spec: SurfaceRenderSpec, date: string) {
  const selection = collectionCalendarDateSelection(collectionDateField(spec), date);
  if (selection.draft) {
    setCollectionNewDraftValue(selection.draft.field_id, selection.draft.value);
  }
  await updateActiveCollectionViewState(selection.view_state);
}

function collectionKanbanColumns(spec: SurfaceRenderSpec): Array<{ value: string; records: Array<Record<string, unknown>> }> {
  return collectionKanbanColumnsForRecords(spec, collectionVisibleRecords(spec));
}

function beginCollectionKanbanDrag(record: Record<string, unknown>, event?: DragEvent) {
  const payload = collectionKanbanDragPayload(record);
  collectionDraggedRecordId.value = payload?.record_id ?? "";
  if (!payload || !event?.dataTransfer) {
    return;
  }
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-samurai-collection-record", JSON.stringify(payload));
  event.dataTransfer.setData("text/plain", payload.record_id);
}

function collectionKanbanDroppedRecordId(event?: DragEvent): string | null {
  if (collectionDraggedRecordId.value) {
    return collectionDraggedRecordId.value;
  }
  const transfer = event?.dataTransfer;
  if (!transfer) {
    return null;
  }
  const payload = transfer.getData("application/x-samurai-collection-record");
  if (payload) {
    try {
      const parsed = JSON.parse(payload);
      if (isRecord(parsed) && typeof parsed.record_id === "string" && parsed.record_id.trim()) {
        return parsed.record_id.trim();
      }
    } catch {
      // Ignore malformed drag payloads and fall back to plain text.
    }
  }
  const plain = transfer.getData("text/plain").trim();
  return plain || null;
}

async function dropCollectionKanbanRecord(spec: SurfaceRenderSpec, value: string, event?: DragEvent) {
  const recordId = collectionKanbanDroppedRecordId(event);
  collectionDraggedRecordId.value = null;
  const patch = collectionKanbanDropPatch(spec, recordId, value);
  if (!patch) return;
  await patchCollectionRecordFields(spec, patch.record_id, patch.changes);
  await updateActiveCollectionViewState(patch.view_state);
}

function taskListData(spec: SurfaceRenderSpec): Record<string, unknown> {
  return spec.props.data && typeof spec.props.data === "object" && !Array.isArray(spec.props.data)
    ? spec.props.data as Record<string, unknown>
    : {};
}

function taskListRecords(spec: SurfaceRenderSpec): Array<Record<string, unknown>> {
  const records = taskListData(spec).records;
  return Array.isArray(records) ? records.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function taskListCounts(spec: SurfaceRenderSpec): { active: number; completed: number; total: number } {
  const records = taskListRecords(spec);
  return {
    total: records.length,
    active: records.filter((record) => record.completed !== true).length,
    completed: records.filter((record) => record.completed === true).length
  };
}

function collectionSchemaTitle(schema: CollectionSchema): string {
  return schema.labels?.ja ?? schema.labels?.en ?? schema.id;
}

function collectionSchemaRenderer(schema: CollectionSchema): string {
  return String((schema.views ?? []).find((view) => typeof view.renderer === "string")?.renderer ?? "collection_table");
}

function collectionDefaultViewId(schema: CollectionSchema): string {
  const firstView = (schema.views ?? [])[0];
  return typeof firstView?.id === "string" && firstView.id ? firstView.id : `${schema.id}_table`;
}

function collectionListErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `Collection一覧を読み込めませんでした。APIエラー ${error.status}`;
  }
  return "Collection一覧を読み込めませんでした。API接続を確認してください。";
}

function taskDraft(record: Record<string, unknown>) {
  const id = String(record.id ?? "");
  const draft = taskDrafts.value[id] ?? {};
  for (const field of taskEditableFields(activeSurfaceSpec.value)) {
    const fieldId = String(field.id ?? "");
    if (fieldId && !(fieldId in draft)) {
      draft[fieldId] = String(record[fieldId] ?? "");
    }
  }
  return draft;
}

function syncTaskDrafts(spec: SurfaceRenderSpec) {
  taskDrafts.value = Object.fromEntries(taskListRecords(spec).map((record) => [
    String(record.id ?? ""),
    Object.fromEntries(taskEditableFields(spec).map((field) => [
      String(field.id ?? ""),
      String(record[String(field.id ?? "")] ?? "")
    ]))
  ]));
}

function taskSchemaFields(spec: SurfaceRenderSpec | null): Array<Record<string, JsonValue>> {
  if (!spec || !isTaskListSurfaceSpec(spec)) {
    return [];
  }
  const fields = taskListData(spec).schema_fields;
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.filter(isRecord) as Array<Record<string, JsonValue>>;
}

function taskEditableFields(spec: SurfaceRenderSpec | null): Array<Record<string, JsonValue>> {
  const config = spec && isTaskListSurfaceSpec(spec) ? taskViewConfig(spec) : {};
  const editable = Array.isArray(config.editable_fields) ? new Set(config.editable_fields.filter((item): item is string => typeof item === "string")) : undefined;
  return taskSchemaFields(spec).filter((field) => {
    const id = String(field.id ?? "");
    return id && id !== "completed" && (!editable || editable.has(id));
  });
}

function taskDisplayFields(spec: SurfaceRenderSpec | null): Array<Record<string, JsonValue>> {
  const config = spec && isTaskListSurfaceSpec(spec) ? taskViewConfig(spec) : {};
  const hidden = new Set((Array.isArray(config.hidden_fields) ? config.hidden_fields : []).filter((item): item is string => typeof item === "string"));
  return taskSchemaFields(spec).filter((field) => {
    const id = String(field.id ?? "");
    return id && id !== "completed" && !hidden.has(id);
  });
}

function taskViewConfig(spec: SurfaceRenderSpec): Record<string, unknown> {
  const value = taskListData(spec).view_config;
  return isRecord(value) ? value : {};
}

function taskAllowsDelete(spec: SurfaceRenderSpec): boolean {
  const actions = Array.isArray(spec.props.actions) ? spec.props.actions : [];
  const hasDeleteAction = actions.some((action) =>
    isRecord(action) && action.operation_kind === "collection.record.delete"
  );
  return hasDeleteAction && taskViewConfig(spec).allow_delete !== false;
}

function taskIsCompact(spec: SurfaceRenderSpec): boolean {
  return taskViewConfig(spec).density === "compact";
}

function taskRecordGroups(spec: SurfaceRenderSpec): Array<{ key: string; title: string; records: Array<Record<string, unknown>> }> {
  const groupBy = taskViewConfig(spec).group_by;
  const records = taskListRecords(spec);
  if (typeof groupBy === "string" && groupBy) {
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const record of records) {
      const key = String(record[groupBy] ?? "未設定") || "未設定";
      grouped.set(key, [...(grouped.get(key) ?? []), record]);
    }
    return Array.from(grouped.entries()).map(([key, groupedRecords]) => ({ key, title: key, records: groupedRecords }));
  }
  return [
    { key: "active", title: "未完了", records: records.filter((item) => item.completed !== true) },
    { key: "completed", title: "完了", records: records.filter((item) => item.completed === true) }
  ];
}

function taskFieldLabel(field: Record<string, unknown>): string {
  return typeof field.label === "string" ? field.label : String(field.id ?? "");
}

function taskFieldType(field: Record<string, unknown>): string {
  return typeof field.type === "string" ? field.type : "string";
}

function taskEnumValues(field: Record<string, unknown>): string[] {
  const values = field.enum_values;
  return Array.isArray(values) ? values.filter((item): item is string => typeof item === "string") : [];
}

function taskFieldId(field: Record<string, unknown>): string {
  return String(field.id ?? "");
}

function taskPatchFromDraft(record: Record<string, unknown>): Record<string, JsonValue> {
  const draft = taskDraft(record);
  return Object.fromEntries(taskEditableFields(activeSurfaceSpec.value).map((field) => {
    const id = String(field.id ?? "");
    const type = taskFieldType(field);
    const raw = draft[id] ?? "";
    const value: JsonValue = type === "boolean" ? raw === "true" : type === "number" ? Number(raw) || 0 : raw;
    return [id, value];
  }));
}

function setTaskDraftValue(record: Record<string, unknown>, field: string, value: string) {
  const id = String(record.id ?? "");
  taskDrafts.value = {
    ...taskDrafts.value,
    [id]: {
      ...taskDraft(record),
      [field]: value
    }
  };
}

async function refreshTaskListSurface(spec: SurfaceRenderSpec) {
  try {
    await ensureTaskSurfaceContract();
    const envelope = await api.runSurfaceOperation<{ collection_id: string; view_id: string }>({
      id: `surface_tasks_present_${Date.now()}`,
      kind: "collection.view.present",
      collection_id: "tasks",
      view_id: "task_list",
      renderer_capabilities: frontendRendererCapabilities.value
    });
    const nextSpec = envelope.render_spec;
    if (!isTaskListSurfaceSpec(nextSpec)) {
      throw new Error("task_list_render_spec_required");
    }
    taskAppError.value = null;
    activeSurfaceSpec.value = nextSpec;
    lastSurfaceRenderSpec.value = nextSpec;
    lastSurfaceRenderSpecs.value = [nextSpec, ...lastSurfaceRenderSpecs.value.filter((item) => !isTaskListSurfaceSpec(item))];
    syncTaskDrafts(nextSpec);
  } catch (error) {
    taskAppError.value = taskSurfaceErrorMessage(error);
    if (!activeSurfaceSpec.value && isTaskListSurfaceSpec(spec)) {
      activeSurfaceSpec.value = spec;
    }
    throw error;
  }
}

async function addTask(spec: SurfaceRenderSpec) {
  const title = taskDraftTitle.value.trim();
  if (!title || taskSaving.value) {
    return;
  }
  taskSaving.value = true;
  try {
    await ensureTaskSurfaceContract();
    const envelope = await api.runSurfaceOperation({
      id: `surface_task_create_${Date.now()}`,
      kind: "collection.record.create",
      collection_id: "tasks",
      record_id: `task_${Date.now()}`,
      renderer_capabilities: frontendRendererCapabilities.value,
      data: {
        title,
        completed: false,
        notes: "",
        due_date: "",
        order: taskListRecords(spec).length,
        source_session_id: activeSession.value?.id ?? "",
        source_message_id: ""
      }
    });
    taskDraftTitle.value = "";
    await refreshTaskListSurface(envelope.render_spec ?? spec);
    taskAppError.value = null;
  } catch (error) {
    taskAppError.value = taskSurfaceErrorMessage(error);
  } finally {
    taskSaving.value = false;
  }
}

async function patchTask(spec: SurfaceRenderSpec, record: Record<string, unknown>, changes: Record<string, JsonValue>) {
  const id = String(record.id ?? "");
  if (!id || taskSaving.value) {
    return;
  }
  taskSaving.value = true;
  try {
    await ensureTaskSurfaceContract();
    const envelope = await api.runSurfaceOperation({
      id: `surface_task_patch_${Date.now()}`,
      kind: "collection.record.patch",
      collection_id: "tasks",
      record_id: id,
      patch_id: `task_patch_${Date.now()}`,
      changes,
      renderer_capabilities: frontendRendererCapabilities.value
    });
    await refreshTaskListSurface(envelope.render_spec ?? spec);
    taskAppError.value = null;
  } catch (error) {
    taskAppError.value = taskSurfaceErrorMessage(error);
  } finally {
    taskSaving.value = false;
  }
}

async function saveTaskDraft(spec: SurfaceRenderSpec, record: Record<string, unknown>) {
  await patchTask(spec, record, taskPatchFromDraft(record));
}

async function deleteTask(spec: SurfaceRenderSpec, record: Record<string, unknown>) {
  const id = String(record.id ?? "");
  if (!id || taskSaving.value || !taskAllowsDelete(spec)) {
    return;
  }
  taskSaving.value = true;
  try {
    await ensureTaskSurfaceContract();
    const envelope = await api.runSurfaceOperation({
      id: `surface_task_delete_${Date.now()}`,
      kind: "collection.record.delete",
      collection_id: "tasks",
      record_id: id,
      view_id: "task_list",
      renderer_capabilities: frontendRendererCapabilities.value
    });
    const nextSpec = envelope.render_spec;
    if (isTaskListSurfaceSpec(nextSpec)) {
      activeSurfaceSpec.value = nextSpec;
      lastSurfaceRenderSpec.value = nextSpec;
      lastSurfaceRenderSpecs.value = [nextSpec, ...lastSurfaceRenderSpecs.value.filter((item) => !isTaskListSurfaceSpec(item))];
      syncTaskDrafts(nextSpec);
    } else {
      await refreshTaskListSurface(spec);
    }
    taskAppError.value = null;
  } catch (error) {
    taskAppError.value = taskSurfaceErrorMessage(error);
  } finally {
    taskSaving.value = false;
  }
}

function collectionTableFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  const hidden = new Set((Array.isArray(appCollectionViewConfig(spec).hidden_fields) ? appCollectionViewConfig(spec).hidden_fields : []).filter((item): item is string => typeof item === "string"));
  return appCollectionSchemaFields(spec).filter((field) => {
    const id = String(field.id ?? "");
    return id && !hidden.has(id);
  });
}

function collectionTableEditableFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  const editable = Array.isArray(appCollectionViewConfig(spec).editable_fields)
    ? new Set(appCollectionViewConfig(spec).editable_fields.filter((item): item is string => typeof item === "string"))
    : undefined;
  return collectionTableFields(spec).filter((field) => {
    const id = String(field.id ?? "");
    return !collectionFieldReadOnly(field) && (!editable || editable.has(id));
  });
}

function collectionFieldLabel(field: Record<string, unknown>): string {
  return typeof field.label === "string" ? field.label : String(field.id ?? "");
}

function collectionFieldType(field: Record<string, unknown>): string {
  return typeof field.type === "string" ? field.type : "string";
}

function collectionFieldInputType(field: Record<string, unknown>): "date" | "datetime-local" | "number" | "text" {
  const type = collectionFieldType(field);
  if (type === "date") return "date";
  if (type === "datetime") return "datetime-local";
  if (type === "number") return "number";
  return "text";
}

function collectionFieldInputValue(field: Record<string, unknown>, value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  const type = collectionFieldType(field);
  if (type === "date") {
    return collectionDateKey(text) || text;
  }
  if (type === "datetime") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return `${text}T00:00`;
    }
    return text.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)?.[0] ?? text;
  }
  return text;
}

function collectionFieldReadOnly(field: Record<string, unknown>): boolean {
  return field.read_only === true || field.derived === true || field.source === "derived_field" || field.source === "collection_embed";
}

function collectionFieldRequired(field: Record<string, unknown>): boolean {
  return field.required === true;
}

function collectionRecordFieldDisplay(record: Record<string, unknown>, field: Record<string, unknown>): string {
  const value = record[collectionFieldId(field)];
  if (field.source === "collection_ref") {
    return collectionRefLabel(field, value);
  }
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  if (typeof value === "boolean") return value ? "true" : "false";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function collectionFieldOptions(field: Record<string, unknown>): Array<{ value: string; label: string }> {
  const options = Array.isArray(field.options) ? field.options : [];
  return options.filter(isRecord).flatMap((option) => {
    const value = option.value ?? option.record_id;
    const label = option.label ?? value;
    if (typeof value !== "string" || typeof label !== "string") {
      return [];
    }
    return [{ value, label }];
  });
}

function collectionRefLabel(field: Record<string, unknown>, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "-";
  return collectionFieldOptions(field).find((option) => option.value === value)?.label ?? value;
}

function collectionRefMissing(record: Record<string, unknown>, field: Record<string, unknown>): boolean {
  if (field.source !== "collection_ref") return false;
  const value = record[collectionFieldId(field)];
  if (typeof value !== "string" || !value.trim()) return false;
  return !collectionFieldOptions(field).some((option) => option.value === value);
}

type CollectionUiAction = {
  id: string;
  label: string;
  operationKind: string;
  actionKind?: string;
  description?: string;
  scope: "collection" | "record";
};

function collectionSchemaActions(spec: SurfaceRenderSpec): CollectionUiAction[] {
  const actions = Array.isArray(spec.props.actions) ? spec.props.actions : [];
  return actions.filter(isRecord).flatMap((action) => {
    if (typeof action.id !== "string" || typeof action.label !== "string" || action.operation_kind !== "collection.action.run") {
      return [];
    }
    const scope = action.scope === "record" ? "record" : "collection";
    return [{
      id: action.id,
      label: action.label,
      operationKind: String(action.operation_kind),
      actionKind: typeof action.action_kind === "string" ? action.action_kind : undefined,
      description: typeof action.description === "string" ? action.description : undefined,
      scope
    }];
  });
}

function collectionLevelActions(spec: SurfaceRenderSpec): CollectionUiAction[] {
  return collectionSchemaActions(spec).filter((action) => action.scope === "collection");
}

function collectionRecordActions(spec: SurfaceRenderSpec): CollectionUiAction[] {
  return collectionSchemaActions(spec).filter((action) => action.scope === "record");
}

function collectionEnumValues(field: Record<string, unknown>): string[] {
  const values = field.enum_values;
  return Array.isArray(values) ? values.filter((item): item is string => typeof item === "string") : [];
}

function collectionDraft(record: Record<string, unknown>) {
  const id = String(record.id ?? "");
  const draft = collectionDrafts.value[id] ?? {};
  for (const field of collectionTableEditableFields(activeSurfaceSpec.value as SurfaceRenderSpec)) {
    const fieldId = String(field.id ?? "");
    if (fieldId && !(fieldId in draft)) {
      draft[fieldId] = String(record[fieldId] ?? "");
    }
  }
  return draft;
}

function setCollectionDraftValue(record: Record<string, unknown>, field: string, value: string) {
  const id = String(record.id ?? "");
  collectionDrafts.value = {
    ...collectionDrafts.value,
    [id]: {
      ...collectionDraft(record),
      [field]: value
    }
  };
}

function setCollectionNewDraftValue(field: string, value: string) {
  collectionNewDraft.value = {
    ...collectionNewDraft.value,
    [field]: value
  };
}

function collectionValueFromRaw(field: Record<string, unknown>, raw: string): JsonValue {
  return collectionDraftValueFromRaw(field, raw);
}

function collectionPatchFromDraft(spec: SurfaceRenderSpec, record: Record<string, unknown>): Record<string, JsonValue> {
  const draft = collectionDraft(record);
  return Object.fromEntries(collectionTableEditableFields(spec).map((field) => {
    const id = String(field.id ?? "");
    return [id, collectionValueFromRaw(field, draft[id] ?? "")];
  }));
}

function collectionCreateData(spec: SurfaceRenderSpec): Record<string, JsonValue> {
  return collectionCreateDataForView(spec, collectionNewDraft.value, { selectedDate: collectionSelectedDateKey(spec) });
}

function collectionCreateDraft(spec: SurfaceRenderSpec): Record<string, string> {
  return collectionCreateDraftForView(spec, collectionNewDraft.value, { selectedDate: collectionSelectedDateKey(spec) });
}

function collectionCreateDraftValue(spec: SurfaceRenderSpec, field: Record<string, unknown>): string {
  return collectionCreateDraft(spec)[collectionFieldId(field)] ?? "";
}

function collectionCreateReady(spec: SurfaceRenderSpec): boolean {
  return collectionRequiredReady(spec, collectionCreateDraft(spec));
}

function collectionRequiredReady(spec: SurfaceRenderSpec, draft: Record<string, string>): boolean {
  return collectionMissingRequiredFields(spec, draft).length === 0;
}

function collectionMissingRequiredFields(spec: SurfaceRenderSpec, draft: Record<string, string>): string[] {
  return collectionTableEditableFields(spec).filter((field) => {
    if (!collectionFieldRequired(field)) return false;
    return collectionRequiredValueMissing(field, draft[String(field.id ?? "")]);
  }).map(collectionFieldLabel);
}

function collectionRequiredValueMissing(field: Record<string, unknown>, value: string | undefined): boolean {
  if (collectionFieldType(field) === "boolean") return false;
  return typeof value !== "string" || value.trim().length === 0;
}

function collectionValidationMessage(spec: SurfaceRenderSpec, draft: Record<string, string>): string {
  const missing = collectionMissingRequiredFields(spec, draft);
  return missing.length > 0 ? `必須: ${missing.join(" / ")}` : "";
}

function collectionCreateValidationMessage(spec: SurfaceRenderSpec): string {
  return collectionValidationMessage(spec, collectionCreateDraft(spec));
}

function collectionVisibleEmptyMessage(spec: SurfaceRenderSpec): string {
  return appCollectionRecords(spec).length === 0 ? "まだレコードがありません" : "条件に合うレコードがありません";
}

function syncCollectionDrafts(spec: SurfaceRenderSpec) {
  collectionDrafts.value = Object.fromEntries(appCollectionRecords(spec).map((record) => [
    String(record.id ?? ""),
    Object.fromEntries(collectionTableEditableFields(spec).map((field) => [
      String(field.id ?? ""),
      String(record[String(field.id ?? "")] ?? "")
    ]))
  ]));
  collectionNewDraft.value = Object.fromEntries(collectionTableEditableFields(spec).map((field) => [String(field.id ?? ""), ""]));
}

async function refreshCollectionTableSurface(spec: SurfaceRenderSpec) {
  try {
    await ensureTaskSurfaceContract();
    const previousState = collectionUserViewState(collectionStateSourceSpec(spec));
    const envelope = await api.runSurfaceOperation({
      id: `surface_collection_present_${Date.now()}`,
      kind: "collection.view.present",
      collection_id: collectionTableId(spec),
      view_id: collectionTableViewId(spec),
      renderer_capabilities: frontendRendererCapabilities.value
    });
    const nextSpec = envelope.render_spec;
    if (!isCollectionTableSurfaceSpec(nextSpec)) {
      throw new Error("collection_table_render_spec_required");
    }
    const nextSpecWithState = withCollectionViewState(nextSpec, previousState);
    collectionAppError.value = null;
    activeSurfaceSpec.value = nextSpecWithState;
    lastSurfaceRenderSpec.value = nextSpecWithState;
    lastSurfaceRenderSpecs.value = [nextSpecWithState, ...lastSurfaceRenderSpecs.value.filter((item) => !(isCollectionTableSurfaceSpec(item) && collectionTableId(item) === collectionTableId(nextSpecWithState)))];
    syncCollectionDrafts(nextSpecWithState);
    await persistActiveCollectionPresentationState(nextSpecWithState);
  } catch (error) {
    collectionAppError.value = collectionSurfaceErrorMessage(error);
    if (!activeSurfaceSpec.value && isCollectionTableSurfaceSpec(spec)) {
      activeSurfaceSpec.value = spec;
    }
    throw error;
  }
}

async function addCollectionRecord(spec: SurfaceRenderSpec) {
  if (collectionSaving.value) return;
  const draft = collectionCreateDraft(spec);
  const data = collectionCreateData(spec);
  if (!collectionRequiredReady(spec, draft)) {
    collectionAppError.value = collectionValidationMessage(spec, draft);
    return;
  }
  collectionSaving.value = true;
  try {
    await ensureTaskSurfaceContract();
    const recordId = `record_${Date.now()}`;
    const envelope = await api.runSurfaceOperation({
      id: `surface_collection_create_${Date.now()}`,
      kind: "collection.record.create",
      collection_id: collectionTableId(spec),
      record_id: recordId,
      renderer_capabilities: frontendRendererCapabilities.value,
      data
    });
    void envelope;
    await refreshCollectionTableSurface(spec);
    await updateActiveCollectionViewState({ selected_record_id: recordId });
  } catch (error) {
    collectionAppError.value = collectionSurfaceErrorMessage(error);
  } finally {
    collectionSaving.value = false;
  }
}

async function saveCollectionRecord(spec: SurfaceRenderSpec, record: Record<string, unknown>) {
  const id = String(record.id ?? "");
  if (!id || collectionSaving.value) return;
  const changes = collectionPatchFromDraft(spec, record);
  const draft = collectionDraft(record);
  if (!collectionRequiredReady(spec, draft)) {
    collectionAppError.value = collectionValidationMessage(spec, draft);
    return;
  }
  await selectCollectionRecord(spec, record);
  await patchCollectionRecordFields(spec, id, changes);
}

async function patchCollectionRecordFields(spec: SurfaceRenderSpec, recordId: string, changes: Record<string, JsonValue>) {
  if (!recordId || collectionSaving.value) return;
  collectionSaving.value = true;
  try {
    await ensureTaskSurfaceContract();
    const envelope = await api.runSurfaceOperation({
      id: `surface_collection_patch_${Date.now()}`,
      kind: "collection.record.patch",
      collection_id: collectionTableId(spec),
      record_id: recordId,
      patch_id: `collection_patch_${Date.now()}`,
      changes,
      renderer_capabilities: frontendRendererCapabilities.value
    });
    void envelope;
    await refreshCollectionTableSurface(spec);
    await updateActiveCollectionViewState({ selected_record_id: recordId });
  } catch (error) {
    collectionAppError.value = collectionSurfaceErrorMessage(error);
  } finally {
    collectionSaving.value = false;
  }
}

async function deleteCollectionRecordFromTable(spec: SurfaceRenderSpec, record: Record<string, unknown>) {
  const id = String(record.id ?? "");
  if (!id || collectionSaving.value) return;
  const previousState = collectionUserViewState(collectionStateSourceSpec(spec));
  const nextState = { ...previousState, selected_record_id: null };
  collectionSaving.value = true;
  try {
    await ensureTaskSurfaceContract();
    const envelope = await api.runSurfaceOperation({
      id: `surface_collection_delete_${Date.now()}`,
      kind: "collection.record.delete",
      collection_id: collectionTableId(spec),
      record_id: id,
      view_id: collectionTableViewId(spec),
      renderer_capabilities: frontendRendererCapabilities.value
    });
    const nextSpec = envelope.render_spec;
    if (isCollectionTableSurfaceSpec(nextSpec)) {
      const nextSpecWithState = withCollectionViewState(nextSpec, nextState);
      activeSurfaceSpec.value = nextSpecWithState;
      lastSurfaceRenderSpec.value = nextSpecWithState;
      syncCollectionDrafts(nextSpecWithState);
    } else {
      await refreshCollectionTableSurface(spec);
    }
    await updateActiveCollectionViewState({ selected_record_id: null });
  } catch (error) {
    collectionAppError.value = collectionSurfaceErrorMessage(error);
  } finally {
    collectionSaving.value = false;
  }
}

async function runCollectionSchemaAction(spec: SurfaceRenderSpec, action: CollectionUiAction, record?: Record<string, unknown>) {
  const recordId = record ? String(record.id ?? "") : "";
  if (collectionSaving.value || (record && !recordId)) return;
  collectionSaving.value = true;
  try {
    await ensureTaskSurfaceContract(["collection.action.run"]);
    const previousState = {
      ...collectionUserViewState(collectionStateSourceSpec(spec)),
      ...(recordId ? { selected_record_id: recordId } : {})
    };
    const envelope = await api.runSurfaceOperation({
      id: `surface_collection_action_${Date.now()}`,
      kind: "collection.action.run",
      session_id: activeSession.value?.id,
      collection_id: collectionTableId(spec),
      action_id: action.id,
      backend_id: selectedBackendId.value,
      record_id: recordId || undefined,
      view_id: collectionTableViewId(spec),
      payload: collectionActionRunPayload(collectionStateSourceSpec(spec), {
        action_id: action.id,
        action_label: action.label,
        action_kind: action.actionKind,
        scope: action.scope,
        ...(record ? { record } : {})
      }),
      renderer_capabilities: frontendRendererCapabilities.value
    });
    const renderSpecs = envelopeRenderSpecs(envelope);
    const generatedCustomView = renderSpecs.find((item) =>
      item.kind === "custom_view"
      && !isCollectionTableSurfaceSpec(item)
      && !isTaskListSurfaceSpec(item)
    );
    const nextSpec = envelope.render_spec;
    if (generatedCustomView) {
      activeSurfaceSpec.value = generatedCustomView;
      activeArtifact.value = null;
      activeMemory.value = null;
      activeMessagePresentationId.value = null;
      setCanvasMode(defaultCanvasMode(generatedCustomView));
      lastSurfaceRenderSpec.value = generatedCustomView;
      lastSurfaceRenderSpecs.value = renderSpecs;
    } else if (isCollectionTableSurfaceSpec(nextSpec)) {
      const nextSpecWithState = withCollectionViewState(nextSpec, previousState);
      activeSurfaceSpec.value = nextSpecWithState;
      lastSurfaceRenderSpec.value = nextSpecWithState;
      lastSurfaceRenderSpecs.value = [nextSpecWithState, ...lastSurfaceRenderSpecs.value.filter((item) => !(isCollectionTableSurfaceSpec(item) && collectionTableId(item) === collectionTableId(nextSpecWithState)))];
      syncCollectionDrafts(nextSpecWithState);
      await persistActiveCollectionPresentationState(nextSpecWithState);
    } else {
      await refreshCollectionTableSurface(spec);
    }
    if (recordId) {
      await updateActiveCollectionViewState({ selected_record_id: recordId });
    }
    if (activeSession.value) {
      await reloadActiveSession();
    }
    collectionAppError.value = null;
  } catch (error) {
    collectionAppError.value = collectionSurfaceErrorMessage(error);
  } finally {
    collectionSaving.value = false;
  }
}

const collectionWorkspaceController = {
  switchCollectionView,
  refreshCollectionTableSurface,
  runCollectionSchemaAction,
  setCollectionSearchQuery,
  setCollectionSortField,
  toggleCollectionSortDirection,
  setCollectionFilterValue,
  setCollectionGroupField,
  setCollectionNewDraftValue,
  addCollectionRecord,
  selectCollectionRecord,
  collectionDraft,
  setCollectionDraftValue,
  saveCollectionRecord,
  deleteCollectionRecordFromTable,
  shiftCollectionCalendarMonth,
  selectCollectionCalendarDate,
  beginCollectionKanbanDrag,
  dropCollectionKanbanRecord
};

function taskSurfaceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("task_surface_contract_missing:")) {
    return "Tasksを表示できません。古いAPIサーバーにつながっている可能性があります。APIとWebを同じ dev 起動で開き直してください。";
  }
  if (error instanceof ApiError && isRecord(error.body) && error.body.error === "invalid_surface_operation") {
    return "Tasksを表示できません。APIサーバーが古い可能性があります。APIを再起動してください。";
  }
  if (error instanceof ApiError) {
    return `Tasksを更新できませんでした。APIエラー ${error.status}`;
  }
  return "Tasksを更新できませんでした。API接続を確認してください。";
}

function collectionSurfaceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("task_surface_contract_missing:")) {
    return "Collectionを表示できません。古いAPIサーバーにつながっている可能性があります。APIとWebを同じ dev 起動で開き直してください。";
  }
  if (error instanceof ApiError && isRecord(error.body) && error.body.error === "invalid_surface_operation") {
    return "Collectionを表示できません。APIサーバーが古い可能性があります。APIを再起動してください。";
  }
  if (error instanceof ApiError) {
    return `Collectionを更新できませんでした。APIエラー ${error.status}`;
  }
  return "Collectionを更新できませんでした。API接続を確認してください。";
}

function surfaceValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function defaultCanvasMode(spec: SurfaceRenderSpec): CanvasMode {
  if (spec.kind === "form" || spec.kind === "table" || spec.kind === "collection_record") {
    return "edit";
  }
  if (spec.kind === "chart" || spec.kind === "custom_view") {
    return "app";
  }
  return "preview";
}

function setCanvasMode(mode: CanvasMode) {
  canvasMode.value = mode;
  persistCanvasMode(mode);
}

function isArtifactPreviewable(artifact: ArtifactRecord): boolean {
  return ["markdown", "document", "note", "generated_report", "pdf", "image"].includes(artifact.kind);
}

function artifactContentUrl(artifact: ArtifactRecord): string {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/content`;
}

function artifactContentType(artifact: ArtifactRecord): string {
  const contentType = artifact.metadata.content_type;
  if (typeof contentType === "string") {
    return contentType;
  }
  if (artifact.kind === "pdf") {
    return "application/pdf";
  }
  if (artifact.kind === "image") {
    return "image/*";
  }
  return "text/markdown";
}

function isPdfArtifact(artifact: ArtifactRecord): boolean {
  return artifact.kind === "pdf" || artifactContentType(artifact) === "application/pdf";
}

function isImageArtifact(artifact: ArtifactRecord): boolean {
  return artifact.kind === "image" || artifactContentType(artifact).startsWith("image/");
}

function markdownPreviewHtml(content: string): string {
  return content
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) {
        return "";
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
      if (heading) {
        const level = heading[1]?.length ?? 2;
        return `<h${level}>${inlineMarkdown(heading[2] ?? "")}</h${level}>`;
      }
      if (/^[-*]\s+/m.test(trimmed)) {
        const items = trimmed
          .split("\n")
          .filter((line) => /^[-*]\s+/.test(line))
          .map((line) => `<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }
      return `<p>${inlineMarkdown(trimmed).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formDraftValue(spec: SurfaceRenderSpec, field: { name: string; value: unknown }): string {
  return surfaceValue(surfaceFormDraft.value[spec.id]?.[field.name] ?? field.value);
}

function setFormDraftValue(spec: SurfaceRenderSpec, fieldName: string, value: string | boolean) {
  surfaceFormDraft.value = {
    ...surfaceFormDraft.value,
    [spec.id]: {
      ...(surfaceFormDraft.value[spec.id] ?? {}),
      [fieldName]: toJsonValue(value)
    }
  };
}

function surfaceRowKey(row: Record<string, unknown>, rowIndex: number): string {
  return typeof row.id === "string" ? row.id : `row_${rowIndex}`;
}

function tableDraftValue(spec: SurfaceRenderSpec, row: Record<string, unknown>, rowIndex: number, columnKey: string): string {
  const rowKey = surfaceRowKey(row, rowIndex);
  return surfaceValue(surfaceTableDraft.value[spec.id]?.[rowKey]?.[columnKey] ?? row[columnKey]);
}

function setTableDraftValue(spec: SurfaceRenderSpec, row: Record<string, unknown>, rowIndex: number, columnKey: string, value: string) {
  const rowKey = surfaceRowKey(row, rowIndex);
  surfaceTableDraft.value = {
    ...surfaceTableDraft.value,
    [spec.id]: {
      ...(surfaceTableDraft.value[spec.id] ?? {}),
      [rowKey]: {
        ...(surfaceTableDraft.value[spec.id]?.[rowKey] ?? objectToJsonRecord(row)),
        [columnKey]: toJsonValue(value)
      }
    }
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (isRecord(value)) {
    return objectToJsonRecord(value);
  }
  return String(value ?? "");
}

function objectToJsonRecord(record: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, toJsonValue(value)]));
}

function changeResourceLabel(change: WorkspaceChangeRecord): string {
  return resourceDisplayName(change.resource_ref);
}

function resourceKindLabel(ref: ResourceRef): string {
  const normalizedKind = ref.kind === "collection_record" ? "collection" : ref.kind;
  const key = `resource.kind.${normalizedKind}` as LocaleKey;
  return label(key);
}

function resourceDisplayName(ref: ResourceRef): string {
  const value = ref.label || ref.uri || ref.id;
  const normalized = value.replace(/^file:\/\//, "");
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

function resourceLineLabel(ref: ResourceRef): string {
  const match = /(?:#L|:line=|[?&]line=)(\d+)/.exec(ref.uri);
  return match?.[1] ? `line ${match[1]}` : "";
}

function resourceExtensionLabel(ref: ResourceRef): string {
  const name = resourceDisplayName(ref);
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1];
  return extension ? extension.toUpperCase() : resourceKindLabel(ref);
}

function isUserFacingWorkChange(change: WorkspaceChangeRecord): boolean {
  const kind = change.resource_ref.kind === "collection_record" ? "collection" : change.resource_ref.kind;
  if (kind === "file" || kind === "artifact" || kind === "collection" || kind === "wiki" || kind === "skill") {
    return true;
  }
  if (kind !== "memory") {
    return false;
  }
  const name = resourceDisplayName(change.resource_ref).toLowerCase();
  const summary = change.summary.toLowerCase();
  return !name.includes("session") && !summary.includes("captured session memory");
}

function workspaceChangeStats(change: WorkspaceChangeRecord): { added?: number; removed?: number } {
  const source = [change.summary, change.resource_ref.label, change.resource_ref.version].filter(Boolean).join(" ");
  const match = /\+(\d+)\s+-(\d+)/.exec(source);
  if (!match) {
    return {};
  }
  return { added: Number(match[1]), removed: Number(match[2]) };
}

function changeStatsLabel(item: WorkChangeCard): string {
  if (item.added === undefined && item.removed === undefined) {
    return "";
  }
  return `+${item.added ?? 0} -${item.removed ?? 0}`;
}

function workSummaryChangeTitle(block: WorkSummaryBlock): string {
  if (block.changes.length === 0) {
    return "";
  }
  const summaryKind = workChangeSummaryKind(block);
  return label(summaryKind === "files" ? "workspace_change.files_changed" : "workspace_change.workspace_items_changed").replace("{count}", String(block.changes.length));
}

function workSummaryStatsLabel(block: WorkSummaryBlock): string {
  if (block.added === undefined && block.removed === undefined) {
    return "";
  }
  return `+${block.added ?? 0} -${block.removed ?? 0}`;
}

function workChangeSummaryKind(block: WorkSummaryBlock): WorkChangeSummaryKind {
  if (block.artifacts.length > 0) {
    return "workspace";
  }
  return block.changes.every((item) => item.change.resource_ref.kind === "file") ? "files" : "workspace";
}

function summarizeWorkActivity(events: BackendEventRecord[]): WorkActivityItem[] {
  const order: WorkActivityKind[] = ["files_read", "code_searched", "command_run", "browser_checked", "artifact_created", "workspace_prepared", "memory_prepared", "skill_prepared", "waiting"];
  const counts = new Map<WorkActivityKind, number>();
  for (const event of events) {
    const kind = workActivityKind(event);
    if (!kind) {
      continue;
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return order
    .filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind);
      const key = `work_activity.${kind}` as LocaleKey;
      return {
        kind,
        label: label(key).replace("{count}", String(count ?? 0)),
        ...(count !== undefined ? { count } : {})
      };
    })
    .slice(0, 6);
}

function workActivityKind(event: BackendEventRecord): WorkActivityKind | undefined {
  if (event.event_type === "artifact_created") {
    return "artifact_created";
  }
  if (event.event_type === "workspace_change_suggested") {
    return "workspace_prepared";
  }
  if (event.event_type === "memory_suggested") {
    return "memory_prepared";
  }
  if (event.event_type === "skill_candidate_created") {
    return "skill_prepared";
  }
  if (event.event_type === "backend_waiting_for_native_input") {
    return "waiting";
  }
  if (event.event_type !== "tool_call_started" && event.event_type !== "tool_call_output") {
    return undefined;
  }
  const payload = isRecord(event.payload) ? event.payload : {};
  const toolName = typeof payload.provider_tool_name === "string" ? payload.provider_tool_name : "";
  if (toolName === "samurai.artifact.create" || toolName === "mcp__samurai__artifact_create" || payload.action_id === "artifact.create") {
    return "artifact_created";
  }
  const text = backendEventSummary(event).toLowerCase();
  if (/\b(rg|grep|search|find)\b|検索/.test(text)) {
    return "code_searched";
  }
  if (/\b(cat|sed|read|open|nl|less)\b|読み込み|read file/.test(text)) {
    return "files_read";
  }
  if (/browser|playwright|http|localhost|127\.0\.0\.1|ブラウザ/.test(text)) {
    return "browser_checked";
  }
  return "command_run";
}

function isWorkSummaryMessage(message: ChatDisplayMessage): boolean {
  return message.role === "agent" && message.state !== "loading" && Boolean(workSummaryBlock.value) && message.id === workSummaryMessageId.value;
}

function hasNewerUserMessage(message: ChatDisplayMessage): boolean {
  const index = currentMessages.value.findIndex((item) => item.id === message.id);
  if (index < 0) {
    return false;
  }
  return currentMessages.value.slice(index + 1).some((item) => item.role === "user");
}

function isWorkActivityVisible(message: ChatDisplayMessage, block: WorkSummaryBlock): boolean {
  if (!block.run) {
    return false;
  }
  return openWorkActivityRunIds.value.has(block.run.id) && !hasNewerUserMessage(message);
}

function toggleWorkActivity(block: WorkSummaryBlock) {
  if (!block.run) {
    return;
  }
  const next = new Set(openWorkActivityRunIds.value);
  if (next.has(block.run.id)) {
    next.delete(block.run.id);
  } else {
    next.add(block.run.id);
  }
  openWorkActivityRunIds.value = next;
}

function runDurationLabel(run: BackendRunRecord | undefined): string {
  if (!run) {
    return label("work_summary.did_work");
  }
  const started = Date.parse(run.started_at);
  const completed = run.completed_at ? Date.parse(run.completed_at) : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return label("work_summary.did_work");
  }
  const seconds = Math.max(1, Math.round((completed - started) / 1000));
  if (seconds < 60) {
    return label("work_summary.did_work_seconds").replace("{seconds}", String(seconds));
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return label("work_summary.did_work_minutes").replace("{minutes}", String(minutes));
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

function captureModeLabel(mode: SettingsRecord["memory_capture_mode"]): string {
  return label(`settings.capture.${mode}` as LocaleKey);
}

function externalProviderRoleLabel(role: SettingsRecord["external_provider_role"]): string {
  return label(`settings.external_provider.${role}` as LocaleKey);
}

function backendDisplayLabel(backend: AgentBackendStatus): string {
  const source = `${backend.kind} ${backend.id} ${backend.label}`.toLowerCase();
  if (source.includes("claude")) {
    return "Claude Code";
  }
  if (source.includes("codex")) {
    return "Codex";
  }
  return backend.label;
}

function displayTitle(title: string): string {
  return isInitialTitle(title) ? label("session.fallback_title") : title;
}

function isInitialTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "" || normalized === "new chat" || normalized === "untitled chat";
}

function isInternalSessionTitle(title: string): boolean {
  return title === "Workspace operations";
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

function draftSessionTitle(content: string): string {
  const title = content.replace(/\s+/g, " ").trim();
  return title.length > 60 ? `${title.slice(0, 57)}...` : title || "New chat";
}

function connectSocket() {
  const socket = io();
  socket.on("session.created", (session: SessionRecord) => {
    if (isInternalSessionTitle(session.title)) {
      return;
    }
    if (isInitialTitle(session.title) && activeSession.value?.id !== session.id) {
      return;
    }
    promoteSessionToTop(session);
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
  socket.on("backend.run.created", (run: BackendRunRecord) => {
    backendRuns.value = [run, ...backendRuns.value.filter((item) => item.id !== run.id)];
    applyStreamingRun(run);
  });
  socket.on("backend.run.updated", (run: BackendRunRecord) => {
    backendRuns.value = [run, ...backendRuns.value.filter((item) => item.id !== run.id)];
    applyStreamingRun(run);
  });
  socket.on("backend.event.created", (event: BackendEventRecord) => {
    backendEvents.value = mergeById([...backendEvents.value, event], []).sort((a, b) => a.sequence - b.sequence);
    applyStreamingEvent(event);
  });
  socket.on("workspace.change.created", (change: WorkspaceChangeRecord) => {
    workspaceChanges.value = [change, ...workspaceChanges.value.filter((item) => item.id !== change.id)];
  });
  socket.on("settings.updated", (next: SettingsRecord) => {
    settings.value = next;
    persistSettings(next);
  });
  socket.on("artifact.created", () => {
    void reloadActiveSession();
  });
  socket.on("memory.candidate.created", () => {
    void reloadActiveSession();
  });
}

function readStoredSettings(): SettingsRecord | undefined {
  try {
    const raw = window.localStorage.getItem(settingsStorageKey);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isSettingsRecord(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function persistSettings(next: SettingsRecord) {
  try {
    window.localStorage.setItem(settingsStorageKey, JSON.stringify(next));
  } catch {
    // localStorage can be unavailable in private/restricted contexts.
  }
}

function isSettingsRecord(value: unknown): value is SettingsRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.ui_locale === "string" &&
    supportedLocales.includes(value.ui_locale as SupportedLocale) &&
    typeof value.output_locale === "string" &&
    supportedLocales.includes(value.output_locale as SupportedLocale) &&
    (value.memory_capture_mode === "manual" || value.memory_capture_mode === "suggest" || value.memory_capture_mode === "off") &&
    (value.knowledge_wiki_capture_mode === "manual" || value.knowledge_wiki_capture_mode === "suggest" || value.knowledge_wiki_capture_mode === "off") &&
    (value.skill_capture_mode === "manual" || value.skill_capture_mode === "suggest" || value.skill_capture_mode === "off") &&
    (value.external_provider_role === "assistive" || value.external_provider_role === "disabled") &&
    typeof value.updated_at === "string"
  );
}

function mergeById<T extends { id: string }>(primary: T[], fallback: T[]): T[] {
  return [...new Map([...primary, ...fallback].map((item) => [item.id, item])).values()];
}

function appendById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))];
}

function hasPersistedPendingUserMessage(): boolean {
  if (!pendingUserMessage.value) {
    return false;
  }
  return messages.value
    .slice(pendingUserMessageStartIndex.value)
    .some((message) => message.role === "user" && message.content === pendingUserMessage.value?.content);
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

function isArtifactRecordLike(value: unknown): value is ArtifactRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && isRecord(value.file_ref);
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

function formatProviderNoticeDetails(notice: ProviderNotice | null): string {
  if (!notice) {
    return "";
  }
  const detail = [
    notice.provider ? `provider=${notice.provider}` : "",
    notice.model ? `model=${notice.model}` : "",
    notice.status ? `status=${notice.status}` : "",
    `retryable=${notice.retryable ? "true" : "false"}`
  ].filter(Boolean);
  return detail.join(" / ");
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
  persistWorkspaceSplitPercent(workspaceSplitPercent.value);
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

function setWorkspaceSplitPercent(value: number, persist = false) {
  workspaceSplitPercent.value = normalizeWorkspaceSplitPercent(value);
  if (persist) {
    persistWorkspaceSplitPercent(workspaceSplitPercent.value);
  }
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

function persistWorkspaceSplitPercent(value: number) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(workspaceSplitStorageKey, String(value));
  } catch {
    // localStorage can be unavailable in private/restricted contexts.
  }
}

function readCanvasMode(): CanvasMode {
  if (typeof window === "undefined") {
    return "preview";
  }
  try {
    const stored = window.localStorage.getItem(canvasModeStorageKey);
    return stored === "edit" || stored === "app" || stored === "preview" ? stored : "preview";
  } catch {
    return "preview";
  }
}

function persistCanvasMode(mode: CanvasMode) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(canvasModeStorageKey, mode);
  } catch {
    // localStorage can be unavailable in private/restricted contexts.
  }
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
            <span v-else-if="viewMode === 'runs'">{{ label("run_history.title") }}</span>
            <span v-else-if="viewMode === 'collections'">Collections</span>
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
                                <CollectionWorkspaceView
                                  v-for="presentation in message.presentations"
                                  :key="presentation.id"
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
                            <CollectionWorkspaceView
                              v-for="presentation in message.presentations"
                              :key="presentation.id"
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

          <aside class="workspace-canvas" :class="{ open: hasWorkspaceCanvas }" :aria-hidden="!hasWorkspaceCanvas">
            <div v-if="hasWorkspaceCanvas" class="workspace-canvas-inner">
              <header class="workspace-head">
                <div>
                  <span v-if="activeWorkspaceSurfaceKind" class="surface-chip is-compact">{{ surfaceRendererLabel(activeWorkspaceSurfaceKind) }}</span>
                  <h2>{{ activeArtifact ? activeArtifact.artifact.title : activeMemory ? activeMemory.memory.topic : activeSurfaceSpec?.title ?? surfaceRendererLabel(activeSurfaceSpec?.kind) }}</h2>
                </div>
                <div class="workspace-actions">
                  <div class="canvas-mode-switch" role="tablist" :aria-label="label('workspace.mode')">
                    <button type="button" :class="{ 'is-active': canvasMode === 'preview' }" :aria-pressed="canvasMode === 'preview'" @click="setCanvasMode('preview')">
                      <FileText :size="14" />
                      {{ label("workspace.mode.preview") }}
                    </button>
                    <button type="button" :class="{ 'is-active': canvasMode === 'edit' }" :aria-pressed="canvasMode === 'edit'" @click="setCanvasMode('edit')">
                      <FileInput :size="14" />
                      {{ label("workspace.mode.edit") }}
                    </button>
                    <button type="button" :class="{ 'is-active': canvasMode === 'app' }" :aria-pressed="canvasMode === 'app'" @click="setCanvasMode('app')">
                      <PanelsTopLeft :size="14" />
                      {{ label("workspace.mode.app") }}
                    </button>
                  </div>
                  <div v-if="activeArtifact" class="surface-action-group">
                    <button class="icon-button" type="button" :title="surfaceRendererLabel('form')" :aria-label="surfaceRendererLabel('form')" :disabled="loading" @click="runArtifactSurfaceOperation('form')">
                      <FileInput :size="15" />
                    </button>
                    <button class="icon-button" type="button" :title="surfaceRendererLabel('table')" :aria-label="surfaceRendererLabel('table')" :disabled="loading" @click="runArtifactSurfaceOperation('table')">
                      <Table2 :size="15" />
                    </button>
                    <button class="icon-button" type="button" :title="surfaceRendererLabel('chart')" :aria-label="surfaceRendererLabel('chart')" :disabled="loading" @click="runArtifactSurfaceOperation('chart')">
                      <BarChart3 :size="15" />
                    </button>
                    <button class="icon-button" type="button" :title="surfaceRendererLabel('custom_view')" :aria-label="surfaceRendererLabel('custom_view')" :disabled="loading" @click="runArtifactSurfaceOperation('custom_view')">
                      <PanelsTopLeft :size="15" />
                    </button>
                  </div>
                  <button class="icon-button" type="button" :title="label('action.close')" :aria-label="label('action.close')" @click="closeWorkspaceCanvas">
                    <X :size="16" />
                  </button>
                </div>
              </header>

              <template v-if="activeArtifact || activeSurfaceSpec">
                <section v-if="activeSurfaceSpec && canvasMode === 'edit'" class="surface-render lit-surface">
                  <div class="surface-render-head">
                    <span class="surface-chip is-compact">{{ surfaceRendererLabel(activeSurfaceSpec.kind) }}</span>
                    <strong>{{ activeSurfaceSpec.title || activeArtifact?.artifact.title || surfaceRendererLabel(activeSurfaceSpec.kind) }}</strong>
                  </div>

                  <div v-if="activeSurfaceSpec.kind === 'form'" class="surface-form">
                    <label v-for="field in surfaceFields(activeSurfaceSpec)" :key="field.name">
                      <span>{{ field.label }}</span>
                      <input
                        v-if="field.type !== 'checkbox'"
                        :value="formDraftValue(activeSurfaceSpec, field)"
                        :required="field.type === 'hidden' ? false : undefined"
                        :type="field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'"
                        @input="setFormDraftValue(activeSurfaceSpec, field.name, ($event.target as HTMLInputElement).value)"
                      />
                      <input
                        v-else
                        :checked="formDraftValue(activeSurfaceSpec, field) === 'true'"
                        type="checkbox"
                        @change="setFormDraftValue(activeSurfaceSpec, field.name, ($event.target as HTMLInputElement).checked)"
                      />
                    </label>
                    <button class="surface-submit" type="button" :disabled="loading" @click="submitSurfaceForm(activeSurfaceSpec)">
                      <Save :size="14" />
                      {{ activeSurfaceSpec.props.submit_label || label("workspace.save") }}
                    </button>
                  </div>

                  <div v-else-if="activeSurfaceSpec.kind === 'table'" class="surface-table-wrap">
                    <table class="surface-table">
                      <thead>
                        <tr>
                          <th v-for="column in surfaceTableColumns(activeSurfaceSpec)" :key="column.key">{{ column.label }}</th>
                          <th>{{ label("workspace.save") }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(row, rowIndex) in surfaceTableRows(activeSurfaceSpec)" :key="rowIndex">
                          <td v-for="column in surfaceTableColumns(activeSurfaceSpec)" :key="column.key">
                            <input
                              :value="tableDraftValue(activeSurfaceSpec, row, rowIndex, column.key)"
                              :readonly="activeSurfaceSpec.props.patchable !== true"
                              @input="setTableDraftValue(activeSurfaceSpec, row, rowIndex, column.key, ($event.target as HTMLInputElement).value)"
                            />
                          </td>
                          <td>
                            <button class="surface-row-save" type="button" :disabled="loading || activeSurfaceSpec.props.patchable !== true" @click="saveSurfaceTableRow(activeSurfaceSpec, row, rowIndex)">
                              <Save :size="13" />
                            </button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <pre v-else class="surface-json">{{ surfaceCustomViewPayload(activeSurfaceSpec) }}</pre>
                </section>

                <section v-if="activeSurfaceSpec && canvasMode === 'app'" class="surface-render lit-surface">
                  <div class="surface-render-head">
                    <span class="surface-chip is-compact">{{ surfaceRendererLabel(activeSurfaceSpec.kind) }}</span>
                    <strong>{{ activeSurfaceSpec.title || activeArtifact?.artifact.title || surfaceRendererLabel(activeSurfaceSpec.kind) }}</strong>
                  </div>

                  <div v-if="activeSurfaceSpec.kind === 'chart'" class="surface-chart">
                    <BarChart3 :size="18" />
                    <div>
                      <strong>{{ activeSurfaceSpec.title }}</strong>
                      <span>{{ surfaceChartRefs(activeSurfaceSpec).join(" / ") }}</span>
                    </div>
                  </div>

                  <CollectionWorkspaceView
                    v-else-if="activeSurfaceSpec.kind === 'custom_view' && isCollectionTableSurfaceSpec(activeSurfaceSpec)"
                    :spec="activeSurfaceSpec"
                    :saving="collectionSaving"
                    :error="collectionAppError"
                    :new-draft="collectionNewDraft"
                    :controller="collectionWorkspaceController"
                  />

                  <CustomViewFrame
                    v-else-if="activeSurfaceSpec.kind === 'custom_view'"
                    :spec="activeSurfaceSpec"
                    :saving="loading"
                    :run-action="runCustomViewAction"
                  />

                  <pre v-else class="surface-json">{{ surfaceCustomViewPayload(activeSurfaceSpec) }}</pre>
                </section>

                <section v-if="activeArtifact && canvasMode === 'preview'" class="canvas-preview">
                  <object v-if="isPdfArtifact(activeArtifact.artifact)" class="pdf-preview" :data="artifactContentUrl(activeArtifact.artifact)" type="application/pdf">
                    <a :href="artifactContentUrl(activeArtifact.artifact)" target="_blank" rel="noreferrer">{{ label("workspace.open_raw") }}</a>
                  </object>
                  <img v-else-if="isImageArtifact(activeArtifact.artifact)" class="image-preview" :src="artifactContentUrl(activeArtifact.artifact)" :alt="activeArtifact.artifact.title" />
                  <article v-else-if="isArtifactPreviewable(activeArtifact.artifact)" class="markdown-preview lit-surface" v-html="markdownPreviewHtml(activeArtifact.content)"></article>
                  <pre v-else class="document-surface">{{ activeArtifact.content }}</pre>
                </section>
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
        <div class="settings-group lit-surface">
          <div class="settings-head">{{ label("settings.learning_memory") }}</div>
          <div class="policy-setting">
            <div>
              <span>{{ label("settings.memory_policy") }}</span>
              <p>{{ label("settings.memory_policy_desc") }}</p>
            </div>
            <div class="segmented-control" role="group" :aria-label="label('settings.memory_policy')">
              <button
                v-for="mode in captureModes"
                :key="mode"
                type="button"
                :class="{ 'is-active': settings.memory_capture_mode === mode }"
                @click="patchSettings({ memory_capture_mode: mode })"
              >
                {{ captureModeLabel(mode) }}
              </button>
            </div>
          </div>
          <div class="policy-setting">
            <div>
              <span>{{ label("settings.wiki_policy") }}</span>
              <p>{{ label("settings.wiki_policy_desc") }}</p>
            </div>
            <div class="segmented-control" role="group" :aria-label="label('settings.wiki_policy')">
              <button
                v-for="mode in captureModes"
                :key="mode"
                type="button"
                :class="{ 'is-active': settings.knowledge_wiki_capture_mode === mode }"
                @click="patchSettings({ knowledge_wiki_capture_mode: mode })"
              >
                {{ captureModeLabel(mode) }}
              </button>
            </div>
          </div>
          <div class="policy-setting">
            <div>
              <span>{{ label("settings.skill_policy") }}</span>
              <p>{{ label("settings.skill_policy_desc") }}</p>
            </div>
            <div class="segmented-control" role="group" :aria-label="label('settings.skill_policy')">
              <button
                v-for="mode in captureModes"
                :key="mode"
                type="button"
                :class="{ 'is-active': settings.skill_capture_mode === mode }"
                @click="patchSettings({ skill_capture_mode: mode })"
              >
                {{ captureModeLabel(mode) }}
              </button>
            </div>
          </div>
          <div class="policy-setting">
            <div>
              <span>{{ label("settings.external_provider_policy") }}</span>
              <p>{{ label("settings.external_provider_policy_desc") }}</p>
            </div>
            <div class="segmented-control" role="group" :aria-label="label('settings.external_provider_policy')">
              <button
                v-for="role in externalProviderRoles"
                :key="role"
                type="button"
                :class="{ 'is-active': settings.external_provider_role === role }"
                @click="patchSettings({ external_provider_role: role })"
              >
                {{ externalProviderRoleLabel(role) }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section v-else-if="viewMode === 'runs'" class="panel-stage">
        <div v-if="backendRuns.length === 0" class="empty-note">{{ label("run_history.empty") }}</div>
        <article v-for="run in backendRuns" :key="run.id" class="history-item">
          <button class="history-toggle" type="button" :aria-expanded="isBackendRunOpen(run.id)" @click="toggleBackendRun(run.id)">
            <ChevronRight class="history-chevron" :class="{ open: isBackendRunOpen(run.id) }" :size="15" />
            <Clock3 class="history-leading" :size="15" />
            <span class="history-main">
              <strong>{{ backendLabel(run.backend_id, run.backend_kind) }} / {{ run.status }}</strong>
              <small>{{ run.input_summary }}</small>
            </span>
          </button>
          <div v-if="isBackendRunOpen(run.id)" class="history-detail">
            <p>{{ backendRunNote(run) || run.status }}</p>
          </div>
        </article>
        <article v-if="pendingLegacyApprovals.length > 0" class="audit-item lit-surface">
          <Clock3 :size="16" />
          <div>
            <strong>{{ label("legacy_request.title") }}</strong>
            <p>{{ pendingLegacyApprovals.length }}</p>
          </div>
        </article>
      </section>

      <section v-else-if="viewMode === 'collections'" class="panel-stage collections-stage">
        <div v-if="collectionListLoading" class="empty-note">Collectionを読み込んでいます</div>
        <div v-else-if="collectionListError" class="empty-note">{{ collectionListError }}</div>
        <div v-else-if="collectionSchemas.length === 0" class="empty-note">Collectionはまだありません</div>
        <div v-else class="collection-list">
          <button
            v-for="schema in collectionSchemas"
            :key="schema.id"
            class="collection-list-item lit-surface"
            type="button"
            @click="openCollectionApp(schema)"
          >
            <span class="codex-card-icon"><Table2 :size="18" /></span>
            <span class="collection-list-main">
              <strong>{{ collectionSchemaTitle(schema) }}</strong>
              <small>{{ schema.id }} ・ {{ schema.fields.length }} fields ・ {{ collectionSchemaRenderer(schema) }}</small>
            </span>
            <em>開く</em>
          </button>
        </div>
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
          <span>今回渡した文脈</span>
          <span class="status-pill">{{ latestBackendRun?.status ?? "idle" }}</span>
        </div>
        <p>{{ backendRunContextSummary(latestBackendRun) }}</p>
      </section>

      <section class="drawer-card lit-surface">
        <div class="drawer-card-head">
          <span>{{ label("backend_event.title") }}</span>
          <span class="drawer-card-badges">
            <span v-if="lastSurfaceRenderSpec" class="surface-chip is-compact">{{ surfaceRendererLabel(lastSurfaceRenderSpec.kind) }}</span>
            <span class="status-pill">{{ latestBackendEvents.length }}</span>
          </span>
        </div>
        <p v-if="latestBackendEvents.length === 0">{{ label("backend_event.empty") }}</p>
        <ol v-else class="activity-list">
          <li v-for="item in latestBackendEvents" :key="item.id" class="history-item drawer-history-item">
            <button class="history-toggle" type="button" :aria-expanded="isBackendEventOpen(item.id)" @click="toggleBackendEvent(item.id)">
              <ChevronRight class="history-chevron" :class="{ open: isBackendEventOpen(item.id) }" :size="15" />
              <span class="history-index">#{{ item.sequence }}</span>
              <span class="history-main">
                <strong>{{ item.event_type }}</strong>
                <small>{{ backendEventSummary(item) }}</small>
              </span>
            </button>
            <pre v-if="isBackendEventOpen(item.id)" class="event-payload">{{ backendEventPayload(item) }}</pre>
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
