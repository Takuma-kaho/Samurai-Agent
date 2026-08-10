import type { ActivityRecord, ConnectorEvidence, ResourceUsageRecord } from "@samurai-agent/core-schemas";
import type { DomainCommandRuntimeResult, DomainQueryRuntimeResult } from "../agent-runtime.js";
import type { RequestedWorkspaceTarget } from "./external-app-context-resolver.js";
import type { ExternalAppIngress } from "./external-app-ingress.js";

/**
 * In-process-only Core09 reference adapter.
 *
 * It accepts already authenticated, secret-free ConnectorEvidence and proves
 * the shared formal ingress contract. It opens no port and defines no HTTP,
 * MCP, Plugin, OAuth, or credential protocol.
 */
export class ReferenceExternalAppAdapter {
  constructor(private readonly ingress: ExternalAppIngress) {}

  query(input: {
    evidence: ConnectorEvidence;
    target: RequestedWorkspaceTarget;
    query_id: string;
    payload?: unknown;
  }): Promise<DomainQueryRuntimeResult> {
    return this.ingress.query(input);
  }

  domainOperation(input: {
    evidence: ConnectorEvidence;
    target: RequestedWorkspaceTarget;
    command_id: string;
    payload?: unknown;
  }): Promise<DomainCommandRuntimeResult> {
    return this.ingress.domainOperation(input);
  }

  activityIngest(input: {
    evidence: ConnectorEvidence;
    target: RequestedWorkspaceTarget;
    idempotency_key: string;
    instruction_summary: string;
    status: Exclude<ActivityRecord["status"], "recording">;
    result_summary?: string;
    verification?: ActivityRecord["verification"];
    failure?: ActivityRecord["failure"];
    domain_operation_ids?: string[];
    correction_of_activity_id?: string;
    resource_usage?: Array<Omit<ResourceUsageRecord, "activity_id" | "created_at">>;
  }): Promise<ActivityRecord> {
    return this.ingress.activityIngest(input);
  }
}
