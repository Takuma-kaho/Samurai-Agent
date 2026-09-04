import type { NativeSelectionCandidate, NativeWorkspaceTarget } from "../native-app/types";

/**
 * Local navigation state is a hint, never an authorization cache. Keep the
 * original key so existing installs can be migrated without a reset, but
 * store one candidate per connection + Workspace target from v2 onward.
 */
const preferenceKey = "samurai.native-app.selection.v1";
const preferenceVersion = 2 as const;

interface StoredSelectionPreference {
  version: typeof preferenceVersion;
  candidates: Record<string, NativeSelectionCandidate>;
  lastTargetKey?: string;
}

interface SelectionConnection {
  id?: string;
  serverUrl?: string;
  accountId?: string;
}

export type NativeSelectionInput = Omit<NativeSelectionCandidate, "serverOrigin" | "accountId">;

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

function candidateTargetKey(candidate: Pick<NativeSelectionCandidate, "connectionId" | "workspaceId" | "serverOrigin" | "accountId">): string {
  const connectionId = candidate.connectionId || `${candidate.serverOrigin}\n${candidate.accountId}`;
  return `${connectionId}\n${candidate.workspaceId ?? ""}`;
}

function targetKey(target: NativeWorkspaceTarget): string {
  return `${target.connectionId}\n${target.workspaceId}`;
}

function isCandidate(value: unknown): value is NativeSelectionCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<NativeSelectionCandidate>;
  const optionalParts = [candidate.connectionId, candidate.organizationId, candidate.workspaceId, candidate.roomId];
  const hasOneTargetPart = candidate.connectionId !== undefined || candidate.workspaceId !== undefined;
  const hasCompleteTarget = candidate.connectionId === undefined && candidate.workspaceId === undefined
    || typeof candidate.connectionId === "string" && candidate.connectionId.length > 0
      && typeof candidate.workspaceId === "string" && candidate.workspaceId.length > 0;
  return typeof candidate.serverOrigin === "string"
    && typeof candidate.accountId === "string"
    && candidate.serverOrigin.length > 0
    && candidate.accountId.length > 0
    && optionalParts.every((part) => part === undefined || typeof part === "string")
    && (!hasOneTargetPart || hasCompleteTarget);
}

function parsePreference(value: unknown): StoredSelectionPreference | undefined {
  if (isCandidate(value)) {
    // v1 was a single object. Keep it as one candidate while the next write
    // upgrades the storage shape.
    const key = candidateTargetKey(value);
    return { version: preferenceVersion, candidates: { [key]: value }, lastTargetKey: key };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as { version?: unknown; candidates?: unknown; lastTargetKey?: unknown };
  if (body.version !== preferenceVersion || !body.candidates || typeof body.candidates !== "object" || Array.isArray(body.candidates)) return undefined;
  const candidates: Record<string, NativeSelectionCandidate> = {};
  for (const [key, candidate] of Object.entries(body.candidates)) {
    if (isCandidate(candidate)) candidates[key] = candidate;
  }
  return {
    version: preferenceVersion,
    candidates,
    ...(typeof body.lastTargetKey === "string" ? { lastTargetKey: body.lastTargetKey } : {})
  };
}

/**
 * Read a candidate for the supplied connection. If target is supplied, the
 * connection + Workspace pair must match exactly; a same-ID Workspace on a
 * different Server can never satisfy the lookup.
 */
export function readNativeSelectionCandidate(connection?: SelectionConnection, target?: NativeWorkspaceTarget): NativeSelectionCandidate | undefined {
  if (!canUseStorage()) return undefined;
  try {
    const raw = window.localStorage.getItem(preferenceKey);
    if (!raw) return undefined;
    const parsed = parsePreference(JSON.parse(raw));
    if (!parsed) return undefined;
    const matchingConnection = Object.values(parsed.candidates).filter((candidate) => {
      if (connection?.id && candidate.connectionId && candidate.connectionId !== connection.id) return false;
      if (connection?.serverUrl && candidate.serverOrigin !== normalizeOrigin(connection.serverUrl)) return false;
      if (connection?.accountId && candidate.accountId !== connection.accountId) return false;
      return true;
    });
    if (target) return matchingConnection.find((candidate) => candidateTargetKey(candidate) === targetKey(target));
    if (parsed.lastTargetKey) {
      const last = matchingConnection.find((candidate) => candidateTargetKey(candidate) === parsed.lastTargetKey);
      if (last) return last;
    }
    return matchingConnection.sort((left, right) => candidateTargetKey(left).localeCompare(candidateTargetKey(right)))[0];
  } catch {
    return undefined;
  }
}

/** Write only navigation hints; no credential or authorization result is stored. */
export function writeNativeSelectionCandidate(input: NativeSelectionInput, connection: SelectionConnection & { serverUrl: string; accountId: string }): void {
  if (!canUseStorage()) return;
  const candidate: NativeSelectionCandidate = {
    serverOrigin: normalizeOrigin(connection.serverUrl),
    accountId: connection.accountId,
    ...(connection.id ? { connectionId: connection.id } : input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.roomId ? { roomId: input.roomId } : {})
  };
  try {
    const raw = window.localStorage.getItem(preferenceKey);
    const existing = raw ? parsePreference(JSON.parse(raw)) : undefined;
    const candidates = { ...(existing?.candidates ?? {}) };
    const key = candidateTargetKey(candidate);
    candidates[key] = candidate;
    window.localStorage.setItem(preferenceKey, JSON.stringify({ version: preferenceVersion, candidates, lastTargetKey: key } satisfies StoredSelectionPreference));
  } catch {
    // A disabled storage area must not prevent Server re-authorization.
  }
}

/** Remove one target hint, or all hints when no target/connection is given. */
export function clearNativeSelectionCandidate(connection?: SelectionConnection, target?: NativeWorkspaceTarget): void {
  if (!canUseStorage()) return;
  try {
    if (!connection && !target) {
      window.localStorage.removeItem(preferenceKey);
      return;
    }
    const raw = window.localStorage.getItem(preferenceKey);
    const existing = raw ? parsePreference(JSON.parse(raw)) : undefined;
    if (!existing) return;
    const candidates = Object.fromEntries(Object.entries(existing.candidates).filter(([, candidate]) => {
      if (target && candidateTargetKey(candidate) === targetKey(target)) return false;
      if (connection?.id && candidate.connectionId === connection.id) return false;
      if (connection?.serverUrl && candidate.serverOrigin === normalizeOrigin(connection.serverUrl)
        && (!connection.accountId || candidate.accountId === connection.accountId)) return false;
      return true;
    }));
    if (!Object.keys(candidates).length) {
      window.localStorage.removeItem(preferenceKey);
      return;
    }
    const lastTargetKey = existing.lastTargetKey && candidates[existing.lastTargetKey] ? existing.lastTargetKey : Object.keys(candidates)[0];
    window.localStorage.setItem(preferenceKey, JSON.stringify({ version: preferenceVersion, candidates, lastTargetKey } satisfies StoredSelectionPreference));
  } catch {
    // Ignore unavailable storage. The next Server response remains authoritative.
  }
}

export function nativeSelectionPreferenceKey(): string {
  return preferenceKey;
}

export function nativeSelectionTargetKey(target: NativeWorkspaceTarget): string {
  return targetKey(target);
}
