import { createId, nowIso, type ActivityInboxItem, type AutomationJobRecord, type CuratorLifecycleReport, type CuratorReviewReport, type EvaluationTraceReport, type JsonValue, type LearningEvaluationRecord, type MessageEnvelope, type OperationRecord, type ReflectionRunRecord, type ReflectionSuggestionRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";
import { jsonValue } from "./json-value.js";

interface AutomationRunRecord { id: string; kind: string; source: string; session_id?: string; backend_run_id?: string; status: "started" | "completed" | "failed"; operation_id?: string; started_at: string; completed_at?: string; error?: string }
interface ReflectionExecutionResult { reflectionRun: ReflectionRunRecord; suggestions: ReflectionSuggestionRecord[]; learningEvaluations?: LearningEvaluationRecord[]; curatorReport?: CuratorLifecycleReport; curatorReviewReport?: CuratorReviewReport; evaluationReport?: EvaluationTraceReport }
interface AutomationRunResult { resource: AutomationRunRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[]; automationRun: AutomationRunRecord }
interface MemoryReviewAutomationResult extends AutomationRunResult { memoryReviewTrace: ReflectionExecutionResult }
export interface AutomationJobWriteResult { resource: AutomationJobRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }

export interface AutomationJobInput {
  title: string; kind: AutomationJobRecord["kind"]; schedule: string; target_instruction: string;
  delivery_target?: Record<string, JsonValue>; enabled?: boolean; next_run_at?: string; max_attempts?: number;
}

export interface AutomationCommandPort {
  releaseLock(jobId: string, now?: string): Promise<AutomationJobRecord | undefined>;
  requeue(jobId: string, nextRunAt?: string): Promise<AutomationJobRecord | undefined>;
  getJob(jobId: string): Promise<AutomationJobRecord | undefined>;
  acquireLock(jobId: string, input: { lockedUntil: string; now: string }): Promise<AutomationJobRecord | undefined>;
  runJob(job: AutomationJobRecord, now: string): Promise<AutomationRunResult>;
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

type ScheduledContext = { source: "cron"; actor_identity: "owner_scheduled"; instruction_source: "scheduled_context"; channel: "cron"; session_key: string };
type ScheduledSession = SessionRecord;
export interface AutomationExecutionPort {
  createRun(input: Pick<AutomationRunRecord, "id" | "kind" | "source" | "status" | "started_at">): Promise<AutomationRunRecord>;
  updateRun(record: AutomationRunRecord): Promise<AutomationRunRecord>;
  ensureSession(context: ScheduledContext, title: string): Promise<ScheduledSession>;
  createEnvelope(context: ScheduledContext, content: string): MessageEnvelope;
  runMutation<T>(input: { session: ScheduledSession; envelope: MessageEnvelope; context: ScheduledContext; operationName: string; inputRef?: ResourceRef; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; summary: string; rollbackPoint?: RollbackPoint }> }): Promise<{ resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
  reindexWiki(): Promise<{ active: number; total: number }>;
  runCurator(): Promise<{ suggestions: unknown[] }>;
  runMemoryReview(session: ScheduledSession): Promise<ReflectionExecutionResult>;
  runEvaluation(): Promise<{ learningEvaluations?: unknown[] }>;
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

  async releaseLock(payload: Record<string, JsonValue>) {
    const job = await this.dependencies.automation.releaseLock(requiredId(payload, "job_id"), optionalString(payload.now) || undefined);
    return this.requireJob(job);
  }

  async requeue(payload: Record<string, JsonValue>) {
    const job = await this.dependencies.automation.requeue(requiredId(payload, "job_id"), optionalString(payload.next_run_at) || undefined);
    return this.requireJob(job);
  }

  async run(payload: Record<string, JsonValue>) {
    const jobId = requiredId(payload, "job_id");
    const job = await this.dependencies.automation.getJob(jobId);
    if (!job) throw this.dependencies.requestError("not_found", `Automation job not found: ${jobId}`);
    const now = optionalString(payload.now) || nowIso();
    const locked = await this.dependencies.automation.acquireLock(job.id, {
      lockedUntil: new Date(Date.parse(now) + 15 * 60_000).toISOString(), now
    });
    if (!locked) throw this.dependencies.requestError("conflict", "automation_job_locked");
    return this.dependencies.automation.runJob(locked, now);
  }

  save(payload: Record<string, JsonValue>) {
    return this.saveInput({
      title: optionalString(payload.title),
      kind: automationKind(payload.kind),
      schedule: optionalString(payload.schedule),
      target_instruction: optionalString(payload.target_instruction),
      delivery_target: recordValue(payload.delivery_target),
      enabled: typeof payload.enabled === "boolean" ? payload.enabled : undefined,
      next_run_at: optionalString(payload.next_run_at) || undefined,
      max_attempts: finiteNumber(payload.max_attempts)
    });
  }

  async setStatus(payload: Record<string, JsonValue>) {
    const status = payload.status === "enabled" || payload.status === "disabled" ? payload.status : undefined;
    if (!status) throw this.dependencies.requestError("conflict", "automation_job_status_invalid");
    const job = await this.dependencies.automation.getJob(requiredId(payload, "job_id"));
    if (!job) throw this.dependencies.requestError("not_found", "automation_job_not_found");
    return this.setStatusInput(job, status);
  }

  runMemoryReview() { return this.executeMemoryReview(); }

  async executeMemoryReview(): Promise<MemoryReviewAutomationResult> {
    const startedAt = nowIso();
    let automationRun = await this.dependencies.execution.createRun({
      id: createId("automation_run"), kind: "memory_review", source: "cron", status: "started", started_at: startedAt
    });
    const context: ScheduledContext = {
      source: "cron", actor_identity: "owner_scheduled", instruction_source: "scheduled_context",
      channel: "cron", session_key: "cron:memory-review"
    };
    const session = await this.dependencies.execution.ensureSession(context, "Scheduled memory review");
    automationRun = await this.dependencies.execution.updateRun({ ...automationRun, session_id: session.id });
    const envelope = this.dependencies.execution.createEnvelope(context, "Run scheduled memory review.");
    try {
      let trace: ReflectionExecutionResult | undefined;
      const result = await this.dependencies.execution.runMutation({
        session, envelope, context, operationName: "automation.memory_review.run",
        inputRef: { kind: "automation_run", id: automationRun.id, uri: `automation-runs/${automationRun.id}`, label: "Automation run" },
        proposedEffects: ["Run scheduled memory review and deterministic curator without external effects."],
        execute: async (operation) => {
          trace = await this.dependencies.execution.runMemoryReview(session);
          return { resource: automationRun,
            ref: { kind: "automation_run", id: automationRun.id, uri: `automation-runs/${automationRun.id}`, label: "Memory review automation" },
            summary: `Memory review automation ran Background Review and applied ${trace.suggestions.length} learning change(s).` };
        }
      });
      automationRun = await this.dependencies.execution.updateRun({ ...automationRun, status: "completed", operation_id: result.operation.id, completed_at: nowIso() });
      if (!trace) throw new Error("memory_review_trace_missing");
      return { ...result, automationRun, memoryReviewTrace: trace };
    } catch (error) {
      automationRun = await this.dependencies.execution.updateRun({ ...automationRun, status: "failed", completed_at: nowIso(), error: this.dependencies.execution.errorMessage(error) });
      throw error;
    }
  }

  async execute(job: AutomationJobRecord, runStartedAt = nowIso()): Promise<AutomationRunResult> {
    let automationRun = await this.dependencies.execution.createRun({ id: createId("automationrun"), kind: job.kind, source: "automation_job", status: "started", started_at: runStartedAt });
    const context: ScheduledContext = { source: "cron", actor_identity: "owner_scheduled", instruction_source: "scheduled_context", channel: "cron", session_key: `cron:automation:${job.id}` };
    const session = await this.dependencies.execution.ensureSession(context, job.title);
    automationRun = await this.dependencies.execution.updateRun({ ...automationRun, session_id: session.id });
    const envelope = this.dependencies.execution.createEnvelope(context, job.target_instruction);
    try {
      const result = await this.dependencies.execution.runMutation({ session, envelope, context, operationName: "automation.job.run", inputRef: this.dependencies.mutation.ref(job), proposedEffects: [`Run automation job ${job.title}.`], execute: async (operation) => {
        const outcome = await this.executeKind(job, session, context);
        if (outcome.backendRunId) automationRun = { ...automationRun, backend_run_id: outcome.backendRunId };
        const ref = { kind: "automation_run", id: automationRun.id, uri: `automation-runs/${automationRun.id}`, label: job.title };
        const resource = await this.dependencies.execution.updateRun({ ...automationRun, status: "completed", operation_id: operation.id, completed_at: nowIso() });
        await this.dependencies.mutation.saveJob({ ...job, status: isOneShotSchedule(job.schedule) ? "disabled" : job.status, last_run_at: nowIso(), next_run_at: isOneShotSchedule(job.schedule) ? undefined : nextRunFromSchedule(job.schedule), retry_after_at: undefined, locked_until: undefined, failure_count: 0, last_error: undefined, updated_at: nowIso() });
        return { resource, ref, summary: outcome.summary };
      }});
      return { ...result, automationRun: result.resource };
    } catch (error) {
      const failureCount = (job.failure_count ?? 0) + 1; const retryable = failureCount < (job.max_attempts ?? 3); const errorText = this.dependencies.execution.errorMessage(error);
      automationRun = await this.dependencies.execution.updateRun({ ...automationRun, status: "failed", completed_at: nowIso(), error: errorText });
      await this.dependencies.mutation.saveJob({ ...job, status: retryable ? "enabled" : "disabled", retry_after_at: retryable ? this.dependencies.execution.retryAt(failureCount) : undefined, locked_until: undefined, failure_count: failureCount, last_error: errorText, updated_at: nowIso() });
      throw error;
    }
  }

  private async executeKind(job: AutomationJobRecord, session: ScheduledSession, context: ScheduledContext): Promise<{ summary: string; backendRunId?: string }> {
    switch (job.kind) {
      case "wiki_reindex": { const value = await this.dependencies.execution.reindexWiki(); return { summary: `Reindexed Knowledge Wiki pages: ${value.active}/${value.total} active.` }; }
      case "skill_curator": { const value = await this.dependencies.execution.runCurator(); return { summary: `Skill curator evaluated ${value.suggestions.length} learning decision(s).` }; }
      case "memory_review": { const value = await this.dependencies.execution.runMemoryReview(session); return { summary: `Background Review applied ${value.suggestions.length} learning change(s).` }; }
      case "learning_evaluation": { const value = await this.dependencies.execution.runEvaluation(); return { summary: `Learning Evaluation stored ${value.learningEvaluations?.length ?? 0} effect record(s).` }; }
      case "resource_translation": { const value = await this.dependencies.execution.runTranslation(job, session, context); return { backendRunId: value.backendRunId, summary: `Translated ${value.source_ref.kind}/${value.source_ref.id} to ${value.target_locale}.` }; }
      case "custom_instruction": { const summary = await this.dependencies.execution.runCollectionTrigger(job); if (summary) return { summary }; const value = await this.dependencies.execution.runInstruction(job, session, context); return { backendRunId: value.backendRunId, summary: value.summary }; }
      case "daily_digest": { const value = await this.dependencies.execution.runInstruction(job, session, context); return { backendRunId: value.backendRunId, summary: value.summary }; }
      default: return assertNever(job.kind);
    }
  }

  async saveInput(input: AutomationJobInput): Promise<AutomationJobWriteResult> {
    const contract = this.dependencies.mutation.contract("automation.job.save");
    const session = await this.dependencies.mutation.ensureSession();
    const envelope = this.dependencies.mutation.createEnvelope(`Save automation job: ${input.title}`);
    const now = nowIso();
    const job: AutomationJobRecord = {
      id: createId("automation"), title: input.title, kind: input.kind, status: input.enabled === false ? "disabled" : "enabled",
      schedule: input.schedule, target_instruction: input.target_instruction, delivery_target: input.delivery_target ?? { channel: "activity" },
      next_run_at: input.next_run_at ?? now, failure_count: 0, max_attempts: input.max_attempts ?? 3, created_at: now, updated_at: now
    };
    return this.dependencies.mutation.runMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, execute: async (operation) => {
      const saved = await this.dependencies.mutation.saveJob(job); const ref = this.dependencies.mutation.ref(saved);
      const rollbackPoint = await this.dependencies.mutation.createRollback(operation, [ref], {}, { automation_job: jsonValue(saved) });
      return { resource: saved, ref, rollbackPoint, summary: `Saved automation job ${saved.title}.` };
    }});
  }

  async setStatusInput(current: AutomationJobRecord, status: "enabled" | "disabled"): Promise<AutomationJobWriteResult> {
    const contract = this.dependencies.mutation.contract("automation.job.set_status");
    const session = await this.dependencies.mutation.ensureSession();
    const envelope = this.dependencies.mutation.createEnvelope(`${status === "enabled" ? "Resume" : "Pause"} automation: ${current.title}`);
    return this.dependencies.mutation.runMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [this.dependencies.mutation.ref(current)], execute: async (operation) => {
      const saved = await this.dependencies.mutation.saveJob({ ...current, status, locked_until: status === "disabled" ? undefined : current.locked_until, updated_at: nowIso() });
      const ref = this.dependencies.mutation.ref(saved); const rollbackPoint = await this.dependencies.mutation.createRollback(operation, [ref], { automation_job: jsonValue(current) }, { automation_job: jsonValue(saved) });
      return { resource: saved, ref, rollbackPoint, summary: `${status === "enabled" ? "Resumed" : "Paused"} automation ${saved.title}.` };
    }});
  }

  private requireJob(job: AutomationJobRecord | undefined): AutomationJobRecord {
    if (!job) throw this.dependencies.requestError("not_found", "automation_job_not_found");
    return job;
  }
}

function optionalString(value: JsonValue | undefined): string { return typeof value === "string" ? value.trim() : ""; }
function requiredId(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]) || optionalString(payload.id);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}
function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
function finiteNumber(value: JsonValue | undefined): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function automationKind(value: JsonValue | undefined): AutomationJobRecord["kind"] {
  return value === "memory_review" || value === "learning_evaluation" || value === "skill_curator" || value === "wiki_reindex" || value === "daily_digest" || value === "resource_translation" || value === "custom_instruction"
    ? value : "custom_instruction";
}
function isOneShotSchedule(schedule: string): boolean { return ["once", "one-shot", "oneshot"].includes(schedule.trim().toLowerCase()); }
function nextRunFromSchedule(schedule: string, fromMs = Date.now()): string {
  const normalized = schedule.trim().toLowerCase(); if (isOneShotSchedule(normalized)) return new Date(fromMs).toISOString();
  if (normalized.includes("weekly")) return new Date(fromMs + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (normalized.includes("hourly")) return new Date(fromMs + 60 * 60 * 1000).toISOString();
  const everyHours = normalized.match(/every\s+(\d+(?:\.\d+)?)\s+hours?/); if (everyHours) return new Date(fromMs + Number(everyHours[1]) * 60 * 60 * 1000).toISOString();
  return new Date(fromMs + 24 * 60 * 60 * 1000).toISOString();
}
function assertNever(value: never): never { throw new Error(`unsupported_automation_kind:${String(value)}`); }
