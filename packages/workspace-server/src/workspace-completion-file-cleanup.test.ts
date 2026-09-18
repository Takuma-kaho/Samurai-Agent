import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { WorkspaceSql } from "./postgres";
import {
  WorkspaceCompletionFileCleanupService,
  WorkspaceCompletionFileService,
  type WorkspaceCompletionFileCleanupCandidate,
  type WorkspaceCompletionFileCleanupDatabase,
  type WorkspaceCompletionFileCleanupFiles
} from "./workspace-completion-files";

interface QueueRow extends WorkspaceCompletionFileCleanupCandidate {
  status: "pending" | "cleaned" | "preserved";
  leaseToken?: string;
  lastErrorCode?: string | null;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Workspace completion physical cleanup worker", () => {
  it("converges missing files and preserves a human-edited body", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-cleanup-"));
    roots.push(root);
    const files = new WorkspaceCompletionFileService(root);
    const edited = await files.stage("workspace_cleanup", { kind: "room", roomId: "room_cleanup" }, [{
      path: "knowledge/edited.md",
      content: Buffer.from("human edit", "utf8")
    }]);
    await files.finalize(edited);
    const originalHash = "0".repeat(64);
    const queue: QueueRow[] = [
      {
        id: "cleanup_missing",
        path: "knowledge/missing.md",
        sha256: "1".repeat(64),
        byteSize: 0,
        reason: "workspace_knowledge_retired",
        attemptCount: 1,
        status: "pending"
      },
      {
        id: "cleanup_edited",
        path: "knowledge/edited.md",
        sha256: originalHash,
        byteSize: 12,
        reason: "workspace_knowledge_retired",
        attemptCount: 1,
        status: "pending"
      }
    ];
    const log: string[] = [];
    const database = fakeDatabase(queue, log);
    const service = new WorkspaceCompletionFileCleanupService(database, files);

    const result = await service.runTick({ workspaceId: "workspace_cleanup", accountId: "account_cleanup" }, { workerId: "worker_cleanup", limit: 2 });

    expect(result).toMatchObject({ claimed: 2, cleaned: 1, preserved: 1, retried: 0, failed: [] });
    expect(queue.map((row) => row.status)).toEqual(["cleaned", "preserved"]);
    expect(queue[1]?.lastErrorCode).toBe("workspace_completion_file_content_changed");
    expect(log.some((entry) => entry.includes("samurai_complete_workspace_completion_file_cleanup") && entry.includes("cleaned"))).toBe(true);
    await expect(files.read("workspace_cleanup", "knowledge/edited.md", edited.entries[0]!.sha256)).resolves.toEqual(Buffer.from("human edit", "utf8"));

    const replay = await service.runTick({ workspaceId: "workspace_cleanup", accountId: "account_cleanup" }, { workerId: "worker_cleanup", limit: 2 });
    expect(replay).toMatchObject({ claimed: 0, cleaned: 0, preserved: 0, retried: 0, failed: [] });
  });

  it("releases a leased row for temporary IO and leaves it pending", async () => {
    const queue: QueueRow[] = [{
      id: "cleanup_retry",
      path: "knowledge/retry.md",
      sha256: "2".repeat(64),
      byteSize: 5,
      reason: "completion_orphaned_batch",
      attemptCount: 2,
      status: "pending"
    }];
    const log: string[] = [];
    const database = fakeDatabase(queue, log);
    const transient = Object.assign(new Error("storage temporarily unavailable"), { code: "EIO" });
    const filePort: WorkspaceCompletionFileCleanupFiles = {
      removeIfUnchangedOutcome: vi.fn().mockRejectedValue(transient)
    };
    const service = new WorkspaceCompletionFileCleanupService(database, filePort);

    const result = await service.runTick({ workspaceId: "workspace_cleanup", accountId: "account_cleanup" }, { workerId: "worker_cleanup" });

    expect(result).toMatchObject({ claimed: 1, cleaned: 0, preserved: 0, retried: 1, failed: [] });
    expect(queue[0]).toMatchObject({ status: "pending", leaseToken: undefined, lastErrorCode: "workspace_completion_file_cleanup_eio" });
    expect(log.some((entry) => entry.includes("samurai_release_workspace_completion_file_cleanup"))).toBe(true);
  });

  it("runs the physical operation and terminal queue update in one tenant transaction", async () => {
    const queue: QueueRow[] = [{
      id: "cleanup_order",
      path: "knowledge/order.md",
      sha256: "3".repeat(64),
      byteSize: 0,
      reason: "completion_orphaned_batch",
      attemptCount: 1,
      status: "pending"
    }];
    const log: string[] = [];
    const database = fakeDatabase(queue, log);
    const filePort: WorkspaceCompletionFileCleanupFiles = {
      removeIfUnchangedOutcome: vi.fn(async () => {
        log.push("filesystem-remove");
        return "missing" as const;
      })
    };
    const service = new WorkspaceCompletionFileCleanupService(database, filePort);

    await service.runTick({ workspaceId: "workspace_cleanup", accountId: "account_cleanup" }, { workerId: "worker_cleanup" });

    const removeIndex = log.indexOf("filesystem-remove");
    const completeIndex = log.findIndex((entry) => entry.includes("samurai_complete_workspace_completion_file_cleanup"));
    expect(removeIndex).toBeGreaterThan(-1);
    expect(completeIndex).toBeGreaterThan(removeIndex);
    expect(log.slice(removeIndex - 1, completeIndex + 1)).not.toContain("transaction-end");
  });
});

function fakeDatabase(queue: QueueRow[], log: string[]): WorkspaceCompletionFileCleanupDatabase {
  const database: WorkspaceCompletionFileCleanupDatabase = {
    async withContext(_context, action) {
      log.push("transaction-start");
      const sql: WorkspaceSql = {
        async query<Row extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
          log.push(`${text} ${values.map(String).join(",")}`);
          if (text.includes("samurai_claim_workspace_completion_file_cleanup")) {
            const claimed = queue.filter((row) => row.status === "pending");
            for (const row of claimed) {
              row.attemptCount += 1;
              row.leaseToken = String(values[1]);
            }
            return { rows: claimed.map((row) => ({
              id: row.id,
              path: row.path,
              sha256: row.sha256,
              byte_size: row.byteSize,
              reason: row.reason,
              attempt_count: row.attemptCount
            })) } as unknown as QueryResult<Row>;
          }
          if (text.includes("samurai_complete_workspace_completion_file_cleanup")) {
            const row = queue.find((candidate) => candidate.id === values[1]);
            if (row) {
              row.status = values[3] as QueueRow["status"];
              row.lastErrorCode = values[4] as string | null;
              row.leaseToken = undefined;
            }
            return { rows: [] } as unknown as QueryResult<Row>;
          }
          if (text.includes("samurai_release_workspace_completion_file_cleanup")) {
            const row = queue.find((candidate) => candidate.id === values[1]);
            if (row) {
              row.lastErrorCode = values[3] as string;
              row.leaseToken = undefined;
            }
            return { rows: [] } as unknown as QueryResult<Row>;
          }
          return { rows: [] } as unknown as QueryResult<Row>;
        }
      };
      const value = await action(sql);
      log.push("transaction-end");
      return value;
    }
  };
  return database;
}
