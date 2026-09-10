import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { JsonValue } from "@samurai-agent/core-schemas";
import { createIdempotencyKey } from "../lib/api";
import {
  withNativeWorkspaceTarget,
  type NativeWorkspaceTargetGuardBridge
} from "./native-workspace-target";
import type { NativeWorkspaceTarget } from "./types";
import { NativeDraftNavigationPrompt } from "./NativeDraftNavigationPrompt";
import { useNativeDraftNavigation, type NativeDraftNavigationController } from "./use-native-draft-navigation";

export type NativeInteractionKind = "approval" | "backend_input";
export type NativeInteractionStatus =
  | "pending"
  | "accepted"
  | "denied"
  | "cancelled"
  | "expired"
  | "executing"
  | "completed"
  | "failed";

/**
 * An option is identified by the immutable server-issued id. The UI never
 * derives the response from a label or from an accept/deny convention.
 */
export interface NativeInteractionOption {
  id: string;
  label: string;
  decision: "approve" | "deny" | "submit_input";
  description?: string;
}

export type NativeInteractionInputValueType = "string" | "number" | "integer" | "boolean";

/** A field is server-declared. The renderer does not infer a schema from text. */
export interface NativeInteractionInputField {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "number" | "checkbox";
  valueType?: NativeInteractionInputValueType;
  required?: boolean;
  description?: string;
  minLength?: number;
  maxLength?: number;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
}

/** The small JSON Schema subset that this native form can render safely. */
export interface NativeInteractionInputSchemaProperty {
  type?: NativeInteractionInputValueType;
  title?: string;
  description?: string;
  enum?: Array<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
}

export interface NativeInteractionInputSchema {
  type?: "object";
  properties?: Record<string, NativeInteractionInputSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Public projection of one persistent request. It deliberately carries the
 * immutable Room/Run/Surface/Revision/action identity shown before responding.
 */
export interface NativeInteractionRequest {
  id: string;
  version: number;
  workspaceId?: string;
  roomId: string;
  kind: NativeInteractionKind;
  status: NativeInteractionStatus;
  title: string;
  summary: string;
  runId?: string;
  surfaceId?: string;
  revisionId?: string;
  actionId?: string;
  targetLabel?: string;
  actionTarget?: Record<string, JsonValue>;
  expiresAt?: string;
  options: NativeInteractionOption[];
  /** Already-normalized fields are accepted from a bridge adapter. */
  inputFields?: NativeInteractionInputField[];
  /** Raw server-declared schema is accepted when the adapter has not normalized it. */
  inputSchema?: NativeInteractionInputSchema;
  inputValues?: Record<string, JsonValue>;
  resultSummary?: string;
  failureSummary?: string;
  errorCode?: string;
  result?: JsonValue;
  createdAt?: string;
  updatedAt?: string;
}

export type NativeInteractionDraft = Record<string, string | number | boolean>;

export interface NativeInteractionDraftState {
  dirty: boolean;
  saving: boolean;
}

export interface NativeInteractionDraftSnapshot {
  requestId: string;
  values: Readonly<NativeInteractionDraft>;
}

export function captureNativeInteractionDraftSnapshot(
  requestId: string,
  draft: NativeInteractionDraft
): NativeInteractionDraftSnapshot {
  return { requestId, values: { ...draft } };
}

export function nativeInteractionDraftSnapshotHasNewerChanges(
  snapshot: NativeInteractionDraftSnapshot,
  current: NativeInteractionDraft | undefined
): boolean {
  if (!current) return false;
  const keys = new Set([...Object.keys(snapshot.values), ...Object.keys(current)]);
  return [...keys].some((key) => !Object.is(snapshot.values[key], current[key]));
}

/** Preserve an edit made after a response started; only the submitted draft may be cleared. */
export function nativeInteractionDraftAfterResponse(
  current: NativeInteractionDraft | undefined,
  snapshot: NativeInteractionDraftSnapshot,
  succeeded = true
): NativeInteractionDraft | undefined {
  if (!current) return undefined;
  if (!succeeded) return current;
  if (!nativeInteractionDraftSnapshotHasNewerChanges(snapshot, current)) return undefined;
  return current;
}

export interface NativeInteractionRequestsBridge extends NativeWorkspaceTargetGuardBridge {
  listWorkspaceInteractionRequests?: (input: {
    roomId: string;
    includeResolved?: boolean;
    target?: NativeWorkspaceTarget;
  }) => Promise<{ requests: NativeInteractionRequest[] }>;
  respondWorkspaceInteractionRequest?: (input: {
    roomId: string;
    requestId: string;
    expectedVersion: number;
    /** The persisted server option id. No raw decision is accepted here. */
    optionId: string;
    values?: Record<string, JsonValue>;
    operationId: string;
    target?: NativeWorkspaceTarget;
  }) => Promise<{ request: NativeInteractionRequest; replayed?: boolean }>;
  cancelWorkspaceInteractionRequest?: (input: {
    roomId: string;
    requestId: string;
    expectedVersion: number;
    operationId: string;
    target?: NativeWorkspaceTarget;
  }) => Promise<{ request: NativeInteractionRequest; replayed?: boolean }>;
}

export interface NativeInteractionRequestsProps {
  roomId?: string;
  target?: NativeWorkspaceTarget;
  bridge?: NativeInteractionRequestsBridge;
  onClose?: () => void;
  onDraftNavigationControllerChange?: (controller: NativeDraftNavigationController | undefined) => void;
}

export interface NativeInteractionRequestOperations {
  list?: () => Promise<{ requests: NativeInteractionRequest[] }>;
  respond?: (input: {
    requestId: string;
    expectedVersion: number;
    optionId: string;
    values?: Record<string, JsonValue>;
    operationId: string;
  }) => Promise<{ request: NativeInteractionRequest; replayed?: boolean }>;
  cancel?: (input: {
    requestId: string;
    expectedVersion: number;
    operationId: string;
  }) => Promise<{ request: NativeInteractionRequest; replayed?: boolean }>;
}

/**
 * Narrow bridge adapter for this surface. Every operation is guarded before
 * and after the request so a late response cannot cross Workspace navigation.
 * If the target or guard contract is missing, the operation is unavailable.
 */
export function nativeInteractionRequestOperations(
  bridge: NativeInteractionRequestsBridge | undefined,
  target: NativeWorkspaceTarget | undefined,
  roomId: string | undefined
): NativeInteractionRequestOperations | undefined {
  if (!bridge || !target || !roomId || !bridge.listWorkspaceConnections) return undefined;

  return {
    ...(bridge.listWorkspaceInteractionRequests ? {
      list: () => withNativeWorkspaceTarget(bridge, target, () => bridge.listWorkspaceInteractionRequests!({ roomId, includeResolved: true, target }))
    } : {}),
    ...(bridge.respondWorkspaceInteractionRequest ? {
      respond: (input) => withNativeWorkspaceTarget(bridge, target, () => bridge.respondWorkspaceInteractionRequest!({
        roomId,
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        optionId: input.optionId,
        ...(input.values === undefined ? {} : { values: input.values }),
        operationId: input.operationId,
        target
      }))
    } : {}),
    ...(bridge.cancelWorkspaceInteractionRequest ? {
      cancel: (input) => withNativeWorkspaceTarget(bridge, target, () => bridge.cancelWorkspaceInteractionRequest!({
        roomId,
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        operationId: input.operationId,
        target
      }))
    } : {})
  };
}

export interface NativeInteractionBusyGate {
  tryStart: (requestId: string) => boolean;
  finish: (requestId: string) => void;
  clear: () => void;
  snapshot: () => Set<string>;
}

/** Synchronous click gate; state updates alone are too late for double clicks. */
export function createNativeInteractionBusyGate(): NativeInteractionBusyGate {
  const busy = new Set<string>();
  return {
    tryStart: (requestId) => {
      if (busy.has(requestId)) return false;
      busy.add(requestId);
      return true;
    },
    finish: (requestId) => { busy.delete(requestId); },
    clear: () => { busy.clear(); },
    snapshot: () => new Set(busy)
  };
}

/**
 * React-only persistent request surface. It cannot manufacture an approval:
 * absent Server list/respond methods are rendered as unavailable instead of a
 * locally successful button.
 */
export function NativeInteractionRequests({ roomId, target, bridge, onClose, onDraftNavigationControllerChange }: NativeInteractionRequestsProps) {
  const sectionId = useId().replace(/:/g, "");
  const generation = useRef(0);
  const busyRef = useRef(createNativeInteractionBusyGate());
  const operationIds = useRef(new Map<string, string>());
  const draftsRef = useRef<Record<string, NativeInteractionDraft>>({});
  const [requests, setRequests] = useState<NativeInteractionRequest[]>([]);
  const [drafts, setDrafts] = useState<Record<string, NativeInteractionDraft>>({});
  const [loading, setLoading] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  draftsRef.current = drafts;
  const stableTarget = useMemo(
    // Preserve an optional Room/selection generation carried by a richer host
    // target.  The generic interaction surface still accepts the legacy
    // connection + Workspace pair.
    () => target ? { ...target } : undefined,
    [target]
  );
  const operations = useMemo(
    () => nativeInteractionRequestOperations(bridge, stableTarget, roomId),
    [bridge, roomId, stableTarget]
  );

  const beginBusy = useCallback((requestId: string): boolean => {
    const started = busyRef.current.tryStart(requestId);
    if (started) setBusyIds(busyRef.current.snapshot());
    return started;
  }, []);

  const endBusy = useCallback((requestId: string): void => {
    busyRef.current.finish(requestId);
    setBusyIds(busyRef.current.snapshot());
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const requestGeneration = ++generation.current;
    const list = operations?.list;
    if (!list) {
      setRequests([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await list();
      if (requestGeneration !== generation.current) return;
      if (!Array.isArray(response.requests)) throw new Error("interaction_request_list_invalid");
      const scoped = response.requests.filter((request) => isInteractionRequestInScope(request, roomId, stableTarget));
      setRequests(scoped);
      setDrafts((current) => {
        const next = mergeInitialDrafts(current, scoped);
        draftsRef.current = next;
        return next;
      });
    } catch (cause) {
      if (requestGeneration === generation.current) setError(nativeInteractionErrorMessage(cause));
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [operations, roomId, stableTarget]);

  useEffect(() => {
    generation.current += 1;
    busyRef.current.clear();
    operationIds.current.clear();
    setBusyIds(new Set());
    setRequests([]);
    draftsRef.current = {};
    setDrafts({});
    setError(undefined);
    setNotice(undefined);
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);

  const draftState = useMemo<NativeInteractionDraftState>(() => ({
    dirty: requests.some((request) => nativeInteractionDraftIsDirty(request, drafts[request.id] ?? {})),
    saving: busyIds.size > 0
  }), [busyIds, drafts, requests]);

  // Accepted/executing requests are not terminal.  Keep the projection fresh
  // until the Server records a terminal result so a failed execution is not
  // hidden behind a manual refresh.
  const hasUnresolvedExecution = requests.some((request) => request.status === "accepted" || request.status === "executing");
  useEffect(() => {
    if (!hasUnresolvedExecution || !operations?.list || loading || busyIds.size > 0) return;
    const timer = setTimeout(() => { void reload(); }, 1_000);
    return () => clearTimeout(timer);
  }, [busyIds.size, hasUnresolvedExecution, loading, operations, reload]);

  const updateDraft = useCallback((requestId: string, field: string, value: string | number | boolean): void => {
    const next = {
      ...draftsRef.current,
      [requestId]: { ...(draftsRef.current[requestId] ?? {}), [field]: value }
    };
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  const respond = useCallback(async (
    request: NativeInteractionRequest,
    option: NativeInteractionOption
  ): Promise<boolean> => {
    const respondOperation = operations?.respond;
    if (!respondOperation || !roomId || !interactionRequestCanRespond(request, option)) return false;
    if (!beginBusy(request.id)) return false;
    const requestGeneration = generation.current;
    setError(undefined);
    setNotice(undefined);
    try {
      const requiresInput = option.decision === "submit_input";
      const submittedDraft = { ...(draftsRef.current[request.id] ?? {}) };
      const draftSnapshot = captureNativeInteractionDraftSnapshot(request.id, submittedDraft);
      const input = requiresInput ? interactionRequestInput(request, submittedDraft) : undefined;
      if (input && !input.ok) {
        setError(input.error);
        return false;
      }
      if (input && !input.supported) {
        setError("Serverが宣言した入力形式に、この画面はまだ対応していません。要求を安全のため保留しました。");
        return false;
      }
      const operationKey = interactionOperationKey(request.id, option.id, input?.values);
      const operationId = operationIds.current.get(operationKey) ?? createIdempotencyKey();
      operationIds.current.set(operationKey, operationId);
      const response = await respondOperation({
        requestId: request.id,
        expectedVersion: request.version,
        optionId: option.id,
        ...(input?.values === undefined ? {} : { values: input.values }),
        operationId
      });
      if (requestGeneration !== generation.current) return false;
      assertInteractionResponse(response.request, request, roomId, stableTarget);
      clearInteractionOperationIds(operationIds.current, request.id);
      setRequests((current) => current.map((candidate) => candidate.id === response.request.id ? response.request : candidate));
      const currentDraft = draftsRef.current[request.id];
      const nextDraft = nativeInteractionDraftAfterResponse(currentDraft, draftSnapshot, response.request.status !== "failed");
      if (nextDraft) {
        const next = { ...draftsRef.current, [request.id]: nextDraft };
        draftsRef.current = next;
        setDrafts(next);
      } else if (currentDraft) {
        const next = { ...draftsRef.current };
        delete next[request.id];
        draftsRef.current = next;
        setDrafts(next);
      }
      setNotice(response.replayed ? "Serverに保存済みの応答を再表示しました。" : undefined);
      return true;
    } catch (cause) {
      if (requestGeneration === generation.current) setError(nativeInteractionErrorMessage(cause));
      return false;
    } finally {
      endBusy(request.id);
    }
  }, [beginBusy, endBusy, operations, roomId, stableTarget]);

  const saveDraftAndNavigate = useCallback(async (): Promise<boolean> => {
    const dirtyRequests = requests.filter((request) => nativeInteractionDraftIsDirty(request, draftsRef.current[request.id] ?? {}));
    for (const request of dirtyRequests) {
      const option = request.options.find((candidate) => candidate.decision === "submit_input");
      if (!option) {
        setError("保存できる入力応答がありません。入力を送信する選択肢を確認してください。");
        return false;
      }
      if (!await respond(request, option)) {
        setError("入力の保存に失敗しました。下書きを保持しています。内容を確認して、もう一度保存してください。");
        return false;
      }
    }
    return !requests.some((request) => nativeInteractionDraftIsDirty(request, draftsRef.current[request.id] ?? {}));
  }, [requests, respond]);

  const cancel = useCallback(async (request: NativeInteractionRequest): Promise<void> => {
    const cancelOperation = operations?.cancel;
    if (!cancelOperation || !roomId || !interactionRequestCanCancel(request)) return;
    if (!beginBusy(request.id)) return;
    const requestGeneration = generation.current;
    setError(undefined);
    setNotice(undefined);
    try {
      const operationKey = `cancel:${request.id}:${request.version}`;
      const operationId = operationIds.current.get(operationKey) ?? createIdempotencyKey();
      operationIds.current.set(operationKey, operationId);
      const response = await cancelOperation({
        requestId: request.id,
        expectedVersion: request.version,
        operationId
      });
      if (requestGeneration !== generation.current) return;
      assertInteractionResponse(response.request, request, roomId, stableTarget);
      clearInteractionOperationIds(operationIds.current, request.id);
      setRequests((current) => current.map((candidate) => candidate.id === response.request.id ? response.request : candidate));
      setNotice(response.replayed ? "Serverに保存済みの取消を再表示しました。" : undefined);
    } catch (cause) {
      if (requestGeneration === generation.current) setError(nativeInteractionErrorMessage(cause));
    } finally {
      endBusy(request.id);
    }
  }, [beginBusy, endBusy, operations, roomId, stableTarget]);

  const draftNavigation = useNativeDraftNavigation({
    scopeKey: "interaction\n" + (stableTarget?.connectionId ?? "") + "\n" + (stableTarget?.workspaceId ?? "") + "\n" + (roomId ?? ""),
    label: "確認待ち入力",
    dirty: draftState.dirty,
    saving: draftState.saving,
    canSave: Boolean(operations?.respond),
    saveUnavailableMessage: "入力を保存するServer操作が利用できません。下書きを破棄するか、接続を確認してください。",
    save: saveDraftAndNavigate,
    discard: () => {
      draftsRef.current = {};
      setDrafts({});
    },
    onControllerChange: onDraftNavigationControllerChange
  });

  const requestClose = useCallback((): void => {
    if (!onClose) return;
    draftNavigation.requestNavigation(onClose);
  }, [draftNavigation, onClose]);

  const unavailableMessage = interactionUnavailableMessage(roomId, stableTarget, operations);
  const unavailable = Boolean(unavailableMessage);
  return <section className="native-interaction-requests" aria-labelledby={`${sectionId}-title`}>
    <header className="native-interaction-requests__header">
      <div>
        <span className="native-section-eyebrow">Work lifecycle</span>
        <h1 id={`${sectionId}-title`}>確認待ち</h1>
        <p>要求の対象・期限・Serverの状態・実行結果を分けて確認します。</p>
      </div>
      <div className="native-interaction-requests__header-actions">
        <button
          type="button"
          className="native-button native-button-quiet"
          onClick={() => void reload()}
          disabled={unavailable || loading || busyIds.size > 0 || draftNavigation.getState().pending}
        >
          {loading ? "更新中…" : "更新"}
        </button>
        {onClose ? <button type="button" className="native-button native-button-quiet" onClick={requestClose}>仕事へ戻る</button> : null}
      </div>
    </header>
    {unavailableMessage ? <p className="native-inline-note" role="status">{unavailableMessage}</p> : null}
    {stableTarget && roomId && !unavailable ? <p className="native-interaction-requests__target-note">Workspace target: {stableTarget.workspaceId}・Room: {roomId}</p> : null}
    {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
    {notice ? <p className="native-inline-note" role="status">{notice}</p> : null}
    {draftState.dirty ? <p className="native-inline-note" role="status">未保存の入力下書きを保持しています。</p> : null}
    {loading ? <p className="native-inline-note" role="status">確認要求を読み込んでいます…</p> : null}
    {!loading && !unavailable && requests.length === 0 ? <p className="native-inline-note">このRoomに確認待ちまたは最近の確定要求はありません。</p> : null}
    <NativeDraftNavigationPrompt controller={draftNavigation} />
    <div className="native-interaction-requests__list">
      {requests.map((request) => <NativeInteractionRequestCard
        key={request.id}
        request={request}
        draft={drafts[request.id] ?? {}}
        busy={busyIds.has(request.id)}
        respondAvailable={Boolean(operations?.respond)}
        cancelAvailable={Boolean(operations?.cancel)}
        leavePending={draftNavigation.getState().pending}
        onDraftChange={(field, value) => updateDraft(request.id, field, value)}
        onRespond={(option) => void respond(request, option)}
        onCancel={() => void cancel(request)}
      />)}
    </div>
  </section>;
}

export function NativeInteractionRequestCard({ request, draft, busy, respondAvailable, cancelAvailable, leavePending = false, onDraftChange, onRespond, onCancel }: {
  request: NativeInteractionRequest;
  draft: NativeInteractionDraft;
  busy: boolean;
  respondAvailable: boolean;
  cancelAvailable: boolean;
  leavePending?: boolean;
  onDraftChange: (field: string, value: string | number | boolean) => void;
  onRespond: (option: NativeInteractionOption) => void;
  onCancel: () => void;
}) {
  const pending = request.status === "pending";
  const input = interactionInputSpec(request);
  const cardId = `interaction-request-${domSafeId(request.id)}`;
  const summaryId = `${cardId}-summary`;
  const unavailableInput = request.kind === "backend_input" && !input.supported;
  return <article className="native-interaction-request-card" aria-labelledby={cardId}>
    <header>
      <div>
        <span className={`native-interaction-request-card__kind is-${request.kind}`}>{request.kind === "approval" ? "承認" : "入力待ち"}</span>
        <h2 id={cardId}>{request.title}</h2>
      </div>
      <span className={`native-interaction-request-card__status is-${request.status}`} role="status">{interactionStatusLabel(request.status)}</span>
    </header>
    <p id={summaryId}>{request.summary}</p>
    <dl className="native-interaction-request-card__context">
      <InteractionContext label="Room" value={request.roomId} />
      {request.targetLabel ? <InteractionContext label="対象" value={request.targetLabel} /> : null}
      {request.runId ? <InteractionContext label="Run" value={request.runId} /> : null}
      {request.surfaceId ? <InteractionContext label="Surface" value={request.surfaceId} /> : null}
      {request.revisionId ? <InteractionContext label="対象版" value={request.revisionId} /> : null}
      {request.actionId ? <InteractionContext label="Action" value={request.actionId} /> : null}
      {request.expiresAt ? <InteractionContext label="期限" value={formatExpiry(request.expiresAt)} /> : null}
      <InteractionContext label="Server version" value={String(request.version)} />
    </dl>
    {request.actionTarget ? <details className="native-interaction-request-card__target">
      <summary>操作対象の詳細</summary>
      <pre>{formatJson(request.actionTarget)}</pre>
    </details> : null}
    {pending && input.fields.length ? <fieldset className="native-interaction-request-card__fields" aria-describedby={summaryId}>
      <legend>Serverが宣言した入力</legend>
      {input.fields.map((field) => <InputField
        key={field.id}
        requestId={request.id}
        field={field}
        value={draft[field.id] ?? ""}
        onChange={(value) => onDraftChange(field.id, value)}
        disabled={busy || leavePending}
      />)}
    </fieldset> : null}
    {pending && request.kind === "backend_input" && input.supported && input.fields.length === 0 ? <p className="native-interaction-request-card__input-note">入力項目はありません。Serverへ空のJSON objectを送ります。</p> : null}
    {pending && !input.supported ? <p className="native-interaction-request-card__input-note" role="alert">この入力 schema はこの画面で安全に表示・検証できません。操作は利用不可です。</p> : null}
    {request.failureSummary || request.errorCode || request.status === "failed" ? <div className="native-interaction-request-card__result is-failure" role="alert">
      <strong>失敗</strong>
      <span>{request.failureSummary ?? "Serverで要求の実行に失敗しました。"}</span>
      {request.errorCode ? <small>コード: {request.errorCode}</small> : null}
    </div> : null}
    {request.resultSummary ? <div className="native-interaction-request-card__result"><strong>結果</strong><span>{request.resultSummary}</span></div> : null}
    {request.result !== undefined ? <details className="native-interaction-request-card__result is-detail">
      <summary>Server結果の詳細</summary>
      <pre>{formatJson(request.result)}</pre>
    </details> : null}
    {pending ? <footer className="native-interaction-request-card__actions">
      {!respondAvailable ? <span className="native-interaction-request-card__unavailable">応答経路が未接続です。</span> : null}
      {request.options.length === 0 ? <span className="native-interaction-request-card__unavailable">Serverが許可した選択肢がありません。</span> : null}
      {request.options.map((option) => {
        const optionHelpId = `${cardId}-option-${domSafeId(option.id)}-help`;
        const allowed = interactionRequestCanRespond(request, option)
            && respondAvailable
            && (option.decision === "deny" || (!unavailableInput && option.decision === "submit_input" && input.supported) || (request.kind === "approval" && option.decision === "approve"));
        return <span className="native-interaction-request-card__option" key={option.id}>
          <button
            type="button"
            className="native-button native-button-primary"
            disabled={busy || leavePending || !allowed}
            onClick={() => onRespond(option)}
            aria-describedby={option.description ? optionHelpId : summaryId}
          >
            {busy ? "送信中…" : option.label}
          </button>
          {option.description ? <small id={optionHelpId}>{option.description}</small> : null}
        </span>;
      })}
      {cancelAvailable && interactionRequestCanCancel(request) ? <button type="button" className="native-text-button" disabled={busy || leavePending} onClick={onCancel}>取消</button> : null}
      {!cancelAvailable ? <span className="native-interaction-request-card__unavailable">取消経路が未接続です。</span> : null}
    </footer> : null}
  </article>;
}

function InteractionContext({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function InputField({ requestId, field, value, onChange, disabled }: {
  requestId: string;
  field: NativeInteractionInputField;
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
  disabled: boolean;
}) {
  const id = `interaction-field-${domSafeId(requestId)}-${domSafeId(field.id)}`;
  const descriptionId = field.description ? `${id}-description` : undefined;
  const label = <span>{field.label}{field.required ? "（必須）" : ""}</span>;
  const describedBy = descriptionId;
  if (field.type === "select") return <label className="native-interaction-request-card__field" htmlFor={id}>{label}
    <select id={id} value={String(value)} onChange={(event) => onChange(event.currentTarget.value)} disabled={disabled} required={field.required} aria-describedby={describedBy}>
      <option value="">選択してください</option>
      {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {field.description ? <small id={descriptionId}>{field.description}</small> : null}
  </label>;
  if (field.type === "checkbox") return <label className="native-interaction-request-card__field" htmlFor={id}>
    <span><input id={id} type="checkbox" checked={value === true} onChange={(event) => onChange(event.currentTarget.checked)} disabled={disabled} required={field.required} aria-describedby={describedBy} /> {label}</span>
    {field.description ? <small id={descriptionId}>{field.description}</small> : null}
  </label>;
  if (field.type === "textarea") return <label className="native-interaction-request-card__field" htmlFor={id}>{label}
    <textarea id={id} value={String(value)} placeholder={field.placeholder} onChange={(event) => onChange(event.currentTarget.value)} disabled={disabled} required={field.required} minLength={field.minLength} maxLength={field.maxLength} rows={4} aria-describedby={describedBy} />
    {field.description ? <small id={descriptionId}>{field.description}</small> : null}
  </label>;
  return <label className="native-interaction-request-card__field" htmlFor={id}>{label}
    <input id={id} type={field.type === "number" ? "number" : "text"} value={String(value)} placeholder={field.placeholder} onChange={(event) => onChange(event.currentTarget.value)} disabled={disabled} required={field.required} minLength={field.minLength} maxLength={field.maxLength} aria-describedby={describedBy} />
    {field.description ? <small id={descriptionId}>{field.description}</small> : null}
  </label>;
}

export function interactionRequestCanRespond(request: NativeInteractionRequest, option: NativeInteractionOption): boolean {
  if (request.status !== "pending" || !option.id || !safeInteractionOptions(request.options)) return false;
  return request.options.some((candidate) => candidate.id === option.id && candidate.decision === option.decision);
}

export function interactionRequestCanCancel(request: NativeInteractionRequest): boolean {
  return request.status === "pending";
}

export function interactionInputFields(request: NativeInteractionRequest): NativeInteractionInputField[] {
  return interactionInputSpec(request).fields;
}

export function interactionInputSchemaSupported(request: NativeInteractionRequest): boolean {
  return interactionInputSpec(request).supported;
}

export function interactionRequestInputValues(
  request: NativeInteractionRequest,
  draft: Record<string, string | number | boolean>
): { supported: boolean; values?: Record<string, JsonValue>; error?: string } {
  const input = interactionRequestInput(request, draft);
  return input.ok
    ? { supported: input.supported, ...(input.values === undefined ? {} : { values: input.values }) }
    : { supported: true, error: input.error };
}

function interactionInputSpec(request: NativeInteractionRequest): { fields: NativeInteractionInputField[]; supported: boolean } {
  if (request.inputFields?.length) {
    return { fields: request.inputFields.filter(isSafeInputField), supported: request.inputFields.every(isSafeInputField) };
  }
  if (request.inputSchema === undefined) return { fields: [], supported: true };
  const schema = request.inputSchema;
  if (schema.type !== undefined && schema.type !== "object") return { fields: [], supported: false };
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const fields: NativeInteractionInputField[] = [];
  for (const [id, property] of Object.entries(properties)) {
    if (!isSafeInputSchemaProperty(property) || !id.trim()) return { fields: [], supported: false };
    const valueType = property.type ?? inferInputValueType(property.enum);
    if (!valueType) return { fields: [], supported: false };
    const options = property.enum?.map((value) => ({ value: scalarInputValue(value), label: String(value) }));
    fields.push({
      id,
      label: property.title ?? id,
      type: options?.length ? "select" : valueType === "boolean" ? "checkbox" : valueType === "number" || valueType === "integer" ? "number" : "text",
      valueType,
      required: required.has(id),
      ...(property.description ? { description: property.description } : {}),
      ...(property.minLength === undefined ? {} : { minLength: property.minLength }),
      ...(property.maxLength === undefined ? {} : { maxLength: property.maxLength }),
      ...(options?.length ? { options } : {})
    });
  }
  if ([...required].some((id) => !Object.prototype.hasOwnProperty.call(properties, id))) return { fields: [], supported: false };
  return { fields, supported: true };
}

function isSafeInputField(value: NativeInteractionInputField): boolean {
  return Boolean(value && typeof value.id === "string" && value.id.trim() && typeof value.label === "string"
    && ["text", "textarea", "select", "number", "checkbox"].includes(value.type)
    && (value.valueType === undefined || ["string", "number", "integer", "boolean"].includes(value.valueType))
    && (value.minLength === undefined || (Number.isSafeInteger(value.minLength) && value.minLength >= 0))
    && (value.maxLength === undefined || (Number.isSafeInteger(value.maxLength) && value.maxLength >= 0))
    && (value.minLength === undefined || value.maxLength === undefined || value.minLength <= value.maxLength)
    && (value.type !== "select" || (Array.isArray(value.options) && value.options.every((option) => typeof option.value === "string" && typeof option.label === "string"))));
}

function isSafeInputSchemaProperty(value: NativeInteractionInputSchemaProperty): boolean {
  if (!value || (value.type !== undefined && !["string", "number", "integer", "boolean"].includes(value.type))) return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  if (value.minLength !== undefined && (!Number.isSafeInteger(value.minLength) || value.minLength < 0)) return false;
  if (value.maxLength !== undefined && (!Number.isSafeInteger(value.maxLength) || value.maxLength < 0)) return false;
  if (value.minLength !== undefined && value.maxLength !== undefined && value.minLength > value.maxLength) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.every((candidate) => ["string", "number", "boolean"].includes(typeof candidate)))) return false;
  if (value.type === "string" && value.enum?.some((candidate) => typeof candidate !== "string")) return false;
  if ((value.type === "number" || value.type === "integer") && value.enum?.some((candidate) => typeof candidate !== "number")) return false;
  if (value.type === "integer" && value.enum?.some((candidate) => !Number.isSafeInteger(candidate))) return false;
  if (value.type === "boolean" && value.enum?.some((candidate) => typeof candidate !== "boolean")) return false;
  return true;
}

function inferInputValueType(values: Array<string | number | boolean> | undefined): NativeInteractionInputValueType | undefined {
  if (!values?.length) return "string";
  const types = new Set(values.map((value) => typeof value));
  if (types.size !== 1) return undefined;
  const type = values[0] === undefined ? undefined : typeof values[0];
  return type === "string" || type === "number" || type === "boolean" ? type : undefined;
}

function interactionRequestInput(
  request: NativeInteractionRequest,
  draft: Record<string, string | number | boolean>
): { ok: true; supported: boolean; values?: Record<string, JsonValue> } | { ok: false; error: string } {
  const input = interactionInputSpec(request);
  if (!input.supported) return { ok: true, supported: false };
  const values: Record<string, JsonValue> = {};
  for (const field of input.fields) {
    const raw = draft[field.id];
    if (isEmptyInputValue(raw)) {
      if (field.required) return { ok: false, error: `必須の入力項目があります: ${field.label}` };
      continue;
    }
    const converted = convertInputValue(field, raw);
    if (!converted.ok) return converted;
    values[field.id] = converted.value;
  }
  const hasInputContract = request.kind === "backend_input" || input.fields.length > 0 || request.inputSchema !== undefined;
  return { ok: true, supported: true, ...(hasInputContract ? { values } : {}) };
}

function convertInputValue(field: NativeInteractionInputField, value: string | number | boolean | undefined): { ok: true; value: JsonValue } | { ok: false; error: string } {
  if (value === undefined) return { ok: false, error: `${field.label} の入力を確認してください。` };
  const valueType = field.valueType ?? (field.type === "number" ? "number" : field.type === "checkbox" ? "boolean" : "string");
  if (valueType === "boolean") return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: `${field.label} は真偽値で入力してください。` };
  if (valueType === "number" || valueType === "integer") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || (valueType === "integer" && !Number.isSafeInteger(number))) return { ok: false, error: `${field.label} は有効な数値で入力してください。` };
    return { ok: true, value: number };
  }
  return { ok: true, value: String(value) };
}

function isEmptyInputValue(value: string | number | boolean | undefined): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length === 0);
}

export function nativeInteractionDraftIsDirty(
  request: NativeInteractionRequest,
  draft: NativeInteractionDraft
): boolean {
  if (request.status !== "pending") return false;
  const input = interactionInputSpec(request);
  if (!input.supported) return Object.keys(draft).length > 0;
  const fields = new Map(input.fields.map((field) => [field.id, field]));
  return Object.entries(draft).some(([fieldId, value]) => {
    const field = fields.get(fieldId);
    if (!field) return true;
    return !interactionDraftValueMatchesServer(field, value, request.inputValues?.[fieldId]);
  });
}

function interactionDraftValueMatchesServer(
  field: NativeInteractionInputField,
  current: string | number | boolean,
  serverValue: JsonValue | undefined
): boolean {
  if (current === "") return serverValue === undefined || serverValue === "";
  if (serverValue === undefined || serverValue === null || typeof serverValue === "object") return false;
  const valueType = field.valueType ?? (field.type === "number" ? "number" : field.type === "checkbox" ? "boolean" : "string");
  if (valueType === "number" || valueType === "integer") return typeof serverValue === "number" && Number(current) === serverValue;
  if (valueType === "boolean") return typeof current === "boolean" && typeof serverValue === "boolean" && current === serverValue;
  return String(current) === String(serverValue);
}

function mergeInitialDrafts(
  current: Record<string, Record<string, string | number | boolean>>,
  requests: NativeInteractionRequest[]
): Record<string, Record<string, string | number | boolean>> {
  const next = { ...current };
  for (const request of requests) {
    if (next[request.id] || !request.inputValues) continue;
    next[request.id] = Object.fromEntries(Object.entries(request.inputValues).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))) as Record<string, string | number | boolean>;
  }
  return next;
}

function safeInteractionOptions(options: readonly NativeInteractionOption[]): boolean {
  const ids = options.map((option) => option.id);
  return ids.length > 0
    && ids.every((id) => Boolean(id))
    && options.every((option) => ["approve", "deny", "submit_input"].includes(option.decision))
    && new Set(ids).size === ids.length;
}

function interactionOperationKey(
  requestId: string,
  optionId: string,
  values: Record<string, JsonValue> | undefined
): string {
  return `respond:${requestId}:${optionId}:${values === undefined ? "no-input" : stableJson(values)}`;
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clearInteractionOperationIds(operationIds: Map<string, string>, requestId: string): void {
  for (const key of operationIds.keys()) {
    if (key.includes(`:${requestId}:`) || key.startsWith(`cancel:${requestId}:`)) operationIds.delete(key);
  }
}

function isInteractionRequestInScope(request: NativeInteractionRequest, roomId: string | undefined, target: NativeWorkspaceTarget | undefined): boolean {
  return Boolean(roomId && target && request.roomId === roomId && (!request.workspaceId || request.workspaceId === target.workspaceId));
}

function assertInteractionResponse(request: NativeInteractionRequest, previous: NativeInteractionRequest, roomId: string, target: NativeWorkspaceTarget | undefined): void {
  if (!target || !isInteractionRequestInScope(request, roomId, target) || request.id !== previous.id) throw new Error("interaction_request_response_mismatch");
}

function interactionUnavailableMessage(roomId: string | undefined, target: NativeWorkspaceTarget | undefined, operations: NativeInteractionRequestOperations | undefined): string | undefined {
  if (!target) return "現在の Workspace target がないため、確認要求は利用できません。";
  if (!roomId) return "Roomを選択すると、確認要求を表示できます。";
  if (!operations?.list) return "Serverの確認要求一覧経路が未接続です。操作は利用できません。";
  return undefined;
}

function interactionStatusLabel(status: NativeInteractionStatus): string {
  return ({
    pending: "応答待ち",
    accepted: "受付済み",
    denied: "拒否済み",
    cancelled: "取消済み",
    expired: "期限切れ",
    executing: "実行中",
    completed: "完了",
    failed: "失敗"
  } as const)[status];
}

function formatExpiry(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function scalarInputValue(value: string | number | boolean): string {
  return String(value);
}

function formatJson(value: JsonValue): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized.length <= 4_000) return serialized;
    return `${serialized.slice(0, 4_000)}\n…（表示を短縮）`;
  } catch {
    return "（結果を表示できません）";
  }
}

function domSafeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "-");
  return safe || "request";
}

export function nativeInteractionErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  if (message.includes("expired")) return "この要求は期限切れです。更新してServerの状態を確認してください。";
  if (message.includes("replayed") || message.includes("already_decided") || message.includes("conflict") || message.includes("version")) return "この要求には既に別の応答があります。更新してServerの結果を確認してください。";
  if (message.includes("permission") || message.includes("access")) return "現在の権限では、この要求へ応答できません。";
  if (message.includes("navigation_changed")) return "Workspaceが切り替わったため、結果を表示しません。現在のRoomで更新してください。";
  if (message.includes("target_guard_unavailable") || message.includes("target_unavailable")) return "現在のWorkspace targetを確認できないため、操作を保留しました。";
  if (message.includes("response_mismatch")) return "Serverの応答対象が一致しないため、結果を表示しませんでした。更新してください。";
  return message || "確認要求の処理に失敗しました。Serverの状態は変更されていない可能性があります。";
}

export default NativeInteractionRequests;
