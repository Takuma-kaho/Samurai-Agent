import { createHash } from "node:crypto";
import { canonicalJson } from "./auth";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import type { PutRecordInput, PutRecordResult } from "./workspace-server-store";
import type { WorkspaceRecord, WorkspaceRecordPayload, WorkspaceRequestContext } from "./types";

export const WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE = "interaction_request";
export const workspaceInteractionRequestKinds = ["approval", "backend_input"] as const;
export type WorkspaceInteractionRequestKind = (typeof workspaceInteractionRequestKinds)[number];

export const workspaceInteractionDecisions = ["approve", "deny", "submit_input"] as const;
export type WorkspaceInteractionDecision = (typeof workspaceInteractionDecisions)[number];

export const workspaceInteractionRequestStatuses = [
  "pending",
  "accepted",
  "executing",
  "completed",
  "failed",
  "denied",
  "cancelled",
  "expired"
] as const;
export type WorkspaceInteractionRequestStatus = (typeof workspaceInteractionRequestStatuses)[number];
export const workspaceInteractionExecutionStatuses = ["executing", "completed", "failed"] as const;
export type WorkspaceInteractionExecutionStatus = (typeof workspaceInteractionExecutionStatuses)[number];

export type WorkspaceInteractionJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkspaceInteractionJsonValue[]
  | { [key: string]: WorkspaceInteractionJsonValue };

export type WorkspaceInteractionJsonObject = { [key: string]: WorkspaceInteractionJsonValue };
export type WorkspaceInteractionInputSchema = WorkspaceInteractionJsonObject;

export interface WorkspaceInteractionOption {
  id: string;
  label: string;
  decision: WorkspaceInteractionDecision;
  description?: string;
}

export type WorkspaceInteractionActionTarget = WorkspaceInteractionJsonObject;

export type WorkspaceInteractionRequestOutcome =
  | {
    kind: "response";
    optionId: string;
    decision: WorkspaceInteractionDecision;
    decidedAt: string;
  }
  | { kind: "cancelled"; decidedAt: string }
  | { kind: "expired"; expiredAt: string };

/** Safe public execution projection. Owner and operation identifiers stay internal. */
export interface WorkspaceInteractionExecutionProjection {
  status: WorkspaceInteractionExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  errorCode?: string;
}

/** Public projection of the durable interaction request record. */
export interface WorkspaceInteractionRequest {
  id: string;
  workspaceId: string;
  roomId: string;
  version: number;
  kind: WorkspaceInteractionRequestKind;
  status: WorkspaceInteractionRequestStatus;
  title: string;
  summary: string;
  runId?: string;
  surfaceId?: string;
  revisionId?: string;
  actionTarget: WorkspaceInteractionActionTarget;
  options: readonly WorkspaceInteractionOption[];
  inputSchema?: WorkspaceInteractionInputSchema;
  requestedAccountId: string;
  decidedAccountId?: string;
  expiresAt: string;
  outcome?: WorkspaceInteractionRequestOutcome;
  execution?: WorkspaceInteractionExecutionProjection;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInteractionRequestCreateInput {
  roomId: string;
  kind: WorkspaceInteractionRequestKind;
  title?: string;
  summary?: string;
  runId?: string;
  surfaceId?: string;
  revisionId?: string;
  /** Compatibility alias for callers that use the shorter revision name. */
  revision?: string;
  actionTarget?: WorkspaceInteractionActionTarget;
  /** Compatibility alias; the Server still owns the value and persists it. */
  target?: WorkspaceInteractionActionTarget;
  options: readonly WorkspaceInteractionOption[];
  inputSchema?: WorkspaceInteractionInputSchema;
  expiresAt?: string;
  ttlMs?: number;
}

export interface WorkspaceInteractionRequestListInput {
  roomId: string;
  includeResolved?: boolean;
  limit?: number;
}

export interface WorkspaceInteractionRequestGetInput {
  roomId: string;
  requestId: string;
}

export interface WorkspaceInteractionRequestRespondInput {
  roomId: string;
  requestId: string;
  expectedVersion: number;
  /** The response must name an option declared in the persisted request. */
  optionId: string;
  /** Accepted only when it agrees with the persisted option. */
  decision?: WorkspaceInteractionDecision;
  /** Backend input payload. It is checked against the persisted inputSchema. */
  input?: WorkspaceInteractionJsonValue;
  /** UI compatibility alias for an object-valued backend input. */
  values?: WorkspaceInteractionJsonObject;
}

export interface WorkspaceInteractionRequestTransitionInput {
  roomId: string;
  requestId: string;
  expectedVersion: number;
}

export interface WorkspaceInteractionExecutionClaimInput extends WorkspaceInteractionRequestTransitionInput {
  /** Stable identity of the worker/process that owns the claim. */
  ownerId: string;
  /** Stable idempotency identity for this execution attempt. */
  executionOperationId: string;
  /** Optional bounded lease. Recovery is explicit after this time. */
  leaseMs?: number;
}

export interface WorkspaceInteractionExecutionClaim {
  ownerId: string;
  executionOperationId: string;
  startedAt: string;
  leaseUntil: string;
  attempt: number;
}

/** Internal Server-only target loaded from the immutable request record. */
export interface WorkspaceInteractionExecutionTarget {
  roomId: string;
  runId?: string;
  surfaceId?: string;
  revisionId?: string;
  actionTarget: WorkspaceInteractionActionTarget;
}

export interface WorkspaceInteractionExecutionClaimResult {
  request: WorkspaceInteractionRequest;
  claim: WorkspaceInteractionExecutionClaim;
  /** Never replace this with a client-provided target or expose it as a mutation payload. */
  executionTarget: WorkspaceInteractionExecutionTarget;
  /** Internal only: the persisted backend input must be passed to Runtime, never to a client. */
  executionInput?: WorkspaceInteractionJsonValue;
  replayed: boolean;
}

export type WorkspaceInteractionExecutionSettlementStatus = "completed" | "failed";

export interface WorkspaceInteractionExecutionSettlementInput extends WorkspaceInteractionRequestTransitionInput {
  ownerId: string;
  executionOperationId: string;
  status: WorkspaceInteractionExecutionSettlementStatus;
  /** Short non-secret summary only; arbitrary result/input objects are not accepted. */
  summary?: string;
  /** Stable non-secret error code for a failed execution. */
  errorCode?: string;
}

export interface WorkspaceInteractionExecutionSettlementResult {
  request: WorkspaceInteractionRequest;
  replayed: boolean;
}

export interface WorkspaceInteractionRequestMutationResult {
  request: WorkspaceInteractionRequest;
  replayed: boolean;
}

/**
 * A terminal lifecycle transition found by the Server maintenance lane.
 *
 * `eventOperationId` is stable for the transition, so a process restart can
 * retry durable Event delivery without producing a second public Event.
 */
export interface WorkspaceInteractionRequestMaintenanceResult {
  request: WorkspaceInteractionRequest;
  action: "expired" | "failed";
  eventOperationId: string;
  deliveryOperationId: string;
}

export interface WorkspaceInteractionRequestMaintenanceInput {
  roomId: string;
  limit?: number;
}

export interface WorkspaceInteractionRequestMaintenanceDeliveryInput extends WorkspaceInteractionRequestTransitionInput {
  eventOperationId: string;
}

export interface WorkspaceInteractionRequestRecordStore {
  getRecord(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; recordType: string; id: string }
  ): Promise<WorkspaceRecord>;
  listRecords(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; recordType?: string; limit?: number }
  ): Promise<WorkspaceRecord[]>;
  putRecord(context: WorkspaceRequestContext, input: PutRecordInput): Promise<PutRecordResult>;
}

export interface WorkspaceInteractionRequestServiceOptions {
  clock?: () => Date;
  defaultTtlMs?: number;
  executionLeaseMs?: number;
}

type InteractionReadContext = Pick<WorkspaceRequestContext, "workspaceId" | "accountId">;

interface StoredInteractionRequestPayload extends WorkspaceRecordPayload {
  schema_version: 1;
  kind: WorkspaceInteractionRequestKind;
  room_id: string;
  run_id: string | null;
  surface_id: string | null;
  revision_id: string | null;
  action_target: WorkspaceInteractionActionTarget;
  title: string;
  summary: string;
  options: WorkspaceInteractionOption[];
  input_schema?: WorkspaceInteractionInputSchema;
  requested_account_id: string;
  status: WorkspaceInteractionRequestStatus;
  decided_account_id?: string;
  expires_at: string;
  ttl_ms?: number;
  outcome?: StoredInteractionRequestOutcome;
  created_at: string;
  /** Legacy last-mutation provenance; specific operation IDs below are authoritative. */
  operation_id?: string;
  response_operation_id?: string;
  cancel_operation_id?: string;
  expire_operation_id?: string;
  /** Durable outbox marker for Server-maintained terminal transitions. */
  maintenance_event?: StoredInteractionMaintenanceEvent;
  execution?: StoredInteractionExecution;
}

interface StoredInteractionResponseOutcome {
  kind: "response";
  optionId: string;
  decision: WorkspaceInteractionDecision;
  input?: WorkspaceInteractionJsonValue;
  decidedAt: string;
}

type StoredInteractionRequestOutcome =
  | StoredInteractionResponseOutcome
  | { kind: "cancelled"; decidedAt: string }
  | { kind: "expired"; expiredAt: string };

interface StoredInteractionMaintenanceEvent {
  action: "expired" | "failed";
  operation_id: string;
  delivered_at?: string;
}

interface StoredInteractionExecution {
  owner_id: string;
  operation_id: string;
  started_at: string;
  lease_until: string;
  attempt: number;
  result?: {
    status: WorkspaceInteractionExecutionSettlementStatus;
    finished_at: string;
    summary?: string;
    error_code?: string;
  };
}

interface LoadedInteractionRequest {
  record: WorkspaceRecord;
  payload: StoredInteractionRequestPayload;
}

interface ResolvedResponse {
  option: WorkspaceInteractionOption;
  input?: WorkspaceInteractionJsonValue;
}

const maxTtlMs = 30 * 24 * 60 * 60 * 1000;
const defaultTtlMs = 10 * 60 * 1000;
const defaultExecutionLeaseMs = 5 * 60 * 1000;
const maxInteractionJsonBytes = 64 * 1024;
const maxInteractionInputBytes = 256 * 1024;
const maxMaintenanceBatchSize = 1_000;
const maintenanceOperationPrefix = "interaction_maintenance_";
const interruptedExecutionSummary = "The Server stopped before it could verify this approved request. It was not retried to avoid a duplicate operation.";
const interruptedExecutionErrorCode = "workspace_interaction_execution_interrupted";

/**
 * Persistent, Room-scoped approval/backend-input state.
 *
 * This service owns durable admission and the hand-off boundary to Runtime.
 * It never executes an action itself: the Server claims an accepted request,
 * performs the side effect, and settles the same claim with a safe result.
 */
export class WorkspaceInteractionRequestService {
  private readonly clock: () => Date;
  private readonly defaultTtlMs: number;
  private readonly executionLeaseMs: number;

  constructor(
    private readonly store: WorkspaceInteractionRequestRecordStore,
    options: WorkspaceInteractionRequestServiceOptions | (() => Date) = {}
  ) {
    if (typeof options === "function") {
      this.clock = options;
      this.defaultTtlMs = defaultTtlMs;
      this.executionLeaseMs = defaultExecutionLeaseMs;
    } else {
      this.clock = options.clock ?? (() => new Date());
      this.defaultTtlMs = options.defaultTtlMs ?? defaultTtlMs;
      this.executionLeaseMs = options.executionLeaseMs ?? defaultExecutionLeaseMs;
    }
    if (!Number.isSafeInteger(this.defaultTtlMs) || this.defaultTtlMs < 1 || this.defaultTtlMs > maxTtlMs) {
      throw new WorkspaceServerError("workspace_interaction_default_ttl_invalid", 500);
    }
    if (!Number.isSafeInteger(this.executionLeaseMs) || this.executionLeaseMs < 1 || this.executionLeaseMs > maxTtlMs) {
      throw new WorkspaceServerError("workspace_interaction_execution_lease_invalid", 500);
    }
  }

  async create(context: WorkspaceRequestContext, input: WorkspaceInteractionRequestCreateInput): Promise<WorkspaceInteractionRequestMutationResult> {
    assertMutationContext(context);
    const normalized = normalizeCreateInput(context, input, this.clock(), this.defaultTtlMs);
    const id = interactionRequestId(context.workspaceId, context.operationId);
    const existing = await this.tryLoad(context, input.roomId, id);
    if (existing) {
      if (!sameCreateIntent(existing.payload, normalized.payload, input.expiresAt === undefined)) {
        throw new WorkspaceServerError("workspace_interaction_request_idempotency_conflict", 409);
      }
      return { request: publicRequest(existing.record, existing.payload, this.clock(), true), replayed: true };
    }

    try {
      const saved = await this.store.putRecord(context, {
        roomId: normalized.payload.room_id,
        recordType: WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE,
        id,
        expectedVersion: 0,
        payload: normalized.payload,
        searchText: `${normalized.payload.title} ${normalized.payload.summary} ${normalized.payload.kind}`.slice(0, 5_000)
      });
      return { request: publicRequest(saved.record, parsePayload(saved.record), this.clock(), false), replayed: saved.replayed };
    } catch (error) {
      const raced = await this.tryLoad(context, input.roomId, id);
      if (raced) {
        if (!sameCreateIntent(raced.payload, normalized.payload, input.expiresAt === undefined)) {
          throw new WorkspaceServerError("workspace_interaction_request_idempotency_conflict", 409);
        }
        return { request: publicRequest(raced.record, raced.payload, this.clock(), true), replayed: true };
      }
      throw error;
    }
  }

  async createRequest(context: WorkspaceRequestContext, input: WorkspaceInteractionRequestCreateInput): Promise<WorkspaceInteractionRequestMutationResult> {
    return this.create(context, input);
  }

  async list(
    context: InteractionReadContext,
    input: WorkspaceInteractionRequestListInput
  ): Promise<WorkspaceInteractionRequest[]> {
    assertReadContext(context);
    assertRoomId(input.roomId);
    const records = await this.store.listRecords(context, {
      roomId: input.roomId,
      recordType: WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE,
      limit: input.limit
    });
    return records
      .map((record) => {
        const payload = parsePayload(record);
        return publicRequest(record, payload, this.clock(), true);
      })
      .filter((request) => input.includeResolved === true || request.status === "pending");
  }

  async listRequests(
    context: InteractionReadContext,
    input: WorkspaceInteractionRequestListInput
  ): Promise<{ requests: WorkspaceInteractionRequest[] }> {
    return { requests: await this.list(context, input) };
  }

  async get(context: InteractionReadContext, input: WorkspaceInteractionRequestGetInput): Promise<WorkspaceInteractionRequest> {
    const loaded = await this.load(context, input.roomId, input.requestId);
    return publicRequest(loaded.record, loaded.payload, this.clock(), true);
  }

  async getRequest(context: InteractionReadContext, input: WorkspaceInteractionRequestGetInput): Promise<WorkspaceInteractionRequest> {
    return this.get(context, input);
  }

  async respond(context: WorkspaceRequestContext, input: WorkspaceInteractionRequestRespondInput): Promise<WorkspaceInteractionRequestMutationResult> {
    assertMutationContext(context);
    assertExpectedVersionValue(input.expectedVersion);
    const loaded = await this.load(context, input.roomId, input.requestId);
    const response = resolveResponse(loaded.payload, input);

    if (loaded.payload.status !== "pending") {
      if (responseOperationId(loaded.payload) === context.operationId && sameResponseIntent(loaded.payload.outcome, response)) {
        return { request: publicRequest(loaded.record, loaded.payload, this.clock(), false), replayed: true };
      }
      throw new WorkspaceServerError("workspace_interaction_request_already_decided", 409);
    }
    if (isExpired(loaded.payload.expires_at, this.clock())) {
      throw new WorkspaceServerError("workspace_interaction_request_expired", 409);
    }
    assertExpectedVersion(input.expectedVersion, loaded.record.version);

    const now = nowIso(this.clock());
    const next: StoredInteractionRequestPayload = {
      ...loaded.payload,
      status: response.option.decision === "deny" ? "denied" : "accepted",
      decided_account_id: context.accountId,
      outcome: {
        kind: "response",
        optionId: response.option.id,
        decision: response.option.decision,
        ...(response.input === undefined ? {} : { input: cloneJson(response.input) }),
        decidedAt: now
      },
      operation_id: context.operationId,
      response_operation_id: context.operationId
    };
    return this.persistTransition(context, loaded, next, "workspace_interaction_request_already_decided", (payload) =>
      payload.response_operation_id === context.operationId && sameResponseIntent(payload.outcome, response)
    );
  }

  async respondRequest(context: WorkspaceRequestContext, input: WorkspaceInteractionRequestRespondInput): Promise<WorkspaceInteractionRequestMutationResult> {
    return this.respond(context, input);
  }

  async cancel(context: WorkspaceRequestContext, input: WorkspaceInteractionRequestTransitionInput): Promise<WorkspaceInteractionRequestMutationResult> {
    assertMutationContext(context);
    assertExpectedVersionValue(input.expectedVersion);
    const loaded = await this.load(context, input.roomId, input.requestId);
    if (loaded.payload.status !== "pending") {
      if (loaded.payload.status === "cancelled" && cancelOperationId(loaded.payload) === context.operationId) {
        return { request: publicRequest(loaded.record, loaded.payload, this.clock(), false), replayed: true };
      }
      throw new WorkspaceServerError("workspace_interaction_request_already_decided", 409);
    }
    if (isExpired(loaded.payload.expires_at, this.clock())) {
      throw new WorkspaceServerError("workspace_interaction_request_expired", 409);
    }
    assertExpectedVersion(input.expectedVersion, loaded.record.version);
    const next: StoredInteractionRequestPayload = {
      ...loaded.payload,
      status: "cancelled",
      decided_account_id: context.accountId,
      outcome: { kind: "cancelled", decidedAt: nowIso(this.clock()) },
      operation_id: context.operationId,
      cancel_operation_id: context.operationId
    };
    return this.persistTransition(context, loaded, next, "workspace_interaction_request_already_decided", (payload) =>
      payload.status === "cancelled" && payload.cancel_operation_id === context.operationId
    );
  }

  async cancelRequest(context: WorkspaceRequestContext, input: WorkspaceInteractionRequestTransitionInput): Promise<WorkspaceInteractionRequestMutationResult> {
    return this.cancel(context, input);
  }

  async expire(context: WorkspaceRequestContext, input: WorkspaceInteractionRequestTransitionInput): Promise<WorkspaceInteractionRequestMutationResult> {
    assertMutationContext(context);
    assertExpectedVersionValue(input.expectedVersion);
    const loaded = await this.load(context, input.roomId, input.requestId);
    if (loaded.payload.status !== "pending") {
      return {
        request: publicRequest(loaded.record, loaded.payload, this.clock(), false),
        replayed: loaded.payload.status === "expired" && loaded.payload.expire_operation_id === context.operationId
      };
    }
    if (!isExpired(loaded.payload.expires_at, this.clock())) {
      throw new WorkspaceServerError("workspace_interaction_request_not_expired", 409);
    }
    assertExpectedVersion(input.expectedVersion, loaded.record.version);
    const next: StoredInteractionRequestPayload = {
      ...loaded.payload,
      status: "expired",
      outcome: { kind: "expired", expiredAt: loaded.payload.expires_at },
      operation_id: context.operationId,
      expire_operation_id: context.operationId
    };
    return this.persistTransition(context, loaded, next, "workspace_interaction_request_expired", (payload) =>
      payload.status === "expired" && payload.expire_operation_id === context.operationId
    );
  }

  async expireRequest(context: WorkspaceRequestContext, input: WorkspaceInteractionRequestTransitionInput): Promise<WorkspaceInteractionRequestMutationResult> {
    return this.expire(context, input);
  }

  /**
   * Finds terminal transitions that the Server must complete even when no
   * client reconnects. Expiry is persisted rather than merely projected.
   *
   * A stale `executing` request is deliberately settled as an interrupted
   * failure instead of being re-executed. The original external action may
   * already have happened before the process stopped, so an automatic retry
   * could duplicate a publish, send, or other irreversible operation.
   */
  async reconcileRoom(
    context: WorkspaceRequestContext,
    input: WorkspaceInteractionRequestMaintenanceInput
  ): Promise<WorkspaceInteractionRequestMaintenanceResult[]> {
    assertMutationContext(context);
    assertRoomId(input.roomId);
    const limit = normalizeMaintenanceLimit(input.limit);
    const records = await this.store.listRecords(context, {
      roomId: input.roomId,
      recordType: WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE,
      limit
    });
    const reconciled: WorkspaceInteractionRequestMaintenanceResult[] = [];

    for (const record of records) {
      const payload = parsePayload(record);
      if (payload.room_id !== input.roomId) {
        throw new WorkspaceServerError("workspace_interaction_request_room_mismatch", 409);
      }
      if (payload.maintenance_event && payload.maintenance_event.delivered_at === undefined) {
        reconciled.push(maintenanceResult(record, payload, this.clock()));
        continue;
      }

      if (payload.status === "pending" && isExpired(payload.expires_at, this.clock())) {
        const eventOperationId = interactionMaintenanceOperationId(context.workspaceId, record.id, "expired");
        const transitionContext = { ...context, operationId: eventOperationId };
        const next: StoredInteractionRequestPayload = {
          ...payload,
          status: "expired",
          outcome: { kind: "expired", expiredAt: payload.expires_at },
          operation_id: eventOperationId,
          expire_operation_id: eventOperationId,
          maintenance_event: { action: "expired", operation_id: eventOperationId }
        };
        await this.persistTransition(
          transitionContext,
          { record, payload },
          next,
          "workspace_interaction_request_expiry_reconciliation_conflict",
          (candidate) => candidate.status === "expired"
            && candidate.expire_operation_id === eventOperationId
            && sameMaintenanceEvent(candidate.maintenance_event, "expired", eventOperationId)
        );
        const current = await this.load(context, input.roomId, record.id);
        if (current.payload.maintenance_event?.delivered_at === undefined
          && sameMaintenanceEvent(current.payload.maintenance_event, "expired", eventOperationId)) {
          reconciled.push(maintenanceResult(current.record, current.payload, this.clock()));
        }
        continue;
      }

      if (payload.status === "executing" && payload.execution && isExecutionStale(payload.execution, this.clock())) {
        const eventOperationId = interactionMaintenanceOperationId(
          context.workspaceId,
          record.id,
          `interrupted:${payload.execution.operation_id}`
        );
        const transitionContext = { ...context, operationId: eventOperationId };
        const next: StoredInteractionRequestPayload = {
          ...payload,
          status: "failed",
          execution: {
            ...payload.execution,
            result: {
              status: "failed",
              finished_at: nowIso(this.clock()),
              summary: interruptedExecutionSummary,
              error_code: interruptedExecutionErrorCode
            }
          },
          operation_id: eventOperationId,
          maintenance_event: { action: "failed", operation_id: eventOperationId }
        };
        await this.persistTransition(
          transitionContext,
          { record, payload },
          next,
          "workspace_interaction_request_execution_reconciliation_conflict",
          (candidate) => candidate.status === "failed"
            && candidate.execution?.operation_id === payload.execution?.operation_id
            && candidate.execution?.result?.error_code === interruptedExecutionErrorCode
            && sameMaintenanceEvent(candidate.maintenance_event, "failed", eventOperationId)
        );
        const current = await this.load(context, input.roomId, record.id);
        if (current.payload.maintenance_event?.delivered_at === undefined
          && sameMaintenanceEvent(current.payload.maintenance_event, "failed", eventOperationId)) {
          reconciled.push(maintenanceResult(current.record, current.payload, this.clock()));
        }
      }
    }

    return reconciled;
  }

  /**
   * Marks a maintenance Event as durably delivered only after the public
   * Event has been appended. If a process dies before this write, the stable
   * Event operation ID makes the next delivery attempt safe to replay.
   */
  async markMaintenanceEventDelivered(
    context: WorkspaceRequestContext,
    input: WorkspaceInteractionRequestMaintenanceDeliveryInput
  ): Promise<WorkspaceInteractionRequestMutationResult> {
    assertMutationContext(context);
    assertExpectedVersionValue(input.expectedVersion);
    assertOpaqueId(input.eventOperationId, "workspace_interaction_request_maintenance_event_invalid");
    const loaded = await this.load(context, input.roomId, input.requestId);
    const event = loaded.payload.maintenance_event;
    if (!event || event.operation_id !== input.eventOperationId) {
      throw new WorkspaceServerError("workspace_interaction_request_maintenance_event_not_pending", 409);
    }
    if (event.delivered_at !== undefined) {
      return { request: publicRequest(loaded.record, loaded.payload, this.clock(), false), replayed: true };
    }
    assertExpectedVersion(input.expectedVersion, loaded.record.version);
    const next: StoredInteractionRequestPayload = {
      ...loaded.payload,
      operation_id: context.operationId,
      maintenance_event: { ...event, delivered_at: nowIso(this.clock()) }
    };
    return this.persistTransition(
      context,
      loaded,
      next,
      "workspace_interaction_request_maintenance_delivery_conflict",
      (candidate) => candidate.maintenance_event?.operation_id === input.eventOperationId
        && candidate.maintenance_event.delivered_at !== undefined
    );
  }

  /**
   * Claims an accepted request for exactly one execution owner.
   *
   * A claim retry is identified by the persisted executionOperationId, not by
   * a client-visible request status. This keeps a worker restart idempotent
   * even when it receives a fresh Workspace operation ID.
   */
  async claimExecution(
    context: WorkspaceRequestContext,
    input: WorkspaceInteractionExecutionClaimInput
  ): Promise<WorkspaceInteractionExecutionClaimResult> {
    assertMutationContext(context);
    assertExpectedVersionValue(input.expectedVersion);
    const claimInput = normalizeClaimInput(input, this.executionLeaseMs);
    const loaded = await this.load(context, input.roomId, input.requestId);
    const existingExecution = loaded.payload.execution;

    if (existingExecution && sameExecutionIdentity(existingExecution, claimInput)) {
      return {
        request: publicRequest(loaded.record, loaded.payload, this.clock(), false),
        claim: publicExecutionClaim(existingExecution),
        executionTarget: internalExecutionTarget(loaded.payload),
        ...internalExecutionInput(loaded.payload),
        replayed: true
      };
    }
    if (existingExecution && loaded.payload.status === "executing") {
      throw new WorkspaceServerError("workspace_interaction_request_execution_in_progress", 409, {
        latest_version: loaded.record.version
      });
    }
    if (["completed", "failed"].includes(loaded.payload.status)) {
      throw new WorkspaceServerError("workspace_interaction_request_execution_already_settled", 409);
    }
    if (loaded.payload.status !== "accepted") {
      throw new WorkspaceServerError("workspace_interaction_request_not_accepted", 409);
    }

    assertExpectedVersion(input.expectedVersion, loaded.record.version);
    const now = nowIso(this.clock());
    const nextExecution = newStoredExecution(claimInput, now, claimInput.leaseMs);
    const next: StoredInteractionRequestPayload = {
      ...loaded.payload,
      status: "executing",
      execution: nextExecution,
      operation_id: context.operationId
    };
    const transition = await this.persistTransition(
      context,
      loaded,
      next,
      "workspace_interaction_request_execution_in_progress",
      (payload) => Boolean(payload.execution && sameExecutionIdentity(payload.execution, claimInput))
    );
    const final = await this.load(context, input.roomId, input.requestId);
    return {
      request: transition.request,
      claim: publicExecutionClaim(final.payload.execution ?? nextExecution),
      executionTarget: internalExecutionTarget(final.payload),
      ...internalExecutionInput(final.payload),
      replayed: transition.replayed
    };
  }

  async claimRequestExecution(
    context: WorkspaceRequestContext,
    input: WorkspaceInteractionExecutionClaimInput
  ): Promise<WorkspaceInteractionExecutionClaimResult> {
    return this.claimExecution(context, input);
  }

  /**
   * Explicitly recovers an execution whose lease has elapsed. There is no
   * implicit stale reclaim in claimExecution; callers must choose this path.
   */
  async recoverExecution(
    context: WorkspaceRequestContext,
    input: WorkspaceInteractionExecutionClaimInput
  ): Promise<WorkspaceInteractionExecutionClaimResult> {
    assertMutationContext(context);
    assertExpectedVersionValue(input.expectedVersion);
    const claimInput = normalizeClaimInput(input, this.executionLeaseMs);
    const loaded = await this.load(context, input.roomId, input.requestId);
    const existingExecution = loaded.payload.execution;

    if (!existingExecution || loaded.payload.status !== "executing") {
      throw new WorkspaceServerError("workspace_interaction_request_execution_not_recoverable", 409);
    }
    if (sameExecutionIdentity(existingExecution, claimInput)) {
      return {
        request: publicRequest(loaded.record, loaded.payload, this.clock(), false),
        claim: publicExecutionClaim(existingExecution),
        executionTarget: internalExecutionTarget(loaded.payload),
        ...internalExecutionInput(loaded.payload),
        replayed: true
      };
    }
    if (!isExecutionStale(existingExecution, this.clock())) {
      throw new WorkspaceServerError("workspace_interaction_request_execution_not_stale", 409, {
        lease_until: existingExecution.lease_until
      });
    }
    assertExpectedVersion(input.expectedVersion, loaded.record.version);

    const now = nowIso(this.clock());
    const nextExecution = newStoredExecution(claimInput, now, claimInput.leaseMs, existingExecution.attempt + 1);
    const next: StoredInteractionRequestPayload = {
      ...loaded.payload,
      status: "executing",
      execution: nextExecution,
      operation_id: context.operationId
    };
    const transition = await this.persistTransition(
      context,
      loaded,
      next,
      "workspace_interaction_request_execution_recovery_conflict",
      (payload) => Boolean(payload.execution && sameExecutionIdentity(payload.execution, claimInput))
    );
    const final = await this.load(context, input.roomId, input.requestId);
    return {
      request: transition.request,
      claim: publicExecutionClaim(final.payload.execution ?? nextExecution),
      executionTarget: internalExecutionTarget(final.payload),
      ...internalExecutionInput(final.payload),
      replayed: transition.replayed
    };
  }

  async recoverRequestExecution(
    context: WorkspaceRequestContext,
    input: WorkspaceInteractionExecutionClaimInput
  ): Promise<WorkspaceInteractionExecutionClaimResult> {
    return this.recoverExecution(context, input);
  }

  /** Internal Server-only result settlement for the currently owned claim. */
  async settleExecution(
    context: WorkspaceRequestContext,
    input: WorkspaceInteractionExecutionSettlementInput
  ): Promise<WorkspaceInteractionExecutionSettlementResult> {
    assertMutationContext(context);
    assertExpectedVersionValue(input.expectedVersion);
    const settlement = normalizeSettlementInput(input);
    const loaded = await this.load(context, input.roomId, input.requestId);
    const execution = loaded.payload.execution;

    if (!execution || !sameExecutionIdentity(execution, settlement)) {
      if (["completed", "failed"].includes(loaded.payload.status)) {
        throw new WorkspaceServerError("workspace_interaction_request_execution_already_settled", 409);
      }
      throw new WorkspaceServerError("workspace_interaction_request_execution_owner_conflict", 409);
    }
    if (["completed", "failed"].includes(loaded.payload.status)) {
      if (loaded.payload.status === settlement.status && sameSettlementIntent(execution.result, settlement)) {
        return { request: publicRequest(loaded.record, loaded.payload, this.clock(), false), replayed: true };
      }
      throw new WorkspaceServerError("workspace_interaction_request_execution_already_settled", 409);
    }
    if (loaded.payload.status !== "executing") {
      throw new WorkspaceServerError("workspace_interaction_request_execution_not_active", 409);
    }
    if (isExecutionStale(execution, this.clock())) {
      throw new WorkspaceServerError("workspace_interaction_request_execution_lease_expired", 409, {
        lease_until: execution.lease_until
      });
    }
    assertExpectedVersion(input.expectedVersion, loaded.record.version);

    const finishedAt = nowIso(this.clock());
    const result = {
      status: settlement.status,
      finished_at: finishedAt,
      ...(settlement.summary === undefined ? {} : { summary: settlement.summary }),
      ...(settlement.errorCode === undefined ? {} : { error_code: settlement.errorCode })
    } as StoredInteractionExecution["result"];
    const next: StoredInteractionRequestPayload = {
      ...loaded.payload,
      status: settlement.status,
      execution: { ...execution, result },
      operation_id: context.operationId
    };
    const transition = await this.persistTransition(
      context,
      loaded,
      next,
      "workspace_interaction_request_settlement_conflict",
      (payload) => Boolean(
        payload.execution
          && sameExecutionIdentity(payload.execution, settlement)
          && payload.status === settlement.status
          && sameSettlementIntent(payload.execution.result, settlement)
      )
    );
    return { request: transition.request, replayed: transition.replayed };
  }

  async settleRequestExecution(
    context: WorkspaceRequestContext,
    input: WorkspaceInteractionExecutionSettlementInput
  ): Promise<WorkspaceInteractionExecutionSettlementResult> {
    return this.settleExecution(context, input);
  }

  private async load(context: InteractionReadContext, roomId: string, requestId: string): Promise<LoadedInteractionRequest> {
    assertReadContext(context);
    assertRoomId(roomId);
    assertOpaqueId(requestId, "workspace_interaction_request_id_invalid");
    try {
      const record = await this.store.getRecord(context, {
        roomId,
        recordType: WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE,
        id: requestId
      });
      const payload = parsePayload(record);
      if (record.roomId !== roomId || payload.room_id !== roomId) {
        throw new WorkspaceServerError("workspace_interaction_request_room_mismatch", 409);
      }
      return { record, payload };
    } catch (error) {
      if (isErrorCode(error, "workspace_record_not_found")) {
        throw new WorkspaceServerError("workspace_interaction_request_not_found", 404);
      }
      throw error;
    }
  }

  private async tryLoad(context: InteractionReadContext, roomId: string, requestId: string): Promise<LoadedInteractionRequest | undefined> {
    try {
      return await this.load(context, roomId, requestId);
    } catch (error) {
      if (isErrorCode(error, "workspace_interaction_request_not_found")) return undefined;
      throw error;
    }
  }

  private async persistTransition(
    context: WorkspaceRequestContext,
    loaded: LoadedInteractionRequest,
    next: StoredInteractionRequestPayload,
    concurrentCode: string,
    sameIntent: (payload: StoredInteractionRequestPayload) => boolean
  ): Promise<WorkspaceInteractionRequestMutationResult> {
    try {
      const saved = await this.store.putRecord(context, {
        roomId: loaded.payload.room_id,
        recordType: WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE,
        id: loaded.record.id,
        expectedVersion: loaded.record.version,
        payload: next,
        searchText: `${next.title} ${next.summary} ${next.kind}`.slice(0, 5_000)
      });
      return { request: publicRequest(saved.record, parsePayload(saved.record), this.clock(), false), replayed: saved.replayed };
    } catch (error) {
      if (!isErrorCode(error, "workspace_record_version_conflict") && !isErrorCode(error, "workspace_operation_id_reused")) throw error;
      const latest = await this.tryLoad(context, loaded.payload.room_id, loaded.record.id);
      if (!latest) throw new WorkspaceServerError("workspace_interaction_request_not_found", 404);
      if (latest.payload.operation_id === context.operationId && !sameIntent(latest.payload)) {
        throw new WorkspaceServerError("workspace_interaction_request_idempotency_conflict", 409);
      }
      if (sameIntent(latest.payload)) {
        return { request: publicRequest(latest.record, latest.payload, this.clock(), false), replayed: true };
      }
      if (latest.record.version !== loaded.record.version) {
        throw new WorkspaceServerError(concurrentCode, 409, { latest_version: latest.record.version });
      }
      throw new WorkspaceServerError("workspace_interaction_request_version_conflict", 409, { latest_version: latest.record.version });
    }
  }
}

function normalizeCreateInput(
  context: WorkspaceRequestContext,
  input: WorkspaceInteractionRequestCreateInput,
  now: Date,
  defaultTtl: number
): { payload: StoredInteractionRequestPayload } {
  assertRoomId(input.roomId);
  if (!workspaceInteractionRequestKinds.includes(input.kind)) {
    throw new WorkspaceServerError("workspace_interaction_request_kind_invalid", 400);
  }
  const runId = optionalOpaqueId(input.runId, "workspace_interaction_run_id_invalid");
  const surfaceId = optionalOpaqueId(input.surfaceId, "workspace_interaction_surface_id_invalid");
  const revisionId = input.revisionId ?? input.revision;
  if (input.revisionId !== undefined && input.revision !== undefined && input.revisionId !== input.revision) {
    throw new WorkspaceServerError("workspace_interaction_revision_conflict", 409);
  }
  const normalizedRevisionId = optionalOpaqueId(revisionId, "workspace_interaction_revision_id_invalid");
  const actionTarget = input.actionTarget ?? input.target;
  if (input.actionTarget && input.target && !canonicalMaybeEqual(input.actionTarget, input.target)) {
    throw new WorkspaceServerError("workspace_interaction_target_conflict", 409);
  }
  if (!isJsonObject(actionTarget)) {
    throw new WorkspaceServerError("workspace_interaction_request_target_invalid", 400);
  }
  if (input.kind === "backend_input" && runId === undefined) {
    throw new WorkspaceServerError("workspace_interaction_request_run_id_required", 400);
  }
  const normalizedTarget = normalizeActionTarget(input.roomId, runId, surfaceId, normalizedRevisionId, actionTarget);
  const options = normalizeOptions(input.kind, input.options, "workspace_interaction_request_options_invalid");
  const inputSchema = input.inputSchema === undefined ? undefined : normalizeInputSchema(input.inputSchema, "workspace_interaction_request_input_schema_invalid");
  if (input.kind === "backend_input" && inputSchema === undefined) {
    throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
  }
  if (input.kind === "approval" && inputSchema !== undefined) {
    throw new WorkspaceServerError("workspace_interaction_request_input_schema_not_allowed", 400);
  }
  const createdAt = validIso(now, "workspace_interaction_request_clock_invalid");
  const expiresAt = resolveExpiry(input, now, defaultTtl);
  const title = normalizeText(input.title ?? (input.kind === "approval" ? "Approval required" : "Backend input required"), 500, "workspace_interaction_request_title_invalid");
  const summary = normalizeText(input.summary ?? "The Server is waiting for a response.", 10_000, "workspace_interaction_request_summary_invalid");
  const payload: StoredInteractionRequestPayload = {
    schema_version: 1,
    kind: input.kind,
    room_id: input.roomId,
    run_id: runId ?? null,
    surface_id: surfaceId ?? null,
    revision_id: normalizedRevisionId ?? null,
    action_target: normalizedTarget,
    title,
    summary,
    options,
    ...(inputSchema === undefined ? {} : { input_schema: inputSchema }),
    requested_account_id: context.accountId,
    status: "pending",
    expires_at: expiresAt,
    ...(input.ttlMs === undefined ? {} : { ttl_ms: input.ttlMs }),
    created_at: createdAt
  };
  return { payload };
}

function resolveExpiry(input: WorkspaceInteractionRequestCreateInput, now: Date, defaultTtl: number): string {
  if (input.expiresAt !== undefined && input.ttlMs !== undefined) {
    throw new WorkspaceServerError("workspace_interaction_request_expiry_conflict", 400);
  }
  if (input.ttlMs !== undefined && (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > maxTtlMs)) {
    throw new WorkspaceServerError("workspace_interaction_request_expiry_invalid", 400);
  }
  const value = input.expiresAt ?? new Date(now.getTime() + (input.ttlMs ?? defaultTtl)).toISOString();
  const expiry = new Date(value);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
    throw new WorkspaceServerError("workspace_interaction_request_expiry_invalid", 400);
  }
  if (expiry.getTime() - now.getTime() > maxTtlMs) {
    throw new WorkspaceServerError("workspace_interaction_request_expiry_too_long", 400);
  }
  return expiry.toISOString();
}

function normalizeOptions(
  kind: WorkspaceInteractionRequestKind,
  options: readonly WorkspaceInteractionOption[],
  code: string
): WorkspaceInteractionOption[] {
  if (!Array.isArray(options) || options.length === 0 || options.length > 32) throw new WorkspaceServerError(code, 400);
  const ids = new Set<string>();
  const normalized = options.map((option) => {
    if (!option || typeof option !== "object") throw new WorkspaceServerError(code, 400);
    const id = normalizeText(option.id, 128, code);
    const label = normalizeText(option.label, 500, code);
    if (!workspaceInteractionDecisions.includes(option.decision) || ids.has(id)) throw new WorkspaceServerError(code, 400);
    if (kind === "approval" && option.decision === "submit_input") throw new WorkspaceServerError(code, 400);
    if (kind === "backend_input" && option.decision === "approve") throw new WorkspaceServerError(code, 400);
    ids.add(id);
    const description = option.description === undefined ? undefined : normalizeText(option.description, 2_000, code);
    return { id, label, decision: option.decision, ...(description === undefined ? {} : { description }) };
  });
  const allowedDecision = kind === "approval" ? "approve" : "submit_input";
  if (!normalized.some((option) => option.decision === allowedDecision)) {
    throw new WorkspaceServerError(code, 400);
  }
  return normalized;
}

function normalizeActionTarget(
  roomId: string,
  runId: string | undefined,
  surfaceId: string | undefined,
  revisionId: string | undefined,
  target: WorkspaceInteractionActionTarget
): WorkspaceInteractionActionTarget {
  const normalized = cloneJson(target);
  assertJsonByteLength(normalized, maxInteractionJsonBytes, "workspace_interaction_request_target_too_large");
  if (Object.keys(normalized).length === 0) {
    throw new WorkspaceServerError("workspace_interaction_request_target_invalid", 400);
  }
  const targetRoomId = optionalTargetId(normalized.room_id, "workspace_interaction_request_target_room_invalid");
  const targetRunId = optionalTargetId(normalized.run_id, "workspace_interaction_request_target_run_invalid");
  const targetSurfaceId = optionalTargetId(normalized.surface_id, "workspace_interaction_request_target_surface_invalid");
  if (normalized.revision_id !== undefined && normalized.revision !== undefined
    && !canonicalMaybeEqual(normalized.revision_id, normalized.revision)) {
    throw new WorkspaceServerError("workspace_interaction_request_target_revision_conflict", 409);
  }
  const targetRevisionId = optionalTargetId(
    normalized.revision_id !== undefined ? normalized.revision_id : normalized.revision,
    "workspace_interaction_request_target_revision_invalid"
  );
  if (targetRoomId !== undefined && targetRoomId !== roomId) {
    throw new WorkspaceServerError("workspace_interaction_request_target_room_mismatch", 409);
  }
  if (targetRunId !== undefined && targetRunId !== runId) {
    throw new WorkspaceServerError("workspace_interaction_request_target_run_mismatch", 409);
  }
  if (targetSurfaceId !== undefined && targetSurfaceId !== surfaceId) {
    throw new WorkspaceServerError("workspace_interaction_request_target_surface_mismatch", 409);
  }
  if (targetRevisionId !== undefined && targetRevisionId !== revisionId) {
    throw new WorkspaceServerError("workspace_interaction_request_target_revision_mismatch", 409);
  }
  return normalized;
}

function optionalTargetId(value: WorkspaceInteractionJsonValue | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new WorkspaceServerError(code, 400);
  return assertOpaqueId(value, code);
}

function normalizeInputSchema(value: WorkspaceInteractionInputSchema, code: string): WorkspaceInteractionInputSchema {
  if (!isJsonObject(value)) throw new WorkspaceServerError(code, 400);
  try {
    validateSchemaDeclaration(value, 0);
    const normalized = cloneJson(value);
    assertJsonByteLength(normalized, maxInteractionJsonBytes, code);
    return normalized;
  } catch (error) {
    if (isErrorCode(error, "workspace_interaction_request_input_schema_invalid")) throw error;
    throw new WorkspaceServerError(code, 400);
  }
}

function resolveResponse(payload: StoredInteractionRequestPayload, input: WorkspaceInteractionRequestRespondInput): ResolvedResponse {
  if (typeof input.optionId !== "string" || !input.optionId.trim()) {
    throw new WorkspaceServerError("workspace_interaction_request_option_id_required", 400);
  }
  const option = payload.options.find((candidate) => candidate.id === input.optionId);
  if (!option || (input.optionId !== undefined && input.decision !== undefined && option.decision !== input.decision)) {
    throw new WorkspaceServerError("workspace_interaction_request_option_invalid", 400);
  }
  const hasInput = input.input !== undefined || input.values !== undefined;
  let responseInput: WorkspaceInteractionJsonValue | undefined = input.input;
  if (input.input !== undefined && input.values !== undefined && !canonicalMaybeEqual(input.input, input.values)) {
    throw new WorkspaceServerError("workspace_interaction_request_input_conflict", 400);
  }
  if (responseInput === undefined && input.values !== undefined) responseInput = input.values;
  if (option.decision === "submit_input") {
    if (!hasInput || payload.input_schema === undefined) {
      throw new WorkspaceServerError("workspace_interaction_request_input_invalid", 400);
    }
    if (responseInput === undefined) {
      throw new WorkspaceServerError("workspace_interaction_request_input_invalid", 400);
    }
    assertJsonByteLength(responseInput, maxInteractionInputBytes, "workspace_interaction_request_input_too_large");
    validateJsonAgainstSchema(payload.input_schema, responseInput, "$input");
  } else if (hasInput) {
    throw new WorkspaceServerError("workspace_interaction_request_input_not_allowed", 400);
  }
  return { option, ...(responseInput === undefined ? {} : { input: cloneJson(responseInput) }) };
}

function sameResponseIntent(outcome: StoredInteractionRequestOutcome | undefined, response: ResolvedResponse): boolean {
  if (!outcome || outcome.kind !== "response") return false;
  return outcome.optionId === response.option.id
    && outcome.decision === response.option.decision
    && canonicalMaybeEqual(outcome.input, response.input);
}

function responseOperationId(payload: StoredInteractionRequestPayload): string | undefined {
  return payload.response_operation_id
    ?? (["accepted", "denied"].includes(payload.status) ? payload.operation_id : undefined);
}

function cancelOperationId(payload: StoredInteractionRequestPayload): string | undefined {
  return payload.cancel_operation_id
    ?? (payload.status === "cancelled" ? payload.operation_id : undefined);
}

function sameCreateIntent(
  existing: StoredInteractionRequestPayload,
  requested: StoredInteractionRequestPayload,
  ignoreExpiry: boolean
): boolean {
  return existing.kind === requested.kind
    && existing.room_id === requested.room_id
    && existing.run_id === requested.run_id
    && existing.surface_id === requested.surface_id
    && existing.revision_id === requested.revision_id
    && existing.requested_account_id === requested.requested_account_id
    && existing.title === requested.title
    && existing.summary === requested.summary
    && canonicalMaybeEqual(existing.action_target, requested.action_target)
    && canonicalMaybeEqual(existing.options, requested.options)
    && canonicalMaybeEqual(existing.input_schema, requested.input_schema)
    && existing.ttl_ms === requested.ttl_ms
    && (ignoreExpiry || existing.expires_at === requested.expires_at);
}

function publicRequest(
  record: WorkspaceRecord,
  payload: StoredInteractionRequestPayload,
  now: Date,
  projectExpiry: boolean
): WorkspaceInteractionRequest {
  const expired = payload.status === "pending" && projectExpiry && isExpired(payload.expires_at, now);
  const status = expired ? "expired" : payload.status;
  const outcome = expired && payload.outcome === undefined
    ? { kind: "expired" as const, expiredAt: payload.expires_at }
    : payload.outcome;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    roomId: payload.room_id,
    version: record.version,
    kind: payload.kind,
    status,
    title: payload.title,
    summary: payload.summary,
    ...(payload.run_id === null ? {} : { runId: payload.run_id }),
    ...(payload.surface_id === null ? {} : { surfaceId: payload.surface_id }),
    ...(payload.revision_id === null ? {} : { revisionId: payload.revision_id }),
    actionTarget: cloneJson(payload.action_target),
    options: payload.options.map((option) => ({ ...option })),
    ...(payload.input_schema === undefined ? {} : { inputSchema: cloneJson(payload.input_schema) }),
    requestedAccountId: payload.requested_account_id,
    ...(payload.decided_account_id === undefined ? {} : { decidedAccountId: payload.decided_account_id }),
    expiresAt: payload.expires_at,
    ...(outcome === undefined ? {} : { outcome: publicOutcome(outcome) }),
    ...(payload.execution === undefined ? {} : { execution: publicExecution(payload.execution, status) }),
    createdAt: payload.created_at,
    updatedAt: record.updatedAt
  };
}

function publicOutcome(outcome: StoredInteractionRequestOutcome): WorkspaceInteractionRequestOutcome {
  if (outcome.kind === "response") {
    return {
      kind: "response",
      optionId: outcome.optionId,
      decision: outcome.decision,
      decidedAt: outcome.decidedAt
    };
  }
  return cloneJson(outcome);
}

function publicExecution(
  execution: StoredInteractionExecution,
  status: WorkspaceInteractionRequestStatus
): WorkspaceInteractionExecutionProjection {
  const executionStatus = status === "executing" || status === "completed" || status === "failed"
    ? status
    : execution.result?.status ?? "executing";
  return {
    status: executionStatus,
    startedAt: execution.started_at,
    ...(execution.result === undefined ? {} : {
      finishedAt: execution.result.finished_at,
      ...(execution.result.summary === undefined ? {} : { summary: execution.result.summary }),
      ...(execution.result.error_code === undefined ? {} : { errorCode: execution.result.error_code })
    })
  };
}

function parsePayload(record: WorkspaceRecord): StoredInteractionRequestPayload {
  if (record.recordType !== WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE || !isJsonObject(record.payload)) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  const value = record.payload;
  if (value.schema_version !== 1
    || !workspaceInteractionRequestKinds.includes(value.kind as WorkspaceInteractionRequestKind)
    || typeof value.room_id !== "string"
    || typeof value.requested_account_id !== "string"
    || typeof value.title !== "string"
    || typeof value.summary !== "string"
    || !workspaceInteractionRequestStatuses.includes(value.status as WorkspaceInteractionRequestStatus)
    || typeof value.expires_at !== "string"
    || typeof value.created_at !== "string"
    || !isJsonObject(value.action_target)
    || !Array.isArray(value.options)) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  if (record.roomId !== value.room_id || !validStoredDate(value.expires_at) || !validStoredDate(value.created_at)) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  let options: WorkspaceInteractionOption[];
  try {
    options = normalizeOptions(value.kind as WorkspaceInteractionRequestKind, value.options as unknown as WorkspaceInteractionOption[], "workspace_interaction_request_corrupt");
  } catch {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  let inputSchema: WorkspaceInteractionInputSchema | undefined;
  if (value.input_schema !== undefined) {
    try {
      inputSchema = normalizeInputSchema(value.input_schema as WorkspaceInteractionInputSchema, "workspace_interaction_request_corrupt");
    } catch {
      throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
    }
  }
  if ((value.kind === "backend_input" && (inputSchema === undefined || value.run_id === null))
    || (value.kind === "approval" && inputSchema !== undefined)
    || (value.run_id !== null && typeof value.run_id !== "string")
    || (value.surface_id !== null && typeof value.surface_id !== "string")
    || (value.revision_id !== null && typeof value.revision_id !== "string")
    || (value.decided_account_id !== undefined && typeof value.decided_account_id !== "string")) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  if (value.ttl_ms !== undefined && (typeof value.ttl_ms !== "number" || !Number.isSafeInteger(value.ttl_ms) || value.ttl_ms < 1 || value.ttl_ms > maxTtlMs)) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  const outcome = value.outcome === undefined ? undefined : parseStoredOutcome(value.outcome);
  validateStoredLifecycle(value.status as WorkspaceInteractionRequestStatus, value.kind as WorkspaceInteractionRequestKind, options, inputSchema, outcome);
  for (const operationId of [value.operation_id, value.response_operation_id, value.cancel_operation_id, value.expire_operation_id]) {
    if (operationId !== undefined) {
      if (typeof operationId !== "string") throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
      assertOpaqueId(operationId, "workspace_interaction_request_corrupt");
    }
  }
  const maintenanceEvent = value.maintenance_event === undefined ? undefined : parseStoredMaintenanceEvent(value.maintenance_event);
  const execution = value.execution === undefined ? undefined : parseStoredExecution(value.execution);
  if (["executing", "completed", "failed"].includes(value.status as string) && execution === undefined) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  if (execution !== undefined) {
    if (value.status === "executing" && execution.result !== undefined) {
      throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
    }
    if (["completed", "failed"].includes(value.status as string)
      && (execution.result === undefined || execution.result.status !== value.status)) {
      throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
    }
  }
  if (maintenanceEvent !== undefined) {
    if ((value.status === "expired" && maintenanceEvent.action !== "expired")
      || (value.status === "failed" && maintenanceEvent.action !== "failed")
      || (value.status !== "expired" && value.status !== "failed")) {
      throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
    }
  }
  let actionTarget: WorkspaceInteractionActionTarget;
  try {
    actionTarget = normalizeActionTarget(
      value.room_id,
      value.run_id === null ? undefined : value.run_id,
      value.surface_id === null ? undefined : value.surface_id,
      value.revision_id === null ? undefined : value.revision_id,
      value.action_target
    );
  } catch {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  return {
    schema_version: 1,
    kind: value.kind as WorkspaceInteractionRequestKind,
    room_id: value.room_id,
    run_id: (value.run_id as string | null | undefined) ?? null,
    surface_id: (value.surface_id as string | null | undefined) ?? null,
    revision_id: (value.revision_id as string | null | undefined) ?? null,
    action_target: actionTarget,
    title: value.title,
    summary: value.summary,
    options,
    ...(inputSchema === undefined ? {} : { input_schema: inputSchema }),
    requested_account_id: value.requested_account_id,
    status: value.status as WorkspaceInteractionRequestStatus,
    ...(value.decided_account_id === undefined ? {} : { decided_account_id: value.decided_account_id }),
    expires_at: value.expires_at,
    ...(value.ttl_ms === undefined ? {} : { ttl_ms: value.ttl_ms }),
    ...(outcome === undefined ? {} : { outcome }),
    created_at: value.created_at,
    ...(typeof value.operation_id === "string" ? { operation_id: value.operation_id } : {}),
    ...(typeof value.response_operation_id === "string" ? { response_operation_id: value.response_operation_id } : {}),
    ...(typeof value.cancel_operation_id === "string" ? { cancel_operation_id: value.cancel_operation_id } : {}),
    ...(typeof value.expire_operation_id === "string" ? { expire_operation_id: value.expire_operation_id } : {}),
    ...(maintenanceEvent === undefined ? {} : { maintenance_event: maintenanceEvent }),
    ...(execution === undefined ? {} : { execution })
  };
}

function parseStoredOutcome(value: WorkspaceInteractionJsonValue): StoredInteractionRequestOutcome {
  if (!isJsonObject(value) || typeof value.kind !== "string") {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  if (value.kind === "response") {
    if (typeof value.optionId !== "string"
      || !workspaceInteractionDecisions.includes(value.decision as WorkspaceInteractionDecision)
      || typeof value.decidedAt !== "string"
      || !validStoredDate(value.decidedAt)
      || (value.input !== undefined && !isJsonValue(value.input))) {
      throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
    }
    return {
      kind: "response",
      optionId: value.optionId as string,
      decision: value.decision as WorkspaceInteractionDecision,
      ...(value.input === undefined ? {} : { input: cloneJson(value.input) }),
      decidedAt: value.decidedAt as string
    };
  }
  if (value.kind === "cancelled" && typeof value.decidedAt === "string" && validStoredDate(value.decidedAt)) {
    return { kind: "cancelled", decidedAt: value.decidedAt };
  }
  if (value.kind === "expired" && typeof value.expiredAt === "string" && validStoredDate(value.expiredAt)) {
    return { kind: "expired", expiredAt: value.expiredAt };
  }
  throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
}

function parseStoredMaintenanceEvent(value: WorkspaceInteractionJsonValue): StoredInteractionMaintenanceEvent {
  if (!isJsonObject(value)
    || (value.action !== "expired" && value.action !== "failed")
    || typeof value.operation_id !== "string"
    || (value.delivered_at !== undefined && (typeof value.delivered_at !== "string" || !validStoredDate(value.delivered_at)))) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  try {
    assertOpaqueId(value.operation_id, "workspace_interaction_request_corrupt");
  } catch {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  return {
    action: value.action,
    operation_id: value.operation_id,
    ...(typeof value.delivered_at === "string" ? { delivered_at: value.delivered_at } : {})
  };
}

function validateStoredLifecycle(
  status: WorkspaceInteractionRequestStatus,
  kind: WorkspaceInteractionRequestKind,
  options: readonly WorkspaceInteractionOption[],
  inputSchema: WorkspaceInteractionInputSchema | undefined,
  outcome: StoredInteractionRequestOutcome | undefined
): void {
  if (status === "pending" && outcome !== undefined) throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  if (status === "cancelled" && outcome?.kind !== "cancelled") throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  if (status === "expired" && outcome?.kind !== "expired") throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  if (["accepted", "executing", "completed", "failed", "denied"].includes(status) && outcome?.kind !== "response") {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  if (outcome?.kind !== "response") return;
  const option = options.find((candidate) => candidate.id === outcome.optionId);
  if (!option || option.decision !== outcome.decision) throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  if (kind === "approval" && inputSchema !== undefined) throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  if (option.decision === "submit_input") {
    if (inputSchema === undefined || outcome.input === undefined) throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
    try {
      validateJsonAgainstSchema(inputSchema, outcome.input, "$input");
    } catch {
      throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
    }
  } else if (outcome.input !== undefined) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  if (status === "denied" && option.decision !== "deny") throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  if (["accepted", "executing", "completed", "failed"].includes(status) && option.decision === "deny") {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
}

function parseStoredExecution(value: WorkspaceInteractionJsonValue): StoredInteractionExecution {
  if (!isJsonObject(value)) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  const ownerId = value.owner_id;
  const operationId = value.operation_id;
  const startedAt = value.started_at;
  const leaseUntil = value.lease_until;
  const attempt = value.attempt;
  if (typeof ownerId !== "string"
    || typeof operationId !== "string"
    || typeof startedAt !== "string"
    || typeof leaseUntil !== "string"
    || typeof attempt !== "number"
    || !Number.isSafeInteger(attempt)
    || attempt < 1
    || !validStoredDate(startedAt)
    || !validStoredDate(leaseUntil)) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  assertOpaqueId(ownerId, "workspace_interaction_request_corrupt");
  assertOpaqueId(operationId, "workspace_interaction_request_corrupt");
  if (value.result === undefined) {
    return {
      owner_id: ownerId,
      operation_id: operationId,
      started_at: startedAt,
      lease_until: leaseUntil,
      attempt
    };
  }
  if (!isJsonObject(value.result)
    || !workspaceInteractionExecutionStatuses.includes(value.result.status as WorkspaceInteractionExecutionStatus)
    || value.result.status === "executing"
    || typeof value.result.finished_at !== "string"
    || !validStoredDate(value.result.finished_at)
    || (value.result.summary !== undefined && typeof value.result.summary !== "string")
    || (value.result.error_code !== undefined && typeof value.result.error_code !== "string")) {
    throw new WorkspaceServerError("workspace_interaction_request_corrupt", 500);
  }
  return {
    owner_id: ownerId,
    operation_id: operationId,
    started_at: startedAt,
    lease_until: leaseUntil,
    attempt,
    result: {
      status: value.result.status as WorkspaceInteractionExecutionSettlementStatus,
      finished_at: value.result.finished_at,
      ...(value.result.summary === undefined ? {} : { summary: value.result.summary }),
      ...(value.result.error_code === undefined ? {} : { error_code: value.result.error_code })
    }
  };
}

function validateSchemaDeclaration(schema: WorkspaceInteractionJsonObject, depth: number): void {
  if (depth > 16) throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.some((type) => typeof type !== "string" || !["null", "boolean", "object", "array", "number", "integer", "string"].includes(type))) {
      throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some((value) => !isJsonValue(value)))) {
    throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
  }
  if (schema.const !== undefined && !isJsonValue(schema.const)) {
    throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
  }
  if (schema.properties !== undefined) {
    if (!isJsonObject(schema.properties)) throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
    for (const child of Object.values(schema.properties)) {
      if (!isJsonObject(child)) throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
      validateSchemaDeclaration(child, depth + 1);
    }
  }
  if (schema.items !== undefined) {
    if (!isJsonObject(schema.items)) throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
    validateSchemaDeclaration(schema.items, depth + 1);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required)
    || schema.required.some((value) => typeof value !== "string" || !value)
    || new Set(schema.required).size !== schema.required.length)) {
    throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || schema[key].length === 0 || schema[key].some((value) => !isJsonObject(value))) {
        throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
      }
      for (const child of schema[key] as WorkspaceInteractionJsonObject[]) validateSchemaDeclaration(child, depth + 1);
    }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum"] as const) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
    try { new RegExp(schema.pattern); } catch { throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400); }
  }
  if (schema.additionalProperties !== undefined
    && typeof schema.additionalProperties !== "boolean"
    && !isJsonObject(schema.additionalProperties)) {
    throw new WorkspaceServerError("workspace_interaction_request_input_schema_invalid", 400);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateSchemaDeclaration(schema.additionalProperties, depth + 1);
}

function validateJsonAgainstSchema(schema: WorkspaceInteractionJsonObject, value: WorkspaceInteractionJsonValue | undefined, path: string): void {
  if (schema.const !== undefined && (value === undefined || !canonicalMaybeEqual(schema.const, value))) failInput(path, "const");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || value === undefined || !schema.enum.some((candidate) => canonicalMaybeEqual(candidate, value)))) failInput(path, "enum");
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.some((candidate) => {
      try { validateJsonAgainstSchema(candidate as WorkspaceInteractionJsonObject, value, path); return true; } catch { return false; }
    })) failInput(path, "anyOf");
  }
  if (schema.oneOf !== undefined) {
    const matches = Array.isArray(schema.oneOf) ? schema.oneOf.filter((candidate) => {
      try { validateJsonAgainstSchema(candidate as WorkspaceInteractionJsonObject, value, path); return true; } catch { return false; }
    }).length : 0;
    if (matches !== 1) failInput(path, "oneOf");
  }
  if (value === undefined) failInput(path, "required");
  const types = schema.type === undefined ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types.length > 0 && !types.some((type) => matchesJsonType(value, type))) failInput(path, "type");
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) failInput(path, "minLength");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) failInput(path, "maxLength");
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) failInput(path, "pattern");
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) failInput(path, "minimum");
    if (typeof schema.maximum === "number" && value > schema.maximum) failInput(path, "maximum");
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) failInput(path, "minItems");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) failInput(path, "maxItems");
    if (schema.items !== undefined && isJsonObject(schema.items)) value.forEach((item, index) => validateJsonAgainstSchema(schema.items as WorkspaceInteractionJsonObject, item, `${path}[${index}]`));
  }
  if (isJsonObject(value)) {
    const properties = isJsonObject(schema.properties) ? schema.properties : undefined;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) failInput(`${path}.${key}`, "required");
    for (const [key, child] of Object.entries(properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(value, key) && isJsonObject(child)) validateJsonAgainstSchema(child, value[key], `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!properties || !Object.prototype.hasOwnProperty.call(properties, key)) failInput(`${path}.${key}`, "additionalProperties");
    } else if (isJsonObject(schema.additionalProperties)) {
      for (const [key, child] of Object.entries(value)) {
        if (!properties || !Object.prototype.hasOwnProperty.call(properties, key)) validateJsonAgainstSchema(schema.additionalProperties, child, `${path}.${key}`);
      }
    }
  }
}

function matchesJsonType(value: WorkspaceInteractionJsonValue, type: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "object": return isJsonObject(value);
    case "array": return Array.isArray(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "string": return typeof value === "string";
    default: return false;
  }
}

function failInput(path: string, reason: string): never {
  throw new WorkspaceServerError("workspace_interaction_request_input_invalid", 400, { path, reason });
}

function assertMutationContext(context: WorkspaceRequestContext): void {
  assertReadContext(context);
  assertOpaqueId(context.operationId, "workspace_operation_id_invalid");
}

function assertReadContext(context: InteractionReadContext): void {
  assertOpaqueId(context.workspaceId, "workspace_id_invalid");
  assertOpaqueId(context.accountId, "account_id_invalid");
}

function assertRoomId(roomId: string): void {
  assertOpaqueId(roomId, "room_id_invalid");
}

function optionalOpaqueId(value: string | undefined, code: string): string | undefined {
  return value === undefined ? undefined : assertOpaqueId(value, code);
}

function normalizeClaimInput(
  input: WorkspaceInteractionExecutionClaimInput,
  defaultLeaseMs: number
): WorkspaceInteractionExecutionClaimInput & { leaseMs: number } {
  const ownerId = assertOpaqueId(input.ownerId, "workspace_interaction_execution_owner_invalid");
  const executionOperationId = assertOpaqueId(input.executionOperationId, "workspace_interaction_execution_operation_invalid");
  const leaseMs = input.leaseMs ?? defaultLeaseMs;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > maxTtlMs) {
    throw new WorkspaceServerError("workspace_interaction_execution_lease_invalid", 400);
  }
  return { ...input, ownerId, executionOperationId, leaseMs };
}

function normalizeSettlementInput(input: WorkspaceInteractionExecutionSettlementInput): WorkspaceInteractionExecutionSettlementInput {
  const ownerId = assertOpaqueId(input.ownerId, "workspace_interaction_execution_owner_invalid");
  const executionOperationId = assertOpaqueId(input.executionOperationId, "workspace_interaction_execution_operation_invalid");
  if (input.status !== "completed" && input.status !== "failed") {
    throw new WorkspaceServerError("workspace_interaction_request_settlement_status_invalid", 400);
  }
  const summary = input.summary === undefined
    ? undefined
    : normalizeText(input.summary, 2_000, "workspace_interaction_request_settlement_summary_invalid");
  const errorCode = input.errorCode === undefined
    ? undefined
    : normalizeErrorCode(input.errorCode);
  if (input.status === "completed" && errorCode !== undefined) {
    throw new WorkspaceServerError("workspace_interaction_request_settlement_error_code_invalid", 400);
  }
  if (input.status === "failed" && summary === undefined && errorCode === undefined) {
    throw new WorkspaceServerError("workspace_interaction_request_settlement_result_required", 400);
  }
  return {
    ...input,
    ownerId,
    executionOperationId,
    ...(summary === undefined ? {} : { summary }),
    ...(errorCode === undefined ? {} : { errorCode })
  };
}

function normalizeErrorCode(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new WorkspaceServerError("workspace_interaction_request_settlement_error_code_invalid", 400);
  }
  return value;
}

function newStoredExecution(
  input: WorkspaceInteractionExecutionClaimInput & { leaseMs: number },
  startedAt: string,
  leaseMs: number,
  attempt = 1
): StoredInteractionExecution {
  return {
    owner_id: input.ownerId,
    operation_id: input.executionOperationId,
    started_at: startedAt,
    lease_until: new Date(new Date(startedAt).getTime() + leaseMs).toISOString(),
    attempt
  };
}

function publicExecutionClaim(execution: StoredInteractionExecution): WorkspaceInteractionExecutionClaim {
  return {
    ownerId: execution.owner_id,
    executionOperationId: execution.operation_id,
    startedAt: execution.started_at,
    leaseUntil: execution.lease_until,
    attempt: execution.attempt
  };
}

function sameExecutionIdentity(
  execution: StoredInteractionExecution,
  input: Pick<WorkspaceInteractionExecutionClaimInput, "ownerId" | "executionOperationId">
): boolean {
  return execution.owner_id === input.ownerId && execution.operation_id === input.executionOperationId;
}

function isExecutionStale(execution: StoredInteractionExecution, now: Date): boolean {
  return new Date(execution.lease_until).getTime() <= now.getTime();
}

function sameMaintenanceEvent(
  event: StoredInteractionMaintenanceEvent | undefined,
  action: StoredInteractionMaintenanceEvent["action"],
  operationId: string
): boolean {
  return event?.action === action && event.operation_id === operationId;
}

function maintenanceResult(
  record: WorkspaceRecord,
  payload: StoredInteractionRequestPayload,
  clock: Date
): WorkspaceInteractionRequestMaintenanceResult {
  const event = payload.maintenance_event;
  if (!event || event.delivered_at !== undefined) {
    throw new WorkspaceServerError("workspace_interaction_request_maintenance_event_not_pending", 409);
  }
  return {
    request: publicRequest(record, payload, clock, false),
    action: event.action,
    eventOperationId: event.operation_id,
    deliveryOperationId: interactionMaintenanceDeliveryOperationId(event.operation_id)
  };
}

function sameSettlementIntent(
  result: StoredInteractionExecution["result"] | undefined,
  input: Pick<WorkspaceInteractionExecutionSettlementInput, "status" | "summary" | "errorCode">
): boolean {
  return result?.status === input.status
    && result.summary === input.summary
    && result.error_code === input.errorCode;
}

function internalExecutionInput(payload: StoredInteractionRequestPayload): { executionInput?: WorkspaceInteractionJsonValue } {
  const outcome = payload.outcome;
  if (!outcome || outcome.kind !== "response" || outcome.input === undefined) return {};
  return { executionInput: cloneJson(outcome.input) };
}

function internalExecutionTarget(payload: StoredInteractionRequestPayload): WorkspaceInteractionExecutionTarget {
  return {
    roomId: payload.room_id,
    ...(payload.run_id === null ? {} : { runId: payload.run_id }),
    ...(payload.surface_id === null ? {} : { surfaceId: payload.surface_id }),
    ...(payload.revision_id === null ? {} : { revisionId: payload.revision_id }),
    actionTarget: cloneJson(payload.action_target)
  };
}

function assertJsonByteLength(value: WorkspaceInteractionJsonValue, maxBytes: number, code: string): void {
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch {
    throw new WorkspaceServerError(code, 400);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new WorkspaceServerError(code, 400);
  }
}

function assertExpectedVersion(expectedVersion: number, currentVersion: number): void {
  assertExpectedVersionValue(expectedVersion);
  if (expectedVersion !== currentVersion) {
    throw new WorkspaceServerError("workspace_interaction_request_version_conflict", 409, { latest_version: currentVersion });
  }
}

function assertExpectedVersionValue(expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new WorkspaceServerError("workspace_interaction_request_expected_version_invalid", 400);
  }
}

function interactionRequestId(workspaceId: string, operationId: string): string {
  return `interaction_${createHash("sha256").update(`workspace-interaction-request-v1|${workspaceId}|${operationId}`).digest("hex").slice(0, 40)}`;
}

function interactionMaintenanceOperationId(workspaceId: string, requestId: string, phase: string): string {
  return `${maintenanceOperationPrefix}${createHash("sha256")
    .update(`workspace-interaction-maintenance-v1|${workspaceId}|${requestId}|${phase}`)
    .digest("hex")
    .slice(0, 48)}`;
}

function interactionMaintenanceDeliveryOperationId(eventOperationId: string): string {
  return `interaction_delivery_${createHash("sha256")
    .update(`workspace-interaction-maintenance-delivery-v1|${eventOperationId}`)
    .digest("hex")
    .slice(0, 48)}`;
}

function normalizeMaintenanceLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxMaintenanceBatchSize) {
    throw new WorkspaceServerError("workspace_interaction_request_maintenance_limit_invalid", 400);
  }
  return limit;
}

function nowIso(clock: Date): string {
  return validIso(clock, "workspace_interaction_request_clock_invalid");
}

function validIso(value: Date | string, code: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new WorkspaceServerError(code, 500);
  return date.toISOString();
}

function validStoredDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function isExpired(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

function normalizeText(value: string, maxLength: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new WorkspaceServerError(code, 400);
  return value.trim();
}

function isJsonObject(value: unknown): value is WorkspaceInteractionJsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && isJsonValue(value));
}

function isJsonValue(value: unknown): value is WorkspaceInteractionJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function cloneJson<T extends WorkspaceInteractionJsonValue>(value: T): T {
  try {
    return JSON.parse(canonicalJson(value)) as T;
  } catch {
    throw new WorkspaceServerError("workspace_interaction_json_invalid", 400);
  }
}

function canonicalMaybeEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof WorkspaceServerError && error.code === code;
}
