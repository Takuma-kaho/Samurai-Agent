import type { ActivityRecord, TrustedWorkspaceContext } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import type { ActivityHistoryQueryService } from "../../activity/activity-history-query-service.js";

export class ActivityHistoryDomainService {
  constructor(
    private readonly query: ActivityHistoryQueryService,
    private readonly workspaceContext: (context: TrustedDomainContext) => TrustedWorkspaceContext
  ) {}

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
      ...(input.request.limit ? { limit: input.request.limit } : {})
    });
  }
}
