import { nowIso, type ContextPreview, type HostContextAssembly, type MemoryFrontmatter } from "@samurai-agent/core-schemas";
import { executionResourceRef, isRuntimeContextSourceScope, type RuntimeContextResourceRef, type RuntimeContextSourceScope } from "./resource-refs.js";

export const hostContextAssemblyLimits = {
  recent_messages: 10,
  knowledge_wiki: 5,
  collection_notes: 5,
  selected_skills: 5,
  session_search: 8
} as const;

/**
 * Runtime Knowledge and Skill share one budget.  The old preview limits are
 * per-display-source limits; they must not be applied independently to Room
 * and Agent resources or the effective prompt would silently double in size.
 */
export const runtimeExecutionContextLimits = {
  max_resources: 16,
  max_content_chars: 16_000
} as const;
export type RuntimeExecutionContextLimits = { max_resources: number; max_content_chars: number };

export type RuntimeExecutionResourceKind = "knowledge" | "skill";

export interface RuntimeExecutionResourceCandidate {
  id: string;
  kind: RuntimeExecutionResourceKind;
  title: string;
  version: string | number;
  contentHash: string;
  sourceScope: RuntimeContextSourceScope;
  /** Completion selection is authoritative; these fields are defense in depth. */
  evidenceState?: "confirmed" | "provisional" | "contradicted" | "review_required";
  lifecycleState?: "active" | "stale" | "archived";
  finalized?: boolean;
  archived?: boolean;
  rank?: number;
  selectionReason?: string;
  uri?: string;
  description?: string;
  tags?: string[];
  requiredCapabilities?: string[];
  /** A Skill body is omitted unless the Completion selector explicitly allows it. */
  disclosureLevel?: "catalog" | "body" | "support";
  bodyAllowed?: boolean;
  content?: string;
  supportFiles?: Array<{ path: string; content: string }>;
}

export interface RuntimeExecutionContextSource {
  kind: "room_knowledge" | "agent_knowledge" | "agent_skills";
  source_scope: RuntimeContextSourceScope;
  candidate_count: number;
  included_count: number;
  refs: RuntimeContextResourceRef[];
  reason: string;
}

export interface RuntimeExecutionContextAssembly {
  version: 1;
  room_id: string;
  agent_id: string;
  query: string;
  resource_refs: RuntimeContextResourceRef[];
  resources: Array<{
    kind: RuntimeExecutionResourceKind;
    id: string;
    title: string;
    version: string;
    content_hash: string;
    source_scope: RuntimeContextSourceScope;
    selection_reason: string;
    disclosure_level: "catalog" | "body" | "support";
    description?: string;
    tags?: string[];
    required_capabilities?: string[];
    ref: RuntimeContextResourceRef;
    content?: string;
    support_files?: Array<{ path: string; content: string }>;
  }>;
  sources: RuntimeExecutionContextSource[];
  included_count: number;
  included_content_chars: number;
  limits: RuntimeExecutionContextLimits;
  omitted: Array<{ id: string; kind: RuntimeExecutionResourceKind; source_scope: RuntimeContextSourceScope; reason: string }>;
}

export interface AssembleRuntimeExecutionContextInput {
  roomId: string;
  agentId: string;
  query: string;
  roomKnowledge?: RuntimeExecutionResourceCandidate[];
  agentKnowledge?: RuntimeExecutionResourceCandidate[];
  agentSkills?: RuntimeExecutionResourceCandidate[];
  limits?: Partial<RuntimeExecutionContextLimits>;
}

/**
 * Assemble server-selected Completion resources without creating an
 * authorization boundary in the provider.  Every candidate is checked again
 * for the expected Room/Agent scope, finalized state, and active lifecycle.
 * A Workspace candidate is therefore never representable in the result.
 */
export function assembleRuntimeExecutionContext(input: AssembleRuntimeExecutionContextInput): RuntimeExecutionContextAssembly {
  const roomId = input.roomId.trim();
  const agentId = input.agentId.trim();
  if (!roomId || !agentId) throw new Error("runtime_execution_context_binding_required");
  const limits = {
    max_resources: boundedPositiveLimit(input.limits?.max_resources, runtimeExecutionContextLimits.max_resources),
    max_content_chars: boundedPositiveLimit(input.limits?.max_content_chars, runtimeExecutionContextLimits.max_content_chars)
  } as const;
  const sourceInputs: Array<{
    kind: RuntimeExecutionContextSource["kind"];
    scope: RuntimeContextSourceScope;
    candidates: RuntimeExecutionResourceCandidate[];
  }> = [
    { kind: "room_knowledge", scope: { kind: "room", room_id: roomId }, candidates: input.roomKnowledge ?? [] },
    { kind: "agent_knowledge", scope: { kind: "agent", agent_id: agentId }, candidates: input.agentKnowledge ?? [] },
    { kind: "agent_skills", scope: { kind: "agent", agent_id: agentId }, candidates: input.agentSkills ?? [] }
  ];
  const omitted: RuntimeExecutionContextAssembly["omitted"] = [];
  const eligible: Array<{
    candidate: RuntimeExecutionResourceCandidate;
    source: (typeof sourceInputs)[number];
    ordinal: number;
  }> = [];
  for (const source of sourceInputs) {
    source.candidates.forEach((candidate, ordinal) => {
      const reason = executionResourceOmissionReason(candidate, source.scope, source.kind);
      if (reason) {
        omitted.push(omittedCandidate(candidate, reason, source.scope));
        return;
      }
      eligible.push({ candidate, source, ordinal });
    });
  }
  // Completion already ranks candidates. Preserve that order while applying
  // one global budget; stable source/ordinal tie breaks avoid nondeterminism.
  eligible.sort((left, right) => (right.candidate.rank ?? 0) - (left.candidate.rank ?? 0)
    || sourceInputs.indexOf(left.source) - sourceInputs.indexOf(right.source)
    || left.ordinal - right.ordinal);

  const selected: RuntimeExecutionContextAssembly["resources"] = [];
  const resourceRefs: RuntimeContextResourceRef[] = [];
  let contentChars = 0;
  for (const entry of eligible) {
    const candidate = entry.candidate;
    if (selected.length >= limits.max_resources) {
      omitted.push(omittedCandidate(candidate, "total_resource_limit", entry.source.scope));
      continue;
    }
    const disclosureLevel = candidate.kind === "skill" ? candidate.disclosureLevel ?? "catalog" : "body";
    const body = candidate.kind === "skill" && disclosureLevel !== "body"
      ? undefined
      : candidate.content?.trim() || undefined;
    const supportFiles = candidate.kind === "skill" && disclosureLevel === "support" && candidate.bodyAllowed === true
      ? boundedSupportFiles(candidate.supportFiles, Math.max(0, limits.max_content_chars - contentChars))
      : undefined;
    const candidateContent = body ?? "";
    const remaining = Math.max(0, limits.max_content_chars - contentChars);
    const includedContent = candidateContent.slice(0, remaining);
    const truncated = includedContent.length < candidateContent.length;
    if (candidateContent && !includedContent) {
      omitted.push(omittedCandidate(candidate, "total_content_limit", entry.source.scope));
      continue;
    }
    const selectionReason = candidate.selectionReason ?? `completion_selected:${entry.source.kind}`;
    const ref = executionResourceRef({
      kind: candidate.kind,
      id: candidate.id,
      version: candidate.version,
      contentHash: candidate.contentHash,
      sourceScope: candidate.sourceScope,
      uri: candidate.uri,
      label: candidate.title
    });
    resourceRefs.push(ref);
    selected.push({
      kind: candidate.kind,
      id: candidate.id,
      title: candidate.title,
      version: ref.version,
      content_hash: ref.content_hash,
      source_scope: candidate.sourceScope,
      selection_reason: truncated ? `${selectionReason}:content_truncated` : selectionReason,
      disclosure_level: disclosureLevel,
      ...(candidate.description ? { description: candidate.description } : {}),
      ...(candidate.tags?.length ? { tags: candidate.tags } : {}),
      ...(candidate.requiredCapabilities?.length ? { required_capabilities: candidate.requiredCapabilities } : {}),
      ref,
      ...(includedContent ? { content: includedContent } : {}),
      ...(supportFiles?.length ? { support_files: supportFiles } : {})
    });
    contentChars += includedContent.length + (supportFiles?.reduce((total, file) => total + file.content.length, 0) ?? 0);
  }

  const sources = sourceInputs.map((source): RuntimeExecutionContextSource => {
    const sourceRefs = resourceRefs.filter((ref) => sameScope(ref.source_scope, source.scope)
      && ((source.kind === "agent_skills" && ref.kind === "skill") || (source.kind !== "agent_skills" && ref.kind === "knowledge")));
    const candidateCount = source.candidates.length;
    return {
      kind: source.kind,
      source_scope: source.scope,
      candidate_count: candidateCount,
      included_count: sourceRefs.length,
      refs: sourceRefs,
      reason: sourceRefs.length < candidateCount ? "Completion candidates were filtered by scope/state or the shared total limit." : "Completion candidates were selected within the shared total limit."
    };
  });
  return {
    version: 1,
    room_id: roomId,
    agent_id: agentId,
    query: input.query,
    resource_refs: resourceRefs,
    resources: selected,
    sources,
    included_count: selected.length,
    included_content_chars: contentChars,
    limits,
    omitted
  };
}

/** Short alias used by Runtime adapters that already call their result an assembly. */
export const buildRuntimeExecutionContext = assembleRuntimeExecutionContext;

function boundedPositiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function executionResourceOmissionReason(
  candidate: RuntimeExecutionResourceCandidate | null | undefined,
  expectedScope: RuntimeContextSourceScope,
  sourceKind: RuntimeExecutionContextSource["kind"]
): string | undefined {
  if (!candidate || typeof candidate !== "object"
    || typeof candidate.id !== "string" || !candidate.id.trim()
    || typeof candidate.title !== "string" || !candidate.title.trim()
    || (typeof candidate.version !== "string" && typeof candidate.version !== "number")
    || !String(candidate.version).trim()
    || typeof candidate.contentHash !== "string" || !candidate.contentHash.trim()) return "resource_metadata_invalid";
  if (!isRuntimeContextSourceScope(candidate.sourceScope)) {
    return (candidate.sourceScope as { kind?: unknown } | undefined)?.kind === "workspace"
      ? "workspace_scope_forbidden"
      : "scope_invalid";
  }
  if (!sameScope(candidate.sourceScope, expectedScope)) return "scope_mismatch";
  if ((sourceKind === "agent_skills" && candidate.kind !== "skill") || (sourceKind !== "agent_skills" && candidate.kind !== "knowledge")) return "resource_kind_mismatch";
  if (candidate.archived === true || candidate.lifecycleState === "archived") return "archived";
  if (candidate.finalized === false || candidate.evidenceState === "provisional" || candidate.evidenceState === "review_required" || candidate.evidenceState === "contradicted") return "not_finalized";
  if (candidate.kind === "skill" && candidate.disclosureLevel === "body" && candidate.bodyAllowed !== true) return "skill_body_not_allowed";
  return undefined;
}

function boundedSupportFiles(files: Array<{ path: string; content: string }> | undefined, remaining: number): Array<{ path: string; content: string }> | undefined {
  if (!files?.length || remaining <= 0) return undefined;
  let budget = remaining;
  const selected: Array<{ path: string; content: string }> = [];
  for (const file of files.slice(0, 5)) {
    if (budget <= 0) break;
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") continue;
    const content = file.content.trim().slice(0, budget);
    if (!content) continue;
    selected.push({ path: file.path, content });
    budget -= content.length;
  }
  return selected.length > 0 ? selected : undefined;
}

function omittedCandidate(
  candidate: RuntimeExecutionResourceCandidate | null | undefined,
  reason: string,
  fallbackScope: RuntimeContextSourceScope
): RuntimeExecutionContextAssembly["omitted"][number] {
  return {
    id: candidate && typeof candidate.id === "string" ? candidate.id : "unknown",
    kind: candidate?.kind === "skill" ? "skill" : "knowledge",
    source_scope: isRuntimeContextSourceScope(candidate?.sourceScope) ? candidate.sourceScope : fallbackScope,
    reason
  };
}

function sameScope(left: RuntimeContextSourceScope, right: RuntimeContextSourceScope): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "room" ? left.room_id === (right as { kind: "room"; room_id: string }).room_id : left.agent_id === (right as { kind: "agent"; agent_id: string }).agent_id;
}

export interface MemoryPreviewCandidate {
  frontmatter: Pick<MemoryFrontmatter, "id" | "topic" | "state" | "sensitive_level" | "conflicts_with" | "evidence_state" | "usage_state">;
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
    ...(memory.frontmatter.evidence_state ? { evidence_state: memory.frontmatter.evidence_state } : {}),
    ...(memory.frontmatter.usage_state ? { usage_state: memory.frontmatter.usage_state } : {}),
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
