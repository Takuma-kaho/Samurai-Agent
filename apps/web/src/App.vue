<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  Brain,
  CheckCircle2,
  Clock3,
  FileText,
  Monitor,
  Moon,
  PanelRightOpen,
  Plus,
  Search,
  Send,
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
import { api, ApiError, type ApprovalLifecyclePayload, type SearchResult } from "./lib/api";

type ViewMode = "chat" | "search" | "settings" | "audit" | "memory";

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
const searchQuery = ref("");
const viewMode = ref<ViewMode>("chat");
const drawerOpen = ref(false);
const loading = ref(false);
const activeArtifact = ref<{ artifact: ArtifactRecord; content: string } | null>(null);

const label = (key: LocaleKey) => t(settings.value.ui_locale, key);
const currentMessages = computed(() => messages.value);
const latestArtifact = computed(() => activeArtifact.value?.artifact ?? artifacts.value[0]);
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

onMounted(async () => {
  settings.value = await api.getSettings();
  applyTheme(settings.value.theme);
  await loadSessions();
  connectSocket();
});

watch(
  () => settings.value.theme,
  (theme) => applyTheme(theme)
);

async function loadSessions() {
  sessions.value = await api.listSessions();
  if (sessions.value.length === 0) {
    await createSession();
    return;
  }
  const firstSession = sessions.value[0];
  if (firstSession) {
    await openSession(firstSession.id);
  }
}

async function createSession() {
  const session = await api.createSession({
    ui_locale: settings.value.ui_locale,
    output_locale: settings.value.output_locale
  });
  sessions.value = [session, ...sessions.value.filter((item) => item.id !== session.id)];
  await openSession(session.id);
  viewMode.value = "chat";
}

async function openSession(sessionId: string) {
  const detail = await api.getSession(sessionId);
  activeSession.value = detail.session;
  messages.value = detail.messages;
  operations.value = detail.operations;
  artifacts.value = detail.artifacts;
  auditRecords.value = detail.auditRecords;
  memory.value = detail.memory;
  activity.value = detail.activity;
  await refreshAuditContext();
}

async function sendMessage() {
  if (!activeSession.value || prompt.value.trim().length === 0 || loading.value) {
    return;
  }
  const content = prompt.value.trim();
  prompt.value = "";
  loading.value = true;
  try {
    const result = await api.sendMessage(activeSession.value.id, content, settings.value.output_locale);
    messages.value.push(...result.messages);
    artifacts.value = [...result.artifacts, ...artifacts.value];
    auditRecords.value = [...result.auditRecords, ...auditRecords.value];
    operations.value = [...result.operations, ...operations.value];
    policyDecisions.value = [...result.policyDecisions, ...policyDecisions.value];
    approvalRequests.value = [...result.approvalRequests, ...approvalRequests.value];
    rollbackPoints.value = [...result.rollbackPoints, ...rollbackPoints.value];
    memory.value = await api.getMemory();
    activity.value = result.activity;
    if (result.artifacts[0]) {
      activeArtifact.value = await api.getArtifact(result.artifacts[0].id);
    }
  } finally {
    loading.value = false;
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
  }
  if (result.kind === "message" && result.session_id) {
    await openSession(result.session_id);
    viewMode.value = "chat";
  }
  if (result.kind === "artifact") {
    activeArtifact.value = await api.getArtifact(result.id);
    viewMode.value = "chat";
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
  memory.value = await api.getMemory();
  viewMode.value = "memory";
}

async function patchSettings(patch: Partial<Pick<SettingsRecord, "theme" | "ui_locale" | "output_locale">>) {
  settings.value = await api.patchSettings(patch);
}

async function openArtifact(id: string) {
  activeArtifact.value = await api.getArtifact(id);
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

function auditStatusByOperation(operation: OperationRecord): string {
  if (operation.status === "pending_approval") {
    return label("approval.status.pending");
  }
  if (operation.status === "deferred") {
    return label("approval.status.deferred");
  }
  if (operation.status === "denied") {
    return label("approval.status.denied");
  }
  if (operation.status === "completed") {
    return label("approval.status.completed");
  }
  return label("approval.status.recorded");
}

function connectSocket() {
  const socket = io();
  socket.on("session.created", (session: SessionRecord) => {
    sessions.value = [session, ...sessions.value.filter((item) => item.id !== session.id)];
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
}

function applyTheme(theme: SettingsRecord["theme"]) {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.body.dataset.theme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
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
</script>

<template>
  <main class="app-shell" :class="{ 'has-drawer': drawerOpen }">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-symbol">S</div>
        <div class="brand-name">{{ label("app.name") }}</div>
      </div>

      <nav class="nav-block">
        <button class="nav-item is-primary" type="button" @click="createSession">
          <Plus :size="16" />
          <span>{{ label("nav.new_chat") }}</span>
        </button>
        <button class="nav-item" type="button" @click="viewMode = 'search'">
          <Search :size="16" />
          <span>{{ label("nav.search") }}</span>
        </button>
      </nav>

      <section class="session-list" :aria-label="label('nav.sessions')">
        <div class="section-label">{{ label("nav.sessions") }}</div>
        <button
          v-for="session in sessions"
          :key="session.id"
          class="session-item"
          :class="{ 'is-current': activeSession?.id === session.id }"
          type="button"
          @click="openSession(session.id)"
        >
          <span>{{ session.title }}</span>
          <span v-if="activeSession?.id === session.id" class="session-dot" />
        </button>
      </section>

      <div class="sidebar-footer">
        <button class="nav-item footer-button" type="button" @click="viewMode = 'settings'">
          <Settings :size="16" />
          <span>{{ label("nav.settings") }}</span>
        </button>
      </div>
    </aside>

    <section class="main-stage">
      <header class="stage-header">
        <div>
          <div class="stage-title">
            <span v-if="viewMode === 'chat'">Chat</span>
            <span v-else-if="viewMode === 'search'">{{ label("search.title") }}</span>
            <span v-else-if="viewMode === 'settings'">{{ label("settings.title") }}</span>
            <span v-else-if="viewMode === 'audit'">{{ label("audit.title") }}</span>
            <span v-else>{{ label("memory.title") }}</span>
          </div>
        </div>
        <div class="stage-actions">
          <button class="icon-button" type="button" title="Memory" @click="loadMemory">
            <Brain :size="17" />
          </button>
          <button class="icon-button" type="button" title="Audit" @click="loadAudit">
            <ShieldCheck :size="17" />
          </button>
          <button class="icon-button" :class="{ 'has-badge': hasActivity }" type="button" title="Context" @click="drawerOpen = !drawerOpen">
            <PanelRightOpen :size="17" />
          </button>
        </div>
      </header>

      <section v-if="viewMode === 'chat'" class="chat-stage">
        <div v-if="currentMessages.length === 0" class="empty-composition">
          <h1>{{ label("chat.empty_title") }}</h1>
        </div>

        <div v-else class="conversation">
          <article
            v-for="message in currentMessages"
            :key="message.id"
            class="message"
            :class="message.role === 'user' ? 'message-user' : 'message-agent lit-surface'"
          >
            <p>{{ message.content }}</p>
          </article>

          <article v-for="artifact in artifacts.slice(0, 3)" :key="artifact.id" class="artifact-card lit-surface">
            <div class="artifact-head">
              <div>
                <div class="artifact-type">{{ label("artifact.title") }}</div>
                <h2>{{ artifact.title }}</h2>
              </div>
              <span class="status-pill"><CheckCircle2 :size="13" />{{ label("status.draft") }}</span>
            </div>
            <div class="artifact-preview">
              <p>{{ artifact.metadata.status ?? label("status.saved") }}</p>
            </div>
            <div class="artifact-actions">
              <button type="button" @click="openArtifact(artifact.id)">{{ label("artifact.open") }}</button>
              <span>{{ label("artifact.saved") }}</span>
            </div>
          </article>
        </div>

        <article v-if="latestArtifact && activeArtifact" class="workspace-peek lit-surface">
          <header class="workspace-head">
            <div>
              <span class="artifact-type">{{ label("artifact.title") }}</span>
              <h2>{{ activeArtifact.artifact.title }}</h2>
            </div>
            <FileText :size="18" />
          </header>
          <pre class="document-surface">{{ activeArtifact.content }}</pre>
        </article>

        <form class="prompt-card lit-surface" @submit.prevent="sendMessage">
          <input v-model="prompt" :placeholder="label('chat.placeholder')" :aria-label="label('chat.placeholder')" />
          <button class="send-button" type="submit" :aria-label="label('chat.send')" :disabled="loading">
            <Send :size="18" />
          </button>
        </form>
      </section>

      <section v-else-if="viewMode === 'search'" class="panel-stage">
        <form class="search-row lit-surface" @submit.prevent="runSearch">
          <Search :size="17" />
          <input v-model="searchQuery" :placeholder="label('search.placeholder')" />
        </form>
        <div class="result-list">
          <button v-for="result in searchResults" :key="`${result.kind}-${result.id}`" class="result-item lit-surface" type="button" @click="chooseResult(result)">
            <span class="result-kind">{{ result.kind }}</span>
            <strong>{{ result.title }}</strong>
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
              Light
            </button>
            <button :class="{ active: settings.theme === 'dark' }" type="button" @click="patchSettings({ theme: 'dark' })">
              <Moon :size="16" />
              Dark
            </button>
            <button :class="{ active: settings.theme === 'system' }" type="button" @click="patchSettings({ theme: 'system' })">
              <Monitor :size="16" />
              System
            </button>
          </div>
        </div>

        <div class="settings-group lit-surface">
          <div class="settings-head">{{ label("settings.language") }}</div>
          <label>
            <span>{{ label("settings.ui_locale") }}</span>
            <select :value="settings.ui_locale" @change="patchSettings({ ui_locale: ($event.target as HTMLSelectElement).value as SupportedLocale })">
              <option v-for="locale in supportedLocales" :key="locale" :value="locale">{{ locale }}</option>
            </select>
          </label>
          <label>
            <span>{{ label("settings.output_locale") }}</span>
            <select :value="settings.output_locale" @change="patchSettings({ output_locale: ($event.target as HTMLSelectElement).value as SupportedLocale })">
              <option v-for="locale in supportedLocales" :key="locale" :value="locale">{{ locale }}</option>
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
          <span class="status-pill">{{ item.state }}</span>
          <strong>{{ item.topic }}</strong>
          <p>{{ item.source }}</p>
        </article>
      </section>
    </section>

    <aside v-if="drawerOpen" class="context-drawer">
      <header class="drawer-header">
        <div class="drawer-title">{{ label("context.title") }}</div>
        <button class="icon-button" type="button" title="Close" @click="drawerOpen = false">
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
        <p v-else>{{ firstMemory.topic }} / {{ firstMemory.state }}</p>
      </section>
    </aside>
  </main>
</template>
