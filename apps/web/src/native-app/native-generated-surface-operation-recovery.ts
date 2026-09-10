import { stableHash } from "@samurai-agent/core-schemas";
import type { JsonValue } from "@samurai-agent/core-schemas";
import type { GeneratedSurfaceFrameActionError, GeneratedSurfaceFrameLatestData } from "@samurai-agent/ui-protocol";
import {
  createIdempotencyKey,
  type DesktopWorkspaceInteractionRequest,
  type DesktopWorkspaceInteractionResult
} from "../lib/api";
import type { WorkspaceOperationHistoryRecord } from "../lib/workspace-browser-bridge";
import type {
  GeneratedSurfaceActionCompletion,
  GeneratedSurfaceActionRequest,
  GeneratedSurfaceApprovalRecovery,
  GeneratedSurfaceApprovalResolution
} from "./GeneratedSurfaceFrame";
import type { NativeArtifactWorkspaceBridge, NativeArtifactWorkspaceTarget } from "./NativeArtifactWorkspace";

/**
 * Client-side correlation state for one durable Generated Surface operation.
 * The Server remains authoritative for the operation and request records.
 */
export interface NativeSurfaceOperationState {
  snapshot: string;
  operationId: string;
  /** Server request ID once a confirmation request has been durably created. */
  requestId?: string;
  /** Current isolated-frame request ID; it may change after a restart. */
  frameRequestId?: string;
  /** Chooses the only valid terminal-result delivery path for approvals. */
  approvalResultChannel?: "frame" | "recovery";
}

/** The payload identity is the logical operation boundary for retry reuse. */
export function nativeSurfaceOperationSnapshot(input: GeneratedSurfaceActionRequest): string {
  return JSON.stringify([input.surfaceId, input.revisionId, input.actionId, input.payload]);
}

export function nativeSurfaceStateOperationSnapshot(input: { surfaceId: string; revisionId: string; action: "pin" | "unpin" | "archive" }): string {
  return JSON.stringify([input.surfaceId, input.revisionId, input.action]);
}

export function operationForNativeSurfaceSnapshot(previous: NativeSurfaceOperationState | undefined, snapshot: string, preferredOperationId?: string): NativeSurfaceOperationState {
  if (previous?.snapshot === snapshot) return previous;
  const operationId = preferredOperationId?.trim() || createIdempotencyKey();
  return { snapshot, operationId };
}

export interface NativeSurfaceApprovalHistoryMatch {
  requestId: string;
  status: string;
  /** Present only when the durable request carries a mutation operation ID. */
  operationId?: string;
}

const activeSurfaceApprovalStatuses = new Set(["pending", "accepted", "executing"]);

export function nativeSurfaceApprovalIsActive(status: string): boolean {
  return activeSurfaceApprovalStatuses.has(status);
}

/**
 * Finds the exact action operation in Server-owned operation/result history.
 * A missing or ambiguous match is deliberately not guessed: the caller may
 * start a new explicit action only when the history has no candidate.
 */
export async function recoverNativeSurfaceActionOperation(
  bridge: Pick<NativeArtifactWorkspaceBridge, "listWorkspaceOperationHistory"> | undefined,
  target: NativeArtifactWorkspaceTarget,
  input: GeneratedSurfaceActionRequest
): Promise<NativeSurfaceOperationState | undefined> {
  const list = bridge?.listWorkspaceOperationHistory;
  if (!list) return undefined;
  const snapshot = nativeSurfaceOperationSnapshot(input);
  const inputHash = nativeGeneratedSurfaceActionInputHash(target, input);
  const [operationHistory, resultHistory] = await Promise.all([
    list({ roomId: target.roomId, recordType: "domain_operation", target }),
    list({ roomId: target.roomId, recordType: "generated_surface_action_result", target })
  ]);
  const candidates = new Map<string, NativeSurfaceOperationState>();
  const resultOperationIds = new Set(
    resultHistory.records
      .filter((record) => nativeSurfaceActionResultRecordMatches(record, target, inputHash))
      .map((record) => record.id)
  );
  for (const record of operationHistory.records) {
    if (nativeSurfaceActionOperationRecordMatches(record, target, input, inputHash)) {
      // A result record can validate a completed replay, but it can never
      // identify an operation by itself: the Server would otherwise execute
      // a new side effect against an orphaned result ID.
      if (record.payload.status === "completed" && !resultOperationIds.has(record.id)) {
        throw new Error("generated_surface_operation_result_recovery_required");
      }
      candidates.set(record.id, { snapshot, operationId: record.id });
    }
  }
  if (candidates.size > 1) throw new Error("generated_surface_operation_recovery_ambiguous");
  return [...candidates.values()][0];
}

/** Recovers a lifecycle operation using its exact interaction/result identity. */
export async function recoverNativeSurfaceStateOperation(
  bridge: Pick<NativeArtifactWorkspaceBridge, "listWorkspaceOperationHistory"> | undefined,
  target: NativeArtifactWorkspaceTarget,
  input: { surfaceId: string; revisionId: string; action: "pin" | "unpin" | "archive" }
): Promise<NativeSurfaceOperationState | undefined> {
  const list = bridge?.listWorkspaceOperationHistory;
  if (!list) return undefined;
  const snapshot = nativeSurfaceStateOperationSnapshot(input);
  const interactionKind = nativeSurfaceStateInteractionKind(input.action);
  const [operationHistory, interactionHistory, resultHistory] = await Promise.all([
    list({ roomId: target.roomId, recordType: "domain_operation", target }),
    list({ roomId: target.roomId, recordType: "surface_interaction", target }),
    list({ roomId: target.roomId, recordType: "generated_surface_operation_result", target })
  ]);
  const interactionOperationIds = new Set<string>();
  for (const record of interactionHistory.records) {
    const payload = record.payload;
    if (payload.surface_id === input.surfaceId
      && payload.revision_id === input.revisionId
      && payload.kind === interactionKind
      && typeof payload.domain_operation_id === "string") {
      interactionOperationIds.add(payload.domain_operation_id);
    }
  }
  if (interactionOperationIds.size > 1) throw new Error("generated_surface_operation_recovery_ambiguous");
  if (interactionOperationIds.size === 1) {
    const operationId = [...interactionOperationIds][0];
    if (!operationId) return undefined;
    const operation = operationHistory.records.find((record) => record.id === operationId
      && record.payload.operation === "generated_surface.state"
      && record.payload.room_id === target.roomId
      && nativeSurfaceTargetResourceRefMatches(record.payload.target_resource_refs, input.surfaceId)
      && record.payload.input_hash === nativeGeneratedSurfaceStateInputHash(target, input, operationId));
    if (!operation) return undefined;
    if (operation.payload.status === "completed" && !resultHistory.records.some((record) => record.id === operationId
      && record.payload.operation_id === operationId
      && record.payload.operation === "generated_surface.state"
      && record.payload.room_id === target.roomId
      && record.payload.input_hash === operation.payload.input_hash)) {
      throw new Error("generated_surface_operation_result_recovery_required");
    }
    return { snapshot, operationId };
  }

  const pendingCandidates = operationHistory.records.filter((record) => {
    const payload = record.payload;
    return payload.operation === "generated_surface.state"
      && payload.room_id === target.roomId
      && nativeSurfaceTargetResourceRefMatches(payload.target_resource_refs, input.surfaceId)
      && payload.status !== "completed"
      && payload.status !== "failed"
      && payload.input_hash === nativeGeneratedSurfaceStateInputHash(target, input, record.id);
  });
  if (pendingCandidates.length > 1) throw new Error("generated_surface_operation_recovery_ambiguous");
  const pending = pendingCandidates[0];
  return pending ? { snapshot, operationId: pending.id } : undefined;
}

/** Reuses a durable approval request without trying to reverse its hashed ID. */
export async function recoverNativeSurfaceApprovalRequest(
  bridge: Pick<NativeArtifactWorkspaceBridge, "listWorkspaceOperationHistory"> | undefined,
  target: NativeArtifactWorkspaceTarget,
  input: GeneratedSurfaceActionRequest,
  knownRequestId?: string
): Promise<NativeSurfaceApprovalHistoryMatch | undefined> {
  const list = bridge?.listWorkspaceOperationHistory;
  if (!list) return undefined;
  const history = await list({ roomId: target.roomId, recordType: "interaction_request", target });
  const matches = history.records.filter((record) => nativeSurfaceApprovalHistoryRecordMatches(record, target, input));
  const activeMatches = matches.filter((record) => nativeSurfaceApprovalIsActive(String(record.payload.status)));
  if (activeMatches.length > 1) throw new Error("generated_surface_approval_recovery_ambiguous");
  const record = knownRequestId
    ? matches.find((candidate) => candidate.id === knownRequestId)
    : activeMatches[0] ?? (matches.length === 1 ? matches[0] : undefined);
  if (!record) return undefined;
  const operationId = typeof record.payload.operation_id === "string"
    ? record.payload.operation_id
    : typeof record.payload.response_operation_id === "string"
      ? record.payload.response_operation_id
      : undefined;
  return { requestId: record.id, status: String(record.payload.status), ...(operationId ? { operationId } : {}) };
}

/**
 * A public interaction request can be associated with the current Surface
 * only when its server-owned scope still names the same Room, revision, and
 * action. The payload is checked separately because a recovered request may
 * be visible after a restart even though the renderer no longer has the
 * original in-memory action input.
 */
export function nativeSurfaceApprovalRequestScopeMatches(
  request: DesktopWorkspaceInteractionRequest,
  target: NativeArtifactWorkspaceTarget,
  input: Pick<GeneratedSurfaceActionRequest, "surfaceId" | "revisionId" | "actionId">
): boolean {
  const actionTarget = request.actionTarget;
  return request.kind === "approval"
    && request.workspaceId === target.workspaceId
    && request.roomId === target.roomId
    && request.surfaceId === input.surfaceId
    && request.revisionId === input.revisionId
    && actionTarget.kind === "generated_surface_action"
    && actionTarget.room_id === target.roomId
    && actionTarget.surface_id === input.surfaceId
    && actionTarget.revision_id === input.revisionId
    && actionTarget.action_id === input.actionId
    && isRecord(actionTarget.payload);
}

/**
 * Chooses the current durable approval projection for an isolated Surface.
 * Interaction history remains available in the parent UI, but an iframe has a
 * single current-result channel.
 */
export function nativeLatestSurfaceApprovalRequest(
  requests: readonly DesktopWorkspaceInteractionRequest[],
  target: NativeArtifactWorkspaceTarget,
  scope: {
    surfaceId: string;
    revisionId: string;
    actionIds: ReadonlySet<string>;
  }
): DesktopWorkspaceInteractionRequest | undefined {
  return requests
    .filter((request) => {
      const actionId = typeof request.actionTarget.action_id === "string" ? request.actionTarget.action_id : "";
      return scope.actionIds.has(actionId)
        && nativeSurfaceApprovalRequestScopeMatches(request, target, {
          surfaceId: scope.surfaceId,
          revisionId: scope.revisionId,
          actionId
        });
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
}

/**
 * Immutable identity captured when approval polling starts. A response may be
 * valid for its original request and still be stale for a Surface that was
 * closed, reopened, or moved while the request was in flight.
 */
export interface NativeSurfaceApprovalPollScope {
  generation: number;
  targetKey: string;
  surfaceViewKey: string;
}

/** Keeps delayed approval polling from updating a later Surface view. */
export function nativeSurfaceApprovalPollScopeIsCurrent(
  scope: NativeSurfaceApprovalPollScope,
  current: NativeSurfaceApprovalPollScope
): boolean {
  return scope.generation === current.generation
    && scope.targetKey === current.targetKey
    && scope.surfaceViewKey === current.surfaceViewKey;
}

/**
 * Reuse requires exact payload equality. A subset comparison would allow a
 * recovered request with a different dynamic target to be reused silently.
 */
export function nativeSurfaceApprovalRequestMatches(
  request: DesktopWorkspaceInteractionRequest,
  target: NativeArtifactWorkspaceTarget,
  input: GeneratedSurfaceActionRequest
): boolean {
  return nativeSurfaceApprovalRequestScopeMatches(request, target, input)
    && stableJson(request.actionTarget.payload) === stableJson(input.payload);
}

export function nativeSurfaceApprovalInputFromRequest(
  request: DesktopWorkspaceInteractionRequest,
  target: NativeArtifactWorkspaceTarget
): GeneratedSurfaceActionRequest | undefined {
  const actionTarget = request.actionTarget;
  if (request.kind !== "approval"
    || request.workspaceId !== target.workspaceId
    || request.roomId !== target.roomId
    || typeof request.surfaceId !== "string"
    || typeof request.revisionId !== "string"
    || actionTarget.kind !== "generated_surface_action"
    || typeof actionTarget.action_id !== "string"
    || !isRecord(actionTarget.payload)) {
    return undefined;
  }
  return {
    surfaceId: request.surfaceId,
    revisionId: request.revisionId,
    actionId: actionTarget.action_id,
    payload: actionTarget.payload as Record<string, JsonValue>,
    requestId: request.id
  };
}

/** Clears only the operation that completed; a newer retry remains protected. */
export function clearNativeSurfaceOperationLedger(
  ledger: Map<string, NativeSurfaceOperationState>,
  key: string,
  operation: NativeSurfaceOperationState
): void {
  if (ledger.get(key) === operation) ledger.delete(key);
}

/**
 * Projects one durable approval result into exactly one frame delivery mode.
 * A current frame receives only a matching `requestId`/`operationId` pair;
 * a recovered operation is instead supplied as a remount-safe recovery.
 */
export function nativeSurfaceApprovalTerminalProjection(
  operation: NativeSurfaceOperationState,
  input: GeneratedSurfaceActionRequest,
  terminal: { status: "completed"; result: JsonValue; latest?: GeneratedSurfaceFrameLatestData }
    | { status: "failed"; error: GeneratedSurfaceFrameActionError["error"] }
): { channel: "frame"; resolution: GeneratedSurfaceApprovalResolution } | { channel: "recovery"; recovery: GeneratedSurfaceApprovalRecovery } | undefined {
  const frameRequestId = operation.frameRequestId;
  if (!frameRequestId) return undefined;
  if (terminal.status === "completed") {
    if (operation.approvalResultChannel === "frame") {
      return {
        channel: "frame",
        resolution: {
          requestId: frameRequestId,
          operationId: operation.operationId,
          status: "completed",
          result: terminal.result,
          ...(terminal.latest === undefined ? {} : { latest: terminal.latest })
        }
      };
    }
    return {
      channel: "recovery",
      recovery: {
        request: { ...input, requestId: frameRequestId, operationId: operation.operationId },
        status: "completed",
        result: terminal.result,
        ...(terminal.latest === undefined ? {} : { latest: terminal.latest })
      }
    };
  }
  if (operation.approvalResultChannel === "frame") {
    return {
      channel: "frame",
      resolution: {
        requestId: frameRequestId,
        operationId: operation.operationId,
        status: "failed",
        error: terminal.error
      }
    };
  }
  return {
    channel: "recovery",
    recovery: {
      request: { ...input, requestId: frameRequestId, operationId: operation.operationId },
      status: "failed",
      error: terminal.error
    }
  };
}

/**
 * Projects a Server-owned interaction result only after rechecking its
 * Surface scope and exact action payload.
 */
export function nativeCompletedSurfaceApprovalCompletion(
  response: DesktopWorkspaceInteractionResult,
  target: NativeArtifactWorkspaceTarget,
  input: GeneratedSurfaceActionRequest,
  requestId: string,
  operationId: string
): GeneratedSurfaceActionCompletion | undefined {
  const scopeMatches = response.request.id === requestId
    && nativeSurfaceApprovalRequestMatches(response.request, target, input);
  if (!scopeMatches) throw new Error("generated_surface_approval_result_scope_invalid");
  if (response.request.status !== "completed" || response.targetResult === undefined) return undefined;
  return { operationId, result: response.targetResult };
}

export function nativeSurfaceApprovalOperationForRequest(
  ledger: Map<string, NativeSurfaceOperationState>,
  requestId: string
): NativeSurfaceOperationState | undefined {
  const matches = [...ledger.values()].filter((operation) => operation.requestId === requestId);
  if (matches.length > 1) throw new Error("generated_surface_approval_operation_ambiguous");
  return matches[0];
}

export function recoveredNativeSurfaceApprovalFrameRequestId(
  target: NativeArtifactWorkspaceTarget,
  requestId: string
): string {
  return `generated_surface_recovered_request_${stableHash({ workspace_id: target.workspaceId, room_id: target.roomId, request_id: requestId })}`;
}

export function recoveredNativeSurfaceApprovalOperation(
  target: NativeArtifactWorkspaceTarget,
  input: GeneratedSurfaceActionRequest,
  requestId: string
): NativeSurfaceOperationState {
  return {
    snapshot: nativeSurfaceOperationSnapshot(input),
    operationId: `generated_surface_recovered_operation_${stableHash({ workspace_id: target.workspaceId, room_id: target.roomId, request_id: requestId })}`,
    requestId,
    frameRequestId: recoveredNativeSurfaceApprovalFrameRequestId(target, requestId),
    approvalResultChannel: "recovery"
  };
}

/** Accepts only the Server's durable approval-request envelope, never an ordinary action result. */
export function assertNativeGeneratedSurfaceApprovalResponse(
  value: unknown,
  target: NativeArtifactWorkspaceTarget,
  input: GeneratedSurfaceActionRequest
): DesktopWorkspaceInteractionRequest {
  if (!isRecord(value) || value.status !== "approval_required") {
    throw new Error("generated_surface_approval_response_invalid");
  }
  const request = value.request;
  if (!isRecord(request)
    || typeof request.id !== "string" || request.id.length === 0
    || request.workspaceId !== target.workspaceId
    || request.roomId !== target.roomId
    || request.kind !== "approval"
    || request.status !== "pending"
    || request.surfaceId !== input.surfaceId
    || request.revisionId !== input.revisionId) {
    throw new Error("generated_surface_approval_request_invalid");
  }
  const parsed = request as unknown as DesktopWorkspaceInteractionRequest;
  if (!nativeSurfaceApprovalRequestMatches(parsed, target, input)) {
    throw new Error("generated_surface_approval_target_invalid");
  }
  return parsed;
}

export function nativeGeneratedSurfaceActionInputHash(target: NativeArtifactWorkspaceTarget, input: GeneratedSurfaceActionRequest): string {
  return stableHash({
    room_id: target.roomId,
    surface_id: input.surfaceId,
    action_id: input.actionId,
    revision_id: input.revisionId ?? null,
    action_payload: input.payload ?? {},
    interaction_id: null,
    message_id: null
  });
}

export function nativeGeneratedSurfaceStateInputHash(
  target: NativeArtifactWorkspaceTarget,
  input: { surfaceId: string; revisionId: string; action: "pin" | "unpin" | "archive" },
  operationId: string
): string {
  return stableHash({
    room_id: target.roomId,
    surface_id: input.surfaceId,
    action: input.action,
    interaction_id: `surface_interaction_${stableHash(operationId)}`
  });
}

function nativeSurfaceActionOperationRecordMatches(
  record: WorkspaceOperationHistoryRecord,
  target: NativeArtifactWorkspaceTarget,
  input: GeneratedSurfaceActionRequest,
  inputHash: string
): boolean {
  const payload = record.payload;
  return payload.operation === "generated_surface.action.run"
    && payload.room_id === target.roomId
    && payload.input_hash === inputHash
    && nativeSurfaceTargetResourceRefMatches(payload.target_resource_refs, input.surfaceId)
    && nativeSurfaceTargetResourceRefMatches(payload.target_resource_refs, input.revisionId);
}

function nativeSurfaceActionResultRecordMatches(
  record: WorkspaceOperationHistoryRecord,
  target: NativeArtifactWorkspaceTarget,
  inputHash: string
): boolean {
  const payload = record.payload;
  return payload.operation_id === record.id
    && payload.operation === "generated_surface.action.run"
    && payload.room_id === target.roomId
    && payload.input_hash === inputHash;
}

function nativeSurfaceApprovalHistoryRecordMatches(
  record: WorkspaceOperationHistoryRecord,
  target: NativeArtifactWorkspaceTarget,
  input: GeneratedSurfaceActionRequest
): boolean {
  const payload = record.payload;
  const actionTarget = payload.action_target;
  return payload.kind === "approval"
    && payload.room_id === target.roomId
    && payload.surface_id === input.surfaceId
    && payload.revision_id === input.revisionId
    && isRecord(actionTarget)
    && actionTarget.kind === "generated_surface_action"
    && actionTarget.room_id === target.roomId
    && actionTarget.surface_id === input.surfaceId
    && actionTarget.revision_id === input.revisionId
    && actionTarget.action_id === input.actionId
    && stableJson(actionTarget.payload) === stableJson(input.payload);
}

function nativeSurfaceTargetResourceRefMatches(value: unknown, id: string): boolean {
  return Array.isArray(value) && value.some((candidate) => {
    if (!isRecord(candidate)) return false;
    return candidate.id === id && (candidate.kind === "generated_surface" || candidate.kind === "generated_surface_revision");
  });
}

function nativeSurfaceStateInteractionKind(action: "pin" | "unpin" | "archive"): "pinned" | "unpinned" | "dismissed" {
  return action === "pin" ? "pinned" : action === "unpin" ? "unpinned" : "dismissed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
