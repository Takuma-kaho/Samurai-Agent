import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  nowIso,
  type BackendRunRecord,
  type MemoryFrontmatter,
  type ReflectionRunRecord
} from "../../packages/core-schemas/src/index";
import {
  learningCandidateKey,
  parseCore05BackgroundReviewResult,
  type Core05BackgroundReviewResult
} from "../../packages/learning/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { localOwnerParticipantId } from "../../packages/room-permissions/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-review-"));
const now = nowIso();
const store = await WorkspaceStore.create({ rootDir: root });
let result: Core05BackgroundReviewResult = { reviewer: "fixture", summary: "", mutations: [] };
const runner = { run: async () => result };
const runtime = new AgentRuntime(
  store,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  { core05BackgroundReviewRunner: runner }
);

try {
  await store.patchSettings({ learning_enabled: true, memory_capture_mode: "auto", skill_capture_mode: "auto" });
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
    title: "s",
    ui_locale: "en",
    output_locale: "en",
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
    content: "この内容を記憶に保存してください。",
    input_locale: "en",
    output_locale: "en",
    created_at: now
  });

  for (const id of ["source-fail", "source-valid"]) {
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
      input_summary: "remember",
      metadata: {}
    };
    await store.saveBackendRun(run);
    await store.createLearningReviewCandidate(candidate(run));
  }

  await store.saveMemory(existingMemory(), "original");
  const existing = await store.getMemory("existing");
  if (!existing) throw new Error("existing_memory_missing");
  await store.ensureResourceAccessBoundary({
    resourceKind: "memory",
    resourceId: existing.id,
    sourceRoomId: "room",
    ownerParticipantId: localOwnerParticipantId,
    creatorParticipantId: localOwnerParticipantId,
    resourceCreatedAt: existing.created_at,
    actorId: localOwnerParticipantId
  });

  assert.throws(() => parseCore05BackgroundReviewResult(JSON.stringify({
    reviewer: "x",
    summary: "x",
    mutations: [{ kind: "memory_add" }]
  })));

  result = {
    reviewer: "fixture",
    summary: "rollback",
    mutations: [
      memoryMutation("temporary", "temporary"),
      {
        kind: "skill_candidate_create",
        title: "temporary",
        description: "temporary",
        content: "temporary",
        reason: "test",
        evidence_refs: [messageRef()],
        usage_scope: { kind: "room", room_id: "room" }
      }
    ]
  };
  const originalSaveSkillMarkdown = store.saveSkillMarkdown.bind(store);
  store.saveSkillMarkdown = async () => {
    throw new Error("injected_write_failure");
  };
  const failed = await runtime.runReflection({ sessionId: "s", sourceRunId: "source-fail" });
  store.saveSkillMarkdown = originalSaveSkillMarkdown;
  assert.equal(failed.reflectionRun.status, "failed");
  const rollbackMemories = await store.listMemory({ includeArchived: true });
  assert.equal(rollbackMemories.some((item) => item.topic === "temporary"), false);
  assert.equal(await store.readMemoryContent("existing"), "original");
  assert.equal((await store.listBackgroundReviewChanges({ reviewRunId: failed.reflectionRun.id })).length, 0);

  result = {
    reviewer: "fixture",
    summary: "valid",
    mutations: [memoryMutation("updated", "updated")]
  };
  const applied = await runtime.runReflection({ sessionId: "s", sourceRunId: "source-valid" });
  assert.equal(applied.reflectionRun.status, "completed");
  assert.equal((await store.listMemory()).some((item) => item.topic === "updated"), true);
  const duplicate = await runtime.runReflection({ sessionId: "s", sourceRunId: "source-valid" });
  assert.equal(duplicate.reflectionRun.id, applied.reflectionRun.id);
  assert.equal((await store.listBackgroundReviewChanges()).filter((item) => item.source_run_id === "source-valid").length, 1);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    malformed_rejected: true,
    mid_write_failure_rolled_back: true,
    partial_metadata: 0,
    valid_mutations: 1,
    duplicate_mutations: 0
  })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function candidate(run: BackendRunRecord): ReflectionRunRecord {
  return {
    id: `candidate-${run.id}`,
    kind: "background_review",
    source_run_id: run.id,
    session_id: "s",
    activity_context: { room_id: "room", session_id: "s", agent_id: "agent" },
    status: "queued",
    candidate_key: learningCandidateKey(run.id),
    candidate_signals: [{
      kind: "explicit_memory_save",
      summary: "The user explicitly requested Memory storage.",
      evidence_refs: [messageRef()],
      details: {}
    }],
    input_summary: "Queued explicit Memory review.",
    started_at: now
  };
}

function memoryMutation(topic: string, content: string): Core05BackgroundReviewResult["mutations"][number] {
  return {
    kind: "memory_create",
    topic,
    content,
    reason: "The user explicitly requested this Room-scoped Memory.",
    evidence_refs: [messageRef()],
    usage_scope: { kind: "room", room_id: "room" },
    evidence_state: "direct_confirmed",
    usage_state: "normal"
  };
}

function messageRef() {
  return { kind: "message" as const, id: "input", uri: "sessions/s/messages/input" };
}

function existingMemory(): MemoryFrontmatter {
  return {
    id: "existing",
    state: "topic",
    topic: "existing",
    source: "input",
    source_locale: "en",
    content_locale: "en",
    source_kind: "owner_instruction",
    instruction_authority: "owner",
    confidence: 1,
    created_by: "fixture",
    created_at: now,
    updated_at: now,
    related_memories: [],
    conflicts_with: [],
    sensitive_level: "none",
    usage_scope: { kind: "room", room_id: "room" },
    source_refs: [messageRef()]
  };
}
