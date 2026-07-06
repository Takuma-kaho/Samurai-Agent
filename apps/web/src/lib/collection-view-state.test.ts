import { describe, expect, it } from "vitest";
import type { JsonValue, MessagePresentationRecord } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  collectionActionRunPayload,
  collectionCalendarDateSelection,
  collectionCalendarSelectedDateKey,
  collectionCreateDataForView,
  collectionCreateDraftForView,
  collectionCreateReadyForSpec,
  collectionCreateValidationMessageForSpec,
  collectionDashboardMetrics,
  collectionDraftValueFromRaw,
  collectionFieldOptions,
  collectionFieldReadOnly,
  collectionGalleryCard,
  collectionKanbanColumnsForRecords,
  collectionKanbanDragPayload,
  collectionKanbanDropPatch,
  collectionPresentationOpenOperation,
  collectionPresentationOpenViewId,
  collectionPresentationForSpec,
  collectionPresentationPreviewSpec,
  collectionPresentationRecordCountLabel,
  collectionPresentationRendererLabel,
  collectionPresentationViewLabel,
  collectionRecordFieldDisplay,
  collectionRefMissing,
  collectionRenderer,
  collectionTableViewId,
  collectionUserViewState,
  collectionVisibleEmptyMessage,
  collectionVisibleRecords,
  collectionViewState,
  withCollectionViewState,
  withPresentationViewState
} from "./collection-view-state";

describe("collection view state", () => {
  it("merges base render metadata with saved data and props state", () => {
    const spec = collectionSpec({
      dataViewState: {
        search: "黒澤",
        selected_record_id: "movie_1"
      },
      propsViewState: {
        selected_record_id: "movie_2",
        sort: { field_id: "rating", direction: "desc" }
      }
    });

    expect(collectionViewState(spec)).toEqual({
      collection_id: "movies",
      view_id: "movies_gallery",
      renderer: "collection_gallery",
      record_count: 2,
      search: "黒澤",
      selected_record_id: "movie_2",
      sort: { field_id: "rating", direction: "desc" }
    });
  });

  it("writes the same view_state into props and collection data", () => {
    const spec = collectionSpec();
    const next = withCollectionViewState(spec, {
      selected_record_id: "movie_1",
      selected_date: "2026-07-05",
      group: "status",
      filter: { field_id: "status", value: "観た" }
    });

    expect(next).not.toBe(spec);
    expect(next.props.view_state).toEqual(next.props.data && typeof next.props.data === "object" && !Array.isArray(next.props.data)
      ? next.props.data.view_state
      : undefined);
    expect(collectionViewState(next)).toMatchObject({
      collection_id: "movies",
      view_id: "movies_gallery",
      renderer: "collection_gallery",
      record_count: 2,
      selected_record_id: "movie_1",
      selected_date: "2026-07-05",
      group: "status",
      filter: { field_id: "status", value: "観た" }
    });
  });

  it("restores card presentation state when a collection is reopened", () => {
    const spec = collectionSpec();
    const presentation = messagePresentation({
      view_id: "movies_calendar",
      renderer: "calendar_view",
      selected_date: "2026-07-05",
      group: "status",
      selected_record_id: "movie_2"
    });

    const next = withPresentationViewState(spec, presentation);

    expect(collectionTableViewId(next)).toBe("movies_calendar");
    expect(collectionRenderer(next)).toBe("calendar_view");
    expect(next.props.data && typeof next.props.data === "object" && !Array.isArray(next.props.data)
      ? next.props.data.view_config
      : undefined).toMatchObject({
      id: "movies_calendar",
      renderer: "calendar_view"
    });
    expect(collectionViewState(next)).toMatchObject({
      collection_id: "movies",
      view_id: "movies_calendar",
      renderer: "calendar_view",
      record_count: 2,
      selected_date: "2026-07-05",
      group: "status",
      selected_record_id: "movie_2"
    });
  });

  it("opens cards from the saved presentation view when card state changed", () => {
    const presentation = messagePresentation({
      view_id: "movies_calendar",
      renderer: "calendar_view",
      selected_date: "2026-07-05"
    });

    expect(collectionPresentationOpenViewId(presentation)).toBe("movies_calendar");
    expect(collectionPresentationOpenOperation(presentation, "surface_card_click")).toEqual({
      id: "surface_card_click",
      kind: "collection.view.present",
      collection_id: "movies",
      view_id: "movies_calendar"
    });
  });

  it("keeps only user-controlled state when syncing a card from Workspace", () => {
    const spec = collectionSpec({
      propsViewState: {
        collection_id: "movies",
        view_id: "movies_calendar",
        renderer: "calendar_view",
        record_count: 2,
        search: "黒澤",
        selected_record_id: "movie_1",
        selected_date: "2026-07-05",
        sort: { field_id: "rating", direction: "desc" },
        filter: { field_id: "status", value: "観た" },
        group: "status"
      }
    });

    expect(collectionUserViewState(spec)).toEqual({
      search: "黒澤",
      selected_record_id: "movie_1",
      selected_date: "2026-07-05",
      sort: { field_id: "rating", direction: "desc" },
      filter: { field_id: "status", value: "観た" },
      group: "status"
    });
  });

  it("builds Collection action payloads with action, view, and record context", () => {
    expect(collectionActionRunPayload(collectionSpec({
      propsViewState: {
        selected_record_id: "movie_1",
        sort: { field_id: "rating", direction: "desc" }
      }
    }), {
      action_id: "summarize_note",
      action_label: "感想を整理",
      action_kind: "custom_instruction",
      scope: "record",
      record: { id: "movie_1", title: "七人の侍", status: "観た", rating: 5, internal: undefined }
    })).toEqual({
      collection_id: "movies",
      view_id: "movies_gallery",
      renderer: "collection_gallery",
      view_state: {
        selected_record_id: "movie_1",
        sort: { field_id: "rating", direction: "desc" }
      },
      action_id: "summarize_note",
      action_label: "感想を整理",
      action_kind: "custom_instruction",
      action_scope: "record",
      record_id: "movie_1",
      record_snapshot: { id: "movie_1", title: "七人の侍", status: "観た", rating: 5 }
    });
  });

  it("keeps blank optional typed fields from becoming fake values", () => {
    expect(collectionDraftValueFromRaw({ id: "rating", type: "number" }, "")).toBeNull();
    expect(collectionDraftValueFromRaw({ id: "rating", type: "number" }, "4.5")).toBe(4.5);
    expect(collectionDraftValueFromRaw({ id: "rating", type: "number" }, "not a number")).toBeNull();
    expect(collectionDraftValueFromRaw({ id: "watched_at", type: "date" }, "")).toBeNull();
    expect(collectionDraftValueFromRaw({ id: "status", type: "enum" }, "")).toBeNull();
    expect(collectionDraftValueFromRaw({ id: "published", type: "boolean" }, "true")).toBe(true);
    expect(collectionDraftValueFromRaw({ id: "note", type: "text" }, "")).toBe("");
  });

  it("applies table search, filter, and sort state to visible records", () => {
    const filtered = withCollectionViewState(collectionSpec(), {
      search: "生",
      filter: { field_id: "status", value: "観た" },
      sort: { field_id: "rating", direction: "asc" }
    });

    expect(collectionVisibleRecords(filtered).map((record) => record.id)).toEqual(["movie_2"]);

    const empty = withCollectionViewState(collectionSpec(), {
      filter: { field_id: "status", value: "視聴中" }
    });
    expect(collectionVisibleRecords(empty)).toEqual([]);
    expect(collectionVisibleEmptyMessage(empty)).toBe("条件に合うレコードがありません");
  });

  it("builds summary metrics from visible Collection records", () => {
    const dashboard = withCollectionViewState(collectionSpec(), {
      view_id: "movies_table",
      renderer: "collection_table",
      filter: { field_id: "status", value: "観た" }
    });

    expect(collectionDashboardMetrics(dashboard)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "record_count", label: "レコード", value: "2", detail: "全件", kind: "count" }),
      expect.objectContaining({ id: "enum_status_観た", label: "観た", value: "2", detail: "状態", kind: "enum" }),
      expect.objectContaining({ id: "number_rating_average", label: "評価 平均", value: "4.5", detail: "2件", kind: "number" }),
      expect.objectContaining({ id: "number_rating_sum", label: "評価 合計", value: "9", kind: "number" })
    ]));
  });

  it("renders linked ref labels, embed fields, and derived fields as Workspace UI data", () => {
    const spec = linkedSpec();
    const fields = spec.props.data && typeof spec.props.data === "object" && !Array.isArray(spec.props.data)
      ? spec.props.data.schema_fields as Array<Record<string, JsonValue>>
      : [];
    const directorField = fields.find((field) => field.id === "director_id")!;
    const profileField = fields.find((field) => field.id === "profile")!;
    const displayField = fields.find((field) => field.id === "display")!;
    const records = spec.props.data && typeof spec.props.data === "object" && !Array.isArray(spec.props.data)
      ? spec.props.data.records as Array<Record<string, unknown>>
      : [];
    const known = records.find((record) => record.id === "movie_1")!;
    const missing = records.find((record) => record.id === "movie_missing_director")!;

    expect(collectionFieldOptions(directorField)).toEqual([
      { value: "person_kurosawa", label: "黒澤明" }
    ]);
    expect(collectionRecordFieldDisplay(known, directorField)).toBe("黒澤明");
    expect(collectionRecordFieldDisplay(missing, directorField)).toBe("person_missing");
    expect(collectionRefMissing(known, directorField)).toBe(false);
    expect(collectionRefMissing(missing, directorField)).toBe(true);
    expect(collectionFieldReadOnly(profileField)).toBe(true);
    expect(collectionFieldReadOnly(displayField)).toBe(true);
    expect(collectionRecordFieldDisplay(known, profileField)).toBe("{\"year\":1954,\"country\":\"JP\"}");
    expect(collectionVisibleRecords(withCollectionViewState(spec, { search: "黒澤" })).map((record) => record.id)).toEqual(["movie_1"]);
  });

  it("prepares calendar date clicks for adding date and datetime records", () => {
    expect(collectionCalendarDateSelection({ id: "watched_at", type: "date" }, "2026-07-05")).toEqual({
      view_state: { selected_date: "2026-07-05" },
      draft: { field_id: "watched_at", value: "2026-07-05" }
    });
    expect(collectionCalendarDateSelection({ id: "starts_at", type: "datetime" }, "2026-07-05")).toEqual({
      view_state: { selected_date: "2026-07-05" },
      draft: { field_id: "starts_at", value: "2026-07-05T00:00" }
    });
    expect(collectionCalendarDateSelection(undefined, "2026-07-05")).toEqual({
      view_state: { selected_date: "2026-07-05" }
    });
  });

  it("fills calendar create drafts and Runtime create data from the selected date", () => {
    const spec = calendarSpec({
      propsViewState: { selected_date: "2026-07-05" }
    });
    const draft = collectionCreateDraftForView(spec, {
      title: "羅生門",
      rating: "4.5"
    });

    expect(draft).toEqual({
      title: "羅生門",
      rating: "4.5",
      watched_at: "2026-07-05"
    });
    expect(collectionCreateDataForView(spec, {
      title: "羅生門",
      rating: "4.5"
    })).toEqual({
      title: "羅生門",
      rating: 4.5,
      watched_at: "2026-07-05"
    });
    expect(collectionCreateReadyForSpec(spec, { title: "羅生門" })).toBe(true);
    expect(collectionCreateValidationMessageForSpec(spec, { title: "羅生門" })).toBe("");
  });

  it("fills datetime calendar create data from the selected date", () => {
    const spec = calendarDateTimeSpec({
      propsViewState: { selected_date: "2026-07-05" }
    });

    expect(collectionCreateDraftForView(spec, {
      title: "上映会"
    })).toEqual({
      title: "上映会",
      starts_at: "2026-07-05T00:00"
    });
    expect(collectionCreateDataForView(spec, {
      title: "上映会"
    })).toEqual({
      title: "上映会",
      starts_at: "2026-07-05T00:00"
    });
  });

  it("keeps explicit calendar create draft dates and falls back to the first record date", () => {
    const spec = calendarSpec();

    expect(collectionCalendarSelectedDateKey(spec, new Date("2026-01-01T00:00:00"))).toBe("2026-07-04");
    expect(collectionCreateDraftForView(spec, {
      title: "生きる",
      watched_at: "2026-08-01"
    }, { fallbackDate: new Date("2026-01-01T00:00:00") })).toEqual({
      title: "生きる",
      watched_at: "2026-08-01"
    });
  });

  it("builds image-less gallery cards from title, status, rating, and note fields", () => {
    expect(collectionGalleryCard(collectionSpec(), {
      id: "movie_1",
      title: "七人の侍",
      status: "観た",
      rating: 5,
      note: "再鑑賞したい",
      watched_at: "2026-07-05"
    })).toEqual({
      title: "七人の侍",
      subtitle: "movie_1",
      summary: "再鑑賞したい",
      highlights: [
        { field_id: "status", label: "状態", value: "観た", kind: "status" },
        { field_id: "rating", label: "評価", value: "5", kind: "rating" },
        { field_id: "watched_at", label: "鑑賞日", value: "2026-07-05", kind: "date" }
      ]
    });
  });

  it("builds kanban columns from the status enum without dropping empty columns", () => {
    const spec = kanbanSpec();
    const columns = collectionKanbanColumnsForRecords(spec, [
      { id: "movie_1", title: "七人の侍", status: "観た" },
      { id: "movie_2", title: "生きる", status: "視聴中" }
    ]);

    expect(columns.map((column) => [column.value, column.records.map((record) => record.id)])).toEqual([
      ["観たい", []],
      ["視聴中", ["movie_2"]],
      ["観た", ["movie_1"]]
    ]);
  });

  it("prepares kanban drops as Runtime record patches and Workspace view state", () => {
    expect(collectionKanbanDragPayload({ id: "movie_1", title: "七人の侍" })).toEqual({ record_id: "movie_1" });
    expect(collectionKanbanDragPayload({ title: "idなし" })).toBeUndefined();
    expect(collectionKanbanDropPatch(kanbanSpec(), "movie_1", "観た")).toEqual({
      record_id: "movie_1",
      changes: { status: "観た" },
      view_state: { group: "status" }
    });
    expect(collectionKanbanDropPatch(kanbanSpec({ schemaFields: [{ id: "title", type: "string", label: "タイトル" }] }), "movie_1", "観た")).toBeUndefined();
    expect(collectionKanbanDropPatch(kanbanSpec(), "", "観た")).toBeUndefined();
  });

  it("derives stable card labels from saved presentation view state", () => {
    const presentation = messagePresentation({
      view_id: "movies_calendar",
      renderer: "calendar_view",
      record_count: 2
    });

    expect(collectionPresentationRendererLabel(presentation)).toBe("Calendar");
    expect(collectionPresentationRecordCountLabel(presentation)).toBe("2件");
    expect(collectionPresentationViewLabel(presentation)).toBe("movies_calendar");
  });

  it("builds a Collection card preview spec from saved presentation state", () => {
    const presentation = messagePresentation({
      view_id: "movies_calendar",
      renderer: "calendar_view",
      record_count: 2
    });
    const spec = collectionPresentationPreviewSpec(presentation);

    expect(spec.kind).toBe("custom_view");
    expect(spec.props.renderer).toBe("calendar_view");
    expect(spec.props.view_id).toBe("movies_calendar");
    expect(collectionViewState(spec)).toEqual(expect.objectContaining({
      collection_id: "movies",
      view_id: "movies_calendar",
      renderer: "calendar_view",
      record_count: 2
    }));
  });

  it("finds the saved presentation that backs an opened Collection workspace spec", () => {
    const galleryPresentation = messagePresentation({
      view_id: "movies_gallery",
      renderer: "collection_gallery",
      record_count: 2
    });
    const calendarPresentation = {
      ...messagePresentation({
        view_id: "movies_calendar",
        renderer: "calendar_view",
        record_count: 2
      }),
      id: "presentation_calendar",
      view_id: "movies_calendar",
      renderer: "calendar_view"
    };

    expect(collectionPresentationForSpec(collectionSpec(), [calendarPresentation, galleryPresentation])).toBe(galleryPresentation);
    expect(collectionPresentationForSpec(calendarSpec(), [galleryPresentation, calendarPresentation])).toBe(calendarPresentation);
    expect(collectionPresentationForSpec(kanbanSpec(), [galleryPresentation, calendarPresentation])).toBeUndefined();
  });
});

function collectionSpec(input: {
  dataViewState?: Record<string, JsonValue>;
  propsViewState?: Record<string, JsonValue>;
} = {}): SurfaceRenderSpec {
  return {
    id: "surface_movies",
    kind: "custom_view",
    priority: "primary",
    resource_refs: [],
    props: {
      renderer: "collection_gallery",
      view_id: "movies_gallery",
      ...(input.propsViewState ? { view_state: input.propsViewState } : {}),
      data: {
        collection_id: "movies",
        view_config: { id: "movies_gallery", renderer: "collection_gallery" },
        schema_fields: [
          { id: "title", type: "string", label: "タイトル" },
          { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
          { id: "rating", type: "number", label: "評価" },
          { id: "note", type: "text", label: "メモ" },
          { id: "watched_at", type: "date", label: "鑑賞日" }
        ],
        records: [
          { id: "movie_1", title: "七人の侍", status: "観た", rating: 5, note: "再鑑賞したい" },
          { id: "movie_2", title: "生きる", status: "観た", rating: 4, note: "静かな名作" }
        ],
        ...(input.dataViewState ? { view_state: input.dataViewState } : {})
      }
    }
  };
}

function calendarSpec(input: {
  propsViewState?: Record<string, JsonValue>;
} = {}): SurfaceRenderSpec {
  return {
    id: "surface_movies_calendar",
    kind: "custom_view",
    priority: "primary",
    resource_refs: [],
    props: {
      renderer: "calendar_view",
      view_id: "movies_calendar",
      ...(input.propsViewState ? { view_state: input.propsViewState } : {}),
      data: {
        collection_id: "movies",
        view_config: {
          id: "movies_calendar",
          renderer: "calendar_view",
          editable_fields: ["title", "rating", "watched_at"]
        },
        schema_fields: [
          { id: "title", type: "string", label: "タイトル", required: true },
          { id: "rating", type: "number", label: "評価" },
          { id: "watched_at", type: "date", label: "鑑賞日", required: true },
          { id: "total", type: "number", label: "合計", derived: true }
        ],
        records: [
          { id: "movie_1", title: "七人の侍", rating: 5, watched_at: "2026-07-04" }
        ]
      }
    }
  };
}

function calendarDateTimeSpec(input: {
  propsViewState?: Record<string, JsonValue>;
} = {}): SurfaceRenderSpec {
  return {
    id: "surface_events_calendar",
    kind: "custom_view",
    priority: "primary",
    resource_refs: [],
    props: {
      renderer: "calendar_view",
      view_id: "events_calendar",
      ...(input.propsViewState ? { view_state: input.propsViewState } : {}),
      data: {
        collection_id: "events",
        view_config: {
          id: "events_calendar",
          renderer: "calendar_view",
          editable_fields: ["title", "starts_at"]
        },
        schema_fields: [
          { id: "title", type: "string", label: "タイトル", required: true },
          { id: "starts_at", type: "datetime", label: "開始日時", required: true }
        ],
        records: []
      }
    }
  };
}

function kanbanSpec(input: {
  schemaFields?: Array<Record<string, JsonValue>>;
} = {}): SurfaceRenderSpec {
  return {
    id: "surface_movies_kanban",
    kind: "custom_view",
    priority: "primary",
    resource_refs: [],
    props: {
      renderer: "collection_kanban",
      view_id: "movies_kanban",
      data: {
        collection_id: "movies",
        view_config: { id: "movies_kanban", renderer: "collection_kanban" },
        schema_fields: input.schemaFields ?? [
          { id: "title", type: "string", label: "タイトル" },
          { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] }
        ],
        records: []
      }
    }
  };
}

function linkedSpec(): SurfaceRenderSpec {
  return {
    id: "surface_movies_linked",
    kind: "custom_view",
    priority: "primary",
    resource_refs: [],
    props: {
      renderer: "collection_table",
      view_id: "movies_table",
      data: {
        collection_id: "movies",
        view_config: { id: "movies_table", renderer: "collection_table" },
        linked_data: {
          target_collection_ids: ["people"],
          ref_options: {
            director_id: [{ value: "person_kurosawa", label: "黒澤明", collection_id: "people" }]
          },
          missing_refs: [{
            collection_id: "movies",
            record_id: "movie_missing_director",
            field: "director_id",
            target_collection_id: "people",
            target_record_id: "person_missing"
          }]
        },
        schema_fields: [
          { id: "title", type: "string", label: "タイトル" },
          {
            id: "director_id",
            type: "ref",
            label: "監督",
            source: "collection_ref",
            target_collection_id: "people",
            required: true,
            options: [{ value: "person_kurosawa", label: "黒澤明", collection_id: "people" }]
          },
          { id: "profile", type: "json", label: "作品情報", source: "collection_embed", read_only: true },
          { id: "display", type: "string", label: "表示名", source: "derived_field", derived: true }
        ],
        records: [
          {
            id: "movie_1",
            title: "七人の侍",
            director_id: "person_kurosawa",
            profile: { year: 1954, country: "JP" },
            display: "七人の侍 / 黒澤明"
          },
          {
            id: "movie_missing_director",
            title: "監督未解決の映画",
            director_id: "person_missing",
            profile: { year: 2026, country: "JP" },
            display: "監督未解決の映画"
          }
        ]
      }
    }
  };
}

function messagePresentation(viewState: Record<string, JsonValue>): MessagePresentationRecord {
  return {
    id: "presentation_1",
    session_id: "session_1",
    message_id: "message_1",
    kind: "collection_app",
    title: "映画ログ",
    subtitle: "2 records",
    collection_id: "movies",
    view_id: "movies_gallery",
    renderer: "collection_gallery",
    view_state: viewState,
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z"
  };
}
