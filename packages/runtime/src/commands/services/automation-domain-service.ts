import type { ActivityInboxItem, AutomationJobRecord, OperationRecord, RollbackPoint } from "@samurai-agent/core-schemas";

/** Retained only as a typed provenance label for the stopped legacy executors. */
export interface ScheduledAutomationContext {
  source: "cron";
  actor_identity: "owner_scheduled";
  instruction_source: "scheduled_context";
  channel: "cron";
  session_key: string;
}

export interface AutomationJobWriteResult {
  resource: AutomationJobRecord;
  operation: OperationRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

export interface AutomationCommandPort {
  releaseLock(jobId: string, lockOwnerToken: string, now?: string): Promise<AutomationJobRecord | undefined>;
  requeue(jobId: string, nextRunAt?: string): Promise<AutomationJobRecord | undefined>;
}

/** Legacy operational controls only. Core09 lifecycle work lives separately. */
export class AutomationDomainService {
  constructor(private readonly dependencies: {
    automation: AutomationCommandPort;
    requestError: (code: "conflict" | "not_found", message: string) => Error;
  }) {}

  releaseLock(jobId: string, lockOwnerToken: string, now?: string) { return this.dependencies.automation.releaseLock(jobId, lockOwnerToken, now); }
  requeue(jobId: string, nextRunAt?: string) { return this.dependencies.automation.requeue(jobId, nextRunAt); }
  notFoundError() { return this.dependencies.requestError("not_found", "automation_job_not_found"); }
}
