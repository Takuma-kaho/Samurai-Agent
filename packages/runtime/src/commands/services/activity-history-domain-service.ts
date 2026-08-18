import type { ActivityRecord, TrustedWorkspaceContext } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import type { ActivityHistoryQueryService } from "../../activity/activity-history-query-service.js";

export class ActivityHistoryDomainService {
  constructor(
    private readonly query: ActivityHistoryQueryService,
    private readonly workspaceContext: (context: TrustedDomainContext) => TrustedWorkspaceContext
  ) {}

  async get(input: { context: TrustedDomainContext; activityId: string }): Promise<ActivityRecord> {
    const item = await this.query.getActivity({ context: this.workspaceContext(input.context), activityId: input.activityId });
    if (!item) throw new Error(`activity_not_found:${input.activityId}`);
    return item;
  }

  list(input: {
    context: TrustedDomainContext;
    request: {
      principal_id?: string;
      source_kind?: ActivityRecord["source"]["kind"];
      source_id?: string;
      status?: ActivityRecord["status"];
      created_after?: string;
      created_before?: string;
      limit?: number;
      offset?: number;
    };
  }): Promise<ActivityRecord[]> {
    return this.query.listActivities({
      context: this.workspaceContext(input.context),
      ...(input.request.principal_id ? { principalId: input.request.principal_id } : {}),
      ...(input.request.source_kind ? { sourceKind: input.request.source_kind } : {}),
      ...(input.request.source_id ? { sourceId: input.request.source_id } : {}),
      ...(input.request.status ? { status: input.request.status } : {}),
      ...(input.request.created_after ? { createdAfter: input.request.created_after } : {}),
      ...(input.request.created_before ? { createdBefore: input.request.created_before } : {}),
      ...(input.request.limit ? { limit: input.request.limit + (input.request.offset ?? 0) } : {})
    }).then((items) => input.request.offset ? items.slice(input.request.offset, input.request.offset + (input.request.limit ?? items.length)) : items);
  }
}
