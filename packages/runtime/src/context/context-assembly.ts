import { nowIso, type ContextPreview, type HostContextAssembly, type MemoryFrontmatter } from "@samurai-agent/core-schemas";

export const hostContextAssemblyLimits = {
  recent_messages: 10,
  knowledge_wiki: 5,
  collection_notes: 5,
  selected_skills: 5,
  session_search: 8
} as const;

export interface MemoryPreviewCandidate {
  frontmatter: Pick<MemoryFrontmatter, "id" | "topic" | "state" | "sensitive_level" | "conflicts_with">;
  content: string;
  priority: "primary" | "sensitive" | "conflict";
  selection_reason: string;
}

export function activeMemoryPreviewEntry(memory: MemoryPreviewCandidate): ContextPreview["active_memory"][number] {
  return {
    id: memory.frontmatter.id,
    topic: memory.frontmatter.topic,
    content: memory.content,
    state: memory.frontmatter.state === "sensitive" ? "sensitive" : memory.frontmatter.state === "active" ? "active" : "topic",
    sensitive_level: memory.frontmatter.sensitive_level,
    priority: memory.priority,
    selection_reason: memory.selection_reason,
    conflicts_with: memory.frontmatter.conflicts_with
  };
}

export interface BuildHostContextAssemblyInput {
  sessionId: string;
  query: string;
  assembledAt?: string;
  sessionFound: boolean;
  messageCount: number;
  recentMessageCount: number;
  freezeSnapshotPresent: boolean;
  activeMemoryCandidateCount: number;
  activeMemoryCount: number;
  knowledgeWikiCandidateCount: number;
  knowledgeWikiIncludedCount: number;
  collectionNoteCandidateCount: number;
  collectionNoteIncludedCount: number;
  selectedSkillCount: number;
  sessionSearchCandidateCount: number;
  sessionSearchIncludedCount: number;
  externalAssistRole: "assistive" | "disabled";
  externalAssistHintCount: number;
  externalAssistFailureCount: number;
  availableToolCount: number;
  skippedSourceKinds?: Set<HostContextAssembly["sources"][number]["kind"]>;
}

export function buildHostContextAssembly(input: BuildHostContextAssemblyInput): HostContextAssembly {
  const omissions = contextAssemblyOmissions(input);
  return {
    version: 1,
    assembled_at: input.assembledAt ?? nowIso(),
    session_id: input.sessionId,
    query: input.query,
    sources: [
      contextAssemblySource("session", input.sessionFound ? "included" : "missing", 1, input.sessionFound ? 1 : 0, input.sessionFound ? "Session record was loaded from Workspace Store." : "Session record was not found."),
      contextAssemblySource("recent_messages", contextAssemblyStatus(input.messageCount, input.recentMessageCount), input.messageCount, input.recentMessageCount, `Latest ${hostContextAssemblyLimits.recent_messages} message(s) are kept for backend context.`),
      contextAssemblySource("freeze_snapshot", input.freezeSnapshotPresent ? "included" : "missing", input.freezeSnapshotPresent ? 1 : 0, input.freezeSnapshotPresent ? 1 : 0, input.freezeSnapshotPresent ? "Profile snapshot was loaded for this turn." : "No profile snapshot could be loaded.", input.skippedSourceKinds),
      contextAssemblySource("active_memory", contextAssemblyStatus(input.activeMemoryCandidateCount, input.activeMemoryCount), input.activeMemoryCandidateCount, input.activeMemoryCount, "Only accepted active/topic/sensitive Memory candidates are included for normal backend context.", input.skippedSourceKinds),
      contextAssemblySource("knowledge_wiki", contextAssemblyStatus(input.knowledgeWikiCandidateCount, input.knowledgeWikiIncludedCount), input.knowledgeWikiCandidateCount, input.knowledgeWikiIncludedCount, "Only active Knowledge Wiki pages with readable content are included.", input.skippedSourceKinds),
      contextAssemblySource("collection_notes", contextAssemblyStatus(input.collectionNoteCandidateCount, input.collectionNoteIncludedCount), input.collectionNoteCandidateCount, input.collectionNoteIncludedCount, "Collection notes are selected as context-only hints.", input.skippedSourceKinds),
      contextAssemblySource("selected_skills", contextAssemblyStatus(input.selectedSkillCount, input.selectedSkillCount), input.selectedSkillCount, input.selectedSkillCount, "Skill index search selected reusable procedures with progressive disclosure.", input.skippedSourceKinds),
      contextAssemblySource("session_search", contextAssemblyStatus(input.sessionSearchCandidateCount, input.sessionSearchIncludedCount), input.sessionSearchCandidateCount, input.sessionSearchIncludedCount, `Session Search is capped at ${hostContextAssemblyLimits.session_search} result(s).`, input.skippedSourceKinds),
      contextAssemblySource(
        "external_assist",
        externalAssistSourceStatus(input.externalAssistRole, input.externalAssistHintCount),
        input.externalAssistHintCount + input.externalAssistFailureCount,
        input.externalAssistHintCount,
        externalAssistSourceReason(input.externalAssistRole, input.externalAssistHintCount, input.externalAssistFailureCount),
        input.skippedSourceKinds
      ),
      contextAssemblySource("available_tools", input.availableToolCount > 0 ? "included" : "empty", input.availableToolCount, input.availableToolCount, "Workspace tool catalog was exposed before any Gateway boundary filtering."),
      contextAssemblySource("gateway_boundary", "missing", 0, 0, "No Gateway boundary policy was attached to this preview.")
    ],
    omissions,
    limits: hostContextAssemblyLimits,
    gateway_boundary: {
      present: false,
      allowed_tools_count: 0,
      available_tools_before_boundary: input.availableToolCount,
      available_tools_after_boundary: input.availableToolCount,
      filtered_tool_count: 0,
      reason: "No Gateway boundary policy was attached to this preview."
    },
    quality_checks: [
      {
        id: "session_loaded",
        status: input.sessionFound ? "pass" : "fail",
        detail: input.sessionFound ? "Session context is available." : "Host cannot assemble context without a session."
      },
      {
        id: "active_wiki_only",
        status: "pass",
        detail: "Knowledge Wiki retrieval used active-only search."
      },
      {
        id: "external_assist_isolated",
        status: "pass",
        detail: "External assist is not included in accepted active Memory."
      },
      {
        id: "collection_notes_context_only",
        status: "pass",
        detail: "Collection notes remain context-only and do not relax schema validation."
      },
      {
        id: "available_tools_catalog",
        status: input.availableToolCount > 0 ? "pass" : "warning",
        detail: input.availableToolCount > 0 ? "Workspace tool catalog is available." : "No workspace tools are available to this run."
      },
      {
        id: "freeze_snapshot_loaded",
        status: input.freezeSnapshotPresent || input.skippedSourceKinds?.has("freeze_snapshot") ? "pass" : "warning",
        detail: input.skippedSourceKinds?.has("freeze_snapshot")
          ? "Profile snapshot was intentionally skipped for this lightweight turn."
          : input.freezeSnapshotPresent ? "Profile snapshot is pinned for this turn." : "Profile snapshot is missing for this turn."
      }
    ]
  };
}

export function externalAssistSourceStatus(
  role: "assistive" | "disabled",
  hintCount: number
): HostContextAssembly["sources"][number]["status"] {
  if (role === "disabled") {
    return "disabled";
  }
  return hintCount > 0 ? "included" : "empty";
}

export function externalAssistSourceReason(role: "assistive" | "disabled", hintCount: number, failureCount: number): string {
  if (role === "disabled") {
    return "External assist is disabled in workspace settings.";
  }
  if (hintCount > 0) {
    return "External assist returned unverified hints isolated from Memory.";
  }
  if (failureCount > 0) {
    return "External assist failed non-fatally; accepted Memory and Session Search remain available.";
  }
  return "External assist is enabled but returned no hint for this query.";
}

export function contextAssemblyStatus(candidateCount: number, includedCount: number): HostContextAssembly["sources"][number]["status"] {
  if (candidateCount === 0 && includedCount === 0) {
    return "empty";
  }
  if (includedCount < candidateCount) {
    return "filtered";
  }
  return includedCount > 0 ? "included" : "empty";
}

export function contextAssemblySource(
  kind: HostContextAssembly["sources"][number]["kind"],
  status: HostContextAssembly["sources"][number]["status"],
  candidateCount: number,
  includedCount: number,
  reason: string,
  skippedSourceKinds?: Set<HostContextAssembly["sources"][number]["kind"]>
): HostContextAssembly["sources"][number] {
  if (skippedSourceKinds?.has(kind)) {
    return {
      kind,
      status: "skipped",
      candidate_count: 0,
      included_count: 0,
      reason: "Skipped for lightweight external backend context."
    };
  }
  return {
    kind,
    status,
    candidate_count: Math.max(0, candidateCount),
    included_count: Math.max(0, includedCount),
    reason
  };
}

export function contextAssemblyOmissions(input: BuildHostContextAssemblyInput): HostContextAssembly["omissions"] {
  const omissions: HostContextAssembly["omissions"] = [];
  if (input.messageCount > input.recentMessageCount) {
    omissions.push({
      kind: "recent_messages",
      count: input.messageCount - input.recentMessageCount,
      reason: `Older messages were omitted from the live backend context after the latest ${hostContextAssemblyLimits.recent_messages}.`
    });
  }
  if (input.knowledgeWikiCandidateCount > input.knowledgeWikiIncludedCount) {
    omissions.push({
      kind: "knowledge_wiki",
      count: input.knowledgeWikiCandidateCount - input.knowledgeWikiIncludedCount,
      reason: "Knowledge Wiki pages without readable active content were omitted."
    });
  }
  if (input.activeMemoryCandidateCount > input.activeMemoryCount) {
    omissions.push({
      kind: "active_memory",
      count: input.activeMemoryCandidateCount - input.activeMemoryCount,
      reason: "Session/provisional/archived/empty Memory candidates were excluded from normal backend context."
    });
  }
  if (input.collectionNoteCandidateCount > input.collectionNoteIncludedCount) {
    omissions.push({
      kind: "collection_notes",
      count: input.collectionNoteCandidateCount - input.collectionNoteIncludedCount,
      reason: "Collection notes outside the query match or context limit were omitted."
    });
  }
  if (input.sessionSearchCandidateCount > input.sessionSearchIncludedCount) {
    omissions.push({
      kind: "session_search",
      count: input.sessionSearchCandidateCount - input.sessionSearchIncludedCount,
      reason: `Session Search results were capped at ${hostContextAssemblyLimits.session_search}.`
    });
  }
  if (input.externalAssistFailureCount > 0) {
    omissions.push({
      kind: "external_assist",
      count: input.externalAssistFailureCount,
      reason: "External assist failures were isolated from accepted Memory and kept as diagnostics."
    });
  }
  if (!input.freezeSnapshotPresent && !input.skippedSourceKinds?.has("freeze_snapshot")) {
    omissions.push({
      kind: "freeze_snapshot",
      reason: "Freeze snapshot was not available for this turn."
    });
  }
  return omissions;
}

export function shouldIncludeSessionSearchInBackendContext(query: string): boolean {
  const normalized = query.trim().replace(/[！!。.,、\s]/g, "").toLowerCase();
  if (!normalized) {
    return false;
  }
  const greetingOnly = new Set([
    "こんにちは",
    "こんばんは",
    "おはよう",
    "おはようございます",
    "やあ",
    "hi",
    "hello",
    "hey"
  ]);
  if (greetingOnly.has(normalized)) {
    return false;
  }
  return query.trim().length >= 12 || /続き|前回|さっき|以前|覚えて|探して|検索|session|history|履歴/i.test(query);
}
