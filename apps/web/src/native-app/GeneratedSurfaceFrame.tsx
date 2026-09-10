import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createId, type JsonValue } from "@samurai-agent/core-schemas";
import {
  GeneratedSurfaceFrameActionErrorSchema,
  GeneratedSurfaceFrameActionRequestSchema,
  GeneratedSurfaceFrameActionResultSchema,
  GeneratedSurfaceFrameLatestDataSchema,
  GeneratedSurfaceFrameReadySchema,
  type GeneratedSurfaceFrameActionError,
  type GeneratedSurfaceFrameActionResult,
  type GeneratedSurfaceFrameLatestData
} from "@samurai-agent/ui-protocol";
import type { GeneratedSurfaceBundleDetail, GeneratedSurfaceDetail, GeneratedSurfaceExportPayload } from "../lib/api";
import { toJsonValue } from "../lib/surface-view-helpers";

export interface GeneratedSurfaceActionRequest {
  surfaceId: string;
  revisionId: string;
  actionId: string;
  payload: Record<string, JsonValue>;
  /** Correlation owned by the isolated frame; never used as an operation ID. */
  requestId?: string;
  /** Parent-owned idempotency key passed to the Server callback. */
  operationId?: string;
}

export interface GeneratedSurfaceStateRequest {
  surfaceId: string;
  revisionId: string;
  action: "pin" | "unpin" | "archive";
}

export interface GeneratedSurfaceActionCompletion {
  /** Must match the operation ID assigned by this parent component. */
  operationId?: string;
  /** The persisted target-command result, not a model-generated status. */
  result?: JsonValue;
  /** Server-authorized snapshots for the generated document to consume. */
  latest?: GeneratedSurfaceFrameLatestData;
}

/**
 * Terminal state delivered by the parent after an approval request is
 * resolved. The frame keeps the original request correlation and never
 * accepts a result that is not paired with the parent operation ID.
 */
export type GeneratedSurfaceApprovalResolution =
  | {
    requestId: string;
    operationId: string;
    status: "completed";
    result: JsonValue;
    latest?: GeneratedSurfaceFrameLatestData;
  }
  | {
    requestId: string;
    operationId: string;
    status: "failed";
    error: GeneratedSurfaceFrameActionError["error"];
  };

/**
 * A completed or failed approval recovered from Server history after the
 * frame was remounted. The request IDs are parent-owned correlation values;
 * they are never sent back to the Server as a new mutation.
 */
export type GeneratedSurfaceApprovalRecovery =
  | {
    request: GeneratedSurfaceActionRequest & { requestId: string; operationId: string };
    status: "completed";
    result: JsonValue;
    latest?: GeneratedSurfaceFrameLatestData;
  }
  | {
    request: GeneratedSurfaceActionRequest & { requestId: string; operationId: string };
    status: "failed";
    error: GeneratedSurfaceFrameActionError["error"];
  };

export interface GeneratedSurfaceFrameProps {
  detail: GeneratedSurfaceDetail;
  /** A previously fetched bundle may be supplied to avoid a second request. */
  bundle?: GeneratedSurfaceBundleDetail;
  disabled?: boolean;
  onLoadBundle?: (input: { surfaceId: string; revisionId: string }) => Promise<GeneratedSurfaceBundleDetail>;
  onRunAction?: (input: GeneratedSurfaceActionRequest) => Promise<GeneratedSurfaceActionCompletion | void>;
  /**
   * Confirmation-sensitive actions must create a real server-side request.
   * This component deliberately never turns a click into `confirmed: true`.
   */
  onRequestApproval?: (input: GeneratedSurfaceActionRequest) => Promise<GeneratedSurfaceActionCompletion | void>;
  onSetState?: (input: { surfaceId: string; action: "pin" | "unpin" | "archive" }) => Promise<void>;
  onExport?: (input: { surfaceId: string; revisionId: string; format: "html" | "zip" }) => Promise<GeneratedSurfaceExportPayload>;
  onClose?: () => void;
  /** Parent-level leave guard for action, approval, state, and export requests. */
  onBusyStateChange?: (busy: boolean) => void;
  /** Durable approval status discovered after reopening the Surface. */
  approvalRecoveryNotice?: string;
  /** Parent-to-frame terminal result for the same approval operation. */
  approvalResolution?: GeneratedSurfaceApprovalResolution;
  /** Durable terminal approvals to reconnect after a frame/app restart. */
  approvalRecoveries?: ReadonlyArray<GeneratedSurfaceApprovalRecovery>;
}

type GeneratedSurfaceAction = {
  id: string;
  label: string;
  payload_template: Record<string, JsonValue>;
  requires_confirmation: boolean;
};

const generatedSurfaceCsp = "default-src 'none'; base-uri 'none'; form-action 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; media-src data: blob:";
const maxActionPayloadBytes = 32 * 1024;
const maxActionResultBytes = 256 * 1024;
const generatedSurfaceSandboxOrigin = "null";
const generatedSurfaceActionResultType = "samurai.generated_surface.action.result";
const generatedSurfaceActionErrorType = "samurai.generated_surface.action.error";

type GeneratedSurfaceActionIdentity = Pick<GeneratedSurfaceActionRequest, "surfaceId" | "revisionId" | "actionId">;

type PendingGeneratedSurfaceOperation = {
  request: GeneratedSurfaceActionRequest & { requestId: string; operationId: string };
  operationId: string;
  frameIdentity: string;
  /** Recovery entries are parent projection; in-memory entries belong to this frame. */
  origin: "in-memory" | "recovery";
  status: "running" | "accepted" | "completed" | "failed";
  completion?: GeneratedSurfaceActionCompletion;
  error?: GeneratedSurfaceFrameActionError;
  deliveredFrameToken?: number;
  deliveredResponseSignature?: string;
};

function generatedSurfaceActionKey(input: GeneratedSurfaceActionIdentity): string {
  return JSON.stringify([input.surfaceId, input.revisionId, input.actionId]);
}

function generatedSurfaceOperationKey(input: GeneratedSurfaceActionRequest): string {
  return JSON.stringify([input.surfaceId, input.revisionId, input.actionId, input.payload]);
}

function generatedSurfaceApprovalRecoveryKey(
  request: GeneratedSurfaceActionRequest & { requestId: string; operationId: string }
): string {
  return JSON.stringify([request.requestId, request.operationId, generatedSurfaceOperationKey(request)]);
}

function generatedSurfaceRequestId(input: GeneratedSurfaceActionRequest): string {
  return generatedSurfaceCorrelationId(input.requestId, "generated_surface_request");
}

function generatedSurfaceOperationId(input: GeneratedSurfaceActionRequest): string {
  return generatedSurfaceCorrelationId(input.operationId, "generated_surface_operation");
}

function generatedSurfaceCorrelationId(value: string | undefined, prefix: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length <= 256 ? normalized : createId(prefix);
}

/**
 * Applies the immutable values declared by the Server for an action. Dynamic
 * values may be supplied by the isolated frame, but they may not replace a
 * declaration-owned value. Keeping this normalization in the parent means
 * retries and approval recovery compare the same payload that the Server
 * persists in its durable interaction target.
 */
function generatedSurfaceActionPayload(
  action: GeneratedSurfaceAction,
  payload: Record<string, JsonValue>
): Record<string, JsonValue> {
  for (const [key, templateValue] of Object.entries(action.payload_template)) {
    if (Object.hasOwn(payload, key) && stableGeneratedSurfaceJson(payload[key]) !== stableGeneratedSurfaceJson(templateValue)) {
      throw generatedSurfaceFailure("generated_surface_action_payload_template_override", "Surface操作の固定値を変更できません。");
    }
  }
  return { ...payload, ...action.payload_template };
}

function stableGeneratedSurfaceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableGeneratedSurfaceJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableGeneratedSurfaceJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function generatedSurfaceStateKey(input: Pick<GeneratedSurfaceStateRequest, "surfaceId" | "revisionId">): string {
  return JSON.stringify([input.surfaceId, input.revisionId]);
}

/** Keeps a validated iframe payload only when it still targets the current action. */
export function generatedSurfaceConfirmationRequest(
  pending: GeneratedSurfaceActionRequest | undefined,
  expected: GeneratedSurfaceActionIdentity
): GeneratedSurfaceActionRequest {
  if (pending
    && pending.surfaceId === expected.surfaceId
    && pending.revisionId === expected.revisionId
    && pending.actionId === expected.actionId) {
    return pending;
  }
  return { ...expected, payload: {} };
}

/**
 * Creates the request used by an explicit parent retry.
 *
 * A retry is the same user operation: it must retain both the frame
 * correlation and the parent operation ID. A new iframe action gets a new
 * frame request ID and therefore creates a new operation naturally.
 */
export function generatedSurfaceParentRetryRequest(
  pending: GeneratedSurfaceActionRequest | undefined,
  expected: GeneratedSurfaceActionIdentity
): GeneratedSurfaceActionRequest {
  return generatedSurfaceConfirmationRequest(pending, expected);
}

/**
 * Consumes only the exact iframe request that was submitted for approval.
 *
 * A newer iframe message for the same action must remain available rather than
 * being erased when an earlier approval request finishes.
 */
export function shouldConsumeGeneratedSurfaceConfirmationRequest(
  pending: GeneratedSurfaceActionRequest | undefined,
  submitted: GeneratedSurfaceActionRequest
): boolean {
  return pending === submitted;
}

/** Removes only the completed request; a newer frame request remains usable. */
export function clearGeneratedSurfaceActionRequestIfCurrent(
  ledger: Map<string, GeneratedSurfaceActionRequest>,
  key: string,
  requestId: string
): void {
  if (ledger.get(key)?.requestId === requestId) ledger.delete(key);
}

/** Keeps a failed state transition as the retry target until it succeeds. */
export function generatedSurfaceStateRetryRequest(
  pending: GeneratedSurfaceStateRequest | undefined,
  requested: GeneratedSurfaceStateRequest
): GeneratedSurfaceStateRequest {
  return pending && pending.surfaceId === requested.surfaceId && pending.revisionId === requested.revisionId
    ? pending
    : requested;
}

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
    parent_origin: typeof window === "undefined" ? "" : window.location.origin,
    surface_id: bundle.surface.id,
    revision_id: bundle.revision.id,
    action_ids: actionIds
  });
  const html = inlineGeneratedSurfaceAssets(bundle.bundle.html, bundle.bundle.assets);
  const css = inlineGeneratedSurfaceAssets(bundle.bundle.css ?? "", bundle.bundle.assets).replace(/<\/style/gi, "<\\/style");
  const script = (bundle.bundle.script ?? "").replace(/<\/script/gi, "<\\/script");

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${generatedSurfaceCsp}"><style>${css}</style></head><body>${html}<script>${script}</script><script>window.samuraiGeneratedSurface=${bridge};(function(){var meta=window.samuraiGeneratedSurface||{};var parentOrigin=typeof meta.parent_origin==="string"?meta.parent_origin:"";var sequence=0;function requestId(){try{if(window.crypto&&typeof window.crypto.randomUUID==="function")return "generated_surface_request_"+window.crypto.randomUUID().replace(/-/g,"");}catch(_error){}return "generated_surface_request_"+Date.now().toString(36)+"_"+(++sequence).toString(36)}window.addEventListener("message",function(event){var data=event.data;if(event.source!==window.parent||(parentOrigin&&event.origin!==parentOrigin)||!data||typeof data!=="object"||data.surface_id!==meta.surface_id||data.revision_id!==meta.revision_id)return;if(data.type!=="${generatedSurfaceActionResultType}"&&data.type!=="${generatedSurfaceActionErrorType}")return;meta.lastActionResult=data;var handler=meta.onActionResult;if(typeof handler==="function")handler(data);try{window.dispatchEvent(new CustomEvent(data.type,{detail:data}))}catch(_error){}});window.dispatchSamuraiAction=function(actionId,payload){var current=window.samuraiGeneratedSurface||meta;window.parent.postMessage({type:"samurai.generated_surface.action",request_id:requestId(),surface_id:current.surface_id,revision_id:current.revision_id,action_id:String(actionId),payload:payload||{}},"*")};window.parent.postMessage({type:"samurai.generated_surface.ready",surface_id:meta.surface_id,revision_id:meta.revision_id},"*")})();<\/script></body></html>`;
}

function inlineGeneratedSurfaceAssets(source: string, assets: GeneratedSurfaceBundleDetail["bundle"]["assets"]): string {
  const dataByPath = new Map<string, string>();
  for (const asset of assets) {
    const path = safeGeneratedSurfaceAssetPath(asset.path);
    if (!path || path !== asset.path) throw new Error("generated_surface_asset_path_invalid");
    if (!isGeneratedSurfaceAssetMimeType(asset.mime_type)) throw new Error("generated_surface_asset_mime_type_invalid");
    const inferredMimeType = generatedSurfaceAssetMimeType(path);
    if (inferredMimeType !== "application/octet-stream" && asset.mime_type !== inferredMimeType) {
      throw new Error("generated_surface_asset_mime_type_conflict");
    }
    if (!isCanonicalBase64(asset.content_base64)) throw new Error("generated_surface_asset_base64_invalid");
    if (dataByPath.has(path)) throw new Error("generated_surface_asset_duplicate");
    const dataUrl = `data:${asset.mime_type};base64,${asset.content_base64}`;
    dataByPath.set(path, dataUrl);
    dataByPath.set(`assets/${path}`, dataUrl);
  }
  const replaceReference = (reference: string): string => {
    const normalized = reference.trim().replace(/^\.\//, "");
    return dataByPath.get(normalized) ?? reference;
  };
  return source
    .replace(/((?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (_match: string, prefix: string, reference: string, suffix: string) => `${prefix}${replaceReference(reference)}${suffix}`)
    .replace(/(url\(\s*["']?)([^"')]+)(["']?\s*\))/gi, (_match: string, prefix: string, reference: string, suffix: string) => `${prefix}${replaceReference(reference)}${suffix}`);
}

function safeGeneratedSurfaceAssetPath(value: string): string | undefined {
  const path = value.trim().replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || !/^[A-Za-z0-9._~/-]+$/.test(path)) return undefined;
  const parts = path.split("/");
  return parts.some((part) => !part || part === "." || part === "..") ? undefined : path;
}

function isGeneratedSurfaceAssetMimeType(value: string): boolean {
  return /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value);
}

function generatedSurfaceAssetMimeType(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  const mimeTypes: Record<string, string> = {
    avif: "image/avif",
    css: "text/css",
    gif: "image/gif",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    json: "application/json",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    webp: "image/webp"
  };
  return (extension && mimeTypes[extension]) ?? "application/octet-stream";
}

/** Base64 is transported as text; reject non-canonical encodings before they
 * become data URLs so the browser never renders an ambiguous asset payload. */
function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  try {
    return globalThis.btoa(globalThis.atob(value)) === value;
  } catch {
    return false;
  }
}

/** Returns only a declared action from a frame that is pinned to this revision. */
export function generatedSurfaceActionFromMessage(
  data: unknown,
  expected: { surfaceId: string; revisionId: string; actions: ReadonlyArray<{ id?: string }> }
): GeneratedSurfaceActionRequest | undefined {
  const parsed = GeneratedSurfaceFrameActionRequestSchema.safeParse(data);
  if (!parsed.success) return undefined;
  if (parsed.data.surface_id !== expected.surfaceId || parsed.data.revision_id !== expected.revisionId) return undefined;
  if (!expected.actions.some((action) => action.id === parsed.data.action_id)) return undefined;
  const payload = parsed.data.payload;
  if (utf8ByteLength(JSON.stringify(payload)) > maxActionPayloadBytes) return undefined;
  return {
    surfaceId: expected.surfaceId,
    revisionId: expected.revisionId,
    actionId: parsed.data.action_id,
    payload,
    requestId: parsed.data.request_id
  };
}

function normalizeGeneratedSurfaceActionCompletion(value: GeneratedSurfaceActionCompletion | void): GeneratedSurfaceActionCompletion | undefined {
  if (!isRecord(value)) return undefined;
  const completion: GeneratedSurfaceActionCompletion = {};
  if (typeof value.operationId === "string" && value.operationId.trim()) completion.operationId = value.operationId.trim();
  if (Object.hasOwn(value, "result")) completion.result = toJsonValue(value.result);
  const latest = GeneratedSurfaceFrameLatestDataSchema.safeParse(value.latest);
  if (latest.success) completion.latest = latest.data;
  return completion;
}

function latestGeneratedSurfaceData(
  detail: GeneratedSurfaceDetail,
  completion: GeneratedSurfaceActionCompletion | undefined,
  fallbackResult: JsonValue | undefined,
  includeHistoricalInteraction = true
): GeneratedSurfaceFrameLatestData {
  const latest = completion?.latest;
  const latestInteraction = [...detail.interactions].sort((left, right) => {
    const leftTime = typeof left.created_at === "string" ? left.created_at : "";
    const rightTime = typeof right.created_at === "string" ? right.created_at : "";
    return rightTime.localeCompare(leftTime);
  })[0];
  const latestSurface = latest?.surface !== undefined ? latest.surface : toJsonValue(detail.surface);
  const latestArtifact = latest?.artifact;
  const latestData = latest?.data !== undefined
    ? latest.data
    : includeHistoricalInteraction && latestInteraction?.command_result !== undefined
      ? latestInteraction.command_result
      : fallbackResult;
  return {
    surface: latestSurface,
    ...(latestArtifact === undefined ? {} : { artifact: latestArtifact }),
    ...(latestData === undefined ? {} : { data: latestData })
  };
}

function generatedSurfaceFrameResult(
  operation: PendingGeneratedSurfaceOperation,
  detail: GeneratedSurfaceDetail
): GeneratedSurfaceFrameActionResult {
  // An accepted approval has not crossed the side-effect boundary. Do not
  // fall back to the Surface's previous interaction here: the isolated
  // document would otherwise display an older saved result as if it belonged
  // to the current approval request.
  const result = operation.status === "accepted"
    ? undefined
    : operation.completion?.result ?? latestInteractionResult(detail);
  const response = GeneratedSurfaceFrameActionResultSchema.parse({
    type: "samurai.generated_surface.action.result",
    request_id: operation.request.requestId,
    operation_id: operation.operationId,
    surface_id: operation.request.surfaceId,
    revision_id: operation.request.revisionId,
    status: operation.status === "accepted" ? "accepted" : "completed",
    saved: operation.status !== "accepted",
    ...(operation.status === "accepted" || result === undefined ? {} : { result: toJsonValue(result) }),
    latest: latestGeneratedSurfaceData(
      detail,
      operation.completion,
      operation.status === "accepted" ? undefined : toJsonValue(result),
      operation.status !== "accepted"
    )
  });
  if (utf8ByteLength(JSON.stringify(response)) > maxActionResultBytes) {
    throw generatedSurfaceFailure("generated_surface_result_too_large", "Surface操作結果が大きすぎるため表示へ返せません。");
  }
  return response;
}

function generatedSurfaceFrameError(
  operation: PendingGeneratedSurfaceOperation,
  cause: unknown,
  fallback: string,
  codeOverride?: string
): GeneratedSurfaceFrameActionError {
  const candidateCode = codeOverride ?? (isRecord(cause) && typeof cause.code === "string" ? cause.code.trim() : "");
  const code = candidateCode.length > 0 && candidateCode.length <= 256 ? candidateCode : "generated_surface_action_failed";
  const message = errorMessage(cause, fallback).slice(0, 2048) || fallback;
  return GeneratedSurfaceFrameActionErrorSchema.parse({
    type: "samurai.generated_surface.action.error",
    request_id: operation.request.requestId,
    operation_id: operation.operationId,
    surface_id: operation.request.surfaceId,
    revision_id: operation.request.revisionId,
    status: "failed",
    error: { code, message, retryable: code !== "generated_surface_operation_mismatch" }
  });
}

function generatedSurfaceFailure(code: string, message: string): Error & { code: string } {
  const failure = new Error(message) as Error & { code: string };
  failure.code = code;
  return failure;
}

function latestInteractionResult(detail: GeneratedSurfaceDetail): JsonValue | undefined {
  const latestInteraction = [...detail.interactions].sort((left, right) => {
    const leftTime = typeof left.created_at === "string" ? left.created_at : "";
    const rightTime = typeof right.created_at === "string" ? right.created_at : "";
    return rightTime.localeCompare(leftTime);
  })[0];
  return latestInteraction?.command_result;
}

/**
 * Treats the recovery prop as an authoritative projection. Only operations
 * created from that projection are eligible for removal; explicit operations
 * remain owned by the frame until their own lifecycle finishes.
 */
function syncGeneratedSurfaceRecoveryOperations(
  pendingOperations: Map<string, PendingGeneratedSurfaceOperation>,
  approvalRecoveries: ReadonlyArray<GeneratedSurfaceApprovalRecovery>,
  expected: { surfaceId: string; revisionId: string; actionIds: ReadonlyArray<string> }
): boolean {
  const currentRecoveryKeys = new Set(
    approvalRecoveries
      .filter(({ request }) => request.surfaceId === expected.surfaceId
        && request.revisionId === expected.revisionId
        && expected.actionIds.includes(request.actionId))
      .map(({ request }) => generatedSurfaceApprovalRecoveryKey(request))
  );
  let changed = false;
  for (const [requestId, operation] of pendingOperations) {
    if (operation.origin !== "recovery" || currentRecoveryKeys.has(generatedSurfaceApprovalRecoveryKey(operation.request))) continue;
    pendingOperations.delete(requestId);
    changed = true;
  }
  return changed;
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
  onClose,
  onBusyStateChange,
  approvalRecoveryNotice,
  approvalResolution,
  approvalRecoveries = []
}: GeneratedSurfaceFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const requestEpoch = useRef(0);
  const latestActionRequests = useRef(new Map<string, GeneratedSurfaceActionRequest>());
  const latestStateRequests = useRef(new Map<string, GeneratedSurfaceStateRequest>());
  const pendingConfirmationActions = useRef(new Map<string, GeneratedSurfaceActionRequest>());
  const inFlightActions = useRef(new Set<string>());
  const pendingOperations = useRef(new Map<string, PendingGeneratedSurfaceOperation>());
  const busyActionTokenRef = useRef<string | undefined>(undefined);
  const runActionRef = useRef<((request: GeneratedSurfaceActionRequest, explicitParentAction: boolean) => Promise<boolean>) | undefined>(undefined);
  const initialMatchingBundle = matchingBundle(initialBundle, detail);
  const activeFrameIdentityRef = useRef<string | undefined>(initialMatchingBundle ? generatedSurfaceBundleIdentity(initialMatchingBundle) : undefined);
  const activeBundleIdentityRef = useRef<string | undefined>(undefined);
  const frameReadyTokenRef = useRef(0);
  const [loadedBundle, setLoadedBundle] = useState<GeneratedSurfaceBundleDetail | undefined>(() => initialMatchingBundle);
  const [loading, setLoading] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [frameReady, setFrameReady] = useState(false);
  const [responseVersion, setResponseVersion] = useState(0);

  const setBusyAction = useCallback((displayId: string | undefined, token = displayId): void => {
    const wasBusy = busyActionTokenRef.current !== undefined;
    busyActionTokenRef.current = token;
    setBusyActionId(displayId);
    if (wasBusy !== (token !== undefined)) onBusyStateChange?.(token !== undefined);
  }, [onBusyStateChange]);

  const clearBusyAction = useCallback((token: string): void => {
    if (busyActionTokenRef.current !== token) return;
    setBusyAction(undefined);
  }, [setBusyAction]);

  const revision = detail.revisions.find((candidate) => candidate.id === detail.surface.current_revision_id)
    ?? detail.revisions.find((candidate) => candidate.revision === detail.surface.current_revision)
    ?? detail.revisions[0];
  const surfaceId = detail.surface.id;
  const currentRevisionId = detail.surface.current_revision_id;
  const archived = detail.surface.state === "archived";
  const actions = useMemo<GeneratedSurfaceAction[]>(() => detail.surface.actions.map((action) => ({
    id: action.id,
    label: action.label,
    payload_template: action.payload_template,
    requires_confirmation: action.requires_confirmation === true
  })), [detail.surface.actions]);
  const latestInteraction = useMemo(() => [...detail.interactions].sort((left, right) => {
    const leftTime = typeof left.created_at === "string" ? left.created_at : "";
    const rightTime = typeof right.created_at === "string" ? right.created_at : "";
    return rightTime.localeCompare(leftTime);
  })[0], [detail.interactions]);

  useEffect(() => {
    activeFrameIdentityRef.current = undefined;
    setBusyAction(undefined);
    latestActionRequests.current.clear();
    latestStateRequests.current.clear();
    pendingConfirmationActions.current.clear();
    inFlightActions.current.clear();
    pendingOperations.current.clear();
    return () => {
      latestActionRequests.current.clear();
      latestStateRequests.current.clear();
      pendingConfirmationActions.current.clear();
      inFlightActions.current.clear();
      pendingOperations.current.clear();
    };
  }, [clearBusyAction, detail.surface.id, revision?.id, setBusyAction]);

  useEffect(() => () => {
    activeFrameIdentityRef.current = undefined;
    latestActionRequests.current.clear();
    latestStateRequests.current.clear();
    pendingConfirmationActions.current.clear();
    inFlightActions.current.clear();
    pendingOperations.current.clear();
    const wasBusy = busyActionTokenRef.current !== undefined;
    busyActionTokenRef.current = undefined;
    if (wasBusy) {
      setBusyActionId(undefined);
      onBusyStateChange?.(false);
    }
  }, [onBusyStateChange]);

  useEffect(() => {
    const supplied = matchingBundle(initialBundle, detail);
    const epoch = ++requestEpoch.current;
    activeFrameIdentityRef.current = undefined;
    setLoadedBundle(undefined);
    if (supplied) {
      activeFrameIdentityRef.current = generatedSurfaceBundleIdentity(supplied);
      setLoadedBundle(supplied);
      setError(undefined);
      setLoading(false);
      return () => { requestEpoch.current += 1; activeFrameIdentityRef.current = undefined; };
    }
    if (!revision || !onLoadBundle) {
      setLoading(false);
      return () => { requestEpoch.current += 1; activeFrameIdentityRef.current = undefined; };
    }
    setLoading(true);
    setError(undefined);
    void onLoadBundle({ surfaceId: detail.surface.id, revisionId: revision.id }).then((next) => {
      if (epoch !== requestEpoch.current) return;
      if (!matchingBundle(next, detail)) {
        setLoadedBundle(undefined);
        setError("受信したSurfaceの版が現在の選択と一致しません。");
        return;
      }
      activeFrameIdentityRef.current = generatedSurfaceBundleIdentity(next);
      setLoadedBundle(next);
    }).catch((cause: unknown) => {
      if (epoch !== requestEpoch.current) return;
      setLoadedBundle(undefined);
      setError(errorMessage(cause, "Surfaceを読み込めませんでした。"));
    }).finally(() => {
      if (epoch === requestEpoch.current) setLoading(false);
    });
    return () => { requestEpoch.current += 1; activeFrameIdentityRef.current = undefined; };
  }, [currentRevisionId, initialBundle, onLoadBundle, revision?.id, surfaceId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== generatedSurfaceSandboxOrigin || event.source !== frameRef.current?.contentWindow || !revision || activeFrameIdentityRef.current !== `${detail.surface.id}\n${revision.id}`) return;
      const ready = GeneratedSurfaceFrameReadySchema.safeParse(event.data);
      if (ready.success
        && ready.data.surface_id === detail.surface.id
        && ready.data.revision_id === revision.id) {
        frameReadyTokenRef.current += 1;
        setFrameReady(true);
        setResponseVersion((current) => current + 1);
        return;
      }
      if (archived) return;
      const request = generatedSurfaceActionFromMessage(event.data, {
        surfaceId: detail.surface.id,
        revisionId: revision.id,
        actions
      });
      if (!request) return;
      const action = actions.find((candidate) => candidate.id === request.actionId);
      const actionKey = generatedSurfaceActionKey(request);
      latestActionRequests.current.set(actionKey, request);
      // A message from an isolated document never counts as a human
      // confirmation. A confirmation flow starts only from the parent UI.
      if (action?.requires_confirmation) {
        pendingConfirmationActions.current.set(generatedSurfaceActionKey(request), request);
        setNotice("確認が必要な操作は、画面上の操作ボタンから開始してください。");
        return;
      }
      void runActionRef.current?.(request, false);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [actions, archived, revision?.id, surfaceId]);

  useEffect(() => {
    if (!approvalResolution) return;
    const operation = [...pendingOperations.current.values()].find((candidate) =>
      candidate.request.requestId === approvalResolution.requestId
      && candidate.operationId === approvalResolution.operationId
    );
    // A resolution for another Surface/frame, or a mismatched operation, is
    // ignored. This is intentionally fail-closed because a stale approval
    // response must never update a newly rendered document.
    if (!operation || operation.status !== "accepted") return;
    operation.deliveredFrameToken = undefined;
    operation.deliveredResponseSignature = undefined;
    if (approvalResolution.status === "completed") {
      operation.completion = {
        operationId: operation.operationId,
        result: toJsonValue(approvalResolution.result),
        ...(approvalResolution.latest === undefined ? {} : { latest: approvalResolution.latest })
      };
      operation.error = undefined;
      operation.status = "completed";
      setError(undefined);
      setNotice("承認済みの操作結果をServerから受信しました。最新のSurfaceデータを表示へ反映しています。");
    } else {
      operation.error = GeneratedSurfaceFrameActionErrorSchema.parse({
        type: generatedSurfaceActionErrorType,
        request_id: operation.request.requestId,
        operation_id: operation.operationId,
        surface_id: operation.request.surfaceId,
        revision_id: operation.request.revisionId,
        status: "failed",
        error: approvalResolution.error
      });
      operation.completion = undefined;
      operation.status = "failed";
      setNotice(undefined);
      setError(approvalResolution.error.message);
    }
    const actionKey = generatedSurfaceActionKey(operation.request);
    clearGeneratedSurfaceActionRequestIfCurrent(latestActionRequests.current, actionKey, operation.request.requestId);
    clearGeneratedSurfaceActionRequestIfCurrent(pendingConfirmationActions.current, actionKey, operation.request.requestId);
    setResponseVersion((current) => current + 1);
  }, [approvalResolution]);

  useEffect(() => {
    const expectedFrameIdentity = `${detail.surface.id}\n${revision?.id ?? ""}`;
    let changed = syncGeneratedSurfaceRecoveryOperations(pendingOperations.current, approvalRecoveries, {
      surfaceId: detail.surface.id,
      revisionId: revision?.id ?? "",
      actionIds: actions.map((action) => action.id)
    });
    for (const recovery of approvalRecoveries) {
      const request = recovery.request;
      if (!revision
        || request.surfaceId !== detail.surface.id
        || request.revisionId !== revision.id
        || !actions.some((action) => action.id === request.actionId)) continue;
      const existing = pendingOperations.current.get(request.requestId);
      // An explicit action owns its in-memory lifecycle. A recovery projection
      // must never replace or remove that operation, even when it has the same
      // request identifiers.
      if (existing?.origin === "in-memory") continue;
      const sameRequest = existing
        && existing.operationId === request.operationId
        && generatedSurfaceOperationKey(existing.request) === generatedSurfaceOperationKey(request);
      const sameTerminalState = sameRequest
        && (recovery.status === "completed"
          ? existing.status === "completed"
            && JSON.stringify(existing.completion?.result) === JSON.stringify(recovery.result)
            && JSON.stringify(existing.completion?.latest) === JSON.stringify(recovery.latest)
          : existing.status === "failed"
            && JSON.stringify(existing.error?.error) === JSON.stringify(recovery.error));
      if (sameTerminalState) continue;
      if (existing && !sameRequest) continue;
      const operation: PendingGeneratedSurfaceOperation = existing ?? {
        request,
        operationId: request.operationId,
        frameIdentity: expectedFrameIdentity,
        origin: "recovery",
        status: "accepted"
      };
      operation.deliveredFrameToken = undefined;
      operation.deliveredResponseSignature = undefined;
      if (recovery.status === "completed") {
        operation.completion = {
          operationId: request.operationId,
          result: toJsonValue(recovery.result),
          ...(recovery.latest === undefined ? {} : { latest: recovery.latest })
        };
        operation.error = undefined;
        operation.status = "completed";
      } else {
        operation.completion = undefined;
        operation.error = GeneratedSurfaceFrameActionErrorSchema.parse({
          type: generatedSurfaceActionErrorType,
          request_id: request.requestId,
          operation_id: request.operationId,
          surface_id: request.surfaceId,
          revision_id: request.revisionId,
          status: "failed",
          error: recovery.error
        });
        operation.status = "failed";
      }
      pendingOperations.current.set(request.requestId, operation);
      // A terminal recovery is an already-settled operation. It must be
      // removed from the "latest request" ledgers so a later explicit click
      // starts a new operation instead of replaying the old approval.
      clearGeneratedSurfaceActionRequestIfCurrent(latestActionRequests.current, generatedSurfaceActionKey(request), request.requestId);
      clearGeneratedSurfaceActionRequestIfCurrent(pendingConfirmationActions.current, generatedSurfaceActionKey(request), request.requestId);
      changed = true;
    }
    if (changed) setResponseVersion((current) => current + 1);
  }, [actions, approvalRecoveries, detail.surface.id, revision]);

  // The parent may keep the originally supplied bundle while a mutation
  // refreshes the current revision. Prefer it when it still matches, then use
  // the bundle fetched for the new revision; a stale initial bundle must not
  // permanently suppress the authoritative replacement.
  const activeBundle = matchingBundle(initialBundle, detail) ?? matchingBundle(loadedBundle, detail);
  const activeBundleIdentity = activeBundle ? generatedSurfaceBundleIdentity(activeBundle) : undefined;
  useEffect(() => {
    if (activeBundleIdentityRef.current === activeBundleIdentity) return;
    activeBundleIdentityRef.current = activeBundleIdentity;
    setFrameReady(false);
    setResponseVersion((current) => current + 1);
  }, [activeBundleIdentity]);

  useEffect(() => {
    if (!frameReady || !activeBundle || !revision || activeBundleIdentityRef.current !== activeBundleIdentity) return;
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow || activeFrameIdentityRef.current !== activeBundleIdentity) return;
    const frameToken = frameReadyTokenRef.current;
    for (const operation of pendingOperations.current.values()) {
      if (operation.frameIdentity !== activeBundleIdentity || operation.status === "running") continue;
      let response: GeneratedSurfaceFrameActionResult | GeneratedSurfaceFrameActionError | undefined;
      if (operation.status === "failed") {
        response = operation.error;
      } else {
        try {
          response = generatedSurfaceFrameResult(operation, detail);
        } catch (cause) {
          operation.status = "failed";
          operation.error = generatedSurfaceFrameError(operation, cause, "Surface操作結果を表示へ返せませんでした。");
          setError(errorMessage(cause, "Surface操作結果を表示へ返せませんでした。"));
          response = operation.error;
        }
      }
      if (!response) continue;
      const signature = JSON.stringify(response);
      if (operation.deliveredFrameToken === frameToken && operation.deliveredResponseSignature === signature) continue;
      // A sandbox without allow-same-origin has an opaque origin, so the
      // targetOrigin must be "*". The incoming direction is still pinned by
      // both event.source and event.origin === "null" above.
      frameWindow.postMessage(response, "*");
      operation.deliveredFrameToken = frameToken;
      operation.deliveredResponseSignature = signature;
    }
  }, [activeBundle, activeBundleIdentity, detail, frameReady, responseVersion, revision]);

  const srcdocState = useMemo(() => {
    if (!activeBundle) return { srcdoc: undefined as string | undefined, error: undefined as string | undefined };
    try {
      return { srcdoc: generatedSurfaceSrcdoc(activeBundle), error: undefined as string | undefined };
    } catch (cause) {
      return { srcdoc: undefined as string | undefined, error: errorMessage(cause, "Surfaceの資産を検証できませんでした。") };
    }
  }, [activeBundle]);
  const srcdoc = srcdocState.srcdoc;
  const renderError = error ?? srcdocState.error;
  const currentRevisionLabel = revision ? `revision ${revision.revision}` : "版を確認できません";

  async function runAction(request: GeneratedSurfaceActionRequest, explicitParentAction: boolean): Promise<boolean> {
    const action = actions.find((candidate) => candidate.id === request.actionId);
    const actionKey = generatedSurfaceActionKey(request);
    const requestedViewKey = `${request.surfaceId}\n${request.revisionId}`;
    if (!action || disabled || archived || activeFrameIdentityRef.current !== requestedViewKey) return false;
    // A confirmation-sensitive iframe request is retained for the parent
    // button, but is never executed merely because it arrived from the frame.
    if (action.requires_confirmation && !explicitParentAction) return false;
    const requestId = generatedSurfaceRequestId(request);
    const existing = pendingOperations.current.get(requestId);
    const canonicalRequest = {
      ...request,
      payload: generatedSurfaceActionPayload(action, request.payload),
      requestId,
      // A frame retry carries the same request_id but no operation_id. Reuse
      // the first parent assignment instead of treating the retry as a new
      // operation.
      operationId: request.operationId?.trim() || existing?.operationId || generatedSurfaceOperationId(request)
    };
    let operation: PendingGeneratedSurfaceOperation;
    if (existing) {
      if (existing.operationId !== canonicalRequest.operationId
        || generatedSurfaceOperationKey(existing.request) !== generatedSurfaceOperationKey(canonicalRequest)) return false;
      if (existing.status === "running") return false;
      if (existing.status === "accepted" || existing.status === "completed") {
        existing.deliveredFrameToken = undefined;
        existing.deliveredResponseSignature = undefined;
        setResponseVersion((current) => current + 1);
        return true;
      }
      // A transiently failed request is retried with the same parent-owned
      // operation ID. A new frame action has a different request ID and does
      // not enter this branch.
      existing.status = "running";
      existing.completion = undefined;
      existing.error = undefined;
      existing.deliveredFrameToken = undefined;
      existing.deliveredResponseSignature = undefined;
      operation = existing;
    } else {
      operation = {
        request: canonicalRequest,
        operationId: canonicalRequest.operationId,
        frameIdentity: requestedViewKey,
        origin: "in-memory",
        status: "running"
      };
      pendingOperations.current.set(canonicalRequest.requestId, operation);
    }
    const fail = (cause: unknown, fallback: string, code?: string): boolean => {
      if (pendingOperations.current.get(canonicalRequest.requestId) !== operation) return false;
      if (activeFrameIdentityRef.current !== requestedViewKey) {
        pendingOperations.current.delete(canonicalRequest.requestId);
        return false;
      }
      operation.status = "failed";
      operation.error = generatedSurfaceFrameError(operation, cause, fallback, code);
      setResponseVersion((current) => current + 1);
      setError(errorMessage(cause, fallback));
      return false;
    };
    if (busyActionTokenRef.current || inFlightActions.current.has(actionKey)) {
      return fail(new Error("Surface操作は別の操作が完了するまで実行できません。"), "Surface操作は別の操作が完了するまで実行できません。", "generated_surface_action_busy");
    }
    if (action.requires_confirmation && !onRequestApproval) {
      setNotice("この操作にはServerの承認経路が必要です。現在の接続では開始できません。");
      return fail(new Error("この操作にはServerの承認経路が必要です。"), "この操作にはServerの承認経路が必要です。", "generated_surface_approval_unavailable");
    }
    if (!action.requires_confirmation && !onRunAction) {
      setNotice("このSurfaceの操作は、現在の接続では利用できません。");
      return fail(new Error("このSurfaceの操作は、現在の接続では利用できません。"), "このSurfaceの操作は、現在の接続では利用できません。", "generated_surface_action_unavailable");
    }
    inFlightActions.current.add(actionKey);
    const busyToken = `${requestedViewKey}\n${request.actionId}`;
    setBusyAction(request.actionId, busyToken);
    setError(undefined);
    try {
      if (action.requires_confirmation) {
        const completion = normalizeGeneratedSurfaceActionCompletion(await onRequestApproval!(canonicalRequest));
        if (activeFrameIdentityRef.current !== requestedViewKey) {
          pendingOperations.current.delete(canonicalRequest.requestId);
          return false;
        }
        if (completion?.operationId && completion.operationId !== operation.operationId) {
          throw generatedSurfaceFailure("generated_surface_operation_mismatch", "Serverが返したoperationIdが要求と一致しません。");
        }
        operation.completion = completion;
        // An already-completed durable request may be reopened after a
        // restart. In that case the parent can return the authoritative
        // result immediately; an operation ID alone still means that the
        // request is merely accepted and must wait for the poller.
        const terminalCompletion = completion !== undefined
          && (completion.result !== undefined || completion.latest !== undefined);
        operation.status = terminalCompletion ? "completed" : "accepted";
        setResponseVersion((current) => current + 1);
        setNotice(terminalCompletion
          ? "保存済みの操作結果をServerから受信しました。最新のSurfaceデータを表示へ反映しています。"
          : "確認要求をServerへ送信しました。結果が確定するまで操作は実行されません。");
        if (terminalCompletion && latestActionRequests.current.get(actionKey) === request) {
          latestActionRequests.current.delete(actionKey);
        }
        return true;
      }
      const completion = normalizeGeneratedSurfaceActionCompletion(await onRunAction!(canonicalRequest));
      if (activeFrameIdentityRef.current !== requestedViewKey) {
        pendingOperations.current.delete(canonicalRequest.requestId);
        return false;
      }
      if (completion?.operationId && completion.operationId !== operation.operationId) {
        throw generatedSurfaceFailure("generated_surface_operation_mismatch", "Serverが返したoperationIdが要求と一致しません。");
      }
      operation.completion = completion;
      operation.status = "completed";
      setResponseVersion((current) => current + 1);
      if (latestActionRequests.current.get(actionKey) === request) latestActionRequests.current.delete(actionKey);
      setNotice("保存済みの操作結果をServerから受信しました。最新のSurfaceデータを表示へ反映しています。");
      return true;
    } catch (cause) {
      return fail(cause, action.requires_confirmation ? "確認要求を送信できませんでした。" : "Surface操作を保存できませんでした。");
    } finally {
      inFlightActions.current.delete(actionKey);
      clearBusyAction(busyToken);
    }
  }

  async function setState(action: "pin" | "unpin" | "archive"): Promise<void> {
    if (!onSetState || busyActionTokenRef.current || disabled || archived) return;
    const requested: GeneratedSurfaceStateRequest = { surfaceId: detail.surface.id, revisionId: currentRevisionId, action };
    const requestedViewKey = `${requested.surfaceId}\n${requested.revisionId}`;
    if (activeFrameIdentityRef.current !== requestedViewKey) return;
    const stateKey = generatedSurfaceStateKey(requested);
    const stateRequest = generatedSurfaceStateRetryRequest(latestStateRequests.current.get(stateKey), requested);
    latestStateRequests.current.set(stateKey, stateRequest);
    const busyToken = `${requestedViewKey}\nstate:${stateRequest.action}`;
    setBusyAction(`state:${stateRequest.action}`, busyToken);
    setError(undefined);
    try {
      await onSetState({ surfaceId: stateRequest.surfaceId, action: stateRequest.action });
      if (activeFrameIdentityRef.current !== requestedViewKey) return;
      latestStateRequests.current.delete(stateKey);
      setNotice(stateRequest.action === "pin" ? "Surfaceをピン留めしました。" : stateRequest.action === "unpin" ? "Surfaceのピン留めを解除しました。" : "Surfaceを保管しました。");
    } catch (cause) {
      if (activeFrameIdentityRef.current === requestedViewKey) setError(errorMessage(cause, "Surfaceの状態を変更できませんでした。"));
    } finally {
      clearBusyAction(busyToken);
    }
  }

  async function exportSurface(format: "html" | "zip"): Promise<void> {
    if (!onExport || !revision || busyActionTokenRef.current || disabled) return;
    const requestedViewKey = `${detail.surface.id}\n${revision.id}`;
    if (activeFrameIdentityRef.current !== requestedViewKey) return;
    const busyToken = `${requestedViewKey}\nexport:${format}`;
    setBusyAction(`export:${format}`, busyToken);
    setError(undefined);
    try {
      const payload = await onExport({ surfaceId: detail.surface.id, revisionId: revision.id, format });
      if (activeFrameIdentityRef.current !== requestedViewKey) return;
      downloadBase64(payload);
      setNotice(`${format.toUpperCase()}を書き出しました。`);
    } catch (cause) {
      setError(errorMessage(cause, "Surfaceを書き出せませんでした。"));
    } finally {
      clearBusyAction(busyToken);
    }
  }

  runActionRef.current = runAction;

  function runParentAction(action: GeneratedSurfaceAction): void {
    if (!revision) return;
    const expected = {
      surfaceId: detail.surface.id,
      revisionId: revision.id,
      actionId: action.id
    };
    const pending = latestActionRequests.current.get(generatedSurfaceActionKey(expected));
    const pendingOperation = pending
      ? pendingOperations.current.get(generatedSurfaceRequestId(pending))
      : undefined;
    if (pending && (pendingOperation?.status === "accepted" || pendingOperation?.status === "running" || pendingOperation?.status === "completed")) {
      void runAction(pending, true);
      return;
    }
    const retryRequest = generatedSurfaceParentRetryRequest(pending, expected);
    latestActionRequests.current.set(generatedSurfaceActionKey(expected), retryRequest);
    void runAction(retryRequest, true);
  }

  return <section className="native-generated-surface" aria-label={`${detail.surface.title}の操作画面`}>
    <header className="native-generated-surface-toolbar">
      <div><span className="native-section-eyebrow">Generated surface</span><strong>{detail.surface.title}</strong><small>{currentRevisionLabel}</small></div>
      <div className="native-generated-surface-toolbar-actions">
        {onSetState && !archived ? <><button type="button" className="native-button native-button-quiet" disabled={disabled || Boolean(busyActionId)} onClick={() => void setState(detail.surface.state === "pinned" ? "unpin" : "pin")}>{detail.surface.state === "pinned" ? "ピン解除" : "ピン留め"}</button><button type="button" className="native-button native-button-quiet" disabled={disabled || Boolean(busyActionId)} onClick={() => void setState("archive")}>保管</button></> : archived ? <span className="native-inline-note">保管済み</span> : null}
        {onExport ? <><button type="button" className="native-button native-button-quiet" disabled={disabled || Boolean(busyActionId) || !revision} onClick={() => void exportSurface("html")}>HTML</button><button type="button" className="native-button native-button-quiet" disabled={disabled || Boolean(busyActionId) || !revision} onClick={() => void exportSurface("zip")}>ZIP</button></> : null}
        {onClose ? <button type="button" className="native-button native-button-quiet" onClick={onClose} disabled={Boolean(busyActionId)}>閉じる</button> : null}
      </div>
    </header>
    {loading ? <p className="native-inline-note" role="status">隔離したSurfaceを読み込んでいます…</p> : null}
    {renderError ? <p className="native-inline-error" role="alert">{renderError}</p> : null}
    {approvalRecoveryNotice ? <p className="native-inline-note" role="status">{approvalRecoveryNotice}</p> : null}
    {notice ? <p className="native-inline-note" role="status">{notice}</p> : null}
    {latestInteraction ? <details className="native-generated-surface-result"><summary>Serverの操作結果</summary><pre>{safeInlineJson(latestInteraction.command_result !== undefined ? latestInteraction.command_result : latestInteraction)}</pre></details> : null}
    {srcdoc && activeBundle ? <iframe key={generatedSurfaceBundleIdentity(activeBundle)} ref={frameRef} className="native-generated-surface-frame" title={detail.surface.title} sandbox="allow-scripts" srcDoc={srcdoc} /> : !loading ? <p className="native-inline-note">表示できるSurface bundleがありません。保存済みの成果物または文章表示へ戻ってください。</p> : null}
    {actions.length > 0 ? <div className="native-generated-surface-actions" aria-label="Surface操作">{actions.map((action) => <button key={action.id} type="button" className="native-button" disabled={disabled || archived || Boolean(busyActionId) || !revision} onClick={() => runParentAction(action)}>{busyActionId === action.id ? "送信中…" : action.requires_confirmation ? `${action.label}（確認）` : action.label}</button>)}</div> : null}
  </section>;
}

export function matchingBundle(bundle: GeneratedSurfaceBundleDetail | undefined, detail: GeneratedSurfaceDetail): GeneratedSurfaceBundleDetail | undefined {
  if (!bundle) return undefined;
  if (bundle.surface.id !== detail.surface.id || bundle.revision.id !== detail.surface.current_revision_id) return undefined;
  return bundle;
}

export function generatedSurfaceBundleIdentity(bundle: GeneratedSurfaceBundleDetail): string {
  return `${bundle.surface.id}\n${bundle.revision.id}`;
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value)).replace(/</g, "\\u003c");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return typeof TextEncoder === "undefined" ? value.length : new TextEncoder().encode(value).byteLength;
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return isRecord(cause) && typeof cause.message === "string" && cause.message.trim() ? cause.message : fallback;
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
