import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";
import { DomainCommandConflictError, DurableDomainCommandBus } from "../../packages/runtime/src/commands/domain-command-bus";

const root = await mkdtemp(path.join(tmpdir(), "samurai-domain-command-evidence-"));
const store = await WorkspaceStore.create({ rootDir: root });

try {
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

  assert.equal(sideEffects, 1);
  assert.deepEqual([...new Set(results.map((result) => result.result_id))], ["result-1"]);
  assert.deepEqual([...new Set(results.map((result) => result.value))], [1]);

  const replay = await new DurableDomainCommandBus(store).execute({
    commandId: "test.increment",
    inputSource: "runtime_api",
    payload: { value: 1 },
    idempotencyKey: "same-command"
  }, async () => {
    throw new Error("completed command must not run again");
  });
  assert.deepEqual(replay, { result_id: "result-1", value: 1 });

  await assert.rejects(
    new DurableDomainCommandBus(store).execute({
      commandId: "test.increment",
      inputSource: "runtime_api",
      payload: { value: 2 },
      idempotencyKey: "same-command"
    }, async () => ({ result_id: "invalid" })),
    DomainCommandConflictError
  );

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    parallel_requests: 100,
    workers: buses.length,
    side_effects: sideEffects,
    result_ids: ["result-1"],
    durable_replay: true,
    mismatched_payload_rejected: true
  })}\n`);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
