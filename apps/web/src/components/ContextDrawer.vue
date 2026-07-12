<script setup lang="ts">
import ChevronRight from "lucide-vue-next/dist/esm/icons/chevron-right.js";
import X from "lucide-vue-next/dist/esm/icons/x.js";
import type { BackendEventRecord, BackendRunRecord, MemoryFrontmatter } from "@samurai-agent/core-schemas";
import type { SurfaceRenderKind, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import type { LocaleKey } from "@samurai-agent/localization";

const props = defineProps<{
  open: boolean;
  label: (key: LocaleKey) => string;
  latestBackendRun?: BackendRunRecord;
  latestBackendEvents: BackendEventRecord[];
  lastSurfaceRenderSpec: SurfaceRenderSpec | null;
  memory: Array<MemoryFrontmatter & { file_path: string }>;
  firstMemory?: MemoryFrontmatter & { file_path: string };
  backendRunContextSummary: (run: BackendRunRecord | undefined) => string;
  surfaceRendererLabel: (kind?: SurfaceRenderKind) => string;
  isBackendEventOpen: (id: string) => boolean;
  toggleBackendEvent: (id: string) => void;
  backendEventSummary: (event: BackendEventRecord) => string;
  backendEventPayload: (event: BackendEventRecord) => string;
  memoryExcerpt: (id: string) => string;
  memoryStateLabel: (state: MemoryFrontmatter["state"]) => string;
  openMemory: (id: string) => void | Promise<void>;
}>();

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <aside class="context-drawer" :class="{ open: props.open }" :aria-hidden="!props.open">
    <header class="drawer-header">
      <div class="drawer-title">{{ props.label("context.title") }}</div>
      <button class="icon-button" type="button" :title="props.label('action.close')" :aria-label="props.label('action.close')" @click="emit('close')">
        <X :size="16" />
      </button>
    </header>

    <section class="drawer-card lit-surface">
      <div class="drawer-card-head"><span>今回渡した文脈</span><span class="status-pill">{{ props.latestBackendRun?.status ?? "idle" }}</span></div>
      <p>{{ props.backendRunContextSummary(props.latestBackendRun) }}</p>
    </section>

    <section class="drawer-card lit-surface">
      <div class="drawer-card-head">
        <span>{{ props.label("backend_event.title") }}</span>
        <span class="drawer-card-badges">
          <span v-if="props.lastSurfaceRenderSpec" class="surface-chip is-compact">{{ props.surfaceRendererLabel(props.lastSurfaceRenderSpec.kind) }}</span>
          <span class="status-pill">{{ props.latestBackendEvents.length }}</span>
        </span>
      </div>
      <p v-if="props.latestBackendEvents.length === 0">{{ props.label("backend_event.empty") }}</p>
      <ol v-else class="activity-list">
        <li v-for="item in props.latestBackendEvents" :key="item.id" class="history-item drawer-history-item">
          <button class="history-toggle" type="button" :aria-expanded="props.isBackendEventOpen(item.id)" @click="props.toggleBackendEvent(item.id)">
            <ChevronRight class="history-chevron" :class="{ open: props.isBackendEventOpen(item.id) }" :size="15" />
            <span class="history-index">#{{ item.sequence }}</span>
            <span class="history-main"><strong>{{ item.event_type }}</strong><small>{{ props.backendEventSummary(item) }}</small></span>
          </button>
          <pre v-if="props.isBackendEventOpen(item.id)" class="event-payload">{{ props.backendEventPayload(item) }}</pre>
        </li>
      </ol>
    </section>

    <section class="drawer-card lit-surface">
      <div class="drawer-card-head"><span>{{ props.label("memory.title") }}</span><span class="status-pill">{{ props.memory.length }}</span></div>
      <p v-if="!props.firstMemory">{{ props.label("memory.empty") }}</p>
      <div v-else class="drawer-memory">
        <strong>{{ props.firstMemory.topic }}</strong>
        <p>{{ props.memoryExcerpt(props.firstMemory.id) || props.memoryStateLabel(props.firstMemory.state) }}</p>
        <button type="button" @click="props.openMemory(props.firstMemory.id)">{{ props.label("memory.open") }}</button>
      </div>
    </section>
  </aside>
</template>
