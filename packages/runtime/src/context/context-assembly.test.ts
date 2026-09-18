import { describe, expect, it } from "vitest";
import {
  activeMemoryPreviewEntry,
  assembleRuntimeExecutionContext,
  buildHostContextAssembly,
  buildRuntimeExecutionContext,
  hostContextAssemblyLimits,
  shouldIncludeSessionSearchInBackendContext
} from "./context-assembly.js";

describe("host context assembly", () => {
  it("preserves source limits, omissions, and quality checks", () => {
    const assembly = buildHostContextAssembly({
      sessionId: "session-1",
      query: "前回の作業の続き",
      sessionFound: true,
      messageCount: 12,
      recentMessageCount: 10,
      freezeSnapshotPresent: false,
      activeMemoryCandidateCount: 3,
      activeMemoryCount: 2,
      knowledgeWikiCandidateCount: 4,
      knowledgeWikiIncludedCount: 3,
      collectionNoteCandidateCount: 6,
      collectionNoteIncludedCount: 5,
      selectedSkillCount: 2,
      sessionSearchCandidateCount: 10,
      sessionSearchIncludedCount: 8,
      externalAssistRole: "assistive",
      externalAssistHintCount: 1,
      externalAssistFailureCount: 1,
      availableToolCount: 2
    });

    expect(assembly.limits).toEqual(hostContextAssemblyLimits);
    expect(assembly.sources.find((source) => source.kind === "recent_messages")).toMatchObject({ status: "filtered", candidate_count: 12, included_count: 10 });
    expect(assembly.sources.find((source) => source.kind === "external_assist")).toMatchObject({ status: "included", candidate_count: 2, included_count: 1 });
    expect(assembly.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "recent_messages", count: 2 }),
      expect.objectContaining({ kind: "external_assist", count: 1 }),
      expect.objectContaining({ kind: "freeze_snapshot" })
    ]));
    expect(assembly.quality_checks.find((check) => check.id === "session_loaded")).toMatchObject({ status: "pass" });
    expect(assembly.quality_checks.find((check) => check.id === "freeze_snapshot_loaded")).toMatchObject({ status: "warning" });
  });

  it("does not search history for greeting-only input", () => {
    expect(shouldIncludeSessionSearchInBackendContext("こんにちは！")).toBe(false);
    expect(shouldIncludeSessionSearchInBackendContext("前回の続き教えて")).toBe(true);
    expect(shouldIncludeSessionSearchInBackendContext("この作業について詳しく説明してください")).toBe(true);
  });

  it("maps active and sensitive memory state for the preview", () => {
    const base = {
      frontmatter: { id: "memory-1", topic: "topic", sensitive_level: "none" as const, conflicts_with: [] },
      content: "remembered detail",
      priority: "primary" as const,
      selection_reason: "matched"
    };
    expect(activeMemoryPreviewEntry({ ...base, frontmatter: { ...base.frontmatter, state: "active" as const } })).toMatchObject({ id: "memory-1", state: "active", priority: "primary" });
    expect(activeMemoryPreviewEntry({ ...base, frontmatter: { ...base.frontmatter, state: "sensitive" as const, sensitive_level: "high" as const }, priority: "sensitive" })).toMatchObject({ state: "sensitive", sensitive_level: "high", priority: "sensitive" });
  });

  it("mixes Room and Agent Completion resources while excluding Workspace scope", () => {
    const hash = "a".repeat(64);
    const context = buildRuntimeExecutionContext({
      roomId: "room-1",
      agentId: "agent-1",
      query: "deploy",
      agentKnowledge: [{
        id: "agent-k",
        kind: "knowledge",
        title: "Agent preference",
        version: 2,
        contentHash: hash,
        sourceScope: { kind: "agent", agent_id: "agent-1" },
        content: "Agent-only context"
      }],
      agentSkills: [{
        id: "agent-s",
        kind: "skill",
        title: "Deploy Skill",
        version: 4,
        contentHash: hash,
        sourceScope: { kind: "agent", agent_id: "agent-1" },
        disclosureLevel: "catalog",
        content: "must not be inlined"
      }],
      // This is deliberately malformed for the Runtime boundary. It must be
      // filtered even when a lower layer accidentally returns it.
      roomKnowledge: [
        {
          id: "room-k",
          kind: "knowledge",
          title: "Room runbook",
          version: 3,
          contentHash: hash,
          sourceScope: { kind: "room", room_id: "room-1" },
          content: "Room-only procedure"
        },
        {
          id: "workspace-k",
          kind: "knowledge",
          title: "Workspace legacy",
          version: 1,
          contentHash: hash,
          sourceScope: { kind: "workspace" as never },
          content: "must never execute"
        }
      ]
    });

    expect(context.resource_refs.map((ref) => ref.id)).toEqual(["room-k", "agent-k", "agent-s"]);
    expect(context.resource_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "room-k", version: "3", content_hash: hash, source_scope: { kind: "room", room_id: "room-1" } }),
      expect.objectContaining({ id: "agent-k", source_scope: { kind: "agent", agent_id: "agent-1" } })
    ]));
    expect(context.resources.find((resource) => resource.id === "agent-s")).not.toHaveProperty("content");
    expect(context.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ id: "workspace-k" })]));
  });

  it("applies one total resource/content budget across Room and Agent scopes", () => {
    const candidate = (id: string, rank: number) => ({
      id,
      kind: "knowledge" as const,
      title: id,
      version: 1,
      contentHash: "b".repeat(64),
      sourceScope: { kind: "room" as const, room_id: "room-1" },
      rank,
      content: "12345"
    });
    const context = assembleRuntimeExecutionContext({
      roomId: "room-1",
      agentId: "agent-1",
      query: "q",
      roomKnowledge: [candidate("first", 3), candidate("second", 2)],
      agentKnowledge: [],
      agentSkills: [],
      limits: { max_resources: 3, max_content_chars: 5 }
    });
    expect(context.resources.map((resource) => resource.id)).toEqual(["first"]);
    expect(context.resources[0]?.content).toBe("12345");
    expect(context.included_content_chars).toBe(5);
    expect(context.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ id: "second", reason: "total_content_limit" })]));
  });

  it("only includes Skill body/support text when the selector explicitly allows it", () => {
    const base = {
      id: "skill-1",
      kind: "skill" as const,
      title: "Skill",
      version: 1,
      contentHash: "c".repeat(64),
      sourceScope: { kind: "agent" as const, agent_id: "agent-1" },
      content: "skill body",
      supportFiles: [{ path: "references/a.md", content: "support" }]
    };
    const denied = assembleRuntimeExecutionContext({ roomId: "room-1", agentId: "agent-1", query: "skill", agentSkills: [{ ...base, disclosureLevel: "body", bodyAllowed: false }] });
    expect(denied.resources).toHaveLength(0);
    const allowed = assembleRuntimeExecutionContext({ roomId: "room-1", agentId: "agent-1", query: "skill", agentSkills: [{ ...base, disclosureLevel: "support", bodyAllowed: true }] });
    expect(allowed.resources[0]).toMatchObject({ disclosure_level: "support", support_files: [{ path: "references/a.md", content: "support" }] });
    expect(allowed.resources[0]).not.toHaveProperty("content");
  });
});
