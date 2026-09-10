import { describe, expect, it, vi } from "vitest";
import type { BackendRunRecord, JsonValue } from "@samurai-agent/core-schemas";
import {
  WorkspaceServerError
} from "@samurai-agent/workspace-server";
import type {
  WorkspaceInteractionRequest,
  WorkspaceInteractionRequestService,
  WorkspaceRequestContext
} from "@samurai-agent/workspace-server";
import { workspaceInteractionExecutionOperationId } from "@samurai-agent/workspace-server";
import type { PostgresRuntimeCommandService } from "../adapters/runtime/postgres-runtime-chat";
import type { RunControlService } from "./run-control-service";
import {
  WORKSPACE_INTERACTION_RECOVERY_AUDIT_ACTOR,
  WorkspaceInteractionRequestWorkflowService,
  type AcceptedInteractionExecutionDependencies
} from "./interaction-request-workflow";

const approvalRequest: WorkspaceInteractionRequest = {
  id: "interaction_notification_isolation",
  workspaceId: "workspace_notification_isolation",
  roomId: "room_notification_isolation",
  version: 1,
  kind: "approval",
  status: "accepted",
  title: "Approve action",
  summary: "Run the saved action target.",
  surfaceId: "surface_notification_isolation",
  revisionId: "revision_notification_isolation",
  actionTarget: {
    kind: "generated_surface_action",
    room_id: "room_notification_isolation",
    surface_id: "surface_notification_isolation",
    revision_id: "revision_notification_isolation",
    action_id: "approve",
    command_id: "artifact.create",
    payload: {}
  },
  options: [{ id: "approve", label: "Approve", decision: "approve" }],
  requestedAccountId: "account_requester",
  decidedAccountId: "account_approver",
  expiresAt: "2026-09-11T00:00:00.000Z",
  outcome: {
    kind: "response",
    optionId: "approve",
    decision: "approve",
    decidedAt: "2026-09-10T00:00:01.000Z"
  },
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:01.000Z"
};

const maintenanceContext: WorkspaceRequestContext = {
  workspaceId: approvalRequest.workspaceId,
  accountId: "account_maintenance",
  operationId: "interaction_notification_test"
};

function claimedRequest(request: WorkspaceInteractionRequest = approvalRequest): WorkspaceInteractionRequest {
  return { ...request, status: "executing", version: request.version + 1 };
}

function workflowDependencies(input: {
  authorization?: Partial<AcceptedInteractionExecutionDependencies["authorization"]>;
  create?: WorkspaceInteractionRequestService["create"];
  respond?: WorkspaceInteractionRequestService["respond"];
  cancel?: WorkspaceInteractionRequestService["cancel"];
  claimExecution: WorkspaceInteractionRequestService["claimExecution"];
  assertExecutionClaim?: WorkspaceInteractionRequestService["assertExecutionClaim"];
  releaseExecutionClaim?: WorkspaceInteractionRequestService["releaseExecutionClaim"];
  recoverExecution?: WorkspaceInteractionRequestService["recoverExecution"];
  failStaleExecution?: WorkspaceInteractionRequestService["failStaleExecution"];
  settleExecution: WorkspaceInteractionRequestService["settleExecution"];
  executeActionTarget: (context: WorkspaceRequestContext, target: unknown) => Promise<Record<string, unknown>>;
  getActionTargetResult?: (context: WorkspaceRequestContext, target: unknown, executionOperationId: string) => Promise<JsonValue | undefined>;
  getExecutionTargetResultLookup?: WorkspaceInteractionRequestService["getExecutionTargetResultLookup"];
  prepareAction?: (...args: never[]) => Promise<unknown>;
  runActionWithReplay?: (...args: never[]) => Promise<unknown>;
  notifications?: AcceptedInteractionExecutionDependencies["notifications"];
  runControl?: AcceptedInteractionExecutionDependencies["runControl"];
}): AcceptedInteractionExecutionDependencies {
  const defaultAuthorization: AcceptedInteractionExecutionDependencies["authorization"] = {
    assertRoomExecutable: vi.fn(async () => undefined)
  };
  return {
    authorization: { ...defaultAuthorization, ...input.authorization },
    interactionRequests: {
      create: input.create ?? (vi.fn(async () => { throw new Error("create_not_configured"); }) as unknown as WorkspaceInteractionRequestService["create"]),
      respond: input.respond ?? (vi.fn(async () => { throw new Error("respond_not_configured"); }) as unknown as WorkspaceInteractionRequestService["respond"]),
      cancel: input.cancel ?? (vi.fn(async () => { throw new Error("cancel_not_configured"); }) as unknown as WorkspaceInteractionRequestService["cancel"]),
      getExecutionTargetResultLookup: input.getExecutionTargetResultLookup ?? vi.fn(async () => ({ operationIds: [] })),
      claimExecution: input.claimExecution,
      assertExecutionClaim: input.assertExecutionClaim ?? (vi.fn(async () => claimedRequest()) as unknown as WorkspaceInteractionRequestService["assertExecutionClaim"]),
      releaseExecutionClaim: input.releaseExecutionClaim ?? (vi.fn(async () => { throw new Error("release_not_configured"); }) as unknown as WorkspaceInteractionRequestService["releaseExecutionClaim"]),
      recoverExecution: input.recoverExecution ?? (vi.fn(async () => { throw new Error("recover_not_configured"); }) as unknown as WorkspaceInteractionRequestService["recoverExecution"]),
      failStaleExecution: input.failStaleExecution ?? (vi.fn(async () => { throw new Error("fail_stale_not_configured"); }) as unknown as WorkspaceInteractionRequestService["failStaleExecution"]),
      settleExecution: input.settleExecution
    },
    generatedSurfaces: {
      executeActionTarget: input.executeActionTarget,
      getActionTargetResult: input.getActionTargetResult ?? vi.fn(async () => undefined),
      prepareAction: input.prepareAction ?? (vi.fn(async () => { throw new Error("prepareAction_not_configured"); }) as never),
      runActionWithReplay: input.runActionWithReplay ?? (vi.fn(async () => { throw new Error("runActionWithReplay_not_configured"); }) as never)
    } as never,
    ...(input.notifications ? { notifications: input.notifications } : {}),
    ...(input.runControl ? { runControl: input.runControl } : {})
  } as AcceptedInteractionExecutionDependencies;
}

describe("WorkspaceInteractionRequestWorkflowService notification isolation", () => {
  it("reads only the durable result for a completed generated Surface approval", async () => {
    const getActionTargetResult = vi.fn(async () => ({ saved: true }));
    const claimExecution = vi.fn();
    const settleExecution = vi.fn();
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution: claimExecution as unknown as WorkspaceInteractionRequestService["claimExecution"],
      settleExecution: settleExecution as unknown as WorkspaceInteractionRequestService["settleExecution"],
      executeActionTarget: vi.fn(async () => ({ saved: true })),
      getActionTargetResult
    }));
    const completed = { ...approvalRequest, status: "completed" as const };

    await expect(workflow.getCompletedGeneratedSurfaceActionResult(maintenanceContext, completed))
      .resolves.toEqual({ saved: true });
    expect(getActionTargetResult).toHaveBeenCalledWith(
      maintenanceContext,
      completed.actionTarget,
      workspaceInteractionExecutionOperationId(maintenanceContext.workspaceId, completed.id, "initial")
    );
    expect(claimExecution).not.toHaveBeenCalled();
    expect(settleExecution).not.toHaveBeenCalled();
  });

  it("uses retained recovery provenance when returning a completed approval result", async () => {
    const completed = { ...approvalRequest, status: "completed" as const };
    const initialOperationId = workspaceInteractionExecutionOperationId(
      maintenanceContext.workspaceId,
      completed.id,
      "initial"
    );
    const recoveredOperationId = "execution-completed-recovery";
    const getExecutionTargetResultLookup = vi.fn(async () => ({
      operationIds: [initialOperationId, recoveredOperationId]
    })) as unknown as WorkspaceInteractionRequestService["getExecutionTargetResultLookup"];
    const getActionTargetResult = vi.fn(async (
      _context: WorkspaceRequestContext,
      _target: unknown,
      operationId: string
    ) => operationId === recoveredOperationId ? { artifact: { id: "artifact-recovered" } } : undefined);
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["claimExecution"],
      settleExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"],
      executeActionTarget: vi.fn(async () => ({ should_not_run: true })),
      getActionTargetResult,
      getExecutionTargetResultLookup
    }));

    await expect(workflow.getCompletedGeneratedSurfaceActionResult(maintenanceContext, completed))
      .resolves.toEqual({ artifact: { id: "artifact-recovered" } });
    expect(getExecutionTargetResultLookup).toHaveBeenCalledWith(maintenanceContext, {
      roomId: completed.roomId,
      requestId: completed.id
    });
    expect(getActionTargetResult.mock.calls.map(([, , operationId]) => operationId)).toEqual([
      initialOperationId,
      recoveredOperationId
    ]);
  });

  it("continues through a retained interaction conflict to a newer completed result", async () => {
    const completed = {
      ...approvalRequest,
      status: "completed" as const,
      actionTarget: {
        ...approvalRequest.actionTarget,
        interaction_id: "surface_interaction_completed_recovery"
      }
    };
    const initialOperationId = workspaceInteractionExecutionOperationId(
      maintenanceContext.workspaceId,
      completed.id,
      "initial"
    );
    const recoveredOperationId = "execution-interaction-recovery";
    const getActionTargetResult = vi.fn(async (
      _context: WorkspaceRequestContext,
      _target: unknown,
      operationId: string
    ) => {
      if (operationId === initialOperationId) {
        throw new WorkspaceServerError("generated_surface_interaction_conflict", 409);
      }
      return { artifact: { id: "artifact-newer" } };
    });
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["claimExecution"],
      settleExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"],
      executeActionTarget: vi.fn(async () => ({ should_not_run: true })),
      getActionTargetResult,
      getExecutionTargetResultLookup: vi.fn(async () => ({
        operationIds: [initialOperationId, recoveredOperationId]
      })) as unknown as WorkspaceInteractionRequestService["getExecutionTargetResultLookup"]
    }));

    await expect(workflow.getCompletedGeneratedSurfaceActionResult(maintenanceContext, completed))
      .resolves.toEqual({ artifact: { id: "artifact-newer" } });
    expect(getActionTargetResult.mock.calls.map(([, , operationId]) => operationId)).toEqual([
      initialOperationId,
      recoveredOperationId
    ]);
  });

  it("does not read an action result for an unresolved or non-approval request", async () => {
    const getActionTargetResult = vi.fn(async () => ({ saved: true }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["claimExecution"],
      settleExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"],
      executeActionTarget: vi.fn(async () => ({ saved: true })),
      getActionTargetResult
    }));

    await expect(workflow.getCompletedGeneratedSurfaceActionResult(maintenanceContext, approvalRequest))
      .resolves.toBeUndefined();
    await expect(workflow.getCompletedGeneratedSurfaceActionResult(maintenanceContext, {
      ...approvalRequest,
      status: "completed",
      kind: "backend_input"
    })).resolves.toBeUndefined();
    expect(getActionTargetResult).not.toHaveBeenCalled();
  });

  it("replays the durable target result when the original Surface approval operation is retried", async () => {
    const completed = { ...approvalRequest, status: "completed" as const, version: 4 };
    const create = vi.fn(async () => ({ request: completed, replayed: true })) as unknown as WorkspaceInteractionRequestService["create"];
    const runActionWithReplay = vi.fn(async () => {
      throw new WorkspaceServerError("generated_surface_action_confirmation_required", 409);
    });
    const prepareAction = vi.fn(async () => ({
      target: approvalRequest.actionTarget,
      surface: { title: "Approval surface" },
      action: { label: "Approve", requires_confirmation: true }
    }));
    const getActionTargetResult = vi.fn(async () => ({ artifact: { id: "artifact-replayed" } }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      create,
      claimExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["claimExecution"],
      settleExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"],
      executeActionTarget: vi.fn(async () => ({ should_not_run: true })),
      getActionTargetResult,
      prepareAction,
      runActionWithReplay
    }));

    await expect(workflow.submitGeneratedSurfaceAction(maintenanceContext, {
      room_id: approvalRequest.roomId,
      surface_id: approvalRequest.surfaceId!,
      revision_id: approvalRequest.revisionId!,
      action_id: "approve",
      action_payload: {}
    })).resolves.toEqual({
      kind: "completed",
      result: { target_result: { artifact: { id: "artifact-replayed" } } },
      targetResult: { artifact: { id: "artifact-replayed" } },
      replayed: true
    });
    expect(create).toHaveBeenCalledOnce();
    expect(getActionTargetResult).toHaveBeenCalledWith(
      maintenanceContext,
      approvalRequest.actionTarget,
      workspaceInteractionExecutionOperationId(approvalRequest.workspaceId, completed.id, "initial")
    );
  });

  it("keeps an approved Surface action completed when response and Event projections fail", async () => {
    const responseRequest = { ...approvalRequest, version: 2 };
    const claimExecution = vi.fn(async (_context: WorkspaceRequestContext, input: { executionOperationId: string }) => ({
      request: claimedRequest(responseRequest),
      claim: { executionOperationId: input.executionOperationId },
      executionTarget: { actionTarget: approvalRequest.actionTarget, surfaceId: approvalRequest.surfaceId },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const settleExecution = vi.fn(async () => ({
      request: { ...claimedRequest(responseRequest), status: "completed", version: 4 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const respond = vi.fn(async () => ({ request: responseRequest, replayed: false })) as unknown as WorkspaceInteractionRequestService["respond"];
    const executeActionTarget = vi.fn(async () => ({ target_result: { saved: true } }));
    const notifications = {
      onInteractionRequestChanged: vi.fn(async () => { throw new Error("interaction_event_projection_unavailable"); }),
      onGeneratedSurfaceChanged: vi.fn(async () => { throw new Error("surface_event_projection_unavailable"); })
    };
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      respond,
      claimExecution,
      settleExecution,
      executeActionTarget,
      notifications
    }));

    const result = await workflow.respondAndExecute(
      { ...maintenanceContext, accountId: approvalRequest.decidedAccountId!, operationId: "interaction_response" },
      {
        roomId: approvalRequest.roomId,
        requestId: approvalRequest.id,
        expectedVersion: 1,
        optionId: "approve"
      },
      () => { throw new Error("approval action must not request a Runtime"); }
    );

    expect(result.execution?.request.status).toBe("completed");
    expect(result.execution?.rawResult).toEqual({ target_result: { saved: true } });
    expect(executeActionTarget).toHaveBeenCalledOnce();
    expect(settleExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed" })
    );
    expect(settleExecution).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed" })
    );
    expect(notifications.onInteractionRequestChanged).toHaveBeenCalledTimes(3);
    expect(notifications.onGeneratedSurfaceChanged).toHaveBeenCalledOnce();
  });

  it("rechecks the saved requester and approver, then executes only as the saved approver", async () => {
    const request = { ...approvalRequest, id: "interaction_saved_actor_reauthorization" };
    const claimed = claimedRequest(request);
    const claimExecution = vi.fn(async () => ({
      request: claimed,
      claim: { executionOperationId: "execution-saved-actor-reauthorization" },
      executionTarget: { actionTarget: request.actionTarget },
      executionTargetResultLookup: { operationIds: ["execution-saved-actor-reauthorization"] },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const settleExecution = vi.fn(async () => ({
      request: { ...claimed, status: "completed" as const, version: claimed.version + 1 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const assertRoomExecutable = vi.fn(async () => undefined);
    const executeActionTarget = vi.fn(async () => ({ target_result: { saved: true } }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      authorization: { assertRoomExecutable },
      claimExecution,
      settleExecution,
      executeActionTarget
    }));

    await expect(workflow.executeAccepted(
      maintenanceContext,
      request,
      () => { throw new Error("Surface approval must not construct a Runtime"); }
    )).resolves.toMatchObject({ request: { status: "completed" } });

    expect(assertRoomExecutable.mock.calls.map(([context]) => context.accountId)).toEqual([
      request.requestedAccountId,
      request.decidedAccountId,
      request.requestedAccountId,
      request.decidedAccountId
    ]);
    expect(executeActionTarget).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: request.decidedAccountId, operationId: "execution-saved-actor-reauthorization" }),
      request.actionTarget
    );
  });

  it("keeps backend input delivery completed when the Run Event projection fails", async () => {
    const request: WorkspaceInteractionRequest = {
      ...approvalRequest,
      id: "interaction_backend_notification_isolation",
      kind: "backend_input",
      runId: "run_notification_isolation",
      surfaceId: undefined,
      revisionId: undefined,
      actionTarget: { kind: "backend_input", run_id: "run_notification_isolation" },
      inputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } }
    };
    const claimed = claimedRequest(request);
    const claimExecution = vi.fn(async (_context: WorkspaceRequestContext, input: { executionOperationId: string }) => ({
      request: claimed,
      claim: { executionOperationId: input.executionOperationId },
      executionTarget: { actionTarget: request.actionTarget, runId: request.runId },
      executionInput: { answer: "yes" },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const settleExecution = vi.fn(async () => ({
      request: { ...claimed, status: "completed", version: 3 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const run: BackendRunRecord = {
      id: request.runId!,
      room_id: request.roomId,
      status: "waiting_for_backend_input",
      phase: "waiting_for_backend_input",
      current_attempt: 1
    } as BackendRunRecord;
    let eventReads = 0;
    const runtime = {
      listBackendEvents: vi.fn(async () => {
        eventReads += 1;
        return eventReads === 1 ? [] : [{
          id: "event_backend_input_submitted",
          run_id: run.id,
          event_type: "backend_native_input_submitted",
          attempt_no: 1
        }];
      })
    } as unknown as PostgresRuntimeCommandService;
    const runControl = {
      execute: vi.fn(async (input: Parameters<RunControlService["execute"]>[0]) => {
        await input.onChanged?.({ action: input.action, run });
        return { result: run, run, replayed: false };
      })
    } as AcceptedInteractionExecutionDependencies["runControl"];
    const notifications = {
      onInteractionRequestChanged: vi.fn(async () => undefined),
      onRunChanged: vi.fn(async () => { throw new Error("run_event_projection_unavailable"); })
    };
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution,
      settleExecution,
      executeActionTarget: vi.fn(async () => ({ saved: true })),
      notifications,
      runControl
    }));

    const result = await workflow.executeAccepted(
      { ...maintenanceContext, workspaceId: request.workspaceId },
      request,
      () => runtime
    );

    expect(result.request.status).toBe("completed");
    expect(runControl.execute).toHaveBeenCalledOnce();
    expect(notifications.onRunChanged).toHaveBeenCalledOnce();
    expect(settleExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed" })
    );
    expect(settleExecution).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed" })
    );
  });

  it("replays the durable target result for a completed response operation without claiming or executing", async () => {
    const responseContext: WorkspaceRequestContext = {
      ...maintenanceContext,
      accountId: approvalRequest.decidedAccountId!,
      operationId: "interaction_response_replay"
    };
    const completed = { ...approvalRequest, status: "completed" as const, version: 4 };
    const respond = vi.fn(async () => ({ request: completed, replayed: true })) as unknown as WorkspaceInteractionRequestService["respond"];
    const getActionTargetResult = vi.fn(async () => ({ artifact: { id: "artifact-saved" } }));
    const claimExecution = vi.fn() as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const executeActionTarget = vi.fn(async () => ({ target_result: { should_not_run: true } }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      respond,
      claimExecution,
      settleExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"],
      executeActionTarget,
      getActionTargetResult
    }));

    const result = await workflow.respondAndExecute(
      responseContext,
      {
        roomId: completed.roomId,
        requestId: completed.id,
        expectedVersion: 1,
        optionId: "approve"
      },
      () => { throw new Error("replayed response must not construct a Runtime"); }
    );

    expect(result.response.replayed).toBe(true);
    expect(result.execution).toEqual({ request: completed, targetResult: { artifact: { id: "artifact-saved" } } });
    expect(getActionTargetResult).toHaveBeenCalledWith(
      responseContext,
      completed.actionTarget,
      workspaceInteractionExecutionOperationId(completed.workspaceId, completed.id, "initial")
    );
    expect(claimExecution).not.toHaveBeenCalled();
    expect(executeActionTarget).not.toHaveBeenCalled();
  });

  it("recovers a stale claim from the durable target result without dispatching twice", async () => {
    const staleRequest = {
      ...approvalRequest,
      status: "executing" as const,
      version: 3,
      execution: {
        status: "executing" as const,
        startedAt: "2026-09-10T00:00:00.000Z",
        errorCode: undefined
      }
    };
    const recoveredRequest = { ...staleRequest, version: 4 };
    const claimExecution = vi.fn(async () => ({
      request: staleRequest,
      claim: {
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: "execution-before-stop",
        startedAt: "2026-09-10T00:00:00.000Z",
        leaseUntil: "2026-09-10T00:00:01.000Z",
        attempt: 1
      },
      executionTarget: { actionTarget: approvalRequest.actionTarget, surfaceId: approvalRequest.surfaceId },
      replayed: true
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const recoverExecution = vi.fn(async () => ({
      request: recoveredRequest,
      claim: {
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: "execution-recovered",
        startedAt: "2026-09-10T00:00:02.000Z",
        leaseUntil: "2099-09-10T00:05:00.000Z",
        attempt: 2
      },
      executionTarget: { actionTarget: approvalRequest.actionTarget, surfaceId: approvalRequest.surfaceId },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["recoverExecution"];
    const getActionTargetResult = vi.fn(async () => ({ artifact: { id: "artifact-recovered" } }));
    const settleExecution = vi.fn(async () => ({
      request: { ...recoveredRequest, status: "completed" as const, version: 5 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const executeActionTarget = vi.fn(async () => ({ target_result: { should_not_run: true } }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution,
      recoverExecution,
      settleExecution,
      executeActionTarget,
      getActionTargetResult
    }));

    const result = await workflow.executeAccepted(
      maintenanceContext,
      staleRequest,
      () => { throw new Error("stale result recovery must not construct a Runtime"); },
      "execution-before-stop"
    );

    expect(result).toMatchObject({
      request: { status: "completed", version: 5 },
      targetResult: { artifact: { id: "artifact-recovered" } }
    });
    expect(getActionTargetResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: "account_approver" }),
      approvalRequest.actionTarget,
      "execution-before-stop"
    );
    expect(getActionTargetResult).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountId: "account_approver" }),
      approvalRequest.actionTarget,
      "execution-before-stop"
    );
    expect(recoverExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: expect.stringContaining("interaction_execution_")
      })
    );
    expect(settleExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed", executionOperationId: "execution-recovered" })
    );
    expect(executeActionTarget).not.toHaveBeenCalled();
  });

  it("uses retained durable-result candidates after a recovery itself was interrupted", async () => {
    const staleRequest = { ...approvalRequest, status: "executing" as const, version: 4 };
    const claimExecution = vi.fn(async () => ({
      request: staleRequest,
      claim: {
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: "execution-recovery-one",
        startedAt: "2026-09-10T00:00:00.000Z",
        leaseUntil: "2026-09-10T00:00:01.000Z",
        attempt: 2
      },
      executionTarget: { actionTarget: approvalRequest.actionTarget },
      executionTargetResultLookup: {
        operationIds: ["execution-original", "execution-recovery-one"]
      },
      replayed: true
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const recoverExecution = vi.fn(async () => ({
      request: { ...staleRequest, version: 5 },
      claim: {
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: "execution-recovery-two",
        startedAt: "2026-09-10T00:00:02.000Z",
        leaseUntil: "2099-09-10T00:05:00.000Z",
        attempt: 3
      },
      executionTarget: { actionTarget: approvalRequest.actionTarget },
      executionTargetResultLookup: {
        operationIds: ["execution-original", "execution-recovery-one", "execution-recovery-two"]
      },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["recoverExecution"];
    const getActionTargetResult = vi.fn(async (
      _context: WorkspaceRequestContext,
      _target: unknown,
      operationId: string
    ) => operationId === "execution-original" ? { artifact: { id: "artifact-original" } } : undefined);
    const settleExecution = vi.fn(async () => ({
      request: { ...staleRequest, status: "completed" as const, version: 6 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const executeActionTarget = vi.fn(async () => ({ should_not_run: true }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution,
      recoverExecution,
      settleExecution,
      executeActionTarget,
      getActionTargetResult
    }));

    const result = await workflow.executeAccepted(
      maintenanceContext,
      staleRequest,
      () => { throw new Error("durable result recovery must not construct a Runtime"); },
      "execution-recovery-one"
    );

    expect(result).toMatchObject({
      request: { status: "completed", version: 6 },
      targetResult: { artifact: { id: "artifact-original" } }
    });
    expect(getActionTargetResult.mock.calls.map(([, , operationId]) => operationId)).toEqual([
      "execution-original",
      "execution-original"
    ]);
    expect(settleExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed", executionOperationId: "execution-recovery-two" })
    );
    expect(executeActionTarget).not.toHaveBeenCalled();
  });

  it("fails closed after a stale Generated Surface claim has no durable result", async () => {
    const staleRequest = { ...approvalRequest, status: "executing" as const, version: 3 };
    const claimExecution = vi.fn(async () => ({
      request: staleRequest,
      claim: {
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: "execution-without-result",
        startedAt: "2026-09-10T00:00:00.000Z",
        leaseUntil: "2026-09-10T00:00:01.000Z",
        attempt: 1
      },
      executionTarget: { actionTarget: approvalRequest.actionTarget },
      replayed: true
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const recoverExecution = vi.fn(async () => ({
      request: { ...staleRequest, version: 4 },
      claim: {
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: "execution-without-result-recovered",
        startedAt: "2026-09-10T00:00:02.000Z",
        leaseUntil: "2099-09-10T00:05:00.000Z",
        attempt: 2
      },
      executionTarget: { actionTarget: approvalRequest.actionTarget },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["recoverExecution"];
    const settleExecution = vi.fn(async () => ({
      request: { ...staleRequest, status: "failed" as const, version: 5 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const getActionTargetResult = vi.fn(async () => undefined);
    const executeActionTarget = vi.fn(async () => ({ should_not_run: true }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution,
      recoverExecution,
      settleExecution,
      executeActionTarget,
      getActionTargetResult
    }));

    const result = await workflow.executeAccepted(
      maintenanceContext,
      staleRequest,
      () => { throw new Error("stale no-result recovery must not dispatch"); },
      "execution-without-result"
    );

    expect(result.request.status).toBe("failed");
    expect(settleExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "failed",
        errorCode: "workspace_interaction_execution_interrupted"
      })
    );
    expect(executeActionTarget).not.toHaveBeenCalled();
  });

  it("terminalizes a stale replay when durable-result provenance reaches its safety limit", async () => {
    const staleRequest = { ...approvalRequest, status: "executing" as const, version: 3 };
    const claimExecution = vi.fn(async () => ({
      request: staleRequest,
      claim: {
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: "execution-provenance-limit-current",
        startedAt: "2026-09-10T00:00:00.000Z",
        leaseUntil: "2026-09-10T00:00:01.000Z",
        attempt: 32
      },
      executionTarget: { actionTarget: staleRequest.actionTarget },
      executionTargetResultLookup: {
        operationIds: Array.from({ length: 32 }, (_, index) => `execution-provenance-limit-${index}`)
      },
      replayed: true
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const recoverExecution = vi.fn(async () => {
      throw new WorkspaceServerError("workspace_interaction_execution_provenance_limit_exceeded", 409);
    }) as unknown as WorkspaceInteractionRequestService["recoverExecution"];
    const settleExecution = vi.fn(async () => ({
      request: { ...staleRequest, status: "failed" as const, version: 4 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const failStaleExecution = vi.fn(async () => ({
      request: { ...staleRequest, status: "failed" as const, version: 4 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["failStaleExecution"];
    const executeActionTarget = vi.fn(async () => ({ should_not_run: true }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution,
      recoverExecution,
      settleExecution,
      failStaleExecution,
      executeActionTarget,
      getActionTargetResult: vi.fn(async () => undefined)
    }));

    await expect(workflow.executeAccepted(
      maintenanceContext,
      staleRequest,
      () => { throw new Error("provenance-limit recovery must not construct a Runtime"); },
      "execution-provenance-limit-current"
    )).resolves.toMatchObject({ request: { status: "failed" } });

    expect(failStaleExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        errorCode: "workspace_interaction_execution_provenance_limit_exceeded",
        executionOperationId: "execution-provenance-limit-current"
      })
    );
    expect(settleExecution).not.toHaveBeenCalled();
    expect(executeActionTarget).not.toHaveBeenCalled();
  });

  it("records the original authorization refusal when exhausted stale provenance cannot be extended", async () => {
    const staleRequest = {
      ...approvalRequest,
      id: "interaction_authorization_provenance_limit",
      status: "executing" as const,
      version: 3
    };
    const authorizationError = new WorkspaceServerError("room_not_executable_or_access_denied", 403);
    const assertRoomExecutable = vi.fn(async (context: Pick<WorkspaceRequestContext, "accountId">) => {
      if (context.accountId === staleRequest.requestedAccountId) throw authorizationError;
    });
    const claimExecution = vi.fn(async () => ({
      request: staleRequest,
      claim: {
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: "execution-authorization-provenance-limit-current",
        startedAt: "2026-09-10T00:00:00.000Z",
        leaseUntil: "2026-09-10T00:00:01.000Z",
        attempt: 32
      },
      executionTarget: { actionTarget: staleRequest.actionTarget },
      executionTargetResultLookup: {
        operationIds: Array.from({ length: 32 }, (_, index) => `execution-authorization-provenance-limit-${index}`)
      },
      replayed: true
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const recoverExecution = vi.fn(async () => {
      throw new WorkspaceServerError("workspace_interaction_execution_provenance_limit_exceeded", 409);
    }) as unknown as WorkspaceInteractionRequestService["recoverExecution"];
    const failStaleExecution = vi.fn(async () => ({
      request: { ...staleRequest, status: "failed" as const, version: 4 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["failStaleExecution"];
    const settleExecution = vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const executeActionTarget = vi.fn(async () => ({ should_not_run: true }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      authorization: { assertRoomExecutable },
      claimExecution,
      recoverExecution,
      failStaleExecution,
      settleExecution,
      executeActionTarget
    }));

    await expect(workflow.executeAccepted(
      maintenanceContext,
      staleRequest,
      () => { throw new Error("authorization-denied recovery must not construct a Runtime"); },
      "execution-authorization-provenance-limit-current"
    )).resolves.toMatchObject({ request: { status: "failed" } });

    expect(failStaleExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        executionOperationId: "execution-authorization-provenance-limit-current",
        errorCode: "room_not_executable_or_access_denied"
      })
    );
    expect(settleExecution).not.toHaveBeenCalled();
    expect(executeActionTarget).not.toHaveBeenCalled();
  });

  it.each(["account_requester", "account_approver"] as const)(
    "terminalizes a stale replay when the saved %s is no longer authorized",
    async (revokedAccountId) => {
      const staleRequest: WorkspaceInteractionRequest = {
        ...approvalRequest,
        id: `interaction_stale_revoked_${revokedAccountId}`,
        status: "executing",
        version: 3
      };
      const assertRoomExecutable = vi.fn(async (context: Pick<WorkspaceRequestContext, "accountId">) => {
        if (context.accountId === revokedAccountId) {
          throw new WorkspaceServerError("room_not_executable_or_access_denied", 403);
        }
      });
      const claimExecution = vi.fn(async () => ({
        request: staleRequest,
        claim: {
          ownerId: "workspace-server-interaction-executor",
          executionOperationId: "execution-stale-revoked",
          startedAt: "2026-09-10T00:00:00.000Z",
          leaseUntil: "2026-09-10T00:00:01.000Z",
          attempt: 1
        },
        executionTarget: { actionTarget: staleRequest.actionTarget, surfaceId: staleRequest.surfaceId },
        replayed: true
      })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
      const recoverExecution = vi.fn(async () => ({
        request: { ...staleRequest, version: 4 },
        claim: {
          ownerId: "workspace-server-interaction-executor",
          executionOperationId: "execution-stale-revoked-recovered",
          startedAt: "2026-09-10T00:00:02.000Z",
          leaseUntil: "2099-09-10T00:05:00.000Z",
          attempt: 2
        },
        executionTarget: { actionTarget: staleRequest.actionTarget, surfaceId: staleRequest.surfaceId },
        replayed: false
      })) as unknown as WorkspaceInteractionRequestService["recoverExecution"];
      const settleExecution = vi.fn(async () => ({
        request: {
          ...staleRequest,
          status: "failed" as const,
          version: 5,
          execution: {
            status: "failed" as const,
            startedAt: "2026-09-10T00:00:00.000Z",
            errorCode: "room_not_executable_or_access_denied"
          }
        },
        replayed: false
      })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
      const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
        authorization: { assertRoomExecutable },
        claimExecution,
        recoverExecution,
        settleExecution,
        executeActionTarget: vi.fn(async () => ({ should_not_run: true })),
        getActionTargetResult: vi.fn(async () => ({ should_not_be_returned: true }))
      }));

      const result = await workflow.executeAccepted(
        maintenanceContext,
        staleRequest,
        () => { throw new Error("revoked stale actor must stop before target execution"); },
        "execution-stale-revoked"
      );

      expect(result.request.status).toBe("failed");
      expect(assertRoomExecutable.mock.calls.map(([context]) => context.accountId)).toEqual([
        "account_requester",
        "account_approver"
      ].slice(0, revokedAccountId === "account_requester" ? 1 : 2));
      expect(recoverExecution).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          ownerId: "workspace-server-interaction-executor",
          executionOperationId: expect.stringMatching(/^interaction_execution_/)
        })
      );
      expect(settleExecution).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "failed",
          errorCode: "room_not_executable_or_access_denied",
          executionOperationId: "execution-stale-revoked-recovered"
        })
      );
    }
  );

  it("preserves a completed replay when current re-authorization is denied", async () => {
    const completed = { ...approvalRequest, status: "completed" as const, version: 4 };
    const assertRoomExecutable = vi.fn(async () => {
      throw new WorkspaceServerError("room_not_executable_or_access_denied", 403);
    });
    const claimExecution = vi.fn(async () => ({
      request: completed,
      claim: {
        ownerId: "workspace-server-interaction-executor",
        executionOperationId: "execution-completed-replay",
        startedAt: "2026-09-10T00:00:00.000Z",
        leaseUntil: "2099-09-10T00:05:00.000Z",
        attempt: 1
      },
      executionTarget: { actionTarget: completed.actionTarget, surfaceId: completed.surfaceId },
      replayed: true
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const settleExecution = vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      authorization: { assertRoomExecutable },
      claimExecution,
      settleExecution,
      executeActionTarget: vi.fn(async () => ({ should_not_run: true }))
    }));

    await expect(workflow.executeAccepted(
      maintenanceContext,
      completed,
      () => { throw new Error("completed replay must not construct a Runtime"); },
      "execution-completed-replay"
    )).resolves.toEqual({ request: completed });
    expect(settleExecution).not.toHaveBeenCalled();
  });

  it("returns a recoverable error when a completed approval has lost its durable result", async () => {
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["claimExecution"],
      settleExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"],
      executeActionTarget: vi.fn(async () => ({ saved: true })),
      getActionTargetResult: vi.fn(async () => undefined)
    }));

    await expect(workflow.getCompletedGeneratedSurfaceActionResult(
      maintenanceContext,
      { ...approvalRequest, status: "completed" }
    )).rejects.toMatchObject({
      code: "workspace_interaction_target_result_unavailable",
      status: 503
    });
  });

  it("moves cancel authorization, transition, and best-effort notification into the workflow", async () => {
    const assertRoomExecutable = vi.fn(async () => undefined);
    const cancelled = { ...approvalRequest, status: "cancelled" as const, version: 2 };
    const cancel = vi.fn(async () => ({ request: cancelled, replayed: false })) as unknown as WorkspaceInteractionRequestService["cancel"];
    const onInteractionRequestChanged = vi.fn(async () => { throw new Error("event_projection_unavailable"); });
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      authorization: { assertRoomExecutable },
      cancel,
      claimExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["claimExecution"],
      settleExecution: vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"],
      executeActionTarget: vi.fn(async () => ({ saved: true })),
      notifications: { onInteractionRequestChanged }
    }));

    await expect(workflow.cancel(maintenanceContext, {
      roomId: approvalRequest.roomId,
      requestId: approvalRequest.id,
      expectedVersion: approvalRequest.version
    })).resolves.toEqual({ request: cancelled, replayed: false });

    expect(assertRoomExecutable).toHaveBeenCalledWith(maintenanceContext, approvalRequest.roomId);
    expect(cancel).toHaveBeenCalledWith(maintenanceContext, expect.objectContaining({ requestId: approvalRequest.id }));
    expect(onInteractionRequestChanged).toHaveBeenCalledWith(maintenanceContext, cancelled, "cancelled");
  });

  it.each(["account_requester", "account_approver"] as const)(
    "terminalizes an accepted recovery only when the explicitly checked actor (%s) is revoked",
    async (revokedAccountId) => {
      const request = { ...approvalRequest, id: `interaction_recovery_revoked_${revokedAccountId}` };
      const assertRoomExecutable = vi.fn(async (context: Pick<WorkspaceRequestContext, "accountId">) => {
        if (context.accountId === revokedAccountId) {
          throw new WorkspaceServerError("room_not_executable_or_access_denied", 403);
        }
      });
      const claimExecution = vi.fn(async () => ({
        request: claimedRequest(request),
        claim: { executionOperationId: "execution-revoked" },
        executionTarget: { actionTarget: request.actionTarget },
        replayed: false
      })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
      const settleExecution = vi.fn(async () => ({
        request: {
          ...claimedRequest(request),
          status: "failed" as const,
          version: 3,
          execution: {
            status: "failed" as const,
            startedAt: "2026-09-10T00:00:02.000Z",
            errorCode: "room_not_executable_or_access_denied"
          }
        },
        replayed: false
      })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
      const executeActionTarget = vi.fn(async () => ({ saved: true }));
      const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
        authorization: { assertRoomExecutable },
        claimExecution,
        settleExecution,
        executeActionTarget
      }));

      const result = await workflow.executeAccepted(
        maintenanceContext,
        request,
        () => { throw new Error("revoked actor must stop before the external action"); },
        `execution-revoked-${revokedAccountId}`
      );

      expect(result.request.status).toBe("failed");
      expect(executeActionTarget).not.toHaveBeenCalled();
      expect(settleExecution).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: maintenanceContext.accountId }),
        expect.objectContaining({ status: "failed", errorCode: "room_not_executable_or_access_denied" })
      );
    }
  );

  it("keeps an accepted request retryable when reauthorization has a transient database failure", async () => {
    let authorizationCalls = 0;
    const assertRoomExecutable = vi.fn(async () => {
      authorizationCalls += 1;
      if (authorizationCalls === 3) {
        const error = new Error("connection terminated") as Error & { code: string };
        error.code = "08006";
        throw error;
      }
    });
    const claimExecution = vi.fn(async () => ({
      request: claimedRequest(),
      claim: { executionOperationId: "execution-transient" },
      executionTarget: { actionTarget: approvalRequest.actionTarget },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const releaseExecutionClaim = vi.fn(async () => ({
      request: approvalRequest,
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["releaseExecutionClaim"];
    const settleExecution = vi.fn() as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const executeActionTarget = vi.fn(async () => ({ saved: true }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      authorization: { assertRoomExecutable },
      claimExecution,
      releaseExecutionClaim,
      settleExecution,
      executeActionTarget
    }));

    await expect(workflow.executeAccepted(
      maintenanceContext,
      approvalRequest,
      () => { throw new Error("transient authorization failure must stop before execution"); }
    )).rejects.toMatchObject({ code: "08006" });

    expect(authorizationCalls).toBe(3);
    expect(releaseExecutionClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ executionOperationId: "execution-transient" })
    );
    expect(settleExecution).not.toHaveBeenCalled();
    expect(executeActionTarget).not.toHaveBeenCalled();
  });

  it("uses the explicit system audit actor for recovery notifications while retaining maintenance authorization context", async () => {
    const claimExecution = vi.fn(async () => ({
      request: claimedRequest(),
      claim: { executionOperationId: "execution-audit" },
      executionTarget: { actionTarget: approvalRequest.actionTarget, surfaceId: approvalRequest.surfaceId },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const settleExecution = vi.fn(async () => ({
      request: { ...claimedRequest(), status: "completed" as const, version: 3 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const notifications = {
      onInteractionRequestChanged: vi.fn(async () => undefined),
      onGeneratedSurfaceChanged: vi.fn(async () => undefined)
    };
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      claimExecution,
      settleExecution,
      executeActionTarget: vi.fn(async () => ({ target_result: { saved: true } })),
      notifications
    }));

    await workflow.executeAccepted(
      maintenanceContext,
      approvalRequest,
      () => { throw new Error("approval action must not request a Runtime"); },
      "execution-audit"
    );

    expect(notifications.onInteractionRequestChanged).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: maintenanceContext.accountId }),
      expect.anything(),
      "executing",
      { actor: WORKSPACE_INTERACTION_RECOVERY_AUDIT_ACTOR, correlationId: "execution-audit" }
    );
    expect(notifications.onInteractionRequestChanged).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: maintenanceContext.accountId }),
      expect.anything(),
      "completed",
      { actor: WORKSPACE_INTERACTION_RECOVERY_AUDIT_ACTOR, correlationId: "execution-audit" }
    );
    expect(notifications.onGeneratedSurfaceChanged).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account_approver" }),
      expect.anything(),
      { actor: WORKSPACE_INTERACTION_RECOVERY_AUDIT_ACTOR, correlationId: "execution-audit" }
    );
  });
});
