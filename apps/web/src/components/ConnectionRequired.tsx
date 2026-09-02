import { useState, type FormEvent } from "react";
import { configureBrowserWorkspaceConnection } from "../lib/workspace-browser-auth";

export interface ConnectionRequiredProps {
  browserMode: boolean;
  error?: string | null;
  onConnected: () => void | Promise<void>;
}

export function ConnectionRequired({ browserMode, error, onConnected }: ConnectionRequiredProps) {
  const [draft, setDraft] = useState({ label: "Browser", serverUrl: "", workspaceId: "", accountId: "", publicKey: "", privateKey: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const update = (key: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!browserMode) {
      setFormError("Desktopの接続設定から、保護された資格情報を読み込んでください。");
      return;
    }
    if (!draft.serverUrl.trim() || !draft.workspaceId.trim() || !draft.accountId.trim() || !draft.publicKey.trim() || !draft.privateKey.trim()) {
      setFormError("Server URL、Workspace ID、Account ID、公開鍵、秘密鍵を入力してください。");
      return;
    }
    setSaving(true);
    try {
      await configureBrowserWorkspaceConnection({
        label: draft.label.trim() || "Browser",
        serverUrl: draft.serverUrl.trim(),
        workspaceId: draft.workspaceId.trim(),
        accountId: draft.accountId.trim(),
        publicKey: draft.publicKey.trim(),
        privateKey: draft.privateKey.trim()
      });
      await onConnected();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "接続設定を保存できませんでした。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="native-connection-gate" aria-labelledby="native-connection-heading">
      <span className="native-placeholder-kicker">SECURE CONNECTION</span>
      <h1 id="native-connection-heading">Workspace Serverに接続してください</h1>
      <p>Organization、Workspace、RoomはServerの認可結果から読み込みます。接続候補だけをこの画面に保存し、権限は毎回確認します。</p>
      {!browserMode ? <div className="native-banner native-banner-warning" role="status">Desktopの接続設定でServerと保護されたAccountを登録すると、ここへ戻って利用できます。</div> : null}
      {browserMode ? <form className="native-connection-form" onSubmit={submit}>
        <label><span>接続名</span><input value={draft.label} onChange={(event) => update("label", event.currentTarget.value)} maxLength={100} /></label>
        <label><span>Server URL</span><input value={draft.serverUrl} onChange={(event) => update("serverUrl", event.currentTarget.value)} inputMode="url" placeholder="https://samurai.example" required /></label>
        <label><span>Workspace ID</span><input value={draft.workspaceId} onChange={(event) => update("workspaceId", event.currentTarget.value)} autoComplete="off" required /></label>
        <label><span>Account ID</span><input value={draft.accountId} onChange={(event) => update("accountId", event.currentTarget.value)} autoComplete="off" required /></label>
        <label><span>Public key</span><textarea value={draft.publicKey} onChange={(event) => update("publicKey", event.currentTarget.value)} rows={3} autoComplete="off" required /></label>
        <label><span>Private key</span><textarea value={draft.privateKey} onChange={(event) => update("privateKey", event.currentTarget.value)} rows={4} autoComplete="off" required /></label>
        {formError || error ? <p className="native-inline-error" role="alert">{formError ?? error}</p> : null}
        <button className="native-button native-button-primary" type="submit" disabled={saving}>{saving ? "接続を確認中…" : "安全に接続"}</button>
      </form> : null}
    </section>
  );
}

export default ConnectionRequired;
