import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export const nativeSidebarWidthStorageKey = "samurai.native.sidebar-width.v1";
export const nativeSidebarWidthDefault = 300;
export const nativeSidebarWidthMin = 220;
export const nativeSidebarWidthMax = 420;

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
  pointerId: number;
  startX: number;
  startWidth: number;
};

export function useNativeSidebarWidth(onClose?: () => void) {
  const [width, setWidthState] = useState(readNativeSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<ResizeState | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const setWidth = useCallback((next: number | ((current: number) => number)): void => {
    setWidthState((current) => {
      const normalized = clampNativeSidebarWidth(typeof next === "function" ? next(current) : next);
      writeNativeSidebarWidth(normalized);
      return normalized;
    });
  }, []);

  const resetWidth = useCallback((): void => setWidth(nativeSidebarWidthDefault), [setWidth]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  }, [width]);

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
      const nextWidth = state.startWidth + event.clientX - state.startX;
      if (nextWidth < nativeSidebarWidthMin) {
        resizeStateRef.current = undefined;
        setIsResizing(false);
        onCloseRef.current?.();
        return;
      }
      setWidth(nextWidth);
    };
    const finishResize = (event: globalThis.PointerEvent): void => {
      const state = resizeStateRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      resizeStateRef.current = undefined;
      setIsResizing(false);
    };
    document.documentElement.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    return () => {
      document.documentElement.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
    };
  }, [isResizing, setWidth]);

  return { width, isResizing, setWidth, resetWidth, onPointerDown, onKeyDown };
}
