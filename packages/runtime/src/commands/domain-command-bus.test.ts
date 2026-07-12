import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { DomainCommandConflictError, DurableDomainCommandBus } from "./domain-command-bus";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<WorkspaceStore> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-domain-command-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

describe("DurableDomainCommandBus", () => {
  it("executes one side effect for 100 concurrent requests with the same key", async () => {
    const store = await createStore();
    const buses = Array.from({ length: 10 }, () => new DurableDomainCommandBus(store));
    let sideEffects = 0;
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      buses[index % buses.length].execute({
        commandId: "test.increment",
        inputSource: "runtime_api",
        payload: { value: 1 },
        idempotencyKey: "same-command"
      }, async () => {
        sideEffects += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { result_id: "result-1", value: sideEffects };
      })
    ));

    expect(sideEffects).toBe(1);
    expect(new Set(results.map((result) => result.result_id))).toEqual(new Set(["result-1"]));
    expect(new Set(results.map((result) => result.value))).toEqual(new Set([1]));
    await store.close();
  });

  it("rejects reuse of a key with a different payload", async () => {
    const store = await createStore();
    const bus = new DurableDomainCommandBus(store);
    await bus.execute({
      commandId: "test.write",
      inputSource: "runtime_api",
      payload: { value: 1 },
      idempotencyKey: "reused-key"
    }, async () => ({ ok: true }));

    await expect(bus.execute({
      commandId: "test.write",
      inputSource: "runtime_api",
      payload: { value: 2 },
      idempotencyKey: "reused-key"
    }, async () => ({ ok: false }))).rejects.toBeInstanceOf(DomainCommandConflictError);
    await store.close();
  });
});
