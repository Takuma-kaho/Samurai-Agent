import { useEffect, useRef, useState } from "react";
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

function fileTypeLabel(mimeType: string, uri: string): string {
  if (mimeType === "application/pdf") return "PDF";
  const extension = fileExtension(uri);
  if (extension && /^[a-z0-9]{1,12}$/i.test(extension)) return extension.toUpperCase();
  const subtype = mimeType.split("/")[1];
  return subtype ? subtype.toUpperCase() : "ファイル";
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
  const [previewOpen, setPreviewOpen] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const scopeKey = `${roomId}\n${target?.connectionId ?? ""}\n${target?.workspaceId ?? ""}\n${target?.selectionGeneration ?? ""}\n${ref?.id ?? ""}\n${ref?.uri ?? ""}\n${ref?.version ?? ""}`;
  const closePreview = (): void => {
    setPreviewOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  useEffect(() => {
    let active = true;
    let currentUrl: string | undefined;
    setRead(undefined);
    setObjectUrl(undefined);
    setPreviewOpen(false);
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
    if (!previewOpen) return;
    previewRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(previewRef.current?.querySelectorAll<HTMLElement>("button, iframe, [href], [tabindex]:not([tabindex=\"-1\"])") ?? []);
      if (focusable.length === 0) {
        event.preventDefault();
        previewRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === previewRef.current)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [previewOpen]);

  const label = ref?.label ?? ref?.uri ?? "添付ファイル";
  const mimeType = read ? mimeTypeFor(ref?.uri ?? "", read.mimeType) : "application/octet-stream";
  const retry = () => {
    setRetryNonce((value) => value + 1);
  };
  const anchorProps = anchorId ? { id: anchorId, tabIndex: -1 } : {};

  if (!ref) return <div {...anchorProps} className="native-work-attachment-card is-failed"><span>添付参照が無効です</span></div>;
  if (state === "loading") return <div {...anchorProps} className="native-work-attachment-card is-loading" aria-label={`${label}を読み込み中`}><span className="native-work-attachment-icon" aria-hidden="true">…</span><span className="native-work-attachment-card-main"><strong title={label}>{label}</strong><small>読み込み中…</small></span></div>;
  if (state !== "ready" || !read || !objectUrl) {
    return (
      <div {...anchorProps} className={`native-work-attachment-card is-${state}`}>
        <span className="native-work-attachment-icon" aria-hidden="true">{state === "deleted" ? "×" : "!"}</span>
        <span className="native-work-attachment-card-main"><strong title={label}>{label}</strong><small>{error}</small></span>
        {state === "failed" || state === "version-mismatch" ? <button type="button" onClick={retry}>再試行</button> : null}
      </div>
    );
  }

  const download = () => {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = label;
    link.click();
  };
  const text = isText(mimeType, ref.uri) ? new TextDecoder().decode(Uint8Array.from(read.bytes)) : undefined;
  const image = isImage(mimeType);
  const canOpen = image || mimeType === "application/pdf" || text !== undefined;
  const viewer = previewOpen ? (
    <div className="native-work-attachment-viewer-dialog" role="presentation" onClick={closePreview}>
      <section
        className="native-work-attachment-viewer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${label}を表示`}
        tabIndex={-1}
        ref={previewRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="native-work-attachment-viewer-header">
          <div>
            <strong title={label}>{label}</strong>
            <small>{fileTypeLabel(mimeType, ref.uri)} · {displaySize(read.file.size)}</small>
          </div>
          <button className="native-work-attachment-viewer-close" type="button" aria-label="添付の表示を閉じる" onClick={closePreview}>×</button>
        </header>
        {image ? <img className="native-work-attachment-viewer-image" src={objectUrl} alt={label} /> : null}
        {mimeType === "application/pdf" ? <iframe className="native-work-attachment-viewer" title={label} src={objectUrl} /> : null}
        {text !== undefined ? <pre className="native-work-attachment-text-viewer" aria-label={`${label}の内容`}>{text}</pre> : null}
        <div className="native-work-attachment-lightbox-actions"><button type="button" onClick={download}>保存</button></div>
      </section>
    </div>
  ) : null;

  if (image) {
    return (
      <figure {...anchorProps} className="native-work-attachment-media">
        <button ref={triggerRef} type="button" className="native-work-attachment-media-button" aria-label={`${label}を拡大表示`} onClick={() => setPreviewOpen(true)}>
          <img src={objectUrl} alt={label} />
        </button>
        {viewer}
      </figure>
    );
  }

  return (
    <div {...anchorProps} className="native-work-attachment-card is-ready">
      <span className="native-work-attachment-icon" aria-hidden="true">{mimeType === "application/pdf" ? "PDF" : "↧"}</span>
      <span className="native-work-attachment-card-main">
        <strong title={label}>{label}</strong>
        <small>{fileTypeLabel(mimeType, ref.uri)} · {displaySize(read.file.size)}</small>
      </span>
      <span className="native-work-attachment-card-actions">
        {canOpen ? <button ref={triggerRef} type="button" onClick={() => setPreviewOpen(true)}>開く</button> : null}
        <button type="button" onClick={download}>ダウンロード</button>
      </span>
      {viewer}
    </div>
  );
}

export default RoomWorkspaceAttachment;
