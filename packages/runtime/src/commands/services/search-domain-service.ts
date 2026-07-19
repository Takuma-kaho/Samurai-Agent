import type { JsonValue } from "@samurai-agent/core-schemas";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";

type SearchStoreMethods = Pick<WorkspaceStore, "search" | "searchMemory" | "searchWiki" | "searchSkills" | "getCollectionSchema" | "listCollectionSchemas" | "listCollectionRecords">;
type SearchArgs<K extends keyof SearchStoreMethods> = Parameters<SearchStoreMethods[K]>;

/** Narrow adapter exposed to Query services; no WorkspaceStore mutation API crosses this boundary. */
export interface SearchReadStore {
  search: SearchStoreMethods["search"];
  searchMemory: SearchStoreMethods["searchMemory"];
  searchWiki: SearchStoreMethods["searchWiki"];
  searchSkills: SearchStoreMethods["searchSkills"];
  getCollectionSchema: SearchStoreMethods["getCollectionSchema"];
  listCollectionSchemas: SearchStoreMethods["listCollectionSchemas"];
  listCollectionRecords: SearchStoreMethods["listCollectionRecords"];
}

export interface SessionSearchResult { kind: "session" | "message" | "artifact" | "audit"; id: string; title: string; summary: string; session_id?: string }
export interface MemorySearchResult { id: string; topic: string; state: "session" | "provisional" | "active" | "sensitive" | "topic"; file_path: string }
export interface WikiSearchResult { id: string; slug: string; title: string; file_path: string }
export interface SkillSearchResult { id: string; title: string; description: string; tags: string[]; file_path: string }
export type CollectionSearchResult =
  | { kind: "collection_schema"; id: string; file_path: string }
  | { kind: "collection_record"; collection_id: string; id: string; file_path: string; summary: string; data: Record<string, JsonValue> };

export function createSearchReadStore(store: SearchStoreMethods): SearchReadStore {
  return Object.freeze({
    search: (...args: SearchArgs<"search">) => store.search(...args),
    searchMemory: (...args: SearchArgs<"searchMemory">) => store.searchMemory(...args),
    searchWiki: (...args: SearchArgs<"searchWiki">) => store.searchWiki(...args),
    searchSkills: (...args: SearchArgs<"searchSkills">) => store.searchSkills(...args),
    getCollectionSchema: (...args: SearchArgs<"getCollectionSchema">) => store.getCollectionSchema(...args),
    listCollectionSchemas: (...args: SearchArgs<"listCollectionSchemas">) => store.listCollectionSchemas(...args),
    listCollectionRecords: (...args: SearchArgs<"listCollectionRecords">) => store.listCollectionRecords(...args)
  });
}

export class SearchDomainService {
  constructor(private readonly store: SearchReadStore) {}

  async searchSessions(query: string, limit: number): Promise<SessionSearchResult[]> {
    return (await this.store.search(query)).slice(0, limit).map((item) => ({ kind: item.kind, id: item.id, title: item.title, summary: item.summary, ...(item.session_id ? { session_id: item.session_id } : {}) }));
  }

  async searchMemory(query: string, limit: number): Promise<MemorySearchResult[]> {
    return (await this.store.searchMemory(query, limit, { includeArchived: false }))
      .filter((item): item is typeof item & { state: Exclude<typeof item.state, "archived"> } => item.state !== "archived")
      .map((item) => ({ id: item.id, topic: item.topic, state: item.state, file_path: item.file_path }));
  }

  async searchWiki(query: string, limit: number): Promise<WikiSearchResult[]> {
    return (await this.store.searchWiki(query, limit, { activeOnly: true })).map((item) => ({ id: item.id, slug: item.slug, title: item.title, file_path: item.file_path }));
  }

  async searchSkills(query: string, limit: number): Promise<SkillSearchResult[]> {
    return (await this.store.searchSkills(query, limit, { states: ["active", "pinned", "project"] })).map((item) => ({ id: item.id, title: item.title, description: item.description, tags: item.tags, file_path: item.file_path }));
  }

  async searchCollections(collectionId: string | undefined, query: string, limit: number): Promise<CollectionSearchResult[]> {
    const schemas = collectionId ? [await this.store.getCollectionSchema(collectionId)].filter((item): item is NonNullable<typeof item> => Boolean(item)) : await this.store.listCollectionSchemas();
    const normalized = query.trim().toLowerCase();
    if (!collectionId) {
      return schemas
        .filter((schema) => !normalized || `${schema.id} ${JSON.stringify(schema.labels)} ${JSON.stringify(schema.descriptions)}`.toLowerCase().includes(normalized))
        .slice(0, limit)
        .map((schema) => ({ kind: "collection_schema", id: schema.id, file_path: schema.file_path }));
    }
    const results: CollectionSearchResult[] = [];
    for (const schema of schemas) {
      if (!normalized || `${schema.id} ${JSON.stringify(schema.labels)} ${JSON.stringify(schema.descriptions)}`.toLowerCase().includes(normalized)) {
        results.push({ kind: "collection_schema", id: schema.id, file_path: schema.file_path });
      }
      const records = await this.store.listCollectionRecords(schema.id);
      for (const record of records) {
        if (normalized && !JSON.stringify(record.data).toLowerCase().includes(normalized)) continue;
        results.push({ kind: "collection_record", collection_id: record.collection_id, id: record.id, file_path: record.file_path, summary: JSON.stringify(record.data).slice(0, 180), data: record.data });
        if (results.length >= limit) return results;
      }
      if (results.length >= limit) return results;
    }
    return results.slice(0, limit);
  }
}
