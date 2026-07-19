import { describe, expect, it } from "vitest";
import { buildSkillOptimizationDataset } from "./dataset";
import { evaluateOptimizationGates } from "./gates";
import { evaluateSkillOptimizationSafety } from "./safety";

describe("Skill improvement contracts", () => {
  it("keeps a non-synthetic holdout in the 20-example split", () => {
    const dataset = buildSkillOptimizationDataset({
      skill_id: "skill_demo",
      real: Array.from({ length: 8 }, (_, index) => ({
        prompt: `実利用 ${index}`,
        expected_behavior: `期待結果 ${index}`,
        feedback: "実行traceから作成",
        source: "real" as const,
        skill_body_read_run_id: `run_${index}`
      })),
      golden: Array.from({ length: 4 }, (_, index) => ({
        prompt: `golden ${index}`,
        expected_behavior: `golden result ${index}`,
        feedback: "手動golden",
        source: "golden" as const,
        skill_body_read_run_id: `golden_run_${index}`
      })),
      synthetic: Array.from({ length: 12 }, (_, index) => ({
        prompt: `synthetic ${index}`,
        expected_behavior: `synthetic result ${index}`,
        feedback: "補助例",
        source: "synthetic" as const
      }))
    });
    expect(dataset.examples).toHaveLength(20);
    expect(dataset.split_counts).toEqual({ train: 12, validation: 4, holdout: 4 });
    expect(dataset.holdout_non_synthetic_count).toBeGreaterThan(0);
  });

  it("requires the fixed improvement gate", () => {
    expect(evaluateOptimizationGates({
      baseline_holdout_score: 60,
      holdout_score: 65,
      related_tests_passed: true,
      safety_checks_passed: true,
      important_regression: false
    }).passed).toBe(true);
    expect(evaluateOptimizationGates({
      baseline_holdout_score: 60,
      holdout_score: 64.9,
      related_tests_passed: true,
      safety_checks_passed: true,
      important_regression: false
    }).passed).toBe(false);
  });

  it("rejects secret-like candidate content", () => {
    expect(evaluateSkillOptimizationSafety("Use the workflow.").passed).toBe(true);
    expect(evaluateSkillOptimizationSafety("api_key=sk-1234567890123456").passed).toBe(false);
  });
});
