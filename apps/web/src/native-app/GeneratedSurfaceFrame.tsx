import { useEffect, useMemo, useRef, useState } from "react";
import type { JsonValue } from "@samurai-agent/core-schemas";
import type { GeneratedSurfaceBundleDetail, GeneratedSurfaceDetail, GeneratedSurfaceExportPayload } from "../lib/api";

export interface GeneratedSurfaceActionRequest {
  surfaceId: string;
  revisionId: string;
  actionId: string;
  payload: Record<string, JsonValue>;
}

export interface GeneratedSurfaceFrameProps {
  detail: GeneratedSurfaceDetail;
  /** A previously fetched bundle may be supplied to avoid a second request. */
  bundle?: GeneratedSurfaceBundleDetail;
  disabled?: boolean;
  onLoadBundle?: (input: { surfaceId: string; revisionId: string }) => Promise<GeneratedSurfaceBundleDetail>;
  onRunAction?: (input: GeneratedSurfaceActionRequest) => Promise<void>;
  /**
   * Confirmation-sensitive actions must create a real server-side request.
   * This component deliberately never turns a click into `confirmed: true`.
   */
  onRequestApproval?: (input: GeneratedSurfaceActionRequest) => Promise<void>;
  onSetState?: (input: { surfaceId: string; action: "pin" | "unpin" | "archive" }) => Promise<void>;
  onExport?: (input: { surfaceId: string; revisionId: string; format: "html" | "zip" }) => Promise<GeneratedSurfaceExportPayload>;
  onClose?: () => void;
}

type GeneratedSurfaceAction = {
  id: string;
  label: string;
  requires_confirmation: boolean;
};

const generatedSurfaceCsp = "default-src 'none'; base-uri 'none'; form-action 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; media-src data: blob:";
const maxActionPayloadBytes = 32 * 1024;

/**
 * Builds the only document passed to the untrusted Surface iframe.
 *
 * The parent never gives the frame its origin, credentials, Electron bridge,
 * or network access. The message envelope pins the Surface and revision so a
 * response from an old frame cannot operate on the current Surface.
 */
export function generatedSurfaceSrcdoc(bundle: GeneratedSurfaceBundleDetail): string {
  const actionIds = bundle.surface.actions.map((action) => action.id);
  const bridge = safeInlineJson({
    surface_id: bundle.surface.id,
    revision_id: bundle.revision.id,
    action_ids: actionIds
  });
  const css = (bundle.bundle.css ?? "").replace(/<\/style/gi, "<\\/style");
  const script = (bundle.bundle.script ?? "").replace(/<\/script/gi, "<\\/script");

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${generatedSurfaceCsp}"><style>${css}</style></head><body>${bundle.bundle.html}<script>${script}</script><script>window.samuraiGeneratedSurface=${bridge};window.dispatchSamuraiAction=function(actionId,payload){var meta=window.samuraiGeneratedSurface||{};window.parent.postMessage({type:"samurai.generated_surface.action",surface_id:meta.surface_id,revision_id:meta.revision_id,action_id:String(actionId),payload:payload||{}},"*")};<\/script></body></html>`;
}

/** Returns only a declared action from a frame that is pinned to this revision. */
export function generatedSurfaceActionFromMessage(
  data: unknown,
  expected: { surfaceId: string; revisionId: string; actions: readonly GeneratedSurfaceAction[] }
): GeneratedSurfaceActionRequest | undefined {
  if (!isRecord(data) || data.type !== "samurai.generated_surface.action") return undefined;
  if (data.surface_id !== expected.surfaceId || data.revision_id !== expected.revisionId || typeof data.action_id !== "string") return undefined;
  if (!expected.actions.some((action) => action.id === data.action_id)) return undefined;
  const payload = isRecord(data.payload) ? toJsonRecord(data.payload) : {};
  if (JSON.stringify(payload).length > maxActionPayloadBytes) return undefined;
  return {
    surfaceId: expected.surfaceId,
    revisionId: expected.revisionId,
    actionId: data.action_id,
    payload
  };
}

export function GeneratedSurfaceFrame({
  detail,
  bundle: initialBundle,
  disabled = false,
  onLoadBundle,
  onRunAction,
  onRequestApproval,
  onSetState,
  onExport,
  onClose
}: GeneratedSurfaceFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const requestEpoch = useRef(0);
  const runActionRef = useRef<((request: GeneratedSurfaceActionRequest, explicitParentAction: boolean) => Promise<void>) | undefined>(undefined);
  const [loadedBundle, setLoadedBundle] = useState<GeneratedSurfaceBundleDetail | undefined>(() => matchingBundle(initialBundle, detail));
  const [loading, setLoading] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const revision = detail.revisions.find((candidate) => candidate.id === detail.surface.current_revision_id)
    ?? detail.revisions.find((candidate) => candidate.revision === detail.surface.current_revision)
    ?? detail.revisions[0];
  const actions = useMemo<GeneratedSurfaceAction[]>(() => detail.surface.actions.map((action) => ({
    id: action.id,
    label: action.label,
    requires_confirmation: action.requires_confirmation === true
  })), [detail.surface.actions]);

  useEffect(() => {
    const supplied = matchingBundle(initialBundle, detail);
    if (supplied) {
      setLoadedBundle(supplied);
      setError(undefined);
      setLoading(false);
      return;
    }
    if (!revision || !onLoadBundle) {
      setLoadedBundle(undefined);
      setLoading(false);
      return;
    }
    const epoch = ++requestEpoch.current;
    setLoading(true);
    setError(undefined);
    void onLoadBundle({ surfaceId: detail.surface.id, revisionId: revision.id }).then((next) => {
      if (epoch !== requestEpoch.current) return;
      if (!matchingBundle(next, detail)) {
        setLoadedBundle(undefined);
        setError("受信したSurfaceの版が現在の選択と一致しません。");
        return;
      }
      setLoadedBundle(next);
    }).catch((cause: unknown) => {
      if (epoch !== requestEpoch.current) return;
      setLoadedBundle(undefined);
      setError(errorMessage(cause, "Surfaceを読み込めませんでした。"));
    }).finally(() => {
      if (epoch === requestEpoch.current) setLoading(false);
    });
    return () => { requestEpoch.current += 1; };
  }, [detail, initialBundle, onLoadBundle, revision]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || !revision) return;
      const request = generatedSurfaceActionFromMessage(event.data, {
        surfaceId: detail.surface.id,
        revisionId: revision.id,
        actions
      });
      if (!request) return;
      const action = actions.find((candidate) => candidate.id === request.actionId);
      // A message from an isolated document never counts as a human
      // confirmation. A confirmation flow starts only from the parent UI.
      if (action?.requires_confirmation) {
        setNotice("確認が必要な操作は、画面上の操作ボタンから開始してください。");
        return;
      }
      void runActionRef.current?.(request, false);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [actions, detail.surface.id, revision]);

  const srcdoc = useMemo(() => loadedBundle ? generatedSurfaceSrcdoc(loadedBundle) : undefined, [loadedBundle]);
  const currentRevisionLabel = revision ? `revision ${revision.revision}` : "版を確認できません";

  async function runAction(request: GeneratedSurfaceActionRequest, explicitParentAction: boolean): Promise<void> {
    const action = actions.find((candidate) => candidate.id === request.actionId);
    if (!action || busyActionId || disabled) return;
    if (action.requires_confirmation) {
      if (!explicitParentAction) return;
      if (!onRequestApproval) {
        setNotice("この操作にはServerの承認経路が必要です。現在の接続では開始できません。");
        return;
      }
      setBusyActionId(request.actionId);
      setError(undefined);
      try {
        await onRequestApproval(request);
        setNotice("確認要求をServerへ送信しました。結果が確定するまで操作は実行されません。");
      } catch (cause) {
        setError(errorMessage(cause, "確認要求を送信できませんでした。"));
      } finally {
        setBusyActionId(undefined);
      }
      return;
    }
    if (!onRunAction) {
      setNotice("このSurfaceの操作は、現在の接続では利用できません。");
      return;
    }
    setBusyActionId(request.actionId);
    setError(undefined);
    try {
      await onRunAction(request);
      setNotice("操作結果をServerへ照会しました。保存済みの変更は再読込時にも確認できます。");
    } catch (cause) {
      setError(errorMessage(cause, "Surface操作を保存できませんでした。"));
    } finally {
      setBusyActionId(undefined);
    }
  }

  async function setState(action: "pin" | "unpin" | "archive"): Promise<void> {
    if (!onSetState || busyActionId || disabled) return;
    setBusyActionId(`state:${action}`);
    setError(undefined);
    try {
      await onSetState({ surfaceId: detail.surface.id, action });
      setNotice(action === "pin" ? "Surfaceをピン留めしました。" : action === "unpin" ? "Surfaceのピン留めを解除しました。" : "Surfaceを保管しました。");
    } catch (cause) {
      setError(errorMessage(cause, "Surfaceの状態を変更できませんでした。"));
    } finally {
      setBusyActionId(undefined);
    }
  }

  async function exportSurface(format: "html" | "zip"): Promise<void> {
    if (!onExport || !revision || busyActionId || disabled) return;
    setBusyActionId(`export:${format}`);
    setError(undefined);
    try {
      const payload = await onExport({ surfaceId: detail.surface.id, revisionId: revision.id, format });
      downloadBase64(payload);
      setNotice(`${format.toUpperCase()}を書き出しました。`);
    } catch (cause) {
      setError(errorMessage(cause, "Surfaceを書き出せませんでした。"));
    } finally {
      setBusyActionId(undefined);
    }
  }

  runActionRef.current = runAction;

  return <section className="native-generated-surface" aria-label={`${detail.surface.title}の操作画面`}>
    <header className="native-generated-surface-toolbar">
      <div><span className="native-section-eyebrow">Generated surface</span><strong>{detail.surface.title}</strong><small>{currentRevisionLabel}</small></div>
      <div className="native-generated-surface-toolbar-actions">
        {onSetState ? <button type="button" className="native-button native-button-quiet" disabled={disabled || Boolean(busyActionId)} onClick={() => void setState(detail.surface.state === "pinned" ? "unpin" : "pin")}>{detail.surface.state === "pinned" ? "ピン解除" : "ピン留め"}</button> : null}
        {onExport ? <><button type="button" className="native-button native-button-quiet" disabled={disabled || Boolean(busyActionId) || !revision} onClick={() => void exportSurface("html")}>HTML</button><button type="button" className="native-button native-button-quiet" disabled={disabled || Boolean(busyActionId) || !revision} onClick={() => void exportSurface("zip")}>ZIP</button></> : null}
        {onClose ? <button type="button" className="native-button native-button-quiet" onClick={onClose} disabled={Boolean(busyActionId)}>閉じる</button> : null}
      </div>
    </header>
    {loading ? <p className="native-inline-note" role="status">隔離したSurfaceを読み込んでいます…</p> : null}
    {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
    {notice ? <p className="native-inline-note" role="status">{notice}</p> : null}
    {srcdoc ? <iframe ref={frameRef} className="native-generated-surface-frame" title={detail.surface.title} sandbox="allow-scripts" srcDoc={srcdoc} /> : !loading ? <p className="native-inline-note">表示できるSurface bundleがありません。保存済みの成果物または文章表示へ戻ってください。</p> : null}
    {actions.length > 0 ? <div className="native-generated-surface-actions" aria-label="Surface操作">{actions.map((action) => <button key={action.id} type="button" className="native-button" disabled={disabled || Boolean(busyActionId) || !revision} onClick={() => revision && void runAction({ surfaceId: detail.surface.id, revisionId: revision.id, actionId: action.id, payload: {} }, true)}>{busyActionId === action.id ? "送信中…" : action.requires_confirmation ? `${action.label}（確認）` : action.label}</button>)}</div> : null}
  </section>;
}

function matchingBundle(bundle: GeneratedSurfaceBundleDetail | undefined, detail: GeneratedSurfaceDetail): GeneratedSurfaceBundleDetail | undefined {
  if (!bundle) return undefined;
  if (bundle.surface.id !== detail.surface.id || bundle.revision.id !== detail.surface.current_revision_id) return undefined;
  return bundle;
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value)).replace(/</g, "\\u003c");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) return toJsonRecord(value);
  return String(value ?? "");
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function downloadBase64(payload: GeneratedSurfaceExportPayload): void {
  if (typeof document === "undefined") return;
  const binary = atob(payload.content_base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.content_type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = payload.file_name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
