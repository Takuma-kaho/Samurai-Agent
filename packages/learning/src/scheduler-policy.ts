export const standardLearningJobDefinitions = [
  { id: "learning-background-review", title: "Background Review", kind: "memory_review" as const, schedule: "every 4 hours", target_instruction: "Review completed runs for reusable Memory and Skill changes." },
  { id: "learning-evaluation", title: "Learning Evaluation", kind: "learning_evaluation" as const, schedule: "daily", target_instruction: "Evaluate learning effects from actual resource use." },
  { id: "learning-curator", title: "Learning Curator", kind: "skill_curator" as const, schedule: "weekly", target_instruction: "Curate Memory and Skills using usage and evaluation evidence." }
];

export function learningRetryDelayMs(failureCount: number): number {
  const clamped = Math.max(1, Math.min(failureCount, 6));
  return 5 * 60_000 * 2 ** (clamped - 1);
}
