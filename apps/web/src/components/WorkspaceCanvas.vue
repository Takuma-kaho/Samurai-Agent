<script setup lang="ts">
import BarChart3 from "lucide-vue-next/dist/esm/icons/chart-column.js";
import FileInput from "lucide-vue-next/dist/esm/icons/file-input.js";
import FileText from "lucide-vue-next/dist/esm/icons/file-text.js";
import PanelsTopLeft from "lucide-vue-next/dist/esm/icons/panels-top-left.js";
import Save from "lucide-vue-next/dist/esm/icons/save.js";
import Table2 from "lucide-vue-next/dist/esm/icons/table-2.js";
import X from "lucide-vue-next/dist/esm/icons/x.js";
import type { ArtifactRecord, JsonValue, MemoryFrontmatter } from "@samurai-agent/core-schemas";
import type { LocaleKey } from "@samurai-agent/localization";
import type { SurfaceRenderKind, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import type { ArtifactDetail, MemoryDetail } from "../lib/api";
import type { CanvasMode } from "../lib/surface-view-helpers";
import CollectionWorkspaceView from "./CollectionWorkspaceView.vue";
import CustomViewFrame from "./CustomViewFrame.vue";
import GeneratedSurfaceFrame from "./GeneratedSurfaceFrame.vue";

type SurfaceField = { name: string; label: string; type: string; value: unknown };
type TableColumn = { key: string; label: string };
type CustomAction = { id: string; label: string };

const props = defineProps<{
  open: boolean;
  activeWorkspaceSurfaceKind?: SurfaceRenderKind;
  activeArtifact: ArtifactDetail | null;
  activeMemory: MemoryDetail | null;
  activeSurfaceSpec: SurfaceRenderSpec | null;
  canvasMode: CanvasMode;
  loading: boolean;
  label: (key: LocaleKey) => string;
  surfaceRendererLabel: (kind?: SurfaceRenderKind) => string;
  setCanvasMode: (mode: CanvasMode) => void;
  runArtifactSurfaceOperation: (kind: "form" | "table" | "chart" | "custom_view") => void | Promise<void>;
  surfaceFields: (spec: SurfaceRenderSpec) => SurfaceField[];
  formDraftValue: (spec: SurfaceRenderSpec, field: SurfaceField) => string;
  setFormDraftValue: (spec: SurfaceRenderSpec, fieldName: string, value: string | boolean) => void;
  submitSurfaceForm: (spec: SurfaceRenderSpec) => void | Promise<void>;
  surfaceTableColumns: (spec: SurfaceRenderSpec) => TableColumn[];
  surfaceTableRows: (spec: SurfaceRenderSpec) => Record<string, unknown>[];
  tableDraftValue: (spec: SurfaceRenderSpec, row: Record<string, unknown>, rowIndex: number, columnKey: string) => string;
  setTableDraftValue: (spec: SurfaceRenderSpec, row: Record<string, unknown>, rowIndex: number, columnKey: string, value: string) => void;
  saveSurfaceTableRow: (spec: SurfaceRenderSpec, row: Record<string, unknown>, rowIndex: number) => void | Promise<void>;
  surfaceCustomViewPayload: (spec: SurfaceRenderSpec) => string;
  surfaceChartRefs: (spec: SurfaceRenderSpec) => string[];
  isCollectionSurface: (spec: SurfaceRenderSpec) => boolean;
  collectionSaving: boolean;
  collectionError: string | null;
  collectionNewDraft: Record<string, string>;
  collectionController: any;
  runCustomViewAction: (spec: SurfaceRenderSpec, action: CustomAction, payload?: Record<string, JsonValue>) => void | Promise<void>;
  runGeneratedSurfaceAction: (spec: SurfaceRenderSpec, action: CustomAction, payload?: Record<string, JsonValue>) => void | Promise<void>;
  pinGeneratedSurface: (spec: SurfaceRenderSpec) => void | Promise<void>;
  reviseGeneratedSurface: (spec: SurfaceRenderSpec) => void | Promise<void>;
  exportGeneratedSurface: (spec: SurfaceRenderSpec, format: "html" | "zip") => void | Promise<void>;
  isPdfArtifact: (artifact: ArtifactRecord) => boolean;
  isImageArtifact: (artifact: ArtifactRecord) => boolean;
  isArtifactPreviewable: (artifact: ArtifactRecord) => boolean;
  artifactContentUrl: (artifact: ArtifactRecord) => string;
  markdownPreviewHtml: (content: string) => string;
  memoryStateLabel: (state: MemoryFrontmatter["state"]) => string;
}>();

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <aside class="workspace-canvas" :class="{ open: props.open }" :aria-hidden="!props.open">
    <div v-if="props.open" class="workspace-canvas-inner">
      <header class="workspace-head">
        <div>
          <span v-if="props.activeWorkspaceSurfaceKind" class="surface-chip is-compact">{{ props.surfaceRendererLabel(props.activeWorkspaceSurfaceKind) }}</span>
          <h2>{{ props.activeArtifact ? props.activeArtifact.artifact.title : props.activeMemory ? props.activeMemory.memory.topic : props.activeSurfaceSpec?.title ?? props.surfaceRendererLabel(props.activeSurfaceSpec?.kind) }}</h2>
        </div>
        <div class="workspace-actions">
          <div class="canvas-mode-switch" role="tablist" :aria-label="props.label('workspace.mode')">
            <button v-for="mode in (['preview', 'edit', 'app'] as const)" :key="mode" type="button" :class="{ 'is-active': props.canvasMode === mode }" :aria-pressed="props.canvasMode === mode" @click="props.setCanvasMode(mode)">
              <FileText v-if="mode === 'preview'" :size="14" />
              <FileInput v-else-if="mode === 'edit'" :size="14" />
              <PanelsTopLeft v-else :size="14" />
              {{ props.label(`workspace.mode.${mode}` as LocaleKey) }}
            </button>
          </div>
          <div v-if="props.activeArtifact" class="surface-action-group">
            <button class="icon-button" type="button" :title="props.surfaceRendererLabel('form')" :aria-label="props.surfaceRendererLabel('form')" :disabled="props.loading" @click="props.runArtifactSurfaceOperation('form')"><FileInput :size="15" /></button>
            <button class="icon-button" type="button" :title="props.surfaceRendererLabel('table')" :aria-label="props.surfaceRendererLabel('table')" :disabled="props.loading" @click="props.runArtifactSurfaceOperation('table')"><Table2 :size="15" /></button>
            <button class="icon-button" type="button" :title="props.surfaceRendererLabel('chart')" :aria-label="props.surfaceRendererLabel('chart')" :disabled="props.loading" @click="props.runArtifactSurfaceOperation('chart')"><BarChart3 :size="15" /></button>
            <button class="icon-button" type="button" :title="props.surfaceRendererLabel('custom_view')" :aria-label="props.surfaceRendererLabel('custom_view')" :disabled="props.loading" @click="props.runArtifactSurfaceOperation('custom_view')"><PanelsTopLeft :size="15" /></button>
          </div>
          <button class="icon-button" type="button" :title="props.label('action.close')" :aria-label="props.label('action.close')" @click="emit('close')"><X :size="16" /></button>
        </div>
      </header>

      <template v-if="props.activeArtifact || props.activeSurfaceSpec">
        <section v-if="props.activeSurfaceSpec && props.canvasMode === 'edit'" class="surface-render lit-surface">
          <div class="surface-render-head"><span class="surface-chip is-compact">{{ props.surfaceRendererLabel(props.activeSurfaceSpec.kind) }}</span><strong>{{ props.activeSurfaceSpec.title || props.activeArtifact?.artifact.title || props.surfaceRendererLabel(props.activeSurfaceSpec.kind) }}</strong></div>
          <div v-if="props.activeSurfaceSpec.kind === 'form'" class="surface-form">
            <label v-for="field in props.surfaceFields(props.activeSurfaceSpec)" :key="field.name">
              <span>{{ field.label }}</span>
              <input v-if="field.type !== 'checkbox'" :value="props.formDraftValue(props.activeSurfaceSpec, field)" :required="field.type === 'hidden' ? false : undefined" :type="field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'" @input="props.setFormDraftValue(props.activeSurfaceSpec, field.name, ($event.target as HTMLInputElement).value)" />
              <input v-else :checked="props.formDraftValue(props.activeSurfaceSpec, field) === 'true'" type="checkbox" @change="props.setFormDraftValue(props.activeSurfaceSpec, field.name, ($event.target as HTMLInputElement).checked)" />
            </label>
            <button class="surface-submit" type="button" :disabled="props.loading" @click="props.submitSurfaceForm(props.activeSurfaceSpec)"><Save :size="14" />{{ props.activeSurfaceSpec.props.submit_label || props.label("workspace.save") }}</button>
          </div>
          <div v-else-if="props.activeSurfaceSpec.kind === 'table'" class="surface-table-wrap">
            <table class="surface-table">
              <thead><tr><th v-for="column in props.surfaceTableColumns(props.activeSurfaceSpec)" :key="column.key">{{ column.label }}</th><th>{{ props.label("workspace.save") }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, rowIndex) in props.surfaceTableRows(props.activeSurfaceSpec)" :key="rowIndex">
                  <td v-for="column in props.surfaceTableColumns(props.activeSurfaceSpec)" :key="column.key"><input :value="props.tableDraftValue(props.activeSurfaceSpec, row, rowIndex, column.key)" :readonly="props.activeSurfaceSpec.props.patchable !== true" @input="props.setTableDraftValue(props.activeSurfaceSpec, row, rowIndex, column.key, ($event.target as HTMLInputElement).value)" /></td>
                  <td><button class="surface-row-save" type="button" :disabled="props.loading || props.activeSurfaceSpec.props.patchable !== true" @click="props.saveSurfaceTableRow(props.activeSurfaceSpec, row, rowIndex)"><Save :size="13" /></button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <pre v-else class="surface-json">{{ props.surfaceCustomViewPayload(props.activeSurfaceSpec) }}</pre>
        </section>

        <section v-if="props.activeSurfaceSpec && props.canvasMode === 'app'" class="surface-render lit-surface">
          <div class="surface-render-head"><span class="surface-chip is-compact">{{ props.surfaceRendererLabel(props.activeSurfaceSpec.kind) }}</span><strong>{{ props.activeSurfaceSpec.title || props.activeArtifact?.artifact.title || props.surfaceRendererLabel(props.activeSurfaceSpec.kind) }}</strong></div>
          <div v-if="props.activeSurfaceSpec.kind === 'chart'" class="surface-chart"><BarChart3 :size="18" /><div><strong>{{ props.activeSurfaceSpec.title }}</strong><span>{{ props.surfaceChartRefs(props.activeSurfaceSpec).join(" / ") }}</span></div></div>
          <CollectionWorkspaceView v-else-if="props.activeSurfaceSpec.kind === 'custom_view' && props.isCollectionSurface(props.activeSurfaceSpec)" :spec="props.activeSurfaceSpec" :saving="props.collectionSaving" :error="props.collectionError" :new-draft="props.collectionNewDraft" :controller="props.collectionController" />
          <GeneratedSurfaceFrame v-else-if="props.activeSurfaceSpec.kind === 'custom_view' && props.activeSurfaceSpec.props.renderer === 'generated_surface'" :spec="props.activeSurfaceSpec" :saving="props.loading" :run-action="props.runGeneratedSurfaceAction" :pin-surface="props.pinGeneratedSurface" :revise-surface="props.reviseGeneratedSurface" :export-surface="props.exportGeneratedSurface" />
          <CustomViewFrame v-else-if="props.activeSurfaceSpec.kind === 'custom_view'" :spec="props.activeSurfaceSpec" :saving="props.loading" :run-action="props.runCustomViewAction" />
          <pre v-else class="surface-json">{{ props.surfaceCustomViewPayload(props.activeSurfaceSpec) }}</pre>
        </section>

        <section v-if="props.activeArtifact && props.canvasMode === 'preview'" class="canvas-preview">
          <object v-if="props.isPdfArtifact(props.activeArtifact.artifact)" class="pdf-preview" :data="props.artifactContentUrl(props.activeArtifact.artifact)" type="application/pdf"><a :href="props.artifactContentUrl(props.activeArtifact.artifact)" target="_blank" rel="noreferrer">{{ props.label("workspace.open_raw") }}</a></object>
          <img v-else-if="props.isImageArtifact(props.activeArtifact.artifact)" class="image-preview" :src="props.artifactContentUrl(props.activeArtifact.artifact)" :alt="props.activeArtifact.artifact.title" />
          <article v-else-if="props.isArtifactPreviewable(props.activeArtifact.artifact)" class="markdown-preview lit-surface" v-html="props.markdownPreviewHtml(props.activeArtifact.content)"></article>
          <pre v-else class="document-surface">{{ props.activeArtifact.content }}</pre>
        </section>
      </template>

      <template v-else-if="props.activeMemory">
        <div class="workspace-meta"><span>{{ props.memoryStateLabel(props.activeMemory.memory.state) }}</span><span>{{ props.label("memory.source") }}: {{ props.activeMemory.memory.source }}</span></div>
        <pre class="document-surface">{{ props.activeMemory.content }}</pre>
      </template>
    </div>
  </aside>
</template>
