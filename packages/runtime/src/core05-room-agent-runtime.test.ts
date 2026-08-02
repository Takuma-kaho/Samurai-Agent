import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nowIso,
  type AgentRecord,
  type BackendRunRecord,
  type MemoryFrontmatter,
  type RoomRecord,
  type SessionRecord,
  type WikiFrontmatter
} from "@samurai-agent/core-schemas";
import {
  AgentBackendRegistry,
  type AgentBackend,
  type BackendRunInput,
  type BackendSessionInput
} from "@samurai-agent/agent-backends";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime } from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core 05 Room and Agent runtime path", () => {
  it("routes one stable Agent through a Backend change without mixing Room context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core05-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const captured: Array<{ backendId: string; input: BackendRunInput }> = [];
    const started: Array<{ backendId: string; input: BackendSessionInput }> = [];
    const alphaBackend = fixtureBackend("backend-alpha", captured, started);
    const betaBackend = fixtureBackend("backend-beta", captured, started);
    const reviewSnapshots: Array<{ room_id?: string; session_id: string; agent_id?: string }> = [];
    const runtime = new AgentRuntime(
      store,
      undefined,
      undefined,
      new AgentBackendRegistry([alphaBackend, betaBackend]),
      undefined,
      undefined,
      undefined,
      {
        backgroundReviewRunner: {
          run: async (snapshot) => {
            reviewSnapshots.push({
              room_id: snapshot.activity_context?.room_id,
              session_id: snapshot.source_session_id,
              agent_id: snapshot.activity_context?.agent_id
            });
            if (reviewSnapshots.length === 1) return {
              reviewer: "core05-fixture",
              summary: "Create resources in the source Room.",
              mutations: [
                {
                  kind: "memory_add" as const,
                  topic: "Background Room context",
                  content: "Keep this in the source Room.",
                  reason: "The review originated in Room A.",
                  evidence_refs: [{ kind: "backend_run", id: snapshot.source_run_id, uri: `backend-runs/${snapshot.source_run_id}` }]
                },
                {
                  kind: "wiki_create" as const,
                  title: "Background Room wiki",
                  slug: "background-room-wiki",
                  content: "# Room A wiki",
                  tags: ["core05-background"],
                  reason: "The review originated in Room A.",
                  evidence_refs: [{ kind: "backend_run", id: snapshot.source_run_id, uri: `backend-runs/${snapshot.source_run_id}` }]
                },
                {
                  kind: "skill_create" as const,
                  title: "Background Room skill",
                  description: "Keep the source Room scope.",
                  content: "# Skill\n\nKeep the source Room scope.",
                  reason: "The review originated in Room A.",
                  evidence_refs: [{ kind: "backend_run", id: snapshot.source_run_id, uri: `backend-runs/${snapshot.source_run_id}` }]
                }
              ]
            };
            return {
              reviewer: "core05-fixture",
              summary: "No learning mutation is needed for this routing test.",
              mutations: []
            };
          }
        }
      }
    );

    const roomA = result<{ id: string }>(await runtime.runDomainCommand({
      command_id: "room.create", idempotency_key: "core05-room-a", payload: { name: "Room A" }
    }));
    const roomB = result<{ id: string }>(await runtime.runDomainCommand({
      command_id: "room.create", idempotency_key: "core05-room-b", payload: { name: "Room B" }
    }));
    const agentA = result<{ id: string; role: string; backend_id: string }>(await runtime.runDomainCommand({
      command_id: "agent.create", idempotency_key: "core05-agent-a",
      payload: { name: "Research Agent", role: "Research", instructions: "Inspect evidence and report the result.", backend_id: alphaBackend.id }
    }));
    const agentB = result<{ id: string; backend_id: string }>(await runtime.runDomainCommand({
      command_id: "agent.create", idempotency_key: "core05-agent-b",
      payload: { name: "Writing Agent", role: "Writing", instructions: "Draft concise output.", backend_id: betaBackend.id }
    }));
    const sessionA = result<SessionRecord>(await runtime.runDomainCommand({
      command_id: "session.create", idempotency_key: "core05-session-a", payload: { room_id: roomA.id, title: "A" }
    }));
    const sessionB = result<SessionRecord>(await runtime.runDomainCommand({
      command_id: "session.create", idempotency_key: "core05-session-b", payload: { room_id: roomB.id, title: "B" }
    }));
    await store.saveMemory(workspaceMemory("memory_core05_workspace", "Research"), "Shared research context.");

    const first = result<{ backendRun: BackendRunRecord }>(await runtime.runDomainCommand({
      command_id: "chat.turn.run", idempotency_key: "core05-turn-a",
      payload: { content: "Research this", agent_id: agentA.id }
    }, { sessionId: sessionA.id }));
    const second = result<{ backendRun: BackendRunRecord }>(await runtime.runDomainCommand({
      command_id: "chat.turn.run", idempotency_key: "core05-turn-b",
      payload: { content: "Draft this", agent_id: agentB.id }
    }, { sessionId: sessionB.id }));
    const rebound = result<{ id: string; role: string; backend_id: string }>(await runtime.runDomainCommand({
      command_id: "agent.backend.bind", idempotency_key: "core05-agent-a-rebind",
      payload: { id: agentA.id, backend_id: betaBackend.id }
    }));
    const afterRebind = result<{ backendRun: BackendRunRecord }>(await runtime.runDomainCommand({
      command_id: "chat.turn.run", idempotency_key: "core05-turn-a-rebound",
      payload: { content: "Research after backend change", agent_id: agentA.id }
    }, { sessionId: sessionA.id }));
    const compatibilityOverride = result<{ backendRun: BackendRunRecord }>(await runtime.runDomainCommand({
      command_id: "chat.turn.run", idempotency_key: "core05-turn-a-compatibility-override",
      payload: { content: "One turn on the compatibility Backend", agent_id: agentA.id, backend_id: alphaBackend.id }
    }, { sessionId: sessionA.id }));
    await runtime.runDomainCommand({
      command_id: "chat.turn.run", idempotency_key: "core05-turn-light-chat",
      payload: { content: "hi", agent_id: agentB.id }
    }, { sessionId: sessionB.id });
    await runtime.runDomainCommand({
      command_id: "settings.patch", idempotency_key: "core05-defaults",
      payload: { default_room_id: roomB.id, default_agent_id: agentB.id }
    });
    const defaultSession = result<SessionRecord>(await runtime.runDomainCommand({
      command_id: "session.create", idempotency_key: "core05-session-default", payload: { title: "Default" }
    }));
    const defaultTurn = result<{ backendRun: BackendRunRecord }>(await runtime.runDomainCommand({
      command_id: "chat.turn.run", idempotency_key: "core05-turn-default", payload: { content: "Use defaults" }
    }, { sessionId: defaultSession.id }));
    await store.saveBackendRun({
      id: "run_system_surface_newest",
      session_id: defaultSession.id,
      input_message_id: defaultTurn.backendRun.input_message_id,
      backend_id: betaBackend.id,
      backend_kind: betaBackend.kind,
      status: "completed",
      started_at: "2099-01-01T00:00:00.000Z",
      completed_at: "2099-01-01T00:00:00.000Z",
      input_summary: "Synthetic surface record.",
      metadata: { generated_surface: true }
    });
    const manualReflection = await runtime.runReflection({ sessionId: sessionA.id, sourceRunId: first.backendRun.id });
    await expect(runtime.runReflection({ sessionId: sessionA.id, sourceRunId: second.backendRun.id }))
      .rejects.toThrow(`reflection_source_run_session_mismatch:${second.backendRun.id}:${sessionA.id}`);
    const scheduledReflection = await runtime.runMemoryReviewAutomation();

    const [storedDefaultSession, storedDefaultRun, storedSessionA, storedSessionB, storedFirst, storedSecond, storedRebound, storedCompatibilityOverride, storedAgentA, learningUses, reflections, backgroundChanges, memories, wiki, skills, roomList, agentList] = await Promise.all([
      store.getSession(defaultSession.id),
      store.getBackendRun(defaultTurn.backendRun.id),
      store.getSession(sessionA.id),
      store.getSession(sessionB.id),
      store.getBackendRun(first.backendRun.id),
      store.getBackendRun(second.backendRun.id),
      store.getBackendRun(afterRebind.backendRun.id),
      store.getBackendRun(compatibilityOverride.backendRun.id),
      store.getAgent(agentA.id),
      store.listLearningResourceUses({ runId: first.backendRun.id }),
      store.listReflectionRuns(sessionA.id),
      store.listBackgroundReviewChanges({ sourceRunId: first.backendRun.id }),
      store.listMemory(),
      store.listWiki({ activeOnly: false }),
      store.listSkills(),
      runtime.runDomainQuery({ query_id: "room.list", payload: {} }),
      runtime.runDomainQuery({ query_id: "agent.list", payload: {} })
    ]);
    await store.close();

    expect(storedDefaultSession).toMatchObject({ room_id: roomB.id });
    expect(storedDefaultRun).toMatchObject({ agent_id: agentB.id, backend_id: betaBackend.id });
    expect(storedSessionA).toMatchObject({ room_id: roomA.id });
    expect(storedSessionB).toMatchObject({ room_id: roomB.id });
    expect(storedFirst).toMatchObject({ agent_id: agentA.id, backend_id: alphaBackend.id });
    expect(storedSecond).toMatchObject({ agent_id: agentB.id, backend_id: betaBackend.id });
    expect(storedRebound).toMatchObject({ agent_id: agentA.id, backend_id: betaBackend.id });
    expect(storedCompatibilityOverride).toMatchObject({ agent_id: agentA.id, backend_id: alphaBackend.id });
    expect(storedAgentA).toMatchObject({ id: agentA.id, backend_id: betaBackend.id });
    expect(rebound).toMatchObject({ id: agentA.id, role: agentA.role, backend_id: betaBackend.id });

    expect(captured).toContainEqual(expect.objectContaining({
      backendId: alphaBackend.id,
      input: expect.objectContaining({
        room_id: roomA.id,
        agent_context: expect.objectContaining({ id: agentA.id, name: "Research Agent", role: "Research", authority: "supporting_context" }),
        backend_session_key: `${roomA.id}:${sessionA.id}:${agentA.id}:${alphaBackend.id}`
      })
    }));
    expect(captured).toContainEqual(expect.objectContaining({
      backendId: betaBackend.id,
      input: expect.objectContaining({
        user_input: "hi",
        context_intent: "light_chat",
        agent_context: expect.objectContaining({ id: agentB.id, authority: "supporting_context" })
      })
    }));
    expect(captured).toContainEqual(expect.objectContaining({
      backendId: betaBackend.id,
      input: expect.objectContaining({
        room_id: roomB.id,
        agent_context: expect.objectContaining({ id: agentB.id })
      })
    }));
    expect(started).toContainEqual(expect.objectContaining({
      backendId: alphaBackend.id,
      input: expect.objectContaining({ room_id: roomA.id, agent_id: agentA.id, backend_session_key: `${roomA.id}:${sessionA.id}:${agentA.id}:${alphaBackend.id}` })
    }));
    expect(started).toContainEqual(expect.objectContaining({
      backendId: betaBackend.id,
      input: expect.objectContaining({ room_id: roomA.id, agent_id: agentA.id, backend_session_key: `${roomA.id}:${sessionA.id}:${agentA.id}:${betaBackend.id}` })
    }));
    expect(reviewSnapshots).toEqual(expect.arrayContaining([
      { room_id: roomA.id, session_id: sessionA.id, agent_id: agentA.id },
      { room_id: roomB.id, session_id: defaultSession.id, agent_id: agentB.id }
    ]));
    expect(reflections).toContainEqual(expect.objectContaining({
      source_run_id: first.backendRun.id,
      activity_context: { room_id: roomA.id, session_id: sessionA.id, agent_id: agentA.id }
    }));
    expect(manualReflection.reflectionRun).toMatchObject({
      source_run_id: first.backendRun.id,
      activity_context: { room_id: roomA.id, session_id: sessionA.id, agent_id: agentA.id }
    });
    expect(scheduledReflection.memoryReviewTrace?.reflectionRun).toMatchObject({
      source_run_id: defaultTurn.backendRun.id,
      session_id: defaultSession.id,
      activity_context: { room_id: roomB.id, session_id: defaultSession.id, agent_id: agentB.id }
    });
    expect(learningUses).toContainEqual(expect.objectContaining({
      resource_id: "memory_core05_workspace",
      activity_context: { room_id: roomA.id, session_id: sessionA.id, agent_id: agentA.id }
    }));
    expect(backgroundChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activity_context: { room_id: roomA.id, session_id: sessionA.id, agent_id: agentA.id }
      })
    ]));
    expect(memories).toContainEqual(expect.objectContaining({
      topic: "Background Room context",
      usage_scope: { kind: "room", room_id: roomA.id }
    }));
    expect(wiki).toContainEqual(expect.objectContaining({
      slug: "background-room-wiki",
      usage_scope: { kind: "room", room_id: roomA.id }
    }));
    expect(skills).toContainEqual(expect.objectContaining({
      title: "Background Room skill",
      frontmatter: expect.objectContaining({ usage_scope: { kind: "room", room_id: roomA.id } })
    }));
    expect(result<Array<{ id: string }>>(roomList)).toEqual(expect.arrayContaining([expect.objectContaining({ id: roomA.id }), expect.objectContaining({ id: roomB.id })]));
    expect(result<Array<{ id: string }>>(agentList)).toEqual(expect.arrayContaining([expect.objectContaining({ id: agentA.id }), expect.objectContaining({ id: agentB.id })]));
  });

  it("rejects a Background Review mutation that targets another Room scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core05-review-scope-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const captured: Array<{ backendId: string; input: BackendRunInput }> = [];
    const started: Array<{ backendId: string; input: BackendSessionInput }> = [];
    const backend = fixtureBackend("backend-scope", captured, started);
    const runtime = new AgentRuntime(
      store,
      undefined,
      undefined,
      new AgentBackendRegistry([backend]),
      undefined,
      undefined,
      undefined,
      {
        backgroundReviewRunner: {
          run: async (snapshot) => ({
            reviewer: "scope-fixture",
            summary: "Attempt a cross-Room replacement.",
            mutations: [{
              kind: "memory_replace",
              resource_id: "memory_room_b",
              content: "This must not be written.",
              reason: "Intentional scope-boundary fixture.",
              evidence_refs: [{ kind: "backend_run", id: snapshot.source_run_id, uri: `backend-runs/${snapshot.source_run_id}` }]
            }]
          })
        }
      }
    );
    const now = nowIso();
    const roomA: RoomRecord = { id: "room_scope_a", name: "Scope A", created_at: now, updated_at: now };
    const roomB: RoomRecord = { id: "room_scope_b", name: "Scope B", created_at: now, updated_at: now };
    const agent: AgentRecord = {
      id: "agent_scope_a", name: "Scope Agent", role: "Review", instructions: "Review only this Room.",
      backend_id: backend.id, enabled: true, created_at: now, updated_at: now
    };
    await Promise.all([store.createRoom(roomA), store.createRoom(roomB), store.createAgent(agent)]);
    await store.saveMemory(memory("memory_room_b", "Room B only", { kind: "room", room_id: roomB.id }), "Room B original.");
    const session = await runtime.createSession({ room_id: roomA.id });
    const turn = await runtime.runChatTurn({ sessionId: session.id, agent_id: agent.id, content: "Review this task" });
    await runtime.runReflection({ sessionId: session.id, sourceRunId: turn.backendRun.id });
    const [content, changes, reflections] = await Promise.all([
      store.readMemoryContent("memory_room_b"),
      store.listBackgroundReviewChanges({ sourceRunId: turn.backendRun.id }),
      store.listReflectionRuns(session.id)
    ]);
    await store.close();

    expect(content).toBe("Room B original.");
    expect(changes).toEqual([]);
    expect(reflections).toContainEqual(expect.objectContaining({
      source_run_id: turn.backendRun.id,
      status: "failed",
      error: "background_review_scope_violation:memory:memory_room_b"
    }));
  });

  it("does not load an unscoped learning reference into a Room review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core05-review-use-scope-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const captured: Array<{ backendId: string; input: BackendRunInput }> = [];
    const started: Array<{ backendId: string; input: BackendSessionInput }> = [];
    const backend = fixtureBackend("backend-use-scope", captured, started);
    let usedWikiFragmentIds: string[] = [];
    const runtime = new AgentRuntime(
      store,
      undefined,
      undefined,
      new AgentBackendRegistry([backend]),
      undefined,
      undefined,
      undefined,
      {
        backgroundReviewRunner: {
          run: async (snapshot) => {
            usedWikiFragmentIds = snapshot.used_wiki_fragments.map((fragment) => fragment.id);
            return { reviewer: "use-scope-fixture", summary: "No mutations.", mutations: [] };
          }
        }
      }
    );
    const now = nowIso();
    const roomA: RoomRecord = { id: "room_use_scope_a", name: "Use scope A", created_at: now, updated_at: now };
    const roomB: RoomRecord = { id: "room_use_scope_b", name: "Use scope B", created_at: now, updated_at: now };
    const agent: AgentRecord = {
      id: "agent_use_scope_a", name: "Use Scope Agent", role: "Review", instructions: "Review only the source Room.",
      backend_id: backend.id, enabled: true, created_at: now, updated_at: now
    };
    await Promise.all([store.createRoom(roomA), store.createRoom(roomB), store.createAgent(agent)]);
    const session = await runtime.createSession({ room_id: roomA.id, title: "Learning use scope fixture" });
    await store.saveMessage({
      id: "message_use_scope",
      session_id: session.id,
      role: "user",
      content: "Do not load a foreign Wiki from an unscoped reference.",
      input_locale: "en",
      output_locale: "en",
      created_at: now
    });
    const sourceRun: BackendRunRecord = {
      id: "run_use_scope",
      session_id: session.id,
      agent_id: agent.id,
      input_message_id: "message_use_scope",
      backend_id: backend.id,
      backend_kind: backend.kind,
      status: "completed",
      started_at: now,
      completed_at: now,
      input_summary: "Scoped review source.",
      metadata: {}
    };
    await store.saveBackendRun(sourceRun);
    const foreignWiki = await store.saveWikiPage(
      wiki("wiki_use_scope_b", "Foreign Wiki", { kind: "room", room_id: roomB.id }),
      "This Room B content must not be loaded."
    );
    await store.recordLearningResourceUse({
      id: "learning_use_unscoped_foreign_wiki",
      run_id: sourceRun.id,
      session_id: session.id,
      resource_kind: "wiki",
      resource_id: foreignWiki.id,
      stage: "body_loaded",
      metadata: { fixture: "legacy_unscoped_reference" },
      created_at: now
    });
    const readWikiContent = vi.spyOn(store, "readWikiContent");

    const reflection = await runtime.runReflection({ sessionId: session.id, sourceRunId: sourceRun.id });
    const foreignWikiWasRead = readWikiContent.mock.calls.some(([id]) => id === foreignWiki.id);
    readWikiContent.mockRestore();
    await store.close();

    expect(reflection.reflectionRun.status).toBe("completed");
    expect(usedWikiFragmentIds).not.toContain(foreignWiki.id);
    expect(foreignWikiWasRead).toBe(false);
  });

  it("fails closed before loading catalog data for an unscoped source run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core05-review-unscoped-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const captured: Array<{ backendId: string; input: BackendRunInput }> = [];
    const started: Array<{ backendId: string; input: BackendSessionInput }> = [];
    const backend = fixtureBackend("backend-unscoped", captured, started);
    let reviewCalls = 0;
    const runtime = new AgentRuntime(
      store,
      undefined,
      undefined,
      new AgentBackendRegistry([backend]),
      undefined,
      undefined,
      undefined,
      {
        backgroundReviewRunner: {
          run: async () => {
            reviewCalls += 1;
            return { reviewer: "unscoped-fixture", summary: "This must not run.", mutations: [] };
          }
        }
      }
    );
    const now = nowIso();
    const roomA: RoomRecord = { id: "room_unscoped_a", name: "Unscoped A", created_at: now, updated_at: now };
    const roomB: RoomRecord = { id: "room_unscoped_b", name: "Unscoped B", created_at: now, updated_at: now };
    await Promise.all([store.createRoom(roomA), store.createRoom(roomB)]);
    const session = await runtime.createSession({ room_id: roomA.id, title: "Unscoped source fixture" });
    await store.saveMessage({
      id: "message_unscoped",
      session_id: session.id,
      role: "user",
      content: "Do not review another Room.",
      input_locale: "en",
      output_locale: "en",
      created_at: now
    });
    await store.saveMemory(memory("memory_unscoped_room_b", "Room B only", { kind: "room", room_id: roomB.id }), "Room B must stay unread.");
    const sourceRun: BackendRunRecord = {
      id: "run_unscoped",
      session_id: session.id,
      input_message_id: "message_unscoped",
      backend_id: backend.id,
      backend_kind: backend.kind,
      status: "completed",
      started_at: now,
      completed_at: now,
      input_summary: "Synthetic system surface.",
      metadata: { generated_surface: true }
    };
    await store.saveBackendRun(sourceRun);

    const reflection = await runtime.runReflection({ sessionId: session.id, sourceRunId: sourceRun.id });
    const [content, changes] = await Promise.all([
      store.readMemoryContent("memory_unscoped_room_b"),
      store.listBackgroundReviewChanges({ sourceRunId: sourceRun.id })
    ]);
    await store.close();

    expect(reviewCalls).toBe(0);
    expect(content).toBe("Room B must stay unread.");
    expect(changes).toEqual([]);
    expect(reflection.reflectionRun).toMatchObject({
      source_run_id: sourceRun.id,
      status: "failed",
      error: `background_review_activity_context_required:${sourceRun.id}`
    });
  });
});

function fixtureBackend(
  id: string,
  captured: Array<{ backendId: string; input: BackendRunInput }>,
  started: Array<{ backendId: string; input: BackendSessionInput }>
): AgentBackend {
  return {
    id,
    kind: "external",
    label: id,
    sessionPolicy: { acquisition: "start_session", resume: "unsupported" },
    execution_owner: "host",
    async startSession(input) {
      started.push({ backendId: id, input });
      return { backend_session_id: `${id}:${input.backend_session_key}`, metadata: {}, started_at: new Date().toISOString() };
    },
    async *runTurn(input) {
      captured.push({ backendId: id, input });
      yield { event_type: "run_started", payload: { input_summary: input.user_input } };
      yield { event_type: "text_delta", payload: { text: `${id} response` } };
      yield {
        event_type: "run_completed",
        terminal_evidence: { kind: "completed", source: "owned_loop_return" },
        payload: { output_summary: `${id} complete` }
      };
    }
  };
}

function result<T>(value: { result: unknown }): T {
  return value.result as T;
}

function workspaceMemory(id: string, topic: string): MemoryFrontmatter {
  return memory(id, topic, { kind: "workspace" });
}

function memory(id: string, topic: string, usage_scope: MemoryFrontmatter["usage_scope"]): MemoryFrontmatter {
  const now = nowIso();
  return {
    id,
    state: "topic",
    topic,
    source: "core05-runtime-test",
    source_locale: "en",
    content_locale: "en",
    source_kind: "owner_instruction",
    instruction_authority: "owner",
    confidence: 0.8,
    created_by: "test",
    created_at: now,
    updated_at: now,
    related_memories: [],
    conflicts_with: [],
    sensitive_level: "none",
    usage_scope
  };
}

function wiki(id: string, title: string, usage_scope: WikiFrontmatter["usage_scope"]): WikiFrontmatter {
  const now = nowIso();
  return {
    id,
    slug: id,
    title,
    state: "active",
    content_locale: "en",
    tags: [],
    usage_scope,
    source_refs: [],
    provenance: { kind: "user_authored", summary: "Core 05 scope fixture", verified: true },
    created_at: now,
    updated_at: now
  };
}
