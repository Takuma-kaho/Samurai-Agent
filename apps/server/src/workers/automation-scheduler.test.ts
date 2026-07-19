import { describe, expect, it } from "vitest";
import { startAutomationScheduler } from "./automation-scheduler";
import type { AgentRuntime } from "@samurai-agent/runtime";

describe("automation scheduler shutdown", () => {
  it("drains an active tick before stop resolves", async () => {
    let resolveRun!: (value: unknown[]) => void;
    const runtime = {
      runDueAutomationJobs: () => new Promise<unknown[]>((resolve) => {
        resolveRun = resolve;
      })
    } as unknown as AgentRuntime;
    const scheduler = startAutomationScheduler(runtime, { SAMURAI_AUTOMATION_TICK_MS: "60000" });
    expect(scheduler).toBeDefined();
    const tick = scheduler!.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = scheduler!.stop();
    let settled = false;
    void stopping.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    resolveRun([]);
    await expect(tick).resolves.toEqual([]);
    await stopping;
    expect(settled).toBe(true);
    expect(scheduler!.state.running).toBe(false);
  });

  it("propagates stop cancellation into the active Runtime tick", async () => {
    let observedSignal: AbortSignal | undefined;
    const runtime = {
      runDueAutomationJobs: (_now: string, context: { signal?: AbortSignal }) => {
        observedSignal = context.signal;
        return new Promise<unknown[]>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      }
    } as unknown as AgentRuntime;
    const scheduler = startAutomationScheduler(runtime, { SAMURAI_AUTOMATION_TICK_MS: "60000" })!;
    const tick = scheduler.tick();
    await scheduler.stop({ deadlineAt: Date.now() + 1_000 });
    expect(observedSignal?.aborted).toBe(true);
    await expect(tick).rejects.toThrow("cancelled");
  });
});
