import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBackendRegistry, type AgentBackend } from "@samurai-agent/agent-backends";
import { nowIso, type AgentRecord, type BackendRunRecord, type MemoryFrontmatter, type RoomRecord, type SessionRecord, type SkillFrontmatter, type WikiFrontmatter } from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime } from "./agent-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core 05 Phase 1 learning foundation", () => {
  it("uses only the trusted Run Activity Context for Provider Knowledge search", async () => {
    const { store, roomA, roomB, agentA, agentB, sessionA, sessionB, runA, runB } = await scopedStore();
    const runtime = new AgentRuntime(store);
    const now = nowIso();
    await Promise.all([
      store.saveMemory(memory("memory-workspace", "shared search", { kind: "workspace" }, now), "shared"),
      store.saveMemory(memory("memory-room-a", "room a search", { kind: "room", room_id: roomA.id }, now), "a"),
      store.saveMemory(memory("memory-room-b", "room b search", { kind: "room", room_id: roomB.id }, now), "b"),
      store.saveWikiPage(wiki("wiki-workspace", "shared-search", { kind: "workspace" }, now), "# Shared"),
      store.saveWikiPage(wiki("wiki-room-b", "room-b-search", { kind: "room", room_id: roomB.id }, now), "# Room B"),
      store.saveSkillMarkdown({ state: "project", skillId: "skill-workspace", markdown: skill("skill-workspace", "shared search skill", { kind: "workspace" }, now, "workspace catalog") }),
      store.saveSkillMarkdown({ state: "project", skillId: "skill-room-b", markdown: skill("skill-room-b", "room b search skill", { kind: "room", room_id: roomB.id }, now, "Room B body must stay unread") })
    ]);
    const readSkillMarkdown = vi.spyOn(store, "readSkillMarkdown");

    const [memoryA, wikiA, skillA, memoryB] = await Promise.all([
      runtime.runDomainQuery({ query_id: "memory.search", payload: { query: "search" } }, { runId: runA.id }),
      runtime.runDomainQuery({ query_id: "wiki.search", payload: { query: "search" } }, { runId: runA.id }),
      runtime.runDomainQuery({ query_id: "skill.search", payload: { query: "search" } }, { runId: runA.id }),
      runtime.runDomainQuery({ query_id: "memory.search", payload: { query: "search" } }, { runId: runB.id })
    ]);

    expect(ids(memoryA.result as Array<{ id: string }>)).toEqual(new Set(["memory-workspace", "memory-room-a"]));
    expect(ids(wikiA.result as Array<{ id: string }>)).toEqual(new Set(["wiki-workspace"]));
    expect(ids(skillA.result as Array<{ id: string }>)).toEqual(new Set(["skill-workspace"]));
    expect(ids(memoryB.result as Array<{ id: string }>)).toEqual(new Set(["memory-workspace", "memory-room-b"]));
    expect(readSkillMarkdown).not.toHaveBeenCalled();
    await expect(runtime.runDomainQuery({ query_id: "skill.view", payload: { skill_id: "skill-room-b" } }, { runId: runA.id }))
      .rejects.toThrow("skill_usage_scope_mismatch");
    expect(readSkillMarkdown).not.toHaveBeenCalled();
    await expect(runtime.runDomainQuery({ query_id: "memory.search", payload: { query: "search" } })).rejects.toThrow("domain_operation_trusted_context_missing:memory.search:runId");

    const unscopedRun: BackendRunRecord = { ...runA, id: "run-unscoped-search", agent_id: undefined };
    await store.saveBackendRun(unscopedRun);
    await expect(runtime.runDomainQuery({ query_id: "skill.search", payload: { query: "search" } }, { runId: unscopedRun.id }))
      .rejects.toThrow();
    readSkillMarkdown.mockRestore();
    await store.close();
  });

  it("records Provider skill body and support use after scope-checked view", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core05-skill-use-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const now = nowIso();
    const room: RoomRecord = { id: "room-skill-use", name: "Skill use", created_at: now, updated_at: now };
    const agent: AgentRecord = { id: "agent-skill-use", name: "Skill agent", role: "Research", instructions: "Use scoped skill.", backend_id: "skill-bridge", enabled: true, created_at: now, updated_at: now };
    const session: SessionRecord = { id: "session-skill-use", session_key: "skill-use", room_id: room.id, title: "Skill use", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
    await Promise.all([store.createRoom(room), store.createAgent(agent), store.createSession(session)]);
    await store.saveSkillMarkdown({ state: "project", skillId: "skill-use", markdown: skill("skill-use", "Scoped skill", { kind: "room", room_id: room.id }, now, "Skill body") });
    await store.writeSkillSupportFile({ skillId: "skill-use", path: "references/check.md", content: "Support content" });

    let runtime: AgentRuntime;
    const backend: AgentBackend = {
      id: "skill-bridge", kind: "external", label: "Skill bridge", sessionPolicy: { acquisition: "none", resume: "unsupported" }, execution_owner: "host",
      async *runTurn(input) {
        const bridge = input.tool_bridge;
        expect(bridge?.enabled).toBe(true);
        const base = { runId: input.run_id, token: bridge?.token ?? "", toolName: "mcp__samurai__skill_view" };
        await runtime.runBackendToolBridgeCall({ ...base, toolCallId: "skill-body-1", toolInput: { skill_id: "skill-use" } });
        await runtime.runBackendToolBridgeCall({ ...base, toolCallId: "skill-body-2", toolInput: { skill_id: "skill-use" } });
        await runtime.runBackendToolBridgeCall({ ...base, toolCallId: "skill-support-1", toolInput: { skill_id: "skill-use", path: "references/check.md" } });
        yield { event_type: "run_completed", terminal_evidence: { kind: "completed", source: "owned_loop_return" }, payload: { output_summary: "done" } };
      }
    };
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const result = await runtime.runChatTurn({ sessionId: session.id, agent_id: agent.id, content: "Use the scoped skill" });
    const [uses, usage] = await Promise.all([
      store.listLearningResourceUses({ runId: result.backendRun.id }),
      store.listSkillUsage()
    ]);
    await store.close();

    expect(uses).toContainEqual(expect.objectContaining({
      resource_id: "skill-use", stage: "body_loaded",
      activity_context: { room_id: room.id, session_id: session.id, agent_id: agent.id },
      metadata: expect.objectContaining({ provider_query_id: "skill.view", provider_tool_call_id: "skill-body-1" })
    }));
    expect(uses).toContainEqual(expect.objectContaining({ resource_id: "skill-use:references/check.md", stage: "support_loaded" }));
    expect(uses.filter((use) => use.resource_id === "skill-use" && use.stage === "body_loaded")).toHaveLength(1);
    expect(usage).toContainEqual(expect.objectContaining({ skill_id: "skill-use", use_count: 1 }));
  });
});

async function scopedStore() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core05-search-"));
  roots.push(root);
  const store = await WorkspaceStore.create({ rootDir: root });
  const now = nowIso();
  const roomA: RoomRecord = { id: "room-a", name: "A", created_at: now, updated_at: now };
  const roomB: RoomRecord = { id: "room-b", name: "B", created_at: now, updated_at: now };
  const agentA: AgentRecord = { id: "agent-a", name: "A", role: "Research", instructions: "Read scoped resources.", backend_id: "backend-a", enabled: true, created_at: now, updated_at: now };
  const agentB: AgentRecord = { id: "agent-b", name: "B", role: "Research", instructions: "Read scoped resources.", backend_id: "backend-b", enabled: true, created_at: now, updated_at: now };
  const sessionA: SessionRecord = { id: "session-a", session_key: "a", room_id: roomA.id, title: "A", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
  const sessionB: SessionRecord = { id: "session-b", session_key: "b", room_id: roomB.id, title: "B", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
  await Promise.all([store.createRoom(roomA), store.createRoom(roomB), store.createAgent(agentA), store.createAgent(agentB), store.createSession(sessionA), store.createSession(sessionB)]);
  await Promise.all([
    store.saveMessage({ id: "message-a", session_id: sessionA.id, role: "user", content: "search", input_locale: "ja", output_locale: "ja", created_at: now }),
    store.saveMessage({ id: "message-b", session_id: sessionB.id, role: "user", content: "search", input_locale: "ja", output_locale: "ja", created_at: now })
  ]);
  const runA: BackendRunRecord = { id: "run-a", session_id: sessionA.id, agent_id: agentA.id, input_message_id: "message-a", backend_id: "backend-a", backend_kind: "external", status: "completed", started_at: now, completed_at: now, input_summary: "search", metadata: {} };
  const runB: BackendRunRecord = { id: "run-b", session_id: sessionB.id, agent_id: agentB.id, input_message_id: "message-b", backend_id: "backend-b", backend_kind: "external", status: "completed", started_at: now, completed_at: now, input_summary: "search", metadata: {} };
  await Promise.all([store.saveBackendRun(runA), store.saveBackendRun(runB)]);
  return { store, roomA, roomB, agentA, agentB, sessionA, sessionB, runA, runB };
}

function memory(id: string, topic: string, usage_scope: MemoryFrontmatter["usage_scope"], now: string): MemoryFrontmatter {
  return { id, state: "topic", topic, source: "test", source_locale: "ja", content_locale: "ja", source_kind: "owner_instruction", instruction_authority: "owner", confidence: 0.8, created_by: "test", created_at: now, updated_at: now, related_memories: [], conflicts_with: [], sensitive_level: "none", usage_scope };
}

function wiki(id: string, slug: string, usage_scope: WikiFrontmatter["usage_scope"], now: string): WikiFrontmatter {
  return { id, slug, title: slug, state: "active", content_locale: "ja", tags: ["search"], source_refs: [], provenance: { kind: "user_authored", summary: "test", verified: true }, usage_scope, created_at: now, updated_at: now };
}

function skill(id: string, title: string, usage_scope: SkillFrontmatter["usage_scope"], now: string, body: string): string {
  const frontmatter: SkillFrontmatter = { id, state: "project", title, description: title, tags: ["search"], provenance: "generated_local", trust_level: "generated_local", allowed_scopes: ["skill"], required_capabilities: [], schedule_policy: {}, secret_policy: {}, owner_pinned: false, last_reviewed_at: now, usage_scope };
  return ["---", JSON.stringify(frontmatter, null, 2), "---", body, ""].join("\n");
}

function ids<T extends { id: string }>(items: T[]): Set<string> {
  return new Set(items.map((item) => item.id));
}
