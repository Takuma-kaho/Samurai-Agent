import type { LearningEvaluationRecord, ResourceRef } from "@samurai-agent/core-schemas";

export interface RunQualitySignals {
  run_id: string;
  completed: number;
  tool_failure_rate: number;
  waiting_or_retry_rate: number;
  workspace_change_count: number;
  artifact_regeneration_count: number;
  correction_count: number;
}

function qualityScore(signal: RunQualitySignals): number {
  return signal.completed
    - signal.tool_failure_rate
    - signal.waiting_or_retry_rate * 0.5
    - signal.correction_count * 0.25
    - signal.artifact_regeneration_count * 0.1
    + Math.min(signal.workspace_change_count, 1) * 0.1;
}

export function evaluateLearningEffect(input: {
  id: string;
  resource_ref: ResourceRef;
  resource_version?: string;
  task_class: string;
  before: RunQualitySignals[];
  after: RunQualitySignals[];
  evidence_refs: ResourceRef[];
  evaluator?: string;
  created_at: string;
}): LearningEvaluationRecord {
  const mean = (items: RunQualitySignals[]) => items.length ? items.reduce((sum, item) => sum + qualityScore(item), 0) / items.length : 0;
  const beforeScore = mean(input.before);
  const afterScore = mean(input.after);
  const effect = afterScore - beforeScore;
  const evidenceCount = Math.min(input.before.length, input.after.length);
  const confidence = Math.min(1, evidenceCount / 5);
  const assessment = evidenceCount === 0
    ? "insufficient_evidence" as const
    : Math.abs(effect) < 0.05
      ? "neutral" as const
      : effect > 0 ? "helpful" as const : "harmful" as const;
  return {
    id: input.id,
    learning_resource_ref: input.resource_ref,
    learning_resource_version: input.resource_version,
    task_class: input.task_class,
    compared_run_ids: [...input.before, ...input.after].map((signal) => signal.run_id),
    before_metrics: { quality_score: beforeScore, run_count: input.before.length },
    after_metrics: { quality_score: afterScore, run_count: input.after.length },
    effect_estimate: effect,
    confidence,
    assessment,
    evidence_refs: input.evidence_refs,
    evaluator: input.evaluator ?? "deterministic-learning-evaluator",
    created_at: input.created_at
  };
}
