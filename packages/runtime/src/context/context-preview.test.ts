import { describe, expect, it } from "vitest";
import type { SettingsRecord } from "@samurai-agent/core-schemas";
import { buildContextPreview, type ContextPreviewPorts } from "./context-preview.js";

const now = "2026-01-01T00:00:00.000Z";
const settings: SettingsRecord = {
  ui_locale: "ja",
  output_locale: "ja",
  memory_capture_mode: "suggest",
  knowledge_wiki_capture_mode: "suggest",
  skill_capture_mode: "suggest",
  external_provider_role: "assistive",
  default_agent_id: "agent-1",
  updated_at: now
};

function makePorts(overrides: Partial<ContextPreviewPorts> = {}, progress: string[] = []): ContextPreviewPorts {
  const skill = {
    id: "skill-1",
    title: "Deploy",
    description: "deploy helper",
    tags: ["deploy"],
    state: "pinned" as const,
    allowed_scopes: ["workspace" as const],
    required_capabilities: ["deploy"],
    owner_pinned: true,
    frontmatter: { allowed_scopes: ["workspace" as const], owner_pinned: true },
    file_path: "skills/pinned/skill-1.md"
  };
  const base: ContextPreviewPorts = {
    session: {
      getSession: async () => ({ id: "session-1", session_key: "main", room_id: "room-1", title: "Main", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now }),
      getSettings: async () => settings
    },
    summary: {
      listMessages: async () => [{ id: "message-1", session_id: "session-1", role: "user", content: "deploy", input_locale: "ja", output_locale: "ja", created_at: now }],
      listOperations: async () => [],
      listBackendRuns: async () => [],
      listToolRuns: async () => [],
      listWorkspaceChanges: async () => []
    },
    memory: {
      retrieve: async () => ({ candidates: [{ frontmatter: { id: "memory-1", topic: "deploy", state: "active", sensitive_level: "none", conflicts_with: [] }, content: "memory", priority: "primary", selection_reason: "matched" }], report: { query: "deploy", retrieved_at: now, candidate_count: 1, included_count: 1, included_memory_ids: ["memory-1"], excluded: [], sensitive_redactions: [], conflict_groups: [], resolution_suggestions: [] } }),
      loadFreezeSnapshot: async () => undefined
    },
    wiki: {
      build: async (query) => ({ pages: [], entries: [], report: { query, retrieved_at: now, candidate_count: 0, included_count: 0, included_wiki_ids: [], excluded: [], source_refs: [] } })
    },
    skills: {
      search: async () => [skill],
      listUsage: async () => [{ skill_id: "skill-1", use_count: 2, created_at: now, updated_at: now }],
      listSupportFileRefs: async () => [{ skill_id: "skill-1", path: "references/deploy.md", file_path: "skills/support/skill-1/references/deploy.md" }],
      environment: { runtime: "local_workspace", platform: "test", availableCapabilities: ["deploy"], supportedScopes: new Set(["workspace"]) }
    },
    collections: {
      listSchemas: async () => [],
      listNotes: async () => []
    },
    sessionSearch: {
      search: async () => [{ kind: "message", id: "old-1", title: "old", summary: "previous" }]
    },
    externalAssist: {
      build: async () => ({ role: "assistive", isolated_from_memory: true, included_in_active_memory: false, note: "failed", hints: [], recent_failures: [{ id: "external-1", phase: "prefetch", status: "failed", provider_id: "fixture", session_id: "session-1", query: "deploy", role: "assistive", hints: [], error: "failed", isolated_from_memory: true, included_in_active_memory: false, created_at: now, updated_at: now }] })
    },
    tools: { listAvailable: () => ["deploy"] },
    errors: { sessionNotFound: (id) => new Error(`Session not found: ${id}`) },
    clock: { now: () => now },
    progress: { report: async (kind) => { progress.push(kind); } }
  };
  return { ...base, ...overrides };
}

describe("context preview orchestration", () => {
  it("assembles full context and passes freeze refs with file paths", async () => {
    let freezeInput: { memoryRefs: Array<{ uri: string }>; skillRefs: Array<{ uri: string }>; wikiRefs: Array<{ uri: string }> } | undefined;
    const ports = makePorts();
    ports.memory.loadFreezeSnapshot = async (input) => {
      freezeInput = input;
      return undefined;
    };
    const preview = await buildContextPreview({ sessionId: "session-1", query: "deploy", ports });
    expect(preview.session_summary.message_count).toBe(1);
    expect(preview.selected_skills[0]).toMatchObject({ id: "skill-1", usage: { use_count: 2 }, disclosure_level: "catalog" });
    expect(preview.external_assist.recent_failures).toHaveLength(1);
    expect(freezeInput?.memoryRefs[0]?.uri).toBe("memory/active/memory-1.md");
    expect(freezeInput?.skillRefs[0]?.uri).toBe("skills/pinned/skill-1.md");
  });

  it("skips heavy sources and reports missing sessions", async () => {
    const progress: string[] = [];
    const ports = makePorts({}, progress);
    const preview = await buildContextPreview({ sessionId: "session-1", query: "hi", ports, skipHeavyContext: true });
    expect(preview.active_memory).toEqual([]);
    expect(preview.selected_skills).toEqual([]);
    expect(preview.external_assist.hints).toEqual([]);
    expect(progress).toContain("activity");

    const missing = makePorts({ session: { getSession: async () => undefined, getSettings: async () => settings } });
    await expect(buildContextPreview({ sessionId: "missing", query: "hi", ports: missing })).rejects.toThrow("Session not found: missing");
  });

  it("continues chat context while omitting Knowledge without a full Activity Context", async () => {
    const ports = makePorts();
    const calls = { memory: 0, wiki: 0, skills: 0 };
    ports.session.getSession = async () => ({ id: "session-1", session_key: "main", title: "Main", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now });
    ports.memory.retrieve = async () => { calls.memory += 1; return emptyMemoryResult(); };
    ports.wiki.build = async (query) => { calls.wiki += 1; return { pages: [], entries: [], report: { query, retrieved_at: now, candidate_count: 0, included_count: 0, included_wiki_ids: [], excluded: [], source_refs: [] } }; };
    ports.skills.search = async () => { calls.skills += 1; return []; };

    const preview = await buildContextPreview({ sessionId: "session-1", query: "deploy", ports });

    expect(preview.session_summary.session_key).toBe("main");
    expect(preview.active_memory).toEqual([]);
    expect(preview.knowledge_wiki).toEqual([]);
    expect(preview.selected_skills).toEqual([]);
    expect(calls).toEqual({ memory: 0, wiki: 0, skills: 0 });
  });

  it("reports session-search timeout progress", async () => {
    const progress: string[] = [];
    const ports = makePorts({}, progress);
    ports.sessionSearch.search = () => new Promise(() => undefined);
    await buildContextPreview({ sessionId: "session-1", query: "search previous history", ports });
    expect(progress).toContain("reasoning_summary");
  }, 5000);
});

function emptyMemoryResult() {
  return {
    candidates: [],
    report: { query: "", retrieved_at: now, candidate_count: 0, included_count: 0, included_memory_ids: [], excluded: [], sensitive_redactions: [], conflict_groups: [], resolution_suggestions: [] }
  };
}
