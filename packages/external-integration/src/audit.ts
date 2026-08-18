import { randomBytes } from "node:crypto";
import { AuditEventSchema, type AuditEvent, type ExternalIntegrationStore } from "./contracts.js";

export interface AppendAuditEventInput {
  eventType: string;
  actorId?: string;
  workspaceId?: string;
  connectionId?: string;
  connectorId?: string;
  accountId?: string;
  resourceType: string;
  resourceId: string;
  data?: Record<string, unknown>;
  createdAt?: string;
}

/** External-integration changes are auditable records, never raw secrets. */
export function createAuditEvent(input: AppendAuditEventInput): AuditEvent {
  return AuditEventSchema.parse({
    id: `audit_${randomBytes(16).toString("hex")}`,
    event_type: input.eventType,
    ...(input.actorId ? { actor_id: input.actorId } : {}),
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    ...(input.connectionId ? { connection_id: input.connectionId } : {}),
    ...(input.connectorId ? { connector_id: input.connectorId } : {}),
    ...(input.accountId ? { account_id: input.accountId } : {}),
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    data: redactAuditData(input.data ?? {}),
    created_at: input.createdAt ?? new Date().toISOString()
  });
}

/** External-integration changes are auditable records, never raw secrets. */
export async function appendAuditEvent(store: ExternalIntegrationStore, input: AppendAuditEventInput): Promise<AuditEvent> {
  const event = createAuditEvent(input);
  return store.createRecord("audit_event", event);
}

function redactAuditData(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/(token|secret|password|authorization|cookie|code|verifier|state)/i.test(key)) return [key, "[REDACTED]"];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return [key, redactAuditData(entry as Record<string, unknown>)];
    return [key, entry];
  }));
}
