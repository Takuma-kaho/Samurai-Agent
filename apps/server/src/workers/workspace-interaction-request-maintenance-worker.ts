import {
  WorkspaceInteractionRequestService,
  type WorkspaceInteractionRequestMaintenanceResult,
  type WorkspaceRequestContext,
  type WorkspaceServerStore
} from "@samurai-agent/workspace-server";
import type { WorkspaceInteractionRequestMaintenanceWorkerPort } from "./workspace-worker-supervisor";

export interface WorkspaceInteractionRequestMaintenanceWorkerOptions {
  store: Pick<WorkspaceServerStore, "listRooms">;
  interactionRequests: WorkspaceInteractionRequestService;
  /**
   * Appends the public Event before the request's durable outbox marker is
   * acknowledged. The callback may be retried with the same operation ID.
   */
  onReconciled(context: WorkspaceRequestContext, result: WorkspaceInteractionRequestMaintenanceResult): Promise<void>;
}

/**
 * Reconciles durable interaction requests independently from HTTP handlers.
 *
 * This lane never replays a stale external action. A request that remained
 * `executing` after its lease is terminally recorded as interrupted, because
 * the Server cannot prove whether the prior process already caused a side
 * effect. A human or Agent must explicitly create a new request to try again.
 */
export class WorkspaceInteractionRequestMaintenanceWorker implements WorkspaceInteractionRequestMaintenanceWorkerPort {
  constructor(private readonly options: WorkspaceInteractionRequestMaintenanceWorkerOptions) {}

  async runTick(
    context: WorkspaceRequestContext,
    input: { workerId: string; maxRuns: number; signal: AbortSignal }
  ): Promise<{ reconciled: number; delivered: number }> {
    void input.workerId;
    if (input.signal.aborted) return { reconciled: 0, delivered: 0 };

    let remaining = Math.max(1, Math.min(Math.trunc(input.maxRuns), 1_000));
    let reconciled = 0;
    let delivered = 0;
    const rooms = await this.options.store.listRooms(context);

    for (const room of rooms) {
      if (input.signal.aborted || remaining <= 0) break;
      const results = await this.options.interactionRequests.reconcileRoom(context, {
        roomId: room.id,
        limit: remaining
      });
      reconciled += results.length;

      for (const result of results) {
        if (input.signal.aborted || remaining <= 0) break;
        await this.options.onReconciled(context, result);
        await this.options.interactionRequests.markMaintenanceEventDelivered(
          { ...context, operationId: result.deliveryOperationId },
          {
            roomId: result.request.roomId,
            requestId: result.request.id,
            expectedVersion: result.request.version,
            eventOperationId: result.eventOperationId
          }
        );
        delivered += 1;
        remaining -= 1;
      }
    }

    return { reconciled, delivered };
  }
}
