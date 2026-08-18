import {
  TrustedWorkspaceContextSchema,
  type ActivityRecord,
  type ResourceUsageRecord,
  type TrustedWorkspaceContext,
  type WorkspaceJobAttemptRecord,
  type WorkspaceJobRecord
} from "@samurai-agent/core-schemas";
import type { ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { RoomAuthorizationService } from "../commands/services/room-authorization-service";

interface ActivityQueryStore {
  getActivity(id: string): Promise<ActivityRecord | undefined>;
  listActivities(input: {
    workspaceId: string;
    roomId?: string;
    principalId?: string;
    sourceKind?: ActivityRecord["source"]["kind"];
    sourceId?: string;
    status?: ActivityRecord["status"];
    createdAfter?: string;
    createdBefore?: string;
    limit?: number;
  }): Promise<ActivityRecord[]>;
  listResourceUsage(input: { activityId: string; workspaceJobAttemptId?: string }): Promise<ResourceUsageRecord[]>;
  getWorkspaceJob(id: string): Promise<WorkspaceJobRecord | undefined>;
  listWorkspaceJobs(input: {
    workspaceId: string;
    roomId?: string;
    rootActivityId?: string;
    status?: WorkspaceJobRecord["status"];
  }): Promise<WorkspaceJobRecord[]>;
  listWorkspaceJobAttempts(workspaceJobId: string): Promise<WorkspaceJobAttemptRecord[]>;
}

/** Internal Room-scoped reads for Core07. It is not an HTTP or MCP adapter. */
export class ActivityHistoryQueryService {
  constructor(private readonly store: ActivityQueryStore, private readonly roomAuthorization: RoomAuthorizationService) {}

  async getActivity(input: { context: TrustedWorkspaceContext; activityId: string }): Promise<ActivityRecord | undefined> {
    const context = await this.assertReadContext(input.context);
    const activity = await this.store.getActivity(input.activityId);
    if (!activity) return undefined;
    this.assertSameRoom(context, activity.workspace_id, activity.room_id);
    return activity;
  }

  async listActivities(input: {
    context: TrustedWorkspaceContext;
    principalId?: string;
    sourceKind?: ActivityRecord["source"]["kind"];
    sourceId?: string;
    status?: ActivityRecord["status"];
    createdAfter?: string;
    createdBefore?: string;
    limit?: number;
  }): Promise<ActivityRecord[]> {
    const context = await this.assertReadContext(input.context);
    if (input.limit !== undefined && !Number.isFinite(input.limit)) throw new Error("activity_query_limit_invalid");
    const limit = input.limit === undefined ? undefined : Math.min(10_200, Math.max(1, Math.trunc(input.limit)));
    if (input.createdAfter) assertIsoDate(input.createdAfter, "activity_query_created_after_invalid");
    if (input.createdBefore) assertIsoDate(input.createdBefore, "activity_query_created_before_invalid");
    return this.store.listActivities({
      workspaceId: context.workspace_id,
      roomId: context.room_id,
      ...(input.principalId ? { principalId: input.principalId } : {}),
      ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.createdAfter ? { createdAfter: input.createdAfter } : {}),
      ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}),
      ...(limit ? { limit } : {})
    });
  }

  async listResourceUsage(input: { context: TrustedWorkspaceContext; activityId: string }) {
    const activity = await this.getActivity({ context: input.context, activityId: input.activityId });
    return activity ? this.store.listResourceUsage({ activityId: activity.id }) : [];
  }

  async getWorkspaceJob(input: { context: TrustedWorkspaceContext; workspaceJobId: string }): Promise<WorkspaceJobRecord | undefined> {
    const context = await this.assertReadContext(input.context);
    const job = await this.store.getWorkspaceJob(input.workspaceJobId);
    if (!job) return undefined;
    this.assertSameRoom(context, job.workspace_id, job.room_id);
    return job;
  }

  async listWorkspaceJobs(input: { context: TrustedWorkspaceContext; rootActivityId?: string; status?: WorkspaceJobRecord["status"] }) {
    const context = await this.assertReadContext(input.context);
    return this.store.listWorkspaceJobs({
      workspaceId: context.workspace_id,
      roomId: context.room_id,
      ...(input.rootActivityId ? { rootActivityId: input.rootActivityId } : {}),
      ...(input.status ? { status: input.status } : {})
    });
  }

  async listWorkspaceJobAttempts(input: { context: TrustedWorkspaceContext; workspaceJobId: string }) {
    const job = await this.getWorkspaceJob({ context: input.context, workspaceJobId: input.workspaceJobId });
    return job ? this.store.listWorkspaceJobAttempts(job.id) : [];
  }

  private async assertReadContext(input: TrustedWorkspaceContext): Promise<TrustedWorkspaceContext> {
    const context = TrustedWorkspaceContextSchema.parse(input);
    if (!context.room_id) throw new Error("activity_context_room_required");
    const principal = participantPrincipal(context.principal);
    if (principal.kind === "system") throw new Error("activity_system_principal_not_authorized");
    await this.roomAuthorization.assertRoom(principal, context.room_id, "read");
    return context;
  }

  private assertSameRoom(context: TrustedWorkspaceContext, workspaceId: string, roomId: string): void {
    if (context.workspace_id !== workspaceId || context.room_id !== roomId) throw new Error("activity_query_room_boundary_denied");
  }
}

function assertIsoDate(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
}

function participantPrincipal(principal: TrustedWorkspaceContext["principal"]): ParticipantPrincipal {
  if (principal.kind === "human") return { kind: "human", participantId: principal.participant_id };
  if (principal.kind === "agent") return { kind: "agent", agentId: principal.agent_id, requestedByParticipantId: principal.requested_by_participant_id };
  if (principal.kind === "external_app") {
    const delegatedBy = participantPrincipal(principal.delegated_by);
    if (delegatedBy.kind !== "human" && delegatedBy.kind !== "agent") throw new Error("external_app_delegation_invalid");
    return { kind: "external_app", appId: principal.app_id, delegatedBy, ...(principal.connector_id ? { connectorId: principal.connector_id } : {}) };
  }
  return { kind: "system", participantId: `system:${principal.system_id}` };
}
