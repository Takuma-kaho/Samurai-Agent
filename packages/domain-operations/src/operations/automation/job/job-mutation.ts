import type { ActivityInboxItem, AutomationJobRecord, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";

export interface AutomationJobMutationPorts {
  automationJobContract(id: "automation.job.save" | "automation.job.set_status"): { id: string; proposed_effects: string[] };
  ensureAutomationSession(): Promise<SessionRecord>;
  createAutomationEnvelope(content: string): MessageEnvelope;
  getAutomationJob(id: string): Promise<AutomationJobRecord | undefined>;
  saveAutomationJobRecord(job: AutomationJobRecord): Promise<AutomationJobRecord>;
  automationJobRef(job: AutomationJobRecord): ResourceRef;
  createAutomationRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runAutomationJobMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: AutomationJobRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: AutomationJobRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
  automationJobError(code: "not_found" | "conflict", message: string): Error;
}

export function automationJobJson(job: AutomationJobRecord): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(job)) as Record<string, JsonValue>;
}
