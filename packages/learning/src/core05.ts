import type {
  ActivityContextRef,
  BackendEventRecord,
  LearningBackgroundReviewMutationPlan,
  LearningBackgroundReviewMutation,
  BackendRunRecord,
  LearningCandidateSignal,
  LearningEvidenceState,
  LearningResourceUseRecord,
  LearningUsageState,
  MessageRecord,
  ResourceRef,
  ToolRunRecord,
  UsageScopeRef,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import {
  LearningBackgroundReviewMutationPlanSchema,
  LearningBackgroundReviewMutationSchema,
  LearningCandidateSignalSchema
} from "@samurai-agent/core-schemas";

export interface Core05EvidenceBundle {
  backend_run: BackendRunRecord;
  activity_context: ActivityContextRef;
  input_message: MessageRecord;
  output_message?: MessageRecord;
  backend_events: BackendEventRecord[];
  tool_runs: ToolRunRecord[];
  workspace_changes: WorkspaceChangeRecord[];
  used_learning_resources: LearningResourceUseRecord[];
}

export interface Core05ResourceCatalogEntry {
  id: string;
  title: string;
  version?: string;
  evidence_state?: LearningEvidenceState;
  usage_state?: LearningUsageState;
  usage_scope?: UsageScopeRef;
  summary?: string;
}

/** The review sees only the source Room's catalog and evidence, never another Room's body. */
export interface Core05ReviewSnapshot {
  evidence: Core05EvidenceBundle;
  /** Additional unprocessed evidence from the same idle Room, never another Room. */
  pending_room_evidence: Core05EvidenceBundle[];
  memory_catalog: Core05ResourceCatalogEntry[];
  knowledge_catalog: Core05ResourceCatalogEntry[];
  skill_catalog: Core05ResourceCatalogEntry[];
  applied_resources: LearningResourceUseRecord[];
}

/** Re-export the shared Domain contract; it intentionally has no delete, archive, merge, or Scope expansion. */
export const Core05BackgroundReviewMutationSchema = LearningBackgroundReviewMutationSchema;
export type Core05BackgroundReviewMutation = LearningBackgroundReviewMutation;
export const Core05BackgroundReviewResultSchema = LearningBackgroundReviewMutationPlanSchema;
export type Core05BackgroundReviewResult = LearningBackgroundReviewMutationPlan;

export interface Core05BackgroundReviewRunner {
  run(snapshot: Core05ReviewSnapshot, signal?: AbortSignal): Promise<Core05BackgroundReviewResult>;
}

/**
 * Narrow Learning-layer orchestration: it owns model-output restriction while
 * Runtime owns evidence collection and invokes the write Domain Operation.
 */
export class Core05BackgroundReviewOrchestrator {
  constructor(private readonly runner: Core05BackgroundReviewRunner) {}

  async createMutationPlan(input: {
    snapshot: Core05ReviewSnapshot;
    activityContext: ActivityContextRef;
    hasExplicitRuleInstruction: boolean;
    hasExplicitMemoryInstruction: boolean;
    signal?: AbortSignal;
  }): Promise<Core05BackgroundReviewResult> {
    const result = await this.runner.run(input.snapshot, input.signal);
    return restrictCore05BackgroundReviewResult({
      result,
      snapshot: input.snapshot,
      activityContext: input.activityContext,
      hasExplicitRuleInstruction: input.hasExplicitRuleInstruction,
      hasExplicitMemoryInstruction: input.hasExplicitMemoryInstruction
    });
  }
}

export function core05BackgroundReviewPrompt(snapshot: Core05ReviewSnapshot): string {
  return [
    "Review confirmed evidence from one Room only.",
    "Doing nothing is valid. Return JSON only.",
    "Allowed mutations: memory_create, experience_rule_create, skill_candidate_create, resource_evidence_append, resource_replacement_candidate, skill_patch_candidate.",
    "Never delete, archive, merge, expand Scope, write raw Activity History, infer dangerous permissions, or call an external service.",
    "An inferred experience rule must remain Room/inferred/limited. A direct user instruction may be Room/direct_confirmed/normal.",
    JSON.stringify(snapshot)
  ].join("\n\n");
}

export function parseCore05BackgroundReviewResult(text: string): Core05BackgroundReviewResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return Core05BackgroundReviewResultSchema.parse(JSON.parse(candidate));
}

/** Reject all unapproved output and enforce the non-escalating Room defaults at Runtime. */
export function restrictCore05BackgroundReviewResult(input: {
  result: Core05BackgroundReviewResult;
  snapshot: Core05ReviewSnapshot;
  activityContext: ActivityContextRef;
  hasExplicitRuleInstruction: boolean;
  hasExplicitMemoryInstruction: boolean;
}): Core05BackgroundReviewResult {
  const roomScopeValue = { kind: "room" as const, room_id: input.activityContext.room_id };
  const allowedEvidence = core05AllowedEvidenceRefs(input.snapshot);
  const mutations: Core05BackgroundReviewMutation[] = [];
  for (const rawMutation of input.result.mutations) {
    const evidenceRefs = rawMutation.evidence_refs
      .map((reference) => allowedEvidence.get(core05RefKey(reference)))
      .filter((reference): reference is ResourceRef => Boolean(reference));
    // A model may not invent an external or another-Room evidence reference.
    if (evidenceRefs.length === 0) continue;
    const mutation = LearningBackgroundReviewMutationSchema.parse({ ...rawMutation, evidence_refs: evidenceRefs });
    if (mutation.kind === "experience_rule_create") {
      const explicitScope = input.hasExplicitRuleInstruction
        ? explicitScopeForMutation(mutation, input.snapshot, "rule")
        : undefined;
      if (mutation.evidence_state === "direct_confirmed" && explicitScope) {
        mutations.push(Core05BackgroundReviewMutationSchema.parse({ ...mutation, usage_scope: explicitScope, usage_state: "normal" }));
      } else {
        mutations.push(Core05BackgroundReviewMutationSchema.parse({ ...mutation, usage_scope: roomScopeValue, evidence_state: "inferred", usage_state: "limited" }));
      }
      continue;
    }
    if (mutation.kind === "memory_create") {
      const explicitScope = input.hasExplicitMemoryInstruction
        ? explicitScopeForMutation(mutation, input.snapshot, "memory")
        : undefined;
      const direct = mutation.evidence_state === "direct_confirmed" && explicitScope !== undefined;
      mutations.push(Core05BackgroundReviewMutationSchema.parse({
        ...mutation,
        usage_scope: explicitScope ?? roomScopeValue,
        evidence_state: direct ? "direct_confirmed" : "inferred",
        usage_state: direct ? "normal" : "limited"
      }));
      continue;
    }
    if (mutation.kind === "skill_candidate_create") {
      mutations.push(Core05BackgroundReviewMutationSchema.parse({ ...mutation, usage_scope: roomScopeValue }));
      continue;
    }
    mutations.push(mutation);
  }
  return { ...input.result, mutations };
}

function core05AllowedEvidenceRefs(snapshot: Core05ReviewSnapshot): Map<string, ResourceRef> {
  const allowed = new Map<string, ResourceRef>();
  const add = (reference: ResourceRef) => {
    allowed.set(core05RefKey(reference), reference);
  };
  const addBundle = (bundle: Core05EvidenceBundle) => {
    add(backendRunRef(bundle.backend_run));
    add(messageResourceRef(bundle.input_message));
    if (bundle.output_message) add(messageResourceRef(bundle.output_message));
    for (const event of bundle.backend_events) for (const reference of event.resource_refs) add(reference);
    for (const tool of bundle.tool_runs) add(toolRunRef(tool));
    for (const change of bundle.workspace_changes) add(change.resource_ref);
  };
  addBundle(snapshot.evidence);
  for (const bundle of snapshot.pending_room_evidence) addBundle(bundle);
  return allowed;
}

function core05RefKey(reference: ResourceRef): string {
  return `${reference.kind}:${reference.id}`;
}

function explicitScopeForMutation(
  mutation: LearningBackgroundReviewMutation,
  snapshot: Core05ReviewSnapshot,
  kind: "memory" | "rule"
): UsageScopeRef | undefined {
  const evidenceMessageIds = new Set(mutation.evidence_refs
    .filter((reference) => reference.kind === "message")
    .map((reference) => reference.id));
  if (evidenceMessageIds.size === 0) return undefined;
  const candidates = core05SnapshotMessages(snapshot)
    .filter(({ message }) => evidenceMessageIds.has(message.id))
    .filter(({ message }) => kind === "memory" ? isExplicitMemoryInstruction(message.content) : isExplicitRuleInstruction(message.content))
    .map(({ message, activity }) => explicitLearningScope(message.content, activity));
  const first = candidates[0];
  if (!first || !candidates.every((scope) => sameUsageScope(scope, first))) return undefined;
  return first;
}

function core05SnapshotMessages(snapshot: Core05ReviewSnapshot): Array<{ message: MessageRecord; activity: ActivityContextRef }> {
  const result: Array<{ message: MessageRecord; activity: ActivityContextRef }> = [];
  const add = (bundle: Core05EvidenceBundle) => {
    result.push({ message: bundle.input_message, activity: bundle.activity_context });
    if (bundle.output_message) result.push({ message: bundle.output_message, activity: bundle.activity_context });
  };
  add(snapshot.evidence);
  for (const bundle of snapshot.pending_room_evidence) add(bundle);
  return result;
}

function isExplicitMemoryInstruction(content: string): boolean {
  return /(?:覚えて|記憶(?:に)?保存|メモリ(?:に)?保存|remember (?:this|that)|save (?:this|that) to memory)/i.test(content);
}

function isExplicitRuleInstruction(content: string): boolean {
  return /(?:経験則|ルール(?:化)?|規則(?:化)?|再利用(?:可能)?な手順|make (?:this|that) a rule)/i.test(content);
}

/** Review-created Resources stay in the source Room; explicit wider Scope is a later owner Version operation. */
function explicitLearningScope(_content: string, activity: ActivityContextRef): UsageScopeRef {
  return { kind: "room", room_id: activity.room_id };
}

function sameUsageScope(left: UsageScopeRef, right: UsageScopeRef): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Deterministic, no-LLM candidate collection performed after a completed Run. */
export function deriveLearningCandidateSignals(bundle: Core05EvidenceBundle): LearningCandidateSignal[] {
  const signals: LearningCandidateSignal[] = [];
  const input = bundle.input_message.content;
  const runRef = backendRunRef(bundle.backend_run);
  const messageRef = resourceRef("message", bundle.input_message.id, `workspace://sessions/${bundle.input_message.session_id}/messages/${bundle.input_message.id}`);
  const correction = /(?:訂正|修正して|修正してください|間違い|not correct|incorrect)/i.test(input);
  const negation = /(?:違う|誤り|wrong|not true|否定)/i.test(input);
  const explicitMemory = isExplicitMemoryInstruction(input);
  const explicitRule = isExplicitRuleInstruction(input);
  const requestedScope = explicitLearningScope(input, bundle.activity_context);
  if (explicitMemory) signals.push(signal("explicit_memory_save", "ユーザーが明示的にMemory保存を求めた。", [messageRef], { requested_usage_scope: requestedScope }));
  if (explicitRule) signals.push(signal("explicit_experience_rule", "ユーザーが明示的に経験則化を求めた。", [messageRef], { requested_usage_scope: requestedScope }));
  if (correction) signals.push(signal("user_correction", "ユーザーが内容を訂正した。", [messageRef]));
  if (negation) signals.push(signal("user_negation", "ユーザーが内容を否定した。", [messageRef]));

  const byTool = new Map<string, ToolRunRecord[]>();
  for (const tool of bundle.tool_runs) {
    const key = tool.action_id || tool.provider_tool_name;
    byTool.set(key, [...(byTool.get(key) ?? []), tool]);
  }
  for (const [toolName, runs] of byTool) {
    if (runs.some((item) => item.status === "failed") && runs.some((item) => item.status === "completed")) {
      signals.push(signal("tool_failure_then_success", `Tool ${toolName} は失敗後に成功した。`, runs.map(toolRunRef)));
    }
    if (runs.filter((item) => item.status === "completed").length >= 2) {
      signals.push(signal("repeated_procedure", `Tool ${toolName} の反復可能な手順の兆候がある。`, runs.map(toolRunRef)));
    }
  }
  const objective = bundle.tool_runs.filter((tool) => tool.status === "completed" && /(?:test|verify|build|check|lint)/i.test(`${tool.action_id} ${tool.provider_tool_name}`));
  if (objective.length) signals.push(signal("objective_result", "客観的なテストまたは実行結果がある。", objective.map(toolRunRef)));
  const applied = bundle.used_learning_resources.filter((entry) => entry.stage === "applied");
  if (applied.length) signals.push(signal("resource_applied", "Resourceが実際の判断・行動に使われた。", [runRef], { resource_ids: applied.map((entry) => entry.resource_id) }));
  const meaningfulChanges = bundle.workspace_changes.filter((change) => change.change_type !== "memory_suggested");
  if (meaningfulChanges.length) signals.push(signal("workspace_change", "意味のあるWorkspace変更がある。", meaningfulChanges.map((change) => change.resource_ref)));
  const backendSignals = backendLearningSignalSummary(bundle.backend_run, bundle.backend_events);
  if (backendSignals.length) signals.push(signal("backend_learning_signal", "BackendがLearning候補信号を返した。", [runRef], { signals: backendSignals }));
  return dedupeSignals(signals);
}

export function learningCandidateKey(sourceRunId: string): string {
  return `background-review:${sourceRunId}`;
}

export interface LearningBudgetDecision {
  allowed: boolean;
  unit?: "currency" | "tokens";
  budget?: number;
  spent?: number;
  estimate?: number;
  deferred_reason?: string;
}

/**
 * Budget math never combines money and tokens.  If the Provider exposes
 * neither, review remains eligible and its unknown cost is not fabricated.
 */
export function learningBudgetDecision(input: {
  normal_runs: BackendRunRecord[];
  source_run: BackendRunRecord;
  ratio: number;
  window_days: number;
  now?: Date;
  already_spent?: Array<{ unit?: "currency" | "tokens"; amount?: number }>;
}): LearningBudgetDecision {
  const now = input.now?.getTime() ?? Date.now();
  const since = now - Math.max(1, input.window_days) * 86_400_000;
  const runs = input.normal_runs.filter((run) => run.status === "completed" && !Boolean(run.metadata.background_review) && Date.parse(run.completed_at ?? run.started_at) >= since);
  const sourceUsage = usageOf(input.source_run);
  const unit = sourceUsage.currency !== undefined ? "currency" : sourceUsage.tokens !== undefined ? "tokens" : undefined;
  if (!unit) return { allowed: true };
  const values = runs.map((run) => usageOf(run)[unit]).filter((value): value is number => value !== undefined);
  if (values.length === 0) return { allowed: true, unit };
  const budget = values.reduce((total, value) => total + value, 0) * Math.max(0, Math.min(1, input.ratio));
  const spent = (input.already_spent ?? []).filter((entry) => entry.unit === unit && typeof entry.amount === "number")
    .reduce((total, entry) => total + (entry.amount ?? 0), 0);
  const explicitEstimate = numeric(input.source_run.metadata.learning_review_estimate);
  const estimate = explicitEstimate ?? (sourceUsage[unit] ?? 0) * 0.1;
  return spent + estimate <= budget
    ? { allowed: true, unit, budget, spent, estimate }
    : { allowed: false, unit, budget, spent, estimate, deferred_reason: "learning_budget_exceeded" };
}

function signal(kind: LearningCandidateSignal["kind"], summary: string, evidence_refs: ResourceRef[], details: Record<string, unknown> = {}): LearningCandidateSignal {
  return LearningCandidateSignalSchema.parse({ kind, summary, evidence_refs, details });
}

function dedupeSignals(signals: LearningCandidateSignal[]): LearningCandidateSignal[] {
  const seen = new Set<string>();
  return signals.filter((item) => {
    const key = `${item.kind}:${item.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function backendLearningSignalSummary(run: BackendRunRecord, events: BackendEventRecord[]): string[] {
  const values: unknown[] = [run.metadata.learning_signal, run.metadata.learning_signals];
  for (const event of events) {
    if (event.payload && typeof event.payload === "object") {
      const payload = event.payload as Record<string, unknown>;
      values.push(payload.learning_signal, payload.learning_signals);
    }
  }
  return values.flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .slice(0, 20);
}

function backendRunRef(run: BackendRunRecord): ResourceRef {
  return resourceRef("backend_run", run.id, `workspace://backend-runs/${run.id}`);
}

function messageResourceRef(message: MessageRecord): ResourceRef {
  return resourceRef("message", message.id, `workspace://sessions/${message.session_id}/messages/${message.id}`);
}

function toolRunRef(run: ToolRunRecord): ResourceRef {
  return resourceRef("tool_run", run.id, `workspace://tool-runs/${run.id}`);
}

function resourceRef(kind: string, id: string, uri: string): ResourceRef {
  return { kind, id, uri };
}

function usageOf(run: BackendRunRecord): { currency?: number; tokens?: number } {
  const metadata = run.metadata as Record<string, unknown>;
  const usage = record(metadata.usage);
  const currency = firstNumber(metadata.cost_usd, metadata.cost, usage.cost_usd, usage.cost);
  const totalTokens = firstNumber(metadata.total_tokens, usage.total_tokens);
  const tokens = totalTokens ?? sumNumbers(metadata.input_tokens, metadata.output_tokens, usage.input_tokens, usage.output_tokens);
  return {
    ...(currency !== undefined && currency >= 0 ? { currency } : {}),
    ...(tokens !== undefined && tokens >= 0 ? { tokens } : {})
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numeric(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function sumNumbers(...values: unknown[]): number | undefined {
  const numbers = values.map(numeric).filter((value): value is number => value !== undefined);
  return numbers.length === 0 ? undefined : numbers.reduce((total, value) => total + value, 0);
}
