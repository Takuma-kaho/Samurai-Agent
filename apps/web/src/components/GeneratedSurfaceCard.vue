<script setup lang="ts">
import PanelsTopLeft from "lucide-vue-next/dist/esm/icons/panels-top-left.js";
import Pin from "lucide-vue-next/dist/esm/icons/pin.js";
import type { MessagePresentationRecord } from "@samurai-agent/core-schemas";

const props = defineProps<{
  presentation: MessagePresentationRecord;
  openLabel: string;
  pinSurface: (presentation: MessagePresentationRecord) => void | Promise<void>;
}>();

const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <article class="generated-surface-card">
    <button class="generated-surface-card-open" type="button" @click="emit('open')">
      <span class="codex-card-icon"><PanelsTopLeft :size="19" /></span>
      <span class="codex-card-main">
        <strong>{{ props.presentation.title }}</strong>
        <small>{{ props.presentation.subtitle || "独自UI" }}</small>
      </span>
      <em>{{ props.openLabel }}</em>
    </button>
    <button class="generated-surface-card-pin" type="button" title="ピン留め" aria-label="ピン留め" @click="props.pinSurface(props.presentation)">
      <Pin :size="14" />
    </button>
  </article>
</template>
