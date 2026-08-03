import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBackendRegistry, type AgentBackend } from "@samurai-agent/agent-backends";
import { getDomainCommandEntry } from "@samurai-agent/action-catalog";
import {
  nowIso,
  stableHash,
  type ActivityContextRef,
  type AgentRecord,
  type BackendRunRecord,
  type LearningResourceVersionRecord,
  type MemoryFrontmatter,
  type RoomRecord,
  type SessionRecord,
  type ToolRunRecord
} from "@samurai-agent/core-schemas";
import type { Core05BackgroundReviewRunner, Core05ReviewSnapshot } from "@samurai-agent/learning";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime } from "./agent-runtime.js";

const roots: string[] = [];
let sequence = 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core 05 completed learning path", () => {
  it("1. normal messages are not duplicated as Memory, while 2. explicit Memory saving still works", async () => {
    const fixture = await createFixture();
    await fixture.runtime.runChatTurn({ sessionId: fixture.sessionA.id, agent_id: fixture.agentA.id, content: "普通の会話です。" });
    expect(await fixture.store.listMemory()).toEqual([]);

    await fixture.runtime.runDomainCommand({
      command_id: "memory.topic.create",
      idempotency_key: "explicit-memory",
      payload: { content: "明示的に保存したMemory", topic_kind: "preference" }
    }, { sessionId: fixture.sessionA.id });
    expect(await fixture.store.listMemory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "preference" })
    ]));
    await fixture.store.close();
  });

  it("3. signal-free Runs create no candidate and 4. one source Run has only one candidate", async () => {
    const fixture = await createFixture();
    const ordinary = await fixture.runtime.runChatTurn({ sessionId: fixture.sessionA.id, agent_id: fixture.agentA.id, content: "普通の会話です。" });
    expect((await fixture.store.listReflectionRuns()).filter((run) => run.source_run_id === ordinary.backendRun.id)).toEqual([]);

    const explicit = await fixture.runtime.runChatTurn({ sessionId: fixture.sessionA.id, agent_id: fixture.agentA.id, content: "この方針を記憶に保存してください。" });
    const candidates = (await fixture.store.listReflectionRuns()).filter((run) => run.source_run_id === explicit.backendRun.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ status: "queued", candidate_signals: [expect.objectContaining({ kind: "explicit_memory_save" })] });
    const duplicate = await fixture.store.createLearningReviewCandidate({ ...candidates[0], id: `duplicate-${nextId("candidate")}` });
    expect(duplicate.id).toBe(candidates[0].id);
    expect((await fixture.store.listReflectionRuns()).filter((run) => run.source_run_id === explicit.backendRun.id)).toHaveLength(1);
    await fixture.store.close();
  });

  it("5. an unresolved Activity Context leaves the completed Run intact", async () => {
    const fixture = await createFixture();
    const run = await createCompletedRun(fixture, "run-no-activity", fixture.sessionA, undefined);
    await expect((fixture.runtime as unknown as {
      registerLearningCandidateForCompletedRun(runId: string): Promise<void>;
    }).registerLearningCandidateForCompletedRun(run.id)).resolves.toBeUndefined();
    expect(run.status).toBe("completed");
    expect((await fixture.store.listReflectionRuns()).filter((item) => item.source_run_id === run.id)).toEqual([]);
    await fixture.store.close();
  });

  it("6. a Review sees only its Room and 7-9. creates only allowed Room-scoped resources", async () => {
    let seenForeignCatalog = false;
    const runner: Core05BackgroundReviewRunner = {
      run: async (snapshot) => {
        seenForeignCatalog = snapshot.memory_catalog.some((entry) => entry.id === "foreign-memory");
        return {
          reviewer: "fixture",
          summary: "Create one explicit Memory.",
          mutations: [{
            kind: "memory_create",
            topic: "Room-only Memory",
            content: "Only the source Room may use this.",
            reason: "Explicit user request.",
            evidence_refs: [{ kind: "message", id: snapshot.evidence.input_message.id, uri: `workspace://sessions/${snapshot.evidence.input_message.session_id}/messages/${snapshot.evidence.input_message.id}` }],
            usage_scope: { kind: "room", room_id: "attempted-other-room" },
            evidence_state: "direct_confirmed",
            usage_state: "normal"
          }]
        };
      }
    };
    const fixture = await createFixture({ runner });
    await fixture.store.saveMemory(memoryFrontmatter({
      id: "foreign-memory",
      topic: "Room B only",
      content: "foreign",
      scope: { kind: "room", room_id: fixture.roomB.id },
      activity: fixture.activityB,
      sourceRunId: "foreign-run"
    }), "foreign");
    const turn = await fixture.runtime.runChatTurn({ sessionId: fixture.sessionA.id, agent_id: fixture.agentA.id, content: "この内容を記憶に保存してください。" });
    const review = await fixture.runtime.runReflection({ sessionId: fixture.sessionA.id, sourceRunId: turn.backendRun.id });
    const memory = (await fixture.store.listMemory()).find((item) => item.topic === "Room-only Memory");
    expect(seenForeignCatalog).toBe(false);
    expect(review.reflectionRun.status).toBe("completed");
    expect(memory).toMatchObject({
      usage_scope: { kind: "room", room_id: fixture.roomA.id },
      evidence_state: "direct_confirmed",
      usage_state: "normal"
    });
    expect((await fixture.store.listDomainCommandExecutions()).map((command) => command.command_id)).toContain("learning.background_review.apply");
    expect(await fixture.store.getMemory("foreign-memory")).toMatchObject({ usage_scope: { kind: "room", room_id: fixture.roomB.id } });
    await fixture.store.close();
  });

  it("Roomがidleなら同じRoomの候補だけを一回のReviewへまとめる", async () => {
    let snapshot: Core05ReviewSnapshot | undefined;
    const runner: Core05BackgroundReviewRunner = {
      run: async (input) => {
        snapshot = input;
        return { reviewer: "fixture", summary: "No change.", mutations: [] };
      }
    };
    const fixture = await createFixture({ runner });
    const secondSession: SessionRecord = {
      ...fixture.sessionA,
      id: nextId("session-a-second"),
      session_key: nextId("key-a-second"),
      title: "Room A second Session",
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await fixture.store.createSession(secondSession);
    const first = await fixture.runtime.runChatTurn({ sessionId: fixture.sessionA.id, agent_id: fixture.agentA.id, content: "この内容を記憶に保存してください。" });
    const second = await fixture.runtime.runChatTurn({ sessionId: secondSession.id, agent_id: fixture.agentA.id, content: "この方針を記憶に保存してください。" });
    const foreign = await fixture.runtime.runChatTurn({ sessionId: fixture.sessionB.id, agent_id: fixture.agentB.id, content: "この内容を記憶に保存してください。" });
    await fixture.runtime.runMemoryReviewAutomation();
    expect(snapshot?.pending_room_evidence.map((entry) => entry.backend_run.id)).toContain(second.backendRun.id);
    expect(snapshot?.pending_room_evidence.some((entry) => entry.backend_run.id === foreign.backendRun.id)).toBe(false);
    const reviewed = (await fixture.store.listReflectionRuns()).filter((run) => [first.backendRun.id, second.backendRun.id].includes(run.source_run_id ?? ""));
    expect(reviewed).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_run_id: first.backendRun.id, status: "completed" }),
      expect.objectContaining({ source_run_id: second.backendRun.id, status: "completed" })
    ]));
    expect((await fixture.store.listReflectionRuns()).find((run) => run.source_run_id === foreign.backendRun.id)).toMatchObject({ status: "queued" });
    await fixture.store.close();
  });

  it("10. rejects applied without a body read, and 11. rejects a different Version, Run, or Scope", async () => {
    const fixture = await createFixture();
    const run = await createCompletedRun(fixture, "run-apply-a");
    const memory = await createVersionedMemory(fixture, { id: "memory-apply", content: "Apply only after body read.", run });
    await expect(fixture.runtime.recordAppliedLearningResource({
      runId: run.id,
      resourceKind: "memory",
      resourceId: memory.id,
      resourceVersion: "1",
      contentHash: memory.content_hash!,
      decisionSummary: "Use the Memory after the body was read.",
      matchedConditions: ["Room A"]
    })).rejects.toThrow("learning_resource_use_body_not_loaded");
    await recordMemoryBody(fixture, memory, run);
    await expect(fixture.runtime.recordAppliedLearningResource({
      runId: run.id,
      resourceKind: "memory",
      resourceId: memory.id,
      resourceVersion: "2",
      contentHash: memory.content_hash!,
      decisionSummary: "Use the Memory.",
      matchedConditions: ["Room A"]
    })).rejects.toThrow("learning_resource_use_version_mismatch");
    const applied = await fixture.runtime.recordAppliedLearningResource({
      runId: run.id,
      resourceKind: "memory",
      resourceId: memory.id,
      resourceVersion: "1",
      contentHash: memory.content_hash!,
      decisionSummary: "Use the Memory.",
      matchedConditions: ["Room A"]
    });
    expect(applied.use_record).toMatchObject({ stage: "applied", resource_version: "1" });

    const sameRoomRun = await createCompletedRun(fixture, "run-apply-same-room", fixture.sessionA, fixture.agentA);
    await expect(fixture.runtime.recordAppliedLearningResource({
      runId: sameRoomRun.id,
      resourceKind: "memory",
      resourceId: memory.id,
      resourceVersion: "1",
      contentHash: memory.content_hash!,
      decisionSummary: "Use the Memory.",
      matchedConditions: ["Room A"]
    })).rejects.toThrow("learning_resource_use_body_not_loaded");
    const otherRoomRun = await createCompletedRun(fixture, "run-apply-b", fixture.sessionB, fixture.agentB);
    await recordMemoryBody(fixture, memory, otherRoomRun);
    await expect(fixture.runtime.recordAppliedLearningResource({
      runId: otherRoomRun.id,
      resourceKind: "memory",
      resourceId: memory.id,
      resourceVersion: "1",
      contentHash: memory.content_hash!,
      decisionSummary: "Use the Memory.",
      matchedConditions: ["Room B"]
    })).rejects.toThrow("learning_resource_use_scope_mismatch");
    await fixture.store.close();
  });

  it("12. skips Evaluation without applied, 13. saves objective support, 14. records corrections as refutation, and 15. never treats silence as support", async () => {
    const fixture = await createFixture();
    const noAppliedRun = await createCompletedRun(fixture, "run-no-applied");
    const noApplied = await evaluate(fixture, noAppliedRun.id);
    expect(noApplied.learningEvaluations).toEqual([]);
    expect((await fixture.store.listReflectionRuns()).filter((run) => run.kind === "evaluation")).toEqual([]);

    const supportedRun = await createCompletedRun(fixture, "run-supported");
    const supportedMemory = await createVersionedMemory(fixture, { id: "memory-supported", content: "Run the test.", run: supportedRun });
    await recordMemoryBody(fixture, supportedMemory, supportedRun);
    await applyMemory(fixture, supportedMemory, supportedRun);
    await fixture.store.saveToolRun(toolRun(supportedRun, "tool-supported", "test", "completed"));
    const supported = await evaluate(fixture, supportedRun.id);
    expect(supported.learningEvaluations).toContainEqual(expect.objectContaining({ prediction_assessment: "supported", causal_assessment: "indeterminate", compared_run_ids: [supportedRun.id] }));

    const silentRun = await createCompletedRun(fixture, "run-silent");
    const silentMemory = await createVersionedMemory(fixture, { id: "memory-silent", content: "No objective result.", run: silentRun });
    await recordMemoryBody(fixture, silentMemory, silentRun);
    await applyMemory(fixture, silentMemory, silentRun);
    const silent = await evaluate(fixture, silentRun.id);
    expect(silent.learningEvaluations).toContainEqual(expect.objectContaining({ prediction_assessment: "indeterminate" }));

    const refutedRun = await createCompletedRun(fixture, "run-refuted");
    const refutedMemory = await createVersionedMemory(fixture, { id: "memory-refuted", content: "Use this rule.", run: refutedRun });
    await recordMemoryBody(fixture, refutedMemory, refutedRun);
    await applyMemory(fixture, refutedMemory, refutedRun);
    await fixture.store.saveMessage({
      id: "message-refutation",
      session_id: fixture.sessionA.id,
      role: "user",
      content: "これは違うので訂正してください。",
      input_locale: "ja",
      output_locale: "ja",
      created_at: new Date(Date.parse(refutedRun.completed_at!) + 1_000).toISOString()
    });
    const refuted = await evaluate(fixture, refutedRun.id);
    expect(refuted.learningEvaluations).toContainEqual(expect.objectContaining({ prediction_assessment: "refuted" }));
    expect(await fixture.store.getMemory(refutedMemory.id)).toMatchObject({ evidence_state: "conflict", usage_state: "limited", version: "2" });
    await fixture.store.close();
  });

  it("16. a refuted Resource is excluded from ordinary next-Run use", async () => {
    const fixture = await createFixture();
    const run = await createCompletedRun(fixture, "run-refuted-next");
    const memory = await createVersionedMemory(fixture, { id: "memory-refuted-next", content: "Do not apply after conflict.", run });
    await recordMemoryBody(fixture, memory, run);
    await applyMemory(fixture, memory, run);
    await fixture.store.saveToolRun(toolRun(run, "tool-refuted", "test", "failed"));
    await evaluate(fixture, run.id);
    const next = await createCompletedRun(fixture, "run-after-conflict");
    const current = await fixture.store.getMemory(memory.id);
    await expect(fixture.runtime.recordAppliedLearningResource({
      runId: next.id,
      resourceKind: "memory",
      resourceId: memory.id,
      resourceVersion: current!.version!,
      contentHash: current!.content_hash!,
      decisionSummary: "Should be rejected.",
      matchedConditions: ["Room A"]
    })).rejects.toThrow("learning_resource_use_not_eligible");
    await fixture.store.close();
  });

  it("17. edits create a new Version and 18. restoring preserves the origin Room", async () => {
    const fixture = await createFixture();
    const run = await createCompletedRun(fixture, "run-version");
    const memory = await createVersionedMemory(fixture, { id: "memory-version", content: "Version one", run });
    const versionTwo = await fixture.runtime.updateLearningResourceVersion({
      resourceKind: "memory",
      resourceId: memory.id,
      changeReason: "user correction",
      content: "Version two",
      usageScope: { kind: "agent", agent_id: fixture.agentA.id }
    });
    expect(versionTwo.resource_version).toMatchObject({ version: "2", parent_version: "1", is_current: true });
    const restored = await fixture.runtime.restoreLearningResourceVersion({ resourceKind: "memory", resourceId: memory.id, targetVersion: "1", reason: "user correction" });
    expect(restored.resource_version).toMatchObject({ version: "3", parent_version: "2", restored_from_version: "1", is_current: true });
    expect(await fixture.store.readMemoryContent(memory.id)).toBe("Version one");
    expect(await fixture.store.getMemory(memory.id)).toMatchObject({
      version: "3",
      usage_scope: { kind: "room", room_id: fixture.roomA.id },
      origin_activity_context: fixture.activityA
    });
    const versions = await fixture.store.listLearningResourceVersions({ resourceKind: "memory", resourceId: memory.id });
    expect(versions.map((entry) => entry.version)).toEqual(expect.arrayContaining(["1", "2", "3"]));
    await fixture.store.close();
  });

  it("19. time alone does not archive, 20. pinned Resources stay active, and 21. Archive Snapshot restores", async () => {
    const fixture = await createFixture();
    const run = await createCompletedRun(fixture, "run-archive");
    const ordinary = await createVersionedMemory(fixture, { id: "memory-archive", content: "Archive only by reason.", run });
    const noReason = await fixture.runtime.runDomainCommand({ command_id: "curator.run", idempotency_key: "curator-no-reason", payload: {} });
    expect((noReason.result as { curatorReport: { dry_run: boolean } }).curatorReport.dry_run).toBe(true);
    expect(await fixture.store.getMemory(ordinary.id)).toMatchObject({ state: "topic" });

    const pinned = await createVersionedMemory(fixture, { id: "memory-pinned", content: "Never auto archive.", run, pinned: true });
    await fixture.runtime.runDomainCommand({ command_id: "curator.run", idempotency_key: "curator-pinned", payload: { reason: "archive", resource_kind: "memory", resource_id: pinned.id } });
    expect(await fixture.store.getMemory(pinned.id)).toMatchObject({ state: "topic", pinned: true });

    const archived = await fixture.runtime.runDomainCommand({ command_id: "curator.run", idempotency_key: "curator-archive", payload: { reason: "archive", resource_kind: "memory", resource_id: ordinary.id } });
    const snapshotId = (archived.result as { curatorReport: { snapshot_id?: string } }).curatorReport.snapshot_id;
    expect(snapshotId).toBeTruthy();
    expect(await fixture.store.getMemory(ordinary.id)).toMatchObject({ state: "archived", version: "2", usage_state: "dormant" });
    await fixture.runtime.runDomainCommand({ command_id: "curator.restore", idempotency_key: "curator-restore", payload: { snapshot_id: snapshotId } });
    expect(await fixture.store.getMemory(ordinary.id)).toMatchObject({ state: "topic", version: "1", usage_state: "normal" });
    expect(await fixture.store.getCurrentLearningResourceVersion({ resourceKind: "memory", resourceId: ordinary.id })).toMatchObject({ version: "1", is_current: true });
    await fixture.store.close();
  });

  it("22. candidate zero calls no review model and 23. a budget excess defers without stopping Chat", async () => {
    let calls = 0;
    const runner: Core05BackgroundReviewRunner = { run: async () => { calls += 1; return { reviewer: "fixture", summary: "none", mutations: [] }; } };
    const fixture = await createFixture({ runner });
    await fixture.store.patchSettings({ learning_enabled: false });
    const disabled = await fixture.runtime.runChatTurn({ sessionId: fixture.sessionA.id, agent_id: fixture.agentA.id, content: "この内容を記憶に保存してください。" });
    expect((await fixture.store.listReflectionRuns()).filter((run) => run.source_run_id === disabled.backendRun.id)).toEqual([]);
    await fixture.store.patchSettings({ learning_enabled: true });
    await fixture.runtime.runChatTurn({ sessionId: fixture.sessionA.id, agent_id: fixture.agentA.id, content: "通常の会話です。" });
    await fixture.runtime.runMemoryReviewAutomation();
    expect(calls).toBe(0);

    const turn = await fixture.runtime.runChatTurn({ sessionId: fixture.sessionA.id, agent_id: fixture.agentA.id, content: "この内容を記憶に保存してください。" });
    await fixture.store.updateBackendRun({ ...turn.backendRun, metadata: { ...turn.backendRun.metadata, cost: 100 } });
    await fixture.store.patchSettings({ learning_budget_ratio: 0 });
    const candidates = (await fixture.store.listReflectionRuns()).filter((run) => run.source_run_id === turn.backendRun.id);
    expect(candidates).toEqual([expect.objectContaining({
      status: "queued",
      session_id: fixture.sessionA.id,
      activity_context: fixture.activityA
    })]);
    const automation = await fixture.runtime.runMemoryReviewAutomation();
    expect(automation.memoryReviewTrace?.reflectionRun).toMatchObject({ source_run_id: turn.backendRun.id, status: "deferred", deferred_reason: "learning_budget_exceeded" });
    expect(calls).toBe(0);
    await fixture.store.close();
  });

  it("24. the applied-use operation is Backend-neutral and 25. explicit Wiki, Skill, and Automation operations remain available", async () => {
    const fixture = await createFixture();
    const operation = getDomainCommandEntry("learning.resource.usage.record");
    expect(operation?.provider_tool_names).toEqual(expect.arrayContaining([
      "samurai.learning.resource.usage.record",
      "record_resource_application",
      "mcp__samurai__record_resource_application"
    ]));
    await fixture.runtime.runDomainCommand({
      command_id: "wiki.proposal.create",
      idempotency_key: "explicit-wiki",
      payload: { title: "Explicit wiki", content: "Keep existing explicit operations." }
    });
    await fixture.runtime.runDomainCommand({
      command_id: "skill.candidate.create",
      idempotency_key: "explicit-skill",
      payload: { title: "Explicit skill", content: "1. Do this." }
    });
    const automation = await fixture.runtime.runMemoryReviewAutomation();
    expect(automation.automationRun.status).toBe("completed");
    expect((await fixture.store.listWiki({ activeOnly: false })).some((page) => page.title === "Explicit wiki")).toBe(true);
    expect((await fixture.store.listSkills()).some((skill) => skill.title === "Explicit skill")).toBe(true);
    await fixture.store.close();
  });
});

interface Fixture {
  store: WorkspaceStore;
  runtime: AgentRuntime;
  roomA: RoomRecord;
  roomB: RoomRecord;
  agentA: AgentRecord;
  agentB: AgentRecord;
  sessionA: SessionRecord;
  sessionB: SessionRecord;
  activityA: ActivityContextRef;
  activityB: ActivityContextRef;
}

async function createFixture(input: { runner?: Core05BackgroundReviewRunner } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core05-completion-"));
  roots.push(root);
  const store = await WorkspaceStore.create({ rootDir: root });
  const now = nowIso();
  const roomA: RoomRecord = { id: nextId("room-a"), name: "Room A", created_at: now, updated_at: now };
  const roomB: RoomRecord = { id: nextId("room-b"), name: "Room B", created_at: now, updated_at: now };
  const backend = fixtureBackend();
  const agentA: AgentRecord = { id: nextId("agent-a"), name: "Agent A", role: "Research", instructions: "Use Room A only.", backend_id: backend.id, enabled: true, created_at: now, updated_at: now };
  const agentB: AgentRecord = { id: nextId("agent-b"), name: "Agent B", role: "Writing", instructions: "Use Room B only.", backend_id: backend.id, enabled: true, created_at: now, updated_at: now };
  const sessionA: SessionRecord = { id: nextId("session-a"), session_key: nextId("key-a"), room_id: roomA.id, title: "Room A Session", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
  const sessionB: SessionRecord = { id: nextId("session-b"), session_key: nextId("key-b"), room_id: roomB.id, title: "Room B Session", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
  await Promise.all([store.createRoom(roomA), store.createRoom(roomB), store.createAgent(agentA), store.createAgent(agentB), store.createSession(sessionA), store.createSession(sessionB)]);
  await store.patchSettings({ default_room_id: roomA.id, default_agent_id: agentA.id });
  const runtime = new AgentRuntime(
    store,
    undefined,
    undefined,
    new AgentBackendRegistry([backend]),
    undefined,
    undefined,
    undefined,
    input.runner ? { core05BackgroundReviewRunner: input.runner } : {}
  );
  return {
    store,
    runtime,
    roomA,
    roomB,
    agentA,
    agentB,
    sessionA,
    sessionB,
    activityA: { room_id: roomA.id, session_id: sessionA.id, agent_id: agentA.id },
    activityB: { room_id: roomB.id, session_id: sessionB.id, agent_id: agentB.id }
  };
}

function fixtureBackend(): AgentBackend {
  return {
    id: "core05-fixture-backend",
    kind: "external",
    label: "Core05 fixture Backend",
    sessionPolicy: { acquisition: "none", resume: "unsupported" },
    execution_owner: "host",
    async *runTurn(input) {
      yield { event_type: "run_started", payload: { input_summary: input.user_input } };
      yield { event_type: "text_delta", payload: { text: "fixture response" } };
      yield { event_type: "run_completed", terminal_evidence: { kind: "completed", source: "owned_loop_return" }, payload: { output_summary: "fixture complete" } };
    }
  };
}

async function createCompletedRun(fixture: Fixture, id: string, session = fixture.sessionA, agent: AgentRecord | undefined = fixture.agentA): Promise<BackendRunRecord> {
  const now = nowIso();
  const messageId = `${id}-message`;
  await fixture.store.saveMessage({ id: messageId, session_id: session.id, role: "user", content: id, input_locale: "ja", output_locale: "ja", created_at: now });
  const run: BackendRunRecord = {
    id,
    session_id: session.id,
    ...(agent ? { agent_id: agent.id } : {}),
    input_message_id: messageId,
    backend_id: "core05-fixture-backend",
    backend_kind: "external",
    status: "completed",
    started_at: now,
    completed_at: now,
    input_summary: id,
    metadata: {}
  };
  await fixture.store.saveBackendRun(run);
  return run;
}

async function createVersionedMemory(
  fixture: Fixture,
  input: { id: string; content: string; run: BackendRunRecord; pinned?: boolean }
) {
  const activity = { room_id: fixture.roomA.id, session_id: fixture.sessionA.id, agent_id: fixture.agentA.id };
  const frontmatter = memoryFrontmatter({ id: input.id, topic: input.id, content: input.content, scope: { kind: "room", room_id: fixture.roomA.id }, activity, sourceRunId: input.run.id, pinned: input.pinned });
  await fixture.store.saveMemory(frontmatter, input.content);
  const stored = await fixture.store.getMemory(input.id);
  if (!stored) throw new Error("fixture_memory_missing");
  await fixture.store.saveLearningResourceVersion({
    record: versionRecord({ resourceKind: "memory", resourceId: stored.id, version: "1", filePath: stored.file_path, contentHash: stored.content_hash!, sourceRunIds: [input.run.id], actor: "fixture" })
  });
  return stored;
}

function memoryFrontmatter(input: {
  id: string;
  topic: string;
  content: string;
  scope: MemoryFrontmatter["usage_scope"];
  activity: ActivityContextRef;
  sourceRunId: string;
  pinned?: boolean;
}): MemoryFrontmatter {
  const now = nowIso();
  return {
    id: input.id,
    state: "topic",
    topic: input.topic,
    source: input.sourceRunId,
    source_locale: "ja",
    content_locale: "ja",
    source_kind: "owner_instruction",
    instruction_authority: "owner",
    confidence: 0.9,
    created_by: "fixture",
    created_at: now,
    updated_at: now,
    related_memories: [],
    conflicts_with: [],
    sensitive_level: "none",
    usage_scope: input.scope,
    evidence_state: "direct_confirmed",
    usage_state: "normal",
    origin_activity_context: input.activity,
    source_run_ids: [input.sourceRunId],
    version: "1",
    content_hash: stableHash(input.content),
    pinned: input.pinned ?? false
  };
}

async function recordMemoryBody(fixture: Fixture, memory: MemoryFrontmatter & { file_path: string }, run: BackendRunRecord): Promise<void> {
  const session = await fixture.store.getSession(run.session_id);
  const agentId = run.agent_id;
  if (!session?.room_id || !agentId) throw new Error("fixture_activity_missing");
  await fixture.store.recordLearningResourceUse({
    id: nextId("body"),
    run_id: run.id,
    session_id: run.session_id,
    activity_context: { room_id: session.room_id, session_id: session.id, agent_id: agentId },
    resource_kind: "memory",
    resource_id: memory.id,
    resource_version: memory.version,
    content_hash: memory.content_hash,
    usage_scope: memory.usage_scope,
    stage: "body_loaded",
    metadata: { fixture: true },
    created_at: nowIso()
  });
}

async function applyMemory(fixture: Fixture, memory: MemoryFrontmatter & { file_path: string }, run: BackendRunRecord): Promise<void> {
  await fixture.runtime.recordAppliedLearningResource({
    runId: run.id,
    resourceKind: "memory",
    resourceId: memory.id,
    resourceVersion: memory.version!,
    contentHash: memory.content_hash!,
    decisionSummary: "Apply the exact Memory.",
    matchedConditions: ["fixture condition"]
  });
}

async function evaluate(fixture: Fixture, sourceRunId: string) {
  const result = await fixture.runtime.runDomainCommand({
    command_id: "evaluation.run",
    idempotency_key: `evaluate-${sourceRunId}`,
    payload: { source_run_id: sourceRunId }
  });
  return result.result as { learningEvaluations: Array<{ prediction_assessment?: string; causal_assessment?: string; compared_run_ids: string[] }> };
}

function toolRun(run: BackendRunRecord, id: string, action: string, status: ToolRunRecord["status"]): ToolRunRecord {
  return {
    id,
    run_id: run.id,
    session_id: run.session_id,
    provider_tool_name: action,
    action_id: action,
    status,
    input_summary: action,
    output_summary: status,
    resource_refs: [],
    created_at: nowIso()
  };
}

function versionRecord(input: {
  resourceKind: "memory" | "wiki" | "skill";
  resourceId: string;
  version: string;
  parentVersion?: string;
  filePath: string;
  contentHash: string;
  sourceRunIds: string[];
  actor: string;
}): LearningResourceVersionRecord {
  return {
    id: nextId("version"),
    resource_kind: input.resourceKind,
    resource_id: input.resourceId,
    version: input.version,
    ...(input.parentVersion ? { parent_version: input.parentVersion } : {}),
    file_path: input.filePath,
    content_hash: input.contentHash,
    change_reason: "fixture change",
    source_run_ids: input.sourceRunIds,
    actor: input.actor,
    is_current: true,
    created_at: nowIso()
  };
}

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}
