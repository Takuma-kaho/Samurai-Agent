import {
  AutomationJobRecordSchema,
  AutomationRunRecordSchema,
  createId,
  nowIso,
  type ActivityInboxItem,
  type AutomationJobRecord,
  type AutomationRunRecord,
  type DelegatedPrincipal,
  type ExternalAppConnectionRecord,
  type JsonValue,
  type OperationRecord,
  type Principal,
  type ResourceRef,
  type TrustedWorkspaceSource
} from "@samurai-agent/core-schemas";
import type { DomainOperationOutput, TrustedDomainContext } from "@samurai-agent/domain-operations";
import type { ParticipantPrincipal } from "@samurai-agent/room-permissions";
import type { RuntimeWriteResult } from "../../agent-runtime.js";
import { RoomAuthorizationError, type RoomAuthorizationService } from "./room-authorization-service.js";

const workspaceId = "workspace";

export class AutomationAuthorizationBlockedError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "AutomationAuthorizationBlockedError";
  }
}

class AutomationExecutionStoppedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AutomationExecutionStoppedError";
  }
}

export interface Core09AutomationRunResult {
  resource: AutomationRunRecord;
  automationRun: AutomationRunRecord;
  operation?: OperationRecord;
  activity: ActivityInboxItem[];
  blocked?: true;
}

/**
 * A pre-authorized, immutable snapshot for a trigger job that another
 * transaction will persist.  It deliberately contains no queue side effect.
 */
export interface CollectionTriggerDelivery {
  workspaceId: string;
  roomId: string;
  authority: NonNullable<AutomationJobRecord["authority"]>;
  createdPrincipalSnapshot: NonNullable<AutomationJobRecord["created_principal_snapshot"]>;
  sourceSnapshot: NonNullable<AutomationJobRecord["source_snapshot"]>;
  connectionId?: string;
  sessionRef?: NonNullable<AutomationJobRecord["session_ref"]>;
}

interface AutomationStore {
  saveAutomationJob(job: AutomationJobRecord): Promise<AutomationJobRecord>;
  getAutomationJob(id: string): Promise<AutomationJobRecord | undefined>;
  acquireAutomationJobLock(jobId: string, input: { lockedUntil: string; lockOwnerToken: string; now?: string }): Promise<AutomationJobRecord | undefined>;
  createAutomationRun(run: AutomationRunRecord): Promise<AutomationRunRecord>;
  attachAutomationRunEvidence(input: { jobId: string; runId: string; lockOwnerToken: string; operationId: string; activityId?: string }): Promise<AutomationRunRecord | undefined>;
  attachAutomationRunBackendRun(input: { jobId: string; runId: string; lockOwnerToken: string; backendRunId: string }): Promise<AutomationRunRecord | undefined>;
  settleAutomationRun(input: {
    jobId: string;
    runId: string;
    lockOwnerToken: string;
    outcome: "completed" | "failed" | "blocked" | "manager_stopped";
    now: string;
    nextRunAt?: string;
    retryAfterAt?: string;
    errorCode?: string;
    error?: string;
  }): Promise<{ job: AutomationJobRecord; run: AutomationRunRecord } | undefined>;
  listExpiredAutomationRunClaims(now?: string): Promise<Array<{ job: AutomationJobRecord; run: AutomationRunRecord }>>;
  getExternalAppConnection(id: string): Promise<ExternalAppConnectionRecord | undefined>;
  getExternalAppConnectionByConnector(input: { workspaceId: string; connectorId: string }): Promise<ExternalAppConnectionRecord | undefined>;
}

interface AutomationMutationPort {
  runMutation<TResource>(input: {
    trustedContext: TrustedDomainContext;
    inputSummary: string;
    operationName: string;
    proposedEffects: string[];
    inputRef?: ResourceRef;
    targetResourceRefs?: ResourceRef[];
    core08Evidence: { changeType: "other" };
    execute(operation: OperationRecord, activity?: import("@samurai-agent/core-schemas").ActivityRecord): Promise<{
      resource: TResource;
      ref: ResourceRef;
      summary: string;
    }>;
  }): Promise<RuntimeWriteResult<TResource>>;
}

interface AutomationExecutionPort {
  reindexWiki(): Promise<{ active: number; total: number }>;
  runInstruction(input: {
    context: TrustedDomainContext;
    job: AutomationJobRecord;
    run: AutomationRunRecord;
  }): Promise<{ backendRunId: string; status: string; summary: string; error?: string }>;
  runCollectionTrigger?(input: {
    context: TrustedDomainContext;
    job: AutomationJobRecord;
  }): Promise<{ summary: string } | undefined>;
  retryAt(failureCount: number): string;
}

/**
 * Session-free Automation lifecycle. Scheduler ownership is token-bound and
 * authority is reconstructed from the durable job immediately before work.
 */
export class Core09AutomationDomainService {
  constructor(private readonly dependencies: {
    store: AutomationStore;
    roomAuthorization: Pick<RoomAuthorizationService, "assertRoom">;
    mutation: AutomationMutationPort;
    execution: AutomationExecutionPort;
    sessionlessMemoryReview: () => Promise<DomainOperationOutput<"automation.memory_review.run">>;
    requestError: (code: "not_found" | "conflict" | "forbidden" | "unavailable", message: string) => Error;
  }) {}

  runSessionlessMemoryReview(): Promise<DomainOperationOutput<"automation.memory_review.run">> {
    return this.dependencies.sessionlessMemoryReview();
  }

  /**
   * Validates the initiating authority before Collection starts its file/DB
   * transaction.  The job itself is inserted by that same transaction.
   */
  async prepareCollectionTriggerDelivery(context: TrustedDomainContext): Promise<CollectionTriggerDelivery> {
    const authority = await this.authorityFromContext(context, "edit");
    return {
      workspaceId,
      roomId: authority.roomId,
      authority: authority.authority,
      createdPrincipalSnapshot: authority.principal,
      sourceSnapshot: authority.source,
      ...(authority.connectionId ? { connectionId: authority.connectionId } : {}),
      ...(context.sessionRef ? { sessionRef: context.sessionRef } : {})
    };
  }

  async save(input: {
    context: TrustedDomainContext;
    request: {
      title: string;
      kind: AutomationJobRecord["kind"];
      schedule: string;
      target_instruction: string;
      delivery_target: Record<string, JsonValue>;
      enabled?: boolean;
      next_run_at?: string;
      max_attempts: number;
    };
  }): Promise<RuntimeWriteResult<AutomationJobRecord>> {
    const authority = await this.authorityFromContext(input.context, "edit");
    const now = nowIso();
    return this.runJobMutation({
      trustedContext: input.context,
      inputSummary: `Save automation job: ${input.request.title}`,
      operationName: "automation.job.save",
      proposedEffects: ["Save an automation job definition."],
      execute: async (operation) => {
        const job = AutomationJobRecordSchema.parse({
          id: createId("automation"),
          title: input.request.title,
          kind: input.request.kind,
          status: input.request.enabled === false ? "disabled" : "enabled",
          schedule: input.request.schedule,
          target_instruction: input.request.target_instruction,
          delivery_target: input.request.delivery_target,
          workspace_id: workspaceId,
          room_id: authority.roomId,
          authority: authority.authority,
          created_principal_snapshot: authority.principal,
          source_snapshot: authority.source,
          ...(authority.connectionId ? { connection_id: authority.connectionId } : {}),
          ...(input.context.sessionRef ? { session_ref: input.context.sessionRef } : {}),
          authorization_state: "ready",
          authorized_at: now,
          management_state: "allowed",
          created_operation_id: operation.id,
          next_run_at: input.request.next_run_at ?? now,
          failure_count: 0,
          max_attempts: input.request.max_attempts,
          created_at: now,
          updated_at: now
        });
        const saved = await this.dependencies.store.saveAutomationJob(job);
        return { resource: saved, ref: automationJobRef(saved), summary: `Saved automation job ${saved.title}.` };
      }
    });
  }

  async setStatus(input: {
    context: TrustedDomainContext;
    jobId: string;
    status: "enabled" | "disabled";
  }): Promise<RuntimeWriteResult<AutomationJobRecord>> {
    const current = await this.requireJob(input.jobId);
    await this.assertJobControl(current, input.context);
    if (current.management_state !== "allowed") {
      throw this.dependencies.requestError("conflict", `automation_job_manager_stopped:${current.id}`);
    }
    if (input.status === "enabled" && (current.authorization_state !== "ready" || current.status === "archived")) {
      throw this.dependencies.requestError("conflict", `automation_job_reauthorization_required:${current.id}`);
    }
    return this.runJobMutation({
      trustedContext: input.context,
      inputSummary: `${input.status === "enabled" ? "Enable" : "Disable"} automation job: ${current.title}`,
      operationName: "automation.job.set_status",
      proposedEffects: ["Change an Automation job between enabled and disabled."],
      targetResourceRefs: [automationJobRef(current)],
      execute: async () => {
        const latest = await this.requireJob(current.id);
        await this.assertJobControl(latest, input.context);
        if (latest.management_state !== "allowed") {
          throw this.dependencies.requestError("conflict", `automation_job_manager_stopped:${latest.id}`);
        }
        if (input.status === "enabled" && (latest.authorization_state !== "ready" || latest.status === "archived")) {
          throw this.dependencies.requestError("conflict", `automation_job_reauthorization_required:${latest.id}`);
        }
        const saved = await this.dependencies.store.saveAutomationJob({
          ...latest,
          status: input.status,
          updated_at: nowIso()
        });
        return { resource: saved, ref: automationJobRef(saved), summary: `${input.status === "enabled" ? "Enabled" : "Disabled"} automation job ${saved.title}.` };
      }
    });
  }

  async managerStop(input: { context: TrustedDomainContext; jobId: string; note?: string }): Promise<RuntimeWriteResult<AutomationJobRecord>> {
    const current = await this.requireJob(input.jobId);
    await this.assertManagerControl(current, input.context);
    return this.runJobMutation({
      trustedContext: input.context,
      inputSummary: `Manager stopped automation job: ${current.title}${input.note ? ` (${input.note})` : ""}`,
      operationName: "automation.job.manager_stop",
      proposedEffects: ["Stop future Automation executions without cancelling an in-flight executor."],
      targetResourceRefs: [automationJobRef(current)],
      execute: async (operation) => {
        const latest = await this.requireJob(current.id);
        await this.assertManagerControl(latest, input.context);
        const saved = await this.dependencies.store.saveAutomationJob({
          ...latest,
          status: "disabled",
          management_state: "manager_stopped",
          management_operation_id: operation.id,
          updated_at: nowIso()
        });
        return { resource: saved, ref: automationJobRef(saved), summary: `Manager stopped automation job ${saved.title}.` };
      }
    });
  }

  async managerResume(input: { context: TrustedDomainContext; jobId: string }): Promise<RuntimeWriteResult<AutomationJobRecord>> {
    const current = await this.requireJob(input.jobId);
    await this.assertManagerControl(current, input.context);
    if (current.management_state !== "manager_stopped") {
      throw this.dependencies.requestError("conflict", `automation_job_manager_resume_not_required:${current.id}`);
    }
    return this.runJobMutation({
      trustedContext: input.context,
      inputSummary: `Manager resumed automation job management: ${current.title}`,
      operationName: "automation.job.manager_resume",
      proposedEffects: ["Allow a separately enabled Automation job to be scheduled again."],
      targetResourceRefs: [automationJobRef(current)],
      execute: async (operation) => {
        const latest = await this.requireJob(current.id);
        await this.assertManagerControl(latest, input.context);
        if (latest.management_state !== "manager_stopped") {
          throw this.dependencies.requestError("conflict", `automation_job_manager_resume_not_required:${latest.id}`);
        }
        const saved = await this.dependencies.store.saveAutomationJob({
          ...latest,
          status: "disabled",
          management_state: "allowed",
          management_operation_id: operation.id,
          updated_at: nowIso()
        });
        return { resource: saved, ref: automationJobRef(saved), summary: `Manager resumed automation job ${saved.title}; it remains disabled.` };
      }
    });
  }

  async reauthorize(input: { context: TrustedDomainContext; jobId: string }): Promise<RuntimeWriteResult<AutomationJobRecord>> {
    const current = await this.requireJob(input.jobId);
    if (current.authorization_state !== "blocked") {
      throw this.dependencies.requestError("conflict", `automation_job_reauthorization_not_required:${current.id}`);
    }
    await this.assertJobControl(current, input.context);
    await this.authorityFromJob(current, "execute", false);
    const now = nowIso();
    return this.runJobMutation({
      trustedContext: input.context,
      inputSummary: `Reauthorize automation job: ${current.title}`,
      operationName: "automation.job.reauthorize",
      proposedEffects: ["Confirm the existing Automation authority without changing it or enabling the job."],
      targetResourceRefs: [automationJobRef(current)],
      execute: async () => {
        const latest = await this.requireJob(current.id);
        if (latest.authorization_state !== "blocked") {
          throw this.dependencies.requestError("conflict", `automation_job_reauthorization_not_required:${latest.id}`);
        }
        await this.assertJobControl(latest, input.context);
        await this.authorityFromJob(latest, "execute", false);
        const saved = await this.dependencies.store.saveAutomationJob({
          ...latest,
          status: "disabled",
          authorization_state: "ready",
          authorization_error_code: undefined,
          authorized_at: now,
          blocked_at: undefined,
          updated_at: now
        });
        return { resource: saved, ref: automationJobRef(saved), summary: `Reauthorized automation job ${saved.title}; it remains disabled.` };
      }
    });
  }

  async rebind(input: { context: TrustedDomainContext; jobId: string }): Promise<RuntimeWriteResult<AutomationJobRecord>> {
    const current = await this.requireJob(input.jobId);
    if (current.authorization_state !== "rebind_required") {
      throw this.dependencies.requestError("conflict", `automation_job_rebind_not_required:${current.id}`);
    }
    await this.authorityFromContext(input.context, "edit");
    const now = nowIso();
    return this.runJobMutation({
      trustedContext: input.context,
      inputSummary: `Rebind automation job authority: ${current.title}`,
      operationName: "automation.job.rebind_authority",
      proposedEffects: ["Bind a legacy Automation job to a trusted Room authority without enabling it."],
      targetResourceRefs: [automationJobRef(current)],
      execute: async (operation) => {
        const latest = await this.requireJob(current.id);
        if (latest.authorization_state !== "rebind_required") {
          throw this.dependencies.requestError("conflict", `automation_job_rebind_not_required:${latest.id}`);
        }
        const currentAuthority = await this.authorityFromContext(input.context, "edit");
        const saved = await this.dependencies.store.saveAutomationJob({
          ...latest,
          status: "disabled",
          workspace_id: workspaceId,
          room_id: currentAuthority.roomId,
          authority: currentAuthority.authority,
          created_principal_snapshot: currentAuthority.principal,
          source_snapshot: currentAuthority.source,
          ...(currentAuthority.connectionId ? { connection_id: currentAuthority.connectionId } : { connection_id: undefined }),
          ...(input.context.sessionRef ? { session_ref: input.context.sessionRef } : { session_ref: undefined }),
          authorization_state: "ready",
          authorization_error_code: undefined,
          authorized_at: now,
          blocked_at: undefined,
          rebound_at: now,
          rebound_operation_id: operation.id,
          locked_until: undefined,
          lock_owner_token: undefined,
          updated_at: now
        });
        return { resource: saved, ref: automationJobRef(saved), summary: `Rebound automation job ${saved.title}; it remains disabled.` };
      }
    });
  }

  /** Converts expired claims into normal retryable failures before selecting due jobs. */
  async recoverInterruptedRuns(now = nowIso()): Promise<AutomationRunRecord[]> {
    const claims = await this.dependencies.store.listExpiredAutomationRunClaims(now);
    const recovered: AutomationRunRecord[] = [];
    for (const claim of claims) {
      const outcome = claim.job.management_state === "manager_stopped" ? "manager_stopped" : "failed";
      const failureCount = (claim.job.failure_count ?? 0) + 1;
      const settled = await this.dependencies.store.settleAutomationRun({
        jobId: claim.job.id,
        runId: claim.run.id,
        lockOwnerToken: required(claim.job.lock_owner_token, "automation_recovery_lock_token_missing"),
        outcome,
        now,
        ...(outcome === "failed" && failureCount < (claim.job.max_attempts ?? 3)
          ? { retryAfterAt: this.dependencies.execution.retryAt(failureCount) }
          : {}),
        errorCode: "automation_execution_interrupted",
        error: "automation_execution_interrupted"
      });
      if (settled) recovered.push(settled.run);
    }
    return recovered;
  }

  async run(input: { jobId: string; now: string }): Promise<Core09AutomationRunResult> {
    const current = await this.requireJob(input.jobId);
    const lockOwnerToken = createId("automation-lock");
    const locked = await this.dependencies.store.acquireAutomationJobLock(current.id, {
      now: input.now,
      lockedUntil: new Date(Date.parse(input.now) + 15 * 60_000).toISOString(),
      lockOwnerToken
    });
    if (!locked) throw this.dependencies.requestError("conflict", "automation_job_locked");

    let authority: ResolvedAutomationAuthority | undefined;
    try {
      authority = await this.authorityFromJob(locked, "execute");
    } catch (error) {
      const run = await this.dependencies.store.createAutomationRun(this.startedRun(locked, input.now));
      return this.settleBlocked(locked, run, lockOwnerToken, blockCode(error));
    }

    let run = await this.dependencies.store.createAutomationRun(this.startedRun(locked, input.now, authority));
    if (!isSessionlessExecutableKind(locked.kind)) {
      return this.settleBlocked(locked, run, lockOwnerToken, "automation_sessionless_executor_unsupported");
    }

    try {
      const mutation = await this.dependencies.mutation.runMutation({
        trustedContext: authority.context,
        inputSummary: `Run automation job: ${locked.title}`,
        operationName: "automation.job.run",
        proposedEffects: [`Run automation job ${locked.title}.`],
        inputRef: automationJobRef(locked),
        targetResourceRefs: [automationJobRef(locked)],
        core08Evidence: { changeType: "other" },
        execute: async (operation, activity) => {
          const linked = await this.dependencies.store.attachAutomationRunEvidence({
            jobId: locked.id,
            runId: run.id,
            lockOwnerToken,
            operationId: operation.id,
            ...(activity ? { activityId: activity.id } : {})
          });
          if (!linked) throw new AutomationExecutionStoppedError("automation_execution_claim_lost");
          run = linked;
          const reloaded = await this.dependencies.store.getAutomationJob(locked.id);
          if (!reloaded || reloaded.lock_owner_token !== lockOwnerToken) {
            throw new AutomationExecutionStoppedError("automation_execution_claim_lost");
          }
          if (reloaded.management_state === "manager_stopped" || reloaded.status !== "enabled") {
            throw new AutomationExecutionStoppedError(reloaded.management_state === "manager_stopped"
              ? "automation_manager_stopped"
              : "automation_job_not_enabled");
          }
          // Re-evaluate after the operation/activity evidence exists but before
          // the executor is allowed to cause an external or resource effect.
          authority = await this.authorityFromJob(reloaded, "execute");
          const outcome = await this.executeSessionlessKind(reloaded, authority.context, run);
          return { resource: run, ref: automationRunRef(run, locked.title), summary: outcome.summary };
        }
      });
      const settled = await this.settle(locked, run, lockOwnerToken, {
        outcome: "completed",
        now: nowIso(),
        nextRunAt: isOneShot(locked.schedule) ? undefined : nextRun(locked.schedule)
      });
      return { resource: settled.run, automationRun: settled.run, operation: mutation.operation, activity: mutation.activity };
    } catch (error) {
      if (error instanceof AutomationExecutionStoppedError) {
        const settled = await this.settle(locked, run, lockOwnerToken, {
          outcome: "manager_stopped",
          now: nowIso(),
          errorCode: error.code,
          error: error.code
        });
        return { resource: settled.run, automationRun: settled.run, activity: [], blocked: true };
      }
      if (error instanceof AutomationAuthorizationBlockedError || error instanceof RoomAuthorizationError) {
        return this.settleBlocked(locked, run, lockOwnerToken, blockCode(error));
      }
      const errorText = safeError(error);
      const failureCount = (locked.failure_count ?? 0) + 1;
      const settled = await this.settle(locked, run, lockOwnerToken, {
        outcome: "failed",
        now: nowIso(),
        ...(failureCount < (locked.max_attempts ?? 3) ? { retryAfterAt: this.dependencies.execution.retryAt(failureCount) } : {}),
        errorCode: "automation_execution_failed",
        error: errorText
      });
      return { resource: settled.run, automationRun: settled.run, activity: [] };
    }
  }

  private async settleBlocked(job: AutomationJobRecord, run: AutomationRunRecord, lockOwnerToken: string, code: string): Promise<Core09AutomationRunResult> {
    const settled = await this.settle(job, run, lockOwnerToken, {
      outcome: "blocked",
      now: nowIso(),
      errorCode: code,
      error: code
    });
    return { resource: settled.run, automationRun: settled.run, activity: [], blocked: true };
  }

  private async settle(
    job: AutomationJobRecord,
    run: AutomationRunRecord,
    lockOwnerToken: string,
    input: Omit<Parameters<AutomationStore["settleAutomationRun"]>[0], "jobId" | "runId" | "lockOwnerToken">
  ): Promise<{ job: AutomationJobRecord; run: AutomationRunRecord }> {
    const settled = await this.dependencies.store.settleAutomationRun({ jobId: job.id, runId: run.id, lockOwnerToken, ...input });
    if (!settled) throw this.dependencies.requestError("conflict", "automation_job_lock_claim_lost");
    return settled;
  }

  private startedRun(job: AutomationJobRecord, startedAt: string, authority?: ResolvedAutomationAuthority): AutomationRunRecord {
    const jobAuthority = required(job.authority, "automation_job_authority_missing");
    const roomId = required(job.room_id, "automation_job_room_missing");
    return AutomationRunRecordSchema.parse({
      id: createId("automationrun"),
      kind: job.kind,
      source: "automation_job",
      status: "started",
      job_id: job.id,
      workspace_id: job.workspace_id ?? workspaceId,
      room_id: authority?.roomId ?? roomId,
      authority: authority?.authority ?? jobAuthority,
      ...((authority?.connectorId ?? (jobAuthority.kind === "external_connection" ? jobAuthority.connector_id : undefined))
        ? { connector_id: authority?.connectorId ?? (jobAuthority as Extract<AutomationJobRecord["authority"], { kind: "external_connection" }>).connector_id }
        : {}),
      ...((authority?.appId ?? (jobAuthority.kind === "external_connection" ? jobAuthority.app_id : undefined))
        ? { app_id: authority?.appId ?? (jobAuthority as Extract<AutomationJobRecord["authority"], { kind: "external_connection" }>).app_id }
        : {}),
      ...(job.session_ref ? { session_ref: job.session_ref } : {}),
      started_at: startedAt
    });
  }

  private async executeSessionlessKind(
    job: AutomationJobRecord,
    context: TrustedDomainContext,
    run: AutomationRunRecord
  ): Promise<{ summary: string }> {
    if (job.kind === "wiki_reindex") {
      const result = await this.dependencies.execution.reindexWiki();
      return { summary: `Reindexed Knowledge Wiki pages: ${result.active}/${result.total} active.` };
    }
    if (job.delivery_target.channel === "collection_trigger" && this.dependencies.execution.runCollectionTrigger) {
      const result = await this.dependencies.execution.runCollectionTrigger({ context, job });
      if (result) return result;
      throw new AutomationAuthorizationBlockedError("automation_collection_trigger_invalid");
    }
    if (!isWorkspaceInstructionKind(job.kind)) throw new Error("automation_sessionless_executor_guard_bypassed");
    const result = await this.dependencies.execution.runInstruction({ context, job, run });
    const linked = await this.dependencies.store.attachAutomationRunBackendRun({
      jobId: job.id,
      runId: run.id,
      lockOwnerToken: required(job.lock_owner_token, "automation_execution_lock_token_missing"),
      backendRunId: result.backendRunId
    });
    if (!linked) throw new AutomationExecutionStoppedError("automation_execution_claim_lost");
    Object.assign(run, linked);
    if (result.status !== "completed") {
      throw new Error(result.error ?? `automation_backend_not_completed:${result.status}`);
    }
    return { summary: result.summary || `Completed automation job ${job.title}.` };
  }

  private async assertJobControl(job: AutomationJobRecord, context: TrustedDomainContext): Promise<void> {
    try {
      const current = await this.authorityFromContext(context, "edit");
      if (job.room_id === current.roomId && job.authority && sameAuthority(job.authority, current.authority)) return;
    } catch (error) {
      if (!(error instanceof RoomAuthorizationError) && !(error instanceof AutomationAuthorizationBlockedError)) throw error;
    }
    await this.assertManagerControl(job, context);
  }

  private async assertManagerControl(job: AutomationJobRecord, context: TrustedDomainContext): Promise<void> {
    if (!job.room_id || context.roomId !== job.room_id || !context.participant || context.participant.kind === "system") {
      throw this.dependencies.requestError("forbidden", "automation_job_manager_room_required");
    }
    // A formal external-app context must still prove its current Connection
    // before its delegated Room-manager permission is considered.
    if (context.participant.kind === "external_app") await this.authorityFromContext(context, "edit");
    try {
      await this.dependencies.roomAuthorization.assertRoom(context.participant, job.room_id, "manage_settings");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) {
        throw this.dependencies.requestError("forbidden", `automation_job_manager_denied:${error.reason}`);
      }
      throw error;
    }
  }

  private async authorityFromContext(context: TrustedDomainContext, action: "edit" | "execute"): Promise<ResolvedAutomationAuthority> {
    if (!context.roomId || !context.participant || context.participant.kind === "system") {
      throw this.dependencies.requestError("forbidden", "automation_job_trusted_room_authority_required");
    }
    if (context.participant.kind === "external_app") {
      const source = context.source;
      if (!source || source.kind !== "external_app" || !source.connector_id || source.app_id !== context.participant.appId || source.connector_id !== context.participant.connectorId) {
        throw this.dependencies.requestError("forbidden", "automation_external_connection_context_mismatch");
      }
      const connection = context.connectionId
        ? await this.dependencies.store.getExternalAppConnection(context.connectionId)
        : await this.dependencies.store.getExternalAppConnectionByConnector({ workspaceId, connectorId: source.connector_id });
      if (!connection || connection.status !== "active") throw new AutomationAuthorizationBlockedError("automation_connection_revoked");
      if (connection.app_id !== source.app_id || !connection.allowed_room_ids.includes(context.roomId) || !connection.ingress_classes.includes("domain_operation")) {
        throw new AutomationAuthorizationBlockedError("automation_connection_scope_denied");
      }
      if (context.connectionId && connection.id !== context.connectionId) throw new AutomationAuthorizationBlockedError("automation_connection_scope_denied");
      if (!sameDelegated(connection.delegated_principal, context.participant.delegatedBy)) {
        throw new AutomationAuthorizationBlockedError("automation_delegated_principal_mismatch");
      }
      await this.dependencies.roomAuthorization.assertRoom(context.participant, context.roomId, action);
      return {
        roomId: context.roomId,
        authority: {
          kind: "external_connection",
          connection_id: connection.id,
          connector_id: connection.connector_id,
          app_id: connection.app_id,
          delegated_principal: connection.delegated_principal
        },
        connectionId: connection.id,
        connectorId: connection.connector_id,
        appId: connection.app_id,
        principal: principalFromParticipant(context.participant),
        source,
        context
      };
    }
    await this.dependencies.roomAuthorization.assertRoom(context.participant, context.roomId, action);
    return {
      roomId: context.roomId,
      authority: { kind: "direct_principal", principal: delegatedFromParticipant(context.participant) },
      principal: principalFromParticipant(context.participant),
      source: context.source ?? { kind: "host" },
      context
    };
  }

  private async authorityFromJob(job: AutomationJobRecord, action: "execute", requireReady = true): Promise<ResolvedAutomationAuthority> {
    if (!job.room_id || !job.authority || (requireReady && job.authorization_state !== "ready")) {
      throw new AutomationAuthorizationBlockedError("automation_job_rebind_required");
    }
    if (job.authority.kind === "direct_principal") {
      const participant = participantFromDelegated(job.authority.principal);
      await this.dependencies.roomAuthorization.assertRoom(participant, job.room_id, action);
      const source = job.source_snapshot ?? { kind: "host" as const };
      return {
        roomId: job.room_id,
        authority: job.authority,
        principal: principalFromParticipant(participant),
        source,
        context: {
          inputSource: "automation",
          workspaceId,
          actorId: "scheduled_automation",
          participant,
          roomId: job.room_id,
          ...(job.session_ref ? { sessionRef: job.session_ref } : {}),
          source,
          correlationId: `automation:${job.id}:${job.next_run_at ?? nowIso()}`
        }
      };
    }
    const connection = await this.dependencies.store.getExternalAppConnection(job.authority.connection_id);
    if (!connection || connection.status !== "active") throw new AutomationAuthorizationBlockedError("automation_connection_revoked");
    if (
      connection.workspace_id !== workspaceId
      || connection.connector_id !== job.authority.connector_id
      || connection.app_id !== job.authority.app_id
      || !connection.allowed_room_ids.includes(job.room_id)
      || !connection.ingress_classes.includes("domain_operation")
      || !sameCoreDelegated(connection.delegated_principal, job.authority.delegated_principal)
    ) {
      throw new AutomationAuthorizationBlockedError("automation_connection_scope_denied");
    }
    const participant: Extract<ParticipantPrincipal, { kind: "external_app" }> = {
      kind: "external_app",
      appId: connection.app_id,
      connectorId: connection.connector_id,
      delegatedBy: participantFromDelegated(connection.delegated_principal)
    };
    await this.dependencies.roomAuthorization.assertRoom(participant, job.room_id, action);
    const source = { kind: "external_app" as const, app_id: connection.app_id, connector_id: connection.connector_id };
    return {
      roomId: job.room_id,
      authority: job.authority,
      connectionId: connection.id,
      connectorId: connection.connector_id,
      appId: connection.app_id,
      principal: principalFromParticipant(participant),
      source,
      context: {
        inputSource: "automation",
        workspaceId,
        actorId: "scheduled_automation",
        participant,
        roomId: job.room_id,
        ...(job.session_ref ? { sessionRef: job.session_ref } : {}),
        source,
        correlationId: `automation:${job.id}:${job.next_run_at ?? nowIso()}`
      }
    };
  }

  private async requireJob(id: string): Promise<AutomationJobRecord> {
    const job = await this.dependencies.store.getAutomationJob(id);
    if (!job) throw this.dependencies.requestError("not_found", "automation_job_not_found");
    return job;
  }

  private runJobMutation(input: {
    trustedContext: TrustedDomainContext;
    inputSummary: string;
    operationName: string;
    proposedEffects: string[];
    inputRef?: ResourceRef;
    targetResourceRefs?: ResourceRef[];
    execute(operation: OperationRecord): Promise<{ resource: AutomationJobRecord; ref: ResourceRef; summary: string }>;
  }): Promise<RuntimeWriteResult<AutomationJobRecord>> {
    return this.dependencies.mutation.runMutation<AutomationJobRecord>({
      ...input,
      core08Evidence: { changeType: "other" },
      execute: input.execute
    });
  }
}

interface ResolvedAutomationAuthority {
  roomId: string;
  authority: NonNullable<AutomationJobRecord["authority"]>;
  connectionId?: string;
  connectorId?: string;
  appId?: string;
  principal: Principal;
  source: TrustedWorkspaceSource;
  context: TrustedDomainContext;
}

function automationJobRef(job: AutomationJobRecord): ResourceRef {
  return { kind: "automation_job", id: job.id, uri: `automation-jobs/${job.id}`, label: job.title };
}

function automationRunRef(run: AutomationRunRecord, title: string): ResourceRef {
  return { kind: "automation_run", id: run.id, uri: `automation-runs/${run.id}`, label: title };
}

function delegatedFromParticipant(participant: Exclude<ParticipantPrincipal, { kind: "system" | "external_app" }>): DelegatedPrincipal {
  return participant.kind === "human"
    ? { kind: "human", participant_id: participant.participantId }
    : { kind: "agent", agent_id: participant.agentId, requested_by_participant_id: participant.requestedByParticipantId };
}

function participantFromDelegated(principal: DelegatedPrincipal): Exclude<ParticipantPrincipal, { kind: "system" | "external_app" }> {
  return principal.kind === "human"
    ? { kind: "human", participantId: principal.participant_id }
    : { kind: "agent", agentId: principal.agent_id, requestedByParticipantId: principal.requested_by_participant_id };
}

function principalFromParticipant(participant: ParticipantPrincipal): Principal {
  if (participant.kind === "human") return { kind: "human", participant_id: participant.participantId };
  if (participant.kind === "agent") return { kind: "agent", agent_id: participant.agentId, requested_by_participant_id: participant.requestedByParticipantId };
  if (participant.kind === "external_app") return {
    kind: "external_app",
    app_id: participant.appId,
    ...(participant.connectorId ? { connector_id: participant.connectorId } : {}),
    delegated_by: principalFromParticipant(participant.delegatedBy) as Extract<Principal, { kind: "human" | "agent" }>
  };
  return { kind: "system", system_id: participant.participantId };
}

function sameDelegated(left: DelegatedPrincipal, right: Exclude<ParticipantPrincipal, { kind: "system" | "external_app" }>): boolean {
  return left.kind === "human"
    ? right.kind === "human" && left.participant_id === right.participantId
    : right.kind === "agent" && left.agent_id === right.agentId && left.requested_by_participant_id === right.requestedByParticipantId;
}

function sameAuthority(left: NonNullable<AutomationJobRecord["authority"]>, right: NonNullable<AutomationJobRecord["authority"]>): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "direct_principal" && right.kind === "direct_principal") return sameCoreDelegated(left.principal, right.principal);
  return left.kind === "external_connection" && right.kind === "external_connection"
    && left.connection_id === right.connection_id
    && left.connector_id === right.connector_id
    && left.app_id === right.app_id
    && sameCoreDelegated(left.delegated_principal, right.delegated_principal);
}

function sameCoreDelegated(left: DelegatedPrincipal, right: DelegatedPrincipal): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "human" && right.kind === "human"
    ? left.participant_id === right.participant_id
    : left.kind === "agent" && right.kind === "agent"
      ? left.agent_id === right.agent_id && left.requested_by_participant_id === right.requested_by_participant_id
      : false;
}

function blockCode(error: unknown): string {
  if (error instanceof AutomationAuthorizationBlockedError) return error.code;
  const message = safeError(error);
  return message.startsWith("room_authorization_denied") ? "automation_room_permission_denied" : "automation_authorization_blocked";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}

function isOneShot(schedule: string): boolean {
  return ["once", "one-shot", "oneshot"].includes(schedule.trim().toLowerCase());
}

function isSessionlessExecutableKind(kind: AutomationJobRecord["kind"]): kind is "wiki_reindex" {
  return kind === "wiki_reindex" || isWorkspaceInstructionKind(kind);
}

function isWorkspaceInstructionKind(kind: AutomationJobRecord["kind"]): kind is "daily_digest" | "custom_instruction" | "resource_translation" {
  return kind === "daily_digest" || kind === "custom_instruction" || kind === "resource_translation";
}

function nextRun(schedule: string, fromMs = Date.now()): string {
  const value = schedule.trim().toLowerCase();
  if (value.includes("weekly")) return new Date(fromMs + 7 * 86400000).toISOString();
  if (value.includes("hourly")) return new Date(fromMs + 3600000).toISOString();
  const match = value.match(/every\s+(\d+(?:\.\d+)?)\s+hours?/);
  return new Date(fromMs + (match ? Number(match[1]) * 3600000 : 86400000)).toISOString();
}
