import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityInboxItem, ArtifactRecord, BackendEventRecord, BackendRunRecord, MemoryFrontmatter, MessageRecord } from "@samurai-agent/core-schemas";
import {
  api,
  createIdempotencyKey,
  getWorkspaceClientBridge,
  setActiveWorkspaceRoomId,
  type DesktopWorkspaceConnection,
  type DesktopWorkspaceConnectionState,
  type DesktopWorkspaceDirectoryEntry,
  type DesktopWorkspaceDirectoryResult,
  type DesktopWorkspaceTarget,
  type DesktopWorkspaceRoom,
  type ChatTurnResult,
  type SessionDetail
} from "../lib/api";
import { createOrganizationApi, OrganizationApiError } from "../lib/organization-api";
import { clearNativeSelectionCandidate, readNativeSelectionCandidate, writeNativeSelectionCandidate } from "../lib/native-app-preferences";
import type {
  NativeChatMessage,
  NativeEvidenceBundle,
  NativeOrganization,
  NativeOrganizationInvitation,
  NativeOrganizationMember,
  NativeRoom,
  NativeWorkspace,
  NativeWorkspaceBundleExport,
  NativeWorkspaceBundleRestoreResult,
  NativeWorkspaceMovePreview,
  NativeWorkspaceTarget,
  NativeWorkspaceTransferPreflight,
  NativeWorkspaceTransferServerState,
  NativeWorkspaceTransferState,
  NativeWorkspaceTransferStatus,
  NativeWorkspaceDirectoryError,
  NativeConnectionAvailability,
  OrganizationRole,
  NativeSelectionCandidate
} from "./types";
import { nativeWorkspaceTargetKey } from "./types";

const legacyOrganizationId = "__legacy_connection__";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof OrganizationApiError) return error.code;
  if (error instanceof Error) return error.message;
  return "request_failed";
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isPermissionError(error: unknown): boolean {
  const message = errorCode(error).toLowerCase();
  const status = errorStatus(error);
  return status === 401 || status === 403 || status === 404
    || /permission|forbidden|not.?found|access|unauthori[sz]ed|403|401|revoke|denied/.test(message);
}

/**
 * A denied or deleted Workspace target is no longer a valid navigation hint.
 * Transport outages and a missing local identity remain retryable so an
 * offline Server or an unconfigured connection is not discarded by accident.
 */
export function shouldDiscardWorkspaceTargetAfterReauthorizationFailure(error: unknown): boolean {
  if (isPermissionError(error)) return true;
  const code = errorCode(error).toLowerCase();
  return /workspace_(?:re)?authorization|workspace_selection_(?:denied|invalid)|workspace_target_(?:not_found|superseded)|workspace_not_found/.test(code);
}

function userFacingError(error: unknown, fallback: string): string {
  if (isPermissionError(error)) return "権限が変わったため、保護された内容を表示できません。Serverを再確認してください。";
  if (errorCode(error).includes("workspace_connection_required")) return "Workspace Serverへの接続が必要です。";
  return fallback;
}

function randomLocalId(prefix: string): string {
  return `${prefix}_${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now()}`;
}

function connectionFromState(state: DesktopWorkspaceConnectionState): DesktopWorkspaceConnection | undefined {
  return state.connections.find((connection) => connection.id === state.activeConnectionId)
    ?? (state.activeTarget ? state.connections.find((connection) => connection.id === state.activeTarget?.connectionId) : undefined)
    ?? state.connections[0];
}

type SelectionCandidateReader = (connection: DesktopWorkspaceConnection) => NativeSelectionCandidate | undefined;

/**
 * Resolve the remembered Workspace only within the explicitly selected
 * Server. A missing target on that Server must not reactivate another Server's
 * local navigation hint.
 */
export function preferredWorkspaceTargetForState(
  state: Pick<DesktopWorkspaceConnectionState, "activeConnectionId" | "activeTarget">,
  connections: DesktopWorkspaceConnection[],
  readCandidate: SelectionCandidateReader = readNativeSelectionCandidate
): DesktopWorkspaceTarget | undefined {
  if (state.activeTarget) return state.activeTarget;
  const candidateConnections = state.activeConnectionId
    ? connections.filter((connection) => connection.id === state.activeConnectionId)
    : connections;
  for (const candidateConnection of candidateConnections) {
    const candidate = readCandidate(candidateConnection);
    if (candidate?.workspaceId) {
      return {
        connectionId: candidate.connectionId ?? candidateConnection.id,
        workspaceId: candidate.workspaceId
      };
    }
  }
  return undefined;
}

function canonicalWorkspaceServerUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim();
  }
}

function connectionForTarget(state: DesktopWorkspaceConnectionState, target?: NativeWorkspaceTarget): DesktopWorkspaceConnection | undefined {
  if (!target) return connectionFromState(state);
  return state.connections.find((candidate) => candidate.id === target.connectionId);
}

function targetForWorkspace(workspace: NativeWorkspace, fallback?: DesktopWorkspaceConnection): NativeWorkspaceTarget | undefined {
  if (workspace.target) return workspace.target;
  if (workspace.connectionId && workspace.id) return { connectionId: workspace.connectionId, workspaceId: workspace.id };
  if (fallback?.id && workspace.id) return { connectionId: fallback.id, workspaceId: workspace.id };
  return undefined;
}

/**
 * Keep an invalid target visible as a locked directory row while removing its
 * granted state. Matching uses the full connection + Workspace key so a
 * same-ID Workspace on another Server is never changed or selected by this
 * cleanup.
 */
export function workspacesAfterReauthorizationFailure(workspaces: NativeWorkspace[], failedTarget: NativeWorkspaceTarget): NativeWorkspace[] {
  const failedKey = nativeWorkspaceTargetKey(failedTarget);
  return workspaces.map((workspace) => {
    const target = targetForWorkspace(workspace);
    if (!target || nativeWorkspaceTargetKey(target) !== failedKey) return workspace;
    return {
      ...workspace,
      access: "none",
      connectionError: "workspace_reauthorization_denied"
    };
  });
}

function sameWorkspaceTarget(left: NativeWorkspace | undefined, right: NativeWorkspace | undefined, fallback?: DesktopWorkspaceConnection): boolean {
  const leftTarget = left ? targetForWorkspace(left, fallback) : undefined;
  const rightTarget = right ? targetForWorkspace(right, fallback) : undefined;
  return Boolean(leftTarget && rightTarget && leftTarget.connectionId === rightTarget.connectionId && leftTarget.workspaceId === rightTarget.workspaceId);
}

function directoryWorkspace(entry: DesktopWorkspaceDirectoryEntry, connection?: DesktopWorkspaceConnection): NativeWorkspace {
  const connectionId = entry.connectionId || connection?.id || "";
  const workspaceId = entry.workspaceId;
  const target = connectionId && workspaceId ? { connectionId, workspaceId } : undefined;
  const availability: NativeConnectionAvailability = entry.availability === "connected"
    || entry.availability === "reconnecting"
    || entry.availability === "offline"
    ? entry.availability
    : "unknown";
  return {
    id: workspaceId,
    ...(entry.organizationId ? { organizationId: entry.organizationId } : {}),
    name: entry.name || "名称未設定のWorkspace",
    state: entry.state === "archived" || entry.state === "read_only" ? entry.state : "active",
    access: entry.access === "none" ? "none" : "granted",
    ...(entry.role ? { role: entry.role } : {}),
    ...(entry.version === undefined ? {} : { version: entry.version }),
    ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    ...(target ? { target } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(entry.serverUrl || connection?.serverUrl ? { serverOrigin: entry.serverUrl ?? connection?.serverUrl } : {}),
    ...(entry.serverLabel || connection?.label ? { serverLabel: entry.serverLabel ?? connection?.label } : {}),
    ...(entry.accountId || connection?.accountId ? { accountId: entry.accountId ?? connection?.accountId } : {}),
    availability,
    ...(entry.error ? { connectionError: entry.error } : {})
  };
}

function directoryRows(value: unknown, fallbackConnection?: DesktopWorkspaceConnection): NativeWorkspace[] {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rows = Array.isArray(value) ? value : Array.isArray(body.workspaces) ? body.workspaces : [];
  return rows.map((entry) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const rawTarget = item.target && typeof item.target === "object" && !Array.isArray(item.target) ? item.target as Record<string, unknown> : {};
    const targetConnectionId = stringValue(rawTarget.connectionId ?? rawTarget.connection_id);
    const targetWorkspaceId = stringValue(rawTarget.workspaceId ?? rawTarget.workspace_id);
    const raw: DesktopWorkspaceDirectoryEntry = {
      connectionId: stringValue(item.connectionId ?? item.connection_id ?? targetConnectionId, fallbackConnection?.id ?? ""),
      workspaceId: stringValue(item.workspaceId ?? item.workspace_id ?? targetWorkspaceId ?? item.id),
      ...(targetConnectionId && targetWorkspaceId ? { target: { connectionId: targetConnectionId, workspaceId: targetWorkspaceId } } : {}),
      ...(typeof item.accountId === "string" || typeof item.account_id === "string" ? { accountId: stringValue(item.accountId ?? item.account_id) } : {}),
      ...(typeof item.serverUrl === "string" ? { serverUrl: item.serverUrl } : {}),
      ...(typeof item.serverLabel === "string" || typeof item.connectionLabel === "string" ? { serverLabel: stringValue(item.serverLabel ?? item.connectionLabel) } : {}),
      ...(typeof item.organizationId === "string" || typeof item.organization_id === "string" ? { organizationId: stringValue(item.organizationId ?? item.organization_id) } : {}),
      name: stringValue(item.name, fallbackConnection?.label ?? "名称未設定のWorkspace"),
      ...(item.state === "archived" || item.state === "read_only" || item.state === "active" ? { state: item.state } : {}),
      ...(item.role === "owner" || item.role === "admin" || item.role === "member" || item.role === "guest" ? { role: item.role } : {}),
      access: item.access === "none" || item.has_access === false || item.can_access === false ? "none" : "granted",
      ...(typeof item.version === "number" ? { version: item.version } : {}),
      ...(typeof item.createdAt === "string" || typeof item.created_at === "string" ? { createdAt: stringValue(item.createdAt ?? item.created_at) } : {}),
      ...(typeof item.updatedAt === "string" || typeof item.updated_at === "string" ? { updatedAt: stringValue(item.updatedAt ?? item.updated_at) } : {}),
      ...(item.availability === "connected" || item.availability === "reconnecting" || item.availability === "offline" ? { availability: item.availability } : {}),
      ...(typeof item.error === "string" ? { error: item.error } : {})
    };
    return directoryWorkspace(raw, fallbackConnection);
  }).filter((workspace) => workspace.id.length > 0);
}

function createdWorkspace(value: unknown, name: string, connection: DesktopWorkspaceConnection, workspaceId: string): NativeWorkspace {
  const body = record(value);
  const envelope = record(body.workspace ?? body.result ?? body.data);
  const source = Object.keys(envelope).length ? envelope : body;
  const id = stringValue(source.id ?? source.workspaceId ?? source.workspace_id, workspaceId);
  const entry: DesktopWorkspaceDirectoryEntry = {
    connectionId: connection.id,
    workspaceId: id,
    accountId: connection.accountId,
    serverUrl: connection.serverUrl,
    serverLabel: connection.label,
    ...(typeof source.organizationId === "string" || typeof source.organization_id === "string" ? { organizationId: stringValue(source.organizationId ?? source.organization_id) } : {}),
    name: stringValue(source.name, name),
    state: source.state === "archived" || source.state === "read_only" ? source.state : "active",
    access: "granted",
    ...(source.role === "owner" || source.role === "admin" || source.role === "member" || source.role === "guest" ? { role: source.role } : {}),
    ...(typeof source.version === "number" ? { version: source.version } : {}),
    availability: "connected"
  };
  return directoryWorkspace(entry, connection);
}

function directoryErrors(value: unknown): NativeWorkspaceDirectoryError[] {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const values = Array.isArray(body.errors) ? body.errors : [];
  return values.map((entry) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    return {
      connectionId: stringValue(item.connectionId ?? item.connection_id),
      ...(optionalString(item.serverOrigin ?? item.server_url) ? { serverOrigin: optionalString(item.serverOrigin ?? item.server_url) } : {}),
      ...(optionalString(item.serverLabel ?? item.server_label) ? { serverLabel: optionalString(item.serverLabel ?? item.server_label) } : {}),
      code: stringValue(item.code, "workspace_server_unreachable"),
      message: stringValue(item.message, "Workspace Serverに接続できません。")
    } satisfies NativeWorkspaceDirectoryError;
  }).filter((error) => error.connectionId.length > 0);
}

function isServerStatusSuccess(status: unknown): boolean {
  const body = status && typeof status === "object" && !Array.isArray(status) ? status as Record<string, unknown> : {};
  const workspace = body.workspace && typeof body.workspace === "object" && !Array.isArray(body.workspace) ? body.workspace as Record<string, unknown> : body;
  const code = workspace.status ?? workspace.statusCode ?? body.status;
  if (typeof code === "number") return code >= 200 && code < 300;
  if (typeof code === "string") return !/denied|forbidden|unauthori[sz]ed|offline|error/i.test(code);
  if (workspace.authorized === false || body.authorized === false || body.access === "none") return false;
  return true;
}

function transferTarget(value: unknown): NativeWorkspaceTarget | undefined {
  const item = record(value);
  const connectionId = optionalString(item.connectionId ?? item.connection_id);
  const workspaceId = optionalString(item.workspaceId ?? item.workspace_id);
  return connectionId && workspaceId ? { connectionId, workspaceId } : undefined;
}

function transferServerState(value: unknown): NativeWorkspaceTransferServerState | undefined {
  const state = stringValue(value).trim().toLowerCase();
  return state === "preparing" || state === "exported" || state === "imported" || state === "committed" || state === "rolled_back" || state === "failed"
    ? state
    : undefined;
}

function transferState(value: unknown): NativeWorkspaceTransferState | undefined {
  const state = stringValue(value).trim().toLowerCase();
  if (state === "preflight" || state === "exported" || state === "restoring" || state === "verified" || state === "cutover" || state === "source_archived" || state === "preparing" || state === "imported" || state === "committed" || state === "rolled_back" || state === "failed") return state;
  // Existing Desktop checkpoints may use the older local names. Keep those
  // values readable while the exact Server state is exposed separately.
  if (state === "restored") return "verified";
  if (state === "running") return "restoring";
  if (state === "archived") return "source_archived";
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function transferWorkspaceState(value: unknown): NativeWorkspaceTransferStatus["sourceWorkspaceState"] {
  const state = stringValue(value).trim().toLowerCase();
  return state === "active" || state === "read_only" || state === "archived" || state === "deleted" ? state : undefined;
}

function sha256Value(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

/**
 * Keep the Renderer copy short and conservative. In particular, a failed or
 * incomplete transfer never says that the source was deleted, and an archive
 * claim is made only when the Server explicitly confirms it.
 */
export function workspaceTransferStatusMessage(status: Pick<NativeWorkspaceTransferStatus, "state" | "serverState" | "sourceArchived" | "receiptPresent" | "targetRestored" | "targetCleanupRequired">): string {
  const state = status.serverState ?? status.state;
  if (state === "preflight") return "移転前の確認待ちです。";
  if (state === "preparing") return "移転の準備中です。移転元は保持されています。";
  if (state === "exported") return "Export済みです。移転元は保持されています。";
  if (state === "restoring") return "移転先へ復元中です。移転元は保持されています。";
  if (state === "imported") return status.receiptPresent === true
    ? "移転先へ復元済みです。受領確認を待っています。"
    : "移転先へ復元済みです。移転元は保持されています。";
  if (state === "verified") return "移転先の整合性を確認済みです。切替待ちです。";
  if (state === "cutover") return status.sourceArchived === true
    ? "移転完了。移転元はArchive済みです。"
    : "接続先を切替済みです。移転元のArchive確認を待っています。";
  if (state === "committed" || state === "source_archived") return (status.sourceArchived === true || state === "source_archived")
    ? "移転完了。移転元はArchive済みです。"
    : "移転完了を確認中です。移転元は保持されています。";
  if (state === "rolled_back") return "移転を安全に取り消しました。移転元は保持されています。";
  if (status.targetCleanupRequired || status.targetRestored) return "移転が途中で停止しました。移転元は保持されています。移転先の確認が必要です。";
  return "移転に失敗しました。移転元は保持されています。";
}

function transferPreflightFromUnknown(value: unknown, source: NativeWorkspaceTarget, destination: NativeWorkspaceTarget, workspace: NativeWorkspace): NativeWorkspaceTransferPreflight {
  const body = record(value);
  const nested = record(body.preflight ?? body.result ?? body.data);
  const sourceTarget = transferTarget(nested.source ?? nested.source_target) ?? source;
  const destinationTarget = transferTarget(nested.destination ?? nested.destination_target ?? nested.target) ?? destination;
  const transferId = optionalString(nested.transferId ?? nested.transfer_id ?? body.transferId ?? body.transfer_id ?? body.id);
  if (!transferId) throw new Error("workspace_transfer_preflight_invalid");
  const rawFailureConditions = nested.failureConditions ?? nested.failure_conditions;
  const failureConditions = Array.isArray(rawFailureConditions)
    ? rawFailureConditions.filter((item: unknown): item is string => typeof item === "string")
    : [];
  const dataByteSize = typeof nested.dataByteSize === "number" ? nested.dataByteSize : typeof nested.byte_size === "number" ? nested.byte_size : undefined;
  const sourceVersion = typeof nested.sourceVersion === "number" ? nested.sourceVersion : typeof nested.source_version === "number" ? nested.source_version : workspace.version;
  return {
    transferId,
    source: sourceTarget,
    destination: destinationTarget,
    workspaceId: optionalString(nested.workspaceId ?? nested.workspace_id) ?? workspace.id,
    ...(optionalString(nested.workspaceName ?? nested.workspace_name) ? { workspaceName: optionalString(nested.workspaceName ?? nested.workspace_name) } : { workspaceName: workspace.name }),
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    ...(dataByteSize === undefined ? {} : { dataByteSize }),
    writeBlocked: nested.writeBlocked === true || nested.write_blocked === true,
    organizationReleased: nested.organizationReleased === true || nested.organization_released === true,
    sourceWillArchive: nested.sourceWillArchive !== false && nested.source_will_archive !== false,
    failureConditions,
    ...(optionalString(nested.expiresAt ?? nested.expires_at) ? { expiresAt: optionalString(nested.expiresAt ?? nested.expires_at) } : {})
  };
}

export function workspaceTransferStatusFromUnknown(value: unknown, fallback: { transferId: string; source: NativeWorkspaceTarget; destination: NativeWorkspaceTarget; workspace: NativeWorkspace }): NativeWorkspaceTransferStatus {
  const body = record(value);
  const nested = record(body.status ?? body.result ?? body.data);
  const field = (...keys: string[]): unknown => keys.map((key) => nested[key] ?? body[key]).find((candidate) => candidate !== undefined);
  const source = transferTarget(field("source", "source_target")) ?? fallback.source;
  const destination = transferTarget(field("destination", "destination_target", "target")) ?? fallback.destination;
  const transferId = optionalString(field("transferId", "transfer_id", "id")) ?? fallback.transferId;
  const rawState = field("state", "status") ?? (typeof body.status === "string" ? body.status : undefined);
  const state = transferState(rawState);
  if (!state) throw new Error("workspace_transfer_status_invalid");
  const serverState = transferServerState(rawState);
  const workspaceId = optionalString(field("workspaceId", "workspace_id")) ?? fallback.workspace.id;
  const sourceWorkspaceId = optionalString(field("sourceWorkspaceId", "source_workspace_id"));
  const targetWorkspaceId = optionalString(field("targetWorkspaceId", "target_workspace_id"));
  if (transferId !== fallback.transferId
    || nativeWorkspaceTargetKey(source) !== nativeWorkspaceTargetKey(fallback.source)
    || nativeWorkspaceTargetKey(destination) !== nativeWorkspaceTargetKey(fallback.destination)
    || workspaceId !== source.workspaceId
    || (sourceWorkspaceId && sourceWorkspaceId !== source.workspaceId)
    || (targetWorkspaceId && targetWorkspaceId !== destination.workspaceId)) {
    throw new Error("workspace_transfer_status_target_mismatch");
  }
  const byteSize = typeof field("dataByteSize", "byte_size") === "number" ? field("dataByteSize", "byte_size") as number : undefined;
  const sourceIntegrityHash = sha256Value(field("sourceIntegrityHash", "source_integrity_hash", "bundleHash", "bundle_hash"));
  const targetIntegrityHash = sha256Value(field("targetIntegrityHash", "target_integrity_hash"));
  const integrityHash = sha256Value(field("integrityHash", "integrity_hash")) ?? sourceIntegrityHash;
  const failureCode = optionalString(field("failureCode", "failure_code", "error_code"));
  const receiptPresent = booleanValue(field("receiptPresent", "receipt_present"));
  const sourceWorkspaceState = transferWorkspaceState(field("sourceWorkspaceState", "source_workspace_state"));
  const sourceArchived = booleanValue(field("sourceArchived", "source_archived"))
    ?? (sourceWorkspaceState === "archived" || sourceWorkspaceState === "deleted" || state === "source_archived" ? true : undefined);
  const targetRestored = booleanValue(field("targetRestored", "target_restored"));
  const targetCleanupRequired = booleanValue(field("targetCleanupRequired", "target_cleanup_required"));
  return {
    transferId,
    source,
    destination,
    state,
    ...(serverState ? { serverState } : {}),
    workspaceId,
    ...(optionalString(field("workspaceName", "workspace_name")) ? { workspaceName: optionalString(field("workspaceName", "workspace_name")) } : { workspaceName: fallback.workspace.name }),
    ...(byteSize === undefined ? {} : { dataByteSize: byteSize }),
    ...(typeof field("writeBlocked", "write_blocked") === "boolean" ? { writeBlocked: field("writeBlocked", "write_blocked") as boolean } : {}),
    ...(typeof field("organizationReleased", "organization_released") === "boolean" ? { organizationReleased: field("organizationReleased", "organization_released") as boolean } : {}),
    ...(sourceArchived === undefined ? {} : { sourceArchived }),
    ...(sourceWorkspaceState ? { sourceWorkspaceState } : {}),
    ...(receiptPresent === undefined ? {} : { receiptPresent }),
    ...(targetWorkspaceId ? { targetWorkspaceId } : {}),
    ...(targetRestored === undefined ? {} : { targetRestored }),
    ...(targetCleanupRequired === undefined ? {} : { targetCleanupRequired }),
    ...(sourceIntegrityHash ? { sourceIntegrityHash } : {}),
    ...(targetIntegrityHash ? { targetIntegrityHash } : {}),
    ...(integrityHash ? { integrityHash } : {}),
    ...(failureCode ? { failureCode } : {}),
    message: workspaceTransferStatusMessage({ state, ...(serverState ? { serverState } : {}), ...(sourceArchived === undefined ? {} : { sourceArchived }), ...(receiptPresent === undefined ? {} : { receiptPresent }), ...(targetRestored === undefined ? {} : { targetRestored }), ...(targetCleanupRequired === undefined ? {} : { targetCleanupRequired }) }),
    ...(optionalString(field("updatedAt", "updated_at")) ? { updatedAt: optionalString(field("updatedAt", "updated_at")) } : {})
  };
}

/**
 * Desktop persists only non-sensitive transfer metadata. Accept both the
 * current array response and an envelope so a restarted renderer can resume
 * showing progress without receiving credentials or Bundle bytes.
 */
function transferStatusesFromCheckpoint(value: unknown): NativeWorkspaceTransferStatus[] {
  const body = record(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(body.transfers)
      ? body.transfers
      : Array.isArray(body.workspaceTransfers)
        ? body.workspaceTransfers
        : Array.isArray(body.workspace_transfers)
          ? body.workspace_transfers
          : [];
  return rows.flatMap((entry) => {
    const raw = record(entry);
    const nested = record(raw.status ?? raw.result ?? raw.data);
    const source = transferTarget(nested.source ?? nested.source_target) ?? transferTarget(raw.source ?? raw.source_target);
    const destination = transferTarget(nested.destination ?? nested.destination_target ?? nested.target)
      ?? transferTarget(raw.destination ?? raw.destination_target ?? raw.target);
    const transferId = optionalString(nested.transferId ?? nested.transfer_id ?? raw.transferId ?? raw.transfer_id ?? raw.id);
    const workspaceId = optionalString(nested.workspaceId ?? nested.workspace_id ?? raw.workspaceId ?? raw.workspace_id) ?? source?.workspaceId;
    if (!source || !destination || !transferId || !workspaceId) return [];
    try {
      return [workspaceTransferStatusFromUnknown(entry, {
        transferId,
        source,
        destination,
        workspace: {
          id: workspaceId,
          name: optionalString(nested.workspaceName ?? nested.workspace_name ?? raw.workspaceName ?? raw.workspace_name) ?? workspaceId,
          state: "active",
          access: "granted",
          target: source,
          connectionId: source.connectionId
        }
      })];
    } catch {
      return [];
    }
  });
}

export function workspaceConnectionStateFromUnknown(value: unknown, fallback: DesktopWorkspaceConnectionState): DesktopWorkspaceConnectionState {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const nested = body.connectionState && typeof body.connectionState === "object" ? body.connectionState : body.state;
  const source = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : body;
  const connections = Array.isArray(source.connections) ? source.connections.filter((item): item is DesktopWorkspaceConnection => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const candidate = item as Record<string, unknown>;
    return typeof candidate.id === "string" && typeof candidate.label === "string" && typeof candidate.serverUrl === "string" && typeof candidate.accountId === "string";
  }) : undefined;
  if (!connections) return fallback;
  const rawTarget = source.activeTarget;
  const parsedTarget = rawTarget && typeof rawTarget === "object" && !Array.isArray(rawTarget)
    && typeof (rawTarget as Record<string, unknown>).connectionId === "string"
    && typeof (rawTarget as Record<string, unknown>).workspaceId === "string"
    ? { connectionId: String((rawTarget as Record<string, unknown>).connectionId), workspaceId: String((rawTarget as Record<string, unknown>).workspaceId) }
    : undefined;
  const explicitConnectionId = typeof source.activeConnectionId === "string" && connections.some((connection) => connection.id === source.activeConnectionId)
    ? source.activeConnectionId
    : undefined;
  const activeConnectionId = explicitConnectionId ?? parsedTarget?.connectionId;
  const activeTarget = parsedTarget
    && connections.some((connection) => connection.id === parsedTarget.connectionId)
    && (!activeConnectionId || activeConnectionId === parsedTarget.connectionId)
    ? parsedTarget
    : undefined;
  return { ...(activeConnectionId ? { activeConnectionId } : {}), ...(activeTarget ? { activeTarget } : {}), connections };
}

type WorkspaceDirectoryStateSnapshot = Pick<DesktopWorkspaceConnectionState, "activeConnectionId" | "activeTarget" | "connections">;

/**
 * A directory response is scoped to the complete connection selection, not
 * just the list of connection IDs.  Keep the snapshot deterministic so a
 * response for Server A cannot be committed after Server B was selected, even
 * when both Servers expose the same Workspace ID.
 */
export function workspaceDirectoryStateFingerprint(state: WorkspaceDirectoryStateSnapshot): string {
  return JSON.stringify({
    activeConnectionId: state.activeConnectionId ?? null,
    activeTarget: state.activeTarget
      ? { connectionId: state.activeTarget.connectionId, workspaceId: state.activeTarget.workspaceId }
      : null,
    connections: [...state.connections]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((connection) => ({
        id: connection.id,
        label: connection.label,
        serverUrl: connection.serverUrl,
        accountId: connection.accountId,
        workspaceId: connection.workspaceId ?? null,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt
      }))
  });
}

export interface WorkspaceDirectoryRequestStamp {
  generation: number;
  stateFingerprint: string;
}

/** Return true only while the directory request still belongs to current state. */
export function workspaceDirectoryRequestIsCurrent(
  request: WorkspaceDirectoryRequestStamp,
  currentGeneration: number,
  currentState: WorkspaceDirectoryStateSnapshot
): boolean {
  return request.generation === currentGeneration
    && request.stateFingerprint === workspaceDirectoryStateFingerprint(currentState);
}

function nativeRoom(room: DesktopWorkspaceRoom): NativeRoom {
  const roomCapabilities = room as DesktopWorkspaceRoom & { canExecute?: boolean };
  return {
    id: room.id,
    workspaceId: room.workspaceId,
    name: room.name,
    ...(room.parentRoomId ? { parentRoomId: room.parentRoomId } : {}),
    ...(roomCapabilities.canExecute === undefined ? {} : { canExecute: roomCapabilities.canExecute }),
    ...(room.canManage === undefined ? {} : { canManage: room.canManage }),
    version: room.version,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

function nativeRooms(value: unknown): NativeRoom[] {
  const body = record(value);
  const rows = Array.isArray(value) ? value : Array.isArray(body.rooms) ? body.rooms : [];
  return rows.map((entry) => {
    const room = record(entry);
    return {
      id: stringValue(room.id ?? room.room_id),
      workspaceId: stringValue(room.workspace_id),
      name: stringValue(room.name, "名称未設定のRoom"),
      ...(optionalString(room.parent_room_id ?? room.parentRoomId) ? { parentRoomId: optionalString(room.parent_room_id ?? room.parentRoomId) } : {}),
      ...(typeof room.can_execute === "boolean" ? { canExecute: room.can_execute } : {}),
      ...(typeof room.can_manage === "boolean" ? { canManage: room.can_manage } : {}),
      ...(typeof room.version === "number" ? { version: room.version } : {}),
      ...(optionalString(room.created_at) ? { createdAt: optionalString(room.created_at) } : {}),
      ...(optionalString(room.updated_at) ? { updatedAt: optionalString(room.updated_at) } : {})
    } satisfies NativeRoom;
  }).filter((room) => room.id.length > 0);
}

function legacyWorkspace(status: unknown, connection: DesktopWorkspaceConnection): NativeWorkspace {
  const statusBody = record(status);
  const workspaceEnvelope = record(statusBody.workspace);
  const body = record(workspaceEnvelope.body ?? workspaceEnvelope);
  const workspace = record(body.workspace ?? body);
  const state = workspace.state === "archived" || workspace.state === "read_only" ? workspace.state : "active";
  const role = workspace.role === "owner" || workspace.role === "admin" || workspace.role === "member" || workspace.role === "guest" ? workspace.role : "member";
  return {
    id: stringValue(workspace.id, connection.workspaceId ?? ""),
    name: stringValue(workspace.name ?? workspace.workspace_name, connection.label),
    state,
    access: "granted",
    role,
    ...(typeof workspace.version === "number" ? { version: workspace.version } : {}),
    ...(optionalString(workspace.created_at) ? { createdAt: optionalString(workspace.created_at) } : {}),
    ...(optionalString(workspace.updated_at) ? { updatedAt: optionalString(workspace.updated_at) } : {}),
    ...(connection.id && stringValue(workspace.id, connection.workspaceId ?? "") ? {
      target: { connectionId: connection.id, workspaceId: stringValue(workspace.id, connection.workspaceId ?? "") },
      connectionId: connection.id,
      serverOrigin: connection.serverUrl,
      serverLabel: connection.label,
      accountId: connection.accountId,
      availability: "connected" as const
    } : {})
  };
}

function nativeMessage(message: MessageRecord): NativeChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at
  };
}

const streamingAgentMessagePrefix = "streaming-agent:";

/**
 * A chat request may be admitted just before the first polling attempt. Keep
 * the lookup strict so an older run, or a run from another Session, can never
 * be rendered as the answer to the current request.
 */
export function backendRunForChatRequest(
  runs: BackendRunRecord[],
  sessionId: string,
  idempotencyKey: string
): BackendRunRecord | undefined {
  return runs
    .filter((run) => run.session_id === sessionId && run.request_idempotency_key === idempotencyKey)
    .sort((left, right) => {
      const leftStarted = Date.parse(left.started_at);
      const rightStarted = Date.parse(right.started_at);
      if (Number.isFinite(rightStarted) && Number.isFinite(leftStarted) && rightStarted !== leftStarted) return rightStarted - leftStarted;
      return right.id.localeCompare(left.id);
    })[0];
}

/**
 * Project only persisted `text_delta` events into the visible answer. The
 * Server may return events in an arbitrary transport order and a realtime
 * notification can cause the same event to be observed more than once.
 */
export function textDeltaContentForRun(events: BackendEventRecord[], runId: string): string {
  const ordered = events
    .filter((event) => event.run_id === runId && event.event_type === "text_delta")
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const seenEventIds = new Set<string>();
  const text: string[] = [];
  for (const event of ordered) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};
    if (typeof payload.text === "string" && payload.text.length > 0) text.push(payload.text);
  }
  return text.join("");
}

export function streamingAgentMessageFromBackendEvents(run: BackendRunRecord, events: BackendEventRecord[]): NativeChatMessage {
  return {
    id: `${streamingAgentMessagePrefix}${run.id}`,
    role: "agent",
    content: textDeltaContentForRun(events, run.id),
    createdAt: run.started_at,
    pending: true
  };
}

function isStreamingAgentMessage(message: NativeChatMessage): boolean {
  return message.id.startsWith(streamingAgentMessagePrefix);
}

function withEvidence(messages: NativeChatMessage[], evidence: NativeEvidenceBundle): NativeChatMessage[] {
  const refs = [
    ...evidence.activity.map((item) => ({ id: item.id, kind: "activity" as const, label: item.title || item.id, status: item.severity, createdAt: item.created_at })),
    ...evidence.artifacts.map((item) => ({ id: item.id, kind: "file" as const, label: item.title || item.id, status: item.kind })),
    ...evidence.memories.map((item) => ({ id: item.id, kind: "knowledge" as const, label: item.title || item.id, status: item.state }))
  ];
  if (!refs.length) return messages;
  return messages.map((message) => message.role === "agent" ? { ...message, evidence: refs } : message);
}

function evidenceFromDetail(detail: SessionDetail): NativeEvidenceBundle {
  return {
    activity: detail.activity,
    backendRuns: detail.backendRuns,
    artifacts: detail.artifacts.map((artifact) => ({ id: artifact.id, title: artifact.title, kind: artifact.kind })),
    memories: detail.memory.map((memory) => ({ id: memory.id, title: memory.topic, state: memory.state }))
  };
}

function evidenceFromResult(result: { activity: ActivityInboxItem[]; backendRun: BackendRunRecord; artifacts: ArtifactRecord[]; memories: MemoryFrontmatter[] }): NativeEvidenceBundle {
  return {
    activity: result.activity,
    backendRuns: result.backendRun ? [result.backendRun] : [],
    artifacts: result.artifacts.map((artifact) => ({ id: artifact.id, title: artifact.title, kind: artifact.kind })),
    memories: result.memories.map((memory) => ({ id: memory.id, title: memory.topic, state: memory.state }))
  };
}

export function useNativeApp() {
  const bridge = useMemo(() => getWorkspaceClientBridge(), []);
  const organizationApi = useMemo(() => createOrganizationApi(), []);
  const browserMode = typeof window !== "undefined" && !window.samuraiDesktop;

  const [connectionState, setConnectionState] = useState<DesktopWorkspaceConnectionState>({ connections: [] });
  const [connection, setConnection] = useState<DesktopWorkspaceConnection>();
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [transportState, setTransportState] = useState<"connected" | "reconnecting" | "offline">("reconnecting");
  const [organizations, setOrganizations] = useState<NativeOrganization[]>([]);
  const [organizationLoading, setOrganizationLoading] = useState(false);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [organizationApiAvailable, setOrganizationApiAvailable] = useState(true);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string>();
  const [workspaces, setWorkspaces] = useState<NativeWorkspace[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceDirectoryErrors, setWorkspaceDirectoryErrors] = useState<NativeWorkspaceDirectoryError[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [selectedWorkspaceTargetKey, setSelectedWorkspaceTargetKey] = useState<string>();
  const [rooms, setRooms] = useState<NativeRoom[]>([]);
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  const [chatLoading, setChatLoading] = useState(false);
  const [messages, setMessages] = useState<NativeChatMessage[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [evidence, setEvidence] = useState<NativeEvidenceBundle>({ activity: [], backendRuns: [], artifacts: [], memories: [] });
  const [evidenceMessage, setEvidenceMessage] = useState<NativeChatMessage>();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [members, setMembers] = useState<NativeOrganizationMember[]>([]);
  const [invitations, setInvitations] = useState<NativeOrganizationInvitation[]>([]);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [workspaceTransferPreflight, setWorkspaceTransferPreflight] = useState<NativeWorkspaceTransferPreflight>();
  const [workspaceTransferStatus, setWorkspaceTransferStatus] = useState<NativeWorkspaceTransferStatus>();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0);
  const initializedConnection = useRef(false);
  const activationSequence = useRef(0);
  const workspaceDirectoryGeneration = useRef(0);
  const connectionOperationGeneration = useRef(0);
  const connectionStateRef = useRef(connectionState);
  const connectionRef = useRef(connection);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const chatStreamGeneration = useRef(0);
  const chatStreamPolling = useRef<{ stop: () => void } | undefined>(undefined);
  connectionStateRef.current = connectionState;
  connectionRef.current = connection;

  const selectedOrganization = organizations.find((organization) => organization.id === selectedOrganizationId);
  const selectedWorkspace = workspaces.find((workspace) => {
    const target = targetForWorkspace(workspace, connection);
    return selectedWorkspaceTargetKey
      ? Boolean(target && nativeWorkspaceTargetKey(target) === selectedWorkspaceTargetKey)
      : workspace.id === selectedWorkspaceId;
  });
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const selectedWorkspaceTarget = selectedWorkspace ? targetForWorkspace(selectedWorkspace, connectionRef.current) : undefined;
  const chatContextTargetKey = selectedWorkspaceTargetKey
    ?? (selectedWorkspaceTarget ? nativeWorkspaceTargetKey(selectedWorkspaceTarget) : undefined);
  const chatContextRef = useRef<{ workspaceTargetKey?: string; roomId?: string }>({});
  chatContextRef.current = {
    workspaceTargetKey: chatContextTargetKey,
    roomId: selectedRoomId
  };

  const stopChatStreamPolling = useCallback((): void => {
    const polling = chatStreamPolling.current;
    chatStreamPolling.current = undefined;
    polling?.stop();
  }, []);

  const setCurrentActiveRunId = useCallback((runId: string | undefined): void => {
    activeRunIdRef.current = runId;
    setActiveRunId(runId);
  }, []);

  const invalidateChatStream = useCallback((): void => {
    chatStreamGeneration.current += 1;
    stopChatStreamPolling();
    setCurrentActiveRunId(undefined);
  }, [setCurrentActiveRunId, stopChatStreamPolling]);

  const invalidateWorkspaceDirectory = useCallback((): void => {
    workspaceDirectoryGeneration.current += 1;
  }, []);

  const beginConnectionOperation = useCallback((): number => {
    const operationId = ++connectionOperationGeneration.current;
    invalidateWorkspaceDirectory();
    return operationId;
  }, [invalidateWorkspaceDirectory]);

  const applyConnectionState = useCallback((nextState: DesktopWorkspaceConnectionState): DesktopWorkspaceConnection | undefined => {
    const active = connectionFromState(nextState);
    invalidateWorkspaceDirectory();
    connectionStateRef.current = nextState;
    connectionRef.current = active;
    setConnectionState(nextState);
    setConnection(active);
    setConnectionError(null);
    setTransportState(active ? "connected" : "offline");
    return active;
  }, [invalidateWorkspaceDirectory]);

  const clearSelectedConnectionContent = useCallback((): void => {
    // A manually chosen Server must not be overwritten by a late Room or
    // Workspace activation from the previously selected Server.
    activationSequence.current += 1;
    invalidateChatStream();
    invalidateWorkspaceDirectory();
    setSending(false);
    setSelectedOrganizationId(undefined);
    setOrganizations([]);
    setOrganizationError(null);
    setSelectedWorkspaceId(undefined);
    setSelectedWorkspaceTargetKey(undefined);
    setWorkspaceError(null);
    setRooms([]);
    setSelectedRoomId(undefined);
    setActiveWorkspaceRoomId(undefined);
    setRoomError(null);
    setMessages([]);
    setSessionId(undefined);
    setChatError(null);
    setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
    setWorkspaceTransferPreflight(undefined);
    setWorkspaceTransferStatus(undefined);
  }, [invalidateChatStream, invalidateWorkspaceDirectory]);

  const refreshConnections = useCallback(async (): Promise<void> => {
    const operationId = beginConnectionOperation();
    if (!bridge?.listWorkspaceConnections) {
      if (operationId === connectionOperationGeneration.current) {
        setConnectionLoading(false);
        setConnectionError("Workspace Server bridgeが利用できません。");
        setTransportState("offline");
      }
      return;
    }
    setConnectionLoading(true);
    try {
      const state = await bridge.listWorkspaceConnections();
      if (operationId !== connectionOperationGeneration.current) return;
      applyConnectionState(state);
    } catch (error) {
      if (operationId !== connectionOperationGeneration.current) return;
      setConnectionError(userFacingError(error, "接続先を確認できませんでした。"));
      setTransportState("offline");
    } finally {
      if (operationId === connectionOperationGeneration.current) setConnectionLoading(false);
    }
  }, [applyConnectionState, beginConnectionOperation, bridge]);

  useEffect(() => {
    if (initializedConnection.current) return;
    initializedConnection.current = true;
    void refreshConnections();
  }, [refreshConnections]);

  const loadOrganizations = useCallback(async (active: DesktopWorkspaceConnection): Promise<void> => {
    setOrganizationLoading(true);
    setOrganizationError(null);
    try {
      const values = await organizationApi.listOrganizations();
      const decorated = values.map((organization) => ({
        ...organization,
        connectionId: active.id,
        serverOrigin: active.serverUrl
      }));
      setOrganizationApiAvailable(true);
      setOrganizations(decorated);
      // Organization is a secondary control plane. An empty result is a
      // normal state and must never clear the Workspace directory.
      const candidate = readNativeSelectionCandidate(active);
      setSelectedOrganizationId((current) => {
        if (current && decorated.some((organization) => organization.id === current)) return current;
        return candidate?.organizationId && decorated.some((organization) => organization.id === candidate.organizationId)
          ? candidate.organizationId
          : undefined;
      });
    } catch (error) {
      setOrganizationApiAvailable(false);
      setOrganizations([]);
      setSelectedOrganizationId(undefined);
      // A control-plane outage is local to Organization management. Keep the
      // account-scoped Workspace directory and content navigation available.
      setOrganizationError(userFacingError(error, "Organization管理情報を確認できませんでした。"));
    } finally {
      setOrganizationLoading(false);
    }
  }, [organizationApi]);

  const loadWorkspaceDirectory = useCallback(async (state: DesktopWorkspaceConnectionState): Promise<void> => {
    const request: WorkspaceDirectoryRequestStamp = {
      generation: ++workspaceDirectoryGeneration.current,
      stateFingerprint: workspaceDirectoryStateFingerprint(state)
    };
    const isCurrentRequest = (): boolean => workspaceDirectoryRequestIsCurrent(
      request,
      workspaceDirectoryGeneration.current,
      connectionStateRef.current
    );
    const connections = state.connections;
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    setWorkspaceDirectoryErrors([]);
    try {
      let result: DesktopWorkspaceDirectoryResult | undefined;
      if (bridge?.listWorkspaceDirectory) {
        try {
          result = await bridge.listWorkspaceDirectory();
        } catch {
          // Older Desktop builds may expose only the per-connection method.
        }
      }
      if (!isCurrentRequest()) return;
      if (!result && bridge?.listWorkspaceAccountWorkspaces) {
        const rows: DesktopWorkspaceDirectoryEntry[] = [];
        const errors: NativeWorkspaceDirectoryError[] = [];
        await Promise.all(connections.map(async (candidateConnection) => {
          try {
            const response = await bridge.listWorkspaceAccountWorkspaces?.({ connectionId: candidateConnection.id });
            rows.push(...directoryRows(response, candidateConnection).map((workspace) => ({
              connectionId: candidateConnection.id,
              workspaceId: workspace.id,
              accountId: candidateConnection.accountId,
              serverUrl: candidateConnection.serverUrl,
              serverLabel: candidateConnection.label,
              ...(workspace.organizationId ? { organizationId: workspace.organizationId } : {}),
              name: workspace.name,
              state: workspace.state,
              role: workspace.role,
              access: workspace.access,
              version: workspace.version,
              createdAt: workspace.createdAt,
              updatedAt: workspace.updatedAt,
              availability: workspace.availability,
              ...(workspace.connectionError ? { error: workspace.connectionError } : {})
            })));
          } catch (error) {
            errors.push({
              connectionId: candidateConnection.id,
              serverOrigin: candidateConnection.serverUrl,
              serverLabel: candidateConnection.label,
              code: errorCode(error),
              message: userFacingError(error, "Workspace Serverに接続できません。")
            });
          }
        }));
        if (!isCurrentRequest()) return;
        result = { workspaces: rows, ...(errors.length ? { errors } : {}) };
      }
      if (!result) {
        // Last-resort compatibility for pre-directory bridges: only the
        // explicit legacy Workspace mirror may be shown, and it is still
        // re-authorized by activateWorkspace before any Room/content read.
        const rows = connections
          .filter((candidateConnection) => Boolean(candidateConnection.workspaceId))
          .map((candidateConnection) => legacyWorkspace({ workspace: { id: candidateConnection.workspaceId, name: candidateConnection.label } }, candidateConnection));
        result = { workspaces: rows.map((workspace) => ({
          connectionId: workspace.connectionId ?? "",
          workspaceId: workspace.id,
          accountId: workspace.accountId,
          serverUrl: workspace.serverOrigin,
          serverLabel: workspace.serverLabel,
          name: workspace.name,
          state: workspace.state,
          role: workspace.role,
          access: workspace.access,
          version: workspace.version,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          availability: workspace.availability
        })) };
      }
      if (!isCurrentRequest()) return;
      const resultErrors = directoryErrors(result);
      const fallbackById = new Map(connections.map((candidateConnection) => [candidateConnection.id, candidateConnection]));
      const normalized = directoryRows(result, undefined).map((workspace) => {
        const candidateConnection = workspace.connectionId ? fallbackById.get(workspace.connectionId) : undefined;
        return candidateConnection && !workspace.serverLabel
          ? directoryWorkspace({
            connectionId: candidateConnection.id,
            workspaceId: workspace.id,
            accountId: candidateConnection.accountId,
            serverUrl: candidateConnection.serverUrl,
            serverLabel: candidateConnection.label,
            name: workspace.name,
            state: workspace.state,
            role: workspace.role,
            access: workspace.access,
            version: workspace.version,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
            availability: workspace.availability,
            ...(workspace.connectionError ? { error: workspace.connectionError } : {})
          }, candidateConnection)
          : workspace;
      });
      const unique = new Map<string, NativeWorkspace>();
      normalized.forEach((workspace) => {
        const target = targetForWorkspace(workspace, workspace.connectionId ? fallbackById.get(workspace.connectionId) : undefined);
        if (!target) return;
        const key = nativeWorkspaceTargetKey(target);
        if (!unique.has(key)) unique.set(key, { ...workspace, target, connectionId: target.connectionId });
      });
      const nextWorkspaces = [...unique.values()].sort((left, right) => left.name.localeCompare(right.name, "ja") || nativeWorkspaceTargetKey(targetForWorkspace(left)!).localeCompare(nativeWorkspaceTargetKey(targetForWorkspace(right)!)));
      if (!isCurrentRequest()) return;
      setWorkspaces(nextWorkspaces);
      setWorkspaceDirectoryErrors(resultErrors);
      if (bridge?.listWorkspaceTransfers) {
        try {
          const checkpointStatuses = transferStatusesFromCheckpoint(await bridge.listWorkspaceTransfers());
          if (!isCurrentRequest()) return;
          const matchingStatus = checkpointStatuses.find((status) => nextWorkspaces.some((workspace) => {
            const target = targetForWorkspace(workspace, fallbackById.get(workspace.connectionId ?? ""));
            return target && nativeWorkspaceTargetKey(target) === nativeWorkspaceTargetKey(status.source);
          }));
          setWorkspaceTransferStatus(matchingStatus ?? checkpointStatuses[0]);
        } catch {
          // A checkpoint is a convenience for resuming the UI. An unavailable
          // ledger must not block the Workspace directory or hide content.
          if (isCurrentRequest()) setWorkspaceTransferStatus(undefined);
        }
      }
      if (!isCurrentRequest()) return;
      const preferredTarget = preferredWorkspaceTargetForState(state, connections);
      const selected = (preferredTarget
        ? nextWorkspaces.find((workspace) => {
          const target = targetForWorkspace(workspace);
          return target && target.connectionId === preferredTarget.connectionId && target.workspaceId === preferredTarget.workspaceId && workspace.access === "granted";
        })
        : undefined)
        // An explicit Server selection without an active Workspace must not
        // silently activate a Workspace on another Server. This also keeps
        // the selected Account stable while its identity is imported.
        ?? nextWorkspaces.find((workspace) => workspace.access === "granted" && workspace.connectionId === state.activeConnectionId);
      setSelectedWorkspaceTargetKey(selected ? nativeWorkspaceTargetKey(targetForWorkspace(selected)!) : undefined);
      setSelectedWorkspaceId(selected?.id);
      if (!selected) {
        setRooms([]);
        setSelectedRoomId(undefined);
        setActiveWorkspaceRoomId(undefined);
      }
      if (nextWorkspaces.length > 0 || resultErrors.length === 0) {
        setTransportState(resultErrors.length > 0 && nextWorkspaces.length === 0 ? "offline" : "connected");
      }
      if (!nextWorkspaces.length && resultErrors.length) {
        setWorkspaceError("接続済みWorkspaceを確認できません。Serverごとの状態を確認してください。");
      } else if (resultErrors.length) {
        setWorkspaceError("一部のWorkspace Serverに接続できません。利用できるServerはそのまま使えます。");
      }
    } catch (error) {
      if (!isCurrentRequest()) return;
      setWorkspaces([]);
      setSelectedWorkspaceId(undefined);
      setSelectedWorkspaceTargetKey(undefined);
      setRooms([]);
      setSelectedRoomId(undefined);
      setActiveWorkspaceRoomId(undefined);
      setWorkspaceError(userFacingError(error, "Workspace一覧を確認できませんでした。"));
      setTransportState(isPermissionError(error) ? "offline" : "reconnecting");
    } finally {
      if (isCurrentRequest()) setWorkspaceLoading(false);
    }
  }, [bridge]);

  const connectionDirectoryKey = useMemo(() => connectionState.connections.map((candidate) => candidate.id).sort().join("\n"), [connectionState.connections]);

  useEffect(() => {
    if (!connectionState.connections.length) return;
    void loadWorkspaceDirectory(connectionState);
  }, [connectionDirectoryKey, loadWorkspaceDirectory, refreshNonce]);

  useEffect(() => {
    if (!connection) return;
    void loadOrganizations(connection);
  }, [connection?.id, connection?.serverUrl, connection?.accountId, loadOrganizations, refreshNonce]);

  // The public Organization projection intentionally contains no membership
  // role. Resolve the current Account's role separately so Owner/Admin UI is
  // enabled only after Server authorization, never from a local candidate.
  useEffect(() => {
    if (!connection || !selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    let cancelled = false;
    void organizationApi.listMembers(selectedOrganizationId).then((values) => {
      if (cancelled) return;
      const membership = values.find((member) => member.accountId === connection.accountId && member.state === "active");
      if (!membership) return;
      setOrganizations((current) => current.map((organization) => organization.id === selectedOrganizationId
        ? { ...organization, role: membership.role }
        : organization));
    }).catch(() => {
      // A member projection may be unavailable to a Guest. The safe default
      // remains member, which only removes management affordances.
    });
    return () => {
      cancelled = true;
    };
  }, [connection, organizationApi, selectedOrganizationId, refreshNonce]);

  const activateWorkspace = useCallback(async (workspace: NativeWorkspace): Promise<void> => {
    const activeConnection = connectionRef.current;
    const target = targetForWorkspace(workspace, activeConnection);
    if (!bridge || !target || workspace.access !== "granted") return;
    const activationId = ++activationSequence.current;
    invalidateChatStream();
    setSending(false);
    setRoomLoading(true);
    setRoomError(null);
    setChatError(null);
    // Never leave content from the previous target visible while the new
    // connection is being selected and re-authorized.
    setRooms([]);
    setSelectedRoomId(undefined);
    setActiveWorkspaceRoomId(undefined);
    setMessages([]);
    setSessionId(undefined);
    setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
    try {
      let nextState = connectionStateRef.current;
      if (bridge.selectWorkspaceTarget) {
        nextState = workspaceConnectionStateFromUnknown(await bridge.selectWorkspaceTarget(target), connectionStateRef.current);
      } else if (bridge.selectWorkspaceCandidate) {
        nextState = workspaceConnectionStateFromUnknown(await bridge.selectWorkspaceCandidate(target), connectionStateRef.current);
      } else if (activeConnection?.id !== target.connectionId || activeConnection.workspaceId !== target.workspaceId) {
        throw new Error("workspace_switch_requires_desktop_bridge");
      }
      if (activationId !== activationSequence.current) return;
      const authorizedConnection = connectionForTarget(nextState, target) ?? connectionForTarget(connectionStateRef.current, target) ?? activeConnection;
      if (!authorizedConnection) throw new Error("workspace_connection_required");
      // Target selection may update activeConnection/activeTarget in the
      // Desktop registry. Keep the refs in sync before any later directory
      // response is allowed to compare its snapshot.
      connectionStateRef.current = nextState;
      connectionRef.current = authorizedConnection;
      invalidateWorkspaceDirectory();
      setConnectionState(nextState);
      setConnection(authorizedConnection);
      const status = bridge.getWorkspaceServerStatus ? await bridge.getWorkspaceServerStatus(target) : undefined;
      if (status !== undefined && !isServerStatusSuccess(status)) throw new Error("workspace_reauthorization_denied");
      if (activationId !== activationSequence.current) return;
      const listed = bridge.listWorkspaceRooms ? (await bridge.listWorkspaceRooms()).rooms.map(nativeRoom) : [];
      if (activationId !== activationSequence.current) return;
      const candidate = readNativeSelectionCandidate(authorizedConnection, target);
      const selected = listed.find((room) => room.id === candidate?.roomId) ?? listed[0];
      setRooms(listed);
      setSelectedRoomId(selected?.id);
      writeNativeSelectionCandidate({
        connectionId: target.connectionId,
        ...(workspace.organizationId ? { organizationId: workspace.organizationId } : {}),
        workspaceId: target.workspaceId,
        ...(selected ? { roomId: selected.id } : {})
      }, authorizedConnection);
      setTransportState("connected");
    } catch (error) {
      if (activationId !== activationSequence.current) return;
      setRooms([]);
      setSelectedRoomId(undefined);
      setActiveWorkspaceRoomId(undefined);
      setMessages([]);
      setSessionId(undefined);
      setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
      const discardTarget = shouldDiscardWorkspaceTargetAfterReauthorizationFailure(error);
      const message = userFacingError(error, "このWorkspaceを再認可できませんでした。Workspaceを選び直してください。");
      if (discardTarget) {
        // A denied/deleted target must not remain selected or be restored from
        // the local navigation hint. Keep other Server targets untouched.
        setSelectedWorkspaceId(undefined);
        setSelectedWorkspaceTargetKey(undefined);
        setWorkspaces((current) => workspacesAfterReauthorizationFailure(current, target));
        clearNativeSelectionCandidate(undefined, target);
        setWorkspaceError(message);
      }
      setRoomError(message);
      setTransportState(isPermissionError(error) ? "offline" : "reconnecting");
    } finally {
      if (activationId === activationSequence.current) setRoomLoading(false);
    }
  }, [bridge, invalidateChatStream, invalidateWorkspaceDirectory]);

  const preflightWorkspaceTransfer = useCallback(async (workspace: NativeWorkspace, destination: NativeWorkspace): Promise<NativeWorkspaceTransferPreflight> => {
    if (!bridge?.preflightWorkspaceTransfer) throw new Error("workspace_transfer_unavailable");
    const source = targetForWorkspace(workspace, connectionRef.current);
    const destinationTarget = targetForWorkspace(destination, connectionStateRef.current.connections.find((item) => item.id === destination.connectionId));
    if (!source || !destinationTarget || source.connectionId === destinationTarget.connectionId || nativeWorkspaceTargetKey(source) === nativeWorkspaceTargetKey(destinationTarget)) {
      throw new Error("workspace_transfer_target_invalid");
    }
    const result = await bridge.preflightWorkspaceTransfer({ source, destination: destinationTarget, operationId: createIdempotencyKey() });
    const preview = transferPreflightFromUnknown(result, source, destinationTarget, workspace);
    if (nativeWorkspaceTargetKey(preview.source) !== nativeWorkspaceTargetKey(source) || nativeWorkspaceTargetKey(preview.destination) !== nativeWorkspaceTargetKey(destinationTarget)) {
      throw new Error("workspace_transfer_preflight_mismatch");
    }
    setWorkspaceTransferPreflight(preview);
    setWorkspaceTransferStatus(undefined);
    return preview;
  }, [bridge]);

  const executeWorkspaceTransfer = useCallback(async (workspace: NativeWorkspace, destination: NativeWorkspace, preflight: NativeWorkspaceTransferPreflight): Promise<NativeWorkspaceTransferStatus> => {
    if (!bridge?.executeWorkspaceTransfer) throw new Error("workspace_transfer_unavailable");
    const source = targetForWorkspace(workspace, connectionRef.current);
    const destinationTarget = targetForWorkspace(destination, connectionStateRef.current.connections.find((item) => item.id === destination.connectionId));
    if (!source || !destinationTarget || nativeWorkspaceTargetKey(preflight.source) !== nativeWorkspaceTargetKey(source) || nativeWorkspaceTargetKey(preflight.destination) !== nativeWorkspaceTargetKey(destinationTarget)) {
      throw new Error("workspace_transfer_preflight_mismatch");
    }
    if (preflight.writeBlocked || preflight.failureConditions.length > 0) throw new Error("workspace_transfer_preflight_blocked");
    if (preflight.expiresAt && Date.parse(preflight.expiresAt) <= Date.now()) throw new Error("workspace_transfer_preflight_expired");
    const result = await bridge.executeWorkspaceTransfer({ transferId: preflight.transferId, source, destination: destinationTarget, operationId: createIdempotencyKey() });
    const status = workspaceTransferStatusFromUnknown(result, { transferId: preflight.transferId, source, destination: destinationTarget, workspace });
    setWorkspaceTransferStatus(status);
    return status;
  }, [bridge]);

  const refreshWorkspaceTransfer = useCallback(async (workspace: NativeWorkspace, destination: NativeWorkspace, current: NativeWorkspaceTransferStatus): Promise<NativeWorkspaceTransferStatus> => {
    if (!bridge?.getWorkspaceTransferStatus) throw new Error("workspace_transfer_status_unavailable");
    const source = targetForWorkspace(workspace, connectionRef.current);
    const destinationTarget = targetForWorkspace(destination, connectionStateRef.current.connections.find((item) => item.id === destination.connectionId));
    if (!source || !destinationTarget || nativeWorkspaceTargetKey(current.source) !== nativeWorkspaceTargetKey(source) || nativeWorkspaceTargetKey(current.destination) !== nativeWorkspaceTargetKey(destinationTarget)) {
      throw new Error("workspace_transfer_status_mismatch");
    }
    const result = await bridge.getWorkspaceTransferStatus({ transferId: current.transferId, source, destination: destinationTarget });
    const status = workspaceTransferStatusFromUnknown(result, { transferId: current.transferId, source, destination: destinationTarget, workspace });
    setWorkspaceTransferStatus(status);
    return status;
  }, [bridge]);

  const cutoverWorkspaceTransfer = useCallback(async (workspace: NativeWorkspace, destination: NativeWorkspace, current: NativeWorkspaceTransferStatus): Promise<void> => {
    if (!bridge?.cutoverWorkspaceTarget) throw new Error("workspace_transfer_cutover_unavailable");
    if (current.state !== "verified") throw new Error("workspace_transfer_not_verified");
    const source = targetForWorkspace(workspace, connectionRef.current);
    const destinationTarget = targetForWorkspace(destination, connectionStateRef.current.connections.find((item) => item.id === destination.connectionId));
    if (!source || !destinationTarget || nativeWorkspaceTargetKey(current.source) !== nativeWorkspaceTargetKey(source) || nativeWorkspaceTargetKey(current.destination) !== nativeWorkspaceTargetKey(destinationTarget)) {
      throw new Error("workspace_transfer_cutover_mismatch");
    }
    const lastRoomId = selectedWorkspaceTargetKey === nativeWorkspaceTargetKey(source) ? selectedRoomId : undefined;
    await bridge.cutoverWorkspaceTarget({ source, destination: destinationTarget, ...(lastRoomId ? { lastRoomId } : {}) });
    const movedWorkspace: NativeWorkspace = {
      ...workspace,
      organizationId: undefined,
      target: destinationTarget,
      connectionId: destinationTarget.connectionId,
      serverOrigin: destination.serverOrigin,
      serverLabel: destination.serverLabel,
      accountId: destination.accountId,
      availability: destination.availability ?? "unknown",
      ...(destination.connectionError ? { connectionError: destination.connectionError } : {})
    };
    setWorkspaces((items) => {
      const next = items.filter((item) => {
        const itemTarget = targetForWorkspace(item, connectionRef.current);
        return !itemTarget || nativeWorkspaceTargetKey(itemTarget) !== nativeWorkspaceTargetKey(source);
      });
      if (!next.some((item) => {
        const itemTarget = targetForWorkspace(item, connectionRef.current);
        return itemTarget && nativeWorkspaceTargetKey(itemTarget) === nativeWorkspaceTargetKey(destinationTarget);
      })) next.push(movedWorkspace);
      return next.sort((left, right) => left.name.localeCompare(right.name, "ja"));
    });
    setSelectedWorkspaceId(movedWorkspace.id);
    setSelectedWorkspaceTargetKey(nativeWorkspaceTargetKey(destinationTarget));
    setSelectedRoomId(undefined);
    setRooms([]);
    setActiveWorkspaceRoomId(undefined);
    setMessages([]);
    setSessionId(undefined);
    setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
    setWorkspaceTransferStatus({ ...current, state: "cutover", sourceArchived: true, updatedAt: new Date().toISOString() });
    setManagementOpen(false);
    setWorkspaceRefreshNonce((value) => value + 1);
    await refreshConnections();
  }, [bridge, refreshConnections, selectedRoomId, selectedWorkspaceTargetKey]);

  useEffect(() => {
    if (!selectedWorkspace || !connection || selectedWorkspace.access !== "granted") {
      setRooms([]);
      setSelectedRoomId(undefined);
      setActiveWorkspaceRoomId(undefined);
      return;
    }
    void activateWorkspace(selectedWorkspace);
  }, [activateWorkspace, selectedWorkspace?.access, selectedWorkspace?.state, selectedWorkspaceTargetKey, workspaceRefreshNonce]);

  const openRoom = useCallback(async (room: NativeRoom): Promise<void> => {
    if (!bridge || !selectedWorkspace || selectedWorkspace.access !== "granted") return;
    invalidateChatStream();
    setSending(false);
    const target = targetForWorkspace(selectedWorkspace, connectionRef.current);
    const targetConnection = target ? connectionForTarget(connectionStateRef.current, target) ?? connectionRef.current : connectionRef.current;
    setSelectedRoomId(room.id);
    setActiveWorkspaceRoomId(room.id);
    if (target && targetConnection) writeNativeSelectionCandidate({
      connectionId: target.connectionId,
      ...(selectedWorkspace.organizationId ? { organizationId: selectedWorkspace.organizationId } : {}),
      workspaceId: target.workspaceId,
      roomId: room.id
    }, targetConnection);
    setChatLoading(true);
    setChatError(null);
    setMessages([]);
    setSessionId(undefined);
    setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
    try {
      const sessions = bridge.listWorkspaceChatSessions ? await bridge.listWorkspaceChatSessions() : [];
      const roomSession = sessions
        .filter((session) => session.room_id === room.id)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
      const session = roomSession ?? (bridge.createWorkspaceChatSession ? await bridge.createWorkspaceChatSession({ roomId: room.id, operationId: createIdempotencyKey() }) : undefined);
      if (!session) throw new Error("chat_session_unavailable");
      setSessionId(session.id);
      const detail = bridge.getWorkspaceChatSession ? await bridge.getWorkspaceChatSession({ sessionId: session.id }) : await api.getSession(session.id);
      const nextEvidence = evidenceFromDetail(detail);
      setEvidence(nextEvidence);
      setMessages(withEvidence(detail.messages.map(nativeMessage), nextEvidence));
      setTransportState("connected");
    } catch (error) {
      setChatError(userFacingError(error, "会話を読み込めませんでした。"));
      setTransportState(isPermissionError(error) ? "offline" : "reconnecting");
    } finally {
      setChatLoading(false);
    }
  }, [bridge, invalidateChatStream, selectedWorkspace]);

  useEffect(() => {
    const room = rooms.find((candidate) => candidate.id === selectedRoomId);
    if (room) void openRoom(room);
    else {
      invalidateChatStream();
      setSending(false);
      setMessages([]);
      setSessionId(undefined);
      setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
    }
  }, [invalidateChatStream, openRoom, rooms, selectedRoomId]);

  useEffect(() => () => {
    chatStreamGeneration.current += 1;
    chatStreamPolling.current?.stop();
    chatStreamPolling.current = undefined;
  }, []);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    if (!selectedRoom) throw new Error("room_required");
    const created = await api.createSession({ room_id: selectedRoom.id });
    setSessionId(created.id);
    return created.id;
  }, [selectedRoom, sessionId]);

  const startChatStreamPolling = useCallback((input: {
    sessionId: string;
    idempotencyKey: string;
    generation: number;
    roomId: string;
    workspaceTargetKey?: string;
  }): void => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let run: BackendRunRecord | undefined;

    const isCurrent = (): boolean => !stopped
      && chatStreamGeneration.current === input.generation
      && chatContextRef.current.roomId === input.roomId
      && chatContextRef.current.workspaceTargetKey === input.workspaceTargetKey;

    const stop = (): void => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    const poll = async (): Promise<void> => {
      if (!isCurrent()) {
        stop();
        return;
      }
      try {
        if (!run) {
          const runs = await api.listBackendRuns(input.sessionId);
          if (!isCurrent()) return;
          run = backendRunForChatRequest(runs, input.sessionId, input.idempotencyKey);
          if (run) setCurrentActiveRunId(run.id);
        }
        if (run) {
          const events = await api.listBackendEvents(run.id);
          if (!isCurrent()) return;
          const message = streamingAgentMessageFromBackendEvents(run, events);
          setMessages((current) => [
            ...current.filter((item) => !isStreamingAgentMessage(item)),
            message
          ]);
        }
      } catch {
        // The polling path is supplementary to the authoritative chat
        // request. A transient read failure must not turn a successful send
        // into a failed message; the next poll will retry once the Server is
        // reachable again.
      }
      if (isCurrent()) timer = setTimeout(() => void poll(), 250);
    };

    const controller = { stop };
    chatStreamPolling.current = controller;
    void poll();
  }, [setCurrentActiveRunId]);

  const sendMessage = useCallback(async (content: string): Promise<void> => {
    if (!selectedRoom || !selectedWorkspace || selectedWorkspace.access !== "granted" || selectedWorkspace.state !== "active" || selectedRoom.canExecute === false) return;
    invalidateChatStream();
    const requestGeneration = chatStreamGeneration.current;
    const requestRoomId = selectedRoom.id;
    const requestWorkspaceTargetKey = chatContextRef.current.workspaceTargetKey;
    const isCurrentRequest = (): boolean => chatStreamGeneration.current === requestGeneration
      && chatContextRef.current.roomId === requestRoomId
      && chatContextRef.current.workspaceTargetKey === requestWorkspaceTargetKey;
    const localMessage: NativeChatMessage = { id: randomLocalId("pending"), role: "user", content, pending: true };
    setMessages((current) => [...current, localMessage]);
    setSending(true);
    setChatError(null);
    const operationId = createIdempotencyKey();
    try {
      const currentSessionId = await ensureSession();
      if (!isCurrentRequest()) return;
      startChatStreamPolling({
        sessionId: currentSessionId,
        idempotencyKey: operationId,
        generation: requestGeneration,
        roomId: requestRoomId,
        workspaceTargetKey: requestWorkspaceTargetKey
      });
      const response = await api.submitChatSurfaceOperation({ sessionId: currentSessionId, content, outputLocale: "ja", idempotencyKey: operationId });
      if (!isCurrentRequest()) return;
      stopChatStreamPolling();
      const result = ("result" in response ? response.result : response) as ChatTurnResult;
      const nextEvidence = evidenceFromResult(result);
      setEvidence(nextEvidence);
      setCurrentActiveRunId(undefined);
      setMessages(withEvidence(result.messages.map(nativeMessage), nextEvidence));
      setTransportState("connected");
    } catch (error) {
      if (!isCurrentRequest()) return;
      stopChatStreamPolling();
      setCurrentActiveRunId(undefined);
      setMessages((current) => current.map((message) => message.id === localMessage.id ? { ...message, pending: false, failed: true, retryable: !isPermissionError(error) } : message));
      setChatError(userFacingError(error, "Agentへの送信に失敗しました。送信済みかを確認してから再試行してください。"));
      setTransportState(isPermissionError(error) ? "offline" : "reconnecting");
    } finally {
      if (isCurrentRequest()) {
        stopChatStreamPolling();
        setSending(false);
      }
    }
  }, [ensureSession, invalidateChatStream, selectedRoom, selectedWorkspace, setCurrentActiveRunId, startChatStreamPolling, stopChatStreamPolling]);

  const stopMessage = useCallback(async (): Promise<void> => {
    const runId = activeRunIdRef.current ?? activeRunId;
    if (!runId) {
      setChatError("停止要求を送る実行情報を確認できません。現在の送信状態を維持しています。");
      return;
    }
    invalidateChatStream();
    setMessages((current) => current.filter((message) => !isStreamingAgentMessage(message)));
    setSending(false);
    try {
      await api.cancelBackendRun(runId);
    } catch (error) {
      setChatError(userFacingError(error, "Agentを停止できませんでした。"));
    }
  }, [activeRunId, invalidateChatStream]);

  const retryMessage = useCallback(async (message: NativeChatMessage): Promise<void> => {
    setMessages((current) => current.filter((item) => item.id !== message.id));
    await sendMessage(message.content);
  }, [sendMessage]);

  const reconnect = useCallback(async (): Promise<void> => {
    setTransportState("reconnecting");
    setChatError(null);
    setWorkspaceRefreshNonce((value) => value + 1);
    setRefreshNonce((value) => value + 1);
    await refreshConnections();
  }, [refreshConnections]);

  const selectWorkspaceConnection = useCallback(async (connectionId: string): Promise<void> => {
    if (!bridge?.selectWorkspaceConnection) throw new Error("workspace_connection_selection_unavailable");
    const operationId = beginConnectionOperation();
    clearSelectedConnectionContent();
    setConnectionLoading(true);
    setConnectionError(null);
    try {
      const nextState = workspaceConnectionStateFromUnknown(await bridge.selectWorkspaceConnection(connectionId), connectionStateRef.current);
      if (operationId !== connectionOperationGeneration.current) return;
      applyConnectionState(nextState);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      if (operationId !== connectionOperationGeneration.current) return;
      setConnectionError(userFacingError(error, "接続先を切り替えられませんでした。"));
      setTransportState("offline");
      throw error;
    } finally {
      if (operationId === connectionOperationGeneration.current) setConnectionLoading(false);
    }
  }, [applyConnectionState, beginConnectionOperation, bridge, clearSelectedConnectionContent]);

  const saveWorkspaceConnection = useCallback(async (input: { label: string; serverUrl: string; accountId: string }): Promise<void> => {
    if (!bridge?.upsertWorkspaceConnection || !bridge.selectWorkspaceConnection) throw new Error("workspace_connection_settings_unavailable");
    const operationId = beginConnectionOperation();
    setConnectionLoading(true);
    setConnectionError(null);
    try {
      const savedState = workspaceConnectionStateFromUnknown(await bridge.upsertWorkspaceConnection(input), connectionStateRef.current);
      if (operationId !== connectionOperationGeneration.current) return;
      const serverUrl = canonicalWorkspaceServerUrl(input.serverUrl);
      const saved = savedState.connections.find((connection) => connection.accountId === input.accountId.trim()
        && connection.serverUrl === serverUrl);
      if (!saved) throw new Error("workspace_connection_save_failed");
      clearSelectedConnectionContent();
      const nextState = workspaceConnectionStateFromUnknown(await bridge.selectWorkspaceConnection(saved.id), savedState);
      if (operationId !== connectionOperationGeneration.current) return;
      applyConnectionState(nextState);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      if (operationId !== connectionOperationGeneration.current) return;
      setConnectionError(userFacingError(error, "接続先を保存できませんでした。"));
      setTransportState("offline");
      throw error;
    } finally {
      if (operationId === connectionOperationGeneration.current) setConnectionLoading(false);
    }
  }, [applyConnectionState, beginConnectionOperation, bridge, clearSelectedConnectionContent]);

  const importActiveWorkspaceIdentity = useCallback(async (): Promise<void> => {
    if (!bridge?.importActiveWorkspaceIdentityFromClipboard) throw new Error("workspace_identity_import_unavailable");
    const operationId = beginConnectionOperation();
    setConnectionLoading(true);
    setConnectionError(null);
    try {
      const nextState = workspaceConnectionStateFromUnknown(await bridge.importActiveWorkspaceIdentityFromClipboard(), connectionStateRef.current);
      if (operationId !== connectionOperationGeneration.current) return;
      applyConnectionState(nextState);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      if (operationId !== connectionOperationGeneration.current) return;
      setConnectionError(userFacingError(error, "コピー済みの秘密鍵をこの端末へ登録できませんでした。Account IDと鍵を確認してください。"));
      setTransportState("offline");
      throw error;
    } finally {
      if (operationId === connectionOperationGeneration.current) setConnectionLoading(false);
    }
  }, [applyConnectionState, beginConnectionOperation, bridge]);

  const registerWorkspaceServerAccount = useCallback(async (): Promise<void> => {
    if (!bridge?.registerWorkspaceServerAccount) throw new Error("workspace_account_registration_unavailable");
    const operationId = beginConnectionOperation();
    setConnectionLoading(true);
    setConnectionError(null);
    try {
      await bridge.registerWorkspaceServerAccount("Samurai Account");
      if (operationId !== connectionOperationGeneration.current) return;
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      if (operationId !== connectionOperationGeneration.current) return;
      setConnectionError(userFacingError(error, "本人情報をServerへ登録できませんでした。"));
      setTransportState("offline");
      throw error;
    } finally {
      if (operationId === connectionOperationGeneration.current) setConnectionLoading(false);
    }
  }, [beginConnectionOperation, bridge]);

  useEffect(() => {
    if (!bridge?.onWorkspaceServerEvent) return undefined;
    return bridge.onWorkspaceServerEvent((event) => {
      const selectedTarget = selectedWorkspace ? targetForWorkspace(selectedWorkspace, connectionRef.current) : undefined;
      if (!event || (selectedWorkspaceId && event.workspaceId !== selectedWorkspaceId)) return;
      if (event.connectionId && selectedTarget && event.connectionId !== selectedTarget.connectionId) return;
      if (event.type === "access_revoked") {
        setMessages([]);
        setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
        setSessionId(undefined);
        setSelectedRoomId(undefined);
        setActiveWorkspaceRoomId(undefined);
        setRooms([]);
        setSelectedWorkspaceId(undefined);
        setSelectedWorkspaceTargetKey(undefined);
        if (selectedTarget) {
          clearNativeSelectionCandidate(connectionRef.current, selectedTarget);
          setWorkspaces((current) => current.map((workspace) => {
            const target = targetForWorkspace(workspace, connectionRef.current);
            return target && target.connectionId === selectedTarget.connectionId && target.workspaceId === selectedTarget.workspaceId
              ? { ...workspace, access: "none", availability: "offline", connectionError: "Workspace access was revoked." }
              : workspace;
          }));
        }
        setWorkspaceError("権限が変更されたため、このWorkspaceの内容を閉じました。");
        setChatError("権限が変更されたため、保護された内容を閉じました。");
        setTransportState("offline");
      } else if (event.type === "room_access_revoked") {
        setMessages([]);
        setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
        setSessionId(undefined);
        setSelectedRoomId(undefined);
        setActiveWorkspaceRoomId(undefined);
        setChatError("Roomの権限が変更されたため、保護された内容を閉じました。");
        setWorkspaceRefreshNonce((value) => value + 1);
      } else {
        setWorkspaceRefreshNonce((value) => value + 1);
      }
    });
  }, [bridge, selectedWorkspace, selectedWorkspaceId]);

  const selectOrganization = useCallback((organizationId: string): void => {
    if (!organizations.some((organization) => organization.id === organizationId)) return;
    setSelectedOrganizationId(organizationId);
    setChatError(null);
    if (connection) writeNativeSelectionCandidate({ connectionId: connection.id, organizationId }, connection);
    if (bridge?.selectOrganizationCandidate) {
      void bridge.selectOrganizationCandidate({ organizationId }).catch((error) => {
        setOrganizationError(userFacingError(error, "Organizationを再確認できませんでした。"));
      });
    }
  }, [bridge, connection, organizations]);

  const selectWorkspace = useCallback((workspace: NativeWorkspace): void => {
    // A user selection supersedes any directory request that was started
    // before the click. Otherwise its preferred target could be applied after
    // this explicit choice, including for a same-ID Workspace on another
    // Server.
    invalidateWorkspaceDirectory();
    const target = targetForWorkspace(workspace, connectionRef.current);
    if (!target) {
      setWorkspaceError("Workspaceの接続先を確認できません。");
      return;
    }
    if (workspace.access !== "granted") {
      setSelectedWorkspaceId(undefined);
      setSelectedWorkspaceTargetKey(undefined);
      setSelectedRoomId(undefined);
      setRooms([]);
      setActiveWorkspaceRoomId(undefined);
      setWorkspaceError("このWorkspaceへのアクセス権限がありません。");
      clearNativeSelectionCandidate(undefined, target);
      return;
    }
    setWorkspaceError(null);
    setSelectedWorkspaceId(workspace.id);
    setSelectedWorkspaceTargetKey(nativeWorkspaceTargetKey(target));
    setSelectedRoomId(undefined);
    setRooms([]);
    setActiveWorkspaceRoomId(undefined);
    setMessages([]);
    setSessionId(undefined);
    setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
    const targetConnection = connectionForTarget(connectionStateRef.current, target) ?? connectionRef.current;
    if (targetConnection) writeNativeSelectionCandidate({
      connectionId: target.connectionId,
      ...(workspace.organizationId ? { organizationId: workspace.organizationId } : {}),
      workspaceId: target.workspaceId
    }, targetConnection);
  }, [invalidateWorkspaceDirectory]);

  const createOrganization = useCallback(async (input: { name: string; description?: string }): Promise<void> => {
    const created = await organizationApi.createOrganization(input);
    setOrganizations((current) => [...current, { ...created, role: "owner" }]);
    setSelectedOrganizationId(created.id);
    setOrganizationError(null);
    if (connection) writeNativeSelectionCandidate({ organizationId: created.id }, connection);
  }, [connection, organizationApi]);

  const createWorkspace = useCallback(async (input: { name: string }): Promise<void> => {
    const targetConnection = connectionRef.current;
    if (!targetConnection) throw new Error("workspace_connection_required");
    if (bridge?.createWorkspace) {
      const workspaceId = randomLocalId("workspace");
      const result = await bridge.createWorkspace({ name: input.name, workspaceId, operationId: createIdempotencyKey() });
      const created = createdWorkspace(result, input.name, targetConnection, workspaceId);
      const target = targetForWorkspace(created, targetConnection);
      setWorkspaces((current) => {
        const next = [...current.filter((item) => {
          const itemTarget = targetForWorkspace(item, connectionRef.current);
          return !target || !itemTarget || nativeWorkspaceTargetKey(itemTarget) !== nativeWorkspaceTargetKey(target);
        }), created];
        return next.sort((left, right) => left.name.localeCompare(right.name, "ja"));
      });
      setSelectedWorkspaceId(created.id);
      if (target) setSelectedWorkspaceTargetKey(nativeWorkspaceTargetKey(target));
      writeNativeSelectionCandidate({
        connectionId: targetConnection.id,
        ...(created.organizationId ? { organizationId: created.organizationId } : {}),
        workspaceId: created.id
      }, targetConnection);
      return;
    }
    // Compatibility path for an older bridge that only exposes the
    // Organization control-plane endpoint. It is never used as a blocker for
    // the normal zero-Organization Workspace-first flow.
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("workspace_create_unavailable");
    const created = await organizationApi.createWorkspace(selectedOrganizationId, input);
    const target = targetForWorkspace(created, targetConnection);
    const withTarget = target ? { ...created, target, connectionId: target.connectionId, serverOrigin: targetConnection.serverUrl, serverLabel: targetConnection.label, accountId: targetConnection.accountId, availability: "connected" as const } : created;
    setWorkspaces((current) => [...current, withTarget]);
    setSelectedWorkspaceId(created.id);
    if (target) setSelectedWorkspaceTargetKey(nativeWorkspaceTargetKey(target));
    writeNativeSelectionCandidate({ connectionId: targetConnection.id, organizationId: selectedOrganizationId, workspaceId: created.id }, targetConnection);
  }, [bridge, organizationApi, selectedOrganizationId]);

  const createRoom = useCallback(async (name: string): Promise<void> => {
    if (!bridge?.createWorkspaceRoom || !selectedWorkspace) throw new Error("room_create_unavailable");
    const result = await bridge.createWorkspaceRoom({ name, expectedWorkspaceVersion: selectedWorkspace.version ?? 0, operationId: createIdempotencyKey() });
    const created = nativeRoom(result.room);
    setRooms((current) => [...current, created]);
    setSelectedRoomId(created.id);
  }, [bridge, selectedWorkspace]);

  const loadManagement = useCallback(async (): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) {
      setMembers([]);
      setInvitations([]);
      setManagementError(null);
      return;
    }
    setManagementError(null);
    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        organizationApi.listMembers(selectedOrganizationId),
        organizationApi.listInvitations(selectedOrganizationId)
      ]);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
    } catch (error) {
      setManagementError(userFacingError(error, "Organization管理情報を読み込めませんでした。"));
    }
  }, [organizationApi, selectedOrganizationId]);

  useEffect(() => {
    if (managementOpen) void loadManagement();
  }, [loadManagement, managementOpen]);

  const saveOrganization = useCallback(async (input: { name: string; description?: string }): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    const updated = await organizationApi.patchOrganization(selectedOrganizationId, input);
    setOrganizations((current) => current.map((organization) => organization.id === updated.id ? { ...organization, ...updated } : organization));
  }, [organizationApi, selectedOrganizationId]);

  const inviteMember = useCallback(async (input: { accountId?: string; role: OrganizationRole; workspaceGrants?: Array<{ workspaceId: string; role: OrganizationRole }>; expiresAt?: string }): Promise<{ token?: string }> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    const result = await organizationApi.inviteMember(selectedOrganizationId, input);
    setInvitations((current) => [result.invitation, ...current]);
    return { ...(result.token ? { token: result.token } : {}) };
  }, [organizationApi, selectedOrganizationId]);

  const changeMemberRole = useCallback(async (accountId: string, role: OrganizationRole): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    const member = await organizationApi.changeMemberRole(selectedOrganizationId, accountId, role);
    setMembers((current) => current.map((item) => item.accountId === accountId ? member : item));
  }, [organizationApi, selectedOrganizationId]);

  const removeMember = useCallback(async (accountId: string): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    await organizationApi.removeMember(selectedOrganizationId, accountId);
    setMembers((current) => current.filter((item) => item.accountId !== accountId));
  }, [organizationApi, selectedOrganizationId]);

  const revokeInvitation = useCallback(async (invitationId: string): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    await organizationApi.revokeInvitation(selectedOrganizationId, invitationId);
    setInvitations((current) => current.map((item) => item.id === invitationId ? { ...item, state: "revoked" } : item));
  }, [organizationApi, selectedOrganizationId]);

  const reissueInvitation = useCallback(async (invitationId: string): Promise<{ token?: string }> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    const result = await organizationApi.reissueInvitation(selectedOrganizationId, invitationId);
    setInvitations((current) => current.map((item) => item.id === invitationId ? result.invitation : item));
    return { ...(result.token ? { token: result.token } : {}) };
  }, [organizationApi, selectedOrganizationId]);

  const extendInvitation = useCallback(async (invitationId: string, expiresAt: string): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    const invitation = await organizationApi.extendInvitation(selectedOrganizationId, invitationId, expiresAt);
    setInvitations((current) => current.map((item) => item.id === invitationId ? invitation : item));
  }, [organizationApi, selectedOrganizationId]);

  const acceptInvitation = useCallback(async (token: string): Promise<void> => {
    const result = await organizationApi.acceptInvitation(token);
    const joinedOrganization = result.organization;
    if (joinedOrganization) {
      setOrganizations((current) => current.some((item) => item.id === joinedOrganization.id)
        ? current.map((item) => item.id === joinedOrganization.id ? { ...item, ...joinedOrganization } : item)
        : [...current, joinedOrganization]);
      setSelectedOrganizationId(joinedOrganization.id);
    }
    setRefreshNonce((value) => value + 1);
  }, [organizationApi]);

  const archiveWorkspace = useCallback(async (workspace: NativeWorkspace): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    const updated = await organizationApi.archiveWorkspace(selectedOrganizationId, workspace.id);
    setWorkspaces((current) => current.map((item) => sameWorkspaceTarget(item, workspace, connectionRef.current)
      ? { ...item, ...updated, target: item.target, connectionId: item.connectionId, serverOrigin: item.serverOrigin, serverLabel: item.serverLabel, accountId: item.accountId }
      : item));
  }, [organizationApi, selectedOrganizationId]);

  const restoreWorkspace = useCallback(async (workspace: NativeWorkspace): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    const updated = await organizationApi.restoreWorkspace(selectedOrganizationId, workspace.id);
    setWorkspaces((current) => current.map((item) => sameWorkspaceTarget(item, workspace, connectionRef.current)
      ? { ...item, ...updated, target: item.target, connectionId: item.connectionId, serverOrigin: item.serverOrigin, serverLabel: item.serverLabel, accountId: item.accountId }
      : item));
  }, [organizationApi, selectedOrganizationId]);

  const deleteWorkspace = useCallback(async (workspace: NativeWorkspace): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    await organizationApi.deleteWorkspace(selectedOrganizationId, workspace.id);
    const target = targetForWorkspace(workspace, connectionRef.current);
    setWorkspaces((current) => current.filter((item) => !sameWorkspaceTarget(item, workspace, connectionRef.current)));
    if (target && selectedWorkspaceTargetKey === nativeWorkspaceTargetKey(target)) {
      setSelectedWorkspaceId(undefined);
      setSelectedWorkspaceTargetKey(undefined);
      setSelectedRoomId(undefined);
      setRooms([]);
      setMessages([]);
      setSessionId(undefined);
      setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
      setActiveWorkspaceRoomId(undefined);
      clearNativeSelectionCandidate(connectionRef.current, target);
    }
  }, [organizationApi, selectedOrganizationId, selectedWorkspaceTargetKey]);

  const deleteOrganization = useCallback(async (): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    const deletedOrganization = organizations.find((organization) => organization.id === selectedOrganizationId);
    await organizationApi.deleteOrganization(selectedOrganizationId);
    for (const workspace of workspaces) {
      if (workspace.organizationId !== selectedOrganizationId
        || (deletedOrganization?.connectionId && workspace.connectionId && workspace.connectionId !== deletedOrganization.connectionId)) continue;
      const target = targetForWorkspace(workspace, connectionRef.current);
      const targetConnection = target ? connectionForTarget(connectionStateRef.current, target) : undefined;
      if (target && targetConnection) writeNativeSelectionCandidate({
        connectionId: target.connectionId,
        workspaceId: target.workspaceId,
        ...(selectedWorkspaceTargetKey === nativeWorkspaceTargetKey(target) && selectedRoomId ? { roomId: selectedRoomId } : {})
      }, targetConnection);
    }
    setOrganizations((current) => current.filter((organization) => organization.id !== selectedOrganizationId));
    setSelectedOrganizationId(undefined);
    // Organization deletion releases its association; it must not delete or
    // hide the Workspace, Room, Chat, or evidence currently in use.
    setWorkspaces((current) => current.map((workspace) => {
      if (workspace.organizationId !== selectedOrganizationId
        || (deletedOrganization?.connectionId && workspace.connectionId && workspace.connectionId !== deletedOrganization.connectionId)) return workspace;
      const { organizationId: _organizationId, ...standalone } = workspace;
      return standalone;
    }));
    setManagementOpen(false);
    setWorkspaceRefreshNonce((value) => value + 1);
  }, [organizationApi, organizations, selectedRoomId, selectedWorkspaceTargetKey, selectedOrganizationId, workspaces]);

  const previewWorkspaceMove = useCallback(async (workspace: NativeWorkspace, targetOrganizationId: string): Promise<NativeWorkspaceMovePreview> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    if (!targetOrganizationId || targetOrganizationId === selectedOrganizationId) throw new Error("workspace_move_target_invalid");
    return organizationApi.previewWorkspaceMove(selectedOrganizationId, workspace.id, {
      targetOrganizationId,
      ...(workspace.version === undefined ? {} : { expectedWorkspaceVersion: workspace.version })
    });
  }, [organizationApi, selectedOrganizationId]);

  const moveWorkspace = useCallback(async (workspace: NativeWorkspace, targetOrganizationId: string, preview: NativeWorkspaceMovePreview): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    if (preview.targetOrganizationId !== targetOrganizationId || preview.workspaceId !== workspace.id) throw new Error("workspace_move_preview_mismatch");
    const result = await organizationApi.moveWorkspace(selectedOrganizationId, workspace.id, {
      targetOrganizationId,
      preflightId: preview.operationId,
      confirmGuestMembership: true,
      ...(workspace.version === undefined ? {} : { expectedWorkspaceVersion: workspace.version })
    });
    if (result.status === "failed" || result.status === "rolled_back") throw new Error(result.failureCode ?? "workspace_move_failed");
    const workspaceTarget = targetForWorkspace(workspace, connectionRef.current);
    setWorkspaces((current) => current.map((item) => sameWorkspaceTarget(item, workspace, connectionRef.current)
      ? { ...item, organizationId: targetOrganizationId }
      : item));
    setOrganizations((current) => current.map((organization) => organization.id === selectedOrganizationId
      ? { ...organization, ...(organization.workspaceCount === undefined ? {} : { workspaceCount: Math.max(0, organization.workspaceCount - 1) }) }
      : organization));
    if (workspaceTarget && selectedWorkspaceTargetKey === nativeWorkspaceTargetKey(workspaceTarget)) {
      setSelectedWorkspaceId(workspace.id);
      setSelectedWorkspaceTargetKey(nativeWorkspaceTargetKey(workspaceTarget));
    }
    setWorkspaceRefreshNonce((value) => value + 1);
  }, [organizationApi, selectedOrganizationId, selectedWorkspaceTargetKey]);

  const attachWorkspace = useCallback(async (workspace: NativeWorkspace, organizationId: string): Promise<void> => {
    if (!organizationId || organizationId === legacyOrganizationId) throw new Error("organization_api_required");
    const target = targetForWorkspace(workspace, connectionRef.current);
    if (!target) throw new Error("workspace_target_required");
    const organization = organizations.find((item) => item.id === organizationId);
    if (!organization) throw new Error("organization_not_found");
    if (organization.connectionId && organization.connectionId !== target.connectionId) throw new Error("workspace_organization_server_mismatch");
    const updated = await organizationApi.attachWorkspace(organizationId, workspace.id, {
      ...(workspace.version === undefined ? {} : { expectedWorkspaceVersion: workspace.version }),
      confirmGuestMemberships: true
    });
    setWorkspaces((current) => current.map((item) => sameWorkspaceTarget(item, workspace, connectionRef.current)
      ? {
        ...item,
        ...updated,
        organizationId,
        target: item.target,
        connectionId: item.connectionId,
        serverOrigin: item.serverOrigin,
        serverLabel: item.serverLabel,
        accountId: item.accountId
      }
      : item));
    setOrganizations((current) => current.map((item) => item.id === organizationId
      ? { ...item, ...(item.workspaceCount === undefined ? {} : { workspaceCount: item.workspaceCount + 1 }) }
      : item));
    setRefreshNonce((value) => value + 1);
    setWorkspaceRefreshNonce((value) => value + 1);
  }, [organizationApi, organizations]);

  const detachWorkspace = useCallback(async (workspace: NativeWorkspace): Promise<void> => {
    const organizationId = workspace.organizationId;
    if (!organizationId || organizationId === legacyOrganizationId) throw new Error("workspace_not_attached");
    const updated = await organizationApi.detachWorkspace(organizationId, workspace.id, workspace.version);
    const target = targetForWorkspace(workspace, connectionRef.current);
    const targetConnection = target ? connectionForTarget(connectionStateRef.current, target) : undefined;
    if (target && targetConnection) writeNativeSelectionCandidate({
      connectionId: target.connectionId,
      workspaceId: target.workspaceId,
      ...(selectedWorkspaceTargetKey === nativeWorkspaceTargetKey(target) && selectedRoomId ? { roomId: selectedRoomId } : {})
    }, targetConnection);
    setWorkspaces((current) => current.map((item) => sameWorkspaceTarget(item, workspace, connectionRef.current)
      ? (() => {
        const { organizationId: _organizationId, ...detached } = { ...item, ...updated };
        return {
          ...detached,
          target: item.target,
          connectionId: item.connectionId,
          serverOrigin: item.serverOrigin,
          serverLabel: item.serverLabel,
          accountId: item.accountId
        };
      })()
      : item));
    setOrganizations((current) => current.map((item) => item.id === organizationId
      ? { ...item, ...(item.workspaceCount === undefined ? {} : { workspaceCount: Math.max(0, item.workspaceCount - 1) }) }
      : item));
    setRefreshNonce((value) => value + 1);
    setWorkspaceRefreshNonce((value) => value + 1);
  }, [organizationApi, selectedRoomId, selectedWorkspaceTargetKey]);

  const exportWorkspaceBundle = useCallback(async (workspace: NativeWorkspace): Promise<NativeWorkspaceBundleExport> => {
    if (!workspace.id) throw new Error("workspace_bundle_input_invalid");
    // The Workspace route is the canonical path and does not require an
    // Organization. Older Desktop builds can still use the compatibility
    // Organization route for an already-attached Workspace.
    if (bridge?.exportWorkspaceBundle) return organizationApi.exportStandaloneWorkspaceBundle(workspace.id, workspace.version);
    if (workspace.organizationId && workspace.organizationId === selectedOrganizationId && selectedOrganizationId !== legacyOrganizationId) {
      return organizationApi.exportWorkspaceBundle(selectedOrganizationId, workspace.id, workspace.version);
    }
    throw new Error("workspace_bundle_export_unavailable");
  }, [bridge, organizationApi, selectedOrganizationId]);

  const restoreWorkspaceBundle = useCallback(async (bundleId: string): Promise<NativeWorkspaceBundleRestoreResult> => {
    const normalizedBundleId = bundleId.trim();
    if (!normalizedBundleId) throw new Error("workspace_bundle_input_invalid");
    if (!bridge?.restoreWorkspaceBundle) throw new Error("workspace_bundle_restore_unavailable");
    const result = await organizationApi.restoreWorkspaceBundle(normalizedBundleId);
    if (result.status === "restored") {
      setRefreshNonce((value) => value + 1);
      setWorkspaceRefreshNonce((value) => value + 1);
    }
    return result;
  }, [bridge, organizationApi]);

  const openEvidence = useCallback((message: NativeChatMessage): void => {
    setEvidenceMessage(message);
    setEvidenceOpen(true);
  }, []);

  return {
    browserMode,
    bridge,
    connection,
    connectionState,
    connectionLoading,
    connectionError,
    transportState,
    organizations,
    organizationLoading,
    organizationError: organizationError ?? (organizationApiAvailable ? null : "Organization管理を利用できません。Workspaceはそのまま利用できます。"),
    organizationApiAvailable,
    selectedOrganization,
    selectedOrganizationId,
    workspaces,
    workspaceLoading,
    workspaceError,
    workspaceDirectoryErrors,
    workspaceTransferPreflight,
    workspaceTransferStatus,
    workspaceTransferSupported: Boolean(bridge?.preflightWorkspaceTransfer && bridge?.executeWorkspaceTransfer && bridge?.cutoverWorkspaceTarget),
    selectedWorkspace,
    selectedWorkspaceId,
    selectedWorkspaceTargetKey,
    rooms,
    roomLoading,
    roomError,
    selectedRoom,
    selectedRoomId,
    chatLoading,
    messages,
    chatError,
    sending,
    evidence,
    evidenceMessage,
    evidenceOpen,
    setEvidenceOpen,
    managementOpen,
    setManagementOpen,
    members,
    invitations,
    managementError,
    refreshConnections,
    selectWorkspaceConnection,
    saveWorkspaceConnection,
    importActiveWorkspaceIdentity,
    registerWorkspaceServerAccount,
    selectOrganization,
    selectWorkspace,
    openRoom,
    sendMessage,
    stopMessage,
    retryMessage,
    reconnect,
    createOrganization,
    createWorkspace,
    createRoom,
    saveOrganization,
    inviteMember,
    changeMemberRole,
    removeMember,
    revokeInvitation,
    reissueInvitation,
    extendInvitation,
    acceptInvitation,
    archiveWorkspace,
    restoreWorkspace,
    deleteWorkspace,
    deleteOrganization,
    previewWorkspaceMove,
    moveWorkspace,
    attachWorkspace,
    detachWorkspace,
    preflightWorkspaceTransfer,
    executeWorkspaceTransfer,
    refreshWorkspaceTransfer,
    cutoverWorkspaceTransfer,
    exportWorkspaceBundle,
    restoreWorkspaceBundle,
    openEvidence
  };
}

export type NativeAppModel = ReturnType<typeof useNativeApp>;
