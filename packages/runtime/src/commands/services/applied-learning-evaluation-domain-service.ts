import {
  createId,
  nowIso,
  type ActivityContextRef,
  type BackendRunRecord,
  type EvaluationTraceReport,
  type LearningEvaluationRecord,
  type LearningJobReportRecord,
  type LearningResourceUseRecord,
  type ReflectionRunRecord,
  type ReflectionSuggestionRecord,
  type ResourceRef,
  type ToolRunRecord
} from "@samurai-agent/core-schemas";

type LearningResourceKind = "memory" | "wiki" | "skill";
type EvaluationVerdict = "supported" | "refuted" | "indeterminate";

interface EvaluableResource {
  ref: ResourceRef;
  current_version?: string;
  predicted_result?: string;
}

export interface AppliedLearningEvaluationDomainServiceDependencies {
  isLearningEnabled(): Promise<boolean>;
  listUses(input?: { runId?: string; sessionId?: string }): Promise<LearningResourceUseRecord[]>;
  listEvaluations(input?: { activityContext?: ActivityContextRef }): Promise<LearningEvaluationRecord[]>;
  getRun(id: string): Promise<BackendRunRecord | undefined>;
  /** Re-checks the Agent and requester before any post-run evidence is read. */
  assertRunAccess(run: BackendRunRecord): Promise<void>;
  assertResourceAccess(input: {
    run: BackendRunRecord;
    resourceKind: LearningResourceKind;
    resourceId: string;
    activityContext: ActivityContextRef;
    action: "read" | "edit";
  }): Promise<void>;
  listToolRuns(input: { runId: string }): Promise<ToolRunRecord[]>;
  listMessages(sessionId: string): Promise<Array<{ id: string; role: "user" | "agent" | "system"; content: string; created_at: string }>>;
  getResource(input: { resourceKind: LearningResourceKind; resourceId: string }): Promise<EvaluableResource | undefined>;
  markRefuted(input: {
    run: BackendRunRecord;
    resourceKind: LearningResourceKind;
    resourceId: string;
    expectedVersion: string;
    activityContext: ActivityContextRef;
    sourceRunId: string;
    reason: string;
    evidenceRefs: ResourceRef[];
  }): Promise<ResourceRef | undefined>;
  createReflectionRun(record: ReflectionRunRecord): Promise<ReflectionRunRecord>;
  updateReflectionRun(record: ReflectionRunRecord): Promise<ReflectionRunRecord>;
  saveEvaluation(record: LearningEvaluationRecord): Promise<LearningEvaluationRecord>;
  saveSuggestion(record: ReflectionSuggestionRecord): Promise<ReflectionSuggestionRecord>;
  saveJobReport(record: LearningJobReportRecord): Promise<LearningJobReportRecord>;
}

/**
 * Evaluates only exact `applied` records. It deliberately has no baseline or
 * quality-score comparison path: an outcome can support a prediction without
 * proving the Resource caused it.
 */
export class AppliedLearningEvaluationDomainService {
  constructor(private readonly dependencies: AppliedLearningEvaluationDomainServiceDependencies) {}

  async run(input: { sourceRunId?: string; sessionId?: string } = {}): Promise<{
    reflectionRun: ReflectionRunRecord;
    suggestions: ReflectionSuggestionRecord[];
    evaluationReport: EvaluationTraceReport;
    learningEvaluations: LearningEvaluationRecord[];
  }> {
    const now = nowIso();
    // A scheduled Workspace-wide evaluation has no Room principal. It must
    // not turn into a hidden scan of every Room; per-Run evaluation still
    // arrives here with its concrete source Run or Session.
    if (!input.sourceRunId && !input.sessionId) {
      const reflectionRun: ReflectionRunRecord = {
        id: createId("reflection"),
        kind: "evaluation",
        status: "completed",
        input_summary: "Skipped Evaluation: no Room-scoped Run or Session was supplied.",
        output_summary: "No Evaluation ran because a Room context is required.",
        started_at: now,
        completed_at: now
      };
      return {
        reflectionRun,
        suggestions: [],
        evaluationReport: appliedEvaluationReport(now, [], [], 0),
        learningEvaluations: []
      };
    }
    if (!await this.dependencies.isLearningEnabled()) {
      const reflectionRun: ReflectionRunRecord = {
        id: createId("reflection"),
        kind: "evaluation",
        status: "completed",
        input_summary: "Skipped Evaluation: Learning is disabled.",
        output_summary: "Learning is disabled; no Evaluation was created.",
        started_at: now,
        completed_at: now
      };
      return {
        reflectionRun,
        suggestions: [],
        evaluationReport: appliedEvaluationReport(now, [], [], 0),
        learningEvaluations: []
      };
    }
    const useFilter = input.sourceRunId ? { runId: input.sourceRunId } : input.sessionId ? { sessionId: input.sessionId } : {};
    const applied = (await this.dependencies.listUses(useFilter))
      .filter((use): use is LearningResourceUseRecord & {
        resource_kind: LearningResourceKind;
        resource_version: string;
        content_hash: string;
        activity_context: ActivityContextRef;
        decision_summary: string;
        matched_conditions: string[];
      } => use.stage === "applied"
        && (use.resource_kind === "memory" || use.resource_kind === "wiki" || use.resource_kind === "skill")
        && Boolean(use.resource_version && use.content_hash && use.activity_context && use.decision_summary && use.matched_conditions?.length));
    const existingByActivity = new Map<string, LearningEvaluationRecord[]>();
    const existingFor = async (activityContext: ActivityContextRef) => {
      const key = `${activityContext.room_id}:${activityContext.session_id}:${activityContext.agent_id}`;
      const cached = existingByActivity.get(key);
      if (cached) return cached;
      const records = await this.dependencies.listEvaluations({ activityContext });
      existingByActivity.set(key, records);
      return records;
    };
    const pending = (await Promise.all(applied.map(async (use) => {
      const existing = await existingFor(use.activity_context);
      return existing.some((evaluation) =>
        evaluation.evaluation_kind === "applied"
        && evaluation.applied_run_id === use.run_id
        && evaluation.learning_resource_ref.id === use.resource_id
        && evaluation.learning_resource_version === use.resource_version
      ) ? undefined : use;
    }))).filter((use): use is typeof applied[number] => Boolean(use));
    if (pending.length === 0) {
      const reflectionRun: ReflectionRunRecord = {
        id: createId("reflection"),
        kind: "evaluation",
        status: "completed",
        input_summary: "Skipped Evaluation: no exact applied Learning Resource requires evaluation.",
        output_summary: "No Evaluation ran because no new applied Resource Version was recorded.",
        started_at: now,
        completed_at: now
      };
      return {
        reflectionRun,
        suggestions: [],
        evaluationReport: appliedEvaluationReport(now, [], [], 0),
        learningEvaluations: []
      };
    }
    let reflectionRun = await this.dependencies.createReflectionRun({
      id: createId("reflection"),
      kind: "evaluation",
      ...(pending[0]?.session_id ? { session_id: pending[0].session_id } : {}),
      ...(pending[0]?.activity_context ? { activity_context: pending[0].activity_context } : {}),
      status: "started",
      input_summary: `Evaluate ${pending.length} exact applied Learning resource record(s).`,
      started_at: now
    });
    const suggestions: ReflectionSuggestionRecord[] = [];
    const learningEvaluations: LearningEvaluationRecord[] = [];
    let toolRunCount = 0;
    for (const use of pending) {
      const run = await this.dependencies.getRun(use.run_id);
      if (!run) continue;
      if (run.session_id !== use.activity_context.session_id) continue;
      await this.dependencies.assertRunAccess(run);
      await this.dependencies.assertResourceAccess({
        run,
        resourceKind: use.resource_kind,
        resourceId: use.resource_id,
        activityContext: use.activity_context,
        action: "read"
      });
      const [resource, toolRuns, messages] = await Promise.all([
        this.dependencies.getResource({ resourceKind: use.resource_kind, resourceId: use.resource_id }),
        this.dependencies.listToolRuns({ runId: run.id }),
        this.dependencies.listMessages(run.session_id)
      ]);
      toolRunCount += toolRuns.length;
      const outcome = outcomeForAppliedUse({ run, toolRuns, messages });
      const ref = resource?.ref ?? {
        kind: use.resource_kind,
        id: use.resource_id,
        uri: `learning-history/${use.resource_kind}/${encodeURIComponent(use.resource_id)}/${encodeURIComponent(use.resource_version)}.md`,
        version: use.resource_version
      };
      const prediction = resource?.current_version === use.resource_version && resource.predicted_result
        ? resource.predicted_result
        : `The applied Resource supports: ${use.decision_summary}`;
      const evaluation: LearningEvaluationRecord = {
        id: createId("learning_evaluation"),
        learning_resource_ref: { ...ref, version: use.resource_version },
        learning_resource_version: use.resource_version,
        task_class: run.backend_kind,
        compared_run_ids: [run.id],
        before_metrics: { unrelated_baseline_runs: 0 },
        after_metrics: { objective_outcome: outcome.verdict === "supported" ? 1 : outcome.verdict === "refuted" ? -1 : 0 },
        effect_estimate: 0,
        confidence: outcome.confidence,
        assessment: outcome.verdict === "supported" ? "helpful" : outcome.verdict === "refuted" ? "harmful" : "insufficient_evidence",
        evaluation_kind: "applied",
        applied_run_id: run.id,
        activity_context: use.activity_context,
        matched_conditions: use.matched_conditions,
        affected_decision: use.decision_summary,
        predicted_result: prediction,
        actual_result: outcome.actual_result,
        prediction_assessment: outcome.verdict,
        causal_assessment: "indeterminate",
        evidence_refs: [ref, ...outcome.evidence_refs],
        evaluator: "applied-learning-evaluator",
        created_at: nowIso()
      };
      await this.dependencies.saveEvaluation(evaluation);
      learningEvaluations.push(evaluation);
      if (outcome.verdict === "refuted") {
        await this.dependencies.assertResourceAccess({
          run,
          resourceKind: use.resource_kind,
          resourceId: use.resource_id,
          activityContext: use.activity_context,
          action: "edit"
        });
        const limitedRef = await this.dependencies.markRefuted({
          run,
          resourceKind: use.resource_kind,
          resourceId: use.resource_id,
          expectedVersion: use.resource_version,
          activityContext: use.activity_context,
          sourceRunId: run.id,
          reason: outcome.actual_result,
          evidenceRefs: outcome.evidence_refs
        });
        const suggestion: ReflectionSuggestionRecord = {
          id: createId("reflection_suggestion"),
          reflection_run_id: reflectionRun.id,
          suggestion_type: "conflict",
          status: limitedRef ? "applied" : "proposed",
          title: `Limited after refutation: ${ref.label ?? ref.id}`,
          content: outcome.actual_result,
          ...(limitedRef ? { target_ref: limitedRef } : { target_ref: ref }),
          source_refs: outcome.evidence_refs,
          confidence: outcome.confidence,
          created_at: nowIso(),
          updated_at: nowIso()
        };
        await this.dependencies.saveSuggestion(suggestion);
        suggestions.push(suggestion);
      }
    }
    const report = appliedEvaluationReport(now, pending, learningEvaluations, toolRunCount);
    reflectionRun = await this.dependencies.updateReflectionRun({
      ...reflectionRun,
      status: "completed",
      output_summary: `Applied-resource Evaluation recorded ${learningEvaluations.length} outcome(s); no unrelated Run comparison was used.`,
      completed_at: nowIso()
    });
    const completedAt = reflectionRun.completed_at ?? nowIso();
    await this.dependencies.saveJobReport({
      id: createId("learning_job_report"),
      job_kind: "evaluation",
      run_id: reflectionRun.id,
      target_resource_count: pending.length,
      mutation_count: suggestions.filter((suggestion) => suggestion.status === "applied").length,
      archive_count: 0,
      restore_count: 0,
      patch_count: suggestions.filter((suggestion) => suggestion.status === "applied").length,
      merge_count: 0,
      skipped_reasons: learningEvaluations.length ? {} : { no_applied_resource_with_outcome: 1 },
      evaluation_count: learningEvaluations.length,
      duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(now)),
      created_at: nowIso()
    });
    return { reflectionRun, suggestions, evaluationReport: report, learningEvaluations };
  }
}

function outcomeForAppliedUse(input: {
  run: BackendRunRecord;
  toolRuns: ToolRunRecord[];
  messages: Array<{ id: string; role: "user" | "agent" | "system"; content: string; created_at: string }>;
}): { verdict: EvaluationVerdict; actual_result: string; confidence: number; evidence_refs: ResourceRef[] } {
  const laterCorrection = input.messages.find((message) =>
    message.role === "user"
    && Date.parse(message.created_at) > Date.parse(input.run.completed_at ?? input.run.started_at)
    && /(?:訂正|違う|誤り|修正して|修正してください|間違い|not correct|incorrect|wrong)/i.test(message.content)
  );
  if (laterCorrection) {
    return {
      verdict: "refuted",
      actual_result: "A later user correction contradicted the applied decision.",
      confidence: 0.95,
      evidence_refs: [{ kind: "message", id: laterCorrection.id, uri: `workspace://sessions/${input.run.session_id}/messages/${laterCorrection.id}` }]
    };
  }
  const objective = input.toolRuns.filter((tool) => /(?:test|verify|build|check|lint)/i.test(`${tool.action_id} ${tool.provider_tool_name}`));
  const failed = objective.filter((tool) => tool.status === "failed");
  if (failed.length) {
    return {
      verdict: "refuted",
      actual_result: "An objective test or execution result failed after the Resource was applied.",
      confidence: 0.8,
      evidence_refs: failed.map(toolRef)
    };
  }
  const succeeded = objective.filter((tool) => tool.status === "completed");
  if (succeeded.length) {
    return {
      verdict: "supported",
      actual_result: "An objective test or execution result completed successfully.",
      confidence: 0.75,
      evidence_refs: succeeded.map(toolRef)
    };
  }
  return {
    verdict: "indeterminate",
    actual_result: "No objective result or explicit user feedback established the prediction.",
    confidence: 0.2,
    evidence_refs: []
  };
}

function toolRef(tool: ToolRunRecord): ResourceRef {
  return { kind: "tool_run", id: tool.id, uri: `workspace://tool-runs/${tool.id}`, label: tool.action_id };
}

function appliedEvaluationReport(
  now: string,
  pending: LearningResourceUseRecord[],
  evaluations: LearningEvaluationRecord[],
  toolRunCount: number
): EvaluationTraceReport {
  return {
    id: `applied_evaluation_${now.replace(/[^0-9A-Za-z]/g, "")}`,
    checked_at: now,
    judge: {
      deterministic_status: "completed",
      external_status: "not_configured",
      summary: "Only exact applied Resource records were evaluated; unrelated Run comparisons were not used."
    },
    counts: {
      backend_runs: new Set(pending.map((use) => use.run_id)).size,
      backend_events: 0,
      workspace_changes: 0,
      tool_runs: toolRunCount,
      audit_records: 0,
      findings: evaluations.filter((evaluation) => evaluation.prediction_assessment === "refuted").length,
      comparisons: 0
    },
    run_scores: [],
    comparisons: []
  };
}
