import {
  type ActiveMemoryRetrievalReport,
  type FreezeSnapshot,
  type MemoryFrontmatter,
  type MessageEnvelope,
  type ProfileDocument,
  type ResourceRef,
  type SupportedLocale,
  createId,
  nowIso,
  stableHash
} from "@samurai-agent/core-schemas";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";

export interface MemoryCandidate {
  frontmatter: MemoryFrontmatter;
  content: string;
  priority: "primary" | "sensitive" | "conflict";
  selection_reason: string;
}

export interface ActiveMemoryRetrievalResult {
  candidates: MemoryCandidate[];
  report: ActiveMemoryRetrievalReport;
}

export async function retrieveActiveMemory(store: WorkspaceStore, query: string): Promise<MemoryCandidate[]> {
  return (await retrieveActiveMemoryWithReport(store, query)).candidates;
}

export async function retrieveActiveMemoryWithReport(store: WorkspaceStore, query: string): Promise<ActiveMemoryRetrievalResult> {
  const retrievedAt = nowIso();
  const rows = await store.searchMemory(query, 20, { includeArchived: true });
  const candidates: MemoryCandidate[] = [];
  const excluded: ActiveMemoryRetrievalReport["excluded"] = [];
  const sensitiveRedactions: ActiveMemoryRetrievalReport["sensitive_redactions"] = [];
  const conflictGroups: ActiveMemoryRetrievalReport["conflict_groups"] = [];
  const resolutionSuggestions: ActiveMemoryRetrievalReport["resolution_suggestions"] = [];

  for (const frontmatter of rows) {
    const exclusionReason = activeMemoryExclusionReason(frontmatter);
    if (exclusionReason) {
      excluded.push({
        id: frontmatter.id,
        topic: frontmatter.topic,
        state: frontmatter.state,
        reason: exclusionReason
      });
      if (frontmatter.state === "provisional") {
        resolutionSuggestions.push({
          kind: "provisional_review",
          memory_ids: [frontmatter.id],
          reason: "Provisional Memory is excluded until accepted."
        });
      }
      continue;
    }

    const rawContent = (await store.readMemoryContent(frontmatter.id)) ?? "";
    const content = memoryContentForInjection(frontmatter, rawContent);
    if (!content.trim()) {
      excluded.push({
        id: frontmatter.id,
        topic: frontmatter.topic,
        state: frontmatter.state,
        reason: "empty_content"
      });
      continue;
    }

    if (frontmatter.sensitive_level !== "none") {
      sensitiveRedactions.push({
        id: frontmatter.id,
        topic: frontmatter.topic,
        sensitive_level: frontmatter.sensitive_level,
        redacted: frontmatter.sensitive_level === "high",
        reason: frontmatter.sensitive_level === "high"
          ? "High sensitive Memory content is withheld from normal injection."
          : "Sensitive Memory is included with explicit priority metadata."
      });
      resolutionSuggestions.push({
        kind: "sensitive_review",
        memory_ids: [frontmatter.id],
        reason: `Review sensitive Memory handling: ${frontmatter.sensitive_level}.`
      });
    }

    if (frontmatter.conflicts_with.length > 0) {
      const memoryIds = [frontmatter.id, ...frontmatter.conflicts_with];
      conflictGroups.push({
        id: `memory_conflict_${frontmatter.id}`,
        memory_ids: memoryIds,
        reason: `Memory ${frontmatter.id} declares conflicts_with ${frontmatter.conflicts_with.join(", ")}.`,
        proposed_action: "review"
      });
      resolutionSuggestions.push({
        kind: "conflict_review",
        memory_ids: memoryIds,
        reason: "Conflicting Memory should be reviewed before promotion or merge."
      });
    }

    candidates.push({
      frontmatter,
      content,
      priority: memoryPriority(frontmatter),
      selection_reason: memorySelectionReason(frontmatter)
    });
  }

  const included = candidates.slice(0, 5);
  return {
    candidates: included,
    report: {
      query,
      retrieved_at: retrievedAt,
      candidate_count: rows.length,
      included_count: included.length,
      included_memory_ids: included.map((candidate) => candidate.frontmatter.id),
      excluded,
      sensitive_redactions: sensitiveRedactions,
      conflict_groups: conflictGroups,
      resolution_suggestions: dedupeMemoryResolutionSuggestions(resolutionSuggestions)
    }
  };
}

export interface FreezeSnapshotInput {
  memoryRefs?: ResourceRef[];
  skillRefs?: ResourceRef[];
  wikiRefs?: ResourceRef[];
}

export async function loadFreezeSnapshot(
  store: Pick<WorkspaceStore, "rootDir">,
  input: FreezeSnapshotInput = {}
): Promise<FreezeSnapshot> {
  const loadedAt = nowIso();
  const soul = await loadProfileDocumentOrEmpty(store.rootDir, "soul", loadedAt);
  const profile = await loadOptionalProfileDocument(store.rootDir, "profile", loadedAt);
  const content = [
    "# Frozen identity",
    "",
    "## SOUL.md",
    soul.content.trim() || "(empty)",
    "",
    ...(profile ? ["## PROFILE.md", profile.content.trim() || "(empty)", ""] : [])
  ].join("\n");

  return {
    id: createId("freeze"),
    soul,
    ...(profile ? { profile } : {}),
    memory_refs: input.memoryRefs ?? [],
    skill_refs: input.skillRefs ?? [],
    wiki_refs: input.wikiRefs ?? [],
    content,
    stable_hash: stableHash({
      soul: soul.content,
      profile: profile?.content ?? "",
      memory_refs: input.memoryRefs ?? [],
      skill_refs: input.skillRefs ?? [],
      wiki_refs: input.wikiRefs ?? []
    }),
    created_at: loadedAt
  };
}

export async function createSessionMemory(
  store: WorkspaceStore,
  envelope: MessageEnvelope,
  content: string
): Promise<MemoryFrontmatter> {
  const frontmatter = buildMemoryFrontmatter({
    state: "session",
    topic: "session",
    source: envelope.id,
    sourceLocale: envelope.input_locale,
    contentLocale: envelope.output_locale,
    sourceKind: "owner_instruction",
    instructionAuthority: envelope.actor_identity
  });

  return store.saveMemory(frontmatter, content);
}

export async function createProvisionalMemory(
  store: WorkspaceStore,
  envelope: MessageEnvelope,
  content: string
): Promise<MemoryFrontmatter> {
  const frontmatter = buildMemoryFrontmatter({
    state: "provisional",
    topic: "preference",
    source: envelope.id,
    sourceLocale: envelope.input_locale,
    contentLocale: envelope.output_locale,
    sourceKind: "agent_reasoning",
    instructionAuthority: envelope.actor_identity
  });

  return store.saveMemory(frontmatter, content);
}

export async function createTopicMemory(
  store: WorkspaceStore,
  envelope: MessageEnvelope,
  topic: string,
  content: string
): Promise<MemoryFrontmatter> {
  const frontmatter = buildMemoryFrontmatter({
    state: "topic",
    topic,
    source: envelope.id,
    sourceLocale: envelope.input_locale,
    contentLocale: envelope.output_locale,
    sourceKind: "owner_instruction",
    instructionAuthority: envelope.actor_identity
  });

  return store.saveMemory(frontmatter, content);
}

export function buildMemoryFrontmatter(input: {
  state: MemoryFrontmatter["state"];
  topic: string;
  source: string;
  sourceLocale: SupportedLocale;
  contentLocale: SupportedLocale;
  sourceKind: MemoryFrontmatter["source_kind"];
  instructionAuthority: string;
}): MemoryFrontmatter {
  const now = nowIso();
  return {
    id: createId("memory"),
    state: input.state,
    topic: input.topic,
    source: input.source,
    source_locale: input.sourceLocale,
    content_locale: input.contentLocale,
    source_kind: input.sourceKind,
    instruction_authority: input.instructionAuthority,
    confidence: input.state === "session" ? 0.6 : 0.48,
    created_by: "runtime",
    created_at: now,
    updated_at: now,
    related_memories: [],
    conflicts_with: [],
    sensitive_level: "none"
  };
}

function memoryPriority(frontmatter: MemoryFrontmatter): MemoryCandidate["priority"] {
  if (frontmatter.conflicts_with.length > 0) {
    return "conflict";
  }
  if (frontmatter.state === "sensitive" || frontmatter.sensitive_level !== "none") {
    return "sensitive";
  }
  return "primary";
}

function memorySelectionReason(frontmatter: MemoryFrontmatter): string {
  if (frontmatter.conflicts_with.length > 0) {
    return `conflicts_with:${frontmatter.conflicts_with.join(",")}`;
  }
  if (frontmatter.state === "sensitive" || frontmatter.sensitive_level !== "none") {
    return `sensitive:${frontmatter.sensitive_level}`;
  }
  return `state:${frontmatter.state}`;
}

function activeMemoryExclusionReason(frontmatter: MemoryFrontmatter): ActiveMemoryRetrievalReport["excluded"][number]["reason"] | undefined {
  if (frontmatter.state === "session") {
    return "session_only";
  }
  if (frontmatter.state === "provisional") {
    return "provisional_pending";
  }
  if (frontmatter.state === "archived") {
    return "archived";
  }
  if (!["active", "topic", "sensitive"].includes(frontmatter.state)) {
    return "not_active_state";
  }
  return undefined;
}

function dedupeMemoryResolutionSuggestions(
  suggestions: ActiveMemoryRetrievalReport["resolution_suggestions"]
): ActiveMemoryRetrievalReport["resolution_suggestions"] {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = `${suggestion.kind}:${suggestion.memory_ids.join(",")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function memoryContentForInjection(frontmatter: MemoryFrontmatter, content: string): string {
  if (frontmatter.sensitive_level === "high") {
    return `[sensitive memory withheld: ${frontmatter.topic}]`;
  }
  return content;
}

async function loadProfileDocumentOrEmpty(rootDir: string, kind: ProfileDocument["kind"], loadedAt: string): Promise<ProfileDocument> {
  const filePath = profileDocumentPath(kind);
  const absolutePath = path.join(rootDir, filePath);
  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch {
    content = "";
  }
  return profileDocument(kind, filePath, content, loadedAt);
}

async function loadOptionalProfileDocument(rootDir: string, kind: ProfileDocument["kind"], loadedAt: string): Promise<ProfileDocument | undefined> {
  const filePath = profileDocumentPath(kind);
  try {
    const content = await readFile(path.join(rootDir, filePath), "utf8");
    return profileDocument(kind, filePath, content, loadedAt);
  } catch {
    return undefined;
  }
}

function profileDocument(kind: ProfileDocument["kind"], filePath: string, content: string, loadedAt: string): ProfileDocument {
  return {
    id: kind,
    kind,
    file_ref: {
      kind: "profile",
      id: kind,
      uri: filePath,
      label: path.basename(filePath)
    },
    content,
    loaded_at: loadedAt
  };
}

function profileDocumentPath(kind: ProfileDocument["kind"]): string {
  return path.join("profile", kind === "soul" ? "SOUL.md" : "PROFILE.md");
}
