/**
 * Core 05 deliberately creates no fixed learning schedule. Existing Automation
 * invokes a Review only when an idle Room has a queued candidate.
 */
export const standardLearningJobDefinitions = [] as const;

export function learningRetryDelayMs(failureCount: number): number {
  const clamped = Math.max(1, Math.min(failureCount, 6));
  return 5 * 60_000 * 2 ** (clamped - 1);
}
