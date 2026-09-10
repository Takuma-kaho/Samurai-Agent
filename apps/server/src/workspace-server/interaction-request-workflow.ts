import { createHash } from "node:crypto";
import type { BackendEventRecord, BackendRunRecord, JsonValue } from "@samurai-agent/core-schemas";
import type { RunControlAction } from "@samurai-agent/domain-api";
import {
  WorkspaceInteractionRequestService,
  WorkspaceServerError,
  workspaceInteractionExecutionOperationId,
  type WorkspaceInteractionRequest,
  type WorkspaceRequestContext,
  type WorkspaceServerStore
} from "@samurai-agent/workspace-server";
import type { GeneratedSurfaceActionTarget, PostgresGeneratedSurface } from "../adapters/runtime/postgres-generated-surface";
import type { PostgresRuntimeCommandService } from "../adapters/runtime/postgres-runtime-chat";
import { RunControlService } from "./run-control-service";

const defaultRunControlService = new RunControlService();

export type WorkspaceInteractionRequestEventAction = "created" | "responded" | "cancelled" | "executing" | "completed" | "failed" | "expired";

export interface WorkspaceInteractionRequestEventOptions {
  actor?: { kind: "human" | "system"; id?: string };
  correlationId?: string;
}

/** Stable audit identity for recovery work. It is never used as an
 * authorization account; recovery checks the saved requester/approver instead. */
export const WORKSPACE_INTERACTION_RECOVERY_AUDIT_ACTOR = {
  kind: "system",
  id: "workspace-server"
} as const;

export interface WorkspaceInteractionRequestNotificationPort {
  onInteractionRequestChanged?(
    context: WorkspaceRequestContext,
    request: WorkspaceInteractionRequest,
    action: WorkspaceInteractionRequestEventAction,
    options?: WorkspaceInteractionRequestEventOptions
  ): Promise<void>;
  onGeneratedSurfaceChanged?(
    context: WorkspaceRequestContext,
    input: { roomId: string; surfaceId: string; revisionId?: string },
    options?: WorkspaceInteractionRequestEventOptions
  ): Promise<void>;
  onRunChanged?(
    context: WorkspaceRequestContext,
    input: { roomId: string; runId: string; status: BackendRunRecord["status"]; action: RunControlAction },
    options?: WorkspaceInteractionRequestEventOptions
  ): Promise<void>;
}

/**
 * Notifications project an already durable transition to clients. They are
 * advisory and must never change the outcome of the durable interaction
 * lifecycle when their event/realtime sink is unavailable.
 */
type BestEffortNotification = () => Promise<void> | void;

function runBestEffortNotification(notification: BestEffortNotification | undefined): void {
  if (!notification) return;
  try {
    // Attach the rejection handler in the same turn so a failed async sink
    // cannot become an unhandled rejection while the business flow proceeds.
    void Promise.resolve(notification()).catch(() => undefined);
  } catch {
    // A failed projection is recoverable through the durable request/result.
  }
}

export type WorkspaceInteractionAuthorizationPort = Pick<WorkspaceServerStore, "assertRoomExecutable">;
export type WorkspaceInteractionRequestLifecyclePort = Pick<WorkspaceInteractionRequestService, "create" | "respond" | "cancel" | "getExecutionTargetResultLookup" | "claimExecution" | "assertExecutionClaim" | "releaseExecutionClaim" | "recoverExecution" | "failStaleExecution" | "settleExecution">;
export type WorkspaceInteractionExecutionPort = Pick<PostgresGeneratedSurface, "executeActionTarget" | "getActionTargetResult">;
export type WorkspaceGeneratedSurfaceActionSubmissionPort = WorkspaceInteractionExecutionPort & Pick<PostgresGeneratedSurface, "prepareAction" | "runActionWithReplay">;

export type WorkspaceInteractionRequestWorkflowDependencies = {
  authorization: WorkspaceInteractionAuthorizationPort;
  interactionRequests: WorkspaceInteractionRequestLifecyclePort;
  generatedSurfaces: WorkspaceGeneratedSurfaceActionSubmissionPort;
  notifications?: WorkspaceInteractionRequestNotificationPort;
  runControl?: Pick<RunControlService, "execute">;
};

export type AcceptedInteractionExecutionDependencies = WorkspaceInteractionRequestWorkflowDependencies;
export type AcceptedInteractionRuntimeFactory = (context: WorkspaceRequestContext) => PostgresRuntimeCommandService;

export type AcceptedInteractionExecutionResult = {
  request: WorkspaceInteractionRequest;
  /** Raw Server-owned action result; the HTTP boundary projects it publicly. */
  rawResult?: Record<string, unknown>;
  /** Durable target result returned while replaying a completed action. */
  targetResult?: JsonValue;
};

export type WorkspaceInteractionResponseResult = {
  response: Awaited<ReturnType<WorkspaceInteractionRequestService["respond"]>>;
  execution?: AcceptedInteractionExecutionResult;
};

export type SubmittedGeneratedSurfaceAction =
  | { kind: "executed"; result: Record<string, unknown>; replayed: boolean }
  | { kind: "approval_required"; request: WorkspaceInteractionRequest; replayed: boolean }
  | { kind: "completed"; result: Record<string, unknown>; targetResult: JsonValue; replayed: true };

export type AcceptedInteractionAuthorization = {
  requesterContext: WorkspaceRequestContext;
  approverContext: WorkspaceRequestContext;
};

export interface BackendInputDeliveryEvidenceInput {
  runId: string;
  replayed: boolean;
  run: Pick<BackendRunRecord, "id" | "status" | "phase" | "current_attempt">;
  beforeEventIds: ReadonlySet<string>;
  events: readonly Pick<BackendEventRecord, "id" | "run_id" | "event_type" | "attempt_no">[];
}

/**
 * Checks the Server-owned evidence for a backend input handoff. A terminal
 * Run replay has no new delivery event and is therefore not a successful
 * submission. The event must be newly persisted for this control operation
 * and the resulting Run must still be a valid post-resume state.
 */
export function assertBackendInputDeliveryEvidence(input: BackendInputDeliveryEvidenceInput): void {
  const runStateAllowsDelivery = ["running", "waiting_for_backend_input", "completed"].includes(input.run.status)
    && (input.run.phase !== "settled" || input.run.status === "completed");
  const attemptMatches = (event: BackendInputDeliveryEvidenceInput["events"][number]): boolean =>
    input.run.current_attempt === undefined || event.attempt_no === input.run.current_attempt;
  const delivered = input.events.some((event) =>
    event.event_type === "backend_native_input_submitted"
      && event.run_id === input.runId
      && !input.beforeEventIds.has(event.id)
      && attemptMatches(event)
  );
  if (input.replayed || input.run.id !== input.runId || !runStateAllowsDelivery || !delivered) {
    throw new WorkspaceServerError("workspace_interaction_backend_input_delivery_unverified", 409);
  }
}

/**
 * Rechecks both persisted human actors. `assertRoomExecutable` atomically
 * checks current Room execute permission and current Workspace writable state.
 * The maintenance Account is intentionally not used for either check.
 */
export async function reauthorizeAcceptedInteractionRequest(
  authorization: WorkspaceInteractionAuthorizationPort,
  base: Pick<WorkspaceRequestContext, "workspaceId" | "operationId">,
  request: WorkspaceInteractionRequest
): Promise<AcceptedInteractionAuthorization> {
  const requesterContext = interactionActorContext(base, request.requestedAccountId, "requester");
  const decidedAccountId = request.decidedAccountId;
  if (!decidedAccountId) throw new WorkspaceServerError("workspace_interaction_execution_actor_missing", 409);
  const approverContext = interactionActorContext(base, decidedAccountId, "approver");

  const actors = new Map<string, WorkspaceRequestContext>([
    [requesterContext.accountId, requesterContext],
    [approverContext.accountId, approverContext]
  ]);
  for (const actorContext of actors.values()) {
    await authorization.assertRoomExecutable(actorContext, request.roomId);
  }
  return { requesterContext, approverContext };
}

export type InteractionAuthorizationFailureDisposition = "denied" | "retryable";

/**
 * Only an explicit authorization refusal may terminalize an accepted request.
 * PostgreSQL/connection failures and unknown errors remain retryable. In
 * particular, do not infer revocation from a generic 500 or driver error.
 */
export function classifyInteractionAuthorizationFailure(error: unknown): InteractionAuthorizationFailureDisposition {
  if (error instanceof WorkspaceServerError && error.status === 403) return "denied";
  if (!error || typeof error !== "object") return "retryable";
  const candidate = error as { code?: unknown; status?: unknown };
  if (candidate.status === 403 || candidate.status === "403") return "denied";
  if (candidate.code === "42501" || candidate.code === "insufficient_privilege") return "denied";
  return "retryable";
}

function isExplicitInteractionAuthorizationRefusal(error: unknown): boolean {
  return classifyInteractionAuthorizationFailure(error) === "denied";
}

/**
 * Application service for the complete durable interaction lifecycle.
 * HTTP supplies only the authenticated response selection; the maintenance
 * worker supplies only a recovery candidate. Notifications and public
 * response conversion are injected at those transport boundaries.
 */
export class WorkspaceInteractionRequestWorkflowService {
  constructor(private readonly dependencies: AcceptedInteractionExecutionDependencies) {}

  /**
   * Submits one Generated Surface action and creates an approval request when
   * the declared action requires it. Keeping this decision beside the
   * accepted-request execution path makes the HTTP route a transport adapter:
   * it no longer owns idempotency, target persistence, or notification rules.
   */
  async submitGeneratedSurfaceAction(
    operation: WorkspaceRequestContext,
    input: Parameters<PostgresGeneratedSurface["prepareAction"]>[1]
  ): Promise<SubmittedGeneratedSurfaceAction> {
    const executeDirectAction = async (): Promise<SubmittedGeneratedSurfaceAction> => {
      const execution = await this.dependencies.generatedSurfaces.runActionWithReplay(operation, input);
      if (!execution.replayed) {
        runBestEffortNotification(() => this.dependencies.notifications?.onGeneratedSurfaceChanged?.(operation, {
          roomId: input.room_id,
          surfaceId: input.surface_id,
          ...(input.revision_id ? { revisionId: input.revision_id } : {})
        }));
      }
      return { kind: "executed", result: execution.result as unknown as Record<string, unknown>, replayed: execution.replayed };
    };

    try {
      return await executeDirectAction();
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.code !== "generated_surface_action_confirmation_required") throw error;
    }

    const prepared = await this.dependencies.generatedSurfaces.prepareAction(operation, input);
    if (!prepared.action.requires_confirmation) return executeDirectAction();
    const created = await this.dependencies.interactionRequests.create(operation, {
      roomId: prepared.target.room_id,
      kind: "approval",
      surfaceId: prepared.target.surface_id,
      revisionId: prepared.target.revision_id,
      actionTarget: prepared.target as unknown as Record<string, JsonValue>,
      title: `${prepared.surface.title}: ${prepared.action.label}`,
      summary: "このSurface操作は、現在の対象版とRoom権限を再確認してから実行されます。",
      options: [
        { id: "approve", label: "実行を許可", decision: "approve" },
        { id: "deny", label: "実行しない", decision: "deny" }
      ]
    });
    if (!created.replayed) {
      runBestEffortNotification(() => this.dependencies.notifications?.onInteractionRequestChanged?.(
        operation,
        created.request,
        "created"
      ));
    }
    if (created.replayed && created.request.status === "completed") {
      const targetResult = await this.getCompletedGeneratedSurfaceActionResult(operation, created.request);
      if (targetResult === undefined) {
        throw new WorkspaceServerError("workspace_interaction_target_result_unavailable", 503);
      }
      return {
        kind: "completed",
        result: { target_result: targetResult },
        targetResult,
        replayed: true
      };
    }
    return { kind: "approval_required", request: created.request, replayed: created.replayed };
  }

  /**
   * Cancels a pending request after checking the current Room authorization.
   * The HTTP layer must not perform this check or decide when to emit the
   * transition event; both belong to this application workflow.
   */
  async cancel(
    operation: WorkspaceRequestContext,
    input: Parameters<WorkspaceInteractionRequestService["cancel"]>[1]
  ): Promise<Awaited<ReturnType<WorkspaceInteractionRequestService["cancel"]>>> {
    await this.dependencies.authorization.assertRoomExecutable(operation, input.roomId);
    const result = await this.dependencies.interactionRequests.cancel(operation, input);
    if (!result.replayed) {
      runBestEffortNotification(() => this.dependencies.notifications?.onInteractionRequestChanged?.(
        operation,
        result.request,
        "cancelled"
      ));
    }
    return result;
  }

  /**
   * Reads the immutable result for a completed approval without claiming or
   * settling the request. The HTTP boundary checks Room readability before
   * calling this read-only workflow method.
   */
  async getCompletedGeneratedSurfaceActionResult(
    context: WorkspaceRequestContext,
    request: WorkspaceInteractionRequest
  ): Promise<JsonValue | undefined> {
    if (
      request.status !== "completed"
      || request.kind !== "approval"
      || request.actionTarget.kind !== "generated_surface_action"
    ) return undefined;

    const initialExecutionOperationId = workspaceInteractionExecutionOperationId(context.workspaceId, request.id, "initial");
    const resultLookup = await this.dependencies.interactionRequests.getExecutionTargetResultLookup(context, {
      roomId: request.roomId,
      requestId: request.id
    });
    const targetResult = await this.findTargetResult(
      context,
      request.actionTarget as unknown as GeneratedSurfaceActionTarget,
      [initialExecutionOperationId, ...resultLookup.operationIds]
    );
    if (targetResult === undefined) {
      throw new WorkspaceServerError("workspace_interaction_target_result_unavailable", 503, {
        operation_id: initialExecutionOperationId
      });
    }
    return targetResult;
  }

  async respondAndExecute(
    responseOperation: WorkspaceRequestContext,
    input: Parameters<WorkspaceInteractionRequestService["respond"]>[1],
    runtimeFor: AcceptedInteractionRuntimeFactory
  ): Promise<WorkspaceInteractionResponseResult> {
    await this.dependencies.authorization.assertRoomExecutable(responseOperation, input.roomId);
    const response = await this.dependencies.interactionRequests.respond(responseOperation, input);
    if (response.replayed && response.request.decidedAccountId !== responseOperation.accountId) {
      throw new WorkspaceServerError("workspace_interaction_response_actor_mismatch", 409);
    }
    if (!response.replayed) {
      runBestEffortNotification(() => this.dependencies.notifications?.onInteractionRequestChanged?.(
        responseOperation,
        response.request,
        "responded"
      ));
    }
    if (response.replayed && response.request.status === "completed") {
      const targetResult = await this.getCompletedGeneratedSurfaceActionResult(responseOperation, response.request);
      if (targetResult !== undefined) {
        return { response, execution: { request: response.request, targetResult } };
      }
      return { response };
    }
    if (response.request.status !== "accepted") return { response };
    return {
      response,
      execution: await this.executeAccepted(responseOperation, response.request, runtimeFor)
    };
  }

  async executeAccepted(
    lifecycleContext: WorkspaceRequestContext,
    accepted: WorkspaceInteractionRequest,
    runtimeFor: AcceptedInteractionRuntimeFactory,
    executionOperationId?: string
  ): Promise<AcceptedInteractionExecutionResult> {
    const ownerId = "workspace-server-interaction-executor";
    const effectiveExecutionOperationId = executionOperationId
      ?? workspaceInteractionExecutionOperationId(lifecycleContext.workspaceId, accepted.id, "initial");
    const recoveryNotificationOptions: WorkspaceInteractionRequestEventOptions | undefined = executionOperationId === undefined
      ? undefined
      : {
        actor: WORKSPACE_INTERACTION_RECOVERY_AUDIT_ACTOR,
        correlationId: effectiveExecutionOperationId
      };
    const claimContext = interactionServerContext(lifecycleContext, accepted.id, "claim");
    let preAuthorizationRefusal: unknown;
    try {
      await reauthorizeAcceptedInteractionRequest(this.dependencies.authorization, lifecycleContext, accepted);
    } catch (error) {
      if (!isExplicitInteractionAuthorizationRefusal(error)) throw error;
      preAuthorizationRefusal = error;
    }
    const claim = await this.dependencies.interactionRequests.claimExecution(claimContext, {
      roomId: accepted.roomId,
      requestId: accepted.id,
      expectedVersion: accepted.version,
      ownerId,
      executionOperationId: effectiveExecutionOperationId
    });
    const claimedLifecycleContext = { ...lifecycleContext, operationId: claim.claim.executionOperationId };

    // A replayed claim means an earlier process may already have crossed the
    // external execution boundary. Never dispatch that side effect a second
    // time. Generated Surface actions have a durable result record which lets
    // this path distinguish "settle was lost" from an interrupted execution.
    if (claim.replayed) {
      // A completed request is already a terminal outcome. Re-authorization
      // must not rewrite it to failed merely because the caller's membership
      // changed after the original execution. The result endpoint performs
      // its own current read authorization when a result is requested.
      if (claim.request.status === "completed") return { request: claim.request };
      if (preAuthorizationRefusal !== undefined) {
        return this.settleReplayedAuthorizationRefusal(
          lifecycleContext,
          claim,
          ownerId,
          preAuthorizationRefusal,
          recoveryNotificationOptions
        );
      }
      if (isGeneratedSurfaceApprovalRequest(claim.request)
        && claim.request.status === "executing") {
        return this.reconcileReplayedGeneratedSurfaceExecution(
          lifecycleContext,
          claim,
          ownerId,
          recoveryNotificationOptions
        );
      }
      return { request: claim.request };
    }
    let authorization: AcceptedInteractionAuthorization;
    try {
      await this.dependencies.interactionRequests.assertExecutionClaim(
        interactionServerContext(claimedLifecycleContext, claim.request.id, "claim-check"),
        {
          roomId: claim.request.roomId,
          requestId: claim.request.id,
          expectedVersion: claim.request.version,
          ownerId,
          executionOperationId: claim.claim.executionOperationId
        }
      );
    } catch (error) {
      return this.releaseClaimAndRethrow(claimedLifecycleContext, claim, ownerId, error);
    }
    if (preAuthorizationRefusal !== undefined) {
      return this.settleFailedAcceptedInteractionRequest(
        claimedLifecycleContext,
        claim,
        ownerId,
        preAuthorizationRefusal,
        recoveryNotificationOptions
      );
    }
    try {
      authorization = await reauthorizeAcceptedInteractionRequest(this.dependencies.authorization, lifecycleContext, claim.request);
    } catch (error) {
      if (isExplicitInteractionAuthorizationRefusal(error)) {
        return this.settleFailedAcceptedInteractionRequest(
          claimedLifecycleContext,
          claim,
          ownerId,
          error,
          recoveryNotificationOptions
        );
      }
      return this.releaseClaimAndRethrow(claimedLifecycleContext, claim, ownerId, error);
    }

    runBestEffortNotification(() => this.dependencies.notifications?.onInteractionRequestChanged?.(
      claimedLifecycleContext,
      claim.request,
      "executing",
      recoveryNotificationOptions
    ));

    // Only the saved approver context crosses the external side-effect
    // boundary. In particular, the maintenance Account never runs a Surface
    // target or resumes a backend Run on its own authority.
    const executionContext = { ...authorization.approverContext, operationId: claim.claim.executionOperationId };
    if (claim.request.kind === "approval") {
      let result: Record<string, unknown>;
      try {
        const target = claim.executionTarget.actionTarget as unknown as GeneratedSurfaceActionTarget;
        result = await this.dependencies.generatedSurfaces.executeActionTarget(executionContext, target);
      } catch (error) {
        return this.settleFailedAcceptedInteractionRequest(
          claimedLifecycleContext,
          claim,
          ownerId,
          error,
          recoveryNotificationOptions
        );
      }
      const settled = await this.dependencies.interactionRequests.settleExecution(
        interactionServerContext(claimedLifecycleContext, claim.request.id, "settle"),
        {
          roomId: claim.request.roomId,
          requestId: claim.request.id,
          expectedVersion: claim.request.version,
          ownerId,
          executionOperationId: claim.claim.executionOperationId,
          status: "completed",
          summary: "Generated Surface action completed."
        }
      );
      if (!settled.replayed) {
        runBestEffortNotification(() => this.dependencies.notifications?.onInteractionRequestChanged?.(
          claimedLifecycleContext,
          settled.request,
          "completed",
          recoveryNotificationOptions
        ));
        const surfaceId = claim.executionTarget.surfaceId;
        if (surfaceId) {
          runBestEffortNotification(() => this.dependencies.notifications?.onGeneratedSurfaceChanged?.(
            executionContext,
            {
              roomId: claim.request.roomId,
              surfaceId,
              revisionId: claim.executionTarget.revisionId
            },
            recoveryNotificationOptions
          ));
        }
      }
      return { request: settled.request, rawResult: result };
    }

    const runId = claim.executionTarget.runId;
    let execution: Awaited<ReturnType<RunControlService["execute"]>>;
    try {
      if (!runId || !isJsonObject(claim.executionInput)) {
        throw new WorkspaceServerError("workspace_interaction_backend_input_invalid", 409);
      }
      const runtime = runtimeFor(executionContext);
      const beforeEvents = await runtime.listBackendEvents({ runId });
      execution = await (this.dependencies.runControl ?? defaultRunControlService).execute({
        runtime,
        action: "resume",
        runId,
        roomId: claim.request.roomId,
        resumeInput: claim.executionInput,
        idempotencyKey: claim.claim.executionOperationId,
          onChanged: async ({ action, run }) => {
          runBestEffortNotification(() => this.dependencies.notifications?.onRunChanged?.(
            executionContext,
            {
              roomId: run.room_id ?? claim.request.roomId,
              runId: run.id,
              status: run.status,
              action
            },
            recoveryNotificationOptions
          ));
        }
      });
      const afterEvents = execution.replayed ? [] : await runtime.listBackendEvents({ runId });
      assertBackendInputDeliveryEvidence({
        runId,
        replayed: execution.replayed,
        run: execution.run,
        beforeEventIds: new Set(beforeEvents.map((event) => event.id)),
        events: afterEvents
      });
    } catch (error) {
      return this.settleFailedAcceptedInteractionRequest(
        claimedLifecycleContext,
        claim,
        ownerId,
        error,
        recoveryNotificationOptions
      );
    }
    const settled = await this.dependencies.interactionRequests.settleExecution(
      interactionServerContext(claimedLifecycleContext, claim.request.id, "settle"),
      {
        roomId: claim.request.roomId,
        requestId: claim.request.id,
        expectedVersion: claim.request.version,
        ownerId,
        executionOperationId: claim.claim.executionOperationId,
        status: "completed",
        summary: "Backend input delivered to the current Run."
      }
    );
    if (!settled.replayed) runBestEffortNotification(() => this.dependencies.notifications?.onInteractionRequestChanged?.(
      claimedLifecycleContext,
      settled.request,
      "completed",
      recoveryNotificationOptions
    ));
    return { request: settled.request };
  }

  /** Only side-effect/admission failures may become terminal failures. */
  private async settleFailedAcceptedInteractionRequest(
    lifecycleContext: WorkspaceRequestContext,
    claim: { request: WorkspaceInteractionRequest; claim: { executionOperationId: string } },
    ownerId: string,
    error: unknown,
    notificationOptions?: WorkspaceInteractionRequestEventOptions
  ): Promise<AcceptedInteractionExecutionResult> {
    const settled = await this.dependencies.interactionRequests.settleExecution(
      interactionServerContext(lifecycleContext, claim.request.id, "settle-failed"),
      {
        roomId: claim.request.roomId,
        requestId: claim.request.id,
        expectedVersion: claim.request.version,
        ownerId,
        executionOperationId: claim.claim.executionOperationId,
        status: "failed",
        summary: "The Server could not execute the approved request.",
        errorCode: publicInteractionErrorCode(error)
      }
    );
    if (!settled.replayed) runBestEffortNotification(() => this.dependencies.notifications?.onInteractionRequestChanged?.(
      lifecycleContext,
      settled.request,
      "failed",
      notificationOptions
    ));
    return { request: settled.request };
  }

  /**
   * Completes a replayed Generated Surface claim from its immutable result
   * record. If the previous lease elapsed, a fresh claim is acquired before
   * settling; the old execution operation remains the lookup key for the
   * result record. No target command is called from this recovery path.
   */
  private async reconcileReplayedGeneratedSurfaceExecution(
    lifecycleContext: WorkspaceRequestContext,
    claim: Awaited<ReturnType<WorkspaceInteractionRequestService["claimExecution"]>>,
    ownerId: string,
    notificationOptions?: WorkspaceInteractionRequestEventOptions
  ): Promise<AcceptedInteractionExecutionResult> {
    let authorization: AcceptedInteractionAuthorization;
    try {
      authorization = await reauthorizeAcceptedInteractionRequest(
        this.dependencies.authorization,
        lifecycleContext,
        claim.request
      );
    } catch (error) {
      if (isExplicitInteractionAuthorizationRefusal(error)) {
        return this.settleReplayedAuthorizationRefusal(
          lifecycleContext,
          claim,
          ownerId,
          error,
          notificationOptions
        );
      }
      throw error;
    }
    const originalExecutionOperationId = claim.claim.executionOperationId;
    const resultOperationIds = targetResultOperationIds(claim, originalExecutionOperationId);
    let activeClaim = claim;
    let targetResult = await this.findTargetResult(
      authorization.approverContext,
      claim.executionTarget.actionTarget as unknown as GeneratedSurfaceActionTarget,
      resultOperationIds
    );

    if (claim.request.status === "completed") {
      if (targetResult === undefined) {
        throw new WorkspaceServerError("workspace_interaction_target_result_unavailable", 503, {
          operation_id: originalExecutionOperationId
        });
      }
      return { request: claim.request, targetResult };
    }

    const stale = executionClaimIsStale(claim.claim.leaseUntil);
    if (targetResult === undefined && !stale) return { request: claim.request };

    if (stale) {
      const recoveryOperationId = workspaceInteractionExecutionOperationId(
        lifecycleContext.workspaceId,
        claim.request.id,
        `recovery:${originalExecutionOperationId}`
      );
      try {
        activeClaim = await this.dependencies.interactionRequests.recoverExecution(
          interactionServerContext(lifecycleContext, claim.request.id, "recover"),
          {
            roomId: claim.request.roomId,
            requestId: claim.request.id,
            expectedVersion: claim.request.version,
            ownerId,
            executionOperationId: recoveryOperationId
          }
        );
      } catch (error) {
        if (!isExecutionResultLookupLimit(error)) throw error;
        return this.failStaleAcceptedInteractionRequest(
          { ...lifecycleContext, operationId: claim.claim.executionOperationId },
          claim,
          error,
          notificationOptions
        );
      }
      targetResult = await this.findTargetResult(
        authorization.approverContext,
        activeClaim.executionTarget.actionTarget as unknown as GeneratedSurfaceActionTarget,
        [...resultOperationIds, ...targetResultOperationIds(activeClaim, originalExecutionOperationId)]
      );
    }

    if (targetResult === undefined) {
      return this.settleFailedAcceptedInteractionRequest(
        { ...lifecycleContext, operationId: activeClaim.claim.executionOperationId },
        activeClaim,
        ownerId,
        new WorkspaceServerError("workspace_interaction_execution_interrupted", 503),
        notificationOptions
      );
    }

    return this.settleGeneratedSurfaceExecution(
      { ...lifecycleContext, operationId: activeClaim.claim.executionOperationId },
      activeClaim,
      ownerId,
      targetResult,
      notificationOptions,
      authorization.approverContext
    );
  }

  /**
   * A replayed stale claim cannot be settled under its expired lease. Acquire
   * one fresh lease before recording an explicit authorization refusal. This
   * path never reads or executes the target: once either saved actor is no
   * longer executable, the approved request is failed closed even if an old
   * target result happens to exist.
   */
  private async settleReplayedAuthorizationRefusal(
    lifecycleContext: WorkspaceRequestContext,
    claim: Awaited<ReturnType<WorkspaceInteractionRequestService["claimExecution"]>>,
    ownerId: string,
    error: unknown,
    notificationOptions?: WorkspaceInteractionRequestEventOptions
  ): Promise<AcceptedInteractionExecutionResult> {
    let activeClaim = claim;
    if (executionClaimIsStale(claim.claim.leaseUntil)) {
      const recoveryOperationId = workspaceInteractionExecutionOperationId(
        lifecycleContext.workspaceId,
        claim.request.id,
        `authorization-recovery:${claim.claim.executionOperationId}`
      );
      try {
        activeClaim = await this.dependencies.interactionRequests.recoverExecution(
          interactionServerContext(lifecycleContext, claim.request.id, "recover-authorization"),
          {
            roomId: claim.request.roomId,
            requestId: claim.request.id,
            expectedVersion: claim.request.version,
            ownerId,
            executionOperationId: recoveryOperationId
          }
        );
      } catch (recoveryError) {
        if (!isExecutionResultLookupLimit(recoveryError)) throw recoveryError;
        return this.failStaleAcceptedInteractionRequest(
          { ...lifecycleContext, operationId: claim.claim.executionOperationId },
          claim,
          error,
          notificationOptions
        );
      }
    }
    return this.settleFailedAcceptedInteractionRequest(
      { ...lifecycleContext, operationId: activeClaim.claim.executionOperationId },
      activeClaim,
      ownerId,
      error,
      notificationOptions
    );
  }

  private async findTargetResult(
    context: WorkspaceRequestContext,
    target: GeneratedSurfaceActionTarget,
    operationIds: readonly string[]
  ): Promise<JsonValue | undefined> {
    const uniqueOperationIds = [...new Set(operationIds)];
    for (const operationId of uniqueOperationIds) {
      try {
        const result = await this.dependencies.generatedSurfaces.getActionTargetResult(context, target, operationId);
        if (result !== undefined) return result;
      } catch (error) {
        // A retained candidate can predate the stable interaction ID or have
        // failed before persisting a result. It is not evidence that a newer
        // candidate did not complete, so keep searching the durable lineage.
        if (isMissingTargetResultCandidate(error)) continue;
        throw error;
      }
    }
    return undefined;
  }

  private async settleGeneratedSurfaceExecution(
    lifecycleContext: WorkspaceRequestContext,
    claim: Awaited<ReturnType<WorkspaceInteractionRequestService["claimExecution"]>>,
    ownerId: string,
    targetResult: JsonValue,
    notificationOptions?: WorkspaceInteractionRequestEventOptions,
    approverContext?: WorkspaceRequestContext
  ): Promise<AcceptedInteractionExecutionResult> {
    const settled = await this.dependencies.interactionRequests.settleExecution(
      interactionServerContext(lifecycleContext, claim.request.id, "settle"),
      {
        roomId: claim.request.roomId,
        requestId: claim.request.id,
        expectedVersion: claim.request.version,
        ownerId,
        executionOperationId: claim.claim.executionOperationId,
        status: "completed",
        summary: "Generated Surface action completed."
      }
    );
    if (!settled.replayed) {
      runBestEffortNotification(() => this.dependencies.notifications?.onInteractionRequestChanged?.(
        lifecycleContext,
        settled.request,
        "completed",
        notificationOptions
      ));
      const surfaceId = claim.executionTarget.surfaceId;
      if (surfaceId) {
        runBestEffortNotification(() => this.dependencies.notifications?.onGeneratedSurfaceChanged?.(
          approverContext ?? lifecycleContext,
          {
            roomId: claim.request.roomId,
            surfaceId,
            revisionId: claim.executionTarget.revisionId
          },
          notificationOptions
        ));
      }
    }
    return { request: settled.request, targetResult };
  }

  /**
   * A provenance-limit failure is deterministic only after the current lease
   * has elapsed. It cannot use normal settlement, which correctly rejects an
   * expired claim; the lifecycle service owns the narrow stale terminalization
   * transition and keeps it unavailable to transport callers.
   */
  private async failStaleAcceptedInteractionRequest(
    lifecycleContext: WorkspaceRequestContext,
    claim: { request: WorkspaceInteractionRequest; claim: { executionOperationId: string } },
    error: unknown,
    notificationOptions?: WorkspaceInteractionRequestEventOptions
  ): Promise<AcceptedInteractionExecutionResult> {
    const failed = await this.dependencies.interactionRequests.failStaleExecution(
      interactionServerContext(lifecycleContext, claim.request.id, "settle-stale-failed"),
      {
        roomId: claim.request.roomId,
        requestId: claim.request.id,
        expectedVersion: claim.request.version,
        executionOperationId: claim.claim.executionOperationId,
        summary: "The Server could not safely recover the approved request.",
        errorCode: publicInteractionErrorCode(error)
      }
    );
    if (!failed.replayed) runBestEffortNotification(() => this.dependencies.notifications?.onInteractionRequestChanged?.(
      lifecycleContext,
      failed.request,
      "failed",
      notificationOptions
    ));
    return { request: failed.request };
  }

  /**
   * A claim is not a terminal outcome. If the immediately-before-execution
   * authorization check hit infrastructure trouble, release it when the
   * store is available and surface the original error so the same operation
   * can be retried. If release itself is unavailable, leave the claim for the
   * explicit stale/unknown recovery lane; never mark it failed based only on
   * an ambiguous authorization error.
   */
  private async releaseClaimAndRethrow(
    lifecycleContext: WorkspaceRequestContext,
    claim: { request: WorkspaceInteractionRequest; claim: { executionOperationId: string } },
    ownerId: string,
    error: unknown
  ): Promise<never> {
    try {
      await this.dependencies.interactionRequests.releaseExecutionClaim(
        interactionServerContext(lifecycleContext, claim.request.id, "release"),
        {
          roomId: claim.request.roomId,
          requestId: claim.request.id,
          expectedVersion: claim.request.version,
          ownerId,
          executionOperationId: claim.claim.executionOperationId
        }
      );
    } catch {
      // Keep the original authorization/claim error. A release failure is
      // also ambiguous and must not be converted into a terminal failure.
    }
    throw error;
  }
}

function interactionActorContext(
  base: Pick<WorkspaceRequestContext, "workspaceId" | "operationId">,
  accountId: string,
  actor: "requester" | "approver"
): WorkspaceRequestContext {
  return {
    workspaceId: base.workspaceId,
    accountId,
    operationId: `interaction_${createHash("sha256").update(`${base.workspaceId}|${base.operationId}|${actor}|${accountId}`).digest("hex").slice(0, 48)}`
  };
}

function interactionServerContext(context: WorkspaceRequestContext, requestId: string, phase: string): WorkspaceRequestContext {
  return {
    ...context,
    operationId: `interaction_${createHash("sha256").update(`${context.workspaceId}|${requestId}|${context.operationId}|${phase}`).digest("hex").slice(0, 48)}`
  };
}

function publicInteractionErrorCode(error: unknown): string {
  if (error instanceof WorkspaceServerError) return error.code;
  if (isExplicitInteractionAuthorizationRefusal(error)) return "room_not_executable_or_access_denied";
  return "workspace_interaction_execution_failed";
}

/** The persisted lookup history is intentionally bounded. Exhaustion is a
 * deterministic safety limit, unlike an unavailable database, so a stale
 * request must become terminal instead of remaining eligible forever. */
function isExecutionResultLookupLimit(error: unknown): boolean {
  return error instanceof WorkspaceServerError
    && error.code === "workspace_interaction_execution_provenance_limit_exceeded";
}

function isMissingTargetResultCandidate(error: unknown): boolean {
  return error instanceof WorkspaceServerError
    && (error.code === "generated_surface_interaction_conflict"
      || error.code === "generated_surface_action_result_unavailable");
}

function isGeneratedSurfaceApprovalRequest(request: WorkspaceInteractionRequest): boolean {
  return request.kind === "approval"
    && isJsonObject(request.actionTarget)
    && request.actionTarget.kind === "generated_surface_action";
}

function executionClaimIsStale(leaseUntil: string): boolean {
  return Number.isFinite(Date.parse(leaseUntil)) && Date.parse(leaseUntil) <= Date.now();
}

/**
 * Result operation IDs are optional for compatibility with older lifecycle
 * stores. The execution operation itself remains the safe fallback because it
 * is the durable key used before the store learned to retain all target keys.
 */
function targetResultOperationIds(
  claim: unknown,
  fallbackOperationId: string
): string[] {
  const candidate = claim as {
    executionTargetResultLookup?: { operationIds?: unknown };
  };
  const ids = Array.isArray(candidate.executionTargetResultLookup?.operationIds)
    ? candidate.executionTargetResultLookup.operationIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  return ids.length > 0 ? ids : [fallbackOperationId];
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createWorkspaceInteractionRequestWorkflow(
  dependencies: AcceptedInteractionExecutionDependencies
): WorkspaceInteractionRequestWorkflowService {
  return new WorkspaceInteractionRequestWorkflowService(dependencies);
}
