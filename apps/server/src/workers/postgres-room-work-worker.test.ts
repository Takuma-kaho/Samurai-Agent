import { describe, expect, it, vi } from "vitest";
import type { PostgresRuntimeCommandService } from "../adapters/runtime/postgres-runtime-chat";
import type { WorkspaceRequestContext, WorkspaceServerStore } from "@samurai-agent/workspace-server";
import { PostgresRoomWorkWorker } from "./postgres-room-work-worker";

const context: WorkspaceRequestContext = {
  workspaceId: "workspace_one",
  accountId: "account_one",
  operationId: "worker_tick_one"
};

function runtimeFake(status: "completed" | "outcome_unknown" = "completed") {
  const createSession = vi.fn(async (_input?: Record<string, unknown>) => ({ id: "session_internal_only" }));
  const runChatTurn = vi.fn(async (_input?: Record<string, unknown>) => ({ backendRun: { id: "run_one", status, output_summary: status === "completed" ? "done" : null } }));
  const runDomainCommand = vi.fn(async (command: Record<string, any>) => {
    if (command.operationId === "session.create") {
      return createSession({
        roomId: command.input.room_id,
        operationId: command.context.idempotencyKey,
        title: command.input.title
      });
    }
    const input = command.input as Record<string, any>;
    return runChatTurn({
      sessionId: command.context.sessionId,
      content: input.content,
      ...(input.agent_id ? { agentId: input.agent_id } : {}),
      ...(Array.isArray(input.attachments) && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      ...(command.executionBinding ? { executionBinding: command.executionBinding } : {}),
      ...(command.resumeBackendContinuation ? { resumeBackendContinuation: command.resumeBackendContinuation } : {}),
      idempotencyKey: command.context.idempotencyKey,
      signal: command.signal
    });
  });
  const runtime = { createSession, runChatTurn, runDomainCommand };
  return runtime as unknown as PostgresRuntimeCommandService;
}

function reservation() {
  return {
    work_id: "work_one",
    assignee_id: "assignee_one",
    room_id: "room_one",
    agent_id: "agent_one",
    instruction: "Do the work",
    attachments: [],
    generation: 2,
    version: 3,
    agent_configuration_version: 4,
    reservation_id: "reservation_one",
    lease_owner: "worker_one"
  };
}

describe("PostgresRoomWorkWorker", () => {
  it("claims a Room assignment, creates the internal Session, and settles the same generation", async () => {
    const settle = vi.fn(async () => undefined);
    const claim = vi.fn()
      .mockResolvedValueOnce(reservation())
      .mockResolvedValueOnce(undefined);
    const store = { claimRoomWorkReservation: claim, settleRoomWorkAssignment: settle } as unknown as WorkspaceServerStore;
    const runtime = runtimeFake();
    const worker = new PostgresRoomWorkWorker({
      store,
      runtimeFor: vi.fn(() => runtime)
    });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 10, signal: new AbortController().signal });

    expect(result).toEqual({ claimed: 1, completed: 1, outcomeUnknown: 0 });
    expect(claim).toHaveBeenCalledWith(context, expect.objectContaining({ workerId: "worker_one", limit: 1 }));
    expect(runtime.runDomainCommand).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operationId: "session.create",
      context: expect.objectContaining({
        inputSource: "automation",
        workspaceId: context.workspaceId,
        actorId: context.accountId,
        roomId: "room_one",
        correlationId: expect.stringMatching(/^room_work_run_[a-f0-9]{48}:session$/),
        idempotencyKey: expect.stringMatching(/^room_work_run_[a-f0-9]{48}:session$/)
      }),
      input: { room_id: "room_one", title: "Do the work" }
    }));
    expect(runtime.runDomainCommand).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operationId: "chat.turn.run",
      context: expect.objectContaining({
        inputSource: "automation",
        roomId: "room_one",
        sessionId: "session_internal_only",
        correlationId: expect.stringMatching(/^room_work_run_[a-f0-9]{48}$/),
        idempotencyKey: expect.stringMatching(/^room_work_run_[a-f0-9]{48}$/)
      }),
      input: { content: "Do the work", agent_id: "agent_one", attachments: [] },
      executionBinding: {
        workId: "work_one",
        assigneeId: "assignee_one",
        generation: 2,
        agentConfigurationVersion: 4,
        reservationId: "reservation_one",
        leaseOwner: "worker_one"
      },
      signal: expect.any(AbortSignal)
    }));
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room_one" }));
    expect(runtime.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_internal_only",
      content: "Do the work",
      agentId: "agent_one",
      executionBinding: {
        workId: "work_one",
        assigneeId: "assignee_one",
        generation: 2,
        agentConfigurationVersion: 4,
        reservationId: "reservation_one",
        leaseOwner: "worker_one"
      }
    }));
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      operationId: expect.stringMatching(/^room_work_run_[a-f0-9]{48}$/)
    }), expect.objectContaining({
      workId: "work_one",
      assigneeId: "assignee_one",
      assignmentId: "assignee_one",
      generation: 2,
      reservationId: "reservation_one",
      leaseOwner: "worker_one",
      runId: "run_one",
      status: "completed"
    }));
  });

  it("reconciles a recovered terminal Runtime Run without launching it again", async () => {
    const settle = vi.fn(async () => undefined);
    const getBackendRun = vi.fn(async (runId: string) => ({
      id: runId,
      status: "completed",
      output_summary: "recovered result"
    }));
    const runDomainCommand = vi.fn();
    const runtime = { getBackendRun, runDomainCommand } as unknown as PostgresRuntimeCommandService;
    const store = {
      claimRoomWorkReservation: vi.fn().mockResolvedValueOnce({
        ...reservation(),
        current_run_id: "run_recovered"
      }),
      settleRoomWorkAssignment: settle
    } as unknown as WorkspaceServerStore;
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    const result = await worker.runTick(context, {
      workerId: "worker_one",
      maxRuns: 1,
      signal: new AbortController().signal
    });

    expect(result).toEqual({ claimed: 1, completed: 1, outcomeUnknown: 0 });
    expect(getBackendRun).toHaveBeenCalledWith("run_recovered");
    expect(runDomainCommand).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "completed",
      runId: "run_recovered",
      result: expect.objectContaining({ recovery: true, runtime_run_id: "run_recovered" })
    }));
  });

  it("keeps a recovered non-terminal Runtime Run outcome_unknown and does not relaunch", async () => {
    const settle = vi.fn(async () => undefined);
    const getBackendRun = vi.fn(async (runId: string) => ({ id: runId, status: "running", output_summary: null }));
    const runDomainCommand = vi.fn();
    const runtime = { getBackendRun, runDomainCommand } as unknown as PostgresRuntimeCommandService;
    const store = {
      claimRoomWorkReservation: vi.fn().mockResolvedValueOnce({
        ...reservation(),
        current_run_id: "run_still_running"
      }),
      settleRoomWorkAssignment: settle
    } as unknown as WorkspaceServerStore;
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    const result = await worker.runTick(context, {
      workerId: "worker_one",
      maxRuns: 1,
      signal: new AbortController().signal
    });

    expect(result).toEqual({ claimed: 1, completed: 0, outcomeUnknown: 1 });
    expect(runDomainCommand).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "outcome_unknown",
      runId: "run_still_running"
    }));
  });

  it("reuses the parent assignment's internal Session for a continuation", async () => {
    const settle = vi.fn(async () => undefined);
    const claim = vi.fn().mockResolvedValueOnce({ ...reservation(), session_id: "session_parent" });
    const store = { claimRoomWorkReservation: claim, settleRoomWorkAssignment: settle } as unknown as WorkspaceServerStore;
    const runtime = runtimeFake();
    const worker = new PostgresRoomWorkWorker({
      store,
      runtimeFor: vi.fn(() => runtime)
    });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(result).toEqual({ claimed: 1, completed: 1, outcomeUnknown: 0 });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_parent",
      content: "Do the work"
    }));
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "completed", runId: "run_one" }));
  });

  it("passes safe relative file refs to Runtime without narrowing them to attachments", async () => {
    const settle = vi.fn(async () => undefined);
    const claim = vi.fn().mockResolvedValueOnce({
      ...reservation(),
      attachments: [{ kind: "file", id: "a".repeat(64), uri: "notes/brief.md", version: "1" }]
    });
    const store = { claimRoomWorkReservation: claim, settleRoomWorkAssignment: settle } as unknown as WorkspaceServerStore;
    const runtime = runtimeFake();
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(runtime.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{ kind: "file", id: "a".repeat(64), uri: "notes/brief.md", version: "1" }]
    }));
  });

  it("fails closed instead of executing when a claimed attachment ref is malformed", async () => {
    const settle = vi.fn(async () => undefined);
    const store = {
      claimRoomWorkReservation: vi.fn().mockResolvedValueOnce({
        ...reservation(),
        attachments: [{ kind: "file", id: "not-a-hash", uri: "notes/brief.md" }]
      }),
      settleRoomWorkAssignment: settle
    } as unknown as WorkspaceServerStore;
    const runtime = runtimeFake();
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(result).toEqual({ claimed: 1, completed: 0, outcomeUnknown: 0 });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.runChatTurn).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "failed",
      errorCode: "room_work_attachment_reference_invalid"
    }));
  });

  it("fails closed when hydrated instruction attachments contain an invalid ref", async () => {
    const settle = vi.fn(async () => undefined);
    const store = {
      claimRoomWorkReservation: vi.fn().mockResolvedValueOnce({
        ...reservation(),
        instruction: undefined,
        attachments: undefined
      }),
      viewRoomWork: vi.fn(async () => ({
        view: {
          assignments: [{ id: "assignee_one", agent_id: "agent_one", generation: 2 }],
          instructions: [{
            assignment_id: "assignee_one",
            body: "Hydrated work",
            attachments: [{ kind: "file", id: "a".repeat(64), uri: "notes/../secret.md", version: "1" }]
          }]
        }
      })),
      settleRoomWorkAssignment: settle
    } as unknown as WorkspaceServerStore;
    const runtime = runtimeFake();
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.runChatTurn).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "failed",
      errorCode: "room_work_attachment_reference_invalid"
    }));
  });

  it("passes the parent provider SessionRef to the Backend resume path", async () => {
    const settle = vi.fn(async () => undefined);
    const claim = vi.fn().mockResolvedValueOnce({
      ...reservation(),
      session_id: "session_parent",
      parent_assignee_id: "assignee_parent",
      resume_backend_continuation: {
        backend_session_id: "claude-session-parent",
        parent: {
          workspace_id: context.workspaceId,
          room_id: "room_one",
          session_id: "session_parent",
          work_id: "work_one",
          assignee_id: "assignee_parent",
          agent_id: "agent_one",
          agent_configuration_version: 4,
          backend_id: "claude-code",
          generation: 2
        }
      },
      // A legacy/raw provider reference must never cross the Room-work worker
      // boundary, even when an old Store row still contains one.
      resume_backend_session_id: "untrusted-provider-session"
    });
    const store = { claimRoomWorkReservation: claim, settleRoomWorkAssignment: settle } as unknown as WorkspaceServerStore;
    const runtime = runtimeFake();
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(runtime.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_parent",
      executionBinding: expect.objectContaining({ parentAssigneeId: "assignee_parent" }),
      resumeBackendContinuation: {
        backendSessionId: "claude-session-parent",
        parent: {
          workspaceId: context.workspaceId,
          roomId: "room_one",
          sessionId: "session_parent",
          workId: "work_one",
          assigneeId: "assignee_parent",
          agentId: "agent_one",
          agentConfigurationVersion: 4,
          backendId: "claude-code",
          generation: 2
        }
      }
    }));
    const runInput = (runtime.runChatTurn as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]?.[0];
    expect(runInput).not.toHaveProperty("resumeBackendSessionId");
  });

  it("never reuses a parent Session supplied on a delegated child reservation", async () => {
    const settle = vi.fn(async () => undefined);
    const claim = vi.fn().mockResolvedValueOnce({
      ...reservation(),
      origin_kind: "delegated",
      session_id: "session_parent_should_not_cross",
      parent_assignee_id: "assignee_parent_should_not_cross",
      resume_backend_continuation: {
        backend_session_id: "backend_parent_should_not_cross",
        parent: {
          workspace_id: context.workspaceId,
          room_id: "room_one",
          session_id: "session_parent_should_not_cross",
          work_id: "work_one",
          assignee_id: "assignee_parent_should_not_cross",
          agent_id: "agent_one",
          agent_configuration_version: 4,
          backend_id: "claude-code",
          generation: 2
        }
      }
    });
    const store = { claimRoomWorkReservation: claim, settleRoomWorkAssignment: settle } as unknown as WorkspaceServerStore;
    const runtime = runtimeFake();
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room_one" }));
    expect(runtime.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_internal_only",
      executionBinding: expect.not.objectContaining({ parentAssigneeId: expect.anything() })
    }));
    const runInput = (runtime.runChatTurn as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]?.[0];
    expect(runInput).not.toHaveProperty("resumeBackendContinuation");
  });

  it("keeps an unknown runtime outcome separate from a confirmed stop", async () => {
    const settle = vi.fn(async () => undefined);
    const store = {
      claimRoomWorkReservation: vi.fn()
        .mockResolvedValueOnce(reservation())
        .mockResolvedValueOnce(undefined),
      settleRoomWorkAssignment: settle
    } as unknown as WorkspaceServerStore;
    const runtime = runtimeFake("outcome_unknown");
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    const result = await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(result.outcomeUnknown).toBe(1);
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ operationId: expect.stringMatching(/^room_work_run_[a-f0-9]{48}$/) }), expect.objectContaining({ status: "outcome_unknown" }));
  });

  it("dispatches an active Room-work stop through Runtime in the independent stop lane", async () => {
    const cancelBackendRun = vi.fn(async () => ({ id: "run_active", status: "cancelled" }));
    const executeRunControlAction = vi.fn(async ({ runId }: { runId: string }) => cancelBackendRun(runId));
    const runtime = {
      createSession: vi.fn(async () => ({ id: "session_internal_only" })),
      runChatTurn: vi.fn(),
      cancelBackendRun,
      executeRunControlAction
    } as unknown as PostgresRuntimeCommandService;
    const claimStop = vi.fn()
      .mockResolvedValueOnce({
        control_id: "control_active_stop",
        work_id: "work_one",
        targets: [{ assignment_id: "assignee_one", run_id: "run_active" }]
      });
    const reconcileStop = vi.fn(async () => ({ state: "confirmed" }));
    const claimLaunch = vi.fn(async () => undefined);
    const store = {
      claimRoomWorkStopDispatch: claimStop,
      reconcileRoomWorkStopDispatch: reconcileStop,
      claimRoomWorkReservation: claimLaunch,
      settleRoomWorkAssignment: vi.fn(async () => undefined)
    } as unknown as WorkspaceServerStore;
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    await worker.runStopTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(claimStop).toHaveBeenCalledWith(context, expect.objectContaining({ workerId: "worker_one", limit: 1 }));
    expect(cancelBackendRun).toHaveBeenCalledWith("run_active");
    expect(executeRunControlAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "cancel",
      runId: "run_active",
      resumeInput: {},
      idempotencyKey: expect.stringMatching(/^room_work_stop_[a-f0-9]{48}:cancel:assignee_one$/)
    }));
    expect(reconcileStop).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: expect.stringMatching(/^room_work_stop_[a-f0-9]{48}$/) }),
      expect.objectContaining({
        controlId: "control_active_stop",
        workerId: "worker_one",
        assignmentId: "assignee_one",
        runId: "run_active",
        outcome: "cancelled"
      })
    );
    expect(claimLaunch).not.toHaveBeenCalled();
    expect((runtime.runChatTurn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("records an unconfirmed stop when Runtime cancellation cannot be proven", async () => {
    const cancelBackendRun = vi.fn(async () => { throw new Error("backend_cancel_unconfirmed"); });
    const executeRunControlAction = vi.fn(async ({ runId }: { runId: string }) => cancelBackendRun(runId));
    const runtime = {
      createSession: vi.fn(async () => ({ id: "session_internal_only" })),
      runChatTurn: vi.fn(),
      cancelBackendRun,
      executeRunControlAction
    } as unknown as PostgresRuntimeCommandService;
    const reconcileStop = vi.fn(async () => ({ state: "unconfirmed" }));
    const store = {
      claimRoomWorkStopDispatch: vi.fn().mockResolvedValueOnce({
        control_id: "control_unconfirmed_stop",
        work_id: "work_one",
        targets: [{ assignment_id: "assignee_one", run_id: "run_active" }]
      }),
      reconcileRoomWorkStopDispatch: reconcileStop,
      claimRoomWorkReservation: vi.fn(async () => undefined),
      settleRoomWorkAssignment: vi.fn(async () => undefined)
    } as unknown as WorkspaceServerStore;
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    await worker.runStopTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(reconcileStop).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      controlId: "control_unconfirmed_stop",
      outcome: "outcome_unknown"
    }));
  });

  it("propagates a settlement failure after a backend result without retrying it as failed", async () => {
    const settlementError = new Error("room_work_settlement_unavailable");
    const settle = vi.fn(async () => { throw settlementError; });
    const store = {
      claimRoomWorkReservation: vi.fn().mockResolvedValueOnce(reservation()),
      settleRoomWorkAssignment: settle
    } as unknown as WorkspaceServerStore;
    const runtime = runtimeFake();
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    await expect(worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal }))
      .rejects.toBe(settlementError);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "completed" }));
  });

  it("propagates a settlement failure while recording a runtime failure", async () => {
    const runtimeError = new Error("provider_failed");
    const settlementError = new Error("room_work_settlement_unavailable");
    const runDomainCommand = vi.fn(async (command: Record<string, any>) => {
      if (command.operationId === "session.create") return { id: "session_internal_only" };
      throw runtimeError;
    });
    const runtime = {
      createSession: vi.fn(async () => ({ id: "session_internal_only" })),
      runChatTurn: vi.fn(async () => { throw runtimeError; }),
      runDomainCommand
    } as unknown as PostgresRuntimeCommandService;
    const settle = vi.fn(async () => { throw settlementError; });
    const store = {
      claimRoomWorkReservation: vi.fn().mockResolvedValueOnce(reservation()),
      settleRoomWorkAssignment: settle
    } as unknown as WorkspaceServerStore;
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    await expect(worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal }))
      .rejects.toBe(settlementError);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "failed", errorCode: "room_work_runtime_failed" }));
  });

  it("does not start Runtime when the claimed lease evidence is incomplete", async () => {
    const runtime = runtimeFake();
    const store = {
      claimRoomWorkReservation: vi.fn()
        .mockResolvedValueOnce({ ...reservation(), lease_owner: undefined })
        .mockResolvedValueOnce(undefined),
      settleRoomWorkAssignment: vi.fn(async () => undefined)
    } as unknown as WorkspaceServerStore;
    const worker = new PostgresRoomWorkWorker({ store, runtimeFor: () => runtime });

    await worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal });

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.runChatTurn).not.toHaveBeenCalled();
  });

  it("fails closed when the Room-work reservation API is not installed", async () => {
    const worker = new PostgresRoomWorkWorker({
      store: {} as WorkspaceServerStore,
      runtimeFor: vi.fn()
    });

    await expect(worker.runTick(context, { workerId: "worker_one", maxRuns: 1, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "room_work_worker_store_api_unavailable", status: 503 });
  });
});
