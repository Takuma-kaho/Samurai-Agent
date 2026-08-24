import { describe, expect, it, vi } from "vitest";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceKnowledgeReviewPort, WorkspaceKnowledgeReviewSnapshot } from "./workspace-learning-policy";
import { WorkspaceLearningRunner, WorkspaceLearningWorker } from "./workspace-learning";
import type { WorkspaceLearningJob, WorkspaceLearningJobAttempt } from "./types";

const snapshot: WorkspaceKnowledgeReviewSnapshot = {
  workspaceId: "workspace_one", roomId: "room_one", activities: [], workspaceRules: [], workspaceKnowledge: [], roomKnowledge: []
};

const job: WorkspaceLearningJob = {
  workspaceId: "workspace_one", roomId: "room_one", id: "job_one", kind: "review", status: "running", priority: "normal",
  groupKey: "group_one", highWatermarkActivityId: "activity_one", nextRunAt: "2026-08-16T00:00:00.000Z",
  attemptCount: 1, maxAttempts: 5, leaseOwner: "worker_one", leaseExpiresAt: "2026-08-16T01:00:00.000Z",
  heartbeatAt: "2026-08-16T00:00:00.000Z", engineId: "engine_one", model: "model_one",
  createdBy: "account_one", updatedBy: "account_one", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z"
};

const attempt: WorkspaceLearningJobAttempt = {
  workspaceId: "workspace_one", id: "attempt_one", jobId: "job_one", attemptNo: 1, workerId: "worker_one",
  engineId: "engine_one", model: "model_one", status: "running", inputHash: "hash",
  usage: { currency: 0, tokens: 0 }, reservation: { currency: 2, tokens: 100 }, startedAt: "2026-08-16T00:00:00.000Z"
};

describe("Workspace learning worker", () => {
  it("claims only with the review cassette's exact engine, model, and declared reservation", async () => {
    let claimInput: unknown;
    const service = {
      claimNextJob: async (_context: unknown, input: unknown) => {
        claimInput = input;
        return { job, attempt, snapshot, settings: {} };
      },
      heartbeat: async () => job,
      applyReview: async () => job,
      failJob: async () => job
    };
    const port: WorkspaceKnowledgeReviewPort = {
      id: "engine_one", model: "model_one", maxUsage: { currency: 2, tokens: 100 },
      async review() { return { reviewer: "test", summary: "No change", mutations: [] }; }
    };

    await new WorkspaceLearningWorker(service as never, port).runOne(
      { workspaceId: "workspace_one", accountId: "account_one" }, { workerId: "worker_one" }
    );

    expect(claimInput).toMatchObject({ engineId: "engine_one", model: "model_one", reservation: { currency: 2, tokens: 100 } });
  });

  it("closes a job when a cassette ignores cancellation past the bounded timeout", async () => {
    let failedCode: string | undefined;
    const service = {
      claimNextJob: async () => ({ job, attempt, snapshot, settings: {} }),
      heartbeat: async () => job,
      applyReview: async () => job,
      failJob: async (_context: unknown, input: { errorCode: string }) => {
        failedCode = input.errorCode;
        return { ...job, status: "queued" as const };
      }
    };
    const port: WorkspaceKnowledgeReviewPort = {
      id: "engine_one", model: "model_one",
      async review() { return await new Promise<never>(() => undefined); }
    };

    const result = await new WorkspaceLearningWorker(service as never, port, { reviewTimeoutMs: 100 }).runOne(
      { workspaceId: "workspace_one", accountId: "account_one" }, { workerId: "worker_one" }
    );

    expect(failedCode).toBe("workspace_learning_review_timeout");
    expect(result?.status).toBe("queued");
  });

  it("settles a rejected review through failJob instead of leaking the rejection", async () => {
    let failedCode: string | undefined;
    const service = {
      claimNextJob: async () => ({ job, attempt, snapshot, settings: {} }),
      heartbeat: async () => job,
      applyReview: async () => { throw new WorkspaceServerError("workspace_learning_resource_ai_update_locked", 409); },
      failJob: async (_context: unknown, input: { errorCode: string; retryable: boolean }) => {
        failedCode = input.errorCode;
        expect(input.retryable).toBe(false);
        return { ...job, status: "failed" as const };
      }
    };
    const port: WorkspaceKnowledgeReviewPort = {
      id: "engine_one", model: "model_one",
      async review() { return { reviewer: "test", summary: "Rejected mutation", mutations: [] }; }
    };

    const result = await new WorkspaceLearningWorker(service as never, port).runOne(
      { workspaceId: "workspace_one", accountId: "account_one" }, { workerId: "worker_one" }
    );

    expect(failedCode).toBe("workspace_learning_resource_ai_update_locked");
    expect(result?.status).toBe("failed");
  });

  it("returns a retryable job promptly when the runner is closed during a review", async () => {
    let failedCode: string | undefined;
    const service = {
      claimNextJob: async () => ({ job, attempt, snapshot, settings: {} }),
      heartbeat: async () => job,
      applyReview: async () => job,
      failJob: async (_context: unknown, input: { errorCode: string; retryable: boolean }) => {
        failedCode = input.errorCode;
        expect(input.retryable).toBe(true);
        return { ...job, status: "queued" as const };
      }
    };
    const port: WorkspaceKnowledgeReviewPort = {
      id: "engine_one", model: "model_one",
      async review() { return await new Promise<never>(() => undefined); }
    };
    const controller = new AbortController();
    const running = new WorkspaceLearningWorker(service as never, port).runOne(
      { workspaceId: "workspace_one", accountId: "account_one" }, { workerId: "worker_one", signal: controller.signal }
    );
    controller.abort(new WorkspaceServerError("workspace_learning_runner_closed", 499));

    const result = await running;
    expect(failedCode).toBe("workspace_learning_runner_closed");
    expect(result?.status).toBe("queued");
  });

  it("keeps a retry wakeup after the current execution cycle has ended", async () => {
    vi.useFakeTimers();
    try {
      const dueAt = Date.now() + 100;
      let claimCount = 0;
      const service = {
        nextDueJobConfiguration: async () => {
          if (claimCount === 0 || Date.now() >= dueAt) return { roomId: "room_one", engineId: "engine_one", model: "model_one" };
          return undefined;
        },
        claimNextJob: async () => {
          claimCount += 1;
          return claimCount === 1 ? { job, attempt, snapshot, settings: {} } : undefined;
        },
        heartbeat: async () => job,
        applyReview: async () => job,
        failJob: async () => ({ ...job, status: "queued" as const, nextRunAt: new Date(dueAt).toISOString() })
      };
      const port: WorkspaceKnowledgeReviewPort = {
        id: "engine_one", model: "model_one",
        async review() { throw new Error("temporary"); }
      };
      const runner = new WorkspaceLearningRunner(service as never, [port], { maxJobsPerCycle: 2 });

      runner.schedule({ workspaceId: "workspace_one", accountId: "account_one" }, { roomId: "room_one" });
      await flushMicrotasks();
      expect(claimCount).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();
      expect(claimCount).toBe(2);
      await runner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an interrupted review to release its retryable Job before closing", async () => {
    let releaseReviewStarted!: () => void;
    const reviewStarted = new Promise<void>((resolve) => { releaseReviewStarted = resolve; });
    let failedCode: string | undefined;
    const service = {
      nextDueJobConfiguration: async () => ({ roomId: "room_one", engineId: "engine_one", model: "model_one" }),
      claimNextJob: async () => ({ job, attempt, snapshot, settings: {} }),
      heartbeat: async () => job,
      applyReview: async () => job,
      failJob: async (_context: unknown, input: { errorCode: string; retryable: boolean }) => {
        failedCode = input.errorCode;
        expect(input.retryable).toBe(true);
        return { ...job, status: "queued" as const };
      }
    };
    const port: WorkspaceKnowledgeReviewPort = {
      id: "engine_one", model: "model_one",
      async review() {
        releaseReviewStarted();
        return await new Promise<never>(() => undefined);
      }
    };
    const runner = new WorkspaceLearningRunner(service as never, [port]);

    runner.schedule({ workspaceId: "workspace_one", accountId: "account_one" }, { roomId: "room_one" });
    await reviewStarted;
    await runner.close();

    expect(failedCode).toBe("workspace_learning_runner_closed");
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
