import type {
  ActivityFailure,
  ActivityRecord,
  ActivityVerificationRecord,
  Principal,
  ResourceRef,
  ResourceUsageRecord,
  ResourceUsageStage,
  TrustedWorkspaceContext,
  UsageScopeRef
} from "@samurai-agent/core-schemas";

/** Core-only Activity ingress. Transport adapters belong to Core09. */
export interface ActivityIngestPort {
  startActivity(input: {
    context: TrustedWorkspaceContext;
    idempotencyKey: string;
    instructionSummary: string;
    correctionOfActivityId?: string;
    provenanceKind?: ActivityRecord["provenance"]["kind"];
  }): Promise<ActivityRecord>;
  linkBackendRun(input: { context: TrustedWorkspaceContext; activityId: string; backendRunId: string }): Promise<ActivityRecord>;
  recordResourceUsage(input: {
    context: TrustedWorkspaceContext;
    activityId: string;
    id: string;
    resourceRef: ResourceRef;
    stage: ResourceUsageStage;
    usageScope: UsageScopeRef;
    resourceVersion?: string;
    contentHash?: string;
    domainOperationId?: string;
    workspaceChangeId?: string;
    workspaceJobAttemptId?: string;
  }): Promise<ResourceUsageRecord>;
  finalizeActivity(input: {
    context: TrustedWorkspaceContext;
    activityId: string;
    status: Exclude<ActivityRecord["status"], "recording">;
    resultSummary?: string;
    verification?: ActivityVerificationRecord[];
    failure?: ActivityFailure;
    backendRunId?: string;
    domainOperationIds?: string[];
  }): Promise<ActivityRecord>;
  ingestFinalizedActivity(input: {
    context: TrustedWorkspaceContext;
    idempotencyKey: string;
    instructionSummary: string;
    status: Exclude<ActivityRecord["status"], "recording">;
    resultSummary?: string;
    verification?: ActivityVerificationRecord[];
    failure?: ActivityFailure;
    backendRunId?: string;
    domainOperationIds?: string[];
    correctionOfActivityId?: string;
    provenanceKind?: ActivityRecord["provenance"]["kind"];
    resourceUsage?: Array<Omit<ResourceUsageRecord, "activity_id" | "created_at">>;
  }): Promise<ActivityRecord>;
}

export type ActivityIngestPrincipal = Principal;
