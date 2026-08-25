import { describe, expect, it, vi } from "vitest";
import { WorkspaceWorkerSupervisor, type WorkspaceCompletionMaintenancePort, type WorkspaceLearningRunnerPort } from "./workspace-worker-supervisor";

function makeRunner(): WorkspaceLearningRunnerPort {
  return {
    runCycle: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
}

function makeMaintenance(): WorkspaceCompletionMaintenancePort {
  return { runTick: vi.fn(async () => undefined) };
}

const context = { workspaceId: "workspace_one", accountId: "account_one" };

describe("WorkspaceWorkerSupervisor", () => {
  it("starts one loop, prevents duplicate starts, and passes a request-scoped operation", async () => {
    vi.useFakeTimers();
    const runner = makeRunner();
    const maintenance = makeMaintenance();
    const supervisor = new WorkspaceWorkerSupervisor({
      learningRunner: runner,
      maintenance,
      resolveContext: async () => ({ state: "enabled", context }),
      intervalMs: 10_000
    });

    const first = supervisor.start();
    const second = supervisor.start();
    expect(await first).toMatchObject({ state: "running", enabled: true });
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.runCycle).toHaveBeenCalledTimes(1);
    expect(maintenance.runTick).toHaveBeenCalledTimes(1);
    expect(maintenance.runTick.mock.calls[0]?.[0]).toMatchObject({ workspaceId: context.workspaceId, accountId: context.accountId });
    expect(maintenance.runTick.mock.calls[0]?.[0].operationId).toMatch(/^workspace_worker_tick_/);

    await supervisor.stop();
    expect(supervisor.status()).toMatchObject({ state: "stopped", enabled: false });
    expect(runner.close).toHaveBeenCalledTimes(1);
    await expect(supervisor.start()).rejects.toThrow("workspace_worker_supervisor_closed");
    vi.useRealTimers();
  });

  it("runs each hosted Workspace through its own maintenance identity context", async () => {
    vi.useFakeTimers();
    const runner = makeRunner();
    const maintenance = makeMaintenance();
    const secondContext = { workspaceId: "workspace_two", accountId: "account_two" };
    const supervisor = new WorkspaceWorkerSupervisor({
      learningRunner: runner,
      maintenance,
      resolveContext: async () => ({ state: "disabled", reason: "legacy_single_context_resolver_unused" }),
      resolveContexts: async () => ({ state: "enabled", contexts: [context, secondContext] }),
      intervalMs: 10_000
    });

    await supervisor.start();
    expect(supervisor.status()).toMatchObject({ state: "running", enabled: true, workspaceCount: 2 });
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.runCycle).toHaveBeenCalledTimes(2);
    expect(maintenance.runTick).toHaveBeenCalledTimes(2);
    expect(maintenance.runTick.mock.calls.map(([value]) => ({
      workspaceId: value.workspaceId,
      accountId: value.accountId
    }))).toEqual([context, secondContext]);
    expect(maintenance.runTick.mock.calls.every(([value]) => value.operationId.startsWith("workspace_worker_tick_"))).toBe(true);

    await supervisor.stop();
    vi.useRealTimers();
  });

  it("keeps a missing identity disabled without starting a retry loop", async () => {
    vi.useFakeTimers();
    const runner = makeRunner();
    const maintenance = makeMaintenance();
    const supervisor = new WorkspaceWorkerSupervisor({
      learningRunner: runner,
      maintenance,
      resolveContext: async () => ({ state: "disabled", reason: "maintenance_identity_unconfigured" }),
      retryBaseMs: 10
    });

    await supervisor.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(supervisor.status()).toMatchObject({ state: "disabled", enabled: false, disabledReason: "maintenance_identity_unconfigured" });
    expect(runner.runCycle).not.toHaveBeenCalled();
    await supervisor.stop();
    vi.useRealTimers();
  });

  it("retries a transient identity resolution failure", async () => {
    vi.useFakeTimers();
    const runner = makeRunner();
    const maintenance = makeMaintenance();
    const resolveContext = vi.fn()
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockResolvedValueOnce({ state: "enabled" as const, context });
    const supervisor = new WorkspaceWorkerSupervisor({
      learningRunner: runner,
      maintenance,
      resolveContext,
      retryBaseMs: 10,
      retryMaxMs: 100
    });

    await supervisor.start();
    expect(supervisor.status()).toMatchObject({ state: "retrying", consecutiveFailures: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(resolveContext).toHaveBeenCalledTimes(2);
    expect(supervisor.status()).toMatchObject({ state: "running", enabled: true });
    await supervisor.stop();
    vi.useRealTimers();
  });

  it("stops and drains when the owning AbortSignal is aborted", async () => {
    const runner = makeRunner();
    const maintenance = makeMaintenance();
    const owner = new AbortController();
    const supervisor = new WorkspaceWorkerSupervisor({
      learningRunner: runner,
      maintenance,
      resolveContext: async () => ({ state: "enabled", context })
    });

    await supervisor.start(owner.signal);
    owner.abort();
    await supervisor.stop();
    expect(supervisor.status()).toMatchObject({ state: "stopped", enabled: false, stopReason: "aborted" });
    expect(runner.close).toHaveBeenCalledTimes(1);
  });

  it("retries a failed tick with backoff and drains it on shutdown", async () => {
    vi.useFakeTimers();
    const runner = makeRunner();
    const maintenance = makeMaintenance();
    vi.mocked(maintenance.runTick)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    const supervisor = new WorkspaceWorkerSupervisor({
      learningRunner: runner,
      maintenance,
      resolveContext: async () => ({ state: "enabled", context }),
      retryBaseMs: 10,
      retryMaxMs: 100,
      intervalMs: 10_000
    });

    await supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.status()).toMatchObject({ state: "retrying", consecutiveFailures: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(maintenance.runTick).toHaveBeenCalledTimes(2);
    expect(supervisor.status()).toMatchObject({ state: "running", consecutiveFailures: 0, successfulTicks: 1 });
    await supervisor.stop();
    vi.useRealTimers();
  });

  it("waits for an in-flight maintenance tick before finishing shutdown", async () => {
    vi.useFakeTimers();
    const runner = makeRunner();
    const maintenance = makeMaintenance();
    let release!: () => void;
    vi.mocked(maintenance.runTick).mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const supervisor = new WorkspaceWorkerSupervisor({
      learningRunner: runner,
      maintenance,
      resolveContext: async () => ({ state: "enabled", context })
    });

    await supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.runTick).toHaveBeenCalledTimes(1);
    const stopping = supervisor.stop();
    expect(supervisor.status()).toMatchObject({ state: "stopping" });
    release();
    await stopping;
    expect(supervisor.status()).toMatchObject({ state: "stopped" });
    vi.useRealTimers();
  });

  it("reports a close failure instead of silently accepting shutdown", async () => {
    const runner = makeRunner();
    vi.mocked(runner.close).mockRejectedValueOnce(new Error("runner close failed"));
    const supervisor = new WorkspaceWorkerSupervisor({
      learningRunner: runner,
      maintenance: makeMaintenance(),
      resolveContext: async () => ({ state: "enabled", context })
    });

    await supervisor.start();
    await supervisor.stop();
    expect(supervisor.status()).toMatchObject({
      state: "stopped",
      stopReason: "shutdown_close_failed",
      lastError: { code: "workspace_worker_shutdown_failed", message: "runner close failed" }
    });
    await expect(supervisor.start()).rejects.toThrow("workspace_worker_supervisor_closed");
  });

  it("captures a synchronous close failure in the shutdown status", async () => {
    const runner = makeRunner();
    vi.mocked(runner.close).mockImplementationOnce(() => {
      throw new Error("runner close threw");
    });
    const supervisor = new WorkspaceWorkerSupervisor({
      learningRunner: runner,
      maintenance: makeMaintenance(),
      resolveContext: async () => ({ state: "enabled", context })
    });

    await supervisor.start();
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.status()).toMatchObject({
      state: "stopped",
      stopReason: "shutdown_close_failed",
      lastError: { code: "workspace_worker_shutdown_failed", message: "runner close threw" }
    });
  });
});
