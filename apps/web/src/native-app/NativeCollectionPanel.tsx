import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollectionSchema, JsonValue } from "@samurai-agent/core-schemas";
import type {
  SurfaceOperation,
  SurfaceOperationResultEnvelope,
  SurfaceRenderSpec
} from "@samurai-agent/ui-protocol";
import {
  createIdempotencyKey,
  getWorkspaceClientBridge,
  type DesktopWorkspaceConnectionState
} from "../lib/api";
import {
  appCollectionRecords,
  collectionActionRunPayload,
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
  listWorkspaceCollectionSchemas?: (input: { roomId: string }) => Promise<{ schemas: NativeCollectionSchema[] }>;
  runWorkspaceCollectionSurfaceOperation?: (input: {
    roomId: string;
    operation: SurfaceOperation;
  }) => Promise<SurfaceOperationResultEnvelope>;
}

export interface NativeCollectionPanelProps {
  target: NativeCollectionPanelTarget;
  bridge?: NativeCollectionPanelBridge;
  canEdit?: boolean;
  canExecute?: boolean;
  onClose: () => void;
}

export interface NativeCollectionSurfaceOperationResult {
  response: SurfaceOperationResultEnvelope;
  operation: NativeCollectionSurfaceOperation;
  spec: SurfaceRenderSpec;
}

export interface NativeCollectionPanelOperations {
  listSchemas: () => Promise<NativeCollectionSchema[]>;
  presentCollection: (collectionId: string, viewId?: string) => Promise<NativeCollectionSurfaceOperationResult>;
  createRecord: (spec: SurfaceRenderSpec, draft: Record<string, string>) => Promise<NativeCollectionSurfaceOperationResult>;
  patchRecord: (spec: SurfaceRenderSpec, record: NativeCollectionRecord, draft: Record<string, string>) => Promise<NativeCollectionSurfaceOperationResult>;
  deleteRecord: (spec: SurfaceRenderSpec, record: NativeCollectionRecord) => Promise<NativeCollectionSurfaceOperationResult>;
  runAction: (spec: SurfaceRenderSpec, action: CollectionUiAction, record?: NativeCollectionRecord) => Promise<NativeCollectionSurfaceOperationResult>;
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

export function createNativeCollectionPanelOperations(
  target: NativeCollectionPanelTarget,
  bridgeSource?: NativeCollectionPanelBridge
): NativeCollectionPanelOperations {
  const bridge = bridgeSource ?? getWorkspaceClientBridge();
  const recordVersions = new Map<string, number>();

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
    if (recordId && version !== undefined) recordVersions.set(recordVersionKey(collectionId, recordId), version);
  };

  const rememberSpec = (spec: SurfaceRenderSpec): void => {
    const collectionId = collectionTableId(spec);
    if (!collectionId) return;
    for (const record of appCollectionRecords(spec)) rememberRecord(collectionId, record);
  };

  const rememberResponse = (response: SurfaceOperationResultEnvelope, collectionId: string): void => {
    rememberSpec(response.render_spec);
    const result = asRecord(response.result);
    if (Array.isArray(result?.records)) {
      for (const record of result.records) rememberRecord(collectionId, record);
    }
    rememberRecord(collectionId, response.result);
    rememberRecord(collectionId, result?.record);
  };

  const runSurfaceOperation = async (
    operation: NativeCollectionSurfaceOperation
  ): Promise<NativeCollectionSurfaceOperationResult> => {
    const activeBridge = requireBridge();
    if (!activeBridge.runWorkspaceCollectionSurfaceOperation) {
      throw new Error("workspace_collection_surface_bridge_unavailable");
    }
    const response = await withNativeCollectionPanelTarget(
      activeBridge,
      target,
      () => activeBridge.runWorkspaceCollectionSurfaceOperation!({ roomId: target.roomId, operation })
    );
    validateSurfaceResponse(response, operation);
    rememberResponse(response, operation.collection_id);
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
      () => activeBridge.listWorkspaceCollectionSchemas!({ roomId: target.roomId })
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

  const createRecord = async (
    spec: SurfaceRenderSpec,
    draft: Record<string, string>
  ): Promise<NativeCollectionSurfaceOperationResult> => {
    assertEditableCollectionTable(spec);
    const operationId = createIdempotencyKey();
    const operation: NativeCollectionSurfaceOperation = {
      id: operationId,
      kind: "collection.record.create",
      collection_id: requiredId(collectionTableId(spec), "collectionId"),
      record_id: `record_${safeOperationId(operationId)}`,
      data: collectionCreateDataForView(spec, draft)
    };
    return runSurfaceOperation(operation);
  };

  const patchRecord = async (
    spec: SurfaceRenderSpec,
    record: NativeCollectionRecord,
    draft: Record<string, string>
  ): Promise<NativeCollectionSurfaceOperationResult> => {
    assertEditableCollectionTable(spec);
    const collectionId = requiredId(collectionTableId(spec), "collectionId");
    const recordId = requiredId(collectionRecordId(record), "recordId");
    const expectedVersion = expectedRecordVersion(collectionId, spec, record, recordVersions);
    const operationId = createIdempotencyKey();
    const changes = Object.fromEntries(collectionTableEditableFields(spec).map((field) => {
      const fieldId = collectionFieldId(field);
      const rawValue = draft[fieldId] ?? collectionFieldInputValue(field, record[fieldId]);
      return [fieldId, collectionDraftValueFromRaw(field, rawValue)];
    })) as Record<string, JsonValue>;
    const operation: NativeCollectionSurfaceOperation = {
      id: operationId,
      kind: "collection.record.patch",
      collection_id: collectionId,
      record_id: recordId,
      patch_id: `patch_${safeOperationId(operationId)}`,
      expected_version: expectedVersion,
      changes,
      metadata: { view_id: collectionTableViewId(spec) }
    };
    return runSurfaceOperation(operation);
  };

  const deleteRecord = async (
    spec: SurfaceRenderSpec,
    record: NativeCollectionRecord
  ): Promise<NativeCollectionSurfaceOperationResult> => {
    assertEditableCollectionTable(spec);
    const collectionId = requiredId(collectionTableId(spec), "collectionId");
    const recordId = requiredId(collectionRecordId(record), "recordId");
    const expectedVersion = expectedRecordVersion(collectionId, spec, record, recordVersions);
    const operation: NativeCollectionSurfaceOperation = {
      id: createIdempotencyKey(),
      kind: "collection.record.delete",
      collection_id: collectionId,
      record_id: recordId,
      expected_version: expectedVersion,
      view_id: collectionTableViewId(spec)
    };
    return runSurfaceOperation(operation);
  };

  const runAction = async (
    spec: SurfaceRenderSpec,
    action: CollectionUiAction,
    record?: NativeCollectionRecord
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
      payload.expected_version = expectedRecordVersion(collectionId, spec, record, recordVersions);
    }
    const operation: NativeCollectionSurfaceOperation = {
      id: createIdempotencyKey(),
      kind: "collection.action.run",
      collection_id: collectionId,
      action_id: declared.id,
      ...(recordId ? { record_id: recordId } : {}),
      view_id: collectionTableViewId(spec),
      payload
    };
    return runSurfaceOperation(operation);
  };

  return {
    listSchemas,
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

export function NativeCollectionPanel({ target, bridge, canEdit = false, canExecute = false, onClose }: NativeCollectionPanelProps) {
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
  const [rowDrafts, setRowDrafts] = useState<Record<string, Record<string, string>>>({});
  const loadGeneration = useRef(0);
  const surfaceGeneration = useRef(0);
  const surfaceSpecRef = useRef<SurfaceRenderSpec | undefined>(undefined);
  const rowDraftsRef = useRef(rowDrafts);
  surfaceSpecRef.current = surfaceSpec;
  rowDraftsRef.current = rowDrafts;

  const isCurrentContext = useCallback((): boolean => (
    targetKeyRef.current === targetKey && operationsRef.current === operations
  ), [operations, targetKey]);

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
    setSurfaceSpec(result.spec);
    setSurfaceError(null);
    setSurfaceConflict(null);
  }, [isCurrentContext]);

  const runMutation = useCallback(async (
    task: () => Promise<NativeCollectionSurfaceOperationResult>,
    afterSuccess?: () => void
  ): Promise<void> => {
    if (!isCurrentContext()) throw new Error("workspace_navigation_changed");
    setSurfaceSaving(true);
    setSurfaceError(null);
    setSurfaceConflict(null);
    try {
      const result = await task();
      if (isCurrentContext()) {
        adoptSurface(result);
        afterSuccess?.();
      }
    } catch (cause) {
      if (isCurrentContext()) {
        const message = nativeCollectionPanelErrorMessage(cause, "Collectionの操作に失敗しました。");
        setSurfaceError(message);
        setSurfaceConflict(isConflictMessage(message) ? message : null);
      }
      throw cause;
    } finally {
      if (isCurrentContext()) setSurfaceSaving(false);
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
        setSurfaceConflict(isConflictMessage(message) ? message : null);
      }
    } finally {
      if (generation === surfaceGeneration.current && isCurrentContext()) setSurfaceLoading(false);
    }
  }, [isCurrentContext, operations, schemas]);

  const currentSpecMatches = useCallback((spec: SurfaceRenderSpec): boolean => (
    isCurrentContext()
      && surfaceSpecRef.current !== undefined
      && surfaceSpecRef.current.id === spec.id
      && collectionTableId(surfaceSpecRef.current) === collectionTableId(spec)
  ), [isCurrentContext]);

  const collectionDraftForRecord = useCallback((record: NativeCollectionRecord): Record<string, string> => {
    const spec = surfaceSpecRef.current;
    if (!spec) return {};
    const key = rowDraftKey(collectionTableId(spec), collectionRecordId(record));
    const controlled = rowDraftsRef.current[key];
    if (controlled) return controlled;
    return Object.fromEntries(collectionTableEditableFields(spec).map((field) => {
      const fieldId = collectionFieldId(field);
      return [fieldId, collectionFieldInputValue(field, record[fieldId])];
    }));
  }, []);

  const controller = useMemo<NativeCollectionSurfaceController>(() => ({
    refreshCollectionTableSurface: (spec) => runMutation(
      () => operations.presentCollection(collectionTableId(spec), collectionTableViewId(spec)),
    ),
    runCollectionSchemaAction: (spec, action, record) => runMutation(
      () => operations.runAction(spec, action, record),
      () => {
        if (record && action.scope === "record") {
          const key = rowDraftKey(collectionTableId(spec), collectionRecordId(record));
          setRowDrafts((current) => withoutKey(current, key));
        }
      }
    ),
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
      setNewDrafts((current) => ({
        ...current,
        [collectionId]: { ...(current[collectionId] ?? {}), [field]: value }
      }));
    },
    addCollectionRecord: (spec) => {
      const collectionId = collectionTableId(spec);
      return runMutation(
        () => operations.createRecord(spec, newDrafts[collectionId] ?? {}),
        () => setNewDrafts((current) => withoutKey(current, collectionId))
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
      setRowDrafts((current) => ({
        ...current,
        [key]: { ...(current[key] ?? {}), [field]: value }
      }));
    },
    saveCollectionRecord: (spec, record) => runMutation(
      () => operations.patchRecord(spec, record, collectionDraftForRecord(record)),
      () => setRowDrafts((current) => withoutKey(current, rowDraftKey(collectionTableId(spec), collectionRecordId(record))))
    ),
    deleteCollectionRecordFromTable: (spec, record) => runMutation(
      () => operations.deleteRecord(spec, record),
      () => setRowDrafts((current) => withoutKey(current, rowDraftKey(collectionTableId(spec), collectionRecordId(record))))
    )
  }), [collectionDraftForRecord, currentSpecMatches, newDrafts, operations, runMutation, updateLocalSurface]);

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
          <button type="button" className="native-collection-panel__close" onClick={onClose} aria-label="Collectionパネルを閉じる">閉じる</button>
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
              onSelect={selectCollection}
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
  versions: Map<string, number>
): number {
  const recordId = collectionRecordId(record);
  const remembered = versions.get(recordVersionKey(collectionId, recordId));
  if (remembered !== undefined) return remembered;
  if (validVersion(record.version)) return record.version;
  const specRecord = appCollectionRecords(spec).find((candidate) => collectionRecordId(candidate) === recordId);
  if (specRecord && validVersion(specRecord.version)) return specRecord.version;
  throw new Error("collection_record_expected_version_required");
}

function validateSurfaceResponse(response: SurfaceOperationResultEnvelope, operation: NativeCollectionSurfaceOperation): void {
  if (!response || !response.render_spec) throw new Error("collection_surface_response_invalid");
  if (response.operation) {
    if (response.operation.id !== operation.id || response.operation.kind !== operation.kind) {
      throw new Error("collection_surface_response_operation_mismatch");
    }
  }
  if (collectionTableId(response.render_spec) !== operation.collection_id) {
    throw new Error("collection_surface_response_scope_invalid");
  }
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

function withoutKey<T>(value: Record<string, T>, key: string): Record<string, T> {
  if (!key || !(key in value)) return value;
  const next = { ...value };
  delete next[key];
  return next;
}

function collectionSchemaLabel(schema: NativeCollectionSchema): string {
  return schema.labels.ja?.trim() || schema.labels.en?.trim() || schema.id;
}

function nativeCollectionPanelErrorMessage(error: unknown, fallback: string): string {
  const record = asRecord(error);
  const body = asRecord(record?.body ?? record?.data);
  const code = nonEmptyString(body?.error) ?? nonEmptyString(body?.code) ?? nonEmptyString(record?.code);
  const detail = nonEmptyString(body?.message) ?? nonEmptyString(body?.detail) ?? nonEmptyString(record?.detail);
  if (code && detail && code !== detail) return `${code}: ${detail}`;
  if (code) return code;
  if (detail) return detail;
  if (error instanceof Error && error.message.trim()) return error.message;
  return nonEmptyString(error) ?? fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isConflictMessage(value: string): boolean {
  return /conflict|version|stale|競合|同時|最新版|版/.test(value.toLowerCase());
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
@media (max-width: 700px) { .native-collection-panel { border-left: 0; width: 100%; } .native-collection-panel__header, .native-collection-panel__body { padding-left: 14px; padding-right: 14px; } .native-collection-panel__body { display: block; overflow: auto; } .native-collection-panel__navigation { margin-bottom: 14px; } .native-collection-panel__status-stack { padding-left: 14px; padding-right: 14px; } }
`;

export default NativeCollectionPanel;
