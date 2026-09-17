import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  PublicShareDraft,
  PublicShareDraftCreateInput,
  PublicShareDraftDiscardResult,
  PublicShareDraftUpdateInput,
  PublicShareKind,
  PublicShareManifest,
  PublicSharePublishResult,
  PublicShareRevokeResult,
  PublicShareVisibility
} from "@samurai-agent/domain-api";

export type WorkspaceShareDialogStage = "select" | "edit" | "review" | "published";

export interface WorkspaceShareSource {
  kind: PublicShareKind;
  id: string;
  label: string;
}

export interface WorkspaceShareResourceOption {
  id: string;
  version: number;
  kind: "knowledge" | "skill";
  title: string;
  summary?: string;
}

export interface WorkspaceShareRecipientOption {
  accountId: string;
  label: string;
}

/** A display-only row. The component deliberately does not render share IDs or URLs. */
export interface WorkspaceSharePublishedSummary {
  shareId: string;
  version: number;
  title: string;
  visibility: PublicShareVisibility;
  status: "active" | "revoked";
  publishedAt: string;
  recipientLabels?: readonly string[];
  /** Kept in the closure for the explicit copy action, never rendered as text. */
  url?: string;
}

export interface WorkspaceShareDialogProps {
  source: WorkspaceShareSource;
  resources: readonly WorkspaceShareResourceOption[];
  recipientOptions?: readonly WorkspaceShareRecipientOption[];
  /** A saved draft can be supplied when a dialog is reopened. */
  draft?: PublicShareDraft | null;
  publishedShares?: readonly WorkspaceSharePublishedSummary[];
  open?: boolean;
  initialStage?: WorkspaceShareDialogStage;
  onCreateDraft: (input: PublicShareDraftCreateInput & { operationId: string }) => Promise<PublicShareDraft>;
  onUpdateDraft: (input: PublicShareDraftUpdateInput & { operationId: string }) => Promise<PublicShareDraft>;
  onDiscardDraft: (input: { draft_id: string; expected_version: number; operationId: string }) => Promise<PublicShareDraftDiscardResult>;
  onPublishDraft: (input: { draft_id: string; expected_version: number; expected_content_hash: string; operationId: string }) => Promise<PublicSharePublishResult>;
  onRevokeShare: (input: { share_id: string; expected_version: number; operationId: string }) => Promise<PublicShareRevokeResult>;
  onClose?: () => void;
  onPublished?: (result: PublicSharePublishResult) => void | Promise<void>;
}

export interface WorkspaceSharePublishedView {
  title: string;
  kind: PublicShareKind;
  visibility: PublicShareVisibility;
  manifest: PublicShareManifest;
  contentHash: string;
  publishedAt: string;
}

export interface WorkspaceShareViewProps {
  view: WorkspaceSharePublishedView;
  /** Restricted content is rendered only after the injected Account check. */
  authenticated?: boolean;
  onAuthenticate?: () => void | Promise<void>;
  onRequestImport?: () => void;
}

export const shareKindLabel: Record<PublicShareKind, string> = {
  room_knowledge: "Room Knowledge",
  agent: "Agent"
};

export const shareVisibilityLabel: Record<PublicShareVisibility, string> = {
  restricted: "限定共有",
  public: "公開リンク"
};

export function workspaceShareDraftCanPublish(draft: Pick<PublicShareDraft, "visibility" | "recipient_account_ids" | "content_hash" | "manifest">, dirty = false): boolean {
  if (dirty || !draft.content_hash || !draft.manifest.title.trim()) return false;
  return draft.visibility === "public" || draft.recipient_account_ids.length > 0;
}

/** A discard is accepted only when the Server confirms this exact draft. */
export function workspaceShareDiscardResultIsValid(result: unknown, draftId: string): result is PublicShareDraftDiscardResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const value = result as { draft_id?: unknown; discarded?: unknown };
  return value.draft_id === draftId && value.discarded === true;
}

export function workspaceShareErrorMessage(error: unknown, action: "draft" | "discard" | "publish" | "revoke" | "copy" = "draft"): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "";
  if (code.includes("permission") || code.includes("forbidden") || code.includes("unauthorized")) return "この操作を行う権限を確認してください。";
  if (code.includes("version") || code.includes("conflict")) return "共有内容の版が更新されています。現在の下書きを読み直して確認してください。";
  if (code.includes("revoked")) return "この共有はすでに停止されています。新しい下書きから再共有してください。";
  if (action === "copy") return "リンクをコピーできませんでした。端末のクリップボード権限を確認してください。";
  if (action === "discard") return "共有用の下書きを破棄できませんでした。版と権限を確認して再試行してください。";
  if (action === "publish") return "共有リンクを発行できませんでした。保存済みの内容と権限を確認して再試行してください。";
  if (action === "revoke") return "共有を停止できませんでした。状態を再読み込みして再試行してください。";
  return "共有用の下書きを保存できませんでした。入力と接続を確認して再試行してください。";
}

function cloneManifest(manifest: PublicShareManifest): PublicShareManifest {
  return {
    ...manifest,
    entries: manifest.entries.map((entry) => ({
      ...entry,
      files: entry.files.map((file) => ({ ...file }))
    })),
    ...(manifest.agent ? { agent: { ...manifest.agent } } : {})
  };
}

function newShareOperationId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    // Continue to the local fallback for older WebViews without Web Crypto.
  }
  return `share-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatShareDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時未確認";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function draftCreateInput(source: WorkspaceShareSource, selected: readonly WorkspaceShareResourceOption[]): PublicShareDraftCreateInput {
  return {
    source_kind: source.kind,
    source_id: source.id,
    resource_refs: selected.map((resource) => ({ id: resource.id, version: resource.version }))
  };
}

function ManifestPreview({ manifest, showContent = true }: { manifest: PublicShareManifest; showContent?: boolean }) {
  return <div className="workspace-share-manifest" aria-label="共有される内容">
    <div className="workspace-share-manifest__heading">
      <strong>{manifest.title}</strong>
      <span>{manifest.entries.length}件の内容</span>
    </div>
    {manifest.agent ? <article className="workspace-share-manifest__agent">
      <span className="workspace-share-dialog__eyebrow">Agent構成</span>
      <h4>{manifest.agent.name}</h4>
      <p>{manifest.agent.role}</p>
      {showContent ? <p className="workspace-share-manifest__body">{manifest.agent.instructions}</p> : null}
    </article> : null}
    <ul className="workspace-share-manifest__entries">
      {manifest.entries.map((entry) => <li key={entry.entry_id}>
        <div className="workspace-share-manifest__entry-title">
          <strong>{entry.title}</strong>
          <span>{entry.kind === "knowledge" ? "Knowledge" : "Skill"}{entry.files.length ? `・添付${entry.files.length}件` : ""}</span>
        </div>
        {showContent ? <p className="workspace-share-manifest__body">{entry.content}</p> : null}
      </li>)}
    </ul>
  </div>;
}

export function WorkspaceShareView({ view, authenticated = false, onAuthenticate, onRequestImport }: WorkspaceShareViewProps) {
  const restricted = view.visibility === "restricted";
  if (restricted && !authenticated) {
    return <section className="workspace-share-view" aria-labelledby="workspace-share-view-title">
      <style>{workspaceShareStyles}</style>
      <span className="workspace-share-dialog__eyebrow">共有リンク</span>
      <h2 id="workspace-share-view-title">{view.title}</h2>
      <p className="workspace-share-view__notice" role="alert">この共有は指定されたAccountだけが表示できます。本人確認後に内容を確認してください。</p>
      {onAuthenticate ? <button type="button" className="workspace-share-dialog__primary" onClick={() => void onAuthenticate()}>本人確認へ進む</button> : null}
    </section>;
  }
  return <section className="workspace-share-view" aria-labelledby="workspace-share-view-title">
    <style>{workspaceShareStyles}</style>
    <span className="workspace-share-dialog__eyebrow">{shareKindLabel[view.kind]}</span>
    <h2 id="workspace-share-view-title">{view.title}</h2>
    <p className="workspace-share-view__meta">{shareVisibilityLabel[view.visibility]}・発行日 {formatShareDate(view.publishedAt)}</p>
    <ManifestPreview manifest={view.manifest} />
    <p className="workspace-share-view__notice">この内容は共有時点の固定コピーです。元のRoomやAgentの権限・履歴は共有されません。</p>
    {onRequestImport ? <button type="button" className="workspace-share-dialog__primary" onClick={onRequestImport}>取り込み先を確認する</button> : null}
  </section>;
}

export default function WorkspaceShareDialog({
  source,
  resources,
  recipientOptions = [],
  draft: incomingDraft = null,
  publishedShares = [],
  open = true,
  initialStage = incomingDraft ? "edit" : "select",
  onCreateDraft,
  onUpdateDraft,
  onDiscardDraft,
  onPublishDraft,
  onRevokeShare,
  onClose,
  onPublished
}: WorkspaceShareDialogProps) {
  const [stage, setStage] = useState<WorkspaceShareDialogStage>(initialStage);
  // Sharing is opt-in: the user must explicitly choose every resource that is
  // copied into the fixed share.  This also keeps a reopened dialog from
  // accidentally publishing a newly-added resource.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [activeDraft, setActiveDraft] = useState<PublicShareDraft | null>(incomingDraft);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"create" | "save" | "discard" | "publish" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closePrompt, setClosePrompt] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [discardAfterClose, setDiscardAfterClose] = useState(false);
  const [publishedResult, setPublishedResult] = useState<WorkspaceSharePublishedSummary | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const createOperationId = useRef(newShareOperationId());
  const saveOperationId = useRef(newShareOperationId());
  const publishOperationId = useRef(newShareOperationId());
  const discardOperationIds = useRef(new Map<string, string>());
  const revokeOperationIds = useRef(new Map<string, string>());
  const sourceKey = `${source.kind}:${source.id}`;
  const previousSourceKey = useRef(sourceKey);
  const incomingDraftKey = incomingDraft ? `${incomingDraft.draft_id}:${incomingDraft.version}:${incomingDraft.content_hash}` : "";
  const previousIncomingDraftKey = useRef(incomingDraftKey);
  const activeDraftRef = useRef<PublicShareDraft | null>(activeDraft);
  activeDraftRef.current = activeDraft;

  useEffect(() => {
    if (previousSourceKey.current === sourceKey) return;
    previousSourceKey.current = sourceKey;
    setStage("select");
    setSelectedIds(new Set());
    setActiveDraft(null);
    setDirty(false);
    setError(null);
    setClosePrompt(false);
    setDiscardPrompt(false);
    setDiscardAfterClose(false);
  }, [sourceKey]);

  useEffect(() => {
    if (previousIncomingDraftKey.current === incomingDraftKey) return;
    previousIncomingDraftKey.current = incomingDraftKey;
    setActiveDraft(incomingDraft);
    setDirty(false);
    setClosePrompt(false);
    setDiscardPrompt(false);
    setDiscardAfterClose(false);
    if (incomingDraft) setStage("edit");
  }, [incomingDraft, incomingDraftKey]);

  const selectableResources = useMemo(() => source.kind === "room_knowledge"
    ? resources.filter((resource) => resource.kind === "knowledge")
    : resources, [resources, source.kind]);
  const mergedPublishedShares = useMemo(() => {
    const merged = new Map(publishedShares.map((share) => [share.shareId, share]));
    if (publishedResult) merged.set(publishedResult.shareId, publishedResult);
    return [...merged.values()];
  }, [publishedResult, publishedShares]);
  const selectedResources = selectableResources.filter((resource) => selectedIds.has(resource.id));
  const canStartDraft = source.kind === "agent" || selectedResources.length > 0;
  const canPublish = Boolean(activeDraft && workspaceShareDraftCanPublish(activeDraft, dirty));

  if (!open) return null;

  const setManifest = (update: (manifest: PublicShareManifest) => PublicShareManifest) => {
    setActiveDraft((current) => current ? { ...current, manifest: update(cloneManifest(current.manifest)) } : current);
    setDirty(true);
  };

  const createDraft = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canStartDraft || busy) return;
    setBusy("create");
    setError(null);
    try {
      const created = await onCreateDraft({ ...draftCreateInput(source, selectedResources), operationId: createOperationId.current });
      setActiveDraft(created);
      setDirty(false);
      setStage("edit");
      createOperationId.current = newShareOperationId();
    } catch (cause) {
      setError(workspaceShareErrorMessage(cause, "draft"));
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!activeDraft || busy === "save") return false;
    setBusy("save");
    setError(null);
    try {
      const saved = await onUpdateDraft({
        draft_id: activeDraft.draft_id,
        expected_version: activeDraft.version,
        manifest: activeDraft.manifest,
        visibility: activeDraft.visibility,
        recipient_account_ids: activeDraft.recipient_account_ids,
        operationId: saveOperationId.current
      });
      setActiveDraft(saved);
      setDirty(false);
      saveOperationId.current = newShareOperationId();
      return true;
    } catch (cause) {
      setError(workspaceShareErrorMessage(cause, "draft"));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /**
   * A saved draft is removed only after the Server confirms the state
   * transition.  The operation ID is retained per draft while a request is
   * failing so a retry is idempotent; a local close is never treated as a
   * successful discard.
   */
  const discardDraft = async (closeAfter: boolean): Promise<boolean> => {
    if (!activeDraft || stage === "published" || busy) return false;
    const draftAtRequest = activeDraft;
    const operationId = discardOperationIds.current.get(draftAtRequest.draft_id) ?? newShareOperationId();
    discardOperationIds.current.set(draftAtRequest.draft_id, operationId);
    setBusy("discard");
    setError(null);
    try {
      const result = await onDiscardDraft({
        draft_id: draftAtRequest.draft_id,
        expected_version: draftAtRequest.version,
        operationId
      });
      if (!workspaceShareDiscardResultIsValid(result, draftAtRequest.draft_id)) {
        throw new Error("share_draft_discard_response_invalid");
      }
      const currentDraft = activeDraftRef.current;
      if (!currentDraft || currentDraft.draft_id !== draftAtRequest.draft_id
        || currentDraft.version !== draftAtRequest.version) {
        throw new Error("share_draft_discard_state_changed");
      }
      discardOperationIds.current.delete(draftAtRequest.draft_id);
      setActiveDraft(null);
      setSelectedIds(new Set());
      setDirty(false);
      setClosePrompt(false);
      setDiscardPrompt(false);
      setDiscardAfterClose(false);
      setError(null);
      setStage("select");
      if (closeAfter) onClose?.();
      return true;
    } catch (cause) {
      setError(workspaceShareErrorMessage(cause, "discard"));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const requestDiscardDraft = (closeAfter: boolean): void => {
    if (!activeDraft || stage === "published" || busy) return;
    setDiscardAfterClose(closeAfter);
    if (closeAfter) setClosePrompt(false);
    setDiscardPrompt(true);
  };

  const moveToReview = async () => {
    if (!activeDraft || busy) return;
    if (!await saveDraft()) return;
    setStage("review");
  };

  const publish = async () => {
    if (!activeDraft || !canPublish || busy) return;
    setBusy("publish");
    setError(null);
    try {
      const result = await onPublishDraft({
        draft_id: activeDraft.draft_id,
        expected_version: activeDraft.version,
        expected_content_hash: activeDraft.content_hash,
        operationId: publishOperationId.current
      });
      const published: WorkspaceSharePublishedSummary = {
        shareId: result.share_id,
        version: result.version,
        title: activeDraft.manifest.title,
        visibility: activeDraft.visibility,
        status: "active",
        publishedAt: result.published_at,
        recipientLabels: activeDraft.recipient_account_ids.map((id) => recipientOptions.find((option) => option.accountId === id)?.label ?? "指定済みの受信者"),
        url: result.url
      };
      setPublishedResult(published);
      setStage("published");
      publishOperationId.current = newShareOperationId();
      await onPublished?.(result);
    } catch (cause) {
      setError(workspaceShareErrorMessage(cause, "publish"));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (share: WorkspaceSharePublishedSummary) => {
    if (busy === "revoke") return;
    const operationId = revokeOperationIds.current.get(share.shareId) ?? newShareOperationId();
    revokeOperationIds.current.set(share.shareId, operationId);
    setBusy("revoke");
    setError(null);
    try {
      const result = await onRevokeShare({ share_id: share.shareId, expected_version: share.version, operationId });
      setPublishedResult((current) => current?.shareId === share.shareId ? { ...current, status: "revoked", version: result.version } : current);
      setPendingRevoke(null);
      revokeOperationIds.current.delete(share.shareId);
    } catch (cause) {
      setError(workspaceShareErrorMessage(cause, "revoke"));
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async (share: WorkspaceSharePublishedSummary) => {
    if (!share.url || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setCopyState("copy-failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(share.url);
      setCopyState(share.shareId);
    } catch {
      setCopyState("copy-failed");
    }
  };

  const close = () => {
    if (dirty) setClosePrompt(true);
    else onClose?.();
  };

  const saveAndClose = async () => {
    if (await saveDraft()) onClose?.();
  };

  const updateVisibility = (visibility: PublicShareVisibility) => {
    setActiveDraft((current) => current ? {
      ...current,
      visibility,
      recipient_account_ids: visibility === "public" ? [] : current.recipient_account_ids
    } : current);
    setDirty(true);
  };

  const toggleRecipient = (accountId: string) => {
    setActiveDraft((current) => {
      if (!current) return current;
      const currentIds = new Set(current.recipient_account_ids);
      if (currentIds.has(accountId)) currentIds.delete(accountId);
      else currentIds.add(accountId);
      return { ...current, recipient_account_ids: [...currentIds] };
    });
    setDirty(true);
  };

  return <>
    <style>{workspaceShareStyles}</style>
    <section className="workspace-share-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-share-dialog-title" aria-busy={busy !== null}>
      <header className="workspace-share-dialog__header">
        <div>
          <span className="workspace-share-dialog__eyebrow">共有</span>
          <h2 id="workspace-share-dialog-title">{source.kind === "room_knowledge" ? "Room Knowledgeを共有" : "Agentを共有"}</h2>
          <p className="workspace-share-dialog__scope">対象: {source.label}</p>
        </div>
        {onClose ? <button type="button" className="workspace-share-dialog__close" onClick={close} aria-label="共有を閉じる">×</button> : null}
      </header>

      <div className="workspace-share-dialog__status" aria-live="polite">
        {error ? <p className="workspace-share-dialog__error" role="alert">{error}</p> : null}
        {busy ? <p role="status">{busy === "create" ? "共有用の下書きを作成しています…" : busy === "save" ? "下書きを保存しています…" : busy === "discard" ? "保存済み下書きを破棄しています…" : busy === "publish" ? "共有リンクを発行しています…" : "共有を停止しています…"}</p> : null}
        {copyState === "copy-failed" ? <p className="workspace-share-dialog__error" role="alert">{workspaceShareErrorMessage(new Error("clipboard"), "copy")}</p> : null}
        {copyState && copyState !== "copy-failed" ? <p role="status">共有リンクをクリップボードへコピーしました。</p> : null}
      </div>

      {stage === "select" ? <form className="workspace-share-dialog__body" onSubmit={(event) => void createDraft(event)}>
        <div className="workspace-share-dialog__card">
          <h3>共有する内容を選択</h3>
          <p className="workspace-share-dialog__muted">元のRoom、会話、設定、認証情報は共有用コピーへ入りません。</p>
          {source.kind === "agent" ? <div className="workspace-share-dialog__required" role="status">
            <strong>Agentの基本構成</strong>
            <span>名前・役割・指示を含めます（必須）。Backendの認証情報や参加Roomは含めません。</span>
          </div> : null}
          {selectableResources.length === 0 ? <p className="workspace-share-dialog__empty" role="status">選択できる内容がありません。</p> : <ul className="workspace-share-dialog__resource-list">
            {selectableResources.map((resource) => <li key={`${resource.kind}:${resource.id}`}>
              <label className="workspace-share-dialog__resource">
                <input
                  type="checkbox"
                  checked={selectedIds.has(resource.id)}
                  onChange={() => setSelectedIds((current) => {
                    const next = new Set(current);
                    if (next.has(resource.id)) next.delete(resource.id);
                    else next.add(resource.id);
                    return next;
                  })}
                />
                <span><strong>{resource.title}</strong><small>{resource.kind === "knowledge" ? "Knowledge" : "Skill"}・確認済み版 {resource.version}</small>{resource.summary ? <em>{resource.summary}</em> : null}</span>
              </label>
            </li>)}
          </ul>}
          {source.kind === "room_knowledge" && selectableResources.length > 0 && selectedResources.length === 0 ? <p className="workspace-share-dialog__warning" role="alert">少なくとも1件のKnowledgeを選択してください。</p> : null}
        </div>
        <div className="workspace-share-dialog__actions">
          <button type="submit" className="workspace-share-dialog__primary" disabled={!canStartDraft || busy !== null}>共有用コピーを編集</button>
        </div>
      </form> : null}

      {stage === "edit" && activeDraft ? <form className="workspace-share-dialog__body" onSubmit={(event) => { event.preventDefault(); void moveToReview(); }}>
        <div className="workspace-share-dialog__card">
          <h3>共有用コピーを編集</h3>
          <p className="workspace-share-dialog__muted">元データとは別の固定コピーです。ここでの編集は元のRoomやAgentを変更しません。</p>
          <label>共有題名<input value={activeDraft.manifest.title} onChange={(event) => setManifest((manifest) => ({ ...manifest, title: event.currentTarget.value }))} maxLength={200} /></label>
          <fieldset className="workspace-share-dialog__visibility">
            <legend>公開範囲</legend>
            <label><input type="radio" name="workspace-share-visibility" checked={activeDraft.visibility === "restricted"} onChange={() => updateVisibility("restricted")} />限定共有</label>
            <label><input type="radio" name="workspace-share-visibility" checked={activeDraft.visibility === "public"} onChange={() => updateVisibility("public")} />公開リンク</label>
          </fieldset>
          {activeDraft.visibility === "restricted" ? <fieldset className="workspace-share-dialog__recipients">
            <legend>受信Account</legend>
            <p className="workspace-share-dialog__muted">受信者の表示名だけを表示します。指定したAccount以外は内容を表示できません。</p>
            {recipientOptions.length === 0 ? <p className="workspace-share-dialog__empty">選択可能な受信Accountがありません。</p> : recipientOptions.map((recipient) => <label key={recipient.accountId}><input type="checkbox" checked={activeDraft.recipient_account_ids.includes(recipient.accountId)} onChange={() => toggleRecipient(recipient.accountId)} />{recipient.label}</label>)}
            {recipientOptions.length > 0 && activeDraft.recipient_account_ids.length === 0 ? <p className="workspace-share-dialog__warning" role="alert">限定共有には受信Accountを1人以上指定してください。</p> : null}
          </fieldset> : <p className="workspace-share-dialog__notice">リンクを知っている人はログインなしで閲覧できます。公開する内容を確認してください。</p>}
        </div>
        <div className="workspace-share-dialog__card">
          <h3>内容</h3>
          {activeDraft.manifest.agent ? <div className="workspace-share-dialog__agent-editor">
            <label>Agent名<input value={activeDraft.manifest.agent.name} onChange={(event) => setManifest((manifest) => ({ ...manifest, agent: manifest.agent ? { ...manifest.agent, name: event.currentTarget.value } : undefined }))} /></label>
            <label>役割<input value={activeDraft.manifest.agent.role} onChange={(event) => setManifest((manifest) => ({ ...manifest, agent: manifest.agent ? { ...manifest.agent, role: event.currentTarget.value } : undefined }))} /></label>
            <label>指示<textarea value={activeDraft.manifest.agent.instructions} onChange={(event) => setManifest((manifest) => ({ ...manifest, agent: manifest.agent ? { ...manifest.agent, instructions: event.currentTarget.value } : undefined }))} /></label>
          </div> : null}
          <ul className="workspace-share-dialog__entry-editor">
            {activeDraft.manifest.entries.map((entry, index) => <li key={entry.entry_id}>
              <span className="workspace-share-dialog__entry-kind">{entry.kind === "knowledge" ? "Knowledge" : "Skill"}</span>
              <label>題名<input value={entry.title} onChange={(event) => setManifest((manifest) => ({ ...manifest, entries: manifest.entries.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, title: event.currentTarget.value } : candidate) }))} /></label>
              <label>本文<textarea value={entry.content} onChange={(event) => setManifest((manifest) => ({ ...manifest, entries: manifest.entries.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, content: event.currentTarget.value } : candidate) }))} /></label>
              {entry.files.length ? <p className="workspace-share-dialog__muted">添付ファイル {entry.files.length}件（内容は固定コピーに含まれます）</p> : null}
            </li>)}
          </ul>
          {activeDraft.removed_references.length ? <p className="workspace-share-dialog__notice">非公開参照 {activeDraft.removed_references.length}件を共有用コピーから除外しました。</p> : null}
        </div>
        <div className="workspace-share-dialog__actions">
          <button type="button" className="workspace-share-dialog__secondary" onClick={() => setStage("select")} disabled={busy !== null}>戻る</button>
          <button type="button" className="workspace-share-dialog__danger" onClick={() => requestDiscardDraft(false)} disabled={busy !== null}>保存済み下書きを破棄</button>
          <button type="submit" className="workspace-share-dialog__primary" disabled={busy !== null || (activeDraft.visibility === "restricted" && activeDraft.recipient_account_ids.length === 0)}>保存して確認</button>
        </div>
      </form> : null}

      {stage === "review" && activeDraft ? <div className="workspace-share-dialog__body">
        <div className="workspace-share-dialog__card">
          <h3>発行前の最終確認</h3>
          <p className="workspace-share-dialog__muted">以下の固定コピーだけが共有されます。発行後に元データが変わっても、この内容は変わりません。</p>
          <dl className="workspace-share-dialog__facts">
            <div><dt>種別</dt><dd>{shareKindLabel[source.kind]}</dd></div>
            <div><dt>公開範囲</dt><dd>{shareVisibilityLabel[activeDraft.visibility]}</dd></div>
            {activeDraft.visibility === "restricted" ? <div><dt>受信Account</dt><dd>{activeDraft.recipient_account_ids.length}人（表示名は共有管理で確認できます）</dd></div> : null}
            <div><dt>内容ハッシュ</dt><dd>確認済みの固定版</dd></div>
          </dl>
          <ManifestPreview manifest={activeDraft.manifest} />
          <p className="workspace-share-dialog__warning">共有を停止しても、相手がすでに取得した独立コピーを回収することはできません。</p>
        </div>
        <div className="workspace-share-dialog__actions">
          <button type="button" className="workspace-share-dialog__secondary" onClick={() => setStage("edit")} disabled={busy !== null}>編集へ戻る</button>
          <button type="button" className="workspace-share-dialog__danger" onClick={() => requestDiscardDraft(false)} disabled={busy !== null}>保存済み下書きを破棄</button>
          <button type="button" className="workspace-share-dialog__primary" onClick={() => void publish()} disabled={!canPublish || busy !== null}>共有リンクを発行</button>
        </div>
      </div> : null}

      {stage === "published" && publishedResult ? <div className="workspace-share-dialog__body">
        <div className="workspace-share-dialog__card workspace-share-dialog__success">
          <h3>共有リンクを発行しました</h3>
          <p>発行済みの内容は固定コピーです。リンクは表示せず、必要なときだけ明示操作でコピーします。</p>
          <button type="button" className="workspace-share-dialog__primary" onClick={() => void copyLink(publishedResult)}>リンクをコピー</button>
        </div>
      </div> : null}

      {mergedPublishedShares.length > 0 ? <section className="workspace-share-dialog__management" aria-labelledby="workspace-share-dialog-management-title">
        <h3 id="workspace-share-dialog-management-title">発行済みの共有</h3>
        <p className="workspace-share-dialog__muted">停止しても、すでに取得された独立コピーは残ります。停止済みリンクは再有効化しません。</p>
        <ul className="workspace-share-dialog__published-list">
          {mergedPublishedShares.map((share) => <li key={share.shareId}>
            <div><strong>{share.title}</strong><span>{shareVisibilityLabel[share.visibility]}・{formatShareDate(share.publishedAt)}・{share.status === "active" ? "有効" : "停止済み"}</span></div>
            <div className="workspace-share-dialog__published-actions">
              {share.status === "active" ? <>
                <button type="button" className="workspace-share-dialog__secondary" onClick={() => void copyLink(share)} disabled={!share.url || busy !== null}>リンクをコピー</button>
                {pendingRevoke === share.shareId ? <>
                  <button type="button" className="workspace-share-dialog__danger" onClick={() => void revoke(share)} disabled={busy !== null}>停止を確定</button>
                  <button type="button" className="workspace-share-dialog__secondary" onClick={() => setPendingRevoke(null)} disabled={busy !== null}>戻る</button>
                </> : <button type="button" className="workspace-share-dialog__danger" onClick={() => setPendingRevoke(share.shareId)} disabled={busy !== null}>共有を停止</button>}
              </> : <span className="workspace-share-dialog__muted">停止済み</span>}
            </div>
          </li>)}
        </ul>
      </section> : null}

      {closePrompt ? <div className="workspace-share-dialog__close-prompt" role="alertdialog" aria-modal="true" aria-labelledby="workspace-share-close-title">
        <h3 id="workspace-share-close-title">未保存の編集があります</h3>
        <p>保存済みの下書きは残ります。未保存の編集をどうしますか。</p>
        <div className="workspace-share-dialog__actions">
          <button type="button" className="workspace-share-dialog__primary" onClick={() => void saveAndClose()} disabled={busy !== null}>保存して閉じる</button>
          <button type="button" className="workspace-share-dialog__secondary" onClick={() => onClose?.()} disabled={busy !== null}>編集だけ破棄して閉じる</button>
          <button type="button" className="workspace-share-dialog__danger" onClick={() => requestDiscardDraft(true)} disabled={busy !== null}>保存済み下書きも破棄</button>
          <button type="button" className="workspace-share-dialog__secondary" onClick={() => setClosePrompt(false)} disabled={busy !== null}>編集を続ける</button>
        </div>
      </div> : null}

      {discardPrompt ? <div className="workspace-share-dialog__close-prompt" role="alertdialog" aria-modal="true" aria-labelledby="workspace-share-discard-title">
        <h3 id="workspace-share-discard-title">保存済み下書きを破棄しますか</h3>
        <p>保存済みの共有下書きと未保存の編集を破棄します。発行済みの共有は停止しません。</p>
        <div className="workspace-share-dialog__actions">
          <button type="button" className="workspace-share-dialog__danger" onClick={() => void discardDraft(discardAfterClose)} disabled={busy !== null}>破棄を確定</button>
          <button type="button" className="workspace-share-dialog__secondary" onClick={() => { setDiscardPrompt(false); setDiscardAfterClose(false); }} disabled={busy !== null}>戻る</button>
        </div>
      </div> : null}
    </section>
  </>;
}

const workspaceShareStyles = `
.workspace-share-dialog, .workspace-share-view { --share-ink: var(--native-copy, #edf2eb); --share-muted: var(--native-muted, #a4afa7); --share-line: var(--native-line, rgba(204,218,209,.14)); --share-accent: var(--native-accent, #f1a65c); --share-danger: var(--native-danger, #ee8981); box-sizing: border-box; color: var(--share-ink); max-height: min(920px, calc(100vh - 32px)); overflow: auto; padding: clamp(18px, 3vw, 32px); width: min(780px, calc(100vw - 32px)); }
.workspace-share-dialog *, .workspace-share-view * { box-sizing: border-box; }
.workspace-share-dialog__header { align-items: flex-start; display: flex; gap: 20px; justify-content: space-between; }
.workspace-share-dialog__header h2, .workspace-share-view h2 { font-family: Georgia, "Times New Roman", serif; font-size: clamp(24px, 3vw, 34px); letter-spacing: -.035em; line-height: 1.05; margin: 5px 0 0; }
.workspace-share-dialog__eyebrow { color: var(--share-accent); display: block; font-size: 10px; font-weight: 800; letter-spacing: .15em; text-transform: uppercase; }
.workspace-share-dialog__scope, .workspace-share-view__meta { color: var(--share-muted); font-size: 12px; margin: 9px 0 0; }
.workspace-share-dialog__close { background: transparent; border: 1px solid var(--share-line); border-radius: 9px; color: var(--share-muted); cursor: pointer; font-size: 21px; height: 36px; width: 36px; }
.workspace-share-dialog__close:hover, .workspace-share-dialog button:hover { filter: brightness(1.08); }
.workspace-share-dialog__status { min-height: 25px; margin-top: 15px; }
.workspace-share-dialog__status p { margin: 0; }
.workspace-share-dialog__error { color: var(--share-danger); }
.workspace-share-dialog__body { display: grid; gap: 14px; margin-top: 16px; }
.workspace-share-dialog__card, .workspace-share-dialog__management, .workspace-share-view { background: linear-gradient(145deg, rgba(28,37,32,.92), rgba(16,22,19,.96)); border: 1px solid var(--share-line); border-radius: 15px; padding: clamp(15px, 2.2vw, 23px); }
.workspace-share-dialog__card h3, .workspace-share-dialog__management h3 { font-size: 14px; margin: 0; }
.workspace-share-dialog__card > p, .workspace-share-dialog__management > p { line-height: 1.55; }
.workspace-share-dialog__muted { color: var(--share-muted); font-size: 12px; line-height: 1.5; }
.workspace-share-dialog__empty, .workspace-share-dialog__notice, .workspace-share-dialog__warning, .workspace-share-view__notice { border-left: 3px solid var(--share-accent); color: var(--share-muted); font-size: 12px; line-height: 1.55; padding-left: 10px; }
.workspace-share-dialog__warning { color: var(--share-accent); }
.workspace-share-dialog__required { background: rgba(241,166,92,.08); border: 1px solid rgba(241,166,92,.27); border-radius: 10px; display: grid; gap: 4px; margin-top: 14px; padding: 11px 12px; }
.workspace-share-dialog__required span { color: var(--share-muted); font-size: 12px; }
.workspace-share-dialog__resource-list, .workspace-share-dialog__entry-editor, .workspace-share-dialog__published-list { display: grid; gap: 8px; list-style: none; margin: 15px 0 0; padding: 0; }
.workspace-share-dialog__resource { align-items: flex-start; border: 1px solid var(--share-line); border-radius: 10px; cursor: pointer; display: flex; gap: 10px; padding: 11px 12px; }
.workspace-share-dialog__resource:hover { background: rgba(255,255,255,.04); }
.workspace-share-dialog__resource span { display: grid; gap: 3px; }
.workspace-share-dialog__resource small, .workspace-share-dialog__resource em { color: var(--share-muted); font-size: 11px; font-style: normal; }
.workspace-share-dialog label { color: var(--share-muted); display: grid; font-size: 11px; font-weight: 700; gap: 6px; }
.workspace-share-dialog input:not([type="checkbox"]):not([type="radio"]), .workspace-share-dialog textarea { background: rgba(0,0,0,.2); border: 1px solid rgba(204,218,209,.25); border-radius: 8px; color: inherit; font: inherit; padding: 9px 10px; width: 100%; }
.workspace-share-dialog textarea { min-height: 100px; resize: vertical; }
.workspace-share-dialog input:focus-visible, .workspace-share-dialog textarea:focus-visible, .workspace-share-dialog button:focus-visible { outline: 2px solid var(--share-accent); outline-offset: 2px; }
.workspace-share-dialog__visibility, .workspace-share-dialog__recipients { border: 0; display: flex; flex-wrap: wrap; gap: 10px 16px; margin: 18px 0 0; padding: 0; }
.workspace-share-dialog__visibility legend, .workspace-share-dialog__recipients legend { color: var(--share-muted); font-size: 11px; font-weight: 700; margin-bottom: 7px; width: 100%; }
.workspace-share-dialog__visibility label, .workspace-share-dialog__recipients label { align-items: center; display: flex; font-weight: 500; gap: 6px; }
.workspace-share-dialog__agent-editor { display: grid; gap: 11px; margin-top: 15px; }
.workspace-share-dialog__entry-editor > li { border-top: 1px solid var(--share-line); display: grid; gap: 10px; padding: 14px 0 0; }
.workspace-share-dialog__entry-kind { color: var(--share-accent); font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.workspace-share-dialog__actions { display: flex; flex-wrap: wrap; gap: 9px; justify-content: flex-end; }
.workspace-share-dialog button { cursor: pointer; font: inherit; }
.workspace-share-dialog button:disabled { cursor: not-allowed; opacity: .52; }
.workspace-share-dialog__primary, .workspace-share-dialog__secondary, .workspace-share-dialog__danger { border-radius: 8px; font-size: 12px; font-weight: 750; min-height: 35px; padding: 8px 12px; }
.workspace-share-dialog__primary { background: var(--share-accent); border: 1px solid var(--share-accent); color: #2b190b; }
.workspace-share-dialog__secondary { background: rgba(255,255,255,.04); border: 1px solid rgba(204,218,209,.25); color: inherit; }
.workspace-share-dialog__danger { background: transparent; border: 1px solid rgba(238,137,129,.5); color: var(--share-danger); }
.workspace-share-dialog__facts { display: grid; gap: 8px; margin: 16px 0; }
.workspace-share-dialog__facts div { align-items: baseline; display: flex; gap: 10px; }
.workspace-share-dialog__facts dt { color: var(--share-muted); font-size: 11px; min-width: 82px; }
.workspace-share-dialog__facts dd { font-size: 12px; margin: 0; }
.workspace-share-dialog__success { border-color: rgba(138,216,178,.4); }
.workspace-share-dialog__management { margin-top: 16px; }
.workspace-share-dialog__published-list > li { align-items: center; border-top: 1px solid var(--share-line); display: flex; gap: 12px; justify-content: space-between; padding-top: 11px; }
.workspace-share-dialog__published-list > li > div:first-child { display: grid; gap: 3px; min-width: 0; }
.workspace-share-dialog__published-list span { color: var(--share-muted); font-size: 11px; }
.workspace-share-dialog__published-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.workspace-share-dialog__close-prompt { background: rgba(13,17,16,.98); border: 1px solid rgba(241,166,92,.4); border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.4); margin-top: 16px; padding: 16px; }
.workspace-share-dialog__close-prompt h3 { font-size: 14px; margin: 0; }
.workspace-share-dialog__close-prompt p { color: var(--share-muted); font-size: 12px; line-height: 1.5; }
.workspace-share-manifest { display: grid; gap: 11px; margin-top: 15px; }
.workspace-share-manifest__heading, .workspace-share-manifest__entry-title { align-items: baseline; display: flex; gap: 9px; justify-content: space-between; }
.workspace-share-manifest__heading span, .workspace-share-manifest__entry-title span { color: var(--share-muted); font-size: 11px; }
.workspace-share-manifest__agent, .workspace-share-manifest__entries > li { border-top: 1px solid var(--share-line); padding-top: 11px; }
.workspace-share-manifest__agent h4 { margin: 5px 0 0; }
.workspace-share-manifest__agent p, .workspace-share-manifest__body { color: var(--share-muted); font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
.workspace-share-manifest__entries { display: grid; gap: 12px; list-style: none; margin: 0; padding: 0; }
@media (max-width: 620px) { .workspace-share-dialog, .workspace-share-view { padding: 18px; width: calc(100vw - 20px); } .workspace-share-dialog__published-list > li { align-items: flex-start; flex-direction: column; } .workspace-share-dialog__published-actions { justify-content: flex-start; } }
`;
