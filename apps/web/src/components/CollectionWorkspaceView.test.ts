import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import type { JsonValue, MessagePresentationRecord } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import CollectionWorkspaceView from "./CollectionWorkspaceView.vue";

describe("CollectionWorkspaceView", () => {
  it("renders the saved card entry as the lightweight chat surface", async () => {
    const html = await renderCollection(collectionSpec("collection_gallery"), {
      mode: "card",
      presentation: messagePresentation(),
      openLabel: "開く"
    });

    expect(html).toContain("collection-card-entry");
    expect(html).toContain("映画ログ");
    expect(html).toContain("Gallery");
    expect(html).toContain("2件");
    expect(html).toContain("開く");
  });

  it("renders table controls, actions, refs, required validation, and missing ref warnings", async () => {
    const html = await renderCollection(collectionSpec("collection_table"), {
      newDraft: { title: "", status: "", director_id: "" }
    });

    expect(html).toContain("collection-table-app");
    expect(html).toContain("collection-view-switch");
    expect(html).toContain("検索");
    expect(html).toContain("並び替えなし");
    expect(html).toContain("感想を整理");
    expect(html).toContain("黒澤明");
    expect(html).toContain("参照先なし");
    expect(html).toContain("必須");
    expect(html).toContain("七人の侍");
  });

  it("renders table error, empty state, and typed create inputs", async () => {
    const html = await renderCollection(emptyTypedCollectionSpec(), {
      error: "保存できませんでした",
      newDraft: { title: "", status: "観たい", rating: "4", watched_at: "2026-07-05", notes: "メモ", favorite: "true" }
    });

    expect(html).toContain("Collectionを更新できません");
    expect(html).toContain("保存できませんでした");
    expect(html).toContain("まだレコードがありません");
    expect(html).toContain("type=\"date\"");
    expect(html).toContain("type=\"number\"");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("<textarea");
    expect(html).toContain("<select");
    expect(html).toContain("必須");
  });

  it("renders gallery, calendar, and kanban Collection views from the same component", async () => {
    const gallery = await renderCollection(collectionSpec("collection_gallery"));
    const calendar = await renderCollection(collectionSpec("calendar_view"));
    const kanban = await renderCollection(collectionSpec("collection_kanban"));

    expect(gallery).toContain("collection-gallery-card");
    expect(gallery).toContain("七人の侍");
    expect(gallery).toContain("再視聴");
    expect(gallery).toContain("感想を整理");

    expect(calendar).toContain("collection-calendar-grid");
    expect(calendar).toContain("collection-calendar-create");
    expect(calendar).toContain("2026-07-03");
    expect(calendar).toContain("七人の侍");

    expect(kanban).toContain("collection-kanban-column");
    expect(kanban).toContain("観たい");
    expect(kanban).toContain("観た");
    expect(kanban).toContain("七人の侍");
  });

  it("renders calendar create controls and kanban drag handles for Runtime-backed record operations", async () => {
    const calendar = await renderCollection(collectionSpec("calendar_view"), {
      newDraft: { title: "羅生門", status: "観たい", watched_at: "2026-07-05" }
    });
    const kanban = await renderCollection(collectionSpec("collection_kanban"));

    expect(calendar).toContain("collection-calendar-day");
    expect(calendar).toContain("collection-calendar-create");
    expect(calendar).toContain("type=\"date\"");
    expect(calendar).toContain("value=\"2026-07-05\"");
    expect(kanban).toContain("collection-kanban-drag-handle");
    expect(kanban).toContain("draggable=\"true\"");
    expect(kanban).toContain("collection-card-actions");
  });

  it("renders gallery and calendar record edit controls for the same Runtime-backed CRUD path", async () => {
    const gallery = await renderCollection(collectionSpec("collection_gallery"));
    const calendar = await renderCollection(collectionSpec("calendar_view"));

    expect(gallery).toContain("collection-card-fields");
    expect(gallery).toContain("collection-card-actions");
    expect(gallery).toContain("<textarea");
    expect(gallery).toContain("<select");
    expect(gallery).toContain("surface-row-save");
    expect(gallery).toContain("参照先なし");

    expect(calendar).toContain("collection-date-list");
    expect(calendar).toContain("collection-date-record");
    expect(calendar).toContain("collection-card-fields");
    expect(calendar).toContain("collection-card-actions");
    expect(calendar).toContain("<textarea");
    expect(calendar).toContain("<select");
    expect(calendar).toContain("surface-row-save");
  });
});

async function renderCollection(
  spec: SurfaceRenderSpec,
  options: {
    mode?: "workspace" | "card";
    presentation?: MessagePresentationRecord;
    newDraft?: Record<string, string>;
    openLabel?: string;
    error?: string | null;
  } = {}
): Promise<string> {
  const app = createSSRApp({
    render() {
      return h(CollectionWorkspaceView, {
        spec,
        saving: false,
        error: options.error ?? null,
        newDraft: options.newDraft ?? {},
        controller: collectionController(),
        mode: options.mode ?? "workspace",
        presentation: options.presentation,
        openLabel: options.openLabel
      });
    }
  });
  return renderToString(app);
}

function collectionController() {
  return {
    switchCollectionView: () => undefined,
    refreshCollectionTableSurface: () => undefined,
    runCollectionSchemaAction: () => undefined,
    setCollectionSearchQuery: () => undefined,
    setCollectionSortField: () => undefined,
    toggleCollectionSortDirection: () => undefined,
    setCollectionFilterValue: () => undefined,
    setCollectionGroupField: () => undefined,
    setCollectionNewDraftValue: () => undefined,
    addCollectionRecord: () => undefined,
    selectCollectionRecord: () => undefined,
    collectionDraft: (record: Record<string, unknown>) => Object.fromEntries(
      Object.entries(record)
        .filter((entry): entry is [string, string | number | boolean] =>
          typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean"
        )
        .map(([key, value]) => [key, String(value)])
    ),
    setCollectionDraftValue: () => undefined,
    saveCollectionRecord: () => undefined,
    deleteCollectionRecordFromTable: () => undefined,
    shiftCollectionCalendarMonth: () => undefined,
    selectCollectionCalendarDate: () => undefined,
    beginCollectionKanbanDrag: () => undefined,
    dropCollectionKanbanRecord: () => undefined
  };
}

function emptyTypedCollectionSpec(): SurfaceRenderSpec {
  const spec = collectionSpec("collection_table");
  const data = spec.props.data as Record<string, JsonValue>;
  const viewConfig = data.view_config as Record<string, JsonValue>;
  return {
    ...spec,
    props: {
      ...spec.props,
      data: {
        ...data,
        record_ids: [],
        records: [],
        schema_fields: [
          ...(data.schema_fields as Array<Record<string, JsonValue>>),
          { id: "favorite", type: "boolean", label: "お気に入り" }
        ],
        view_config: {
          ...viewConfig,
          editable_fields: ["title", "status", "rating", "watched_at", "notes", "director_id", "favorite"]
        }
      }
    }
  };
}

function collectionSpec(renderer: "collection_table" | "collection_gallery" | "calendar_view" | "collection_kanban"): SurfaceRenderSpec {
  const viewId = renderer === "collection_table"
    ? "movies_table"
    : renderer === "collection_gallery"
      ? "movies_gallery"
      : renderer === "calendar_view"
        ? "movies_calendar"
        : "movies_kanban";
  const viewState = {
    collection_id: "movies",
    view_id: viewId,
    renderer,
    selected_date: "2026-07-03",
    selected_record_id: "movie_1",
    group: "status",
    record_count: 2
  };
  return {
    id: `surface_${viewId}`,
    kind: "custom_view",
    priority: "secondary",
    state: "ready",
    title: "映画ログ",
    resource_refs: [{
      kind: "collection",
      id: "movies",
      uri: "collections/movies",
      label: "映画ログ"
    }],
    props: {
      renderer,
      view_id: viewId,
      view_state: viewState,
      actions: [{
        id: "summarize_note",
        label: "感想を整理",
        operation_kind: "collection.action.run",
        action_kind: "custom_instruction",
        scope: "record",
        description: "選択した映画の感想を整理する"
      }],
      data: {
        collection_id: "movies",
        record_ids: ["movie_1", "movie_2"],
        records: [
          {
            id: "movie_1",
            title: "七人の侍",
            status: "観た",
            rating: 5,
            watched_at: "2026-07-03",
            notes: "再視聴",
            director_id: "person_kurosawa",
            score_label: "5 / 観た"
          },
          {
            id: "movie_2",
            title: "羅生門",
            status: "観たい",
            rating: 4,
            watched_at: "2026-07-05",
            notes: "次に観る",
            director_id: "person_missing",
            score_label: "4 / 観たい"
          }
        ],
        schema_fields: [
          { id: "title", type: "string", label: "タイトル", required: true },
          { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
          { id: "rating", type: "number", label: "評価" },
          { id: "watched_at", type: "date", label: "鑑賞日" },
          { id: "notes", type: "text", label: "メモ" },
          {
            id: "director_id",
            type: "ref",
            label: "監督",
            source: "collection_ref",
            target_collection_id: "people",
            options: [{ value: "person_kurosawa", label: "黒澤明" }]
          },
          {
            id: "score_label",
            type: "string",
            label: "表示",
            source: "derived_field",
            derived: true,
            read_only: true
          }
        ],
        linked_data: {
          ref_options: {
            director_id: [{ value: "person_kurosawa", label: "黒澤明", collection_id: "people" }]
          },
          target_collection_ids: ["people"],
          missing_refs: [{
            collection_id: "movies",
            record_id: "movie_2",
            field: "director_id",
            target_collection_id: "people",
            target_record_id: "person_missing"
          }]
        },
        view_config: {
          id: viewId,
          renderer,
          editable_fields: ["title", "status", "rating", "watched_at", "notes", "director_id"],
          emphasized_fields: ["title", "rating", "status"],
          group_by: "status"
        },
        view_options: [
          { id: "movies_table", renderer: "collection_table", label: "Table" },
          { id: "movies_gallery", renderer: "collection_gallery", label: "Gallery" },
          { id: "movies_calendar", renderer: "calendar_view", label: "Calendar" },
          { id: "movies_kanban", renderer: "collection_kanban", label: "Kanban" }
        ],
        view_state: viewState
      }
    } as Record<string, JsonValue>
  };
}

function messagePresentation(): MessagePresentationRecord {
  return {
    id: "presentation_1",
    kind: "collection_app",
    session_id: "session_1",
    message_id: "message_1",
    collection_id: "movies",
    view_id: "movies_gallery",
    renderer: "collection_gallery",
    title: "映画ログ",
    subtitle: "movies ・ 2件",
    view_state: {
      collection_id: "movies",
      view_id: "movies_gallery",
      renderer: "collection_gallery",
      record_count: 2
    },
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z"
  };
}
