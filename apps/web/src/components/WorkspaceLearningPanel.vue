<script setup lang="ts">
import { computed, defineComponent, h, onMounted, onUnmounted, ref, watch } from "vue";
import Archive from "lucide-vue-next/dist/esm/icons/archive.js";
import Check from "lucide-vue-next/dist/esm/icons/check.js";
import Lock from "lucide-vue-next/dist/esm/icons/lock.js";
import Search from "lucide-vue-next/dist/esm/icons/search.js";
import type {
  DesktopWorkspaceLearningEvidence,
  DesktopWorkspaceLearningResource,
  DesktopWorkspaceLearningResourceVersion,
  DesktopWorkspaceLearningSettings
} from "../lib/api";

const props = defineProps<{
  available: boolean;
  selectedRoomId?: string;
}>();

type ScopeKind = "workspace" | "room";
type ResourceKind = DesktopWorkspaceLearningResource["kind"];

const ResourceGroup = defineComponent({
  name: "ResourceGroup",
  props: {
    title: { type: String, required: true },
    resources: { type: Array as () => DesktopWorkspaceLearningResource[], required: true },
    scopeLabel: { type: Function as () => (resource: DesktopWorkspaceLearningResource) => string, required: true }
  },
  emits: ["select", "fixed", "archive"],
  setup(groupProps, { emit }) {
    return () => h("section", { class: "workspace-learning-group" }, [
      h("strong", groupProps.title),
      groupProps.resources.length === 0
        ? h("span", { class: "workspace-learning-empty" }, "まだありません")
        : h("div", { class: "workspace-learning-list" }, groupProps.resources.map((resource) => h("article", { key: resource.id, class: ["workspace-learning-item", { "is-provisional": resource.state === "provisional", "is-archived": resource.state === "archived", "is-conflict": resource.state === "conflict" }] }, [
          h("button", { type: "button", onClick: () => emit("select", resource) }, [
            h("small", groupProps.scopeLabel(resource)), h("strong", resource.title),
            ...(resource.state === "provisional" ? [h("em", { class: "workspace-learning-provisional" }, provisionalLabel(resource))] : []),
            h("span", resource.content), h("em", `v${resource.version}`)
          ]),
          h("div", { class: "workspace-learning-actions" }, [
            h("button", { type: "button", title: resource.aiUpdateLocked ? "AI固定を解除" : "AI更新を固定", onClick: () => emit("fixed", resource) }, [h(resource.aiUpdateLocked ? Lock : Check, { size: 14 })]),
            h("button", { type: "button", title: resource.state === "archived" ? "復元" : "アーカイブ", onClick: () => emit("archive", resource) }, [h(Archive, { size: 14 })])
          ])
        ])))
    ]);
  }
});

const loading = ref(false);
const saving = ref(false);
const searching = ref(false);
const error = ref<string | null>(null);
const roomResources = ref<DesktopWorkspaceLearningResource[]>([]);
const workspaceResources = ref<DesktopWorkspaceLearningResource[]>([]);
const searchQuery = ref("");
const searchResults = ref<DesktopWorkspaceLearningResource[]>([]);
const settings = ref<DesktopWorkspaceLearningSettings | null>(null);
const workspaceSettings = ref<DesktopWorkspaceLearningSettings | null>(null);
const roomSettings = ref<DesktopWorkspaceLearningSettings | null>(null);
const settingsScope = ref<ScopeKind>("workspace");
const editing = ref<DesktopWorkspaceLearningResource | null>(null);
const resourceHistory = ref<{ versions: DesktopWorkspaceLearningResourceVersion[]; evidence: DesktopWorkspaceLearningEvidence[] } | null>(null);
const resourceScope = ref<ScopeKind>("room");
const resourceKind = ref<ResourceKind>("knowledge");
const resourceTitle = ref("");
const resourceContent = ref("");
const actionReason = ref("人が確認して保存");
const settingsEnabled = ref(true);
const settingsEngineId = ref("");
const settingsModel = ref("");
const settingsSecretRef = ref("");
const settingsCurrencyLimit = ref("");
const settingsTokenLimit = ref("");
const clearSecretRef = ref(false);
let loadGeneration = 0;
let searchGeneration = 0;
let realtimeReloadTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribeRealtime: (() => void) | undefined;

const canUse = computed(() => props.available && Boolean(props.selectedRoomId) && Boolean(window.samuraiDesktop?.listWorkspaceLearningResources));
const workspaceRules = computed(() => workspaceResources.value.filter((resource) => resource.isAbsoluteRule));
const workspaceKnowledge = computed(() => workspaceResources.value.filter((resource) => !resource.isAbsoluteRule));

watch(() => props.selectedRoomId, () => {
  // A selected Room is an authorization/context boundary. Never leave an
  // editable projection or its evidence visible while the next Room loads.
  beginCreate();
  clearLearningDisplay();
  searchQuery.value = "";
  searchResults.value = [];
  searching.value = false;
  searchGeneration += 1;
  void load();
}, { immediate: true });

watch(resourceKind, (kind) => {
  if (kind === "workspace_rule") resourceScope.value = "workspace";
});

watch(settingsScope, () => applySettingsForm());

onMounted(() => {
  unsubscribeRealtime = window.samuraiDesktop?.onWorkspaceServerEvent?.((event) => {
    if (event?.type !== "event" || !event.kind?.startsWith("learning.")) return;
    if (event.roomId && event.roomId !== props.selectedRoomId) return;
    if (realtimeReloadTimer) clearTimeout(realtimeReloadTimer);
    realtimeReloadTimer = setTimeout(() => { void load(); }, 100);
  });
});

onUnmounted(() => {
  unsubscribeRealtime?.();
  if (realtimeReloadTimer) clearTimeout(realtimeReloadTimer);
});

async function load(): Promise<void> {
  const generation = ++loadGeneration;
  if (!canUse.value || !props.selectedRoomId) {
    clearLearningDisplay();
    return;
  }
  const roomId = props.selectedRoomId;
  const desktop = window.samuraiDesktop;
  if (!desktop?.listWorkspaceLearningResources || !desktop.getWorkspaceLearningSettings) return;
  loading.value = true;
  error.value = null;
  try {
    const [room, workspace, configured] = await Promise.all([
      desktop.listWorkspaceLearningResources({ scopeKind: "room", roomId, includeArchived: true }),
      desktop.listWorkspaceLearningResources({ scopeKind: "workspace", includeArchived: true }),
      desktop.getWorkspaceLearningSettings(roomId)
    ]);
    if (generation !== loadGeneration || props.selectedRoomId !== roomId) return;
    roomResources.value = room.resources;
    workspaceResources.value = workspace.resources;
    applySettings(configured);
  } catch (cause) {
    if (generation === loadGeneration && props.selectedRoomId === roomId) error.value = message(cause);
  } finally {
    if (generation === loadGeneration && props.selectedRoomId === roomId) loading.value = false;
  }
}

function beginCreate(): void {
  editing.value = null;
  resourceHistory.value = null;
  resourceScope.value = "room";
  resourceKind.value = "knowledge";
  resourceTitle.value = "";
  resourceContent.value = "";
}

function clearLearningDisplay(): void {
  loading.value = false;
  roomResources.value = [];
  workspaceResources.value = [];
  settings.value = null;
  workspaceSettings.value = null;
  roomSettings.value = null;
  error.value = null;
}

async function beginEdit(resource: DesktopWorkspaceLearningResource): Promise<void> {
  editing.value = resource;
  resourceScope.value = resource.scope.kind;
  resourceKind.value = resource.kind;
  resourceTitle.value = resource.title;
  resourceContent.value = resource.content;
  resourceHistory.value = null;
  const desktop = window.samuraiDesktop;
  if (!desktop?.getWorkspaceLearningResource) return;
  try {
    const detail = await desktop.getWorkspaceLearningResource({ resourceId: resource.id });
    if (editing.value?.id !== resource.id) return;
    resourceHistory.value = { versions: detail.versions, evidence: detail.evidence };
  } catch (cause) {
    if (editing.value?.id === resource.id) error.value = message(cause);
  }
}

async function saveResource(): Promise<void> {
  const desktop = window.samuraiDesktop;
  if (!desktop || !props.selectedRoomId || !resourceTitle.value.trim() || !resourceContent.value.trim() || !actionReason.value.trim()) return;
  if (!desktop.createWorkspaceLearningResource || !desktop.updateWorkspaceLearningResource) return;
  saving.value = true;
  error.value = null;
  const scopeInput = resourceScope.value === "room" ? { scopeKind: "room" as const, roomId: props.selectedRoomId } : { scopeKind: "workspace" as const };
  const input = {
    ...scopeInput,
    kind: resourceKind.value,
    ...(resourceKind.value === "workspace_rule" ? { isAbsoluteRule: true } : {}),
    title: resourceTitle.value,
    content: resourceContent.value,
    reason: actionReason.value,
    operationId: operationId()
  };
  try {
    if (editing.value) {
      await desktop.updateWorkspaceLearningResource({ ...input, resourceId: editing.value.id, expectedVersion: editing.value.version });
    } else {
      await desktop.createWorkspaceLearningResource(input);
    }
    beginCreate();
    await load();
  } catch (cause) {
    error.value = message(cause);
  } finally {
    saving.value = false;
  }
}

async function toggleFixed(resource: DesktopWorkspaceLearningResource): Promise<void> {
  const desktop = window.samuraiDesktop;
  if (!desktop?.setWorkspaceLearningResourceFixed || !actionReason.value.trim()) return;
  saving.value = true;
  try {
    await desktop.setWorkspaceLearningResourceFixed({
      resourceId: resource.id, fixed: !resource.aiUpdateLocked, expectedVersion: resource.version,
      reason: actionReason.value, operationId: operationId()
    });
    await load();
  } catch (cause) {
    error.value = message(cause);
  } finally {
    saving.value = false;
  }
}

async function toggleArchive(resource: DesktopWorkspaceLearningResource): Promise<void> {
  const desktop = window.samuraiDesktop;
  if (!desktop?.archiveWorkspaceLearningResource || !actionReason.value.trim()) return;
  saving.value = true;
  try {
    await desktop.archiveWorkspaceLearningResource({
      resourceId: resource.id, archived: resource.state !== "archived", expectedVersion: resource.version,
      reason: actionReason.value, operationId: operationId()
    });
    await load();
  } catch (cause) {
    error.value = message(cause);
  } finally {
    saving.value = false;
  }
}

async function runSearch(): Promise<void> {
  const desktop = window.samuraiDesktop;
  if (!desktop?.searchWorkspaceKnowledge || !props.selectedRoomId || !searchQuery.value.trim()) return;
  const roomId = props.selectedRoomId;
  const generation = ++searchGeneration;
  searching.value = true;
  error.value = null;
  try {
    const result = await desktop.searchWorkspaceKnowledge({ roomId, query: searchQuery.value, limit: 20 });
    if (generation === searchGeneration && props.selectedRoomId === roomId) searchResults.value = result.resources;
  } catch (cause) {
    if (generation === searchGeneration && props.selectedRoomId === roomId) error.value = message(cause);
  } finally {
    if (generation === searchGeneration && props.selectedRoomId === roomId) searching.value = false;
  }
}

async function saveSettings(): Promise<void> {
  const desktop = window.samuraiDesktop;
  const effective = settings.value;
  if (!desktop?.updateWorkspaceLearningSettings || !effective || !actionReason.value.trim()) return;
  saving.value = true;
  error.value = null;
  try {
    const current = settingsScope.value === "room" ? roomSettings.value : workspaceSettings.value;
    const scopeInput = settingsScope.value === "room" && props.selectedRoomId
      ? { scopeKind: "room" as const, roomId: props.selectedRoomId }
      : { scopeKind: "workspace" as const };
    await desktop.updateWorkspaceLearningSettings({
      ...scopeInput,
      enabled: settingsEnabled.value,
      ...(settingsEngineId.value.trim() ? { engineId: settingsEngineId.value.trim() } : { clearEngineId: true }),
      ...(settingsModel.value.trim() ? { model: settingsModel.value.trim() } : { clearModel: true }),
      ...(settingsSecretRef.value.trim() ? { secretRef: settingsSecretRef.value.trim() } : {}),
      ...(clearSecretRef.value ? { clearSecretRef: true } : {}),
      ...(settingsCurrencyLimit.value.trim() ? { currencyLimit: Number(settingsCurrencyLimit.value) } : { clearCurrencyLimit: true }),
      ...(settingsTokenLimit.value.trim() ? { tokenLimit: Number(settingsTokenLimit.value) } : { clearTokenLimit: true }),
      expectedVersion: current?.version ?? 0,
      operationId: operationId()
    });
    await load();
  } catch (cause) {
    error.value = message(cause);
  } finally {
    saving.value = false;
  }
}

async function removeRoomOverride(): Promise<void> {
  const desktop = window.samuraiDesktop;
  if (!desktop?.updateWorkspaceLearningSettings || !props.selectedRoomId || !roomSettings.value) return;
  saving.value = true;
  error.value = null;
  try {
    await desktop.updateWorkspaceLearningSettings({
      scopeKind: "room", roomId: props.selectedRoomId, removeOverride: true,
      expectedVersion: roomSettings.value.version, operationId: operationId()
    });
    await load();
  } catch (cause) {
    error.value = message(cause);
  } finally {
    saving.value = false;
  }
}

function applySettings(value: { settings: DesktopWorkspaceLearningSettings; workspace_settings?: DesktopWorkspaceLearningSettings; room_settings?: DesktopWorkspaceLearningSettings }): void {
  settings.value = value.settings;
  workspaceSettings.value = value.workspace_settings ?? null;
  roomSettings.value = value.room_settings ?? null;
  settingsScope.value = value.room_settings ? "room" : "workspace";
  applySettingsForm();
}

function applySettingsForm(): void {
  const effective = settings.value;
  if (!effective) return;
  // A Room with no override starts from its inherited values. Saving a small
  // Room change must not silently clear its usable Engine/model/budget.
  const value = settingsScope.value === "room"
    ? (roomSettings.value ?? effective)
    : workspaceSettings.value;
  settingsEnabled.value = value?.enabled ?? (settingsScope.value === "room" ? effective.enabled : true);
  settingsEngineId.value = value?.engineId ?? "";
  settingsModel.value = value?.model ?? "";
  settingsSecretRef.value = "";
  clearSecretRef.value = false;
  settingsCurrencyLimit.value = value?.currencyLimit === undefined ? "" : String(value.currencyLimit);
  settingsTokenLimit.value = value?.tokenLimit === undefined ? "" : String(value.tokenLimit);
}

function resourceScopeLabel(resource: DesktopWorkspaceLearningResource): string {
  if (resource.isAbsoluteRule) return "Workspaceの絶対ルール";
  return resource.scope.kind === "room" ? "このRoom" : "Workspace共通";
}

function provisionalLabel(resource: DesktopWorkspaceLearningResource): string {
  return `AIの暫定Knowledge${resource.confidence === undefined ? "" : `（確信度 ${Math.round(resource.confidence * 100)}%）`}`;
}

function operationId(): string {
  return `learning_ui_${crypto.randomUUID()}`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Knowledgeを更新できませんでした";
}
</script>

<template>
  <section class="workspace-learning-panel" aria-label="Knowledgeと学習設定">
    <div class="workspace-learning-head">
      <div>
        <strong>Knowledgeと学習</strong>
        <p>このRoomのKnowledgeだけを自動で見直します。ほかのRoomは自動で混ざりません。</p>
      </div>
      <button type="button" :disabled="loading || saving" @click="load">更新</button>
    </div>

    <div v-if="!props.selectedRoomId" class="empty-note">Roomを選ぶとKnowledgeを確認できます</div>
    <div v-else-if="!props.available" class="empty-note">Workspace Serverへ接続するとKnowledgeを管理できます</div>
    <template v-else>
      <div v-if="error" class="workspace-learning-error">{{ error }}</div>
      <div v-if="loading" class="empty-note">Knowledgeを読み込んでいます</div>

      <form class="workspace-learning-search" @submit.prevent="runSearch">
        <Search :size="15" />
        <input v-model="searchQuery" placeholder="このRoomで検索" />
        <button type="submit" :disabled="saving || searching || !searchQuery.trim()">検索</button>
      </form>
      <div v-if="searchResults.length" class="workspace-learning-list">
        <button v-for="resource in searchResults" :key="`search-${resource.id}`" type="button" class="workspace-learning-item" @click="beginEdit(resource)">
          <small>{{ resourceScopeLabel(resource) }}</small><strong>{{ resource.title }}</strong><span>{{ resource.content }}</span>
        </button>
      </div>

      <div class="workspace-learning-groups">
        <ResourceGroup title="最優先のWorkspaceルール" :resources="workspaceRules" :scope-label="resourceScopeLabel" @select="beginEdit" @fixed="toggleFixed" @archive="toggleArchive" />
        <ResourceGroup title="このRoomのKnowledge" :resources="roomResources" :scope-label="resourceScopeLabel" @select="beginEdit" @fixed="toggleFixed" @archive="toggleArchive" />
        <ResourceGroup title="Workspace共通Knowledge" :resources="workspaceKnowledge" :scope-label="resourceScopeLabel" @select="beginEdit" @fixed="toggleFixed" @archive="toggleArchive" />
      </div>

      <form class="workspace-learning-form" @submit.prevent="saveResource">
        <div class="workspace-learning-form-head"><strong>{{ editing ? "Knowledgeを編集" : "Knowledgeを追加" }}</strong><button type="button" @click="beginCreate">新規</button></div>
        <label><span>保存先</span><select v-model="resourceScope" :disabled="Boolean(editing) || resourceKind === 'workspace_rule'"><option value="room">このRoom</option><option value="workspace">Workspace共通</option></select></label>
        <label><span>種類</span><select v-model="resourceKind" :disabled="Boolean(editing)"><option value="knowledge">Knowledge</option><option value="memory">Memory</option><option value="skill">Skill</option><option value="workspace_rule">絶対ルール</option></select></label>
        <label><span>タイトル</span><input v-model="resourceTitle" required maxlength="20000" /></label>
        <label><span>内容</span><textarea v-model="resourceContent" required maxlength="200000" rows="4" /></label>
        <label><span>変更理由</span><input v-model="actionReason" required maxlength="4000" /></label>
        <button type="submit" :disabled="saving || !resourceTitle.trim() || !resourceContent.trim()">{{ editing ? "保存" : "追加" }}</button>
      </form>

      <section v-if="editing && resourceHistory" class="workspace-learning-history" aria-label="Knowledgeの変更履歴">
        <strong>変更履歴と根拠</strong>
        <div v-if="resourceHistory.versions.length" class="workspace-learning-history-list">
          <article v-for="version in resourceHistory.versions" :key="`version-${version.version}`">
            <strong>v{{ version.version }} · {{ version.changeKind }}</strong>
            <span>{{ version.reason }}</span>
          </article>
        </div>
        <div v-if="resourceHistory.evidence.length" class="workspace-learning-history-list">
          <article v-for="evidence in resourceHistory.evidence" :key="(evidence.activityId ?? 'human') + evidence.resourceVersion + evidence.kind">
            <strong>根拠 · v{{ evidence.resourceVersion }} · {{ evidence.kind }}</strong>
            <span>{{ evidence.summary }}</span>
          </article>
        </div>
        <span v-if="resourceHistory.versions.length === 0 && resourceHistory.evidence.length === 0" class="workspace-learning-empty">履歴はまだありません</span>
      </section>

      <form v-if="settings" class="workspace-learning-form" @submit.prevent="saveSettings">
        <div class="workspace-learning-form-head"><strong>学習Engine設定</strong><small>Workspaceの標準値と、このRoomだけの上書きを分けて保存します</small></div>
        <label><span>設定対象</span><select v-model="settingsScope"><option value="workspace">Workspaceの標準設定</option><option value="room">このRoomだけの上書き</option></select></label>
        <label class="workspace-learning-check"><input v-model="settingsEnabled" type="checkbox" /><span>この設定で学習を有効にする</span></label>
        <label><span>Engine ID</span><input v-model="settingsEngineId" maxlength="128" placeholder="例: local_engine" /></label>
        <label><span>Model</span><input v-model="settingsModel" maxlength="512" /></label>
        <label><span>SecretRef</span><input v-model="settingsSecretRef" maxlength="128" placeholder="実際の秘密値は入力しない" /></label>
        <label class="workspace-learning-check"><input v-model="clearSecretRef" type="checkbox" /><span>登録済みのSecretRefを解除する</span></label>
        <label><span>費用上限</span><input v-model="settingsCurrencyLimit" inputmode="decimal" /></label>
        <label><span>トークン上限</span><input v-model="settingsTokenLimit" inputmode="numeric" /></label>
        <small>現在の使用量: {{ settings.currencyUsed }} / {{ settings.tokensUsed }}（確保中: {{ settings.currencyReserved }} / {{ settings.tokensReserved }}）</small>
        <button type="submit" :disabled="saving">設定を保存</button>
        <button v-if="settingsScope === 'room' && roomSettings" type="button" :disabled="saving" @click="removeRoomOverride">このRoomの上書きを解除</button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.workspace-learning-panel { display: grid; gap: 12px; }
.workspace-learning-head, .workspace-learning-form-head, .workspace-learning-item, .workspace-learning-actions, .workspace-learning-search { display: flex; align-items: center; gap: 8px; }
.workspace-learning-head { justify-content: space-between; }
.workspace-learning-head p { margin: 3px 0 0; color: var(--text-muted, #777); font-size: 12px; }
.workspace-learning-error { color: #c2410c; font-size: 12px; }
.workspace-learning-search input { min-width: 0; flex: 1; }
.workspace-learning-groups, .workspace-learning-group, .workspace-learning-list, .workspace-learning-form { display: grid; gap: 8px; }
.workspace-learning-group { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); padding-top: 9px; }
.workspace-learning-empty { color: var(--text-muted, #777); font-size: 12px; }
.workspace-learning-item { justify-content: space-between; border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 8px; padding: 8px; }
.workspace-learning-item > button { min-width: 0; flex: 1; display: grid; gap: 2px; text-align: left; background: transparent; border: 0; color: inherit; }
.workspace-learning-item span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text-muted, #777); }
.workspace-learning-item small, .workspace-learning-item em { font-size: 11px; color: var(--text-muted, #777); font-style: normal; }
.workspace-learning-item.is-archived { opacity: .55; }
.workspace-learning-item.is-provisional { border-color: #2563eb; }
.workspace-learning-item.is-conflict { border-color: #d97706; }
.workspace-learning-provisional { color: #2563eb !important; }
.workspace-learning-actions button { padding: 3px; }
.workspace-learning-form { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); padding-top: 10px; }
.workspace-learning-history, .workspace-learning-history-list { display: grid; gap: 7px; }
.workspace-learning-history { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); padding-top: 10px; }
.workspace-learning-history article { display: grid; gap: 2px; font-size: 12px; }
.workspace-learning-history article span { color: var(--text-muted, #777); }
.workspace-learning-form-head { justify-content: space-between; }
.workspace-learning-form label { display: grid; gap: 4px; font-size: 12px; }
.workspace-learning-form input, .workspace-learning-form select, .workspace-learning-form textarea { width: 100%; box-sizing: border-box; }
.workspace-learning-check { grid-template-columns: auto 1fr; align-items: center; }
</style>
