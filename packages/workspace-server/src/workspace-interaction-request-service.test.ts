import { describe, expect, it } from "vitest";
import { canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import {
  WORKSPACE_INTERACTION_REQUEST_RECORD_TYPE,
  WorkspaceInteractionRequestService,
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
      actionTarget: { kind: "generated_surface_action", surface_id: "surface-maintenance", action_id: "publish" },
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
  executionCount = 0;
  resumeCount = 0;

  async getRecord(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; recordType: string; id: string }): Promise<WorkspaceRecord> {
    const record = this.records.get(this.key(context.workspaceId, input.recordType, input.id));
    if (!record || record.roomId !== input.roomId) throw new WorkspaceServerError("workspace_record_not_found", 404);
    return cloneRecord(record);
  }

  async listRecords(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; recordType?: string; limit?: number }): Promise<WorkspaceRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.workspaceId === context.workspaceId && record.roomId === input.roomId && (!input.recordType || record.recordType === input.recordType))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, input.limit ?? 100)
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
