import { useState, type FormEvent } from "react";
import type { DesktopWorkspaceConnection } from "../lib/api";

export type WorkspaceConnectionDraft = {
  label: string;
  serverUrl: string;
  accountId: string;
};

type WorkspaceConnectionAction = "save" | "select" | "import" | "register";

export interface WorkspaceConnectionSettingsProps {
  connections: DesktopWorkspaceConnection[];
  activeConnectionId?: string;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (input: WorkspaceConnectionDraft) => void | Promise<void>;
  onSelect: (connectionId: string) => void | Promise<void>;
  onImportIdentity: () => void | Promise<void>;
  onRegisterAccount: () => void | Promise<void>;
}

export function workspaceConnectionActionError(action: WorkspaceConnectionAction): string {
  switch (action) {
    case "save": return "接続先を保存できませんでした。URLとAccount IDを確認してください。";
    case "select": return "接続先を切り替えられませんでした。";
    case "import": return "コピー済みの秘密鍵を読み込めませんでした。Account IDと鍵を確認してください。";
    case "register": return "本人情報をServerへ登録できませんでした。";
  }
}

export function workspaceConnectionActionSuccess(action: WorkspaceConnectionAction): string {
  switch (action) {
    case "save": return "接続先を保存しました。";
    case "select": return "接続先を切り替えました。";
    case "import": return "秘密鍵をこの端末の保護領域へ読み込みました。クリップボードの鍵は手動で消してください。";
    case "register": return "本人情報をServerへ登録しました。";
  }
}

export function workspaceConnectionActionLabel(action: WorkspaceConnectionAction, runningAction?: WorkspaceConnectionAction | null): string {
  if (runningAction === action) {
    switch (action) {
      case "save": return "保存中…";
      case "select": return "切替中…";
      case "import": return "読み込み中…";
      case "register": return "登録中…";
    }
  }

  switch (action) {
    case "save": return "Serverを追加";
    case "select": return "選択";
    case "import": return "コピー済みの秘密鍵を読み込む";
    case "register": return "本人情報を登録";
  }
}

export interface WorkspaceConnectionFeedbackProps {
  success?: string | null;
  error?: string | null;
}

/**
 * Keep the latest connection action result visible in the dialog.  The
 * feedback contains only a user-facing message; credentials never reach
 * this component.
 */
export function WorkspaceConnectionFeedback({ success, error }: WorkspaceConnectionFeedbackProps) {
  const message = error || success;
  if (!message) return null;

  const completed = !error && Boolean(success);
  return (
    <div
      className={`native-action-feedback ${completed ? "is-success" : "is-error"}`}
      role={completed ? "status" : "alert"}
      aria-live={completed ? "polite" : "assertive"}
    >
      <span className="native-action-feedback-icon" aria-hidden="true">{completed ? "✓" : "!"}</span>
      <span className="native-action-feedback-copy">
        <strong>{completed ? "完了" : "失敗"}</strong>
        <span>{message}</span>
      </span>
    </div>
  );
}

/**
 * Desktop-only connection settings.  This component intentionally has no
 * private-key field: Electron Main reads the copied key and writes it to the
 * OS-protected credential store without exposing key material to React.
 */
export function WorkspaceConnectionSettings({
  connections,
  activeConnectionId,
  loading = false,
  error,
  onClose,
  onSave,
  onSelect,
  onImportIdentity,
  onRegisterAccount
}: WorkspaceConnectionSettingsProps) {
  const [draft, setDraft] = useState<WorkspaceConnectionDraft>({ label: "", serverUrl: "", accountId: "" });
  const [saving, setSaving] = useState(false);
  const [runningAction, setRunningAction] = useState<WorkspaceConnectionAction | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const update = (key: keyof WorkspaceConnectionDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const run = async (action: WorkspaceConnectionAction, operation: () => void | Promise<void>) => {
    setFormError(null);
    setFormSuccess(null);
    setSaving(true);
    setRunningAction(action);
    try {
      await operation();
      if (action === "save") setDraft({ label: "", serverUrl: "", accountId: "" });
      setFormSuccess(workspaceConnectionActionSuccess(action));
    } catch {
      setFormError(workspaceConnectionActionError(action));
    } finally {
      setSaving(false);
      setRunningAction(null);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = {
      label: draft.label.trim(),
      serverUrl: draft.serverUrl.trim(),
      accountId: draft.accountId.trim()
    };
    if (!input.label || !input.serverUrl || !input.accountId) {
      setFormSuccess(null);
      setFormError("表示名、Server URL、Account IDを入力してください。");
      return;
    }
    void run("save", () => onSave(input));
  };

  const disabled = loading || saving;
  const active = connections.find((connection) => connection.id === activeConnectionId);

  return (
    <div className="native-dialog-backdrop" role="presentation">
      <section className="native-dialog native-connection-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="native-connection-settings-title">
        <div className="native-card-heading">
          <div>
            <span className="native-section-eyebrow">Desktop only</span>
            <h2 id="native-connection-settings-title">Server接続設定</h2>
          </div>
          <button className="native-icon-button" type="button" onClick={onClose} aria-label="閉じる">×</button>
        </div>

        <p className="native-muted-note">接続先はこの端末だけに保存されます。秘密鍵はこの画面に貼り付けず、ElectronがOSの保護領域へ直接読み込みます。</p>

        {connections.length ? <div className="native-connection-list" aria-label="登録済みServer">
          {connections.map((connection) => {
            const selected = connection.id === activeConnectionId;
            return <button key={connection.id} className={`native-connection-row${selected ? " is-active" : ""}`} type="button" disabled={disabled || selected} onClick={() => void run("select", () => onSelect(connection.id))}>
              <span className="native-connection-row-copy"><strong>{connection.label}</strong><small>{connection.serverUrl}</small><em>{connection.accountId}</em></span>
              <span>{selected ? "選択中" : workspaceConnectionActionLabel("select", runningAction)}</span>
            </button>;
          })}
        </div> : <p className="native-empty-copy">まだServer接続はありません。</p>}

        <form className="native-form-grid native-connection-settings-form" onSubmit={submit}>
          <span className="native-section-eyebrow">Add server</span>
          <label><span>表示名</span><input value={draft.label} onChange={(event) => update("label", event.currentTarget.value)} maxLength={100} placeholder="検証用 Server B" autoComplete="off" required /></label>
          <label><span>Server URL</span><input value={draft.serverUrl} onChange={(event) => update("serverUrl", event.currentTarget.value)} inputMode="url" placeholder="http://127.0.0.1:4318" autoComplete="url" required /></label>
          <label><span>Account ID</span><input value={draft.accountId} onChange={(event) => update("accountId", event.currentTarget.value)} maxLength={128} placeholder="account_..." autoComplete="off" required /></label>
          <p className="native-muted-note">保存すると、このServerを選択します。</p>
          <button className="native-button native-button-primary" type="submit" disabled={disabled}>{workspaceConnectionActionLabel("save", runningAction)}</button>
        </form>

        {active ? <div className="native-connection-identity">
          <span className="native-section-eyebrow">Secure identity</span>
          <p className="native-muted-note">1. 対応する秘密鍵をクリップボードへコピー 2. 下のボタンでこの端末へ読み込む。読み込み後は、クリップボードの鍵を手動で消してください。</p>
          <div className="native-dialog-actions native-connection-identity-actions">
            <button className="native-button" type="button" disabled={disabled} onClick={() => void run("import", onImportIdentity)}>{workspaceConnectionActionLabel("import", runningAction)}</button>
            <button className="native-button native-button-quiet" type="button" disabled={disabled} onClick={() => void run("register", onRegisterAccount)}>{workspaceConnectionActionLabel("register", runningAction)}</button>
          </div>
        </div> : null}

        <WorkspaceConnectionFeedback success={formSuccess} error={formError ?? error} />
      </section>
    </div>
  );
}

export default WorkspaceConnectionSettings;
