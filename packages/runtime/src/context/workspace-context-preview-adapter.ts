import { proposalCapabilityManifest } from "@samurai-agent/capability-registry";
import { loadFreezeSnapshot, retrieveActiveMemoryWithReport } from "@samurai-agent/memory";
import { nowIso, type ExternalAssistRecord } from "@samurai-agent/core-schemas";
import { parseSkillMarkdown } from "@samurai-agent/skills";
import { type ExternalAssistProviderPort, buildExternalAssistContext } from "./external-assist-context.js";
import { buildKnowledgeWikiContext } from "./workspace-context-candidates.js";
import { type ContextPreviewPorts } from "./context-preview.js";
import type { SkillContextEnvironment } from "./skill-context.js";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";

export interface WorkspaceContextPreviewAdapterOptions {
  externalAssistProviders?: readonly ExternalAssistProviderPort[];
  sessionNotFound(sessionId: string): Error;
}

/** Concrete Workspace Store adapter; the context preview core only sees ContextPreviewPorts. */
export class WorkspaceContextPreviewAdapter {
  readonly ports: ContextPreviewPorts;

  constructor(private readonly store: WorkspaceStore, options: WorkspaceContextPreviewAdapterOptions) {
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
        retrieve: (query) => retrieveActiveMemoryWithReport(this.store, query),
        loadFreezeSnapshot: (input) => loadFreezeSnapshot(this.store, input)
      },
      wiki: {
        build: (query) => buildKnowledgeWikiContext(this.store, query)
      },
      skills: {
        search: (query, limit) => this.store.searchSkills(query, limit, { states: ["active", "pinned", "project"] }),
        listUsage: () => this.store.listSkillUsage(),
        readBody: async (skillId) => {
          const markdown = await this.store.readSkillMarkdown(skillId);
          return markdown === undefined ? undefined : parseSkillMarkdown(markdown).content.trim();
        },
        listSupportFiles: (skillId) => this.store.listSkillSupportFiles(skillId),
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
