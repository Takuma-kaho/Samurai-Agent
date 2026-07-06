<script setup lang="ts">
import ArrowDown from "lucide-vue-next/dist/esm/icons/arrow-down.js";
import ArrowUp from "lucide-vue-next/dist/esm/icons/arrow-up.js";
import ChevronLeft from "lucide-vue-next/dist/esm/icons/chevron-left.js";
import ChevronRight from "lucide-vue-next/dist/esm/icons/chevron-right.js";
import Group from "lucide-vue-next/dist/esm/icons/group.js";
import PanelsTopLeft from "lucide-vue-next/dist/esm/icons/panels-top-left.js";
import Play from "lucide-vue-next/dist/esm/icons/play.js";
import Plus from "lucide-vue-next/dist/esm/icons/plus.js";
import RotateCcw from "lucide-vue-next/dist/esm/icons/rotate-ccw.js";
import Save from "lucide-vue-next/dist/esm/icons/save.js";
import Search from "lucide-vue-next/dist/esm/icons/search.js";
import Trash2 from "lucide-vue-next/dist/esm/icons/trash-2.js";
import type { JsonValue, MessagePresentationRecord } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  appCollectionRecords,
  collectionCalendarDays,
  collectionCalendarFieldLabel,
  collectionCalendarMonthLabel,
  collectionCreateDraftValueForSpec,
  collectionCreateReadyForSpec,
  collectionCreateValidationMessageForSpec,
  collectionDateField,
  collectionEnumField,
  collectionEnumValues,
  collectionFieldInputType,
  collectionFieldInputValue,
  collectionFieldLabel,
  collectionFieldOptions,
  collectionFieldReadOnly,
  collectionFieldRequired,
  collectionFieldType,
  collectionFilterField,
  collectionFilterOptions,
  collectionFilterValue,
  collectionGalleryCard,
  collectionGroupFieldId,
  collectionGroupFields,
  collectionKanbanColumns,
  collectionLevelActions,
  collectionPresentationRecordCountLabel,
  collectionPresentationRendererLabel,
  collectionPresentationViewLabel,
  collectionRecordActions,
  collectionRecordFieldDisplay,
  collectionRecordSelected,
  collectionRecordSummary,
  collectionRecordTitle,
  collectionRefMissing,
  collectionRenderer,
  collectionRequiredReady,
  collectionRequiredValueMissing,
  collectionSearchQuery,
  collectionSelectedDateKey,
  collectionSelectedDateRecords,
  collectionSortDirection,
  collectionSortFieldId,
  collectionTableId,
  collectionTableEditableFields,
  collectionTableFields,
  collectionViewOptionLabel,
  collectionViewOptions,
  collectionVisibleEmptyMessage,
  collectionVisibleRecords,
  isActiveCollectionViewOption,
  type CollectionUiAction
} from "../lib/collection-view-state";

type CollectionRecordView = Record<string, unknown>;

type CollectionWorkspaceController = {
  switchCollectionView: (spec: SurfaceRenderSpec, option: Record<string, JsonValue>) => void | Promise<void>;
  refreshCollectionTableSurface: (spec: SurfaceRenderSpec) => void | Promise<void>;
  runCollectionSchemaAction: (spec: SurfaceRenderSpec, action: CollectionUiAction, record?: CollectionRecordView) => void | Promise<void>;
  setCollectionSearchQuery: (spec: SurfaceRenderSpec, search: string) => void | Promise<void>;
  setCollectionSortField: (spec: SurfaceRenderSpec, fieldId: string) => void | Promise<void>;
  toggleCollectionSortDirection: (spec: SurfaceRenderSpec) => void | Promise<void>;
  setCollectionFilterValue: (spec: SurfaceRenderSpec, value: string) => void | Promise<void>;
  setCollectionGroupField: (spec: SurfaceRenderSpec, fieldId: string) => void | Promise<void>;
  setCollectionNewDraftValue: (field: string, value: string) => void;
  addCollectionRecord: (spec: SurfaceRenderSpec) => void | Promise<void>;
  selectCollectionRecord: (spec: SurfaceRenderSpec, record: CollectionRecordView) => void | Promise<void>;
  collectionDraft: (record: CollectionRecordView) => Record<string, string>;
  setCollectionDraftValue: (record: CollectionRecordView, field: string, value: string) => void;
  saveCollectionRecord: (spec: SurfaceRenderSpec, record: CollectionRecordView) => void | Promise<void>;
  deleteCollectionRecordFromTable: (spec: SurfaceRenderSpec, record: CollectionRecordView) => void | Promise<void>;
  shiftCollectionCalendarMonth: (spec: SurfaceRenderSpec, offset: number) => void | Promise<void>;
  selectCollectionCalendarDate: (spec: SurfaceRenderSpec, date: string) => void | Promise<void>;
  beginCollectionKanbanDrag: (record: CollectionRecordView, event?: DragEvent) => void;
  dropCollectionKanbanRecord: (spec: SurfaceRenderSpec, value: string, event?: DragEvent) => void | Promise<void>;
};

const props = defineProps<{
  spec: SurfaceRenderSpec;
  saving: boolean;
  error: string | null;
  newDraft: Record<string, string>;
  controller: CollectionWorkspaceController;
  mode?: "workspace" | "card";
  presentation?: MessagePresentationRecord;
  openLabel?: string;
}>();

const emit = defineEmits<{
  open: [];
}>();

const c = props.controller;
</script>

<template>
  <button v-if="props.mode === 'card'" class="codex-artifact-card collection-card-entry" type="button" @click="emit('open')">
    <span class="codex-card-icon"><PanelsTopLeft :size="19" /></span>
    <span class="codex-card-main">
      <strong>{{ props.presentation?.title || props.spec.title || collectionTableId(props.spec) }}</strong>
      <small>{{ props.presentation?.subtitle || `${collectionTableId(props.spec)} ・ ${appCollectionRecords(props.spec).length}件` }}</small>
      <span v-if="props.presentation" class="codex-card-meta" :title="collectionPresentationViewLabel(props.presentation)">
        <span>{{ collectionPresentationRendererLabel(props.presentation) }}</span>
        <span v-if="collectionPresentationRecordCountLabel(props.presentation)">{{ collectionPresentationRecordCountLabel(props.presentation) }}</span>
      </span>
    </span>
    <em>{{ props.openLabel || "Open" }}</em>
  </button>

  <div v-else class="collection-table-app">
    <div v-if="props.error" class="provider-notice is-inline">
      <div class="provider-notice-main">
        <strong>Collectionを更新できません</strong>
        <span>{{ props.error }}</span>
      </div>
    </div>
    <div class="collection-table-toolbar">
      <div v-if="collectionViewOptions(props.spec).length > 1" class="collection-view-switch" role="tablist" aria-label="Collection view">
        <button
          v-for="option in collectionViewOptions(props.spec)"
          :key="String(option.id)"
          type="button"
          :class="{ 'is-active': isActiveCollectionViewOption(props.spec, option) }"
          :disabled="props.saving"
          @click="c.switchCollectionView(props.spec, option)"
        >
          {{ collectionViewOptionLabel(option) }}
        </button>
      </div>
      <div class="task-counts">
        <span>{{ collectionVisibleRecords(props.spec).length }} / {{ appCollectionRecords(props.spec).length }}件</span>
        <span>{{ collectionTableId(props.spec) }}</span>
      </div>
      <button class="surface-row-save" type="button" :disabled="props.saving" @click="c.refreshCollectionTableSurface(props.spec)">
        <RotateCcw :size="13" />
      </button>
    </div>
    <div v-if="collectionLevelActions(props.spec).length > 0" class="collection-action-bar">
      <button
        v-for="action in collectionLevelActions(props.spec)"
        :key="action.id"
        class="surface-row-save collection-action-button"
        type="button"
        :title="action.description || action.label"
        :disabled="props.saving"
        @click="c.runCollectionSchemaAction(props.spec, action)"
      >
        <Play :size="13" />
        <span>{{ action.label }}</span>
      </button>
    </div>
    <div class="collection-controls">
      <label class="collection-search-control">
        <Search :size="13" />
        <input
          :value="collectionSearchQuery(props.spec)"
          type="search"
          placeholder="検索"
          @input="c.setCollectionSearchQuery(props.spec, ($event.target as HTMLInputElement).value)"
        />
      </label>
      <select :value="collectionSortFieldId(props.spec)" :disabled="props.saving" @change="c.setCollectionSortField(props.spec, ($event.target as HTMLSelectElement).value)">
        <option value="">並び替えなし</option>
        <option v-for="field in collectionTableFields(props.spec)" :key="String(field.id)" :value="String(field.id)">{{ collectionFieldLabel(field) }}</option>
      </select>
      <button class="surface-row-save" type="button" :disabled="props.saving || !collectionSortFieldId(props.spec)" @click="c.toggleCollectionSortDirection(props.spec)">
        <ArrowDown v-if="collectionSortDirection(props.spec) === 'desc'" :size="13" />
        <ArrowUp v-else :size="13" />
      </button>
      <select v-if="collectionFilterField(props.spec)" :value="collectionFilterValue(props.spec)" :disabled="props.saving" @change="c.setCollectionFilterValue(props.spec, ($event.target as HTMLSelectElement).value)">
        <option value="">すべて</option>
        <option v-for="value in collectionFilterOptions(props.spec)" :key="value" :value="value">{{ value }}</option>
      </select>
      <label v-if="collectionGroupFields(props.spec).length > 0" class="collection-group-control">
        <Group :size="13" />
        <select :value="collectionGroupFieldId(props.spec)" :disabled="props.saving" @change="c.setCollectionGroupField(props.spec, ($event.target as HTMLSelectElement).value)">
          <option value="">グループなし</option>
          <option v-for="field in collectionGroupFields(props.spec)" :key="String(field.id)" :value="String(field.id)">{{ collectionFieldLabel(field) }}</option>
        </select>
      </label>
    </div>
    <div v-if="collectionRenderer(props.spec) !== 'collection_table' && collectionRenderer(props.spec) !== 'calendar_view'" class="collection-new-panel">
      <label v-for="field in collectionTableEditableFields(props.spec)" :key="String(field.id)" :class="{ 'is-required': collectionFieldRequired(field) }">
        <span>{{ collectionFieldLabel(field) }}<small v-if="collectionFieldRequired(field)">必須</small></span>
        <select v-if="collectionFieldType(field) === 'ref'" :value="props.newDraft[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLSelectElement).value)">
          <option value=""></option>
          <option v-for="option in collectionFieldOptions(field)" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <select v-else-if="collectionFieldType(field) === 'enum'" :value="props.newDraft[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLSelectElement).value)">
          <option value=""></option>
          <option v-for="value in collectionEnumValues(field)" :key="value" :value="value">{{ value }}</option>
        </select>
        <input v-else-if="collectionFieldType(field) === 'boolean'" type="checkbox" :checked="props.newDraft[String(field.id)] === 'true'" :disabled="props.saving" @change="c.setCollectionNewDraftValue(String(field.id), String(($event.target as HTMLInputElement).checked))" />
        <textarea v-else-if="collectionFieldType(field) === 'text'" :value="props.newDraft[String(field.id)] ?? ''" :disabled="props.saving" rows="2" @input="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLTextAreaElement).value)"></textarea>
        <input v-else :value="collectionFieldInputValue(field, props.newDraft[String(field.id)])" :disabled="props.saving" :type="collectionFieldInputType(field)" @input="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLInputElement).value)" />
      </label>
      <span v-if="collectionCreateValidationMessageForSpec(props.spec, props.newDraft)" class="collection-validation-note">{{ collectionCreateValidationMessageForSpec(props.spec, props.newDraft) }}</span>
      <button class="surface-submit" type="button" :disabled="props.saving || !collectionCreateReadyForSpec(props.spec, props.newDraft)" @click="c.addCollectionRecord(props.spec)">
        <Plus :size="13" />
      </button>
    </div>
    <div v-if="collectionRenderer(props.spec) === 'collection_table'" class="surface-table-wrap">
      <table class="surface-table collection-table">
        <thead>
          <tr>
            <th v-for="field in collectionTableFields(props.spec)" :key="String(field.id)">
              {{ collectionFieldLabel(field) }}<span v-if="collectionFieldRequired(field)" class="collection-required-mark">必須</span>
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr class="collection-new-row">
            <td v-for="field in collectionTableFields(props.spec)" :key="String(field.id)">
              <span v-if="collectionFieldReadOnly(field)" class="collection-readonly-value">-</span>
              <select v-else-if="collectionFieldType(field) === 'ref'" :value="props.newDraft[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLSelectElement).value)">
                <option value=""></option>
                <option v-for="option in collectionFieldOptions(field)" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <select v-else-if="collectionFieldType(field) === 'enum'" :value="props.newDraft[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLSelectElement).value)">
                <option value=""></option>
                <option v-for="value in collectionEnumValues(field)" :key="value" :value="value">{{ value }}</option>
              </select>
              <input v-else-if="collectionFieldType(field) === 'boolean'" type="checkbox" :checked="props.newDraft[String(field.id)] === 'true'" :disabled="props.saving" @change="c.setCollectionNewDraftValue(String(field.id), String(($event.target as HTMLInputElement).checked))" />
              <textarea v-else-if="collectionFieldType(field) === 'text'" :value="props.newDraft[String(field.id)] ?? ''" :disabled="props.saving" rows="2" @input="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLTextAreaElement).value)"></textarea>
              <input v-else :value="collectionFieldInputValue(field, props.newDraft[String(field.id)])" :disabled="props.saving" :type="collectionFieldInputType(field)" @input="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLInputElement).value)" />
              <span v-if="collectionFieldRequired(field) && collectionRequiredValueMissing(field, props.newDraft[String(field.id)])" class="collection-validation-note">必須</span>
            </td>
            <td>
              <button class="surface-row-save" type="button" :disabled="props.saving || !collectionCreateReadyForSpec(props.spec, props.newDraft)" @click="c.addCollectionRecord(props.spec)">
                <Plus :size="13" />
              </button>
            </td>
          </tr>
          <tr v-for="record in collectionVisibleRecords(props.spec)" :key="String(record.id)" :class="{ 'is-selected': collectionRecordSelected(props.spec, record) }" @click="c.selectCollectionRecord(props.spec, record)" @focusin="c.selectCollectionRecord(props.spec, record)">
            <td v-for="field in collectionTableFields(props.spec)" :key="String(field.id)">
              <span v-if="collectionFieldReadOnly(field)" class="collection-readonly-value">{{ collectionRecordFieldDisplay(record, field) }}</span>
              <select v-else-if="collectionFieldType(field) === 'ref'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLSelectElement).value)">
                <option value=""></option>
                <option v-for="option in collectionFieldOptions(field)" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <select v-else-if="collectionFieldType(field) === 'enum'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLSelectElement).value)">
                <option value=""></option>
                <option v-for="value in collectionEnumValues(field)" :key="value" :value="value">{{ value }}</option>
              </select>
              <input v-else-if="collectionFieldType(field) === 'boolean'" type="checkbox" :checked="c.collectionDraft(record)[String(field.id)] === 'true'" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), String(($event.target as HTMLInputElement).checked))" />
              <textarea v-else-if="collectionFieldType(field) === 'text'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" rows="2" @input="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLTextAreaElement).value)"></textarea>
              <input v-else :value="collectionFieldInputValue(field, c.collectionDraft(record)[String(field.id)])" :disabled="props.saving" :type="collectionFieldInputType(field)" @input="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLInputElement).value)" />
              <span v-if="collectionFieldRequired(field) && collectionRequiredValueMissing(field, c.collectionDraft(record)[String(field.id)])" class="collection-validation-note">必須</span>
              <span v-if="collectionRefMissing(record, field)" class="collection-ref-warning">参照先なし</span>
            </td>
            <td class="collection-row-actions">
              <button
                v-for="action in collectionRecordActions(props.spec)"
                :key="action.id"
                class="surface-row-save collection-action-button"
                type="button"
                :title="action.description || action.label"
                :disabled="props.saving"
                @click="c.runCollectionSchemaAction(props.spec, action, record)"
              >
                <Play :size="13" />
                <span>{{ action.label }}</span>
              </button>
              <button class="surface-row-save" type="button" :disabled="props.saving || !collectionRequiredReady(props.spec, c.collectionDraft(record))" @click="c.saveCollectionRecord(props.spec, record)">
                <Save :size="13" />
              </button>
              <button class="surface-row-save" type="button" :disabled="props.saving" @click="c.deleteCollectionRecordFromTable(props.spec, record)">
                <Trash2 :size="13" />
              </button>
            </td>
          </tr>
          <tr v-if="collectionVisibleRecords(props.spec).length === 0">
            <td :colspan="collectionTableFields(props.spec).length + 1">
              <div class="collection-empty-state">{{ collectionVisibleEmptyMessage(props.spec) }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="collectionRenderer(props.spec) === 'collection_gallery'" class="collection-gallery-grid">
      <div v-if="collectionVisibleRecords(props.spec).length === 0" class="collection-empty-state">{{ collectionVisibleEmptyMessage(props.spec) }}</div>
      <article v-for="record in collectionVisibleRecords(props.spec)" :key="String(record.id)" class="collection-gallery-card" :class="{ 'is-selected': collectionRecordSelected(props.spec, record) }" @click="c.selectCollectionRecord(props.spec, record)" @focusin="c.selectCollectionRecord(props.spec, record)">
        <div class="collection-card-head">
          <strong>{{ collectionGalleryCard(props.spec, record).title }}</strong>
          <small>{{ collectionGalleryCard(props.spec, record).subtitle }}</small>
        </div>
        <div v-if="collectionGalleryCard(props.spec, record).highlights.length > 0" class="collection-gallery-highlights">
          <span
            v-for="highlight in collectionGalleryCard(props.spec, record).highlights"
            :key="highlight.field_id"
            class="collection-gallery-chip"
            :class="`is-${highlight.kind}`"
          >
            <small>{{ highlight.label }}</small>
            {{ highlight.value }}
          </span>
        </div>
        <p v-if="collectionGalleryCard(props.spec, record).summary">{{ collectionGalleryCard(props.spec, record).summary }}</p>
        <div class="collection-card-fields">
          <label v-for="field in collectionTableFields(props.spec)" :key="String(field.id)" :class="{ 'is-readonly': collectionFieldReadOnly(field), 'is-required': collectionFieldRequired(field) }">
            <span>{{ collectionFieldLabel(field) }}<small v-if="collectionFieldRequired(field)">必須</small></span>
            <span v-if="collectionFieldReadOnly(field)" class="collection-readonly-value">{{ collectionRecordFieldDisplay(record, field) }}</span>
            <select v-else-if="collectionFieldType(field) === 'ref'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLSelectElement).value)">
              <option value=""></option>
              <option v-for="option in collectionFieldOptions(field)" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <select v-else-if="collectionFieldType(field) === 'enum'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLSelectElement).value)">
              <option value=""></option>
              <option v-for="value in collectionEnumValues(field)" :key="value" :value="value">{{ value }}</option>
            </select>
            <input v-else-if="collectionFieldType(field) === 'boolean'" type="checkbox" :checked="c.collectionDraft(record)[String(field.id)] === 'true'" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), String(($event.target as HTMLInputElement).checked))" />
            <textarea v-else-if="collectionFieldType(field) === 'text'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" rows="2" @input="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLTextAreaElement).value)"></textarea>
            <input v-else :value="collectionFieldInputValue(field, c.collectionDraft(record)[String(field.id)])" :disabled="props.saving" :type="collectionFieldInputType(field)" @input="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLInputElement).value)" />
            <span v-if="collectionFieldRequired(field) && collectionRequiredValueMissing(field, c.collectionDraft(record)[String(field.id)])" class="collection-validation-note">必須</span>
            <span v-if="collectionRefMissing(record, field)" class="collection-ref-warning">参照先なし</span>
          </label>
        </div>
        <div class="collection-card-actions">
          <button
            v-for="action in collectionRecordActions(props.spec)"
            :key="action.id"
            class="surface-row-save collection-action-button"
            type="button"
            :title="action.description || action.label"
            :disabled="props.saving"
            @click="c.runCollectionSchemaAction(props.spec, action, record)"
          >
            <Play :size="13" />
            <span>{{ action.label }}</span>
          </button>
          <button class="surface-row-save" type="button" :disabled="props.saving || !collectionRequiredReady(props.spec, c.collectionDraft(record))" @click="c.saveCollectionRecord(props.spec, record)">
            <Save :size="13" />
          </button>
          <button class="surface-row-save" type="button" :disabled="props.saving" @click="c.deleteCollectionRecordFromTable(props.spec, record)">
            <Trash2 :size="13" />
          </button>
        </div>
      </article>
    </div>
    <div v-else-if="collectionRenderer(props.spec) === 'calendar_view'" class="collection-calendar-app">
      <div v-if="!collectionDateField(props.spec)" class="empty-note">日付fieldがないためtableに戻してください</div>
      <template v-else>
        <div class="collection-calendar-head">
          <div class="collection-calendar-title">
            <strong>{{ collectionCalendarMonthLabel(props.spec) }}</strong>
            <span>{{ collectionCalendarFieldLabel(props.spec) }}</span>
          </div>
          <div class="collection-calendar-nav" aria-label="カレンダー月">
            <button type="button" title="前月" aria-label="前月" :disabled="props.saving" @click="c.shiftCollectionCalendarMonth(props.spec, -1)">
              <ChevronLeft :size="14" />
            </button>
            <button type="button" title="翌月" aria-label="翌月" :disabled="props.saving" @click="c.shiftCollectionCalendarMonth(props.spec, 1)">
              <ChevronRight :size="14" />
            </button>
          </div>
        </div>
        <div class="collection-calendar-grid">
          <button
            v-for="day in collectionCalendarDays(props.spec)"
            :key="day.key"
            class="collection-calendar-day"
            :class="{ 'is-outside': !day.inMonth, 'is-selected': day.selected, 'is-today': day.today }"
            type="button"
            @click="c.selectCollectionCalendarDate(props.spec, day.date)"
          >
            <span>{{ day.day }}</span>
            <small v-if="day.records.length">{{ day.records.length }}</small>
          </button>
        </div>
        <div class="collection-calendar-create">
          <div class="collection-calendar-create-head">
            <strong>{{ collectionSelectedDateKey(props.spec) }}</strong>
            <span>{{ collectionCalendarFieldLabel(props.spec) }}</span>
          </div>
          <div class="collection-new-panel">
            <label v-for="field in collectionTableEditableFields(props.spec)" :key="String(field.id)" :class="{ 'is-required': collectionFieldRequired(field) }">
              <span>{{ collectionFieldLabel(field) }}<small v-if="collectionFieldRequired(field)">必須</small></span>
              <select v-if="collectionFieldType(field) === 'ref'" :value="collectionCreateDraftValueForSpec(props.spec, field, props.newDraft)" :disabled="props.saving" @change="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLSelectElement).value)">
                <option value=""></option>
                <option v-for="option in collectionFieldOptions(field)" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <select v-else-if="collectionFieldType(field) === 'enum'" :value="collectionCreateDraftValueForSpec(props.spec, field, props.newDraft)" :disabled="props.saving" @change="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLSelectElement).value)">
                <option value=""></option>
                <option v-for="value in collectionEnumValues(field)" :key="value" :value="value">{{ value }}</option>
              </select>
              <input v-else-if="collectionFieldType(field) === 'boolean'" type="checkbox" :checked="collectionCreateDraftValueForSpec(props.spec, field, props.newDraft) === 'true'" :disabled="props.saving" @change="c.setCollectionNewDraftValue(String(field.id), String(($event.target as HTMLInputElement).checked))" />
              <textarea v-else-if="collectionFieldType(field) === 'text'" :value="collectionCreateDraftValueForSpec(props.spec, field, props.newDraft)" :disabled="props.saving" rows="2" @input="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLTextAreaElement).value)"></textarea>
              <input v-else :value="collectionFieldInputValue(field, collectionCreateDraftValueForSpec(props.spec, field, props.newDraft))" :disabled="props.saving" :type="collectionFieldInputType(field)" @input="c.setCollectionNewDraftValue(String(field.id), ($event.target as HTMLInputElement).value)" />
            </label>
            <span v-if="collectionCreateValidationMessageForSpec(props.spec, props.newDraft)" class="collection-validation-note">{{ collectionCreateValidationMessageForSpec(props.spec, props.newDraft) }}</span>
            <button class="surface-submit" type="button" :disabled="props.saving || !collectionCreateReadyForSpec(props.spec, props.newDraft)" @click="c.addCollectionRecord(props.spec)">
              <Plus :size="13" />
            </button>
          </div>
        </div>
        <div class="collection-date-list">
          <article v-for="record in collectionSelectedDateRecords(props.spec)" :key="String(record.id)" class="collection-date-record" :class="{ 'is-selected': collectionRecordSelected(props.spec, record) }" @click="c.selectCollectionRecord(props.spec, record)" @focusin="c.selectCollectionRecord(props.spec, record)">
            <div class="collection-card-head">
              <strong>{{ collectionRecordTitle(props.spec, record) }}</strong>
              <small>{{ collectionRecordSummary(props.spec, record) || String(record.id ?? '') }}</small>
            </div>
            <div class="collection-card-fields">
              <label v-for="field in collectionTableFields(props.spec)" :key="String(field.id)" :class="{ 'is-readonly': collectionFieldReadOnly(field), 'is-required': collectionFieldRequired(field) }">
                <span>{{ collectionFieldLabel(field) }}<small v-if="collectionFieldRequired(field)">必須</small></span>
                <span v-if="collectionFieldReadOnly(field)" class="collection-readonly-value">{{ collectionRecordFieldDisplay(record, field) }}</span>
                <select v-else-if="collectionFieldType(field) === 'ref'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLSelectElement).value)">
                  <option value=""></option>
                  <option v-for="option in collectionFieldOptions(field)" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <select v-else-if="collectionFieldType(field) === 'enum'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLSelectElement).value)">
                  <option value=""></option>
                  <option v-for="value in collectionEnumValues(field)" :key="value" :value="value">{{ value }}</option>
                </select>
                <input v-else-if="collectionFieldType(field) === 'boolean'" type="checkbox" :checked="c.collectionDraft(record)[String(field.id)] === 'true'" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), String(($event.target as HTMLInputElement).checked))" />
                <textarea v-else-if="collectionFieldType(field) === 'text'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" rows="2" @input="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLTextAreaElement).value)"></textarea>
                <input v-else :value="collectionFieldInputValue(field, c.collectionDraft(record)[String(field.id)])" :disabled="props.saving" :type="collectionFieldInputType(field)" @input="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLInputElement).value)" />
                <span v-if="collectionFieldRequired(field) && collectionRequiredValueMissing(field, c.collectionDraft(record)[String(field.id)])" class="collection-validation-note">必須</span>
                <span v-if="collectionRefMissing(record, field)" class="collection-ref-warning">参照先なし</span>
              </label>
            </div>
            <div class="collection-card-actions">
              <button
                v-for="action in collectionRecordActions(props.spec)"
                :key="action.id"
                class="surface-row-save collection-action-button"
                type="button"
                :title="action.description || action.label"
                :disabled="props.saving"
                @click="c.runCollectionSchemaAction(props.spec, action, record)"
              >
                <Play :size="13" />
                <span>{{ action.label }}</span>
              </button>
              <button class="surface-row-save" type="button" :disabled="props.saving || !collectionRequiredReady(props.spec, c.collectionDraft(record))" @click="c.saveCollectionRecord(props.spec, record)">
                <Save :size="13" />
              </button>
              <button class="surface-row-save" type="button" :disabled="props.saving" @click="c.deleteCollectionRecordFromTable(props.spec, record)">
                <Trash2 :size="13" />
              </button>
            </div>
          </article>
          <div v-if="collectionSelectedDateRecords(props.spec).length === 0" class="collection-empty-state">この日のレコードはありません</div>
        </div>
      </template>
    </div>
    <div v-else-if="collectionRenderer(props.spec) === 'collection_kanban'" class="collection-kanban-board">
      <div v-if="!collectionEnumField(props.spec)" class="empty-note">enum/status fieldがないためtableに戻してください</div>
      <template v-else>
        <div v-if="collectionVisibleRecords(props.spec).length === 0" class="collection-empty-state">{{ collectionVisibleEmptyMessage(props.spec) }}</div>
        <section
          v-for="column in collectionKanbanColumns(props.spec)"
          :key="column.value"
          class="collection-kanban-column"
          @dragover.prevent
          @drop="c.dropCollectionKanbanRecord(props.spec, column.value, $event)"
        >
          <h3>{{ column.value }} <span>{{ column.records.length }}</span></h3>
          <article
            v-for="record in column.records"
            :key="String(record.id)"
            class="collection-kanban-card"
            :class="{ 'is-selected': collectionRecordSelected(props.spec, record) }"
            @click="c.selectCollectionRecord(props.spec, record)"
            @focusin="c.selectCollectionRecord(props.spec, record)"
          >
            <div class="collection-card-head collection-kanban-drag-handle" draggable="true" @dragstart="c.beginCollectionKanbanDrag(record, $event)">
              <strong>{{ collectionRecordTitle(props.spec, record) }}</strong>
              <small>{{ collectionRecordSummary(props.spec, record) || String(record.id ?? '') }}</small>
            </div>
            <div class="collection-card-fields">
              <label v-for="field in collectionTableFields(props.spec)" :key="String(field.id)" :class="{ 'is-readonly': collectionFieldReadOnly(field), 'is-required': collectionFieldRequired(field) }">
                <span>{{ collectionFieldLabel(field) }}<small v-if="collectionFieldRequired(field)">必須</small></span>
                <span v-if="collectionFieldReadOnly(field)" class="collection-readonly-value">{{ collectionRecordFieldDisplay(record, field) }}</span>
                <select v-else-if="collectionFieldType(field) === 'ref'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLSelectElement).value)">
                  <option value=""></option>
                  <option v-for="option in collectionFieldOptions(field)" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <select v-else-if="collectionFieldType(field) === 'enum'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLSelectElement).value)">
                  <option value=""></option>
                  <option v-for="value in collectionEnumValues(field)" :key="value" :value="value">{{ value }}</option>
                </select>
                <input v-else-if="collectionFieldType(field) === 'boolean'" type="checkbox" :checked="c.collectionDraft(record)[String(field.id)] === 'true'" :disabled="props.saving" @change="c.setCollectionDraftValue(record, String(field.id), String(($event.target as HTMLInputElement).checked))" />
                <textarea v-else-if="collectionFieldType(field) === 'text'" :value="c.collectionDraft(record)[String(field.id)] ?? ''" :disabled="props.saving" rows="2" @input="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLTextAreaElement).value)"></textarea>
                <input v-else :value="collectionFieldInputValue(field, c.collectionDraft(record)[String(field.id)])" :disabled="props.saving" :type="collectionFieldInputType(field)" @input="c.setCollectionDraftValue(record, String(field.id), ($event.target as HTMLInputElement).value)" />
                <span v-if="collectionFieldRequired(field) && collectionRequiredValueMissing(field, c.collectionDraft(record)[String(field.id)])" class="collection-validation-note">必須</span>
                <span v-if="collectionRefMissing(record, field)" class="collection-ref-warning">参照先なし</span>
              </label>
            </div>
            <div class="collection-card-actions">
              <button
                v-for="action in collectionRecordActions(props.spec)"
                :key="action.id"
                class="surface-row-save collection-action-button"
                type="button"
                :title="action.description || action.label"
                :disabled="props.saving"
                @click="c.runCollectionSchemaAction(props.spec, action, record)"
              >
                <Play :size="13" />
                <span>{{ action.label }}</span>
              </button>
              <button class="surface-row-save" type="button" :disabled="props.saving || !collectionRequiredReady(props.spec, c.collectionDraft(record))" @click="c.saveCollectionRecord(props.spec, record)">
                <Save :size="13" />
              </button>
              <button class="surface-row-save" type="button" :disabled="props.saving" @click="c.deleteCollectionRecordFromTable(props.spec, record)">
                <Trash2 :size="13" />
              </button>
            </div>
          </article>
        </section>
      </template>
    </div>
  </div>
</template>
