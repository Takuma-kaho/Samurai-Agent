import type { FormEvent, KeyboardEvent } from "react";
import type { NativeChatMessage, NativeEvidenceBundle } from "../native-app/types";

export interface ChatSurfaceProps {
  roomName?: string;
  messages: NativeChatMessage[];
  loading?: boolean;
  sending?: boolean;
  archived?: boolean;
  readOnly?: boolean;
  canExecute?: boolean;
  connectionState?: "connected" | "reconnecting" | "offline";
  error?: string | null;
  onSend: (content: string) => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRetry: (message: NativeChatMessage) => void | Promise<void>;
  onInspectEvidence: (message: NativeChatMessage, evidence?: NativeEvidenceBundle) => void;
  onReconnect: () => void | Promise<void>;
}

function roleLabel(role: NativeChatMessage["role"]): string {
  if (role === "user") return "あなた";
  if (role === "agent") return "Agent";
  if (role === "system") return "システム";
  return role;
}

function statusLabel(state: ChatSurfaceProps["connectionState"]): string {
  if (state === "reconnecting") return "再接続中";
  if (state === "offline") return "オフライン";
  return "接続済み";
}

export function ChatSurface({
  roomName,
  messages,
  loading = false,
  sending = false,
  archived = false,
  readOnly = false,
  canExecute = true,
  connectionState = "connected",
  error,
  onSend,
  onStop,
  onRetry,
  onInspectEvidence,
  onReconnect
}: ChatSurfaceProps) {
  const composerDisabled = loading || sending || archived || readOnly || !canExecute || connectionState === "offline";
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("chat-message") as HTMLTextAreaElement | null;
    const content = input?.value.trim() ?? "";
    if (!input || !content || composerDisabled) return;
    input.value = "";
    void onSend(content);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <section className="native-chat-surface" aria-labelledby="native-chat-heading">
      <header className="native-chat-header">
        <div>
          <div className="native-section-eyebrow">Room conversation</div>
          <h1 id="native-chat-heading">{roomName ?? "Roomを選択"}</h1>
        </div>
        <div className={`native-connection-status is-${connectionState}`} role="status">
          <span className="native-status-dot" aria-hidden="true" />
          {statusLabel(connectionState)}
        </div>
      </header>

      {archived ? <div className="native-banner native-banner-warning" role="status"><strong>このWorkspaceはアーカイブ済みです。</strong> 履歴の閲覧はできますが、Chatと書き込みはできません。</div> : null}
      {!archived && readOnly ? <div className="native-banner native-banner-warning" role="status"><strong>このWorkspaceは読み取り専用です。</strong> 履歴の閲覧はできますが、Chatと書き込みはできません。</div> : null}
      {!archived && !canExecute && roomName ? <div className="native-banner native-banner-warning" role="status"><strong>このRoomへの実行権限がありません。</strong> 権限が付与されるまでChatを開けません。</div> : null}
      {error ? (
        <div className="native-banner native-banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="native-button native-button-quiet" onClick={() => void onReconnect()}>再接続</button>
        </div>
      ) : null}

      <div className="native-message-list" aria-live="polite" aria-busy={loading || sending}>
        {loading ? <div className="native-chat-placeholder" role="status">会話を読み込んでいます…</div> : null}
        {!loading && messages.length === 0 ? (
          <div className="native-chat-placeholder">
            <span className="native-placeholder-kicker">START HERE</span>
            <p>{roomName ? "このRoomで、最初の依頼をAgentに送ってください。" : "左側からRoomを選ぶと会話を始められます。"}</p>
          </div>
        ) : null}
        {messages.map((message) => (
          <article key={message.id} className={`native-message native-message-${message.role}${message.pending ? " is-pending" : ""}${message.failed ? " is-failed" : ""}`}>
            <div className="native-message-meta">
              <span>{roleLabel(message.role)}</span>
              {message.pending ? <span className="native-message-state">送信中…</span> : null}
              {message.failed ? <span className="native-message-state is-error">失敗</span> : null}
            </div>
            <div className="native-message-content">{message.content || (message.pending ? "Agentが応答を準備しています…" : "")}</div>
            <div className="native-message-actions">
              {message.failed && message.retryable !== false ? <button type="button" className="native-text-button" onClick={() => void onRetry(message)}>再試行</button> : null}
              {message.evidence?.length ? <button type="button" className="native-text-button" onClick={() => onInspectEvidence(message)} aria-label={`${roleLabel(message.role)}の根拠を確認`}>根拠を確認</button> : null}
            </div>
          </article>
        ))}
      </div>

      <footer className="native-composer-wrap">
        {sending ? <div className="native-streaming-row" role="status"><span className="native-streaming-bars" aria-hidden="true"><i /><i /><i /></span>Agentが応答中です <button type="button" className="native-text-button" onClick={() => void onStop()}>停止</button></div> : null}
        <form className="native-composer" onSubmit={handleSubmit}>
          <label className="native-visually-hidden" htmlFor="native-chat-message">メッセージ</label>
          <textarea id="native-chat-message" name="chat-message" rows={2} placeholder={archived ? "アーカイブ済みのWorkspaceでは送信できません" : readOnly ? "読み取り専用のWorkspaceでは送信できません" : "Agentに依頼する…"} disabled={composerDisabled} onKeyDown={handleKeyDown} />
          <div className="native-composer-footer">
            <span>⌘/Ctrl + Enter で送信</span>
            <button className="native-send-button" type="submit" disabled={composerDisabled}>送信 <span aria-hidden="true">↗</span></button>
          </div>
        </form>
      </footer>
    </section>
  );
}

export default ChatSurface;
