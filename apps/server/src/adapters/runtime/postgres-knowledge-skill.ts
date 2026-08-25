import {
  SkillFrontmatterSchema,
  jsonValueSchema,
  type JsonValue,
  type SkillFrontmatter
} from "@samurai-agent/core-schemas";
import {
  WorkspaceServerError,
  type WorkspaceCompletionResource,
  type WorkspaceCompletionResourceVersion,
  type WorkspaceCompletionService,
  type WorkspaceRequestContext,
  type WorkspaceServerCommandService
} from "@samurai-agent/workspace-server";

export interface KnowledgeSkillPage {
  skill: SkillFrontmatter & { file_path: string; resource_version: number };
  content: string;
  scope: WorkspaceCompletionResource["scope"];
  metadata: Record<string, JsonValue>;
}

/** PostgreSQL projection for the Skill catalog and body.  Skill documents and
 * support files are owned by WorkspaceCompletion; this adapter only translates
 * the current Resource/Version contract for clients that still use Skill terms.
 */
export class PostgresKnowledgeSkill {
  constructor(
    private readonly completion: WorkspaceCompletionService,
    private readonly commands: WorkspaceServerCommandService
  ) {}

  async list(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, includeArchived = false): Promise<KnowledgeSkillPage[]> {
    const resources: WorkspaceCompletionResource[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.completion.listResourcesPage(context, { roomId, kind: "skill", includeArchived: true, limit: 100, ...(cursor ? { cursor } : {}) });
      resources.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const pages = await Promise.all(resources.map((resource) => this.read(context, resource.id)));
    return pages.filter((page): page is KnowledgeSkillPage => page !== undefined && (includeArchived || page.skill.state !== "archived"));
  }

  async search(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, query: string, limit = 50): Promise<Array<KnowledgeSkillPage & { rank: number }>> {
    const resources = await this.completion.searchKnowledge(context, { roomId, query, limit: Math.min(100, Math.max(1, limit * 3)) });
    const pages = await Promise.all(resources.filter((resource) => resource.kind === "skill").map(async (resource) => {
      const page = await this.read(context, resource.id);
      return page ? { ...page, rank: resource.rank } : undefined;
    }));
    return pages.filter((page): page is KnowledgeSkillPage & { rank: number } => Boolean(page)).slice(0, limit);
  }

  async get(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, id: string): Promise<KnowledgeSkillPage> {
    const page = await this.read(context, id);
    if (!page) throw new WorkspaceServerError("skill_not_found", 404);
    return page;
  }

  async patch(context: WorkspaceRequestContext, id: string, input: { title?: string; description?: string; content?: string; tags?: string[]; state?: SkillFrontmatter["state"] }): Promise<KnowledgeSkillPage> {
    const current = await this.get(context, id);
    const metadata = { ...current.metadata, ...(input.description === undefined ? {} : { description: input.description }), ...(input.tags === undefined ? {} : { tags: input.tags }), ...(input.state === undefined ? {} : { state: input.state }) };
    await this.commands.updateCompletionResource(context, id, {
      scope: current.scope,
      kind: "skill",
      title: input.title ?? current.skill.title,
      content: input.content ?? current.content,
      metadata,
      reason: "Skill compatibility update",
      expectedVersion: current.skill.resource_version
    });
    return this.get(context, id);
  }

  async listSupportFiles(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, id: string, version?: number) {
    const current = await this.get(context, id);
    return this.completion.listSkillFiles(context, id, version ?? current.skill.resource_version, 100);
  }

  async getSupportFile(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, id: string, relativePath: string, version?: number) {
    const current = await this.get(context, id);
    return this.completion.getSkillFile(context, id, relativePath, version ?? current.skill.resource_version);
  }

  private async read(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, id: string): Promise<KnowledgeSkillPage | undefined> {
    try {
      const body = await this.completion.getResourceBody(context, id);
      if (body.resource.kind !== "skill") return undefined;
      const metadata = parseMetadata(body.version.metadata);
      return {
        skill: skillFrontmatter(body.resource, body.version, metadata),
        content: body.content,
        scope: body.resource.scope,
        metadata
      };
    } catch (error) {
      if (error instanceof WorkspaceServerError && error.status === 404) return undefined;
      throw error;
    }
  }
}

function parseMetadata(value: Record<string, unknown>): Record<string, JsonValue> {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) throw new WorkspaceServerError("skill_metadata_invalid", 503);
  return parsed.data as Record<string, JsonValue>;
}

function skillFrontmatter(resource: WorkspaceCompletionResource, version: WorkspaceCompletionResourceVersion, metadata: Record<string, JsonValue>): SkillFrontmatter & { file_path: string; resource_version: number } {
  return {
    ...SkillFrontmatterSchema.parse({
      id: resource.id,
      state: skillState(metadata.state, resource.lifecycleState),
      title: resource.title,
      description: stringValue(metadata.description) ?? "",
      tags: stringArray(metadata.tags),
      provenance: stringValue(metadata.provenance) ?? resource.creationSource,
      trust_level: trustLevel(metadata.trust_level),
      allowed_scopes: Array.isArray(metadata.allowed_scopes) ? metadata.allowed_scopes : [],
      required_capabilities: stringArray(metadata.required_capabilities),
      schedule_policy: jsonObject(metadata.schedule_policy),
      secret_policy: jsonObject(metadata.secret_policy),
      owner_pinned: resource.aiProtection === "fixed",
      ...(metadata.usage_scope ? { usage_scope: metadata.usage_scope } : {}),
      ...(metadata.source_refs ? { source_refs: metadata.source_refs } : {}),
      ...(metadata.provenance_detail ? { provenance_detail: metadata.provenance_detail } : {}),
      ...(metadata.evidence_state ? { evidence_state: metadata.evidence_state } : {}),
      ...(metadata.usage_state ? { usage_state: metadata.usage_state } : {}),
      version: String(version.version),
      content_hash: version.contentHash,
      pinned: resource.aiProtection === "fixed",
      created_at: resource.createdAt,
      updated_at: resource.updatedAt
    }),
    file_path: version.filePath,
    resource_version: version.version
  };
}

function skillState(value: JsonValue | undefined, lifecycle: WorkspaceCompletionResource["lifecycleState"]): SkillFrontmatter["state"] {
  if (value === "candidate" || value === "project" || value === "active" || value === "stale" || value === "archived" || value === "pinned") return value;
  return lifecycle === "archived" ? "archived" : "active";
}

function trustLevel(value: JsonValue | undefined): SkillFrontmatter["trust_level"] {
  return value === "generated_local" || value === "user_authored" || value === "bundled" || value === "imported" || value === "shared" ? value : "user_authored";
}

function stringValue(value: JsonValue | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
function stringArray(value: JsonValue | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
