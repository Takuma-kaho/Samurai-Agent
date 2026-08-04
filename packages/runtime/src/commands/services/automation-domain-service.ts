import { type ActivityInboxItem, type AutomationJobRecord, type CuratorLifecycleReport, type CuratorReviewReport, type EvaluationTraceReport, type JsonValue, type LearningEvaluationRecord, type MessageEnvelope, type OperationRecord, type ReflectionRunRecord, type ReflectionSuggestionRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";

interface AutomationRunRecord { id: string; kind: string; source: string; session_id?: string; backend_run_id?: string; status: "started" | "completed" | "failed"; operation_id?: string; started_at: string; completed_at?: string; error?: string }
interface ReflectionExecutionResult { reflectionRun: ReflectionRunRecord; suggestions: ReflectionSuggestionRecord[]; learningEvaluations?: LearningEvaluationRecord[]; curatorReport?: CuratorLifecycleReport; curatorReviewReport?: CuratorReviewReport; evaluationReport?: EvaluationTraceReport }
export interface AutomationJobWriteResult { resource: AutomationJobRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }

export interface AutomationCommandPort {
  releaseLock(jobId: string, now?: string): Promise<AutomationJobRecord | undefined>;
  requeue(jobId: string, nextRunAt?: string): Promise<AutomationJobRecord | undefined>;
  getJob(jobId: string): Promise<AutomationJobRecord | undefined>;
  acquireLock(jobId: string, input: { lockedUntil: string; now: string }): Promise<AutomationJobRecord | undefined>;
}

export interface AutomationMutationPort {
  saveJob(job: AutomationJobRecord): Promise<AutomationJobRecord>;
  ensureSession(): Promise<SessionRecord>;
  createEnvelope(content: string): MessageEnvelope;
  runMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: AutomationJobRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<AutomationJobWriteResult>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  ref(job: AutomationJobRecord): ResourceRef;
  contract(id: "automation.job.save" | "automation.job.set_status"): { id: string; proposed_effects: string[] };
}

export interface ScheduledAutomationContext {
  source: "cron";
  actor_identity: "owner_scheduled";
  instruction_source: "scheduled_context";
  channel: "cron";
  session_key: string;
}
type ScheduledContext = ScheduledAutomationContext;
type ScheduledSession = SessionRecord;
export interface AutomationExecutionPort {
  createRun(input: Pick<AutomationRunRecord, "id" | "kind" | "source" | "status" | "started_at">): Promise<AutomationRunRecord>;
  updateRun(record: AutomationRunRecord): Promise<AutomationRunRecord>;
  ensureSession(context: ScheduledContext, title: string, roomId?: string): Promise<ScheduledSession>;
  createEnvelope(context: ScheduledContext, content: string): MessageEnvelope;
  runMutation<T>(input: { session: ScheduledSession; envelope: MessageEnvelope; context: ScheduledContext; operationName: string; inputRef?: ResourceRef; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; summary: string; rollbackPoint?: RollbackPoint }> }): Promise<{ resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
  reindexWiki(): Promise<{ active: number; total: number }>;
  runCurator(): Promise<{ suggestions: ReflectionSuggestionRecord[] }>;
  runMemoryReview(session: ScheduledSession): Promise<ReflectionExecutionResult>;
  runEvaluation(): Promise<{ learningEvaluations?: LearningEvaluationRecord[] }>;
  runTranslation(job: AutomationJobRecord, session: ScheduledSession, context: ScheduledContext): Promise<{ backendRunId: string; source_ref: ResourceRef; target_locale: string }>;
  runCollectionTrigger(job: AutomationJobRecord): Promise<string | undefined>;
  runInstruction(job: AutomationJobRecord, session: ScheduledSession, context: ScheduledContext): Promise<{ backendRunId: string; summary: string }>;
  errorMessage(error: unknown): string;
  retryAt(failureCount: number): string;
}

export class AutomationDomainService {
  constructor(private readonly dependencies: {
    automation: AutomationCommandPort;
    mutation: AutomationMutationPort;
    execution: AutomationExecutionPort;
    requestError: (code: "conflict" | "not_found", message: string) => Error;
  }) {}

  releaseLock(jobId: string, now?: string) { return this.dependencies.automation.releaseLock(jobId, now); }

  requeue(jobId: string, nextRunAt?: string) { return this.dependencies.automation.requeue(jobId, nextRunAt); }

  notFoundError() { return this.dependencies.requestError("not_found", "automation_job_not_found"); }
  jobContract(id: "automation.job.save" | "automation.job.set_status") { return this.dependencies.mutation.contract(id); }
  ensureMutationSession() { return this.dependencies.mutation.ensureSession(); }
  createMutationEnvelope(content: string) { return this.dependencies.mutation.createEnvelope(content); }
  getJob(id: string) { return this.dependencies.automation.getJob(id); }
  saveJobRecord(job: AutomationJobRecord) { return this.dependencies.mutation.saveJob(job); }
  jobRef(job: AutomationJobRecord) { return this.dependencies.mutation.ref(job); }
  createJobRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.dependencies.mutation.createRollback(operation, refs, before, after); }
  runJobMutation(input: Parameters<AutomationMutationPort["runMutation"]>[0]) { return this.dependencies.mutation.runMutation(input); }
  jobError(code: "not_found" | "conflict", message: string) { return this.dependencies.requestError(code, message); }
  createExecutionRun(input: Pick<AutomationRunRecord, "id" | "kind" | "source" | "status" | "started_at">) { return this.dependencies.execution.createRun(input); }
  updateExecutionRun(record: AutomationRunRecord) { return this.dependencies.execution.updateRun(record); }
  ensureExecutionSession(context: ScheduledContext, title: string, roomId?: string) { return this.dependencies.execution.ensureSession(context, title, roomId); }
  createExecutionEnvelope(context: ScheduledContext, content: string) { return this.dependencies.execution.createEnvelope(context, content); }
  runExecutionMutation<T>(input: { session: ScheduledSession; envelope: MessageEnvelope; context: ScheduledContext; operationName: string; inputRef?: ResourceRef; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; summary: string; rollbackPoint?: RollbackPoint }> }) { return this.dependencies.execution.runMutation(input); }
  runExecutionMemoryReview(session: ScheduledSession) { return this.dependencies.execution.runMemoryReview(session); }
  executionErrorMessage(error: unknown) { return this.dependencies.execution.errorMessage(error); }
  acquireAutomationJobLock(id: string, input: { lockedUntil: string; now: string }) { return this.dependencies.automation.acquireLock(id, input); }
  reindexAutomationWiki() { return this.dependencies.execution.reindexWiki(); }
  runAutomationCurator() { return this.dependencies.execution.runCurator(); }
  runAutomationMemoryReview(session: ScheduledSession) { return this.dependencies.execution.runMemoryReview(session); }
  runAutomationEvaluation() { return this.dependencies.execution.runEvaluation(); }
  runAutomationTranslation(job: AutomationJobRecord, session: ScheduledSession, context: ScheduledContext) { return this.dependencies.execution.runTranslation(job, session, context); }
  runAutomationCollectionTrigger(job: AutomationJobRecord) { return this.dependencies.execution.runCollectionTrigger(job); }
  runAutomationInstruction(job: AutomationJobRecord, session: ScheduledSession, context: ScheduledContext) { return this.dependencies.execution.runInstruction(job, session, context); }
  automationRetryAt(failureCount: number) { return this.dependencies.execution.retryAt(failureCount); }

}
