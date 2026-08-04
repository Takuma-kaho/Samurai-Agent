import type {
  ActivityInboxItem, BackendEventRecord, BackendRunRecord, CuratorLifecycleReport, CuratorReviewReport, EvaluationTraceReport, JsonValue,
  LearningEvaluationRecord, MemoryFrontmatter, MessageEnvelope, MessageRecord, OperationRecord, ReflectionRunRecord,
  ReflectionSuggestionRecord, ResourceRef, RollbackPoint, SessionRecord, SkillFrontmatter, ToolRunRecord, WikiFrontmatter, WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import type { ReflectionArtifactSnapshot, ReflectionWorkflowInput } from "@samurai-agent/domain-operations";

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
type ReflectionSuggestion = ReflectionSuggestionRecord;
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
export interface SystemSandboxExecRequest {
  command: string;
  args: string[];
  cwd?: string;
  environment: Record<string, string>;
  stdin?: string;
  secretEnvironment: Record<string, string>;
  secretFiles: Array<{ secretRefId: string; filename: string; environmentName?: string; mode?: number }>;
  timeoutMs?: number;
  toolCallId?: string;
}
export interface SystemMcpCallRequest {
  serverName: string;
  toolName: string;
  input: Record<string, JsonValue>;
  toolCallId?: string;
}
export interface SystemOperationPort {
  getSession(id: string): Promise<SessionRecord | undefined>;
  getBackendRun(id: string): Promise<BackendRunRecord | undefined>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  listBackendRuns(sessionId?: string): Promise<BackendRunRecord[]>;
  listToolRuns(runId?: string): Promise<ToolRunRecord[]>;
  listWorkspaceChanges(sessionId?: string): Promise<WorkspaceChangeRecord[]>;
  listBackendEvents(input: { runId?: string; sessionId?: string }): Promise<BackendEventRecord[]>;
  loadArtifacts(input: { sessionId: string; sourceRunId?: string; workspaceChanges: WorkspaceChangeRecord[] }): Promise<ReflectionArtifactSnapshot[]>;
  executeReflection(input: ReflectionWorkflowInput): Promise<ReflectionExecutionResult>;
  getReflectionSuggestion(sessionId: string, suggestionId: string): Promise<ReflectionSuggestionRecord | undefined>;
  updateReflectionSuggestion(suggestion: ReflectionSuggestionRecord): Promise<ReflectionSuggestionRecord>;
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
    executeSandbox(context: TrustedDomainContext, request: SystemSandboxExecRequest): Promise<unknown>;
    callMcp(context: TrustedDomainContext, request: SystemMcpCallRequest): Promise<unknown>;
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
  getReflectionBackendRun(id: string) { return this.dependencies.operations.getBackendRun(id); }
  reflectionSourceRunNotFoundError(id: string) { return this.dependencies.rollback.requestError("not_found", `Backend run not found: ${id}`); }
  reflectionSourceRunSessionMismatchError(input: { sourceRunId: string; sessionId: string }) {
    return this.dependencies.rollback.requestError("conflict", `reflection_source_run_session_mismatch:${input.sourceRunId}:${input.sessionId}`);
  }
  listReflectionMessages(id: string) { return this.dependencies.operations.listMessages(id); }
  listReflectionToolRuns(runId?: string) { return this.dependencies.operations.listToolRuns(runId); }
  listReflectionWorkspaceChanges(sessionId?: string) { return this.dependencies.operations.listWorkspaceChanges(sessionId); }
  listReflectionBackendEvents(input: { runId?: string; sessionId?: string }) { return this.dependencies.operations.listBackendEvents(input); }
  loadReflectionArtifacts(input: { sessionId: string; sourceRunId?: string; workspaceChanges: WorkspaceChangeRecord[] }) { return this.dependencies.operations.loadArtifacts(input); }
  executeReflectionWorkflow(input: ReflectionWorkflowInput) { return this.dependencies.operations.executeReflection(input); }
  getReflectionSuggestion(sessionId: string, suggestionId: string) { return this.dependencies.operations.getReflectionSuggestion(sessionId, suggestionId); }
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

  async runScheduledReflection(session: SessionRecord): Promise<ReflectionExecutionResult> {
    // Scheduled work is still Room work.  It may inspect only the supplied
    // Session, never select an unrelated completed Run from another Room.
    const backendRuns = await this.dependencies.operations.listBackendRuns(session.id);
    const sourceRun = backendRuns.find((run) => run.status === "completed" && Boolean(run.agent_id));
    const sourceSession = session;
    const recentRuns = sourceRun
      ? backendRuns.filter((run) => run.session_id === sourceSession.id).slice(0, 8)
      : [];
    const [messages, workspaceChanges, toolRuns] = await Promise.all([
      this.dependencies.operations.listMessages(sourceSession.id),
      this.dependencies.operations.listWorkspaceChanges(sourceSession.id),
      Promise.all(recentRuns.map((run) => this.dependencies.operations.listToolRuns(run.id))).then((runs) => runs.flat())
    ]);
    const backendEvents = (await Promise.all(recentRuns.map((run) => this.dependencies.operations.listBackendEvents({ runId: run.id })))).flat().slice(0, 80);
    const userMessage = [...messages].reverse().find((message) => message.role === "user");
    const agentMessage = [...messages].reverse().find((message) => message.role === "agent");
    return this.dependencies.operations.executeReflection({
      kind: "scheduled", session: sourceSession, sourceRunId: sourceRun?.id, backendRun: sourceRun, userMessage, agentMessage,
      backendEvents, workspaceChanges: workspaceChanges.slice(0, 50), toolRuns: toolRuns.slice(0, 50), transcriptMessages: messages.slice(-30),
      artifacts: await this.dependencies.operations.loadArtifacts({
        sessionId: sourceSession.id,
        sourceRunId: sourceRun?.id, workspaceChanges
      })
    });
  }

  executeSandbox(context: TrustedDomainContext, request: SystemSandboxExecRequest): Promise<unknown> {
    return this.dependencies.tools.executeSandbox(context, request);
  }

  callMcp(context: TrustedDomainContext, request: SystemMcpCallRequest): Promise<unknown> {
    return this.dependencies.tools.callMcp(context, request);
  }
}
