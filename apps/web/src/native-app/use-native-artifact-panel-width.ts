import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

export const nativeArtifactPanelWidthStorageKey = "samurai.native.artifact-panel-width.v1";
export const nativeArtifactPanelWidthDefault = 410;
export const nativeArtifactPanelWidthMin = 260;
export const nativeArtifactPanelChatMinWidth = 280;
export const nativeArtifactPanelSplitMinWidth = nativeArtifactPanelWidthMin + nativeArtifactPanelChatMinWidth;

export type NativeArtifactPanelWidthTransition =
  | { kind: "close" }
  | { kind: "expand"; restoreWidth: number }
  | { kind: "split"; width: number };

export function nativeArtifactPanelSplitMaxWidth(availableWidth?: number): number | undefined {
  if (availableWidth === undefined || !Number.isFinite(availableWidth) || availableWidth <= 0) return undefined;
  return Math.floor(availableWidth - nativeArtifactPanelChatMinWidth);
}

export function clampNativeArtifactPanelWidth(value: number, availableWidth?: number): number {
  const preferred = Number.isFinite(value) ? Math.round(value) : nativeArtifactPanelWidthDefault;
  const maximum = nativeArtifactPanelSplitMaxWidth(availableWidth);
  if (maximum === undefined) return Math.max(nativeArtifactPanelWidthMin, preferred);
  if (maximum < nativeArtifactPanelWidthMin) return Math.max(0, Math.min(preferred, maximum));
  return Math.min(maximum, Math.max(nativeArtifactPanelWidthMin, preferred));
}

export function nativeArtifactPanelWidthTransition(currentWidth: number, nextWidth: number, availableWidth?: number): NativeArtifactPanelWidthTransition {
  const current = clampNativeArtifactPanelWidth(currentWidth, availableWidth);
  const proposed = Number.isFinite(nextWidth) ? Math.round(nextWidth) : current;
  if (proposed < nativeArtifactPanelWidthMin) return { kind: "close" };
  const maximum = nativeArtifactPanelSplitMaxWidth(availableWidth);
  if (maximum !== undefined && maximum < nativeArtifactPanelWidthMin) {
    return { kind: "split", width: clampNativeArtifactPanelWidth(proposed) };
  }
  if (maximum !== undefined && maximum >= nativeArtifactPanelWidthMin && proposed > maximum) {
    return { kind: "expand", restoreWidth: current };
  }
  return { kind: "split", width: clampNativeArtifactPanelWidth(proposed, availableWidth) };
}

export function normalizeNativeArtifactPanelWidth(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return nativeArtifactPanelWidthDefault;
  const parsed = typeof value === "number" ? value : Number(value);
  return clampNativeArtifactPanelWidth(parsed);
}

function readNativeArtifactPanelWidth(): number {
  if (typeof window === "undefined") return nativeArtifactPanelWidthDefault;
  try {
    return normalizeNativeArtifactPanelWidth(window.localStorage.getItem(nativeArtifactPanelWidthStorageKey));
  } catch {
    return nativeArtifactPanelWidthDefault;
  }
}

function writeNativeArtifactPanelWidth(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(nativeArtifactPanelWidthStorageKey, String(value));
  } catch {
    // Storage failure must not disable resizing in the current view.
  }
}

type ResizeState = {
  handle: HTMLButtonElement;
  lastSplitWidth: number;
  pointerId: number;
  startX: number;
  startWidth: number;
};

export function useNativeArtifactPanelWidth(
  containerRef: RefObject<HTMLElement | null>,
  onClose?: () => void,
  onExpand?: (restoreWidth: number) => void
) {
  const [preferredWidth, setPreferredWidthState] = useState(readNativeArtifactPanelWidth);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<ResizeState | undefined>(undefined);
  const availableWidthRef = useRef(0);
  const widthRef = useRef(nativeArtifactPanelWidthDefault);
  const maxWidthRef = useRef(nativeArtifactPanelWidthDefault);
  const onCloseRef = useRef(onClose);
  const onExpandRef = useRef(onExpand);
  onCloseRef.current = onClose;
  onExpandRef.current = onExpand;
  availableWidthRef.current = availableWidth;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const update = (width: number): void => setAvailableWidth(Math.max(0, Math.round(width)));
    update(element.getBoundingClientRect().width || element.clientWidth);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  const setPreferredWidth = useCallback((next: number | ((current: number) => number)): void => {
    setPreferredWidthState((current) => {
      const raw = typeof next === "function" ? next(current) : next;
      const available = availableWidthRef.current;
      const normalized = available > 0 && available < nativeArtifactPanelSplitMinWidth
        ? clampNativeArtifactPanelWidth(raw)
        : clampNativeArtifactPanelWidth(raw, available);
      writeNativeArtifactPanelWidth(normalized);
      return normalized;
    });
  }, []);

  const resetWidth = useCallback((): void => setPreferredWidth(nativeArtifactPanelWidthDefault), [setPreferredWidth]);
  const isTooNarrow = availableWidth > 0 && availableWidth < nativeArtifactPanelSplitMinWidth;
  const splitMaxWidth = nativeArtifactPanelSplitMaxWidth(availableWidth);
  const width = isTooNarrow
    ? nativeArtifactPanelWidthMin
    : clampNativeArtifactPanelWidth(preferredWidth, availableWidth);
  const maxWidth = availableWidth > 0
    ? Math.max(nativeArtifactPanelWidthMin, splitMaxWidth ?? nativeArtifactPanelWidthMin)
    : Math.max(nativeArtifactPanelWidthDefault, width);
  widthRef.current = width;
  maxWidthRef.current = maxWidth;

  const onPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStateRef.current = { handle: event.currentTarget, lastSplitWidth: widthRef.current, pointerId: event.pointerId, startX: event.clientX, startWidth: widthRef.current };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const transition = nativeArtifactPanelWidthTransition(widthRef.current, widthRef.current + 10, availableWidthRef.current);
      if (transition.kind === "expand") onExpandRef.current?.(transition.restoreWidth);
      else if (transition.kind === "split") setPreferredWidth(transition.width);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const transition = nativeArtifactPanelWidthTransition(widthRef.current, widthRef.current - 10, availableWidthRef.current);
      if (transition.kind === "close") onCloseRef.current?.();
      else if (transition.kind === "split") setPreferredWidth(transition.width);
    } else if (event.key === "Home") {
      event.preventDefault();
      setPreferredWidth(nativeArtifactPanelWidthMin);
    } else if (event.key === "End") {
      event.preventDefault();
      setPreferredWidth(maxWidthRef.current);
    } else if (event.key === "Enter") {
      event.preventDefault();
      resetWidth();
    }
  }, [resetWidth, setPreferredWidth]);

  useEffect(() => {
    if (!isResizing) return undefined;
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const finishResize = (event?: globalThis.PointerEvent): void => {
      const state = resizeStateRef.current;
      if (!state || (event && event.pointerId !== state.pointerId)) return;
      if (state.handle.hasPointerCapture?.(state.pointerId)) state.handle.releasePointerCapture?.(state.pointerId);
      resizeStateRef.current = undefined;
      setIsResizing(false);
    };
    const onPointerMove = (event: globalThis.PointerEvent): void => {
      const state = resizeStateRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      const nextWidth = state.startWidth + state.startX - event.clientX;
      const transition = nativeArtifactPanelWidthTransition(state.lastSplitWidth, nextWidth, availableWidthRef.current);
      if (transition.kind === "close") {
        finishResize(event);
        onCloseRef.current?.();
        return;
      }
      if (transition.kind === "expand") {
        finishResize(event);
        onExpandRef.current?.(transition.restoreWidth);
        return;
      }
      state.lastSplitWidth = transition.width;
      setPreferredWidth(transition.width);
    };
    const onBlur = (): void => finishResize();
    document.documentElement.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    window.addEventListener("blur", onBlur);
    return () => {
      resizeStateRef.current = undefined;
      document.documentElement.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("blur", onBlur);
    };
  }, [isResizing, setPreferredWidth]);

  return {
    width,
    preferredWidth,
    minWidth: nativeArtifactPanelWidthMin,
    maxWidth,
    isTooNarrow,
    isResizing,
    resetWidth,
    setWidth: setPreferredWidth,
    onPointerDown,
    onKeyDown
  };
}
