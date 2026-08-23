import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { type ObjectiveRecord, type WorkItemRecord } from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function objective(id: string, roomId: string): ObjectiveRecord {
  const now = "2026-08-23T00:00:00.000Z";
  return {
    id,
    room_id: roomId,
    title: id,
    objective: `Objective ${id}`,
    completion_criteria: ["done"],
    status: "active",
    created_at: now,
    updated_at: now
  };
}

function workItem(id: string, objectiveId: string, roomId: string, overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  const now = "2026-08-23T00:00:00.000Z";
  return {
    id,
    objective_id: objectiveId,
    room_id: roomId,
    instruction: `Work ${id}`,
    status: "ready",
    priority: 1,
    attempt: 0,
    max_attempts: 3,
    idempotency_key: id,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

async function createStore() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-durable-work-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

describe("durable work Room boundary", () => {
  it("requires a Room and keeps Objective, Work Item, and parent bindings aligned", async () => {
    const store = await createStore();
    const roomA = "room-a";
    const roomB = "room-b";
    const objectiveA = objective("objective-a", roomA);
    const objectiveB = objective("objective-b", roomB);

    await expect(store.saveObjective({ ...objectiveA, room_id: undefined })).rejects.toThrow("objective_room_scope_required");
    await store.saveObjective(objectiveA);
    await store.saveObjective(objectiveB);
    expect(await store.getObjective(objectiveA.id)).toBeUndefined();
    expect(await store.getObjective(objectiveA.id, roomB)).toBeUndefined();
    await expect(store.getObjective(objectiveA.id, roomA)).resolves.toMatchObject({ id: objectiveA.id, room_id: roomA });
    expect((await store.listObjectives(undefined, roomA)).map((item) => item.id)).toEqual([objectiveA.id]);
    expect((await store.listObjectives(undefined, roomB)).map((item) => item.id)).toEqual([objectiveB.id]);

    const itemA = workItem("work-a", objectiveA.id, roomA);
    await expect(store.saveWorkItem({ ...itemA, room_id: roomB })).rejects.toThrow("work_item_objective_room_mismatch");
    await expect(store.saveWorkItem({ ...itemA, parent_work_item_id: "missing-parent" })).rejects.toThrow("work_item_parent_room_mismatch");
    await store.saveWorkItem(itemA);
    await expect(store.saveWorkItem({ ...itemA, parent_work_item_id: itemA.id })).rejects.toThrow("work_item_parent_self_reference");
    await expect(store.updateObjective({ ...objectiveA, room_id: roomB }, roomB)).rejects.toThrow("objective_not_found_or_room_mismatch");
    expect(await store.getWorkItem(itemA.id, roomB)).toBeUndefined();
    await expect(store.getWorkItem(itemA.id, roomA)).resolves.toMatchObject({ id: itemA.id, room_id: roomA });
    expect((await store.listWorkItems({ roomId: roomB })).map((item) => item.id)).toEqual([]);
    await store.close();
  });

  it("keeps concurrent claims, leases, retry, and expiry recovery Room-scoped", async () => {
    const primary = await createStore();
    const secondary = await WorkspaceStore.create({ rootDir: primary.rootDir });
    const roomA = "room-a";
    const roomB = "room-b";
    const objectiveA = objective("objective-claim-a", roomA);
    const objectiveB = objective("objective-claim-b", roomB);
    await primary.saveObjective(objectiveA);
    await primary.saveObjective(objectiveB);
    await primary.saveWorkItem(workItem("claim-a", objectiveA.id, roomA));
    await primary.saveWorkItem(workItem("claim-b", objectiveB.id, roomB));

    expect(await primary.claimWorkItem({ workerId: "missing-room", leaseMs: 1_000, now: "2026-08-23T00:00:00.000Z" })).toBeUndefined();
    const claims = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? primary : secondary).claimWorkItem({
      workerId: `worker-${index}`,
      roomId: roomA,
      leaseMs: 1_000,
      now: "2026-08-23T00:00:00.000Z"
    })));
    const claimed = claims.filter((item): item is WorkItemRecord => item !== undefined);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: "claim-a", room_id: roomA, status: "running", attempt: 1 });
    expect(await primary.claimWorkItem({ workerId: "wrong-room", roomId: roomB, leaseMs: 1_000, now: "2026-08-23T00:00:00.000Z" })).toMatchObject({ id: "claim-b", room_id: roomB });

    const owner = claimed[0]!.lease_owner!;
    await expect(primary.heartbeatWorkItem({ workItemId: claimed[0]!.id, workerId: "other-worker", roomId: roomA, leaseMs: 2_000, now: "2026-08-23T00:00:00.500Z" })).resolves.toBeUndefined();
    await expect(primary.heartbeatWorkItem({ workItemId: claimed[0]!.id, workerId: owner, roomId: roomA, leaseMs: 2_000, now: "2026-08-23T00:00:00.500Z" })).resolves.toMatchObject({
      lease_expires_at: "2026-08-23T00:00:02.500Z",
      room_id: roomA
    });
    const retryable = await primary.failWorkItem({
      workItemId: claimed[0]!.id,
      workerId: owner,
      roomId: roomA,
      failureKind: "retryable",
      error: "temporary",
      now: "2026-08-23T00:00:01.000Z",
      baseRetryMs: 100
    });
    expect(retryable).toMatchObject({ status: "ready", attempt: 1, room_id: roomA });
    expect(await primary.claimWorkItem({ workerId: "too-early", roomId: roomA, leaseMs: 1_000, now: "2026-08-23T00:00:01.050Z" })).toBeUndefined();
    const reclaimed = await primary.claimWorkItem({ workerId: "retry-worker", roomId: roomA, leaseMs: 1_000, now: "2026-08-23T00:00:01.100Z" });
    expect(reclaimed).toMatchObject({ id: "claim-a", status: "running", attempt: 2, room_id: roomA });
    await primary.completeWorkItem({ workItemId: "claim-a", workerId: "retry-worker", roomId: roomA, now: "2026-08-23T00:00:02.000Z" });

    const expired = workItem("expired-a", objectiveA.id, roomA);
    const terminal = workItem("terminal-a", objectiveA.id, roomA, { max_attempts: 1 });
    await primary.saveWorkItem(expired);
    await primary.saveWorkItem(terminal);
    const expiredClaim = await primary.claimWorkItem({ workerId: "lease-worker", roomId: roomA, leaseMs: 1, now: "2026-08-23T00:00:03.000Z" });
    expect(expiredClaim?.id).toBe("expired-a");
    const terminalClaim = await primary.claimWorkItem({ workerId: "terminal-worker", roomId: roomA, leaseMs: 1, now: "2026-08-23T00:00:03.000Z" });
    expect(terminalClaim?.id).toBe("terminal-a");
    const recovered = await primary.reconcileExpiredWorkItems({ roomId: roomA, now: "2026-08-23T00:00:04.000Z", baseRetryMs: 0 });
    expect(recovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "expired-a", status: "ready", room_id: roomA }),
      expect.objectContaining({ id: "terminal-a", status: "failed", room_id: roomA })
    ]));
    expect((await primary.listWorkItems({ roomId: roomB })).map((item) => item.id)).toEqual(["claim-b"]);
    await secondary.close();
    await primary.close();
  });
});
