import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceServerError,
  type WorkspaceInteractionRequest,
  type WorkspaceInteractionRequestService,
  type WorkspaceRequestContext
} from "@samurai-agent/workspace-server";

// The workflow tests do not exercise renderer/runtime construction. Keep the
// unit test isolated from the unrelated UI protocol dependency graph.
vi.mock("@samurai-agent/runtime", () => ({
  generatedSurfaceCsp: "",
  safeGeneratedSurfaceAssetPath: () => ""
}));
vi.mock("@samurai-agent/ui-protocol", () => ({
  parseSurfaceOperation: () => undefined
}));

import {
  WorkspaceInteractionRequestWorkflowService,
  type AcceptedInteractionExecutionDependencies
} from "./domain-api-v1";

const acceptedRequest: WorkspaceInteractionRequest = {
  id: "interaction_approved_action",
  workspaceId: "workspace_interaction_workflow",
  roomId: "room_interaction_workflow",
  version: 1,
  kind: "approval",
  status: "accepted",
  title: "Approve action",
  summary: "Run the saved action target.",
  surfaceId: "surface_interaction_workflow",
  revisionId: "revision_interaction_workflow",
  actionTarget: {
    kind: "generated_surface_action",
    room_id: "room_interaction_workflow",
    surface_id: "surface_interaction_workflow",
    revision_id: "revision_interaction_workflow",
    action_id: "approve",
    command_id: "artifact.create",
    payload: {}
  },
  options: [{ id: "approve", label: "Approve", decision: "approve" }],
  requestedAccountId: "account_requester",
  decidedAccountId: "account_approver",
  expiresAt: "2026-09-10T01:00:00.000Z",
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
  workspaceId: acceptedRequest.workspaceId,
  accountId: "account_maintenance",
  operationId: "interaction_recovery_tick"
};

function workflowDependencies(input: {
  assertRoomExecutable: (context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string) => Promise<void>;
  respond?: WorkspaceInteractionRequestService["respond"];
  claimExecution: WorkspaceInteractionRequestService["claimExecution"];
  assertExecutionClaim?: WorkspaceInteractionRequestService["assertExecutionClaim"];
  settleExecution: WorkspaceInteractionRequestService["settleExecution"];
  executeActionTarget: (context: WorkspaceRequestContext, target: unknown) => Promise<Record<string, unknown>>;
  notifications?: AcceptedInteractionExecutionDependencies["notifications"];
}): AcceptedInteractionExecutionDependencies {
  return {
    authorization: {
      assertRoomExecutable: input.assertRoomExecutable
    },
    interactionRequests: {
      respond: input.respond ?? (vi.fn(async () => { throw new Error("respond_not_configured"); }) as unknown as WorkspaceInteractionRequestService["respond"]),
      claimExecution: input.claimExecution,
      assertExecutionClaim: input.assertExecutionClaim ?? (vi.fn(async () => acceptedRequest) as unknown as WorkspaceInteractionRequestService["assertExecutionClaim"]),
      settleExecution: input.settleExecution
    } as unknown as WorkspaceInteractionRequestService,
    generatedSurfaces: {
      executeActionTarget: input.executeActionTarget,
      getActionTargetResult: vi.fn(async () => undefined)
    } as never,
    ...(input.notifications ? { notifications: input.notifications } : {})
  };
}

function claimedRequest(): WorkspaceInteractionRequest {
  return { ...acceptedRequest, status: "executing", version: 2 };
}

describe("WorkspaceInteractionRequestWorkflowService", () => {
  it("runs response, reauthorization, execution, and settlement in one service", async () => {
    const responseContext: WorkspaceRequestContext = {
      workspaceId: acceptedRequest.workspaceId,
      accountId: acceptedRequest.decidedAccountId!,
      operationId: "interaction_response"
    };
    const responseAccepted = { ...acceptedRequest, version: 2 };
    const assertRoomExecutable = vi.fn(async () => undefined);
    const respond = vi.fn(async () => ({ request: responseAccepted, replayed: false })) as unknown as WorkspaceInteractionRequestService["respond"];
    const claimExecution = vi.fn(async (_context: WorkspaceRequestContext, input: { executionOperationId: string }) => ({
      request: claimedRequest(),
      claim: { executionOperationId: input.executionOperationId },
      executionTarget: { actionTarget: acceptedRequest.actionTarget },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const settleExecution = vi.fn(async () => ({
      request: { ...claimedRequest(), status: "completed", version: 3 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const executeActionTarget = vi.fn(async (context: WorkspaceRequestContext) => {
      expect(context.accountId).toBe("account_approver");
      return { target_result: { saved: true } };
    });
    const actions: string[] = [];
    const notifications = {
      onInteractionRequestChanged: vi.fn(async (_context: WorkspaceRequestContext, _request: WorkspaceInteractionRequest, action: string) => {
        actions.push(action);
      })
    };
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      assertRoomExecutable,
      respond,
      claimExecution,
      settleExecution,
      executeActionTarget,
      notifications
    }));

    const result = await workflow.respondAndExecute(responseContext, {
      roomId: acceptedRequest.roomId,
      requestId: acceptedRequest.id,
      expectedVersion: 1,
      optionId: "approve"
    }, () => { throw new Error("approval action must not request a Runtime"); });

    expect(result.response.replayed).toBe(false);
    expect(result.execution?.request.status).toBe("completed");
    expect(result.execution?.rawResult).toEqual({ target_result: { saved: true } });
    expect(respond).toHaveBeenCalledWith(responseContext, expect.objectContaining({ optionId: "approve" }));
    expect(actions).toEqual(["responded", "executing", "completed"]);
  });

  it("re-authorizes both saved actors and executes only with the approver context", async () => {
    const order: string[] = [];
    const assertRoomExecutable = vi.fn(async (context: Pick<WorkspaceRequestContext, "accountId">) => {
      order.push(`authorize:${context.accountId}`);
    });
    const claimExecution = vi.fn(async (_context: WorkspaceRequestContext, input: { executionOperationId: string }) => {
      order.push("claim");
      return {
        request: claimedRequest(),
        claim: { executionOperationId: input.executionOperationId },
        executionTarget: { actionTarget: acceptedRequest.actionTarget },
        replayed: false
      };
    }) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const settleExecution = vi.fn(async () => ({
      request: { ...claimedRequest(), status: "completed", version: 3 },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const executeActionTarget = vi.fn(async (context: WorkspaceRequestContext) => {
      expect(context.accountId).toBe("account_approver");
      order.push("execute");
      return { target_result: { saved: true } };
    });
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      assertRoomExecutable,
      claimExecution,
      settleExecution,
      executeActionTarget
    }));

    const result = await workflow.executeAccepted(
      maintenanceContext,
      acceptedRequest,
      () => { throw new Error("approval action must not request a Runtime"); }
    );

    expect(result.request.status).toBe("completed");
    expect(assertRoomExecutable.mock.calls.map(([context]) => context.accountId)).toEqual([
      "account_requester",
      "account_approver",
      "account_requester",
      "account_approver"
    ]);
    expect(order.slice(0, 5)).toEqual([
      "authorize:account_requester",
      "authorize:account_approver",
      "claim",
      "authorize:account_requester",
      "authorize:account_approver"
    ]);
    expect(executeActionTarget).toHaveBeenCalledOnce();
    expect(settleExecution).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account_maintenance" }),
      expect.objectContaining({ status: "completed" })
    );
  });

  it("settles a revoked requester as failed without dispatching the approved action", async () => {
    const assertRoomExecutable = vi.fn(async (context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">) => {
      if (context.accountId === acceptedRequest.requestedAccountId) {
        throw new WorkspaceServerError("room_not_executable_or_access_denied", 403);
      }
    });
    const claimExecution = vi.fn(async (_context: WorkspaceRequestContext, input: { executionOperationId: string }) => ({
      request: claimedRequest(),
      claim: { executionOperationId: input.executionOperationId },
      executionTarget: { actionTarget: acceptedRequest.actionTarget },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["claimExecution"];
    const settleExecution = vi.fn(async () => ({
      request: {
        ...claimedRequest(),
        status: "failed",
        version: 3,
        execution: {
          status: "failed",
          startedAt: "2026-09-10T00:00:02.000Z",
          errorCode: "room_not_executable_or_access_denied"
        }
      },
      replayed: false
    })) as unknown as WorkspaceInteractionRequestService["settleExecution"];
    const executeActionTarget = vi.fn(async () => ({ target_result: { saved: true } }));
    const workflow = new WorkspaceInteractionRequestWorkflowService(workflowDependencies({
      assertRoomExecutable,
      claimExecution,
      settleExecution,
      executeActionTarget
    }));

    const result = await workflow.executeAccepted(
      maintenanceContext,
      acceptedRequest,
      () => { throw new Error("revoked requester must stop before Runtime"); }
    );

    expect(result.request.status).toBe("failed");
    expect(assertRoomExecutable).toHaveBeenCalledOnce();
    expect(executeActionTarget).not.toHaveBeenCalled();
    expect(settleExecution).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account_maintenance" }),
      expect.objectContaining({ status: "failed", errorCode: "room_not_executable_or_access_denied" })
    );
  });
});
