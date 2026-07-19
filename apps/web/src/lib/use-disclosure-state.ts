import { ref } from "vue";

export function useDisclosureState() {
  const openBackendEventIds = ref<Set<string>>(new Set());
  const openBackendRunIds = ref<Set<string>>(new Set());
  const isBackendEventOpen = (id: string) => openBackendEventIds.value.has(id);
  const isBackendRunOpen = (id: string) => openBackendRunIds.value.has(id);
  const toggleBackendEvent = (id: string) => { openBackendEventIds.value = toggled(openBackendEventIds.value, id); };
  const toggleBackendRun = (id: string) => { openBackendRunIds.value = toggled(openBackendRunIds.value, id); };
  return { isBackendEventOpen, isBackendRunOpen, toggleBackendEvent, toggleBackendRun };
}

function toggled(values: Set<string>, id: string): Set<string> {
  const next = new Set(values);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
