import { useCallback, useEffect, useMemo, useState } from "react";

const storageKey = "samurai.native.room-expansion.v1";

type StoredRoomExpansion = Record<string, string[]>;

function readStoredExpansion(): StoredRoomExpansion {
  if (typeof window === "undefined") return {};
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: StoredRoomExpansion = {};
    for (const [key, ids] of Object.entries(value)) {
      if (!Array.isArray(ids)) continue;
      const normalized = ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
      result[key] = [...new Set(normalized)];
    }
    return result;
  } catch {
    return {};
  }
}

function writeStoredExpansion(value: StoredRoomExpansion): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // A full/private localStorage must not prevent Room navigation.
  }
}

export function nativeRoomExpansionStorageKey(targetKey: string | undefined): string | undefined {
  const normalized = targetKey?.trim();
  return normalized ? normalized : undefined;
}

export function nativeRoomExpansionToggle(
  stored: ReadonlySet<string> | undefined,
  parentRoomIds: ReadonlySet<string>,
  roomId: string
): Set<string> {
  const next = new Set(stored ?? parentRoomIds);
  if (next.has(roomId)) next.delete(roomId);
  else next.add(roomId);
  return next;
}

/**
 * Room expansion is a navigation preference, not authorization state.  It is
 * therefore keyed by the complete Server + Workspace target and never shared
 * across targets.  Undefined means the navigator's safe initial state (all
 * visible parents expanded).
 */
export function useNativeRoomExpansion(targetKey: string | undefined) {
  const [stored, setStored] = useState<StoredRoomExpansion>(readStoredExpansion);
  const key = nativeRoomExpansionStorageKey(targetKey);
  const expandedRoomIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!key || !Object.prototype.hasOwnProperty.call(stored, key)) return undefined;
    return new Set(stored[key] ?? []);
  }, [key, stored]);

  useEffect(() => {
    writeStoredExpansion(stored);
  }, [stored]);

  const toggleExpanded = useCallback((roomId: string, parentRoomIds: ReadonlySet<string>): void => {
    if (!key || !roomId.trim()) return;
    setStored((current) => {
      const existing = Object.prototype.hasOwnProperty.call(current, key)
        ? new Set(current[key] ?? [])
        : undefined;
      const next = nativeRoomExpansionToggle(existing, parentRoomIds, roomId);
      return { ...current, [key]: [...next].sort() };
    });
  }, [key]);

  return { expandedRoomIds, toggleExpanded };
}

export const nativeRoomExpansionStorageKeyForTests = storageKey;
