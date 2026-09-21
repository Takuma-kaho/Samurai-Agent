import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { nativePanelEdgeTransition, nativePanelWidthTransition } from "./native-panel-width";

export const nativeSidebarWidthStorageKey = "samurai.native.sidebar-width.v1";
export const nativeSidebarWidthDefault = 300;
export const nativeSidebarWidthMin = 220;
export const nativeSidebarWidthMax = 420;
export const nativeSidebarCloseDragDistance = 110;

export function clampNativeSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return nativeSidebarWidthDefault;
  return Math.round(Math.min(nativeSidebarWidthMax, Math.max(nativeSidebarWidthMin, value)));
}

export function normalizeNativeSidebarWidth(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return nativeSidebarWidthDefault;
  const parsed = typeof value === "number" ? value : Number(value);
  return clampNativeSidebarWidth(parsed);
}

function readNativeSidebarWidth(): number {
  if (typeof window === "undefined") return nativeSidebarWidthDefault;
  try {
    return normalizeNativeSidebarWidth(window.localStorage.getItem(nativeSidebarWidthStorageKey));
  } catch {
    return nativeSidebarWidthDefault;
  }
}

function writeNativeSidebarWidth(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(nativeSidebarWidthStorageKey, String(value));
  } catch {
    // A private or full storage must not prevent resizing the current view.
  }
}

type ResizeState = {
  handle?: HTMLButtonElement;
  pointerId: number;
  startX: number;
  startWidth: number;
  mode: "closed" | "split";
};

export function useNativeSidebarWidth(onClose?: () => void, onOpen?: () => void) {
  const [width, setWidthState] = useState(readNativeSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<ResizeState | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  const onOpenRef = useRef(onOpen);
  onCloseRef.current = onClose;
  onOpenRef.current = onOpen;

  const setWidth = useCallback((next: number | ((current: number) => number)): void => {
    setWidthState((current) => {
      const normalized = clampNativeSidebarWidth(typeof next === "function" ? next(current) : next);
      writeNativeSidebarWidth(normalized);
      return normalized;
    });
  }, []);

  const resetWidth = useCallback((): void => setWidth(nativeSidebarWidthDefault), [setWidth]);
  const cancelResize = useCallback((): void => {
    const state = resizeStateRef.current;
    if (state?.handle?.hasPointerCapture?.(state.pointerId)) state.handle.releasePointerCapture?.(state.pointerId);
    resizeStateRef.current = undefined;
    setIsResizing(false);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStateRef.current = {
      handle: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      mode: "split"
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  }, [width]);

  const onClosedPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStateRef.current = { handle: event.currentTarget, pointerId: event.pointerId, startX: event.clientX, startWidth: nativeSidebarWidthMin, mode: "closed" };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const nextWidth = width - 10;
      if (nextWidth < nativeSidebarWidthMin) {
        onCloseRef.current?.();
      } else {
        setWidth(nextWidth);
      }
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setWidth(width + 10);
    } else if (event.key === "Home") {
      event.preventDefault();
      setWidth(nativeSidebarWidthMin);
    } else if (event.key === "End") {
      event.preventDefault();
      setWidth(nativeSidebarWidthMax);
    }
  }, [setWidth, width]);

  useEffect(() => {
    if (!isResizing) return undefined;
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const onPointerMove = (event: globalThis.PointerEvent): void => {
      const state = resizeStateRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      if (state.mode === "closed") {
        const distance = event.clientX - state.startX;
        if (nativePanelEdgeTransition(distance, nativeSidebarCloseDragDistance) === "closed") return;
        state.mode = "split";
        state.startWidth = nativeSidebarWidthMin;
        state.startX = event.clientX;
        onOpenRef.current?.();
      }
      const nextWidth = state.startWidth + event.clientX - state.startX;
      const transition = nativePanelWidthTransition(state.startWidth, nextWidth, {
        minWidth: nativeSidebarWidthMin,
        closeDragDistance: nativeSidebarCloseDragDistance,
        maxWidth: nativeSidebarWidthMax,
        clampWidth: clampNativeSidebarWidth
      });
      if (transition.kind === "close") {
        state.mode = "closed";
        state.startX = event.clientX;
        state.startWidth = nativeSidebarWidthMin;
        onCloseRef.current?.();
        return;
      }
      if (transition.kind === "split") setWidth(transition.width);
    };
    const finishResize = (event?: globalThis.PointerEvent): void => {
      const state = resizeStateRef.current;
      if (!state || (event && event.pointerId !== state.pointerId)) return;
      if (state.handle?.hasPointerCapture?.(state.pointerId)) state.handle.releasePointerCapture?.(state.pointerId);
      resizeStateRef.current = undefined;
      setIsResizing(false);
    };
    const onWindowBlur = (): void => finishResize();
    document.documentElement.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      cancelResize();
      document.documentElement.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [cancelResize, isResizing, setWidth]);

  return { width, isResizing, setWidth, resetWidth, cancelResize, onPointerDown, onClosedPointerDown, onKeyDown };
}
