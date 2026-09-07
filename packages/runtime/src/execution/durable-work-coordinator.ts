import {
  nowIso,
  type BackendRunRecord,
  type ObjectiveRecord,
  type ResourceRef,
  type RoomWorkAssignmentRecord,
  type RoomWorkInstructionRecord,
  type RoomWorkRecord,
  type WorkDependencyRecord,
  type WorkItemRecord
} from "@samurai-agent/core-schemas";
import {
  assertHumanWorkDelegation,
  assertHumanWorkWriter,
  createCommentApplyInstruction,
  createFollowUpWorkItem,
  createHumanWorkInstruction,
  settleHumanWorkAssignment,
  steerWorkItem,
  transitionHumanWorkInstruction,
  transitionObjectiveState,
  type CreateCommentApplyInstructionInput,
  type CreateHumanWorkInstructionInput,
  type HumanWorkDelegationInput,
  type HumanWorkInstructionTransitionInput,
  type HumanWorkRunResultInput,
  type HumanWorkStopTransitionInput,
  type HumanWorkWriterIdentity,
  type HumanWorkWriterLease,
  type HumanWorkWriterPort
} from "./work-state-machine";

export interface BackendRunCancellationPort {
  cancelRun(runId: string): Promise<BackendRunRecord>;
}

export interface DurableWorkStorePort {
  getObjective(id: string, roomId: string): Promise<ObjectiveRecord | undefined>;
  listWorkItems(input: { objectiveId?: string; status?: WorkItemRecord["status"]; roomId: string }): Promise<WorkItemRecord[]>;
  saveObjective(record: ObjectiveRecord, roomId: string): Promise<ObjectiveRecord>;
  saveWorkItem(record: WorkItemRecord, roomId: string): Promise<WorkItemRecord>;
  getBackendRun(runId: string): Promise<BackendRunRecord | undefined>;
  getWorkItem(id: string, roomId: string): Promise<WorkItemRecord | undefined>;
  saveWorkDependency(record: WorkDependencyRecord, roomId: string): Promise<WorkDependencyRecord>;
}

/** Public human-work creation input. Session IDs are intentionally absent. */
export interface HumanWorkCreateRequest {
  workspaceId: string;
  roomId: string;
  requesterId: string;
  instruction?: string;
  attachments?: readonly ResourceRef[];
  agentId?: string;
  title?: string;
  objective?: string;
  completionCriteria?: readonly string[];
  operationId: string;
  now?: string;
}

export interface HumanWorkReplyRequest {
  workspaceId: string;
  roomId: string;
  workId: string;
  assigneeId?: string;
  instruction?: string;
  attachments?: readonly ResourceRef[];
  expectedVersion?: number;
  expectedGeneration?: number;
  operationId: string;
}

export interface HumanWorkCommentRequest {
  workspaceId: string;
  roomId: string;
  workId: string;
  body?: string;
  attachments?: readonly ResourceRef[];
  expectedVersion?: number;
  operationId: string;
}

export interface HumanWorkCommentApplyRequest {
  workspaceId: string;
  roomId: string;
  workId: string;
  commentId: string;
  commentVersion: number;
  assigneeId?: string;
  expectedVersion?: number;
  expectedGeneration?: number;
  operationId: string;
}

export interface HumanWorkStopRequest {
  workspaceId: string;
  roomId: string;
  workId: string;
  assignmentId?: string;
  reason?: string;
  expectedVersion?: number;
  expectedGeneration?: number;
  operationId: string;
}

export interface HumanWorkReassignRequest {
  workspaceId: string;
  roomId: string;
  workId: string;
  assigneeId: string;
  agentId: string;
  expectedVersion?: number;
  expectedGeneration?: number;
  operationId: string;
}

/**
 * Server-owned identity for one admitted Room-work execution.  Provider
 * payloads never establish any of these fields; the worker/runtime binding
 * does.
 */
export interface HumanWorkRuntimeBinding {
  workspaceId: string;
  roomId: string;
  workId: string;
  parentAssignmentId: string;
  runId: string;
  actorId: string;
  requestedByParticipantId: string;
  agentId: string;
  generation: number;
}

/** Internal settlement envelope; reservation/lease values are not public DTO fields. */
export interface HumanWorkSettlementRequest extends HumanWorkRunResultInput {
  workspaceId: string;
  roomId: string;
  reservationId: string;
  leaseOwner: string;
  operationId: string;
}

/**
 * Atomic Store/worker boundary for human work. Implementations own the
 * durable aggregate, reservation, idempotency, and transaction. Runtime
 * never implements these methods with generic Objective writes or the
 * skill-optimization worker.
 */
export interface HumanWorkOrchestrationPort {
  createHumanWork?(input: HumanWorkCreateRequest): Promise<unknown>;
  createRoomWork?(input: HumanWorkCreateRequest): Promise<unknown>;
  listRoomWorks?(input: { workspaceId: string; roomId: string; status?: RoomWorkRecord["status"]; cursor?: string; limit: number }): Promise<unknown>;
  viewRoomWork?(input: { workspaceId: string; roomId: string; workId: string }): Promise<unknown>;
  replyToHumanWork?(input: HumanWorkReplyRequest): Promise<unknown>;
  replyToRoomWork?(input: HumanWorkReplyRequest): Promise<unknown>;
  createHumanWorkComment?(input: HumanWorkCommentRequest): Promise<unknown>;
  createRoomWorkComment?(input: HumanWorkCommentRequest): Promise<unknown>;
  applyHumanWorkComment?(input: HumanWorkCommentApplyRequest): Promise<unknown>;
  applyRoomWorkComment?(input: HumanWorkCommentApplyRequest): Promise<unknown>;
  setHumanWorkCommentReaction?(input: {
    workspaceId: string;
    roomId: string;
    workId: string;
    commentId: string;
    reaction: "like";
    enabled: boolean;
    expectedVersion?: number;
    operationId: string;
  }): Promise<unknown>;
  setRoomWorkCommentReaction?(input: {
    workspaceId: string;
    roomId: string;
    workId: string;
    commentId: string;
    reaction: "like";
    enabled: boolean;
    expectedVersion?: number;
    operationId: string;
  }): Promise<unknown>;
  requestHumanWorkStop?(input: HumanWorkStopRequest): Promise<unknown>;
  stopRoomWork?(input: HumanWorkStopRequest): Promise<unknown>;
  confirmHumanWorkStop?(input: HumanWorkStopRequest): Promise<unknown>;
  confirmRoomWorkStop?(input: HumanWorkStopRequest): Promise<unknown>;
  markHumanWorkStopUnconfirmed?(input: HumanWorkStopRequest): Promise<unknown>;
  markRoomWorkStopUnconfirmed?(input: HumanWorkStopRequest): Promise<unknown>;
  stopHumanWorkAssignee?(input: HumanWorkStopRequest & { assignmentId: string }): Promise<unknown>;
  stopRoomWorkAssignee?(input: HumanWorkStopRequest & { assignmentId: string }): Promise<unknown>;
  reassignHumanWorkAssignee?(input: HumanWorkReassignRequest): Promise<unknown>;
  reassignRoomWorkAssignee?(input: HumanWorkReassignRequest): Promise<unknown>;
  delegateHumanWork?(input: HumanWorkDelegationRequest): Promise<unknown>;
  applyHumanWorkInstruction?(input: HumanWorkInstructionTransitionInput & { workspaceId: string; operationId: string }): Promise<unknown>;
  settleHumanWorkAssignment?(input: HumanWorkSettlementRequest & { nextAssignment: RoomWorkAssignmentRecord }): Promise<unknown>;
  writer?: HumanWorkWriterPort;
}

export interface HumanWorkInstructionApplyRequest extends HumanWorkInstructionTransitionInput {
  workspaceId: string;
  operationId: string;
}

export interface HumanWorkDelegationRequest {
  admission: HumanWorkDelegationInput;
  payload: unknown;
  trustedBinding: HumanWorkRuntimeBinding;
}

export interface HumanWorkWriterOperationInput {
  identity: HumanWorkWriterIdentity;
  ownerId: string;
  leaseMs: number;
  now?: string;
  terminalConfirmed?: boolean;
}

export class DurableWorkCoordinator {
  constructor(
    private readonly store: DurableWorkStorePort,
    private readonly runControl: BackendRunCancellationPort,
    private readonly humanWork?: HumanWorkOrchestrationPort
  ) {}

  async transitionObjective(objectiveId: string, action: "pause" | "resume" | "cancel", roomId: string, now = nowIso()) {
    const objective = await this.requireObjective(objectiveId, roomId);
    assertRoomBinding(objective.room_id, roomId, "objective");
    // Human work has a separate stop-request/terminal-confirmation protocol.
    // Reject before generic rows or Backend Runs can be changed.
    if (objective.kind === "human" && action === "cancel") {
      throw new Error("human_work_cancel_requires_stop_request");
    }
    const workItems = await this.store.listWorkItems({ objectiveId, roomId });
    for (const workItem of workItems) assertRoomBinding(workItem.room_id, roomId, "work_item");
    const transition = transitionObjectiveState({ objective, workItems, action, now });
    await this.store.saveObjective(transition.objective, roomId);
    for (const workItem of transition.workItems) await this.store.saveWorkItem(workItem, roomId);
    if (action === "cancel") {
      for (const runId of transition.cancelBackendRunIds) {
        const run = await this.store.getBackendRun(runId);
        if (!run) continue;
        await this.runControl.cancelRun(run.id);
      }
    }
    return transition;
  }

  async steer(workItemId: string, instruction: string, roomId: string, now = nowIso()): Promise<WorkItemRecord> {
    const workItem = await this.requireWorkItem(workItemId, roomId);
    assertRoomBinding(workItem.room_id, roomId, "work_item");
    return this.store.saveWorkItem(steerWorkItem({ workItem, instruction, now }), roomId);
  }

  async followUp(workItemId: string, instruction: string, roomId: string, now = nowIso()) {
    const current = await this.requireWorkItem(workItemId, roomId);
    assertRoomBinding(current.room_id, roomId, "work_item");
    const objective = await this.requireObjective(current.objective_id, roomId);
    assertRoomBinding(objective.room_id, roomId, "objective");
    const created = createFollowUpWorkItem({ objective, current, instruction, now });
    await this.store.saveWorkItem(created.workItem, roomId);
    await this.store.saveWorkDependency(created.dependency, roomId);
    return created;
  }

  /** Delegate creation to the atomic human-work Store after pure admission. */
  async createHumanWork(input: HumanWorkCreateRequest): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.requesterId, input.operationId);
    const instruction = input.instruction?.trim() ?? "";
    if (!instruction && (!input.attachments || input.attachments.length === 0)) {
      throw new Error("human_work_instruction_or_attachment_required");
    }
    const port = this.requireHumanPort();
    if (port.createHumanWork) return port.createHumanWork(input);
    if (port.createRoomWork) return port.createRoomWork(input);
    throw new Error("domain_operation_requires_workspace_server:createRoomWork");
  }

  async createRoomWork(input: HumanWorkCreateRequest): Promise<unknown> {
    return this.createHumanWork(input);
  }

  async listHumanWorks(input: { workspaceId: string; roomId: string; status?: RoomWorkRecord["status"]; cursor?: string; limit: number }): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, "list", "list");
    const port = this.requireHumanPort();
    if (!port.listRoomWorks) throw new Error("domain_operation_requires_workspace_server:listRoomWorks");
    return port.listRoomWorks(input);
  }

  async listRoomWorks(input: { workspaceId: string; roomId: string; status?: RoomWorkRecord["status"]; cursor?: string; limit: number }): Promise<unknown> {
    return this.listHumanWorks(input);
  }

  async viewHumanWork(input: { workspaceId: string; roomId: string; workId: string }): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, "view");
    const port = this.requireHumanPort();
    if (!port.viewRoomWork) throw new Error("domain_operation_requires_workspace_server:viewRoomWork");
    return port.viewRoomWork(input);
  }

  async viewRoomWork(input: { workspaceId: string; roomId: string; workId: string }): Promise<unknown> {
    return this.viewHumanWork(input);
  }

  async replyToHumanWork(input: HumanWorkReplyRequest): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, input.operationId);
    const port = this.requireHumanPort();
    if (port.replyToHumanWork) return port.replyToHumanWork(input);
    if (port.replyToRoomWork) return port.replyToRoomWork(input);
    throw new Error("domain_operation_requires_workspace_server:replyToRoomWork");
  }

  async replyToRoomWork(input: HumanWorkReplyRequest): Promise<unknown> {
    return this.replyToHumanWork(input);
  }

  async createHumanWorkComment(input: HumanWorkCommentRequest): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, input.operationId);
    const port = this.requireHumanPort();
    if (port.createHumanWorkComment) return port.createHumanWorkComment(input);
    if (port.createRoomWorkComment) return port.createRoomWorkComment(input);
    throw new Error("domain_operation_requires_workspace_server:createRoomWorkComment");
  }

  async createRoomWorkComment(input: HumanWorkCommentRequest): Promise<unknown> {
    return this.createHumanWorkComment(input);
  }

  async applyHumanWorkComment(input: HumanWorkCommentApplyRequest): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, input.operationId);
    const port = this.requireHumanPort();
    if (port.applyHumanWorkComment) return port.applyHumanWorkComment(input);
    if (port.applyRoomWorkComment) return port.applyRoomWorkComment(input);
    throw new Error("domain_operation_requires_workspace_server:applyRoomWorkComment");
  }

  async applyRoomWorkComment(input: HumanWorkCommentApplyRequest): Promise<unknown> {
    return this.applyHumanWorkComment(input);
  }

  async setHumanWorkCommentReaction(input: Parameters<NonNullable<HumanWorkOrchestrationPort["setHumanWorkCommentReaction"]>>[0]): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, input.operationId);
    const port = this.requireHumanPort();
    if (port.setHumanWorkCommentReaction) return port.setHumanWorkCommentReaction(input);
    if (port.setRoomWorkCommentReaction) return port.setRoomWorkCommentReaction(input);
    throw new Error("domain_operation_requires_workspace_server:setRoomWorkCommentReaction");
  }

  async setRoomWorkCommentReaction(input: Parameters<NonNullable<HumanWorkOrchestrationPort["setRoomWorkCommentReaction"]>>[0]): Promise<unknown> {
    return this.setHumanWorkCommentReaction(input);
  }

  /**
   * Requesting a stop never calls `transitionObjective(..., "cancel")` or
   * `runControl.cancelRun`. Only the Store/worker can later confirm or mark
   * the external execution outcome unknown.
   */
  async requestHumanWorkStop(input: HumanWorkStopRequest): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, input.operationId);
    const port = this.requireHumanPort();
    if (port.requestHumanWorkStop) return port.requestHumanWorkStop(input);
    if (port.stopRoomWork) return port.stopRoomWork(input);
    throw new Error("domain_operation_requires_workspace_server:stopRoomWork");
  }

  async stopHumanWork(input: HumanWorkStopRequest): Promise<unknown> {
    return this.requestHumanWorkStop(input);
  }

  async stopRoomWork(input: HumanWorkStopRequest): Promise<unknown> {
    return this.requestHumanWorkStop(input);
  }

  async confirmHumanWorkStop(input: HumanWorkStopRequest): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, input.operationId);
    const port = this.requireHumanPort();
    if (port.confirmHumanWorkStop) return port.confirmHumanWorkStop(input);
    if (port.confirmRoomWorkStop) return port.confirmRoomWorkStop(input);
    throw new Error("domain_operation_requires_workspace_server:confirmRoomWorkStop");
  }

  async markHumanWorkStopUnconfirmed(input: HumanWorkStopRequest): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, input.operationId);
    const port = this.requireHumanPort();
    if (port.markHumanWorkStopUnconfirmed) return port.markHumanWorkStopUnconfirmed(input);
    if (port.markRoomWorkStopUnconfirmed) return port.markRoomWorkStopUnconfirmed(input);
    throw new Error("domain_operation_requires_workspace_server:markRoomWorkStopUnconfirmed");
  }

  async transitionHumanWorkStop(input: HumanWorkStopTransitionInput): Promise<unknown> {
    const request: HumanWorkStopRequest = {
      workspaceId: input.work.workspace_id,
      roomId: input.work.room_id,
      workId: input.work.id,
      ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      ...(input.expectedGeneration === undefined ? {} : { expectedGeneration: input.expectedGeneration }),
      operationId: input.operationId
    };
    if (input.action === "request") return this.requestHumanWorkStop(request);
    return input.action === "confirm" ? this.confirmHumanWorkStop(request) : this.markHumanWorkStopUnconfirmed(request);
  }

  async stopHumanWorkAssignee(input: HumanWorkStopRequest & { assignmentId: string }): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, input.operationId);
    const port = this.requireHumanPort();
    if (port.stopHumanWorkAssignee) return port.stopHumanWorkAssignee(input);
    if (port.stopRoomWorkAssignee) return port.stopRoomWorkAssignee(input);
    throw new Error("domain_operation_requires_workspace_server:stopRoomWorkAssignee");
  }

  async reassignHumanWorkAssignee(input: HumanWorkReassignRequest): Promise<unknown> {
    requireHumanScope(input.workspaceId, input.roomId, input.workId, input.operationId);
    const port = this.requireHumanPort();
    if (port.reassignHumanWorkAssignee) return port.reassignHumanWorkAssignee(input);
    if (port.reassignRoomWorkAssignee) return port.reassignRoomWorkAssignee(input);
    throw new Error("domain_operation_requires_workspace_server:reassignRoomWorkAssignee");
  }

  async delegateHumanWork(input: HumanWorkDelegationRequest): Promise<unknown> {
    assertHumanWorkDelegation(input.admission);
    assertHumanWorkRuntimeBinding(input);
    const port = this.requireHumanPort();
    if (!port.delegateHumanWork) throw new Error("domain_operation_requires_workspace_server:delegateHumanWork");
    return port.delegateHumanWork({
      ...input,
      // Authority-bearing provider fields are ignored at this boundary. The
      // Store receives only the server-owned binding plus child intent.
      payload: sanitizeHumanWorkDelegationPayload(input.payload)
    });
  }

  createHumanWorkInstruction(input: CreateHumanWorkInstructionInput): RoomWorkInstructionRecord {
    return createHumanWorkInstruction(input);
  }

  createCommentApplyInstruction(input: CreateCommentApplyInstructionInput) {
    return createCommentApplyInstruction(input);
  }

  transitionHumanWorkInstruction(input: HumanWorkInstructionTransitionInput): RoomWorkInstructionRecord {
    return transitionHumanWorkInstruction(input);
  }

  async applyHumanWorkInstruction(input: HumanWorkInstructionApplyRequest): Promise<unknown> {
    const port = this.requireHumanPort();
    if (!port.applyHumanWorkInstruction) throw new Error("domain_operation_requires_workspace_server:applyHumanWorkInstruction");
    return port.applyHumanWorkInstruction(input);
  }

  /** Reject stale Run output before handing settlement to the atomic Store. */
  async settleHumanWorkRun(input: HumanWorkSettlementRequest): Promise<unknown> {
    const nextAssignment = settleHumanWorkAssignment(input);
    const port = this.requireHumanPort();
    if (!port.settleHumanWorkAssignment) throw new Error("domain_operation_requires_workspace_server:settleHumanWorkAssignment");
    return port.settleHumanWorkAssignment({ ...input, nextAssignment });
  }

  async settleHumanWorkAssignment(input: HumanWorkSettlementRequest): Promise<unknown> {
    return this.settleHumanWorkRun(input);
  }

  async acquireHumanWorkWriter(input: HumanWorkWriterOperationInput): Promise<HumanWorkWriterLease> {
    requireHumanScope(input.identity.workspaceId, input.identity.executionTargetId, input.ownerId, "writer");
    const writer = this.requireHumanWriter();
    const result = await writer.acquireWriter({
      ...input.identity,
      leaseMs: input.leaseMs,
      now: input.now ?? nowIso()
    });
    if (!result.acquired) throw new Error("human_work_writer_exclusion_conflict");
    assertHumanWorkWriter({ lease: result.lease, identity: input.identity, ownerId: input.ownerId });
    return result.lease;
  }

  async releaseHumanWorkWriter(lease: HumanWorkWriterLease, terminalConfirmed: boolean, now = nowIso()): Promise<void> {
    await this.requireHumanWriter().releaseWriter({ ...lease, terminalConfirmed, now });
  }

  /** Keep a same-target writer lease through non-terminal work. */
  async withHumanWorkWriter<T>(input: HumanWorkWriterOperationInput, operation: (lease: HumanWorkWriterLease) => Promise<T>): Promise<T> {
    const lease = await this.acquireHumanWorkWriter(input);
    try {
      return await operation(lease);
    } finally {
      if (input.terminalConfirmed === true) await this.releaseHumanWorkWriter(lease, true);
    }
  }

  private requireHumanPort(): HumanWorkOrchestrationPort {
    return this.humanWork ?? (this.store as unknown as HumanWorkOrchestrationPort);
  }

  private requireHumanWriter(): HumanWorkWriterPort {
    const writer = this.requireHumanPort().writer;
    if (!writer) throw new Error("domain_operation_requires_workspace_server:humanWorkWriter");
    return writer;
  }

  private async requireObjective(id: string, roomId: string): Promise<ObjectiveRecord> {
    const objective = await this.store.getObjective(id, roomId);
    if (!objective) throw new Error(`objective_not_found:${id}`);
    return objective;
  }

  private async requireWorkItem(id: string, roomId: string): Promise<WorkItemRecord> {
    const workItem = await this.store.getWorkItem(id, roomId);
    if (!workItem) throw new Error(`work_item_not_found:${id}`);
    return workItem;
  }
}

function assertRoomBinding(recordRoomId: string | undefined, requestedRoomId: string, resourceKind: "objective" | "work_item"): void {
  if (!requestedRoomId.trim() || recordRoomId !== requestedRoomId) {
    throw new Error(`${resourceKind}_room_access_denied`);
  }
}

function assertHumanWorkRuntimeBinding(input: HumanWorkDelegationRequest): void {
  const binding = input.trustedBinding;
  const required = [
    binding.workspaceId,
    binding.roomId,
    binding.workId,
    binding.parentAssignmentId,
    binding.runId,
    binding.actorId,
    binding.requestedByParticipantId,
    binding.agentId
  ];
  if (required.some((value) => typeof value !== "string" || !value.trim())
    || !Number.isSafeInteger(binding.generation)
    || binding.generation < 0) {
    throw new Error("human_work_runtime_binding_invalid");
  }
  if (input.admission.work.id !== binding.workId || input.admission.parentAssignmentId !== binding.parentAssignmentId) {
    throw new Error("human_work_runtime_binding_mismatch");
  }
  const parent = input.admission.assignments.find((assignment) => assignment.id === binding.parentAssignmentId);
  if (!parent
    || parent.workspace_id !== binding.workspaceId
    || parent.room_id !== binding.roomId
    || parent.work_id !== binding.workId
    || parent.agent_id !== binding.agentId
    || parent.generation !== binding.generation) {
    throw new Error("human_work_runtime_binding_mismatch");
  }
}

const humanWorkDelegationAuthorityKeys = new Set([
  "workspace", "room", "work", "assignee", "assignment", "run", "parent", "parent_run", "parentrun",
  "parent_assignment", "parentassignment", "actor", "requester", "principal", "authority",
  "workspace_id", "workspaceid", "room_id", "roomid", "work_id", "workid",
  "assignment_id", "assignmentid", "assignee_id", "assigneeid",
  "parent_assignment_id", "parentassignmentid", "parent_assignee_id", "parentassigneeid",
  "parent_run_id", "parentrunid", "run_id", "runid", "actor_id", "actorid",
  "account_id", "accountid", "participant_id", "participantid", "requester_id", "requesterid",
  "requested_by_participant_id", "requestedbyparticipantid", "generation", "expected_generation",
  "expectedgeneration", "expected_version", "expectedversion", "control_generation", "controlgeneration",
  "runtime_binding", "runtimebinding", "execution_binding", "executionbinding"
]);

function sanitizeHumanWorkDelegationPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => {
    const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
    return !humanWorkDelegationAuthorityKeys.has(normalized)
      && !humanWorkDelegationAuthorityKeys.has(normalized.replace(/_/g, ""));
  }));
}

function requireHumanScope(workspaceId: string, roomId: string, resourceId: string, operationId: string): void {
  if (!workspaceId.trim() || !roomId.trim() || !resourceId.trim() || !operationId.trim()) {
    throw new Error("human_work_scope_required");
  }
}
