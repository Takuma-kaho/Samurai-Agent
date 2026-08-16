import { createHash } from "node:crypto";
import { canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import type {
  WorkspaceLearningActivityOutcome,
  WorkspaceLearningFailureState,
  WorkspaceLearningResource,
  WorkspaceLearningResourceKind,
  WorkspaceLearningVerificationState,
  WorkspaceRecordPayload
} from "./types";

export interface LearningActivityEligibilityInput {
  outcome: WorkspaceLearningActivityOutcome;
  verificationState: WorkspaceLearningVerificationState;
  failureState: WorkspaceLearningFailureState;
  correctionOfActivityId?: string;
  explicitRemember: boolean;
  /** A formal Artifact / Collection / output was finalized. */
  finalizedResource?: boolean;
  /** Existing learning was used and its outcome is now known. */
  learningUseOutcomeKnown?: boolean;
  /** The activity contains a reusable completed procedure. */
  reusableCompletion?: boolean;
}

export interface LearningEligibility {
  eligible: boolean;
  priority: "normal" | "high";
  reasons: readonly string[];
}

/** This is deliberately deterministic.  The model decides how to summarize
 * selected evidence, never whether every low-value event deserves a model run. */
export function classifyLearningActivity(input: LearningActivityEligibilityInput): LearningEligibility {
  // A correction or a remembered fact must be recorded as its own resolved
  // Activity. It must not turn a cancelled or still-unresolved execution into
  // automatic learning evidence by adding a convenient flag.
  if (input.outcome === "cancelled" || input.failureState === "unresolved") {
    return { eligible: false, priority: "normal", reasons: [] };
  }
  const reasons: string[] = [];
  const verifiedCompletion = input.outcome === "completed" && input.verificationState === "confirmed";
  if (input.correctionOfActivityId) reasons.push("human_correction");
  if (input.explicitRemember) reasons.push("explicit_remember");
  if (verifiedCompletion) reasons.push("verified_completion");
  // A recovery, finalized deliverable, and reusable procedure are only useful
  // learning evidence once the underlying completion itself was confirmed.
  if (verifiedCompletion && input.failureState === "resolved") reasons.push("failure_recovered");
  if (verifiedCompletion && input.finalizedResource === true) reasons.push("formal_resource_finalized");
  if (input.learningUseOutcomeKnown === true) reasons.push("learning_use_outcome_known");
  if (verifiedCompletion && input.reusableCompletion === true) reasons.push("reusable_completion");
  return {
    eligible: reasons.length > 0,
    priority: input.correctionOfActivityId ? "high" : "normal",
    reasons
  };
}

export interface WorkspaceKnowledgeReviewSnapshot {
  workspaceId: string;
  roomId: string;
  activities: ReadonlyArray<{
    id: string;
    instructionSummary: string;
    resultSummary?: string;
    outcome: WorkspaceLearningActivityOutcome;
    verificationState: WorkspaceLearningVerificationState;
    failureState: WorkspaceLearningFailureState;
    correctionOfActivityId?: string;
    explicitRemember: boolean;
    payload: WorkspaceRecordPayload;
  }>;
  workspaceRules: readonly WorkspaceLearningResource[];
  workspaceKnowledge: readonly WorkspaceLearningResource[];
  roomKnowledge: readonly WorkspaceLearningResource[];
}

export interface WorkspaceKnowledgeReviewMutation {
  kind: "create" | "update" | "evidence_append" | "conflict" | "no_change";
  resourceKind?: Exclude<WorkspaceLearningResourceKind, "workspace_rule">;
  resourceId?: string;
  expectedVersion?: number;
  /** Required for AI-created candidate Knowledge. It makes the provisional
   * state legible without pretending that a model output is human-confirmed. */
  confidence?: number;
  title?: string;
  content?: string;
  payload?: WorkspaceRecordPayload;
  reason: string;
  evidenceActivityIds: readonly string[];
}

export interface WorkspaceKnowledgeReviewResult {
  reviewer: string;
  summary: string;
  mutations: readonly WorkspaceKnowledgeReviewMutation[];
  usage?: { currency?: number; tokens?: number };
}

/** Backend cassette boundary.  A review model receives only an already
 * authorized snapshot and returns a narrow mutation plan, never database or
 * filesystem authority. */
export interface WorkspaceKnowledgeReviewPort {
  readonly id: string;
  readonly model?: string;
  /** Upper bound reserved before invoking this cassette. A configured budget
   * cannot be safely used with a port that provides no bound for that metric. */
  readonly maxUsage?: { currency?: number; tokens?: number };
  review(snapshot: WorkspaceKnowledgeReviewSnapshot, options: { signal: AbortSignal }): Promise<WorkspaceKnowledgeReviewResult>;
}

export function validateWorkspaceKnowledgeReviewResult(
  snapshot: WorkspaceKnowledgeReviewSnapshot,
  value: WorkspaceKnowledgeReviewResult
): WorkspaceKnowledgeReviewResult {
  if (!value || typeof value !== "object" || !nonBlank(value.reviewer) || typeof value.summary !== "string" || !Array.isArray(value.mutations)) {
    throw new WorkspaceServerError("workspace_learning_review_output_invalid", 422);
  }
  assertSafeLearningText(value.reviewer);
  assertSafeLearningText(value.summary);
  if (value.mutations.length > 50) throw new WorkspaceServerError("workspace_learning_review_output_too_large", 422);
  const activityIds = new Set(snapshot.activities.map((activity) => activity.id));
  const roomResources = new Map(snapshot.roomKnowledge.map((resource) => [resource.id, resource]));
  const output: WorkspaceKnowledgeReviewMutation[] = [];
  for (const mutation of value.mutations) {
    if (!mutation || typeof mutation !== "object" || !["create", "update", "evidence_append", "conflict", "no_change"].includes(mutation.kind) || !nonBlank(mutation.reason)) {
      throw new WorkspaceServerError("workspace_learning_review_output_invalid", 422);
    }
    assertSafeLearningText(mutation.reason);
    const rawEvidenceActivityIds: unknown = mutation.evidenceActivityIds;
    if (!Array.isArray(rawEvidenceActivityIds) || rawEvidenceActivityIds.some((id: unknown) => !nonBlank(id))) {
      throw new WorkspaceServerError("workspace_learning_review_evidence_invalid", 422);
    }
    const evidenceActivityIds = [...new Set(rawEvidenceActivityIds as string[])];
    if (mutation.kind !== "no_change" && evidenceActivityIds.length === 0) {
      throw new WorkspaceServerError("workspace_learning_review_evidence_required", 422);
    }
    if (evidenceActivityIds.some((id) => !activityIds.has(id))) {
      throw new WorkspaceServerError("workspace_learning_review_evidence_out_of_scope", 422);
    }
    if (mutation.kind === "create") {
      if (!isResourceKind(mutation.resourceKind) || !nonBlank(mutation.title) || !nonBlank(mutation.content) || !isConfidence(mutation.confidence)) {
        throw new WorkspaceServerError("workspace_learning_review_create_invalid", 422);
      }
      assertSafeLearningText(mutation.title!);
      assertSafeLearningText(mutation.content!);
      assertSafeLearningPayload(mutation.payload);
      output.push({
        kind: "create",
        resourceKind: mutation.resourceKind,
        confidence: mutation.confidence,
        title: mutation.title.trim(),
        content: mutation.content.trim(),
        ...(mutation.payload === undefined ? {} : { payload: mutation.payload }),
        reason: mutation.reason.trim(),
        evidenceActivityIds
      });
    } else if (mutation.kind === "update" || mutation.kind === "evidence_append" || mutation.kind === "conflict") {
      if (!nonBlank(mutation.resourceId)) throw new WorkspaceServerError("workspace_learning_review_resource_required", 422);
      const target = roomResources.get(mutation.resourceId!);
      if (!target) throw new WorkspaceServerError("workspace_learning_review_cross_room_resource_denied", 422);
      if (mutation.kind === "update") {
        if (target.aiUpdateLocked) throw new WorkspaceServerError("workspace_learning_resource_ai_update_locked", 409);
        if (!Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion! < 1 || !nonBlank(mutation.title) || !nonBlank(mutation.content)) {
          throw new WorkspaceServerError("workspace_learning_review_update_invalid", 422);
        }
        assertSafeLearningText(mutation.title!);
        assertSafeLearningText(mutation.content!);
        assertSafeLearningPayload(mutation.payload);
        output.push({
          kind: "update",
          resourceId: mutation.resourceId,
          expectedVersion: mutation.expectedVersion,
          title: mutation.title.trim(),
          content: mutation.content.trim(),
          ...(mutation.payload === undefined ? {} : { payload: mutation.payload }),
          reason: mutation.reason.trim(),
          evidenceActivityIds
        });
      } else if (mutation.kind === "evidence_append") {
        if (target.aiUpdateLocked) throw new WorkspaceServerError("workspace_learning_resource_ai_update_locked", 409);
        if (!Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion! < 1) {
          throw new WorkspaceServerError("workspace_learning_review_evidence_append_invalid", 422);
        }
        output.push({ kind: "evidence_append", resourceId: mutation.resourceId, expectedVersion: mutation.expectedVersion, reason: mutation.reason.trim(), evidenceActivityIds });
      } else {
        // A conflict preserves a new candidate alongside the existing item.
        // It therefore does not alter a human-fixed target, but still requires
        // a full candidate and an optimistic version for the link target.
        if (!Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion! < 1 || !nonBlank(mutation.title) || !nonBlank(mutation.content) || !isConfidence(mutation.confidence)) {
          throw new WorkspaceServerError("workspace_learning_review_conflict_invalid", 422);
        }
        assertSafeLearningText(mutation.title!);
        assertSafeLearningText(mutation.content!);
        assertSafeLearningPayload(mutation.payload);
        output.push({
          kind: "conflict",
          resourceId: mutation.resourceId,
          expectedVersion: mutation.expectedVersion,
          confidence: mutation.confidence,
          title: mutation.title.trim(),
          content: mutation.content.trim(),
          ...(mutation.payload === undefined ? {} : { payload: mutation.payload }),
          reason: mutation.reason.trim(),
          evidenceActivityIds
        });
      }
    } else {
      output.push({ kind: "no_change", reason: mutation.reason.trim(), evidenceActivityIds });
    }
  }
  const usage = normalizeReviewUsage(value.usage);
  return {
    reviewer: value.reviewer.trim(),
    summary: value.summary.trim(),
    mutations: output,
    ...(usage ? { usage } : {})
  };
}

export function learningRetryDelayMs(failureCount: number): number {
  const clamped = Math.max(1, Math.min(failureCount, 6));
  return 60_000 * 2 ** (clamped - 1);
}

export function isRetryableLearningError(error: unknown): boolean {
  if (error instanceof WorkspaceServerError) {
    return error.status >= 500
      || error.code === "workspace_learning_backend_temporary_unavailable"
      || error.code === "workspace_learning_runner_closed"
      || error.code === "workspace_learning_review_aborted";
  }
  return true;
}

/** Search ordering is a policy, not a visibility expansion. Only callers that
 * already supplied the current Room receive this three-layer result. */
export function rankKnowledgeForCurrentRoom(input: {
  query: string;
  workspaceRules: readonly WorkspaceLearningResource[];
  roomKnowledge: readonly WorkspaceLearningResource[];
  workspaceKnowledge: readonly WorkspaceLearningResource[];
  limit: number;
}): WorkspaceLearningResource[] {
  const query = input.query.trim().toLocaleLowerCase();
  const ranked = [
    ...scoreResources(input.workspaceRules, query, 3),
    ...scoreResources(input.roomKnowledge, query, 2),
    ...scoreResources(input.workspaceKnowledge, query, 1)
  ];
  return ranked
    .sort((left, right) => right.score - left.score || right.resource.updatedAt.localeCompare(left.resource.updatedAt) || left.resource.id.localeCompare(right.resource.id))
    .slice(0, input.limit)
    .map((entry) => entry.resource);
}

export function learningContentHash(input: { title: string; content: string; payload: WorkspaceRecordPayload }): string {
  return createHash("sha256").update(canonicalJson({ title: input.title, content: input.content, payload: input.payload })).digest("hex");
}

/** Knowledge must not become a second secret store. This intentionally catches
 * strong credential signatures rather than trying to redact arbitrary prose. */
export function assertSafeLearningText(value: string): void {
  if (!nonBlank(value)) throw new WorkspaceServerError("workspace_learning_content_invalid", 400);
  assertSafeLearningString(value);
}

function assertSafeLearningString(value: string): void {
  if (value.length > 200_000) throw new WorkspaceServerError("workspace_learning_content_invalid", 400);
  if (/(?:-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bsk-[A-Za-z0-9]{20,}\b|\bghp_[A-Za-z0-9]{30,}\b|\bAKIA[A-Z0-9]{16}\b)/.test(value)) {
    throw new WorkspaceServerError("workspace_learning_secret_content_forbidden", 400);
  }
}

/** Reject obvious credential-bearing fields before an Activity or Knowledge
 * payload becomes durable evidence. Opaque secret references are configured
 * elsewhere and never pass through this payload. */
export function assertSafeLearningPayload(value: unknown): asserts value is WorkspaceRecordPayload | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceServerError("workspace_learning_payload_invalid", 400);
  }
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      assertSafeLearningString(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      const normalizedKey = key.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
      if (/(?:password|passphrase|secret|privatekey|token|authorization|cookie|credential|apikey)$/.test(normalizedKey)) {
        throw new WorkspaceServerError("workspace_learning_secret_content_forbidden", 400);
      }
      visit(nested);
    }
  };
  visit(value);
}

function scoreResources(resources: readonly WorkspaceLearningResource[], query: string, scopeWeight: number) {
  return resources
    .filter((resource) => {
      if (resource.state === "archived" || resource.state === "conflict") return false;
      if (!query) return true;
      return `${resource.title}\n${resource.content}`.toLocaleLowerCase().includes(query);
    })
    .map((resource) => {
      return { resource, score: 100 + scopeWeight * 1_000 + (resource.isAbsoluteRule ? 10_000 : 0) };
    })
}

function isResourceKind(value: unknown): value is Exclude<WorkspaceLearningResourceKind, "workspace_rule"> {
  return value === "knowledge" || value === "memory" || value === "skill";
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeReviewUsage(value: WorkspaceKnowledgeReviewResult["usage"]): WorkspaceKnowledgeReviewResult["usage"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError("workspace_learning_usage_invalid", 422);
  const candidate = value as Record<string, unknown>;
  if (candidate.currency !== undefined && (typeof candidate.currency !== "number" || !Number.isFinite(candidate.currency) || candidate.currency < 0)) {
    throw new WorkspaceServerError("workspace_learning_usage_invalid", 422);
  }
  if (candidate.tokens !== undefined && (typeof candidate.tokens !== "number" || !Number.isSafeInteger(candidate.tokens) || candidate.tokens < 0)) {
    throw new WorkspaceServerError("workspace_learning_usage_invalid", 422);
  }
  return {
    ...(candidate.currency === undefined ? {} : { currency: candidate.currency as number }),
    ...(candidate.tokens === undefined ? {} : { tokens: candidate.tokens as number })
  };
}
