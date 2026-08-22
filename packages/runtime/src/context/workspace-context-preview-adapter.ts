import { proposalCapabilityManifest } from "@samurai-agent/capability-registry";
import { loadFreezeSnapshot, retrieveActiveMemoryWithReport, type MemoryRetrievalPort, type WorkspaceRootPort } from "@samurai-agent/memory";
import { nowIso, type ExternalAssistRecord, type SkillFrontmatter } from "@samurai-agent/core-schemas";
import type { ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { type ExternalAssistProviderPort, buildExternalAssistContext } from "./external-assist-context.js";
import { buildKnowledgeWikiContext, type WorkspaceContextCandidatesStore } from "./workspace-context-candidates.js";
import { type ContextPreviewMemoryResult, type ContextPreviewPorts, type ContextPreviewSearchResult } from "./context-preview.js";
import type { SkillContextEnvironment, SkillContextSkill } from "./skill-context.js";
import type { ExternalAssistContextStore } from "./external-assist-context.js";
import { RoomAuthorizationError, RoomAuthorizationService } from "../commands/services/room-authorization-service.js";

export interface WorkspaceContextPreviewStorePort extends MemoryRetrievalPort, WorkspaceRootPort, WorkspaceContextCandidatesStore, ExternalAssistContextStore {
  getSession: ContextPreviewPorts["session"]["getSession"];
  listSessions(input?: { ids?: string[]; roomIds?: string[] }): Promise<Array<{ id: string; room_id?: string }>>;
  getSettings: ContextPreviewPorts["session"]["getSettings"];
  listMessages: ContextPreviewPorts["summary"]["listMessages"];
  listOperations: ContextPreviewPorts["summary"]["listOperations"];
  listBackendRuns: ContextPreviewPorts["summary"]["listBackendRuns"];
  listToolRuns(input: { sessionId: string }): ReturnType<ContextPreviewPorts["summary"]["listToolRuns"]>;
  listWorkspaceChanges: ContextPreviewPorts["summary"]["listWorkspaceChanges"];
  searchSkills(query: string, limit?: number, options?: {
    states?: SkillFrontmatter["state"][];
    activityContext?: { room_id: string; session_id: string; agent_id: string };
    resourceIds?: string[];
    includeLegacy?: boolean;
  }): Promise<SkillContextSkill[]>;
  listSkillUsage: ContextPreviewPorts["skills"]["listUsage"];
  listSkillSupportFileRefs: ContextPreviewPorts["skills"]["listSupportFileRefs"];
  listCollectionSchemas(options?: { resourceIds?: string[]; includeLegacy?: boolean }): ReturnType<ContextPreviewPorts["collections"]["listSchemas"]>;
  listCollectionNotes(collectionId: string): Promise<Array<{ collection_id: string; file_path: string; content: string; role: "context_only" }>>;
  search(query: string, input?: { sessionIds?: string[] }): ReturnType<ContextPreviewPorts["sessionSearch"]["search"]>;
}

export interface WorkspaceContextPreviewAdapterOptions {
  externalAssistProviders?: readonly ExternalAssistProviderPort[];
  sessionNotFound(sessionId: string): Error;
}

/** The current principal and Room are server-resolved from the admitted Run. */
export interface WorkspaceContextPreviewAccess {
  principal: ParticipantPrincipal;
  roomId: string;
}

/** Concrete Workspace Store adapter; the context preview core only sees ContextPreviewPorts. */
export class WorkspaceContextPreviewAdapter {
  constructor(
    private readonly store: WorkspaceContextPreviewStorePort,
    private readonly options: WorkspaceContextPreviewAdapterOptions,
    private readonly authorization: RoomAuthorizationService
  ) {}

  /** A Run-specific view prevents Memory, Skill, Wiki, Collection and search leakage. */
  portsForAccess(access: WorkspaceContextPreviewAccess): ContextPreviewPorts {
    return this.createPorts(access);
  }

  private createPorts(access: WorkspaceContextPreviewAccess): ContextPreviewPorts {
    const environment: SkillContextEnvironment = {
      runtime: "local_workspace",
      platform: process.platform,
      availableCapabilities: [...new Set([
        ...proposalCapabilityManifest.agent_tools,
        ...proposalCapabilityManifest.operations.map((operation) => operation.operation)
      ])].sort(),
      supportedScopes: new Set([
        ...proposalCapabilityManifest.operations.map((operation) => operation.scope),
        "artifact", "collection", "memory", "session", "skill", "workspace"
      ])
    };
    return {
      session: {
        getSession: async (sessionId) => {
          const session = await this.store.getSession(sessionId);
          if (!session || !await this.sessionAllowed(access, sessionId)) return undefined;
          return session;
        },
        getSettings: () => this.store.getSettings()
      },
      summary: {
        listMessages: async (sessionId) => {
          await this.assertSessionAccess(access, sessionId);
          return this.store.listMessages(sessionId);
        },
        listOperations: async (sessionId) => {
          await this.assertSessionAccess(access, sessionId);
          return this.store.listOperations(sessionId);
        },
        listBackendRuns: async (sessionId) => {
          await this.assertSessionAccess(access, sessionId);
          return this.store.listBackendRuns(sessionId);
        },
        listToolRuns: async (sessionId) => {
          await this.assertSessionAccess(access, sessionId);
          return this.store.listToolRuns({ sessionId });
        },
        listWorkspaceChanges: async (sessionId) => {
          await this.assertSessionAccess(access, sessionId);
          return this.store.listWorkspaceChanges(sessionId);
        }
      },
      memory: {
        retrieve: async (query, activityContext) => {
          const retrievalStore: MemoryRetrievalPort = {
            searchMemory: async (searchQuery, limit, options) => {
              const candidates = await this.store.searchMemory(searchQuery, limit, {
                ...options,
                ...await this.resourceCandidateOptions(access, "memory")
              });
              return this.filterResources(access, candidates, "memory", (candidate) => candidate.id);
            },
            readMemoryContent: async (memoryId) => {
              if (!await this.resourceAllowed(access, "memory", memoryId)) return undefined;
              return this.store.readMemoryContent(memoryId);
            }
          };
          const result = await retrieveActiveMemoryWithReport(retrievalStore, query, activityContext);
          const candidates = await this.filterResources(access, result.candidates, "memory", (candidate) => candidate.frontmatter.id);
          return {
            candidates,
            report: {
              ...result.report,
              // Keep the retrieval candidate count before Room filtering and
              // active-memory redaction. Context assembly uses the difference
              // to explain why a candidate was omitted.
              candidate_count: result.report.candidate_count,
              included_count: candidates.length,
              included_memory_ids: candidates.map((candidate) => candidate.frontmatter.id),
              excluded: await this.filterMemoryExclusions(access, result.report.excluded)
            }
          };
        },
        loadFreezeSnapshot: async (input) => {
          const refs = [
            ...input.memoryRefs.map((ref) => ({ kind: "memory", id: ref.id })),
            ...input.skillRefs.map((ref) => ({ kind: "skill", id: ref.id })),
            ...input.wikiRefs.map((ref) => ({ kind: "wiki", id: ref.id }))
          ];
          for (const ref of refs) {
            if (!await this.resourceAllowed(access, ref.kind, ref.id)) return undefined;
          }
          return loadFreezeSnapshot(this.store, input);
        }
      },
      wiki: {
        build: async (query, activityContext) => buildKnowledgeWikiContext({
          searchWiki: async (searchQuery, limit, searchOptions) => {
            const candidates = await this.store.searchWiki(searchQuery, limit, {
              ...searchOptions,
            ...await this.resourceCandidateOptions(access, "wiki")
          });
            return this.filterResources(access, candidates, "wiki", (candidate) => candidate.id);
          },
          readWikiContent: async (id) => {
            if (!await this.resourceAllowed(access, "wiki", id)) return undefined;
            return this.store.readWikiContent(id);
          }
        }, query, activityContext)
      },
      skills: {
        search: async (query, limit, activityContext) => {
          const candidates = (await this.store.searchSkills(query, limit, {
            states: ["active", "pinned", "project"],
            ...(activityContext ? { activityContext } : {}),
            ...await this.resourceCandidateOptions(access, "skill")
          })).filter((skill) => skill.frontmatter.evidence_state !== "conflict" && skill.frontmatter.usage_state !== "dormant");
          return this.filterResources(access, candidates, "skill", (skill) => skill.id);
        },
        listUsage: async () => {
          const usage = await this.store.listSkillUsage();
          const filtered = await Promise.all(usage.map(async (entry) => ({
            entry,
            allowed: await this.resourceAllowed(access, "skill", entry.skill_id)
          })));
          return filtered.filter((entry) => entry.allowed).map((entry) => entry.entry);
        },
        listSupportFileRefs: async (skillId) => {
          if (!await this.resourceAllowed(access, "skill", skillId)) return [];
          return this.store.listSkillSupportFileRefs(skillId);
        },
        environment
      },
      collections: {
        listSchemas: async () => {
          const schemas = await this.store.listCollectionSchemas(
            await this.resourceCandidateOptions(access, "collection_schema")
          );
          return this.filterResources(access, schemas, "collection_schema", (schema) => schema.id);
        },
        listNotes: async (collectionId) => {
          if (!await this.resourceAllowed(access, "collection_schema", collectionId)) return [];
          return (await this.store.listCollectionNotes(collectionId)).map((note) => ({
            collection_id: note.collection_id,
            file_path: note.file_path,
            content: note.content.trim(),
            role: "context_only" as const
          }));
        }
      },
      sessionSearch: {
        search: async (query) => {
          const results = await this.store.search(query, { sessionIds: await this.authorizedSessionIds(access) });
          return this.filterSessionSearch(access, results);
        }
      },
      externalAssist: {
        build: async (input) => {
          // Re-check at the external boundary, after context was assembled but
          // immediately before its contents could leave the Workspace.
          await this.assertSessionAccess(access, input.sessionId);
          return buildExternalAssistContext({
            store: {
              listExternalAssistRecords: (recordInput) => this.store.listExternalAssistRecords(recordInput),
              saveExternalAssistRecord: (record: ExternalAssistRecord) => this.store.saveExternalAssistRecord(record)
            },
            providers: this.options.externalAssistProviders ?? [],
            sessionId: input.sessionId,
            query: input.query,
            role: input.role,
            recentMessages: input.recentMessages,
            sessionSearch: input.sessionSearch
          });
        }
      },
      tools: { listAvailable: () => proposalCapabilityManifest.agent_tools },
      errors: { sessionNotFound: this.options.sessionNotFound },
      clock: { now: () => nowIso() }
    };
  }

  private async filterSessionSearch(access: WorkspaceContextPreviewAccess, results: ContextPreviewSearchResult[]): Promise<ContextPreviewSearchResult[]> {
    const filtered = await Promise.all(results.map(async (result) => {
      const sessionId = "session_id" in result && typeof result.session_id === "string"
        ? result.session_id
        : result.kind === "session" ? result.id : undefined;
      if (!sessionId) return undefined;
      const session = await this.store.getSession(sessionId);
      if (!session?.room_id) return undefined;
      // Candidate selection already constrains Session IDs. Re-check even the
      // current Room here so an unbounded legacy Session cannot reach Agent
      // context for anyone other than the Workspace Owner.
      return await this.resourceAllowed(access, "session", session.id) ? result : undefined;
    }));
    return filtered.filter((result): result is ContextPreviewSearchResult => Boolean(result));
  }

  private async authorizedSessionIds(access: WorkspaceContextPreviewAccess): Promise<string[]> {
    const candidateAccess = await this.authorization.resourceCandidateAccess(access.principal, access.roomId, "session");
    const ids = new Set(candidateAccess.resourceIds);
    if (candidateAccess.includeLegacy) {
      for (const session of await this.store.listSessions({ roomIds: [access.roomId] })) ids.add(session.id);
    }
    return [...ids];
  }

  private async filterResources<T>(access: WorkspaceContextPreviewAccess, values: T[], resourceKind: string, resourceId: (value: T) => string): Promise<T[]> {
    const filtered = await Promise.all(values.map(async (value) => ({ value, allowed: await this.resourceAllowed(access, resourceKind, resourceId(value)) })));
    return filtered.filter((entry) => entry.allowed).map((entry) => entry.value);
  }

  private async filterMemoryExclusions(access: WorkspaceContextPreviewAccess, exclusions: ContextPreviewMemoryResult["report"]["excluded"]): Promise<ContextPreviewMemoryResult["report"]["excluded"]> {
    const visible = await Promise.all(exclusions.map(async (entry) => {
      return await this.resourceAllowed(access, "memory", entry.id) ? entry : undefined;
    }));
    return visible.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  }

  private async resourceAllowed(access: WorkspaceContextPreviewAccess, resourceKind: string, resourceId: string): Promise<boolean> {
    try {
      // Final check happens immediately before the candidate reaches Host context.
      await this.authorization.assertResource(access.principal, { roomId: access.roomId, action: "read", resourceKind, resourceId });
      return true;
    } catch (error) {
      if (error instanceof RoomAuthorizationError) return false;
      throw error;
    }
  }

  private async resourceCandidateOptions(
    access: WorkspaceContextPreviewAccess,
    resourceKind: string
  ): Promise<{ resourceIds: string[]; includeLegacy: boolean }> {
    return this.authorization.resourceCandidateAccess(access.principal, access.roomId, resourceKind);
  }

  private async sessionAllowed(access: WorkspaceContextPreviewAccess, sessionId: string): Promise<boolean> {
    try {
      await this.assertSessionAccess(access, sessionId);
      return true;
    } catch (error) {
      if (error instanceof RoomAuthorizationError) return false;
      throw error;
    }
  }

  private async assertSessionAccess(access: WorkspaceContextPreviewAccess, sessionId: string): Promise<void> {
    const session = await this.store.getSession(sessionId);
    if (!session?.room_id) throw this.options.sessionNotFound(sessionId);
    await this.authorization.assertResource(access.principal, {
      roomId: access.roomId,
      action: "read",
      resourceKind: "session",
      resourceId: session.id
    });
  }
}
