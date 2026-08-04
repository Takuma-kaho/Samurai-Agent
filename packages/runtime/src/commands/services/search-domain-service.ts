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
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import { collectionRecordResourceId, type ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { RoomAuthorizationError, RoomAuthorizationService } from "./room-authorization-service.js";

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
  search(query: string, input?: { sessionIds?: string[] }): Promise<SearchResult[]>;
  getBackendRun(id: string): Promise<{ id: string; session_id: string; agent_id?: string; requested_by_participant_id?: string } | undefined>;
  getSession(id: string): Promise<{ id: string; room_id?: string } | undefined>;
  listSessions(input?: { ids?: string[]; roomIds?: string[] }): Promise<Array<{ id: string; room_id?: string }>>;
  getRoom(id: string): Promise<RoomRecord | undefined>;
  getAgent(id: string): Promise<AgentRecord | undefined>;
  searchMemory(query: string, limit?: number, options?: { includeArchived?: boolean; activityContext?: ActivityContextRef; resourceIds?: string[]; includeLegacy?: boolean }): Promise<MemoryWithFilePath[]>;
  searchWiki(query: string, limit?: number, options?: { activeOnly?: boolean; activityContext?: ActivityContextRef; resourceIds?: string[]; includeLegacy?: boolean }): Promise<WikiWithFilePath[]>;
  searchSkills(query: string, limit?: number, options?: { states?: SkillWithFilePath["state"][]; activityContext?: ActivityContextRef; resourceIds?: string[]; includeLegacy?: boolean }): Promise<SkillWithFilePath[]>;
  getCollectionSchema(collectionId: string): Promise<CollectionSchemaWithFilePath | undefined>;
  listCollectionSchemas(options?: { resourceIds?: string[]; includeLegacy?: boolean }): Promise<CollectionSchemaWithFilePath[]>;
  listCollectionRecords(collectionId?: string, options?: { resourceIds?: string[]; includeLegacy?: boolean }): Promise<CollectionRecordWithFilePath[]>;
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
    search: (query, input) => store.search(query, input),
    getBackendRun: (id) => store.getBackendRun(id),
    getSession: (id) => store.getSession(id),
    listSessions: (input) => store.listSessions(input),
    getRoom: (id) => store.getRoom(id),
    getAgent: (id) => store.getAgent(id),
    searchMemory: (query, limit, options) => store.searchMemory(query, limit, options),
    searchWiki: (query, limit, options) => store.searchWiki(query, limit, options),
    searchSkills: (query, limit, options) => store.searchSkills(query, limit, options),
    getCollectionSchema: (collectionId) => store.getCollectionSchema(collectionId),
    listCollectionSchemas: (options) => store.listCollectionSchemas(options),
    listCollectionRecords: (collectionId, options) => store.listCollectionRecords(collectionId, options)
  });
}

interface SearchAccess {
  activityContext: ActivityContextRef;
  principal: ParticipantPrincipal;
}

/**
 * Search always resolves a Room first. UsageScope narrows candidates only;
 * `RoomAuthorizationService` is the sole authority for both candidates and
 * the final returned values.
 */
export class SearchDomainService {
  constructor(
    private readonly store: SearchReadStore,
    private readonly authorization: RoomAuthorizationService
  ) {}

  async searchSessions(context: TrustedDomainContext, query: string, limit: number): Promise<SessionSearchResult[]> {
    const access = await this.resolveAccess(context);
    const candidates = await this.store.search(query, { sessionIds: await this.authorizedSessionIds(access) });
    const allowed: SessionSearchResult[] = [];
    for (const item of candidates) {
      const sessionId = item.session_id ?? (item.kind === "session" ? item.id : undefined);
      if (!sessionId || !await this.sessionResultAllowed(access, sessionId)) continue;
      allowed.push({ kind: item.kind, id: item.id, title: item.title, summary: item.summary, ...(item.session_id ? { session_id: item.session_id } : {}) });
      if (allowed.length >= limit) break;
    }
    return allowed;
  }

  async searchMemory(context: TrustedDomainContext, query: string, limit: number): Promise<MemorySearchResult[]> {
    const access = await this.resolveAccess(context);
    const candidates = await this.store.searchMemory(query, limit, {
      includeArchived: false,
      activityContext: access.activityContext,
      ...await this.resourceCandidateOptions(access, "memory")
    });
    const allowed = await this.filterResources(access, candidates, "memory", (item) => item.id);
    return allowed
      .filter((item): item is typeof item & { state: Exclude<typeof item.state, "archived"> } => item.state !== "archived")
      .map((item) => ({ id: item.id, topic: item.topic, state: item.state, file_path: item.file_path }));
  }

  async searchWiki(context: TrustedDomainContext, query: string, limit: number): Promise<WikiSearchResult[]> {
    const access = await this.resolveAccess(context);
    const candidates = await this.store.searchWiki(query, limit, {
      activeOnly: true,
      activityContext: access.activityContext,
      ...await this.resourceCandidateOptions(access, "wiki")
    });
    const allowed = await this.filterResources(access, candidates, "wiki", (item) => item.id);
    return allowed.map((item) => ({ id: item.id, slug: item.slug, title: item.title, file_path: item.file_path }));
  }

  async searchSkills(context: TrustedDomainContext, query: string, limit: number): Promise<SkillSearchResult[]> {
    const access = await this.resolveAccess(context);
    const candidates = await this.store.searchSkills(query, limit, {
      states: ["active", "pinned", "project"],
      activityContext: access.activityContext,
      ...await this.resourceCandidateOptions(access, "skill")
    });
    const allowed = await this.filterResources(access, candidates, "skill", (item) => item.id);
    return allowed.map((item) => ({ id: item.id, title: item.title, description: item.description, tags: item.tags, file_path: item.file_path }));
  }

  async searchCollections(context: TrustedDomainContext, collectionId: string | undefined, query: string, limit: number): Promise<CollectionSearchResult[]> {
    const access = await this.resolveAccess(context);
    const schemaCandidateAccess = await this.authorization.resourceCandidateAccess(access.principal, access.activityContext.room_id, "collection_schema");
    const schemas = collectionId
      ? await this.directSchemaCandidate(access, collectionId, schemaCandidateAccess)
      : await this.store.listCollectionSchemas(schemaCandidateAccess);
    const recordCandidateAccess = await this.authorization.resourceCandidateAccess(access.principal, access.activityContext.room_id, "collection_record");
    const normalized = query.trim().toLowerCase();
    const results: CollectionSearchResult[] = [];
    for (const schema of schemas) {
      if (!await this.resourceAllowed(access, "collection_schema", schema.id)) continue;
      const schemaMatches = !normalized || `${schema.id} ${JSON.stringify(schema.labels)} ${JSON.stringify(schema.descriptions)}`.toLowerCase().includes(normalized);
      if (schemaMatches) {
        results.push({ kind: "collection_schema", id: schema.id, file_path: schema.file_path });
      }
      if (!collectionId) {
        if (results.length >= limit) break;
        continue;
      }
      const records = await this.store.listCollectionRecords(schema.id, recordCandidateAccess);
      for (const record of records) {
        const recordBoundaryId = collectionRecordBoundaryId(record.collection_id, record.id);
        if (!await this.resourceAllowed(access, "collection_record", recordBoundaryId)) continue;
        if (normalized && !JSON.stringify(record.data).toLowerCase().includes(normalized)) continue;
        results.push({ kind: "collection_record", collection_id: record.collection_id, id: record.id, file_path: record.file_path, summary: JSON.stringify(record.data).slice(0, 180), data: record.data });
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  }

  private async resolveAccess(context: TrustedDomainContext): Promise<SearchAccess> {
    if (!context.participant) throw new Error("search_activity_context_required:participant");
    let sessionId = context.sessionId;
    let principal = context.participant;
    let run: Awaited<ReturnType<SearchReadStore["getBackendRun"]>>;
    if (context.runId) {
      run = await this.store.getBackendRun(context.runId);
      if (!run?.agent_id) throw new Error(`search_activity_context_required:${context.runId}`);
      sessionId = run.session_id;
      if (principal.kind !== "agent" || principal.agentId !== run.agent_id) {
        throw new Error(`search_activity_context_participant_mismatch:${context.runId}`);
      }
    }
    if (!sessionId) throw new Error("search_activity_context_required:session");
    const session = await this.store.getSession(sessionId);
    if (!session?.room_id) throw new Error(`search_activity_context_required:${sessionId}`);
    const [room, agent] = await Promise.all([
      this.store.getRoom(session.room_id),
      context.runId && run?.agent_id ? this.store.getAgent(run.agent_id) : Promise.resolve(undefined)
    ]);
    if (!room || (context.runId && !agent)) throw new Error(`search_activity_context_required:${sessionId}`);
    try {
      await this.authorization.assertRoom(principal, room.id, "read");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new Error(`search_room_authorization_denied:${error.reason}`);
      throw error;
    }
    return { activityContext: { room_id: room.id, session_id: session.id, agent_id: agent?.id ?? "human" }, principal };
  }

  private async sessionResultAllowed(access: SearchAccess, sessionId: string): Promise<boolean> {
    const session = await this.store.getSession(sessionId);
    if (!session?.room_id) return false;
    // The first phase limits candidates to current-Room or explicitly shared
    // Sessions. This second phase still checks every result, including a
    // same-Room legacy Session, so removal and Owner-only legacy rules take
    // effect immediately before a title or message summary is returned.
    return this.resourceAllowed(access, "session", session.id);
  }

  private async directSchemaCandidate(
    access: SearchAccess,
    collectionId: string,
    candidates: { resourceIds: string[]; includeLegacy: boolean }
  ): Promise<CollectionSchemaWithFilePath[]> {
    // Check a known identifier before loading its schema body or metadata. For
    // an Owner, `resourceAllowed` distinguishes a genuinely legacy schema
    // from one formally owned by another Room.
    if (!candidates.includeLegacy && !candidates.resourceIds.includes(collectionId)) return [];
    if (!await this.resourceAllowed(access, "collection_schema", collectionId)) return [];
    const schema = await this.store.getCollectionSchema(collectionId);
    return schema ? [schema] : [];
  }

  private async authorizedSessionIds(access: SearchAccess): Promise<string[]> {
    const candidateAccess = await this.authorization.resourceCandidateAccess(
      access.principal,
      access.activityContext.room_id,
      "session"
    );
    const ids = new Set(candidateAccess.resourceIds);
    // Legacy Sessions have no boundary. They remain available only to the
    // Workspace Owner, and only from their own Room; no other Room is scanned.
    if (candidateAccess.includeLegacy) {
      for (const session of await this.store.listSessions({ roomIds: [access.activityContext.room_id] })) {
        ids.add(session.id);
      }
    }
    return [...ids];
  }

  private async filterResources<T>(access: SearchAccess, candidates: T[], resourceKind: string, id: (item: T) => string): Promise<T[]> {
    const results = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      allowed: await this.resourceAllowed(access, resourceKind, id(candidate))
    })));
    return results.filter((result) => result.allowed).map((result) => result.candidate);
  }

  private async resourceAllowed(access: SearchAccess, resourceKind: string, resourceId: string): Promise<boolean> {
    try {
      // This executes after candidate retrieval, giving revoked participation
      // and shares an immediate final check before returning any content.
      await this.authorization.assertResource(access.principal, {
        roomId: access.activityContext.room_id,
        action: "read",
        resourceKind,
        resourceId
      });
      return true;
    } catch (error) {
      if (error instanceof RoomAuthorizationError) return false;
      throw error;
    }
  }

  private async resourceCandidateOptions(access: SearchAccess, resourceKind: string): Promise<{ resourceIds: string[]; includeLegacy: boolean }> {
    const candidateAccess = await this.authorization.resourceCandidateAccess(
      access.principal,
      access.activityContext.room_id,
      resourceKind
    );
    return candidateAccess;
  }
}

export function collectionRecordBoundaryId(collectionId: string, recordId: string): string {
  return collectionRecordResourceId(collectionId, recordId);
}
