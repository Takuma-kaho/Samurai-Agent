import type {
  ActivityContextRef,
  AgentRecord,
  CollectionRecord,
  CollectionSchema,
  JsonValue,
  MemoryFrontmatter,
  RoomRecord,
  SkillFrontmatter,
  WikiFrontmatter
} from "@samurai-agent/core-schemas";

interface SearchResult {
  kind: "session" | "message" | "artifact" | "audit";
  id: string;
  title: string;
  summary: string;
  session_id?: string;
}
type MemoryWithFilePath = MemoryFrontmatter & { file_path: string };
type WikiWithFilePath = WikiFrontmatter & { file_path: string };
type SkillWithFilePath = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  state: SkillFrontmatter["state"];
  allowed_scopes: SkillFrontmatter["allowed_scopes"];
  required_capabilities: string[];
  owner_pinned: boolean;
  frontmatter: SkillFrontmatter;
  file_path: string;
};
type CollectionSchemaWithFilePath = CollectionSchema & { file_path: string };
type CollectionRecordWithFilePath = Omit<CollectionRecord, "version"> & { version: number; file_path: string };

/** Narrow adapter exposed to Query services; no WorkspaceStore mutation API crosses this boundary. */
export interface SearchReadStore {
  search(query: string): Promise<SearchResult[]>;
  getBackendRun(id: string): Promise<{ id: string; session_id: string; agent_id?: string } | undefined>;
  getSession(id: string): Promise<{ id: string; room_id?: string } | undefined>;
  getRoom(id: string): Promise<RoomRecord | undefined>;
  getAgent(id: string): Promise<AgentRecord | undefined>;
  searchMemory(query: string, limit?: number, options?: { includeArchived?: boolean; activityContext?: ActivityContextRef }): Promise<MemoryWithFilePath[]>;
  searchWiki(query: string, limit?: number, options?: { activeOnly?: boolean; activityContext?: ActivityContextRef }): Promise<WikiWithFilePath[]>;
  searchSkills(query: string, limit?: number, options?: { states?: SkillWithFilePath["state"][]; activityContext?: ActivityContextRef }): Promise<SkillWithFilePath[]>;
  getCollectionSchema(collectionId: string): Promise<CollectionSchemaWithFilePath | undefined>;
  listCollectionSchemas(): Promise<CollectionSchemaWithFilePath[]>;
  listCollectionRecords(collectionId?: string): Promise<CollectionRecordWithFilePath[]>;
}

export interface SessionSearchResult { kind: "session" | "message" | "artifact" | "audit"; id: string; title: string; summary: string; session_id?: string }
export interface MemorySearchResult { id: string; topic: string; state: "session" | "provisional" | "active" | "sensitive" | "topic"; file_path: string }
export interface WikiSearchResult { id: string; slug: string; title: string; file_path: string }
export interface SkillSearchResult { id: string; title: string; description: string; tags: string[]; file_path: string }
export type CollectionSearchResult =
  | { kind: "collection_schema"; id: string; file_path: string }
  | { kind: "collection_record"; collection_id: string; id: string; file_path: string; summary: string; data: Record<string, JsonValue> };

export function createSearchReadStore(store: SearchReadStore): SearchReadStore {
  return Object.freeze<SearchReadStore>({
    search: (query) => store.search(query),
    getBackendRun: (id) => store.getBackendRun(id),
    getSession: (id) => store.getSession(id),
    getRoom: (id) => store.getRoom(id),
    getAgent: (id) => store.getAgent(id),
    searchMemory: (query, limit, options) => store.searchMemory(query, limit, options),
    searchWiki: (query, limit, options) => store.searchWiki(query, limit, options),
    searchSkills: (query, limit, options) => store.searchSkills(query, limit, options),
    getCollectionSchema: (collectionId) => store.getCollectionSchema(collectionId),
    listCollectionSchemas: () => store.listCollectionSchemas(),
    listCollectionRecords: (collectionId) => store.listCollectionRecords(collectionId)
  });
}

export class SearchDomainService {
  constructor(private readonly store: SearchReadStore) {}

  async searchSessions(query: string, limit: number): Promise<SessionSearchResult[]> {
    return (await this.store.search(query)).slice(0, limit).map((item) => ({ kind: item.kind, id: item.id, title: item.title, summary: item.summary, ...(item.session_id ? { session_id: item.session_id } : {}) }));
  }

  async searchMemory(runId: string, query: string, limit: number): Promise<MemorySearchResult[]> {
    const activityContext = await this.resolveTrustedActivityContext(runId);
    return (await this.store.searchMemory(query, limit, { includeArchived: false, activityContext }))
      .filter((item): item is typeof item & { state: Exclude<typeof item.state, "archived"> } => item.state !== "archived")
      .map((item) => ({ id: item.id, topic: item.topic, state: item.state, file_path: item.file_path }));
  }

  async searchWiki(runId: string, query: string, limit: number): Promise<WikiSearchResult[]> {
    const activityContext = await this.resolveTrustedActivityContext(runId);
    return (await this.store.searchWiki(query, limit, { activeOnly: true, activityContext })).map((item) => ({ id: item.id, slug: item.slug, title: item.title, file_path: item.file_path }));
  }

  async searchSkills(runId: string, query: string, limit: number): Promise<SkillSearchResult[]> {
    const activityContext = await this.resolveTrustedActivityContext(runId);
    return (await this.store.searchSkills(query, limit, { states: ["active", "pinned", "project"], activityContext })).map((item) => ({ id: item.id, title: item.title, description: item.description, tags: item.tags, file_path: item.file_path }));
  }

  private async resolveTrustedActivityContext(runId: string): Promise<ActivityContextRef> {
    const run = await this.store.getBackendRun(runId);
    if (!run?.agent_id) throw new Error(`search_activity_context_required:${runId}`);
    const session = await this.store.getSession(run.session_id);
    if (!session?.room_id || session.id !== run.session_id) throw new Error(`search_activity_context_required:${runId}`);
    const [room, agent] = await Promise.all([this.store.getRoom(session.room_id), this.store.getAgent(run.agent_id)]);
    if (!room || !agent) throw new Error(`search_activity_context_required:${runId}`);
    return { room_id: room.id, session_id: session.id, agent_id: agent.id };
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
