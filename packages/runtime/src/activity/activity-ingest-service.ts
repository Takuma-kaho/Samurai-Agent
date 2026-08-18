import {
  TrustedWorkspaceContextSchema,
  createId,
  nowIso,
  stableStringify,
  type ActivityRecord,
  type Principal,
  type ResourceUsageRecord,
  type TrustedWorkspaceContext
} from "@samurai-agent/core-schemas";
import { isRoomShareableResourceKind, type ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { RoomAuthorizationService } from "../commands/services/room-authorization-service";
import type { ActivityIngestPort } from "./activity-ingest-port";

type ActivityFinalization = {
  activityId: string;
  status: Exclude<ActivityRecord["status"], "recording">;
  resultSummary?: string;
  verification?: ActivityRecord["verification"];
  failure?: ActivityRecord["failure"];
  backendRunId?: string;
  domainOperationIds?: string[];
  now: string;
};

interface ActivityStore {
  createActivity(record: ActivityRecord): Promise<ActivityRecord>;
  getActivity(id: string): Promise<ActivityRecord | undefined>;
  getOperation(id: string): Promise<{ room_id?: string } | undefined>;
  linkActivityBackendRun(input: { activityId: string; backendRunId: string; now: string }): Promise<ActivityRecord>;
  recordResourceUsage(record: ResourceUsageRecord): Promise<ResourceUsageRecord>;
  finalizeActivity(input: ActivityFinalization): Promise<ActivityRecord>;
  ingestFinalizedActivity(input: {
    activity: ActivityRecord;
    resourceUsage: ResourceUsageRecord[];
    finalization: Omit<ActivityFinalization, "activityId">;
    signal?: AbortSignal;
  }): Promise<ActivityRecord>;
}

/**
 * Receives only already-trusted Workspace context. It records facts and never
 * creates Jobs, Memory, Knowledge, or Skills.
 */
export class ActivityIngestService implements ActivityIngestPort {
  constructor(
    private readonly store: ActivityStore,
    private readonly roomAuthorization: RoomAuthorizationService,
    private readonly clock: () => string = nowIso
  ) {}

  async startActivity(input: Parameters<ActivityIngestPort["startActivity"]>[0]): Promise<ActivityRecord> {
    const context = await this.assertContext(input.context, "execute");
    await this.assertCorrectionScope(input.correctionOfActivityId, context);
    const now = this.clock();
    return this.store.createActivity(this.buildRecordingActivity({
      context,
      idempotencyKey: input.idempotencyKey,
      instructionSummary: input.instructionSummary,
      correctionOfActivityId: input.correctionOfActivityId,
      provenanceKind: input.provenanceKind,
      now
    }));
  }

  async ingestFinalizedActivity(input: Parameters<ActivityIngestPort["ingestFinalizedActivity"]>[0]): Promise<ActivityRecord> {
    throwIfAborted(input.signal);
    const context = await this.assertContext(input.context, "execute");
    await this.assertCorrectionScope(input.correctionOfActivityId, context);
    await this.assertOperationScopes([
      ...(input.domainOperationIds ?? []),
      ...(input.verification ?? []).flatMap((verification) => verification.source_operation_id ? [verification.source_operation_id] : [])
    ], context);
    const principal = participantPrincipal(context.principal);
    for (const usage of input.resourceUsage ?? []) {
      const action = usage.stage === "modified" || usage.stage === "reverted" ? "edit" : "read";
      await this.roomAuthorization.assertRoom(principal, context.room_id!, action);
      // An external reference is never evidence that the referenced Workspace
      // resource belongs to this Room. Known resource kinds must pass the
      // current Room boundary before Activity evidence is accepted.
      if (isExternalContext(context) && !isRoomShareableResourceKind(usage.resource_ref.kind)) {
        throw new Error("activity_external_resource_kind_not_allowed");
      }
      if (isExternalContext(context)
        && (usage.usage_scope.kind !== "room" || usage.usage_scope.room_id !== context.room_id)) {
        throw new Error("resource_usage_room_scope_mismatch");
      }
      if (isRoomShareableResourceKind(usage.resource_ref.kind)) {
        await this.roomAuthorization.assertResource(principal, {
          roomId: context.room_id!,
          action,
          resourceKind: usage.resource_ref.kind,
          resourceId: usage.resource_ref.id
        });
      }
    }
    throwIfAborted(input.signal);
    const now = this.clock();
    const activity = this.buildRecordingActivity({
      context,
      idempotencyKey: input.idempotencyKey,
      instructionSummary: input.instructionSummary,
      correctionOfActivityId: input.correctionOfActivityId,
      provenanceKind: input.provenanceKind,
      now
    });
    const resourceUsage = (input.resourceUsage ?? []).map((usage) => ({
      ...usage,
      activity_id: activity.id,
      created_at: now
    }));
    return this.store.ingestFinalizedActivity({
      activity,
      resourceUsage,
      finalization: {
        status: input.status,
        ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
        ...(input.verification ? { verification: input.verification } : {}),
        ...(input.failure ? { failure: input.failure } : {}),
        ...(input.backendRunId ? { backendRunId: input.backendRunId } : {}),
        ...(input.domainOperationIds ? { domainOperationIds: [...new Set(input.domainOperationIds)] } : {}),
        now
      },
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  private buildRecordingActivity(input: {
    context: TrustedWorkspaceContext;
    idempotencyKey: string;
    instructionSummary: string;
    correctionOfActivityId?: string;
    provenanceKind?: ActivityRecord["provenance"]["kind"];
    now: string;
  }): ActivityRecord {
    return {
      id: createId("activity"),
      workspace_id: input.context.workspace_id,
      room_id: input.context.room_id!,
      principal: input.context.principal,
      source: input.context.source,
      status: "recording",
      idempotency_key: input.idempotencyKey,
      instruction_summary: input.instructionSummary,
      verification: [],
      ...(input.correctionOfActivityId ? { correction_of_activity_id: input.correctionOfActivityId } : {}),
      ...(input.context.session_ref ? { session_ref: input.context.session_ref } : {}),
      domain_operation_ids: [],
      provenance: {
        kind: input.provenanceKind ?? "trusted_context",
        source_id: input.context.correlation_id,
        recorded_at: input.now
      },
      created_at: input.now,
      updated_at: input.now
    };
  }

  async linkBackendRun(input: Parameters<ActivityIngestPort["linkBackendRun"]>[0]): Promise<ActivityRecord> {
    const context = await this.assertContext(input.context, "execute");
    await this.assertActivityContext(input.activityId, context, "execute");
    return this.store.linkActivityBackendRun({ activityId: input.activityId, backendRunId: input.backendRunId, now: this.clock() });
  }

  async recordResourceUsage(input: Parameters<ActivityIngestPort["recordResourceUsage"]>[0]): Promise<ResourceUsageRecord> {
    const action = input.stage === "modified" || input.stage === "reverted" ? "edit" : "read";
    const context = await this.assertContext(input.context, action);
    await this.assertActivityContext(input.activityId, context, action);
    const principal = participantPrincipal(context.principal);
    if (isRoomShareableResourceKind(input.resourceRef.kind)) {
      await this.roomAuthorization.assertResource(principal, {
        roomId: context.room_id!,
        action,
        resourceKind: input.resourceRef.kind,
        resourceId: input.resourceRef.id
      });
    }
    return this.store.recordResourceUsage({
      id: input.id,
      activity_id: input.activityId,
      ...(input.workspaceJobAttemptId ? { workspace_job_attempt_id: input.workspaceJobAttemptId } : {}),
      resource_ref: input.resourceRef,
      ...(input.resourceVersion ? { resource_version: input.resourceVersion } : {}),
      ...(input.contentHash ? { content_hash: input.contentHash } : {}),
      usage_scope: input.usageScope,
      stage: input.stage,
      ...(input.domainOperationId ? { domain_operation_id: input.domainOperationId } : {}),
      ...(input.workspaceChangeId ? { workspace_change_id: input.workspaceChangeId } : {}),
      created_at: this.clock()
    });
  }

  async finalizeActivity(input: Parameters<ActivityIngestPort["finalizeActivity"]>[0]): Promise<ActivityRecord> {
    const context = await this.assertContext(input.context, "execute");
    await this.assertActivityContext(input.activityId, context, "execute");
    await this.assertOperationScopes([
      ...(input.domainOperationIds ?? []),
      ...(input.verification ?? []).flatMap((verification) => verification.source_operation_id ? [verification.source_operation_id] : [])
    ], context);
    return this.store.finalizeActivity({
      activityId: input.activityId,
      status: input.status,
      ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
      ...(input.verification ? { verification: input.verification } : {}),
      ...(input.failure ? { failure: input.failure } : {}),
      ...(input.backendRunId ? { backendRunId: input.backendRunId } : {}),
      ...(input.domainOperationIds ? { domainOperationIds: [...new Set(input.domainOperationIds)] } : {}),
      now: this.clock()
    });
  }

  private async assertContext(contextInput: TrustedWorkspaceContext, action: "read" | "edit" | "execute"): Promise<TrustedWorkspaceContext> {
    const context = TrustedWorkspaceContextSchema.parse(contextInput);
    if (!context.room_id) throw new Error("activity_context_room_required");
    const principal = participantPrincipal(context.principal);
    if (principal.kind === "system") throw new Error("activity_system_principal_not_authorized");
    await this.roomAuthorization.assertRoom(principal, context.room_id, action);
    return context;
  }

  private async assertActivityContext(activityId: string, context: TrustedWorkspaceContext, action: "read" | "edit" | "execute"): Promise<void> {
    const activity = await this.store.getActivity(activityId);
    if (!activity) throw new Error("activity_not_found");
    if (activity.workspace_id !== context.workspace_id || activity.room_id !== context.room_id
      || stableStringify(activity.principal) !== stableStringify(context.principal)
      || stableStringify(activity.source) !== stableStringify(context.source)) {
      throw new Error("activity_context_mismatch");
    }
    const principal = participantPrincipal(context.principal);
    if (principal.kind === "system") throw new Error("activity_system_principal_not_authorized");
    await this.roomAuthorization.assertRoom(principal, context.room_id!, action);
  }

  private async assertCorrectionScope(activityId: string | undefined, context: TrustedWorkspaceContext): Promise<void> {
    if (!activityId) return;
    const correction = await this.store.getActivity(activityId);
    if (!correction || correction.workspace_id !== context.workspace_id || correction.room_id !== context.room_id) {
      throw new Error("activity_correction_scope_invalid");
    }
  }

  private async assertOperationScopes(operationIds: string[], context: TrustedWorkspaceContext): Promise<void> {
    for (const operationId of new Set(operationIds)) {
      const operation = await this.store.getOperation(operationId);
      if (!operation || operation.room_id !== context.room_id) {
        throw new Error("activity_domain_operation_scope_invalid");
      }
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("external_app_ingress_aborted");
}

function isExternalContext(context: TrustedWorkspaceContext): boolean {
  return context.principal.kind === "external_app" && context.source.kind === "external_app";
}

function participantPrincipal(principal: Principal): ParticipantPrincipal {
  switch (principal.kind) {
    case "human":
      return { kind: "human", participantId: principal.participant_id };
    case "agent":
      return { kind: "agent", agentId: principal.agent_id, requestedByParticipantId: principal.requested_by_participant_id };
    case "external_app": {
      const delegatedBy = participantPrincipal(principal.delegated_by);
      if (delegatedBy.kind !== "human" && delegatedBy.kind !== "agent") throw new Error("external_app_delegation_invalid");
      return { kind: "external_app", appId: principal.app_id, delegatedBy, ...(principal.connector_id ? { connectorId: principal.connector_id } : {}) };
    }
    case "system":
      return { kind: "system", participantId: `system:${principal.system_id}` };
  }
}
