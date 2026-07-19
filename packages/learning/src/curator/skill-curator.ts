import type { LearningEvaluationRecord } from "@samurai-agent/core-schemas";
import { decideSkillLifecycle, type SkillLifecycleDecision } from "./lifecycle-policy";

export interface SkillCuratorResource {
  id: string;
  state: string;
  owner_pinned: boolean;
  usage_count: number;
  last_activity_at?: string;
  evaluations: LearningEvaluationRecord[];
}

export function curateSkills(resources: SkillCuratorResource[], policy: { now: string; stale_after_days: number; archive_after_days: number }): Array<{ skill_id: string; decision: SkillLifecycleDecision; reason: string }> {
  return resources.map((resource) => ({
    skill_id: resource.id,
    ...decideSkillLifecycle({
      state: resource.state,
      owner_pinned: resource.owner_pinned,
      usage_count: resource.usage_count,
      last_activity_at: resource.last_activity_at,
      now: policy.now,
      stale_after_days: policy.stale_after_days,
      archive_after_days: policy.archive_after_days,
      evaluations: resource.evaluations
    })
  }));
}
