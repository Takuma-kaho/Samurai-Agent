import { describe, expect, it, vi } from "vitest";
import {
  PostgresWorkspaceShareImportWorker,
  WorkspaceShareImportWorkerFailure,
  type WorkspaceShareImportClaim,
  type WorkspaceShareImportCorePort
} from "./postgres-workspace-share-import-worker";

const context = {
  workspaceId: "workspace_one",
  accountId: "maintenance_one",
  operationId: "workspace_worker_tick_one"
};

function claim(overrides: Partial<WorkspaceShareImportClaim> = {}): WorkspaceShareImportClaim {
  return {
    importId: "import_one",
    operationId: "operation_one",
    workspaceId: context.workspaceId,
    recipientAccountId: "recipient_one",
    kind: "room_knowledge",
    targetRoomId: "room_one",
    leaseToken: "lease_one",
    ...overrides
  };
}

function makeCore(overrides: Partial<WorkspaceShareImportCorePort> = {}): WorkspaceShareImportCorePort {
  return {
    claim: vi.fn(async () => null),
    recheckTarget: vi.fn(async () => ({ allowed: true as const })),
    execute: vi.fn(async () => ({ status: "committed" as const })),
    heartbeat: vi.fn(async () => true),
    settle: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("PostgresWorkspaceShareImportWorker", () => {
  it("claims, rechecks the persisted target, executes, and settles without carrying delegation data", async () => {
    const imported = claim();
    const core = makeCore({
      claim: vi.fn()
        .mockResolvedValueOnce(imported)
        .mockResolvedValueOnce(null)
    });
    const worker = new PostgresWorkspaceShareImportWorker({
      core,
      now: () => new Date("2026-09-17T00:00:00.000Z")
    });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 10, signal: new AbortController().signal });

    expect(result).toMatchObject({ claimed: 1, completed: 1, retried: 0, failed: 0, leaseLost: 0 });
    expect(core.claim).toHaveBeenCalledWith(expect.objectContaining({
      context,
      workerId: "worker_one:share-import",
      leaseMs: 30_000,
      now: "2026-09-17T00:00:00.000Z",
      signal: expect.any(AbortSignal)
    }));
    expect(core.recheckTarget).toHaveBeenCalledWith({ claim: imported, signal: expect.any(AbortSignal) });
    expect(core.execute).toHaveBeenCalledWith({
      claim: imported,
      signal: expect.any(AbortSignal),
      heartbeat: expect.any(Function)
    });
    const executeInput = vi.mocked(core.execute).mock.calls[0]?.[0];
    expect(executeInput).not.toHaveProperty("delegation");
    expect(core.settle).toHaveBeenCalledWith({
      claim: imported,
      result: { status: "committed" },
      now: "2026-09-17T00:00:00.000Z"
    });
  });

  it("does not fetch or commit after current target authorization is revoked", async () => {
    const imported = claim();
    const core = makeCore({
      claim: vi.fn()
        .mockResolvedValueOnce(imported)
        .mockResolvedValueOnce(null),
      recheckTarget: vi.fn(async () => ({ allowed: false as const, failureCode: "workspace_share_import_target_authorization_lost" }))
    });
    const worker = new PostgresWorkspaceShareImportWorker({ core });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(core.execute).not.toHaveBeenCalled();
    expect(core.settle).toHaveBeenCalledWith(expect.objectContaining({
      claim: imported,
      result: { status: "failed", failureCode: "workspace_share_import_target_authorization_lost" }
    }));
  });

  it("settles transport/capability failures as retryable and never reports them as committed", async () => {
    const imported = claim({ operationId: "operation_retry" });
    const core = makeCore({
      claim: vi.fn()
        .mockResolvedValueOnce(imported)
        .mockResolvedValueOnce(null),
      execute: vi.fn(async () => {
        throw new WorkspaceShareImportWorkerFailure("workspace_share_import_worker_capability_unavailable", true);
      })
    });
    const worker = new PostgresWorkspaceShareImportWorker({ core });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(result).toMatchObject({ claimed: 1, completed: 0, retried: 1, failed: 0 });
    expect(core.settle).toHaveBeenCalledWith({
      claim: imported,
      result: { status: "retryable", failureCode: "workspace_share_import_worker_capability_unavailable" },
      now: expect.any(String)
    });
  });

  it("does not reclaim a retryable operation in the same tick and starts the 2 second backoff", async () => {
    const imported = claim({ operationId: "operation_backoff" });
    const core = makeCore({
      claim: vi.fn()
        .mockResolvedValueOnce(imported)
        .mockResolvedValueOnce(null),
      execute: vi.fn(async () => ({ status: "retryable" as const, failureCode: "workspace_share_transport_failed" }))
    });
    const worker = new PostgresWorkspaceShareImportWorker({
      core,
      now: () => new Date("2026-09-17T00:00:00.000Z")
    });

    await worker.runTick(context, { workerId: "worker_one", maxRuns: 2, signal: new AbortController().signal });

    expect(core.claim).toHaveBeenNthCalledWith(2, expect.objectContaining({
      excludeOperationIds: ["operation_backoff"]
    }));
  });

  it("stops automatic retries after the 2/5/15 second schedule", async () => {
    const imported = claim({ operationId: "operation_exhausted" });
    const core = makeCore({
      claim: vi.fn()
        .mockResolvedValueOnce(imported)
        .mockResolvedValueOnce(imported)
        .mockResolvedValueOnce(imported)
        .mockResolvedValueOnce(null),
      execute: vi.fn(async () => ({ status: "retryable" as const, failureCode: "workspace_share_transport_failed" }))
    });
    const worker = new PostgresWorkspaceShareImportWorker({ core, now: () => new Date("2026-09-17T00:00:00.000Z") });

    await worker.runTick(context, { workerId: "worker_one", maxRuns: 4, signal: new AbortController().signal });

    expect(core.settle).toHaveBeenNthCalledWith(3, expect.objectContaining({
      result: { status: "retryable", failureCode: "workspace_share_import_retry_exhausted" }
    }));
  });

  it("keeps manifest and hash validation failures terminal", async () => {
    const imported = claim({ operationId: "operation_invalid_manifest" });
    const core = makeCore({
      claim: vi.fn()
        .mockResolvedValueOnce(imported)
        .mockResolvedValueOnce(null),
      execute: vi.fn(async () => ({ status: "failed" as const, failureCode: "workspace_share_manifest_kind_mismatch" }))
    });
    const worker = new PostgresWorkspaceShareImportWorker({ core });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(result).toMatchObject({ claimed: 1, completed: 0, retried: 0, failed: 1 });
    expect(core.settle).toHaveBeenCalledWith(expect.objectContaining({
      claim: imported,
      result: { status: "failed", failureCode: "workspace_share_manifest_kind_mismatch" }
    }));
  });

  it("does not settle after the lease is lost", async () => {
    const imported = claim({ operationId: "operation_lease_lost" });
    const core = makeCore({
      claim: vi.fn()
        .mockResolvedValueOnce(imported)
        .mockResolvedValueOnce(null),
      heartbeat: vi.fn(async () => false),
      execute: vi.fn(async () => ({ status: "committed" as const }))
    });
    const worker = new PostgresWorkspaceShareImportWorker({ core });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(result).toMatchObject({ claimed: 1, completed: 0, leaseLost: 1 });
    expect(core.recheckTarget).not.toHaveBeenCalled();
    expect(core.execute).not.toHaveBeenCalled();
    expect(core.settle).not.toHaveBeenCalled();
  });

  it("honors the supervisor abort without settling a partially processed claim", async () => {
    const imported = claim({ operationId: "operation_abort" });
    const owner = new AbortController();
    const core = makeCore({
      claim: vi.fn(async () => imported),
      execute: vi.fn(async ({ signal }) => {
        owner.abort();
        await Promise.resolve();
        expect(signal.aborted).toBe(true);
        return { status: "committed" as const };
      })
    });
    const worker = new PostgresWorkspaceShareImportWorker({ core });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: owner.signal });

    expect(result.completed).toBe(0);
    expect(core.settle).not.toHaveBeenCalled();
  });

  it("closes the Core port and rejects subsequent ticks", async () => {
    const close = vi.fn(async () => undefined);
    const core = makeCore({ close });
    const worker = new PostgresWorkspaceShareImportWorker({ core });

    await worker.close();
    await worker.close();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal }))
      .rejects.toThrow("workspace_share_import_worker_closed");
  });
});
