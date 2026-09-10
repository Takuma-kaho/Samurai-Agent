import { describe, expect, it, vi } from "vitest";
import type {
  WorkspaceInteractionRequestAcceptedRecovery,
  WorkspaceInteractionRequestMaintenanceResult,
  WorkspaceInteractionRequestService,
  WorkspaceRequestContext,
  WorkspaceServerStore
} from "@samurai-agent/workspace-server";
import { WorkspaceInteractionRequestMaintenanceWorker } from "./workspace-interaction-request-maintenance-worker";

const context: WorkspaceRequestContext = {
  workspaceId: "workspace_maintenance",
  accountId: "account_maintenance",
  operationId: "maintenance_tick"
};

function maintenanceResult(): WorkspaceInteractionRequestMaintenanceResult {
  return {
    request: {
      id: "interaction_maintenance",
      workspaceId: context.workspaceId,
      roomId: "room_maintenance",
      version: 4,
      kind: "approval",
      status: "failed",
      title: "Approval interrupted",
      summary: "The Server stopped before completion could be verified.",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface_maintenance", action_id: "publish" },
      options: [],
      requestedAccountId: context.accountId,
      expiresAt: "2026-09-08T00:10:00.000Z",
      execution: {
        status: "failed",
        startedAt: "2026-09-08T00:00:00.000Z",
        errorCode: "workspace_interaction_execution_interrupted"
      },
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:02.000Z"
    },
    action: "failed",
    eventOperationId: "interaction_maintenance_event",
    deliveryOperationId: "interaction_delivery_event"
  };
}

describe("WorkspaceInteractionRequestMaintenanceWorker", () => {
  it("delivers a stable public Event before acknowledging its durable outbox marker", async () => {
    const result = maintenanceResult();
    const reconciliation = vi.fn(async () => [result]);
    const delivery = vi.fn(async () => undefined);
    const onReconciled = vi.fn(async () => undefined);
    const worker = new WorkspaceInteractionRequestMaintenanceWorker({
      store: { listRooms: vi.fn(async () => [{ id: result.request.roomId }]) } as unknown as Pick<WorkspaceServerStore, "listRooms">,
      interactionRequests: {
        reconcileRoom: reconciliation,
        markMaintenanceEventDelivered: delivery
      } as unknown as WorkspaceInteractionRequestService,
      onReconciled
    });

    await expect(worker.runTick(context, {
      workerId: "workspace_worker_test",
      maxRuns: 10,
      signal: new AbortController().signal
    })).resolves.toEqual({ reconciled: 1, delivered: 1 });

    expect(reconciliation).toHaveBeenCalledWith(context, { roomId: result.request.roomId, limit: 10 });
    expect(onReconciled).toHaveBeenCalledWith(context, result);
    expect(delivery).toHaveBeenCalledWith(
      { ...context, operationId: result.deliveryOperationId },
      {
        roomId: result.request.roomId,
        requestId: result.request.id,
        expectedVersion: result.request.version,
        eventOperationId: result.eventOperationId
      }
    );
    expect(onReconciled.mock.invocationCallOrder[0]).toBeLessThan(delivery.mock.invocationCallOrder[0]!);
  });

  it("keeps the outbox marker pending when durable Event delivery fails", async () => {
    const result = maintenanceResult();
    const delivery = vi.fn(async () => undefined);
    const worker = new WorkspaceInteractionRequestMaintenanceWorker({
      store: { listRooms: vi.fn(async () => [{ id: result.request.roomId }]) } as unknown as Pick<WorkspaceServerStore, "listRooms">,
      interactionRequests: {
        reconcileRoom: vi.fn(async () => [result]),
        markMaintenanceEventDelivered: delivery
      } as unknown as WorkspaceInteractionRequestService,
      onReconciled: async () => { throw new Error("event_store_unavailable"); }
    });

    await expect(worker.runTick(context, {
      workerId: "workspace_worker_test",
      maxRuns: 10,
      signal: new AbortController().signal
    })).rejects.toThrow("event_store_unavailable");
    expect(delivery).not.toHaveBeenCalled();
  });

  it("passes an accepted unclaimed request to the existing claim/execution path once", async () => {
    const candidate: WorkspaceInteractionRequestAcceptedRecovery = {
      request: {
        id: "interaction_accepted_recovery",
        workspaceId: context.workspaceId,
        roomId: "room_accepted_recovery",
        version: 2,
        kind: "approval",
        status: "accepted",
        title: "Approval accepted",
        summary: "Recover this request.",
        surfaceId: "surface_accepted_recovery",
        revisionId: "revision_accepted_recovery",
        actionTarget: { kind: "generated_surface_action", surface_id: "surface_accepted_recovery", action_id: "publish" },
        options: [{ id: "approve", label: "Allow", decision: "approve" }],
        requestedAccountId: context.accountId,
        decidedAccountId: context.accountId,
        expiresAt: "2026-09-08T00:10:00.000Z",
        outcome: { kind: "response", optionId: "approve", decision: "approve", decidedAt: "2026-09-08T00:00:01.000Z" },
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:01.000Z"
      },
      executionOperationId: "interaction_execution_accepted_recovery"
    };
    const acceptedRecovery = vi.fn(async () => undefined);
    const worker = new WorkspaceInteractionRequestMaintenanceWorker({
      store: { listRooms: vi.fn(async () => [{ id: candidate.request.roomId }]) } as unknown as Pick<WorkspaceServerStore, "listRooms">,
      interactionRequests: {
        reconcileRoom: vi.fn(async () => []),
        listAcceptedForRecovery: vi.fn(async () => [candidate]),
        markMaintenanceEventDelivered: vi.fn(async () => undefined)
      } as unknown as WorkspaceInteractionRequestService,
      onReconciled: vi.fn(async () => undefined),
      recoverAcceptedInteraction: acceptedRecovery
    });

    await expect(worker.runTick(context, {
      workerId: "workspace_worker_test",
      maxRuns: 10,
      signal: new AbortController().signal
    })).resolves.toEqual({ reconciled: 1, delivered: 0 });
    expect(acceptedRecovery).toHaveBeenCalledWith(context, candidate);
  });

  it("passes a stale Generated Surface claim to result-aware recovery instead of emitting a blind failure", async () => {
    const candidate: WorkspaceInteractionRequestAcceptedRecovery = {
      request: {
        id: "interaction_stale_surface_recovery",
        workspaceId: context.workspaceId,
        roomId: "room_stale_surface_recovery",
        version: 4,
        kind: "approval",
        status: "executing",
        title: "Approval accepted",
        summary: "Recover this request.",
        surfaceId: "surface_stale_surface_recovery",
        revisionId: "revision_stale_surface_recovery",
        actionTarget: {
          kind: "generated_surface_action",
          room_id: "room_stale_surface_recovery",
          surface_id: "surface_stale_surface_recovery",
          revision_id: "revision_stale_surface_recovery",
          action_id: "publish",
          command_id: "artifact.create",
          payload: {}
        },
        options: [{ id: "approve", label: "Allow", decision: "approve" }],
        requestedAccountId: context.accountId,
        decidedAccountId: context.accountId,
        expiresAt: "2026-09-08T00:10:00.000Z",
        outcome: { kind: "response", optionId: "approve", decision: "approve", decidedAt: "2026-09-08T00:00:01.000Z" },
        execution: { status: "executing", startedAt: "2026-09-08T00:00:02.000Z" },
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:03.000Z"
      },
      executionOperationId: "execution_stale_surface_recovery"
    };
    const acceptedRecovery = vi.fn(async () => undefined);
    const worker = new WorkspaceInteractionRequestMaintenanceWorker({
      store: { listRooms: vi.fn(async () => [{ id: candidate.request.roomId }]) } as unknown as Pick<WorkspaceServerStore, "listRooms">,
      interactionRequests: {
        reconcileRoom: vi.fn(async () => []),
        listAcceptedForRecovery: vi.fn(async () => [candidate]),
        markMaintenanceEventDelivered: vi.fn(async () => undefined)
      } as unknown as WorkspaceInteractionRequestService,
      onReconciled: vi.fn(async () => undefined),
      recoverAcceptedInteraction: acceptedRecovery
    });

    await expect(worker.runTick(context, {
      workerId: "workspace_worker_test",
      maxRuns: 10,
      signal: new AbortController().signal
    })).resolves.toEqual({ reconciled: 1, delivered: 0 });
    expect(acceptedRecovery).toHaveBeenCalledWith(context, candidate);
  });
});
