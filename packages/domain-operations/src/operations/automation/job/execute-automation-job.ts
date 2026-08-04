import { createId, nowIso, type ActivityInboxItem, type AutomationJobRecord, type LearningEvaluationRecord, type MessageEnvelope, type OperationRecord, type ReflectionSuggestionRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";

type ScheduledContext = { source: "cron"; actor_identity: "owner_scheduled"; instruction_source: "scheduled_context"; channel: "cron"; session_key: string };
interface AutomationRunRecord { id: string; kind: string; source: string; session_id?: string; backend_run_id?: string; status: "started" | "completed" | "failed"; operation_id?: string; started_at: string; completed_at?: string; error?: string }

export interface AutomationJobExecutionPorts {
  getAutomationJob(id: string): Promise<AutomationJobRecord | undefined>;
  acquireAutomationJobLock(id: string, input: { lockedUntil: string; now: string }): Promise<AutomationJobRecord | undefined>;
  automationExecutionError(code: "not_found" | "conflict", message: string): Error;
  createAutomationRun(input: { id: string; kind: string; source: string; status: "started"; started_at: string }): Promise<AutomationRunRecord>;
  updateAutomationRun(record: AutomationRunRecord): Promise<AutomationRunRecord>;
  ensureScheduledAutomationSession(context: ScheduledContext, title: string, roomId?: string): Promise<SessionRecord>;
  createScheduledAutomationEnvelope(context: ScheduledContext, content: string): MessageEnvelope;
  runScheduledAutomationMutation(input: { session: SessionRecord; envelope: MessageEnvelope; context: ScheduledContext; operationName: string; inputRef?: ResourceRef; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: AutomationRunRecord; ref: ResourceRef; summary: string; rollbackPoint?: RollbackPoint }> }): Promise<{ resource: AutomationRunRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
  automationJobRef(job: AutomationJobRecord): ResourceRef;
  saveAutomationJobRecord(job: AutomationJobRecord): Promise<AutomationJobRecord>;
  reindexAutomationWiki(): Promise<{ active: number; total: number }>;
  runAutomationCurator(): Promise<{ suggestions: ReflectionSuggestionRecord[] }>;
  runAutomationMemoryReview(session: SessionRecord): Promise<{ suggestions: ReflectionSuggestionRecord[] }>;
  runAutomationEvaluation(): Promise<{ learningEvaluations?: LearningEvaluationRecord[] }>;
  runAutomationTranslation(job: AutomationJobRecord, session: SessionRecord, context: ScheduledContext): Promise<{ backendRunId: string; source_ref: ResourceRef; target_locale: string }>;
  runAutomationCollectionTrigger(job: AutomationJobRecord): Promise<string | undefined>;
  runAutomationInstruction(job: AutomationJobRecord, session: SessionRecord, context: ScheduledContext): Promise<{ backendRunId: string; summary: string }>;
  automationErrorMessage(error: unknown): string;
  automationRetryAt(failureCount: number): string;
}

export async function executeAutomationJob(ports: AutomationJobExecutionPorts, job: AutomationJobRecord, runStartedAt: string) {
  let automationRun = await ports.createAutomationRun({ id: createId("automationrun"), kind: job.kind, source: "automation_job", status: "started", started_at: runStartedAt });
  const context: ScheduledContext = { source: "cron", actor_identity: "owner_scheduled", instruction_source: "scheduled_context", channel: "cron", session_key: `cron:automation:${job.id}` };
  // Only translations read a persisted Room-bound source when they run later.
  // Existing non-translation automation retains its established execution path.
  const roomId = job.kind === "resource_translation" ? automationJobRoomId(job) : undefined;
  if (job.kind === "resource_translation" && !roomId) {
    throw ports.automationExecutionError("conflict", "automation_job_room_context_required");
  }
  const session = roomId
    ? await ports.ensureScheduledAutomationSession(context, job.title, roomId)
    : await ports.ensureScheduledAutomationSession(context, job.title);
  automationRun = await ports.updateAutomationRun({ ...automationRun, session_id: session.id });
  const envelope = ports.createScheduledAutomationEnvelope(context, job.target_instruction);
  try {
    const result = await ports.runScheduledAutomationMutation({ session, envelope, context, operationName: "automation.job.run", inputRef: ports.automationJobRef(job), proposedEffects: [`Run automation job ${job.title}.`], execute: async (operation) => {
      const outcome = await executeKind(ports, job, session, context);
      if (outcome.backendRunId) automationRun = { ...automationRun, backend_run_id: outcome.backendRunId };
      const ref: ResourceRef = { kind: "automation_run", id: automationRun.id, uri: `automation-runs/${automationRun.id}`, label: job.title };
      const resource = await ports.updateAutomationRun({ ...automationRun, status: "completed", operation_id: operation.id, completed_at: nowIso() });
      await ports.saveAutomationJobRecord({ ...job, status: isOneShot(job.schedule) ? "disabled" : job.status, last_run_at: nowIso(), next_run_at: isOneShot(job.schedule) ? undefined : nextRun(job.schedule), retry_after_at: undefined, locked_until: undefined, failure_count: 0, last_error: undefined, updated_at: nowIso() });
      return { resource, ref, summary: outcome.summary };
    }});
    return { ...result, automationRun: result.resource };
  } catch (error) {
    const failureCount = (job.failure_count ?? 0) + 1; const retryable = failureCount < (job.max_attempts ?? 3); const errorText = ports.automationErrorMessage(error);
    automationRun = await ports.updateAutomationRun({ ...automationRun, status: "failed", completed_at: nowIso(), error: errorText });
    await ports.saveAutomationJobRecord({ ...job, status: retryable ? "enabled" : "disabled", retry_after_at: retryable ? ports.automationRetryAt(failureCount) : undefined, locked_until: undefined, failure_count: failureCount, last_error: errorText, updated_at: nowIso() });
    throw error;
  }
}

async function executeKind(ports: AutomationJobExecutionPorts, job: AutomationJobRecord, session: SessionRecord, context: ScheduledContext): Promise<{ summary: string; backendRunId?: string }> {
  switch (job.kind) {
    case "wiki_reindex": { const value = await ports.reindexAutomationWiki(); return { summary: `Reindexed Knowledge Wiki pages: ${value.active}/${value.total} active.` }; }
    case "skill_curator": { const value = await ports.runAutomationCurator(); return { summary: `Skill curator evaluated ${value.suggestions.length} learning decision(s).` }; }
    case "memory_review": { const value = await ports.runAutomationMemoryReview(session); return { summary: `Background Review applied ${value.suggestions.length} learning change(s).` }; }
    case "learning_evaluation": { const value = await ports.runAutomationEvaluation(); return { summary: `Learning Evaluation stored ${value.learningEvaluations?.length ?? 0} effect record(s).` }; }
    case "resource_translation": { const value = await ports.runAutomationTranslation(job, session, context); return { backendRunId: value.backendRunId, summary: `Translated ${value.source_ref.kind}/${value.source_ref.id} to ${value.target_locale}.` }; }
    case "custom_instruction": { const summary = await ports.runAutomationCollectionTrigger(job); if (summary) return { summary }; const value = await ports.runAutomationInstruction(job, session, context); return { backendRunId: value.backendRunId, summary: value.summary }; }
    case "daily_digest": { const value = await ports.runAutomationInstruction(job, session, context); return { backendRunId: value.backendRunId, summary: value.summary }; }
  }
}

function isOneShot(schedule: string) { return ["once", "one-shot", "oneshot"].includes(schedule.trim().toLowerCase()); }
function nextRun(schedule: string, fromMs = Date.now()) { const value = schedule.trim().toLowerCase(); if (value.includes("weekly")) return new Date(fromMs + 7 * 86400000).toISOString(); if (value.includes("hourly")) return new Date(fromMs + 3600000).toISOString(); const match = value.match(/every\s+(\d+(?:\.\d+)?)\s+hours?/); return new Date(fromMs + (match ? Number(match[1]) * 3600000 : 86400000)).toISOString(); }

function automationJobRoomId(job: AutomationJobRecord): string | undefined {
  const roomId = job.delivery_target.room_id;
  return typeof roomId === "string" && roomId.trim() ? roomId : undefined;
}
