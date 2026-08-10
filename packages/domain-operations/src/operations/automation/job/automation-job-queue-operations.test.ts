import { describe, expect, it, vi } from "vitest";
import type { AutomationJobRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../../definition/index.js";
import automationJobReleaseLock from "./release_lock.operation.js";
import automationJobRequeue from "./requeue.operation.js";
import automationJobRun from "./run.operation.js";
import automationJobSave from "./save.operation.js";
import { automationJobJson } from "./job-mutation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "actor_test",
  correlationId: "correlation_test"
};

const job: AutomationJobRecord = {
  id: "job_1",
  title: "Daily digest",
  kind: "daily_digest",
  status: "enabled",
  schedule: "daily",
  target_instruction: "Create a digest",
  delivery_target: { channel: "activity" },
  locked_until: "2099-01-01T00:00:00.000Z",
  lock_owner_token: "lock-test-token",
  failure_count: 1,
  max_attempts: 3,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z"
};

describe("Automation job queue operation handlers", () => {
  it("passes the validated lock-release arguments to the queue port", async () => {
    const releaseAutomationJobLock = vi.fn(async () => ({ ...job, locked_until: undefined, lock_owner_token: undefined }));
    const handler = automationJobReleaseLock.createHandler({
      releaseAutomationJobLock,
      automationJobNotFoundError: () => new Error("automation_job_not_found")
    });

    const result = await handler.execute(context, {
      job_id: job.id,
      lock_owner_token: "lock-test-token",
      now: "2026-02-01T00:00:00.000Z"
    });

    expect(releaseAutomationJobLock).toHaveBeenCalledWith(job.id, "lock-test-token", "2026-02-01T00:00:00.000Z");
    expect(result.value.locked_until).toBeUndefined();
  });

  it("owns the missing-job decision", async () => {
    const handler = automationJobReleaseLock.createHandler({
      releaseAutomationJobLock: async () => undefined,
      automationJobNotFoundError: () => new Error("automation_job_not_found")
    });

    await expect(handler.execute(context, { job_id: "missing", lock_owner_token: "lock-test-token" })).rejects.toThrow("automation_job_not_found");
  });

  it("passes the validated requeue arguments to the queue port", async () => {
    const requeueAutomationJob = vi.fn(async () => ({ ...job, retry_after_at: "2026-02-02T00:00:00.000Z" }));
    const handler = automationJobRequeue.createHandler({
      requeueAutomationJob,
      automationJobNotFoundError: () => new Error("automation_job_not_found")
    });

    const result = await handler.execute(context, {
      job_id: job.id,
      next_run_at: "2026-02-02T00:00:00.000Z"
    });

    expect(requeueAutomationJob).toHaveBeenCalledWith(job.id, "2026-02-02T00:00:00.000Z");
    expect(result.value.retry_after_at).toBe("2026-02-02T00:00:00.000Z");
  });

  it("rejects envelope fields that do not belong to either operation", () => {
    expect(automationJobReleaseLock.input.safeParse({ job_id: job.id, session_id: "session_1" }).success).toBe(false);
    expect(automationJobRequeue.input.safeParse({ job_id: job.id, next_run_at: "tomorrow" }).success).toBe(false);
  });

  it("serializes optional job fields without leaking undefined into rollback JSON", () => {
    const serialized = automationJobJson({ ...job, locked_until: undefined, lock_owner_token: undefined, retry_after_at: undefined });

    expect(serialized).not.toHaveProperty("locked_until");
    expect(serialized).not.toHaveProperty("lock_owner_token");
    expect(serialized).not.toHaveProperty("retry_after_at");
  });

  it("rejects a non-date run timestamp at the operation boundary", () => {
    expect(automationJobRun.input.safeParse({ job_id: job.id, now: "not-a-date" }).success).toBe(false);
    expect(automationJobSave.input.safeParse({ title: "Fixture", kind: "daily_digest", schedule: "daily", target_instruction: "fixture", next_run_at: "not-a-date" }).success).toBe(false);
  });
});
