import {
  ActivityContextRefSchema,
  MemoryFrontmatterSchema,
  ResourceRefSchema,
  UsageScopeRefSchema,
  instructionSources,
  memoryStates,
  jsonValueSchema,
  supportedLocales,
  type JsonValue,
  type MemoryFrontmatter,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import {
  WorkspaceServerError,
  type WorkspaceCompletionResource,
  type WorkspaceCompletionResourceVersion,
  type WorkspaceCompletionService,
  type WorkspaceRequestContext,
  type WorkspaceServerCommandService
} from "@samurai-agent/workspace-server";

export interface KnowledgeMemoryPage {
  memory: MemoryFrontmatter & { file_path: string };
  content: string;
  scope: WorkspaceCompletionResource["scope"];
  metadata: Record<string, JsonValue>;
}

/** Compatibility projection for the old Memory UI. The data source is the
 * Room-authorized Completion Knowledge query; no legacy Memory table is read
 * from the PostgreSQL Server path. */
export class PostgresKnowledgeMemory {
  constructor(
    private readonly completion: WorkspaceCompletionService,
    private readonly commands: WorkspaceServerCommandService
  ) {}

  async list(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, includeArchived = false): Promise<KnowledgeMemoryPage[]> {
    const resources = [] as WorkspaceCompletionResource[];
    let cursor: string | undefined;
    do {
      const page = await this.completion.listResourcesPage(context, { roomId, kind: "knowledge", includeArchived: true, limit: 100, ...(cursor ? { cursor } : {}) });
      resources.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const memories = await Promise.all(resources.map((resource) => this.readIfMemory(context, resource.id)));
    return memories.filter((memory): memory is KnowledgeMemoryPage => memory !== undefined && (includeArchived || memory.memory.state !== "archived"));
  }

  async get(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, id: string): Promise<KnowledgeMemoryPage> {
    const memory = await this.readIfMemory(context, id);
    if (!memory) throw new WorkspaceServerError("memory_not_found", 404);
    return memory;
  }

  async archive(context: WorkspaceRequestContext, id: string, reason: string): Promise<{ memory: KnowledgeMemoryPage; changed: boolean; replayed: boolean }> {
    const current = await this.get(context, id);
    if (current.memory.state === "archived") return { memory: current, changed: false, replayed: true };
    const saved = await this.commands.setCompletionResourceArchived(context, {
      resourceId: id,
      archived: true,
      expectedVersion: versionOf(current).version,
      reason
    });
    return { memory: await this.get(context, id), changed: true, replayed: saved.replayed };
  }

  async search(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, query: string, limit = 50): Promise<Array<KnowledgeMemoryPage & { rank: number }>> {
    const resources = await this.completion.searchKnowledge(context, { roomId, query, limit: Math.min(100, Math.max(1, limit * 3)) });
    const memories = await Promise.all(resources.map(async (resource) => {
      const page = await this.readIfMemory(context, resource.id);
      return page ? { ...page, rank: resource.rank } : undefined;
    }));
    return memories.filter((memory): memory is KnowledgeMemoryPage & { rank: number } => Boolean(memory));
  }

  private async readIfMemory(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, id: string): Promise<KnowledgeMemoryPage | undefined> {
    try {
      const body = await this.completion.getResourceBody(context, id);
      const metadata = jsonMetadata(body.version.metadata);
      if (!isMemoryMetadata(metadata)) return undefined;
      return { memory: memoryFrontmatter(body, metadata), content: body.content, scope: body.resource.scope, metadata };
    } catch (error) {
      if (error instanceof WorkspaceServerError && error.status === 404) return undefined;
      throw error;
    }
  }
}

function isMemoryMetadata(metadata: Record<string, JsonValue>): boolean {
  if (metadata.memory === true || metadata.legacy_resource_kind === "memory") return true;
  const legacy = metadata.legacy_source;
  return Boolean(legacy && typeof legacy === "object" && !Array.isArray(legacy) && (legacy as Record<string, JsonValue>).resource_kind === "memory");
}

function jsonMetadata(value: Record<string, unknown>): Record<string, JsonValue> {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || parsed.data === null || Array.isArray(parsed.data) || typeof parsed.data !== "object") {
    throw new WorkspaceServerError("knowledge_memory_metadata_invalid", 503);
  }
  return parsed.data;
}

function memoryFrontmatter(body: { resource: WorkspaceCompletionResource; version: WorkspaceCompletionResourceVersion }, metadata: Record<string, JsonValue>): MemoryFrontmatter & { file_path: string } {
  const legacy = jsonObject(metadata.legacy_source);
  const stateCandidate = stringValue(metadata.state) ?? stringValue(legacy?.source_state);
  const state = body.resource.lifecycleState === "archived"
    ? "archived"
    : memoryStates.includes(stateCandidate as (typeof memoryStates)[number])
      ? stateCandidate as MemoryFrontmatter["state"]
      : body.resource.evidenceState === "provisional" ? "provisional" : "active";
  const sourceLocale = localeValue(metadata.source_locale) ?? "ja";
  const contentLocale = localeValue(metadata.content_locale) ?? sourceLocale;
  const sourceKind = instructionSources.includes(stringValue(metadata.source_kind) as (typeof instructionSources)[number])
    ? stringValue(metadata.source_kind) as MemoryFrontmatter["source_kind"]
    : "workspace_data";
  const sourceRefs = arrayValue(metadata.source_refs).map((value) => ResourceRefSchema.safeParse(value)).filter((result): result is { success: true; data: import("@samurai-agent/core-schemas").ResourceRef } => result.success).map((result) => result.data);
  const usageScope = UsageScopeRefSchema.safeParse(metadata.usage_scope).success
    ? UsageScopeRefSchema.parse(metadata.usage_scope)
    : body.resource.scope.kind === "room" && body.resource.scope.roomId
      ? { kind: "room" as const, room_id: body.resource.scope.roomId }
      : { kind: "workspace" as const };
  const provenance = metadata.provenance;
  const parsedProvenance = provenance && typeof provenance === "object" && !Array.isArray(provenance) ? provenance : undefined;
  const activity = ActivityContextRefSchema.safeParse(metadata.origin_activity_context);
  const frontmatter = MemoryFrontmatterSchema.parse({
    id: body.resource.id,
    state,
    topic: stringValue(metadata.topic) ?? body.resource.title,
    source: stringValue(metadata.source) ?? "completion:knowledge",
    source_locale: sourceLocale,
    content_locale: contentLocale,
    source_kind: sourceKind,
    instruction_authority: stringValue(metadata.instruction_authority) ?? "workspace",
    ...(stringValue(metadata.quoted_from) ? { quoted_from: stringValue(metadata.quoted_from) } : {}),
    confidence: numberValue(metadata.confidence) ?? (body.resource.evidenceState === "confirmed" ? 1 : 0.5),
    created_by: stringValue(metadata.created_by) ?? stringValue(legacy?.source_created_by) ?? "workspace",
    created_at: body.resource.createdAt,
    updated_at: body.resource.updatedAt,
    ...(stringValue(metadata.last_used_at) ? { last_used_at: stringValue(metadata.last_used_at) } : {}),
    related_memories: stringArray(metadata.related_memories),
    conflicts_with: stringArray(metadata.conflicts_with),
    sensitive_level: metadata.sensitive_level === "high" || metadata.sensitive_level === "low" ? metadata.sensitive_level : "none",
    usage_scope: usageScope,
    ...(sourceRefs.length ? { source_refs: sourceRefs } : {}),
    ...(parsedProvenance ? { provenance: parsedProvenance } : {}),
    ...(metadata.evidence_state === "direct_confirmed" || metadata.evidence_state === "inferred" || metadata.evidence_state === "supported" || metadata.evidence_state === "conflict" ? { evidence_state: metadata.evidence_state } : {}),
    ...(metadata.usage_state === "normal" || metadata.usage_state === "limited" || metadata.usage_state === "dormant" ? { usage_state: metadata.usage_state } : {}),
    ...(activity.success ? { origin_activity_context: activity.data } : {}),
    source_run_ids: stringArray(metadata.source_run_ids),
    version: String(body.version.version),
    content_hash: body.version.contentHash,
    pinned: body.resource.aiProtection === "fixed"
  });
  return { ...frontmatter, file_path: body.version.filePath };
}

function versionOf(page: KnowledgeMemoryPage): { version: number } {
  const value = Number(page.memory.version);
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkspaceServerError("memory_version_invalid", 503);
  return { version: value };
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: JsonValue | undefined): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function arrayValue(value: JsonValue | undefined): JsonValue[] { return Array.isArray(value) ? value : []; }
function stringArray(value: JsonValue | undefined): string[] { return arrayValue(value).filter((item): item is string => typeof item === "string"); }
function localeValue(value: JsonValue | undefined): SupportedLocale | undefined { return supportedLocales.includes(value as SupportedLocale) ? value as SupportedLocale : undefined; }
