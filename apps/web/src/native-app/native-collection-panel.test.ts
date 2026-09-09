import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SurfaceOperation, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  createNativeCollectionPanelOperations,
  NativeCollectionCollectionList,
  NativeCollectionPanel,
  type NativeCollectionPanelBridge,
  type NativeCollectionPanelTarget,
  type NativeCollectionSchema
} from "./NativeCollectionPanel";

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
        : { id: "record-created", collection_id: "movies", version: 1, data: { title: "新しい" } }
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

function surfaceResponse(operation: SurfaceOperation, result: unknown = {}): {
  operation: SurfaceOperation;
  result_kind: "collection_view";
  render_spec: SurfaceRenderSpec;
  render_specs: SurfaceRenderSpec[];
  result: unknown;
} {
  const renderSpec = collectionSpec();
  return {
    operation,
    result_kind: "collection_view",
    render_spec: renderSpec,
    render_specs: [renderSpec],
    result
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
      actions: [],
      data: {
        collection_id: "movies",
        records: [{ id: "record-1", title: "変更前", version: 7 }],
        schema_fields: [{ id: "title", type: "string", required: true }],
        view_config: { id: "movies_table", renderer: "collection_table" }
      }
    }
  } as SurfaceRenderSpec;
}
