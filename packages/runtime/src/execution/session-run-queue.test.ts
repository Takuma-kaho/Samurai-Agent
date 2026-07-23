import { describe, expect, it } from "vitest";
import { SessionRunQueue } from "./session-run-queue";

describe("SessionRunQueue", () => {
  it("serializes one session and runs different sessions in parallel", async () => {
    const queue = new SessionRunQueue({ maxConcurrency: 2 });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.enqueue("same", async () => { order.push("first:start"); await gate; order.push("first:end"); return 1; });
    const second = queue.enqueue("same", async () => { order.push("second"); return 2; });
    const other = queue.enqueue("other", async () => { order.push("other"); return 3; });
    await other;
    expect(order).toContain("other");
    expect(order).not.toContain("second");
    release();
    await Promise.all([first, second]);
    expect(order.indexOf("first:end")).toBeLessThan(order.indexOf("second"));
  });

  it("reacquires a released global slot only for a suspended direct control", async () => {
    const queue = new SessionRunQueue({ maxConcurrency: 1 });
    const waiting = queue.enqueue("waiting", async () => {
      queue.markWaiting("waiting", "suspended");
      return 1;
    });
    await waiting;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = queue.enqueue("other", async () => gate);
    await Promise.resolve();
    expect(queue.activeCount).toBe(1);

    let resumed = false;
    const controlPromise = queue.acquireControl("waiting").then(() => { resumed = true; });
    await Promise.resolve();
    expect(resumed).toBe(false);
    release();
    await active;
    await controlPromise;
    expect(resumed).toBe(true);
    expect(queue.activeCount).toBe(1);
    queue.releaseSession("waiting");
    expect(queue.activeCount).toBe(0);
  });
});
