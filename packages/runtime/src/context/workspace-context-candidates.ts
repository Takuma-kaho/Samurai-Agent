import { nowIso, type ContextPreview, type Provenance, type ResourceRef } from "@samurai-agent/core-schemas";

export interface WikiContextPage {
  id: string;
  slug: string;
  title: string;
  state: "proposed" | "active" | "rejected" | "archived";
  source_refs: ResourceRef[];
  provenance: Provenance;
  file_path: string;
}

export interface WorkspaceContextCandidatesStore {
  searchWiki(query: string, limit: number, options: { activeOnly: boolean; activityContext?: { room_id: string; session_id: string; agent_id: string } }): Promise<WikiContextPage[]>;
  readWikiContent(id: string): Promise<string | undefined>;
}

export interface KnowledgeWikiContext {
  pages: WikiContextPage[];
  entries: ContextPreview["knowledge_wiki"];
  report: ContextPreview["knowledge_wiki_report"];
}

export function emptyKnowledgeWikiContext(query: string): KnowledgeWikiContext {
  return { pages: [], entries: [], report: { query, retrieved_at: nowIso(), candidate_count: 0, included_count: 0, included_wiki_ids: [], excluded: [], source_refs: [] } };
}

export async function buildKnowledgeWikiContext(store: WorkspaceContextCandidatesStore, query: string, activityContext?: { room_id: string; session_id: string; agent_id: string }): Promise<KnowledgeWikiContext> {
  const matches = await store.searchWiki(query, 20, { activeOnly: false, ...(activityContext ? { activityContext } : {}) });
  const pages: WikiContextPage[] = [];
  const entries: ContextPreview["knowledge_wiki"] = [];
  const excluded: ContextPreview["knowledge_wiki_report"]["excluded"] = [];
  for (const wiki of matches) {
    const reason = knowledgeWikiExclusionReason(wiki);
    if (reason) {
      excluded.push({ id: wiki.id, slug: wiki.slug, title: wiki.title, state: wiki.state, reason });
      continue;
    }
    const content = (await store.readWikiContent(wiki.id)) ?? "";
    if (!content.trim()) {
      excluded.push({ id: wiki.id, slug: wiki.slug, title: wiki.title, state: wiki.state, reason: "empty_content" });
      continue;
    }
    if (entries.length < 5) {
      pages.push(wiki);
      entries.push({ id: wiki.id, slug: wiki.slug, title: wiki.title, content, source_refs: wiki.source_refs, provenance: wiki.provenance });
    }
  }
  return { pages, entries, report: { query, retrieved_at: nowIso(), candidate_count: matches.length, included_count: entries.length, included_wiki_ids: entries.map((entry) => entry.id), excluded, source_refs: entries.flatMap((entry) => entry.source_refs) } };
}

function knowledgeWikiExclusionReason(wiki: WikiContextPage): ContextPreview["knowledge_wiki_report"]["excluded"][number]["reason"] | undefined {
  if (wiki.state === "proposed") return "proposed";
  if (wiki.state === "rejected") return "rejected";
  if (wiki.state === "archived") return "archived";
  if (wiki.state !== "active") return "not_active";
  return undefined;
}
