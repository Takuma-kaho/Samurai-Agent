import {
  WorkspaceServerError,
  type WorkspaceRequestContext,
  type WorkspaceShareService
} from "@samurai-agent/workspace-server";
import {
  PostgresWorkspaceShareImportWorker,
  type WorkspaceShareImportClaim,
  type WorkspaceShareImportCorePort,
  type WorkspaceShareImportExecutionResult,
  type WorkspaceShareImportWorkerOptions
} from "../workers/postgres-workspace-share-import-worker";

/**
 * Adapter between the process-owned Share import worker and Share Core.
 *
 * The supervisor context is a maintenance identity and is used only to claim
 * a due row.  Once a row is claimed, every target check, lease heartbeat,
 * file operation, and settlement is performed with the recipient persisted
 * on that row.  A delegation is intentionally absent from this contract;
 * Share Core keeps the verified, short-lived capability in process memory.
 */
export type WorkspaceShareImportServicePort = Pick<
  WorkspaceShareService,
  | "claimNextImport"
  | "recheckImportTarget"
  | "executeImportLease"
  | "heartbeatImport"
  | "settleImportWorker"
>;

export class PostgresWorkspaceShareImportCoreAdapter implements WorkspaceShareImportCorePort {
  constructor(private readonly service: WorkspaceShareImportServicePort) {}

  async claim(input: Parameters<WorkspaceShareImportCorePort["claim"]>[0]): Promise<WorkspaceShareImportClaim | null> {
    const claimContext = requestContext(input.context);
    const claimed = await this.service.claimNextImport(claimContext, {
      workerId: input.workerId,
      leaseMs: input.leaseMs,
      now: new Date(input.now),
      ...(input.excludeOperationIds ? { excludeOperationIds: input.excludeOperationIds } : {})
    });
    if (!claimed) return null;
    const lease = claimed.lease;
    return {
      importId: lease.operation_id,
      operationId: lease.operation_id,
      workspaceId: input.context.workspaceId,
      recipientAccountId: claimed.recipientAccountId,
      kind: lease.kind,
      targetRoomId: lease.target_room_id,
      leaseToken: lease.lease_token
    };
  }

  async recheckTarget(input: Parameters<WorkspaceShareImportCorePort["recheckTarget"]>[0]): Promise<{ allowed: true } | { allowed: false; failureCode?: string }> {
    try {
      await this.service.recheckImportTarget(recipientContext(input.claim), input.claim.operationId);
      return { allowed: true };
    } catch (error) {
      if (isTargetAuthorizationFailure(error)) {
        return { allowed: false, failureCode: errorCode(error, "workspace_share_import_target_authorization_lost") };
      }
      throw error;
    }
  }

  async execute(input: Parameters<WorkspaceShareImportCorePort["execute"]>[0]): Promise<WorkspaceShareImportExecutionResult> {
    try {
      await this.service.executeImportLease(
        recipientContext(input.claim),
        { operation_id: input.claim.operationId, lease_token: input.claim.leaseToken },
        input.heartbeat
      );
      return { status: "committed" };
    } catch (error) {
      const code = errorCode(error, "workspace_share_import_worker_failed");
      if (isRetryableImportFailure(error)) return { status: "retryable", failureCode: code };
      if (error instanceof WorkspaceServerError && error.code === "workspace_share_import_lease_conflict") throw error;
      return { status: "failed", failureCode: code };
    }
  }

  async heartbeat(input: Parameters<WorkspaceShareImportCorePort["heartbeat"]>[0]): Promise<boolean> {
    try {
      await this.service.heartbeatImport(
        recipientContext(input.claim),
        { operation_id: input.claim.operationId, lease_token: input.claim.leaseToken }
      );
      return true;
    } catch {
      // The worker must not settle after an uncertain heartbeat.  Returning
      // false makes it abandon the claim and lets the durable lease recover.
      return false;
    }
  }

  async settle(input: Parameters<WorkspaceShareImportCorePort["settle"]>[0]): Promise<void> {
    await this.service.settleImportWorker(
      recipientContext(input.claim),
      {
        operation_id: input.claim.operationId,
        lease_token: input.claim.leaseToken,
        result: input.result
      }
    );
  }

  async close(): Promise<void> {
    // Share Core owns the database/file ports. There is no process-local
    // resource in this adapter that needs an independent close operation.
  }
}

export interface PostgresWorkspaceShareImportWorkerFactoryOptions extends Omit<WorkspaceShareImportWorkerOptions, "core"> {
  service: WorkspaceShareImportServicePort;
}

export function createPostgresWorkspaceShareImportWorker(
  options: PostgresWorkspaceShareImportWorkerFactoryOptions
): PostgresWorkspaceShareImportWorker {
  return new PostgresWorkspaceShareImportWorker({
    ...options,
    core: new PostgresWorkspaceShareImportCoreAdapter(options.service),
    leaseMs: options.leaseMs ?? 30_000,
    heartbeatMs: options.heartbeatMs ?? 10_000
  });
}

function requestContext(context: Parameters<WorkspaceShareImportCorePort["claim"]>[0]["context"]): WorkspaceRequestContext {
  return {
    workspaceId: context.workspaceId,
    accountId: context.accountId,
    operationId: context.operationId
  };
}

function recipientContext(claim: WorkspaceShareImportClaim): WorkspaceRequestContext {
  return {
    workspaceId: claim.workspaceId,
    accountId: claim.recipientAccountId,
    operationId: claim.operationId
  };
}

function errorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : fallback;
  return /^[a-z0-9][a-z0-9_.:-]{0,159}$/.test(code) ? code : fallback;
}

function isTargetAuthorizationFailure(error: unknown): boolean {
  return error instanceof WorkspaceServerError
    && ["workspace_share_import_target_forbidden", "workspace_share_permission_denied", "workspace_share_import_not_found"].includes(error.code);
}

function isRetryableImportFailure(error: unknown): boolean {
  if (error instanceof WorkspaceServerError) {
    if (error.code === "authorization_refresh_required") return true;
    if (["workspace_share_transport_failed", "workspace_share_transport_timeout", "workspace_share_transport_unavailable", "workspace_share_import_transport_missing", "workspace_share_file_io_failed"].includes(error.code)) return true;
    return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  return error instanceof Error && /(?:timeout|temporar|unavailable|unreachable|transport|network|capability)/i.test(error.message);
}

export type WorkspaceShareImportWorker = PostgresWorkspaceShareImportWorker;
