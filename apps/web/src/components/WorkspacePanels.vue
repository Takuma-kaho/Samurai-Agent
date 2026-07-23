<script setup lang="ts">
import Archive from "lucide-vue-next/dist/esm/icons/archive.js";
import ChevronRight from "lucide-vue-next/dist/esm/icons/chevron-right.js";
import Clock3 from "lucide-vue-next/dist/esm/icons/clock-3.js";
import Eye from "lucide-vue-next/dist/esm/icons/eye.js";
import Search from "lucide-vue-next/dist/esm/icons/search.js";
import Table2 from "lucide-vue-next/dist/esm/icons/table-2.js";
import type {
  BackendRunRecord,
  CollectionSchema,
  MemoryFrontmatter,
  SessionRecord,
  SettingsRecord,
  SupportedLocale
} from "@samurai-agent/core-schemas";
import type { MemoryDetail, SearchResult } from "../lib/api";
import type { AutomationRunSummary, SkillIndexEntry, WikiDetail } from "../lib/api";
import ManagementSurfaces from "./ManagementSurfaces.vue";
import type { AutomationJobRecord, WikiFrontmatter } from "@samurai-agent/core-schemas";
import type { LocaleKey } from "@samurai-agent/localization";

type ViewMode = "chat" | "search" | "settings" | "runs" | "collections" | "memory" | "wiki" | "skills" | "automations";
type Label = (key: LocaleKey) => string;
type CaptureMode = SettingsRecord["memory_capture_mode"];
type ExternalProviderRole = SettingsRecord["external_provider_role"];

const props = defineProps<{
  viewMode: ViewMode;
  label: Label;
  searchQuery: string;
  searchResults: SearchResult[];
  runSearch: () => void | Promise<void>;
  chooseResult: (result: SearchResult) => void | Promise<void>;
  searchKindLabel: (kind: SearchResult["kind"]) => string;
  resultDisplayTitle: (result: SearchResult) => string;
  settings: SettingsRecord;
  supportedLocales: readonly SupportedLocale[];
  captureModes: CaptureMode[];
  externalProviderRoles: ExternalProviderRole[];
  patchSettings: (patch: Partial<Omit<SettingsRecord, "updated_at">>) => void | Promise<void>;
  localeDisplayName: (locale: SupportedLocale) => string;
  captureModeLabel: (mode: CaptureMode) => string;
  externalProviderRoleLabel: (role: ExternalProviderRole) => string;
  backendRuns: BackendRunRecord[];
  pendingLegacyApprovalCount: number;
  isBackendRunOpen: (id: string) => boolean;
  toggleBackendRun: (id: string) => void;
  backendLabel: (id: string, fallback?: string) => string;
  backendRunNote: (run: BackendRunRecord) => string;
  backendRunStatusLabel: (run: BackendRunRecord) => string;
  collectionListLoading: boolean;
  collectionListError: string | null;
  collectionSchemas: Array<CollectionSchema & { file_path: string }>;
  openCollectionApp: (schema: CollectionSchema & { file_path: string }) => void | Promise<void>;
  collectionSchemaTitle: (schema: CollectionSchema) => string;
  collectionSchemaRenderer: (schema: CollectionSchema) => string;
  memory: Array<MemoryFrontmatter & { file_path: string }>;
  activeMemory: MemoryDetail | null;
  activeSession: SessionRecord | null;
  memoryStateLabel: (state: MemoryFrontmatter["state"]) => string;
  memoryExcerpt: (id: string) => string;
  openMemory: (id: string) => void | Promise<void>;
  archiveMemoryItem: (id: string) => void | Promise<void>;
  managementLoading: boolean;
  managementError: string | null;
  wikiPages: Array<WikiFrontmatter & { file_path: string }>;
  wikiDetail: WikiDetail | null;
  wikiDiagnostics: Record<string, unknown> | null;
  skills: SkillIndexEntry[];
  skillDetail: { skill: SkillIndexEntry; markdown: string } | null;
  automationJobs: AutomationJobRecord[];
  automationRuns: AutomationRunSummary[];
  openWiki: (id: string) => void | Promise<void>;
  saveWiki: (id: string, input: { title: string; content: string }) => void | Promise<void>;
  archiveWiki: (id: string) => void | Promise<void>;
  reindexWiki: () => void | Promise<void>;
  openSkill: (id: string) => void | Promise<void>;
  saveSkill: (id: string, input: { title: string; description: string; content: string }) => void | Promise<void>;
  setSkillActive: (id: string, active: boolean) => void | Promise<void>;
  setAutomationStatus: (id: string, status: "enabled" | "disabled") => void | Promise<void>;
  useManagementResourceInChat: (kind: "wiki" | "skill" | "automation", id: string, title: string) => void;
}>();

const emit = defineEmits<{ "update:searchQuery": [value: string] }>();
</script>

<template>
  <section v-if="props.viewMode === 'search'" class="panel-stage">
    <form class="search-row lit-surface" @submit.prevent="props.runSearch">
      <Search :size="17" />
      <input :value="props.searchQuery" :placeholder="props.label('search.placeholder')" @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)" />
    </form>
    <div class="result-list">
      <div v-if="props.searchResults.length === 0" class="empty-note">{{ props.label("search.empty") }}</div>
      <button v-for="result in props.searchResults" :key="`${result.kind}-${result.id}`" class="result-item lit-surface" type="button" @click="props.chooseResult(result)">
        <span class="result-kind">{{ props.searchKindLabel(result.kind) }}</span>
        <strong>{{ props.resultDisplayTitle(result) }}</strong>
        <span>{{ result.summary }}</span>
      </button>
    </div>
  </section>

  <section v-else-if="props.viewMode === 'settings'" class="panel-stage settings-stage">
    <div class="settings-group lit-surface">
      <div class="settings-head">{{ props.label("settings.language") }}</div>
      <label>
        <span>{{ props.label("settings.ui_locale") }}</span>
        <select :value="props.settings.ui_locale" @change="props.patchSettings({ ui_locale: ($event.target as HTMLSelectElement).value as SupportedLocale })">
          <option v-for="locale in props.supportedLocales" :key="locale" :value="locale">{{ props.localeDisplayName(locale) }}</option>
        </select>
      </label>
      <label>
        <span>{{ props.label("settings.output_locale") }}</span>
        <select :value="props.settings.output_locale" @change="props.patchSettings({ output_locale: ($event.target as HTMLSelectElement).value as SupportedLocale })">
          <option v-for="locale in props.supportedLocales" :key="locale" :value="locale">{{ props.localeDisplayName(locale) }}</option>
        </select>
      </label>
    </div>
    <div class="settings-group lit-surface">
      <div class="settings-head">{{ props.label("settings.learning_memory") }}</div>
      <div v-for="policy in ([
        { key: 'memory_capture_mode', title: 'settings.memory_policy', description: 'settings.memory_policy_desc' },
        { key: 'knowledge_wiki_capture_mode', title: 'settings.wiki_policy', description: 'settings.wiki_policy_desc' },
        { key: 'skill_capture_mode', title: 'settings.skill_policy', description: 'settings.skill_policy_desc' }
      ] as const)" :key="policy.key" class="policy-setting">
        <div>
          <span>{{ props.label(policy.title) }}</span>
          <p>{{ props.label(policy.description) }}</p>
        </div>
        <div class="segmented-control" role="group" :aria-label="props.label(policy.title)">
          <button
            v-for="mode in props.captureModes"
            :key="mode"
            type="button"
            :class="{ 'is-active': props.settings[policy.key] === mode }"
            @click="props.patchSettings({ [policy.key]: mode })"
          >
            {{ props.captureModeLabel(mode) }}
          </button>
        </div>
      </div>
      <div class="policy-setting">
        <div>
          <span>{{ props.label("settings.external_provider_policy") }}</span>
          <p>{{ props.label("settings.external_provider_policy_desc") }}</p>
        </div>
        <div class="segmented-control" role="group" :aria-label="props.label('settings.external_provider_policy')">
          <button
            v-for="role in props.externalProviderRoles"
            :key="role"
            type="button"
            :class="{ 'is-active': props.settings.external_provider_role === role }"
            @click="props.patchSettings({ external_provider_role: role })"
          >
            {{ props.externalProviderRoleLabel(role) }}
          </button>
        </div>
      </div>
    </div>
  </section>

  <section v-else-if="props.viewMode === 'runs'" class="panel-stage">
    <div v-if="props.backendRuns.length === 0" class="empty-note">{{ props.label("run_history.empty") }}</div>
    <article v-for="run in props.backendRuns" :key="run.id" class="history-item">
      <button class="history-toggle" type="button" :aria-expanded="props.isBackendRunOpen(run.id)" @click="props.toggleBackendRun(run.id)">
        <ChevronRight class="history-chevron" :class="{ open: props.isBackendRunOpen(run.id) }" :size="15" />
        <Clock3 class="history-leading" :size="15" />
        <span class="history-main">
          <strong>{{ props.backendLabel(run.backend_id, run.backend_kind) }} / {{ props.backendRunStatusLabel(run) }}</strong>
          <small>{{ run.input_summary }}</small>
        </span>
      </button>
      <div v-if="props.isBackendRunOpen(run.id)" class="history-detail"><p>{{ props.backendRunNote(run) || props.backendRunStatusLabel(run) }}</p></div>
    </article>
    <article v-if="props.pendingLegacyApprovalCount > 0" class="audit-item lit-surface">
      <Clock3 :size="16" />
      <div><strong>{{ props.label("legacy_request.title") }}</strong><p>{{ props.pendingLegacyApprovalCount }}</p></div>
    </article>
  </section>

  <section v-else-if="props.viewMode === 'collections'" class="panel-stage collections-stage">
    <div v-if="props.collectionListLoading" class="empty-note">Collectionを読み込んでいます</div>
    <div v-else-if="props.collectionListError" class="empty-note">{{ props.collectionListError }}</div>
    <div v-else-if="props.collectionSchemas.length === 0" class="empty-note">Collectionはまだありません</div>
    <div v-else class="collection-list">
      <button v-for="schema in props.collectionSchemas" :key="schema.id" class="collection-list-item lit-surface" type="button" @click="props.openCollectionApp(schema)">
        <span class="codex-card-icon"><Table2 :size="18" /></span>
        <span class="collection-list-main">
          <strong>{{ props.collectionSchemaTitle(schema) }}</strong>
          <small>{{ schema.id }} ・ {{ schema.fields.length }} fields ・ {{ props.collectionSchemaRenderer(schema) }}</small>
        </span>
        <em>開く</em>
      </button>
    </div>
  </section>

  <ManagementSurfaces
    v-else-if="props.viewMode === 'wiki' || props.viewMode === 'skills' || props.viewMode === 'automations'"
    :mode="props.viewMode"
    :loading="props.managementLoading"
    :error="props.managementError"
    :wiki-pages="props.wikiPages"
    :wiki-detail="props.wikiDetail"
    :wiki-diagnostics="props.wikiDiagnostics"
    :skills="props.skills"
    :skill-detail="props.skillDetail"
    :automation-jobs="props.automationJobs"
    :automation-runs="props.automationRuns"
    :open-wiki="props.openWiki"
    :save-wiki="props.saveWiki"
    :archive-wiki="props.archiveWiki"
    :reindex-wiki="props.reindexWiki"
    :open-skill="props.openSkill"
    :save-skill="props.saveSkill"
    :set-skill-active="props.setSkillActive"
    :set-automation-status="props.setAutomationStatus"
    :use-in-chat="props.useManagementResourceInChat"
  />

  <section v-else class="panel-stage">
    <div v-if="props.memory.length === 0" class="empty-note">{{ props.label("memory.empty") }}</div>
    <article v-for="item in props.memory" :key="item.id" class="memory-item lit-surface">
      <span class="status-pill">{{ props.memoryStateLabel(item.state) }}</span>
      <strong>{{ item.topic }}</strong>
      <p>{{ props.memoryExcerpt(item.id) || item.source }}</p>
      <div class="memory-actions">
        <button type="button" @click="props.openMemory(item.id)"><Eye :size="14" />{{ props.label("memory.open") }}</button>
        <button v-if="props.activeSession" type="button" @click="props.archiveMemoryItem(item.id)"><Archive :size="14" />{{ props.label("memory.archive") }}</button>
      </div>
    </article>
    <article v-if="props.activeMemory" class="memory-detail lit-surface">
      <div class="drawer-card-head"><span>{{ props.activeMemory.memory.topic }}</span><span class="status-pill">{{ props.memoryStateLabel(props.activeMemory.memory.state) }}</span></div>
      <pre class="document-surface">{{ props.activeMemory.content }}</pre>
    </article>
  </section>
</template>
