import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceConnection {
  id: string;
  label: string;
  serverUrl: string;
  workspaceId: string;
  accountId: string;
  /** Points to OS keychain / secure storage; the private key never enters this file. */
  credentialRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceConnectionRegistry {
  version: 1;
  activeConnectionId?: string;
  connections: WorkspaceConnection[];
}

export type WorkspaceConnectionInput = Omit<WorkspaceConnection, "id" | "createdAt" | "updatedAt"> & { id?: string };

export async function loadWorkspaceConnectionRegistry(filePath: string): Promise<WorkspaceConnectionRegistry> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return validateRegistry(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connections: [] };
    throw new Error("workspace_connection_registry_invalid");
  }
}

export async function saveWorkspaceConnectionRegistry(filePath: string, registry: WorkspaceConnectionRegistry): Promise<void> {
  const normalized = validateRegistry(registry);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(normalized, null, 2), { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

export function upsertWorkspaceConnection(registry: WorkspaceConnectionRegistry, input: WorkspaceConnectionInput): WorkspaceConnectionRegistry {
  const now = new Date().toISOString();
  const normalized = normalizeConnection(input, now);
  const previous = registry.connections.find((connection) => connection.id === normalized.id);
  const connection: WorkspaceConnection = {
    ...normalized,
    // The renderer never receives this reference. Re-saving the same endpoint
    // must not accidentally discard the locally protected private key.
    ...(normalized.credentialRef || !previous?.credentialRef ? {} : { credentialRef: previous.credentialRef }),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
  const connections = [...registry.connections.filter((item) => item.id !== connection.id), connection]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { version: 1, activeConnectionId: registry.activeConnectionId ?? connection.id, connections };
}

export function selectWorkspaceConnection(registry: WorkspaceConnectionRegistry, connectionId: string): WorkspaceConnectionRegistry {
  if (!registry.connections.some((connection) => connection.id === connectionId)) throw new Error("workspace_connection_not_found");
  return { ...registry, activeConnectionId: connectionId };
}

export function activeWorkspaceConnection(registry: WorkspaceConnectionRegistry): WorkspaceConnection | undefined {
  return registry.connections.find((connection) => connection.id === registry.activeConnectionId);
}

function validateRegistry(value: unknown): WorkspaceConnectionRegistry {
  if (!value || typeof value !== "object") throw new Error("workspace_connection_registry_invalid");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.connections)) throw new Error("workspace_connection_registry_invalid");
  const connections = record.connections.map((connection) => validateConnection(connection));
  const activeConnectionId = typeof record.activeConnectionId === "string" ? record.activeConnectionId : undefined;
  if (activeConnectionId && !connections.some((connection) => connection.id === activeConnectionId)) throw new Error("workspace_connection_registry_invalid");
  return { version: 1, ...(activeConnectionId ? { activeConnectionId } : {}), connections };
}

function validateConnection(value: unknown): WorkspaceConnection {
  if (!value || typeof value !== "object") throw new Error("workspace_connection_registry_invalid");
  const record = value as Record<string, unknown>;
  const normalized = normalizeConnection({
    id: stringValue(record.id),
    label: stringValue(record.label),
    serverUrl: stringValue(record.serverUrl),
    workspaceId: stringValue(record.workspaceId),
    accountId: stringValue(record.accountId),
    ...(typeof record.credentialRef === "string" ? { credentialRef: record.credentialRef } : {})
  }, stringValue(record.updatedAt));
  return { ...normalized, createdAt: stringValue(record.createdAt), updatedAt: stringValue(record.updatedAt) };
}

function normalizeConnection(input: WorkspaceConnectionInput, _now: string): Omit<WorkspaceConnection, "createdAt" | "updatedAt"> {
  const serverUrl = normalizeUrl(input.serverUrl);
  const workspaceId = opaqueId(input.workspaceId);
  const accountId = opaqueId(input.accountId);
  const label = input.label.trim().slice(0, 100);
  if (!label) throw new Error("workspace_connection_label_required");
  const id = input.id?.trim() || `connection_${createHash("sha256").update(`${serverUrl}|${workspaceId}|${accountId}`).digest("hex").slice(0, 20)}`;
  const credentialRef = input.credentialRef?.trim();
  if (credentialRef && !/^(?:keychain|electron-safe-storage|credential-store):\/\/[A-Za-z0-9._:/-]{1,180}$/.test(credentialRef)) {
    throw new Error("workspace_connection_credential_ref_invalid");
  }
  return {
    id: opaqueId(id),
    label,
    serverUrl,
    workspaceId,
    accountId,
    ...(credentialRef ? { credentialRef } : {})
  };
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.username || url.password || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("workspace_connection_server_url_invalid");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function opaqueId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("workspace_connection_id_invalid");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("workspace_connection_registry_invalid");
  return value;
}
