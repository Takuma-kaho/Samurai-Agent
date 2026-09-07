import {
  createId,
  type HumanWorkObjectiveRecord,
  type JsonValue,
  type ObjectiveRecord,
  type RoomWorkAssignmentRecord,
  type RoomWorkCommentApplySnapshot,
  type RoomWorkCommentRecord,
  type RoomWorkControlRecord,
  type RoomWorkInstructionRecord,
  type RoomWorkRecord,
  type RoomWorkTerminalRecord,
  type WorkDependencyRecord,
  type WorkItemRecord
} from "@samurai-agent/core-schemas";

/** Errors raised before a state is handed to the persistence port. */
export class WorkStateTransitionError extends Error {}

export interface ObjectiveTransitionResult {
  objective: ObjectiveRecord;
  workItems: WorkItemRecord[];
  cancelBackendRunIds: string[];
}

/**
 * Runtime limits for one human Room work.
 *
 * `maxDepth` counts the root assignment as depth 0. All values are finite
 * and positive except for depth, where zero is a useful "no delegation"
 * policy. The store remains the owner of the persisted policy; this type is
 * only the validation/admission contract used by the orchestrator.
 */
export interface HumanWorkLimits {
  maxDepth: number;
  maxConcurrentAssignments: number;
  maxAssignments: number;
  maxDurationMs: number;
}

export interface HumanWorkLimitsInput {
  maxDepth?: number;
  maxConcurrentAssignments?: number;
  maxAssignments?: number;
  maxTotalAssignments?: number;
  maxDurationMs?: number;
  timeLimitMs?: number;
}

export const defaultHumanWorkLimits: Readonly<HumanWorkLimits> = Object.freeze({
  maxDepth: 8,
  maxConcurrentAssignments: 4,
  maxAssignments: 100,
  maxDurationMs: 24 * 60 * 60 * 1_000
});

export type HumanWorkAssignmentStatus = RoomWorkAssignmentRecord["status"];
export type HumanWorkInstructionAction = "accept" | "queue" | "deliver" | "apply" | "fail" | "reject";
export type HumanWorkStopAction = "request" | "confirm" | "unconfirmed";

const terminalWorkStatuses = new Set<WorkItemRecord["status"]>(["completed", "failed", "cancelled"]);
const terminalHumanAssignmentStatuses = new Set<HumanWorkAssignmentStatus>(["completed", "failed", "cancelled", "outcome_unknown"]);
const activeHumanAssignmentStatuses = new Set<HumanWorkAssignmentStatus>(["ready", "running", "waiting"]);

/**
 * Legacy Objective/WorkItem state transitions remain available for learning
 * and older callers. A human Objective must use the Room-work stop
 * transition below; the old `cancel` path is deliberately rejected so a
 * generic cancellation cannot masquerade as confirmed human-work stopping.
 */
export function transitionObjectiveState(input: {
  objective: ObjectiveRecord;
  workItems: WorkItemRecord[];
  action: "pause" | "resume" | "cancel";
  now: string;
}): ObjectiveTransitionResult {
  if (isHumanObjective(input.objective) && input.action === "cancel") {
    throw new WorkStateTransitionError("human_work_cancel_requires_stop_request");
  }
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

/**
 * Validate and normalize limits at the pure boundary. Aliases are accepted
 * because older adapters call the same concepts `maxTotalAssignments` and
 * `timeLimitMs`; the normalized result has one canonical shape.
 */
export function normalizeHumanWorkLimits(input: HumanWorkLimitsInput = {}): HumanWorkLimits {
  const limits: HumanWorkLimits = {
    maxDepth: input.maxDepth ?? defaultHumanWorkLimits.maxDepth,
    maxConcurrentAssignments: input.maxConcurrentAssignments ?? defaultHumanWorkLimits.maxConcurrentAssignments,
    maxAssignments: input.maxAssignments ?? input.maxTotalAssignments ?? defaultHumanWorkLimits.maxAssignments,
    maxDurationMs: input.maxDurationMs ?? input.timeLimitMs ?? defaultHumanWorkLimits.maxDurationMs
  };
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0) throw new WorkStateTransitionError("human_work_max_depth_invalid");
  if (!Number.isSafeInteger(limits.maxConcurrentAssignments) || limits.maxConcurrentAssignments < 1) {
    throw new WorkStateTransitionError("human_work_max_concurrency_invalid");
  }
  if (!Number.isSafeInteger(limits.maxAssignments) || limits.maxAssignments < 1) throw new WorkStateTransitionError("human_work_max_assignments_invalid");
  if (!Number.isSafeInteger(limits.maxDurationMs) || limits.maxDurationMs < 1) throw new WorkStateTransitionError("human_work_time_limit_invalid");
  return limits;
}

export interface HumanWorkDelegationDecision {
  allowed: boolean;
  reason:
    | "allowed"
    | "human_work_not_delegable"
    | "human_work_stopped"
    | "human_work_duration_limit_exceeded"
    | "human_work_assignment_limit_exceeded"
    | "human_work_concurrency_limit_exceeded"
    | "human_work_depth_limit_exceeded"
    | "human_work_dependency_invalid"
    | "human_work_dependency_cycle";
  depth: number;
  activeAssignments: number;
}

export interface HumanWorkDelegationInput {
  work: Pick<RoomWorkRecord, "id" | "status" | "stop_state" | "created_at">;
  assignments: readonly RoomWorkAssignmentRecord[];
  parentAssignmentId?: string;
  dependencyAssignmentIds?: readonly string[];
  now: string;
  limits?: HumanWorkLimitsInput | HumanWorkLimits;
}

/**
 * Pure admission policy for a delegated assignment. It checks graph scope,
 * finite resource limits, stop races, and time budget before the Store creates
 * the child reservation. It does not create or persist an assignment.
 */
export function evaluateHumanWorkDelegation(input: HumanWorkDelegationInput): HumanWorkDelegationDecision {
  const limits = normalizeHumanWorkLimits(input.limits);
  const assignments = input.assignments;
  const activeAssignments = assignments.filter((assignment) => activeHumanAssignmentStatuses.has(assignment.status)).length;
  const invalid = (reason: HumanWorkDelegationDecision["reason"], depth = 0): HumanWorkDelegationDecision => ({
    allowed: false,
    reason,
    depth,
    activeAssignments
  });

  // A delegation graph is local to one Room Work.  Validate graph scope
  // before calculating depth so malformed input is a decision, not an
  // uncaught exception from the pure evaluator.
  if (assignments.some((assignment) => assignment.work_id !== input.work.id)) {
    return invalid("human_work_dependency_invalid");
  }
  const assignmentIds = new Set(assignments.map((assignment) => assignment.id));
  let depth = 0;
  if (input.parentAssignmentId !== undefined) {
    if (!assignmentIds.has(input.parentAssignmentId)) return invalid("human_work_dependency_invalid");
    try {
      depth = assignmentDepth(input.parentAssignmentId, assignments) + 1;
    } catch (error) {
      return invalid(error instanceof WorkStateTransitionError && error.message.includes("cycle")
        ? "human_work_dependency_cycle"
        : "human_work_dependency_invalid");
    }
    const parent = assignments.find((assignment) => assignment.id === input.parentAssignmentId);
    if (parent && dependencyUnavailable(parent.status)) return invalid("human_work_dependency_invalid", depth);
  }
  if (input.work.status === "completed" || input.work.status === "failed" || input.work.status === "cancelled" || input.work.status === "outcome_unknown") {
    return invalid("human_work_not_delegable", depth);
  }
  if (input.work.status === "stopping" || input.work.stop_state !== "none") return invalid("human_work_stopped", depth);
  if (Date.parse(input.now) - Date.parse(input.work.created_at) >= limits.maxDurationMs) {
    return invalid("human_work_duration_limit_exceeded", depth);
  }
  if (assignments.length >= limits.maxAssignments) return invalid("human_work_assignment_limit_exceeded", depth);
  if (activeAssignments >= limits.maxConcurrentAssignments) return invalid("human_work_concurrency_limit_exceeded", depth);
  if (depth > limits.maxDepth) return invalid("human_work_depth_limit_exceeded", depth);
  const dependencyIds = [...new Set(input.dependencyAssignmentIds ?? [])];
  if (dependencyIds.some((id) => !assignmentIds.has(id) || id === input.parentAssignmentId)) {
    return invalid("human_work_dependency_invalid", depth);
  }
  if (dependencyIds.some((id) => {
    const dependency = assignments.find((assignment) => assignment.id === id);
    return dependency !== undefined && dependencyUnavailable(dependency.status);
  })) {
    return invalid("human_work_dependency_invalid", depth);
  }
  if (hasAssignmentDependencyCycle(assignments)) return invalid("human_work_dependency_cycle", depth);
  return { allowed: true, reason: "allowed", depth, activeAssignments };
}

export function assertHumanWorkDelegation(input: HumanWorkDelegationInput): HumanWorkDelegationDecision {
  const decision = evaluateHumanWorkDelegation(input);
  if (!decision.allowed) throw new WorkStateTransitionError(decision.reason);
  return decision;
}

/** Compatibility aliases used by adapters that call the operation an admit. */
export const canAdmitHumanWorkDelegation = evaluateHumanWorkDelegation;
export const assertDelegationWithinLimits = assertHumanWorkDelegation;

export function assignmentDepth(assignmentId: string, assignments: readonly RoomWorkAssignmentRecord[]): number {
  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  let current = byId.get(assignmentId);
  let depth = 0;
  const visited = new Set<string>();
  while (current?.parent_assignment_id) {
    if (visited.has(current.id)) throw new WorkStateTransitionError("human_work_dependency_cycle");
    visited.add(current.id);
    const parent = byId.get(current.parent_assignment_id);
    if (!parent) throw new WorkStateTransitionError("human_work_dependency_invalid");
    if (parent.work_id !== current.work_id) throw new WorkStateTransitionError("human_work_dependency_cross_work");
    depth += 1;
    current = parent;
  }
  return depth;
}

export const workAssignmentDepth = assignmentDepth;

function hasAssignmentDependencyCycle(assignments: readonly RoomWorkAssignmentRecord[]): boolean {
  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    const assignment = byId.get(id);
    if (!assignment) return false;
    visiting.add(id);
    const edges = [assignment.parent_assignment_id, ...(assignment.dependency_assignment_ids ?? [])].filter((value): value is string => Boolean(value));
    if (edges.some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return assignments.some((assignment) => visit(assignment.id));
}

/**
 * Existing generic steering stores a legacy string. It remains unchanged for
 * compatibility; human Room instructions use versioned receipts instead.
 */
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

export interface CreateHumanWorkInstructionInput {
  workspaceId: string;
  workId: string;
  roomId: string;
  version: number;
  body: string;
  createdBy: string;
  sourceKind: "request" | "reply" | "comment_reflection" | "system";
  assignmentId?: string;
  generation?: number;
  sourceCommentId?: string;
  sourceCommentVersion?: number;
  attachments?: RoomWorkInstructionRecord["attachments"];
  id?: string;
  now: string;
}

/** Build an unaccepted instruction receipt without persisting it. */
export function createHumanWorkInstruction(input: CreateHumanWorkInstructionInput): RoomWorkInstructionRecord {
  const body = input.body.trim();
  if (!body) throw new WorkStateTransitionError("human_work_instruction_required");
  if ((input.sourceCommentId === undefined) !== (input.sourceCommentVersion === undefined)) {
    throw new WorkStateTransitionError("human_work_comment_snapshot_incomplete");
  }
  return {
    id: input.id ?? createId("instruction"),
    workspace_id: input.workspaceId,
    work_id: input.workId,
    ...(input.assignmentId ? { assignment_id: input.assignmentId } : {}),
    room_id: input.roomId,
    version: positiveVersion(input.version, "human_work_instruction_version_invalid"),
    generation: input.generation ?? 0,
    body,
    source_kind: input.sourceKind,
    ...(input.sourceCommentId ? { source_comment_id: input.sourceCommentId, source_comment_version: input.sourceCommentVersion } : {}),
    state: "pending",
    attachments: [...(input.attachments ?? [])],
    created_by: input.createdBy,
    created_at: input.now,
    updated_at: input.now
  };
}

export interface HumanWorkInstructionTransitionInput {
  instruction: RoomWorkInstructionRecord;
  action: HumanWorkInstructionAction;
  now: string;
  reason?: string;
  expectedVersion?: number;
  expectedGeneration?: number;
}

/**
 * Instruction lifecycle is a receipt chain. In particular, saving a body
 * does not imply delivery or application to a Backend Run.
 */
export function transitionHumanWorkInstruction(input: HumanWorkInstructionTransitionInput): RoomWorkInstructionRecord {
  const current = input.instruction;
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    throw new WorkStateTransitionError("human_work_instruction_version_conflict");
  }
  if (input.expectedGeneration !== undefined && input.expectedGeneration !== current.generation) {
    throw new WorkStateTransitionError("human_work_instruction_generation_conflict");
  }
  const nextState = nextInstructionState(current.state, input.action);
  if ((input.action === "fail" || input.action === "reject") && !input.reason?.trim()) {
    throw new WorkStateTransitionError("human_work_instruction_reason_required");
  }
  return {
    ...current,
    state: nextState,
    updated_at: input.now,
    ...(input.action === "accept" ? { accepted_at: current.accepted_at ?? input.now } : {}),
    ...(input.action === "deliver" ? { delivered_at: current.delivered_at ?? input.now } : {}),
    ...(input.action === "apply" ? { applied_at: current.applied_at ?? input.now } : {}),
    ...(input.action === "fail" || input.action === "reject" ? { failure_reason: input.reason?.trim() } : {})
  };
}

export const applyHumanWorkInstructionTransition = transitionHumanWorkInstruction;

function nextInstructionState(
  state: RoomWorkInstructionRecord["state"],
  action: HumanWorkInstructionAction
): RoomWorkInstructionRecord["state"] {
  if (state === "applied" || state === "failed" || state === "rejected") {
    throw new WorkStateTransitionError(`human_work_instruction_terminal:${state}`);
  }
  if (action === "accept" && state === "pending") return "accepted";
  if (action === "queue" && state === "accepted") return "queued";
  if (action === "deliver" && (state === "accepted" || state === "queued")) return "delivered";
  if (action === "apply" && state === "delivered") return "applied";
  if (action === "fail") return "failed";
  if (action === "reject" && (state === "pending" || state === "accepted" || state === "queued")) return "rejected";
  throw new WorkStateTransitionError(`human_work_instruction_transition_invalid:${state}:${action}`);
}

export interface CreateCommentApplyInstructionInput {
  comment: RoomWorkCommentRecord;
  commentVersion: number;
  instructionVersion: number;
  instructionId?: string;
  appliedByAccountId: string;
  assignmentId?: string;
  generation?: number;
  now: string;
}

/**
 * A comment body is copied at apply time. Later comment edits therefore
 * cannot rewrite the instruction sent to an Agent.
 */
export function createCommentApplyInstruction(input: CreateCommentApplyInstructionInput): {
  instruction: RoomWorkInstructionRecord;
  snapshot: RoomWorkCommentApplySnapshot;
} {
  if (input.comment.version !== input.commentVersion) throw new WorkStateTransitionError("human_work_comment_version_conflict");
  const body = input.comment.body.trim() || "Review the attached material.";
  const instruction = createHumanWorkInstruction({
    workspaceId: input.comment.workspace_id,
    workId: input.comment.work_id,
    roomId: input.comment.room_id,
    version: input.instructionVersion,
    body,
    createdBy: input.appliedByAccountId,
    sourceKind: "comment_reflection",
    ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    sourceCommentId: input.comment.id,
    sourceCommentVersion: input.commentVersion,
    attachments: input.comment.attachment_refs,
    ...(input.instructionId ? { id: input.instructionId } : {}),
    now: input.now
  });
  const snapshot: RoomWorkCommentApplySnapshot = {
    id: createId("comment_apply"),
    workspace_id: input.comment.workspace_id,
    work_id: input.comment.work_id,
    room_id: input.comment.room_id,
    comment_id: input.comment.id,
    comment_version: input.commentVersion,
    instruction_id: instruction.id,
    instruction_version: input.instructionVersion,
    body,
    attachment_refs: [...input.comment.attachment_refs],
    applied_by_account_id: input.appliedByAccountId,
    applied_at: input.now
  };
  return { instruction, snapshot };
}

export const applyCommentSnapshot = createCommentApplyInstruction;

export interface HumanWorkStopTransitionInput {
  work: RoomWorkRecord;
  assignments: readonly RoomWorkAssignmentRecord[];
  action: HumanWorkStopAction;
  actorAccountId: string;
  operationId: string;
  now: string;
  reason?: string;
  assignmentId?: string;
  confirmedAssignmentIds?: readonly string[];
  unconfirmedAssignmentIds?: readonly string[];
  evidence?: RoomWorkTerminalRecord["evidence"];
  expectedVersion?: number;
  expectedGeneration?: number;
}

export interface HumanWorkStopTransitionResult {
  work: RoomWorkRecord;
  assignments: RoomWorkAssignmentRecord[];
  control: RoomWorkControlRecord;
  cancelRunIds: string[];
}

/**
 * Request/terminal state are intentionally separate. `request` changes the
 * admission state to `stopping` and returns Run IDs for an external stop
 * request, but never marks the work cancelled. The Store/worker later calls
 * this function with `confirm` or `unconfirmed` after it owns terminal
 * evidence.
 */
export function transitionHumanWorkStop(input: HumanWorkStopTransitionInput): HumanWorkStopTransitionResult {
  assertHumanWorkIdentity(input.work, input.assignments);
  if (input.expectedVersion !== undefined && input.expectedVersion !== input.work.control_generation) {
    throw new WorkStateTransitionError("human_work_control_generation_conflict");
  }
  if (input.expectedGeneration !== undefined && input.expectedGeneration !== input.work.control_generation) {
    throw new WorkStateTransitionError("human_work_control_generation_conflict");
  }
  const targetIds = targetAssignmentIds(input.assignments, input.assignmentId);
  const previousGeneration = input.work.control_generation;
  const generation = previousGeneration + 1;
  const cancelRunIds = input.assignments
    .filter((assignment) => targetIds.has(assignment.id) && !terminalHumanAssignmentStatuses.has(assignment.status) && assignment.current_run_id)
    .map((assignment) => assignment.current_run_id as string);

  if (input.action === "request") {
    if (input.work.stop_state === "confirmed") throw new WorkStateTransitionError("human_work_stop_already_confirmed");
    if (input.work.stop_state === "unconfirmed") throw new WorkStateTransitionError("human_work_stop_unconfirmed_requires_recovery");
    const dependencyWaitingIds = dependentAssignmentIds(input.assignments, targetIds);
    const assignments = input.assignments.map((assignment) => {
      if (targetIds.has(assignment.id) && !terminalHumanAssignmentStatuses.has(assignment.status)) {
        return { ...assignment, status: "stopping" as const, generation, updated_at: input.now };
      }
      // A sibling that depends on an individually stopped assignment must not
      // be replaced or launched implicitly. Keep it waiting until the Store
      // receives an explicit recovery/reassignment operation.
      if (dependencyWaitingIds.has(assignment.id) && ["queued", "ready", "blocked"].includes(assignment.status)) {
        return {
          ...assignment,
          status: "waiting" as const,
          lease_owner: undefined,
          lease_expires_at: undefined,
          heartbeat_at: undefined,
          updated_at: input.now
        };
      }
      return assignment;
    });
    const wholeWork = input.assignmentId === undefined;
    const work: RoomWorkRecord = {
      ...input.work,
      ...(wholeWork ? { status: "stopping" as const, stop_state: "requested" as const } : {}),
      control_generation: generation,
      updated_at: input.now
    };
    const control = stopControlRecord({
      work,
      action: input.assignmentId ? "assignment_stop" : "stop_request",
      state: "accepted",
      actorAccountId: input.actorAccountId,
      operationId: input.operationId,
      generation,
      now: input.now,
      reason: input.reason,
      assignmentId: input.assignmentId,
      terminal: { status: "pending", unconfirmed_assignee_ids: [] }
    });
    return { work, assignments, control, cancelRunIds: [...new Set(cancelRunIds)] };
  }

  const hasStopRequest = input.work.stop_state === "requested"
    || input.assignments.some((assignment) => targetIds.has(assignment.id) && assignment.status === "stopping");
  if (!hasStopRequest) throw new WorkStateTransitionError("human_work_stop_request_required");
  const confirmed = new Set(input.confirmedAssignmentIds ?? []);
  const unconfirmed = new Set(input.unconfirmedAssignmentIds ?? []);
  for (const id of [...confirmed, ...unconfirmed]) if (!targetIds.has(id)) throw new WorkStateTransitionError("human_work_stop_target_invalid");
  const assignments = input.assignments.map((assignment) => {
    if (!targetIds.has(assignment.id)) return assignment;
    if (unconfirmed.has(assignment.id)) return settleHumanAssignmentForStop(assignment, "outcome_unknown", input.now);
    if (confirmed.has(assignment.id)) return settleHumanAssignmentForStop(assignment, "cancelled", input.now);
    return assignment;
  });
  const remaining = assignments.filter((assignment) => targetIds.has(assignment.id) && !terminalHumanAssignmentStatuses.has(assignment.status));
  const hasUnknown = assignments.some((assignment) => targetIds.has(assignment.id) && assignment.status === "outcome_unknown");
  const wholeWork = input.assignmentId === undefined;
  const terminalStatus = hasUnknown ? "unconfirmed" : remaining.length === 0 ? "confirmed" : "pending";
  const work: RoomWorkRecord = {
    ...input.work,
    ...(wholeWork && terminalStatus === "confirmed" ? { status: "cancelled" as const, stop_state: "confirmed" as const } : {}),
    ...(wholeWork && terminalStatus === "unconfirmed" ? { status: "outcome_unknown" as const, stop_state: "unconfirmed" as const } : {}),
    ...(wholeWork && terminalStatus === "pending" ? { status: "stopping" as const, stop_state: "requested" as const } : {}),
    control_generation: generation,
    updated_at: input.now
  };
  const terminal: RoomWorkTerminalRecord = {
    status: terminalStatus,
    ...(terminalStatus === "confirmed" ? { confirmed_at: input.now } : {}),
    ...(terminalStatus === "unconfirmed" ? { unconfirmed_at: input.now } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    unconfirmed_assignee_ids: [...new Set([
      ...unconfirmed,
      ...assignments.filter((assignment) => targetIds.has(assignment.id) && assignment.status === "outcome_unknown").map((assignment) => assignment.id)
    ])]
  };
  const control = stopControlRecord({
    work,
    action: input.assignmentId ? (terminalStatus === "unconfirmed" ? "stop_unconfirmed" : "assignment_stop") : terminalStatus === "unconfirmed" ? "stop_unconfirmed" : "stop_confirm",
    state: terminalStatus === "confirmed" ? "confirmed" : terminalStatus === "unconfirmed" ? "unconfirmed" : "pending",
    actorAccountId: input.actorAccountId,
    operationId: input.operationId,
    generation,
    now: input.now,
    reason: input.reason,
    assignmentId: input.assignmentId,
    terminal
  });
  return { work, assignments, control, cancelRunIds: [...new Set(cancelRunIds)] };
}

export const transitionRoomWorkStop = transitionHumanWorkStop;

export function requestHumanWorkStop(input: Omit<HumanWorkStopTransitionInput, "action">): HumanWorkStopTransitionResult {
  return transitionHumanWorkStop({ ...input, action: "request" });
}

export function confirmHumanWorkStop(input: Omit<HumanWorkStopTransitionInput, "action">): HumanWorkStopTransitionResult {
  return transitionHumanWorkStop({ ...input, action: "confirm" });
}

export function markHumanWorkStopUnconfirmed(input: Omit<HumanWorkStopTransitionInput, "action">): HumanWorkStopTransitionResult {
  return transitionHumanWorkStop({ ...input, action: "unconfirmed", unconfirmedAssignmentIds: input.unconfirmedAssignmentIds ?? [...targetAssignmentIds(input.assignments, input.assignmentId)] });
}

function stopControlRecord(input: {
  work: RoomWorkRecord;
  action: RoomWorkControlRecord["action"];
  state: RoomWorkControlRecord["state"];
  actorAccountId: string;
  operationId: string;
  generation: number;
  now: string;
  reason?: string;
  assignmentId?: string;
  terminal?: RoomWorkTerminalRecord;
}): RoomWorkControlRecord {
  return {
    id: createId("work_control"),
    workspace_id: input.work.workspace_id,
    work_id: input.work.id,
    ...(input.assignmentId ? { assignment_id: input.assignmentId } : {}),
    room_id: input.work.room_id,
    action: input.action,
    state: input.state,
    actor_account_id: input.actorAccountId,
    generation: input.generation,
    operation_id: input.operationId,
    details: {
      ...(input.reason ? { reason: input.reason } : {}),
      stop_state: input.work.stop_state
    },
    ...(input.action === "stop_request" || input.action === "assignment_stop"
      ? {
          stop_request: {
            state: "accepted" as const,
            requested_by: input.actorAccountId,
            operation_id: input.operationId,
            requested_at: input.now,
            accepted_at: input.now
          }
        }
      : {}),
    ...(input.terminal ? { terminal: input.terminal } : {}),
    created_at: input.now,
    updated_at: input.now
  };
}

function targetAssignmentIds(assignments: readonly RoomWorkAssignmentRecord[], assignmentId?: string): Set<string> {
  if (!assignmentId) return new Set(assignments.map((assignment) => assignment.id));
  const byParent = new Map<string, string[]>();
  for (const assignment of assignments) {
    if (!assignment.parent_assignment_id) continue;
    const children = byParent.get(assignment.parent_assignment_id) ?? [];
    children.push(assignment.id);
    byParent.set(assignment.parent_assignment_id, children);
  }
  if (!assignments.some((assignment) => assignment.id === assignmentId)) throw new WorkStateTransitionError("human_work_stop_target_invalid");
  const result = new Set<string>([assignmentId]);
  const queue = [assignmentId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of byParent.get(current) ?? []) if (!result.has(child)) { result.add(child); queue.push(child); }
  }
  return result;
}

function dependentAssignmentIds(assignments: readonly RoomWorkAssignmentRecord[], targetIds: ReadonlySet<string>): Set<string> {
  return new Set(assignments
    .filter((assignment) => !targetIds.has(assignment.id))
    .filter((assignment) => (assignment.dependency_assignment_ids ?? []).some((id) => targetIds.has(id)))
    .map((assignment) => assignment.id));
}

function settleHumanAssignmentForStop(assignment: RoomWorkAssignmentRecord, status: "cancelled" | "outcome_unknown", now: string): RoomWorkAssignmentRecord {
  return {
    ...assignment,
    status,
    lease_owner: undefined,
    lease_expires_at: undefined,
    heartbeat_at: undefined,
    updated_at: now,
    ...(status === "cancelled" ? { completed_at: now } : {})
  };
}

function dependencyUnavailable(status: HumanWorkAssignmentStatus): boolean {
  return status === "stopping" || status === "cancelled" || status === "failed" || status === "outcome_unknown";
}

function assertHumanWorkIdentity(work: RoomWorkRecord, assignments: readonly RoomWorkAssignmentRecord[]): void {
  if (work.kind !== "human") throw new WorkStateTransitionError("human_work_kind_required");
  for (const assignment of assignments) {
    if (assignment.work_id !== work.id || assignment.room_id !== work.room_id || assignment.workspace_id !== work.workspace_id) {
      throw new WorkStateTransitionError("human_work_assignment_scope_conflict");
    }
  }
}

export interface HumanWorkRunResultInput {
  work: RoomWorkRecord;
  assignment: RoomWorkAssignmentRecord;
  runId: string;
  generation: number;
  instructionVersion: number;
  controlGeneration?: number;
  status: Extract<HumanWorkAssignmentStatus, "completed" | "failed" | "cancelled" | "waiting" | "blocked" | "outcome_unknown">;
  result?: JsonValue;
  now: string;
}

export interface HumanWorkRunResultDecision {
  accepted: boolean;
  reason: "accepted" | "stale_work" | "stale_assignment" | "stale_run" | "stale_instruction" | "stopped_work";
}

/** Reject late results before they can be handed to the Store settlement port. */
export function evaluateHumanWorkRunResult(input: HumanWorkRunResultInput): HumanWorkRunResultDecision {
  if (
    input.work.kind !== "human"
    || input.assignment.work_id !== input.work.id
    || input.assignment.workspace_id !== input.work.workspace_id
    || input.assignment.room_id !== input.work.room_id
  ) return { accepted: false, reason: "stale_work" };
  if (input.work.stop_state !== "none" || input.work.status === "stopping" || input.work.status === "completed" || input.work.status === "failed" || input.work.status === "cancelled" || input.work.status === "outcome_unknown") {
    return { accepted: false, reason: "stopped_work" };
  }
  if (input.assignment.status === "stopping" || input.assignment.status === "cancelled" || input.assignment.status === "outcome_unknown") {
    return { accepted: false, reason: "stopped_work" };
  }
  if (input.assignment.status === "completed" || input.assignment.status === "failed") {
    return { accepted: false, reason: "stale_assignment" };
  }
  if (input.assignment.generation !== input.generation) return { accepted: false, reason: "stale_assignment" };
  if (input.controlGeneration !== undefined && input.controlGeneration !== input.work.control_generation) return { accepted: false, reason: "stale_work" };
  if (input.assignment.instruction_version !== input.instructionVersion) return { accepted: false, reason: "stale_instruction" };
  if (input.assignment.current_run_id === undefined || input.assignment.current_run_id !== input.runId) return { accepted: false, reason: "stale_run" };
  return { accepted: true, reason: "accepted" };
}

export function assertCurrentHumanWorkRunResult(input: HumanWorkRunResultInput): HumanWorkRunResultDecision {
  const decision = evaluateHumanWorkRunResult(input);
  if (!decision.accepted) throw new WorkStateTransitionError(`human_work_${decision.reason}`);
  return decision;
}

export function settleHumanWorkAssignment(input: HumanWorkRunResultInput): RoomWorkAssignmentRecord {
  assertCurrentHumanWorkRunResult(input);
  const terminal = terminalHumanAssignmentStatuses.has(input.status);
  return {
    ...input.assignment,
    status: input.status,
    ...(input.result === undefined ? {} : { result: input.result }),
    lease_owner: undefined,
    lease_expires_at: undefined,
    heartbeat_at: undefined,
    updated_at: input.now,
    ...(terminal ? { completed_at: input.now } : {})
  };
}

export const acceptHumanWorkRunResult = evaluateHumanWorkRunResult;

export interface HumanWorkWriterLease {
  key: string;
  ownerId: string;
  leaseId: string;
  generation: number;
  terminalConfirmed?: boolean;
}

export interface HumanWorkWriterIdentity {
  workspaceId: string;
  executionTargetId: string;
  workId: string;
  assignmentId: string;
  generation: number;
}

/** Same execution target means same key, even when Work IDs differ. */
export function humanWorkWriterKey(input: Pick<HumanWorkWriterIdentity, "workspaceId" | "executionTargetId">): string {
  const workspaceId = input.workspaceId.trim();
  const target = input.executionTargetId.trim();
  if (!workspaceId || !target) throw new WorkStateTransitionError("human_work_writer_scope_required");
  return `${workspaceId}:execution-target:${target}`;
}

export const writerExclusionKey = humanWorkWriterKey;

export interface HumanWorkWriterPort {
  acquireWriter(input: HumanWorkWriterIdentity & { leaseMs: number; now: string }): Promise<{ acquired: true; lease: HumanWorkWriterLease } | { acquired: false; lease?: HumanWorkWriterLease }>;
  releaseWriter(input: HumanWorkWriterLease & { now: string; terminalConfirmed: boolean }): Promise<void>;
}

/** Pure check used by the coordinator before accepting a worker result. */
export function assertHumanWorkWriter(input: { lease: HumanWorkWriterLease; identity: HumanWorkWriterIdentity; ownerId: string }): void {
  const expectedKey = humanWorkWriterKey(input.identity);
  if (input.lease.key !== expectedKey || input.lease.ownerId !== input.ownerId || input.lease.generation !== input.identity.generation) {
    throw new WorkStateTransitionError("human_work_writer_exclusion_conflict");
  }
}

export interface CreateFollowUpWorkItemInput {
  objective: ObjectiveRecord;
  current: WorkItemRecord;
  instruction: string;
  now: string;
  maxAttempts?: number;
  limits?: HumanWorkLimitsInput | HumanWorkLimits;
  workItems?: readonly WorkItemRecord[];
}

export function createFollowUpWorkItem(input: CreateFollowUpWorkItemInput): { workItem: WorkItemRecord; dependency: WorkDependencyRecord } {
  const instruction = input.instruction.trim();
  if (!instruction) throw new WorkStateTransitionError("work_item_follow_up_instruction_required");
  if (["cancelled", "failed"].includes(input.objective.status)) {
    throw new WorkStateTransitionError(`work_item_follow_up_objective_invalid:${input.objective.status}`);
  }
  if (isHumanObjective(input.objective)) {
    const existing = input.workItems ?? [input.current];
    const humanWork = {
      id: input.objective.id,
      status: input.objective.status === "active" ? "running" as const : input.objective.status === "paused" ? "waiting" as const : "blocked" as const,
      stop_state: "none" as const,
      created_at: input.objective.created_at
    };
    const parentAssignment = toRoomAssignment(input.current);
    const assignments = existing.map(toRoomAssignment);
    assertHumanWorkDelegation({
      work: humanWork,
      assignments,
      parentAssignmentId: parentAssignment.id,
      now: input.now,
      limits: input.limits
    });
  }
  const workItem: WorkItemRecord = {
    id: createId("work"),
    objective_id: input.objective.id,
    room_id: input.objective.room_id ?? input.current.room_id,
    ...(input.objective.workspace_id ? { workspace_id: input.objective.workspace_id } : input.current.workspace_id ? { workspace_id: input.current.workspace_id } : {}),
    ...(isHumanObjective(input.objective) ? { kind: "human" as const } : {}),
    parent_work_item_id: input.current.id,
    ...(input.current.assignee_agent_id ? { assignee_agent_id: input.current.assignee_agent_id } : {}),
    ...(input.current.agent_configuration_version ? { agent_configuration_version: input.current.agent_configuration_version } : {}),
    ...(input.current.generation ? { generation: input.current.generation } : {}),
    ...(input.current.instruction_version ? { instruction_version: input.current.instruction_version + 1 } : {}),
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

function toRoomAssignment(item: WorkItemRecord): RoomWorkAssignmentRecord {
  return {
    id: item.id,
    workspace_id: item.workspace_id ?? "legacy-workspace",
    work_id: item.objective_id,
    room_id: item.room_id ?? "legacy-room",
    ...(item.parent_work_item_id ? { parent_assignment_id: item.parent_work_item_id } : {}),
    agent_id: item.assignee_agent_id ?? "legacy-agent",
    agent_version: item.agent_configuration_version ?? 1,
    instruction_version: item.instruction_version ?? 1,
    generation: item.generation ?? 1,
    attempt: item.attempt,
    priority: item.priority,
    status: item.status === "queued" ? "queued" : item.status === "ready" ? "ready" : item.status === "running" ? "running" : item.status === "waiting" ? "waiting" : item.status === "blocked" ? "blocked" : item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "cancelled",
    ...(item.backend_run_id ? { current_run_id: item.backend_run_id } : {}),
    ...(item.lease_owner ? { lease_owner: item.lease_owner } : {}),
    ...(item.lease_expires_at ? { lease_expires_at: item.lease_expires_at } : {}),
    ...(item.heartbeat_at ? { heartbeat_at: item.heartbeat_at } : {}),
    created_at: item.created_at,
    updated_at: item.updated_at,
    ...(item.started_at ? { started_at: item.started_at } : {}),
    ...(item.completed_at ? { completed_at: item.completed_at } : {})
  };
}

function isHumanObjective(objective: ObjectiveRecord): objective is HumanWorkObjectiveRecord {
  return objective.kind === "human";
}

function positiveVersion(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkStateTransitionError(code);
  return value;
}
