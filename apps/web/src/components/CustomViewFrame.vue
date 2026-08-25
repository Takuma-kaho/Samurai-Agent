<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { JsonValue } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";

type CustomViewAction = {
  id: string;
  label: string;
  description?: string;
};

const props = defineProps<{
  spec: SurfaceRenderSpec;
  saving: boolean;
  runAction: (spec: SurfaceRenderSpec, action: CustomViewAction, payload?: Record<string, JsonValue>) => void | Promise<void>;
}>();

const frameRef = ref<HTMLIFrameElement | null>(null);

const customViewData = computed(() => {
  const value = props.spec.props.data;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
});

const customViewActions = computed<CustomViewAction[]>(() => {
  const actions = Array.isArray(props.spec.props.actions) ? props.spec.props.actions : [];
  return actions.flatMap((action) => {
    if (!isRecord(action) || typeof action.id !== "string" || typeof action.label !== "string") {
      return [];
    }
    return [{
      id: action.id,
      label: action.label,
      ...(typeof action.description === "string" ? { description: action.description } : {})
    }];
  });
});

const customViewSandbox = computed(() => isRecord(props.spec.props.sandbox) ? props.spec.props.sandbox : {});
const customViewCapability = computed(() => isRecord(props.spec.props.capability) ? props.spec.props.capability : {});

const allowedActionIds = computed(() => {
  const allowed = customViewCapability.value.allowed_actions;
  const actionIds = Array.isArray(allowed)
    ? allowed.filter((item): item is string => typeof item === "string")
    : customViewActions.value.map((action) => action.id);
  return new Set(actionIds);
});

const frameHtml = computed(() => {
  const srcdoc = customViewData.value.srcdoc;
  if (typeof srcdoc === "string" && srcdoc.trim()) {
    return srcdoc;
  }
  const html = customViewData.value.html;
  return typeof html === "string" && html.trim() ? html : "";
});

const frameSrcdoc = computed(() => frameHtml.value
  ? `${customViewCspMeta()}${customViewBootstrapScript()}${frameHtml.value}`
  : "");

const sandboxAttribute = computed(() => {
  const sandbox = customViewSandbox.value;
  const tokens: string[] = [];
  if (sandbox.allow_scripts !== false) {
    tokens.push("allow-scripts");
  }
  if (sandbox.allow_forms === true) {
    tokens.push("allow-forms");
  }
  // Custom View data can arrive from a signed HTTP response, but it is still
  // untrusted document content at this boundary. Never let a response opt
  // the iframe into the parent origin: that would expose browser credentials
  // and the Desktop bridge to HTML supplied by a remote or compromised
  // Workspace Server. The protocol field remains readable for compatibility,
  // but this renderer is deliberately fail-closed.
  return tokens.join(" ");
});

const payloadText = computed(() => JSON.stringify(props.spec.props.data ?? {}, null, 2));

function handleFrameMessage(event: MessageEvent) {
  if (!frameRef.value || event.source !== frameRef.value.contentWindow || !isRecord(event.data)) {
    return;
  }
  if (event.data.type !== "samurai.custom_view.action" || typeof event.data.action_id !== "string") {
    return;
  }
  const action = customViewActions.value.find((item) => item.id === event.data.action_id);
  if (!action || !allowedActionIds.value.has(action.id)) {
    return;
  }
  const payload = isRecord(event.data.payload) ? objectToJsonRecord(event.data.payload) : {};
  void props.runAction(props.spec, action, payload);
}

function customViewBootstrapScript(): string {
  const bootstrap = {
    view_id: props.spec.props.view_id,
    renderer: props.spec.props.renderer,
    data: props.spec.props.data ?? null,
    capability: Object.keys(customViewCapability.value).length > 0 ? customViewCapability.value : null,
    actions: customViewActions.value
  };
  return `<script>window.samuraiCustomView=${safeInlineJson(bootstrap)};window.dispatchSamuraiAction=function(actionId,payload){window.parent.postMessage({type:"samurai.custom_view.action",action_id:actionId,payload:payload||{}},"*")};<\/script>`;
}

function customViewCspMeta(): string {
  const networkAccess = customViewSandbox.value.network_access === "read"
    && customViewCapability.value.network_access === "read"
    ? "read"
    : "none";
  const networkSources = networkAccess === "read" ? "https: http:" : "'none'";
  const mediaSources = networkAccess === "read" ? "data: blob: https: http:" : "data: blob:";
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src ${mediaSources}; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${networkSources}; frame-src 'none'">`;
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value)).replace(/</g, "\\u003c");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

onMounted(() => {
  window.addEventListener("message", handleFrameMessage);
});

onUnmounted(() => {
  window.removeEventListener("message", handleFrameMessage);
});
</script>

<template>
  <div class="custom-view-frame">
    <iframe
      v-if="frameSrcdoc"
      ref="frameRef"
      class="custom-view-iframe"
      :title="props.spec.title || props.spec.props.view_id"
      :sandbox="sandboxAttribute"
      :srcdoc="frameSrcdoc"
    ></iframe>
    <pre v-else class="surface-json">{{ payloadText }}</pre>

    <div v-if="customViewActions.length > 0" class="surface-app-actions">
      <button
        v-for="action in customViewActions"
        :key="action.id"
        type="button"
        :title="action.description || action.label"
        :disabled="props.saving || !allowedActionIds.has(action.id)"
        @click="props.runAction(props.spec, action)"
      >
        {{ action.label }}
      </button>
    </div>
  </div>
</template>
