import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { WorkspaceFileResourceRefSchema, type ResourceRef } from "@samurai-agent/core-schemas";
import { getWorkspaceClientBridge, type DesktopWorkspaceTarget, type WorkspaceAttachmentReadResult } from "../lib/api";

type SavedAttachmentState = "loading" | "ready" | "failed" | "deleted" | "version-mismatch";

export interface RoomWorkspaceAttachmentProps {
  resourceRef: ResourceRef;
  roomId: string;
  target?: DesktopWorkspaceTarget;
  anchorId?: string;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not_found") || message.includes("deleted")) return "ファイルは削除されています";
  if (message.includes("version_mismatch") || message.includes("hash_mismatch")) return "保存時の版と一致しません";
  if (message.includes("navigation_changed") || message.includes("room_navigation")) return "Roomまたは接続が切り替わりました";
  return "読み込みに失敗しました";
}

function fileExtension(uri: string): string {
  return uri.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
}

function mimeTypeFor(uri: string, mimeType?: string): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", xml: "text/xml",
    html: "text/html", css: "text/css", js: "text/javascript", ts: "text/plain"
  } as Record<string, string>)[fileExtension(uri)] ?? mimeType ?? "application/octet-stream";
}

function displaySize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(size < 10 * 1_024 ? 1 : 0)} KiB`;
  return `${(size / (1_024 * 1_024)).toFixed(size < 10 * 1_024 * 1_024 ? 1 : 0)} MiB`;
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}

function isText(mimeType: string, uri: string): boolean {
  return mimeType.startsWith("text/") || ["json", "csv", "md", "markdown", "ts", "js", "css"].includes(fileExtension(uri));
}

function errorState(message: string): SavedAttachmentState {
  if (message.includes("削除")) return "deleted";
  if (message.includes("版と一致")) return "version-mismatch";
  return "failed";
}

export function RoomWorkspaceAttachment({ resourceRef, roomId, target, anchorId }: RoomWorkspaceAttachmentProps) {
  const parsed = WorkspaceFileResourceRefSchema.safeParse(resourceRef);
  const ref = parsed.success ? parsed.data : undefined;
  const [state, setState] = useState<SavedAttachmentState>(ref ? "loading" : "failed");
  const [error, setError] = useState(parsed.success ? "" : "参照が無効です");
  const [read, setRead] = useState<WorkspaceAttachmentReadResult>();
  const [objectUrl, setObjectUrl] = useState<string>();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const scopeKey = `${roomId}\n${target?.connectionId ?? ""}\n${target?.workspaceId ?? ""}\n${target?.selectionGeneration ?? ""}\n${ref?.id ?? ""}\n${ref?.uri ?? ""}\n${ref?.version ?? ""}`;

  useEffect(() => {
    let active = true;
    let currentUrl: string | undefined;
    setRead(undefined);
    setObjectUrl(undefined);
    setLightboxOpen(false);
    if (!ref) return () => { active = false; };
    const bridge = getWorkspaceClientBridge();
    if (!bridge?.readWorkspaceAttachment) {
      setState("failed");
      setError("保存済み添付の取得に対応していません");
      return () => { active = false; };
    }
    setState("loading");
    setError("");
    void bridge.readWorkspaceAttachment({ roomId, resourceRef: ref, ...(target ? { target } : {}) })
      .then((result) => {
        if (!active) return;
        if (result.file.path !== ref.uri || result.file.version !== Number(ref.version) || result.file.sha256 !== ref.id) {
          throw new Error("workspace_attachment_reference_mismatch");
        }
        const mimeType = mimeTypeFor(ref.uri, result.mimeType);
        currentUrl = URL.createObjectURL(new Blob([Uint8Array.from(result.bytes)], { type: mimeType }));
        setRead({ ...result, mimeType });
        setObjectUrl(currentUrl);
        setState("ready");
      })
      .catch((caught) => {
        if (!active) return;
        const message = readableError(caught);
        setState(errorState(message));
        setError(message);
      });
    return () => {
      active = false;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [scopeKey, retryNonce]);

  useEffect(() => {
    if (!lightboxOpen) return;
    lightboxRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setLightboxOpen(false);
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [lightboxOpen]);

  const label = ref?.label ?? ref?.uri ?? "添付ファイル";
  const mimeType = read ? mimeTypeFor(ref?.uri ?? "", read.mimeType) : "application/octet-stream";
  const retry = () => {
    setRetryNonce((value) => value + 1);
  };
  const anchorProps = anchorId ? { id: anchorId, tabIndex: -1 } : {};

  if (!ref) return <div {...anchorProps} className="native-work-attachment-card is-failed"><span>添付参照が無効です</span></div>;
  if (state === "loading") return <div {...anchorProps} className="native-work-attachment-card is-loading" aria-label={`${label}を読み込み中`}><span className="native-work-attachment-icon" aria-hidden="true">…</span><span className="native-work-attachment-card-main"><strong title={label}>{label}</strong><small>読み込み中… · v{ref.version}</small></span></div>;
  if (state !== "ready" || !read || !objectUrl) {
    return (
      <div {...anchorProps} className={`native-work-attachment-card is-${state}`}>
        <span className="native-work-attachment-icon" aria-hidden="true">{state === "deleted" ? "×" : "!"}</span>
        <span className="native-work-attachment-card-main"><strong title={label}>{label}</strong><small>{error} · v{ref.version}</small></span>
        {state === "failed" || state === "version-mismatch" ? <button type="button" onClick={retry}>再試行</button> : null}
      </div>
    );
  }

  const displayLabel = `${label} · ${displaySize(read.file.size)}`;
  const download = () => {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = label;
    link.click();
  };
  const text = isText(mimeType, ref.uri) ? new TextDecoder().decode(Uint8Array.from(read.bytes)) : undefined;
  return (
    <div {...anchorProps} className="native-work-attachment-card is-ready">
      <span className="native-work-attachment-icon" aria-hidden="true">{isImage(mimeType) ? "▧" : mimeType === "application/pdf" ? "PDF" : "↧"}</span>
      <span className="native-work-attachment-card-main">
        <strong title={label}>{label}</strong>
        <small>{mimeType} · {displaySize(read.file.size)} · v{ref.version}</small>
      </span>
      {isImage(mimeType) ? <button ref={triggerRef} type="button" className="native-work-attachment-preview-button" onClick={() => setLightboxOpen(true)}><img src={objectUrl} alt={displayLabel} /></button> : null}
      {mimeType === "application/pdf" ? <iframe className="native-work-attachment-viewer" title={label} src={objectUrl} /> : null}
      {text !== undefined ? <pre className="native-work-attachment-text-viewer" aria-label={`${label}の内容`}>{text}</pre> : null}
      <span className="native-work-attachment-card-actions">
        {(isImage(mimeType) || mimeType === "application/pdf" || text !== undefined) ? <button type="button" onClick={download}>保存</button> : null}
        {!isImage(mimeType) && mimeType !== "application/pdf" && text === undefined ? <button type="button" onClick={download}>ダウンロード</button> : null}
      </span>
      {lightboxOpen ? <div className="native-work-attachment-lightbox" role="dialog" aria-modal="true" aria-label={`${label}を拡大表示`} tabIndex={-1} ref={lightboxRef} onClick={() => setLightboxOpen(false)} onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => { if (event.key === "Escape") setLightboxOpen(false); }}><button type="button" aria-label="拡大表示を閉じる" onClick={() => setLightboxOpen(false)}>×</button><img src={objectUrl} alt={displayLabel} onClick={(event) => event.stopPropagation()} /></div> : null}
    </div>
  );
}

export default RoomWorkspaceAttachment;
