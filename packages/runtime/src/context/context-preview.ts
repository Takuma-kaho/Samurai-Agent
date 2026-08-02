import { nowIso, type BackendRunRecord, type ContextPreview, type FreezeSnapshot, type MessageRecord, type OperationRecord, type ResourceRef, type SessionRecord, type SettingsRecord, type SkillUsageRecord, type ToolRunRecord, type WorkspaceChangeRecord } from "@samurai-agent/core-schemas";
import { activeMemoryPreviewEntry, buildHostContextAssembly, hostContextAssemblyLimits, shouldIncludeSessionSearchInBackendContext } from "./context-assembly.js";
import { emptyExternalAssistContext } from "./external-assist-context.js";
import { selectCollectionNotes, type CollectionContextNote } from "./collection-context.js";
import { selectRuntimeSkills, describeSkillSelection, skillAllowedScopes, skillRef, type SkillContextEnvironment, type SkillContextSkill } from "./skill-context.js";
import { timeboxContextStep, timeboxContextValue } from "./timebox.js";
import type { KnowledgeWikiContext } from "./workspace-context-candidates.js";
import { memoryRef } from "./resource-refs.js";

export interface ContextPreviewSearchResult {
  kind: string;
  id: string;
  title: string;
  summary: string;
}

export interface ContextPreviewMemoryResult {
  candidates: Array<Parameters<typeof activeMemoryPreviewEntry>[0]>;
  report: ContextPreview["active_memory_report"];
}

export interface ContextPreviewSessionPort {
    getSession(sessionId: string): Promise<SessionRecord | undefined>;
    getSettings(): Promise<SettingsRecord>;
}

export interface ContextPreviewSummaryPort {
    listMessages(sessionId: string): Promise<MessageRecord[]>;
    listOperations(sessionId: string): Promise<OperationRecord[]>;
    listBackendRuns(sessionId: string): Promise<BackendRunRecord[]>;
    listToolRuns(sessionId: string): Promise<ToolRunRecord[]>;
    listWorkspaceChanges(sessionId: string): Promise<WorkspaceChangeRecord[]>;
}

export interface ContextPreviewMemoryPort {
  retrieve(query: string, activityContext?: { room_id: string; session_id: string; agent_id: string }): Promise<ContextPreviewMemoryResult>;
  loadFreezeSnapshot(input: { memoryRefs: ResourceRef[]; skillRefs: ResourceRef[]; wikiRefs: ResourceRef[] }): Promise<FreezeSnapshot | undefined>;
}

export interface ContextPreviewWikiPort {
  build(query: string, activityContext?: { room_id: string; session_id: string; agent_id: string }): Promise<KnowledgeWikiContext>;
}

export interface ContextPreviewSkillsPort {
  search(query: string, limit: number, activityContext?: { room_id: string; session_id: string; agent_id: string }): Promise<SkillContextSkill[]>;
  listUsage(): Promise<SkillUsageRecord[]>;
  listSupportFileRefs(skillId: string): Promise<Array<{ skill_id: string; path: string; file_path: string }>>;
  environment: SkillContextEnvironment;
}

export interface ContextPreviewCollectionsPort {
  listSchemas(): Promise<Array<{ id: string }>>;
  listNotes(collectionId: string): Promise<CollectionContextNote[]>;
}

export interface ContextPreviewSessionSearchPort {
    search(query: string): Promise<ContextPreviewSearchResult[]>;
}

export interface ContextPreviewExternalAssistPort {
  build(input: {
    sessionId: string;
    query: string;
    role: SettingsRecord["external_provider_role"];
    recentMessages: MessageRecord[];
    sessionSearch: ContextPreviewSearchResult[];
  }): Promise<ContextPreview["external_assist"]>;
}

export interface ContextPreviewToolCatalogPort {
  listAvailable(): string[];
}

export interface ContextPreviewProgressPort {
  report(displayKind: "reasoning_summary" | "activity", text: string, activityKind?: string): Promise<void>;
}

export interface ContextPreviewErrorPort {
  sessionNotFound(sessionId: string): Error;
}

export interface ContextPreviewClockPort {
  now(): string;
}

export interface ContextPreviewPorts {
  session: ContextPreviewSessionPort;
  summary: ContextPreviewSummaryPort;
  memory: ContextPreviewMemoryPort;
  wiki: ContextPreviewWikiPort;
  skills: ContextPreviewSkillsPort;
  collections: ContextPreviewCollectionsPort;
  sessionSearch: ContextPreviewSessionSearchPort;
  externalAssist: ContextPreviewExternalAssistPort;
  tools: ContextPreviewToolCatalogPort;
  progress?: ContextPreviewProgressPort;
  errors: ContextPreviewErrorPort;
  clock: ContextPreviewClockPort;
}

export interface BuildContextPreviewInput {
  sessionId: string;
  agentId?: string;
  query: string;
  ports: ContextPreviewPorts;
  skipHeavyContext?: boolean;
  onProgress?: (displayKind: "reasoning_summary" | "activity", text: string, activityKind?: string) => Promise<void>;
}

export function emptyActiveMemoryResult(query: string, now = nowIso()): ContextPreviewMemoryResult {
  return {
    candidates: [],
    report: {
      query,
      retrieved_at: now,
      candidate_count: 0,
      included_count: 0,
      included_memory_ids: [],
      excluded: [],
      sensitive_redactions: [],
      conflict_groups: [],
      resolution_suggestions: []
    }
  };
}

export async function buildContextPreview(input: BuildContextPreviewInput): Promise<ContextPreview> {
  const { ports, sessionId, query } = input;
  const skipHeavyContext = input.skipHeavyContext === true;
  const progress = input.onProgress ? { report: input.onProgress } : ports.progress;
  const emptyMemory = () => emptyActiveMemoryResult(query, ports.clock.now());
  const emptyWiki = (): KnowledgeWikiContext => ({ pages: [], entries: [], report: { query, retrieved_at: ports.clock.now(), candidate_count: 0, included_count: 0, included_wiki_ids: [], excluded: [], source_refs: [] } });
  const [session, settings] = await Promise.all([
    ports.session.getSession(sessionId),
    ports.session.getSettings()
  ]);
  if (!session) {
    throw ports.errors.sessionNotFound(sessionId);
  }
  const scopedAgentId = input.agentId ?? settings.default_agent_id;
  const activityContext = session.room_id && scopedAgentId
    ? { room_id: session.room_id, session_id: session.id, agent_id: scopedAgentId }
    : undefined;
  const knowledgeAvailable = !skipHeavyContext && Boolean(activityContext);
  const sessionSearchQuery = !skipHeavyContext && query.trim()
    ? timeboxContextStep(ports.sessionSearch.search(query), [], "session_search")
    : Promise.resolve(timeboxContextValue<ContextPreviewSearchResult[]>([], false));
  const [activeMemoryResult, knowledgeWikiContext, skillCandidates, skillUsage, collectionSchemas, messages, operations, backendRuns, toolRuns, workspaceChanges, searchResults] = await Promise.all([
    knowledgeAvailable ? timeboxContextStep(ports.memory.retrieve(query, activityContext), emptyMemory(), "active_memory").then((result) => result.value) : Promise.resolve(emptyMemory()),
    knowledgeAvailable ? timeboxContextStep(ports.wiki.build(query, activityContext), emptyWiki(), "knowledge_wiki").then((result) => result.value) : Promise.resolve(emptyWiki()),
    knowledgeAvailable ? timeboxContextStep(ports.skills.search(query, 12, activityContext), [], "selected_skills").then((result) => result.value) : Promise.resolve([]),
    knowledgeAvailable ? ports.skills.listUsage() : Promise.resolve([]),
    skipHeavyContext ? Promise.resolve([]) : ports.collections.listSchemas(),
    ports.summary.listMessages(sessionId),
    ports.summary.listOperations(sessionId),
    ports.summary.listBackendRuns(sessionId),
    ports.summary.listToolRuns(sessionId),
    ports.summary.listWorkspaceChanges(sessionId),
    sessionSearchQuery
  ]);
  const sessionSearchTimedOut = searchResults.timedOut;
  const sessionSearchValues = searchResults.value;
  if (sessionSearchTimedOut) {
    await progress?.report("reasoning_summary", "過去会話検索が遅いため、今回は軽い文脈のまま実行部へ進めます。");
  }
  await progress?.report("activity", "参照候補を整理", "context_handoff");
  const activeMemory = activeMemoryResult.candidates;
  const skillSelection = selectRuntimeSkills({ candidates: skillCandidates, query, limit: hostContextAssemblyLimits.selected_skills, environment: ports.skills.environment });
  const selectedSkills = skillSelection.selected.map((item) => item.skill);
  const freezeSnapshot = !knowledgeAvailable
    ? undefined
    : await ports.memory.loadFreezeSnapshot({
        memoryRefs: activeMemory.map((memory) => memoryRef(memory.frontmatter)),
        skillRefs: selectedSkills.map((skill) => skillRef(skill)),
        wikiRefs: knowledgeWikiContext.pages.map((wiki) => ({ kind: "wiki", id: wiki.id, uri: wiki.file_path, label: wiki.title }))
      });
  const skillUsageById = new Map(skillUsage.map((usage) => [usage.skill_id, usage]));
  const skillSelectionById = new Map(skillSelection.selected.map((item) => [item.skill.id, item.selection]));
  const selectedSkillEntries = await Promise.all(selectedSkills.map(async (skill, index) => {
    const supportFileRefs = await ports.skills.listSupportFileRefs(skill.id);
    const usage = skillUsageById.get(skill.id);
    const disclosureLevel = "catalog" as const;
    return {
      id: skill.id,
      title: skill.title,
      description: skill.description,
      tags: skill.tags,
      allowed_scopes: skillAllowedScopes(skill),
      required_capabilities: skill.required_capabilities,
      disclosure_level: disclosureLevel,
      selection_reason: describeSkillSelection(disclosureLevel, index, supportFileRefs, usage, skillSelectionById.get(skill.id)),
      selection: skillSelectionById.get(skill.id),
      usage: usage ? { use_count: usage.use_count, ...(usage.last_used_at ? { last_used_at: usage.last_used_at } : {}) } : undefined,
      content: undefined,
      support_file_refs: supportFileRefs.map((file) => ({ path: file.path, file_path: file.file_path })),
      support_files: undefined
    };
  }));
  const allCollectionNotes = (await Promise.all(collectionSchemas.map((schema) => ports.collections.listNotes(schema.id)))).flat();
  const collectionContextNotes = selectCollectionNotes(allCollectionNotes, query);
  const knowledgeWiki = knowledgeWikiContext.entries;
  const sessionSearchForBackend = shouldIncludeSessionSearchInBackendContext(query) ? sessionSearchValues.slice(0, hostContextAssemblyLimits.session_search) : [];
  const sessionSearch = sessionSearchForBackend.map((result) => ({ kind: result.kind, id: result.id, title: result.title, summary: result.summary }));
  const recentMessageRecords = messages.slice(-hostContextAssemblyLimits.recent_messages);
  const recentMessages = recentMessageRecords.map((message) => ({ id: message.id, role: message.role, content: message.content }));
  const availableTools = ports.tools.listAvailable();
  const externalAssist = skipHeavyContext
    ? emptyExternalAssistContext(settings.external_provider_role, "External assist was skipped for this lightweight chat turn.")
    : await ports.externalAssist.build({ sessionId, query, role: settings.external_provider_role, recentMessages: recentMessageRecords, sessionSearch });
  const lastMessage = messages.at(-1);
  const lastBackendRun = backendRuns[0];
  const contextAssembly = buildHostContextAssembly({
    sessionId,
    query,
    assembledAt: ports.clock.now(),
    sessionFound: true,
    messageCount: messages.length,
    recentMessageCount: recentMessages.length,
    freezeSnapshotPresent: Boolean(freezeSnapshot),
    activeMemoryCount: activeMemory.length,
    activeMemoryCandidateCount: activeMemoryResult.report.candidate_count,
    knowledgeWikiCandidateCount: knowledgeWikiContext.report.candidate_count,
    knowledgeWikiIncludedCount: knowledgeWiki.length,
    collectionNoteCandidateCount: allCollectionNotes.length,
    collectionNoteIncludedCount: collectionContextNotes.length,
    selectedSkillCount: selectedSkillEntries.length,
    sessionSearchCandidateCount: sessionSearchValues.length,
    sessionSearchIncludedCount: sessionSearch.length,
    externalAssistRole: settings.external_provider_role,
    externalAssistHintCount: externalAssist.hints.length,
    externalAssistFailureCount: externalAssist.recent_failures.length,
    availableToolCount: availableTools.length,
    skippedSourceKinds: !knowledgeAvailable
      ? new Set<"freeze_snapshot" | "active_memory" | "knowledge_wiki" | "selected_skills" | "collection_notes" | "session_search" | "external_assist">([
          "freeze_snapshot", "active_memory", "knowledge_wiki", "selected_skills", ...(skipHeavyContext ? ["collection_notes", "session_search", "external_assist"] as const : [])
        ])
      : sessionSearchTimedOut ? new Set<"session_search">(["session_search"]) : undefined
  });
  return {
    session_id: sessionId,
    query,
    context_assembly: contextAssembly,
    session_summary: {
      session_key: session.session_key,
      title: session.title,
      ui_locale: session.ui_locale,
      output_locale: session.output_locale,
      message_count: messages.length,
      operation_count: operations.length,
      backend_run_count: backendRuns.length,
      tool_run_count: toolRuns.length,
      workspace_change_count: workspaceChanges.length,
      ...(lastMessage ? { last_message_at: lastMessage.created_at } : {}),
      ...(lastBackendRun ? { last_backend_run_id: lastBackendRun.id } : {}),
      ...(lastBackendRun ? { last_backend_run_status: lastBackendRun.status } : {})
    },
    external_assist: externalAssist,
    freeze_snapshot: freezeSnapshot,
    active_memory: activeMemory.map((memory) => ({ ...activeMemoryPreviewEntry(memory) })),
    active_memory_report: activeMemoryResult.report,
    knowledge_wiki: knowledgeWiki,
    knowledge_wiki_report: knowledgeWikiContext.report,
    collection_notes: collectionContextNotes,
    skill_selection_report: skillSelection.report,
    selected_skills: selectedSkillEntries,
    session_search: sessionSearch,
    recent_messages: recentMessages,
    available_tools: availableTools
  };
}
