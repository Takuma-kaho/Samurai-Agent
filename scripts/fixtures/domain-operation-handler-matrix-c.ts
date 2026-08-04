/**
 * C shard: executable, hand-reviewed Handler contract matrix.
 *
 * This deliberately invokes each concrete Handler with a narrow Port object.
 * Every Port method records its full DTO before returning an explicit valid
 * value.  The resulting sequence is compared to the independent static
 * expectations in domain-operation-handler-expectations-c.ts; no expectation
 * is generated from a Handler at runtime.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { TrustedDomainContext } from "../../packages/domain-operations/src/definition/index";
import { jsonSchemaFor, operationDefinitions, type OperationDefinition } from "../../packages/domain-operations/src/index";
import curatorRun from "../../packages/domain-operations/src/operations/curator/run.operation";
import evaluationRun from "../../packages/domain-operations/src/operations/evaluation/run.operation";
import memoryArchive from "../../packages/domain-operations/src/operations/memory/archive.operation";
import memorySessionCreate from "../../packages/domain-operations/src/operations/memory/session/create.operation";
import memoryTopicCreate from "../../packages/domain-operations/src/operations/memory/topic/create.operation";
import messagePresentationUpdate from "../../packages/domain-operations/src/operations/message/presentation/update.operation";
import objectiveCreate from "../../packages/domain-operations/src/operations/objective/create.operation";
import presentationPlan from "../../packages/domain-operations/src/operations/presentation/plan.operation";
import reflectionRun from "../../packages/domain-operations/src/operations/reflection/run.operation";
import reflectionSuggestionApply from "../../packages/domain-operations/src/operations/reflection/suggestion/apply.operation";
import resourceTranslationJobSave from "../../packages/domain-operations/src/operations/resource/translation_job/save.operation";
import resourceTranslationSave from "../../packages/domain-operations/src/operations/resource/translation/save.operation";
import skillCandidateCreate from "../../packages/domain-operations/src/operations/skill/candidate/create.operation";
import skillLifecycleApply from "../../packages/domain-operations/src/operations/skill/lifecycle/apply.operation";
import skillOptimizationCancel from "../../packages/domain-operations/src/operations/skill/optimization/cancel.operation";
import skillOptimizationPromote from "../../packages/domain-operations/src/operations/skill/optimization/promote.operation";
import skillOptimizationReject from "../../packages/domain-operations/src/operations/skill/optimization/reject.operation";
import skillOptimizationRollback from "../../packages/domain-operations/src/operations/skill/optimization/rollback.operation";
import skillOptimizationStart from "../../packages/domain-operations/src/operations/skill/optimization/start.operation";
import skillPatch from "../../packages/domain-operations/src/operations/skill/patch.operation";
import skillProjectSave from "../../packages/domain-operations/src/operations/skill/project/save.operation";
import skillSupportFileSave from "../../packages/domain-operations/src/operations/skill/support_file/save.operation";
import skillView from "../../packages/domain-operations/src/operations/skill/view.operation";
import wikiAccept from "../../packages/domain-operations/src/operations/wiki/accept.operation";
import wikiArchive from "../../packages/domain-operations/src/operations/wiki/archive.operation";
import wikiPatch from "../../packages/domain-operations/src/operations/wiki/patch.operation";
import wikiProposalCreate from "../../packages/domain-operations/src/operations/wiki/proposal/create.operation";
import wikiReindex from "../../packages/domain-operations/src/operations/wiki/reindex.operation";
import wikiReject from "../../packages/domain-operations/src/operations/wiki/reject.operation";
import workItemCreate from "../../packages/domain-operations/src/operations/work_item/create.operation";
import {
  cHandlerCaseCount,
  cHandlerExpectations,
  cHandlerOperationCount,
  type CHandlerCallExpectation,
  type CHandlerCaseExpectation
} from "./domain-operation-handler-expectations-c";

type JsonObject = Record<string, unknown>;
type HandlerDefinition = {
  id: string;
  input: { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean; data?: unknown } };
  createHandler(ports: unknown): { execute(context: TrustedDomainContext, input: never): Promise<unknown> };
};
type RecordedCall = CHandlerCallExpectation;

const now = "2026-07-17T00:00:00.000Z";
const repositoryRoot = process.env.SAMURAI_REPO_ROOT ?? process.cwd();
const require = createRequire(resolve(repositoryRoot, "package.json"));
const ts: typeof import("typescript") = require("typescript");

const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "handler-matrix-c-workspace",
  actorId: "handler-matrix-c-actor",
  correlationId: "handler-matrix-c",
  roomId: "room_fixture",
  sessionId: "session_fixture",
  runId: "run_fixture",
  envelopeId: "envelope_fixture"
};

const session = {
  id: "session_fixture",
  session_key: "session_fixture",
  title: "Fixture session",
  ui_locale: "en",
  output_locale: "ja",
  created_at: now,
  updated_at: now
};
const envelope = {
  id: "envelope_fixture",
  source: "web",
  actor_identity: "owner",
  session_key: "session_fixture",
  user_intent: "Fixture intent",
  attachments: [],
  input_locale: "en",
  output_locale: "ja",
  metadata: {},
  received_at: now
};
const resourceRef = { kind: "artifact", id: "artifact_fixture", uri: "artifacts/fixture.md", label: "Fixture artifact" };
const provenance = { kind: "user_authored", summary: "fixture provenance", verified: true };
const operation = {
  id: "operation_fixture",
  session_id: "session_fixture",
  capability_id: "fixture",
  operation: "fixture.operation",
  actor_identity: "owner",
  instruction_source: "owner_instruction",
  instruction_authority: "owner",
  channel: "test",
  input_hash: "fixture_hash",
  target_resource_refs: [],
  proposed_effects: [],
  status: "completed",
  created_at: now,
  updated_at: now
};
const rollbackPoint = {
  id: "rollback_fixture",
  operation_id: "operation_fixture",
  affected_resources: [],
  before_snapshot: {},
  after_snapshot: {},
  reversible: true,
  irreversible_effects: [],
  created_at: now,
  expires_at: "2026-07-18T00:00:00.000Z"
};
const memory = {
  id: "memory_fixture",
  state: "session",
  topic: "fixture-memory",
  source: "fixture",
  source_locale: "en",
  content_locale: "en",
  source_kind: "owner_instruction",
  instruction_authority: "owner",
  confidence: 1,
  created_by: "fixture",
  created_at: now,
  updated_at: now,
  related_memories: [],
  conflicts_with: [] as string[],
  sensitive_level: "none",
  source_refs: [resourceRef],
  provenance
};
const storedSkill = {
  id: "skill_fixture",
  title: "Fixture Skill",
  description: "Fixture skill description",
  tags: ["fixture"],
  state: "project",
  allowed_scopes: ["workspace"],
  required_capabilities: [],
  owner_pinned: false,
  frontmatter: {
    id: "skill_fixture",
    state: "project",
    title: "Fixture Skill",
    description: "Fixture skill description",
    tags: ["fixture"],
    provenance: "fixture",
    trust_level: "user_authored",
    allowed_scopes: ["workspace"],
    required_capabilities: [],
    schedule_policy: {},
    secret_policy: {},
    owner_pinned: false,
    source_refs: [resourceRef],
    provenance_detail: provenance
  },
  file_path: "skills/skill_fixture.md"
};
const storedWiki = {
  id: "wiki_fixture",
  slug: "fixture-wiki",
  title: "Fixture Wiki",
  state: "proposed",
  content_locale: "en",
  tags: ["fixture"],
  source_refs: [resourceRef],
  provenance,
  created_at: now,
  updated_at: now,
  file_path: "wiki/fixture-wiki.md"
};
const reflectionRunRecord = {
  id: "reflection_fixture",
  kind: "manual",
  session_id: "session_fixture",
  status: "completed",
  input_summary: "Fixture reflection",
  output_summary: "Fixture result",
  started_at: now,
  completed_at: now
};
const reflectionSuggestion = {
  id: "suggestion_fixture",
  reflection_run_id: "reflection_fixture",
  suggestion_type: "memory",
  status: "proposed",
  title: "Fixture suggestion",
  content: "Fixture suggestion content",
  source_refs: [resourceRef],
  confidence: 0.8,
  created_at: now,
  updated_at: now
};
const reflectionBackendRun = {
  id: "run_fixture",
  session_id: "session_fixture",
  agent_id: "agent_fixture",
  input_message_id: "message_user",
  backend_id: "backend_fixture",
  backend_kind: "samurai_native",
  status: "completed",
  started_at: now,
  completed_at: now,
  input_summary: "Fixture user request",
  metadata: {}
};
const evaluationReport = {
  id: "evaluation_report_fixture",
  checked_at: now,
  judge: { deterministic_status: "completed", external_status: "not_configured", summary: "Fixture evaluation" },
  counts: { backend_runs: 0, backend_events: 0, workspace_changes: 0, tool_runs: 0, audit_records: 0, findings: 0, comparisons: 0 },
  run_scores: [],
  comparisons: []
};
const evaluationOutput = { reflectionRun: { ...reflectionRunRecord, kind: "evaluation" }, suggestions: [], evaluationReport, learningEvaluations: [] };
const curatorReport = {
  id: "curator_report_fixture",
  checked_at: now,
  dry_run: false,
  paused: false,
  thresholds: { stale_after_days: 30, archive_after_days: 90, min_idle_hours: 1 },
  counts: { memory_items: 0, wiki_pages: 0, skill_items: 0, skill_usage_rows: 0, suggestions: 0 },
  skill_actions: [],
  protected_skills: []
};
const curatorReviewReport = {
  id: "curator_review_fixture",
  checked_at: now,
  dry_run: false,
  counts: { keep_candidates: 0, patch_candidates: 0, consolidate_candidates: 0, archive_candidates: 0 },
  keep_candidates: [],
  memory_merge_groups: [],
  skill_consolidation_groups: [],
  wiki_patch_proposals: [],
  archive_candidates: []
};
const curatorOutput = {
  reflectionRun: { ...reflectionRunRecord, kind: "curator" },
  suggestions: [],
  curatorReport,
  curatorReviewReport
};
const automationJob = {
  id: "automation_job_fixture",
  title: "Fixture translation job",
  kind: "resource_translation",
  status: "active",
  schedule: "once",
  target_instruction: "Fixture",
  delivery_target: {},
  failure_count: 0,
  max_attempts: 3,
  created_at: now,
  updated_at: now
};
const translation = {
  id: "translation_fixture",
  source_ref: resourceRef,
  source_locale: "en",
  target_locale: "ja",
  status: "verified",
  original_hash: "hash_fixture",
  translated_text: "翻訳済み",
  provenance,
  created_at: now,
  updated_at: now
};
const objective = {
  id: "objective_fixture",
  session_id: "session_fixture",
  title: "Fixture objective",
  objective: "Complete the fixture objective",
  completion_criteria: ["fixture complete"],
  status: "active",
  created_at: now,
  updated_at: now
};
const workItem = {
  id: "work_item_fixture",
  objective_id: "objective_fixture",
  instruction: "Fixture work item",
  status: "ready",
  priority: 0,
  attempt: 0,
  max_attempts: 3,
  idempotency_key: "fixture-work-key",
  created_at: now,
  updated_at: now
};
const optimizationRun = {
  id: "optimization_run_fixture",
  target_skill_id: "skill_fixture",
  baseline_content_hash: "hash_before",
  baseline_version: "v1",
  dataset_id: "dataset_fixture",
  objective_id: "objective_fixture",
  work_item_id: "work_item_fixture",
  optimizer: "gepa",
  optimizer_version: "1.0",
  status: "completed",
  phase: "completed",
  progress: 1,
  candidate_ids: ["candidate_fixture"],
  trace_refs: [resourceRef],
  provenance: {},
  created_at: now,
  updated_at: now,
  completed_at: now
};
const optimizationCandidate = {
  id: "candidate_fixture",
  run_id: "optimization_run_fixture",
  skill_id: "skill_fixture",
  body: "# Candidate",
  content_hash: "hash_candidate",
  baseline_holdout_score: 50,
  holdout_score: 60,
  holdout_delta: 10,
  feedback: ["Fixture feedback"],
  dataset_id: "dataset_fixture",
  trace_refs: [resourceRef],
  safety: { related_tests_passed: true, safety_checks_passed: true, important_regression: false },
  status: "promoted",
  created_at: now,
  updated_at: now
};
const optimizationSnapshot = {
  id: "snapshot_fixture",
  skill_id: "skill_fixture",
  run_id: "optimization_run_fixture",
  candidate_id: "candidate_fixture",
  content_hash: "hash_before",
  markdown: "# Fixture Skill",
  created_at: now
};
const optimizationPromotion = {
  id: "promotion_fixture",
  run_id: "optimization_run_fixture",
  candidate_id: "candidate_fixture",
  skill_id: "skill_fixture",
  snapshot_id: "snapshot_fixture",
  expected_content_hash: "hash_before",
  promoted_content_hash: "hash_after",
  status: "promoted",
  provenance: {},
  created_at: now
};
const optimizationDataset = {
  id: "dataset_fixture",
  skill_id: "skill_fixture",
  examples: Array.from({ length: 20 }, (_, index) => ({
    id: `example_${index}`,
    skill_id: "skill_fixture",
    prompt: `Prompt ${index}`,
    expected_behavior: `Expected ${index}`,
    feedback: `Feedback ${index}`,
    source: index === 16 ? "golden" : "synthetic",
    split: index < 12 ? "train" : index < 16 ? "validation" : "holdout",
    ...(index === 16 ? { skill_body_read_run_id: "run_fixture" } : {}),
    trace_refs: [resourceRef],
    metadata: {},
    created_at: now
  })),
  split_counts: { train: 12, validation: 4, holdout: 4 },
  holdout_non_synthetic_count: 1,
  created_at: now
};

const definitions = new Map(operationDefinitions.map((definition) => [definition.id, definition]));
let executedCases = 0;
let executedCalls = 0;

async function main(): Promise<void> {
  assert.equal(cHandlerOperationCount, 30, "handler_matrix_c_operation_count_drift");
  assert.equal(Object.keys(cHandlerExpectations).length, 30, "handler_matrix_c_static_expectation_count_drift");
  assertSchemaCaseCoverage();
  assertHandlerBranchEvidence();

  await runCuratorCases();
  await runEvaluationCase();
  await runMemoryArchiveCase();
  await runMemoryCreateCases();
  await runMessagePresentationCases();
  await runObjectiveCases();
  await runPresentationPlanCases();
  await runReflectionRunCases();
  await runReflectionSuggestionCases();
  await runTranslationJobCases();
  await runTranslationSaveCases();
  await runSkillMutationCases();
  await runSkillLifecycleAndOptimizationCases();
  await runSkillViewCases();
  await runWikiCases();
  await runWorkItemCases();

  assert.equal(executedCases, cHandlerCaseCount, "handler_matrix_c_case_count_drift");
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    gates: ["RH06", "RH07"],
    shard: "C",
    covered_operations: cHandlerOperationCount,
    covered_operation_ids: Object.keys(cHandlerExpectations).sort(),
    remaining_operations: 0,
    cases: executedCases,
    calls: executedCalls,
    top_level_field_coverage: true,
    required_field_coverage: true,
    enum_union_branch_coverage: true,
    handler_ast_branch_evidence: true,
    expectation_mode: "static_method_args_order_count_forbidden"
  })}\n`);
}

function handlerDefinition(id: string): HandlerDefinition {
  const definition = definitions.get(id);
  assert.ok(definition, `handler_matrix_c_definition_missing:${id}`);
  return definition as unknown as HandlerDefinition;
}

interface FixtureRuntime {
  readonly tracker: DynamicValueTracker;
  record(method: string, args: unknown[]): void;
}

async function runCase(
  id: keyof typeof cHandlerExpectations,
  testCase: CHandlerCaseExpectation,
  createPorts: (fixture: FixtureRuntime) => object
): Promise<void> {
  const definition = handlerDefinition(id);
  const parsed = definition.input.safeParse(testCase.input);
  assert.equal(parsed.success, true, `handler_matrix_c_input_invalid:${id}:${testCase.id}`);
  const calls: RecordedCall[] = [];
  const tracker = new DynamicValueTracker();
  const fixture: FixtureRuntime = { tracker, record: (method, args) => calls.push({ method, args: tracker.normalize(args) }) };
  const wrapped = strictPorts(id, createPorts(fixture));
  const caseContext: TrustedDomainContext = {
    ...context,
    ...(testCase.context ?? {})
  };
  await definition.createHandler(wrapped).execute(caseContext, parsed.data as never);
  const expected = cHandlerExpectations[id].cases.find((candidate) => candidate.id === testCase.id)?.calls;
  assert.ok(expected, `handler_matrix_c_static_case_missing:${id}:${testCase.id}`);
  assert.deepEqual(calls, expected, `handler_matrix_c_port_contract_drift:${id}:${testCase.id}`);
  executedCases += 1;
  executedCalls += calls.length;
}

/** Reject accidental production-Port expansion or Handler reach-through. */
function strictPorts<T extends object>(operationId: string, ports: T): T {
  return new Proxy(ports, {
    get(target, property, receiver) {
      if (typeof property === "symbol") return Reflect.get(target, property, receiver);
      if (!Object.hasOwn(target, property)) throw new Error(`handler_matrix_c_forbidden_port:${operationId}:${property}`);
      return Reflect.get(target, property, receiver);
    }
  });
}

class DynamicValueTracker {
  private readonly tokens = new Map<string, string>();

  mark(value: unknown, token: string): void {
    if (typeof value === "string") this.tokens.set(value, token);
  }

  normalize(value: unknown): unknown {
    if (typeof value === "function") return "$function";
    if (typeof value === "string") return this.tokens.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => this.normalize(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.normalize(item)]));
  }
}

function caseFor(id: keyof typeof cHandlerExpectations, caseId: string): CHandlerCaseExpectation {
  const value = cHandlerExpectations[id].cases.find((candidate) => candidate.id === caseId);
  assert.ok(value, `handler_matrix_c_case_not_declared:${id}:${caseId}`);
  return value;
}

function markGeneratedObjective(tracker: DynamicValueTracker, value: Record<string, unknown>): void {
  assert.match(String(value.id), /^objective_[a-z0-9_-]+$/i, "objective.create must create an objective id");
  assert.match(String(value.created_at), /^\d{4}-\d{2}-\d{2}T/, "objective.create must stamp creation time");
  tracker.mark(value.id, "$generated:objective-id");
  markGeneratedObjectiveTimes(tracker, value);
}

function markGeneratedObjectiveTimes(tracker: DynamicValueTracker, value: Record<string, unknown>): void {
  assert.match(String(value.created_at), /^\d{4}-\d{2}-\d{2}T/, "objective.create must stamp creation time");
  tracker.mark(value.created_at, "$generated:time");
  tracker.mark(value.updated_at, "$generated:time");
}

function markGeneratedWorkItem(tracker: DynamicValueTracker, value: Record<string, unknown>): void {
  assert.match(String(value.id), /^work_[a-z0-9_-]+$/i, "work_item.create must create a work id");
  assert.match(String(value.idempotency_key), /^objective_fixture:/, "work_item.create must derive a stable objective key");
  tracker.mark(value.id, "$generated:work-item-id");
  tracker.mark(value.idempotency_key, "$generated:work-idempotency-key");
  markWorkItemTimes(tracker, value);
}

function markWorkItemTimes(tracker: DynamicValueTracker, value: Record<string, unknown>): void {
  assert.match(String(value.created_at), /^\d{4}-\d{2}-\d{2}T/, "work_item.create must stamp creation time");
  tracker.mark(value.created_at, "$generated:time");
  tracker.mark(value.updated_at, "$generated:time");
}

function markGeneratedOperation(tracker: DynamicValueTracker, value: Record<string, unknown>): void {
  assert.match(String(value.id), /^operation_[a-z0-9_-]+$/i, "operation id must be generated");
  tracker.mark(value.id, "$generated:operation-id");
  tracker.mark(value.input_hash, "$generated:input-hash");
  tracker.mark(value.created_at, "$generated:time");
  tracker.mark(value.updated_at, "$generated:time");
}

function markGeneratedSkillSave(tracker: DynamicValueTracker, value: Record<string, unknown>): void {
  assert.match(String(value.skillId), /^skill_[a-z0-9_-]+$/i, "skill mutation must generate a skill id");
  assert.match(String(value.markdown), /^---\n/, "skill mutation must render frontmatter markdown");
  tracker.mark(value.skillId, "$generated:skill-id");
  tracker.mark(value.markdown, "$generated:skill-markdown");
}

function markGeneratedWiki(tracker: DynamicValueTracker, value: Record<string, unknown>): void {
  assert.match(String(value.id), /^wiki_[a-z0-9_-]+$/i, "wiki proposal must generate an id");
  tracker.mark(value.id, "$generated:wiki-id");
  tracker.mark(value.created_at, "$generated:time");
  tracker.mark(value.updated_at, "$generated:time");
}

async function runCuratorCases(): Promise<void> {
  for (const caseId of ["idle-gate-omitted", "idle-gate-enabled", "reason-driven-resource"] as const) {
    const testCase = caseFor("curator.run", caseId);
    await runCase("curator.run", testCase, (fixture) => ({
      runCurator(input: unknown) {
        fixture.record("runCurator", [input]);
        return curatorOutput;
      }
    }));
  }
}

async function runEvaluationCase(): Promise<void> {
  const testCase = caseFor("evaluation.run", "source-run");
  const evaluationRunRecord = {
    id: "reflection_evaluation_fixture",
    kind: "evaluation",
    session_id: "session_fixture",
    status: "started",
    input_summary: "Fixture evaluation run",
    started_at: now
  };
  await runCase("evaluation.run", testCase, (fixture) => ({
    runAppliedEvaluation: async (input: unknown) => { fixture.record("runAppliedEvaluation", [input]); return evaluationOutput; },
    ensureEvaluationSession: async () => {
      fixture.record("ensureEvaluationSession", []);
      return { id: "session_fixture" };
    },
    listEvaluationSkills: async () => { fixture.record("listEvaluationSkills", []); return []; },
    listEvaluationBackendRuns: async () => { fixture.record("listEvaluationBackendRuns", []); return []; },
    listEvaluationBackendEvents: async () => { fixture.record("listEvaluationBackendEvents", []); return []; },
    listEvaluationWorkspaceChanges: async () => { fixture.record("listEvaluationWorkspaceChanges", []); return []; },
    listEvaluationToolRuns: async () => { fixture.record("listEvaluationToolRuns", []); return []; },
    listEvaluationAuditRecords: async () => { fixture.record("listEvaluationAuditRecords", []); return []; },
    listLearningResourceUses: async () => { fixture.record("listLearningResourceUses", []); return []; },
    listExistingLearningEvaluations: async () => { fixture.record("listExistingLearningEvaluations", []); return []; },
    evaluationNow: () => { fixture.record("evaluationNow", []); return now; },
    createEvaluationId(prefix: unknown) {
      fixture.record("createEvaluationId", [prefix]);
      return prefix === "reflection" ? "reflection_evaluation_fixture" : prefix === "learning_job_report" ? "learning_job_report_fixture" : "learning_evaluation_fixture";
    },
    createEvaluationReflectionRun: async (value: unknown) => {
      fixture.record("createEvaluationReflectionRun", [value]);
      return evaluationRunRecord;
    },
    createEvaluationSuggestions: (run: unknown, input: unknown) => {
      fixture.record("createEvaluationSuggestions", [run, input]);
      return [];
    },
    createEvaluationReport: async (input: unknown) => {
      fixture.record("createEvaluationReport", [input]);
      return evaluationReport;
    },
    actualLearningUses: (value: unknown) => { fixture.record("actualLearningUses", [value]); return []; },
    evaluateLearningEffect: (value: unknown) => { fixture.record("evaluateLearningEffect", [value]); throw new Error("evaluation fixture has no uses"); },
    saveLearningEvaluation: async (value: unknown) => { fixture.record("saveLearningEvaluation", [value]); throw new Error("evaluation fixture has no uses"); },
    saveEvaluationSuggestion: async (value: unknown) => { fixture.record("saveEvaluationSuggestion", [value]); throw new Error("evaluation fixture has no suggestions"); },
    updateEvaluationReflectionRun: async (value: unknown) => {
      fixture.record("updateEvaluationReflectionRun", [value]);
      return value;
    },
    saveEvaluationJobReport: async (value: unknown) => {
      fixture.record("saveEvaluationJobReport", [value]);
      return value;
    },
    nextEvaluationRunAt: (from: unknown) => { fixture.record("nextEvaluationRunAt", [from]); return "2026-07-18T00:00:00.000Z"; }
  }));
}

async function runMemoryArchiveCase(): Promise<void> {
  const testCase = caseFor("memory.archive", "session-linked-memory");
  const archiveBefore = { frontmatter: memory, file_path: "memory/memory_fixture.md" };
  const archived = { ...memory, state: "archived", updated_at: now };
  const archiveAfter = { frontmatter: archived, file_path: "memory/memory_fixture.md" };
  await runCase("memory.archive", testCase, (fixture) => ({
    getMemorySession: async (id: unknown) => { fixture.record("getMemorySession", [id]); return session; },
    getMemoryForArchive: async (id: unknown) => { fixture.record("getMemoryForArchive", [id]); return { ...memory, file_path: "memory/memory_fixture.md" }; },
    listMemoryForSession: async (id: unknown) => { fixture.record("listMemoryForSession", [id]); return [{ ...memory, file_path: "memory/memory_fixture.md" }]; },
    memoryResourceRef: (value: unknown) => {
      fixture.record("memoryResourceRef", [value]);
      const candidate = value as { id: string };
      return { kind: "memory", id: candidate.id, uri: "memory/memory_fixture.md", label: "fixture-memory" };
    },
    memoryArchiveCapabilityId: () => { fixture.record("memoryArchiveCapabilityId", []); return "memory"; },
    saveMemoryArchiveOperation: async (value: unknown) => {
      markGeneratedOperation(fixture.tracker, value as Record<string, unknown>);
      fixture.record("saveMemoryArchiveOperation", [value]);
      return value;
    },
    emitMemoryArchiveOperation: async (value: unknown) => { fixture.record("emitMemoryArchiveOperation", [value]); },
    archiveMemoryRecord: async (id: unknown) => {
      fixture.record("archiveMemoryRecord", [id]);
      return { before: archiveBefore, after: archiveAfter, content: "Archived fixture content", changed: true };
    },
    createMemoryArchiveRollback: async (value: unknown, refs: unknown, before: unknown, after: unknown) => {
      fixture.record("createMemoryArchiveRollback", [value, refs, before, after]);
      return rollbackPoint;
    },
    updateMemoryArchiveOperation: async (value: unknown) => {
      fixture.tracker.mark((value as Record<string, unknown>).updated_at, "$generated:time");
      fixture.record("updateMemoryArchiveOperation", [value]);
      return value;
    },
    rebuildMemoryActivity: async () => { fixture.record("rebuildMemoryActivity", []); return []; },
    memoryArchiveError: (code: unknown, message: unknown) => { fixture.record("memoryArchiveError", [code, message]); return new Error(String(message)); }
  }));
}

function memoryCreatePorts(fixture: FixtureRuntime, kind: "session" | "topic"): object {
  const createdMemory = { ...memory, state: kind === "session" ? "session" : "topic" };
  return {
    getMemorySession: async (id: unknown) => { fixture.record("getMemorySession", [id]); return session; },
    createMemorySession: async (input: unknown) => { fixture.record("createMemorySession", [input]); return session; },
    ensureMemorySession: async () => { fixture.record("ensureMemorySession", []); return session; },
    memoryCreateError: (message: unknown) => { fixture.record("memoryCreateError", [message]); return new Error(String(message)); },
    createMemoryEnvelope: (input: unknown) => { fixture.record("createMemoryEnvelope", [input]); return envelope; },
    writeSessionMemory: async (message: unknown, content: unknown) => { fixture.record("writeSessionMemory", [message, content]); return createdMemory; },
    writeTopicMemory: async (message: unknown, topic: unknown, content: unknown) => { fixture.record("writeTopicMemory", [message, topic, content]); return createdMemory; },
    memoryResourceRef: (value: unknown) => { fixture.record("memoryResourceRef", [value]); return { kind: "memory", id: "memory_fixture", uri: "memory/memory_fixture.md", label: "fixture-memory" }; },
    createMemoryRollback: async (value: unknown, refs: unknown, after: unknown) => { fixture.record("createMemoryRollback", [value, refs, after]); return rollbackPoint; },
    emitMemoryCandidate: async (value: unknown) => { fixture.record("emitMemoryCandidate", [value]); },
    runMemoryMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
      fixture.record("runMemoryMutation", [input]);
      const executed = await input.execute(operation);
      return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
    }
  };
}

async function runMemoryCreateCases(): Promise<void> {
  await runCase("memory.session.create", caseFor("memory.session.create", "existing-session-all-fields"), (fixture) => memoryCreatePorts(fixture, "session"));
  await runCase("memory.session.create", caseFor("memory.session.create", "create-session-defaults"), (fixture) => memoryCreatePorts(fixture, "session"));
  await runCase("memory.topic.create", caseFor("memory.topic.create", "explicit-kind-all-fields"), (fixture) => memoryCreatePorts(fixture, "topic"));
}

async function runMessagePresentationCases(): Promise<void> {
  const presentation = {
    id: "presentation_fixture",
    collection_id: "collection_fixture",
    view_id: "view_stored",
    view_state: {},
    created_at: now,
    updated_at: now
  };
  const renderSpec = { kind: "collection", collection_id: "collection_fixture", view_id: "view_explicit", title: "Fixture collection", columns: [], rows: [] };
  for (const caseId of ["explicit-view-id", "fallback-to-stored-view"] as const) {
    await runCase("message.presentation.update", caseFor("message.presentation.update", caseId), (fixture) => ({
      getMessagePresentation: async (id: unknown) => { fixture.record("getMessagePresentation", [id]); return presentation; },
      presentCollectionView: async (input: unknown) => { fixture.record("presentCollectionView", [input]); return { render_spec: renderSpec }; },
      applyPresentationViewState: (spec: unknown, viewState: unknown) => { fixture.record("applyPresentationViewState", [spec, viewState]); return { ...renderSpec, view_state: viewState }; },
      presentationViewStateFromSpec: (spec: unknown) => { fixture.record("presentationViewStateFromSpec", [spec]); return (spec as { view_state?: Record<string, unknown> }).view_state ?? {}; },
      updateMessagePresentationViewState: async (input: unknown) => { fixture.record("updateMessagePresentationViewState", [input]); return presentation; },
      messagePresentationNotFoundError: (id: unknown) => { fixture.record("messagePresentationNotFoundError", [id]); return new Error(String(id)); }
    }));
  }
}

async function runObjectiveCases(): Promise<void> {
  await runCase("objective.create", caseFor("objective.create", "all-public-fields"), (fixture) => ({
    saveObjective: async (value: unknown) => { markGeneratedObjectiveTimes(fixture.tracker, value as Record<string, unknown>); fixture.record("saveObjective", [value]); return value; }
  }));
  await runCase("objective.create", caseFor("objective.create", "generated-defaults"), (fixture) => ({
    saveObjective: async (value: unknown) => {
      markGeneratedObjective(fixture.tracker, value as Record<string, unknown>);
      fixture.record("saveObjective", [value]);
      return value;
    }
  }));
}

async function runPresentationPlanCases(): Promise<void> {
  for (const caseId of ["built-in", "generated"] as const) {
    await runCase("presentation.plan", caseFor("presentation.plan", caseId), () => ({}));
  }
}

async function runReflectionRunCases(): Promise<void> {
  const messages = [
    { id: "message_user", session_id: "session_fixture", role: "user", content: "Fixture user request", input_locale: "en", output_locale: "ja", created_at: now },
    { id: "message_agent", session_id: "session_fixture", role: "agent", content: "Fixture agent answer", input_locale: "en", output_locale: "ja", created_at: now }
  ];
  const reflectionOutput = { reflectionRun: reflectionRunRecord, suggestions: [] };
  for (const caseId of ["session-scope", "backend-run-scope"] as const) {
    await runCase("reflection.run", caseFor("reflection.run", caseId), (fixture) => ({
      getReflectionSession: async (id: unknown) => { fixture.record("getReflectionSession", [id]); return session; },
      reflectionSessionNotFoundError: (id: unknown) => { fixture.record("reflectionSessionNotFoundError", [id]); return new Error(String(id)); },
      getReflectionBackendRun: async (id: unknown) => { fixture.record("getReflectionBackendRun", [id]); return String(id) === reflectionBackendRun.id ? reflectionBackendRun : undefined; },
      reflectionSourceRunNotFoundError: (id: unknown) => { fixture.record("reflectionSourceRunNotFoundError", [id]); return new Error(String(id)); },
      reflectionSourceRunSessionMismatchError: (input: unknown) => { fixture.record("reflectionSourceRunSessionMismatchError", [input]); return new Error("reflection_source_run_session_mismatch"); },
      listReflectionMessages: async (id: unknown) => { fixture.record("listReflectionMessages", [id]); return messages; },
      listReflectionToolRuns: async (id: unknown) => { fixture.record("listReflectionToolRuns", [id]); return []; },
      listReflectionWorkspaceChanges: async (id: unknown) => { fixture.record("listReflectionWorkspaceChanges", [id]); return []; },
      listReflectionBackendEvents: async (input: unknown) => { fixture.record("listReflectionBackendEvents", [input]); return []; },
      loadReflectionArtifacts: async (input: unknown) => { fixture.record("loadReflectionArtifacts", [input]); return []; },
      executeReflectionWorkflow: async (input: unknown) => { fixture.record("executeReflectionWorkflow", [input]); return reflectionOutput; }
    }));
  }
}

function suggestionFor(kind: "memory" | "knowledge_wiki" | "skill") {
  return {
    ...reflectionSuggestion,
    id: `suggestion_${kind === "knowledge_wiki" ? "wiki" : kind}`,
    suggestion_type: kind
  };
}

async function runReflectionSuggestionCases(): Promise<void> {
  const cases = [
    ["memory", "memory"],
    ["wiki", "knowledge_wiki"],
    ["skill", "skill"]
  ] as const;
  for (const [caseId, kind] of cases) {
    const suggestion = suggestionFor(kind);
    const target = kind === "memory" ? memory : kind === "knowledge_wiki" ? storedWiki : storedSkill;
    const targetRef = kind === "memory"
      ? { kind: "memory", id: memory.id, uri: "memory/memory_fixture.md", label: memory.topic }
      : kind === "knowledge_wiki"
        ? { kind: "wiki", id: storedWiki.id, uri: storedWiki.file_path, label: storedWiki.title }
        : { kind: "skill", id: storedSkill.id, uri: storedSkill.file_path, label: storedSkill.title };
    await runCase("reflection.suggestion.apply", caseFor("reflection.suggestion.apply", caseId), (fixture) => ({
      getReflectionSuggestion: async (sessionId: unknown, suggestionId: unknown) => {
        fixture.record("getReflectionSuggestion", [sessionId, suggestionId]);
        return sessionId === "session_fixture" && suggestionId === suggestion.id ? suggestion : undefined;
      },
      reflectionSuggestionError: (code: unknown, message: unknown) => { fixture.record("reflectionSuggestionError", [code, message]); return new Error(String(message)); },
      ensureReflectionMutationSession: async () => { fixture.record("ensureReflectionMutationSession", []); return session; },
      createReflectionMutationEnvelope: (content: unknown) => { fixture.record("createReflectionMutationEnvelope", [content]); return envelope; },
      runReflectionSuggestionMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
        fixture.record("runReflectionSuggestionMutation", [input]);
        const executed = await input.execute(operation);
        return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
      },
      createReflectionMemoryTarget: async (input: unknown) => { fixture.record("createReflectionMemoryTarget", [input]); return { resource: memory, ref: targetRef }; },
      createReflectionWikiTarget: async (input: unknown) => { fixture.record("createReflectionWikiTarget", [input]); return { resource: storedWiki, ref: targetRef }; },
      createReflectionSkillTarget: async (input: unknown) => { fixture.record("createReflectionSkillTarget", [input]); return { resource: storedSkill, ref: targetRef }; },
      createReflectionTargetRollback: async (value: unknown, refs: unknown, after: unknown) => { fixture.record("createReflectionTargetRollback", [value, refs, after]); return rollbackPoint; },
      updateReflectionSuggestion: async (value: unknown) => { fixture.record("updateReflectionSuggestion", [value]); return value; },
      reflectionNow: () => { fixture.record("reflectionNow", []); return now; }
    }));
  }
}

function translationSourceFor(input: Record<string, unknown>) {
  const ref = input.source_ref as Record<string, unknown>;
  return { ref, source_locale: ref.kind === "artifact" ? "ja" : ref.kind === "wiki" || ref.kind === "skill" ? "en" : undefined, content: ref.kind === "skill" ? "---\n{}\n---\nSkill body" : `Source body for ${String(ref.kind)}` };
}

async function runTranslationJobCases(): Promise<void> {
  const caseIds = ["artifact-all-options", "memory", "wiki", "skill", "collection-record"] as const;
  for (const caseId of caseIds) {
    const testCase = caseFor("resource.translation_job.save", caseId);
    const source = translationSourceFor(testCase.input);
    const kind = String((testCase.input.source_ref as Record<string, unknown>).kind);
    await runCase("resource.translation_job.save", testCase, (fixture) => ({
      loadArtifactTranslationSource: async (id: unknown) => { fixture.record("loadArtifactTranslationSource", [id]); return kind === "artifact" ? source : undefined; },
      loadMemoryTranslationSource: async (id: unknown) => { fixture.record("loadMemoryTranslationSource", [id]); return kind === "memory" ? source : undefined; },
      loadWikiTranslationSource: async (id: unknown) => { fixture.record("loadWikiTranslationSource", [id]); return kind === "wiki" ? source : undefined; },
      loadSkillTranslationSource: async (id: unknown) => { fixture.record("loadSkillTranslationSource", [id]); return kind === "skill" ? source : undefined; },
      loadCollectionRecordTranslationSource: async (ref: unknown) => { fixture.record("loadCollectionRecordTranslationSource", [ref]); return kind === "collection_record" ? source : undefined; },
      stripTranslationSkillFrontmatter: (content: unknown) => { fixture.record("stripTranslationSkillFrontmatter", [content]); return "Skill body"; },
      hashTranslationContent: (content: unknown) => { fixture.record("hashTranslationContent", [content]); return "hash_translation_fixture"; },
      saveTranslationAutomationJob: async (input: unknown) => { fixture.record("saveTranslationAutomationJob", [input]); return { resource: automationJob, operation, activity: [] }; },
      translationSourceNotFoundError: (ref: unknown) => { fixture.record("translationSourceNotFoundError", [ref]); return new Error("translation_source_not_found"); }
    }));
  }
}

async function runTranslationSaveCases(): Promise<void> {
  for (const caseId of ["all-public-fields", "draft", "missing"] as const) {
    const testCase = caseFor("resource.translation.save", caseId);
    await runCase("resource.translation.save", testCase, (fixture) => ({
      saveResourceTranslation: async (input: unknown) => { fixture.record("saveResourceTranslation", [input]); return { ...translation, status: (input as { status: string }).status }; }
    }));
  }
}

function skillMutationContract(id: string) {
  return { id, proposed_effects: [`Fixture effect for ${id}`] };
}

function skillRef(value: { id: string; file_path: string; title: string }) {
  return { kind: "skill", id: value.id, uri: value.file_path, label: value.title };
}

function skillMutationResult<T>(resource: T, rollback = rollbackPoint) {
  return { resource, operation, rollbackPoint: rollback, activity: [] };
}

function candidateMarkdown(): string {
  return [
    "---",
    JSON.stringify({
      id: "candidate_fixture",
      state: "candidate",
      title: "Candidate Skill",
      description: "Candidate description",
      tags: ["fixture"],
      provenance: "fixture",
      trust_level: "user_authored",
      allowed_scopes: ["skill"],
      required_capabilities: [],
      schedule_policy: {},
      secret_policy: {},
      owner_pinned: false
    }, null, 2),
    "---",
    "# Candidate",
    ""
  ].join("\n");
}

async function runSkillMutationCases(): Promise<void> {
  await runCase("skill.candidate.create", caseFor("skill.candidate.create", "all-public-fields"), (fixture) => ({
    skillMutationContract: (id: unknown) => { fixture.record("skillMutationContract", [id]); return skillMutationContract(String(id)); },
    ensureSkillMutationSession: async () => { fixture.record("ensureSkillMutationSession", []); return session; },
    createSkillMutationEnvelope: (content: unknown) => { fixture.record("createSkillMutationEnvelope", [content]); return envelope; },
    runSkillMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
      fixture.record("runSkillMutation", [input]);
      const executed = await input.execute(operation);
      return skillMutationResult(executed.resource, executed.rollbackPoint as typeof rollbackPoint);
    },
    saveSkillMarkdown: async (input: unknown) => {
      markGeneratedSkillSave(fixture.tracker, input as Record<string, unknown>);
      fixture.record("saveSkillMarkdown", [input]);
      const value = input as { skillId: string };
      return { ...storedSkill, id: value.skillId, state: "candidate", frontmatter: { ...storedSkill.frontmatter, id: value.skillId, state: "candidate" } };
    },
    skillResourceRef: (value: unknown) => { fixture.record("skillResourceRef", [value]); return skillRef(value as typeof storedSkill); },
    createSkillRollback: async (value: unknown, refs: unknown, before: unknown, after: unknown) => { fixture.record("createSkillRollback", [value, refs, before, after]); return rollbackPoint; },
    skillMutationNotFound: (message: unknown) => { fixture.record("skillMutationNotFound", [message]); return new Error(String(message)); },
    skillMutationConflict: (message: unknown) => { fixture.record("skillMutationConflict", [message]); return new Error(String(message)); }
  }));

  await runCase("skill.patch", caseFor("skill.patch", "all-public-fields"), (fixture) => ({
    getSkillForMutation: async (id: unknown) => { fixture.record("getSkillForMutation", [id]); return storedSkill; },
    readSkillMarkdown: async (id: unknown) => { fixture.record("readSkillMarkdown", [id]); return "# Old skill body"; },
    skillMutationContract: (id: unknown) => { fixture.record("skillMutationContract", [id]); return skillMutationContract(String(id)); },
    ensureSkillMutationSession: async () => { fixture.record("ensureSkillMutationSession", []); return session; },
    createSkillMutationEnvelope: (content: unknown) => { fixture.record("createSkillMutationEnvelope", [content]); return envelope; },
    skillResourceRef: (value: unknown) => { fixture.record("skillResourceRef", [value]); return skillRef(value as typeof storedSkill); },
    runSkillMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
      fixture.record("runSkillMutation", [input]);
      const executed = await input.execute(operation);
      return skillMutationResult(executed.resource, executed.rollbackPoint as typeof rollbackPoint);
    },
    patchSkillRecord: async (input: unknown) => {
      fixture.record("patchSkillRecord", [input]);
      const patch = input as { title?: string; description?: string; tags?: string[] };
      return { ...storedSkill, title: patch.title ?? storedSkill.title, description: patch.description ?? storedSkill.description, tags: patch.tags ?? storedSkill.tags,
        frontmatter: { ...storedSkill.frontmatter, title: patch.title ?? storedSkill.title, description: patch.description ?? storedSkill.description, tags: patch.tags ?? storedSkill.tags } };
    },
    createSkillRollback: async (value: unknown, refs: unknown, before: unknown, after: unknown) => { fixture.record("createSkillRollback", [value, refs, before, after]); return rollbackPoint; },
    skillMutationNotFound: (message: unknown) => { fixture.record("skillMutationNotFound", [message]); return new Error(String(message)); },
    skillMutationConflict: (message: unknown) => { fixture.record("skillMutationConflict", [message]); return new Error(String(message)); }
  }));

  await runCase("skill.project.save", caseFor("skill.project.save", "candidate"), (fixture) => ({
    readSkillMarkdown: async (id: unknown) => { fixture.record("readSkillMarkdown", [id]); return candidateMarkdown(); },
    skillMutationContract: (id: unknown) => { fixture.record("skillMutationContract", [id]); return skillMutationContract(String(id)); },
    ensureSkillMutationSession: async () => { fixture.record("ensureSkillMutationSession", []); return session; },
    createSkillMutationEnvelope: (content: unknown) => { fixture.record("createSkillMutationEnvelope", [content]); return envelope; },
    runSkillMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
      fixture.record("runSkillMutation", [input]);
      const executed = await input.execute(operation);
      return skillMutationResult(executed.resource, executed.rollbackPoint as typeof rollbackPoint);
    },
    saveSkillMarkdown: async (input: unknown) => {
      markGeneratedSkillSave(fixture.tracker, input as Record<string, unknown>);
      fixture.record("saveSkillMarkdown", [input]);
      const value = input as { skillId: string };
      return { ...storedSkill, id: value.skillId, title: "Candidate Skill", state: "project", frontmatter: { ...storedSkill.frontmatter, id: value.skillId, title: "Candidate Skill", state: "project" } };
    },
    skillResourceRef: (value: unknown) => { fixture.record("skillResourceRef", [value]); return skillRef(value as typeof storedSkill); },
    createSkillRollback: async (value: unknown, refs: unknown, before: unknown, after: unknown) => { fixture.record("createSkillRollback", [value, refs, before, after]); return rollbackPoint; },
    skillMutationNotFound: (message: unknown) => { fixture.record("skillMutationNotFound", [message]); return new Error(String(message)); },
    skillMutationConflict: (message: unknown) => { fixture.record("skillMutationConflict", [message]); return new Error(String(message)); }
  }));

  await runCase("skill.support_file.save", caseFor("skill.support_file.save", "all-public-fields"), (fixture) => ({
    getSkillForMutation: async (id: unknown) => { fixture.record("getSkillForMutation", [id]); return storedSkill; },
    listSkillSupportFiles: async (id: unknown) => { fixture.record("listSkillSupportFiles", [id]); return [{ path: "references/guide.md", file_path: "skills/skill_fixture/references/guide.md", content: "Old support content" }]; },
    skillMutationContract: (id: unknown) => { fixture.record("skillMutationContract", [id]); return skillMutationContract(String(id)); },
    ensureSkillMutationSession: async () => { fixture.record("ensureSkillMutationSession", []); return session; },
    createSkillMutationEnvelope: (content: unknown) => { fixture.record("createSkillMutationEnvelope", [content]); return envelope; },
    skillResourceRef: (value: unknown) => { fixture.record("skillResourceRef", [value]); return skillRef(value as typeof storedSkill); },
    runSkillMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
      fixture.record("runSkillMutation", [input]);
      const executed = await input.execute(operation);
      return skillMutationResult(executed.resource, executed.rollbackPoint as typeof rollbackPoint);
    },
    writeSkillSupportFile: async (input: unknown) => {
      fixture.record("writeSkillSupportFile", [input]);
      const value = input as { path: string; content: string };
      return { path: value.path, file_path: `skills/skill_fixture/${value.path}`, content: value.content };
    },
    createSkillRollback: async (value: unknown, refs: unknown, before: unknown, after: unknown) => { fixture.record("createSkillRollback", [value, refs, before, after]); return rollbackPoint; },
    skillMutationNotFound: (message: unknown) => { fixture.record("skillMutationNotFound", [message]); return new Error(String(message)); },
    skillMutationConflict: (message: unknown) => { fixture.record("skillMutationConflict", [message]); return new Error(String(message)); }
  }));
}

async function runSkillLifecycleAndOptimizationCases(): Promise<void> {
  for (const caseId of ["mark-stale", "archive", "reactivate"] as const) {
    await runCase("skill.lifecycle.apply", caseFor("skill.lifecycle.apply", caseId), (fixture) => ({
      applySkillLifecycle: async (input: unknown) => {
        fixture.record("applySkillLifecycle", [input]);
        return { resource: storedSkill, operation, activity: [] };
      }
    }));
  }

  for (const caseId of ["defaults", "all-options"] as const) {
    await runCase("skill.optimization.start", caseFor("skill.optimization.start", caseId), (fixture) => ({
      startSkillOptimization: async (input: unknown) => {
        fixture.record("startSkillOptimization", [input]);
        return { run: optimizationRun, dataset: optimizationDataset, objective, work_item: workItem };
      }
    }));
  }

  await runCase("skill.optimization.cancel", caseFor("skill.optimization.cancel", "run"), (fixture) => ({
    cancelSkillOptimization: async (input: unknown) => { fixture.record("cancelSkillOptimization", [input]); return optimizationRun; }
  }));
  await runCase("skill.optimization.promote", caseFor("skill.optimization.promote", "candidate"), (fixture) => ({
    promoteSkillOptimization: async (input: unknown) => { fixture.record("promoteSkillOptimization", [input]); return { run: optimizationRun, skill: storedSkill, candidate: optimizationCandidate, snapshot: optimizationSnapshot, promotion: optimizationPromotion }; }
  }));
  await runCase("skill.optimization.reject", caseFor("skill.optimization.reject", "candidate"), (fixture) => ({
    rejectSkillOptimization: async (input: unknown) => { fixture.record("rejectSkillOptimization", [input]); return { run: optimizationRun, candidate: { ...optimizationCandidate, status: "rejected" } }; }
  }));
  for (const caseId of ["promotion-only", "snapshot-only", "both"] as const) {
    await runCase("skill.optimization.rollback", caseFor("skill.optimization.rollback", caseId), (fixture) => ({
      rollbackSkillOptimization: async (input: unknown) => { fixture.record("rollbackSkillOptimization", [input]); return { skill: storedSkill, snapshot: optimizationSnapshot, promotion: optimizationPromotion }; }
    }));
  }
}

async function runSkillViewCases(): Promise<void> {
  for (const caseId of ["body", "support-file"] as const) {
    await runCase("skill.view", caseFor("skill.view", caseId), (fixture) => ({
      viewSkill: async (input: unknown) => {
        fixture.record("viewSkill", [input]);
        const path = (input as { path?: string }).path;
        return {
          skill: storedSkill,
          content: path ? "Support content" : "# Fixture Skill",
          file_refs: [{ path: "references/guide.md", file_path: "skills/skill_fixture/references/guide.md" }],
          disclosure_level: path ? "support" : "body",
          usage: { skill_id: "skill_fixture", run_id: "run_fixture", resource_id: "skill_fixture", content_hash: "hash_fixture", stage: path ? "support_loaded" : "body_loaded", metadata: path ? { skill_id: "skill_fixture", path } : { skill_id: "skill_fixture" } }
        };
      }
    }));
  }
}

function wikiRef(value: { id: string; file_path: string; title: string }) {
  return { kind: "wiki", id: value.id, uri: value.file_path, label: value.title };
}

function wikiMutationResult<T>(resource: T, rollback = rollbackPoint) {
  return { resource, operation, rollbackPoint: rollback, activity: [] };
}

async function runWikiCases(): Promise<void> {
  const stateCases = [
    ["wiki.accept", "active", "active"],
    ["wiki.archive", "archived", "archived"],
    ["wiki.reject", "rejected", "rejected"]
  ] as const;
  for (const [id, caseId, state] of stateCases) {
    await runCase(id, caseFor(id, caseId), (fixture) => ({
      getWikiPage: async (wikiId: unknown) => { fixture.record("getWikiPage", [wikiId]); return storedWiki; },
      ensureWikiSession: async () => { fixture.record("ensureWikiSession", []); return session; },
      createWikiEnvelope: (content: unknown) => { fixture.record("createWikiEnvelope", [content]); return envelope; },
      runWikiMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
        fixture.record("runWikiMutation", [input]);
        const executed = await input.execute(operation);
        return wikiMutationResult(executed.resource, executed.rollbackPoint as typeof rollbackPoint);
      },
      setWikiPageState: async (wikiId: unknown, nextState: unknown) => {
        fixture.record("setWikiPageState", [wikiId, nextState]);
        return { ...storedWiki, state };
      },
      createWikiRollback: async (value: unknown, refs: unknown, before: unknown, after: unknown) => { fixture.record("createWikiRollback", [value, refs, before, after]); return rollbackPoint; },
      wikiPageNotFoundError: (wikiId: unknown) => { fixture.record("wikiPageNotFoundError", [wikiId]); return new Error(String(wikiId)); }
    }));
  }

  await runCase("wiki.patch", caseFor("wiki.patch", "all-public-fields"), (fixture) => ({
    getWikiPage: async (wikiId: unknown) => { fixture.record("getWikiPage", [wikiId]); return storedWiki; },
    readWikiContent: async (wikiId: unknown) => { fixture.record("readWikiContent", [wikiId]); return "Old wiki content"; },
    ensureWikiSession: async () => { fixture.record("ensureWikiSession", []); return session; },
    createWikiEnvelope: (content: unknown) => { fixture.record("createWikiEnvelope", [content]); return envelope; },
    runWikiMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
      fixture.record("runWikiMutation", [input]);
      const executed = await input.execute(operation);
      return wikiMutationResult(executed.resource, executed.rollbackPoint as typeof rollbackPoint);
    },
    updateWikiPage: async (input: unknown) => {
      fixture.record("updateWikiPage", [input]);
      const patch = input as { title?: string; tags?: string[]; content_locale?: string; source_refs?: unknown[]; provenance?: typeof provenance };
      return { ...storedWiki, title: patch.title ?? storedWiki.title, tags: patch.tags ?? storedWiki.tags, content_locale: patch.content_locale ?? storedWiki.content_locale, source_refs: patch.source_refs ?? storedWiki.source_refs, provenance: patch.provenance ?? storedWiki.provenance };
    },
    createWikiRollback: async (value: unknown, refs: unknown, before: unknown, after: unknown) => { fixture.record("createWikiRollback", [value, refs, before, after]); return rollbackPoint; },
    wikiPageNotFoundError: (wikiId: unknown) => { fixture.record("wikiPageNotFoundError", [wikiId]); return new Error(String(wikiId)); }
  }));

  await runCase("wiki.proposal.create", caseFor("wiki.proposal.create", "all-public-fields"), (fixture) => ({
    ensureWikiSession: async () => { fixture.record("ensureWikiSession", []); return session; },
    createWikiEnvelope: (content: unknown) => { fixture.record("createWikiEnvelope", [content]); return envelope; },
    runWikiMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
      fixture.record("runWikiMutation", [input]);
      const executed = await input.execute(operation);
      return wikiMutationResult(executed.resource, executed.rollbackPoint as typeof rollbackPoint);
    },
    saveWikiPage: async (record: unknown, content: unknown) => {
      markGeneratedWiki(fixture.tracker, record as Record<string, unknown>);
      fixture.record("saveWikiPage", [record, content]);
      const value = record as { id: string; slug: string; title: string; tags: string[]; content_locale: string; source_refs: unknown[]; provenance: typeof provenance; created_at: string; updated_at: string };
      return { ...storedWiki, ...value, file_path: `wiki/${value.slug}.md` };
    },
    createWikiRollback: async (value: unknown, refs: unknown, before: unknown, after: unknown) => { fixture.record("createWikiRollback", [value, refs, before, after]); return rollbackPoint; }
  }));

  await runCase("wiki.reindex", caseFor("wiki.reindex", "empty-input"), (fixture) => ({
    ensureWikiSession: async () => { fixture.record("ensureWikiSession", []); return session; },
    createWikiEnvelope: (content: unknown) => { fixture.record("createWikiEnvelope", [content]); return envelope; },
    runWikiMutation: async (input: { execute(operation: unknown): Promise<{ resource: unknown; rollbackPoint?: unknown }> }) => {
      fixture.record("runWikiMutation", [input]);
      const executed = await input.execute(operation);
      return { resource: executed.resource, operation, activity: [] };
    },
    reindexWikiPages: async () => { fixture.record("reindexWikiPages", []); return { active: 2, total: 3, files: 3, indexed: 2, created: 1, updated: 1, removed: 0, skipped: 1, errors: [] }; }
  }));
}

async function runWorkItemCases(): Promise<void> {
  await runCase("work_item.create", caseFor("work_item.create", "all-public-fields"), (fixture) => ({
    getWorkItemObjective: async (id: unknown) => { fixture.record("getWorkItemObjective", [id]); return objective; },
    saveWorkItem: async (value: unknown) => { markWorkItemTimes(fixture.tracker, value as Record<string, unknown>); fixture.record("saveWorkItem", [value]); return value; },
    workItemObjectiveNotFoundError: () => { fixture.record("workItemObjectiveNotFoundError", []); return new Error("objective_not_found"); }
  }));
  await runCase("work_item.create", caseFor("work_item.create", "generated-defaults"), (fixture) => ({
    getWorkItemObjective: async (id: unknown) => { fixture.record("getWorkItemObjective", [id]); return objective; },
    saveWorkItem: async (value: unknown) => {
      markGeneratedWorkItem(fixture.tracker, value as Record<string, unknown>);
      fixture.record("saveWorkItem", [value]);
      return value;
    },
    workItemObjectiveNotFoundError: () => { fixture.record("workItemObjectiveNotFoundError", []); return new Error("objective_not_found"); }
  }));
}

type JsonSchema = Record<string, unknown>;

/**
 * Contract coverage is derived from the actual published input projection.
 * It does not trust the handwritten `branches` labels: every top-level field,
 * required field, direct enum choice, and direct union branch has to be
 * present in the concrete case DTOs before a single Handler is executed.
 */
function assertSchemaCaseCoverage(): void {
  const cIds = new Set(cHandlerOperationIds());
  for (const id of cIds) {
    const definition = definitions.get(id);
    assert.ok(definition, `handler_matrix_c_schema_definition_missing:${id}`);
    const schema = jsonSchemaFor(definition!.input, `${id}.handler_matrix_c`) as JsonSchema;
    const root = resolveJsonSchema(schema, schema);
    const properties = asSchemaMap(root.properties);
    const fields = Object.keys(properties).sort();
    const required = new Set(Array.isArray(root.required) ? root.required.filter((value): value is string => typeof value === "string") : []);
    const cases = cHandlerExpectations[id as keyof typeof cHandlerExpectations].cases;
    const parsedCases = cases.map((testCase) => {
      const parsed = (definition!.input as { safeParse(value: unknown): { success: boolean; data?: unknown } }).safeParse(testCase.input);
      assert.equal(parsed.success, true, `handler_matrix_c_schema_case_invalid:${id}:${testCase.id}`);
      return { id: testCase.id, value: parsed.data as Record<string, unknown> };
    });
    const present = new Set(parsedCases.flatMap((testCase) => Object.keys(testCase.value)));
    const missingFields = fields.filter((field) => !present.has(field));
    assert.deepEqual(missingFields, [], `handler_matrix_c_uncovered_top_level_fields:${id}:${missingFields.join(",")}`);
    const missingRequired = [...required].filter((field) => parsedCases.some((testCase) => !(field in testCase.value)));
    assert.deepEqual(missingRequired, [], `handler_matrix_c_missing_required_field_case:${id}:${missingRequired.join(",")}`);

    for (const [field, rawFieldSchema] of Object.entries(properties)) {
      const fieldSchema = resolveJsonSchema(rawFieldSchema as JsonSchema, schema);
      const enumValues = Array.isArray(fieldSchema.enum) ? fieldSchema.enum : [];
      // The schema matrix owns every vocabulary value (for example all eight
      // locales). This Handler matrix owns enum values that actually select a
      // Handler decision. The distinction is mechanically derived from a
      // conditional/switch expression over this input field, not from labels.
      if (enumValues.length && handlerControlsInputEnum(id, field)) {
        const actual = new Set(parsedCases.map((testCase) => stableJson(testCase.value[field])));
        const missing = enumValues.filter((value) => !actual.has(stableJson(value)));
        assert.deepEqual(missing, [], `handler_matrix_c_uncovered_enum_branch:${id}:${field}:${missing.map(stableJson).join(",")}`);
      }
      const alternatives = directUnionAlternatives(fieldSchema, schema);
      if (alternatives.length) {
        const missing = alternatives.filter((alternative) => !parsedCases.some((testCase) => schemaAccepts(testCase.value[field], alternative, schema)));
        assert.equal(missing.length, 0, `handler_matrix_c_uncovered_union_branch:${id}:${field}:${missing.length}`);
      }
    }

    const declared = cHandlerExpectations[id as keyof typeof cHandlerExpectations];
    const actualBranches = new Set(cases.flatMap((testCase) => testCase.branches));
    const missingBranchLabels = declared.requiredBranches.filter((branch) => !actualBranches.has(branch));
    const unexpectedBranchLabels = [...actualBranches].filter((branch) => !declared.requiredBranches.includes(branch));
    assert.deepEqual(missingBranchLabels, [], `handler_matrix_c_declared_branch_missing_case:${id}:${missingBranchLabels.join(",")}`);
    assert.deepEqual(unexpectedBranchLabels, [], `handler_matrix_c_unreviewed_case_branch:${id}:${unexpectedBranchLabels.join(",")}`);
  }
}

function handlerControlsInputEnum(id: string, field: string): boolean {
  const evidence = branchAstEvidence[id] ?? [];
  return evidence.some((item) => {
    const path = resolve(repositoryRoot, "packages/domain-operations/src/operations", item.file);
    const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let controls = false;
    const visit = (node: import("typescript").Node): void => {
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isSwitchStatement(node)) {
        const expression = (node as import("typescript").IfStatement | import("typescript").ConditionalExpression | import("typescript").SwitchStatement).expression;
        if (expression?.getText(ast).includes(`input.${field}`)) controls = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return controls;
  });
}

function cHandlerOperationIds(): string[] {
  return Object.keys(cHandlerExpectations).sort();
}

function asSchemaMap(value: unknown): Record<string, JsonSchema> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, JsonSchema] => Boolean(entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]))));
}

function resolveJsonSchema(value: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = value.$ref;
  if (typeof ref !== "string") return value;
  assert.ok(ref.startsWith("#/"), `handler_matrix_c_external_schema_ref:${ref}`);
  const target = ref.slice(2).split("/").reduce<unknown>((current, token) => current && typeof current === "object" ? (current as Record<string, unknown>)[token.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, root);
  assert.ok(target && typeof target === "object" && !Array.isArray(target), `handler_matrix_c_schema_ref_missing:${ref}`);
  return resolveJsonSchema(target as JsonSchema, root);
}

function directUnionAlternatives(value: JsonSchema, root: JsonSchema): JsonSchema[] {
  const resolved = resolveJsonSchema(value, root);
  const alternatives = Array.isArray(resolved.oneOf) ? resolved.oneOf : Array.isArray(resolved.anyOf) ? resolved.anyOf : [];
  return alternatives.filter((candidate): candidate is JsonSchema => Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate))).map((candidate) => resolveJsonSchema(candidate, root));
}

function schemaAccepts(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  const resolved = resolveJsonSchema(schema, root);
  if (Array.isArray(resolved.enum)) return resolved.enum.some((candidate) => stableJson(candidate) === stableJson(value));
  if (typeof resolved.const !== "undefined") return stableJson(resolved.const) === stableJson(value);
  if (Array.isArray(resolved.oneOf) || Array.isArray(resolved.anyOf)) return directUnionAlternatives(resolved, root).some((candidate) => schemaAccepts(value, candidate, root));
  if (resolved.type === "string") return typeof value === "string";
  if (resolved.type === "boolean") return typeof value === "boolean";
  if (resolved.type === "number" || resolved.type === "integer") return typeof value === "number";
  if (resolved.type === "array") return Array.isArray(value);
  if (resolved.type === "object") return Boolean(value && typeof value === "object" && !Array.isArray(value));
  return true;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

interface BranchAstEvidence { branch: string; file: string; nodeText: string; }

/**
 * Labels are not self-certifying. For each declared Handler branch we locate
 * its concrete AST evidence in the owning operation/helper. A refactor that
 * removes a decision while leaving a stale label therefore fails this matrix.
 */
const branchAstEvidence: Record<string, readonly BranchAstEvidence[]> = {
  "curator.run": [
    { branch: "idle_gate:omitted", file: "curator/run.operation.ts", nodeText: "input.respect_idle_gate === undefined" },
    { branch: "idle_gate:present", file: "curator/run.operation.ts", nodeText: "respectIdleGate: input.respect_idle_gate" }
  ],
  "evaluation.run": [],
  "memory.archive": [{ branch: "archive:session-linked-memory", file: "memory/archive.operation.ts", nodeText: "sessionMemory.some" }],
  "memory.session.create": [
    { branch: "session:existing", file: "memory/create-memory.ts", nodeText: "input.sessionId" },
    { branch: "session:create", file: "memory/create-memory.ts", nodeText: "input.kind === \"session\"" }
  ],
  "memory.topic.create": [{ branch: "topic:explicit-kind", file: "memory/topic/create.operation.ts", nodeText: "topicKind: input.topic_kind" }],
  "message.presentation.update": [
    { branch: "view_id:explicit", file: "message/presentation/update.operation.ts", nodeText: "typeof input.view_state.view_id === \"string\"" },
    { branch: "view_id:fallback", file: "message/presentation/update.operation.ts", nodeText: "requestedViewId ?? existing.view_id" }
  ],
  "objective.create": [
    { branch: "objective:explicit-identifiers-and-budgets", file: "objective/create.operation.ts", nodeText: "id: input.objective_id ?? createId(\"objective\")" },
    { branch: "objective:generated-identifiers-and-default-title", file: "objective/create.operation.ts", nodeText: "title: input.title ?? summarize(input.objective, 80)" }
  ],
  "presentation.plan": [
    { branch: "requested_kind:built_in_surface", file: "presentation/plan.operation.ts", nodeText: "input.requested_kind === \"generated_surface\"" },
    { branch: "requested_kind:generated_surface", file: "presentation/plan.operation.ts", nodeText: "selected_kind: generated ? \"generated_surface\" : \"built_in_surface\"" }
  ],
  "reflection.run": [
    { branch: "source_run:session", file: "reflection/run.operation.ts", nodeText: "input.source_run_id ? { runId: input.source_run_id } : { sessionId }" },
    { branch: "source_run:backend", file: "reflection/run.operation.ts", nodeText: "sourceRunId: input.source_run_id" }
  ],
  "reflection.suggestion.apply": [
    { branch: "suggestion:memory", file: "reflection/suggestion/apply.operation.ts", nodeText: "suggestion.suggestion_type === \"memory\"" },
    { branch: "suggestion:knowledge_wiki", file: "reflection/suggestion/apply.operation.ts", nodeText: "suggestion.suggestion_type === \"knowledge_wiki\"" },
    { branch: "suggestion:skill", file: "reflection/suggestion/apply.operation.ts", nodeText: "suggestion.suggestion_type === \"skill\"" }
  ],
  "resource.translation_job.save": [
    { branch: "source:artifact", file: "resource/translation_job/save.operation.ts", nodeText: "input.source_ref.kind === \"artifact\"" },
    { branch: "source:memory", file: "resource/translation_job/save.operation.ts", nodeText: "input.source_ref.kind === \"memory\"" },
    { branch: "source:wiki", file: "resource/translation_job/save.operation.ts", nodeText: "input.source_ref.kind === \"wiki\"" },
    { branch: "source:skill", file: "resource/translation_job/save.operation.ts", nodeText: "input.source_ref.kind === \"skill\"" },
    { branch: "source:collection_record", file: "resource/translation_job/save.operation.ts", nodeText: "input.source_ref.kind === \"collection_record\"" },
    { branch: "schedule:default", file: "resource/translation_job/save.operation.ts", nodeText: "input.schedule?.trim() || \"once\"" }
  ],
  "resource.translation.save": [{ branch: "translation:save", file: "resource/translation/save.operation.ts", nodeText: "ports.saveResourceTranslation(request)" }],
  "skill.candidate.create": [{ branch: "candidate:create", file: "skill/candidate/create.operation.ts", nodeText: "state: \"candidate\"" }],
  "skill.lifecycle.apply": [
    { branch: "action:mark_stale", file: "skill/lifecycle/apply.operation.ts", nodeText: "action: input.action" },
    { branch: "action:archive", file: "skill/lifecycle/apply.operation.ts", nodeText: "action: input.action" },
    { branch: "action:reactivate", file: "skill/lifecycle/apply.operation.ts", nodeText: "action: input.action" }
  ],
  "skill.optimization.start": [
    { branch: "examples:omitted", file: "skill/optimization/start.operation.ts", nodeText: "...(input.golden_examples ?" },
    { branch: "examples:provided", file: "skill/optimization/start.operation.ts", nodeText: "goldenExamples: input.golden_examples" },
    { branch: "session:trusted", file: "skill/optimization/start.operation.ts", nodeText: "...(context.sessionId ? { sessionId: context.sessionId } : {})" }
  ],
  "skill.optimization.cancel": [{ branch: "optimization:cancel", file: "skill/optimization/cancel.operation.ts", nodeText: "optimizationRunId: input.optimization_run_id" }],
  "skill.optimization.promote": [{ branch: "optimization:promote", file: "skill/optimization/promote.operation.ts", nodeText: "candidateId: input.candidate_id" }],
  "skill.optimization.reject": [{ branch: "optimization:reject", file: "skill/optimization/reject.operation.ts", nodeText: "candidateId: input.candidate_id" }],
  "skill.optimization.rollback": [
    { branch: "rollback:promotion", file: "skill/optimization/rollback.operation.ts", nodeText: "...(input.promotion_id ? { promotionId: input.promotion_id } : {})" },
    { branch: "rollback:snapshot", file: "skill/optimization/rollback.operation.ts", nodeText: "...(input.snapshot_id ? { snapshotId: input.snapshot_id } : {})" },
    { branch: "rollback:both", file: "skill/optimization/rollback.operation.ts", nodeText: "...(input.snapshot_id ? { snapshotId: input.snapshot_id } : {})" }
  ],
  "skill.patch": [{ branch: "patch:all-fields", file: "skill/patch.operation.ts", nodeText: "ports.patchSkillRecord" }],
  "skill.project.save": [{ branch: "candidate:project-save", file: "skill/project/save.operation.ts", nodeText: "parsed.frontmatter.state !== \"candidate\"" }],
  "skill.support_file.save": [{ branch: "support-file:save", file: "skill/support_file/save.operation.ts", nodeText: "ports.writeSkillSupportFile" }],
  "skill.view": [
    { branch: "path:body", file: "skill/view.operation.ts", nodeText: "...(input.path ? { path: input.path } : {})" },
    { branch: "path:support", file: "skill/view.operation.ts", nodeText: "...(input.path ? { path: input.path } : {})" }
  ],
  "wiki.accept": [{ branch: "state:active", file: "wiki/accept.operation.ts", nodeText: "state: \"active\"" }],
  "wiki.archive": [{ branch: "state:archived", file: "wiki/archive.operation.ts", nodeText: "state: \"archived\"" }],
  "wiki.patch": [{ branch: "patch:all-fields", file: "wiki/patch.operation.ts", nodeText: "const update = { id: input.wiki_id" }],
  "wiki.proposal.create": [{ branch: "proposal:all-fields", file: "wiki/proposal/create.operation.ts", nodeText: "slug: slugify(input.slug ?? input.title)" }],
  "wiki.reindex": [{ branch: "reindex:all-pages", file: "wiki/reindex.operation.ts", nodeText: "ports.reindexWikiPages" }],
  "wiki.reject": [{ branch: "state:rejected", file: "wiki/reject.operation.ts", nodeText: "state: \"rejected\"" }],
  "work_item.create": [
    { branch: "work-item:explicit-values", file: "work_item/create.operation.ts", nodeText: "id: input.work_item_id ?? createId(\"work\")" },
    { branch: "work-item:generated-defaults", file: "work_item/create.operation.ts", nodeText: "input.work_idempotency_key ?? `${input.objective_id}:${stableHash(input)}`" }
  ]
};

function assertHandlerBranchEvidence(): void {
  for (const [id, expectation] of Object.entries(cHandlerExpectations)) {
    const evidence = branchAstEvidence[id];
    assert.ok(evidence, `handler_matrix_c_branch_evidence_missing:${id}`);
    assert.deepEqual(evidence.map((item) => item.branch).sort(), [...expectation.requiredBranches].sort(), `handler_matrix_c_branch_evidence_set_drift:${id}`);
    for (const item of evidence) {
      const path = resolve(repositoryRoot, "packages/domain-operations/src/operations", item.file);
      const source = readFileSync(path, "utf8");
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let found = false;
      const visit = (node: import("typescript").Node): void => {
        if (node.getText(ast).includes(item.nodeText)) found = true;
        ts.forEachChild(node, visit);
      };
      visit(ast);
      assert.equal(found, true, `handler_matrix_c_branch_ast_evidence_missing:${id}:${item.branch}:${item.nodeText}`);
    }
  }
}

await main();
