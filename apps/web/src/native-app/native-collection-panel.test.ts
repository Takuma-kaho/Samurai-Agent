import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SurfaceOperation, SurfaceOperationResultEnvelope, SurfaceOperationResultKind, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  createNativeCollectionPanelOperations,
  captureNativeCollectionDraftSnapshot,
  NativeCollectionCollectionList,
  NativeCollectionPanel,
  nativeCollectionDraftSnapshotHasNewerChanges,
  nativeCollectionRowDraftAfterSave,
  saveNativeCollectionDraftSnapshot,
  updateNativeCollectionRowDraft,
  type NativeCollectionSurfaceOperationResult,
  type NativeCollectionPanelBridge,
  type NativeCollectionPanelTarget,
  type NativeCollectionRowDraft,
  type NativeCollectionSchema
} from "./NativeCollectionPanel";
import type { CollectionUiAction } from "../lib/collection-view-state";
import type { WorkspaceOperationHistoryRecord } from "../lib/workspace-browser-bridge";

const target: NativeCollectionPanelTarget = {
  connectionId: "connection-a",
  workspaceId: "workspace-a",
  roomId: "room-a"
};

const otherTarget: NativeCollectionPanelTarget = {
  connectionId: "connection-b",
  workspaceId: "workspace-b",
  roomId: "room-b"
};

const schema: NativeCollectionSchema = {
  id: "movies",
  version: "1",
  labels: { ja: "映画ログ" } as NativeCollectionSchema["labels"],
  descriptions: { ja: "映画の記録" } as NativeCollectionSchema["descriptions"],
  fields: [{ id: "title", type: "string", required: true }],
  refs: [],
  embeds: [],
  derived_fields: [],
  triggers: [],
  actions: [],
  views: [{ id: "movies_table", renderer: "collection_table", label: "表" }],
  permissions: {},
  file_path: "collections/movies/schema.md",
  resource_version: 3,
  room_id: target.roomId
};

describe("NativeCollectionPanel bridge boundary", () => {
  it("rejects a response when the active Workspace changes during an operation", async () => {
    let checks = 0;
    const runOperation = vi.fn(async ({ operation }: { roomId: string; operation: SurfaceOperation }) => surfaceResponse(operation));
    const bridge: NativeCollectionPanelBridge = {
      listWorkspaceConnections: vi.fn(async () => ({
        activeTarget: checks++ === 0 ? target : otherTarget,
        connections: []
      })),
      runWorkspaceCollectionSurfaceOperation: runOperation
    };

    const operations = createNativeCollectionPanelOperations(target, bridge);

    await expect(operations.presentCollection("movies")).rejects.toThrow("workspace_navigation_changed");
    expect(runOperation).toHaveBeenCalledTimes(1);
  });

  it("sends create and patch through SurfaceOperation with a stable id and expected version", async () => {
    const runOperation = vi.fn(async ({ operation }: { roomId: string; operation: SurfaceOperation }) => surfaceResponse(
      operation,
      operation.kind === "collection.record.patch"
        ? { id: "record-1", collection_id: "movies", version: 8, data: { title: "更新後" } }
        : { id: operation.kind === "collection.record.create" ? operation.record_id : "record-created", collection_id: "movies", version: 1, data: { title: "新しい" } }
    ));
    const bridge = readyBridge(runOperation);
    const operations = createNativeCollectionPanelOperations(target, bridge);
    const currentSpec = collectionSpec();

    await operations.createRecord(currentSpec, { title: "新しい" });
    await operations.patchRecord(currentSpec, { id: "record-1", title: "変更前", version: 7 }, { title: "変更後" });

    const createCall = runOperation.mock.calls[0]?.[0];
    const patchCall = runOperation.mock.calls[1]?.[0];
    if (!createCall || !patchCall) throw new Error("surface operation calls missing");
    const createOperation = createCall.operation;
    const patchOperation = patchCall.operation;
    if (createOperation.kind !== "collection.record.create") throw new Error("create operation missing");
    if (patchOperation.kind !== "collection.record.patch") throw new Error("patch operation missing");
    expect(createCall.roomId).toBe(target.roomId);
    expect(createOperation.kind).toBe("collection.record.create");
    expect(createOperation.id).toEqual(expect.any(String));
    expect(createOperation.record_id).toMatch(/^record_/);
    expect(createOperation.data).toEqual({ title: "新しい" });
    expect(patchCall.roomId).toBe(target.roomId);
    expect(patchOperation).toMatchObject({
      kind: "collection.record.patch",
      collection_id: "movies",
      record_id: "record-1",
      expected_version: 7
    });
    expect(patchOperation.changes).toEqual({ title: "変更後" });
  });

  it("reuses operation, record, and patch IDs after response loss, then allocates a new explicit create", async () => {
    const attempts = new Map<SurfaceOperation["kind"], number>();
    const calls: SurfaceOperation[] = [];
    const runOperation = vi.fn(async ({ operation }: { roomId: string; operation: SurfaceOperation }) => {
      calls.push(operation);
      const attempt = (attempts.get(operation.kind) ?? 0) + 1;
      attempts.set(operation.kind, attempt);
      if (attempt === 1) throw new Error("response_lost");
      return surfaceResponse(operation);
    });
    const operations = createNativeCollectionPanelOperations(target, readyBridge(runOperation));
    const currentSpec = collectionSpec();
    const record = { id: "record-1", title: "変更前", version: 7 };
    const action: CollectionUiAction = {
      id: "refresh",
      label: "更新",
      operationKind: "collection.action.run",
      actionKind: "refresh",
      scope: "collection"
    };

    await expect(operations.createRecord(currentSpec, { title: "同じ入力" })).rejects.toThrow("response_lost");
    await operations.createRecord(currentSpec, { title: "同じ入力" });
    await operations.createRecord(currentSpec, { title: "同じ入力" });

    await expect(operations.patchRecord(currentSpec, record, { title: "変更後" })).rejects.toThrow("response_lost");
    await operations.patchRecord(currentSpec, record, { title: "変更後" });
    await expect(operations.deleteRecord(currentSpec, record)).rejects.toThrow("response_lost");
    await operations.deleteRecord(currentSpec, record);
    await expect(operations.runAction(currentSpec, action)).rejects.toThrow("response_lost");
    await operations.runAction(currentSpec, action);

    const createAttempts = calls.filter((operation) => operation.kind === "collection.record.create");
    const patchAttempts = calls.filter((operation) => operation.kind === "collection.record.patch");
    const deleteAttempts = calls.filter((operation) => operation.kind === "collection.record.delete");
    const actionAttempts = calls.filter((operation) => operation.kind === "collection.action.run");
    expect(createAttempts[0]?.id).toBe(createAttempts[1]?.id);
    expect(createAttempts[0]?.record_id).toBe(createAttempts[1]?.record_id);
    expect(createAttempts[2]?.id).not.toBe(createAttempts[1]?.id);
    expect(patchAttempts[0]?.id).toBe(patchAttempts[1]?.id);
    expect(patchAttempts[0]?.patch_id).toBe(patchAttempts[1]?.patch_id);
    expect(deleteAttempts[0]?.id).toBe(deleteAttempts[1]?.id);
    expect(actionAttempts[0]?.id).toBe(actionAttempts[1]?.id);
  });

  it("recovers Collection create and patch IDs from durable history after component restart", async () => {
    const history: WorkspaceOperationHistoryRecord[] = [];
    const firstFailures = new Set<SurfaceOperation["kind"]>();
    const runOperation = vi.fn(async ({ operation }: { roomId: string; operation: SurfaceOperation }) => {
      if ((operation.kind === "collection.record.create" || operation.kind === "collection.record.patch")
        && !firstFailures.has(operation.kind)) {
        firstFailures.add(operation.kind);
        history.push(operation.kind === "collection.record.create"
          ? collectionRecordHistory(operation)
          : collectionPatchHistory(operation));
        throw new Error("response_lost");
      }
      return surfaceResponse(operation);
    });
    const listWorkspaceOperationHistory = vi.fn(async ({ recordType }: { recordType: string }) => ({
      records: history.filter((record) => record.recordType === recordType)
    }));
    const bridge: NativeCollectionPanelBridge = {
      listWorkspaceConnections: vi.fn(async () => ({ activeTarget: target, connections: [] })),
      listWorkspaceOperationHistory,
      runWorkspaceCollectionSurfaceOperation: runOperation
    };
    const currentSpec = collectionSpec();
    const record = { id: "record-1", title: "変更前", version: 7 };

    const firstComponent = createNativeCollectionPanelOperations(target, bridge);
    await expect(firstComponent.createRecord(currentSpec, { title: "再起動後も同じ" })).rejects.toThrow("response_lost");
    const firstCreate = runOperation.mock.calls[0]?.[0]?.operation;
    if (!firstCreate || firstCreate.kind !== "collection.record.create") throw new Error("create operation missing");

    const restartedComponent = createNativeCollectionPanelOperations(target, bridge);
    const recoveredCreate = await restartedComponent.createRecord(currentSpec, { title: "再起動後も同じ" });
    expect(recoveredCreate.operation.id).toBe(firstCreate.id);
    expect(recoveredCreate.operation.kind).toBe("collection.record.create");

    const beforePatch = runOperation.mock.calls.length;
    const patchComponent = createNativeCollectionPanelOperations(target, bridge);
    await expect(patchComponent.patchRecord(currentSpec, record, { title: "永続復旧" })).rejects.toThrow("response_lost");
    const firstPatch = runOperation.mock.calls[beforePatch]?.[0]?.operation;
    if (!firstPatch || firstPatch.kind !== "collection.record.patch") throw new Error("patch operation missing");

    const restartedPatchComponent = createNativeCollectionPanelOperations(target, bridge);
    const recoveredPatch = await restartedPatchComponent.patchRecord(currentSpec, record, { title: "永続復旧" });
    expect(recoveredPatch.operation.id).toBe(firstPatch.id);
    expect(recoveredPatch.operation.kind).toBe("collection.record.patch");
    if (recoveredPatch.operation.kind !== "collection.record.patch"
      || firstPatch.kind !== "collection.record.patch") throw new Error("patch operation missing after restart");
    expect(recoveredPatch.operation.patch_id).toBe(firstPatch.patch_id);
  });

  it("retries a durable delete with the same ID from a fresh operation instance", async () => {
    const history: WorkspaceOperationHistoryRecord[] = [];
    const runOperation = vi.fn(async ({ operation }: { roomId: string; operation: SurfaceOperation }) => {
      if (operation.kind === "collection.record.delete" && history.length === 0) {
        history.push(collectionDeleteHistory(operation));
        throw new Error("response_lost");
      }
      return surfaceResponse(operation);
    });
    const listWorkspaceOperationHistory = vi.fn(async ({ recordType }: { recordType: string }) => ({
      records: history.filter((record) => record.recordType === recordType)
    }));
    const bridge: NativeCollectionPanelBridge = {
      listWorkspaceConnections: vi.fn(async () => ({ activeTarget: target, connections: [] })),
      listWorkspaceOperationHistory,
      runWorkspaceCollectionSurfaceOperation: runOperation
    };
    const currentSpec = collectionSpec();
    const record = { id: "record-1", title: "削除対象", version: 7 };

    const firstComponent = createNativeCollectionPanelOperations(target, bridge);
    await expect(firstComponent.deleteRecord(currentSpec, record)).rejects.toThrow("response_lost");
    const firstDelete = runOperation.mock.calls[0]?.[0]?.operation;
    if (!firstDelete || firstDelete.kind !== "collection.record.delete") throw new Error("delete operation missing");

    const restartedComponent = createNativeCollectionPanelOperations(target, bridge);
    const recoveredDelete = await restartedComponent.deleteRecord(currentSpec, record);
    expect(recoveredDelete.operation.kind).toBe("collection.record.delete");
    if (recoveredDelete.operation.kind !== "collection.record.delete") throw new Error("delete operation missing after restart");
    expect(recoveredDelete.operation.id).toBe(firstDelete.id);
    expect(runOperation).toHaveBeenCalledTimes(2);
    expect(listWorkspaceOperationHistory).toHaveBeenCalledWith(expect.objectContaining({ recordType: "collection_record" }));
  });

  it("does not auto-send a new Collection ID when durable history is ambiguous", async () => {
    const operation = {
      kind: "collection.record.create" as const,
      collection_id: "movies",
      record_id: "record_operation-one",
      data: { title: "重複候補" },
      id: "operation-one"
    };
    const history: WorkspaceOperationHistoryRecord[] = [
      collectionRecordHistory(operation),
      collectionRecordHistory({ ...operation, id: "operation-two", record_id: "record_operation-two" })
    ];
    const runOperation = vi.fn(async ({ operation: sent }: { roomId: string; operation: SurfaceOperation }) => surfaceResponse(sent));
    const bridge: NativeCollectionPanelBridge = {
      listWorkspaceConnections: vi.fn(async () => ({ activeTarget: target, connections: [] })),
      listWorkspaceOperationHistory: vi.fn(async () => ({ records: history })),
      runWorkspaceCollectionSurfaceOperation: runOperation
    };

    const operations = createNativeCollectionPanelOperations(target, bridge);
    await expect(operations.createRecord(collectionSpec(), { title: "重複候補" }))
      .rejects.toThrow("collection_operation_recovery_ambiguous");
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("keeps the first base version when a dirty row receives another field edit", () => {
    const first = updateNativeCollectionRowDraft(undefined, 7, "title", "利用者のdraft");
    const second = updateNativeCollectionRowDraft(first, 12, "status", "観たい");
    expect(second).toEqual({
      values: { title: "利用者のdraft", status: "観たい" },
      baseVersion: 7
    });
  });

  it("detects edits made after a save snapshot without treating the pending clear as a new edit", () => {
    const snapshot = captureNativeCollectionDraftSnapshot(
      "movies",
      { "movies\nrecord-1": { values: { title: "保存時" }, baseVersion: 7 } },
      { movies: { title: "新規" } }
    );

    expect(nativeCollectionDraftSnapshotHasNewerChanges(snapshot, {
      "movies\nrecord-1": { values: { title: "保存後の入力" }, baseVersion: 7 }
    }, { movies: { title: "新規" } })).toBe(true);
    expect(nativeCollectionDraftSnapshotHasNewerChanges(snapshot, {
      "movies\nrecord-1": { values: { title: "保存時" }, baseVersion: 7 }
    }, { movies: { title: "新規" } })).toBe(false);
    expect(nativeCollectionDraftSnapshotHasNewerChanges(snapshot, {}, {})).toBe(false);
  });

  it("keeps later drafts and reports the latest durable spec when a batch save fails partway through", async () => {
    const original = collectionSpec();
    const originalData = original.props.data as Record<string, unknown>;
    const initialSpec = {
      ...original,
      props: {
        ...original.props,
        data: {
          ...originalData,
          records: [
            { id: "record-1", title: "変更前 A", version: 7 },
            { id: "record-2", title: "変更前 B", version: 4 }
          ]
        }
      }
    } as SurfaceRenderSpec;
    const firstSpec = {
      ...initialSpec,
      props: {
        ...initialSpec.props,
        data: {
          ...originalData,
          records: [
            { id: "record-1", title: "保存済み A", version: 8 },
            { id: "record-2", title: "変更前 B", version: 4 }
          ]
        }
      }
    } as SurfaceRenderSpec;
    const firstResult = { spec: firstSpec } as NativeCollectionSurfaceOperationResult;
    const failure = new Error("collection_record_version_conflict");
    const patchRecord = vi.fn(async (_spec: SurfaceRenderSpec, record: { id?: unknown }) => {
      if (record.id === "record-1") return firstResult;
      throw failure;
    });
    const createRecord = vi.fn();
    const savedRows: string[] = [];

    await expect(saveNativeCollectionDraftSnapshot(
      { patchRecord, createRecord },
      initialSpec,
      {
        collectionId: "movies",
        rows: {
          "movies\nrecord-1": { values: { title: "保存済み A" }, baseVersion: 7 },
          "movies\nrecord-2": { values: { title: "保存予定 B" }, baseVersion: 4 }
        },
        newDraft: {}
      },
      { onRowSaved: ({ key, result }) => {
        savedRows.push(key);
        expect(result).toBe(firstResult);
      } }
    )).rejects.toBe(failure);

    expect(savedRows).toEqual(["movies\nrecord-1"]);
    expect(patchRecord).toHaveBeenCalledTimes(2);
    expect(patchRecord.mock.calls[1]?.[0]).toBe(firstSpec);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("keeps a same-row edit during save and sends the returned version on the second save", async () => {
    const currentSpec = collectionSpec();
    const draftKey = "movies\nrecord-1";
    let firstOperation: SurfaceOperation | undefined;
    let releaseFirst!: () => void;
    const firstResponse = new Promise<SurfaceOperationResultEnvelope<unknown>>((resolve) => {
      releaseFirst = () => {
        if (!firstOperation) throw new Error("first operation missing");
        resolve(surfaceResponse(firstOperation, {
          id: "record-1",
          collection_id: "movies",
          version: 8,
          data: { title: "一回目保存済み" }
        }));
      };
    });
    const runOperation = vi.fn(({ operation }: { roomId: string; operation: SurfaceOperation }) => {
      if (!firstOperation) {
        firstOperation = operation;
        return firstResponse;
      }
      return Promise.resolve(surfaceResponse(operation, {
        id: "record-1",
        collection_id: "movies",
        version: 9,
        data: { title: "二回目保存済み" }
      }));
    });
    const operations = createNativeCollectionPanelOperations(target, readyBridge(runOperation));
    let rowDrafts: Record<string, NativeCollectionRowDraft> = {
      [draftKey]: updateNativeCollectionRowDraft(undefined, 7, "title", "一回目の入力")
    };
    const applySavedRow = ({
      key,
      draft,
      result
    }: {
      key: string;
      draft: NativeCollectionRowDraft;
      result: NativeCollectionSurfaceOperationResult;
    }): void => {
      const serverResult = result.response.result;
      if (!("id" in serverResult)) throw new Error("saved row result missing");
      const current = rowDrafts[key];
      if (!current) return;
      const next = nativeCollectionRowDraftAfterSave(current, draft, serverResult.version);
      const nextRowDrafts = { ...rowDrafts };
      if (next) nextRowDrafts[key] = next;
      else delete nextRowDrafts[key];
      rowDrafts = nextRowDrafts;
    };

    const firstSave = saveNativeCollectionDraftSnapshot(
      operations,
      currentSpec,
      captureNativeCollectionDraftSnapshot("movies", rowDrafts, {}),
      { onRowSaved: applySavedRow }
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rowDrafts = {
      ...rowDrafts,
      [draftKey]: updateNativeCollectionRowDraft(rowDrafts[draftKey], 7, "title", "二回目の入力")
    };
    releaseFirst();

    const firstResult = await firstSave;
    expect(rowDrafts[draftKey]).toEqual({ values: { title: "二回目の入力" }, baseVersion: 8 });

    await saveNativeCollectionDraftSnapshot(
      operations,
      firstResult.spec,
      captureNativeCollectionDraftSnapshot("movies", rowDrafts, {}),
      { onRowSaved: applySavedRow }
    );

    const secondCall = runOperation.mock.calls[1]?.[0];
    if (!secondCall || secondCall.operation.kind !== "collection.record.patch") throw new Error("second patch operation missing");
    expect(secondCall.operation.expected_version).toBe(8);
    expect(secondCall.operation.changes).toEqual({ title: "二回目の入力" });
    expect(rowDrafts[draftKey]).toBeUndefined();
  });

  it("sends the dirty base after refresh records a newer server version", async () => {
    const runOperation = vi.fn(async ({ operation }: { roomId: string; operation: SurfaceOperation }) => (
      operation.kind === "collection.view.present"
        ? surfaceResponse(operation, { records: [{ id: "record-1", collection_id: "movies", version: 12, data: { title: "相手の変更" } }] })
        : surfaceResponse(operation)
    ));
    const operations = createNativeCollectionPanelOperations(target, readyBridge(runOperation));
    const refreshed = await operations.presentCollection("movies");

    await operations.patchRecord(
      refreshed.spec,
      { id: "record-1", title: "相手の変更" },
      { title: "利用者のdraft" },
      7
    );

    const patchCall = runOperation.mock.calls[1]?.[0];
    if (!patchCall || patchCall.operation.kind !== "collection.record.patch") throw new Error("patch operation missing");
    expect(patchCall.operation.expected_version).toBe(7);
    expect(patchCall.operation.changes).toEqual({ title: "利用者のdraft" });
  });

  it("rejects a response that omits the server result contract", async () => {
    const runOperation = vi.fn(async ({ operation }: { roomId: string; operation: SurfaceOperation }) => ({
      ...surfaceResponse(operation),
      result_kind: "collection_view" as const,
      result: { records: [] }
    }));
    const operations = createNativeCollectionPanelOperations(target, readyBridge(runOperation));
    await expect(operations.patchRecord(collectionSpec(), { id: "record-1", title: "変更前", version: 7 }, { title: "変更後" }))
      .rejects.toThrow("collection_surface_response_result_kind_mismatch");
  });

  it("does not mutate the draft when the bridge rejects a write", async () => {
    const draft = { title: "保存前の下書き" };
    const bridge = readyBridge(vi.fn(async () => {
      throw new Error("collection_record_version_conflict");
    }));
    const operations = createNativeCollectionPanelOperations(target, bridge);

    await expect(operations.createRecord(collectionSpec(), draft)).rejects.toThrow("collection_record_version_conflict");
    expect(draft).toEqual({ title: "保存前の下書き" });
  });
});

describe("NativeCollectionPanel rendering", () => {
  it("renders the authorized Collection list and the empty state with accessible labels", () => {
    const listMarkup = renderToStaticMarkup(createElement(NativeCollectionCollectionList, {
      schemas: [schema],
      onSelect: vi.fn()
    }));
    const emptyMarkup = renderToStaticMarkup(createElement(NativeCollectionCollectionList, {
      schemas: [],
      onSelect: vi.fn()
    }));
    const panelMarkup = renderToStaticMarkup(createElement(NativeCollectionPanel, {
      target,
      bridge: {},
      onClose: vi.fn()
    }));

    expect(listMarkup).toContain("映画ログ");
    expect(listMarkup).toContain("movies");
    expect(listMarkup).toContain("認可済みCollection一覧");
    expect(emptyMarkup).toContain("認可済みCollectionはありません");
    expect(panelMarkup).toContain("Collectionパネルを閉じる");
    expect(panelMarkup).toContain("Collection一覧");
    expect(panelMarkup).not.toMatch(/session/i);
  });
});

function readyBridge(
  runOperation: NonNullable<NativeCollectionPanelBridge["runWorkspaceCollectionSurfaceOperation"]>
): NativeCollectionPanelBridge {
  return {
    listWorkspaceConnections: vi.fn(async () => ({ activeTarget: target, connections: [] })),
    runWorkspaceCollectionSurfaceOperation: runOperation
  };
}

function surfaceResponse(operation: SurfaceOperation, result?: unknown): SurfaceOperationResultEnvelope<unknown> {
  const renderSpec = collectionSpec();
  const resultKind: SurfaceOperationResultKind = operation.kind === "collection.view.present"
    ? "collection_view"
    : operation.kind === "collection.record.create"
      ? "collection_record"
      : operation.kind === "collection.record.patch"
        ? "collection_patch"
        : operation.kind === "collection.record.delete"
          ? "collection_delete"
          : "collection_action";
  let defaultResult: unknown;
  if (operation.kind === "collection.view.present") {
    defaultResult = { records: [{ id: "record-1", collection_id: "movies", version: 7, data: { title: "変更前" } }] };
  } else if (operation.kind === "collection.action.run") {
    defaultResult = { action_id: operation.action_id };
  } else if (
    operation.kind === "collection.record.create"
    || operation.kind === "collection.record.patch"
    || operation.kind === "collection.record.delete"
  ) {
    defaultResult = { id: operation.record_id, collection_id: "movies", version: 8, data: { title: "更新後" } };
  } else {
    throw new Error("unsupported test operation");
  }
  return {
    operation,
    result_kind: resultKind,
    render_spec: renderSpec,
    render_specs: [renderSpec],
    result: result ?? defaultResult
  };
}

function collectionSpec(): SurfaceRenderSpec {
  return {
    id: "surface_movies",
    kind: "custom_view",
    priority: "primary",
    state: "ready",
    title: "映画ログ",
    resource_refs: [{ kind: "collection", id: "movies", uri: "collections/movies", label: "映画ログ" }],
    props: {
      renderer: "collection_table",
      view_id: "movies_table",
      view_state: { collection_id: "movies", view_id: "movies_table", renderer: "collection_table" },
      actions: [{ id: "refresh", label: "更新", operation_kind: "collection.action.run", action_kind: "refresh", scope: "collection" }],
      data: {
        collection_id: "movies",
        records: [{ id: "record-1", title: "変更前", version: 7 }],
        schema_fields: [{ id: "title", type: "string", required: true }],
        view_config: { id: "movies_table", renderer: "collection_table" }
      }
    }
  } as SurfaceRenderSpec;
}

function collectionRecordHistory(
  operation: Extract<SurfaceOperation, { kind: "collection.record.create" }>
): WorkspaceOperationHistoryRecord {
  return {
    workspaceId: target.workspaceId,
    roomId: target.roomId,
    recordType: "collection_record",
    id: `collection_record_${operation.id}`,
    version: 1,
    payload: {
      kind: "record",
      state: "ready",
      collection_id: operation.collection_id,
      file_path: `collections/${operation.collection_id}/records/${operation.record_id}.md`,
      operation_id: operation.id,
      record: {
        id: operation.record_id,
        collection_id: operation.collection_id,
        version: 1,
        data: operation.data,
        resource_refs: [],
        created_at: "2026-09-10T00:00:00.000Z",
        updated_at: "2026-09-10T00:00:00.000Z"
      }
    }
  };
}

function collectionPatchHistory(
  operation: Extract<SurfaceOperation, { kind: "collection.record.patch" }>
): WorkspaceOperationHistoryRecord {
  return {
    workspaceId: target.workspaceId,
    roomId: target.roomId,
    recordType: "collection_patch",
    id: `collection_patch_${operation.id}`,
    version: 1,
    payload: {
      kind: "patch",
      state: "ready",
      collection_id: operation.collection_id,
      file_path: `collections/${operation.collection_id}/records/${operation.record_id}.md`,
      patch: {
        id: operation.patch_id,
        record_id: operation.record_id,
        changes: operation.changes,
        ...(operation.expected_version === undefined ? {} : { expected_version: operation.expected_version }),
        source_operation_id: operation.id,
        created_at: "2026-09-10T00:00:00.000Z"
      }
    }
  };
}

function collectionDeleteHistory(
  operation: Extract<SurfaceOperation, { kind: "collection.record.delete" }>
): WorkspaceOperationHistoryRecord {
  return {
    workspaceId: target.workspaceId,
    roomId: target.roomId,
    recordType: "collection_record",
    id: `collection_record_${operation.id}`,
    version: 1,
    payload: {
      kind: "record",
      state: "deleted",
      collection_id: operation.collection_id,
      file_path: `collections/${operation.collection_id}/records/${operation.record_id}.md`,
      operation_id: operation.id,
      record: {
        id: operation.record_id,
        collection_id: operation.collection_id,
        version: operation.expected_version,
        data: { title: "削除対象" },
        resource_refs: [],
        created_at: "2026-09-10T00:00:00.000Z",
        updated_at: "2026-09-10T00:00:00.000Z"
      }
    }
  };
}
