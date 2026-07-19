import { computed, ref, type Ref } from "vue";

const workspaceSplitStorageKey = "samurai-agent.workspace-split-percent";
const sidebarWidthStorageKey = "samurai-agent.sidebar-width";
const workspaceSplitMin = 32;
const workspaceSplitMax = 68;
const workspaceSplitDefault = 50;
const sidebarWidthMin = 204;
const sidebarWidthMax = 340;
const sidebarWidthDefault = 244;
const sidebarCollapseDragThreshold = 84;

export function useResizableLayout(input: {
  chatLayoutRef: Ref<HTMLDivElement | null>;
  hasWorkspaceCanvas: Readonly<Ref<boolean>>;
  sidebarCollapsed: Ref<boolean>;
}) {
  const workspaceSplitPercent = ref(readWorkspaceSplitPercent());
  const isResizingWorkspace = ref(false);
  const sidebarWidth = ref(readSidebarWidth());
  const isResizingSidebar = ref(false);
  const workspaceSplitStyle = computed<Record<string, string>>(() => ({
    "--workspace-chat-percent": `${workspaceSplitPercent.value}%`,
    "--workspace-canvas-percent": `${100 - workspaceSplitPercent.value}%`
  }));
  const appShellStyle = computed<Record<string, string>>(() => ({
    "--sidebar-width": `${sidebarWidth.value}px`
  }));
  let previousBodyCursor = "";
  let previousBodyUserSelect = "";

  function beginSidebarResize(event: PointerEvent) {
    if (input.sidebarCollapsed.value) return;
    event.preventDefault();
    isResizingSidebar.value = true;
    rememberBodyInteractionStyle();
    updateSidebarWidthFromPointer(event);
    if (!isResizingSidebar.value) return;
    window.addEventListener("pointermove", handleSidebarResizeMove);
    window.addEventListener("pointerup", finishSidebarResize);
    window.addEventListener("pointercancel", finishSidebarResize);
  }

  function handleSidebarResizeMove(event: PointerEvent) {
    if (!isResizingSidebar.value) return;
    event.preventDefault();
    updateSidebarWidthFromPointer(event);
  }

  function updateSidebarWidthFromPointer(event: PointerEvent) {
    if (event.clientX <= sidebarCollapseDragThreshold) {
      input.sidebarCollapsed.value = true;
      finishSidebarResize();
      return;
    }
    setSidebarWidth(event.clientX);
  }

  function finishSidebarResize() {
    if (!isResizingSidebar.value) return;
    isResizingSidebar.value = false;
    restoreBodyInteractionStyle();
    window.removeEventListener("pointermove", handleSidebarResizeMove);
    window.removeEventListener("pointerup", finishSidebarResize);
    window.removeEventListener("pointercancel", finishSidebarResize);
    persistSidebarWidth(sidebarWidth.value);
  }

  function handleSidebarResizerKeydown(event: KeyboardEvent) {
    if (input.sidebarCollapsed.value) return;
    if (event.key === "ArrowLeft") setSidebarWidthFromKeyboard(event, sidebarWidth.value - 12);
    else if (event.key === "ArrowRight") setSidebarWidthFromKeyboard(event, sidebarWidth.value + 12);
    else if (event.key === "Home") setSidebarWidthFromKeyboard(event, sidebarWidthMin);
    else if (event.key === "End") setSidebarWidthFromKeyboard(event, sidebarWidthMax);
    else if (event.key === "Enter" || event.key === " ") setSidebarWidthFromKeyboard(event, sidebarWidthDefault);
  }

  function setSidebarWidthFromKeyboard(event: KeyboardEvent, value: number) {
    event.preventDefault();
    setSidebarWidth(value, true);
  }

  function setSidebarWidth(value: number, persist = false) {
    sidebarWidth.value = normalizeSidebarWidth(value);
    if (persist) persistSidebarWidth(sidebarWidth.value);
  }

  function beginWorkspaceResize(event: PointerEvent) {
    if (!input.hasWorkspaceCanvas.value || !input.chatLayoutRef.value) return;
    event.preventDefault();
    isResizingWorkspace.value = true;
    rememberBodyInteractionStyle();
    updateWorkspaceSplitFromPointer(event);
    window.addEventListener("pointermove", handleWorkspaceResizeMove);
    window.addEventListener("pointerup", finishWorkspaceResize);
    window.addEventListener("pointercancel", finishWorkspaceResize);
  }

  function handleWorkspaceResizeMove(event: PointerEvent) {
    if (!isResizingWorkspace.value) return;
    event.preventDefault();
    updateWorkspaceSplitFromPointer(event);
  }

  function updateWorkspaceSplitFromPointer(event: PointerEvent) {
    const rect = input.chatLayoutRef.value?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setWorkspaceSplitPercent(((event.clientX - rect.left) / rect.width) * 100);
  }

  function finishWorkspaceResize() {
    if (!isResizingWorkspace.value) return;
    isResizingWorkspace.value = false;
    restoreBodyInteractionStyle();
    window.removeEventListener("pointermove", handleWorkspaceResizeMove);
    window.removeEventListener("pointerup", finishWorkspaceResize);
    window.removeEventListener("pointercancel", finishWorkspaceResize);
    persistWorkspaceSplitPercent(workspaceSplitPercent.value);
  }

  function handleWorkspaceResizerKeydown(event: KeyboardEvent) {
    if (!input.hasWorkspaceCanvas.value) return;
    if (event.key === "ArrowLeft") setWorkspaceSplitFromKeyboard(event, workspaceSplitPercent.value - 4);
    else if (event.key === "ArrowRight") setWorkspaceSplitFromKeyboard(event, workspaceSplitPercent.value + 4);
    else if (event.key === "Home") setWorkspaceSplitFromKeyboard(event, workspaceSplitMin);
    else if (event.key === "End") setWorkspaceSplitFromKeyboard(event, workspaceSplitMax);
    else if (event.key === "Enter" || event.key === " ") setWorkspaceSplitFromKeyboard(event, workspaceSplitDefault);
  }

  function setWorkspaceSplitFromKeyboard(event: KeyboardEvent, value: number) {
    event.preventDefault();
    setWorkspaceSplitPercent(value, true);
  }

  function setWorkspaceSplitPercent(value: number, persist = false) {
    workspaceSplitPercent.value = normalizeWorkspaceSplitPercent(value);
    if (persist) persistWorkspaceSplitPercent(workspaceSplitPercent.value);
  }

  function rememberBodyInteractionStyle() {
    previousBodyCursor = document.body.style.cursor;
    previousBodyUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function restoreBodyInteractionStyle() {
    document.body.style.cursor = previousBodyCursor;
    document.body.style.userSelect = previousBodyUserSelect;
  }

  return {
    appShellStyle,
    beginSidebarResize,
    beginWorkspaceResize,
    finishSidebarResize,
    finishWorkspaceResize,
    handleSidebarResizerKeydown,
    handleWorkspaceResizerKeydown,
    isResizingSidebar,
    isResizingWorkspace,
    sidebarWidthMin,
    sidebarWidthMax,
    sidebarWidth,
    workspaceSplitMin,
    workspaceSplitMax,
    workspaceSplitPercent,
    workspaceSplitStyle
  };
}

function readSidebarWidth(): number {
  return readStoredNumber(sidebarWidthStorageKey, sidebarWidthDefault, normalizeSidebarWidth);
}

function normalizeSidebarWidth(value: number): number {
  const normalized = Number.isFinite(value) ? value : sidebarWidthDefault;
  return Math.min(sidebarWidthMax, Math.max(sidebarWidthMin, Math.round(normalized)));
}

function persistSidebarWidth(value: number) {
  persistNumber(sidebarWidthStorageKey, value);
}

function readWorkspaceSplitPercent(): number {
  return readStoredNumber(workspaceSplitStorageKey, workspaceSplitDefault, normalizeWorkspaceSplitPercent);
}

function normalizeWorkspaceSplitPercent(value: number): number {
  const normalized = Number.isFinite(value) ? value : workspaceSplitDefault;
  return Math.min(workspaceSplitMax, Math.max(workspaceSplitMin, Math.round(normalized * 10) / 10));
}

function persistWorkspaceSplitPercent(value: number) {
  persistNumber(workspaceSplitStorageKey, value);
}

function readStoredNumber(key: string, fallback: number, normalize: (value: number) => number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? normalize(Number(stored)) : fallback;
  } catch {
    return fallback;
  }
}

function persistNumber(key: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // localStorage can be unavailable in private/restricted contexts.
  }
}
