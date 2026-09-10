import { useId, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import type { JsonValue } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  appCollectionRecords,
  collectionCreateReadyForSpec,
  collectionCreateValidationMessageForSpec,
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
  collectionLevelActions,
  collectionRecordActions,
  collectionRecordFieldDisplay,
  collectionRecordSelected,
  collectionRefMissing,
  collectionRequiredReady,
  collectionRequiredValueMissing,
  collectionSearchQuery,
  collectionSortDirection,
  collectionSortFieldId,
  collectionTableFields,
  collectionTableId,
  collectionTableEditableFields,
  collectionValidationMessage,
  collectionVisibleEmptyMessage,
  collectionVisibleRecords,
  collectionRenderer,
  type CollectionUiAction
} from "../lib/collection-view-state";

export type NativeCollectionRecord = Record<string, JsonValue>;
export type NativeCollectionControllerResult = void | Promise<void>;

/**
 * The surface owns presentation only. Reads and every domain mutation are
 * supplied by the active React controller so this component cannot pretend to
 * have saved a record or execute a server action by itself.
 */
export interface NativeCollectionSurfaceController {
  refreshCollectionTableSurface: (spec: SurfaceRenderSpec) => NativeCollectionControllerResult;
  runCollectionSchemaAction: (spec: SurfaceRenderSpec, action: CollectionUiAction, record?: NativeCollectionRecord) => NativeCollectionControllerResult;
  setCollectionSearchQuery: (spec: SurfaceRenderSpec, search: string) => NativeCollectionControllerResult;
  setCollectionSortField: (spec: SurfaceRenderSpec, fieldId: string) => NativeCollectionControllerResult;
  toggleCollectionSortDirection: (spec: SurfaceRenderSpec) => NativeCollectionControllerResult;
  setCollectionFilterValue: (spec: SurfaceRenderSpec, value: string) => NativeCollectionControllerResult;
  setCollectionNewDraftValue: (field: string, value: string) => void;
  addCollectionRecord: (spec: SurfaceRenderSpec) => NativeCollectionControllerResult;
  selectCollectionRecord: (spec: SurfaceRenderSpec, record: NativeCollectionRecord) => NativeCollectionControllerResult;
  collectionDraft: (record: NativeCollectionRecord) => Record<string, string>;
  setCollectionDraftValue: (record: NativeCollectionRecord, field: string, value: string) => void;
  saveCollectionRecord: (spec: SurfaceRenderSpec, record: NativeCollectionRecord) => NativeCollectionControllerResult;
  deleteCollectionRecordFromTable: (spec: SurfaceRenderSpec, record: NativeCollectionRecord) => NativeCollectionControllerResult;
  discardCollectionDraft?: (spec: SurfaceRenderSpec, record: NativeCollectionRecord) => void;
  discardCollectionNewDraft?: (spec: SurfaceRenderSpec) => void;
}

export interface NativeCollectionSurfaceProps {
  spec: SurfaceRenderSpec;
  controller: NativeCollectionSurfaceController;
  /** Read access still permits local search/sort/filter, but not writes. */
  canEdit?: boolean;
  /** Declared Collection actions require the Room's execute capability. */
  canExecute?: boolean;
  /** Draft state is controlled by the caller and must survive failed writes. */
  newDraft?: Record<string, string>;
  saving?: boolean;
  error?: string | null;
  /** Optional server-provided conflict detail, kept separate from transport errors. */
  conflict?: string | null;
}

type CollectionField = Record<string, JsonValue>;
type FieldEditorChange = (value: string) => void;

export function NativeCollectionSurface({
  spec,
  controller,
  canEdit = true,
  canExecute = true,
  newDraft = {},
  saving = false,
  error = null,
  conflict = null
}: NativeCollectionSurfaceProps) {
  const rawId = useId();
  const surfaceId = rawId.replace(/[^a-zA-Z0-9_-]/g, "") || "collection-surface";
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const renderer = collectionRenderer(spec);
  const fields = collectionTableFields(spec);
  const editableFields = collectionTableEditableFields(spec);
  const records = appCollectionRecords(spec).map(nativeCollectionRecordFromValue).filter(isNativeCollectionRecord);
  const visibleRecords = collectionVisibleRecords(spec).map(nativeCollectionRecordFromValue).filter(isNativeCollectionRecord);
  const collectionId = collectionTableId(spec);
  const title = spec.title?.trim() || collectionId || "Collection";
  const busy = saving || pendingOperation !== null;
  const draftInputDisabled = !canEdit || (
    pendingOperation !== null
      && pendingOperation !== "create"
      && !pendingOperation.startsWith("save:")
  );
  const externalError = typeof error === "string" && error.trim() ? error.trim() : null;
  const localIssue = localError?.trim() || null;
  const explicitConflict = typeof conflict === "string" && conflict.trim() ? conflict.trim() : null;
  const issue = externalError ?? localIssue;
  const conflictMessage = explicitConflict;
  const failureMessage = issue && issue !== conflictMessage ? issue : null;
  const specError = spec.errors?.find((item) => item.message.trim())?.message.trim() ?? null;
  const unsupportedRenderer = renderer !== "collection_table";

  const runControllerOperation = (
    operation: () => NativeCollectionControllerResult,
    fallback: string
  ): void => {
    void (async () => {
      try {
        await operation();
      } catch (cause) {
        setLocalError(errorMessage(cause, fallback));
      }
    })();
  };

  const runMutation = (
    operationId: string,
    operation: () => NativeCollectionControllerResult,
    fallback: string
  ): void => {
    if (busy) return;
    setPendingOperation(operationId);
    setLocalError(null);
    void (async () => {
      try {
        await operation();
      } catch (cause) {
        // Do not clear a draft here. A rejected Controller call is not a
        // successful write and its input remains the user's recoverable draft.
        setLocalError(errorMessage(cause, fallback));
      } finally {
        setPendingOperation((current) => current === operationId ? null : current);
      }
    })();
  };

  const selectRecord = (record: NativeCollectionRecord): void => {
    runControllerOperation(
      () => controller.selectCollectionRecord(spec, record),
      "レコードを選択できませんでした。"
    );
  };

  const setSearch = (value: string): void => {
    runControllerOperation(
      () => controller.setCollectionSearchQuery(spec, value),
      "検索条件を保存できませんでした。"
    );
  };

  const setSortField = (value: string): void => {
    runControllerOperation(
      () => controller.setCollectionSortField(spec, value),
      "並び替えを変更できませんでした。"
    );
  };

  const toggleSortDirection = (): void => {
    runControllerOperation(
      () => controller.toggleCollectionSortDirection(spec),
      "並び替えの向きを変更できませんでした。"
    );
  };

  const setFilter = (value: string): void => {
    runControllerOperation(
      () => controller.setCollectionFilterValue(spec, value),
      "フィルターを変更できませんでした。"
    );
  };

  const setNewDraft = (field: string, value: string): void => {
    try {
      controller.setCollectionNewDraftValue(field, value);
    } catch (cause) {
      setLocalError(errorMessage(cause, "入力を保持できませんでした。"));
    }
  };

  const recordDraft = (record: NativeCollectionRecord): Record<string, string> => {
    const fallback = Object.fromEntries(editableFields.map((field) => {
      const fieldId = String(field.id ?? field.name ?? "");
      return [fieldId, collectionFieldInputValue(field, record[fieldId])];
    }));
    const controlled = controller.collectionDraft(record);
    return { ...fallback, ...(controlled ?? {}) };
  };

  const setRecordDraft = (record: NativeCollectionRecord, field: string, value: string): void => {
    try {
      controller.setCollectionDraftValue(record, field, value);
    } catch (cause) {
      setLocalError(errorMessage(cause, "入力を保持できませんでした。"));
    }
  };

  const submitCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canEdit) {
      setLocalError("このRoomではCollectionを編集できません。");
      return;
    }
    if (!collectionCreateReadyForSpec(spec, newDraft)) return;
    runMutation(
      "create",
      () => controller.addCollectionRecord(spec),
      "レコードを追加できませんでした。"
    );
  };

  const saveRecord = (record: NativeCollectionRecord, draft: Record<string, string>): void => {
    if (!canEdit) {
      setLocalError("このRoomではCollectionを編集できません。");
      return;
    }
    const recordId = recordIdFor(record);
    if (!recordId || !collectionRequiredReady(spec, draft)) {
      setLocalError(collectionValidationMessage(spec, draft));
      return;
    }
    runMutation(
      `save:${recordId}`,
      () => controller.saveCollectionRecord(spec, record),
      "レコードを保存できませんでした。"
    );
  };

  const deleteRecord = (record: NativeCollectionRecord): void => {
    if (!canEdit) {
      setLocalError("このRoomではCollectionを編集できません。");
      return;
    }
    const recordId = recordIdFor(record);
    if (!recordId) return;
    runMutation(
      `delete:${recordId}`,
      () => controller.deleteCollectionRecordFromTable(spec, record),
      "レコードを削除できませんでした。"
    );
  };

  const runAction = (action: CollectionUiAction, record?: NativeCollectionRecord): void => {
    if (!canExecute) {
      setLocalError("このRoomではCollectionの操作を実行できません。");
      return;
    }
    const recordId = record ? recordIdFor(record) : "";
    if (action.scope === "record" && !recordId) return;
    runMutation(
      `action:${action.id}:${recordId || "collection"}`,
      () => controller.runCollectionSchemaAction(spec, action, record),
      "Collectionの操作を実行できませんでした。"
    );
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, record: NativeCollectionRecord): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectRecord(record);
  };

  const failureDescriptionId = `${surfaceId}-failure`;
  const conflictDescriptionId = `${surfaceId}-conflict`;
  const createValidationId = `${surfaceId}-create-validation`;
  const createValidation = collectionCreateValidationMessageForSpec(spec, newDraft);
  const filterField = collectionFilterField(spec);
  const filterOptions = collectionFilterOptions(spec);
  const levelActions = collectionLevelActions(spec);
  const createDescribedBy = [
    createValidation ? createValidationId : null,
    failureMessage ? failureDescriptionId : null,
    conflictMessage ? conflictDescriptionId : null
  ].filter((value): value is string => Boolean(value)).join(" ") || undefined;

  return (
    <section
      className="native-collection-surface"
      aria-labelledby={`${surfaceId}-title`}
      aria-busy={busy}
    >
      <CollectionSurfaceStyles />
      <header className="native-collection-surface__header">
        <div>
          <p className="native-collection-surface__eyebrow">Collection / Table</p>
          <h1 id={`${surfaceId}-title`}>{title}</h1>
          <p className="native-collection-surface__context">
            {collectionId ? `Collection ${collectionId} の認可済みレコード` : "認可済みのCollectionレコード"}
          </p>
        </div>
        <button
          type="button"
          className="native-collection-surface__secondary"
          onClick={() => runMutation("refresh", () => controller.refreshCollectionTableSurface(spec), "Collectionを再読込できませんでした。")}
          disabled={busy}
          aria-label="Collectionを再読込"
        >
          再読込
        </button>
      </header>

      {specError ? <p className="native-collection-surface__error" role="alert">{specError}</p> : null}
      {failureMessage ? (
        <p id={failureDescriptionId} className="native-collection-surface__error" role="alert">
          Collectionを更新できませんでした。{failureMessage} 入力中の下書きは保持されています。
        </p>
      ) : null}
      {conflictMessage ? (
        <p id={conflictDescriptionId} className="native-collection-surface__conflict" role="alert">
          保存が競合しました。{conflictMessage} 下書きを保持しています。最新版を確認してから再試行してください。
        </p>
      ) : null}
      {busy ? (
        <p className="native-collection-surface__status" role="status" aria-live="polite">
          保存中… 入力中の下書きを保持しています。
        </p>
      ) : null}

      {unsupportedRenderer ? (
        <div className="native-collection-surface__unsupported" role="status">
          <strong>このCollectionは表形式で開けません</strong>
          <p>現在のSurface定義に対応する表表示がありません。専用の別レイアウトはこの画面では復活させません。</p>
        </div>
      ) : (
        <>
          <div className="native-collection-surface__summary" aria-live="polite">
            <span>{visibleRecords.length} / {records.length}件</span>
            <span>{collectionId || "Collection"}</span>
          </div>

          {levelActions.length > 0 ? (
            <div className="native-collection-surface__actions" role="group" aria-label="Collectionの宣言済み操作">
              {levelActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="native-collection-surface__action"
                  onClick={() => runAction(action)}
                  disabled={busy || !canExecute}
                  title={action.description || action.label}
                >
                  実行: {action.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="native-collection-surface__controls" role="group" aria-label="Collectionの表示条件">
            <label className="native-collection-surface__search" htmlFor={`${surfaceId}-search`}>
              <span>検索</span>
              <input
                id={`${surfaceId}-search`}
                type="search"
                value={collectionSearchQuery(spec)}
                placeholder="レコードを検索"
                onChange={(event) => setSearch(event.currentTarget.value)}
                aria-label="Collection内を検索"
              />
            </label>
            <label htmlFor={`${surfaceId}-sort`}>並び替え</label>
            <select
              id={`${surfaceId}-sort`}
              value={collectionSortFieldId(spec)}
              onChange={(event) => setSortField(event.currentTarget.value)}
            >
              <option value="">並び替えなし</option>
              {fields.map((field) => (
                <option key={fieldKey(field)} value={fieldKey(field)}>{collectionFieldLabel(field)}</option>
              ))}
            </select>
            <button
              type="button"
              className="native-collection-surface__icon-button"
              onClick={toggleSortDirection}
              disabled={!collectionSortFieldId(spec)}
              aria-label={collectionSortDirection(spec) === "desc" ? "昇順に切り替え" : "降順に切り替え"}
              title={collectionSortDirection(spec) === "desc" ? "昇順" : "降順"}
            >
              <span aria-hidden="true">{collectionSortDirection(spec) === "desc" ? "↓" : "↑"}</span>
            </button>
            {filterField ? (
              <label htmlFor={`${surfaceId}-filter`}>フィルター</label>
            ) : null}
            {filterField ? (
              <select
                id={`${surfaceId}-filter`}
                value={collectionFilterValue(spec)}
                onChange={(event) => setFilter(event.currentTarget.value)}
              >
                <option value="">すべて</option>
                {filterOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : null}
          </div>

          <form
            className="native-collection-surface__create"
            onSubmit={submitCreate}
            aria-labelledby={`${surfaceId}-create-title`}
            aria-describedby={createDescribedBy}
          >
            <fieldset disabled={!canEdit || editableFields.length === 0}>
              <legend id={`${surfaceId}-create-title`}>新しいレコードを追加</legend>
              <div className="native-collection-surface__form-grid">
                {editableFields.map((field) => {
                  const id = fieldKey(field);
                  const missing = collectionRequiredValueMissing(field, newDraft[id]);
                  return (
                    <label key={id} htmlFor={`${surfaceId}-new-${safePart(id)}`}>
                      <span>{collectionFieldLabel(field)}{collectionFieldRequired(field) ? <small>必須</small> : null}</span>
                      <CollectionFieldEditor
                        field={field}
                        id={`${surfaceId}-new-${safePart(id)}`}
                        value={newDraft[id] ?? ""}
                        disabled={draftInputDisabled}
                        compact={false}
                        onChange={(value) => setNewDraft(id, value)}
                        ariaLabel={`${collectionFieldLabel(field)}（新しいレコード）`}
                      />
                      {collectionFieldRequired(field) && missing ? <em className="native-collection-surface__validation">必須</em> : null}
                    </label>
                  );
                })}
              </div>
              {editableFields.length === 0 ? <p className="native-collection-surface__muted">編集できるfieldが定義されていません。</p> : null}
              {createValidation ? <p id={createValidationId} className="native-collection-surface__validation" role="status">{createValidation}</p> : null}
              <button
                type="submit"
                className="native-collection-surface__primary"
                disabled={busy || !canEdit || editableFields.length === 0 || !collectionCreateReadyForSpec(spec, newDraft)}
              >
                追加
              </button>
            </fieldset>
          </form>

          <div className="native-collection-surface__table-wrap">
            <table className="native-collection-surface__table" aria-label={`${title}のレコード一覧`}>
              <caption className="native-collection-surface__sr-only">{title}のレコード一覧。行を選択するとControllerへ通知します。</caption>
              <thead>
                <tr>
                  {fields.map((field) => (
                    <th key={fieldKey(field)} scope="col">
                      {collectionFieldLabel(field)}{collectionFieldRequired(field) ? <small>必須</small> : null}
                    </th>
                  ))}
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleRecords.map((record, index) => {
                  const recordId = recordIdFor(record);
                  const draft = recordDraft(record);
                  const recordTitle = recordId || `行${index + 1}`;
                  const selected = collectionRecordSelected(spec, record);
                  const ready = collectionRequiredReady(spec, draft);
                  return (
                    <tr
                      key={recordId}
                      tabIndex={0}
                      aria-selected={selected}
                      className={selected ? "is-selected" : undefined}
                      onClick={() => selectRecord(record)}
                      onFocus={() => selectRecord(record)}
                      onKeyDown={(event) => handleRowKeyDown(event, record)}
                    >
                      {fields.map((field) => {
                        const id = fieldKey(field);
                        const readonly = collectionFieldReadOnly(field);
                        const missing = collectionFieldRequired(field) && collectionRequiredValueMissing(field, draft[id]);
                        return (
                          <td key={id}>
                            {readonly ? (
                              <span className="native-collection-surface__readonly">{collectionRecordFieldDisplay(record, field)}</span>
                            ) : (
                              <CollectionFieldEditor
                                field={field}
                                id={`${surfaceId}-${safePart(recordId || `row-${index}`)}-${safePart(id)}`}
                                value={draft[id] ?? ""}
                                disabled={draftInputDisabled}
                                compact
                                onChange={(value) => setRecordDraft(record, id, value)}
                                ariaLabel={`${collectionFieldLabel(field)}（${recordTitle}）`}
                              />
                            )}
                            {missing ? <span className="native-collection-surface__validation">必須</span> : null}
                            {collectionRefMissing(record, field) ? <span className="native-collection-surface__ref-warning" role="status">参照先なし</span> : null}
                          </td>
                        );
                      })}
                      <td className="native-collection-surface__row-actions">
                        {collectionRecordActions(spec).map((action) => (
                          <button
                            key={action.id}
                            type="button"
                            className="native-collection-surface__action"
                            onClick={(event) => { event.stopPropagation(); runAction(action, record); }}
                            disabled={busy || !canExecute || (action.scope === "record" && !recordId)}
                            title={action.description || action.label}
                          >
                            {action.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="native-collection-surface__secondary"
                          onClick={(event) => { event.stopPropagation(); saveRecord(record, draft); }}
                          disabled={busy || !canEdit || !recordId || !ready}
                          aria-label={`${recordTitle}を保存`}
                        >
                          {pendingOperation === `save:${recordId}` ? "保存中…" : "保存"}
                        </button>
                        <button
                          type="button"
                          className="native-collection-surface__danger"
                          onClick={(event) => { event.stopPropagation(); deleteRecord(record); }}
                          disabled={busy || !canEdit || !recordId}
                          aria-label={`${recordTitle}を削除`}
                        >
                          {pendingOperation === `delete:${recordId}` ? "削除中…" : "削除"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {visibleRecords.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(fields.length + 1, 1)}>
                      <p className="native-collection-surface__empty">{collectionVisibleEmptyMessage(spec)}</p>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

interface CollectionFieldEditorProps {
  field: CollectionField;
  id: string;
  value: string;
  disabled: boolean;
  compact: boolean;
  onChange: FieldEditorChange;
  ariaLabel: string;
}

function CollectionFieldEditor({ field, id, value, disabled, compact, onChange, ariaLabel }: CollectionFieldEditorProps) {
  const type = collectionFieldType(field);
  const required = collectionFieldRequired(field) && type !== "boolean";
  const invalid = required && collectionRequiredValueMissing(field, value);
  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>): void => {
    if (type === "boolean") {
      onChange(String((event.currentTarget as HTMLInputElement).checked));
      return;
    }
    onChange(event.currentTarget.value);
  };

  const common = {
    id,
    name: fieldKey(field),
    disabled,
    required,
    "aria-label": ariaLabel,
    "aria-invalid": invalid ? true : undefined,
    "data-field-type": type,
    onChange: handleChange
  };

  if (type === "ref" || type === "enum") {
    const options = type === "ref"
      ? collectionFieldOptions(field)
      : (Array.isArray(field.enum_values)
        ? field.enum_values.filter((item): item is string => typeof item === "string").map((item) => ({ value: item, label: item }))
        : []);
    return (
      <select {...common} value={value}>
        <option value="">選択してください</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }

  if (type === "boolean") {
    return (
      <input
        {...common}
        type="checkbox"
        checked={value === "true"}
        required={false}
      />
    );
  }

  if (type === "text") {
    return <textarea {...common} value={value} rows={compact ? 2 : 4} />;
  }

  return (
    <input
      {...common}
      type={collectionFieldInputType(field)}
      value={collectionFieldInputValue(field, value)}
      inputMode={type === "number" ? "decimal" : undefined}
    />
  );
}

function CollectionSurfaceStyles() {
  return (
    <style>{`
      .native-collection-surface {
        --collection-ink: #17232d;
        --collection-muted: #65727a;
        --collection-line: #d8d4ca;
        --collection-paper: #fbfaf7;
        --collection-wash: #f1eee7;
        --collection-accent: #d98b3a;
        --collection-accent-dark: #8c4d1d;
        --collection-danger: #9c3c32;
        box-sizing: border-box;
        display: grid;
        gap: 1rem;
        min-width: 0;
        padding: clamp(1rem, 2.5vw, 2rem);
        border: 1px solid var(--collection-line);
        border-radius: 18px;
        background: radial-gradient(circle at 100% 0, rgba(217,139,58,.11), transparent 31%), var(--collection-paper);
        color: var(--collection-ink);
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif;
      }
      .native-collection-surface *, .native-collection-surface *::before, .native-collection-surface *::after { box-sizing: border-box; }
      .native-collection-surface__header, .native-collection-surface__summary, .native-collection-surface__controls, .native-collection-surface__actions, .native-collection-surface__row-actions { align-items: center; display: flex; flex-wrap: wrap; gap: .65rem; }
      .native-collection-surface__header { align-items: flex-start; justify-content: space-between; gap: 1rem; }
      .native-collection-surface__eyebrow { margin: 0 0 .35rem; color: var(--collection-accent-dark); font-size: .7rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
      .native-collection-surface h1, .native-collection-surface legend { margin: 0; font-family: Georgia, "Times New Roman", serif; letter-spacing: -.02em; }
      .native-collection-surface h1 { font-size: clamp(1.35rem, 3vw, 2rem); line-height: 1.1; }
      .native-collection-surface__context, .native-collection-surface__muted { margin: .35rem 0 0; color: var(--collection-muted); font-size: .82rem; line-height: 1.5; }
      .native-collection-surface__summary { justify-content: space-between; border-block: 1px solid var(--collection-line); padding: .65rem 0; color: var(--collection-muted); font-size: .78rem; }
      .native-collection-surface__summary span:first-child { color: var(--collection-ink); font-weight: 800; }
      .native-collection-surface__controls { align-items: end; padding: .1rem 0; }
      .native-collection-surface__controls label, .native-collection-surface__search { display: grid; gap: .28rem; color: var(--collection-muted); font-size: .72rem; font-weight: 800; letter-spacing: .03em; }
      .native-collection-surface__search { min-width: min(100%, 18rem); flex: 1 1 18rem; }
      .native-collection-surface input, .native-collection-surface select, .native-collection-surface textarea { border: 1px solid #bdb9b0; border-radius: 8px; background: #fffefa; color: var(--collection-ink); font: inherit; font-size: .84rem; line-height: 1.35; }
      .native-collection-surface input, .native-collection-surface select { min-height: 2.2rem; padding: .45rem .6rem; }
      .native-collection-surface textarea { min-height: 2.2rem; padding: .45rem .6rem; resize: vertical; }
      .native-collection-surface input:focus-visible, .native-collection-surface select:focus-visible, .native-collection-surface textarea:focus-visible, .native-collection-surface button:focus-visible, .native-collection-surface tr:focus-visible { outline: 3px solid rgba(217,139,58,.36); outline-offset: 2px; }
      .native-collection-surface button { cursor: pointer; font: inherit; }
      .native-collection-surface button:disabled, .native-collection-surface fieldset:disabled { cursor: not-allowed; opacity: .58; }
      .native-collection-surface__primary, .native-collection-surface__secondary, .native-collection-surface__danger, .native-collection-surface__action, .native-collection-surface__icon-button { border-radius: 8px; min-height: 2.2rem; padding: .42rem .7rem; }
      .native-collection-surface__primary { border: 1px solid var(--collection-accent-dark); background: var(--collection-accent-dark); color: #fffaf1; font-weight: 800; }
      .native-collection-surface__secondary, .native-collection-surface__icon-button { border: 1px solid #aaa69d; background: transparent; color: var(--collection-ink); }
      .native-collection-surface__danger { border: 1px solid rgba(156,60,50,.42); background: #fff8f5; color: var(--collection-danger); }
      .native-collection-surface__action { border: 1px solid rgba(217,139,58,.5); background: #fff8ec; color: var(--collection-accent-dark); font-size: .76rem; font-weight: 800; }
      .native-collection-surface__icon-button { min-width: 2.2rem; padding-inline: .5rem; }
      .native-collection-surface__actions { padding-bottom: .1rem; }
      .native-collection-surface__create { border: 1px solid var(--collection-line); border-radius: 12px; background: var(--collection-wash); padding: .85rem; }
      .native-collection-surface__create fieldset { border: 0; margin: 0; padding: 0; }
      .native-collection-surface__create legend { font-size: 1.02rem; font-weight: 700; }
      .native-collection-surface__form-grid { display: grid; gap: .7rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); margin: .75rem 0; }
      .native-collection-surface__form-grid label { display: grid; align-content: start; gap: .3rem; color: var(--collection-muted); font-size: .73rem; font-weight: 800; }
      .native-collection-surface__form-grid label > span { display: flex; align-items: baseline; gap: .35rem; }
      .native-collection-surface small { color: var(--collection-muted); font-size: .68rem; font-weight: 700; }
      .native-collection-surface__table-wrap { overflow-x: auto; border: 1px solid var(--collection-line); border-radius: 12px; }
      .native-collection-surface__table { border-collapse: collapse; min-width: 46rem; width: 100%; }
      .native-collection-surface__table th { background: #eeebe3; color: var(--collection-muted); font-size: .72rem; font-weight: 800; letter-spacing: .035em; text-align: left; white-space: nowrap; }
      .native-collection-surface__table th, .native-collection-surface__table td { border-bottom: 1px solid var(--collection-line); padding: .65rem .7rem; vertical-align: top; }
      .native-collection-surface__table tbody tr:last-child td { border-bottom: 0; }
      .native-collection-surface__table tbody tr[aria-selected="true"] { background: rgba(217,139,58,.09); }
      .native-collection-surface__table tbody tr:focus-visible { position: relative; z-index: 1; }
      .native-collection-surface__table td > input, .native-collection-surface__table td > select, .native-collection-surface__table td > textarea { min-width: 7rem; width: 100%; }
      .native-collection-surface__table td > input[type="checkbox"] { min-width: 1rem; width: auto; }
      .native-collection-surface__row-actions { align-items: flex-start; min-width: 13rem; }
      .native-collection-surface__row-actions button { font-size: .74rem; }
      .native-collection-surface__readonly { display: inline-block; max-width: 18rem; overflow-wrap: anywhere; color: var(--collection-muted); font-size: .82rem; }
      .native-collection-surface__validation, .native-collection-surface__ref-warning { display: block; margin-top: .25rem; color: var(--collection-danger); font-size: .7rem; font-style: normal; font-weight: 700; }
      .native-collection-surface__ref-warning { color: var(--collection-accent-dark); }
      .native-collection-surface__empty, .native-collection-surface__unsupported { margin: 0; padding: 1.5rem; color: var(--collection-muted); text-align: center; }
      .native-collection-surface__unsupported { border: 1px dashed var(--collection-line); border-radius: 12px; background: var(--collection-wash); text-align: left; }
      .native-collection-surface__unsupported strong { color: var(--collection-ink); }
      .native-collection-surface__unsupported p { margin: .35rem 0 0; font-size: .82rem; line-height: 1.5; }
      .native-collection-surface__status, .native-collection-surface__error, .native-collection-surface__conflict { margin: 0; border-left: 3px solid var(--collection-accent); padding: .55rem .7rem; font-size: .8rem; line-height: 1.5; }
      .native-collection-surface__error { border-left-color: var(--collection-danger); color: #7e2f28; }
      .native-collection-surface__conflict { border-left-color: var(--collection-accent); color: var(--collection-accent-dark); }
      .native-collection-surface__sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
      @media (max-width: 700px) { .native-collection-surface { padding: 1rem; } .native-collection-surface__header { align-items: stretch; flex-direction: column; } .native-collection-surface__header button { align-self: flex-start; } .native-collection-surface__controls { align-items: stretch; } .native-collection-surface__controls > label:not(.native-collection-surface__search), .native-collection-surface__controls > select, .native-collection-surface__controls > button { flex: 1 1 auto; } }
    `}</style>
  );
}

function fieldKey(field: Record<string, unknown>): string {
  const id = typeof field.id === "string" ? field.id.trim() : "";
  if (id) return id;
  const name = typeof field.name === "string" ? field.name.trim() : "";
  return name;
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-") || "field";
}

function recordIdFor(record: NativeCollectionRecord): string {
  return typeof record.id === "string" || typeof record.id === "number" ? String(record.id).trim() : "";
}

function nativeCollectionRecordFromValue(value: Record<string, unknown>): NativeCollectionRecord | undefined {
  const rawId = value.id;
  if ((typeof rawId !== "string" && typeof rawId !== "number") || !String(rawId).trim()) return undefined;
  const entries: Array<[string, JsonValue]> = [];
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!isJsonValue(fieldValue)) return undefined;
    entries.push([key, fieldValue]);
  }
  return Object.fromEntries(entries.map(([key, fieldValue]) => key === "id" ? [key, String(rawId).trim()] : [key, fieldValue]));
}

function isNativeCollectionRecord(value: NativeCollectionRecord | undefined): value is NativeCollectionRecord {
  return value !== undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

export default NativeCollectionSurface;
