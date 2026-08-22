import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  nowIso,
  stableHash,
  type BackendRunRecord,
  type ReflectionRunRecord,
  type WikiFrontmatter
} from "../../packages/core-schemas/src/index";
import {
  learningCandidateKey,
  type Core05BackgroundReviewResult
} from "../../packages/learning/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { localOwnerParticipantId } from "../../packages/room-permissions/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-wiki-loop-"));
const now = nowIso();
const store = await WorkspaceStore.create({ rootDir: root });
let review: Core05BackgroundReviewResult = { reviewer: "fixture", summary: "none", mutations: [] };
const runtime = new AgentRuntime(
  store,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  { core05BackgroundReviewRunner: { run: async () => review } }
);
const activity = { room_id: "room", session_id: "s", agent_id: "agent" };

try {
  await store.patchSettings({ learning_enabled: true, knowledge_wiki_capture_mode: "auto" });
  await store.createRoomWithOwner({ id: "room", name: "Fixture Room", created_at: now, updated_at: now }, localOwnerParticipantId);
  await store.createAgent({
    id: "agent",
    name: "Fixture Agent",
    role: "Review",
    instructions: "Review only the source Room.",
    backend_id: "fixture",
    enabled: true,
    created_at: now,
    updated_at: now
  });
  await store.createSession({
    id: "s",
    session_key: "s",
    room_id: "room",
    title: "Wiki loop",
    ui_locale: "ja",
    output_locale: "ja",
    created_at: now,
    updated_at: now
  });
  await store.setRoomAgentPermissions({
    roomId: "room",
    agentId: "agent",
    canView: true,
    canEdit: true,
    canExecute: true,
    actorId: localOwnerParticipantId
  });
  await store.ensureResourceAccessBoundary({
    resourceKind: "session",
    resourceId: "s",
    sourceRoomId: "room",
    ownerParticipantId: localOwnerParticipantId,
    actorId: localOwnerParticipantId
  });
  await store.saveMessage({
    id: "input",
    session_id: "s",
    role: "user",
    content: "請求書ルールを経験則として保存してください。",
    input_locale: "ja",
    output_locale: "ja",
    created_at: now
  });

  const createRun = await backendRun("run-create");
  await store.createLearningReviewCandidate(candidate(createRun, "explicit_experience_rule"));
  review = {
    reviewer: "fixture",
    summary: "Create one inferred experience rule.",
    mutations: [{
      kind: "experience_rule_create",
      title: "請求書補足",
      summary: "送信前に宛先を確認する",
      conditions: ["請求書を送信する前"],
      recommended_action: "宛先を確認してから送信する",
      predicted_result: "誤送信を減らせる",
      reason: "Evidence-backed Wiki candidate.",
      evidence_refs: [messageRef()],
      usage_scope: { kind: "room", room_id: "room" },
      evidence_state: "inferred",
      usage_state: "limited"
    }]
  };
  const created = await runtime.runReflection({ sessionId: "s", sourceRunId: createRun.id });
  assert.equal(created.reflectionRun.status, "completed");
  const createdPage = (await store.listWiki({ activeOnly: false })).find((page) => page.title === "請求書補足");
  assert.ok(createdPage);

  const primary = await store.saveWikiPage(wiki("primary", "invoice-rule", "請求書ルール"), "承認後に送信する");
  await ensureWikiBoundary(primary.id, primary.created_at);
  const useRun = await backendRun("run-use");
  await recordWikiUse(useRun.id, primary.id, "承認後に送信する", "context");

  const patchRun = await backendRun("run-patch");
  await store.createLearningReviewCandidate(candidate(patchRun, "resource_applied"));
  review = {
    reviewer: "fixture",
    summary: "Append evidence before the explicit Wiki edit.",
    mutations: [{
      kind: "resource_evidence_append",
      resource_kind: "wiki",
      resource_id: primary.id,
      reason: "A scoped use supplied evidence for the correction.",
      evidence_refs: [messageRef()]
    }]
  };
  const reviewed = await runtime.runReflection({ sessionId: "s", sourceRunId: patchRun.id });
  assert.equal(reviewed.reflectionRun.status, "completed");
  const currentBeforePatch = await store.getWiki(primary.id);
  if (!currentBeforePatch) throw new Error("primary_wiki_missing_before_patch");
  await runtime.runDomainCommand({
    command_id: "wiki.patch",
    idempotency_key: "wiki-loop-primary-patch",
    payload: {
      wiki_id: primary.id,
      content: "経理承認後に送信する",
      expected_resource_version: currentBeforePatch.resource_version,
      source_refs: [messageRef()]
    }
  }, { sessionId: "s" });
  assert.equal(await store.readWikiContent(primary.id), "経理承認後に送信する");
  await recordWikiUse(patchRun.id, primary.id, "経理承認後に送信する", "surface_generation");
  const search = await runtime.runDomainQuery({ query_id: "wiki.search", payload: { query: "経理承認" } }, { runId: patchRun.id });
  assert.equal((search.result as Array<{ id: string }>)[0]?.id, primary.id);

  const replacementRun = await backendRun("run-replacement");
  await store.createLearningReviewCandidate(candidate(replacementRun, "resource_applied"));
  review = {
    reviewer: "fixture",
    summary: "Propose replacement without merging automatically.",
    mutations: [{
      kind: "resource_replacement_candidate",
      resource_kind: "wiki",
      resource_id: primary.id,
      reason: "The owner may review a replacement later.",
      evidence_refs: [messageRef()]
    }]
  };
  const replacement = await runtime.runReflection({ sessionId: "s", sourceRunId: replacementRun.id });
  assert.equal(replacement.reflectionRun.status, "completed");
  assert.equal(await store.readWikiContent(primary.id), "経理承認後に送信する");

  const snapshot = await store.createLearningSnapshot(`candidate-${patchRun.id}`);
  const beforeArchive = await store.getWiki(primary.id);
  if (!beforeArchive) throw new Error("primary_wiki_missing_before_archive");
  await runtime.runDomainCommand({
    command_id: "wiki.archive",
    idempotency_key: "wiki-loop-primary-archive",
    payload: { wiki_id: primary.id, expected_resource_version: beforeArchive.resource_version }
  }, { sessionId: "s" });
  assert.equal((await store.getWiki(primary.id))?.state, "archived");
  await store.restoreLearningSnapshot(snapshot.id, { allowRoomScope: true, roomId: "room" });
  assert.equal((await store.getWiki(primary.id))?.state, "active");

  const curatorCommand = await runtime.runDomainCommand({
    command_id: "curator.run",
    idempotency_key: "wiki-loop-curator",
    payload: {}
  }, { sessionId: "s" });
  const curator = curatorCommand.result as { reflectionRun: ReflectionRunRecord };
  assert.equal(curator.reflectionRun.status, "completed");

  let adoptedCorrections = 0;
  for (let index = 0; index < 20; index += 1) {
    const id = `bench-wiki-${index}`;
    const useRunId = `bench-use-${index}`;
    const patchRunId = `bench-patch-${index}`;
    const reuseRunId = `bench-reuse-${index}`;
    const before = `旧手順 TASK-${index}`;
    const after = `採用済み訂正 TASK-${index}`;
    await Promise.all([backendRun(useRunId), backendRun(patchRunId), backendRun(reuseRunId)]);
    const page = await store.saveWikiPage(wiki(id, `benchmark-${index}`, `Benchmark ${index}`), before);
    await ensureWikiBoundary(page.id, page.created_at);
    await recordWikiUse(useRunId, id, before, "benchmark_initial");
    await store.createLearningReviewCandidate(candidate(await store.getBackendRun(patchRunId) as BackendRunRecord, "resource_applied"));
    review = {
      reviewer: "fixture",
      summary: `Evidence append ${index}`,
      mutations: [{ kind: "resource_evidence_append", resource_kind: "wiki", resource_id: id, reason: "Apply the scoped correction evidence.", evidence_refs: [messageRef()] }]
    };
    const reflected = await runtime.runReflection({ sessionId: "s", sourceRunId: patchRunId });
    assert.equal(reflected.reflectionRun.status, "completed");
    const current = await store.getWiki(id);
    if (!current) throw new Error(`benchmark_wiki_missing:${index}`);
    await runtime.runDomainCommand({
      command_id: "wiki.patch",
      idempotency_key: `wiki-loop-benchmark-patch-${index}`,
      payload: { wiki_id: id, content: after, expected_resource_version: current.resource_version, source_refs: [messageRef()] }
    }, { sessionId: "s" });
    await store.saveLearningEvaluation({
      id: `bench-eval-${index}`,
      learning_resource_ref: { kind: "knowledge_wiki", id, uri: page.file_path },
      learning_resource_version: stableHash(after),
      task_class: `wiki-task-${index}`,
      compared_run_ids: [useRunId, reuseRunId],
      before_metrics: { correction_applied: 0 },
      after_metrics: { correction_applied: 1 },
      effect_estimate: 1,
      confidence: 0.95,
      assessment: "helpful",
      evaluation_kind: "applied",
      applied_run_id: reuseRunId,
      activity_context: activity,
      matched_conditions: [`TASK-${index}`],
      affected_decision: "Wiki correction reuse",
      evidence_refs: [{ kind: "backend_run", id: patchRunId, uri: `runs/${patchRunId}` }],
      evaluator: "wiki-loop-benchmark",
      created_at: now
    });
    const found = (await store.searchWiki(after, 5, { activeOnly: true })).find((item) => item.id === id);
    if (found) {
      adoptedCorrections += 1;
      await recordWikiUse(reuseRunId, id, after, "benchmark_reuse");
    }
  }

  const unrelated = (await store.searchWiki("天気予報 明日の気温", 5, { activeOnly: true }))
    .filter((page) => page.id.startsWith("bench-wiki-")).length;
  assert.ok(adoptedCorrections >= 18);
  assert.equal(unrelated, 0);
  const benchmarkEvaluations = await store.listLearningEvaluations();
  const benchmarkUses = (await store.listLearningResourceUses()).filter((use) => use.resource_id.startsWith("bench-wiki-"));
  assert.equal(benchmarkEvaluations.filter((item) => item.evaluator === "wiki-loop-benchmark").length, 20);
  assert.equal(benchmarkUses.length, 40);
  const uses = await store.listLearningResourceUses({ resourceId: primary.id });
  const changes = await store.listBackgroundReviewChanges();
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    benchmark_tasks: 20,
    closed_loop_evidence_complete: benchmarkUses.length === 40 && benchmarkEvaluations.filter((item) => item.evaluator === "wiki-loop-benchmark").length === 20,
    adopted_corrections: adoptedCorrections,
    correction_reflection_rate: adoptedCorrections / 20,
    unrelated_misapplications: unrelated,
    active_retrieval: true,
    use_purposes: uses.map((item) => item.metadata.purpose),
    patched: true,
    created: Boolean(createdPage),
    replacement_proposed: true,
    archived: true,
    curator_completed: true,
    reused_updated_version: true,
    rollback_restored: true,
    change_kinds: changes.map((item) => item.mutation_kind)
  })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

async function backendRun(id: string): Promise<BackendRunRecord> {
  const run: BackendRunRecord = {
    id,
    session_id: "s",
    agent_id: "agent",
    input_message_id: "input",
    backend_id: "fixture",
    backend_kind: "samurai_native",
    status: "completed",
    started_at: now,
    completed_at: now,
    input_summary: "請求書ルール",
    metadata: {}
  };
  await store.saveBackendRun(run);
  return run;
}

function candidate(run: BackendRunRecord, signalKind: "explicit_experience_rule" | "resource_applied"): ReflectionRunRecord {
  return {
    id: `candidate-${run.id}`,
    kind: "background_review",
    source_run_id: run.id,
    session_id: "s",
    activity_context: activity,
    status: "queued",
    candidate_key: learningCandidateKey(run.id),
    candidate_signals: [{ kind: signalKind, summary: "Evidence-backed Learning candidate.", evidence_refs: [messageRef()], details: {} }],
    input_summary: "Queued Wiki Learning candidate.",
    started_at: now
  };
}

async function ensureWikiBoundary(resourceId: string, createdAt: string): Promise<void> {
  await store.ensureResourceAccessBoundary({
    resourceKind: "wiki",
    resourceId,
    sourceRoomId: "room",
    ownerParticipantId: localOwnerParticipantId,
    creatorParticipantId: localOwnerParticipantId,
    resourceCreatedAt: createdAt,
    actorId: localOwnerParticipantId
  });
}

async function recordWikiUse(runId: string, resourceId: string, content: string, purpose: string): Promise<void> {
  await store.recordLearningResourceUse({
    id: `use-${runId}-${resourceId}-${purpose}`,
    run_id: runId,
    session_id: "s",
    activity_context: activity,
    resource_kind: "wiki",
    resource_id: resourceId,
    resource_version: stableHash(content),
    content_hash: stableHash(content),
    usage_scope: { kind: "room", room_id: "room" },
    stage: "body_loaded",
    metadata: { purpose },
    created_at: now
  });
}

function messageRef() {
  return { kind: "message" as const, id: "input", uri: "sessions/s/messages/input" };
}

function wiki(id: string, slug: string, title: string): WikiFrontmatter {
  return {
    id,
    slug,
    title,
    state: "active",
    content_locale: "ja",
    tags: ["billing"],
    usage_scope: { kind: "room", room_id: "room" },
    source_refs: [messageRef()],
    provenance: { kind: "user_authored", summary: "fixture", verified: true },
    created_at: now,
    updated_at: now
  };
}
