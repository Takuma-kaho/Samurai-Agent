import { createHash } from "node:crypto";
import { WorkspaceServerError } from "./errors";
import {
  workspaceCompletionAiProtections,
  workspaceCompletionCreationSources,
  workspaceCompletionDefaultTuning,
  workspaceCompletionEvidenceStates,
  workspaceCompletionKnowledgeKinds,
  workspaceCompletionLifecycleStates,
  workspaceCompletionPolicyEffects,
  workspaceCompletionPolicyOperations,
  type WorkspaceCompletionActivity,
  type WorkspaceCompletionConfiguration,
  type WorkspaceCompletionEvidenceState,
  type WorkspaceCompletionKnowledgeKind,
  type WorkspaceCompletionPolicyEffect,
  type WorkspaceCompletionPolicyOperation,
  type WorkspaceCompletionPolicyRule,
  type WorkspaceCompletionResourceKind,
  type WorkspaceCompletionTuning
} from "./workspace-completion-types";

const secretPattern = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|(?:^|[\n{,])\s*["']?(?:password|passphrase|secret|client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|api[_-]?key)["']?\s*[:=]|(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})(?:$|[^A-Za-z0-9])/i;
const secretFieldPattern = /(?:^|[^A-Za-z0-9])(?:password|passphrase|secret|client[_-]?secret|oauth[_-]?client[_-]?secret|private[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?(?:access|refresh)[_-]?token|authorization(?!_(?:state|error_code)\b)|cookie|credential|api[_-]?key|api[_-]?token|bearer[_-]?token)(?:$|[^A-Za-z0-9])/i;
const opaqueId = /^[a-z][a-z0-9_:-]{0,127}$/;

export interface WorkspaceCompletionValidationIssue {
  path: string;
  code: string;
  expected: string;
}

export interface WorkspaceCompletionReviewCandidate {
  kind: "skip" | "knowledge" | "skill" | "policy_change_request" | "evidence_append" | "conflict";
  resourceId?: string;
  expectedVersion?: number;
  title?: string;
  content?: string;
  resourceKind?: WorkspaceCompletionResourceKind;
  knowledgeKind?: WorkspaceCompletionKnowledgeKind;
  metadata?: Record<string, unknown>;
  evidenceActivityIds: readonly string[];
  reason: string;
}

export interface WorkspaceCompletionReviewResult {
  reviewer: string;
  summary: string;
  candidates: readonly WorkspaceCompletionReviewCandidate[];
}

export interface WorkspaceCompletionReviewSnapshot {
  workspaceId: string;
  roomId: string;
  episodeId: string;
  /** Last Activity included by the deterministic, cursor-complete read. */
  highWatermarkActivityId: string;
  activityCount: number;
  resourceCount: number;
  /** Hash of all selected rows plus the configuration version. */
  digest: string;
  configurationVersion: number;
  activities: readonly WorkspaceCompletionActivity[];
  resources: readonly {
    id: string;
    version: number;
    kind: WorkspaceCompletionResourceKind;
    fixed: boolean;
    contentHash: string;
    lifecycleState: string;
    evidenceState: string;
  }[];
}

export interface CompletionEligibility {
  eligible: boolean;
  priority: "normal" | "high";
  reasons: readonly string[];
}

/** The model may summarize this selected evidence, but cannot widen the
 * candidate set from chat text, a cancellation, or an unexplained failure. */
export function classifyWorkspaceCompletionActivity(activity: Pick<WorkspaceCompletionActivity,
  "outcome" | "verificationOutcome" | "failureState" | "explicitRemember" | "correctionOfActivityId" | "payload"
>): CompletionEligibility {
  if (activity.outcome === "cancelled" || activity.failureState === "unresolved") {
    return { eligible: false, priority: "normal", reasons: [] };
  }
  const reasons: string[] = [];
  if (activity.correctionOfActivityId) reasons.push("human_correction");
  if (activity.explicitRemember) reasons.push("explicit_remember");
  // `verificationOutcome` is a caller declaration retained on the Activity.
  // It is deliberately not an eligibility or promotion signal: a hash-bound
  // Attestation record is evaluated later by the server transaction.
  if (activity.failureState === "resolved" && activity.outcome === "completed") reasons.push("failure_recovered");
  if (activity.payload.finalized_resource === true && activity.outcome === "completed") reasons.push("formal_resource_finalized");
  if (activity.payload.learning_use_outcome_known === true) reasons.push("learning_use_outcome_known");
  return { eligible: reasons.length > 0, priority: activity.correctionOfActivityId ? "high" : "normal", reasons };
}

/** A 422 is deliberately shaped for a repair attempt: a cassette receives
 * path/code/expected rather than a vague retry instruction. */
export function validateWorkspaceCompletionReviewResult(
  snapshot: WorkspaceCompletionReviewSnapshot,
  value: WorkspaceCompletionReviewResult
): WorkspaceCompletionReviewResult {
  const issues: WorkspaceCompletionValidationIssue[] = [];
  if (!value || typeof value !== "object") issues.push(issue("$", "object_required", "review result object"));
  if (!nonBlank(value?.reviewer)) issues.push(issue("$.reviewer", "required", "non-empty reviewer"));
  if (typeof value?.summary !== "string") issues.push(issue("$.summary", "string_required", "string"));
  if (!Array.isArray(value?.candidates)) issues.push(issue("$.candidates", "array_required", "array"));
  if (issues.length > 0) throwValidation(issues);
  safeText(value.reviewer, "$.reviewer", issues);
  safeText(value.summary, "$.summary", issues);
  if (value.candidates.length > 50) issues.push(issue("$.candidates", "too_many", "50 or fewer candidates"));
  const activityIds = new Set(snapshot.activities.map((activity) => activity.id));
  const resources = new Map(snapshot.resources.map((resource) => [resource.id, resource]));
  const candidates: WorkspaceCompletionReviewCandidate[] = [];
  for (const [index, raw] of value.candidates.entries()) {
    const path = `$.candidates[${index}]`;
    if (!raw || typeof raw !== "object") {
      issues.push(issue(path, "object_required", "candidate object"));
      continue;
    }
    const candidate = raw as WorkspaceCompletionReviewCandidate;
    if (!["skip", "knowledge", "skill", "policy_change_request", "evidence_append", "conflict"].includes(candidate.kind)) {
      issues.push(issue(`${path}.kind`, "enum_invalid", "skip, knowledge, skill, policy_change_request, evidence_append, or conflict"));
      continue;
    }
    if (!nonBlank(candidate.reason)) issues.push(issue(`${path}.reason`, "required", "non-empty reason"));
    else safeText(candidate.reason, `${path}.reason`, issues);
    const evidenceIds = Array.isArray(candidate.evidenceActivityIds) ? [...new Set(candidate.evidenceActivityIds)] : [];
    if (!Array.isArray(candidate.evidenceActivityIds) || evidenceIds.some((id) => !nonBlank(id))) {
      issues.push(issue(`${path}.evidenceActivityIds`, "invalid", "array of activity IDs"));
    }
    if (candidate.kind !== "skip" && evidenceIds.length === 0) {
      issues.push(issue(`${path}.evidenceActivityIds`, "required", "at least one selected Activity"));
    }
    if (evidenceIds.some((id) => !activityIds.has(id))) {
      issues.push(issue(`${path}.evidenceActivityIds`, "out_of_scope", "only Activity IDs from this Episode snapshot"));
    }
    if (candidate.kind === "knowledge" || candidate.kind === "skill" || candidate.kind === "conflict") {
      validateProposedResource(candidate, path, issues);
    }
    if (candidate.kind === "knowledge" && candidate.resourceKind !== "knowledge") {
      issues.push(issue(`${path}.resourceKind`, "kind_invalid", "knowledge"));
    }
    if (candidate.kind === "skill" && candidate.resourceKind !== "skill") {
      issues.push(issue(`${path}.resourceKind`, "kind_invalid", "skill"));
    }
    if (candidate.kind === "conflict" && candidate.resourceKind !== "knowledge" && candidate.resourceKind !== "skill") {
      issues.push(issue(`${path}.resourceKind`, "kind_invalid", "knowledge or skill"));
    }
    if ((candidate.kind === "knowledge" || candidate.kind === "skill") && candidate.resourceId !== undefined) {
      const target = resources.get(candidate.resourceId);
      if (!target) issues.push(issue(`${path}.resourceId`, "out_of_scope", "resource ID from the Room snapshot"));
      if (!Number.isSafeInteger(candidate.expectedVersion) || (candidate.expectedVersion ?? 0) < 1) {
        issues.push(issue(`${path}.expectedVersion`, "version_required", "positive integer current version"));
      } else if (target && candidate.expectedVersion !== target.version) {
        issues.push(issue(`${path}.expectedVersion`, "stale", `current version ${target.version}`));
      }
      if (target?.fixed) issues.push(issue(`${path}.resourceId`, "fixed_resource", "a non-fixed resource"));
    }
    if (candidate.kind === "policy_change_request" && candidate.resourceKind === "policy") {
      // A request is intentionally not a Policy resource. Human signature and
      // Policy apply are a different, non-AI operation.
      issues.push(issue(`${path}.resourceKind`, "policy_not_auto_applicable", "omit resourceKind; create only a change request"));
    }
    if (candidate.kind === "evidence_append" || candidate.kind === "conflict") {
      const target = nonBlank(candidate.resourceId) ? resources.get(candidate.resourceId) : undefined;
      if (!target) issues.push(issue(`${path}.resourceId`, "out_of_scope", "resource ID from the Room snapshot"));
      if (!Number.isSafeInteger(candidate.expectedVersion) || (candidate.expectedVersion ?? 0) < 1) {
        issues.push(issue(`${path}.expectedVersion`, "version_required", "positive integer current version"));
      } else if (target && candidate.expectedVersion !== target.version) {
        issues.push(issue(`${path}.expectedVersion`, "stale", `current version ${target.version}`));
      }
      if (candidate.kind === "evidence_append" && target?.fixed) {
        issues.push(issue(`${path}.resourceId`, "fixed_resource", "a non-fixed resource; fixed resources only receive Use/Evaluation evidence"));
      }
    }
    candidates.push({ ...candidate, evidenceActivityIds: evidenceIds, reason: candidate.reason?.trim() ?? "" });
  }
  if (issues.length > 0) throwValidation(issues);
  return { reviewer: value.reviewer.trim(), summary: value.summary.trim(), candidates };
}

function validateProposedResource(candidate: WorkspaceCompletionReviewCandidate, path: string, issues: WorkspaceCompletionValidationIssue[]): void {
  if (!nonBlank(candidate.title)) issues.push(issue(`${path}.title`, "required", "non-empty title"));
  else safeText(candidate.title, `${path}.title`, issues);
  if (!nonBlank(candidate.content)) issues.push(issue(`${path}.content`, "required", "non-empty file body"));
  else safeText(candidate.content, `${path}.content`, issues);
  if (!candidate.metadata || typeof candidate.metadata !== "object" || Array.isArray(candidate.metadata)) {
    issues.push(issue(`${path}.metadata`, "object_required", "structured metadata object"));
    return;
  }
  safeObject(candidate.metadata, `${path}.metadata`, issues);
  if (candidate.resourceKind === "knowledge") {
    if (!workspaceCompletionKnowledgeKinds.includes(candidate.knowledgeKind as WorkspaceCompletionKnowledgeKind)) {
      issues.push(issue(`${path}.knowledgeKind`, "enum_invalid", "fact, decision, explanation, or experience_rule"));
      return;
    }
    const required = requiredKnowledgeFields(candidate.knowledgeKind!);
    for (const field of required) {
      if (!hasMeaningfulValue(candidate.metadata[field])) issues.push(issue(`${path}.metadata.${field}`, "required", requiredDescription(candidate.knowledgeKind!, field)));
    }
  }
  if (candidate.resourceKind === "skill") {
    for (const field of ["when", "inputs", "preconditions", "steps", "completion", "failure", "knowledge_ids"]) {
      if (!hasMeaningfulValue(candidate.metadata[field])) issues.push(issue(`${path}.metadata.${field}`, "required", "complete Skill package metadata"));
    }
    if (!Array.isArray(candidate.metadata.steps) || candidate.metadata.steps.length === 0 || candidate.metadata.steps.some((step) => !nonBlank(String(step)))) {
      issues.push(issue(`${path}.metadata.steps`, "ordered_steps_required", "one or more ordered non-empty steps"));
    }
  }
}

function requiredKnowledgeFields(kind: WorkspaceCompletionKnowledgeKind): readonly string[] {
  switch (kind) {
    case "fact": return ["statement", "subject", "evidence"];
    case "decision": return ["decision", "assumptions", "reason"];
    case "explanation": return ["topic", "explanation", "assumptions"];
    case "experience_rule": return ["conditions", "action", "likely_result"];
  }
}

function requiredDescription(kind: WorkspaceCompletionKnowledgeKind, field: string): string {
  return `${kind} requires ${field}`;
}

export interface WorkspaceCompletionPolicyEvaluationInput {
  operation: WorkspaceCompletionPolicyOperation;
  accountId: string;
  /** Trusted ingress classification. It is never read from a policy body or
   * HTTP JSON; Connection rules are inert unless a Connection Host supplies
   * its authenticated internal Context. */
  callerKind: "human" | "connection" | "maintenance" | "unknown";
  connectionId?: string;
  attributes: Readonly<Record<string, string | number | boolean | undefined>>;
  /** RLS / normal membership already made this decision. Policy can narrow it,
   * never expand it. */
  baseAllowed: boolean;
}

export interface WorkspaceCompletionPolicyEvaluation {
  allowed: boolean;
  required: readonly string[];
  deniedBy: readonly string[];
}

/** Evaluate workspace rules before room rules. A room `allow` can never undo a
 * workspace `deny` or unfulfilled workspace `require`. */
export function evaluateWorkspaceCompletionPolicies(
  workspaceRules: readonly WorkspaceCompletionPolicyRule[],
  roomRules: readonly WorkspaceCompletionPolicyRule[],
  input: WorkspaceCompletionPolicyEvaluationInput
): WorkspaceCompletionPolicyEvaluation {
  if (!input.baseAllowed) return { allowed: false, required: [], deniedBy: ["base_permission"] };
  // These two attributes are derived from the Server-created Context.  They
  // deliberately override same-named operation attributes, which may have
  // originated in a request body or an external connection payload.
  const trustedInput: WorkspaceCompletionPolicyEvaluationInput = {
    ...input,
    attributes: {
      ...input.attributes,
      caller_kind: input.callerKind,
      connection_id: input.connectionId
    }
  };
  const required: string[] = [];
  const deniedBy: string[] = [];
  for (const rule of workspaceRules) applyRule(rule, trustedInput, required, deniedBy);
  const workspaceBlocked = deniedBy.length > 0 || required.length > 0;
  for (const rule of roomRules) {
    if (workspaceBlocked && rule.effect === "allow") continue;
    applyRule(rule, trustedInput, required, deniedBy);
  }
  return { allowed: deniedBy.length === 0 && required.length === 0, required, deniedBy };
}

function applyRule(
  rule: WorkspaceCompletionPolicyRule,
  input: WorkspaceCompletionPolicyEvaluationInput,
  required: string[],
  deniedBy: string[]
): void {
  if (rule.operation !== input.operation) return;
  if (rule.principalAccountId && rule.principalAccountId !== input.accountId) return;
  if (rule.connectionId && rule.connectionId !== input.connectionId) return;
  const conditionsMatch = Object.entries(rule.conditions).every(([key, expected]) => input.attributes[key] === expected);
  if (rule.effect === "require") {
    if (!conditionsMatch) required.push(rule.id);
    return;
  }
  if (!conditionsMatch) return;
  if (rule.effect === "deny") deniedBy.push(rule.id);
  // `allow` intentionally does nothing beyond documenting a compatible rule:
  // normal authorization/RLS remains the sole positive authority.
}

export function validateWorkspaceCompletionPolicyRules(value: unknown): WorkspaceCompletionPolicyRule[] {
  if (!Array.isArray(value) || value.length > 100) throw new WorkspaceServerError("workspace_completion_policy_rules_invalid", 422);
  const rules: WorkspaceCompletionPolicyRule[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WorkspaceServerError("workspace_completion_policy_rule_invalid", 422);
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const operation = item.operation as WorkspaceCompletionPolicyOperation;
    const effect = item.effect as WorkspaceCompletionPolicyEffect;
    if (!opaqueId.test(id) || !workspaceCompletionPolicyOperations.includes(operation) || !workspaceCompletionPolicyEffects.includes(effect)) {
      throw new WorkspaceServerError("workspace_completion_policy_rule_invalid", 422);
    }
    const conditions = item.conditions;
    if (!conditions || typeof conditions !== "object" || Array.isArray(conditions) || Object.keys(conditions).length > 16) {
      throw new WorkspaceServerError("workspace_completion_policy_conditions_invalid", 422);
    }
    const normalized: Record<string, string | number | boolean> = {};
    for (const [key, condition] of Object.entries(conditions as Record<string, unknown>)) {
      const scalar = typeof condition === "string" || typeof condition === "number" || typeof condition === "boolean";
      const finiteNumber = typeof condition !== "number" || Number.isFinite(condition);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !scalar || !finiteNumber) {
        throw new WorkspaceServerError("workspace_completion_policy_conditions_invalid", 422);
      }
      if (typeof condition === "string" && (condition.length > 256 || secretPattern.test(condition))) throw new WorkspaceServerError("workspace_completion_secret_content_forbidden", 400);
      normalized[key] = condition;
    }
    const principalAccountId = optionalOpaqueId(item.principalAccountId, "workspace_completion_policy_principal_invalid");
    const connectionId = optionalOpaqueId(item.connectionId, "workspace_completion_policy_connection_invalid");
    rules.push({ id, operation, effect, ...(principalAccountId ? { principalAccountId } : {}), ...(connectionId ? { connectionId } : {}), conditions: normalized });
  }
  return rules;
}

export function validateWorkspaceCompletionTuning(value: unknown): WorkspaceCompletionTuning {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError("workspace_completion_tuning_invalid", 422);
  const candidate = value as Record<string, unknown>;
  const normalized = { ...workspaceCompletionDefaultTuning } as WorkspaceCompletionTuning;
  for (const key of Object.keys(workspaceCompletionDefaultTuning) as Array<keyof WorkspaceCompletionTuning>) {
    if (candidate[key] === undefined) continue;
    if (!Number.isSafeInteger(candidate[key]) || Number(candidate[key]) < 1 || Number(candidate[key]) > 1_000_000) {
      throw new WorkspaceServerError("workspace_completion_tuning_invalid", 422, { field: key });
    }
    normalized[key] = Number(candidate[key]);
  }
  return normalized;
}

export function configurationFingerprint(configuration: WorkspaceCompletionConfiguration): string {
  return createHash("sha256").update(JSON.stringify({ scope: configuration.scope, version: configuration.version, values: configuration.values })).digest("hex");
}

export function assertCompletionResourceAxes(input: {
  evidenceState: WorkspaceCompletionEvidenceState;
  lifecycleState: string;
  aiProtection: string;
  creationSource: string;
}): void {
  if (!workspaceCompletionEvidenceStates.includes(input.evidenceState)
    || !workspaceCompletionLifecycleStates.includes(input.lifecycleState as never)
    || !workspaceCompletionAiProtections.includes(input.aiProtection as never)
    || !workspaceCompletionCreationSources.includes(input.creationSource as never)) {
    throw new WorkspaceServerError("workspace_completion_resource_axes_invalid", 422);
  }
}

export function containsWorkspaceCompletionSecret(value: string): boolean {
  return secretPattern.test(value) || secretFieldPattern.test(value);
}

function safeText(value: string, path: string, issues: WorkspaceCompletionValidationIssue[]): void {
  if (value.length > 200_000) issues.push(issue(path, "too_large", "200000 characters or fewer"));
  if (secretPattern.test(value)) issues.push(issue(path, "secret_forbidden", "text without a credential or private key"));
}

function safeObject(value: Record<string, unknown>, path: string, issues: WorkspaceCompletionValidationIssue[]): void {
  if (Object.keys(value).length > 64) issues.push(issue(path, "too_many_fields", "64 fields or fewer"));
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") safeText(child, `${path}.${key}`, issues);
  }
}

function hasMeaningfulValue(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

function optionalOpaqueId(value: unknown, code: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !opaqueId.test(value)) throw new WorkspaceServerError(code, 422);
  return value;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(path: string, code: string, expected: string): WorkspaceCompletionValidationIssue {
  return { path, code, expected };
}

function throwValidation(issues: readonly WorkspaceCompletionValidationIssue[]): never {
  throw new WorkspaceServerError("workspace_completion_review_validation", 422, { issues });
}
