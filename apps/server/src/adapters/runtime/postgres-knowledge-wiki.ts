import {
  ResourceRefSchema,
  jsonValueSchema,
  supportedLocales,
  type JsonValue,
  type ResourceRef,
  type SupportedLocale,
  type WikiFrontmatter
} from "@samurai-agent/core-schemas";
import {
  WorkspaceServerError,
  type WorkspaceCompletionResource,
  type WorkspaceCompletionResourceVersion,
  type WorkspaceCompletionService,
  type WorkspaceRequestContext,
  type WorkspaceServerCommandService
} from "@samurai-agent/workspace-server";

export interface PostgresKnowledgeWikiInput {
  roomId: string;
  title: string;
  content: string;
  slug?: string;
  tags?: string[];
  contentLocale?: SupportedLocale;
  knowledgeKind?: "fact" | "decision" | "explanation" | "experience_rule";
  reason: string;
}

export interface PostgresKnowledgeWikiPatch {
  title?: string;
  content?: string;
  tags?: string[];
  contentLocale?: SupportedLocale;
  reason: string;
}

export type KnowledgeWikiState = "proposed" | "active" | "archived" | "rejected";

export interface KnowledgeWikiPage {
  wiki: WikiFrontmatter & { file_path: string };
  content: string;
  scope: WorkspaceCompletionResource["scope"];
  metadata: Record<string, JsonValue>;
}

/**
 * Knowledge Wiki is a Markdown-facing projection over the Completion
 * Knowledge Resource. The body remains in the Completion file transaction;
 * Wiki metadata is explicit, so a normal Knowledge document is never silently
 * presented as a Wiki page.
 */
export class PostgresKnowledgeWiki {
  constructor(
    private readonly completion: WorkspaceCompletionService,
    private readonly commands: WorkspaceServerCommandService
  ) {}

  async list(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, includeArchived = false): Promise<KnowledgeWikiPage[]> {
    const pages: KnowledgeWikiPage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.completion.listResourcesPage(context, {
        roomId,
        kind: "knowledge",
        includeArchived: true,
        limit: 100,
        ...(cursor ? { cursor } : {})
      });
      const resolved = await Promise.all(page.items.map((resource) => this.readIfWiki(context, resource.id)));
      pages.push(...resolved.filter((page): page is KnowledgeWikiPage => page !== undefined && (includeArchived || page.wiki.state !== "archived")));
      cursor = page.nextCursor;
    } while (cursor);
    return pages;
  }

  async get(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, id: string): Promise<KnowledgeWikiPage> {
    const page = await this.readIfWiki(context, id);
    if (!page) throw new WorkspaceServerError("knowledge_wiki_not_found", 404);
    return page;
  }

  async create(context: WorkspaceRequestContext, input: PostgresKnowledgeWikiInput) {
    const slug = normalizeSlug(input.slug ?? input.title);
    const saved = await this.commands.createCompletionResource(context, {
      scope: { kind: "room", roomId: input.roomId },
      kind: "knowledge",
      knowledgeKind: input.knowledgeKind ?? "explanation",
      title: input.title,
      content: input.content,
      metadata: wikiMetadata({ slug, tags: input.tags ?? [], contentLocale: input.contentLocale ?? "ja" }),
      reason: input.reason
    });
    return { ...saved, wiki: await this.get(context, saved.resource.id) };
  }

  async update(context: WorkspaceRequestContext, id: string, input: PostgresKnowledgeWikiPatch) {
    const current = await this.get(context, id);
    const saved = await this.commands.updateCompletionResource(context, id, {
      scope: current.scope,
      kind: "knowledge",
      knowledgeKind: completionKnowledgeKind(current.wiki.knowledge_kind),
      title: input.title ?? current.wiki.title,
      content: input.content ?? current.content,
      metadata: {
        ...currentMetadata(current),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.contentLocale ? { content_locale: input.contentLocale } : {})
      },
      reason: input.reason,
      expectedVersion: currentVersion(current).version
    });
    return { ...saved, wiki: await this.get(context, id) };
  }

  async setArchived(context: WorkspaceRequestContext, id: string, archived: boolean, reason: string) {
    const current = await this.get(context, id);
    const saved = await this.commands.setCompletionResourceArchived(context, {
      resourceId: id,
      archived,
      expectedVersion: currentVersion(current).version,
      reason
    });
    return { ...saved, wiki: await this.get(context, id) };
  }

  async setState(context: WorkspaceRequestContext, id: string, state: KnowledgeWikiState, reason: string) {
    const current = await this.get(context, id);
    const saved = await this.commands.updateCompletionResource(context, id, {
      scope: current.scope,
      kind: "knowledge",
      knowledgeKind: completionKnowledgeKind(current.wiki.knowledge_kind),
      title: current.wiki.title,
      content: current.content,
      metadata: { ...current.metadata, wiki_state: state },
      reason,
      expectedVersion: currentVersion(current).version
    });
    return { ...saved, wiki: await this.get(context, id) };
  }

  async reindex(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string) {
    const pages = await this.list(context, roomId, true);
    const links = pages.reduce((count, page) => count + wikiLinks(page.content).length, 0);
    return { active: pages.filter((page) => page.wiki.state !== "archived").length, total: pages.length, links };
  }

  async graph(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, query?: string) {
    const pages = await this.list(context, roomId, false);
    const visible = query?.trim()
      ? pages.filter((page) => `${page.wiki.title} ${page.wiki.slug} ${page.content}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      : pages;
    const bySlug = new Map(visible.map((page) => [page.wiki.slug, page]));
    return {
      version: "1" as const,
      nodes: visible.map((page) => ({ id: page.wiki.id, label: page.wiki.title, body: page.content.slice(0, 500) })),
      edges: visible.flatMap((page) => wikiLinks(page.content)
        .map((slug) => bySlug.get(slug))
        .filter((target): target is KnowledgeWikiPage => Boolean(target))
        .map((target) => ({ id: `${page.wiki.id}:${target.wiki.id}`, source: page.wiki.id, target: target.wiki.id, label: "wiki_link" })))
    };
  }

  async backlinks(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, id: string) {
    const target = await this.get(context, id);
    const pages = await this.list(context, roomId, false);
    return pages.filter((page) => wikiLinks(page.content).includes(target.wiki.slug)).map((page) => ({ from_wiki_id: page.wiki.id, label: page.wiki.title }));
  }

  async diagnostics(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string) {
    const pages = await this.list(context, roomId, false);
    const slugs = new Map<string, KnowledgeWikiPage[]>();
    for (const page of pages) slugs.set(page.wiki.slug, [...(slugs.get(page.wiki.slug) ?? []), page]);
    const duplicateSlugs = [...slugs.entries()].filter(([, matches]) => matches.length > 1).map(([slug]) => slug);
    const brokenLinks = pages.flatMap((page) => wikiLinks(page.content)
      .filter((slug) => !slugs.has(slug))
      .map((slug) => ({ wiki_id: page.wiki.id, slug })));
    return { room_id: roomId, pages: pages.length, duplicate_slugs: duplicateSlugs, broken_links: brokenLinks };
  }

  private async readIfWiki(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, id: string): Promise<KnowledgeWikiPage | undefined> {
    try {
      const body = await this.completion.getResourceBody(context, id);
      const metadata = jsonMetadata(body.version.metadata);
      if (!isWikiMetadata(metadata)) return undefined;
      return { wiki: wikiFrontmatter(body, metadata), content: body.content, scope: body.resource.scope, metadata };
    } catch (error) {
      if (error instanceof WorkspaceServerError && error.status === 404) return undefined;
      throw error;
    }
  }
}

function isWikiMetadata(metadata: Record<string, JsonValue>): boolean {
  const legacy = metadata.legacy_source;
  return metadata.wiki === true || (!!legacy && typeof legacy === "object" && !Array.isArray(legacy)
    && (legacy as Record<string, JsonValue>).resource_kind === "wiki");
}

function wikiMetadata(input: { slug: string; tags: string[]; contentLocale: SupportedLocale }): Record<string, JsonValue> {
  return { wiki: true, slug: input.slug, tags: input.tags, content_locale: input.contentLocale };
}

function wikiFrontmatter(body: { resource: WorkspaceCompletionResource; version: WorkspaceCompletionResourceVersion }, metadata: Record<string, JsonValue>): WikiFrontmatter & { file_path: string } {
  const locale = supportedLocales.includes(metadata.content_locale as SupportedLocale) ? metadata.content_locale as SupportedLocale : "ja";
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((item): item is string => typeof item === "string") : [];
  const sourceRefs = Array.isArray(metadata.source_refs) ? metadata.source_refs.map((item) => ResourceRefSchema.safeParse(item)).filter((item): item is { success: true; data: ResourceRef } => item.success).map((item) => item.data) : [];
  const state = body.resource.lifecycleState === "archived"
    ? "archived"
    : metadata.wiki_state === "proposed" || metadata.wiki_state === "rejected" || metadata.wiki_state === "active" || metadata.wiki_state === "archived"
      ? metadata.wiki_state
      : body.resource.evidenceState === "provisional" ? "proposed" : "active";
  return {
    id: body.resource.id,
    slug: typeof metadata.slug === "string" ? metadata.slug : normalizeSlug(body.resource.title),
    title: body.resource.title,
    state,
    content_locale: locale,
    tags,
    source_refs: sourceRefs,
    provenance: { kind: "user_authored", summary: "PostgreSQL Knowledge Wiki", verified: body.resource.evidenceState === "confirmed" },
    ...(body.resource.scope.kind === "room" && body.resource.scope.roomId ? { usage_scope: { kind: "room", room_id: body.resource.scope.roomId } } : { usage_scope: { kind: "workspace" } }),
    knowledge_kind: body.resource.knowledgeKind ?? "explanation",
    evidence_state: body.resource.evidenceState === "confirmed" ? "direct_confirmed" : body.resource.evidenceState === "contradicted" || body.resource.evidenceState === "review_required" ? "conflict" : "inferred",
    usage_state: "normal",
    version: String(body.version.version),
    content_hash: body.version.contentHash,
    pinned: body.resource.aiProtection === "fixed",
    created_at: body.resource.createdAt,
    updated_at: body.resource.updatedAt,
    file_path: body.version.filePath
  };
}

function currentMetadata(page: KnowledgeWikiPage): Record<string, JsonValue> {
  return page.metadata;
}

function jsonMetadata(value: Record<string, unknown>): Record<string, JsonValue> {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || parsed.data === null || Array.isArray(parsed.data) || typeof parsed.data !== "object") {
    throw new WorkspaceServerError("knowledge_wiki_metadata_invalid", 503);
  }
  return parsed.data;
}

function currentVersion(page: KnowledgeWikiPage): { version: number } {
  const value = Number(page.wiki.version);
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkspaceServerError("knowledge_wiki_version_invalid", 409);
  return { version: value };
}

function completionKnowledgeKind(value: WikiFrontmatter["knowledge_kind"]): "fact" | "decision" | "explanation" | "experience_rule" {
  if (value === "fact" || value === "decision" || value === "explanation" || value === "experience_rule") return value;
  // Legacy SQLite Wiki documents used the broad `reference` label. Keep them
  // readable, but do not write that retired label back into Completion.
  return "explanation";
}

function normalizeSlug(value: string): string {
  const slug = value.normalize("NFKC").toLowerCase().trim().replace(/[^a-z0-9一-龯ぁ-んァ-ヶ]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new WorkspaceServerError("knowledge_wiki_slug_required", 400);
  return slug.slice(0, 160);
}

function wikiLinks(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].flatMap((match) => match[1] ? [normalizeSlug(match[1])] : []);
}
