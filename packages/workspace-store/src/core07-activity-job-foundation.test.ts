import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityRecord, BackendRunRecord, ResourceUsageRecord, WorkspaceChangeRecord, WorkspaceJobRecord } from "@samurai-agent/core-schemas";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceStore } from "./index";

const roots: string[] = [];
const t0 = "2026-08-09T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<WorkspaceStore> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core07-store-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

async function finalizedActivity(store: WorkspaceStore, id = "activity-core07"): Promise<ActivityRecord> {
  const room = await store.createRoom({ id: `room-${id}`, name: `Room ${id}`, created_at: t0, updated_at: t0 });
  await store.createActivity({
    id,
    workspace_id: "workspace-core07",
    room_id: room.id,
    principal: { kind: "human", participant_id: localOwnerParticipantId },
    source: { kind: "host" },
    status: "recording",
    idempotency_key: `activity:${id}`,
    instruction_summary: "Verify Core07 durable history.",
    verification: [],
    domain_operation_ids: [],
    provenance: { kind: "trusted_context", source_id: "test", recorded_at: t0 },
    created_at: t0,
    updated_at: t0
  });
  return store.finalizeActivity({
    activityId: id,
    status: "completed",
    resultSummary: "Activity completed without inferred verification.",
    verification: [{ id: "check-1", kind: "test", status: "passed", summary: "Explicit test only.", recorded_at: t0 }],
    now: t0
  });
}

function jobRecord(activity: ActivityRecord, id: string, processorVersion = "v1"): WorkspaceJobRecord {
  return {
    id,
    workspace_id: activity.workspace_id,
    room_id: activity.room_id,
    root_activity_id: activity.id,
    kind: "activity_processing",
    processor_id: "core07.fake",
    processor_version: processorVersion,
    idempotency_key: `job:${id}`,
    status: "queued",
    attempt_count: 0,
    max_attempts: 2,
    retryable: true,
    created_at: t0,
    updated_at: t0
  };
}

async function prepareAttempt(
  store: WorkspaceStore,
  activity: ActivityRecord,
  claim: NonNullable<Awaited<ReturnType<WorkspaceStore["claimWorkspaceJob"]>>>,
  workerId: string,
  now: string
) {
  return store.prepareWorkspaceJobAttempt({
    workspaceJobId: claim.job.id,
    attemptId: claim.attempt.id,
    workerId,
    processorInput: {
      activity,
      resource_usage: [],
      resource_versions: [],
      input_schema_version: "activity_processor.input/v1"
    },
    now
  });
}

function usage(activity: ActivityRecord, stage: ResourceUsageRecord["stage"], id: string, change?: WorkspaceChangeRecord): ResourceUsageRecord {
  const isChangeStage = stage === "modified" || stage === "reverted";
  return {
    id,
    activity_id: activity.id,
    resource_ref: isChangeStage && change ? change.resource_ref : { kind: "memory", id: `memory-${stage}`, uri: `memory/${stage}` },
    resource_version: "v1",
    content_hash: `hash-${stage}`,
    usage_scope: { kind: "room", room_id: activity.room_id },
    stage,
    ...(isChangeStage && change ? { workspace_change_id: change.id } : {}),
    created_at: t0
  };
}

async function linkActualChange(store: WorkspaceStore, activity: ActivityRecord): Promise<WorkspaceChangeRecord> {
  const run: BackendRunRecord = {
    id: `run-${activity.id}`,
    room_id: activity.room_id,
    principal: activity.principal,
    source: activity.source,
    backend_id: "core07-test",
    backend_kind: "mock",
    status: "completed",
    started_at: t0,
    completed_at: t0,
    input_summary: "Core07 test change",
    output_summary: "Core07 test change completed",
    metadata: {}
  };
  await store.saveBackendRun(run);
  await store.linkActivityBackendRun({ activityId: activity.id, backendRunId: run.id, now: t0 });
  const change: WorkspaceChangeRecord = {
    id: `change-${activity.id}`,
    run_id: run.id,
    resource_ref: { kind: "memory", id: "memory-change", uri: "memory/memory-change" },
    change_type: "other",
    summary: "An actual Workspace Change used by Activity evidence.",
    created_at: t0
  };
  return store.saveWorkspaceChange(change);
}

describe("Core07 Activity History and Workspace Job persistence", () => {
  it("stores room-scoped Activity and distinct resource-use stages without creating a Job", async () => {
    const store = await createStore();
    const activity = await finalizedActivity(store);

    await expect(store.finalizeActivity({
      activityId: activity.id,
      status: "completed",
      resultSummary: "This must not overwrite the first fact.",
      now: "2026-08-09T00:01:00.000Z"
    })).rejects.toThrow("activity_finalized_immutable");

    // Usage is intentionally recorded while an Activity is open. Create a
    // correction Activity rather than editing the finalized original.
    const correction = await store.createActivity({
      id: "activity-core07-correction",
      workspace_id: activity.workspace_id,
      room_id: activity.room_id,
      principal: activity.principal,
      source: activity.source,
      status: "recording",
      idempotency_key: "activity:core07:correction",
      instruction_summary: "Correct the original Activity.",
      verification: [],
      correction_of_activity_id: activity.id,
      domain_operation_ids: [],
      provenance: { kind: "trusted_context", source_id: "test", recorded_at: t0 },
      created_at: t0,
      updated_at: t0
    });
    const correctionReplay = await store.createActivity({
      id: "activity-core07-correction-replay-id-must-not-win",
      workspace_id: activity.workspace_id,
      room_id: activity.room_id,
      principal: activity.principal,
      source: activity.source,
      status: "recording",
      idempotency_key: "activity:core07:correction",
      instruction_summary: "Correct the original Activity.",
      verification: [],
      correction_of_activity_id: activity.id,
      domain_operation_ids: [],
      provenance: { kind: "trusted_context", source_id: "test", recorded_at: "2026-08-09T00:01:00.000Z" },
      created_at: "2026-08-09T00:01:00.000Z",
      updated_at: "2026-08-09T00:01:00.000Z"
    });
    expect(correctionReplay.id).toBe(correction.id);
    const change = await linkActualChange(store, correction);
    for (const stage of ["referenced", "read", "applied", "modified", "reverted"] as const) {
      const originalUsage = usage(correction, stage, `usage-${stage}`, change);
      await store.recordResourceUsage(originalUsage);
      const replayedUsage = await store.recordResourceUsage({ ...originalUsage, created_at: "2026-08-09T00:01:00.000Z" });
      expect(replayedUsage.created_at).toBe(t0);
    }
    await expect(store.recordResourceUsage({
      ...usage(correction, "modified", "usage-invalid-change", change),
      workspace_change_id: "missing-change"
    })).rejects.toThrow("resource_usage_workspace_change_not_found");
    const foreignRoom = await store.createRoom({ id: "room-core07-foreign-change", name: "Foreign change", created_at: t0, updated_at: t0 });
    await store.saveBackendRun({
      id: "run-core07-foreign-change",
      room_id: foreignRoom.id,
      principal: correction.principal,
      source: correction.source,
      backend_id: "core07-test",
      backend_kind: "mock",
      status: "completed",
      started_at: t0,
      completed_at: t0,
      input_summary: "Foreign change",
      output_summary: "Foreign change completed",
      metadata: {}
    });
    const foreignChange = await store.saveWorkspaceChange({
      id: "change-core07-foreign-change",
      run_id: "run-core07-foreign-change",
      resource_ref: { kind: "memory", id: "memory-foreign-change", uri: "memory/foreign-change" },
      change_type: "other",
      summary: "A different Room's change.",
      created_at: t0
    });
    await expect(store.recordResourceUsage({
      ...usage(correction, "read", "usage-invalid-foreign-change"),
      resource_ref: foreignChange.resource_ref,
      workspace_change_id: foreignChange.id
    })).rejects.toThrow("resource_usage_workspace_change_scope_invalid");
    await expect(Promise.all([
      store.finalizeActivity({
        activityId: correction.id,
        status: "completed",
        resultSummary: "Correction recorded.",
        now: "2026-08-09T00:01:00.000Z"
      }),
      store.finalizeActivity({
        activityId: correction.id,
        status: "completed",
        resultSummary: "Correction recorded.",
        now: "2026-08-09T00:01:00.000Z"
      })
    ])).resolves.toHaveLength(2);
    await expect(store.finalizeActivity({
      activityId: correction.id,
      status: "completed",
      resultSummary: "Correction recorded.",
      now: "2026-08-09T00:02:00.000Z"
    })).resolves.toMatchObject({ id: correction.id, finalized_at: "2026-08-09T00:01:00.000Z" });
    await expect(store.recordResourceUsage({
      ...usage(correction, "read", "usage-read", change),
      created_at: "2026-08-09T00:02:00.000Z"
    })).resolves.toMatchObject({ id: "usage-read", created_at: t0 });

    expect(await store.listActivities({ workspaceId: activity.workspace_id, roomId: activity.room_id, principalId: localOwnerParticipantId }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: activity.id }), expect.objectContaining({ id: correction.id, correction_of_activity_id: activity.id })]));
    expect((await store.listResourceUsage({ activityId: correction.id })).map((item) => item.stage))
      .toEqual(["referenced", "read", "applied", "modified", "reverted"]);
    expect(await store.listWorkspaceJobs({ workspaceId: activity.workspace_id, rootActivityId: activity.id })).toEqual([]);
    await store.close();
  });

  it("does not leave a partial Activity when finalized ingestion rejects its evidence", async () => {
    const store = await createStore();
    const room = await store.createRoom({ id: "room-core07-atomic", name: "Atomic Activity", created_at: t0, updated_at: t0 });
    const activity: ActivityRecord = {
      id: "activity-core07-atomic",
      workspace_id: "workspace-core07",
      room_id: room.id,
      principal: { kind: "human", participant_id: localOwnerParticipantId },
      source: { kind: "host" },
      status: "recording",
      idempotency_key: "activity:core07:atomic",
      instruction_summary: "Atomically ingest a completed Activity.",
      verification: [],
      domain_operation_ids: [],
      provenance: { kind: "trusted_context", source_id: "test", recorded_at: t0 },
      created_at: t0,
      updated_at: t0
    };
    await expect(store.ingestFinalizedActivity({
      activity,
      resourceUsage: [{
        id: "usage-core07-atomic-invalid",
        activity_id: activity.id,
        resource_ref: { kind: "memory", id: "memory-atomic", uri: "memory/atomic" },
        usage_scope: { kind: "room", room_id: room.id },
        stage: "modified",
        workspace_change_id: "missing-change",
        created_at: t0
      }],
      finalization: {
        status: "completed",
        resultSummary: "This must not be persisted alone.",
        now: t0
      }
    })).rejects.toThrow("resource_usage_workspace_change_not_found");
    expect(await store.getActivity(activity.id)).toBeUndefined();
    await store.close();
  });

  it("keeps retry, lease recovery, cancellation, and old attempts durable", async () => {
    const store = await createStore();
    const activity = await finalizedActivity(store, "activity-core07-job");
    const first = await store.enqueueWorkspaceJob(jobRecord(activity, "job-core07-v1"));
    const replayedJob = await store.enqueueWorkspaceJob({
      ...jobRecord(activity, "job-core07-v1-replay"),
      idempotency_key: first.idempotency_key
    });
    expect(replayedJob.id).toBe(first.id);
    await expect(store.enqueueWorkspaceJob({
      ...jobRecord(activity, "job-core07-v1-conflict", "v2"),
      idempotency_key: first.idempotency_key
    })).rejects.toThrow("workspace_job_idempotency_conflict");
    const claim1 = await store.claimWorkspaceJob({ workerId: "worker-a", leaseMs: 1_000, now: t0 });
    expect(claim1?.job.id).toBe(first.id);
    expect(claim1?.attempt.attempt_no).toBe(1);
    await store.recordResourceUsage({
      id: "usage-core07-job-attempt",
      activity_id: activity.id,
      workspace_job_attempt_id: claim1!.attempt.id,
      resource_ref: { kind: "memory", id: "memory-processor-read", uri: "memory/memory-processor-read" },
      usage_scope: { kind: "room", room_id: activity.room_id },
      stage: "read",
      created_at: t0
    });
    await expect(store.recordResourceUsage({
      id: "usage-core07-job-attempt-write",
      activity_id: activity.id,
      workspace_job_attempt_id: claim1!.attempt.id,
      resource_ref: { kind: "memory", id: "memory-processor-write", uri: "memory/memory-processor-write" },
      usage_scope: { kind: "room", room_id: activity.room_id },
      stage: "modified",
      workspace_change_id: "must-not-reach-change-validation",
      created_at: t0
    })).rejects.toThrow("workspace_job_processor_read_only");
    const retry = await store.failWorkspaceJob({
      workspaceJobId: first.id,
      attemptId: claim1!.attempt.id,
      workerId: "worker-a",
      errorCode: "temporary_processor_error",
      retryable: true,
      retryAfterMs: 1_000,
      now: t0
    });
    expect(retry).toMatchObject({ status: "queued", attempt_count: 1 });
    const claim2 = await store.claimWorkspaceJob({ workerId: "worker-b", leaseMs: 1_000, now: "2026-08-09T00:00:01.000Z" });
    expect(claim2?.attempt.attempt_no).toBe(2);
    await expect(store.completeWorkspaceJob({
      workspaceJobId: first.id,
      attemptId: claim2!.attempt.id,
      workerId: "worker-b",
      result: { outputSchemaVersion: "core07.test/v1", output: { result: "must-not-complete" }, summary: "Input was not prepared.", diagnostics: [] },
      now: "2026-08-09T00:00:01.000Z"
    })).rejects.toThrow("workspace_job_attempt_not_prepared");
    await prepareAttempt(store, activity, claim2!, "worker-b", "2026-08-09T00:00:01.000Z");
    await store.completeWorkspaceJob({
      workspaceJobId: first.id,
      attemptId: claim2!.attempt.id,
      workerId: "worker-b",
      result: {
        outputSchemaVersion: "core07.test/v1",
        output: { result: "kept" },
        summary: "Fake processor completed.",
        diagnostics: []
      },
      now: "2026-08-09T00:00:01.000Z"
    });
    expect((await store.listWorkspaceJobAttempts(first.id)).map((attempt) => attempt.status)).toEqual(["failed", "completed"]);

    const reprocessed = await store.enqueueWorkspaceJob(jobRecord(activity, "job-core07-v2", "v2"));
    const claimV2 = await store.claimWorkspaceJob({ workerId: "worker-c", leaseMs: 1_000, now: "2026-08-09T00:00:02.000Z" });
    await prepareAttempt(store, activity, claimV2!, "worker-c", "2026-08-09T00:00:02.000Z");
    await store.completeWorkspaceJob({
      workspaceJobId: reprocessed.id,
      attemptId: claimV2!.attempt.id,
      workerId: "worker-c",
      result: {
        outputSchemaVersion: "core07.test/v2",
        output: { result: "new" },
        summary: "Version two completed.",
        diagnostics: []
      },
      now: "2026-08-09T00:00:02.000Z"
    });
    expect(await store.listWorkspaceJobAttempts(first.id)).toHaveLength(2);
    expect(await store.listWorkspaceJobAttempts(reprocessed.id)).toHaveLength(1);

    const heartbeatJob = await store.enqueueWorkspaceJob(jobRecord(activity, "job-core07-heartbeat"));
    const heartbeatClaim = await store.claimWorkspaceJob({ workerId: "worker-heartbeat", leaseMs: 1_000, now: "2026-08-09T00:00:03.000Z" });
    expect(heartbeatClaim?.job.id).toBe(heartbeatJob.id);
    const heartbeated = await store.heartbeatWorkspaceJob({
      workspaceJobId: heartbeatJob.id,
      attemptId: heartbeatClaim!.attempt.id,
      workerId: "worker-heartbeat",
      leaseMs: 1_000,
      now: "2026-08-09T00:00:03.500Z"
    });
    expect(heartbeated?.lease_expires_at).toBe("2026-08-09T00:00:04.500Z");
    expect(await store.reconcileExpiredWorkspaceJobs({ now: "2026-08-09T00:00:04.000Z" })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: heartbeatJob.id })])
    );
    await store.failWorkspaceJob({
      workspaceJobId: heartbeatJob.id,
      attemptId: heartbeatClaim!.attempt.id,
      workerId: "worker-heartbeat",
      errorCode: "test_finished",
      retryable: false,
      now: "2026-08-09T00:00:04.000Z"
    });

    const leaseJob = await store.enqueueWorkspaceJob(jobRecord(activity, "job-core07-lease"));
    const leaseClaim = await store.claimWorkspaceJob({ workerId: "worker-lease", leaseMs: 1_000, now: "2026-08-09T00:00:03.000Z" });
    expect(leaseClaim?.job.id).toBe(leaseJob.id);
    await prepareAttempt(store, activity, leaseClaim!, "worker-lease", "2026-08-09T00:00:03.000Z");
    const recovered = await store.reconcileExpiredWorkspaceJobs({ now: "2026-08-09T00:00:05.000Z", retryAfterMs: 0 });
    expect(recovered).toEqual(expect.arrayContaining([expect.objectContaining({ id: leaseJob.id, status: "queued" })]));
    await expect(store.completeWorkspaceJob({
      workspaceJobId: leaseJob.id,
      attemptId: leaseClaim!.attempt.id,
      workerId: "worker-lease",
      result: { outputSchemaVersion: "core07.test/v1", output: { stale: true }, summary: "Expired worker result.", diagnostics: [] },
      now: "2026-08-09T00:00:05.000Z"
    })).resolves.toBeUndefined();
    const recoveredClaim = await store.claimWorkspaceJob({ workerId: "worker-cancel", leaseMs: 1_000, now: "2026-08-09T00:00:05.000Z" });
    const cancelled = await store.requestWorkspaceJobCancel({ workspaceJobId: leaseJob.id, now: "2026-08-09T00:00:05.000Z" });
    expect(cancelled).toMatchObject({ status: "running", cancel_requested_at: "2026-08-09T00:00:05.000Z" });
    const terminalCancelled = await store.failWorkspaceJob({
      workspaceJobId: leaseJob.id,
      attemptId: recoveredClaim!.attempt.id,
      workerId: "worker-cancel",
      errorCode: "workspace_job_cancelled",
      retryable: false,
      now: "2026-08-09T00:00:05.000Z"
    });
    expect(terminalCancelled).toMatchObject({ status: "cancelled" });
    expect((await store.listWorkspaceJobAttempts(leaseJob.id)).map((attempt) => attempt.status)).toEqual(["failed", "cancelled"]);
    await store.close();
  });

  it("keeps Activity and Job attempts through backup and restore", async () => {
    const store = await createStore();
    const activity = await finalizedActivity(store, "activity-core07-backup");
    const job = await store.enqueueWorkspaceJob(jobRecord(activity, "job-core07-backup"));
    const claim = await store.claimWorkspaceJob({ workerId: "worker-backup", leaseMs: 1_000, now: t0 });
    await prepareAttempt(store, activity, claim!, "worker-backup", t0);
    await store.completeWorkspaceJob({
      workspaceJobId: job.id,
      attemptId: claim!.attempt.id,
      workerId: "worker-backup",
      result: { outputSchemaVersion: "core07.test/v1", output: { durable: true }, summary: "Durable output.", diagnostics: [] },
      now: t0
    });
    const backup = await store.createWorkspaceBackup();
    const restored = await store.restoreWorkspaceBackup(backup.id);
    expect(restored.integrity.ok).toBe(true);
    expect(await store.getActivity(activity.id)).toMatchObject({ id: activity.id, status: "completed" });
    expect(await store.getWorkspaceJob(job.id)).toMatchObject({ id: job.id, status: "completed" });
    expect(await store.listWorkspaceJobAttempts(job.id)).toHaveLength(1);
    expect(await store.listSchemaMigrations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 12, name: "core07_activity_history" }),
      expect.objectContaining({ version: 13, name: "core07_workspace_jobs" })
    ]));
    await store.close();
  });

  it("rejects direct SQLite rewrites of finalized Activity and terminal Job facts", async () => {
    const store = await createStore();
    const activity = await finalizedActivity(store, "activity-core07-sqlite-guard");
    const job = await store.enqueueWorkspaceJob(jobRecord(activity, "job-core07-sqlite-guard"));
    const claim = await store.claimWorkspaceJob({ workerId: "worker-sqlite-guard", leaseMs: 1_000, now: t0 });
    await store.recordResourceUsage({
      id: "usage-core07-sqlite-guard",
      activity_id: activity.id,
      workspace_job_attempt_id: claim!.attempt.id,
      resource_ref: { kind: "memory", id: "memory-sqlite-guard", uri: "memory/sqlite-guard" },
      usage_scope: { kind: "room", room_id: activity.room_id },
      stage: "read",
      created_at: t0
    });
    await prepareAttempt(store, activity, claim!, "worker-sqlite-guard", t0);
    await store.completeWorkspaceJob({
      workspaceJobId: job.id,
      attemptId: claim!.attempt.id,
      workerId: "worker-sqlite-guard",
      result: { outputSchemaVersion: "core07.test/v1", output: { durable: true }, summary: "Durable output.", diagnostics: [] },
      now: t0
    });
    const dbPath = store.dbPath;
    await store.close();

    const database = new Database(dbPath);
    try {
      expect(() => database.prepare("UPDATE activity_records SET result_summary = ? WHERE id = ?").run("rewritten", activity.id))
        .toThrow("activity_finalized_immutable");
      expect(() => database.prepare("UPDATE resource_usage_records SET stage = ? WHERE id = ?").run("applied", "usage-core07-sqlite-guard"))
        .toThrow("resource_usage_immutable");
      expect(() => database.prepare("UPDATE workspace_jobs SET status = ? WHERE id = ?").run("running", job.id))
        .toThrow("workspace_job_invalid_transition");
    } finally {
      database.close();
    }
  });
});
