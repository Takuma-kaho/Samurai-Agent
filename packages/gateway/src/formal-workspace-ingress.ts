import type { ActivityRecord, ConnectorEvidence, JsonValue, ResourceUsageRecord } from "@samurai-agent/core-schemas";

/**
 * Gateway's inward-facing formal Workspace boundary.
 *
 * Pairing and delivery remain transport admission concerns. This contract has
 * no Pairing, Session, Store, or credential fields, so it cannot turn an
 * admitted transport into a Workspace principal by accident.
 */
export interface FormalWorkspaceIngressPort {
  query(input: {
    evidence: ConnectorEvidence;
    target: FormalWorkspaceTarget;
    query_id: string;
    payload?: unknown;
  }): Promise<unknown>;
  domainOperation(input: {
    evidence: ConnectorEvidence;
    target: FormalWorkspaceTarget;
    command_id: string;
    payload?: unknown;
  }): Promise<unknown>;
  activityIngest(input: {
    evidence: ConnectorEvidence;
    target: FormalWorkspaceTarget;
    idempotency_key: string;
    instruction_summary: string;
    status: Exclude<ActivityRecord["status"], "recording">;
    result_summary?: string;
    verification?: ActivityRecord["verification"];
    failure?: ActivityRecord["failure"];
    domain_operation_ids?: string[];
    correction_of_activity_id?: string;
    resource_usage?: Array<Omit<ResourceUsageRecord, "activity_id" | "created_at">>;
  }): Promise<unknown>;
}

/** Untrusted target selection; the Runtime resolver validates it. */
export interface FormalWorkspaceTarget {
  requested_room_id: string;
  correlation_id: string;
  idempotency_key?: string;
  session_ref?: {
    app_id: string;
    session_id: string;
    turn_id?: string;
    message_id?: string;
    resume_url?: string;
    external_ref?: string;
  };
}

/**
 * A transport-neutral adapter used after webhook verification or pairing.
 * It deliberately delegates all authorization to Runtime's Connection
 * resolver and has no access to a Workspace repository.
 */
export class GatewayFormalWorkspaceIngress {
  constructor(private readonly port: FormalWorkspaceIngressPort) {}

  query(input: {
    evidence: ConnectorEvidence;
    target: FormalWorkspaceTarget;
    query_id: string;
    payload?: Record<string, JsonValue>;
  }) {
    return this.port.query(input);
  }

  domainOperation(input: {
    evidence: ConnectorEvidence;
    target: FormalWorkspaceTarget;
    command_id: string;
    payload?: Record<string, JsonValue>;
  }) {
    return this.port.domainOperation(input);
  }

  activityIngest(input: {
    evidence: ConnectorEvidence;
    target: FormalWorkspaceTarget;
    idempotency_key: string;
    instruction_summary: string;
    status: Exclude<ActivityRecord["status"], "recording">;
    result_summary?: string;
    verification?: ActivityRecord["verification"];
    failure?: ActivityRecord["failure"];
    domain_operation_ids?: string[];
    correction_of_activity_id?: string;
    resource_usage?: Array<Omit<ResourceUsageRecord, "activity_id" | "created_at">>;
  }) {
    return this.port.activityIngest(input);
  }
}
