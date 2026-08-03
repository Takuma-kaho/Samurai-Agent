import { proposalCapabilityManifest } from "@samurai-agent/capability-registry";
import { loadFreezeSnapshot, retrieveActiveMemoryWithReport, type MemoryRetrievalPort, type WorkspaceRootPort } from "@samurai-agent/memory";
import { nowIso, type ExternalAssistRecord, type SkillFrontmatter } from "@samurai-agent/core-schemas";
import { type ExternalAssistProviderPort, buildExternalAssistContext } from "./external-assist-context.js";
import { buildKnowledgeWikiContext, type WorkspaceContextCandidatesStore } from "./workspace-context-candidates.js";
import { type ContextPreviewPorts } from "./context-preview.js";
import type { SkillContextEnvironment, SkillContextSkill } from "./skill-context.js";
import type { ExternalAssistContextStore } from "./external-assist-context.js";

export interface WorkspaceContextPreviewStorePort extends MemoryRetrievalPort, WorkspaceRootPort, WorkspaceContextCandidatesStore, ExternalAssistContextStore {
  getSession: ContextPreviewPorts["session"]["getSession"];
  getSettings: ContextPreviewPorts["session"]["getSettings"];
  listMessages: ContextPreviewPorts["summary"]["listMessages"];
  listOperations: ContextPreviewPorts["summary"]["listOperations"];
  listBackendRuns: ContextPreviewPorts["summary"]["listBackendRuns"];
  listToolRuns(input: { sessionId: string }): ReturnType<ContextPreviewPorts["summary"]["listToolRuns"]>;
  listWorkspaceChanges: ContextPreviewPorts["summary"]["listWorkspaceChanges"];
  searchSkills(query: string, limit?: number, options?: { states?: SkillFrontmatter["state"][]; activityContext?: { room_id: string; session_id: string; agent_id: string } }): Promise<SkillContextSkill[]>;
  listSkillUsage: ContextPreviewPorts["skills"]["listUsage"];
  listSkillSupportFileRefs: ContextPreviewPorts["skills"]["listSupportFileRefs"];
  listCollectionSchemas: ContextPreviewPorts["collections"]["listSchemas"];
  listCollectionNotes(collectionId: string): Promise<Array<{ collection_id: string; file_path: string; content: string; role: "context_only" }>>;
  search: ContextPreviewPorts["sessionSearch"]["search"];
}

export interface WorkspaceContextPreviewAdapterOptions {
  externalAssistProviders?: readonly ExternalAssistProviderPort[];
  sessionNotFound(sessionId: string): Error;
}

/** Concrete Workspace Store adapter; the context preview core only sees ContextPreviewPorts. */
export class WorkspaceContextPreviewAdapter {
  readonly ports: ContextPreviewPorts;

  constructor(private readonly store: WorkspaceContextPreviewStorePort, options: WorkspaceContextPreviewAdapterOptions) {
    const environment: SkillContextEnvironment = {
      runtime: "local_workspace",
      platform: process.platform,
      availableCapabilities: [...new Set([
        ...proposalCapabilityManifest.agent_tools,
        ...proposalCapabilityManifest.operations.map((operation) => operation.operation)
      ])].sort(),
      supportedScopes: new Set([
        ...proposalCapabilityManifest.operations.map((operation) => operation.scope),
        "artifact",
        "collection",
        "memory",
        "session",
        "skill",
        "workspace"
      ])
    };
    this.ports = {
      session: {
        getSession: (sessionId) => this.store.getSession(sessionId),
        getSettings: () => this.store.getSettings()
      },
      summary: {
        listMessages: (sessionId) => this.store.listMessages(sessionId),
        listOperations: (sessionId) => this.store.listOperations(sessionId),
        listBackendRuns: (sessionId) => this.store.listBackendRuns(sessionId),
        listToolRuns: (sessionId) => this.store.listToolRuns({ sessionId }),
        listWorkspaceChanges: (sessionId) => this.store.listWorkspaceChanges(sessionId)
      },
      memory: {
        retrieve: (query, activityContext) => retrieveActiveMemoryWithReport(this.store, query, activityContext),
        loadFreezeSnapshot: (input) => loadFreezeSnapshot(this.store, input)
      },
      wiki: {
        build: (query, activityContext) => buildKnowledgeWikiContext(this.store, query, activityContext)
      },
      skills: {
        search: async (query, limit, activityContext) => (await this.store.searchSkills(query, limit, {
          states: ["active", "pinned", "project"],
          ...(activityContext ? { activityContext } : {})
        })).filter((skill) => skill.frontmatter.evidence_state !== "conflict" && skill.frontmatter.usage_state !== "dormant"),
        listUsage: () => this.store.listSkillUsage(),
        listSupportFileRefs: (skillId) => this.store.listSkillSupportFileRefs(skillId),
        environment
      },
      collections: {
        listSchemas: async () => this.store.listCollectionSchemas(),
        listNotes: async (collectionId) => (await this.store.listCollectionNotes(collectionId)).map((note) => ({
          collection_id: note.collection_id,
          file_path: note.file_path,
          content: note.content.trim(),
          role: "context_only" as const
        }))
      },
      sessionSearch: {
        search: (query) => this.store.search(query)
      },
      externalAssist: {
        build: (input) => buildExternalAssistContext({
          store: {
            listExternalAssistRecords: (recordInput) => this.store.listExternalAssistRecords(recordInput),
            saveExternalAssistRecord: (record: ExternalAssistRecord) => this.store.saveExternalAssistRecord(record)
          },
          providers: options.externalAssistProviders ?? [],
          sessionId: input.sessionId,
          query: input.query,
          role: input.role,
          recentMessages: input.recentMessages,
          sessionSearch: input.sessionSearch
        })
      },
      tools: {
        listAvailable: () => proposalCapabilityManifest.agent_tools
      },
      errors: {
        sessionNotFound: options.sessionNotFound
      },
      clock: {
        now: () => nowIso()
      }
    };
  }
}
