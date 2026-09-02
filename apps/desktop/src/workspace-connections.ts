import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A Desktop connection identifies an Account at a Server. Workspace and
 * Room IDs are only local navigation hints; the Server re-authorizes them on
 * every selection and never treats them as part of the credential scope.
 */
export interface WorkspaceConnection {
  id: string;
  label: string;
  serverUrl: string;
  accountId: string;
  /** Points to OS keychain / secure storage; the private key never enters this file. */
  credentialRef?: string;
  /** Last selected values. These are candidates, not authorization grants. */
  lastOrganizationId?: string;
  lastWorkspaceId?: string;
  lastRoomId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Version 1 is accepted as an input shape so existing callers and on-disk
 * registries can be migrated without a destructive reset. New saves always
 * produce version 2.
 */
export interface WorkspaceConnectionRegistry {
  version: 1 | 2;
  activeConnectionId?: string;
  connections: WorkspaceConnection[];
}

export type WorkspaceConnectionInput = {
  id?: string;
  label: string;
  serverUrl: string;
  accountId: string;
  credentialRef?: string;
  lastOrganizationId?: string;
  lastWorkspaceId?: string;
  lastRoomId?: string;
  /** @deprecated Version 1 input; migrated to lastWorkspaceId. */
  workspaceId?: string;
};

const CURRENT_REGISTRY_VERSION = 2 as const;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const credentialRefPattern = /^(?:keychain|electron-safe-storage|credential-store):\/\/[A-Za-z0-9._:\/-]{1,180}$/;

export async function loadWorkspaceConnectionRegistry(filePath: string): Promise<WorkspaceConnectionRegistry> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return migrateWorkspaceConnectionRegistry(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: CURRENT_REGISTRY_VERSION, connections: [] };
    if (error instanceof Error && error.message === "workspace_connection_registry_invalid") throw error;
    throw new Error("workspace_connection_registry_invalid");
  }
}

export async function saveWorkspaceConnectionRegistry(filePath: string, registry: WorkspaceConnectionRegistry): Promise<void> {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(normalized, null, 2), { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

/**
 * Migrates the old workspace-scoped registry and coalesces duplicate
 * Server+Account entries. The selected old workspace survives only as the
 * lastWorkspaceId candidate; no Workspace or Organization permission is
 * copied into the new connection identity.
 */
export function migrateWorkspaceConnectionRegistry(value: unknown): WorkspaceConnectionRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_connection_registry_invalid");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) throw new Error("workspace_connection_registry_invalid");
  if (!Array.isArray(record.connections)) throw new Error("workspace_connection_registry_invalid");

  const rawConnections = record.connections.map((connection) => parseStoredConnection(connection));
  const activeSourceId = typeof record.activeConnectionId === "string" ? record.activeConnectionId : undefined;
  if (activeSourceId && !rawConnections.some((connection) => connection.id === activeSourceId)) {
    throw new Error("workspace_connection_registry_invalid");
  }

  const grouped = new Map<string, Array<WorkspaceConnection & { sourceIndex: number }>>();
  rawConnections.forEach((connection, sourceIndex) => {
    const key = connectionKey(connection.serverUrl, connection.accountId);
    const values = grouped.get(key) ?? [];
    values.push({ ...connection, sourceIndex });
    grouped.set(key, values);
  });

  const idMap = new Map<string, string>();
  const connections: WorkspaceConnection[] = [];
  for (const group of grouped.values()) {
    // Newest metadata is the most useful default. If the active legacy row is
    // in this group, its navigation candidate and protected credential win.
    const ordered = [...group].sort((left, right) => {
      const leftActive = left.id === activeSourceId ? 1 : 0;
      const rightActive = right.id === activeSourceId ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return right.updatedAt.localeCompare(left.updatedAt) || left.sourceIndex - right.sourceIndex;
    });
    const primary = ordered[0]!;
    const canonicalId = connectionId(primary.serverUrl, primary.accountId);
    for (const connection of group) idMap.set(connection.id, canonicalId);
    const merged = mergeConnections(undefined, primary, canonicalId);
    for (const candidate of ordered.slice(1)) {
      if (!merged.credentialRef && candidate.credentialRef) merged.credentialRef = candidate.credentialRef;
      for (const field of ["lastOrganizationId", "lastWorkspaceId", "lastRoomId"] as const) {
        if (!merged[field] && candidate[field]) merged[field] = candidate[field];
      }
      if (candidate.createdAt < merged.createdAt) merged.createdAt = candidate.createdAt;
      if (candidate.updatedAt > merged.updatedAt) merged.updatedAt = candidate.updatedAt;
    }
    connections.push(merged);
  }

  connections.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const activeConnectionId = activeSourceId ? idMap.get(activeSourceId) : undefined;
  return {
    version: CURRENT_REGISTRY_VERSION,
    ...(activeConnectionId ? { activeConnectionId } : {}),
    connections
  };
}

export function upsertWorkspaceConnection(registry: WorkspaceConnectionRegistry, input: WorkspaceConnectionInput): WorkspaceConnectionRegistry {
  const normalizedRegistry = migrateWorkspaceConnectionRegistry(registry);
  const now = new Date().toISOString();
  const normalized = normalizeConnection(input, now);
  const existing = normalizedRegistry.connections.find((connection) => connectionKey(connection.serverUrl, connection.accountId) === connectionKey(normalized.serverUrl, normalized.accountId));
  const connection = mergeConnections(existing, normalized, connectionId(normalized.serverUrl, normalized.accountId));
  const connections = [...normalizedRegistry.connections.filter((item) => item.id !== existing?.id), connection]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    version: CURRENT_REGISTRY_VERSION,
    activeConnectionId: normalizedRegistry.activeConnectionId ?? connection.id,
    connections
  };
}

export function selectWorkspaceConnection(registry: WorkspaceConnectionRegistry, connectionId: string): WorkspaceConnectionRegistry {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  const selected = normalized.connections.find((connection) => connection.id === connectionId.trim());
  if (!selected) throw new Error("workspace_connection_not_found");
  return { ...normalized, activeConnectionId: selected.id };
}

export function activeWorkspaceConnection(registry: WorkspaceConnectionRegistry): WorkspaceConnection | undefined {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  return normalized.connections.find((connection) => connection.id === normalized.activeConnectionId);
}

function parseStoredConnection(value: unknown): WorkspaceConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_connection_registry_invalid");
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id, "workspace_connection_registry_invalid");
  const label = stringValue(record.label, "workspace_connection_registry_invalid");
  const serverUrl = normalizeUrl(stringValue(record.serverUrl, "workspace_connection_registry_invalid"));
  const accountId = opaqueId(stringValue(record.accountId, "workspace_connection_registry_invalid"), "workspace_connection_registry_invalid");
  const credentialRef = optionalCredentialRef(record.credentialRef);
  const legacyWorkspaceId = optionalOpaqueId(record.workspaceId, "workspace_connection_registry_invalid");
  const lastWorkspaceId = optionalOpaqueId(record.lastWorkspaceId, "workspace_connection_registry_invalid") ?? legacyWorkspaceId;
  const lastOrganizationId = optionalOpaqueId(record.lastOrganizationId, "workspace_connection_registry_invalid");
  const lastRoomId = optionalOpaqueId(record.lastRoomId, "workspace_connection_registry_invalid");
  const createdAt = stringValue(record.createdAt, "workspace_connection_registry_invalid");
  const updatedAt = stringValue(record.updatedAt, "workspace_connection_registry_invalid");
  return {
    id: opaqueId(id, "workspace_connection_registry_invalid"),
    label: label.trim().slice(0, 100),
    serverUrl,
    accountId,
    ...(credentialRef ? { credentialRef } : {}),
    ...(lastOrganizationId ? { lastOrganizationId } : {}),
    ...(lastWorkspaceId ? { lastWorkspaceId } : {}),
    ...(lastRoomId ? { lastRoomId } : {}),
    createdAt,
    updatedAt
  };
}

function normalizeConnection(input: WorkspaceConnectionInput, now: string): WorkspaceConnection {
  const serverUrl = normalizeUrl(input.serverUrl);
  const accountId = opaqueId(input.accountId, "workspace_connection_id_invalid");
  const label = input.label.trim().slice(0, 100);
  if (!label) throw new Error("workspace_connection_label_required");
  const credentialRef = optionalCredentialRef(input.credentialRef);
  const lastOrganizationId = optionalOpaqueId(input.lastOrganizationId, "workspace_connection_id_invalid");
  const lastWorkspaceId = optionalOpaqueId(input.lastWorkspaceId, "workspace_connection_id_invalid")
    ?? optionalOpaqueId(input.workspaceId, "workspace_connection_id_invalid");
  const lastRoomId = optionalOpaqueId(input.lastRoomId, "workspace_connection_id_invalid");
  return {
    id: connectionId(serverUrl, accountId),
    label,
    serverUrl,
    accountId,
    ...(credentialRef ? { credentialRef } : {}),
    ...(lastOrganizationId ? { lastOrganizationId } : {}),
    ...(lastWorkspaceId ? { lastWorkspaceId } : {}),
    ...(lastRoomId ? { lastRoomId } : {}),
    createdAt: now,
    updatedAt: now
  };
}

function mergeConnections(
  existing: WorkspaceConnection | undefined,
  incoming: WorkspaceConnection,
  id: string
): WorkspaceConnection {
  const createdAt = existing?.createdAt && existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt;
  return {
    id,
    label: incoming.label || existing?.label || "Samurai Server",
    serverUrl: incoming.serverUrl,
    accountId: incoming.accountId,
    // The renderer cannot submit a credential reference. Keep the protected
    // value already held by Main when an endpoint is saved again.
    ...(incoming.credentialRef || existing?.credentialRef
      ? { credentialRef: incoming.credentialRef ?? existing?.credentialRef } : {}),
    ...(incoming.lastOrganizationId ?? existing?.lastOrganizationId
      ? { lastOrganizationId: incoming.lastOrganizationId ?? existing?.lastOrganizationId } : {}),
    ...(incoming.lastWorkspaceId ?? existing?.lastWorkspaceId
      ? { lastWorkspaceId: incoming.lastWorkspaceId ?? existing?.lastWorkspaceId } : {}),
    ...(incoming.lastRoomId ?? existing?.lastRoomId
      ? { lastRoomId: incoming.lastRoomId ?? existing?.lastRoomId } : {}),
    createdAt,
    updatedAt: incoming.updatedAt
  };
}

function connectionKey(serverUrl: string, accountId: string): string {
  return `${serverUrl}\n${accountId}`;
}

function connectionId(serverUrl: string, accountId: string): string {
  return `connection_${createHash("sha256").update(connectionKey(serverUrl, accountId)).digest("hex").slice(0, 40)}`;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
    if (url.username || url.password || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
      throw new Error("workspace_connection_server_url_invalid");
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof Error && error.message === "workspace_connection_server_url_invalid") throw error;
    throw new Error("workspace_connection_server_url_invalid");
  }
}

function optionalCredentialRef(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !credentialRefPattern.test(value.trim())) {
    throw new Error("workspace_connection_credential_ref_invalid");
  }
  return value.trim();
}

function optionalOpaqueId(value: unknown, errorCode: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return opaqueId(value, errorCode);
}

function opaqueId(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !opaqueIdPattern.test(value.trim())) throw new Error(errorCode);
  return value.trim();
}

function stringValue(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(errorCode);
  return value;
}
