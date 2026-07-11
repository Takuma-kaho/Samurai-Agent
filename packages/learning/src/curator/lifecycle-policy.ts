import type { LearningEvaluationRecord } from "@samurai-agent/core-schemas";

export interface SkillLifecyclePolicyInput {
  state: string;
  owner_pinned: boolean;
  usage_count: number;
  last_activity_at?: string;
  now: string;
  stale_after_days: number;
  archive_after_days: number;
  evaluations: LearningEvaluationRecord[];
}

export type SkillLifecycleDecision = "keep" | "review" | "mark_stale" | "archive" | "reactivate" | "patch";

export function decideSkillLifecycle(input: SkillLifecyclePolicyInput): { decision: SkillLifecycleDecision; reason: string } {
  if (input.owner_pinned || input.state === "pinned") return { decision: "keep", reason: "owner_pinned" };
  const highConfidenceHelpful = input.evaluations.some((evaluation) => evaluation.assessment === "helpful" && evaluation.confidence >= 0.5);
  const highConfidenceHarmful = input.evaluations.some((evaluation) => evaluation.assessment === "harmful" && evaluation.confidence >= 0.5);
  if (highConfidenceHarmful) return { decision: "patch", reason: "harmful_evaluation_patch_first" };
  if (highConfidenceHelpful) return { decision: "keep", reason: "positive_effect_protected" };
  if (input.evaluations.length > 0 && input.evaluations.every((evaluation) => evaluation.assessment === "insufficient_evidence")) {
    return { decision: "keep", reason: "insufficient_evidence" };
  }
  const activity = input.last_activity_at ? Date.parse(input.last_activity_at) : Number.NaN;
  const ageDays = Number.isFinite(activity) ? (Date.parse(input.now) - activity) / 86_400_000 : Number.POSITIVE_INFINITY;
  if (input.state === "stale" && input.last_activity_at && ageDays < input.stale_after_days) return { decision: "reactivate", reason: "recent_use" };
  if (ageDays >= input.archive_after_days) return { decision: "archive", reason: "archive_threshold" };
  if (ageDays >= input.stale_after_days) return { decision: "mark_stale", reason: "stale_threshold" };
  if (input.state === "candidate" || input.state === "project") return { decision: "review", reason: "pre_active_review" };
  return { decision: "keep", reason: "current_and_supported" };
}
