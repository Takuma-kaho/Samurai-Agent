import {
  stableHash,
  type ActivityRecord,
  type NewWorkspaceChangeRecord,
  type OperationRecord,
  type ResourceRef,
  type ResourceUsageRecord,
  type ResourceUsageStage,
  type TrustedWorkspaceContext,
  type WorkspaceChangeRecord,
  type WorkspaceChangeType
} from "@samurai-agent/core-schemas";
import type { ActivityIngestPort } from "./activity-ingest-port";

export interface ResourceMutationActivityScope {
  /** Context used for Activity authorization and ResourceUsage writes. */
  context: TrustedWorkspaceContext;
  /** Original command context retained for Change correlation and provenance. */
  operationContext: TrustedWorkspaceContext;
  activity: ActivityRecord;
  /** A Run-owned Activity is completed by the Run, never by one Resource. */
  direct: boolean;
}

interface ResourceMutationActivityStore {
  getActivityByBackendRunId(backendRunId: string): Promise<ActivityRecord | undefined>;
  commitResourceMutationEvidence(input: {
    change: NewWorkspaceChangeRecord;
    resourceUsage: ResourceUsageRecord;
    directActivity?: {
      activityId: string;
      resultSummary: string;
      domainOperationIds: string[];
      now: string;
    };
  }): Promise<{ change: WorkspaceChangeRecord }>;
}

/** A committed Resource whose durable evidence could not be recorded. */
export class ResourceMutationEvidenceError extends Error {
  readonly code = "resource_mutation_evidence_failed" as const;
  readonly name = "ResourceMutationEvidenceError";

  constructor(
    readonly stage: "workspace_change" | "resource_usage" | "activity_finalize",
    readonly evidenceFailure: unknown,
    readonly failureFinalizationFailure?: unknown
  ) {
    super(`resource_mutation_evidence_failed:${stage}:${evidenceFailureSummary(evidenceFailure)}`);
  }
}

/**
 * Connects one committed Resource mutation to Core07 evidence. It does not
 * create Jobs or learning output; it only writes Activity, Change and Usage.
 */
export class ResourceMutationActivityService {
  constructor(
    private readonly store: ResourceMutationActivityStore,
    private readonly activityIngest: ActivityIngestPort
  ) {}

  async begin(input: {
    context: TrustedWorkspaceContext;
    operation: OperationRecord;
    instructionSummary: string;
  }): Promise<ResourceMutationActivityScope> {
    if (!input.context.room_id) throw new Error("resource_mutation_room_context_required");
    const parent = input.context.run_id
      ? await this.store.getActivityByBackendRunId(input.context.run_id)
      : undefined;
    if (parent) {
      if (parent.workspace_id !== input.context.workspace_id || parent.room_id !== input.context.room_id) {
        throw new Error("resource_mutation_parent_activity_scope_invalid");
      }
      // A Backend Run already has an Activity with its own trusted Principal
      // and Source. Reuse those exact identities for Usage writes; the Domain
      // command's correlation remains on WorkspaceChange below.
      return {
        context: activityMutationContext(parent, input.context),
        operationContext: input.context,
        activity: parent,
        direct: false
      };
    }
    const activity = await this.activityIngest.startActivity({
      context: input.context,
      idempotencyKey: `resource-mutation:${input.operation.id}`,
      instructionSummary: input.instructionSummary,
      provenanceKind: "trusted_context"
    });
    return { context: input.context, operationContext: input.context, activity, direct: true };
  }

  async recordCommitted(input: {
    scope: ResourceMutationActivityScope;
    operation: OperationRecord;
    resourceRef: ResourceRef;
    changeType: WorkspaceChangeType;
    summary: string;
    stage?: Extract<ResourceUsageStage, "modified" | "reverted">;
    contentHash?: string;
  }): Promise<WorkspaceChangeRecord> {
    const stage = input.stage ?? "modified";
    const changeId = resourceMutationChangeId(input.operation.id, input.resourceRef, stage);
    try {
      const committed = await this.store.commitResourceMutationEvidence({
        change: {
          id: changeId,
          ...(input.scope.operationContext.run_id ? { run_id: input.scope.operationContext.run_id } : {}),
          ...(input.operation.session_id ? { session_id: input.operation.session_id } : {}),
          room_id: input.scope.operationContext.room_id!,
          activity_id: input.scope.activity.id,
          domain_operation_id: input.operation.id,
          ...(input.scope.operationContext.session_ref ? { session_ref: input.scope.operationContext.session_ref } : {}),
          resource_ref: input.resourceRef,
          change_type: input.changeType,
          summary: input.summary,
          correlation_id: input.scope.operationContext.correlation_id,
          created_at: input.operation.updated_at
        },
        resourceUsage: {
          id: resourceMutationUsageId(input.scope.activity.id, changeId, stage),
          activity_id: input.scope.activity.id,
          resource_ref: input.resourceRef,
          stage,
          usage_scope: { kind: "room", room_id: input.scope.context.room_id! },
          ...(input.resourceRef.version ? { resource_version: input.resourceRef.version } : {}),
          ...(input.contentHash ? { content_hash: input.contentHash } : {}),
          domain_operation_id: input.operation.id,
          workspace_change_id: changeId,
          created_at: input.operation.updated_at
        },
        ...(input.scope.direct ? {
          directActivity: {
            activityId: input.scope.activity.id,
            resultSummary: input.summary,
            domainOperationIds: [input.operation.id],
            now: input.operation.updated_at
          }
        } : {})
      });
      return committed.change;
    } catch (error) {
      // The Resource and Operation may already be committed. A direct Activity
      // must still end as failed rather than remain an open success-looking row.
      if (input.scope.direct) {
        try {
          await this.activityIngest.finalizeActivity({
            context: input.scope.context,
            activityId: input.scope.activity.id,
            status: "failed",
            failure: { code: "resource_mutation_evidence_failed", summary: evidenceFailureSummary(error) },
            domainOperationIds: [input.operation.id]
          });
        } catch (failureFinalizationFailure) {
          throw new ResourceMutationEvidenceError(evidenceFailureStage(error), error, failureFinalizationFailure);
        }
      }
      throw new ResourceMutationEvidenceError(evidenceFailureStage(error), error);
    }
  }

  async recordFailed(input: {
    scope: ResourceMutationActivityScope | undefined;
    operation: OperationRecord;
    code: string;
    summary: string;
  }): Promise<void> {
    if (!input.scope?.direct || input.scope.activity.status !== "recording") return;
    await this.activityIngest.finalizeActivity({
      context: input.scope.context,
      activityId: input.scope.activity.id,
      status: "failed",
      failure: { code: input.code, summary: input.summary },
      domainOperationIds: [input.operation.id]
    });
  }
}

function evidenceFailureSummary(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "resource_mutation_evidence_failed";
}

function evidenceFailureStage(error: unknown): "workspace_change" | "resource_usage" | "activity_finalize" {
  if (typeof error === "object" && error !== null && "stage" in error) {
    const stage = (error as { stage?: unknown }).stage;
    if (stage === "workspace_change" || stage === "resource_usage" || stage === "activity_finalize") return stage;
  }
  return "workspace_change";
}

function activityMutationContext(activity: ActivityRecord, operationContext: TrustedWorkspaceContext): TrustedWorkspaceContext {
  const sessionRef = activity.session_ref ?? operationContext.session_ref;
  const runId = activity.backend_run_id ?? operationContext.run_id;
  return {
    workspace_id: activity.workspace_id,
    room_id: activity.room_id,
    principal: activity.principal,
    source: activity.source,
    correlation_id: operationContext.correlation_id,
    ...(sessionRef ? { session_ref: sessionRef } : {}),
    ...(runId ? { run_id: runId } : {})
  };
}

function resourceMutationChangeId(operationId: string, resourceRef: ResourceRef, stage: "modified" | "reverted"): string {
  return `change_${stableHash({ operation_id: operationId, resource_ref: resourceRef, stage })}`;
}

function resourceMutationUsageId(activityId: string, changeId: string, stage: "modified" | "reverted"): string {
  return `activity_use_${stableHash({ activity_id: activityId, change_id: changeId, stage })}`;
}
