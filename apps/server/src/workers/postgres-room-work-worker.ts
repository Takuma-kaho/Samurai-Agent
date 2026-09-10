import { createHash } from "node:crypto";
import { ResourceRefSchema, RoomWorkResultResourceRefSchema, WorkspaceFileResourceRefSchema, nowIso, type ResourceRef, type RoomWorkResultResourceRef, type SessionRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import type { RunChatTurnResult } from "@samurai-agent/runtime";
import {
  WorkspaceServerError,
  type WorkspaceRequestContext,
  type WorkspaceServerStore
} from "@samurai-agent/workspace-server";
import type {
  PostgresRuntimeCommandService,
  PostgresRuntimeExecutionBinding,
  PostgresRuntimeExternalContinuation
} from "../adapters/runtime/postgres-runtime-chat";
import type { WorkspaceRoomWorkStopWorkerPort, WorkspaceRoomWorkWorkerPort } from "./workspace-worker-supervisor";

/**
 * The persistence lane owns the exact SQL shape of a Room-work reservation.
 * Until that API is exported by `WorkspaceServerStore`, this adapter keeps the
 * server composition typed and fails closed rather than falling back to the
 * legacy skill-optimization records.
 */
export interface PostgresRoomWorkWorkerOptions {
  store: WorkspaceServerStore;
  runtimeFor(context: WorkspaceRequestContext, operationId: string): PostgresRuntimeCommandService;
  leaseMs?: number;
}

interface RoomWorkReservation {
  workId: string;
  assigneeId: string;
  assignmentId: string;
  roomId: string;
  agentId?: string;
  instruction: string;
  attachments: ResourceRef[];
  /** A malformed attachment payload is terminal for this reservation. */
  attachmentError?: string;
  generation: number;
  reservationId?: string;
  leaseOwner?: string;
  /** Existing Runtime Run found during lease recovery; never launch twice. */
  currentRunId?: string;
  originKind?: "normal" | "delegated" | "parent_continuation";
  agentConfigurationVersion?: number;
  sessionId?: string;
  /** Parent assignment proven by the Store's runtime_binding check. */
  parentAssigneeId?: string;
  /** Structured continuation candidate proven by the Store. */
  resumeBackendContinuation?: PostgresRuntimeExternalContinuation;
}

interface RoomWorkStoreAdapter {
  claimRoomWorkStopDispatch?: (context: WorkspaceRequestContext, input: {
    workerId: string;
    leaseMs: number;
    now: string;
    limit: number;
  }) => Promise<unknown>;
  reconcileRoomWorkStopDispatch?: (context: WorkspaceRequestContext, input: {
    controlId: string;
    workerId: string;
    assignmentId: string;
    runId?: string;
    outcome: "completed" | "failed" | "cancelled" | "outcome_unknown";
  }) => Promise<unknown>;
  claimRoomWorkReservation?: (context: WorkspaceRequestContext, input: {
    workerId: string;
    leaseMs: number;
    now: string;
    limit: number;
  }) => Promise<unknown>;
  settleRoomWorkAssignment?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  readRoomWorkCompletionEvidence?: (context: WorkspaceRequestContext, input: {
    workId: string;
    assignmentId: string;
    roomId: string;
    runId: string;
  }) => Promise<unknown>;
  viewRoomWork?: (context: WorkspaceRequestContext, input: { roomId: string; workId: string }) => Promise<unknown>;
  getAgent?: (context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, agentId: string) => Promise<unknown>;
}

interface RoomWorkCompletionEvidence {
  runId: string;
  runStatus: string;
  outputSummary?: string | null;
  resourceRefs: RoomWorkResultResourceRef[];
}

/**
 * Claims and runs one durable Room assignment at a time.  The worker never
 * accepts a Session ID from the public API: it creates or reuses the internal
 * SessionRef returned by the Store after the reservation has been durably
 * claimed.
 */
export class PostgresRoomWorkWorker implements WorkspaceRoomWorkWorkerPort, WorkspaceRoomWorkStopWorkerPort {
  private readonly leaseMs: number;
  private readonly storeAdapter: RoomWorkStoreAdapter;
  private closed = false;

  constructor(private readonly options: PostgresRoomWorkWorkerOptions) {
    this.leaseMs = boundedDuration(options.leaseMs ?? 60_000, 1_000, 86_400_000);
    this.storeAdapter = options.store as unknown as RoomWorkStoreAdapter;
  }

  async runTick(
    context: WorkspaceRequestContext,
    input: { workerId: string; maxRuns: number; signal: AbortSignal }
  ): Promise<{ claimed: number; completed: number; outcomeUnknown: number }> {
    if (this.closed || input.signal.aborted) return { claimed: 0, completed: 0, outcomeUnknown: 0 };
    const claim = this.storeAdapter.claimRoomWorkReservation;
    if (!claim) throw new WorkspaceServerError("room_work_worker_store_api_unavailable", 503);

    let claimedCount = 0;
    let completed = 0;
    let outcomeUnknown = 0;
    const limit = boundedInteger(input.maxRuns, 1, 100);
    for (let index = 0; index < limit; index += 1) {
      if (this.closed || input.signal.aborted) break;
      const raw = await claim.call(this.storeAdapter, context, {
        workerId: input.workerId,
        leaseMs: this.leaseMs,
        now: nowIso(),
        limit: 1
      });
      const claimedReservation = normalizeReservation(raw);
      if (!claimedReservation) break;
      claimedCount += 1;

      const operationId = roomWorkRuntimeOperationId(claimedReservation);
      const runContext = { ...context, operationId };
      let settlementAttempted = false;
      let runtimeRunId: string | undefined;
      try {
        if (!claimedReservation.reservationId || !claimedReservation.leaseOwner) {
          throw new WorkspaceServerError("room_work_reservation_lease_missing", 409);
        }
        if (claimedReservation.leaseOwner !== input.workerId) {
          throw new WorkspaceServerError("room_work_reservation_lease_owner_mismatch", 409);
        }
        if (claimedReservation.attachmentError) {
          throw new WorkspaceServerError(claimedReservation.attachmentError, 400);
        }
        const reservation = claimedReservation.instruction
          ? claimedReservation
          : await this.hydrateReservation(context, claimedReservation);
        if (!reservation) throw new WorkspaceServerError("room_work_reservation_payload_missing", 500);
        if (reservation.attachmentError) {
          throw new WorkspaceServerError(reservation.attachmentError, 400);
        }
        const runtime = this.options.runtimeFor(runContext, operationId);
        if (claimedReservation.currentRunId) {
          // A claimed lease can expire while its Runtime Run is still
          // progressing (or while its terminal row is becoming visible).
          // Recovery must reconcile that Run and must never call chat.turn.run
          // a second time. Missing/unknown evidence stays outcome_unknown so
          // the stop/confirmation lane can decide what to do next.
          let existingRun: { id?: string; status?: string; output_summary?: string | null } | undefined;
          try {
            const getBackendRun = runtime.getBackendRun;
            existingRun = typeof getBackendRun === "function"
              ? await getBackendRun.call(runtime, claimedReservation.currentRunId)
              : undefined;
          } catch {
            existingRun = undefined;
          }
          let completionEvidence: RoomWorkCompletionEvidence | undefined;
          try {
            completionEvidence = await this.readCompletionEvidence(runContext, {
              workId: claimedReservation.workId,
              assignmentId: claimedReservation.assignmentId,
              roomId: claimedReservation.roomId,
              runId: claimedReservation.currentRunId
            });
          } catch (error) {
            // A terminal Runtime row without reconstructable Server evidence
            // is not a successful Work result. Keep the assignment explicitly
            // unknown so a later control/recovery pass can inspect it again;
            // never launch the Backend a second time.
            const evidenceErrorCode = errorCode(error);
            settlementAttempted = true;
            await this.settle(runContext, claimedReservation, {
              status: "outcome_unknown",
              runId: claimedReservation.currentRunId,
              errorCode: evidenceErrorCode,
              errorMessage: error instanceof Error ? error.message : String(error),
              result: {
                status: "outcome_unknown",
                recovery: true,
                runtime_run_id: claimedReservation.currentRunId,
                ...(existingRun?.status ? { runtime_status: existingRun.status } : {}),
                error_code: evidenceErrorCode
              },
              now: nowIso()
            });
            outcomeUnknown += 1;
            continue;
          }
          const recoveredStatus = recoveryTerminalStatus(completionEvidence.runStatus);
          const recoveredRunId = completionEvidence.runId === claimedReservation.currentRunId
            ? completionEvidence.runId
            : undefined;
          settlementAttempted = true;
          await this.settle(runContext, claimedReservation, {
            status: recoveredStatus,
            ...(recoveredRunId ? { runId: recoveredRunId } : {}),
            ...(recoveredStatus === "completed" && (completionEvidence.outputSummary ?? existingRun?.output_summary)
              ? { outputSummary: completionEvidence.outputSummary ?? existingRun?.output_summary ?? undefined }
              : {}),
            result: {
              status: recoveredStatus,
              recovery: true,
              runtime_run_id: claimedReservation.currentRunId,
              runtime_status: completionEvidence.runStatus,
              ...(recoveredStatus === "completed" ? { resource_refs: completionEvidence.resourceRefs } : {}),
              ...(completionEvidence.outputSummary ?? existingRun?.output_summary
                ? { output_summary: completionEvidence.outputSummary ?? existingRun?.output_summary }
                : {})
            },
            now: nowIso()
          });
          if (recoveredStatus === "outcome_unknown") outcomeUnknown += 1;
          else if (recoveredStatus === "completed") completed += 1;
          continue;
        }
        const sessionId = await this.ensureInternalSession(runtime, runContext, reservation, operationId, input.signal);
        const agentConfigurationVersion = await this.resolveAgentConfigurationVersion(context, reservation);
        const executionBinding: PostgresRuntimeExecutionBinding = {
          workId: reservation.workId,
          assigneeId: reservation.assigneeId,
          ...(reservation.parentAssigneeId ? { parentAssigneeId: reservation.parentAssigneeId } : {}),
          generation: reservation.generation,
          agentConfigurationVersion,
          reservationId: reservation.reservationId,
          leaseOwner: reservation.leaseOwner
        };
        const result = await runtime.runDomainCommand({
          operationId: "chat.turn.run",
          context: roomWorkDomainContext(runContext, reservation.roomId, sessionId, operationId, input.signal),
          input: {
            content: reservation.instruction,
            ...(reservation.agentId ? { agent_id: reservation.agentId } : {}),
            attachments: reservation.attachments
          },
          executionBinding,
          ...(reservation.resumeBackendContinuation ? { resumeBackendContinuation: reservation.resumeBackendContinuation } : {}),
          signal: input.signal
        }) as RunChatTurnResult;
        runtimeRunId = stringValue(recordValue((result as unknown as Record<string, unknown>).backendRun), "id") || undefined;
        assertRunChatTurnResult(result);
        runtimeRunId = result.backendRun.id;
        const settledStatus = terminalStatus(result.backendRun.status);
        const completionEvidence = settledStatus === "completed"
          ? await this.readCompletionEvidence(runContext, {
              workId: reservation.workId,
              assignmentId: reservation.assignmentId,
              roomId: reservation.roomId,
              runId: result.backendRun.id
            })
          : undefined;
        if (completionEvidence && completionEvidence.runStatus !== "completed") {
          throw new WorkspaceServerError(
            completionEvidence.runStatus === "failed"
              ? "room_work_completion_status_failed"
              : "room_work_completion_status_unknown",
            409
          );
        }
        settlementAttempted = true;
        await this.settle(runContext, claimedReservation, {
          status: settledStatus,
          runId: result.backendRun.id,
          outputSummary: result.backendRun.output_summary ?? undefined,
          result: {
            run_id: result.backendRun.id,
            status: result.backendRun.status,
            ...(completionEvidence ? { resource_refs: completionEvidence.resourceRefs } : {}),
            ...(result.backendRun.output_summary ? { output_summary: result.backendRun.output_summary } : {})
          },
          now: nowIso()
        });
        if (settledStatus === "outcome_unknown") outcomeUnknown += 1;
        else if (settledStatus === "completed") completed += 1;
      } catch (error) {
        // A settlement failure is a durable-lifecycle failure, not a runtime
        // outcome. Do not reinterpret it as a second failed settlement: that
        // can overwrite a successful backend result and, when the Store is
        // unavailable, leave the claimed assignment running while the worker
        // reports a successful tick.
        if (settlementAttempted) {
          // Another worker can reconcile the same leased assignment through a
          // stop control after Runtime has committed terminal evidence. That
          // is a successful durable race, not a reason to write a second
          // failed outcome or fail the whole supervisor tick.
          if (isExpectedStopSettlementRace(error)) continue;
          throw error;
        }
        // A stopped process or provider with unknown side effects must not be
        // reported as a clean cancellation. The Store decides whether a
        // terminal evidence row exists and keeps `unconfirmed` otherwise.
        const status = input.signal.aborted || isOutcomeUnknown(error)
          ? "outcome_unknown"
          : isRoomWorkAdmissionClosed(error) ? "cancelled"
            : "failed";
        try {
          await this.settle(runContext, claimedReservation, {
            status,
            errorCode: errorCode(error),
            errorMessage: error instanceof Error ? error.message : String(error),
            result: {
              status,
              error_code: errorCode(error),
              ...(runtimeRunId ? { run_id: runtimeRunId } : {}),
              ...(error instanceof Error ? { error_message: error.message } : {})
            },
            ...(runtimeRunId ? { runId: runtimeRunId } : {}),
            now: nowIso()
          });
        } catch (settlementError) {
          if (!isExpectedStopSettlementRace(settlementError)) throw settlementError;
        }
        if (status === "outcome_unknown") outcomeUnknown += 1;
      }
    }
    return { claimed: claimedCount, completed, outcomeUnknown };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /**
   * Stop dispatch is exposed as a separate lane for the Supervisor. The
   * normal runTick is intentionally limited to launch/settlement, while this
   * method lets active long-running Runs be cancelled without waiting for
   * runChatTurn in that launch lane to settle.
   */
  async runStopTick(
    context: WorkspaceRequestContext,
    input: { workerId: string; maxRuns: number; signal: AbortSignal }
  ): Promise<void> {
    if (this.closed || input.signal.aborted) return;
    await this.dispatchPendingStops(context, input);
  }

  private async dispatchPendingStops(
    context: WorkspaceRequestContext,
    input: { workerId: string; maxRuns: number; signal: AbortSignal }
  ): Promise<void> {
    const claim = this.storeAdapter.claimRoomWorkStopDispatch;
    const reconcile = this.storeAdapter.reconcileRoomWorkStopDispatch;
    // Older focused fakes intentionally model only the launch lane. The
    // deployed Server is fail-closed on migration state; this compatibility
    // branch exists solely so those narrow unit tests can exercise the
    // independent run/settle behavior.
    if (!claim || !reconcile) return;
    const limit = boundedInteger(input.maxRuns, 1, 100);
    for (let index = 0; index < limit; index += 1) {
      if (this.closed || input.signal.aborted) return;
      const raw = await claim.call(this.storeAdapter, context, {
        workerId: input.workerId,
        leaseMs: this.leaseMs,
        now: nowIso(),
        limit: 1
      });
      const dispatch = normalizeStopDispatch(raw);
      if (!dispatch) return;
      const operationId = roomWorkStopOperationId(dispatch);
      const dispatchContext = { ...context, operationId };
      for (const target of dispatch.targets) {
        if (this.closed || input.signal.aborted) return;
        let outcome: "completed" | "failed" | "cancelled" | "outcome_unknown" = "outcome_unknown";
        let runId = target.runId;
        try {
          if (runId) {
            const runtime = this.options.runtimeFor(dispatchContext, operationId);
            const controlResult = await runtime.executeRunControlAction({
              action: "cancel",
              runId,
              resumeInput: {},
              idempotencyKey: `${operationId}:cancel:${target.assignmentId}`
            });
            const run = "backendRun" in controlResult ? controlResult.backendRun : controlResult;
            outcome = stopOutcome(run.status);
          }
        } catch {
          // The SQL reconciliation below records this as unknown instead of
          // fabricating cancellation. It can be retried after the dispatch
          // lease expires and can later consume delayed Runtime evidence.
          outcome = "outcome_unknown";
        }
        try {
          await reconcile.call(this.storeAdapter, dispatchContext, {
            controlId: dispatch.controlId,
            workerId: input.workerId,
            assignmentId: target.assignmentId,
            ...(runId ? { runId } : {}),
            outcome
          });
        } catch (error) {
          // A concurrent original worker may have settled the same Run
          // immediately after cancellation. The control will be picked up on
          // a later tick to aggregate its durable state.
          if (isExpectedStopSettlementRace(error)) continue;
          throw error;
        }
      }
      // A control with no remaining targets can have been terminally
      // confirmed by the SQL claim itself. A pending control with targets is
      // retried on the next loop/tick until every target has terminal proof.
      if (dispatch.targets.length === 0) continue;
    }
  }

  private async hydrateReservation(
    context: WorkspaceRequestContext,
    reservation: RoomWorkReservation
  ): Promise<RoomWorkReservation | undefined> {
    const viewRoomWork = this.storeAdapter.viewRoomWork;
    if (!viewRoomWork || !reservation.roomId || !reservation.workId) return undefined;
    const raw = await viewRoomWork.call(this.storeAdapter, context, {
      roomId: reservation.roomId,
      workId: reservation.workId
    });
    const view = nestedRecord(raw, "view", "workView", "work", "roomWork");
    const assignments = Array.isArray(view.assignments) ? view.assignments : [];
    const assignment = assignments
      .map(recordValue)
      .find((candidate) => stringValue(candidate, "id", "assignment_id", "assignmentId", "assignee_id", "assigneeId") === reservation.assignmentId);
    const instructions = Array.isArray(view.instructions) ? view.instructions : [];
    const instruction = instructions
      .map(recordValue)
      .filter((candidate) => {
        const assignmentId = stringValue(candidate, "assignment_id", "assignmentId");
        return !assignmentId || assignmentId === reservation.assignmentId;
      })
      .sort((left, right) => (numberValue(right, "version") ?? 0) - (numberValue(left, "version") ?? 0))[0];
    const body = stringValue(instruction ?? {}, "body", "instruction", "content", "prompt");
    if (!body) return undefined;
    const agentId = reservation.agentId || stringValue(assignment ?? {}, "agent_id", "agentId");
    const parsedAttachments = instruction?.attachments === undefined
      ? { attachments: reservation.attachments }
      : parseRoomWorkAttachments(instruction.attachments);
    return {
      ...reservation,
      ...(agentId ? { agentId } : {}),
      instruction: body,
      attachments: parsedAttachments.attachments,
      ...(parsedAttachments.error ? { attachmentError: parsedAttachments.error } : {}),
      ...(numberValue(assignment ?? {}, "generation") === undefined ? {} : { generation: numberValue(assignment ?? {}, "generation")! })
    };
  }

  private async ensureInternalSession(
    runtime: PostgresRuntimeCommandService,
    context: WorkspaceRequestContext,
    reservation: RoomWorkReservation,
    operationId: string,
    signal: AbortSignal
  ): Promise<string> {
    if (reservation.sessionId) return reservation.sessionId;
    const sessionOperationId = `${operationId}:session`;
    const session = await runtime.runDomainCommand({
      operationId: "session.create",
      context: roomWorkDomainContext(context, reservation.roomId, undefined, sessionOperationId, signal),
      input: {
        room_id: reservation.roomId,
        title: reservation.instruction.slice(0, 200)
      }
    }) as SessionRecord;
    return session.id;
  }

  private async resolveAgentConfigurationVersion(
    context: WorkspaceRequestContext,
    reservation: RoomWorkReservation
  ): Promise<number> {
    if (reservation.agentConfigurationVersion !== undefined) {
      return validPositiveVersion(reservation.agentConfigurationVersion, "room_work_agent_configuration_version_invalid");
    }
    if (!reservation.agentId || !this.storeAdapter.getAgent) {
      throw new WorkspaceServerError("room_work_agent_snapshot_unavailable", 503);
    }
    const raw = await this.storeAdapter.getAgent.call(this.storeAdapter, {
      workspaceId: context.workspaceId,
      accountId: context.accountId
    }, reservation.agentId);
    const version = numberValue(recordValue(raw), "version", "configuration_version", "agent_configuration_version", "agentConfigurationVersion");
    return validPositiveVersion(version, "room_work_agent_configuration_version_invalid");
  }

  private async settle(
    context: WorkspaceRequestContext,
    reservation: RoomWorkReservation,
    result: {
      status: "completed" | "failed" | "cancelled" | "waiting" | "outcome_unknown";
      runId?: string;
      outputSummary?: string;
      errorCode?: string;
      errorMessage?: string;
      result?: Record<string, unknown>;
      now: string;
    }
  ): Promise<void> {
    const settle = this.storeAdapter.settleRoomWorkAssignment;
    if (!settle) throw new WorkspaceServerError("room_work_worker_store_api_unavailable", 503);
    await settle.call(this.storeAdapter, context, {
      workId: reservation.workId,
      assigneeId: reservation.assigneeId,
      assignmentId: reservation.assignmentId,
      ...(reservation.reservationId ? { reservationId: reservation.reservationId } : {}),
      ...(reservation.leaseOwner ? { leaseOwner: reservation.leaseOwner } : {}),
      generation: reservation.generation,
      status: result.status,
      ...(result.result ? { result: result.result } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      now: result.now
    });
  }

  private async readCompletionEvidence(
    context: WorkspaceRequestContext,
    input: { workId: string; assignmentId: string; roomId: string; runId: string }
  ): Promise<RoomWorkCompletionEvidence> {
    const read = this.storeAdapter.readRoomWorkCompletionEvidence;
    if (!read) throw new WorkspaceServerError("room_work_completion_evidence_unavailable", 503);
    const value = await read.call(this.storeAdapter, context, input);
    const body = recordValue(value);
    const runId = stringValue(body, "runId", "run_id");
    const runStatus = stringValue(body, "runStatus", "run_status", "status");
    const outputSummary = body.outputSummary ?? body.output_summary;
    const refs = RoomWorkResultResourceRefSchema.array().max(32).safeParse(body.resourceRefs ?? body.resource_refs);
    if (!runId || !runStatus || !refs.success || (outputSummary !== undefined && outputSummary !== null && typeof outputSummary !== "string")) {
      throw new WorkspaceServerError("room_work_completion_evidence_invalid", 500);
    }
    if (runId !== input.runId) throw new WorkspaceServerError("room_work_completion_evidence_binding_invalid", 409);
    return {
      runId,
      runStatus,
      ...(outputSummary === undefined || outputSummary === null ? {} : { outputSummary }),
      resourceRefs: refs.data
    };
  }
}

const roomWorkCompletionResourceKinds = new Set([
  "artifact",
  "artifact_revision",
  "generated_surface",
  "generated_surface_revision"
]);

const runChatTurnResultArrayFields = [
  "messages",
  "messagePresentations",
  "backendEvents",
  "workspaceChanges",
  "operations",
  "policyDecisions",
  "artifacts",
  "memories",
  "approvalRequests",
  "auditRecords",
  "rollbackPoints",
  "activity",
  "reflectionRuns",
  "reflectionSuggestions",
  "toolRuns"
] as const;
const roomWorkCompletionArrayFields = ["backendEvents", "workspaceChanges", "operations", "artifacts"] as const;

function assertArrayFields(body: Record<string, any>, fields: readonly string[]): void {
  for (const field of fields) {
    if (!Array.isArray(body[field])) {
      throw new WorkspaceServerError("room_work_result_contract_invalid", 500);
    }
  }
}

function assertRunChatTurnResult(value: unknown): asserts value is RunChatTurnResult {
  const body = recordValue(value);
  const session = recordValue(body.session);
  const backendRun = recordValue(body.backendRun);
  if (!stringValue(session, "id") || !stringValue(backendRun, "id") || !stringValue(backendRun, "status")) {
    throw new WorkspaceServerError("room_work_result_contract_invalid", 500);
  }
  assertArrayFields(body, runChatTurnResultArrayFields);
}

/**
 * Completion evidence comes only from Runtime's server-persisted projections:
 * event refs, Workspace changes, operation result refs, and server Artifact
 * records. Provider messages/tool output are intentionally not inspected.
 */
export function roomWorkCompletionResourceRefs(
  result: Pick<RunChatTurnResult, "backendEvents" | "workspaceChanges" | "operations" | "artifacts">,
  runId: string,
  workId: string,
  roomId: string
): ResourceRef[] {
  assertArrayFields(recordValue(result), roomWorkCompletionArrayFields);
  const backendEvents = result.backendEvents;
  const workspaceChanges = result.workspaceChanges;
  const operations = result.operations;
  const artifacts = result.artifacts;
  const candidates: unknown[] = [];
  for (const event of backendEvents) {
    if (event.run_id !== runId) continue;
    if (!Array.isArray(event.resource_refs)) {
      throw new WorkspaceServerError("room_work_result_contract_invalid", 500);
    }
    candidates.push(...event.resource_refs);
  }
  for (const change of workspaceChanges) {
    if (change.run_id === runId && (!change.room_id || change.room_id === roomId)) candidates.push(change.resource_ref);
  }
  for (const operation of operations) {
    if ((!operation.run_id || operation.run_id === runId) && (!operation.room_id || operation.room_id === roomId) && operation.result_ref) {
      candidates.push(operation.result_ref);
    }
  }
  const changedResourceIds = new Set(workspaceChanges
    .filter((change) => change.run_id === runId && (!change.room_id || change.room_id === roomId))
    .map((change) => change.resource_ref.id));
  for (const artifact of artifacts) {
    const metadata = artifact.metadata;
    const sourceRunId = typeof metadata.source_run_id === "string" ? metadata.source_run_id : undefined;
    const sourceWorkId = typeof metadata.source_work_id === "string" ? metadata.source_work_id : undefined;
    if (sourceRunId !== runId && sourceWorkId !== workId && !changedResourceIds.has(artifact.id) && !changedResourceIds.has(artifact.file_ref.id)) continue;
    candidates.push({
      kind: "artifact",
      id: artifact.id,
      uri: `artifacts/${artifact.id}`,
      label: artifact.title
    });
    if (artifact.file_ref.kind === "artifact_revision") {
      candidates.push({
        ...artifact.file_ref,
        parent_id: artifact.id
      });
    }
  }

  const refs: ResourceRef[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const candidateRecord = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : undefined;
    const { parent_id: _parentId, ...genericCandidate } = candidateRecord ?? {};
    const generic = ResourceRefSchema.safeParse(genericCandidate);
    if (!generic.success) throw new WorkspaceServerError("room_work_resource_reference_invalid", 500);
    if (!roomWorkCompletionResourceKinds.has(generic.data.kind)) continue;
    const parsed = RoomWorkResultResourceRefSchema.safeParse(candidate);
    if (!parsed.success) throw new WorkspaceServerError("room_work_resource_reference_invalid", 500);
    const key = `${parsed.data.kind}|${parsed.data.id}|${parsed.data.uri}|${parsed.data.version ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(parsed.data);
  }
  return refs;
}

function roomWorkDomainContext(
  context: WorkspaceRequestContext,
  roomId: string,
  sessionId: string | undefined,
  operationId: string,
  signal: AbortSignal
): TrustedDomainContext {
  return {
    inputSource: "automation",
    workspaceId: context.workspaceId,
    actorId: context.accountId,
    roomId,
    ...(sessionId ? { sessionId } : {}),
    correlationId: operationId,
    idempotencyKey: operationId,
    signal
  };
}

interface RoomWorkStopDispatchTarget {
  assignmentId: string;
  runId?: string;
}

interface RoomWorkStopDispatch {
  controlId: string;
  workId: string;
  targets: RoomWorkStopDispatchTarget[];
}

function normalizeStopDispatch(value: unknown): RoomWorkStopDispatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const controlId = stringValue(body as Record<string, any>, "control_id", "controlId");
  const workId = stringValue(body as Record<string, any>, "work_id", "workId");
  if (!controlId || !workId) return undefined;
  const rawTargets = Array.isArray(body.targets) ? body.targets : [];
  const targets = rawTargets.flatMap((value) => {
    const target = recordValue(value);
    const assignmentId = stringValue(target, "assignment_id", "assignmentId", "assignee_id", "assigneeId");
    if (!assignmentId) return [];
    const runId = stringValue(target, "run_id", "runId");
    return [{ assignmentId, ...(runId ? { runId } : {}) }];
  });
  return { controlId, workId, targets };
}

function roomWorkStopOperationId(dispatch: RoomWorkStopDispatch): string {
  const digest = createHash("sha256")
    .update(`${dispatch.workId}|${dispatch.controlId}`)
    .digest("hex")
    .slice(0, 48);
  return `room_work_stop_${digest}`;
}

function stopOutcome(status: string): "completed" | "failed" | "cancelled" | "outcome_unknown" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return "outcome_unknown";
}

function normalizeReservation(value: unknown): RoomWorkReservation | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  const body = recordValue(value);
  const candidate = nestedRecord(body, "reservation", "assignment", "assignee", "work");
  const work = nestedRecord(body, "work");
  const assignee = nestedRecord(body, "assignee", "assignment");
  const workId = stringValue(candidate, "work_id", "workId") || stringValue(work, "id", "work_id", "workId");
  const assignmentId = stringValue(candidate, "assignment_id", "assignmentId", "assignee_id", "assigneeId")
    || stringValue(assignee, "id", "assignment_id", "assignmentId", "assignee_id", "assigneeId");
  const assigneeId = stringValue(candidate, "assignee_id", "assigneeId", "assignment_id", "assignmentId")
    || stringValue(assignee, "agent_assignment_id", "agentAssignmentId", "id", "assignment_id", "assignmentId", "assignee_id", "assigneeId");
  const roomId = stringValue(candidate, "room_id", "roomId") || stringValue(work, "room_id", "roomId");
  const instruction = stringValue(candidate, "instruction", "content", "prompt") || stringValue(body, "instruction", "content", "prompt");
  if (!workId || !assigneeId || !assignmentId || !roomId) return undefined;
  const parsedAttachments = candidate.attachments === undefined
    ? { attachments: [] as ResourceRef[] }
    : parseRoomWorkAttachments(candidate.attachments);
  const generation = numberValue(candidate, "generation") ?? numberValue(assignee, "generation") ?? numberValue(work, "generation") ?? 0;
  const originKindValue = stringValue(candidate, "origin_kind", "originKind");
  const originKind = originKindValue === "delegated" || originKindValue === "parent_continuation" || originKindValue === "normal"
    ? originKindValue
    : undefined;
  // A delegated child must always create its own internal Session.  The
  // Store's v107 SQL projection already omits parent Session fields; this
  // second guard prevents a stale/legacy row from reintroducing them through
  // a worker hydration payload.
  const delegatedChild = originKind === "delegated";
  const continuation = delegatedChild ? undefined : roomWorkContinuationFromReservation(candidate);
  return {
    workId,
    assigneeId,
    assignmentId,
    roomId,
    ...(stringValue(candidate, "agent_id", "agentId") || stringValue(assignee, "agent_id", "agentId") ? { agentId: stringValue(candidate, "agent_id", "agentId") || stringValue(assignee, "agent_id", "agentId") } : {}),
    instruction,
    attachments: parsedAttachments.attachments,
    ...(parsedAttachments.error ? { attachmentError: parsedAttachments.error } : {}),
    generation,
    ...(numberValue(candidate, "agent_configuration_version", "agentConfigurationVersion", "configuration_version", "agent_version") === undefined
      ? {}
      : { agentConfigurationVersion: numberValue(candidate, "agent_configuration_version", "agentConfigurationVersion", "configuration_version", "agent_version") }),
    ...(stringValue(candidate, "reservation_id", "reservationId") ? { reservationId: stringValue(candidate, "reservation_id", "reservationId") } : {}),
    ...(stringValue(candidate, "lease_owner", "leaseOwner") ? { leaseOwner: stringValue(candidate, "lease_owner", "leaseOwner") } : {}),
    ...(stringValue(candidate, "current_run_id", "currentRunId") ? { currentRunId: stringValue(candidate, "current_run_id", "currentRunId") } : {}),
    ...(originKind ? { originKind } : {}),
    ...(!delegatedChild && stringValue(candidate, "session_id", "sessionId") ? { sessionId: stringValue(candidate, "session_id", "sessionId") } : {}),
    ...(!delegatedChild && stringValue(candidate, "parent_assignee_id", "parentAssigneeId")
      ? { parentAssigneeId: stringValue(candidate, "parent_assignee_id", "parentAssigneeId") }
      : {}),
    ...(continuation ? { resumeBackendContinuation: continuation } : {})
  };
}

function roomWorkContinuationFromReservation(
  candidate: Record<string, any>
): PostgresRuntimeExternalContinuation | undefined {
  const raw = candidate.resume_backend_continuation ?? candidate.resumeBackendContinuation ?? candidate.continuation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const parent = raw.parent;
  const backendSessionId = stringValue(raw, "backend_session_id", "backendSessionId");
  if (!parent || typeof parent !== "object" || Array.isArray(parent) || !backendSessionId) return undefined;
  const parentRecord = parent as Record<string, any>;
  const workspaceId = stringValue(parentRecord, "workspace_id", "workspaceId");
  const roomId = stringValue(parentRecord, "room_id", "roomId");
  const sessionId = stringValue(parentRecord, "session_id", "sessionId");
  const workId = stringValue(parentRecord, "work_id", "workId");
  const assigneeId = stringValue(parentRecord, "assignee_id", "assigneeId");
  const agentId = stringValue(parentRecord, "agent_id", "agentId");
  const backendId = stringValue(parentRecord, "backend_id", "backendId");
  const agentConfigurationVersion = numberValue(parentRecord, "agent_configuration_version", "agentConfigurationVersion");
  const generation = numberValue(parentRecord, "generation");
  if (!workspaceId || !roomId || !sessionId || !workId || !assigneeId || !agentId || !backendId
    || agentConfigurationVersion === undefined || generation === undefined) return undefined;
  return {
    backendSessionId,
    parent: {
      workspaceId,
      roomId,
      sessionId,
      workId,
      assigneeId,
      agentId,
      agentConfigurationVersion,
      backendId,
      generation
    }
  };
}

function roomWorkRuntimeOperationId(reservation: RoomWorkReservation): string {
  const digest = createHash("sha256")
    .update(`${reservation.workId}|${reservation.assigneeId}|${reservation.generation}`)
    .digest("hex")
    .slice(0, 48);
  return `room_work_run_${digest}`;
}

function recoveryTerminalStatus(status: string | undefined): "completed" | "failed" | "cancelled" | "outcome_unknown" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  // queued/running/waiting/outcome_unknown, a missing Run, or an unfamiliar
  // provider status all require explicit confirmation and must not be
  // converted into a fresh launch.
  return "outcome_unknown";
}

function terminalStatus(status: string): "completed" | "failed" | "cancelled" | "waiting" | "outcome_unknown" {
  if (status === "completed") return "completed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "waiting_for_backend_input" || status === "waiting") return "waiting";
  // A queued/running result has no terminal evidence yet. Preserve that
  // uncertainty so a later lease owner can reconcile the Runtime record.
  if (status === "queued" || status === "running") return "outcome_unknown";
  if (status === "outcome_unknown") return "outcome_unknown";
  return "failed";
}

function isOutcomeUnknown(error: unknown): boolean {
  const code = errorCode(error);
  return code.includes("unknown") || code.includes("indeterminate") || code.includes("process_exit") || code.includes("runtime_run_in_progress");
}

function isRoomWorkAdmissionClosed(error: unknown): boolean {
  const code = errorCode(error);
  return code.includes("execution_admission_closed") || code.includes("human_work_stopped");
}

function isExpectedStopSettlementRace(error: unknown): boolean {
  const code = errorCode(error);
  return code === "human_work_assignment_not_running"
    || code === "human_work_assignment_lease_conflict"
    || code === "room_work_control_generation_conflict"
    || code === "room_work_stop_lease_conflict";
}

function errorCode(error: unknown): string {
  const candidate = error as { code?: unknown } | undefined;
  return typeof candidate?.code === "string" && candidate.code.trim() ? candidate.code : "room_work_runtime_failed";
}

function boundedDuration(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : minimum;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function nestedRecord(value: unknown, ...keys: string[]): Record<string, any> {
  const body = recordValue(value);
  for (const key of keys) {
    const nested = body[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, any>;
  }
  return body;
}

function stringValue(body: Record<string, any>, ...keys: string[]): string {
  for (const key of keys) if (typeof body[key] === "string" && body[key].trim()) return body[key].trim();
  return "";
}

function numberValue(body: Record<string, any>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof body[key] === "number" && Number.isFinite(body[key])) return body[key];
    if (typeof body[key] === "string" && /^(0|[1-9][0-9]*)$/.test(body[key])) {
      const parsed = Number(body[key]);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return undefined;
}

function validPositiveVersion(value: number | undefined, code: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) throw new WorkspaceServerError(code, 409);
  return value;
}

function parseRoomWorkAttachments(value: unknown): { attachments: ResourceRef[]; error?: string } {
  if (!Array.isArray(value) || value.length > 100) {
    return { attachments: [], error: "room_work_attachment_reference_invalid" };
  }
  const attachments: ResourceRef[] = [];
  for (const entry of value) {
    const parsed = WorkspaceFileResourceRefSchema.safeParse(entry);
    if (!parsed.success) {
      // Never continue with a partial list. Dropping one malformed reference
      // could make a different instruction execute without required context.
      return { attachments: [], error: "room_work_attachment_reference_invalid" };
    }
    attachments.push(parsed.data);
  }
  return { attachments };
}
