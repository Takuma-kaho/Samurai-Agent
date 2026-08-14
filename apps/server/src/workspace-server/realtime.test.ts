import { describe, expect, it } from "vitest";
import { WorkspaceRealtimeGate } from "./realtime";

describe("Workspace Server realtime isolation", () => {
  it("serializes access changes and delivery within one Workspace only", async () => {
    const gate = new WorkspaceRealtimeGate();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted!: () => void;
    let independentCompleted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const independentCompletedPromise = new Promise<void>((resolve) => { independentCompleted = resolve; });
    const first = gate.run("workspace_a", async () => {
      order.push("first:start");
      firstStarted();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first:end");
    });
    const second = gate.run("workspace_a", async () => {
      order.push("second:start");
      order.push("second:end");
    });
    const independent = gate.run("workspace_b", async () => {
      order.push("other:start");
      order.push("other:end");
      independentCompleted();
    });

    await Promise.all([firstStartedPromise, independentCompletedPromise]);
    expect(order).toContain("first:start");
    expect(order).toContain("other:start");
    expect(order).not.toContain("second:start");
    releaseFirst?.();
    await Promise.all([first, second, independent]);
    expect(order.indexOf("first:end")).toBeLessThan(order.indexOf("second:start"));
    expect(order).toContain("second:end");
  });
});
