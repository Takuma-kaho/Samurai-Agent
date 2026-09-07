import { describe, expect, it } from "vitest";
import type {
  HumanWorkObjectiveRecord,
  RoomWorkAssignmentRecord,
  RoomWorkCommentRecord,
  RoomWorkRecord
} from "@samurai-agent/core-schemas";
import {
  assertHumanWorkWriter,
  confirmHumanWorkStop,
  createCommentApplyInstruction,
  createHumanWorkInstruction,
  evaluateHumanWorkDelegation,
  evaluateHumanWorkRunResult,
  humanWorkWriterKey,
  markHumanWorkStopUnconfirmed,
  normalizeHumanWorkLimits,
  requestHumanWorkStop,
  transitionHumanWorkInstruction,
  transitionObjectiveState,
  type HumanWorkWriterIdentity,
  type HumanWorkWriterLease
} from "./work-state-machine";

const createdAt = "2026-01-01T00:00:00.000Z";
const nextAt = "2026-01-01T00:00:01.000Z";

function work(overrides: Partial<RoomWorkRecord> = {}): RoomWorkRecord {
  return {
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
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides
  };
}

function assignment(overrides: Partial<RoomWorkAssignmentRecord> = {}): RoomWorkAssignmentRecord {
  return {
    id: "assignment-1",
    workspace_id: "workspace-1",
    work_id: "work-1",
    room_id: "room-1",
    agent_id: "agent-1",
    agent_version: 1,
    instruction_version: 1,
    generation: 1,
    attempt: 0,
    priority: 0,
    status: "running",
    current_run_id: "run-1",
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides
  };
}

function objective(overrides: Partial<HumanWorkObjectiveRecord> = {}): HumanWorkObjectiveRecord {
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
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides
  };
}

describe("human Work state policy", () => {
  it("keeps the legacy generic cancel path away from a human Objective", () => {
    expect(() => transitionObjectiveState({
      objective: objective(),
      workItems: [],
      action: "cancel",
      now: nextAt
    })).toThrow("human_work_cancel_requires_stop_request");
  });

  it("enforces finite delegation limits and rejects malformed graph scope", () => {
    expect(normalizeHumanWorkLimits({ maxTotalAssignments: 3, timeLimitMs: 5000 })).toEqual({
      maxDepth: 8,
      maxConcurrentAssignments: 4,
      maxAssignments: 3,
      maxDurationMs: 5000
    });

    const root = assignment();
    const base = {
      work: { id: "work-1", status: "running" as const, stop_state: "none" as const, created_at: createdAt },
      assignments: [root],
      now: createdAt
    };
    expect(evaluateHumanWorkDelegation({ ...base, parentAssignmentId: "missing" })).toMatchObject({
      allowed: false,
      reason: "human_work_dependency_invalid"
    });
    expect(evaluateHumanWorkDelegation({ ...base, parentAssignmentId: root.id, limits: { maxDepth: 0 } })).toMatchObject({
      allowed: false,
      reason: "human_work_depth_limit_exceeded",
      depth: 1
    });
    expect(evaluateHumanWorkDelegation({ ...base, limits: { maxConcurrentAssignments: 1 } })).toMatchObject({
      allowed: false,
      reason: "human_work_concurrency_limit_exceeded",
      activeAssignments: 1
    });
    expect(evaluateHumanWorkDelegation({ ...base, now: nextAt, limits: { maxDurationMs: 500 } })).toMatchObject({
      allowed: false,
      reason: "human_work_duration_limit_exceeded"
    });
    expect(evaluateHumanWorkDelegation({
      ...base,
      assignments: [assignment({ work_id: "another-work" })]
    })).toMatchObject({ allowed: false, reason: "human_work_dependency_invalid" });
    expect(evaluateHumanWorkDelegation({
      ...base,
      parentAssignmentId: "assignment-a",
      assignments: [
        assignment({ id: "assignment-a", parent_assignment_id: "assignment-b" }),
        assignment({ id: "assignment-b", parent_assignment_id: "assignment-a" })
      ]
    })).toMatchObject({ allowed: false, reason: "human_work_dependency_cycle" });
  });

  it("keeps instruction acceptance, delivery, and application as separate receipts", () => {
    let instruction = createHumanWorkInstruction({
      workspaceId: "workspace-1",
      roomId: "room-1",
      workId: "work-1",
      version: 1,
      generation: 1,
      body: "Draft the report.",
      createdBy: "human-1",
      sourceKind: "request",
      now: createdAt
    });
    expect(instruction.state).toBe("pending");

    instruction = transitionHumanWorkInstruction({ instruction, action: "accept", now: nextAt });
    expect(instruction.state).toBe("accepted");
    expect(instruction.accepted_at).toBe(nextAt);
    instruction = transitionHumanWorkInstruction({ instruction, action: "deliver", now: nextAt });
    expect(instruction.state).toBe("delivered");
    expect(instruction.delivered_at).toBe(nextAt);
    instruction = transitionHumanWorkInstruction({ instruction, action: "apply", now: nextAt });
    expect(instruction.state).toBe("applied");
    expect(instruction.applied_at).toBe(nextAt);
    expect(() => transitionHumanWorkInstruction({ instruction, action: "deliver", now: nextAt })).toThrow("human_work_instruction_terminal");
  });

  it("snapshots a comment body and attachments when applying it", () => {
    const comment: RoomWorkCommentRecord = {
      id: "comment-1",
      workspace_id: "workspace-1",
      work_id: "work-1",
      room_id: "room-1",
      author_account_id: "human-1",
      version: 1,
      body: "Use the approved numbers.",
      attachment_refs: [],
      created_at: createdAt,
      updated_at: createdAt
    };
    const applied = createCommentApplyInstruction({
      comment,
      commentVersion: 1,
      instructionVersion: 2,
      appliedByAccountId: "human-1",
      now: nextAt
    });

    expect(applied.instruction.body).toBe("Use the approved numbers.");
    expect(applied.snapshot).toMatchObject({
      comment_id: "comment-1",
      comment_version: 1,
      instruction_version: 2,
      body: "Use the approved numbers."
    });
    const edited = { ...comment, body: "A later edit must not rewrite the applied instruction.", version: 2 };
    expect(edited.body).not.toBe(applied.instruction.body);
    expect(applied.snapshot.body).toBe(applied.instruction.body);
    expect(() => createCommentApplyInstruction({
      comment: edited,
      commentVersion: 1,
      instructionVersion: 3,
      appliedByAccountId: "human-1",
      now: nextAt
    })).toThrow("human_work_comment_version_conflict");
  });

  it("keeps stop request, confirmation, and unknown outcome separate", () => {
    const child = assignment({ id: "assignment-2", current_run_id: "run-2", parent_assignment_id: "assignment-1" });
    const requested = requestHumanWorkStop({
      work: work(),
      assignments: [assignment(), child],
      actorAccountId: "human-1",
      operationId: "stop-operation",
      reason: "No longer needed.",
      now: nextAt
    });
    expect(requested.work).toMatchObject({ status: "stopping", stop_state: "requested", control_generation: 2 });
    expect(requested.assignments.map((item) => item.status)).toEqual(["stopping", "stopping"]);
    expect(requested.cancelRunIds).toEqual(["run-1", "run-2"]);
    expect(requested.control).toMatchObject({ action: "stop_request", state: "accepted" });

    const confirmed = confirmHumanWorkStop({
      work: requested.work,
      assignments: requested.assignments,
      confirmedAssignmentIds: ["assignment-1", "assignment-2"],
      actorAccountId: "human-1",
      operationId: "stop-confirm-operation",
      now: nextAt
    });
    expect(confirmed.work).toMatchObject({ status: "cancelled", stop_state: "confirmed", control_generation: 3 });
    expect(confirmed.assignments.every((item) => item.status === "cancelled")).toBe(true);
    expect(confirmed.control).toMatchObject({ action: "stop_confirm", state: "confirmed" });

    const requestedAgain = requestHumanWorkStop({
      work: work(),
      assignments: [assignment()],
      actorAccountId: "human-1",
      operationId: "stop-operation-2",
      now: nextAt
    });
    const unconfirmed = markHumanWorkStopUnconfirmed({
      work: requestedAgain.work,
      assignments: requestedAgain.assignments,
      actorAccountId: "human-1",
      operationId: "stop-unconfirmed-operation",
      now: nextAt
    });
    expect(unconfirmed.work).toMatchObject({ status: "outcome_unknown", stop_state: "unconfirmed" });
    expect(unconfirmed.assignments[0].status).toBe("outcome_unknown");
    expect(unconfirmed.assignments[0].completed_at).toBeUndefined();
    expect(unconfirmed.control).toMatchObject({ action: "stop_unconfirmed", state: "unconfirmed" });

    const dependent = assignment({ id: "assignment-3", dependency_assignment_ids: ["assignment-1"], current_run_id: undefined, status: "ready" });
    const individualStop = requestHumanWorkStop({
      work: work(),
      assignments: [assignment(), dependent],
      assignmentId: "assignment-1",
      actorAccountId: "human-1",
      operationId: "assignment-stop-operation",
      now: nextAt
    });
    expect(individualStop.work).toMatchObject({ status: "running", stop_state: "none" });
    expect(individualStop.assignments.map((item) => item.status)).toEqual(["stopping", "waiting"]);
  });

  it("rejects old or cross-scope Run results before settlement", () => {
    const current = {
      work: work(),
      assignment: assignment(),
      runId: "run-1",
      generation: 1,
      instructionVersion: 1,
      status: "completed" as const,
      now: nextAt
    };
    expect(evaluateHumanWorkRunResult(current)).toEqual({ accepted: true, reason: "accepted" });
    expect(evaluateHumanWorkRunResult({ ...current, runId: "old-run" })).toEqual({ accepted: false, reason: "stale_run" });
    expect(evaluateHumanWorkRunResult({ ...current, instructionVersion: 2 })).toEqual({ accepted: false, reason: "stale_instruction" });
    expect(evaluateHumanWorkRunResult({ ...current, generation: 2 })).toEqual({ accepted: false, reason: "stale_assignment" });
    expect(evaluateHumanWorkRunResult({
      ...current,
      assignment: assignment({ room_id: "other-room" })
    })).toEqual({ accepted: false, reason: "stale_work" });

    const requested = requestHumanWorkStop({
      work: work(),
      assignments: [assignment()],
      actorAccountId: "human-1",
      operationId: "stop-operation",
      now: nextAt
    });
    expect(evaluateHumanWorkRunResult({
      ...current,
      work: requested.work,
      assignment: requested.assignments[0],
      generation: requested.assignments[0].generation
    })).toEqual({ accepted: false, reason: "stopped_work" });
  });

  it("uses one writer key for the same execution target", () => {
    const first: HumanWorkWriterIdentity = {
      workspaceId: "workspace-1",
      executionTargetId: "agent-1",
      workId: "work-1",
      assignmentId: "assignment-1",
      generation: 1
    };
    const second = { ...first, workId: "work-2", assignmentId: "assignment-2" };
    const differentTarget = { ...first, executionTargetId: "agent-2" };
    expect(humanWorkWriterKey(first)).toBe(humanWorkWriterKey(second));
    expect(humanWorkWriterKey(first)).not.toBe(humanWorkWriterKey(differentTarget));

    const lease: HumanWorkWriterLease = {
      key: humanWorkWriterKey(first),
      ownerId: "worker-1",
      leaseId: "lease-1",
      generation: 1
    };
    expect(() => assertHumanWorkWriter({ lease, identity: first, ownerId: "worker-1" })).not.toThrow();
    expect(() => assertHumanWorkWriter({ lease, identity: second, ownerId: "worker-1" })).not.toThrow();
    expect(() => assertHumanWorkWriter({ lease, identity: differentTarget, ownerId: "worker-1" })).toThrow("human_work_writer_exclusion_conflict");
  });
});
