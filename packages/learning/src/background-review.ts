import type {
  ActivityContextRef,
  ArtifactRecord,
  BackendEventRecord,
  BackendRunRecord,
  LearningResourceUseRecord,
  MessageRecord,
  ResourceRef,
  ToolRunRecord,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import { ResourceRefSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";

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
  /** The Room, Session, and Agent that produced this review input. */
  activity_context?: ActivityContextRef;
  messages: MessageRecord[];
  artifacts: Array<{ record: ArtifactRecord; content?: string }>;
  backend_run?: BackendRunRecord;
  backend_events: BackendEventRecord[];
  tool_runs: ToolRunRecord[];
  workspace_changes: WorkspaceChangeRecord[];
  used_learning_resources: LearningResourceUseRecord[];
  existing_memory_catalog: LearningCatalogEntry[];
  existing_skill_catalog: LearningCatalogEntry[];
  existing_wiki_catalog: LearningCatalogEntry[];
  used_wiki_fragments: Array<{ id: string; version?: string; purpose?: string; section_ref?: string; content: string }>;
}

export type BackgroundReviewMutation =
  | { kind: "memory_add"; topic: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "memory_replace"; resource_id: string; expected_version?: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "memory_remove"; resource_id: string; expected_version?: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "skill_create"; title: string; description: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "skill_patch"; resource_id: string; expected_version?: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "skill_support_write"; resource_id: string; expected_version?: string; path: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "wiki_create"; title: string; slug: string; content: string; tags: string[]; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "wiki_patch"; resource_id: string; expected_version: string; content: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "wiki_archive"; resource_id: string; expected_version: string; reason: string; evidence_refs: ResourceRef[] }
  | { kind: "wiki_merge"; target_resource_id: string; source_resource_ids: string[]; expected_versions: Record<string,string>; content: string; reason: string; evidence_refs: ResourceRef[] };

const evidence = z.array(ResourceRefSchema).min(1);
export const BackgroundReviewMutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory_add"), topic: z.string().min(1), content: z.string().min(1), reason: z.string().min(1), evidence_refs: evidence }).strict(),
  z.object({ kind: z.literal("memory_replace"), resource_id: z.string().min(1), expected_version: z.string().min(1).optional(), content: z.string().min(1), reason: z.string().min(1), evidence_refs: evidence }).strict(),
  z.object({ kind: z.literal("memory_remove"), resource_id: z.string().min(1), expected_version: z.string().min(1).optional(), reason: z.string().min(1), evidence_refs: evidence }).strict(),
  z.object({ kind: z.literal("skill_create"), title: z.string().min(1), description: z.string().min(1), content: z.string().min(1), reason: z.string().min(1), evidence_refs: evidence }).strict(),
  z.object({ kind: z.literal("skill_patch"), resource_id: z.string().min(1), expected_version: z.string().min(1).optional(), content: z.string().min(1), reason: z.string().min(1), evidence_refs: evidence }).strict(),
  z.object({ kind: z.literal("skill_support_write"), resource_id: z.string().min(1), expected_version: z.string().min(1).optional(), path: z.string().min(1).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/), content: z.string().min(1), reason: z.string().min(1), evidence_refs: evidence }).strict()
  ,z.object({ kind:z.literal("wiki_create"),title:z.string().min(1),slug:z.string().regex(/^[a-z0-9][a-z0-9-]*$/),content:z.string().min(1),tags:z.array(z.string()),reason:z.string().min(1),evidence_refs:evidence }).strict()
  ,z.object({ kind:z.literal("wiki_patch"),resource_id:z.string().min(1),expected_version:z.string().min(1),content:z.string().min(1),reason:z.string().min(1),evidence_refs:evidence }).strict()
  ,z.object({ kind:z.literal("wiki_archive"),resource_id:z.string().min(1),expected_version:z.string().min(1),reason:z.string().min(1),evidence_refs:evidence }).strict()
  ,z.object({ kind:z.literal("wiki_merge"),target_resource_id:z.string().min(1),source_resource_ids:z.array(z.string().min(1)).min(1),expected_versions:z.record(z.string().min(1)),content:z.string().min(1),reason:z.string().min(1),evidence_refs:evidence }).strict()
]);
export const BackgroundReviewResultSchema = z.object({ reviewer: z.string().min(1), summary: z.string(), mutations: z.array(BackgroundReviewMutationSchema).max(100) }).strict();

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
  run(snapshot: ReviewSnapshot, policy: BackgroundReviewPolicy, signal?: AbortSignal): Promise<BackgroundReviewResult>;
}

export const defaultBackgroundReviewPolicy: BackgroundReviewPolicy = {
  max_iterations: 4,
  allowed_mutations: ["memory_add", "memory_replace", "memory_remove", "skill_create", "skill_patch", "skill_support_write", "wiki_create", "wiki_patch", "wiki_archive", "wiki_merge"]
};

export function restrictBackgroundReviewResult(result: BackgroundReviewResult, policy: BackgroundReviewPolicy): BackgroundReviewResult {
  const allowed = new Set(policy.allowed_mutations);
  return { ...result, mutations: result.mutations.filter((mutation) => allowed.has(mutation.kind)) };
}

export function backgroundReviewPrompt(snapshot: ReviewSnapshot, policy: BackgroundReviewPolicy): string {
  return [
    "Review the completed work as a separate learning run.",
    "Decide whether to update reusable Memory, Knowledge Wiki, or Skill resources. Doing nothing is valid.",
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
  return BackgroundReviewResultSchema.parse(JSON.parse(candidate)) as BackgroundReviewResult;
}
