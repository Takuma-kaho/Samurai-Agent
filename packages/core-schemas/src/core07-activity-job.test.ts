import { describe, expect, it } from "vitest";
import {
  ActivityRecordSchema,
  ResourceUsageRecordSchema,
  WorkspaceJobAttemptRecordSchema,
  WorkspaceJobRecordSchema,
  assertActivityStatusTransition,
  assertWorkspaceJobStatusTransition
} from "./index";

const now = "2026-08-09T00:00:00.000Z";

describe("Core07 Activity and Workspace Job contracts", () => {
  it("keeps a completed Activity structured and immutable by transition", () => {
    const activity = ActivityRecordSchema.parse({
      id: "activity-contract", workspace_id: "workspace", room_id: "room",
      principal: { kind: "human", participant_id: "human:owner" }, source: { kind: "host" },
      status: "completed", idempotency_key: "activity:contract", instruction_summary: "Record a fact.",
      result_summary: "The fact was recorded.", verification: [], domain_operation_ids: [],
      provenance: { kind: "trusted_context", source_id: "test", recorded_at: now },
      created_at: now, updated_at: now, finalized_at: now
    });
    expect(activity.status).toBe("completed");
    expect(() => assertActivityStatusTransition("recording", "recording")).toThrow("activity_invalid_transition");
    expect(() => assertActivityStatusTransition("completed", "failed")).toThrow("activity_finalized_immutable");
    expect(ActivityRecordSchema.safeParse({ ...activity, result_summary: undefined }).success).toBe(false);
  });

  it("requires a real change reference for modified or reverted Resource use", () => {
    const base = {
      id: "usage-contract", activity_id: "activity-contract",
      resource_ref: { kind: "memory", id: "memory-1", uri: "memory/memory-1" },
      usage_scope: { kind: "room" as const, room_id: "room" }, created_at: now
    };
    expect(ResourceUsageRecordSchema.safeParse({ ...base, stage: "modified" }).success).toBe(false);
    expect(ResourceUsageRecordSchema.safeParse({ ...base, stage: "reverted", workspace_change_id: "change-1" }).success).toBe(true);
    expect(ResourceUsageRecordSchema.safeParse({ ...base, stage: "read" }).success).toBe(true);
  });

  it("requires leases for running Jobs and versioned output for completed attempts", () => {
    const job = WorkspaceJobRecordSchema.parse({
      id: "job-contract", workspace_id: "workspace", room_id: "room", root_activity_id: "activity-contract",
      kind: "activity_processing", processor_id: "fake", processor_version: "v1", idempotency_key: "job:contract",
      status: "running", attempt_count: 1, max_attempts: 2, retryable: true,
      lease_owner: "worker-1", lease_expires_at: "2026-08-09T00:01:00.000Z", heartbeat_at: now,
      created_at: now, updated_at: now, started_at: now
    });
    expect(job.status).toBe("running");
    expect(WorkspaceJobRecordSchema.safeParse({ ...job, lease_owner: undefined }).success).toBe(false);
    expect(WorkspaceJobAttemptRecordSchema.safeParse({
      id: "attempt-contract", workspace_job_id: job.id, attempt_no: 1, activity_id: "activity-contract",
      processor_id: "fake", processor_version: "v1", input_schema_version: "activity_processor.input/v1",
      resource_versions: [], input_hash: "input", diagnostics: [], status: "completed", started_at: now, completed_at: now
    }).success).toBe(false);
    const completedAttempt = {
      id: "attempt-completed", workspace_job_id: job.id, attempt_no: 1, activity_id: "activity-contract",
      processor_id: "fake", processor_version: "v1", input_schema_version: "activity_processor.input/v1",
      resource_versions: [], input_hash: "input", output_schema_version: "output/v1", output_hash: "output",
      output: { durable: true }, summary: "Completed from a prepared input.", diagnostics: [], status: "completed" as const,
      started_at: now, prepared_at: now, completed_at: now
    };
    expect(WorkspaceJobAttemptRecordSchema.safeParse(completedAttempt).success).toBe(true);
    expect(WorkspaceJobAttemptRecordSchema.safeParse({ ...completedAttempt, prepared_at: undefined }).success).toBe(false);
    expect(() => assertWorkspaceJobStatusTransition("completed", "running")).toThrow("workspace_job_invalid_transition");
  });
});
