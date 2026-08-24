import { describe, expect, it } from "vitest";
import { WorkspaceServerError } from "./errors";
import { WorkspaceCompletionJobService } from "./workspace-completion-jobs";
import type { WorkspaceCompletionService } from "./workspace-completion-service";

describe("WorkspaceCompletionJobService", () => {
  it("blocks a stale queued Review before the Worker starts an Attempt", async () => {
    const workspaceId = "workspace_completion_jobs_test";
    const accountId = "account_owner";
    const jobId = "completion_job_stale_test";
    let blockedReason: unknown;
    const sql = {
      query: async <T extends Record<string, unknown>>(query: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> => {
        if (query.includes("SELECT * FROM workspace_completion_jobs") && query.includes("kind = 'review'")) {
          return {
            rows: [{
              workspace_id: workspaceId,
              room_id: "room_root",
              id: jobId,
              kind: "review",
              status: "queued",
              idempotency_key: "review:stale",
              group_key: "completion_episode_stale",
              high_watermark: "completion_activity_unlinked",
              input_hash: "0".repeat(64),
              configuration_version: 1,
              attempt_count: 0,
              max_attempts: 3,
              lease_owner: null,
              lease_expires_at: null,
              heartbeat_at: null,
              blocked_reason: null,
              created_by: accountId,
              updated_by: accountId,
              created_at: "2026-08-24T00:00:00.000Z",
              updated_at: "2026-08-24T00:00:00.000Z",
              completed_at: null
            } as T]
          };
        }
        if (query.includes("SET status = 'blocked'")) {
          blockedReason = values[2];
          return { rows: [{ id: jobId } as T] };
        }
        return { rows: [] };
      }
    };
    const completion = {
      store: {
        database: {
          withContext: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql)
        }
      },
      createReviewSnapshot: async () => {
        throw new WorkspaceServerError("workspace_completion_review_stale_input", 409, {
          episode_id: "completion_episode_stale",
          high_watermark_activity_id: "completion_activity_unlinked"
        });
      }
    } as unknown as WorkspaceCompletionService;

    const result = await new WorkspaceCompletionJobService(completion).claimReview(
      { workspaceId, accountId },
      { workerId: "completion_worker_test" }
    );

    expect(result).toEqual({ blocked: true, jobId });
    expect(JSON.parse(String(blockedReason))).toMatchObject({
      code: "workspace_completion_review_stale_input",
      episode_id: "completion_episode_stale",
      high_watermark_activity_id: "completion_activity_unlinked"
    });
  });
});
