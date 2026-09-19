import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  PublicShareImportResult,
  PublicShareKind
} from "@samurai-agent/domain-api";
import { WorkspaceShareView, type WorkspaceSharePublishedView } from "./WorkspaceShareDialog";

export interface WorkspaceShareImportSource {
  /** Opaque signed input. It is passed to the injected Core adapter only. */
  sourceOrigin: string;
  locator: string;
  claimId: string;
  contentHash: string;
  delegation: unknown;
}

export interface WorkspaceShareImportWorkspace {
  id: string;
  name: string;
  canImport?: boolean;
  /** Opaque target identity used to distinguish same-ID Workspaces on connections. */
  targetKey?: string;
}

export interface WorkspaceShareImportRoom {
  id: string;
  workspaceId: string;
  name: string;
  canImport?: boolean;
  /** Keeps Rooms from same-ID Workspaces on different targets separate. */
  workspaceTargetKey?: string;
}

export interface WorkspaceShareImportStartInput {
  source: WorkspaceShareImportSource;
  workspaceId: string;
  workspaceTargetKey?: string;
  roomId?: string;
  operationId: string;
}

export interface WorkspaceShareImportStatusInput {
  workspaceId: string;
  workspaceTargetKey?: string;
  roomId?: string;
  operationId: string;
}

export interface WorkspaceShareImportProps {
  view: WorkspaceSharePublishedView;
  source?: WorkspaceShareImportSource;
  authenticated: boolean;
  authenticating?: boolean;
  workspaces: readonly WorkspaceShareImportWorkspace[];
  rooms?: readonly WorkspaceShareImportRoom[];
  initialStatus?: PublicShareImportResult | null;
  initialOperationId?: string;
  onAuthenticate?: () => void | Promise<void>;
  onStartImport: (input: WorkspaceShareImportStartInput) => Promise<PublicShareImportResult>;
  onGetStatus: (input: WorkspaceShareImportStatusInput) => Promise<PublicShareImportResult>;
  onClose?: () => void;
}

function newImportOperationId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    // Continue to the local fallback for older WebViews without Web Crypto.
  }
  return `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function workspaceShareImportStatusLabel(status: PublicShareImportResult["status"]): string {
  if (status === "committed") return "取り込み完了";
  if (status === "failed") return "取り込み失敗";
  return "取り込み処理中";
}

export function workspaceShareImportCanStart(input: {
  authenticated: boolean;
  confirmed: boolean;
  hasSource: boolean;
  workspaceId: string;
  kind: PublicShareKind;
  roomId: string;
  status?: PublicShareImportResult["status"];
}): boolean {
  if (!input.authenticated || !input.confirmed || !input.hasSource || !input.workspaceId) return false;
  if (input.kind === "room_knowledge" && !input.roomId) return false;
  return input.status !== "committed" && input.status !== "staging";
}

function importStatusMessage(status: PublicShareImportResult): string {
  if (status.status === "staging") return `処理中です（${status.phase}）。同じ操作の状態を再表示できます。`;
  if (status.status === "committed") {
    const count = status.created_resource_ids.length;
    return status.kind === "agent"
      ? "新しいAgentの独立コピーを作成しました。実行接続や既定Agentは自動変更していません。"
      : `${count}件のKnowledgeを選択したRoomへ独立コピーとして取り込みました。`;
  }
  return status.retryable ? "取り込みに失敗しました。宛先と権限を確認して同じ操作を再試行できます。" : "取り込みに失敗しました。Serverの案内を確認してください。";
}

export default function WorkspaceShareImport({
  view,
  source,
  authenticated,
  authenticating = false,
  workspaces,
  rooms = [],
  initialStatus = null,
  initialOperationId,
  onAuthenticate,
  onStartImport,
  onGetStatus,
  onClose
}: WorkspaceShareImportProps) {
  const [workspaceSelectionKey, setWorkspaceSelectionKey] = useState("");
  const [roomId, setRoomId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<PublicShareImportResult | null>(initialStatus);
  const [busy, setBusy] = useState<"start" | "status" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(Boolean(initialStatus));
  const operationId = useRef(initialOperationId ?? newImportOperationId());
  const viewIdentity = `${view.kind}:${view.contentHash}:${view.publishedAt}`;
  const previousViewIdentity = useRef(viewIdentity);

  useEffect(() => {
    if (previousViewIdentity.current === viewIdentity) return;
    previousViewIdentity.current = viewIdentity;
    setWorkspaceSelectionKey("");
    setRoomId("");
    setConfirmed(false);
    setStatus(null);
    setStarted(false);
    setError(null);
    operationId.current = newImportOperationId();
  }, [viewIdentity]);

  const selectedWorkspace = workspaces.find((workspace) => (workspace.targetKey ?? workspace.id) === workspaceSelectionKey);
  const workspaceId = selectedWorkspace?.id ?? "";

  useEffect(() => {
    if (!workspaceId || !roomId) return;
    if (!rooms.some((room) => room.id === roomId
      && room.workspaceId === workspaceId
      && (room.workspaceTargetKey === undefined || room.workspaceTargetKey === workspaceSelectionKey)
      && room.canImport !== false)) setRoomId("");
  }, [roomId, rooms, workspaceId, workspaceSelectionKey]);

  const availableRooms = rooms.filter((room) => room.workspaceId === workspaceId
    && (room.workspaceTargetKey === undefined || room.workspaceTargetKey === workspaceSelectionKey)
    && room.canImport !== false);
  const canStart = workspaceShareImportCanStart({
    authenticated,
    confirmed,
    hasSource: Boolean(source),
    workspaceId,
    kind: view.kind,
    roomId,
    status: status?.status
  });

  const startImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!source || !canStart || busy) return;
    setBusy("start");
    setError(null);
    setStarted(true);
    try {
      const next = await onStartImport({ source, workspaceId, ...(selectedWorkspace?.targetKey ? { workspaceTargetKey: selectedWorkspace.targetKey } : {}), ...(view.kind === "room_knowledge" ? { roomId } : {}), operationId: operationId.current });
      setStatus(next);
    } catch {
      setError("取り込みを開始できませんでした。宛先の権限と接続を確認して、同じ操作を再試行してください。");
    } finally {
      setBusy(null);
    }
  };

  const refreshStatus = async () => {
    if (!started || !workspaceId || busy) return;
    setBusy("status");
    setError(null);
    try {
      const next = await onGetStatus({ workspaceId, ...(selectedWorkspace?.targetKey ? { workspaceTargetKey: selectedWorkspace.targetKey } : {}), ...(view.kind === "room_knowledge" && roomId ? { roomId } : {}), operationId: operationId.current });
      setStatus(next);
    } catch {
      setError("取り込み状態を再表示できませんでした。接続を確認して再試行してください。");
    } finally {
      setBusy(null);
    }
  };

  return <>
    <style>{workspaceShareImportStyles}</style>
    <section className="workspace-share-import" role="dialog" aria-modal="true" aria-labelledby="workspace-share-import-title" aria-busy={busy !== null}>
      <header className="workspace-share-import__header">
        <div>
          <span className="workspace-share-import__eyebrow">取り込み</span>
          <h2 id="workspace-share-import-title">共有内容を取り込む</h2>
          <p>共有元のRoomへ参加したり、Agentを実行したりせず、確認した内容を独立コピーとして保存します。</p>
        </div>
        {onClose ? <button type="button" className="workspace-share-import__close" onClick={onClose} aria-label="取り込みを閉じる">×</button> : null}
      </header>

      {!authenticated ? <div className="workspace-share-import__auth" role="alert">
        <strong>取り込みには本人確認が必要です</strong>
        <p>公開リンクの内容を確認できますが、保存操作には現在のAccountが必要です。</p>
        {onAuthenticate ? <button type="button" className="workspace-share-import__primary" onClick={() => void onAuthenticate()} disabled={authenticating}>{authenticating ? "本人確認中…" : "本人確認へ進む"}</button> : null}
      </div> : null}

      <WorkspaceShareView view={view} authenticated={authenticated} />

      <div className="workspace-share-import__status" aria-live="polite">
        {busy === "start" ? <p role="status">取り込みを受け付けています…</p> : null}
        {busy === "status" ? <p role="status">取り込み状態を確認しています…</p> : null}
        {error ? <p className="workspace-share-import__error" role="alert">{error}</p> : null}
        {status ? <div className={`workspace-share-import__result is-${status.status}`} role={status.status === "failed" ? "alert" : "status"}>
          <strong>{workspaceShareImportStatusLabel(status.status)}</strong>
          <p>{importStatusMessage(status)}</p>
          {status.status === "failed" && status.failure_code ? <p className="workspace-share-import__muted">Serverが返した失敗理由を確認してください。</p> : null}
          {status.status === "committed" ? <p className="workspace-share-import__muted">取り込み済みコピーを共有元の停止操作で削除することはありません。</p> : null}
        </div> : null}
      </div>

      {authenticated && status?.status !== "committed" ? <form className="workspace-share-import__destination" onSubmit={(event) => void startImport(event)}>
        <fieldset>
          <legend>取り込み先</legend>
          <label>Workspace<select value={workspaceSelectionKey} onChange={(event) => { setWorkspaceSelectionKey(event.currentTarget.value); setRoomId(""); setConfirmed(false); }} disabled={busy !== null || (started && Boolean(workspaceSelectionKey))}>
            <option value="">Workspaceを選択</option>
            {workspaces.filter((workspace) => workspace.canImport !== false).map((workspace) => {
              const selectionKey = workspace.targetKey ?? workspace.id;
              return <option value={selectionKey} key={selectionKey}>{workspace.name}</option>;
            })}
          </select></label>
          {view.kind === "room_knowledge" ? <label>既存Room<select value={roomId} onChange={(event) => { setRoomId(event.currentTarget.value); setConfirmed(false); }} disabled={!workspaceId || busy !== null || started}>
            <option value="">Roomを選択</option>
            {availableRooms.map((room) => <option value={room.id} key={`${room.workspaceTargetKey ?? workspaceSelectionKey}:${room.id}`}>{room.name}</option>)}
          </select></label> : <p className="workspace-share-import__note">Agentは選択したWorkspaceに新しい独立コピーとして作成されます。既存Agentを上書きせず、既定Agentにも設定しません。</p>}
        </fieldset>
        <label className="workspace-share-import__confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} disabled={!workspaceId || (view.kind === "room_knowledge" && !roomId) || busy !== null} />内容と取り込み先を確認しました</label>
        <button type="submit" className="workspace-share-import__primary" disabled={!canStart || busy !== null}>明示的に取り込む</button>
      </form> : null}

      {started ? <button type="button" className="workspace-share-import__secondary" onClick={() => void refreshStatus()} disabled={busy !== null || !workspaceId}>同じ操作の状態を再表示</button> : null}
    </section>
  </>;
}

const workspaceShareImportStyles = `
.workspace-share-import { --share-import-ink: var(--native-copy, #eeeeee); --share-import-muted: var(--native-muted, #b2b2b2); --share-import-line: var(--native-line, rgba(255,255,255,.09)); --share-import-accent: var(--native-accent, #d6d6d6); --share-import-danger: var(--native-danger, #ee8981); box-sizing: border-box; color: var(--share-import-ink); display: grid; gap: 12px; max-height: min(920px, calc(100vh - 32px)); overflow: auto; padding: 20px 24px; width: min(820px, calc(100vw - 32px)); }
.workspace-share-import *, .workspace-share-import *::before, .workspace-share-import *::after { box-sizing: border-box; }
.workspace-share-import__header { align-items: flex-start; display: flex; gap: 18px; justify-content: space-between; }
.workspace-share-import__header h2 { font-family: inherit; font-size: 18px; font-weight: 600; letter-spacing: .01em; line-height: 1.3; margin: 5px 0 0; }
.workspace-share-import__header p, .workspace-share-import__note { color: var(--share-import-muted); font-size: 12px; line-height: 1.55; margin: 9px 0 0; }
.workspace-share-import__eyebrow { color: var(--share-import-muted); display: block; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.workspace-share-import__close { background: transparent; border: 1px solid var(--share-import-line); border-radius: 8px; color: var(--share-import-muted); cursor: pointer; font-size: 16px; height: 32px; width: 32px; }
.workspace-share-import__auth, .workspace-share-import__destination, .workspace-share-import__result { background: var(--native-surface-soft, #1c1c1c); border: 1px solid var(--share-import-line); border-radius: 10px; padding: 14px; }
.workspace-share-import__auth { border-color: rgba(var(--native-accent-rgb, 214, 214, 214), .28); }
.workspace-share-import__auth p { color: var(--share-import-muted); font-size: 12px; line-height: 1.5; }
.workspace-share-import__destination { display: grid; gap: 13px; }
.workspace-share-import__destination fieldset { border: 0; display: grid; gap: 11px; margin: 0; padding: 0; }
.workspace-share-import__destination legend { color: var(--share-import-accent); font-size: 13px; font-weight: 600; margin-bottom: 2px; }
.workspace-share-import__destination label { color: var(--share-import-muted); display: grid; font-size: 11px; font-weight: 700; gap: 6px; }
.workspace-share-import__destination select { background: rgba(0,0,0,.2); border: 1px solid rgba(204,218,209,.25); border-radius: 8px; color: inherit; font: inherit; padding: 9px 10px; width: 100%; }
.workspace-share-import__destination select:focus-visible, .workspace-share-import button:focus-visible, .workspace-share-import input:focus-visible { outline: 2px solid var(--share-import-accent); outline-offset: 2px; }
.workspace-share-import__confirm { align-items: center; color: var(--share-import-ink); display: flex !important; font-size: 12px !important; font-weight: 600 !important; gap: 8px; }
.workspace-share-import__primary, .workspace-share-import__secondary { border-radius: 7px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600; min-height: 32px; padding: 7px 10px; }
.workspace-share-import__primary { background: var(--share-import-accent); border: 1px solid var(--share-import-accent); color: var(--native-accent-ink, #171717); }
.workspace-share-import__secondary { background: rgba(255,255,255,.04); border: 1px solid rgba(204,218,209,.25); color: inherit; justify-self: start; }
.workspace-share-import button:disabled { cursor: not-allowed; opacity: .52; }
.workspace-share-import__status { min-height: 24px; }
.workspace-share-import__status > p { margin: 0; }
.workspace-share-import__result { margin-top: 8px; }
.workspace-share-import__result p { color: var(--share-import-muted); font-size: 12px; line-height: 1.55; margin: 7px 0 0; }
.workspace-share-import__result.is-committed { border-color: rgba(138,216,178,.4); }
.workspace-share-import__result.is-failed, .workspace-share-import__error { color: var(--share-import-danger); }
.workspace-share-import__muted { color: var(--share-import-muted) !important; }
@media (max-width: 620px) { .workspace-share-import { padding: 18px; width: calc(100vw - 20px); } }
`;
