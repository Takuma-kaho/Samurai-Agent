import { ref, type Ref } from "vue";
import type { ArtifactRecord, JsonValue, MessagePresentationRecord, SessionRecord, SettingsRecord, WorkspaceChangeRecord } from "@samurai-agent/core-schemas";
import type { SurfaceOperation, SurfaceRendererCapabilities, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import { api, type ArtifactDetail, type MemoryDetail, type SurfaceContractPayload } from "./api";
import { defaultCanvasMode, objectToJsonRecord, surfaceRowKey, surfaceValue, toJsonValue, type CanvasMode } from "./surface-view-helpers";

type SurfaceField = { name: string; label: string; type: string; value: unknown };

export function useSurfaceWorkspace(input: {
  activeSession: Ref<SessionRecord | null>;
  settings: Ref<SettingsRecord>;
  surfaceContract: Ref<SurfaceContractPayload | null>;
  frontendRendererCapabilities: Readonly<Ref<SurfaceRendererCapabilities>>;
  loading: Ref<boolean>;
  lastSurfaceRenderSpec: Ref<SurfaceRenderSpec | null>;
  activeMessagePresentationId: Ref<string | null>;
  reloadActiveSession: () => Promise<void>;
  isCollectionSurface: (spec: SurfaceRenderSpec) => boolean;
  syncCollectionDrafts: (spec: SurfaceRenderSpec) => void;
  isArtifactRecordLike: (value: unknown) => value is ArtifactRecord;
}) {
  const activeArtifact = ref<ArtifactDetail | null>(null);
  const activeMemory = ref<MemoryDetail | null>(null);
  const activeSurfaceSpec = ref<SurfaceRenderSpec | null>(null);
  const canvasMode = ref<CanvasMode>(readCanvasMode());
  const surfaceFormDraft = ref<Record<string, Record<string, JsonValue>>>({});
  const surfaceTableDraft = ref<Record<string, Record<string, Record<string, JsonValue>>>>({});
  const memoryContent = ref<Record<string, string>>({});

  async function openArtifact(id: string) {
    activeArtifact.value = await api.getArtifact(id);
    activeMemory.value = null;
    activeSurfaceSpec.value = null;
    input.activeMessagePresentationId.value = null;
  }

  async function openMemory(id: string) {
    activeMemory.value = await api.getMemory(id);
    activeArtifact.value = null;
    activeSurfaceSpec.value = null;
    input.activeMessagePresentationId.value = null;
    memoryContent.value = { ...memoryContent.value, [id]: activeMemory.value.content };
  }

  function closeWorkspaceCanvas() {
    activeArtifact.value = null;
    activeMemory.value = null;
    activeSurfaceSpec.value = null;
    input.activeMessagePresentationId.value = null;
  }

  function setCanvasMode(mode: CanvasMode) {
    canvasMode.value = mode;
    persistCanvasMode(mode);
  }

  function openSurfaceSpec(spec: SurfaceRenderSpec) {
    activeSurfaceSpec.value = spec;
    activeArtifact.value = null;
    activeMemory.value = null;
    input.activeMessagePresentationId.value = null;
    setCanvasMode(defaultCanvasMode(spec));
    if (input.isCollectionSurface(spec)) input.syncCollectionDrafts(spec);
  }

  function prepareSurfaceDraft(spec: SurfaceRenderSpec) {
    canvasMode.value = defaultCanvasMode(spec);
    persistCanvasMode(canvasMode.value);
    if (spec.kind === "form") {
      surfaceFormDraft.value = { ...surfaceFormDraft.value, [spec.id]: Object.fromEntries(surfaceFields(spec).map((field) => [field.name, toJsonValue(field.value)])) };
    }
    if (spec.kind === "table") {
      surfaceTableDraft.value = {
        ...surfaceTableDraft.value,
        [spec.id]: Object.fromEntries(surfaceTableRows(spec).map((row, index) => [surfaceRowKey(row, index), objectToJsonRecord(row)]))
      };
    }
  }

  function formDraftValue(spec: SurfaceRenderSpec, field: SurfaceField): string {
    return surfaceValue(surfaceFormDraft.value[spec.id]?.[field.name] ?? field.value);
  }

  function setFormDraftValue(spec: SurfaceRenderSpec, fieldName: string, value: string | boolean) {
    surfaceFormDraft.value = { ...surfaceFormDraft.value, [spec.id]: { ...(surfaceFormDraft.value[spec.id] ?? {}), [fieldName]: toJsonValue(value) } };
  }

  function tableDraftValue(spec: SurfaceRenderSpec, row: Record<string, unknown>, rowIndex: number, columnKey: string): string {
    const rowKey = surfaceRowKey(row, rowIndex);
    return surfaceValue(surfaceTableDraft.value[spec.id]?.[rowKey]?.[columnKey] ?? row[columnKey]);
  }

  function setTableDraftValue(spec: SurfaceRenderSpec, row: Record<string, unknown>, rowIndex: number, columnKey: string, value: string) {
    const rowKey = surfaceRowKey(row, rowIndex);
    surfaceTableDraft.value = { ...surfaceTableDraft.value, [spec.id]: { ...(surfaceTableDraft.value[spec.id] ?? {}), [rowKey]: { ...(surfaceTableDraft.value[spec.id]?.[rowKey] ?? objectToJsonRecord(row)), [columnKey]: toJsonValue(value) } } };
  }

  async function runArtifactSurfaceOperation(kind: "form" | "table" | "chart" | "custom_view") {
    if (!input.activeSession.value || !activeArtifact.value || input.loading.value) return;
    input.loading.value = true;
    try {
      const artifact = activeArtifact.value.artifact;
      const base = operationBase(input, kind, artifact.id);
      const operation: SurfaceOperation = kind === "form"
        ? { ...base, kind: "form.submit", form_id: `artifact.${artifact.id}.review`, values: { artifact_id: artifact.id, title: artifact.title, kind: artifact.kind }, submit_label: "Save" }
        : kind === "table"
          ? { ...base, kind: "table.patch", table_id: `artifact.${artifact.id}.table`, row_id: artifact.id, changes: { title: artifact.title, kind: artifact.kind, file_path: artifact.file_ref.uri } }
          : kind === "chart"
            ? { ...base, kind: "chart.request", chart_id: `artifact.${artifact.id}.chart`, title: `${artifact.title} chart`, query: `Summarize ${artifact.title} as chart-ready workspace data.`, data_refs: [artifact.file_ref.uri] }
            : { ...base, kind: "custom_view.action", view_id: `artifact.${artifact.id}.custom`, action_id: "open", payload: { renderer: "generic", artifact_id: artifact.id, title: artifact.title, file_path: artifact.file_ref.uri } };
      const envelope = await api.runSurfaceOperation<{ resource?: unknown; workspaceChange?: WorkspaceChangeRecord }>(operation);
      applyRenderSpec(envelope.render_spec);
      await input.reloadActiveSession();
      if (input.isArtifactRecordLike(envelope.result.resource)) activeArtifact.value = await api.getArtifact(envelope.result.resource.id);
    } finally {
      input.loading.value = false;
    }
  }

  async function submitSurfaceForm(spec: SurfaceRenderSpec) {
    if (!input.activeSession.value || spec.kind !== "form" || input.loading.value) return;
    input.loading.value = true;
    try {
      const values = surfaceFormDraft.value[spec.id] ?? Object.fromEntries(surfaceFields(spec).map((field) => [field.name, toJsonValue(field.value)]));
      const envelope = await api.runSurfaceOperation<{ resource?: unknown; workspaceChange?: WorkspaceChangeRecord }>({
        ...operationBase(input, "form", spec.id), kind: "form.submit", form_id: String(spec.props.form_id), values,
        submit_label: typeof spec.props.submit_label === "string" ? spec.props.submit_label : undefined,
        metadata: { frontend_surface_contract_version: input.surfaceContract.value?.protocol_version ?? "1", source_render_spec_id: spec.id }
      });
      applyRenderSpec(envelope.render_spec);
      await input.reloadActiveSession();
    } finally { input.loading.value = false; }
  }

  async function saveSurfaceTableRow(spec: SurfaceRenderSpec, row: Record<string, unknown>, rowIndex: number) {
    if (!input.activeSession.value || spec.kind !== "table" || input.loading.value) return;
    input.loading.value = true;
    try {
      const rowKey = surfaceRowKey(row, rowIndex);
      const envelope = await api.runSurfaceOperation<{ resource?: unknown; workspaceChange?: WorkspaceChangeRecord }>({
        ...operationBase(input, "table", spec.id), kind: "table.patch", table_id: String(spec.props.table_id),
        row_id: typeof row.id === "string" ? row.id : rowKey,
        changes: objectToJsonRecord(surfaceTableDraft.value[spec.id]?.[rowKey] ?? row),
        metadata: { frontend_surface_contract_version: input.surfaceContract.value?.protocol_version ?? "1", source_render_spec_id: spec.id }
      });
      applyRenderSpec(envelope.render_spec);
      await input.reloadActiveSession();
    } finally { input.loading.value = false; }
  }

  async function runCustomViewAction(spec: SurfaceRenderSpec, action: { id: string; label: string }, actionPayload: Record<string, JsonValue> = {}) {
    if (!input.activeSession.value || spec.kind !== "custom_view" || input.loading.value) return;
    input.loading.value = true;
    try {
      const envelope = await api.runSurfaceOperation<{ resource?: unknown; workspaceChange?: WorkspaceChangeRecord }>({
        ...operationBase(input, "custom_view", spec.id), kind: "custom_view.action", view_id: String(spec.props.view_id), action_id: action.id,
        payload: { ...actionPayload, renderer: String(spec.props.renderer), source_render_spec_id: spec.id, data: toJsonValue(spec.props.data) },
        metadata: { frontend_surface_contract_version: input.surfaceContract.value?.protocol_version ?? "1" }
      });
      applyRenderSpec(envelope.render_spec);
      await input.reloadActiveSession();
    } finally { input.loading.value = false; }
  }

  function applyRenderSpec(spec: SurfaceRenderSpec) {
    input.lastSurfaceRenderSpec.value = spec;
    activeSurfaceSpec.value = spec;
  }

  return {
    activeArtifact, activeMemory, activeSurfaceSpec, canvasMode, memoryContent,
    openArtifact, openMemory, closeWorkspaceCanvas, setCanvasMode, openSurfaceSpec, prepareSurfaceDraft,
    formDraftValue, setFormDraftValue, tableDraftValue, setTableDraftValue,
    runArtifactSurfaceOperation, submitSurfaceForm, saveSurfaceTableRow, runCustomViewAction
  };
}

function operationBase(input: Parameters<typeof useSurfaceWorkspace>[0], action: string, sourceId: string) {
  return {
    id: `surface_${action}_${Date.now()}`,
    session_id: input.activeSession.value!.id,
    input_locale: input.settings.value.ui_locale,
    output_locale: input.settings.value.output_locale,
    renderer_capabilities: input.frontendRendererCapabilities.value,
    metadata: { frontend_surface_contract_version: input.surfaceContract.value?.protocol_version ?? "1", frontend_surface_action: action, source_artifact_id: sourceId }
  };
}

export function surfaceFields(spec: SurfaceRenderSpec): SurfaceField[] {
  const fields = Array.isArray(spec.props.fields) ? spec.props.fields : [];
  return fields.filter(isRecord).map((field) => ({ name: typeof field.name === "string" ? field.name : "field", label: typeof field.label === "string" ? field.label : typeof field.name === "string" ? field.name : "Field", type: typeof field.type === "string" ? field.type : "text", value: field.default_value }));
}
export function surfaceTableColumns(spec: SurfaceRenderSpec): Array<{ key: string; label: string }> {
  const columns = Array.isArray(spec.props.columns) ? spec.props.columns : [];
  return columns.filter(isRecord).map((column) => ({ key: typeof column.key === "string" ? column.key : "value", label: typeof column.label === "string" ? column.label : typeof column.key === "string" ? column.key : "Value" }));
}
export function surfaceTableRows(spec: SurfaceRenderSpec): Record<string, unknown>[] { return Array.isArray(spec.props.rows) ? spec.props.rows.filter(isRecord) : []; }
export function surfaceChartRefs(spec: SurfaceRenderSpec): string[] { return Array.isArray(spec.props.data_refs) ? spec.props.data_refs.filter((item): item is string => typeof item === "string") : []; }
export function surfaceCustomViewPayload(spec: SurfaceRenderSpec): string { return JSON.stringify(spec.props.data ?? spec.props, null, 2); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const canvasModeStorageKey = "samurai-agent.workspace-canvas-mode";
function readCanvasMode(): CanvasMode {
  try { const value = window.localStorage.getItem(canvasModeStorageKey); return value === "edit" || value === "app" || value === "preview" ? value : "preview"; } catch { return "preview"; }
}
function persistCanvasMode(mode: CanvasMode) { try { window.localStorage.setItem(canvasModeStorageKey, mode); } catch { /* restricted storage */ } }
