import {
  type MemoryFrontmatter,
  type MessageEnvelope,
  type SupportedLocale,
  createId,
  nowIso
} from "@samurai-agent/core-schemas";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";

export interface MemoryCandidate {
  frontmatter: MemoryFrontmatter;
  content: string;
}

export async function retrieveActiveMemory(store: WorkspaceStore, query: string): Promise<MemoryCandidate[]> {
  const rows = await store.searchMemory(query, 5);
  return rows.map((frontmatter) => ({
    frontmatter,
    content: frontmatter.source
  }));
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
