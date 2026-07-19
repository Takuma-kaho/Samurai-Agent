import {
  SkillOptimizationDatasetSchema,
  SkillOptimizationExampleSchema,
  createId,
  nowIso,
  stableHash,
  type ResourceRef,
  type SkillOptimizationDataset,
  type SkillOptimizationExample
} from "@samurai-agent/core-schemas";

export interface OptimizationExampleInput {
  id?: string;
  prompt: string;
  expected_behavior: string;
  feedback: string;
  source: "real" | "golden" | "synthetic";
  skill_body_read_run_id?: string;
  trace_refs?: ResourceRef[];
  metadata?: Record<string, unknown>;
}

export function buildSkillOptimizationDataset(input: {
  id?: string;
  skill_id: string;
  real: OptimizationExampleInput[];
  golden: OptimizationExampleInput[];
  synthetic?: OptimizationExampleInput[];
  created_at?: string;
}): SkillOptimizationDataset {
  const now = input.created_at ?? nowIso();
  const candidates = [...input.real, ...input.golden, ...(input.synthetic ?? [])]
    .map((example, index) => SkillOptimizationExampleSchema.parse({
      id: example.id ?? `${input.skill_id}_example_${index + 1}`,
      skill_id: input.skill_id,
      prompt: example.prompt.trim(),
      expected_behavior: example.expected_behavior.trim(),
      feedback: example.feedback.trim(),
      source: example.source,
      split: "train",
      ...(example.skill_body_read_run_id ? { skill_body_read_run_id: example.skill_body_read_run_id } : {}),
      trace_refs: example.trace_refs ?? [],
      metadata: jsonRecord(example.metadata ?? {}),
      created_at: now
    }))
    .filter((example, index, all) => all.findIndex((item) => item.prompt === example.prompt) === index)
    .sort((left, right) => stableHash(left.id).localeCompare(stableHash(right.id)));

  if (candidates.filter((example) => example.source !== "synthetic").length < 4) {
    throw new Error("skill_optimization_dataset_needs_four_real_or_golden_examples");
  }
  if (candidates.length < 20) {
    throw new Error("skill_optimization_dataset_needs_twenty_examples");
  }

  const selected = candidates.slice(0, 20);
  const nonSynthetic = selected.filter((example) => example.source !== "synthetic");
  if (nonSynthetic.length < 4) {
    throw new Error("skill_optimization_holdout_cannot_be_synthetic_only");
  }
  const holdoutAnchor = nonSynthetic[0]!;
  const remaining = selected.filter((example) => example.id !== holdoutAnchor.id);
  const splitExamples: SkillOptimizationExample[] = [
    ...remaining.slice(0, 12).map((example) => ({ ...example, split: "train" as const })),
    ...remaining.slice(12, 16).map((example) => ({ ...example, split: "validation" as const })),
    { ...holdoutAnchor, split: "holdout" as const },
    ...remaining.slice(16, 19).map((example) => ({ ...example, split: "holdout" as const }))
  ];
  if (splitExamples.length !== 20) {
    throw new Error("skill_optimization_dataset_split_failed");
  }
  return SkillOptimizationDatasetSchema.parse({
    id: input.id ?? createId("skill_dataset"),
    skill_id: input.skill_id,
    examples: splitExamples,
    split_counts: { train: 12, validation: 4, holdout: 4 },
    holdout_non_synthetic_count: splitExamples.filter((example) => example.split === "holdout" && example.source !== "synthetic").length,
    created_at: now
  });
}

function jsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
}

function jsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return jsonRecord(value as Record<string, unknown>);
  return String(value ?? "");
}
