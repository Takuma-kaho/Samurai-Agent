import { describe, expect, it, vi } from "vitest";
import type { HumanWorkObjectiveRecord, RoomWorkAssignmentRecord } from "@samurai-agent/core-schemas";
import {
  DurableWorkCoordinator,
  type DurableWorkStorePort,
  type HumanWorkOrchestrationPort
} from "./durable-work-coordinator";

const now = "2026-01-01T00:00:00.000Z";

function humanObjective(): HumanWorkObjectiveRecord {
  return {
    id: "work-1",
    kind: "human",
    workspace_id: "workspace-1",
    room_id: "room-1",
    requester_id: "human-1",
    front_agent_id: "agent-1",
    default_agent_id: "agent-1",
    default_agent_version: 1,
    current_instruction_version: 1,
    control_generation: 1,
    created_operation_id: "operation-1",
    title: "Human work",
    objective: "Produce the requested result.",
    completion_criteria: ["The result is reviewed."],
    status: "active",
    created_at: now,
    updated_at: now
  };
}

function emptyStore(objective: HumanWorkObjectiveRecord): DurableWorkStorePort {
  return {
    getObjective: vi.fn(async () => objective),
    listWorkItems: vi.fn(async () => []),
    saveObjective: vi.fn(async (record) => record),
    saveWorkItem: vi.fn(async (record) => record),
    getBackendRun: vi.fn(async () => undefined),
    getWorkItem: vi.fn(async () => undefined),
    saveWorkDependency: vi.fn(async (record) => record)
  };
}

describe("DurableWorkCoordinator human Work boundary", () => {
  it("delegates stop request to the atomic human-work port", async () => {
    const requestHumanWorkStop = vi.fn(async (input: unknown) => ({ input, state: "accepted" }));
    const humanWork: HumanWorkOrchestrationPort = { requestHumanWorkStop };
    const coordinator = new DurableWorkCoordinator(
      emptyStore(humanObjective()),
      { cancelRun: vi.fn(async () => { throw new Error("generic cancellation must not run"); }) },
      humanWork
    );

    const result = await coordinator.transitionHumanWorkStop({
      work: {
        id: "work-1",
        workspace_id: "workspace-1",
        room_id: "room-1",
        kind: "human",
        requester_id: "human-1",
        front_agent_id: "agent-1",
        default_agent_id: "agent-1",
        default_agent_version: 1,
        title: "Human work",
        objective: "Produce the requested result.",
        completion_criteria: ["The result is reviewed."],
        status: "running",
        stop_state: "none",
        instruction_version: 1,
        control_generation: 1,
        operation_id: "operation-1",
        created_at: now,
        updated_at: now
      },
      assignments: [],
      action: "request",
      actorAccountId: "human-1",
      operationId: "stop-operation",
      now
    });

    expect(result).toMatchObject({ state: "accepted" });
    expect(requestHumanWorkStop).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      roomId: "room-1",
      workId: "work-1",
      operationId: "stop-operation"
    });
  });

  it("rejects generic Objective cancel before Store rows or runs are touched", async () => {
    const store = emptyStore(humanObjective());
    const cancelRun = vi.fn();
    const coordinator = new DurableWorkCoordinator(store, { cancelRun });

    await expect(coordinator.transitionObjective("work-1", "cancel", "room-1", now))
      .rejects.toThrow("human_work_cancel_requires_stop_request");
    expect(store.listWorkItems).not.toHaveBeenCalled();
    expect(store.saveObjective).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("passes only a trusted parent binding and strips authority fields from delegation payload", async () => {
    const delegateHumanWork = vi.fn(async (input: unknown) => input);
    const humanWork: HumanWorkOrchestrationPort = { delegateHumanWork };
    const coordinator = new DurableWorkCoordinator(
      emptyStore(humanObjective()),
      { cancelRun: vi.fn(async () => ({}) as never) },
      humanWork
    );
    const parent: RoomWorkAssignmentRecord = {
      id: "assignment-1",
      workspace_id: "workspace-1",
      work_id: "work-1",
      room_id: "room-1",
      agent_id: "agent-1",
      agent_version: 1,
      instruction_version: 1,
      generation: 1,
      attempt: 1,
      priority: 0,
      status: "running",
      current_run_id: "run-1",
      created_at: now,
      updated_at: now
    };
    const trustedBinding = {
      workspaceId: "workspace-1",
      roomId: "room-1",
      workId: "work-1",
      parentAssignmentId: "assignment-1",
      runId: "run-1",
      actorId: "agent-1",
      requestedByParticipantId: "human-1",
      agentId: "agent-1",
      generation: 1
    };

    await coordinator.delegateHumanWork({
      admission: {
        work: { id: "work-1", status: "running", stop_state: "none", created_at: now },
        assignments: [parent],
        parentAssignmentId: "assignment-1",
        now
      },
      trustedBinding,
      payload: {
        work_id: "spoofed-work",
        parent_run_id: "spoofed-run",
        requester_id: "spoofed-requester",
        agent_id: "agent-2",
        instruction: "Do the child work"
      }
    });

    expect(delegateHumanWork).toHaveBeenCalledWith(expect.objectContaining({
      trustedBinding,
      payload: { agent_id: "agent-2", instruction: "Do the child work" }
    }));
    expect(delegateHumanWork.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({
      payload: expect.objectContaining({ work_id: expect.anything() })
    }));
  });

  it("rejects a forged parent binding before the Store port is called", async () => {
    const delegateHumanWork = vi.fn(async (input: unknown) => input);
    const coordinator = new DurableWorkCoordinator(
      emptyStore(humanObjective()),
      { cancelRun: vi.fn(async () => ({}) as never) },
      { delegateHumanWork }
    );
    await expect(coordinator.delegateHumanWork({
      admission: {
        work: { id: "work-1", status: "running", stop_state: "none", created_at: now },
        assignments: [{
          id: "assignment-forged",
          workspace_id: "workspace-1",
          work_id: "work-1",
          room_id: "room-1",
          agent_id: "agent-1",
          agent_version: 1,
          instruction_version: 1,
          generation: 1,
          attempt: 1,
          priority: 0,
          status: "running",
          current_run_id: "run-1",
          created_at: now,
          updated_at: now
        }],
        parentAssignmentId: "assignment-forged",
        now
      },
      trustedBinding: {
        workspaceId: "workspace-1",
        roomId: "room-1",
        workId: "other-work",
        parentAssignmentId: "assignment-forged",
        runId: "run-1",
        actorId: "agent-1",
        requestedByParticipantId: "human-1",
        agentId: "agent-1",
        generation: 1
      },
      payload: { instruction: "ignored" }
    })).rejects.toThrow("human_work_runtime_binding_mismatch");
    expect(delegateHumanWork).not.toHaveBeenCalled();
  });
});
