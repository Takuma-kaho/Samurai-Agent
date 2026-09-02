import type { NativeSelectionCandidate } from "../native-app/types";

const preferenceKey = "samurai.native-app.selection.v1";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/$/, "");
  }
}

function isCandidate(value: unknown): value is NativeSelectionCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NativeSelectionCandidate>;
  return typeof candidate.serverOrigin === "string"
    && typeof candidate.accountId === "string"
    && candidate.serverOrigin.length > 0
    && candidate.accountId.length > 0
    && [candidate.organizationId, candidate.workspaceId, candidate.roomId].every((part) => part === undefined || typeof part === "string");
}

/**
 * Selection is a convenience hint only. It never contains a credential or an
 * authorization decision, and callers must re-query the Server before using it.
 */
export function readNativeSelectionCandidate(connection?: { serverUrl?: string; accountId?: string }): NativeSelectionCandidate | undefined {
  if (!canUseStorage()) return undefined;
  try {
    const raw = window.localStorage.getItem(preferenceKey);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isCandidate(parsed)) return undefined;
    if (connection?.serverUrl && parsed.serverOrigin !== normalizeOrigin(connection.serverUrl)) return undefined;
    if (connection?.accountId && parsed.accountId !== connection.accountId) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeNativeSelectionCandidate(input: Omit<NativeSelectionCandidate, "serverOrigin" | "accountId">, connection: { serverUrl: string; accountId: string }): void {
  if (!canUseStorage()) return;
  const candidate: NativeSelectionCandidate = {
    serverOrigin: normalizeOrigin(connection.serverUrl),
    accountId: connection.accountId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.roomId ? { roomId: input.roomId } : {})
  };
  try {
    window.localStorage.setItem(preferenceKey, JSON.stringify(candidate));
  } catch {
    // A disabled storage area must not prevent Server re-authorization.
  }
}

export function clearNativeSelectionCandidate(): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(preferenceKey);
  } catch {
    // Ignore unavailable storage. The next Server response remains authoritative.
  }
}

export function nativeSelectionPreferenceKey(): string {
  return preferenceKey;
}
