import type { OptimizationCandidate } from "@samurai-agent/core-schemas";

export interface OptimizationGateInput {
  baseline_holdout_score: number;
  holdout_score: number;
  related_tests_passed: boolean;
  safety_checks_passed: boolean;
  important_regression: boolean;
}

export interface OptimizationGateResult {
  holdout_delta: number;
  improvement_passed: boolean;
  passed: boolean;
  status: OptimizationCandidate["status"];
  reason: string;
}

export function evaluateOptimizationGates(input: OptimizationGateInput): OptimizationGateResult {
  const holdout_delta = input.holdout_score - input.baseline_holdout_score;
  const improvement_passed = holdout_delta >= 5;
  const passed = input.related_tests_passed && input.safety_checks_passed && !input.important_regression && improvement_passed;
  return {
    holdout_delta,
    improvement_passed,
    passed,
    status: passed ? "passed" : "rejected",
    reason: passed
      ? "All related tests and safety checks passed, holdout improved by at least five points, and no important regression was found."
      : [
          !input.related_tests_passed ? "related_tests_failed" : "",
          !input.safety_checks_passed ? "safety_checks_failed" : "",
          input.important_regression ? "important_regression" : "",
          !improvement_passed ? "holdout_improvement_below_five" : ""
        ].filter(Boolean).join(",")
  };
}
