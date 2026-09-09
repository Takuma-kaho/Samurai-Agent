import { describe, expect, it, vi } from "vitest";
import type {
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
});
