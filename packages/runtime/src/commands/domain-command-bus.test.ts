import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import type { DomainCommandExecutionRecord } from "@samurai-agent/core-schemas";
import { DomainCommandConflictError, DomainCommandOutcomeUnknownError, DomainCommandReplayError, DurableDomainCommandBus } from "./domain-command-bus";

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
  it("rejects commands without an idempotency key", async () => {
    const store = {} as WorkspaceStore;
    await expect(new DurableDomainCommandBus(store).execute({ commandId: "test.missing-key", inputSource: "test", payload: {} }, async () => null)).rejects.toMatchObject({
      name: "DomainCommandIdempotencyKeyRequiredError", code: "idempotency_key_required"
    });
  });

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

  it("covers local conflicts, observers, undefined results, and primitive failures", async () => {
    const store = await createStore();
    const checkpoints: string[] = [];
    const bus = new DurableDomainCommandBus(store, 30_000, { checkpoint: (name) => { checkpoints.push(name); } });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = bus.execute({ commandId: "test.local", inputSource: "test", payload: { value: 1 }, idempotencyKey: "local" }, async () => {
      await blocked;
      return undefined;
    });
    await expect(bus.execute({ commandId: "test.local", inputSource: "test", payload: { value: 2 }, idempotencyKey: "local" }, async () => null)).rejects.toBeInstanceOf(DomainCommandConflictError);
    release();
    await expect(first).resolves.toBeUndefined();
    expect(checkpoints).toEqual(["claimed", "handler_started", "handler_succeeded", "result_saved"]);

    await expect(bus.execute({ commandId: "test.primitive", inputSource: "test", payload: {}, idempotencyKey: "primitive" }, async () => { throw "primitive"; })).rejects.toBe("primitive");
    await expect(new DurableDomainCommandBus(store).execute({ commandId: "test.primitive", inputSource: "test", payload: {}, idempotencyKey: "primitive" }, async () => null)).rejects.toMatchObject({
      name: "DomainCommandReplayError", code: "domain_command_failed", retryable: false
    });
    const fallbackError = { unexpected: true, retryable: true };
    await expect(bus.execute({ commandId: "test.fallback", inputSource: "test", correlationId: "explicit-correlation", payload: {}, idempotencyKey: "fallback" }, async () => { throw fallbackError; })).rejects.toBe(fallbackError);
    await expect(new DurableDomainCommandBus(store).execute({ commandId: "test.fallback", inputSource: "test", correlationId: "explicit-correlation", payload: {}, idempotencyKey: "fallback" }, async () => null)).rejects.toMatchObject({
      code: "domain_command_failed", message: "[object Object]", retryable: true
    });
    const structuredError = { code: "fixture_error", message: "structured failure", retryable: true, details: { reason: "fixture" } };
    await expect(bus.execute({ commandId: "test.structured", inputSource: "test", payload: {}, idempotencyKey: "structured", executionClass: "external" }, async () => { throw structuredError; })).rejects.toBe(structuredError);
    await expect(new DurableDomainCommandBus(store).execute({ commandId: "test.structured", inputSource: "test", payload: {}, idempotencyKey: "structured", executionClass: "external" }, async () => null)).rejects.toMatchObject({
      code: "fixture_error", message: "structured failure", retryable: true, details: { reason: "fixture" }
    });
    await store.close();
  });

  it("resolves every durable recovery branch", async () => {
    const now = new Date(0).toISOString();
    const input = { commandId: "test.recovery", inputSource: "test", payload: {}, idempotencyKey: "recovery" };
    const record = (overrides: Partial<DomainCommandExecutionRecord> = {}): DomainCommandExecutionRecord => ({
      id: "execution", idempotency_key: "recovery", command_id: "test.recovery", input_source: "test",
      correlation_id: "correlation", payload_hash: "unused", phase: "internal_running", status: "running",
      heartbeat_at: now, created_at: now, updated_at: now, ...overrides
    });
    const executeWith = async (initial: DomainCommandExecutionRecord, latest: DomainCommandExecutionRecord | undefined, changed = false, executionClass?: "internal" | "external") => {
      const store = {
        claimDomainCommandExecution: async () => ({ claimed: false as const, record: initial }),
        getDomainCommandExecution: async () => latest,
        compareAndSetDomainCommandExecution: async () => changed,
        updateDomainCommandExecution: async (value: DomainCommandExecutionRecord) => value,
        heartbeatDomainCommandExecution: async () => true
      } as unknown as WorkspaceStore;
      return new DurableDomainCommandBus(store, 1).execute({ ...input, executionClass }, async () => ({ recovered: true }));
    };
    const hashStore = await createStore();
    await new DurableDomainCommandBus(hashStore).execute(input, async () => ({ hash: true }));
    const persisted = await hashStore.getDomainCommandExecution("recovery");
    expect(persisted).toBeDefined();
    await hashStore.close();
    const base = { ...persisted!, status: "running" as const, heartbeat_at: now, updated_at: now };

    await expect(executeWith({ ...base, status: "outcome_unknown" }, undefined)).rejects.toBeInstanceOf(DomainCommandOutcomeUnknownError);
    await expect(executeWith({ ...base, phase: "external_running" }, undefined)).rejects.toThrow("domain_command_execution_missing");
    await expect(executeWith({ ...base, phase: "external_running" }, undefined, true)).rejects.toBeInstanceOf(DomainCommandOutcomeUnknownError);
    await expect(executeWith(base, undefined)).rejects.toThrow("domain_command_execution_missing");
    await expect(executeWith({ ...base, phase: "external_running" }, { ...base, status: "completed", result: { replayed: true } })).resolves.toEqual({ replayed: true });
    await expect(executeWith(base, { ...base, status: "failed", error: undefined })).rejects.toBeInstanceOf(DomainCommandReplayError);
    await expect(executeWith({ ...base, phase: "claimed", heartbeat_at: undefined, updated_at: undefined }, undefined, true, "external")).resolves.toEqual({ recovered: true });
    const liveWithoutRefresh = { ...base, heartbeat_at: new Date().toISOString(), updated_at: undefined };
    await expect(executeWith(liveWithoutRefresh, undefined, true)).resolves.toEqual({ recovered: true });
    await expect(executeWith({ ...base, heartbeat_at: "invalid", updated_at: "invalid", created_at: "invalid" }, undefined, true)).resolves.toEqual({ recovered: true });
  });

  it("heartbeats while a claimed handler is still running", async () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi.fn(async () => true);
      const store = {
        claimDomainCommandExecution: async (record: DomainCommandExecutionRecord) => ({ claimed: true as const, record }),
        updateDomainCommandExecution: async (record: DomainCommandExecutionRecord) => record,
        heartbeatDomainCommandExecution: heartbeat
      } as unknown as WorkspaceStore;
      let finish!: () => void;
      const running = new Promise<void>((resolve) => { finish = resolve; });
      const execution = new DurableDomainCommandBus(store, 3_000).execute({ commandId: "test.heartbeat", inputSource: "test", payload: {}, idempotencyKey: "heartbeat" }, async () => running);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      finish();
      await expect(execution).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
