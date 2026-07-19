import { ref, type Ref } from "vue";
import type { JsonValue, MessagePresentationRecord, SessionRecord } from "@samurai-agent/core-schemas";
import type { SurfaceRendererCapabilities, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import { api, ApiError } from "./api";
import { defaultCanvasMode, type CanvasMode } from "./surface-view-helpers";
import {
  appCollectionRecords,
  collectionActionRunPayload,
  collectionCalendarDateSelection,
  collectionCalendarMonthOffsetDate,
  collectionCreateDataForView,
  collectionCreateDraftForView,
  collectionDateField,
  collectionDraftValueFromRaw,
  collectionFieldId,
  collectionFilterField,
  collectionKanbanDragPayload,
  collectionKanbanDropPatch,
  collectionRecordId,
  collectionRenderer,
  collectionRequiredReady,
  collectionSelectedDateKey,
  collectionSortDirection,
  collectionSortFieldId,
  collectionTableEditableFields,
  collectionTableId,
  collectionTableViewId,
  collectionUserViewState,
  collectionValidationMessage,
  collectionViewState,
  withCollectionViewState,
  type CollectionUiAction
} from "./collection-view-state";

const collectionSurfaceRenderers = new Set(["collection_table", "collection_gallery", "calendar_view", "collection_kanban"]);

type CollectionWorkspaceInput = {
  activeSurfaceSpec: Ref<SurfaceRenderSpec | null>;
  activeMessagePresentationId: Ref<string | null>;
  messagePresentations: Ref<MessagePresentationRecord[]>;
  lastSurfaceRenderSpec: Ref<SurfaceRenderSpec | null>;
  lastSurfaceRenderSpecs: Ref<SurfaceRenderSpec[]>;
  frontendRendererCapabilities: Readonly<Ref<SurfaceRendererCapabilities>>;
  activeSession: Ref<SessionRecord | null>;
  selectedBackendId: Ref<string>;
  activeArtifact: Ref<any>;
  activeMemory: Ref<any>;
  ensureSurfaceContract: (extraKinds?: string[]) => Promise<void>;
  openSurfaceSpec: (spec: SurfaceRenderSpec) => void;
  reloadActiveSession: () => Promise<void>;
  setCanvasMode: (mode: CanvasMode) => void;
};

export function useCollectionWorkspace(input: CollectionWorkspaceInput) {
  const collectionDrafts = ref<Record<string, Record<string, string>>>({});
  const collectionNewDraft = ref<Record<string, string>>({});
  const collectionSaving = ref(false);
  const collectionAppError = ref<string | null>(null);
  const collectionDraggedRecordId = ref<string | null>(null);

  async function switchCollectionView(spec: SurfaceRenderSpec, option: Record<string, JsonValue>) {
    const viewId = String(option.id ?? "");
    if (!viewId || viewId === collectionTableViewId(spec) || collectionSaving.value) return;
    const presentationId = input.activeMessagePresentationId.value;
    const previousState = collectionUserViewState(spec);
    collectionSaving.value = true;
    try {
      const envelope = await api.runSurfaceOperation({
        id: `surface_collection_view_switch_${Date.now()}`,
        kind: "collection.view.present",
        collection_id: collectionTableId(spec),
        view_id: viewId,
        renderer_capabilities: input.frontendRendererCapabilities.value
      });
      const nextSpec = envelope.render_spec;
      requireCollectionSurface(nextSpec, "collection_view_switch_render_spec_required");
      input.openSurfaceSpec(nextSpec);
      input.activeMessagePresentationId.value = presentationId;
      replaceLastCollectionSurface(nextSpec);
      await updateActiveCollectionViewState({
        ...previousState,
        view_id: collectionTableViewId(nextSpec),
        renderer: collectionRenderer(nextSpec)
      });
    } catch (error) {
      collectionAppError.value = collectionSurfaceErrorMessage(error);
    } finally {
      collectionSaving.value = false;
    }
  }

  function collectionStateSourceSpec(spec: SurfaceRenderSpec): SurfaceRenderSpec {
    const active = input.activeSurfaceSpec.value;
    return active && isCollectionSurfaceSpec(active) && collectionTableId(active) === collectionTableId(spec) ? active : spec;
  }

  function collectionSelectedRecordId(spec: SurfaceRenderSpec): string {
    const value = collectionViewState(collectionStateSourceSpec(spec)).selected_record_id;
    return typeof value === "string" ? value : "";
  }

  async function selectCollectionRecord(spec: SurfaceRenderSpec, record: Record<string, unknown>) {
    const id = collectionRecordId(record);
    if (id && collectionSelectedRecordId(spec) !== id) await updateActiveCollectionViewState({ selected_record_id: id });
  }

  async function setCollectionSearchQuery(_spec: SurfaceRenderSpec, search: string) {
    await updateActiveCollectionViewState({ search });
  }

  async function setCollectionSortField(spec: SurfaceRenderSpec, fieldId: string) {
    await updateActiveCollectionViewState({ sort: fieldId ? { field_id: fieldId, direction: collectionSortDirection(spec) } : {} });
  }

  async function toggleCollectionSortDirection(spec: SurfaceRenderSpec) {
    const fieldId = collectionSortFieldId(spec);
    if (fieldId) await updateActiveCollectionViewState({ sort: { field_id: fieldId, direction: collectionSortDirection(spec) === "desc" ? "asc" : "desc" } });
  }

  async function setCollectionFilterValue(spec: SurfaceRenderSpec, value: string) {
    const field = collectionFilterField(spec);
    await updateActiveCollectionViewState({ filter: field && value ? { field_id: collectionFieldId(field), value } : {} });
  }

  async function setCollectionGroupField(_spec: SurfaceRenderSpec, fieldId: string) {
    await updateActiveCollectionViewState({ group: fieldId || null });
  }

  async function updateActiveCollectionViewState(patch: Record<string, JsonValue>) {
    const active = input.activeSurfaceSpec.value;
    if (!active || !isCollectionSurfaceSpec(active)) return;
    const nextSpec = withCollectionViewState(active, patch);
    input.activeSurfaceSpec.value = nextSpec;
    await persistActiveCollectionPresentationState(nextSpec);
  }

  async function persistActiveCollectionPresentationState(spec: SurfaceRenderSpec) {
    const presentationId = input.activeMessagePresentationId.value;
    if (!presentationId) return;
    try {
      const envelope = await api.updateMessagePresentationViewState(presentationId, collectionViewState(spec));
      input.messagePresentations.value = mergeById(input.messagePresentations.value, [envelope.result]);
    } catch {
      // The active view remains usable if only presentation-state persistence fails.
    }
  }

  async function shiftCollectionCalendarMonth(spec: SurfaceRenderSpec, offset: number) {
    await updateActiveCollectionViewState({ selected_date: collectionCalendarMonthOffsetDate(spec, offset) });
  }

  async function selectCollectionCalendarDate(spec: SurfaceRenderSpec, date: string) {
    const selection = collectionCalendarDateSelection(collectionDateField(spec), date);
    if (selection.draft) setCollectionNewDraftValue(selection.draft.field_id, selection.draft.value);
    await updateActiveCollectionViewState(selection.view_state);
  }

  function beginCollectionKanbanDrag(record: Record<string, unknown>, event?: DragEvent) {
    const payload = collectionKanbanDragPayload(record);
    collectionDraggedRecordId.value = payload?.record_id ?? "";
    if (!payload || !event?.dataTransfer) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-samurai-collection-record", JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", payload.record_id);
  }

  function collectionKanbanDroppedRecordId(event?: DragEvent): string | null {
    if (collectionDraggedRecordId.value) return collectionDraggedRecordId.value;
    const transfer = event?.dataTransfer;
    if (!transfer) return null;
    const payload = transfer.getData("application/x-samurai-collection-record");
    if (payload) {
      try {
        const parsed = JSON.parse(payload);
        if (isRecord(parsed) && typeof parsed.record_id === "string" && parsed.record_id.trim()) return parsed.record_id.trim();
      } catch {
        // Fall back to the plain-text record id for malformed custom payloads.
      }
    }
    return transfer.getData("text/plain").trim() || null;
  }

  async function dropCollectionKanbanRecord(spec: SurfaceRenderSpec, value: string, event?: DragEvent) {
    const recordId = collectionKanbanDroppedRecordId(event);
    collectionDraggedRecordId.value = null;
    const patch = collectionKanbanDropPatch(spec, recordId, value);
    if (!patch) return;
    await patchCollectionRecordFields(spec, patch.record_id, patch.changes);
    await updateActiveCollectionViewState(patch.view_state);
  }

  function collectionDraft(record: Record<string, unknown>): Record<string, string> {
    const id = String(record.id ?? "");
    const draft = collectionDrafts.value[id] ?? {};
    const active = input.activeSurfaceSpec.value;
    if (!active) return draft;
    for (const field of collectionTableEditableFields(active)) {
      const fieldId = String(field.id ?? "");
      if (fieldId && !(fieldId in draft)) draft[fieldId] = String(record[fieldId] ?? "");
    }
    return draft;
  }

  function setCollectionDraftValue(record: Record<string, unknown>, field: string, value: string) {
    const id = String(record.id ?? "");
    collectionDrafts.value = { ...collectionDrafts.value, [id]: { ...collectionDraft(record), [field]: value } };
  }

  function setCollectionNewDraftValue(field: string, value: string) {
    collectionNewDraft.value = { ...collectionNewDraft.value, [field]: value };
  }

  function collectionPatchFromDraft(spec: SurfaceRenderSpec, record: Record<string, unknown>): Record<string, JsonValue> {
    const draft = collectionDraft(record);
    return Object.fromEntries(collectionTableEditableFields(spec).map((field) => {
      const id = String(field.id ?? "");
      return [id, collectionDraftValueFromRaw(field, draft[id] ?? "")];
    }));
  }

  function collectionCreateDraft(spec: SurfaceRenderSpec): Record<string, string> {
    return collectionCreateDraftForView(spec, collectionNewDraft.value, { selectedDate: collectionSelectedDateKey(spec) });
  }

  function syncCollectionDrafts(spec: SurfaceRenderSpec) {
    collectionDrafts.value = Object.fromEntries(appCollectionRecords(spec).map((record) => [
      String(record.id ?? ""),
      Object.fromEntries(collectionTableEditableFields(spec).map((field) => [String(field.id ?? ""), String(record[String(field.id ?? "")] ?? "")]))
    ]));
    collectionNewDraft.value = Object.fromEntries(collectionTableEditableFields(spec).map((field) => [String(field.id ?? ""), ""]));
  }

  async function refreshCollectionTableSurface(spec: SurfaceRenderSpec) {
    try {
      await input.ensureSurfaceContract();
      const previousState = collectionUserViewState(collectionStateSourceSpec(spec));
      const envelope = await api.runSurfaceOperation({
        id: `surface_collection_present_${Date.now()}`,
        kind: "collection.view.present",
        collection_id: collectionTableId(spec),
        view_id: collectionTableViewId(spec),
        renderer_capabilities: input.frontendRendererCapabilities.value
      });
      requireCollectionSurface(envelope.render_spec, "collection_table_render_spec_required");
      const nextSpec = withCollectionViewState(envelope.render_spec, previousState);
      collectionAppError.value = null;
      input.activeSurfaceSpec.value = nextSpec;
      replaceLastCollectionSurface(nextSpec);
      syncCollectionDrafts(nextSpec);
      await persistActiveCollectionPresentationState(nextSpec);
    } catch (error) {
      collectionAppError.value = collectionSurfaceErrorMessage(error);
      if (!input.activeSurfaceSpec.value && isCollectionSurfaceSpec(spec)) input.activeSurfaceSpec.value = spec;
      throw error;
    }
  }

  async function addCollectionRecord(spec: SurfaceRenderSpec) {
    if (collectionSaving.value) return;
    const draft = collectionCreateDraft(spec);
    if (!collectionRequiredReady(spec, draft)) {
      collectionAppError.value = collectionValidationMessage(spec, draft);
      return;
    }
    collectionSaving.value = true;
    try {
      await input.ensureSurfaceContract();
      const recordId = `record_${Date.now()}`;
      await api.runSurfaceOperation({
        id: `surface_collection_create_${Date.now()}`,
        kind: "collection.record.create",
        collection_id: collectionTableId(spec),
        record_id: recordId,
        renderer_capabilities: input.frontendRendererCapabilities.value,
        data: collectionCreateDataForView(spec, collectionNewDraft.value, { selectedDate: collectionSelectedDateKey(spec) })
      });
      await refreshCollectionTableSurface(spec);
      await updateActiveCollectionViewState({ selected_record_id: recordId });
    } catch (error) {
      collectionAppError.value = collectionSurfaceErrorMessage(error);
    } finally {
      collectionSaving.value = false;
    }
  }

  async function saveCollectionRecord(spec: SurfaceRenderSpec, record: Record<string, unknown>) {
    const id = String(record.id ?? "");
    if (!id || collectionSaving.value) return;
    const draft = collectionDraft(record);
    if (!collectionRequiredReady(spec, draft)) {
      collectionAppError.value = collectionValidationMessage(spec, draft);
      return;
    }
    await selectCollectionRecord(spec, record);
    await patchCollectionRecordFields(spec, id, collectionPatchFromDraft(spec, record));
  }

  async function patchCollectionRecordFields(spec: SurfaceRenderSpec, recordId: string, changes: Record<string, JsonValue>) {
    if (!recordId || collectionSaving.value) return;
    collectionSaving.value = true;
    try {
      await input.ensureSurfaceContract();
      await api.runSurfaceOperation({
        id: `surface_collection_patch_${Date.now()}`,
        kind: "collection.record.patch",
        collection_id: collectionTableId(spec),
        record_id: recordId,
        patch_id: `collection_patch_${Date.now()}`,
        expected_version: requiredCollectionRecordVersion(appCollectionRecords(spec).find((record) => String(record.id ?? "") === recordId)),
        changes,
        renderer_capabilities: input.frontendRendererCapabilities.value
      });
      await refreshCollectionTableSurface(spec);
      await updateActiveCollectionViewState({ selected_record_id: recordId });
    } catch (error) {
      collectionAppError.value = collectionSurfaceErrorMessage(error);
    } finally {
      collectionSaving.value = false;
    }
  }

  async function deleteCollectionRecordFromTable(spec: SurfaceRenderSpec, record: Record<string, unknown>) {
    const id = String(record.id ?? "");
    if (!id || collectionSaving.value) return;
    const nextState = { ...collectionUserViewState(collectionStateSourceSpec(spec)), selected_record_id: null };
    collectionSaving.value = true;
    try {
      await input.ensureSurfaceContract();
      const envelope = await api.runSurfaceOperation({
        id: `surface_collection_delete_${Date.now()}`,
        kind: "collection.record.delete",
        collection_id: collectionTableId(spec),
        record_id: id,
        view_id: collectionTableViewId(spec),
        renderer_capabilities: input.frontendRendererCapabilities.value
      });
      if (isCollectionSurfaceSpec(envelope.render_spec)) {
        const nextSpec = withCollectionViewState(envelope.render_spec, nextState);
        input.activeSurfaceSpec.value = nextSpec;
        input.lastSurfaceRenderSpec.value = nextSpec;
        syncCollectionDrafts(nextSpec);
      } else {
        await refreshCollectionTableSurface(spec);
      }
      await updateActiveCollectionViewState({ selected_record_id: null });
    } catch (error) {
      collectionAppError.value = collectionSurfaceErrorMessage(error);
    } finally {
      collectionSaving.value = false;
    }
  }

  async function runCollectionSchemaAction(spec: SurfaceRenderSpec, action: CollectionUiAction, record?: Record<string, unknown>) {
    const recordId = record ? String(record.id ?? "") : "";
    if (collectionSaving.value || (record && !recordId)) return;
    collectionSaving.value = true;
    try {
      await input.ensureSurfaceContract(["collection.action.run"]);
      const previousState = { ...collectionUserViewState(collectionStateSourceSpec(spec)), ...(recordId ? { selected_record_id: recordId } : {}) };
      const envelope = await api.runSurfaceOperation({
        id: `surface_collection_action_${Date.now()}`,
        kind: "collection.action.run",
        session_id: input.activeSession.value?.id,
        collection_id: collectionTableId(spec),
        action_id: action.id,
        backend_id: input.selectedBackendId.value,
        record_id: recordId || undefined,
        view_id: collectionTableViewId(spec),
        payload: collectionActionRunPayload(collectionStateSourceSpec(spec), {
          action_id: action.id,
          action_label: action.label,
          action_kind: action.actionKind,
          scope: action.scope,
          ...(record ? { record } : {})
        }),
        renderer_capabilities: input.frontendRendererCapabilities.value
      });
      const renderSpecs = envelopeRenderSpecs(envelope);
      const generatedCustomView = renderSpecs.find((item) => item.kind === "custom_view" && !isCollectionSurfaceSpec(item) && !isTaskListSurfaceSpec(item));
      if (generatedCustomView) {
        input.activeSurfaceSpec.value = generatedCustomView;
        input.activeArtifact.value = null;
        input.activeMemory.value = null;
        input.activeMessagePresentationId.value = null;
        input.setCanvasMode(defaultCanvasMode(generatedCustomView));
        input.lastSurfaceRenderSpec.value = generatedCustomView;
        input.lastSurfaceRenderSpecs.value = renderSpecs;
      } else if (isCollectionSurfaceSpec(envelope.render_spec)) {
        const nextSpec = withCollectionViewState(envelope.render_spec, previousState);
        input.activeSurfaceSpec.value = nextSpec;
        replaceLastCollectionSurface(nextSpec);
        syncCollectionDrafts(nextSpec);
        await persistActiveCollectionPresentationState(nextSpec);
      } else {
        await refreshCollectionTableSurface(spec);
      }
      if (recordId) await updateActiveCollectionViewState({ selected_record_id: recordId });
      if (input.activeSession.value) await input.reloadActiveSession();
      collectionAppError.value = null;
    } catch (error) {
      collectionAppError.value = collectionSurfaceErrorMessage(error);
    } finally {
      collectionSaving.value = false;
    }
  }

  function replaceLastCollectionSurface(nextSpec: SurfaceRenderSpec) {
    input.lastSurfaceRenderSpec.value = nextSpec;
    input.lastSurfaceRenderSpecs.value = [nextSpec, ...input.lastSurfaceRenderSpecs.value.filter((item) => !(isCollectionSurfaceSpec(item) && collectionTableId(item) === collectionTableId(nextSpec)))];
  }

  const collectionWorkspaceController = {
    switchCollectionView, refreshCollectionTableSurface, runCollectionSchemaAction,
    setCollectionSearchQuery, setCollectionSortField, toggleCollectionSortDirection,
    setCollectionFilterValue, setCollectionGroupField, setCollectionNewDraftValue,
    addCollectionRecord, selectCollectionRecord, collectionDraft, setCollectionDraftValue,
    saveCollectionRecord, deleteCollectionRecordFromTable, shiftCollectionCalendarMonth,
    selectCollectionCalendarDate, beginCollectionKanbanDrag, dropCollectionKanbanRecord
  };

  return {
    collectionAppError,
    collectionNewDraft,
    collectionSaving,
    collectionWorkspaceController,
    syncCollectionDrafts,
    collectionSurfaceErrorMessage
  };
}

export function isCollectionSurfaceSpec(spec: SurfaceRenderSpec): boolean {
  return spec.kind === "custom_view" && collectionSurfaceRenderers.has(String(spec.props.renderer ?? ""));
}

function isTaskListSurfaceSpec(spec: SurfaceRenderSpec): boolean {
  return spec.kind === "custom_view" && spec.props.renderer === "task_list";
}

function requireCollectionSurface(spec: SurfaceRenderSpec, message: string): asserts spec is SurfaceRenderSpec {
  if (!isCollectionSurfaceSpec(spec)) throw new Error(message);
}

function requiredCollectionRecordVersion(record: Record<string, unknown> | undefined): number {
  const version = record?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) throw new Error("最新のレコード状態を取得してから、もう一度保存してください。");
  return version;
}

function collectionSurfaceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("task_surface_contract_missing:")) return "Collectionを表示できません。古いAPIサーバーにつながっている可能性があります。APIとWebを同じ dev 起動で開き直してください。";
  if (error instanceof ApiError && isRecord(error.body) && error.body.error === "invalid_surface_operation") return "Collectionを表示できません。APIサーバーが古い可能性があります。APIを再起動してください。";
  if (error instanceof ApiError) return `Collectionを更新できませんでした。APIエラー ${error.status}`;
  return "Collectionを更新できませんでした。API接続を確認してください。";
}

function envelopeRenderSpecs(envelope: { render_spec: SurfaceRenderSpec; render_specs?: SurfaceRenderSpec[] }): SurfaceRenderSpec[] {
  return envelope.render_specs && envelope.render_specs.length > 0 ? envelope.render_specs : [envelope.render_spec];
}

function mergeById<T extends { id: string }>(primary: T[], fallback: T[]): T[] {
  return [...primary, ...fallback.filter((candidate) => !primary.some((item) => item.id === candidate.id))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
