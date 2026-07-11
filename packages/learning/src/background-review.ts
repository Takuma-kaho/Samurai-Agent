import type {
  ArtifactRecord,
  BackendEventRecord,
  BackendRunRecord,
  LearningResourceUseRecord,
  MessageRecord,
  ResourceRef,
  ToolRunRecord,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";

export interface LearningCatalogEntry {
  id: string;
  title: string;
  state: string;
  version?: string;
  summary?: string;
}

export interface ReviewSnapshot {
  source_session_id: string;
  source_run_id: string;
  messages: MessageRecord[];
  artifacts: Array<{ record: ArtifactRecord; content?: string }>;
  backend_run?: BackendRunRecord;
  backend_events: BackendEventRecord[];
  tool_runs: ToolRunRecord[];
  workspace_changes: WorkspaceChangeRecord[];
  used_learning_resources: LearningResourceUseRecord[];
  existing_memory_catalog: LearningCatalogEntry[];
  existing_skill_catalog: LearningCatalogEntry[];
}

export type BackgroundReviewMutation =
  | { kind: "memory_add"; topic: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "memory_replace"; resource_id: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "memory_remove"; resource_id: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "skill_create"; title: string; description: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "skill_patch"; resource_id: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "skill_support_write"; resource_id: string; path: string; content: string; reason: string; evidence_refs: ResourceRef[] };

export interface BackgroundReviewPolicy {
  max_iterations: number;
  allowed_mutations: BackgroundReviewMutation["kind"][];
}

export interface BackgroundReviewResult {
  reviewer: string;
  summary: string;
  mutations: BackgroundReviewMutation[];
}

export interface BackgroundReviewRunner {
  run(snapshot: ReviewSnapshot, policy: BackgroundReviewPolicy): Promise<BackgroundReviewResult>;
}

export const defaultBackgroundReviewPolicy: BackgroundReviewPolicy = {
  max_iterations: 4,
  allowed_mutations: ["memory_add", "memory_replace", "memory_remove", "skill_create", "skill_patch", "skill_support_write"]
};

export function restrictBackgroundReviewResult(result: BackgroundReviewResult, policy: BackgroundReviewPolicy): BackgroundReviewResult {
  const allowed = new Set(policy.allowed_mutations);
  return { ...result, mutations: result.mutations.filter((mutation) => allowed.has(mutation.kind)) };
}

export function backgroundReviewPrompt(snapshot: ReviewSnapshot, policy: BackgroundReviewPolicy): string {
  return [
    "Review the completed work as a separate learning run.",
    "Decide whether to update reusable Memory or Skill resources. Doing nothing is valid.",
    "Memory is short durable user context. Skill is a reusable class-level procedure, not a one-off incident.",
    "Do not create Artifacts, Collections, general files, external sends, or messages in the source Session.",
    `Allowed mutations: ${policy.allowed_mutations.join(", ")}`,
    "Return JSON only: { reviewer, summary, mutations }.",
    JSON.stringify(snapshot)
  ].join("\n\n");
}

export function parseBackgroundReviewResult(text: string): BackgroundReviewResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(candidate) as Partial<BackgroundReviewResult>;
  return {
    reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : "background-review",
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    mutations: Array.isArray(parsed.mutations) ? parsed.mutations as BackgroundReviewMutation[] : []
  };
}
