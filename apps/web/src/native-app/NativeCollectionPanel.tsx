import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollectionSchema, JsonValue } from "@samurai-agent/core-schemas";
import type {
  SurfaceOperation,
  SurfaceOperationResultEnvelope,
  SurfaceRenderSpec
} from "@samurai-agent/ui-protocol";
import { SurfaceOperationSchema, SurfaceRenderSpecSchema } from "@samurai-agent/ui-protocol";
import {
  createIdempotencyKey,
  getWorkspaceClientBridge,
  type DesktopWorkspaceConnectionState
} from "../lib/api";
import {
  appCollectionRecords,
  collectionActionRunPayload,
  collectionCreateReadyForSpec,
  collectionCreateDataForView,
  collectionDraftValueFromRaw,
  collectionFieldId,
  collectionFieldInputValue,
  collectionFilterField,
  collectionRecordId,
  collectionRenderer,
  collectionSchemaActions,
  collectionSortDirection,
  collectionSortFieldId,
  collectionTableEditableFields,
  collectionTableId,
  collectionTableViewId,
  withCollectionViewState,
  type CollectionUiAction
} from "../lib/collection-view-state";
import NativeCollectionSurface, {
  type NativeCollectionRecord,
  type NativeCollectionSurfaceController
} from "./NativeCollectionSurface";
import {
  activeNativeWorkspaceTarget,
  assertNativeWorkspaceTarget,
  withNativeWorkspaceTarget
} from "./native-workspace-target";
import type { NativeWorkspaceTarget } from "./types";
import type {
  WorkspaceOperationHistoryBridge,
  WorkspaceOperationHistoryRecord
} from "../lib/workspace-browser-bridge";

type NativeCollectionSurfaceOperation = Extract<SurfaceOperation, {
  kind: "collection.view.present"
    | "collection.record.create"
    | "collection.record.patch"
    | "collection.record.delete"
    | "collection.action.run";
}>;

export interface NativeCollectionPanelTarget extends NativeWorkspaceTarget {
  roomId: string;
}

export type NativeCollectionSchema = CollectionSchema & {
  file_path: string;
  resource_version: number;
  room_id: string;
};

export interface NativeCollectionPanelBridge {
  listWorkspaceConnections?: () => Promise<DesktopWorkspaceConnectionState>;
  listWorkspaceCollectionSchemas?: (input: { roomId: string; target?: NativeCollectionPanelTarget }) => Promise<{ schemas: NativeCollectionSchema[] }>;
  runWorkspaceCollectionSurfaceOperation?: (input: {
    roomId: string;
    operation: SurfaceOperation;
    target?: NativeCollectionPanelTarget;
  }) => Promise<SurfaceOperationResultEnvelope>;
  listWorkspaceOperationHistory?: WorkspaceOperationHistoryBridge["listWorkspaceOperationHistory"];
}

export interface NativeCollectionPanelProps {
  target: NativeCollectionPanelTarget;
  bridge?: NativeCollectionPanelBridge;
  canEdit?: boolean;
  canExecute?: boolean;
  onClose: () => void;
  onDraftNavigationControllerChange?: (controller: NativeDraftNavigationController | undefined) => void;
}

export interface NativeCollectionSurfaceOperationResult {
  response: NativeCollectionSurfaceOperationResponse;
  operation: NativeCollectionSurfaceOperation;
  spec: SurfaceRenderSpec;
}

export interface NativeCollectionRowDraft {
  values: Record<string, string>;
  baseVersion: number;
}

/**
 * A save request owns this immutable snapshot.  React state is intentionally
 * allowed to receive another edit while the request is in flight; the
 * completion path may clear only values that still match this snapshot.
 */
export interface NativeCollectionDraftSnapshot {
  collectionId: string;
  rows: Readonly<Record<string, NativeCollectionRowDraft>>;
  newDraft: Readonly<Record<string, string>>;
}

export function updateNativeCollectionRowDraft(
  previous: NativeCollectionRowDraft | undefined,
  baseVersion: number,
  field: string,
  value: string
): NativeCollectionRowDraft {
  return {
    values: { ...(previous?.values ?? {}), [field]: value },
    baseVersion: previous?.baseVersion ?? baseVersion
  };
}

export function nativeCollectionRowDraftAfterSave(
  current: NativeCollectionRowDraft,
  submitted: NativeCollectionRowDraft,
  serverVersion: number
): NativeCollectionRowDraft | undefined {
  if (current.baseVersion === submitted.baseVersion && stringMapsEqual(current.values, submitted.values)) {
    return undefined;
  }
  return { ...current, baseVersion: serverVersion };
}

export function captureNativeCollectionDraftSnapshot(
  collectionId: string,
  rowDrafts: Record<string, NativeCollectionRowDraft>,
  newDrafts: Record<string, Record<string, string>>
): NativeCollectionDraftSnapshot {
  const prefix = `${collectionId}\n`;
  const rows = Object.fromEntries(
    Object.entries(rowDrafts)
      .filter(([key, draft]) => key.startsWith(prefix) && Object.keys(draft.values).length > 0)
      .map(([key, draft]) => [key, { values: { ...draft.values }, baseVersion: draft.baseVersion }])
  );
  const currentNewDraft = newDrafts[collectionId] ?? {};
  return {
    collectionId,
    rows,
    newDraft: { ...currentNewDraft }
  };
}

/** Returns true when a draft differs from the values a save request captured. */
export function nativeCollectionDraftSnapshotHasNewerChanges(
  snapshot: NativeCollectionDraftSnapshot,
  rowDrafts: Record<string, NativeCollectionRowDraft>,
  newDrafts: Record<string, Record<string, string>>
): boolean {
  const currentRows = Object.fromEntries(
    Object.entries(rowDrafts)
      .filter(([key, draft]) => key.startsWith(`${snapshot.collectionId}\n`) && Object.keys(draft.values).length > 0)
  );
  for (const [key, current] of Object.entries(currentRows)) {
    const saved = snapshot.rows[key];
    if (!saved || saved.baseVersion !== current.baseVersion || !stringMapsEqual(saved.values, current.values)) return true;
  }
  const currentNewDraft = newDrafts[snapshot.collectionId] ?? {};
  if (Object.keys(currentNewDraft).length === 0) return false;
  if (Object.keys(snapshot.newDraft).length === 0) return true;
  return !stringMapsEqual(snapshot.newDraft, currentNewDraft);
}

interface NativeCollectionRecordMutationResult {
  id: string;
  collection_id: string;
  version: number;
  data: Record<string, JsonValue>;
}

interface NativeCollectionViewResult {
  records: NativeCollectionRecordMutationResult[];
}

interface NativeCollectionActionResult {
  action_id: string;
  record?: NativeCollectionRecordMutationResult;
}

type NativeCollectionSurfaceResult =
  | NativeCollectionRecordMutationResult
  | NativeCollectionViewResult
  | NativeCollectionActionResult;

interface NativeCollectionSurfaceOperationResponse {
  operation: NativeCollectionSurfaceOperation;
  result_kind: "collection_view" | "collection_record" | "collection_patch" | "collection_delete" | "collection_action";
  render_spec: SurfaceRenderSpec;
  render_specs: SurfaceRenderSpec[];
  result: NativeCollectionSurfaceResult;
}

export interface NativeCollectionPanelOperations {
  listSchemas: () => Promise<NativeCollectionSchema[]>;
  recordBaseVersion: (spec: SurfaceRenderSpec, record: NativeCollectionRecord) => number;
  presentCollection: (collectionId: string, viewId?: string) => Promise<NativeCollectionSurfaceOperationResult>;
  createRecord: (spec: SurfaceRenderSpec, draft: Record<string, string>) => Promise<NativeCollectionSurfaceOperationResult>;
  patchRecord: (spec: SurfaceRenderSpec, record: NativeCollectionRecord, draft: Record<string, string>, baseVersion?: number) => Promise<NativeCollectionSurfaceOperationResult>;
  deleteRecord: (spec: SurfaceRenderSpec, record: NativeCollectionRecord, baseVersion?: number) => Promise<NativeCollectionSurfaceOperationResult>;
  runAction: (spec: SurfaceRenderSpec, action: CollectionUiAction, record?: NativeCollectionRecord, baseVersion?: number) => Promise<NativeCollectionSurfaceOperationResult>;
}

/**
 * Reports each durable save in a draft batch. Callers can commit only that
 * draft and reflect the returned Server state before the next save begins.
 */
export interface NativeCollectionDraftSaveCallbacks {
  onRowSaved?: (input: {
    key: string;
    draft: NativeCollectionRowDraft;
    submittedValues: Record<string, string>;
    result: NativeCollectionSurfaceOperationResult;
  }) => void;
  onNewDraftSaved?: (input: {
    collectionId: string;
    submittedValues: Record<string, string>;
    result: NativeCollectionSurfaceOperationResult;
  }) => void;
}

/**
 * Saves one immutable draft snapshot in order. Each successful item is
 * reported immediately, so a later failure never hides an already durable
 * Server update or discards the remaining drafts.
 */
export async function saveNativeCollectionDraftSnapshot(
  operations: Pick<NativeCollectionPanelOperations, "patchRecord" | "createRecord">,
  initialSpec: SurfaceRenderSpec,
  snapshot: NativeCollectionDraftSnapshot,
  callbacks: NativeCollectionDraftSaveCallbacks = {}
): Promise<NativeCollectionSurfaceOperationResult> {
  const collectionId = requiredId(collectionTableId(initialSpec), "collectionId");
  if (snapshot.collectionId !== collectionId) throw new Error("collection_draft_target_changed");
  let currentSpec = initialSpec;
  let lastResult: NativeCollectionSurfaceOperationResult | undefined;

  for (const [key, draft] of Object.entries(snapshot.rows)) {
    const recordId = key.slice(collectionId.length + 1);
    const rawRecord = appCollectionRecords(currentSpec).find((candidate) => collectionRecordId(candidate) === recordId);
    const record = rawRecord ? nativeCollectionRecordFromValue(rawRecord) : undefined;
    if (!record) throw new Error("collection_record_draft_target_missing");
    const submittedValues = { ...draft.values };
    lastResult = await operations.patchRecord(currentSpec, record, submittedValues, draft.baseVersion);
    callbacks.onRowSaved?.({ key, draft, submittedValues, result: lastResult });
    currentSpec = lastResult.spec;
  }

  if (Object.keys(snapshot.newDraft).length > 0) {
    const submittedValues = { ...snapshot.newDraft };
    if (!collectionCreateReadyForSpec(currentSpec, submittedValues)) {
      throw new Error("collection_create_draft_invalid");
    }
    lastResult = await operations.createRecord(currentSpec, submittedValues);
    callbacks.onNewDraftSaved?.({ collectionId, submittedValues, result: lastResult });
  }

  if (!lastResult) throw new Error("collection_draft_missing");
  return lastResult;
}

export function nativeCollectionPanelTargetKey(target: NativeCollectionPanelTarget): string {
  return `${target.connectionId}\n${target.workspaceId}\n${target.roomId}`;
}

export function activeNativeCollectionPanelTarget(
  state: DesktopWorkspaceConnectionState
): NativeWorkspaceTarget | undefined {
  return activeNativeWorkspaceTarget(state);
}

export async function assertNativeCollectionPanelTarget(
  bridge: NativeCollectionPanelBridge,
  target: NativeCollectionPanelTarget
): Promise<void> {
  return assertNativeWorkspaceTarget(bridge, target);
}

/**
 * Desktop and Browser bridges follow the currently selected Workspace. The
 * panel therefore checks the selection immediately before and after every
 * bridge request; the Room is fixed in the request body and never inferred
 * from a Session or a legacy API client.
 */
export async function withNativeCollectionPanelTarget<T>(
  bridge: NativeCollectionPanelBridge,
  target: NativeCollectionPanelTarget,
  task: () => Promise<T>
): Promise<T> {
  return withNativeWorkspaceTarget(bridge, target, task);
}

type NativeCollectionOperationRecoveryRequest =
  | { kind: "collection.record.create"; collectionId: string; data: Record<string, JsonValue> }
  | { kind: "collection.record.patch"; collectionId: string; recordId: string; expectedVersion: number; changes: Record<string, JsonValue>; viewId: string }
  | { kind: "collection.record.delete"; collectionId: string; recordId: string; expectedVersion: number; viewId: string }
  | { kind: "collection.action.run"; collectionId: string; actionId: string; actionKind?: string; recordId?: string; viewId: string; payload: Record<string, JsonValue> };

/**
 * Resolves a Collection operation from durable index/result records.  The
 * operation ID is accepted only when its persisted record contains the exact
 * target and input that the new component state is submitting.
 */
async function recoverNativeCollectionOperationFromHistory(
  bridge: Pick<NativeCollectionPanelBridge, "listWorkspaceOperationHistory"> | undefined,
  target: NativeCollectionPanelTarget,
  request: NativeCollectionOperationRecoveryRequest
): Promise<NativeCollectionSurfaceOperation | undefined> {
  const list = bridge?.listWorkspaceOperationHistory;
  if (!list) return undefined;
  const recordType = request.kind === "collection.record.patch" || (request.kind === "collection.action.run" && requiresRecordVersion(request.actionKind) && /patch/i.test(request.actionKind ?? ""))
    ? "collection_patch"
    : "collection_record";
  const history = await list({ roomId: target.roomId, recordType, target });
  const matches = history.records.flatMap((record) => {
    const operation = recordType === "collection_patch"
      ? recoverCollectionPatchOperation(record, request)
      : recoverCollectionRecordOperation(record, request);
    return operation ? [operation] : [];
  });
  if (matches.length > 1) throw new Error("collection_operation_recovery_ambiguous");
  return matches[0];
}

function recoverCollectionRecordOperation(
  record: WorkspaceOperationHistoryRecord,
  request: NativeCollectionOperationRecoveryRequest
): NativeCollectionSurfaceOperation | undefined {
  const payload = record.payload;
  if (payload.kind !== "record" || payload.collection_id !== request.collectionId) return undefined;
  const operationId = typeof payload.operation_id === "string" ? payload.operation_id : undefined;
  const storedRecord = isJsonObject(payload.record) ? payload.record : undefined;
  if (!operationId || !storedRecord || storedRecord.collection_id !== request.collectionId || typeof storedRecord.id !== "string") return undefined;
  const states = new Set(["pending", "ready", "blocked", "deleting", "deleted"]);
  if (typeof payload.state !== "string" || !states.has(payload.state)) return undefined;

  if (request.kind === "collection.record.create") {
    if (storedRecord.id !== `record_${safeOperationId(operationId)}`
      || !isJsonObject(storedRecord.data)
      || stableJson(storedRecord.data) !== stableJson(request.data)) return undefined;
    return {
      id: operationId,
      kind: "collection.record.create",
      collection_id: request.collectionId,
      record_id: storedRecord.id,
      data: storedRecord.data
    };
  }
  if (request.kind === "collection.record.delete") {
    if (storedRecord.id !== request.recordId || storedRecord.version !== request.expectedVersion) return undefined;
    return {
      id: operationId,
      kind: "collection.record.delete",
      collection_id: request.collectionId,
      record_id: request.recordId,
      expected_version: request.expectedVersion,
      view_id: request.viewId
    };
  }
  if (request.kind !== "collection.action.run") return undefined;
  if (storedRecord.id !== (request.recordId ?? `record_${safeOperationId(operationId)}`)) return undefined;
  const actionKind = request.actionKind ?? (typeof request.payload.action_kind === "string" ? request.payload.action_kind : undefined);
  if (/delete/i.test(actionKind ?? "")) {
    if (storedRecord.version !== request.payload.expected_version) return undefined;
    return {
      id: operationId,
      kind: "collection.action.run",
      collection_id: request.collectionId,
      action_id: request.actionId,
      ...(request.recordId ? { record_id: request.recordId } : {}),
      view_id: request.viewId,
      payload: request.payload
    };
  }
  if (/create/i.test(actionKind ?? "")
    && isJsonObject(request.payload.data)
    && isJsonObject(storedRecord.data)
    && stableJson(storedRecord.data) === stableJson(request.payload.data)) {
    return {
      id: operationId,
      kind: "collection.action.run",
      collection_id: request.collectionId,
      action_id: request.actionId,
      ...(request.recordId ? { record_id: request.recordId } : {}),
      view_id: request.viewId,
      payload: request.payload
    };
  }
  return undefined;
}

function recoverCollectionPatchOperation(
  record: WorkspaceOperationHistoryRecord,
  request: NativeCollectionOperationRecoveryRequest
): NativeCollectionSurfaceOperation | undefined {
  const payload = record.payload;
  const patch = isJsonObject(payload.patch) ? payload.patch : undefined;
  if (payload.kind !== "patch" || payload.collection_id !== request.collectionId || !patch) return undefined;
  const operationId = typeof patch.source_operation_id === "string" ? patch.source_operation_id : undefined;
  if (!operationId || typeof patch.id !== "string" || typeof patch.record_id !== "string" || !isJsonObject(patch.changes)) return undefined;
  if (request.kind === "collection.record.patch") {
    if (patch.record_id !== request.recordId
      || patch.id !== `patch_${safeOperationId(operationId)}`
      || patch.expected_version !== request.expectedVersion
      || stableJson(patch.changes) !== stableJson(request.changes)) return undefined;
    return {
      id: operationId,
      kind: "collection.record.patch",
      collection_id: request.collectionId,
      record_id: request.recordId,
      patch_id: patch.id,
      expected_version: request.expectedVersion,
      changes: patch.changes,
      metadata: { view_id: request.viewId }
    };
  }
  if (request.kind !== "collection.action.run" || !/patch/i.test(request.actionKind ?? "")) return undefined;
  if (patch.id !== `action_${operationId}`
    || patch.record_id !== request.recordId
    || patch.expected_version !== request.payload.expected_version
    || !isJsonObject(request.payload.changes)
    || stableJson(patch.changes) !== stableJson(request.payload.changes)) return undefined;
  return {
    id: operationId,
    kind: "collection.action.run",
    collection_id: request.collectionId,
    action_id: request.actionId,
    ...(request.recordId ? { record_id: request.recordId } : {}),
    view_id: request.viewId,
    payload: request.payload
  };
}

export function createNativeCollectionPanelOperations(
  target: NativeCollectionPanelTarget,
  bridgeSource?: NativeCollectionPanelBridge
): NativeCollectionPanelOperations {
  const bridge = (bridgeSource ?? getWorkspaceClientBridge()) as NativeCollectionPanelBridge | undefined;
  const recordVersions = new Map<string, number>();
  const operationLedger = new Map<string, NativeCollectionSurfaceOperation>();
  const completedOperationKeys = new Set<string>();

  const requireBridge = (): NativeCollectionPanelBridge => {
    if (!bridge) throw new Error("workspace_collection_bridge_unavailable");
    return bridge;
  };

  const rememberRecord = (collectionId: string, value: unknown): void => {
    const record = asRecord(value);
    if (!record) return;
    const recordId = typeof record.id === "string" || typeof record.id === "number"
      ? String(record.id).trim()
      : "";
    const version = validVersion(record.version) ? record.version : undefined;
    if (recordId && version !== undefined) {
      const key = recordVersionKey(collectionId, recordId);
      const previous = recordVersions.get(key);
      if (previous === undefined || version >= previous) recordVersions.set(key, version);
    }
  };

  const rememberSpec = (spec: SurfaceRenderSpec): void => {
    const collectionId = collectionTableId(spec);
    if (!collectionId) return;
    for (const record of appCollectionRecords(spec)) rememberRecord(collectionId, record);
  };

  const rememberResponse = (response: NativeCollectionSurfaceOperationResponse, collectionId: string): void => {
    rememberSpec(response.render_spec);
    if (isNativeCollectionViewResult(response.result)) {
      for (const record of response.result.records) rememberRecord(collectionId, record);
    }
    rememberRecord(collectionId, response.result);
    if (isNativeCollectionActionResult(response.result) && response.result.record) {
      rememberRecord(collectionId, response.result.record);
    }
  };

  const operationFor = (
    key: string,
    build: () => NativeCollectionSurfaceOperation
  ): NativeCollectionSurfaceOperation => {
    const existing = operationLedger.get(key);
    if (existing) return existing;
    const operation = build();
    operationLedger.set(key, operation);
    return operation;
  };

  const operationForDurableRetry = async (
    key: string,
    recoveryRequest: NativeCollectionOperationRecoveryRequest | undefined,
    build: () => NativeCollectionSurfaceOperation
  ): Promise<NativeCollectionSurfaceOperation> => {
    const existing = operationLedger.get(key);
    if (existing) return existing;
    if (recoveryRequest && !completedOperationKeys.has(key) && bridge?.listWorkspaceOperationHistory) {
      const recovered = await withNativeCollectionPanelTarget(
        requireBridge(),
        target,
        () => recoverNativeCollectionOperationFromHistory(bridge, target, recoveryRequest)
      );
      if (recovered) {
        operationLedger.set(key, recovered);
        return recovered;
      }
    }
    return operationFor(key, build);
  };

  const runSurfaceOperation = async (
    operation: NativeCollectionSurfaceOperation,
    operationKey?: string
  ): Promise<NativeCollectionSurfaceOperationResult> => {
    const activeBridge = requireBridge();
    if (!activeBridge.runWorkspaceCollectionSurfaceOperation) {
      throw new Error("workspace_collection_surface_bridge_unavailable");
    }
    const rawResponse = await withNativeCollectionPanelTarget(
      activeBridge,
      target,
      () => activeBridge.runWorkspaceCollectionSurfaceOperation!({ roomId: target.roomId, operation, target })
    );
    const response = parseSurfaceResponse(rawResponse, operation);
    rememberResponse(response, operation.collection_id);
    if (operationKey) completedOperationKeys.add(operationKey);
    for (const [key, candidate] of operationLedger) {
      if (candidate.id === operation.id) operationLedger.delete(key);
    }
    return { response, operation, spec: response.render_spec };
  };

  const listSchemas = async (): Promise<NativeCollectionSchema[]> => {
    const activeBridge = requireBridge();
    if (!activeBridge.listWorkspaceCollectionSchemas) {
      throw new Error("workspace_collection_schema_bridge_unavailable");
    }
    const response = await withNativeCollectionPanelTarget(
      activeBridge,
      target,
      () => activeBridge.listWorkspaceCollectionSchemas!({ roomId: target.roomId, target })
    );
    if (!response || !Array.isArray(response.schemas)) throw new Error("workspace_collection_schema_response_invalid");
    for (const schema of response.schemas) {
      if (!schema || schema.room_id !== target.roomId) throw new Error("workspace_collection_schema_response_scope_invalid");
    }
    return response.schemas;
  };

  const presentCollection = async (collectionId: string, viewId?: string): Promise<NativeCollectionSurfaceOperationResult> => {
    const operation: NativeCollectionSurfaceOperation = {
      id: createIdempotencyKey(),
      kind: "collection.view.present",
      collection_id: requiredId(collectionId, "collectionId"),
      ...(viewId?.trim() ? { view_id: viewId.trim() } : {})
    };
    return runSurfaceOperation(operation);
  };

  const recordBaseVersion = (spec: SurfaceRenderSpec, record: NativeCollectionRecord): number => {
    const collectionId = requiredId(collectionTableId(spec), "collectionId");
    return expectedRecordVersion(collectionId, spec, record, recordVersions);
  };

  const createRecord = async (
    spec: SurfaceRenderSpec,
    draft: Record<string, string>
  ): Promise<NativeCollectionSurfaceOperationResult> => {
    assertEditableCollectionTable(spec);
    const collectionId = requiredId(collectionTableId(spec), "collectionId");
    const data = collectionCreateDataForView(spec, draft);
    const operationKey = operationIdentityKey("collection.record.create", collectionId, stableJson(data));
    const operation = await operationForDurableRetry(
      operationKey,
      { kind: "collection.record.create", collectionId, data },
      () => {
        const operationId = createIdempotencyKey();
        return {
          id: operationId,
          kind: "collection.record.create",
          collection_id: collectionId,
          record_id: `record_${safeOperationId(operationId)}`,
          data
        };
      }
    );
    return runSurfaceOperation(operation, operationKey);
  };

  const patchRecord = async (
    spec: SurfaceRenderSpec,
    record: NativeCollectionRecord,
    draft: Record<string, string>,
    baseVersion?: number
  ): Promise<NativeCollectionSurfaceOperationResult> => {
    assertEditableCollectionTable(spec);
    const collectionId = requiredId(collectionTableId(spec), "collectionId");
    const recordId = requiredId(collectionRecordId(record), "recordId");
    const expectedVersion = expectedRecordVersion(collectionId, spec, record, recordVersions, baseVersion);
    const changes = Object.fromEntries(collectionTableEditableFields(spec).map((field) => {
      const fieldId = collectionFieldId(field);
      const rawValue = draft[fieldId] ?? collectionFieldInputValue(field, record[fieldId]);
      return [fieldId, collectionDraftValueFromRaw(field, rawValue)];
    })) as Record<string, JsonValue>;
    const viewId = collectionTableViewId(spec);
    const operationKey = operationIdentityKey("collection.record.patch", collectionId, recordId, String(expectedVersion), viewId, stableJson(changes));
    const operation = await operationForDurableRetry(
      operationKey,
      { kind: "collection.record.patch", collectionId, recordId, expectedVersion, changes, viewId },
      () => {
        const operationId = createIdempotencyKey();
        return {
          id: operationId,
          kind: "collection.record.patch",
          collection_id: collectionId,
          record_id: recordId,
          patch_id: `patch_${safeOperationId(operationId)}`,
          expected_version: expectedVersion,
          changes,
          metadata: { view_id: viewId }
        };
      }
    );
    return runSurfaceOperation(operation, operationKey);
  };

  const deleteRecord = async (
    spec: SurfaceRenderSpec,
    record: NativeCollectionRecord,
    baseVersion?: number
  ): Promise<NativeCollectionSurfaceOperationResult> => {
    assertEditableCollectionTable(spec);
    const collectionId = requiredId(collectionTableId(spec), "collectionId");
    const recordId = requiredId(collectionRecordId(record), "recordId");
    const expectedVersion = expectedRecordVersion(collectionId, spec, record, recordVersions, baseVersion);
    const viewId = collectionTableViewId(spec);
    const operationKey = operationIdentityKey("collection.record.delete", collectionId, recordId, String(expectedVersion), viewId);
    const operation = await operationForDurableRetry(
      operationKey,
      { kind: "collection.record.delete", collectionId, recordId, expectedVersion, viewId },
      () => ({
        id: createIdempotencyKey(),
        kind: "collection.record.delete",
        collection_id: collectionId,
        record_id: recordId,
        expected_version: expectedVersion,
        view_id: viewId
      })
    );
    return runSurfaceOperation(operation, operationKey);
  };

  const runAction = async (
    spec: SurfaceRenderSpec,
    action: CollectionUiAction,
    record?: NativeCollectionRecord,
    baseVersion?: number
  ): Promise<NativeCollectionSurfaceOperationResult> => {
    assertEditableCollectionTable(spec);
    const collectionId = requiredId(collectionTableId(spec), "collectionId");
    const declared = collectionSchemaActions(spec).find((candidate) =>
      candidate.id === action.id && candidate.scope === action.scope
    );
    if (!declared || declared.operationKind !== "collection.action.run") {
      throw new Error("collection_action_not_declared");
    }
    const recordId = record ? collectionRecordId(record) : "";
    if (declared.scope === "record" && !recordId) throw new Error("collection_action_record_required");
    const payload = collectionActionRunPayload(spec, {
      action_id: declared.id,
      action_label: declared.label,
      action_kind: declared.actionKind,
      scope: declared.scope,
      ...(declared.scope === "record" && record ? { record } : {})
    });
    if (record && recordId && requiresRecordVersion(declared.actionKind)) {
      payload.expected_version = expectedRecordVersion(collectionId, spec, record, recordVersions, baseVersion);
    }
    const viewId = collectionTableViewId(spec);
    const operationKey = operationIdentityKey("collection.action.run", collectionId, declared.id, recordId || "collection", viewId, stableJson(payload));
    const recoveryRequest = /patch|delete|create/i.test(declared.actionKind ?? "")
      ? { kind: "collection.action.run" as const, collectionId, actionId: declared.id, actionKind: declared.actionKind, ...(recordId ? { recordId } : {}), viewId, payload }
      : undefined;
    const operation = await operationForDurableRetry(
      operationKey,
      recoveryRequest,
      () => ({
        id: createIdempotencyKey(),
        kind: "collection.action.run",
        collection_id: collectionId,
        action_id: declared.id,
        ...(recordId ? { record_id: recordId } : {}),
        view_id: viewId,
        payload
      })
    );
    return runSurfaceOperation(operation, operationKey);
  };

  return {
    listSchemas,
    recordBaseVersion,
    presentCollection,
    createRecord,
    patchRecord,
    deleteRecord,
    runAction
  };
}

export interface NativeCollectionCollectionListProps {
  schemas: readonly NativeCollectionSchema[];
  selectedCollectionId?: string;
  disabled?: boolean;
  onSelect: (collectionId: string) => void | Promise<void>;
}

export function NativeCollectionCollectionList({
  schemas,
  selectedCollectionId,
  disabled = false,
  onSelect
}: NativeCollectionCollectionListProps) {
  if (schemas.length === 0) {
    return <p className="native-collection-panel__empty">認可済みCollectionはありません。</p>;
  }
  return (
    <ul className="native-collection-panel__collection-list" aria-label="認可済みCollection一覧">
      {schemas.map((schema) => {
        const selected = schema.id === selectedCollectionId;
        return (
          <li key={schema.id}>
            <button
              type="button"
              className="native-collection-panel__collection-item"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => { void onSelect(schema.id); }}
            >
              <strong>{collectionSchemaLabel(schema)}</strong>
              <span>{schema.id}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function NativeCollectionPanel({ target, bridge, canEdit = false, canExecute = false, onClose, onDraftNavigationControllerChange }: NativeCollectionPanelProps) {
  const targetKey = nativeCollectionPanelTargetKey(target);
  const operations = useMemo(
    () => createNativeCollectionPanelOperations(target, bridge),
    [bridge, targetKey]
  );
  const targetKeyRef = useRef(targetKey);
  const operationsRef = useRef(operations);
  targetKeyRef.current = targetKey;
  operationsRef.current = operations;

  const [schemas, setSchemas] = useState<NativeCollectionSchema[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>();
  const [surfaceSpec, setSurfaceSpec] = useState<SurfaceRenderSpec>();
  const [surfaceLoading, setSurfaceLoading] = useState(false);
  const [surfaceSaving, setSurfaceSaving] = useState(false);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [surfaceConflict, setSurfaceConflict] = useState<string | null>(null);
  const [newDrafts, setNewDrafts] = useState<Record<string, Record<string, string>>>({});
  const [rowDrafts, setRowDrafts] = useState<Record<string, NativeCollectionRowDraft>>({});
  const loadGeneration = useRef(0);
  const surfaceGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const surfaceSpecRef = useRef<SurfaceRenderSpec | undefined>(undefined);
  const newDraftsRef = useRef(newDrafts);
  const rowDraftsRef = useRef(rowDrafts);
  surfaceSpecRef.current = surfaceSpec;
  newDraftsRef.current = newDrafts;
  rowDraftsRef.current = rowDrafts;

  const isCurrentContext = useCallback((): boolean => (
    targetKeyRef.current === targetKey && operationsRef.current === operations
  ), [operations, targetKey]);

  const isCurrentSurface = useCallback((spec: SurfaceRenderSpec): boolean => {
    const current = surfaceSpecRef.current;
    return isCurrentContext() && current !== undefined && collectionSurfaceIdentity(current) === collectionSurfaceIdentity(spec);
  }, [isCurrentContext]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    setSchemas([]);
    setSelectedCollectionId(undefined);
    setSurfaceSpec(undefined);
    setSurfaceError(null);
    setSurfaceConflict(null);
    setNewDrafts({});
    setRowDrafts({});
    setListLoading(true);
    setListError(null);
    void operations.listSchemas()
      .then((nextSchemas) => {
        if (generation !== loadGeneration.current || !isCurrentContext()) return;
        setSchemas(nextSchemas);
      })
      .catch((cause: unknown) => {
        if (generation !== loadGeneration.current || !isCurrentContext()) return;
        setListError(nativeCollectionPanelErrorMessage(cause, "Collection一覧を取得できませんでした。"));
      })
      .finally(() => {
        if (generation === loadGeneration.current && isCurrentContext()) setListLoading(false);
      });
  }, [isCurrentContext, operations]);

  const adoptSurface = useCallback((result: NativeCollectionSurfaceOperationResult): void => {
    if (!isCurrentContext()) return;
    const current = surfaceSpecRef.current;
    const preservedViewState = current && isJsonObject(current.props.view_state)
      ? current.props.view_state
      : undefined;
    setSurfaceSpec(preservedViewState
      ? withCollectionViewState(result.spec, preservedViewState)
      : result.spec);
    setSurfaceError(null);
    setSurfaceConflict(null);
  }, [isCurrentContext]);

  const runMutation = useCallback(async (
    task: () => Promise<NativeCollectionSurfaceOperationResult>,
    afterSuccess?: (result: NativeCollectionSurfaceOperationResult) => void,
    expectedSpec?: SurfaceRenderSpec
  ): Promise<void> => {
    if (!isCurrentContext()) throw new Error("workspace_navigation_changed");
    const expectedSurface = expectedSpec ? collectionSurfaceIdentity(expectedSpec) : undefined;
    const mutation = ++mutationGeneration.current;
    const canApplyResult = (): boolean => {
      const current = surfaceSpecRef.current;
      return isCurrentContext()
        && (expectedSurface === undefined || current !== undefined && collectionSurfaceIdentity(current) === expectedSurface);
    };
    setSurfaceSaving(true);
    setSurfaceError(null);
    setSurfaceConflict(null);
    try {
      const result = await task();
      if (canApplyResult()) {
        adoptSurface(result);
        afterSuccess?.(result);
      }
    } catch (cause) {
      if (canApplyResult()) {
        const message = nativeCollectionPanelErrorMessage(cause, "Collectionの操作に失敗しました。");
        setSurfaceError(message);
        setSurfaceConflict(nativeCollectionPanelConflictMessage(cause, message));
      }
      throw cause;
    } finally {
      if (isCurrentContext() && mutation === mutationGeneration.current) setSurfaceSaving(false);
    }
  }, [adoptSurface, isCurrentContext]);

  const updateLocalSurface = useCallback((spec: SurfaceRenderSpec, patch: Record<string, JsonValue>): void => {
    setSurfaceSpec((current) => current && collectionTableId(current) === collectionTableId(spec)
      ? withCollectionViewState(current, patch)
      : current);
  }, []);

  const selectCollection = useCallback(async (collectionId: string): Promise<void> => {
    if (!schemas.some((schema) => schema.id === collectionId)) return;
    const generation = ++surfaceGeneration.current;
    setSelectedCollectionId(collectionId);
    setSurfaceSpec(undefined);
    setSurfaceLoading(true);
    setSurfaceError(null);
    setSurfaceConflict(null);
    try {
      const result = await operations.presentCollection(collectionId);
      if (generation !== surfaceGeneration.current || !isCurrentContext()) return;
      setSurfaceSpec(result.spec);
    } catch (cause) {
      if (generation === surfaceGeneration.current && isCurrentContext()) {
        const message = nativeCollectionPanelErrorMessage(cause, "Collectionを開けませんでした。");
        setSurfaceError(message);
        setSurfaceConflict(nativeCollectionPanelConflictMessage(cause, message));
      }
    } finally {
      if (generation === surfaceGeneration.current && isCurrentContext()) setSurfaceLoading(false);
    }
  }, [isCurrentContext, operations, schemas]);

  const currentSpecMatches = isCurrentSurface;

  const collectionDraftForRecord = useCallback((record: NativeCollectionRecord): Record<string, string> => {
    const spec = surfaceSpecRef.current;
    if (!spec) return {};
    const key = rowDraftKey(collectionTableId(spec), collectionRecordId(record));
    const controlled = rowDraftsRef.current[key];
    if (controlled) return controlled.values;
    return Object.fromEntries(collectionTableEditableFields(spec).map((field) => {
      const fieldId = collectionFieldId(field);
      return [fieldId, collectionFieldInputValue(field, record[fieldId])];
    }));
  }, []);

  const collectionHasDraft = useCallback((spec: SurfaceRenderSpec | undefined): boolean => {
    if (!spec) return false;
    const collectionId = collectionTableId(spec);
    if (!collectionId) return false;
    const newDraft = newDraftsRef.current[collectionId];
    if (newDraft && Object.keys(newDraft).length > 0) return true;
    const prefix = `${collectionId}\n`;
    return Object.entries(rowDraftsRef.current).some(([key, draft]) => (
      key.startsWith(prefix) && Object.keys(draft.values).length > 0
    ));
  }, []);

  const discardCollectionDrafts = useCallback((collectionId: string): void => {
    if (!collectionId) return;
    const nextNewDrafts = withoutKey(newDraftsRef.current, collectionId);
    newDraftsRef.current = nextNewDrafts;
    setNewDrafts(nextNewDrafts);
    const prefix = `${collectionId}\n`;
    const nextRowDrafts = Object.fromEntries(
      Object.entries(rowDraftsRef.current).filter(([key]) => !key.startsWith(prefix))
    );
    rowDraftsRef.current = nextRowDrafts;
    setRowDrafts(nextRowDrafts);
  }, []);

  const saveCurrentCollectionDrafts = useCallback(async (
    initialSpec: SurfaceRenderSpec,
    snapshot: NativeCollectionDraftSnapshot
  ): Promise<NativeCollectionSurfaceOperationResult> => saveNativeCollectionDraftSnapshot(
    operations,
    initialSpec,
    snapshot,
    {
      onRowSaved: ({ key, draft, submittedValues, result }) => {
        if (!isCurrentSurface(initialSpec)) return;
        const currentDraft = rowDraftsRef.current[key];
        const recordId = key.slice(snapshot.collectionId.length + 1);
        const serverVersion = nativeCollectionServerRecordVersion(result, recordId);
        if (currentDraft && serverVersion !== undefined) {
          const nextDraft = nativeCollectionRowDraftAfterSave(
            currentDraft,
            { ...draft, values: submittedValues },
            serverVersion
          );
          const nextRowDrafts = nextDraft
            ? { ...rowDraftsRef.current, [key]: nextDraft }
            : withoutKey(rowDraftsRef.current, key);
          rowDraftsRef.current = nextRowDrafts;
          setRowDrafts(nextRowDrafts);
        }
        adoptSurface(result);
      },
      onNewDraftSaved: ({ collectionId, submittedValues, result }) => {
        if (!isCurrentSurface(initialSpec)) return;
        if (stringMapsEqual(newDraftsRef.current[collectionId] ?? {}, submittedValues)) {
          const nextNewDrafts = withoutKey(newDraftsRef.current, collectionId);
          newDraftsRef.current = nextNewDrafts;
          setNewDrafts(nextNewDrafts);
        }
        adoptSurface(result);
      }
    }
  ), [adoptSurface, isCurrentSurface, operations]);

  const saveDraftAndNavigate = useCallback(async (): Promise<boolean> => {
    if (!canEdit) return false;
    const currentSpec = surfaceSpecRef.current;
    if (!currentSpec) return false;
    const snapshot = captureNativeCollectionDraftSnapshot(
      collectionTableId(currentSpec),
      rowDraftsRef.current,
      newDraftsRef.current
    );
    try {
      await runMutation(
        () => saveCurrentCollectionDrafts(currentSpec, snapshot),
        undefined,
        currentSpec
      );
    } catch {
      return false;
    }
    if (nativeCollectionDraftSnapshotHasNewerChanges(snapshot, rowDraftsRef.current, newDraftsRef.current)) {
      setSurfaceError("保存中に入力された新しい下書きを保持しています。もう一度保存するか、破棄して移動してください。");
      return false;
    }
    return true;
  }, [canEdit, runMutation, saveCurrentCollectionDrafts]);

  const discardDraftAndNavigate = useCallback((): void => {
    const currentSpec = surfaceSpecRef.current;
    if (currentSpec) discardCollectionDrafts(collectionTableId(currentSpec));
  }, [discardCollectionDrafts]);

  const draftNavigation = useNativeDraftNavigation({
    scopeKey: "collection\n" + targetKey,
    label: "Collection",
    dirty: collectionHasDraft(surfaceSpec),
    saving: surfaceSaving,
    canSave: canEdit,
    saveUnavailableMessage: "このRoomではCollectionを編集できないため保存できません。下書きを破棄するか、保存権限を確認してください。",
    save: saveDraftAndNavigate,
    discard: discardDraftAndNavigate,
    onControllerChange: onDraftNavigationControllerChange
  });

  const controller = useMemo<NativeCollectionSurfaceController>(() => ({
    refreshCollectionTableSurface: (spec) => runMutation(
      () => operations.presentCollection(collectionTableId(spec), collectionTableViewId(spec)),
      undefined,
      spec
    ),
    runCollectionSchemaAction: (spec, action, record) => {
      const draft = record ? collectionDraftForRecord(record) : undefined;
      const baseVersion = record ? rowDraftBaseVersion(spec, record, rowDraftsRef.current) : undefined;
      return runMutation(
        () => operations.runAction(spec, action, record, baseVersion),
        () => {
          if (record && action.scope === "record" && requiresRecordVersion(action.actionKind)) {
            const key = rowDraftKey(collectionTableId(spec), collectionRecordId(record));
            const savedDraft = rowDraftsRef.current[key];
            if (!savedDraft || !draft || stringMapsEqual(savedDraft.values, draft)) {
              setRowDrafts((current) => withoutKey(current, key));
            }
          }
        },
        spec
      );
    },
    setCollectionSearchQuery: (spec, search) => {
      if (currentSpecMatches(spec)) updateLocalSurface(spec, { search });
    },
    setCollectionSortField: (spec, fieldId) => {
      if (currentSpecMatches(spec)) {
        updateLocalSurface(spec, {
          sort: { field_id: fieldId, direction: collectionSortDirection(spec) }
        });
      }
    },
    toggleCollectionSortDirection: (spec) => {
      if (currentSpecMatches(spec)) {
        updateLocalSurface(spec, {
          sort: {
            field_id: collectionSortFieldId(spec),
            direction: collectionSortDirection(spec) === "desc" ? "asc" : "desc"
          }
        });
      }
    },
    setCollectionFilterValue: (spec, value) => {
      if (currentSpecMatches(spec)) {
        const field = collectionFilterField(spec);
        updateLocalSurface(spec, {
          filter: { field_id: field ? collectionFieldId(field) : "", value }
        });
      }
    },
    setCollectionNewDraftValue: (field, value) => {
      const currentSpec = surfaceSpecRef.current;
      if (!currentSpec) return;
      const collectionId = collectionTableId(currentSpec);
      if (!collectionId) return;
      const next = {
        ...newDraftsRef.current,
        [collectionId]: { ...(newDraftsRef.current[collectionId] ?? {}), [field]: value }
      };
      newDraftsRef.current = next;
      setNewDrafts(next);
    },
    addCollectionRecord: (spec) => {
      const collectionId = collectionTableId(spec);
      const draft = { ...(newDraftsRef.current[collectionId] ?? {}) };
      return runMutation(
        () => operations.createRecord(spec, draft),
        () => setNewDrafts((current) => (
          stringMapsEqual(current[collectionId] ?? {}, draft)
            ? withoutKey(current, collectionId)
            : current
        )),
        spec
      );
    },
    selectCollectionRecord: (spec, record) => {
      const recordId = collectionRecordId(record);
      if (currentSpecMatches(spec) && recordId) updateLocalSurface(spec, { selected_record_id: recordId });
    },
    collectionDraft: collectionDraftForRecord,
    setCollectionDraftValue: (record, field, value) => {
      const spec = surfaceSpecRef.current;
      if (!spec) return;
      const key = rowDraftKey(collectionTableId(spec), collectionRecordId(record));
      if (!key) return;
      const knownBaseVersion = rowDraftsRef.current[key]?.baseVersion
        ?? operations.recordBaseVersion(spec, record);
      const next = {
        ...rowDraftsRef.current,
        [key]: updateNativeCollectionRowDraft(rowDraftsRef.current[key], knownBaseVersion, field, value)
      };
      rowDraftsRef.current = next;
      setRowDrafts(next);
    },
    saveCollectionRecord: (spec, record) => {
      const draft = collectionDraftForRecord(record);
      const baseVersion = rowDraftBaseVersion(spec, record, rowDraftsRef.current);
      const submittedBaseVersion = baseVersion ?? operations.recordBaseVersion(spec, record);
      const key = rowDraftKey(collectionTableId(spec), collectionRecordId(record));
      return runMutation(
        () => operations.patchRecord(spec, record, draft, submittedBaseVersion),
        (result) => {
          const savedDraft = rowDraftsRef.current[key];
          const serverVersion = nativeCollectionServerRecordVersion(result, collectionRecordId(record));
          if (savedDraft && serverVersion !== undefined) {
            const nextDraft = nativeCollectionRowDraftAfterSave(
              savedDraft,
              { values: draft, baseVersion: submittedBaseVersion },
              serverVersion
            );
            const nextRowDrafts = nextDraft
              ? { ...rowDraftsRef.current, [key]: nextDraft }
              : withoutKey(rowDraftsRef.current, key);
            rowDraftsRef.current = nextRowDrafts;
            setRowDrafts(nextRowDrafts);
          }
        },
        spec
      );
    },
    deleteCollectionRecordFromTable: (spec, record) => runMutation(
      () => operations.deleteRecord(spec, record, rowDraftBaseVersion(spec, record, rowDraftsRef.current)),
      () => setRowDrafts((current) => withoutKey(current, rowDraftKey(collectionTableId(spec), collectionRecordId(record)))),
      spec
    ),
    discardCollectionDraft: (spec, record) => {
      setRowDrafts((current) => withoutKey(current, rowDraftKey(collectionTableId(spec), collectionRecordId(record))));
    },
    discardCollectionNewDraft: (spec) => {
      setNewDrafts((current) => withoutKey(current, collectionTableId(spec)));
    }
  }), [collectionDraftForRecord, currentSpecMatches, operations, runMutation, updateLocalSurface]);

  const selectCollectionAfterNavigation = useCallback((collectionId: string): void => {
    void selectCollection(collectionId);
  }, [selectCollection]);

  const requestCollectionSelection = useCallback((collectionId: string): void => {
    if (!schemas.some((schema) => schema.id === collectionId) || collectionId === selectedCollectionId) return;
    draftNavigation.requestNavigation(() => selectCollectionAfterNavigation(collectionId));
  }, [draftNavigation, schemas, selectedCollectionId, selectCollectionAfterNavigation]);

  const requestClose = useCallback((): void => {
    draftNavigation.requestNavigation(onClose);
  }, [draftNavigation, onClose]);

  const selectedSchema = schemas.find((schema) => schema.id === selectedCollectionId);
  const selectedNewDraft = selectedCollectionId ? newDrafts[selectedCollectionId] ?? {} : {};

  return (
    <>
      <style>{panelStyles}</style>
      <aside className="native-collection-panel" aria-label="Room Collectionパネル">
        <header className="native-collection-panel__header">
          <div>
            <span className="native-collection-panel__eyebrow">Room collection</span>
            <h2>Collection</h2>
            <p>認可済みCollectionを、このRoomに固定して表示します。</p>
            <span className="native-collection-panel__target" aria-label="固定中のRoom対象">
              {target.connectionId} / {target.workspaceId} / {target.roomId}
            </span>
          </div>
          <button type="button" className="native-collection-panel__close" onClick={requestClose} aria-label="Collectionパネルを閉じる">閉じる</button>
        </header>

        <div className="native-collection-panel__status-stack" aria-live="polite">
          {listLoading ? <p role="status">Collection一覧を読み込み中…</p> : null}
          {surfaceLoading ? <p role="status">Collectionの表示を読み込み中…</p> : null}
          {surfaceSaving ? <p role="status">Collectionを保存中…入力中の下書きを保持しています。</p> : null}
          {listError ? <p role="alert">{listError}</p> : null}
          {surfaceError && !surfaceSpec ? <p role="alert">{surfaceError}</p> : null}
        </div>

        <div className="native-collection-panel__body">
          <nav className="native-collection-panel__navigation" aria-label="認可済みCollection一覧">
            <h3>Collection一覧</h3>
            <NativeCollectionCollectionList
              schemas={schemas}
              selectedCollectionId={selectedCollectionId}
              disabled={listLoading || surfaceLoading}
              onSelect={requestCollectionSelection}
            />
          </nav>

          <section className="native-collection-panel__surface" aria-label="選択中のCollection">
            {surfaceSpec ? (
              <NativeCollectionSurface
                spec={surfaceSpec}
                controller={controller}
                newDraft={selectedNewDraft}
                saving={surfaceSaving}
                error={surfaceError}
                conflict={surfaceConflict}
                canEdit={canEdit}
                canExecute={canExecute}
              />
            ) : selectedSchema || surfaceLoading ? (
              <p className="native-collection-panel__placeholder" role="status">
                {surfaceLoading ? "Collectionを準備しています…" : "Collectionを選択してください。"}
              </p>
            ) : (
              <p className="native-collection-panel__placeholder">左の一覧からCollectionを選択してください。</p>
            )}
          </section>
        </div>
      </aside>
      <NativeDraftNavigationPrompt controller={draftNavigation} />
    </>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function recordVersionKey(collectionId: string, recordId: string): string {
  return `${collectionId}\n${recordId}`;
}

function expectedRecordVersion(
  collectionId: string,
  spec: SurfaceRenderSpec,
  record: NativeCollectionRecord,
  versions: Map<string, number>,
  explicitVersion?: number
): number {
  if (explicitVersion !== undefined) {
    if (!validVersion(explicitVersion)) throw new Error("collection_record_expected_version_required");
    return explicitVersion;
  }
  const recordId = collectionRecordId(record);
  if (validVersion(record.version)) return record.version;
  const remembered = versions.get(recordVersionKey(collectionId, recordId));
  if (remembered !== undefined) return remembered;
  const specRecord = appCollectionRecords(spec).find((candidate) => collectionRecordId(candidate) === recordId);
  if (specRecord && validVersion(specRecord.version)) return specRecord.version;
  throw new Error("collection_record_expected_version_required");
}

function parseSurfaceResponse(
  response: SurfaceOperationResultEnvelope,
  operation: NativeCollectionSurfaceOperation
): NativeCollectionSurfaceOperationResponse {
  if (!response || typeof response !== "object" || !response.render_spec) {
    throw new Error("collection_surface_response_invalid");
  }
  const parsedRenderSpec = SurfaceRenderSpecSchema.safeParse(response.render_spec);
  if (!parsedRenderSpec.success) throw new Error("collection_surface_response_render_spec_invalid");
  const parsedOperation = SurfaceOperationSchema.safeParse(response.operation);
  if (!parsedOperation.success || !isNativeCollectionSurfaceOperation(parsedOperation.data) || !surfaceOperationsMatch(parsedOperation.data, operation)) {
    throw new Error("collection_surface_response_operation_mismatch");
  }
  if (collectionTableId(parsedRenderSpec.data) !== operation.collection_id) {
    throw new Error("collection_surface_response_scope_invalid");
  }
  const resultKind = expectedResultKind(operation);
  if (response.result_kind !== resultKind) throw new Error("collection_surface_response_result_kind_mismatch");
  const result = parseSurfaceResult(response.result, resultKind, operation.collection_id);
  assertSurfaceResultTarget(result, operation);
  const rawRenderSpecs = response.render_specs ?? [response.render_spec];
  if (!Array.isArray(rawRenderSpecs)) throw new Error("collection_surface_response_render_specs_invalid");
  const renderSpecs = rawRenderSpecs.map((candidate) => {
    const parsed = SurfaceRenderSpecSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("collection_surface_response_render_specs_invalid");
    return parsed.data;
  });
  return {
    operation: parsedOperation.data,
    result_kind: resultKind,
    render_spec: parsedRenderSpec.data,
    render_specs: renderSpecs.length > 0 ? renderSpecs : [parsedRenderSpec.data],
    result
  };
}

function expectedResultKind(operation: NativeCollectionSurfaceOperation): NativeCollectionSurfaceOperationResponse["result_kind"] {
  switch (operation.kind) {
    case "collection.view.present": return "collection_view";
    case "collection.record.create": return "collection_record";
    case "collection.record.patch": return "collection_patch";
    case "collection.record.delete": return "collection_delete";
    case "collection.action.run": return "collection_action";
  }
}

function parseSurfaceResult(
  value: unknown,
  resultKind: NativeCollectionSurfaceOperationResponse["result_kind"],
  collectionId: string
): NativeCollectionSurfaceResult {
  if (resultKind === "collection_view") {
    const object = asRecord(value);
    if (!object || !Array.isArray(object.records)) throw new Error("collection_surface_response_result_invalid");
    const records = object.records.map((record) => parseRecordMutationResult(record, collectionId));
    return { records };
  }
  if (resultKind === "collection_action") {
    const object = asRecord(value);
    if (!object || typeof object.action_id !== "string" || !object.action_id.trim()) {
      throw new Error("collection_surface_response_result_invalid");
    }
    return {
      action_id: object.action_id,
      ...(object.record === undefined ? {} : { record: parseRecordMutationResult(object.record, collectionId) })
    };
  }
  return parseRecordMutationResult(value, collectionId);
}

function isNativeCollectionViewResult(value: NativeCollectionSurfaceResult): value is NativeCollectionViewResult {
  return "records" in value;
}

function isNativeCollectionActionResult(value: NativeCollectionSurfaceResult): value is NativeCollectionActionResult {
  return "action_id" in value;
}

function nativeCollectionServerRecordVersion(
  result: NativeCollectionSurfaceOperationResult,
  recordId: string
): number | undefined {
  const operationResult = result.response.result;
  const record = isNativeCollectionViewResult(operationResult)
    ? undefined
    : isNativeCollectionActionResult(operationResult)
      ? operationResult.record
      : operationResult;
  return record?.id === recordId && validVersion(record.version) ? record.version : undefined;
}

function parseRecordMutationResult(value: unknown, collectionId: string): NativeCollectionRecordMutationResult {
  const object = asRecord(value);
  if (!object || typeof object.id !== "string" || !object.id.trim() || object.collection_id !== collectionId || !validVersion(object.version)) {
    throw new Error("collection_surface_response_result_invalid");
  }
  const data = object.data;
  if (!isJsonObject(data)) throw new Error("collection_surface_response_result_invalid");
  return { id: object.id, collection_id: collectionId, version: object.version, data };
}

function assertSurfaceResultTarget(
  result: NativeCollectionSurfaceResult,
  operation: NativeCollectionSurfaceOperation
): void {
  if (operation.kind === "collection.view.present") return;
  if (operation.kind === "collection.action.run") {
    if (!isNativeCollectionActionResult(result) || result.action_id !== operation.action_id) {
      throw new Error("collection_surface_response_result_scope_invalid");
    }
    if (result.record && operation.record_id && result.record.id !== operation.record_id) {
      throw new Error("collection_surface_response_result_scope_invalid");
    }
    return;
  }
  if (!("id" in result) || result.id !== operation.record_id) {
    throw new Error("collection_surface_response_result_scope_invalid");
  }
}

function isNativeCollectionSurfaceOperation(value: SurfaceOperation): value is NativeCollectionSurfaceOperation {
  return value.kind === "collection.view.present"
    || value.kind === "collection.record.create"
    || value.kind === "collection.record.patch"
    || value.kind === "collection.record.delete"
    || value.kind === "collection.action.run";
}

function surfaceOperationsMatch(left: NativeCollectionSurfaceOperation, right: NativeCollectionSurfaceOperation): boolean {
  if (left.id !== right.id || left.kind !== right.kind || left.collection_id !== right.collection_id) return false;
  switch (left.kind) {
    case "collection.view.present":
      return right.kind === "collection.view.present" && left.view_id === right.view_id;
    case "collection.record.create":
      return right.kind === "collection.record.create"
        && left.record_id === right.record_id
        && stableJson(left.data) === stableJson(right.data);
    case "collection.record.patch":
      return right.kind === "collection.record.patch"
        && left.record_id === right.record_id
        && left.patch_id === right.patch_id
        && left.expected_version === right.expected_version
        && stableJson(left.changes) === stableJson(right.changes)
        && stableJson(left.metadata ?? null) === stableJson(right.metadata ?? null);
    case "collection.record.delete":
      return right.kind === "collection.record.delete"
        && left.record_id === right.record_id
        && left.expected_version === right.expected_version
        && left.view_id === right.view_id;
    case "collection.action.run":
      return right.kind === "collection.action.run"
        && left.action_id === right.action_id
        && left.record_id === right.record_id
        && left.view_id === right.view_id
        && stableJson(left.payload) === stableJson(right.payload);
  }
}

function operationIdentityKey(kind: string, ...parts: string[]): string {
  return [kind, ...parts].join("\n");
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function assertEditableCollectionTable(spec: SurfaceRenderSpec): void {
  if (collectionRenderer(spec) !== "collection_table") throw new Error("collection_renderer_unsupported");
}

function requiredId(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name}_required`);
  return normalized;
}

function safeOperationId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 96) || "operation";
}

function requiresRecordVersion(actionKind?: string): boolean {
  return Boolean(actionKind && /patch|delete/i.test(actionKind));
}

function rowDraftKey(collectionId: string, recordId: string): string {
  return collectionId && recordId ? `${collectionId}\n${recordId}` : "";
}

function rowDraftBaseVersion(
  spec: SurfaceRenderSpec,
  record: NativeCollectionRecord,
  drafts: Record<string, NativeCollectionRowDraft>
): number | undefined {
  const key = rowDraftKey(collectionTableId(spec), collectionRecordId(record));
  return key ? drafts[key]?.baseVersion : undefined;
}

function collectionSurfaceIdentity(spec: SurfaceRenderSpec): string {
  return [spec.id, collectionTableId(spec), collectionTableViewId(spec)].join("\n");
}

function withoutKey<T>(value: Record<string, T>, key: string): Record<string, T> {
  if (!key || !(key in value)) return value;
  const next = { ...value };
  delete next[key];
  return next;
}

function stringMapsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => right[key] === left[key]);
}

function nativeCollectionRecordFromValue(value: Record<string, unknown>): NativeCollectionRecord | undefined {
  const rawId = value.id;
  if ((typeof rawId !== "string" && typeof rawId !== "number") || !String(rawId).trim()) return undefined;
  const entries: Array<[string, JsonValue]> = [];
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!isJsonValue(fieldValue)) return undefined;
    entries.push([key, fieldValue]);
  }
  return Object.fromEntries(entries.map(([key, fieldValue]) => (
    key === "id" ? [key, String(rawId).trim()] : [key, fieldValue]
  ))) as NativeCollectionRecord;
}

function collectionSchemaLabel(schema: NativeCollectionSchema): string {
  return schema.labels.ja?.trim() || schema.labels.en?.trim() || schema.id;
}

function nativeCollectionPanelErrorMessage(error: unknown, fallback: string): string {
  const record = asRecord(error);
  const body = asRecord(record?.body ?? record?.data);
  const code = nonEmptyString(body?.error) ?? nonEmptyString(body?.code) ?? nonEmptyString(record?.code);
  const latestVersion = validVersion(body?.latest_version) ? `latest_version=${body.latest_version}` : undefined;
  const detail = nonEmptyString(body?.message) ?? nonEmptyString(body?.detail) ?? latestVersion ?? nonEmptyString(record?.detail);
  if (code && detail && code !== detail) return `${code}: ${detail}`;
  if (code) return code;
  if (detail) return detail;
  if (error instanceof Error && error.message.trim()) return error.message;
  return nonEmptyString(error) ?? fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nativeCollectionPanelConflictMessage(cause: unknown, message: string): string | null {
  const record = asRecord(cause);
  const body = asRecord(record?.body ?? record?.data);
  const status = record?.status;
  const code = nonEmptyString(body?.error) ?? nonEmptyString(body?.code) ?? nonEmptyString(record?.code);
  const errorText = cause instanceof Error ? cause.message : "";
  const serverConflict = status === 409
    || Boolean(code && /collection_(?:record|patch|action|surface)_.*(?:conflict|version)/i.test(code))
    || /collection_(?:record|patch|action|surface)_.*(?:conflict|version)/i.test(errorText);
  return serverConflict ? message : null;
}

const panelStyles = `
.native-collection-panel { --ncp-ink: #edf2eb; --ncp-muted: #a4afa7; --ncp-dim: #6f7a73; --ncp-line: rgba(204,218,209,.14); --ncp-accent: #f1a65c; background: linear-gradient(145deg, rgba(22,29,26,.98), rgba(13,17,16,.98)); border-left: 1px solid var(--ncp-line); box-sizing: border-box; color: var(--ncp-ink); display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; width: min(920px, 100%); }
.native-collection-panel *, .native-collection-panel *::before, .native-collection-panel *::after { box-sizing: border-box; }
.native-collection-panel__header { align-items: flex-start; border-bottom: 1px solid var(--ncp-line); display: flex; gap: 14px; justify-content: space-between; padding: 18px 20px 15px; }
.native-collection-panel__eyebrow { color: var(--ncp-accent); display: block; font-size: 10px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
.native-collection-panel h2 { font-family: Georgia, "Times New Roman", serif; font-size: clamp(24px, 4vw, 34px); letter-spacing: -.035em; line-height: 1; margin: 7px 0 0; }
.native-collection-panel__header p { color: var(--ncp-muted); font-size: 12px; line-height: 1.5; margin: 8px 0 0; }
.native-collection-panel__target { color: var(--ncp-dim); display: block; font-size: 10px; margin-top: 8px; overflow-wrap: anywhere; }
.native-collection-panel__close { background: transparent; border: 1px solid var(--ncp-line); border-radius: 9px; color: var(--ncp-muted); cursor: pointer; font: inherit; font-size: 11px; min-height: 34px; padding: 7px 10px; white-space: nowrap; }
.native-collection-panel__close:hover { background: rgba(255,255,255,.06); color: var(--ncp-ink); }
.native-collection-panel__close:focus-visible, .native-collection-panel button:focus-visible { outline: 2px solid var(--ncp-accent); outline-offset: 2px; }
.native-collection-panel__status-stack { display: grid; gap: 7px; padding: 12px 20px 0; }
.native-collection-panel__status-stack p { border-left: 3px solid var(--ncp-accent); color: var(--ncp-muted); font-size: 11px; line-height: 1.45; margin: 0; padding: 6px 9px; }
.native-collection-panel__status-stack [role="alert"] { border-left-color: #ee8981; color: #f0a19b; }
.native-collection-panel__body { display: grid; flex: 1; gap: 14px; grid-template-columns: minmax(170px, 230px) minmax(0, 1fr); min-height: 0; overflow: auto; padding: 14px 20px 22px; }
.native-collection-panel__navigation { min-width: 0; }
.native-collection-panel__navigation h3 { color: var(--ncp-muted); font-size: 11px; letter-spacing: .08em; margin: 0 0 8px; text-transform: uppercase; }
.native-collection-panel__collection-list { display: grid; gap: 7px; list-style: none; margin: 0; padding: 0; }
.native-collection-panel__collection-item { align-items: flex-start; background: rgba(255,255,255,.035); border: 1px solid var(--ncp-line); border-radius: 10px; color: var(--ncp-ink); cursor: pointer; display: grid; gap: 4px; min-width: 0; padding: 10px 11px; text-align: left; width: 100%; }
.native-collection-panel__collection-item:hover, .native-collection-panel__collection-item[aria-pressed="true"] { background: rgba(241,166,92,.13); border-color: rgba(241,166,92,.4); }
.native-collection-panel__collection-item strong { font-size: 12px; overflow-wrap: anywhere; }
.native-collection-panel__collection-item span { color: var(--ncp-dim); font-size: 10px; overflow-wrap: anywhere; }
.native-collection-panel__empty, .native-collection-panel__placeholder { color: var(--ncp-dim); font-size: 12px; line-height: 1.55; margin: 0; }
.native-collection-panel__surface { min-width: 0; }
.native-collection-panel__surface > .native-collection-surface { min-width: 0; }
.native-collection-panel__navigation-dialog { align-items: center; background: rgba(4,8,6,.62); display: flex; inset: 0; justify-content: center; padding: 18px; position: fixed; z-index: 20; }
.native-collection-panel__navigation-dialog-card { background: #17201c; border: 1px solid rgba(204,218,209,.24); border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.34); color: var(--ncp-ink); max-width: 440px; padding: 18px; width: 100%; }
.native-collection-panel__navigation-dialog-card h3 { font-size: 16px; margin: 0; }
.native-collection-panel__navigation-dialog-card p { color: var(--ncp-muted); font-size: 12px; line-height: 1.5; margin: 8px 0 16px; }
.native-collection-panel__navigation-dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
@media (max-width: 700px) { .native-collection-panel { border-left: 0; width: 100%; } .native-collection-panel__header, .native-collection-panel__body { padding-left: 14px; padding-right: 14px; } .native-collection-panel__body { display: block; overflow: auto; } .native-collection-panel__navigation { margin-bottom: 14px; } .native-collection-panel__status-stack { padding-left: 14px; padding-right: 14px; } }
`;

export default NativeCollectionPanel;
import { NativeDraftNavigationPrompt } from "./NativeDraftNavigationPrompt";
import { useNativeDraftNavigation, type NativeDraftNavigationController } from "./use-native-draft-navigation";
