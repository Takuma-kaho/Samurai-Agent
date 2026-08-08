import {
  createId,
  nowIso,
  type ActivityContextRef,
  type BackendRunRecord,
  type LearningEvidenceState,
  type LearningResourceUseRecord,
  type LearningUsageState,
  type UsageScopeRef
} from "@samurai-agent/core-schemas";

export type AppliedLearningResourceKind = "memory" | "wiki" | "skill";

export interface AppliedLearningResource {
  resource_kind: AppliedLearningResourceKind;
  resource_id: string;
  resource_version?: string;
  content_hash?: string;
  usage_scope?: UsageScopeRef;
  evidence_state?: LearningEvidenceState;
  usage_state?: LearningUsageState;
}

export interface LearningResourceUseDomainServiceDependencies {
  getRun(id: string): Promise<BackendRunRecord | undefined>;
  resolveActivityContext(run: BackendRunRecord): Promise<ActivityContextRef | undefined>;
  getResource(input: { resourceKind: AppliedLearningResourceKind; resourceId: string }): Promise<AppliedLearningResource | undefined>;
  listUses(input: { runId: string; resourceId: string; activityContext: ActivityContextRef }): Promise<LearningResourceUseRecord[]>;
  recordUse(record: LearningResourceUseRecord): Promise<LearningResourceUseRecord>;
  requestError(code: "not_found" | "conflict", message: string): Error;
}

/** Validates actual use at the Domain boundary; context injection alone is never `applied`. */
export class LearningResourceUseDomainService {
  constructor(private readonly dependencies: LearningResourceUseDomainServiceDependencies) {}

  async recordAppliedResourceUse(input: {
    runId: string;
    resourceKind: AppliedLearningResourceKind;
    resourceId: string;
    resourceVersion: string;
    contentHash: string;
    decisionSummary: string;
    matchedConditions: string[];
  }): Promise<{ use_record: LearningResourceUseRecord }> {
    const run = await this.dependencies.getRun(input.runId);
    if (!run) throw this.dependencies.requestError("not_found", "learning_resource_use_run_not_found");
    const activityContext = await this.dependencies.resolveActivityContext(run);
    if (!activityContext) throw this.dependencies.requestError("conflict", "learning_resource_use_activity_context_required");
    const resource = await this.dependencies.getResource({ resourceKind: input.resourceKind, resourceId: input.resourceId });
    if (!resource) throw this.dependencies.requestError("not_found", "learning_resource_use_resource_not_found");
    if (!resource.resource_version || !resource.content_hash) {
      throw this.dependencies.requestError("conflict", "learning_resource_use_version_required");
    }
    if (resource.resource_version !== input.resourceVersion || resource.content_hash !== input.contentHash) {
      throw this.dependencies.requestError("conflict", "learning_resource_use_version_mismatch");
    }
    if (!scopeAllowsActivity(resource.usage_scope, activityContext)) {
      throw this.dependencies.requestError("conflict", "learning_resource_use_scope_mismatch");
    }
    if (resource.evidence_state === "conflict" || resource.usage_state === "dormant") {
      throw this.dependencies.requestError("conflict", "learning_resource_use_not_eligible");
    }
    const uses = await this.dependencies.listUses({ runId: run.id, resourceId: resource.resource_id, activityContext });
    const bodyLoaded = uses.some((record) =>
      record.resource_kind === resource.resource_kind
      && record.stage === "body_loaded"
      && record.resource_version === input.resourceVersion
      && record.content_hash === input.contentHash
      && sameScope(record.usage_scope, resource.usage_scope)
    );
    if (!bodyLoaded) throw this.dependencies.requestError("conflict", "learning_resource_use_body_not_loaded");
    if (!run.session_id) throw this.dependencies.requestError("conflict", "learning_resource_use_session_compatibility_required");
    const useRecord = await this.dependencies.recordUse({
      id: createId("learning_use"),
      run_id: run.id,
      session_id: run.session_id,
      activity_context: activityContext,
      resource_kind: resource.resource_kind,
      resource_id: resource.resource_id,
      resource_version: input.resourceVersion,
      content_hash: input.contentHash,
      usage_scope: resource.usage_scope,
      stage: "applied",
      source_operation_id: "learning.resource.usage.record",
      decision_summary: input.decisionSummary,
      matched_conditions: input.matchedConditions,
      metadata: { applied: true },
      created_at: nowIso()
    });
    return { use_record: useRecord };
  }
}

function scopeAllowsActivity(scope: UsageScopeRef | undefined, activity: ActivityContextRef): boolean {
  const resolved = scope ?? { kind: "workspace" as const };
  if (resolved.kind === "workspace") return true;
  if (resolved.kind === "room") return resolved.room_id === activity.room_id;
  if (resolved.kind === "agent") return resolved.agent_id === activity.agent_id;
  return resolved.session_id === activity.session_id;
}

function sameScope(left: UsageScopeRef | undefined, right: UsageScopeRef | undefined): boolean {
  return JSON.stringify(left ?? { kind: "workspace" }) === JSON.stringify(right ?? { kind: "workspace" });
}
