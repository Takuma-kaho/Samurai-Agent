import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A Workspace target is always addressed by both the Desktop connection and
 * the Server Workspace ID. A Workspace ID by itself is never a registry key.
 */
export interface WorkspaceTargetRef {
  connectionId: string;
  workspaceId: string;
}

export interface WorkspaceTarget extends WorkspaceTargetRef {
  /** Navigation candidates only; the Server remains the authorization source. */
  lastOrganizationId?: string;
  lastRoomId?: string;
  /** Set only after a verified Server-to-Server cutover. */
  supersededBy?: WorkspaceTargetRef;
  createdAt: string;
  updatedAt: string;
}

/** A Desktop connection identifies an Account at a Server. */
export interface WorkspaceConnection {
  id: string;
  label: string;
  serverUrl: string;
  accountId: string;
  /** Points to OS keychain / secure storage; the private key never enters this file. */
  credentialRef?: string;
  /** Workspace candidates keyed by connectionId + workspaceId. */
  targets: WorkspaceTarget[];
  /**
   * Deprecated v1/v2 mirrors. Retained for source compatibility and migration
   * only; new Main code uses targets and activeTarget.
   */
  lastOrganizationId?: string;
  lastWorkspaceId?: string;
  lastRoomId?: string;
  createdAt: string;
  updatedAt: string;
}

/** v1/v2 are accepted on disk; v3 is the target-aware normalized shape. */
export interface WorkspaceConnectionRegistry {
  version: 1 | 2 | 3;
  /** Kept for old connection settings consumers. */
  activeConnectionId?: string;
  /** The only valid active Workspace identity. */
  activeTarget?: WorkspaceTargetRef;
  connections: WorkspaceConnection[];
  transfers?: WorkspaceTransferRecord[];
}

export type WorkspaceTargetInput = WorkspaceTargetRef & {
  lastOrganizationId?: string;
  lastRoomId?: string;
};

export interface WorkspaceTargetCutover {
  source: WorkspaceTargetRef;
  destination: WorkspaceTargetRef;
  lastOrganizationId?: string | null;
  lastRoomId?: string | null;
}

/** Portable transfer receipt metadata retained for restart-safe completion. */
export interface WorkspaceTransferReceiptRecord {
  format_version: 1;
  transfer_id: string;
  source_workspace_id: string;
  source_integrity_hash: string;
  target_workspace_id: string;
  imported_at: string;
  target_integrity_hash: string;
}

/** Restart-safe transfer checkpoint; never contains credentials or bundle bytes. */
export interface WorkspaceTransferRecord {
  transferId: string;
  source: WorkspaceTargetRef;
  destination: WorkspaceTargetRef;
  state: "preflight" | "exported" | "restoring" | "verified" | "cutover" | "source_archived" | "failed";
  workspaceId: string;
  workspaceName?: string;
  dataByteSize?: number;
  entryCount?: number;
  capacityUnverified?: boolean;
  organizationReleased?: boolean;
  sourceArchived?: boolean;
  targetRestored?: boolean;
  targetCleanupRequired?: boolean;
  integrityHash?: string;
  receipt?: WorkspaceTransferReceiptRecord;
  failureCode?: string;
  message?: string;
  updatedAt: string;
}

export type WorkspaceTargetPatch = {
  lastOrganizationId?: string | null;
  lastRoomId?: string | null;
};

export type WorkspaceConnectionInput = {
  id?: string;
  label: string;
  serverUrl: string;
  accountId: string;
  credentialRef?: string;
  lastOrganizationId?: string;
  lastWorkspaceId?: string;
  lastRoomId?: string;
  /** New target-aware input. */
  targets?: Array<WorkspaceTargetInput & Partial<Pick<WorkspaceTarget, "createdAt" | "updatedAt">>>;
  /** @deprecated Version 1 input; migrated to a target. */
  workspaceId?: string;
};

const CURRENT_REGISTRY_VERSION = 3 as const;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const credentialRefPattern = /^(?:keychain|electron-safe-storage|credential-store):\/\/[A-Za-z0-9._:\/-]{1,180}$/;

export async function loadWorkspaceConnectionRegistry(filePath: string): Promise<WorkspaceConnectionRegistry> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return migrateWorkspaceConnectionRegistry(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWorkspaceConnectionRegistry();
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

export function emptyWorkspaceConnectionRegistry(): WorkspaceConnectionRegistry {
  return { version: CURRENT_REGISTRY_VERSION, connections: [] };
}

export function recordWorkspaceTransfer(
  registry: WorkspaceConnectionRegistry,
  transfer: WorkspaceTransferRecord
): WorkspaceConnectionRegistry {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  const transfers = [...(normalized.transfers ?? []).filter((item) => item.transferId !== transfer.transferId), { ...transfer }]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 256);
  return { ...normalized, transfers };
}

export function getWorkspaceTransfer(
  registry: WorkspaceConnectionRegistry,
  transferId: string
): WorkspaceTransferRecord | undefined {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  return normalized.transfers?.find((transfer) => transfer.transferId === transferId);
}

/**
 * Migrates the old Workspace-scoped registry and coalesces duplicate
 * Server+Account entries. A legacy Workspace candidate becomes one target;
 * distinct Workspace IDs on the same connection are all retained.
 */
export function migrateWorkspaceConnectionRegistry(value: unknown): WorkspaceConnectionRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_connection_registry_invalid");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2 && record.version !== 3) {
    throw new Error("workspace_connection_registry_invalid");
  }
  if (!Array.isArray(record.connections)) throw new Error("workspace_connection_registry_invalid");

  const rawConnections = record.connections.map((connection) => parseStoredConnection(connection));
  const activeSourceId = typeof record.activeConnectionId === "string" ? record.activeConnectionId.trim() || undefined : undefined;
  if (activeSourceId && !rawConnections.some((connection) => connection.id === activeSourceId)) {
    throw new Error("workspace_connection_registry_invalid");
  }
  const requestedActiveTarget = parseStoredTargetRef(record.activeTarget, record.activeTargetKey);
  const parsedTransfers = Array.isArray(record.transfers)
    ? record.transfers.map((transfer) => parseStoredTransfer(transfer)).slice(0, 256)
    : [];

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
    // An active legacy row wins first, then newer metadata. This preserves the
    // last selected candidate and protected credential during migration.
    const ordered = [...group].sort((left, right) => {
      const leftActive = left.id === activeSourceId ? 1 : 0;
      const rightActive = right.id === activeSourceId ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return right.updatedAt.localeCompare(left.updatedAt) || left.sourceIndex - right.sourceIndex;
    });
    const primary = ordered[0]!;
    const canonicalId = connectionId(primary.serverUrl, primary.accountId);
    for (const connection of group) idMap.set(connection.id, canonicalId);

    let merged = mergeConnections(undefined, primary, canonicalId);
    for (const candidate of ordered.slice(1)) merged = mergeConnections(merged, candidate, canonicalId);
    const preferredWorkspaceId = requestedActiveTarget?.workspaceId
      ?? (activeSourceId === primary.id ? primary.targets[0]?.workspaceId : undefined)
      ?? merged.lastWorkspaceId;
    connections.push(syncLegacyConnectionMirror(merged, preferredWorkspaceId));
  }

  connections.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const activeConnectionId = activeSourceId
    ? idMap.get(activeSourceId)
    : requestedActiveTarget
      ? idMap.get(requestedActiveTarget.connectionId) ?? requestedActiveTarget.connectionId
      : undefined;
  const activeConnection = activeConnectionId ? connections.find((connection) => connection.id === activeConnectionId) : undefined;
  const activeWorkspaceId = requestedActiveTarget?.workspaceId
    ?? (activeSourceId ? rawConnections.find((connection) => connection.id === activeSourceId)?.targets[0]?.workspaceId : undefined)
    ?? activeConnection?.lastWorkspaceId;
  const activeTargetCandidate = activeConnection && activeWorkspaceId
    ? findWorkspaceTarget(activeConnection, activeWorkspaceId)
    : undefined;
  const activeTarget = activeTargetCandidate && !activeTargetCandidate.supersededBy
    ? activeTargetCandidate
    : undefined;
  const transfers = parsedTransfers.map((transfer) => ({
    ...transfer,
    source: { ...transfer.source, connectionId: idMap.get(transfer.source.connectionId) ?? transfer.source.connectionId },
    destination: { ...transfer.destination, connectionId: idMap.get(transfer.destination.connectionId) ?? transfer.destination.connectionId }
  }));

  return {
    version: CURRENT_REGISTRY_VERSION,
    ...(activeConnection?.id ? { activeConnectionId: activeConnection.id } : {}),
    ...(activeTarget ? { activeTarget: targetRef(activeTarget) } : {}),
    connections,
    ...(transfers.length > 0 ? { transfers } : {})
  };
}

export function upsertWorkspaceConnection(registry: WorkspaceConnectionRegistry, input: WorkspaceConnectionInput): WorkspaceConnectionRegistry {
  const normalizedRegistry = migrateWorkspaceConnectionRegistry(registry);
  const now = new Date().toISOString();
  const normalized = normalizeConnection(input, now);
  const existing = normalizedRegistry.connections.find((connection) => connectionKey(connection.serverUrl, connection.accountId) === connectionKey(normalized.serverUrl, normalized.accountId));
  const connection = mergeConnections(existing, normalized, connectionId(normalized.serverUrl, normalized.accountId));
  const connections = [...normalizedRegistry.connections.filter((item) => item.id !== existing?.id), syncLegacyConnectionMirror(connection)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const nextActiveConnectionId = normalizedRegistry.activeConnectionId ?? connection.id;
  const nextActiveConnection = connections.find((item) => item.id === nextActiveConnectionId);
  const activeTarget = normalizedRegistry.activeTarget
    && nextActiveConnection?.id === normalizedRegistry.activeTarget.connectionId
    && findWorkspaceTarget(nextActiveConnection, normalizedRegistry.activeTarget.workspaceId)
    && !findWorkspaceTarget(nextActiveConnection, normalizedRegistry.activeTarget.workspaceId)?.supersededBy
    ? normalizedRegistry.activeTarget
    : nextActiveConnection?.id === connection.id && connection.targets[0]
      ? targetRef(connection.targets[0])
      : undefined;
  return {
    version: CURRENT_REGISTRY_VERSION,
    ...(nextActiveConnection?.id ? { activeConnectionId: nextActiveConnection.id } : {}),
    ...(activeTarget ? { activeTarget } : {}),
    connections,
    ...(normalizedRegistry.transfers && normalizedRegistry.transfers.length > 0 ? { transfers: normalizedRegistry.transfers } : {})
  };
}

/** Add or update a candidate without making it active. */
export function upsertWorkspaceTarget(registry: WorkspaceConnectionRegistry, input: WorkspaceTargetInput): WorkspaceConnectionRegistry {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  const connection = normalized.connections.find((candidate) => candidate.id === input.connectionId.trim());
  if (!connection) throw new Error("workspace_connection_not_found");
  const now = new Date().toISOString();
  const candidate = normalizeTarget(input, connection.id, now);
  const updatedConnection = syncLegacyConnectionMirror({
    ...connection,
    targets: mergeTargets(connection.targets, [candidate]),
    updatedAt: now
  }, candidate.workspaceId);
  return {
    ...normalized,
    connections: normalized.connections.map((item) => item.id === connection.id ? updatedConnection : item),
    ...(normalized.transfers && normalized.transfers.length > 0 ? { transfers: normalized.transfers } : {})
  };
}

/**
 * Atomically changes the registry target for a completed Server-to-Server
 * transfer. The source candidate is retained as a superseded audit/recovery
 * hint, but is not selectable or emitted by the normal Workspace directory.
 * No Server request is made here; the caller must invoke this only after its
 * transfer preflight, restore, and verification have succeeded.
 */
export function cutoverWorkspaceTarget(registry: WorkspaceConnectionRegistry, input: WorkspaceTargetCutover): WorkspaceConnectionRegistry {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  const source = normalizeTargetRef(input.source, "workspace_target_cutover_source_invalid");
  const destination = normalizeTargetRef(input.destination, "workspace_target_cutover_destination_invalid");
  if (workspaceTargetKey(source) === workspaceTargetKey(destination)) throw new Error("workspace_target_cutover_same_target");
  const sourceConnection = normalized.connections.find((connection) => connection.id === source.connectionId);
  const destinationConnection = normalized.connections.find((connection) => connection.id === destination.connectionId);
  if (!sourceConnection) throw new Error("workspace_connection_not_found");
  if (!destinationConnection) throw new Error("workspace_target_cutover_destination_connection_not_found");
  const sourceTarget = findWorkspaceTarget(sourceConnection, source.workspaceId);
  if (!sourceTarget) throw new Error("workspace_target_not_found");
  const now = new Date().toISOString();
  const destinationExisting = findWorkspaceTarget(destinationConnection, destination.workspaceId);
  const destinationTarget: WorkspaceTarget = {
    ...(destinationExisting ?? {
      connectionId: destination.connectionId,
      workspaceId: destination.workspaceId,
      createdAt: now,
      updatedAt: now
    }),
    connectionId: destination.connectionId,
    workspaceId: destination.workspaceId,
    updatedAt: now
  };
  if (input.lastOrganizationId !== undefined) {
    const lastOrganizationId = optionalOpaqueId(input.lastOrganizationId, "workspace_target_id_invalid");
    if (lastOrganizationId) destinationTarget.lastOrganizationId = lastOrganizationId;
    else delete destinationTarget.lastOrganizationId;
  } else if (sourceTarget.lastOrganizationId) {
    destinationTarget.lastOrganizationId = sourceTarget.lastOrganizationId;
  }
  if (input.lastRoomId !== undefined) {
    const lastRoomId = optionalOpaqueId(input.lastRoomId, "workspace_target_id_invalid");
    if (lastRoomId) destinationTarget.lastRoomId = lastRoomId;
    else delete destinationTarget.lastRoomId;
  } else if (sourceTarget.lastRoomId) {
    destinationTarget.lastRoomId = sourceTarget.lastRoomId;
  }
  delete destinationTarget.supersededBy;
  const supersededSource: WorkspaceTarget = {
    ...sourceTarget,
    supersededBy: targetRef(destinationTarget),
    updatedAt: now
  };
  const connections = normalized.connections.map((connection) => {
    if (connection.id === sourceConnection.id && connection.id === destinationConnection.id) {
      const targets = connection.targets.map((target) => target.workspaceId === source.workspaceId ? supersededSource : target.workspaceId === destination.workspaceId ? destinationTarget : target);
      return syncLegacyConnectionMirror({ ...connection, targets, updatedAt: now }, destination.workspaceId);
    }
    if (connection.id === sourceConnection.id) {
      return syncLegacyConnectionMirror({
        ...connection,
        targets: connection.targets.map((target) => target.workspaceId === source.workspaceId ? supersededSource : target),
        updatedAt: now
      });
    }
    if (connection.id === destinationConnection.id) {
      const hasDestination = connection.targets.some((target) => target.workspaceId === destination.workspaceId);
      return syncLegacyConnectionMirror({
        ...connection,
        targets: hasDestination
          ? connection.targets.map((target) => target.workspaceId === destination.workspaceId ? destinationTarget : target)
          : [...connection.targets, destinationTarget],
        updatedAt: now
      }, destination.workspaceId);
    }
    return connection;
  });
  const activeSource = normalized.activeTarget && sameTarget(normalized.activeTarget, source);
  return {
    ...normalized,
    ...(activeSource
      ? { activeConnectionId: destination.connectionId, activeTarget: targetRef(destinationTarget) }
      : {}),
    connections
  };
}

/** Update the last Organization/Room hints for a target without switching it. */
export function patchWorkspaceTarget(
  registry: WorkspaceConnectionRegistry,
  ref: WorkspaceTargetRef,
  patch: WorkspaceTargetPatch
): WorkspaceConnectionRegistry {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  const connection = normalized.connections.find((candidate) => candidate.id === ref.connectionId.trim());
  if (!connection) throw new Error("workspace_connection_not_found");
  const existing = findWorkspaceTarget(connection, ref.workspaceId);
  if (!existing) throw new Error("workspace_target_not_found");
  const updatedAt = new Date().toISOString();
  const updatedTarget: WorkspaceTarget = {
    ...existing,
    ...(patch.lastOrganizationId === null ? {} : patch.lastOrganizationId === undefined ? {} : { lastOrganizationId: optionalOpaqueId(patch.lastOrganizationId, "workspace_target_id_invalid") }),
    ...(patch.lastRoomId === null ? {} : patch.lastRoomId === undefined ? {} : { lastRoomId: optionalOpaqueId(patch.lastRoomId, "workspace_target_id_invalid") }),
    updatedAt
  };
  if (patch.lastOrganizationId === null) delete updatedTarget.lastOrganizationId;
  if (patch.lastRoomId === null) delete updatedTarget.lastRoomId;
  const updatedConnection = syncLegacyConnectionMirror({
    ...connection,
    targets: connection.targets.map((candidate) => candidate.workspaceId === ref.workspaceId ? updatedTarget : candidate),
    updatedAt
  }, normalized.activeTarget?.connectionId === connection.id && normalized.activeTarget.workspaceId === ref.workspaceId
    ? ref.workspaceId
    : connection.lastWorkspaceId);
  return {
    ...normalized,
    connections: normalized.connections.map((item) => item.id === connection.id ? updatedConnection : item)
  };
}

export function selectWorkspaceConnection(registry: WorkspaceConnectionRegistry, connectionId: string): WorkspaceConnectionRegistry {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  const selected = normalized.connections.find((connection) => connection.id === connectionId.trim());
  if (!selected) throw new Error("workspace_connection_not_found");
  const selectedTarget = selected.targets.find((target) => !target.supersededBy) ?? selected.targets[0];
  if (selectedTarget?.supersededBy) {
    return { ...normalized, activeConnectionId: selected.id, activeTarget: undefined };
  }
  return {
    ...normalized,
    activeConnectionId: selected.id,
    ...(selectedTarget ? { activeTarget: targetRef(selectedTarget) } : { activeTarget: undefined })
  };
}

/** Select only an exact connection + Workspace pair. */
export function selectWorkspaceTarget(registry: WorkspaceConnectionRegistry, ref: WorkspaceTargetRef): WorkspaceConnectionRegistry {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  const connection = normalized.connections.find((candidate) => candidate.id === ref.connectionId.trim());
  if (!connection) throw new Error("workspace_connection_not_found");
  const selected = findWorkspaceTarget(connection, ref.workspaceId.trim());
  if (!selected) throw new Error("workspace_target_not_found");
  if (selected.supersededBy) throw new Error("workspace_target_superseded");
  return {
    ...normalized,
    activeConnectionId: connection.id,
    activeTarget: targetRef(selected)
  };
}

/** Clear only the active target. The candidate remains available for retry. */
export function clearActiveWorkspaceTarget(registry: WorkspaceConnectionRegistry, ref?: WorkspaceTargetRef): WorkspaceConnectionRegistry {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  if (!ref || (normalized.activeTarget?.connectionId === ref.connectionId && normalized.activeTarget.workspaceId === ref.workspaceId)) {
    const { activeTarget: _activeTarget, ...withoutTarget } = normalized;
    return withoutTarget;
  }
  return normalized;
}

export function activeWorkspaceConnection(registry: WorkspaceConnectionRegistry): WorkspaceConnection | undefined {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  return normalized.connections.find((connection) => connection.id === normalized.activeConnectionId);
}

export function activeWorkspaceTarget(registry: WorkspaceConnectionRegistry): WorkspaceTarget | undefined {
  const normalized = migrateWorkspaceConnectionRegistry(registry);
  if (!normalized.activeTarget) return undefined;
  const connection = normalized.connections.find((candidate) => candidate.id === normalized.activeTarget!.connectionId);
  return connection ? findWorkspaceTarget(connection, normalized.activeTarget.workspaceId) : undefined;
}

export function workspaceTargetForConnection(connection: WorkspaceConnection, workspaceId: string): WorkspaceTarget | undefined {
  return findWorkspaceTarget(connection, workspaceId.trim());
}

export function workspaceTargetKey(ref: WorkspaceTargetRef): string {
  return `${ref.connectionId}\n${ref.workspaceId}`;
}

function parseStoredConnection(value: unknown): WorkspaceConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_connection_registry_invalid");
  const record = value as Record<string, unknown>;
  const id = opaqueId(stringValue(record.id, "workspace_connection_registry_invalid"), "workspace_connection_registry_invalid");
  const label = stringValue(record.label, "workspace_connection_registry_invalid").trim().slice(0, 100);
  const serverUrl = normalizeUrl(stringValue(record.serverUrl, "workspace_connection_registry_invalid"));
  const accountId = opaqueId(stringValue(record.accountId, "workspace_connection_registry_invalid"), "workspace_connection_registry_invalid");
  const credentialRef = optionalCredentialRef(record.credentialRef);
  const createdAt = stringValue(record.createdAt, "workspace_connection_registry_invalid");
  const updatedAt = stringValue(record.updatedAt, "workspace_connection_registry_invalid");
  const targets = Array.isArray(record.targets)
    ? record.targets.map((target) => parseStoredTarget(target, id, createdAt, updatedAt))
    : [];
  const legacyWorkspaceId = optionalOpaqueId(record.workspaceId, "workspace_connection_registry_invalid");
  const lastWorkspaceId = optionalOpaqueId(record.lastWorkspaceId, "workspace_connection_registry_invalid") ?? legacyWorkspaceId;
  const lastOrganizationId = optionalOpaqueId(record.lastOrganizationId, "workspace_connection_registry_invalid");
  const lastRoomId = optionalOpaqueId(record.lastRoomId, "workspace_connection_registry_invalid");
  if (lastWorkspaceId && !targets.some((target) => target.workspaceId === lastWorkspaceId)) {
    targets.push({
      connectionId: id,
      workspaceId: lastWorkspaceId,
      ...(lastOrganizationId ? { lastOrganizationId } : {}),
      ...(lastRoomId ? { lastRoomId } : {}),
      createdAt,
      updatedAt
    });
  }
  return {
    id,
    label,
    serverUrl,
    accountId,
    ...(credentialRef ? { credentialRef } : {}),
    targets: dedupeTargets(targets, id),
    ...(lastOrganizationId ? { lastOrganizationId } : {}),
    ...(lastWorkspaceId ? { lastWorkspaceId } : {}),
    ...(lastRoomId ? { lastRoomId } : {}),
    createdAt,
    updatedAt
  };
}

function parseStoredTarget(value: unknown, connectionId: string, fallbackCreatedAt: string, fallbackUpdatedAt: string): WorkspaceTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_connection_registry_invalid");
  const record = value as Record<string, unknown>;
  const storedConnectionId = record.connectionId === undefined ? undefined : opaqueId(record.connectionId, "workspace_connection_registry_invalid");
  if (storedConnectionId && storedConnectionId !== connectionId) throw new Error("workspace_connection_registry_invalid");
  const workspaceId = opaqueId(record.workspaceId, "workspace_connection_registry_invalid");
  const lastOrganizationId = optionalOpaqueId(record.lastOrganizationId, "workspace_connection_registry_invalid");
  const lastRoomId = optionalOpaqueId(record.lastRoomId, "workspace_connection_registry_invalid");
  const supersededBy = record.supersededBy === undefined || record.supersededBy === null
    ? undefined
    : parseStoredTargetRef(record.supersededBy, undefined);
  if (supersededBy && supersededBy.connectionId === connectionId && supersededBy.workspaceId === workspaceId) {
    throw new Error("workspace_connection_registry_invalid");
  }
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : fallbackCreatedAt;
  const updatedAt = typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : fallbackUpdatedAt;
  return {
    connectionId,
    workspaceId,
    ...(lastOrganizationId ? { lastOrganizationId } : {}),
    ...(lastRoomId ? { lastRoomId } : {}),
    ...(supersededBy ? { supersededBy } : {}),
    createdAt,
    updatedAt
  };
}

function parseStoredTransfer(value: unknown): WorkspaceTransferRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_connection_registry_invalid");
  const record = value as Record<string, unknown>;
  const transferId = opaqueId(record.transferId, "workspace_connection_registry_invalid");
  const source = parseStoredTargetRef(record.source, undefined);
  const destination = parseStoredTargetRef(record.destination, undefined);
  if (!source || !destination) throw new Error("workspace_connection_registry_invalid");
  const state = record.state;
  if (state !== "preflight" && state !== "exported" && state !== "restoring" && state !== "verified"
    && state !== "cutover" && state !== "source_archived" && state !== "failed") {
    throw new Error("workspace_connection_registry_invalid");
  }
  const workspaceId = opaqueId(record.workspaceId, "workspace_connection_registry_invalid");
  if (workspaceId !== source.workspaceId) throw new Error("workspace_connection_registry_invalid");
  const updatedAt = stringValue(record.updatedAt, "workspace_connection_registry_invalid");
  const optionalTextValue = (key: string, max: number): string | undefined => {
    const candidate = record[key];
    if (candidate === undefined || candidate === null || candidate === "") return undefined;
    if (typeof candidate !== "string" || candidate.length > max) throw new Error("workspace_connection_registry_invalid");
    return candidate;
  };
  const optionalNonNegativeInteger = (key: string): number | undefined => {
    const candidate = record[key];
    if (candidate === undefined || candidate === null) return undefined;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) throw new Error("workspace_connection_registry_invalid");
    return candidate;
  };
  const integrityHash = optionalTextValue("integrityHash", 128);
  if (integrityHash !== undefined && !/^[a-f0-9]{64}$/.test(integrityHash)) throw new Error("workspace_connection_registry_invalid");
  const receipt = parseStoredTransferReceipt(record.receipt, transferId, source.workspaceId, destination.workspaceId, integrityHash);
  const booleanValue = (key: string): boolean | undefined => {
    const candidate = record[key];
    if (candidate === undefined || candidate === null) return undefined;
    if (typeof candidate !== "boolean") throw new Error("workspace_connection_registry_invalid");
    return candidate;
  };
  return {
    transferId,
    source,
    destination,
    state,
    workspaceId,
    ...(optionalTextValue("workspaceName", 20_000) ? { workspaceName: optionalTextValue("workspaceName", 20_000) } : {}),
    ...(optionalNonNegativeInteger("dataByteSize") === undefined ? {} : { dataByteSize: optionalNonNegativeInteger("dataByteSize") }),
    ...(optionalNonNegativeInteger("entryCount") === undefined ? {} : { entryCount: optionalNonNegativeInteger("entryCount") }),
    ...(booleanValue("capacityUnverified") === undefined ? {} : { capacityUnverified: booleanValue("capacityUnverified") }),
    ...(booleanValue("organizationReleased") === undefined ? {} : { organizationReleased: booleanValue("organizationReleased") }),
    ...(booleanValue("sourceArchived") === undefined ? {} : { sourceArchived: booleanValue("sourceArchived") }),
    ...(booleanValue("targetRestored") === undefined ? {} : { targetRestored: booleanValue("targetRestored") }),
    ...(booleanValue("targetCleanupRequired") === undefined ? {} : { targetCleanupRequired: booleanValue("targetCleanupRequired") }),
    ...(integrityHash ? { integrityHash } : {}),
    ...(receipt ? { receipt } : {}),
    ...(optionalTextValue("failureCode", 256) ? { failureCode: optionalTextValue("failureCode", 256) } : {}),
    ...(optionalTextValue("message", 20_000) ? { message: optionalTextValue("message", 20_000) } : {}),
    updatedAt
  };
}

function parseStoredTransferReceipt(
  value: unknown,
  transferId: string,
  sourceWorkspaceId: string,
  destinationWorkspaceId: string,
  expectedIntegrityHash?: string
): WorkspaceTransferReceiptRecord | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_connection_registry_invalid");
  const record = value as Record<string, unknown>;
  const sourceIntegrityHash = record.source_integrity_hash;
  const targetIntegrityHash = record.target_integrity_hash;
  if (record.format_version !== 1
    || record.transfer_id !== transferId
    || record.source_workspace_id !== sourceWorkspaceId
    || record.target_workspace_id !== destinationWorkspaceId
    || typeof record.imported_at !== "string"
    || !record.imported_at.trim()
    || !Number.isFinite(new Date(record.imported_at).getTime())
    || typeof sourceIntegrityHash !== "string"
    || typeof targetIntegrityHash !== "string"
    || !/^[a-f0-9]{64}$/.test(sourceIntegrityHash)
    || !/^[a-f0-9]{64}$/.test(targetIntegrityHash)
    || sourceIntegrityHash !== targetIntegrityHash
    || (expectedIntegrityHash !== undefined && sourceIntegrityHash !== expectedIntegrityHash)) {
    throw new Error("workspace_connection_registry_invalid");
  }
  return {
    format_version: 1,
    transfer_id: transferId,
    source_workspace_id: sourceWorkspaceId,
    source_integrity_hash: sourceIntegrityHash,
    target_workspace_id: destinationWorkspaceId,
    imported_at: record.imported_at,
    target_integrity_hash: targetIntegrityHash
  };
}

function parseStoredTargetRef(value: unknown, targetKey: unknown): WorkspaceTargetRef | undefined {
  if (value !== undefined && value !== null) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_connection_registry_invalid");
    const record = value as Record<string, unknown>;
    return {
      connectionId: opaqueId(record.connectionId, "workspace_connection_registry_invalid"),
      workspaceId: opaqueId(record.workspaceId, "workspace_connection_registry_invalid")
    };
  }
  if (typeof targetKey !== "string" || !targetKey.trim()) return undefined;
  const separator = targetKey.indexOf("\n");
  if (separator <= 0 || separator === targetKey.length - 1) throw new Error("workspace_connection_registry_invalid");
  return {
    connectionId: opaqueId(targetKey.slice(0, separator), "workspace_connection_registry_invalid"),
    workspaceId: opaqueId(targetKey.slice(separator + 1), "workspace_connection_registry_invalid")
  };
}

function normalizeConnection(input: WorkspaceConnectionInput, now: string): WorkspaceConnection {
  const serverUrl = normalizeUrl(input.serverUrl);
  const accountId = opaqueId(input.accountId, "workspace_connection_id_invalid");
  const label = input.label.trim().slice(0, 100);
  if (!label) throw new Error("workspace_connection_label_required");
  const id = connectionId(serverUrl, accountId);
  const credentialRef = optionalCredentialRef(input.credentialRef);
  const lastOrganizationId = optionalOpaqueId(input.lastOrganizationId, "workspace_connection_id_invalid");
  const lastWorkspaceId = optionalOpaqueId(input.lastWorkspaceId, "workspace_connection_id_invalid")
    ?? optionalOpaqueId(input.workspaceId, "workspace_connection_id_invalid");
  const lastRoomId = optionalOpaqueId(input.lastRoomId, "workspace_connection_id_invalid");
  const targets = (input.targets ?? []).map((target) => normalizeTarget(target, id, now));
  if (lastWorkspaceId && !targets.some((target) => target.workspaceId === lastWorkspaceId)) {
    targets.push({
      connectionId: id,
      workspaceId: lastWorkspaceId,
      ...(lastOrganizationId ? { lastOrganizationId } : {}),
      ...(lastRoomId ? { lastRoomId } : {}),
      createdAt: now,
      updatedAt: now
    });
  }
  return {
    id,
    label,
    serverUrl,
    accountId,
    ...(credentialRef ? { credentialRef } : {}),
    targets: dedupeTargets(targets, id),
    ...(lastOrganizationId ? { lastOrganizationId } : {}),
    ...(lastWorkspaceId ? { lastWorkspaceId } : {}),
    ...(lastRoomId ? { lastRoomId } : {}),
    createdAt: now,
    updatedAt: now
  };
}

function normalizeTarget(input: WorkspaceTargetInput & Partial<Pick<WorkspaceTarget, "createdAt" | "updatedAt">>, connectionId: string, now: string): WorkspaceTarget {
  if (input.connectionId.trim() !== connectionId) throw new Error("workspace_target_connection_mismatch");
  const workspaceId = opaqueId(input.workspaceId, "workspace_target_id_invalid");
  const lastOrganizationId = optionalOpaqueId(input.lastOrganizationId, "workspace_target_id_invalid");
  const lastRoomId = optionalOpaqueId(input.lastRoomId, "workspace_target_id_invalid");
  return {
    connectionId,
    workspaceId,
    ...(lastOrganizationId ? { lastOrganizationId } : {}),
    ...(lastRoomId ? { lastRoomId } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
}

function mergeConnections(existing: WorkspaceConnection | undefined, incoming: WorkspaceConnection, id: string): WorkspaceConnection {
  const createdAt = existing?.createdAt && existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt;
  const targets = mergeTargets(existing?.targets ?? [], incoming.targets).map((target) => ({ ...target, connectionId: id }));
  const merged: WorkspaceConnection = {
    id,
    label: incoming.label || existing?.label || "Samurai Server",
    serverUrl: incoming.serverUrl,
    accountId: incoming.accountId,
    // Keep the protected reference already held by Main when an endpoint is
    // saved again; renderer input cannot submit a credential reference.
    ...(incoming.credentialRef || existing?.credentialRef
      ? { credentialRef: incoming.credentialRef ?? existing?.credentialRef } : {}),
    targets,
    ...(incoming.lastOrganizationId ?? existing?.lastOrganizationId
      ? { lastOrganizationId: incoming.lastOrganizationId ?? existing?.lastOrganizationId } : {}),
    ...(incoming.lastWorkspaceId ?? existing?.lastWorkspaceId
      ? { lastWorkspaceId: incoming.lastWorkspaceId ?? existing?.lastWorkspaceId } : {}),
    ...(incoming.lastRoomId ?? existing?.lastRoomId
      ? { lastRoomId: incoming.lastRoomId ?? existing?.lastRoomId } : {}),
    createdAt,
    updatedAt: incoming.updatedAt
  };
  return syncLegacyConnectionMirror(merged, incoming.lastWorkspaceId ?? existing?.lastWorkspaceId);
}

function mergeTargets(existing: WorkspaceTarget[], incoming: WorkspaceTarget[]): WorkspaceTarget[] {
  const byWorkspaceId = new Map<string, WorkspaceTarget>();
  for (const target of existing) byWorkspaceId.set(target.workspaceId, { ...target });
  for (const target of incoming) {
    const current = byWorkspaceId.get(target.workspaceId);
    byWorkspaceId.set(target.workspaceId, current ? mergeTarget(current, target) : { ...target });
  }
  return [...byWorkspaceId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function mergeTarget(existing: WorkspaceTarget, incoming: WorkspaceTarget): WorkspaceTarget {
  const supersededBy = incoming.supersededBy ?? existing.supersededBy;
  return {
    connectionId: incoming.connectionId,
    workspaceId: incoming.workspaceId,
    ...(incoming.lastOrganizationId ?? existing.lastOrganizationId
      ? { lastOrganizationId: incoming.lastOrganizationId ?? existing.lastOrganizationId } : {}),
    ...(incoming.lastRoomId ?? existing.lastRoomId
      ? { lastRoomId: incoming.lastRoomId ?? existing.lastRoomId } : {}),
    ...(supersededBy ? { supersededBy: { ...supersededBy } } : {}),
    createdAt: existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt,
    updatedAt: existing.updatedAt > incoming.updatedAt ? existing.updatedAt : incoming.updatedAt
  };
}

function dedupeTargets(targets: WorkspaceTarget[], connectionId: string): WorkspaceTarget[] {
  return mergeTargets([], targets.map((target) => ({ ...target, connectionId })));
}

function syncLegacyConnectionMirror(connection: WorkspaceConnection, preferredWorkspaceId?: string): WorkspaceConnection {
  const visibleTargets = connection.targets.filter((candidate) => !candidate.supersededBy);
  const preferredCandidate = preferredWorkspaceId ? findWorkspaceTarget(connection, preferredWorkspaceId) : undefined;
  const preferred = preferredCandidate && !preferredCandidate.supersededBy ? preferredCandidate : undefined;
  const legacyCandidate = connection.lastWorkspaceId ? findWorkspaceTarget(connection, connection.lastWorkspaceId) : undefined;
  const target = preferred ?? (legacyCandidate && !legacyCandidate.supersededBy ? legacyCandidate : undefined) ?? visibleTargets[0];
  const result: WorkspaceConnection = {
    ...connection,
    targets: connection.targets.map((candidate) => ({ ...candidate, connectionId: connection.id }))
  };
  if (!target) {
    delete result.lastOrganizationId;
    delete result.lastWorkspaceId;
    delete result.lastRoomId;
    return result;
  }
  if (target.lastOrganizationId) result.lastOrganizationId = target.lastOrganizationId;
  else delete result.lastOrganizationId;
  result.lastWorkspaceId = target.workspaceId;
  if (target.lastRoomId) result.lastRoomId = target.lastRoomId;
  else delete result.lastRoomId;
  return result;
}

function findWorkspaceTarget(connection: WorkspaceConnection, workspaceId: string): WorkspaceTarget | undefined {
  return connection.targets.find((target) => target.connectionId === connection.id && target.workspaceId === workspaceId);
}

function normalizeTargetRef(value: WorkspaceTargetRef, errorCode: string): WorkspaceTargetRef {
  if (!value || typeof value !== "object") throw new Error(errorCode);
  return {
    connectionId: opaqueId(value.connectionId, errorCode),
    workspaceId: opaqueId(value.workspaceId, errorCode)
  };
}

function sameTarget(left: WorkspaceTargetRef, right: WorkspaceTargetRef): boolean {
  return left.connectionId === right.connectionId && left.workspaceId === right.workspaceId;
}

function targetRef(target: WorkspaceTarget): WorkspaceTargetRef {
  return { connectionId: target.connectionId, workspaceId: target.workspaceId };
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
