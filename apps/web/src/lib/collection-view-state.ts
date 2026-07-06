import type { JsonValue, MessagePresentationRecord } from "@samurai-agent/core-schemas";
import type { CollectionViewPresentOperation, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";

export type CollectionGalleryHighlight = {
  field_id: string;
  label: string;
  value: string;
  kind: "status" | "rating" | "date" | "text";
};

export type CollectionGalleryCard = {
  title: string;
  subtitle: string;
  summary: string;
  highlights: CollectionGalleryHighlight[];
};

export type CollectionActionPayloadInput = {
  action_id: string;
  action_label: string;
  action_kind?: string;
  scope?: "collection" | "record";
  record?: Record<string, unknown>;
};

export type CollectionUiAction = {
  id: string;
  label: string;
  operationKind: string;
  actionKind?: string;
  description?: string;
  scope: "collection" | "record";
};

export type CollectionDashboardMetric = {
  id: string;
  label: string;
  value: string;
  detail?: string;
  kind: "count" | "number" | "enum" | "date";
};

export type CollectionCreateDraftOptions = {
  selectedDate?: string;
  fallbackDate?: Date;
};

export function appCollectionData(spec: SurfaceRenderSpec): Record<string, unknown> {
  return spec.props.data && typeof spec.props.data === "object" && !Array.isArray(spec.props.data)
    ? spec.props.data as Record<string, unknown>
    : {};
}

export function appCollectionRecords(spec: SurfaceRenderSpec): Array<Record<string, unknown>> {
  const records = appCollectionData(spec).records;
  return Array.isArray(records) ? records.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

export function appCollectionViewConfig(spec: SurfaceRenderSpec): Record<string, unknown> {
  const value = appCollectionData(spec).view_config;
  return isRecord(value) ? value : {};
}

export function collectionRenderer(spec: SurfaceRenderSpec): string {
  return String(spec.props.renderer ?? "collection_table");
}

export function collectionTableId(spec: SurfaceRenderSpec): string {
  return String(appCollectionData(spec).collection_id ?? "");
}

export function collectionTableViewId(spec: SurfaceRenderSpec): string {
  return String(spec.props.view_id ?? appCollectionViewConfig(spec).id ?? `${collectionTableId(spec)}_table`);
}

export function collectionViewState(spec: SurfaceRenderSpec): Record<string, JsonValue> {
  const propsState = isJsonRecord(spec.props.view_state) ? spec.props.view_state : {};
  const dataState = isJsonRecord(appCollectionData(spec).view_state) ? appCollectionData(spec).view_state as Record<string, JsonValue> : {};
  return {
    collection_id: collectionTableId(spec),
    view_id: collectionTableViewId(spec),
    renderer: collectionRenderer(spec),
    record_count: appCollectionRecords(spec).length,
    ...dataState,
    ...propsState
  };
}

export function withPresentationViewState(spec: SurfaceRenderSpec, presentation: MessagePresentationRecord): SurfaceRenderSpec {
  return withCollectionViewState(spec, presentation.view_state ?? {});
}

export function collectionPresentationForSpec(spec: SurfaceRenderSpec, presentations: MessagePresentationRecord[]): MessagePresentationRecord | undefined {
  const collectionId = collectionTableId(spec);
  const viewId = collectionTableViewId(spec);
  const renderer = collectionRenderer(spec);
  if (!collectionId || !viewId || !renderer) {
    return undefined;
  }
  return presentations.find((presentation) =>
    presentation.collection_id === collectionId
    && collectionPresentationOpenViewId(presentation) === viewId
    && String(presentation.view_state?.renderer ?? presentation.renderer) === renderer
  );
}

export function collectionPresentationPreviewSpec(presentation: MessagePresentationRecord): SurfaceRenderSpec {
  const viewState = {
    collection_id: presentation.collection_id,
    view_id: collectionPresentationOpenViewId(presentation),
    renderer: presentation.view_state?.renderer ?? presentation.renderer,
    ...(presentation.view_state ?? {})
  };
  return {
    id: `presentation_preview_${presentation.id}`,
    kind: "custom_view",
    priority: "secondary",
    state: "ready",
    title: presentation.title,
    resource_refs: [{
      kind: "collection",
      id: presentation.collection_id,
      uri: `collections/${presentation.collection_id}`,
      label: presentation.title || presentation.collection_id
    }],
    props: {
      view_id: String(viewState.view_id ?? presentation.view_id),
      renderer: String(viewState.renderer ?? presentation.renderer),
      renderer_version: "1",
      view_state: viewState,
      data: {
        collection_id: presentation.collection_id,
        records: [],
        schema_fields: [],
        view_config: {
          id: String(viewState.view_id ?? presentation.view_id),
          renderer: String(viewState.renderer ?? presentation.renderer)
        },
        view_state: viewState,
        counts: {
          total: collectionPresentationRecordCount(presentation) ?? 0
        },
        record_ids: []
      }
    },
    fallback: {
      kind: "collection",
      title: presentation.title || presentation.collection_id,
      message: "Open this Collection in Workspace.",
      props: {
        collection_id: presentation.collection_id,
        view_id: String(viewState.view_id ?? presentation.view_id)
      }
    }
  };
}

export function collectionPresentationOpenViewId(presentation: MessagePresentationRecord): string {
  return presentationViewStateString(presentation, "view_id") || presentation.view_id;
}

export function collectionPresentationOpenOperation(presentation: MessagePresentationRecord, id: string): CollectionViewPresentOperation {
  return {
    id,
    kind: "collection.view.present",
    collection_id: presentation.collection_id,
    view_id: collectionPresentationOpenViewId(presentation)
  };
}

export function collectionUserViewState(spec: SurfaceRenderSpec): Record<string, JsonValue> {
  const state = collectionViewState(spec);
  return Object.fromEntries(["search", "sort", "filter", "group", "selected_date", "selected_record_id"]
    .map((key) => [key, state[key]])
    .filter(([, value]) => value !== undefined && value !== "")) as Record<string, JsonValue>;
}

export function collectionCalendarDateSelection(field: Record<string, unknown> | undefined, date: string): {
  view_state: Record<string, JsonValue>;
  draft?: { field_id: string; value: string };
} {
  const fieldId = typeof field?.id === "string" && field.id.trim()
    ? field.id.trim()
    : typeof field?.name === "string" && field.name.trim()
      ? field.name.trim()
      : "";
  const fieldType = typeof field?.type === "string" ? field.type : "";
  return {
    view_state: { selected_date: date },
    ...(fieldId
      ? {
          draft: {
            field_id: fieldId,
            value: fieldType === "datetime" ? `${date}T00:00` : date
          }
        }
      : {})
  };
}

export function collectionCalendarSelectedDateKey(spec: SurfaceRenderSpec, fallbackDate: Date = new Date()): string {
  const selected = collectionViewState(spec).selected_date;
  if (typeof selected === "string" && /^\d{4}-\d{2}-\d{2}$/.test(selected)) {
    return selected;
  }
  const field = collectionDateField(spec);
  const fieldId = field ? fieldIdFromDefinition(field) : "";
  const firstRecordDate = fieldId
    ? appCollectionRecords(spec).map((record) => collectionDateKey(record[fieldId])).find(Boolean)
    : "";
  return firstRecordDate || collectionDateKeyFromDate(fallbackDate);
}

export function collectionCreateDraftForView(
  spec: SurfaceRenderSpec,
  draft: Record<string, string>,
  options: CollectionCreateDraftOptions = {}
): Record<string, string> {
  const next = { ...draft };
  if (collectionRenderer(spec) !== "calendar_view") {
    return next;
  }
  const field = collectionDateField(spec);
  const fieldId = field ? fieldIdFromDefinition(field) : "";
  if (!fieldId || next[fieldId]?.trim()) {
    return next;
  }
  const date = options.selectedDate || collectionCalendarSelectedDateKey(spec, options.fallbackDate);
  const selection = collectionCalendarDateSelection(field, date);
  if (selection.draft) {
    next[selection.draft.field_id] = selection.draft.value;
  }
  return next;
}

export function collectionCreateDataForView(
  spec: SurfaceRenderSpec,
  draft: Record<string, string>,
  options: CollectionCreateDraftOptions = {}
): Record<string, JsonValue> {
  const preparedDraft = collectionCreateDraftForView(spec, draft, options);
  return Object.fromEntries(collectionEditableFields(spec).map((field) => {
    const id = fieldIdFromDefinition(field);
    return [id, collectionDraftValueFromRaw(field, preparedDraft[id] ?? "")];
  }));
}

export function collectionGalleryCard(spec: SurfaceRenderSpec, record: Record<string, unknown>): CollectionGalleryCard {
  const titleField = galleryTitleField(spec);
  const summaryField = gallerySummaryField(spec);
  const titleFieldId = titleField ? fieldIdFromDefinition(titleField) : "";
  const summaryFieldId = summaryField ? fieldIdFromDefinition(summaryField) : "";
  const title = titleFieldId ? recordText(record, titleFieldId) : "";
  const summary = summaryFieldId ? recordText(record, summaryFieldId) : "";
  return {
    title: title || String(record.id ?? ""),
    subtitle: String(record.id ?? ""),
    summary,
    highlights: galleryHighlightFields(spec, new Set([titleFieldId, summaryFieldId].filter(Boolean)))
      .flatMap((field) => {
        const fieldId = fieldIdFromDefinition(field);
        const value = fieldId ? recordText(record, fieldId) : "";
        return value
          ? [{
              field_id: fieldId,
              label: fieldLabel(field),
              value,
              kind: galleryHighlightKind(field)
            }]
          : [];
      })
  };
}

export function collectionKanbanColumnsForRecords(spec: SurfaceRenderSpec, records: Array<Record<string, unknown>>): Array<{ value: string; records: Array<Record<string, unknown>> }> {
  const field = collectionKanbanField(spec);
  if (!field) return [];
  const fieldId = fieldIdFromDefinition(field);
  const configured = enumValues(field);
  const values = configured.length > 0
    ? configured
    : [...new Set(records.map((record) => recordText(record, fieldId)).filter(Boolean))];
  return values.map((value) => ({
    value,
    records: records.filter((record) => recordText(record, fieldId) === value)
  }));
}

export function collectionDashboardMetrics(spec: SurfaceRenderSpec): CollectionDashboardMetric[] {
  const allRecords = appCollectionRecords(spec);
  const records = collectionVisibleRecords(spec);
  const metrics: CollectionDashboardMetric[] = [{
    id: "record_count",
    label: "レコード",
    value: String(records.length),
    detail: records.length === allRecords.length ? "全件" : `全${allRecords.length}件中`,
    kind: "count"
  }];
  const enumField = collectionEnumField(spec);
  const enumFieldId = enumField ? collectionFieldId(enumField) : "";
  if (enumField && enumFieldId) {
    for (const column of collectionKanbanColumnsForRecords(spec, records).slice(0, 6)) {
      metrics.push({
        id: `enum_${enumFieldId}_${column.value}`,
        label: column.value,
        value: String(column.records.length),
        detail: collectionFieldLabel(enumField),
        kind: "enum"
      });
    }
  }
  const numberField = firstField(spec, { ids: /rating|score|amount|price|total|評価|点数|金額|合計/, types: ["number"] })
    ?? firstField(spec, { types: ["number"] });
  const numberFieldId = numberField ? collectionFieldId(numberField) : "";
  const numbers = numberFieldId
    ? records.map((record) => numberFromRecordValue(record[numberFieldId])).filter((value): value is number => value !== undefined)
    : [];
  if (numberField && numberFieldId && numbers.length > 0) {
    const sum = numbers.reduce((total, value) => total + value, 0);
    metrics.push({
      id: `number_${numberFieldId}_average`,
      label: `${collectionFieldLabel(numberField)} 平均`,
      value: formatDashboardNumber(sum / numbers.length),
      detail: `${numbers.length}件`,
      kind: "number"
    });
    metrics.push({
      id: `number_${numberFieldId}_sum`,
      label: `${collectionFieldLabel(numberField)} 合計`,
      value: formatDashboardNumber(sum),
      kind: "number"
    });
  }
  const dateField = collectionDateField(spec);
  const dateFieldId = dateField ? collectionFieldId(dateField) : "";
  const latestDate = dateFieldId
    ? records.map((record) => collectionDateKey(record[dateFieldId])).filter(Boolean).sort().at(-1)
    : "";
  if (dateField && latestDate) {
    metrics.push({
      id: `date_${dateFieldId}_latest`,
      label: `${collectionFieldLabel(dateField)} 最新`,
      value: latestDate,
      kind: "date"
    });
  }
  return metrics;
}

export function collectionKanbanDropPatch(spec: SurfaceRenderSpec, recordId: string | null | undefined, value: string): {
  record_id: string;
  changes: Record<string, JsonValue>;
  view_state: Record<string, JsonValue>;
} | undefined {
  const field = collectionKanbanField(spec);
  const fieldId = field ? fieldIdFromDefinition(field) : "";
  const targetValue = value.trim();
  const id = typeof recordId === "string" ? recordId.trim() : "";
  if (!fieldId || !id || !targetValue) {
    return undefined;
  }
  return {
    record_id: id,
    changes: { [fieldId]: targetValue },
    view_state: { group: fieldId }
  };
}

export function collectionKanbanDragPayload(record: Record<string, unknown>): { record_id: string } | undefined {
  const recordId = String(record.id ?? "").trim();
  return recordId ? { record_id: recordId } : undefined;
}

export function collectionActionRunPayload(spec: SurfaceRenderSpec, input: CollectionActionPayloadInput): Record<string, JsonValue> {
  const record = input.record;
  const recordId = record ? String(record.id ?? "").trim() : "";
  return removeUndefinedJson({
    collection_id: collectionTableId(spec),
    view_id: collectionTableViewId(spec),
    renderer: collectionRenderer(spec),
    view_state: collectionUserViewState(spec),
    action_id: input.action_id,
    action_label: input.action_label,
    action_kind: input.action_kind,
    action_scope: input.scope,
    ...(record && recordId ? { record_id: recordId, record_snapshot: jsonRecord(record) } : {})
  });
}

export function collectionDraftValueFromRaw(field: Record<string, unknown>, raw: string): JsonValue {
  const type = typeof field.type === "string" ? field.type : "string";
  const trimmed = raw.trim();
  if (type === "boolean") return raw === "true";
  if (type === "number") {
    if (!trimmed) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  if ((type === "date" || type === "datetime" || type === "enum" || type === "ref") && !trimmed) {
    return null;
  }
  return raw;
}

export function withCollectionViewState(spec: SurfaceRenderSpec, patch: Record<string, JsonValue>): SurfaceRenderSpec {
  const viewState = {
    ...collectionViewState(spec),
    ...patch
  };
  const data = appCollectionData(spec);
  const viewId = typeof viewState.view_id === "string" && viewState.view_id.trim()
    ? viewState.view_id.trim()
    : collectionTableViewId(spec);
  const renderer = typeof viewState.renderer === "string" && viewState.renderer.trim()
    ? viewState.renderer.trim()
    : collectionRenderer(spec);
  const viewConfig = appCollectionViewConfig(spec);
  return {
    ...spec,
    props: {
      ...spec.props,
      view_id: viewId,
      renderer,
      view_state: viewState,
      data: {
        ...data,
        view_config: {
          ...viewConfig,
          id: viewId,
          renderer
        },
        view_state: viewState
      }
    }
  };
}

export function collectionPresentationRendererLabel(presentation: MessagePresentationRecord): string {
  const renderer = presentationViewStateString(presentation, "renderer") || presentation.renderer;
  if (renderer === "collection_gallery") return "Gallery";
  if (renderer === "calendar_view") return "Calendar";
  if (renderer === "collection_kanban") return "Kanban";
  if (renderer === "collection_table") return "Table";
  return renderer.split(/[_\s-]+/).filter(Boolean).map(capitalize).join(" ") || "Collection";
}

export function collectionPresentationRecordCount(presentation: MessagePresentationRecord): number | undefined {
  const count = presentation.view_state?.record_count;
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : undefined;
}

export function collectionPresentationRecordCountLabel(presentation: MessagePresentationRecord): string | undefined {
  const count = collectionPresentationRecordCount(presentation);
  return count === undefined ? undefined : `${count}件`;
}

export function collectionPresentationViewLabel(presentation: MessagePresentationRecord): string {
  const viewId = presentationViewStateString(presentation, "view_id") || presentation.view_id;
  return viewId || presentation.collection_id;
}

export function collectionViewOptions(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  const options = appCollectionData(spec).view_options;
  if (Array.isArray(options)) {
    return options.filter(isRecord).filter(isJsonRecord);
  }
  return [{
    id: collectionTableViewId(spec),
    renderer: collectionRenderer(spec),
    label: collectionViewOptionLabel({ renderer: collectionRenderer(spec) })
  }];
}

export function collectionViewOptionLabel(option: Record<string, unknown>): string {
  if (typeof option.label === "string" && option.label.trim()) {
    return option.label;
  }
  const renderer = String(option.renderer ?? "collection_table");
  if (renderer === "collection_gallery") return "Gallery";
  if (renderer === "calendar_view") return "Calendar";
  if (renderer === "collection_kanban") return "Kanban";
  return "Table";
}

export function isActiveCollectionViewOption(spec: SurfaceRenderSpec, option: Record<string, unknown>): boolean {
  return String(option.id ?? "") === collectionTableViewId(spec);
}

export function collectionSearchQuery(spec: SurfaceRenderSpec): string {
  const value = collectionViewState(spec).search;
  return typeof value === "string" ? value : "";
}

export function collectionSortState(spec: SurfaceRenderSpec): Record<string, JsonValue> {
  const stateSort = collectionViewState(spec).sort;
  if (isJsonRecord(stateSort)) {
    return stateSort;
  }
  const configSort = appCollectionViewConfig(spec).sort;
  return isJsonRecord(configSort) ? configSort : {};
}

export function collectionSortFieldId(spec: SurfaceRenderSpec): string {
  const fieldId = collectionSortState(spec).field_id;
  return typeof fieldId === "string" ? fieldId : "";
}

export function collectionSortDirection(spec: SurfaceRenderSpec): "asc" | "desc" {
  return collectionSortState(spec).direction === "desc" ? "desc" : "asc";
}

export function collectionFilterState(spec: SurfaceRenderSpec): Record<string, JsonValue> {
  const value = collectionViewState(spec).filter;
  return isJsonRecord(value) ? value : {};
}

export function collectionFilterFieldId(spec: SurfaceRenderSpec): string {
  const fieldId = collectionFilterState(spec).field_id;
  return typeof fieldId === "string" ? fieldId : "";
}

export function collectionFilterValue(spec: SurfaceRenderSpec): string {
  const value = collectionFilterState(spec).value;
  return typeof value === "string" ? value : "";
}

export function collectionFilterField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  const stateField = collectionFilterFieldId(spec);
  if (stateField) {
    return collectionTableFields(spec).find((field) => collectionFieldId(field) === stateField);
  }
  return collectionEnumField(spec);
}

export function collectionFilterOptions(spec: SurfaceRenderSpec): string[] {
  const field = collectionFilterField(spec);
  if (!field) return [];
  const fieldId = collectionFieldId(field);
  const configured = collectionEnumValues(field);
  const fromRecords = [...new Set(appCollectionRecords(spec).map((record) => collectionRecordText(record, fieldId)).filter(Boolean))];
  return configured.length > 0 ? configured : fromRecords;
}

export function collectionGroupFieldId(spec: SurfaceRenderSpec): string {
  const stateGroup = collectionViewState(spec).group;
  if (typeof stateGroup === "string") {
    return stateGroup;
  }
  const configGroup = appCollectionViewConfig(spec).group ?? appCollectionViewConfig(spec).group_by;
  return typeof configGroup === "string" ? configGroup : "";
}

export function collectionGroupFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  return collectionTableFields(spec).filter((field) => {
    const id = collectionFieldId(field);
    const type = collectionFieldType(field);
    return Boolean(id) && ["enum", "ref", "boolean", "date", "datetime", "string", "number"].includes(type);
  });
}

export function collectionVisibleRecords(spec: SurfaceRenderSpec): Array<Record<string, unknown>> {
  const query = collectionSearchQuery(spec).trim().toLowerCase();
  const filterField = collectionFilterField(spec);
  const filterFieldId = filterField ? collectionFieldId(filterField) : "";
  const filterValue = collectionFilterValue(spec);
  const sortFieldId = collectionSortFieldId(spec);
  const direction = collectionSortDirection(spec) === "desc" ? -1 : 1;
  const records = appCollectionRecords(spec).filter((record) => {
    if (query && !collectionRecordSearchTextForSpec(spec, record).includes(query)) {
      return false;
    }
    if (filterFieldId && filterValue && collectionRecordText(record, filterFieldId) !== filterValue) {
      return false;
    }
    return true;
  });
  if (!sortFieldId) {
    return records;
  }
  return [...records].sort((left, right) => compareCollectionValues(left[sortFieldId], right[sortFieldId]) * direction);
}

export function collectionSelectedRecordId(spec: SurfaceRenderSpec): string {
  const value = collectionViewState(spec).selected_record_id;
  return typeof value === "string" ? value : "";
}

export function collectionRecordId(record: Record<string, unknown>): string {
  return String(record.id ?? "");
}

export function collectionRecordSearchText(record: Record<string, unknown>): string {
  return Object.values(record).map((value) => {
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }).join(" ").toLowerCase();
}

export function collectionRecordSearchTextForSpec(spec: SurfaceRenderSpec, record: Record<string, unknown>): string {
  const rawText = collectionRecordSearchText(record);
  const displayText = collectionTableFields(spec).map((field) => collectionRecordFieldDisplay(record, field)).join(" ");
  return `${rawText} ${displayText}`.toLowerCase();
}

export function collectionRecordSelected(spec: SurfaceRenderSpec, record: Record<string, unknown>): boolean {
  const id = collectionRecordId(record);
  return Boolean(id) && collectionSelectedRecordId(spec) === id;
}

export function collectionTableFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  return collectionFields(spec);
}

export function collectionTableEditableFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  return collectionEditableFields(spec);
}

export function collectionFieldId(field: Record<string, unknown>): string {
  return fieldIdFromDefinition(field);
}

export function collectionFieldLabel(field: Record<string, unknown>): string {
  return fieldLabel(field);
}

export function collectionFieldType(field: Record<string, unknown>): string {
  return typeof field.type === "string" ? field.type : "string";
}

export function collectionFieldInputType(field: Record<string, unknown>): "date" | "datetime-local" | "number" | "text" {
  const type = collectionFieldType(field);
  if (type === "date") return "date";
  if (type === "datetime") return "datetime-local";
  if (type === "number") return "number";
  return "text";
}

export function collectionFieldInputValue(field: Record<string, unknown>, value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  const type = collectionFieldType(field);
  if (type === "date") {
    return collectionDateKey(text) || text;
  }
  if (type === "datetime") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return `${text}T00:00`;
    }
    return text.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)?.[0] ?? text;
  }
  return text;
}

export function collectionRecordFieldDisplay(record: Record<string, unknown>, field: Record<string, unknown>): string {
  const value = record[collectionFieldId(field)];
  if (field.source === "collection_ref") {
    return collectionRefLabel(field, value);
  }
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  if (typeof value === "boolean") return value ? "true" : "false";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function collectionFieldOptions(field: Record<string, unknown>): Array<{ value: string; label: string }> {
  const options = Array.isArray(field.options) ? field.options : [];
  return options.filter(isRecord).flatMap((option) => {
    const value = option.value ?? option.record_id;
    const label = option.label ?? value;
    if (typeof value !== "string" || typeof label !== "string") {
      return [];
    }
    return [{ value, label }];
  });
}

export function collectionRefLabel(field: Record<string, unknown>, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "-";
  return collectionFieldOptions(field).find((option) => option.value === value)?.label ?? value;
}

export function collectionRefMissing(record: Record<string, unknown>, field: Record<string, unknown>): boolean {
  if (field.source !== "collection_ref") return false;
  const value = record[collectionFieldId(field)];
  if (typeof value !== "string" || !value.trim()) return false;
  return !collectionFieldOptions(field).some((option) => option.value === value);
}

export function collectionEnumValues(field: Record<string, unknown>): string[] {
  return enumValues(field);
}

export function collectionFieldRequired(field: Record<string, unknown>): boolean {
  return field.required === true;
}

export function collectionRequiredValueMissing(field: Record<string, unknown>, value: string | undefined): boolean {
  if (collectionFieldType(field) === "boolean") return false;
  return typeof value !== "string" || value.trim().length === 0;
}

export function collectionMissingRequiredFields(spec: SurfaceRenderSpec, draft: Record<string, string>): string[] {
  return collectionTableEditableFields(spec).filter((field) => {
    if (!collectionFieldRequired(field)) return false;
    return collectionRequiredValueMissing(field, draft[String(field.id ?? "")]);
  }).map(collectionFieldLabel);
}

export function collectionRequiredReady(spec: SurfaceRenderSpec, draft: Record<string, string>): boolean {
  return collectionMissingRequiredFields(spec, draft).length === 0;
}

export function collectionValidationMessage(spec: SurfaceRenderSpec, draft: Record<string, string>): string {
  const missing = collectionMissingRequiredFields(spec, draft);
  return missing.length > 0 ? `必須: ${missing.join(" / ")}` : "";
}

export function collectionCreateDraftForSpec(spec: SurfaceRenderSpec, draft: Record<string, string>): Record<string, string> {
  return collectionCreateDraftForView(spec, draft, { selectedDate: collectionSelectedDateKey(spec) });
}

export function collectionCreateDraftValueForSpec(spec: SurfaceRenderSpec, field: Record<string, unknown>, draft: Record<string, string>): string {
  return collectionCreateDraftForSpec(spec, draft)[collectionFieldId(field)] ?? "";
}

export function collectionCreateReadyForSpec(spec: SurfaceRenderSpec, draft: Record<string, string>): boolean {
  return collectionRequiredReady(spec, collectionCreateDraftForSpec(spec, draft));
}

export function collectionCreateValidationMessageForSpec(spec: SurfaceRenderSpec, draft: Record<string, string>): string {
  return collectionValidationMessage(spec, collectionCreateDraftForSpec(spec, draft));
}

export function collectionVisibleEmptyMessage(spec: SurfaceRenderSpec): string {
  return appCollectionRecords(spec).length === 0 ? "まだレコードがありません" : "条件に合うレコードがありません";
}

export function collectionCalendarFieldLabel(spec: SurfaceRenderSpec): string {
  const field = collectionDateField(spec);
  return field ? collectionFieldLabel(field) : "";
}

export function collectionEnumField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  return firstField(spec, { ids: /status|state|stage|phase|状態|進捗/, types: ["enum"] })
    ?? firstField(spec, { types: ["enum"] });
}

export function collectionRecordTitle(spec: SurfaceRenderSpec, record: Record<string, unknown>): string {
  const field = galleryTitleField(spec);
  return field ? collectionRecordText(record, collectionFieldId(field)) || String(record.id ?? "") : String(record.id ?? "");
}

export function collectionRecordSummary(spec: SurfaceRenderSpec, record: Record<string, unknown>): string {
  const field = gallerySummaryField(spec);
  return field ? collectionRecordText(record, collectionFieldId(field)) : "";
}

export function collectionCalendarMonthDate(spec: SurfaceRenderSpec): Date {
  const selected = typeof collectionViewState(spec).selected_date === "string" ? String(collectionViewState(spec).selected_date) : "";
  const selectedDate = selected ? new Date(`${selected}T00:00:00`) : undefined;
  if (selectedDate && Number.isFinite(selectedDate.getTime())) {
    return selectedDate;
  }
  const field = collectionDateField(spec);
  const fieldId = field ? collectionFieldId(field) : "";
  const firstRecordDate = fieldId ? collectionVisibleRecords(spec).map((record) => collectionDateKey(record[fieldId])).find(Boolean) : "";
  const firstDate = firstRecordDate ? new Date(`${firstRecordDate}T00:00:00`) : undefined;
  return firstDate && Number.isFinite(firstDate.getTime()) ? firstDate : new Date();
}

export function collectionCalendarMonthLabel(spec: SurfaceRenderSpec): string {
  const date = collectionCalendarMonthDate(spec);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function collectionCalendarMonthOffsetDate(spec: SurfaceRenderSpec, offset: number): string {
  const base = collectionCalendarMonthDate(spec);
  const target = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(base.getDate(), lastDay));
  return collectionDateKeyFromDate(target);
}

export function collectionSelectedDateKey(spec: SurfaceRenderSpec): string {
  const selected = typeof collectionViewState(spec).selected_date === "string" ? String(collectionViewState(spec).selected_date) : "";
  return selected || collectionDateKeyFromDate(collectionCalendarMonthDate(spec));
}

export function collectionCalendarDays(spec: SurfaceRenderSpec): Array<{ key: string; date: string; day: number; inMonth: boolean; records: Array<Record<string, unknown>>; selected: boolean; today: boolean }> {
  const field = collectionDateField(spec);
  const fieldId = field ? collectionFieldId(field) : "";
  const monthDate = collectionCalendarMonthDate(spec);
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  const selected = collectionSelectedDateKey(spec);
  const today = collectionDateKeyFromDate(new Date());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const dateKey = collectionDateKeyFromDate(date);
    const records = fieldId ? collectionVisibleRecords(spec).filter((record) => collectionDateKey(record[fieldId]) === dateKey) : [];
    return {
      key: dateKey,
      date: dateKey,
      day: date.getDate(),
      inMonth: date.getMonth() === monthDate.getMonth(),
      records,
      selected: dateKey === selected,
      today: dateKey === today
    };
  });
}

export function collectionSelectedDateRecords(spec: SurfaceRenderSpec): Array<Record<string, unknown>> {
  const selected = collectionSelectedDateKey(spec);
  const field = collectionDateField(spec);
  const fieldId = field ? collectionFieldId(field) : "";
  return selected && fieldId ? collectionVisibleRecords(spec).filter((record) => collectionDateKey(record[fieldId]) === selected) : [];
}

export function collectionKanbanColumns(spec: SurfaceRenderSpec): Array<{ value: string; records: Array<Record<string, unknown>> }> {
  return collectionKanbanColumnsForRecords(spec, collectionVisibleRecords(spec));
}

export function collectionSchemaActions(spec: SurfaceRenderSpec): CollectionUiAction[] {
  const actions: unknown[] = Array.isArray(spec.props.actions) ? spec.props.actions : [];
  return actions.filter(isRecord).flatMap((action) => {
    if (typeof action.id !== "string" || typeof action.label !== "string" || action.operation_kind !== "collection.action.run") {
      return [];
    }
    const scope = action.scope === "record" ? "record" : "collection";
    return [{
      id: action.id,
      label: action.label,
      operationKind: String(action.operation_kind),
      actionKind: typeof action.action_kind === "string" ? action.action_kind : undefined,
      description: typeof action.description === "string" ? action.description : undefined,
      scope
    }];
  });
}

export function collectionLevelActions(spec: SurfaceRenderSpec): CollectionUiAction[] {
  return collectionSchemaActions(spec).filter((action) => action.scope === "collection");
}

export function collectionRecordActions(spec: SurfaceRenderSpec): CollectionUiAction[] {
  return collectionSchemaActions(spec).filter((action) => action.scope === "record");
}

function presentationViewStateString(presentation: MessagePresentationRecord, key: string): string {
  const value = presentation.view_state?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function collectionKanbanField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  return firstField(spec, { ids: /status|state|stage|phase|状態|進捗/, types: ["enum"] })
    ?? firstField(spec, { types: ["enum"] });
}

function galleryTitleField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  return firstField(spec, { ids: /title|name|subject|label|作品|映画|本|名前|タイトル/, types: ["string", "text"] })
    ?? firstField(spec, { types: ["string", "text"] });
}

function gallerySummaryField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  return firstField(spec, { ids: /note|memo|summary|description|comment|感想|メモ|説明/, types: ["string", "text"] });
}

function galleryHighlightFields(spec: SurfaceRenderSpec, excluded: Set<string>): Array<Record<string, JsonValue>> {
  const fields = [
    firstField(spec, { ids: /status|state|stage|phase|状態|進捗/, types: ["enum", "string"] }),
    firstField(spec, { ids: /rating|score|stars|rank|評価|点数/, types: ["number", "string", "enum"] }),
    firstField(spec, { ids: /date|day|due|deadline|watched_at|created_at|updated_at|期限|日付|鑑賞日/, types: ["date", "datetime", "string"] })
  ];
  const seen = new Set(excluded);
  return fields.flatMap((field) => {
    const fieldId = field ? fieldIdFromDefinition(field) : "";
    if (!field || !fieldId || seen.has(fieldId)) {
      return [];
    }
    seen.add(fieldId);
    return [field];
  });
}

function galleryHighlightKind(field: Record<string, unknown>): CollectionGalleryHighlight["kind"] {
  const id = fieldIdFromDefinition(field).toLowerCase();
  const type = typeof field.type === "string" ? field.type : "";
  if (/status|state|stage|phase|状態|進捗/.test(id)) return "status";
  if (/rating|score|stars|rank|評価|点数/.test(id)) return "rating";
  if (type === "date" || type === "datetime" || /date|day|due|deadline|watched_at|created_at|updated_at|期限|日付|鑑賞日/.test(id)) return "date";
  return "text";
}

function numberFromRecordValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatDashboardNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function collectionFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  const hiddenFields = appCollectionViewConfig(spec).hidden_fields;
  const hidden = new Set(Array.isArray(hiddenFields)
    ? hiddenFields.filter((item): item is string => typeof item === "string")
    : []);
  const fields = appCollectionData(spec).schema_fields;
  return Array.isArray(fields)
    ? fields.filter(isRecord).filter((field): field is Record<string, JsonValue> => {
        const id = fieldIdFromDefinition(field);
        return Boolean(id) && !hidden.has(id) && isJsonRecord(field);
      })
    : [];
}

function collectionEditableFields(spec: SurfaceRenderSpec): Array<Record<string, JsonValue>> {
  const editableFields = appCollectionViewConfig(spec).editable_fields;
  const editable = Array.isArray(editableFields)
    ? new Set(editableFields.filter((item): item is string => typeof item === "string"))
    : undefined;
  return collectionFields(spec).filter((field) => {
    const id = fieldIdFromDefinition(field);
    return !collectionFieldReadOnly(field) && (!editable || editable.has(id));
  });
}

export function collectionDateField(spec: SurfaceRenderSpec): Record<string, JsonValue> | undefined {
  return firstField(spec, { types: ["date", "datetime"] })
    ?? firstField(spec, { ids: /date|day|due|deadline|watched_at|created_at|updated_at|期限|日付|鑑賞日/ });
}

function firstField(spec: SurfaceRenderSpec, options: { ids?: RegExp; types?: string[] }): Record<string, JsonValue> | undefined {
  return collectionFields(spec).find((field) => {
    const id = fieldIdFromDefinition(field).toLowerCase();
    const type = typeof field.type === "string" ? field.type : "string";
    return (!options.ids || options.ids.test(id)) && (!options.types || options.types.includes(type));
  });
}

function fieldIdFromDefinition(field: Record<string, unknown>): string {
  return typeof field.id === "string" && field.id.trim()
    ? field.id.trim()
    : typeof field.name === "string" && field.name.trim()
      ? field.name.trim()
      : "";
}

function fieldLabel(field: Record<string, unknown>): string {
  return typeof field.label === "string" && field.label.trim() ? field.label.trim() : fieldIdFromDefinition(field);
}

export function collectionFieldReadOnly(field: Record<string, unknown>): boolean {
  return field.read_only === true || field.derived === true || field.source === "derived_field" || field.source === "collection_embed";
}

function enumValues(field: Record<string, unknown>): string[] {
  const values = field.enum_values;
  return Array.isArray(values) ? values.filter((item): item is string => typeof item === "string") : [];
}

export function collectionRecordText(record: Record<string, unknown>, fieldId: string): string {
  const value = record[fieldId];
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function recordText(record: Record<string, unknown>, fieldId: string): string {
  return collectionRecordText(record, fieldId);
}

function compareCollectionValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true, sensitivity: "base" });
}

export function collectionDateKey(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function collectionDateKeyFromDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function jsonRecord(record: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => isJsonValue(value))) as Record<string, JsonValue>;
}

function removeUndefinedJson(record: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>;
}

function capitalize(value: string): string {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
