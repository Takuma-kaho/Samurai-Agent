import { createId, type ObjectiveRecord, type WorkDependencyRecord, type WorkItemRecord } from "@samurai-agent/core-schemas";

export class WorkStateTransitionError extends Error {}

export interface ObjectiveTransitionResult {
  objective: ObjectiveRecord;
  workItems: WorkItemRecord[];
  cancelBackendRunIds: string[];
}

const terminalWorkStatuses = new Set<WorkItemRecord["status"]>(["completed", "failed", "cancelled"]);

export function transitionObjectiveState(input: {
  objective: ObjectiveRecord;
  workItems: WorkItemRecord[];
  action: "pause" | "resume" | "cancel";
  now: string;
}): ObjectiveTransitionResult {
  if (input.action === "pause" && input.objective.status !== "active") {
    throw new WorkStateTransitionError(`objective_pause_invalid:${input.objective.status}`);
  }
  if (input.action === "resume" && !["paused", "blocked"].includes(input.objective.status)) {
    throw new WorkStateTransitionError(`objective_resume_invalid:${input.objective.status}`);
  }
  if (input.action === "cancel" && ["completed", "cancelled", "failed"].includes(input.objective.status)) {
    throw new WorkStateTransitionError(`objective_cancel_invalid:${input.objective.status}`);
  }

  const nextObjectiveStatus = input.action === "pause" ? "paused" : input.action === "resume" ? "active" : "cancelled";
  const cancelBackendRunIds: string[] = [];
  const workItems = input.workItems.map((item): WorkItemRecord => {
    if (terminalWorkStatuses.has(item.status)) return item;
    if (input.action === "pause") {
      if (item.status !== "running") return item;
      return { ...item, status: "waiting", lease_owner: undefined, lease_expires_at: undefined, heartbeat_at: undefined, updated_at: input.now };
    }
    if (input.action === "resume") {
      if (item.status !== "waiting" && item.status !== "blocked") return item;
      return { ...item, status: "ready", retry_after_at: undefined, failure_kind: undefined, error: undefined, updated_at: input.now };
    }
    if (item.backend_run_id) cancelBackendRunIds.push(item.backend_run_id);
    return {
      ...item,
      status: "cancelled",
      lease_owner: undefined,
      lease_expires_at: undefined,
      heartbeat_at: undefined,
      retry_after_at: undefined,
      failure_kind: "cancelled",
      error: "objective_cancelled",
      updated_at: input.now,
      completed_at: input.now
    };
  });
  return {
    objective: {
      ...input.objective,
      status: nextObjectiveStatus,
      updated_at: input.now,
      ...(nextObjectiveStatus === "cancelled" ? { completed_at: input.now } : {})
    },
    workItems,
    cancelBackendRunIds: [...new Set(cancelBackendRunIds)]
  };
}

export function steerWorkItem(input: { workItem: WorkItemRecord; instruction: string; now: string }): WorkItemRecord {
  const instruction = input.instruction.trim();
  if (!instruction) throw new WorkStateTransitionError("work_item_steer_instruction_required");
  if (!["running", "waiting"].includes(input.workItem.status)) {
    throw new WorkStateTransitionError(`work_item_steer_invalid:${input.workItem.status}`);
  }
  return {
    ...input.workItem,
    instruction: `${input.workItem.instruction}\n\nSteer: ${instruction}`,
    updated_at: input.now
  };
}

export function createFollowUpWorkItem(input: {
  objective: ObjectiveRecord;
  current: WorkItemRecord;
  instruction: string;
  now: string;
  maxAttempts?: number;
}): { workItem: WorkItemRecord; dependency: WorkDependencyRecord } {
  const instruction = input.instruction.trim();
  if (!instruction) throw new WorkStateTransitionError("work_item_follow_up_instruction_required");
  if (["cancelled", "failed"].includes(input.objective.status)) {
    throw new WorkStateTransitionError(`work_item_follow_up_objective_invalid:${input.objective.status}`);
  }
  const workItem: WorkItemRecord = {
    id: createId("work"),
    objective_id: input.objective.id,
    room_id: input.objective.room_id ?? input.current.room_id,
    parent_work_item_id: input.current.id,
    instruction,
    status: "queued",
    priority: input.current.priority,
    attempt: 0,
    max_attempts: input.maxAttempts ?? input.current.max_attempts,
    idempotency_key: `${input.objective.id}:follow-up:${createId("instruction")}`,
    created_at: input.now,
    updated_at: input.now
  };
  return {
    workItem,
    dependency: {
      id: createId("dependency"),
      objective_id: input.objective.id,
      predecessor_work_item_id: input.current.id,
      successor_work_item_id: workItem.id,
      kind: "blocks",
      created_at: input.now
    }
  };
}
