import { describe, expect, it } from "vitest";
import { canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import {
  WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE,
  WorkspaceInteractionRequestService,
  workspaceInteractionExecutionOperationId,
  type WorkspaceInteractionRequestRecordStore,
  type WorkspaceInteractionRequestRespondInput
} from "./workspace-interaction-request-service";
import type { PutRecordInput, PutRecordResult } from "./workspace-server-store";
import type { WorkspaceRecord, WorkspaceRequestContext } from "./types";

describe("WorkspaceInteractionRequestService", () => {
  it("persists immutable Room/Run/Surface/revision/target data and accepts only declared options", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock });
    const context = contextFor("operation-create");
    const created = await service.create(context, {
      roomId: "room-a",
      kind: "approval",
      title: "公開前の確認",
      summary: "この変更を公開します。",
      runId: "run-a",
      surfaceId: "surface-a",
      revisionId: "revision-a",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-a", action_id: "publish" },
      options: [
        { id: "approve", label: "許可", decision: "approve" },
        { id: "deny", label: "拒否", decision: "deny" }
      ],
      expiresAt: "2026-09-08T00:05:00.000Z"
    });

    expect(created.request).toMatchObject({
      roomId: "room-a",
      runId: "run-a",
      surfaceId: "surface-a",
      revisionId: "revision-a",
      requestedAccountId: context.accountId,
      status: "pending",
      version: 1
    });

    await expect(service.respond(contextFor("operation-decision-only"), {
      roomId: "room-a",
      requestId: created.request.id,
      expectedVersion: 1,
      decision: "approve"
    } as unknown as WorkspaceInteractionRequestRespondInput)).rejects.toMatchObject({
      code: "workspace_interaction_request_option_id_required",
      status: 400
    });
    await expect(service.respond(contextFor("operation-missing-version"), {
      roomId: "room-a",
      requestId: created.request.id,
      optionId: "approve"
    } as unknown as WorkspaceInteractionRequestRespondInput)).rejects.toMatchObject({
      code: "workspace_interaction_request_expected_version_invalid",
      status: 400
    });

    await expect(service.respond(contextFor("operation-forged"), {
      roomId: "room-a",
      requestId: created.request.id,
      expectedVersion: 1,
      optionId: "forged",
      decision: "approve",
      input: { actionTarget: { room_id: "other-room" } }
    } as WorkspaceInteractionRequestRespondInput)).rejects.toMatchObject({
      code: "workspace_interaction_request_option_invalid",
      status: 400
    });

    const accepted = await service.respond(contextFor("operation-accept", "account-decider"), {
      roomId: "room-a",
      requestId: created.request.id,
      expectedVersion: 1,
      optionId: "approve"
    });
    expect(accepted.request).toMatchObject({
      status: "accepted",
      decidedAccountId: "account-decider",
      version: 2,
      runId: "run-a",
      surfaceId: "surface-a",
      revisionId: "revision-a",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-a", action_id: "publish" }
    });
    expect(accepted.request.outcome).toMatchObject({ kind: "response", optionId: "approve", decision: "approve" });
    expect(store.executionCount).toBe(2);
  });

  it("validates backend input against the persisted Server schema and never resumes the Run", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock });
    const created = await service.create(contextFor("operation-input-create"), {
      roomId: "room-input",
      kind: "backend_input",
      runId: "run-input",
      actionTarget: { kind: "backend_input", field: "answer" },
      options: [
        { id: "submit", label: "送信", decision: "submit_input" },
        { id: "skip", label: "拒否", decision: "deny" }
      ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: { answer: { type: "string", minLength: 2 } }
      },
      expiresAt: "2026-09-08T00:05:00.000Z"
    });

    await expect(service.respond(contextFor("operation-invalid-input"), {
      roomId: "room-input",
      requestId: created.request.id,
      expectedVersion: 1,
      optionId: "submit",
      values: { answer: "x" }
    })).rejects.toMatchObject({ code: "workspace_interaction_request_input_invalid", status: 400 });

    const accepted = await service.respond(contextFor("operation-valid-input"), {
      roomId: "room-input",
      requestId: created.request.id,
      expectedVersion: 1,
      optionId: "submit",
      values: { answer: "ok" }
    });
    expect(accepted.request.status).toBe("accepted");
    expect(accepted.request.outcome).toMatchObject({ kind: "response", optionId: "submit", decision: "submit_input" });
    expect(accepted.request.outcome).not.toHaveProperty("input");
    expect(store.resumeCount).toBe(0);
  });

  it("requires a run identity for backend input requests", async () => {
    const service = new WorkspaceInteractionRequestService(new MemoryInteractionRecordStore(), { clock: mutableClock("2026-09-08T00:00:00.000Z") });
    await expect(service.create(contextFor("operation-input-without-run"), {
      roomId: "room-input",
      kind: "backend_input",
      actionTarget: { kind: "backend_input" },
      options: [{ id: "submit", label: "送信", decision: "submit_input" }],
      inputSchema: { type: "object" }
    })).rejects.toMatchObject({ code: "workspace_interaction_request_run_id_required", status: 400 });
  });

  it("makes response idempotency explicit and rejects a concurrent second decision", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock });
    const created = await service.create(contextFor("operation-double-create"), {
      roomId: "room-double",
      kind: "approval",
      actionTarget: { kind: "artifact", id: "artifact-a" },
      options: [
        { id: "approve", label: "許可", decision: "approve" },
        { id: "deny", label: "拒否", decision: "deny" }
      ],
      expiresAt: "2026-09-08T00:05:00.000Z"
    });

    const responses = await Promise.allSettled([
      service.respond(contextFor("operation-double-approve", "account-a"), {
        roomId: "room-double", requestId: created.request.id, expectedVersion: 1, optionId: "approve"
      }),
      service.respond(contextFor("operation-double-deny", "account-b"), {
        roomId: "room-double", requestId: created.request.id, expectedVersion: 1, optionId: "deny"
      })
    ]);
    expect(responses.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(responses.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = responses.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.objectContaining({ code: "workspace_interaction_request_already_decided" }) });

    const replayed = await service.respond(contextFor("operation-double-approve", "account-a"), {
      roomId: "room-double", requestId: created.request.id, expectedVersion: 1, optionId: "approve"
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.request.version).toBe(2);
  });

  it("persists expiry/cancel transitions and can read the same request after service restart", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock });
    const expiring = await service.create(contextFor("operation-expiring"), {
      roomId: "room-expiry",
      kind: "approval",
      actionTarget: { kind: "artifact", id: "artifact-expiry" },
      options: [{ id: "approve", label: "許可", decision: "approve" }],
      expiresAt: "2026-09-08T00:00:01.000Z"
    });
    clock.set("2026-09-08T00:00:02.000Z");
    expect((await service.get({ workspaceId: "workspace-a", accountId: "account-owner" }, { roomId: "room-expiry", requestId: expiring.request.id })).status).toBe("expired");
    await expect(service.respond(contextFor("operation-late"), {
      roomId: "room-expiry", requestId: expiring.request.id, expectedVersion: 1, optionId: "approve"
    })).rejects.toMatchObject({ code: "workspace_interaction_request_expired" });
    const expired = await service.expire(contextFor("operation-expire"), {
      roomId: "room-expiry", requestId: expiring.request.id, expectedVersion: 1
    });
    expect(expired.request.status).toBe("expired");
    expect(expired.request.version).toBe(2);

    const restarted = new WorkspaceInteractionRequestService(store, { clock });
    await expect(restarted.get({ workspaceId: "workspace-a", accountId: "account-owner" }, { roomId: "room-expiry", requestId: expiring.request.id })).resolves.toMatchObject({
      status: "expired",
      version: 2,
      outcome: { kind: "expired" }
    });

    const cancellable = await restarted.create(contextFor("operation-cancellable"), {
      roomId: "room-expiry",
      kind: "backend_input",
      runId: "run-cancellable",
      actionTarget: { kind: "backend_input", id: "input-a" },
      options: [
        { id: "submit", label: "送信", decision: "submit_input" },
        { id: "skip", label: "拒否", decision: "deny" }
      ],
      inputSchema: { type: "object" },
      expiresAt: "2026-09-08T00:10:00.000Z"
    });
    const cancelled = await restarted.cancel(contextFor("operation-cancel"), {
      roomId: "room-expiry", requestId: cancellable.request.id, expectedVersion: 1
    });
    expect(cancelled.request.status).toBe("cancelled");
    expect((await restarted.list({ workspaceId: "workspace-a", accountId: "account-owner" }, { roomId: "room-expiry", includeResolved: true })).map((request) => request.status)).toEqual(expect.arrayContaining(["expired", "cancelled"]));
  });

  it("allows one persistent execution claim, survives a service restart, and settles without exposing input", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const created = await service.create(contextFor("operation-claim-create"), {
      roomId: "room-claim",
      kind: "backend_input",
      runId: "run-claim",
      actionTarget: { kind: "backend_input", run_id: "run-claim", field: "answer" },
      options: [
        { id: "submit", label: "送信", decision: "submit_input" },
        { id: "skip", label: "拒否", decision: "deny" }
      ],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: { answer: { type: "string" } }
      }
    });
    const accepted = await service.respond(contextFor("operation-claim-response"), {
      roomId: "room-claim",
      requestId: created.request.id,
      expectedVersion: 1,
      optionId: "submit",
      values: { answer: "secret answer" }
    });

    const claims = await Promise.allSettled([
      service.claimExecution(contextFor("operation-claim-worker-a"), {
        roomId: "room-claim", requestId: created.request.id, expectedVersion: accepted.request.version,
        ownerId: "worker-a", executionOperationId: "execution-a"
      }),
      service.claimExecution(contextFor("operation-claim-worker-b"), {
        roomId: "room-claim", requestId: created.request.id, expectedVersion: accepted.request.version,
        ownerId: "worker-b", executionOperationId: "execution-b"
      })
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winningClaim = claims.find((result) => result.status === "fulfilled");
    if (winningClaim?.status !== "fulfilled") throw new Error("expected a winning execution claim");
    expect(winningClaim.value.request).toMatchObject({ status: "executing", version: 3 });
    expect(["worker-a", "worker-b"]).toContain(winningClaim.value.claim.ownerId);
    expect(["execution-a", "execution-b"]).toContain(winningClaim.value.claim.executionOperationId);
    expect(winningClaim.value.claim.attempt).toBe(1);
    expect(winningClaim.value.executionInput).toEqual({ answer: "secret answer" });
    expect(winningClaim.value.executionTarget).toEqual({
      roomId: "room-claim",
      runId: "run-claim",
      actionTarget: { kind: "backend_input", run_id: "run-claim", field: "answer" }
    });
    expect(winningClaim.value.request).not.toHaveProperty("executionInput");
    const winningOwnerId = winningClaim.value.claim.ownerId;
    const winningExecutionOperationId = winningClaim.value.claim.executionOperationId;

    const restarted = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const retried = await restarted.claimExecution(contextFor("operation-claim-retry"), {
      roomId: "room-claim", requestId: created.request.id, expectedVersion: 3,
      ownerId: winningOwnerId, executionOperationId: winningExecutionOperationId
    });
    expect(retried.replayed).toBe(true);
    expect(retried.request.execution).toMatchObject({ status: "executing", startedAt: "2026-09-08T00:00:00.000Z" });
    expect(retried.request).not.toHaveProperty("outcome.input");
    expect(retried.executionInput).toEqual({ answer: "secret answer" });
    await expect(restarted.assertExecutionClaim(contextFor("operation-claim-reauthorize"), {
      roomId: "room-claim", requestId: created.request.id, expectedVersion: retried.request.version,
      ownerId: winningOwnerId, executionOperationId: winningExecutionOperationId
    })).resolves.toMatchObject({ status: "executing", version: 3 });

    const settled = await restarted.settleExecution(contextFor("operation-claim-settle"), {
      roomId: "room-claim", requestId: created.request.id, expectedVersion: 3,
      ownerId: winningOwnerId, executionOperationId: winningExecutionOperationId, status: "completed", summary: "Runtime resumed"
    });
    expect(settled.request).toMatchObject({
      status: "completed",
      version: 4,
      execution: { status: "completed", summary: "Runtime resumed" }
    });
    expect(settled.request).not.toHaveProperty("outcome.input");
    expect(settled.request).not.toHaveProperty("executionInput");

    const settleReplay = await restarted.settleExecution(contextFor("operation-claim-settle"), {
      roomId: "room-claim", requestId: created.request.id, expectedVersion: 3,
      ownerId: winningOwnerId, executionOperationId: winningExecutionOperationId, status: "completed", summary: "Runtime resumed"
    });
    expect(settleReplay.replayed).toBe(true);
  });

  it("exposes an unclaimed accepted request with the same stable execution operation after a restart", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock });
    const created = await service.create(contextFor("operation-accepted-recovery-create"), {
      roomId: "room-accepted-recovery",
      kind: "approval",
      surfaceId: "surface-accepted-recovery",
      revisionId: "revision-accepted-recovery",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-accepted-recovery", action_id: "publish" },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    const accepted = await service.respond(contextFor("operation-accepted-recovery-response"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: created.request.version,
      optionId: "approve"
    });

    const restarted = new WorkspaceInteractionRequestService(store, { clock });
    const candidates = await restarted.listAcceptedForRecovery(contextFor("operation-accepted-recovery-scan"), {
      roomId: created.request.roomId,
      limit: 10
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      request: { id: created.request.id, status: "accepted", version: accepted.request.version },
      executionOperationId: workspaceInteractionExecutionOperationId("workspace-a", created.request.id, "initial")
    });

    const claim = await restarted.claimExecution(contextFor("operation-accepted-recovery-claim"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: candidates[0]!.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: candidates[0]!.executionOperationId
    });
    expect(claim.replayed).toBe(false);
    expect(claim.request.status).toBe("executing");
    await expect(restarted.listAcceptedForRecovery(contextFor("operation-accepted-recovery-rescan"), {
      roomId: created.request.roomId,
      limit: 10
    })).resolves.toEqual([]);
  });

  it("returns a claim to accepted after a retryable admission failure and replays the release", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock });
    const created = await service.create(contextFor("operation-release-create"), {
      roomId: "room-release",
      kind: "approval",
      surfaceId: "surface-release",
      revisionId: "revision-release",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-release", action_id: "publish" },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    const accepted = await service.respond(contextFor("operation-release-response"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: created.request.version,
      optionId: "approve"
    });
    const claimed = await service.claimExecution(contextFor("operation-release-claim"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: accepted.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-release"
    });

    const released = await service.releaseExecutionClaim(contextFor("operation-release-release"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: claimed.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-release"
    });
    expect(released).toMatchObject({ replayed: false, request: { status: "accepted", version: 4 } });

    const releaseReplay = await service.releaseExecutionClaim(contextFor("operation-release-release"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: claimed.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-release"
    });
    expect(releaseReplay).toMatchObject({ replayed: true, request: { status: "accepted", version: 4 } });

    const retryClaim = await service.claimExecution(contextFor("operation-release-retry"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: released.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-release"
    });
    expect(retryClaim).toMatchObject({ replayed: false, request: { status: "executing", version: 5 } });
  });

  it("scans beyond the first storage page when recovering accepted requests", async () => {
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock: mutableClock("2026-09-08T00:00:00.000Z") });
    for (let index = 0; index < 501; index += 1) {
      const created = await service.create(contextFor(`operation-accepted-page-${index}`), {
        roomId: "room-accepted-page",
        kind: "approval",
        surfaceId: "surface-accepted-page",
        revisionId: "revision-accepted-page",
        actionTarget: { kind: "generated_surface_action", surface_id: "surface-accepted-page", action_id: "publish" },
        options: [{ id: "approve", label: "許可", decision: "approve" }]
      });
      await service.respond(contextFor(`operation-accepted-page-response-${index}`), {
        roomId: created.request.roomId,
        requestId: created.request.id,
        expectedVersion: created.request.version,
        optionId: "approve"
      });
    }

    const candidates = await service.listAcceptedForRecovery(contextFor("operation-accepted-page-scan"), {
      roomId: "room-accepted-page",
      limit: 501
    });

    expect(candidates).toHaveLength(501);
    expect(store.listOffsets).toEqual([0, 500]);
  });

  it("filters pending requests before applying pagination", async () => {
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock: mutableClock("2026-09-08T00:00:00.000Z") });
    await service.create(contextFor("operation-pending-before-resolved"), {
      roomId: "room-pending-page",
      kind: "approval",
      surfaceId: "surface-pending-page",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-pending-page", action_id: "publish" },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    for (let index = 0; index < 501; index += 1) {
      const created = await service.create(contextFor(`operation-resolved-page-${index}`), {
        roomId: "room-pending-page",
        kind: "approval",
        surfaceId: "surface-resolved-page",
        actionTarget: { kind: "generated_surface_action", surface_id: "surface-resolved-page", action_id: "publish" },
        options: [{ id: "approve", label: "許可", decision: "approve" }]
      });
      await service.respond(contextFor(`operation-resolved-page-response-${index}`), {
        roomId: created.request.roomId,
        requestId: created.request.id,
        expectedVersion: created.request.version,
        optionId: "approve"
      });
    }

    const requests = await service.list(contextFor("operation-pending-page-list"), {
      roomId: "room-pending-page",
      includeResolved: false,
      limit: 100
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.actionTarget).toMatchObject({ surface_id: "surface-pending-page" });
    expect(store.listOffsets).toEqual([0, 500]);
  });

  it("requires explicit stale recovery and records failed execution", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const created = await service.create(contextFor("operation-recovery-create"), {
      roomId: "room-recovery",
      kind: "approval",
      runId: "run-recovery",
      surfaceId: "surface-recovery",
      revisionId: "revision-recovery",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-recovery", action_id: "publish" },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    const accepted = await service.respond(contextFor("operation-recovery-response"), {
      roomId: "room-recovery", requestId: created.request.id, expectedVersion: 1, optionId: "approve"
    });
    const claimed = await service.claimExecution(contextFor("operation-recovery-claim"), {
      roomId: "room-recovery", requestId: created.request.id, expectedVersion: accepted.request.version,
      ownerId: "worker-old", executionOperationId: "execution-old"
    });
    clock.set("2026-09-08T00:00:02.000Z");

    await expect(service.claimExecution(contextFor("operation-recovery-implicit"), {
      roomId: "room-recovery", requestId: created.request.id, expectedVersion: claimed.request.version,
      ownerId: "worker-new", executionOperationId: "execution-new"
    })).rejects.toMatchObject({ code: "workspace_interaction_request_execution_in_progress" });
    const recovered = await service.recoverExecution(contextFor("operation-recovery-explicit"), {
      roomId: "room-recovery", requestId: created.request.id, expectedVersion: claimed.request.version,
      ownerId: "worker-new", executionOperationId: "execution-new"
    });
    expect(recovered.request).toMatchObject({ status: "executing", version: 4, execution: { status: "executing" } });
    expect(recovered.claim.attempt).toBe(2);

    const failed = await service.settleExecution(contextFor("operation-recovery-fail"), {
      roomId: "room-recovery", requestId: created.request.id, expectedVersion: recovered.request.version,
      ownerId: "worker-new", executionOperationId: "execution-new", status: "failed", errorCode: "runtime_timeout"
    });
    expect(failed.request).toMatchObject({ status: "failed", execution: { status: "failed", errorCode: "runtime_timeout" } });

    await expect(service.settleExecution(contextFor("operation-old-settle"), {
      roomId: "room-recovery", requestId: created.request.id, expectedVersion: 4,
      ownerId: "worker-old", executionOperationId: "execution-old", status: "completed", summary: "late"
    })).rejects.toMatchObject({ code: "workspace_interaction_request_execution_already_settled" });
  });

  it("durably expires pending requests and records stale execution as interrupted without retrying it", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const expiring = await service.create(contextFor("operation-maintenance-expiring"), {
      roomId: "room-maintenance",
      kind: "approval",
      surfaceId: "surface-maintenance",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-maintenance", action_id: "publish" },
      options: [{ id: "approve", label: "許可", decision: "approve" }],
      expiresAt: "2026-09-08T00:00:01.000Z"
    });
    const executable = await service.create(contextFor("operation-maintenance-executable"), {
      roomId: "room-maintenance",
      kind: "approval",
      surfaceId: "surface-maintenance",
      actionTarget: { kind: "generic_approval_target", id: "target-maintenance" },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    const accepted = await service.respond(contextFor("operation-maintenance-accept"), {
      roomId: "room-maintenance", requestId: executable.request.id, expectedVersion: 1, optionId: "approve"
    });
    const claimed = await service.claimExecution(contextFor("operation-maintenance-claim"), {
      roomId: "room-maintenance",
      requestId: executable.request.id,
      expectedVersion: accepted.request.version,
      ownerId: "worker-before-restart",
      executionOperationId: "execution-before-restart"
    });

    clock.set("2026-09-08T00:00:02.000Z");
    const reconciled = await service.reconcileRoom(contextFor("operation-maintenance-tick"), {
      roomId: "room-maintenance"
    });

    expect(reconciled).toHaveLength(2);
    const expired = reconciled.find((result) => result.request.id === expiring.request.id);
    const interrupted = reconciled.find((result) => result.request.id === executable.request.id);
    expect(expired).toMatchObject({ request: { status: "expired", version: 2 }, action: "expired" });
    expect(interrupted).toMatchObject({
      request: {
        status: "failed",
        version: 4,
        execution: { status: "failed", errorCode: "workspace_interaction_execution_interrupted" }
      },
      action: "failed"
    });
    if (!expired || !interrupted) throw new Error("expected both maintenance transitions");

    await expect(service.settleExecution(contextFor("operation-maintenance-late-complete"), {
      roomId: "room-maintenance",
      requestId: executable.request.id,
      expectedVersion: claimed.request.version,
      ownerId: "worker-before-restart",
      executionOperationId: "execution-before-restart",
      status: "completed",
      summary: "late completion"
    })).rejects.toMatchObject({ code: "workspace_interaction_request_execution_already_settled" });

    for (const result of [expired, interrupted]) {
      await service.markMaintenanceEventDelivered(
        contextFor(result.deliveryOperationId),
        {
          roomId: "room-maintenance",
          requestId: result.request.id,
          expectedVersion: result.request.version,
          eventOperationId: result.eventOperationId
        }
      );
    }

    const restarted = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    await expect(restarted.get({ workspaceId: "workspace-a", accountId: "account-owner" }, {
      roomId: "room-maintenance", requestId: expiring.request.id
    })).resolves.toMatchObject({ status: "expired" });
    await expect(restarted.get({ workspaceId: "workspace-a", accountId: "account-owner" }, {
      roomId: "room-maintenance", requestId: executable.request.id
    })).resolves.toMatchObject({
      status: "failed",
      execution: { errorCode: "workspace_interaction_execution_interrupted" }
    });
    await expect(restarted.reconcileRoom(contextFor("operation-maintenance-restart"), {
      roomId: "room-maintenance"
    })).resolves.toEqual([]);
  });

  it("leaves a stale Generated Surface claim for result-aware recovery instead of failing it blindly", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const created = await service.create(contextFor("operation-surface-recovery-create"), {
      roomId: "room-surface-recovery",
      kind: "approval",
      surfaceId: "surface-surface-recovery",
      revisionId: "revision-surface-recovery",
      actionTarget: {
        kind: "generated_surface_action",
        room_id: "room-surface-recovery",
        surface_id: "surface-surface-recovery",
        revision_id: "revision-surface-recovery",
        action_id: "publish",
        command_id: "artifact.create",
        payload: {}
      },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    const accepted = await service.respond(contextFor("operation-surface-recovery-response"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: created.request.version,
      optionId: "approve"
    });
    const claimed = await service.claimExecution(contextFor("operation-surface-recovery-claim"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: accepted.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-surface-before-stop"
    });
    clock.set("2026-09-08T00:00:02.000Z");

    await expect(service.reconcileRoom(contextFor("operation-surface-recovery-reconcile"), {
      roomId: created.request.roomId,
      limit: 10
    })).resolves.toEqual([]);

    const candidates = await service.listAcceptedForRecovery(contextFor("operation-surface-recovery-scan"), {
      roomId: created.request.roomId,
      limit: 10
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      request: { id: created.request.id, status: "executing", version: claimed.request.version },
      executionOperationId: "execution-surface-before-stop"
    });
    expect(await service.get(contextFor("operation-surface-recovery-read"), {
      roomId: created.request.roomId,
      requestId: created.request.id
    })).toMatchObject({ status: "executing", version: claimed.request.version });
  });

  it("preserves the first durable target-result lookup candidate across repeated recovery after restart", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const created = await service.create(contextFor("operation-provenance-create"), {
      roomId: "room-provenance",
      kind: "approval",
      surfaceId: "surface-provenance",
      revisionId: "revision-provenance",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-provenance", action_id: "publish" },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    const accepted = await service.respond(contextFor("operation-provenance-response"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: created.request.version,
      optionId: "approve"
    });
    const initial = await service.claimExecution(contextFor("operation-provenance-claim"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: accepted.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-provenance-initial"
    });
    expect(initial.executionTargetResultLookup).toEqual({
      operationIds: ["execution-provenance-initial"]
    });
    expect(initial.request).not.toHaveProperty("executionTargetResultLookup");

    clock.set("2026-09-08T00:00:02.000Z");
    const firstRecovery = await service.recoverExecution(contextFor("operation-provenance-recovery-1"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: initial.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-provenance-recovery-1"
    });
    expect(firstRecovery.executionTargetResultLookup).toEqual({
      operationIds: ["execution-provenance-initial", "execution-provenance-recovery-1"]
    });

    clock.set("2026-09-08T00:00:04.000Z");
    const restarted = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const secondRecovery = await restarted.recoverExecution(contextFor("operation-provenance-recovery-2"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: firstRecovery.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-provenance-recovery-2"
    });

    expect(secondRecovery.executionTargetResultLookup).toEqual({
      operationIds: [
        "execution-provenance-initial",
        "execution-provenance-recovery-1",
        "execution-provenance-recovery-2"
      ]
    });
    expect(secondRecovery.request).not.toHaveProperty("executionTargetResultLookup");
    await expect(restarted.getExecutionTargetResultLookup(contextFor("operation-provenance-internal-read"), {
      roomId: created.request.roomId,
      requestId: created.request.id
    })).resolves.toEqual({
      operationIds: [
        "execution-provenance-initial",
        "execution-provenance-recovery-1",
        "execution-provenance-recovery-2"
      ]
    });
    const persisted = await store.getRecord(contextFor("operation-provenance-read"), {
      roomId: created.request.roomId,
      recordType: WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE,
      id: created.request.id
    });
    expect(persisted.payload).toMatchObject({
      execution: {
        target_result_lookup_operation_ids: [
          "execution-provenance-initial",
          "execution-provenance-recovery-1",
          "execution-provenance-recovery-2"
        ]
      }
    });
  });

  it("derives durable target-result provenance from a legacy execution record", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const created = await service.create(contextFor("operation-legacy-provenance-create"), {
      roomId: "room-legacy-provenance",
      kind: "approval",
      surfaceId: "surface-legacy-provenance",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-legacy-provenance", action_id: "publish" },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    const accepted = await service.respond(contextFor("operation-legacy-provenance-response"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: created.request.version,
      optionId: "approve"
    });
    const claimed = await service.claimExecution(contextFor("operation-legacy-provenance-claim"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: accepted.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-legacy-initial"
    });
    store.omitTargetResultLookupOperationIds(created.request.id);

    const restarted = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const replayed = await restarted.claimExecution(contextFor("operation-legacy-provenance-replay"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: claimed.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-legacy-initial"
    });
    expect(replayed.executionTargetResultLookup).toEqual({
      operationIds: ["execution-legacy-initial"]
    });

    clock.set("2026-09-08T00:00:02.000Z");
    const recovered = await restarted.recoverExecution(contextFor("operation-legacy-provenance-recovery"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: claimed.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-legacy-recovery"
    });
    expect(recovered.executionTargetResultLookup).toEqual({
      operationIds: ["execution-legacy-initial", "execution-legacy-recovery"]
    });
  });

  it("fails closed instead of truncating bounded target-result provenance", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    const created = await service.create(contextFor("operation-provenance-limit-create"), {
      roomId: "room-provenance-limit",
      kind: "approval",
      surfaceId: "surface-provenance-limit",
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-provenance-limit", action_id: "publish" },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    const accepted = await service.respond(contextFor("operation-provenance-limit-response"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: created.request.version,
      optionId: "approve"
    });
    const claimed = await service.claimExecution(contextFor("operation-provenance-limit-claim"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: accepted.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-provenance-limit-current"
    });
    store.setTargetResultLookupOperationIds(created.request.id, [
      ...Array.from({ length: 31 }, (_, index) => `execution-provenance-limit-${index}`),
      "execution-provenance-limit-current"
    ]);
    clock.set("2026-09-08T00:00:02.000Z");

    await expect(service.recoverExecution(contextFor("operation-provenance-limit-recovery"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: claimed.request.version,
      ownerId: "workspace-server-interaction-executor",
      executionOperationId: "execution-provenance-limit-next"
    })).rejects.toMatchObject({
      code: "workspace_interaction_execution_provenance_limit_exceeded",
      status: 409
    });

    const terminal = await service.failStaleExecution(contextFor("operation-provenance-limit-terminal"), {
      roomId: created.request.roomId,
      requestId: created.request.id,
      expectedVersion: claimed.request.version,
      executionOperationId: claimed.claim.executionOperationId,
      errorCode: "workspace_interaction_execution_provenance_limit_exceeded"
    });
    expect(terminal).toMatchObject({
      replayed: false,
      request: {
        status: "failed",
        execution: {
          status: "failed",
          errorCode: "workspace_interaction_execution_provenance_limit_exceeded"
        }
      }
    });

    const restarted = new WorkspaceInteractionRequestService(store, { clock, executionLeaseMs: 1_000 });
    await expect(restarted.get(contextFor("operation-provenance-limit-terminal-read"), {
      roomId: created.request.roomId,
      requestId: created.request.id
    })).resolves.toMatchObject({
      status: "failed",
      execution: { errorCode: "workspace_interaction_execution_provenance_limit_exceeded" }
    });
    await expect(restarted.listAcceptedForRecovery(contextFor("operation-provenance-limit-terminal-scan"), {
      roomId: created.request.roomId,
      limit: 10
    })).resolves.toEqual([]);
  });

  it("rejects execution claims for expired and cancelled requests", async () => {
    const clock = mutableClock("2026-09-08T00:00:00.000Z");
    const store = new MemoryInteractionRecordStore();
    const service = new WorkspaceInteractionRequestService(store, { clock });
    const expired = await service.create(contextFor("operation-claim-expired-create"), {
      roomId: "room-claim-terminal",
      kind: "approval",
      actionTarget: { kind: "artifact", id: "artifact-expired" },
      options: [{ id: "approve", label: "許可", decision: "approve" }],
      expiresAt: "2026-09-08T00:00:01.000Z"
    });
    clock.set("2026-09-08T00:00:02.000Z");
    await expect(service.respond(contextFor("operation-claim-expired-response"), {
      roomId: "room-claim-terminal", requestId: expired.request.id, expectedVersion: 1, optionId: "approve"
    })).rejects.toMatchObject({ code: "workspace_interaction_request_expired" });
    await service.expire(contextFor("operation-claim-expire"), {
      roomId: "room-claim-terminal", requestId: expired.request.id, expectedVersion: 1
    });
    await expect(service.claimExecution(contextFor("operation-claim-expired-claim"), {
      roomId: "room-claim-terminal", requestId: expired.request.id, expectedVersion: 2,
      ownerId: "worker", executionOperationId: "execution-expired"
    })).rejects.toMatchObject({ code: "workspace_interaction_request_not_accepted" });

    const cancelled = await service.create(contextFor("operation-claim-cancelled-create"), {
      roomId: "room-claim-terminal",
      kind: "approval",
      actionTarget: { kind: "artifact", id: "artifact-cancelled" },
      options: [{ id: "approve", label: "許可", decision: "approve" }]
    });
    await service.cancel(contextFor("operation-claim-cancel"), {
      roomId: "room-claim-terminal", requestId: cancelled.request.id, expectedVersion: 1
    });
    await expect(service.claimExecution(contextFor("operation-claim-cancelled-claim"), {
      roomId: "room-claim-terminal", requestId: cancelled.request.id, expectedVersion: 2,
      ownerId: "worker", executionOperationId: "execution-cancelled"
    })).rejects.toMatchObject({ code: "workspace_interaction_request_not_accepted" });
  });
});

function contextFor(operationId: string, accountId = "account-owner"): WorkspaceRequestContext {
  return { workspaceId: "workspace-a", accountId, operationId };
}

function mutableClock(initial: string): (() => Date) & { set(value: string): void } {
  let value = new Date(initial);
  const clock = (() => new Date(value)) as (() => Date) & { set(value: string): void };
  clock.set = (next: string) => { value = new Date(next); };
  return clock;
}

class MemoryInteractionRecordStore implements WorkspaceInteractionRequestRecordStore {
  private readonly records = new Map<string, WorkspaceRecord>();
  private readonly operations = new Map<string, { requestHash: string; result: PutRecordResult }>();
  readonly listOffsets: number[] = [];
  executionCount = 0;
  resumeCount = 0;

  async getRecord(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; recordType: string; id: string }): Promise<WorkspaceRecord> {
    const record = this.records.get(this.key(context.workspaceId, input.recordType, input.id));
    if (!record || record.roomId !== input.roomId) throw new WorkspaceServerError("workspace_record_not_found", 404);
    return cloneRecord(record);
  }

  async listRecords(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; recordType?: string; limit?: number; offset?: number }): Promise<WorkspaceRecord[]> {
    this.listOffsets.push(input.offset ?? 0);
    const limit = Math.min(input.limit ?? 100, 500);
    return [...this.records.values()]
      .filter((record) => record.workspaceId === context.workspaceId && record.roomId === input.roomId && (!input.recordType || record.recordType === input.recordType))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(input.offset ?? 0, (input.offset ?? 0) + limit)
      .map(cloneRecord);
  }

  async putRecord(context: WorkspaceRequestContext, input: PutRecordInput): Promise<PutRecordResult> {
    this.executionCount += 1;
    const operationKey = `${context.workspaceId}:${context.operationId}`;
    const requestHash = canonicalJson({ ...input, payload: input.payload });
    const previous = this.operations.get(operationKey);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new WorkspaceServerError("workspace_operation_id_reused", 409);
      return { ...cloneResult(previous.result), replayed: true };
    }
    await Promise.resolve();
    const key = this.key(context.workspaceId, input.recordType, input.id);
    const current = this.records.get(key);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== input.expectedVersion) throw new WorkspaceServerError("workspace_record_version_conflict", 409);
    const now = current?.updatedAt ?? "2026-09-08T00:00:00.000Z";
    const record: WorkspaceRecord = {
      workspaceId: context.workspaceId,
      roomId: input.roomId,
      recordType: input.recordType,
      id: input.id,
      version: currentVersion + 1,
      payload: structuredClone(input.payload),
      contentHash: "test-hash",
      createdAt: current?.createdAt ?? now,
      updatedAt: current ? "2026-09-08T00:00:01.000Z" : now
    };
    this.records.set(key, record);
    const result: PutRecordResult = {
      record: cloneRecord(record),
      event: {} as PutRecordResult["event"],
      replayed: false
    };
    this.operations.set(operationKey, { requestHash, result: cloneResult(result) });
    return result;
  }

  omitTargetResultLookupOperationIds(requestId: string): void {
    this.updateExecutionPayload(requestId, (execution) => {
      delete execution.target_result_lookup_operation_ids;
    });
  }

  setTargetResultLookupOperationIds(requestId: string, operationIds: string[]): void {
    this.updateExecutionPayload(requestId, (execution) => {
      execution.target_result_lookup_operation_ids = [...operationIds];
    });
  }

  private updateExecutionPayload(requestId: string, update: (execution: Record<string, unknown>) => void): void {
    const key = this.key("workspace-a", WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE, requestId);
    const record = this.records.get(key);
    if (!record || !record.payload.execution || typeof record.payload.execution !== "object" || Array.isArray(record.payload.execution)) {
      throw new Error("expected an execution payload");
    }
    const payload = structuredClone(record.payload) as Record<string, unknown>;
    const execution = payload.execution;
    if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
      throw new Error("expected an execution payload");
    }
    update(execution as Record<string, unknown>);
    this.records.set(key, { ...record, payload });
  }

  private key(workspaceId: string, recordType: string, id: string): string {
    return `${workspaceId}:${recordType}:${id}`;
  }
}

function cloneRecord(record: WorkspaceRecord): WorkspaceRecord {
  return { ...record, payload: structuredClone(record.payload) };
}

function cloneResult(result: PutRecordResult): PutRecordResult {
  return { ...result, record: cloneRecord(result.record) };
}
