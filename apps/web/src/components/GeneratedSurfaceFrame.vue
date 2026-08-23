<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { JsonValue } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";

type GeneratedAction = { id: string; label: string; description?: string; requires_confirmation?: boolean };

const props = defineProps<{
  spec: SurfaceRenderSpec;
  saving: boolean;
  runAction: (spec: SurfaceRenderSpec, action: GeneratedAction, payload?: Record<string, JsonValue>) => void | Promise<void>;
  pinSurface: (spec: SurfaceRenderSpec) => void | Promise<void>;
  reviseSurface: (spec: SurfaceRenderSpec) => void | Promise<void>;
  exportSurface: (spec: SurfaceRenderSpec, format: "html" | "zip") => void | Promise<void>;
}>();

const frameRef = ref<HTMLIFrameElement | null>(null);
const previewUrl = computed(() => typeof props.spec.props.preview_url === "string" ? props.spec.props.preview_url : "");
const srcdoc = computed(() => typeof props.spec.props.srcdoc === "string" ? props.spec.props.srcdoc : "");
const actions = computed<GeneratedAction[]>(() => {
  const value = props.spec.props.actions;
  return Array.isArray(value)
    ? value.flatMap((item) => {
        if (!isRecord(item) || typeof item.id !== "string" || typeof item.label !== "string") return [];
        return [{
          id: item.id,
          label: item.label,
          ...(typeof item.description === "string" ? { description: item.description } : {}),
          ...(item.requires_confirmation === true ? { requires_confirmation: true } : {})
        }];
      })
    : [];
});
const actionIds = computed(() => new Set(actions.value.map((action) => action.id)));

function handleMessage(event: MessageEvent) {
  if (!frameRef.value || event.source !== frameRef.value.contentWindow || !isRecord(event.data)) return;
  if (event.data.type !== "samurai.generated_surface.action" || typeof event.data.action_id !== "string") return;
  if (!actionIds.value.has(event.data.action_id)) return;
  const action = actions.value.find((item) => item.id === event.data.action_id);
  if (!action) return;
  // An iframe message is never an explicit human confirmation. Dangerous
  // actions remain available through the visible button below.
  if (action.requires_confirmation === true) return;
  const payload = isRecord(event.data.payload) ? toJsonRecord(event.data.payload) : {};
  void props.runAction(props.spec, action, payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  return isRecord(value) ? toJsonRecord(value) : String(value);
}

onMounted(() => window.addEventListener("message", handleMessage));
onUnmounted(() => window.removeEventListener("message", handleMessage));
</script>

<template>
  <div class="generated-surface-frame">
    <div class="generated-surface-toolbar">
      <span class="surface-chip is-compact">独自UI</span>
      <span class="generated-surface-revision">revision {{ props.spec.props.revision_id || "-" }}</span>
      <span class="generated-surface-toolbar-spacer"></span>
      <button type="button" :disabled="props.saving" @click="props.pinSurface(props.spec)">ピン留め</button>
      <button type="button" :disabled="props.saving" @click="props.reviseSurface(props.spec)">チャットで修正</button>
      <button type="button" :disabled="props.saving" @click="props.exportSurface(props.spec, 'html')">HTML</button>
      <button type="button" :disabled="props.saving" @click="props.exportSurface(props.spec, 'zip')">ZIP</button>
    </div>
    <iframe
      v-if="srcdoc || previewUrl"
      ref="frameRef"
      class="generated-surface-iframe"
      :src="srcdoc ? undefined : previewUrl"
      :srcdoc="srcdoc || undefined"
      sandbox="allow-scripts"
      title="生成された独自UI"
    ></iframe>
    <div v-else class="generated-surface-empty">表示URLがありません。文章またはArtifact表示に戻してください。</div>
    <div v-if="actions.length > 0" class="generated-surface-actions">
      <button v-for="action in actions" :key="action.id" type="button" :disabled="props.saving" :title="action.description" @click="props.runAction(props.spec, action)">
        {{ action.label }}
      </button>
    </div>
  </div>
</template>
