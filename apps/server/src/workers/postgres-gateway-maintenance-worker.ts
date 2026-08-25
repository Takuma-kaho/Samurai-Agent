import { nowIso, type GatewayConcurrencyLockRecord, type GatewayPairingRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import { PostgresWorkspaceDatabase, type WorkspaceRequestContext } from "@samurai-agent/workspace-server";
import { PostgresGatewayAdapter } from "../adapters/runtime/postgres-gateway";
import { PostgresGatewayDomainOperations } from "../adapters/runtime/postgres-gateway-domain-operation";
import type { WorkspaceGatewayMaintenancePort } from "./workspace-worker-supervisor";

/**
 * Runs Gateway state maintenance from the standard Worker Supervisor.
 * Delivery transport is intentionally not fabricated here: pending replies
 * remain pending until the channel-specific delivery adapter claims them.
 * This lane only expires pairings/locks and recovers expired delivery leases.
 */
export class PostgresGatewayMaintenanceWorker implements WorkspaceGatewayMaintenancePort {
  constructor(private readonly database: PostgresWorkspaceDatabase) {}

  async runTick(
    context: WorkspaceRequestContext,
    input: { workerId: string; maxRuns: number; signal: AbortSignal }
  ): Promise<{ expired_pairings: number; expired_locks: number; reconciled_deliveries: number }> {
    void input.workerId;
    void input.maxRuns;
    if (input.signal.aborted) return { expired_pairings: 0, expired_locks: 0, reconciled_deliveries: 0 };
    const options = {
      database: this.database,
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      core: {
        ensureSession: async () => { throw new Error("gateway_worker_core_path_unavailable"); },
        runChat: async () => { throw new Error("gateway_worker_core_path_unavailable"); }
      },
      emit: async () => undefined
    } as const;
    const adapter = new PostgresGatewayAdapter(options);
    const operations = new PostgresGatewayDomainOperations(options);
    const now = nowIso();
    const operationContext: TrustedDomainContext = {
      inputSource: "scheduled_context",
      workspaceId: context.workspaceId,
      actorId: context.accountId,
      correlationId: context.operationId,
      idempotencyKey: `${context.operationId}:gateway-maintenance`
    };
    const expiredPairings = (await operations.execute(operationContext, "gateway.pairing.expire", { now })).value as GatewayPairingRecord[];
    if (input.signal.aborted) return { expired_pairings: expiredPairings.length, expired_locks: 0, reconciled_deliveries: 0 };
    const expiredLocks = ((await operations.execute({
      ...operationContext,
      idempotencyKey: `${context.operationId}:gateway-lock-maintenance`
    }, "gateway.concurrency_lock.expire", { now })).value as { expired_count: number; locks: GatewayConcurrencyLockRecord[] }).locks;
    if (input.signal.aborted) return { expired_pairings: expiredPairings.length, expired_locks: expiredLocks.length, reconciled_deliveries: 0 };
    // Delivery lease reconciliation is storage recovery, not a user-facing
    // Domain Operation. It has no transport-side effect and remains scoped to
    // this Worker-owned RLS context.
    const reconciledDeliveries = await adapter.reconcileExpiredDeliveries(now);
    return {
      expired_pairings: expiredPairings.length,
      expired_locks: expiredLocks.length,
      reconciled_deliveries: reconciledDeliveries.length
    };
  }
}
