import type {
  ApprovalRequest,
  ArtifactRecord,
  AuditRecord,
  BackendEventRecord,
  BackendRunRecord,
  ChangeHistoryEntry,
  DomainCommandExecutionRecord,
  LearningResourceUseRecord,
  MessagePresentationRecord,
  MessageRecord,
  ObjectiveRecord,
  OperationRecord,
  PolicyDecisionRecord,
  ReflectionRunRecord,
  ResourceRef,
  RollbackPoint,
  RunHistoryEntry,
  SessionRecord,
  ToolRunRecord,
  WorkItemRecord,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import { SessionSearchIndex, type SessionSearchEntry, type SessionSearchIndexMode } from "../kernel/session-search-index";
import type { SearchResult, SessionTranscriptExport, WorkspaceHealthReport } from "../workspace-store-contracts";

export interface SessionQueryPort {
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  listSessions(): Promise<SessionRecord[]>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  listMessagePresentations(input: { sessionId: string; messageId?: string }): Promise<MessagePresentationRecord[]>;
  listOperations(sessionId?: string): Promise<OperationRecord[]>;
  getOperation(operationId: string): Promise<OperationRecord | undefined>;
  listBackendRuns(sessionId?: string): Promise<BackendRunRecord[]>;
  listBackendEvents(input?: { runId?: string; sessionId?: string; afterSequence?: number; limit?: number }): Promise<BackendEventRecord[]>;
  listToolRuns(input?: { runId?: string; sessionId?: string }): Promise<ToolRunRecord[]>;
  listWorkspaceChanges(sessionId?: string): Promise<WorkspaceChangeRecord[]>;
  listChangeHistoryEntries(sessionId?: string): Promise<ChangeHistoryEntry[]>;
  listRunHistoryEntries(sessionId?: string): Promise<RunHistoryEntry[]>;
}

export interface ArtifactQueryPort {
  listArtifacts(): Promise<ArtifactRecord[]>;
  listArtifactsForSession(sessionId: string): Promise<ArtifactRecord[]>;
  readArtifactContent(id: string): Promise<string | undefined>;
}

export interface MemoryQueryPort {
  listMemory(input?: { includeArchived?: boolean }): Promise<Array<{ id: string }>>;
}

export interface WikiQueryPort {
  listWiki(input?: { activeOnly?: boolean }): Promise<Array<{ id: string }>>;
}

export interface SkillQueryPort {
  listSkills(): Promise<Array<{ id: string }>>;
}

export interface CollectionQueryPort {
  listCollectionRecords(collectionId?: string): Promise<Array<{
    id: string;
    collection_id: string;
    file_path: string;
    resource_refs: ResourceRef[];
  }>>;
}

export interface AccessHistoryQueryPort {
  listPolicyDecisions(): Promise<PolicyDecisionRecord[]>;
  listAuditRecords(): Promise<AuditRecord[]>;
  listApprovalRequests(): Promise<ApprovalRequest[]>;
  listRollbackPoints(): Promise<RollbackPoint[]>;
}

export interface DurableWorkQueryPort {
  listObjectives(status?: ObjectiveRecord["status"]): Promise<ObjectiveRecord[]>;
  listWorkItems(input?: { objectiveId?: string; status?: WorkItemRecord["status"] }): Promise<WorkItemRecord[]>;
  listDomainCommandExecutions(): Promise<DomainCommandExecutionRecord[]>;
}

export interface LearningQueryPort {
  listLearningResourceUses(input?: { runId?: string; sessionId?: string; resourceId?: string }): Promise<LearningResourceUseRecord[]>;
  listReflectionRuns(sessionId?: string): Promise<ReflectionRunRecord[]>;
}

/**
 * Read-only projections that intentionally compose narrow repository ports.
 * No repository uses this service for writes.
 */
export class WorkspaceQueryService {
  constructor(
    private readonly sessionSearch: SessionSearchIndex,
    private readonly sessions: SessionQueryPort,
    private readonly artifacts: ArtifactQueryPort,
    private readonly memory: MemoryQueryPort,
    private readonly wiki: WikiQueryPort,
    private readonly skills: SkillQueryPort,
    private readonly collections: CollectionQueryPort,
    private readonly accessHistory: AccessHistoryQueryPort,
    private readonly durableWork: DurableWorkQueryPort,
    private readonly learning: LearningQueryPort
  ) {}

  async initializeSessionSearch(): Promise<void> {
    await this.sessionSearch.initialize(() => this.collectSessionSearchEntries());
  }

  async reindexSessionSearch(): Promise<{ mode: SessionSearchIndexMode; indexed: number }> {
    return this.sessionSearch.reindex(await this.collectSessionSearchEntries());
  }

  getSessionSearchMode(): SessionSearchIndexMode {
    return this.sessionSearch.getMode();
  }

  async inspectSessionSearchIndex(): Promise<WorkspaceHealthReport["indexes"]["search"]> {
    const sourceRecords = (await this.collectSessionSearchEntries()).length;
    const mode = this.sessionSearch.getMode();
    if (mode === "like") {
      return { ok: true, mode, indexed: 0, source_records: sourceRecords, stale: false };
    }
    const indexed = await this.sessionSearch.countEntries();
    if (indexed === undefined) {
      return { ok: false, mode: this.sessionSearch.getMode(), indexed: 0, source_records: sourceRecords, stale: true };
    }
    return {
      ok: indexed === sourceRecords,
      mode: this.sessionSearch.getMode(),
      indexed,
      source_records: sourceRecords,
      stale: indexed !== sourceRecords
    };
  }

  /** Finds references that cross resource boundaries and no longer resolve. */
  async findBrokenCollectionResourceRefs(): Promise<Array<{
    collection_id: string;
    record_id: string;
    file_path: string;
    ref: ResourceRef;
  }>> {
    const [records, artifacts, memory, skills, wiki] = await Promise.all([
      this.collections.listCollectionRecords(),
      this.artifacts.listArtifacts(),
      this.memory.listMemory({ includeArchived: true }),
      this.skills.listSkills(),
      this.wiki.listWiki()
    ]);
    const ids = {
      artifact: new Set(artifacts.map((artifact) => artifact.id)),
      memory: new Set(memory.map((entry) => entry.id)),
      skill: new Set(skills.map((skill) => skill.id)),
      wiki: new Set(wiki.map((page) => page.id)),
      collection_record: new Set(records.map((record) => record.id))
    };
    const broken: Array<{ collection_id: string; record_id: string; file_path: string; ref: ResourceRef }> = [];
    for (const record of records) {
      for (const ref of record.resource_refs) {
        if (ref.kind in ids && !(ids[ref.kind as keyof typeof ids] as Set<string>).has(ref.id)) {
          broken.push({ collection_id: record.collection_id, record_id: record.id, file_path: record.file_path, ref });
        }
      }
    }
    return broken;
  }

  async exportSessionTranscript(sessionId: string): Promise<SessionTranscriptExport | undefined> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) return undefined;
    const [messages, messagePresentations, operations, artifacts, backendRuns, backendEvents, toolRuns, workspaceChanges, changeHistory, runHistory, policyDecisions, auditRecords] = await Promise.all([
      this.sessions.listMessages(sessionId),
      this.sessions.listMessagePresentations({ sessionId }),
      this.sessions.listOperations(sessionId),
      this.artifacts.listArtifactsForSession(sessionId),
      this.sessions.listBackendRuns(sessionId),
      this.sessions.listBackendEvents({ sessionId }),
      this.sessions.listToolRuns({ sessionId }),
      this.sessions.listWorkspaceChanges(sessionId),
      this.sessions.listChangeHistoryEntries(sessionId),
      this.sessions.listRunHistoryEntries(sessionId),
      this.accessHistory.listPolicyDecisions(),
      this.accessHistory.listAuditRecords()
    ]);
    const operationIds = new Set(operations.map((operation) => operation.id));
    return {
      session,
      messages,
      message_presentations: messagePresentations,
      operations,
      policy_decisions: policyDecisions.filter((decision) => operationIds.has(decision.operation_id)),
      audit_records: auditRecords.filter((record) => operationIds.has(record.operation_id)),
      artifacts,
      backend_runs: backendRuns,
      backend_events: backendEvents,
      tool_runs: toolRuns,
      workspace_changes: workspaceChanges,
      change_history: changeHistory,
      run_history: runHistory
    };
  }

  async search(query: string): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (this.sessionSearch.getMode() !== "like") {
      const indexed = await this.sessionSearch.search(trimmed);
      if (this.sessionSearch.getMode() !== "like") {
        return [...indexed, ...(await this.matchAuditRecords(trimmed))];
      }
    }

    const [sessions, artifacts, auditRecords] = await Promise.all([
      this.sessions.listSessions(),
      this.artifacts.listArtifacts(),
      this.accessHistory.listAuditRecords()
    ]);
    const messages = (await Promise.all(sessions.map((session) => this.sessions.listMessages(session.id)))).flat();
    const artifactResults: SearchResult[] = [];
    for (const artifact of artifacts) {
      const content = (await this.artifacts.readArtifactContent(artifact.id).catch(() => "")) ?? "";
      if (!artifact.title.includes(trimmed) && !content.includes(trimmed)) continue;
      const operation = await this.sessions.getOperation(artifact.source_operation_id);
      artifactResults.push({
        kind: "artifact",
        id: artifact.id,
        title: artifact.title,
        summary: content.slice(0, 120),
        session_id: operation?.session_id,
        operation_id: artifact.source_operation_id
      });
      if (artifactResults.length >= 10) break;
    }
    return [
      ...sessions.filter((session) => session.title.includes(trimmed)).slice(0, 10).map((session) => ({
        kind: "session" as const,
        id: session.id,
        title: session.title,
        summary: session.session_key
      })),
      ...messages.filter((message) => message.content.includes(trimmed)).slice(0, 10).map((message) => ({
        kind: "message" as const,
        id: message.id,
        title: message.role,
        summary: message.content.slice(0, 120),
        session_id: message.session_id
      })),
      ...artifactResults,
      ...(await this.matchAuditRecords(trimmed, auditRecords))
    ];
  }

  async getCorrelationTrace(sessionId: string) {
    const [messages, operations, objectives, backendRuns, toolRuns, changes, learningUses, reflections, commands] = await Promise.all([
      this.sessions.listMessages(sessionId),
      this.sessions.listOperations(sessionId),
      this.durableWork.listObjectives(),
      this.sessions.listBackendRuns(sessionId),
      this.sessions.listToolRuns({ sessionId }),
      this.sessions.listWorkspaceChanges(sessionId),
      this.learning.listLearningResourceUses({ sessionId }),
      this.learning.listReflectionRuns(sessionId),
      this.durableWork.listDomainCommandExecutions()
    ]);
    const scopedObjectives = objectives.filter((objective) => objective.session_id === sessionId);
    const objectiveIds = new Set(scopedObjectives.map((objective) => objective.id));
    const workItems = (await this.durableWork.listWorkItems()).filter((workItem) => objectiveIds.has(workItem.objective_id));
    const runIds = new Set([
      ...backendRuns.map((run) => run.id),
      ...workItems.map((item) => item.backend_run_id).filter((id): id is string => Boolean(id))
    ]);
    const operationIds = new Set(operations.map((operation) => operation.id));
    const scopedCommands = commands.filter((command) => {
      const serialized = JSON.stringify(command.result ?? {});
      return serialized.includes(sessionId) || [...operationIds].some((id) => serialized.includes(id));
    });
    const edges: Array<{ from: string; to: string; relation: string }> = [];
    for (const message of messages) edges.push({ from: `session:${sessionId}`, to: `message:${message.id}`, relation: "contains" });
    for (const operation of operations) edges.push({ from: `session:${sessionId}`, to: `operation:${operation.id}`, relation: "requested" });
    for (const objective of scopedObjectives) edges.push({ from: `session:${sessionId}`, to: `objective:${objective.id}`, relation: "owns" });
    for (const workItem of workItems) {
      edges.push({ from: `objective:${workItem.objective_id}`, to: `work_item:${workItem.id}`, relation: "decomposes" });
      if (workItem.backend_run_id) edges.push({ from: `work_item:${workItem.id}`, to: `run:${workItem.backend_run_id}`, relation: "executes" });
    }
    for (const run of backendRuns) edges.push({ from: `session:${sessionId}`, to: `run:${run.id}`, relation: "runs" });
    for (const toolRun of toolRuns) edges.push({ from: `run:${toolRun.run_id}`, to: `tool:${toolRun.id}`, relation: "calls" });
    for (const change of changes) edges.push({ from: `run:${change.run_id}`, to: `change:${change.id}`, relation: "changes" });
    for (const use of learningUses) edges.push({ from: `run:${use.run_id}`, to: `learning_use:${use.id}`, relation: "learns_from" });
    for (const reflection of reflections) if (reflection.source_run_id) edges.push({ from: `run:${reflection.source_run_id}`, to: `reflection:${reflection.id}`, relation: "reviews" });
    for (const command of scopedCommands) {
      for (const operationId of operationIds) {
        if (JSON.stringify(command.result ?? {}).includes(operationId)) {
          edges.push({ from: `command:${command.id}`, to: `operation:${operationId}`, relation: "dispatches" });
        }
      }
    }
    return {
      session_id: sessionId,
      commands: scopedCommands,
      messages,
      operations,
      objectives: scopedObjectives,
      work_items: workItems,
      backend_runs: backendRuns.filter((run) => runIds.has(run.id)),
      tool_runs: toolRuns,
      workspace_changes: changes,
      learning_uses: learningUses,
      reflections,
      edges
    };
  }

  async readActivityInputs(): Promise<{
    approvals: ApprovalRequest[];
    operations: OperationRecord[];
    decisions: PolicyDecisionRecord[];
    audits: AuditRecord[];
    rollbacks: RollbackPoint[];
  }> {
    const [approvals, operations, decisions, audits, rollbacks] = await Promise.all([
      this.accessHistory.listApprovalRequests(),
      this.sessions.listOperations(),
      this.accessHistory.listPolicyDecisions(),
      this.accessHistory.listAuditRecords(),
      this.accessHistory.listRollbackPoints()
    ]);
    return { approvals, operations, decisions, audits, rollbacks };
  }

  private async collectSessionSearchEntries(): Promise<SessionSearchEntry[]> {
    const [sessions, artifacts] = await Promise.all([this.sessions.listSessions(), this.artifacts.listArtifacts()]);
    const messages = (await Promise.all(sessions.map((session) => this.sessions.listMessages(session.id)))).flat();
    const artifactEntries = await Promise.all(artifacts.map(async (artifact) => {
      const operation = await this.sessions.getOperation(artifact.source_operation_id);
      return {
        kind: "artifact" as const,
        id: artifact.id,
        sessionId: operation?.session_id,
        operationId: artifact.source_operation_id,
        title: artifact.title,
        body: (await this.artifacts.readArtifactContent(artifact.id).catch(() => "")) ?? ""
      };
    }));
    return [
      ...sessions.map((session) => ({ kind: "session" as const, id: session.id, title: session.title, body: session.session_key })),
      ...messages.map((message) => ({ kind: "message" as const, id: message.id, sessionId: message.session_id, title: message.role, body: message.content })),
      ...artifactEntries
    ];
  }

  private async matchAuditRecords(query: string, records?: AuditRecord[]): Promise<SearchResult[]> {
    const audits = records ?? await this.accessHistory.listAuditRecords();
    const operations = new Map((await this.sessions.listOperations()).map((operation) => [operation.id, operation]));
    return audits
      .filter((audit) => audit.inputs_summary.includes(query) || audit.outputs_summary.includes(query))
      .slice(0, 10)
      .map((audit) => ({
        kind: "audit",
        id: audit.id,
        title: audit.operation_id,
        summary: `${audit.inputs_summary} -> ${audit.outputs_summary}`.slice(0, 140),
        session_id: operations.get(audit.operation_id)?.session_id,
        operation_id: audit.operation_id
      }));
  }
}
