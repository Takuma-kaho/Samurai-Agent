import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

export const nativeArtifactPanelWidthStorageKey = "samurai.native.artifact-panel-width.v1";
export const nativeArtifactPanelWidthDefault = 410;
export const nativeArtifactPanelWidthMin = 260;
export const nativeArtifactPanelWidthMax = 720;
export const nativeArtifactPanelChatMinWidth = 280;
export const nativeArtifactPanelSplitMinWidth = nativeArtifactPanelWidthMin + nativeArtifactPanelChatMinWidth;

export function clampNativeArtifactPanelWidth(value: number, availableWidth?: number): number {
  const preferred = Number.isFinite(value) ? Math.round(value) : nativeArtifactPanelWidthDefault;
  if (!Number.isFinite(availableWidth) || availableWidth === undefined || availableWidth <= 0) {
    return Math.min(nativeArtifactPanelWidthMax, Math.max(nativeArtifactPanelWidthMin, preferred));
  }
  const maximum = Math.min(nativeArtifactPanelWidthMax, Math.floor(availableWidth - nativeArtifactPanelChatMinWidth));
  if (maximum < nativeArtifactPanelWidthMin) return Math.max(0, Math.min(preferred, maximum));
  return Math.min(maximum, Math.max(nativeArtifactPanelWidthMin, preferred));
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
  pointerId: number;
  startX: number;
  startWidth: number;
};

export function useNativeArtifactPanelWidth(containerRef: RefObject<HTMLElement | null>, onClose?: () => void) {
  const [preferredWidth, setPreferredWidthState] = useState(readNativeArtifactPanelWidth);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<ResizeState | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
      const normalized = clampNativeArtifactPanelWidth(raw);
      writeNativeArtifactPanelWidth(normalized);
      return normalized;
    });
  }, []);

  const resetWidth = useCallback((): void => setPreferredWidth(nativeArtifactPanelWidthDefault), [setPreferredWidth]);
  const isTooNarrow = availableWidth > 0 && availableWidth < nativeArtifactPanelSplitMinWidth;
  const maxWidth = availableWidth > 0
    ? Math.max(nativeArtifactPanelWidthMin, Math.min(nativeArtifactPanelWidthMax, Math.floor(availableWidth - nativeArtifactPanelChatMinWidth)))
    : nativeArtifactPanelWidthMax;
  const width = isTooNarrow
    ? nativeArtifactPanelWidthMin
    : clampNativeArtifactPanelWidth(preferredWidth, availableWidth);

  const onPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStateRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  }, [width]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPreferredWidth(width + 10);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const nextWidth = width - 10;
      if (nextWidth < nativeArtifactPanelWidthMin) {
        onCloseRef.current?.();
      } else {
        setPreferredWidth(nextWidth);
      }
    } else if (event.key === "Home") {
      event.preventDefault();
      setPreferredWidth(nativeArtifactPanelWidthMin);
    } else if (event.key === "End") {
      event.preventDefault();
      setPreferredWidth(nativeArtifactPanelWidthMax);
    } else if (event.key === "Enter") {
      event.preventDefault();
      resetWidth();
    }
  }, [resetWidth, setPreferredWidth, width]);

  useEffect(() => {
    if (!isResizing) return undefined;
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const finishResize = (event?: globalThis.PointerEvent): void => {
      const state = resizeStateRef.current;
      if (!state || (event && event.pointerId !== state.pointerId)) return;
      resizeStateRef.current = undefined;
      setIsResizing(false);
    };
    const onPointerMove = (event: globalThis.PointerEvent): void => {
      const state = resizeStateRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      const nextWidth = state.startWidth + state.startX - event.clientX;
      if (nextWidth < nativeArtifactPanelWidthMin) {
        resizeStateRef.current = undefined;
        setIsResizing(false);
        onCloseRef.current?.();
        return;
      }
      setPreferredWidth(nextWidth);
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
    onPointerDown,
    onKeyDown
  };
}
