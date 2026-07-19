import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../definition/index.js";
import curatorRestore from "./restore.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const snapshot = { id: "snapshot_1", run_id: "run_1", path: "snapshots/1", resource_counts: { memory: 1, skills: 2, support_files: 0, wiki: 0 }, created_at: "2026-01-01T00:00:00.000Z" };

describe("curator.restore handler", () => {
  it("returns the restored snapshot", async () => {
    const restoreCuratorSnapshot = vi.fn(async () => snapshot);
    const handler = curatorRestore.createHandler({ restoreCuratorSnapshot, curatorSnapshotNotFoundError: () => new Error("snapshot_not_found") });

    const result = await handler.execute(context, { snapshot_id: snapshot.id });

    expect(restoreCuratorSnapshot).toHaveBeenCalledWith(snapshot.id);
    expect(result.value).toEqual(snapshot);
  });

  it("owns the missing-snapshot decision", async () => {
    const handler = curatorRestore.createHandler({ restoreCuratorSnapshot: async () => undefined, curatorSnapshotNotFoundError: () => new Error("snapshot_not_found") });
    await expect(handler.execute(context, { snapshot_id: "missing" })).rejects.toThrow("snapshot_not_found");
  });
});
