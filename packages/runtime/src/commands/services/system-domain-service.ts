import type {
  ActivityInboxItem, CuratorLifecycleReport, CuratorReviewReport, EvaluationTraceReport, JsonValue,
  LearningEvaluationRecord, MemoryFrontmatter, MessageEnvelope, OperationRecord, ReflectionRunRecord,
  ReflectionSuggestionRecord, ResourceRef, RollbackPoint, SessionRecord, SkillFrontmatter, WikiFrontmatter
} from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";

interface ReflectionExecutionResult {
  reflectionRun: ReflectionRunRecord;
  suggestions: ReflectionSuggestionRecord[];
  learningEvaluations?: LearningEvaluationRecord[];
  curatorReport?: CuratorLifecycleReport;
  curatorReviewReport?: CuratorReviewReport;
  evaluationReport?: EvaluationTraceReport;
}

interface RollbackPointRecord { id: string; reversible: boolean; expires_at: string; before_snapshot: Record<string, JsonValue> }
interface ResolvedPath { absolutePath: string; relativePath: string }
interface ReflectionSuggestion {
  id: string;
  status: string;
  suggestion_type: string;
  title: string;
  content: string;
  source_refs: ResourceRef[];
  target_ref?: ResourceRef;
  updated_at: string;
}
export type ReflectionTarget = MemoryFrontmatter | (WikiFrontmatter & { file_path: string }) | {
  id: string; title: string; description: string; tags: string[]; state: SkillFrontmatter["state"];
  allowed_scopes: SkillFrontmatter["allowed_scopes"]; required_capabilities: string[]; owner_pinned: boolean;
  frontmatter: SkillFrontmatter; file_path: string;
};
interface CreatedReflectionTarget {
  resource: ReflectionTarget;
  ref: ResourceRef;
  rollbackPoint?: RollbackPoint;
}
interface ReflectionTargetWriteResult { resource: ReflectionTarget; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }
interface RollbackRestoreResource { rollback_point_id: string; path: string; action: "written" | "deleted" }
interface RollbackRestoreWriteResult { resource: RollbackRestoreResource; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }
interface ReflectionSession { id: string }
interface ReflectionMessage { role: string; session_id: string; created_at: string }
interface ReflectionBackendRun { id: string; session_id: string }

export interface SystemOperationPort {
  getSession(id: string): Promise<unknown | undefined>;
  listMessages(sessionId: string): Promise<ReflectionMessage[]>;
  listSessions(): Promise<ReflectionSession[]>;
  listBackendRuns(): Promise<ReflectionBackendRun[]>;
  listToolRuns(runId?: string): Promise<unknown[]>;
  listWorkspaceChanges(sessionId?: string): Promise<unknown[]>;
  listBackendEvents(input: { runId?: string; sessionId?: string }): Promise<unknown[]>;
  loadArtifacts(input: { sessionId: string; sourceRunId?: string; workspaceChanges: unknown[] }): Promise<unknown[]>;
  executeReflection(input: Record<string, unknown>): Promise<ReflectionExecutionResult>;
  listReflectionSuggestions(): Promise<ReflectionSuggestion[]>;
  updateReflectionSuggestion(suggestion: ReflectionSuggestion): Promise<unknown>;
  ensureReflectionSession(): Promise<SessionRecord>;
  createReflectionEnvelope(content: string): MessageEnvelope;
  runReflectionMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ReflectionTarget; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<ReflectionTargetWriteResult>;
  createMemoryTarget(input: { title: string; content: string; envelope: MessageEnvelope }): Promise<CreatedReflectionTarget>;
  createWikiTarget(input: { title: string; content: string; sourceRefs: ResourceRef[] }): Promise<CreatedReflectionTarget>;
  createSkillTarget(input: { title: string; content: string; sourceRefs: ResourceRef[] }): Promise<CreatedReflectionTarget>;
  createReflectionRollback(operation: OperationRecord, refs: ResourceRef[], after: Record<string, JsonValue>): Promise<RollbackPoint>;
  now(): string;
}

export interface SystemDomainServiceDependencies {
  operations: SystemOperationPort;
  rollback: {
    get(id: string): Promise<RollbackPointRecord | undefined>;
    resolve(path: string): ResolvedPath;
    read(path: string): Promise<string | undefined>;
    write(path: string, content: string): Promise<void>;
    remove(path: string): Promise<void>;
    ensureParent(path: string): Promise<void>;
    ensureSession(): Promise<SessionRecord>;
    createEnvelope(content: string): MessageEnvelope;
    runMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: RollbackRestoreResource; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<RollbackRestoreWriteResult>;
    createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
    fileRef(path: string): ResourceRef;
    requestError(code: "not_found" | "conflict" | "forbidden", message: string): Error;
  };
  requestError: (code: "conflict", message: string) => Error;
  tools: {
    executeSandbox(context: TrustedDomainContext, input: Record<string, JsonValue>): Promise<unknown>;
    callMcp(context: TrustedDomainContext, input: Record<string, JsonValue>): Promise<unknown>;
  };
}

export class SystemDomainService {
  constructor(private readonly dependencies: SystemDomainServiceDependencies) {}

  getRollbackPoint(id: string) { return this.dependencies.rollback.get(id); }
  rollbackError(code: "not_found" | "conflict" | "forbidden", message: string) { return this.dependencies.rollback.requestError(code, message); }
  resolveRollbackPath(path: string) { return this.dependencies.rollback.resolve(path); }
  ensureRollbackSession() { return this.dependencies.rollback.ensureSession(); }
  createRollbackEnvelope(content: string) { return this.dependencies.rollback.createEnvelope(content); }
  rollbackFileRef(path: string) { return this.dependencies.rollback.fileRef(path); }
  readRollbackFile(path: string) { return this.dependencies.rollback.read(path); }
  removeRollbackFile(path: string) { return this.dependencies.rollback.remove(path); }
  ensureRollbackParent(path: string) { return this.dependencies.rollback.ensureParent(path); }
  writeRollbackFile(path: string, content: string) { return this.dependencies.rollback.write(path, content); }
  createRestoreRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.dependencies.rollback.createRollback(operation, refs, before, after); }
  runRollbackMutation(input: Parameters<SystemDomainServiceDependencies["rollback"]["runMutation"]>[0]) { return this.dependencies.rollback.runMutation(input); }
  currentTimeMillis() { return Date.now(); }
  getReflectionSession(id: string) { return this.dependencies.operations.getSession(id); }
  reflectionSessionNotFoundError(id: string) { return this.dependencies.rollback.requestError("not_found", `Session not found: ${id}`); }
  listReflectionMessages(id: string) { return this.dependencies.operations.listMessages(id); }
  listReflectionToolRuns(runId?: string) { return this.dependencies.operations.listToolRuns(runId); }
  listReflectionWorkspaceChanges(sessionId?: string) { return this.dependencies.operations.listWorkspaceChanges(sessionId); }
  listReflectionBackendEvents(input: { runId?: string; sessionId?: string }) { return this.dependencies.operations.listBackendEvents(input); }
  loadReflectionArtifacts(input: { sessionId: string; sourceRunId?: string; workspaceChanges: unknown[] }) { return this.dependencies.operations.loadArtifacts(input); }
  executeReflectionWorkflow(input: Record<string, unknown>) { return this.dependencies.operations.executeReflection(input); }
  listReflectionSuggestions() { return this.dependencies.operations.listReflectionSuggestions(); }
  reflectionSuggestionError(code: "not_found" | "conflict", message: string) { return this.dependencies.rollback.requestError(code, message); }
  ensureReflectionMutationSession() { return this.dependencies.operations.ensureReflectionSession(); }
  createReflectionMutationEnvelope(content: string) { return this.dependencies.operations.createReflectionEnvelope(content); }
  runReflectionSuggestionMutation(input: Parameters<SystemOperationPort["runReflectionMutation"]>[0]) { return this.dependencies.operations.runReflectionMutation(input); }
  createReflectionMemoryTarget(input: Parameters<SystemOperationPort["createMemoryTarget"]>[0]) { return this.dependencies.operations.createMemoryTarget(input); }
  createReflectionWikiTarget(input: Parameters<SystemOperationPort["createWikiTarget"]>[0]) { return this.dependencies.operations.createWikiTarget(input); }
  createReflectionSkillTarget(input: Parameters<SystemOperationPort["createSkillTarget"]>[0]) { return this.dependencies.operations.createSkillTarget(input); }
  createReflectionTargetRollback(operation: OperationRecord, refs: ResourceRef[], after: Record<string, JsonValue>) { return this.dependencies.operations.createReflectionRollback(operation, refs, after); }
  updateReflectionSuggestion(suggestion: ReflectionSuggestion) { return this.dependencies.operations.updateReflectionSuggestion(suggestion); }
  reflectionNow() { return this.dependencies.operations.now(); }

  runReflection(payload: Record<string, JsonValue>) {
    return this.runReflectionInput({
      sessionId: requiredString(payload, "session_id"),
      sourceRunId: optionalString(payload.source_run_id) || undefined
    });
  }

  async runReflectionInput(input: { sessionId: string; sourceRunId?: string }): Promise<ReflectionExecutionResult> {
    const session = await this.dependencies.operations.getSession(input.sessionId);
    if (!session) throw this.dependencies.rollback.requestError("not_found", `Session not found: ${input.sessionId}`);
    const messages = await this.dependencies.operations.listMessages(input.sessionId);
    const userMessage = [...messages].reverse().find((message) => message.role === "user");
    const agentMessage = [...messages].reverse().find((message) => message.role === "agent");
    const [toolRuns, workspaceChanges, backendEvents] = await Promise.all([
      this.dependencies.operations.listToolRuns(input.sourceRunId),
      this.dependencies.operations.listWorkspaceChanges(input.sessionId),
      this.dependencies.operations.listBackendEvents(input.sourceRunId ? { runId: input.sourceRunId } : { sessionId: input.sessionId })
    ]);
    return this.dependencies.operations.executeReflection({
      kind: "manual", session, sourceRunId: input.sourceRunId, userMessage, agentMessage,
      backendEvents, workspaceChanges, toolRuns, transcriptMessages: messages,
      artifacts: await this.dependencies.operations.loadArtifacts({
        sessionId: input.sessionId, sourceRunId: input.sourceRunId, workspaceChanges
      })
    });
  }

  async runScheduledReflection(session: ReflectionSession): Promise<ReflectionExecutionResult> {
    const [sessions, backendRuns, workspaceChanges, toolRuns] = await Promise.all([
      this.dependencies.operations.listSessions(), this.dependencies.operations.listBackendRuns(),
      this.dependencies.operations.listWorkspaceChanges(), this.dependencies.operations.listToolRuns()
    ]);
    const messages = (await Promise.all(sessions.slice(0, 10).map((item) => this.dependencies.operations.listMessages(item.id))))
      .flat().sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)).slice(0, 30).reverse();
    const recentRuns = backendRuns.slice(0, 8);
    const backendEvents = (await Promise.all(recentRuns.map((run) => this.dependencies.operations.listBackendEvents({ runId: run.id })))).flat().slice(0, 80);
    const userMessage = [...messages].reverse().find((message) => message.role === "user");
    const agentMessage = [...messages].reverse().find((message) => message.role === "agent");
    const sourceRun = recentRuns[0];
    return this.dependencies.operations.executeReflection({
      kind: "scheduled", session, sourceRunId: sourceRun?.id, backendRun: sourceRun, userMessage, agentMessage,
      backendEvents, workspaceChanges: workspaceChanges.slice(0, 50), toolRuns: toolRuns.slice(0, 50), transcriptMessages: messages,
      artifacts: await this.dependencies.operations.loadArtifacts({
        sessionId: sourceRun?.session_id ?? userMessage?.session_id ?? session.id,
        sourceRunId: sourceRun?.id, workspaceChanges
      })
    });
  }

  applyReflection(payload: Record<string, JsonValue>) {
    return this.applyReflectionSuggestion({
      suggestionId: optionalString(payload.suggestion_id) || optionalString(payload.id)
    });
  }

  async applyReflectionSuggestion(input: { suggestionId: string }): Promise<ReflectionTargetWriteResult> {
    const suggestion = (await this.dependencies.operations.listReflectionSuggestions())
      .find((item) => item.id === input.suggestionId);
    if (!suggestion) throw this.dependencies.rollback.requestError("not_found", `Reflection suggestion not found: ${input.suggestionId}`);
    if (suggestion.status !== "proposed") throw this.dependencies.rollback.requestError("conflict", "reflection_suggestion_already_settled");
    const session = await this.dependencies.operations.ensureReflectionSession();
    const envelope = this.dependencies.operations.createReflectionEnvelope(`Apply reflection suggestion: ${suggestion.title}`);
    return this.dependencies.operations.runReflectionMutation({
      session, envelope, operationName: "reflection.suggestion.apply",
      proposedEffects: [`Apply ${suggestion.suggestion_type} reflection suggestion.`],
      targetResourceRefs: suggestion.source_refs,
      execute: async (operation) => {
        const now = this.dependencies.operations.now();
        if (suggestion.suggestion_type === "memory") {
          const target = await this.dependencies.operations.createMemoryTarget({ title: suggestion.title || "reflection", content: suggestion.content, envelope });
          const rollbackPoint = await this.dependencies.operations.createReflectionRollback(operation, [target.ref], { memory: target.resource as JsonValue });
          await this.dependencies.operations.updateReflectionSuggestion({ ...suggestion, status: "applied", updated_at: now });
          return { ...target, rollbackPoint, summary: `Applied reflection suggestion as Memory ${suggestion.title}.` };
        }
        if (suggestion.suggestion_type === "knowledge_wiki" || suggestion.suggestion_type === "skill") {
          const target = suggestion.suggestion_type === "knowledge_wiki"
            ? await this.dependencies.operations.createWikiTarget({ title: suggestion.title, content: suggestion.content, sourceRefs: suggestion.source_refs })
            : await this.dependencies.operations.createSkillTarget({ title: suggestion.title, content: suggestion.content, sourceRefs: suggestion.source_refs });
          await this.dependencies.operations.updateReflectionSuggestion({ ...suggestion, status: "applied", target_ref: target.ref, updated_at: now });
          return { ...target, summary: `Applied reflection suggestion as ${suggestion.suggestion_type === "skill" ? "Skill candidate" : "Knowledge Wiki proposal"} ${suggestion.title}.` };
        }
        throw this.dependencies.rollback.requestError("conflict", "reflection_suggestion_type_not_applyable");
      }
    });
  }

  restoreRollback(payload: Record<string, JsonValue>) {
    return this.restoreRollbackPoint(requiredString(payload, "rollback_point_id"));
  }

  async restoreRollbackPoint(id: string): Promise<RollbackRestoreWriteResult> {
    const point = await this.dependencies.rollback.get(id);
    if (!point) throw this.dependencies.rollback.requestError("not_found", `Rollback point not found: ${id}`);
    if (!point.reversible) throw this.dependencies.rollback.requestError("conflict", "rollback_not_reversible");
    if (Date.parse(point.expires_at) < Date.now()) throw this.dependencies.rollback.requestError("conflict", "rollback_expired");
    const snapshot = fileSnapshot(point.before_snapshot);
    if (!snapshot) throw this.dependencies.rollback.requestError("conflict", "rollback_restore_unsupported_snapshot");
    const workspacePath = this.dependencies.rollback.resolve(snapshot.path);
    if (workspacePath.relativePath === ".") throw this.dependencies.rollback.requestError("forbidden", "rollback_restore_requires_file_path");
    const session = await this.dependencies.rollback.ensureSession(); const envelope = this.dependencies.rollback.createEnvelope(`rollback.restore: ${point.id}`); const ref = this.dependencies.rollback.fileRef(workspacePath.relativePath);
    return this.dependencies.rollback.runMutation({ session, envelope, operationName: "rollback.restore", proposedEffects: [`Restore rollback point ${point.id} for ${workspacePath.relativePath}.`], targetResourceRefs: [ref], execute: async (operation) => {
      const current = await this.dependencies.rollback.read(workspacePath.absolutePath);
      if (snapshot.content === null) await this.dependencies.rollback.remove(workspacePath.absolutePath); else { await this.dependencies.rollback.ensureParent(workspacePath.absolutePath); await this.dependencies.rollback.write(workspacePath.absolutePath, snapshot.content); }
      const rollbackPoint = await this.dependencies.rollback.createRollback(operation, [ref], { path: workspacePath.relativePath, content: current ?? null }, { path: workspacePath.relativePath, content: snapshot.content });
      return { resource: { rollback_point_id: point.id, path: workspacePath.relativePath, action: snapshot.content === null ? "deleted" : "written" }, ref, rollbackPoint, summary: `Restored rollback point ${point.id} for ${workspacePath.relativePath}.` };
    }});
  }

  executeSandbox(context: TrustedDomainContext, input: Record<string, JsonValue>): Promise<unknown> {
    return this.dependencies.tools.executeSandbox(context, input);
  }

  callMcp(context: TrustedDomainContext, input: Record<string, JsonValue>): Promise<unknown> {
    return this.dependencies.tools.callMcp(context, input);
  }
}

function fileSnapshot(value: Record<string, JsonValue>): { path: string; content: string | null } | undefined {
  const path = typeof value.path === "string" ? value.path : undefined; const content = value.content;
  return path && (typeof content === "string" || content === null) ? { path, content } : undefined;
}

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}
