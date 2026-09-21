import { useCallback, useMemo, useState } from "react";

export type NativeWorkspaceNavigationEntry = Readonly<{
  workspaceTargetKey: string;
  kind: "room" | "agents";
  roomId?: string;
}>;

export type NativeWorkspaceNavigationHistoryState = Readonly<{
  entries: readonly NativeWorkspaceNavigationEntry[];
  index: number;
}>;

const emptyHistory: NativeWorkspaceNavigationHistoryState = { entries: [], index: -1 };

export function nativeWorkspaceNavigationEntryEqual(
  left: NativeWorkspaceNavigationEntry | undefined,
  right: NativeWorkspaceNavigationEntry | undefined
): boolean {
  return left?.workspaceTargetKey === right?.workspaceTargetKey
    && left?.kind === right?.kind
    && left?.roomId === right?.roomId;
}

export function recordNativeWorkspaceNavigation(
  state: NativeWorkspaceNavigationHistoryState,
  entry: NativeWorkspaceNavigationEntry
): NativeWorkspaceNavigationHistoryState {
  const current = state.entries[state.index];
  if (nativeWorkspaceNavigationEntryEqual(current, entry)) return state;
  if (!current || current.workspaceTargetKey !== entry.workspaceTargetKey) {
    return { entries: [entry], index: 0 };
  }
  const entries = [...state.entries.slice(0, state.index + 1), entry];
  return { entries, index: entries.length - 1 };
}

export function useNativeWorkspaceNavigationHistory() {
  const [state, setState] = useState<NativeWorkspaceNavigationHistoryState>(emptyHistory);

  const record = useCallback((entry: NativeWorkspaceNavigationEntry): void => {
    setState((current) => recordNativeWorkspaceNavigation(current, entry));
  }, []);

  const reset = useCallback((): void => {
    setState(emptyHistory);
  }, []);

  const moveBack = useCallback((): void => {
    setState((current) => current.index > 0 ? { ...current, index: current.index - 1 } : current);
  }, []);

  const moveForward = useCallback((): void => {
    setState((current) => current.index < current.entries.length - 1 ? { ...current, index: current.index + 1 } : current);
  }, []);

  return useMemo(() => ({
    ...state,
    backTarget: state.index > 0 ? state.entries[state.index - 1] : undefined,
    forwardTarget: state.index >= 0 && state.index < state.entries.length - 1 ? state.entries[state.index + 1] : undefined,
    canGoBack: state.index > 0,
    canGoForward: state.index >= 0 && state.index < state.entries.length - 1,
    record,
    reset,
    moveBack,
    moveForward
  }), [moveBack, moveForward, record, reset, state]);
}
