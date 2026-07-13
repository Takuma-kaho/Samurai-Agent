<script setup lang="ts">
import PanelLeft from "lucide-vue-next/dist/esm/icons/panel-left.js";
import Plus from "lucide-vue-next/dist/esm/icons/plus.js";
import Search from "lucide-vue-next/dist/esm/icons/search.js";
import Settings from "lucide-vue-next/dist/esm/icons/settings.js";
import type { SessionRecord } from "@samurai-agent/core-schemas";
import type { LocaleKey } from "@samurai-agent/localization";

type ViewMode = "chat" | "search" | "settings" | "runs" | "memory" | "collections" | "wiki" | "skills" | "automations";

const props = defineProps<{
  collapsed: boolean;
  viewMode: ViewMode;
  isDraftChat: boolean;
  initializing: boolean;
  sessionLoadError: boolean;
  sessions: SessionRecord[];
  activeSession: SessionRecord | null;
  sidebarWidth: number;
  sidebarWidthMin: number;
  sidebarWidthMax: number;
  label: (key: LocaleKey) => string;
  startDraftChat: () => void;
  loadSessionsWithRetry: () => void | Promise<void>;
  sessionDisplayTitle: (session: SessionRecord) => string;
  openSession: (id: string) => void | Promise<void>;
  openSettings: () => void;
  beginSidebarResize: (event: PointerEvent) => void;
  handleSidebarResizerKeydown: (event: KeyboardEvent) => void;
}>();

const emit = defineEmits<{ "update:collapsed": [value: boolean]; search: [] }>();
</script>

<template>
  <aside class="sidebar">
    <div class="brand-row">
      <button class="sidebar-toggle icon-button" type="button" :title="props.collapsed ? props.label('nav.expand_sidebar') : props.label('nav.collapse_sidebar')" :aria-label="props.collapsed ? props.label('nav.expand_sidebar') : props.label('nav.collapse_sidebar')" @click="emit('update:collapsed', !props.collapsed)">
        <PanelLeft :size="16" />
      </button>
    </div>

    <nav class="nav-block">
      <button class="nav-item" :class="{ 'is-active': props.isDraftChat }" type="button" :title="props.label('nav.new_chat')" :aria-label="props.label('nav.new_chat')" @click="props.startDraftChat">
        <Plus :size="16" /><span>{{ props.label("nav.new_chat") }}</span>
      </button>
      <button class="nav-item" :class="{ 'is-active': props.viewMode === 'search' }" type="button" :title="props.label('nav.search')" :aria-label="props.label('nav.search')" @click="emit('search')">
        <Search :size="16" /><span>{{ props.label("nav.search") }}</span>
      </button>
    </nav>

    <section class="session-list" :aria-label="props.label('nav.sessions')">
      <div class="section-label">{{ props.label("nav.sessions") }}</div>
      <div v-if="props.initializing" class="session-state"><span class="state-pulse" aria-hidden="true"></span><span>{{ props.label("session.loading") }}</span></div>
      <div v-else-if="props.sessionLoadError" class="session-state is-error"><span>{{ props.label("session.load_failed") }}</span><button type="button" @click="props.loadSessionsWithRetry">{{ props.label("session.reload") }}</button></div>
      <button v-for="session in props.sessions" :key="session.id" class="session-item" :class="{ 'is-current': props.viewMode === 'chat' && props.activeSession?.id === session.id }" type="button" :title="props.sessionDisplayTitle(session)" @click="props.openSession(session.id)">
        <span>{{ props.sessionDisplayTitle(session) }}</span>
      </button>
    </section>

    <div class="sidebar-footer">
      <button class="nav-item footer-button" :class="{ 'is-active': props.viewMode === 'settings' }" type="button" :title="props.label('nav.settings')" :aria-label="props.label('nav.settings')" @click="props.openSettings">
        <Settings :size="16" /><span>{{ props.label("nav.settings") }}</span>
      </button>
    </div>

    <button class="sidebar-resizer" type="button" role="separator" aria-orientation="vertical" :aria-label="props.label('nav.resize_sidebar')" :aria-valuemin="props.sidebarWidthMin" :aria-valuemax="props.sidebarWidthMax" :aria-valuenow="props.sidebarWidth" :aria-hidden="props.collapsed" :disabled="props.collapsed" :tabindex="props.collapsed ? -1 : 0" @pointerdown="props.beginSidebarResize" @keydown="props.handleSidebarResizerKeydown" />
  </aside>
</template>
