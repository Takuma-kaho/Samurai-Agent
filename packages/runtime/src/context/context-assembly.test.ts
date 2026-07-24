import { describe, expect, it } from "vitest";
import {
  activeMemoryPreviewEntry,
  buildHostContextAssembly,
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
});
