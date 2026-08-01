import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nowIso,
  type AgentRecord,
  type MemoryFrontmatter,
  type RoomRecord,
  type SessionRecord,
  type SkillFrontmatter,
  type WikiFrontmatter
} from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "./index";

const roots: string[] = [];

async function createStore(): Promise<WorkspaceStore> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core05-store-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core 05 Room and Agent foundation", () => {
  it("keeps Room, Agent, scoped resources, and backup state separate", async () => {
    const store = await createStore();
    const now = nowIso();
    const roomAlpha = room("room_alpha", "Alpha", now);
    const roomBeta = room("room_beta", "Beta", now);
    const agentAlpha = agent("agent_alpha", "Alpha Agent", "Research", "backend-alpha", now);
    const agentBeta = agent("agent_beta", "Beta Agent", "Writing", "backend-beta", now);
    await Promise.all([
      store.createRoom(roomAlpha),
      store.createRoom(roomBeta),
      store.createAgent(agentAlpha),
      store.createAgent(agentBeta)
    ]);

    const sessionAlpha = session("session_alpha", roomAlpha.id, now);
    const sessionBeta = session("session_beta", roomBeta.id, now);
    await Promise.all([store.createSession(sessionAlpha), store.createSession(sessionBeta)]);

    await Promise.all([
      store.saveMemory(memory("memory_workspace", "workspace", { kind: "workspace" }, now), "workspace context"),
      store.saveMemory(memory("memory_room_alpha", "room alpha", { kind: "room", room_id: roomAlpha.id }, now), "alpha context"),
      store.saveMemory(memory("memory_room_beta", "room beta", { kind: "room", room_id: roomBeta.id }, now), "beta context"),
      store.saveMemory(memory("memory_agent_alpha", "agent alpha", { kind: "agent", agent_id: agentAlpha.id }, now), "agent alpha context"),
      store.saveMemory(memory("memory_session_alpha", "session alpha", { kind: "session", session_id: sessionAlpha.id }, now), "session alpha context"),
      store.saveWikiPage(wiki("wiki_workspace", "workspace-note", { kind: "workspace" }, now), "# Workspace"),
      store.saveWikiPage(wiki("wiki_alpha", "alpha-note", { kind: "room", room_id: roomAlpha.id }, now), "# Alpha"),
      store.saveWikiPage(wiki("wiki_beta", "beta-note", { kind: "room", room_id: roomBeta.id }, now), "# Beta"),
      store.saveSkillMarkdown({ state: "project", skillId: "skill_workspace", markdown: skill("skill_workspace", "Workspace Skill", { kind: "workspace" }, now) }),
      store.saveSkillMarkdown({ state: "project", skillId: "skill_alpha", markdown: skill("skill_alpha", "Alpha Skill", { kind: "room", room_id: roomAlpha.id }, now) }),
      store.saveSkillMarkdown({ state: "project", skillId: "skill_beta", markdown: skill("skill_beta", "Beta Skill", { kind: "room", room_id: roomBeta.id }, now) })
    ]);

    const alphaContext = { room_id: roomAlpha.id, session_id: sessionAlpha.id, agent_id: agentAlpha.id };
    const betaContext = { room_id: roomBeta.id, session_id: sessionBeta.id, agent_id: agentBeta.id };
    const [alphaMemories, betaMemories, alphaWiki, betaWiki, alphaSkills, betaSkills] = await Promise.all([
      store.listMemory({ activityContext: alphaContext }),
      store.listMemory({ activityContext: betaContext }),
      store.listWiki({ activeOnly: false, activityContext: alphaContext }),
      store.listWiki({ activeOnly: false, activityContext: betaContext }),
      store.listSkills({ activityContext: alphaContext }),
      store.listSkills({ activityContext: betaContext })
    ]);

    expect(ids(alphaMemories)).toEqual(new Set(["memory_workspace", "memory_room_alpha", "memory_agent_alpha", "memory_session_alpha"]));
    expect(ids(betaMemories)).toEqual(new Set(["memory_workspace", "memory_room_beta"]));
    expect(ids(alphaWiki)).toEqual(new Set(["wiki_workspace", "wiki_alpha"]));
    expect(ids(betaWiki)).toEqual(new Set(["wiki_workspace", "wiki_beta"]));
    expect(ids(alphaSkills)).toEqual(new Set(["skill_workspace", "skill_alpha"]));
    expect(ids(betaSkills)).toEqual(new Set(["skill_workspace", "skill_beta"]));

    const backup = await store.createWorkspaceBackup();
    await store.patchRoom({ id: roomAlpha.id, name: "Changed Room" });
    await store.patchAgent({ id: agentAlpha.id, role: "Changed role" });
    const restore = await store.restoreWorkspaceBackup(backup.id);
    const [restoredRoom, restoredAgent, restoredMemories, migrations] = await Promise.all([
      store.getRoom(roomAlpha.id),
      store.getAgent(agentAlpha.id),
      store.listMemory({ activityContext: alphaContext }),
      store.listSchemaMigrations()
    ]);
    await store.close();

    expect(migrations.map((migration) => migration.version)).toContain(7);
    expect(backup.manifest.file_roots).not.toContain("rooms");
    expect(backup.manifest.file_roots).not.toContain("agents");
    expect(restore.db_restored).toBe(true);
    expect(restoredRoom).toMatchObject({ id: roomAlpha.id, name: "Alpha" });
    expect(restoredAgent).toMatchObject({ id: agentAlpha.id, role: "Research", backend_id: "backend-alpha" });
    expect(ids(restoredMemories)).toEqual(new Set(["memory_workspace", "memory_room_alpha", "memory_agent_alpha", "memory_session_alpha"]));
  });
});

function room(id: string, name: string, now: string): RoomRecord {
  return { id, name, created_at: now, updated_at: now };
}

function agent(id: string, name: string, role: string, backend_id: string, now: string): AgentRecord {
  return { id, name, role, instructions: `${role} instructions`, backend_id, enabled: true, created_at: now, updated_at: now };
}

function session(id: string, room_id: string, now: string): SessionRecord {
  return { id, session_key: `test:${id}`, room_id, title: id, ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
}

function memory(id: string, topic: string, usage_scope: MemoryFrontmatter["usage_scope"], now: string): MemoryFrontmatter {
  return {
    id, state: "topic", topic, source: "core05-test", source_locale: "ja", content_locale: "ja",
    source_kind: "owner_instruction", instruction_authority: "owner", confidence: 0.8, created_by: "test",
    created_at: now, updated_at: now, related_memories: [], conflicts_with: [], sensitive_level: "none", usage_scope
  };
}

function wiki(id: string, slug: string, usage_scope: WikiFrontmatter["usage_scope"], now: string): WikiFrontmatter {
  return {
    id, slug, title: slug, state: "active", content_locale: "ja", tags: [], source_refs: [],
    provenance: { kind: "user_authored", summary: "Core 05 scope test", verified: true }, usage_scope,
    created_at: now, updated_at: now
  };
}

function skill(id: string, title: string, usage_scope: SkillFrontmatter["usage_scope"], now: string): string {
  const frontmatter: SkillFrontmatter = {
    id, state: "project", title, description: title, tags: [], provenance: "generated_local", trust_level: "generated_local",
    allowed_scopes: ["skill"], required_capabilities: [], schedule_policy: {}, secret_policy: {}, owner_pinned: false,
    last_reviewed_at: now, usage_scope
  };
  return ["---", JSON.stringify(frontmatter, null, 2), "---", "# Body", ""].join("\n");
}

function ids<T extends { id: string }>(items: T[]): Set<string> {
  return new Set(items.map((item) => item.id));
}
