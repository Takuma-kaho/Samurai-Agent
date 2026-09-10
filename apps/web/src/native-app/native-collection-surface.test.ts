import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import NativeCollectionSurface, { type NativeCollectionRecord, type NativeCollectionSurfaceController } from "./NativeCollectionSurface";
import type { JsonValue } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";

describe("NativeCollectionSurface", () => {
  it("renders the React table, typed form fields, declared actions, and accessible row controls", () => {
    const markup = renderSurface({
      newDraft: {
        title: "新しい映画",
        status: "観たい",
        rating: "4",
        watched_at: "2026-09-08",
        starts_at: "2026-09-08T19:30",
        notes: "あとで見る",
        director_id: "person_kurosawa",
        favorite: "true"
      }
    });

    expect(markup).toContain("native-collection-surface");
    expect(markup).toContain("新しいレコードを追加");
    expect(markup).toContain("type=\"number\"");
    expect(markup).toContain("type=\"date\"");
    expect(markup).toContain("type=\"datetime-local\"");
    expect(markup).toContain("type=\"checkbox\"");
    expect(markup).toContain("<textarea");
    expect(markup).toContain("<select");
    expect(markup).toContain("黒澤明");
    expect(markup).toContain("参照先なし");
    expect(markup).toContain("実行: Collectionを整理");
    expect(markup).toContain("行を要約");
    expect(markup).not.toContain("未接続action");
    expect(markup).toContain("scope=\"col\"");
    expect(markup).toContain("tabindex=\"0\"");
    expect(markup).toContain("aria-selected=\"true\"");
    expect(markup).toContain("aria-label=\"movie_1を保存\"");
    expect(markup).toContain("aria-label=\"movie_1を削除\"");
  });

  it("applies search, sort, and filter state from SurfaceRenderSpec", () => {
    const markup = renderSurface({
      spec: collectionSpec({
        view_state: {
          collection_id: "movies",
          view_id: "movies_table",
          renderer: "collection_table",
          search: "侍",
          sort: { field_id: "rating", direction: "desc" },
          filter: { field_id: "status", value: "観た" },
          selected_record_id: "movie_1"
        }
      })
    });

    expect(markup).toContain("1 / 2件");
    expect(markup).toContain("value=\"侍\"");
    expect(markup).toContain("value=\"rating\"");
    expect(markup).toContain("value=\"観た\"");
    expect(markup).toContain("七人の侍");
    expect(markup).not.toContain("羅生門");
  });

  it("shows saving, failure, and conflict states without removing controlled drafts", () => {
    const markup = renderSurface({
      saving: true,
      error: "保存に失敗しました",
      conflict: "expected_version が古くなっています",
      newDraft: { title: "保持する下書き", status: "観たい" },
      controller: collectionController({
        collectionDraft: () => ({ title: "保持する行の下書き", status: "観たい" })
      })
    });

    expect(markup).toContain("保存が競合しました");
    expect(markup).toContain("下書きを保持しています");
    expect(markup).toContain("保存中…");
    expect(markup).toContain("保持する下書き");
    expect(markup).toContain("保持する行の下書き");
    expect(markup).toContain("disabled=\"\"");
  });

  it("keeps the active draft buffer editable while a save is pending", () => {
    const markup = renderSurface({
      saving: true,
      newDraft: { title: "保存中も入力" }
    });

    expect(markup).not.toContain("<fieldset disabled=\"\">");
    expect(markup).not.toMatch(/data-field-type=\"string\"[^>]*disabled/);
    expect(markup).toContain("保存中も入力");
  });

  it("uses server row IDs for controls and rejects records without a stable ID", () => {
    const spec = collectionSpec();
    const data = spec.props.data as Record<string, JsonValue>;
    const records = data.records as JsonValue[];
    const markup = renderSurface({
      spec: {
        ...spec,
        props: {
          ...spec.props,
          data: {
            ...data,
            records: [...records, { id: "movie_zero", title: "ゼロ", rating: 0, favorite: false }, { title: "IDなし" }]
          }
        }
      }
    });

    expect(markup).toContain("movie_1-title");
    expect(markup).toContain("movie_2-title");
    expect(markup).toContain("movie_zero-title");
    expect(markup).toContain('value="0"');
    expect(markup).not.toContain("IDなし");
    expect(markup).not.toContain("row-0-title");
  });

  it("keeps local browsing available but disables writes and declared actions without Room capabilities", () => {
    const markup = renderSurface({ canEdit: false, canExecute: false });

    expect(markup).toContain("レコードを検索");
    expect(markup).toMatch(/disabled=\"\"[^>]*>実行: Collectionを整理<\/button>/);
    expect(markup).toMatch(/disabled=\"\"[^>]*aria-label=\"movie_1を保存\"/);
    expect(markup).toMatch(/disabled=\"\"[^>]*aria-label=\"movie_1を削除\"/);
  });

  it("does not revive the legacy gallery, calendar, or kanban renderers", () => {
    const markup = renderSurface({
      spec: collectionSpec({ renderer: "calendar_view", view_id: "movies_calendar" })
    });

    expect(markup).toContain("このCollectionは表形式で開けません");
    expect(markup).not.toContain("collection-gallery");
    expect(markup).not.toContain("collection-calendar");
    expect(markup).not.toContain("collection-kanban");
  });
});

function renderSurface(options: {
  spec?: SurfaceRenderSpec;
  controller?: NativeCollectionSurfaceController;
  newDraft?: Record<string, string>;
  saving?: boolean;
  error?: string | null;
  conflict?: string | null;
  canEdit?: boolean;
  canExecute?: boolean;
} = {}): string {
  return renderToStaticMarkup(createElement(NativeCollectionSurface, {
    spec: options.spec ?? collectionSpec(),
    controller: options.controller ?? collectionController(),
    newDraft: options.newDraft ?? { title: "", status: "" },
    saving: options.saving ?? false,
    error: options.error ?? null,
    conflict: options.conflict ?? null,
    canEdit: options.canEdit,
    canExecute: options.canExecute
  }));
}

function collectionController(overrides: Partial<NativeCollectionSurfaceController> = {}): NativeCollectionSurfaceController {
  const controller: NativeCollectionSurfaceController = {
    refreshCollectionTableSurface: vi.fn(),
    runCollectionSchemaAction: vi.fn(),
    setCollectionSearchQuery: vi.fn(),
    setCollectionSortField: vi.fn(),
    toggleCollectionSortDirection: vi.fn(),
    setCollectionFilterValue: vi.fn(),
    setCollectionNewDraftValue: vi.fn(),
    addCollectionRecord: vi.fn(),
    selectCollectionRecord: vi.fn(),
    collectionDraft: (record: NativeCollectionRecord) => Object.fromEntries(
      ["title", "status", "rating", "watched_at", "starts_at", "notes", "director_id", "favorite"]
        .map((field) => [field, draftText(record[field])])
    ),
    setCollectionDraftValue: vi.fn(),
    saveCollectionRecord: vi.fn(),
    deleteCollectionRecordFromTable: vi.fn()
  };
  return { ...controller, ...overrides };
}

function draftText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function collectionSpec(input: {
  renderer?: string;
  view_id?: string;
  view_state?: Record<string, JsonValue>;
} = {}): SurfaceRenderSpec {
  const renderer = input.renderer ?? "collection_table";
  const viewId = input.view_id ?? (renderer === "collection_table" ? "movies_table" : "movies_calendar");
  const viewState = input.view_state ?? {
    collection_id: "movies",
    view_id: viewId,
    renderer,
    selected_record_id: "movie_1"
  };
  return {
    id: "surface_movies",
    kind: "custom_view",
    priority: "primary",
    state: "ready",
    title: "映画ログ",
    resource_refs: [{ kind: "collection", id: "movies", uri: "collections/movies", label: "映画ログ" }],
    props: {
      renderer,
      view_id: viewId,
      view_state: viewState,
      actions: [
        {
          id: "organize",
          label: "Collectionを整理",
          operation_kind: "collection.action.run",
          scope: "collection",
          description: "Collection全体を整理する"
        },
        {
          id: "summarize",
          label: "行を要約",
          operation_kind: "collection.action.run",
          scope: "record"
        },
        {
          id: "legacy",
          label: "未接続action",
          operation_kind: "custom_view.action",
          scope: "record"
        }
      ] as unknown as JsonValue,
      data: {
        collection_id: "movies",
        record_ids: ["movie_1", "movie_2"],
        records: [
          {
            id: "movie_1",
            version: 3,
            title: "七人の侍",
            status: "観た",
            rating: 5,
            watched_at: "2026-07-03",
            starts_at: "2026-07-03T18:00:00.000Z",
            notes: "再視聴",
            director_id: "person_kurosawa",
            favorite: true,
            display_name: "七人の侍 / 黒澤明"
          },
          {
            id: "movie_2",
            version: 4,
            title: "羅生門",
            status: "観たい",
            rating: 4,
            watched_at: "2026-07-05",
            starts_at: "2026-07-05T18:00:00.000Z",
            notes: "次に見る",
            director_id: "person_missing",
            favorite: false,
            display_name: "羅生門"
          }
        ],
        schema_fields: [
          { id: "title", type: "string", label: "タイトル", required: true },
          { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "観た"] },
          { id: "rating", type: "number", label: "評価" },
          { id: "watched_at", type: "date", label: "鑑賞日" },
          { id: "starts_at", type: "datetime", label: "開始日時" },
          { id: "notes", type: "text", label: "メモ" },
          {
            id: "director_id",
            type: "ref",
            label: "監督",
            source: "collection_ref",
            target_collection_id: "people",
            options: [{ value: "person_kurosawa", label: "黒澤明" }]
          },
          { id: "favorite", type: "boolean", label: "お気に入り" },
          { id: "display_name", type: "string", label: "表示名", derived: true, read_only: true }
        ],
        view_config: {
          id: viewId,
          renderer,
          editable_fields: ["title", "status", "rating", "watched_at", "starts_at", "notes", "director_id", "favorite"]
        }
      } as unknown as JsonValue
    }
  };
}
