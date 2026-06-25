import { createArtifactDraft } from "@samurai-agent/artifacts";
import { buildActivityInboxItems, createAuditRecord } from "@samurai-agent/audit";
import { getCapabilityManifest, proposalCapabilityManifest } from "@samurai-agent/capability-registry";
import {
  AgentBackendRegistry,
  ClaudeCodeBackend,
  CodexBackend,
  type BackendOutputEvent,
  type BackendRunInput
} from "@samurai-agent/agent-backends";
import {
  type ActivityInboxItem,
  type ApprovalRequest,
  type ArtifactRecord,
  type AuditRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type CollectionPatch,
  type CollectionRecord,
  type CollectionSchema,
  type ActorIdentity,
  type InstructionSource,
  type JsonValue,
  type MemoryFrontmatter,
  type MessageEnvelope,
  type MessageRecord,
  type OperationRecord,
  type PolicyDecisionRecord,
  type PolicyEvaluationInput,
  type RollbackPoint,
  type SessionRecord,
  type WikiFrontmatter,
  type WorkspaceChangeRecord,
  SkillFrontmatterSchema,
  type SkillFrontmatter,
  type SupportedLocale,
  createId,
  nowIso,
  stableHash
} from "@samurai-agent/core-schemas";
import { isSupportedLocale } from "@samurai-agent/localization";
import { createSessionMemory, createTopicMemory, retrieveActiveMemory } from "@samurai-agent/memory";
import { evaluatePolicy } from "@samurai-agent/policy-engine";
import type { RuntimeEventSink } from "@samurai-agent/ui-protocol";
import type {
  ArchiveMemoryResult,
  AutomationRunRecord,
  CollectionRecordWithFilePath,
  CollectionSchemaWithFilePath,
  SkillWithFilePath,
  WikiWithFilePath,
  WorkspaceStore
} from "@samurai-agent/workspace-store";
import { handleBackendToolCall } from "./backend-feedback";
import { SamuraiNativeBackend } from "./native-backend";
export {
  FakeProviderAdapter,
  ProviderRegistry,
  ProviderRequestError,
  createProviderRegistryFromEnv,
  type ProviderAdapter,
  type ProviderDiagnostics,
  type ProviderInput,
  type ProviderOutput,
  type ProviderToolCall
} from "./provider";
import { ProviderRequestError, type ProviderAdapter, type ProviderDiagnostics, type ProviderInput, type ProviderOutput, type ProviderToolCall } from "./provider";

interface GatewayContext {
  source: "web" | "cron";
  actor_identity: ActorIdentity;
  instruction_source: InstructionSource;
  channel: "web" | "cron";
  session_key: string;
}

const webGatewayContext: GatewayContext = {
  source: "web",
  actor_identity: "owner",
  instruction_source: "owner_instruction",
  channel: "web",
  session_key: "web:owner:main"
};

const cronMemoryReviewGatewayContext: GatewayContext = {
  source: "cron",
  actor_identity: "owner_scheduled",
  instruction_source: "scheduled_context",
  channel: "cron",
  session_key: "cron:owner_scheduled:memory-review"
};

export interface RunChatTurnInput {
  sessionId: string;
  content: string;
  backend_id?: string;
  input_locale?: SupportedLocale;
  output_locale?: SupportedLocale;
  metadata?: Record<string, unknown>;
}

export interface RunChatTurnResult {
  session: SessionRecord;
  messages: MessageRecord[];
  backendRun: BackendRunRecord;
  backendEvents: BackendEventRecord[];
  workspaceChanges: WorkspaceChangeRecord[];
  operations: OperationRecord[];
  policyDecisions: PolicyDecisionRecord[];
  artifacts: ArtifactRecord[];
  memories: MemoryFrontmatter[];
  approvalRequests: ApprovalRequest[];
  auditRecords: AuditRecord[];
  rollbackPoints: RollbackPoint[];
  activity: ActivityInboxItem[];
}

export type ApprovalLifecycleStatus = "approved" | "denied" | "expired";

export interface ApprovalLifecycleResult {
  approvalRequest: ApprovalRequest;
  operation: OperationRecord;
  auditRecord: AuditRecord;
  activity: ActivityInboxItem[];
  status: ApprovalLifecycleStatus;
}

export interface ArchiveMemoryInput {
  memoryId: string;
  sessionId: string;
  actorIdentity?: OperationRecord["actor_identity"];
  decidedBy?: string;
}

export interface ArchiveMemoryRuntimeResult {
  memory: ArchiveMemoryResult["after"]["frontmatter"] & { file_path: string };
  content: string;
  operation: OperationRecord;
  auditRecord: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
  changed: boolean;
  warning?: string;
}

export interface RuntimeWriteResult<TResource> {
  resource: TResource;
  operation: OperationRecord;
  policyDecision: PolicyDecisionRecord;
  auditRecord: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

export type SkillRuntimeResult = RuntimeWriteResult<SkillWithFilePath>;
export type WikiRuntimeResult = RuntimeWriteResult<WikiWithFilePath>;
export type CollectionSchemaRuntimeResult = RuntimeWriteResult<CollectionSchemaWithFilePath>;
export type CollectionRecordRuntimeResult = RuntimeWriteResult<CollectionRecordWithFilePath>;

export interface CollectionPatchRuntimeResult extends RuntimeWriteResult<CollectionRecordWithFilePath> {
  before: CollectionRecordWithFilePath;
}

export interface AutomationRunRuntimeResult {
  automationRun: AutomationRunRecord;
  operation: OperationRecord;
  policyDecision: PolicyDecisionRecord;
  auditRecord: AuditRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

export interface BackendRunErrorPayload {
  session: SessionRecord;
  messages: MessageRecord[];
  backendRun: BackendRunRecord;
  backendEvents: BackendEventRecord[];
  workspaceChanges: WorkspaceChangeRecord[];
}

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "forbidden" | "provider_not_configured" | "provider_failed",
    message: string,
    readonly payload?: ApprovalLifecycleResult | ArchiveMemoryRuntimeResult | BackendRunErrorPayload,
    readonly diagnostics?: ProviderDiagnostics
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

interface OperationPlan {
  operation: string;
  proposedEffects: string[];
  toolCall?: ProviderToolCall;
  artifact?: {
    title: string;
    content: string;
    preview?: string;
  };
}

export function createDefaultAgentBackendRegistry(
  provider?: ProviderAdapter,
  env: NodeJS.ProcessEnv = process.env
): AgentBackendRegistry {
  return new AgentBackendRegistry([
    new SamuraiNativeBackend(provider),
    new ClaudeCodeBackend({
      command: env.SAMURAI_CLAUDE_CODE_COMMAND,
      args: splitArgs(env.SAMURAI_CLAUDE_CODE_ARGS),
      timeoutMs: parseTimeout(env.SAMURAI_CLAUDE_CODE_TIMEOUT_MS)
    }),
    new CodexBackend({
      command: env.SAMURAI_CODEX_COMMAND,
      args: splitArgs(env.SAMURAI_CODEX_ARGS),
      timeoutMs: parseTimeout(env.SAMURAI_CODEX_TIMEOUT_MS)
    })
  ]);
}

function defaultBackendId(env: NodeJS.ProcessEnv = process.env): string {
  return env.SAMURAI_BACKEND_DEFAULT?.trim() || "samurai-native";
}

function splitArgs(value: string | undefined): string[] {
  return value?.split(" ").map((item) => item.trim()).filter(Boolean) ?? [];
}

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export class AgentRuntime {
  private readonly backendRegistry: AgentBackendRegistry;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly emit: RuntimeEventSink = () => undefined,
    private readonly provider?: ProviderAdapter,
    backendRegistry?: AgentBackendRegistry
  ) {
    this.backendRegistry = backendRegistry ?? createDefaultAgentBackendRegistry(provider);
  }

  listAgentBackends() {
    return this.backendRegistry.statuses();
  }

  async createSession(input: {
    title?: string;
    ui_locale?: SupportedLocale;
    output_locale?: SupportedLocale;
  } = {}): Promise<SessionRecord> {
    const settings = await this.store.getSettings();
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: "web:owner:main",
      title: input.title ?? "New chat",
      ui_locale: input.ui_locale ?? settings.ui_locale,
      output_locale: input.output_locale ?? settings.output_locale,
      created_at: now,
      updated_at: now
    };

    await this.store.createSession(session);
    await this.emit("session.created", session);
    return session;
  }

  async runChatTurn(input: RunChatTurnInput): Promise<RunChatTurnResult> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const settings = await this.store.getSettings();
    const inputLocale = input.input_locale ?? session.ui_locale ?? settings.ui_locale;
    const outputLocale = input.output_locale ?? session.output_locale ?? settings.output_locale;
    const envelope = createEnvelope(input.content, inputLocale, outputLocale, input.metadata);
    const userMessage = await this.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "user",
      content: input.content,
      input_locale: envelope.input_locale,
      output_locale: envelope.output_locale,
      envelope,
      created_at: envelope.received_at
    });

    const backendId = input.backend_id?.trim() || defaultBackendId();
    const backend = this.backendRegistry.get(backendId);
    if (!backend) {
      throw new RuntimeRequestError("conflict", `backend_not_registered:${backendId}`);
    }
    let backendRun: BackendRunRecord = {
      id: createId("run"),
      session_id: session.id,
      input_message_id: userMessage.id,
      backend_id: backend.id,
      backend_kind: backend.kind,
      status: "running",
      started_at: nowIso(),
      input_summary: summarize(input.content),
      metadata: jsonRecord(input.metadata ?? {})
    };
    backendRun = await this.store.saveBackendRun(backendRun);
    await this.emit("backend.run.created", backendRun);

    const activeMemory = await retrieveActiveMemory(this.store, input.content);
    const recentMessages = (await this.store.listMessages(session.id)).slice(-10);
    const runInput: BackendRunInput = {
      run_id: backendRun.id,
      session_id: session.id,
      input_message_id: userMessage.id,
      user_input: input.content,
      input_locale: inputLocale,
      output_locale: outputLocale,
      active_memory: activeMemory.map((memory) => ({
        id: memory.frontmatter.id,
        topic: memory.frontmatter.topic,
        content: memory.content
      })),
      recent_messages: recentMessages,
      metadata: jsonRecord(input.metadata ?? {})
    };

    const operations: OperationRecord[] = [];
    const artifacts: ArtifactRecord[] = [];
    const memories: MemoryFrontmatter[] = [];
    const backendEvents: BackendEventRecord[] = [];
    const workspaceChanges: WorkspaceChangeRecord[] = [];
    const textParts: string[] = [];
    let nextSequence = 1;
    let failedEvent: BackendEventRecord | undefined;
    let waitingForBackendInput = false;

    const sessionMemory = await createSessionMemory(this.store, envelope, input.content);
    memories.push(sessionMemory);
    const sessionMemoryRef = memoryRef(sessionMemory);
    const sessionMemoryChange: WorkspaceChangeRecord = {
      id: createId("change"),
      run_id: backendRun.id,
      session_id: session.id,
      resource_ref: sessionMemoryRef,
      change_type: "memory_suggested",
      summary: `Captured session memory ${sessionMemory.topic}.`,
      created_at: nowIso()
    };
    await this.store.saveWorkspaceChange(sessionMemoryChange);
    workspaceChanges.push(sessionMemoryChange);
    await this.emit("workspace.change.created", sessionMemoryChange);
    await this.emit("memory.candidate.created", sessionMemory);

    const recordEvent = async (event: BackendOutputEvent): Promise<BackendEventRecord> => {
      const record: BackendEventRecord = {
        id: createId("event"),
        run_id: backendRun.id,
        session_id: session.id,
        event_type: event.event_type,
        sequence: nextSequence,
        payload: jsonRecord(event.payload),
        resource_refs: event.resource_refs ?? [],
        created_at: nowIso()
      };
      nextSequence += 1;
      await this.store.saveBackendEvent(record);
      backendEvents.push(record);
      await this.emit("backend.event.created", record);
      return record;
    };

    const saveFeedbackEvent = async (event: BackendOutputEvent) => {
      await recordEvent(event);
    };

    for await (const event of backend.runTurn(runInput)) {
      const record = await recordEvent(event);
      if (event.event_type === "text_delta") {
        const text = typeof event.payload.text === "string" ? event.payload.text : "";
        if (text) {
          textParts.push(text);
        }
      }
      if (event.event_type === "tool_call_started") {
        const feedback = await handleBackendToolCall({ store: this.store, run: backendRun, runInput, event });
        operations.push(...feedback.operations);
        artifacts.push(...feedback.artifacts);
        memories.push(...feedback.memories);
        for (const change of feedback.workspaceChanges) {
          await this.store.saveWorkspaceChange(change);
          workspaceChanges.push(change);
          await this.emit("workspace.change.created", change);
        }
        for (const feedbackEvent of feedback.events) {
          await saveFeedbackEvent(feedbackEvent);
        }
      }
      if (event.event_type === "backend_waiting_for_native_input") {
        waitingForBackendInput = true;
        backendRun = {
          ...backendRun,
          status: "waiting_for_backend_input"
        };
        await this.store.updateBackendRun(backendRun);
        await this.emit("backend.run.updated", backendRun);
        break;
      }
      if (event.event_type === "run_failed") {
        failedEvent = record;
      }
      if (event.event_type === "run_completed") {
        backendRun = {
          ...backendRun,
          status: "completed",
          output_summary: typeof event.payload.output_summary === "string" ? event.payload.output_summary : summarize(textParts.join(" ")),
          completed_at: nowIso()
        };
      }
    }

    if (failedEvent) {
      backendRun = {
        ...backendRun,
        status: "failed",
        error_code: typeof failedEvent.payload.error_code === "string" ? failedEvent.payload.error_code : "provider_failed",
        completed_at: nowIso()
      };
      await this.store.updateBackendRun(backendRun);
      await this.emit("backend.run.updated", backendRun);
      const payload = { session, messages: [userMessage], backendRun, backendEvents, workspaceChanges };
      const code = backendRun.error_code === "provider_not_configured" ? "provider_not_configured" : "provider_failed";
      throw new RuntimeRequestError(code, typeof failedEvent.payload.message === "string" ? failedEvent.payload.message : "Provider failed.", payload, {
        reason: isProviderDiagnosticReason(failedEvent.payload.reason) ? failedEvent.payload.reason : code === "provider_not_configured" ? "not_configured" : "unknown",
        retryable: failedEvent.payload.retryable === true,
        provider: typeof failedEvent.payload.provider === "string" ? failedEvent.payload.provider : undefined,
        model: typeof failedEvent.payload.model === "string" ? failedEvent.payload.model : undefined,
        status: typeof failedEvent.payload.status === "number" ? failedEvent.payload.status : undefined
      });
    }

    const agentContent = textParts.join("\n").trim();
    const agentMessage = await this.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: agentContent,
      input_locale: envelope.input_locale,
      output_locale: envelope.output_locale,
      created_at: nowIso()
    });

    backendRun = {
      ...backendRun,
      output_message_id: agentMessage.id,
      status: waitingForBackendInput ? "waiting_for_backend_input" : backendRun.status === "running" ? "completed" : backendRun.status,
      output_summary: backendRun.output_summary ?? summarize(agentContent),
      completed_at: waitingForBackendInput ? undefined : (backendRun.completed_at ?? nowIso())
    };
    await this.store.updateBackendRun(backendRun);
    await this.emit("backend.run.updated", backendRun);

    return {
      session,
      messages: [userMessage, agentMessage],
      backendRun,
      backendEvents,
      workspaceChanges,
      operations,
      policyDecisions: [],
      artifacts,
      memories,
      approvalRequests: [],
      auditRecords: [],
      rollbackPoints: [],
      activity: []
    };
  }

  async approveRequest(approvalRequestId: string, decidedBy = "owner"): Promise<ApprovalLifecycleResult> {
    const approval = await this.store.getApprovalRequest(approvalRequestId);
    if (!approval) {
      throw new RuntimeRequestError("not_found", `Approval request not found: ${approvalRequestId}`);
    }
    const operation = await this.store.getOperation(approval.operation_id);
    if (!operation) {
      throw new RuntimeRequestError("not_found", `Operation not found: ${approval.operation_id}`);
    }

    this.assertApprovalCanBeDecided(approval, operation);

    if (Date.parse(approval.expires_at) <= Date.now()) {
      const result = await this.expireApprovalRequest(approval, operation, decidedBy);
      throw new RuntimeRequestError("conflict", "Approval request expired.", result);
    }

    const savedDecision = await this.getSavedDecisionForApproval(operation);
    const manifest = getCapabilityManifest(operation.capability_id);
    const decision = await this.savePolicyDecision(evaluatePolicy({
      input: savedDecision.policy_inputs,
      manifest,
      grants: await this.store.listGrants(),
      operationId: operation.id
    }));

    const approved: ApprovalRequest = {
      ...approval,
      status: decision.decision === "deny" ? "cancelled" : "approved",
      decided_by: decidedBy,
      decided_at: nowIso()
    };
    await this.store.updateApprovalRequest(approved);

    operation.policy_decision_id = decision.id;
    operation.status = decision.decision === "deny" ? "denied" : "deferred";
    operation.result_ref = {
      kind: "approval",
      id: approved.id,
      uri: `approval_requests/${approved.id}`,
      label: decision.decision === "deny" ? "Approval cancelled by policy" : "Approved without external execution"
    };
    operation.updated_at = nowIso();
    await this.store.updateOperation(operation);

    const audit = await this.auditOperation(
      operation,
      decision,
      decision.decision === "deny"
        ? "Approval was cancelled because policy re-evaluation denied the operation."
        : "Approval accepted. v1 deferred the external effect and recorded audit only.",
      [],
      undefined
    );
    return {
      approvalRequest: approved,
      operation,
      auditRecord: audit,
      activity: await this.rebuildActivity(),
      status: decision.decision === "deny" ? "denied" : "approved"
    };
  }

  async denyRequest(approvalRequestId: string, decidedBy = "owner", reason = "Denied by owner."): Promise<ApprovalLifecycleResult> {
    const approval = await this.store.getApprovalRequest(approvalRequestId);
    if (!approval) {
      throw new RuntimeRequestError("not_found", `Approval request not found: ${approvalRequestId}`);
    }
    const operation = await this.store.getOperation(approval.operation_id);
    if (!operation) {
      throw new RuntimeRequestError("not_found", `Operation not found: ${approval.operation_id}`);
    }

    this.assertApprovalCanBeDecided(approval, operation);

    if (Date.parse(approval.expires_at) <= Date.now()) {
      const result = await this.expireApprovalRequest(approval, operation, decidedBy);
      throw new RuntimeRequestError("conflict", "Approval request expired.", result);
    }

    const savedDecision = await this.getSavedDecisionForApproval(operation);
    const denied: ApprovalRequest = {
      ...approval,
      status: "denied",
      reason: reason.trim() || approval.reason,
      decided_by: decidedBy,
      decided_at: nowIso()
    };
    await this.store.updateApprovalRequest(denied);

    operation.status = "denied";
    operation.result_ref = {
      kind: "approval",
      id: denied.id,
      uri: `approval_requests/${denied.id}`,
      label: "Denied by owner"
    };
    operation.updated_at = nowIso();
    await this.store.updateOperation(operation);

    const audit = await this.auditOperation(operation, savedDecision, "Approval was denied. No external effect executed.", [], undefined);
    return {
      approvalRequest: denied,
      operation,
      auditRecord: audit,
      activity: await this.rebuildActivity(),
      status: "denied"
    };
  }

  async archiveMemory(input: ArchiveMemoryInput): Promise<ArchiveMemoryRuntimeResult> {
    const session = await this.store.getSession(input.sessionId);
    if (!session) {
      throw new RuntimeRequestError("not_found", `Session not found: ${input.sessionId}`);
    }

    const memory = await this.store.getMemory(input.memoryId);
    if (!memory) {
      throw new RuntimeRequestError("not_found", `Memory not found: ${input.memoryId}`);
    }

    const sessionMemory = await this.store.listMemoryForSession(session.id, { includeArchived: true });
    if (!sessionMemory.some((item) => item.id === input.memoryId)) {
      throw new RuntimeRequestError("conflict", "memory_not_in_session");
    }

    const operation = await this.createMemoryArchiveOperation(session, memory, input.actorIdentity ?? "owner", input.decidedBy ?? "owner");
    const manifest = getCapabilityManifest(operation.capability_id);
    const decision = await this.savePolicyDecision(evaluatePolicy({
      input: this.createPolicyInput(operation),
      manifest,
      grants: await this.store.listGrants(),
      operationId: operation.id
    }));
    operation.policy_decision_id = decision.id;

    if (decision.decision === "deny") {
      operation.status = "denied";
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      const audit = await this.auditOperation(operation, decision, "Memory archive denied by policy.", [memoryRef(memory)], undefined);
      const activity = await this.rebuildActivity();
      throw new RuntimeRequestError("forbidden", "policy_denied", {
        memory,
        content: (await this.store.readMemoryContent(input.memoryId)) ?? "",
        operation,
        auditRecord: audit,
        activity,
        changed: false
      });
    }

    if (decision.decision !== "allow_auto" && decision.decision !== "allow_with_audit") {
      operation.status = "denied";
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      const audit = await this.auditOperation(operation, decision, "Memory archive requires approval and was not executed in this endpoint.", [memoryRef(memory)], undefined);
      const activity = await this.rebuildActivity();
      throw new RuntimeRequestError("forbidden", "policy_denied", {
        memory,
        content: (await this.store.readMemoryContent(input.memoryId)) ?? "",
        operation,
        auditRecord: audit,
        activity,
        changed: false
      });
    }

    const archive = await this.store.archiveMemory(input.memoryId);
    if (!archive) {
      throw new RuntimeRequestError("not_found", `Memory not found: ${input.memoryId}`);
    }

    const archivedMemory = {
      ...archive.after.frontmatter,
      file_path: archive.after.file_path
    };
    const ref = memoryRef(archivedMemory);
    let rollbackPoint: RollbackPoint | undefined;
    if (archive.changed) {
      rollbackPoint = await this.createRollbackPoint(
        operation,
        [ref],
        { memory: archive.before as unknown as JsonValue },
        { memory: archive.after as unknown as JsonValue }
      );
    }

    operation.status = "completed";
    operation.result_ref = ref;
    operation.updated_at = nowIso();
    await this.store.updateOperation(operation);

    const summary = archive.changed
      ? `Archived memory ${archive.after.frontmatter.topic}.${archive.warning ? ` Warning: ${archive.warning}` : ""}`
      : `Memory ${archive.after.frontmatter.topic} was already archived.`;
    const audit = await this.auditOperation(operation, decision, summary, [ref], rollbackPoint?.id);
    const activity = await this.rebuildActivity();

    return {
      memory: archivedMemory,
      content: archive.content,
      operation,
      auditRecord: audit,
      rollbackPoint,
      activity,
      changed: archive.changed,
      warning: archive.warning
    };
  }

  async createSkillCandidate(input: {
    title: string;
    description: string;
    content: string;
    tags?: string[];
    required_capabilities?: string[];
  }): Promise<SkillRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Create skill candidate: ${input.title}`);
    const skillId = createId("skill");
    const now = nowIso();
    const markdown = renderSkillMarkdown(
      {
        id: skillId,
        state: "candidate",
        title: input.title,
        description: input.description,
        tags: input.tags ?? [],
        provenance: "generated_local",
        trust_level: "generated_local",
        allowed_scopes: ["skill"],
        required_capabilities: input.required_capabilities ?? [],
        schedule_policy: {},
        secret_policy: {},
        owner_pinned: false,
        last_reviewed_at: now
      },
      input.content
    );

    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "skill.candidate.create",
      proposedEffects: ["Create a local skill candidate markdown file."],
      execute: async (operation) => {
        const skill = await this.store.saveSkillMarkdown({ state: "candidate", skillId, markdown });
        const ref = skillRef(skill);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { skill_id: skill.id });
        return { resource: skill, ref, rollbackPoint, summary: `Created skill candidate ${skill.title}.` };
      }
    });
  }

  async saveSkillProject(input: { candidateId: string }): Promise<SkillRuntimeResult> {
    const candidateMarkdown = await this.store.readSkillMarkdown(input.candidateId);
    if (!candidateMarkdown) {
      throw new RuntimeRequestError("not_found", `Skill candidate not found: ${input.candidateId}`);
    }
    const parsedCandidate = parseSkillMarkdown(candidateMarkdown);
    if (parsedCandidate.frontmatter.state !== "candidate") {
      throw new RuntimeRequestError("conflict", "skill_is_not_candidate");
    }

    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Save project skill from candidate: ${input.candidateId}`);
    const skillId = createId("skill");
    const markdown = renderSkillMarkdown(
      {
        ...parsedCandidate.frontmatter,
        id: skillId,
        state: "project",
        provenance: `candidate:${input.candidateId}`,
        last_reviewed_at: nowIso()
      },
      parsedCandidate.content
    );

    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "skill.project.save",
      proposedEffects: ["Create a project skill markdown file from an existing candidate."],
      execute: async (operation) => {
        const skill = await this.store.saveSkillMarkdown({ state: "project", skillId, markdown });
        const ref = skillRef(skill);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { skill_id: skill.id, candidate_id: input.candidateId });
        return { resource: skill, ref, rollbackPoint, summary: `Saved project skill ${skill.title}.` };
      }
    });
  }

  async createWikiProposal(input: {
    title: string;
    content: string;
    slug?: string;
    tags?: string[];
    content_locale?: SupportedLocale;
    source_refs?: WikiFrontmatter["source_refs"];
    provenance?: WikiFrontmatter["provenance"];
  }): Promise<WikiRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Create wiki proposal: ${input.title}`);
    const now = nowIso();
    const wiki: WikiFrontmatter = {
      id: createId("wiki"),
      slug: slugify(input.slug ?? input.title),
      title: input.title,
      state: "proposed",
      content_locale: input.content_locale ?? session.output_locale,
      tags: input.tags ?? [],
      source_refs: input.source_refs ?? [],
      provenance: input.provenance ?? {
        kind: "user_authored",
        summary: "Created from an explicit local request.",
        verified: true
      },
      created_at: now,
      updated_at: now
    };

    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "wiki.proposal.create",
      proposedEffects: ["Create a proposed wiki markdown page."],
      execute: async (operation) => {
        const saved = await this.store.saveWikiPage(wiki, input.content);
        const ref = wikiRef(saved);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { wiki_id: saved.id });
        return { resource: saved, ref, rollbackPoint, summary: `Created wiki proposal ${saved.title}.` };
      }
    });
  }

  async acceptWikiPage(id: string): Promise<WikiRuntimeResult> {
    return this.updateWikiState(id, "active", "wiki.accept", "Accept a wiki proposal for active retrieval.", "Accepted wiki page");
  }

  async rejectWikiPage(id: string): Promise<WikiRuntimeResult> {
    return this.updateWikiState(id, "rejected", "wiki.reject", "Reject a wiki proposal without deleting its markdown.", "Rejected wiki page");
  }

  async archiveWikiPage(id: string): Promise<WikiRuntimeResult> {
    return this.updateWikiState(id, "archived", "wiki.archive", "Archive a wiki page without deleting its markdown.", "Archived wiki page");
  }

  async patchWikiPage(input: {
    id: string;
    title?: string;
    content?: string;
    tags?: string[];
    content_locale?: SupportedLocale;
    source_refs?: WikiFrontmatter["source_refs"];
    provenance?: WikiFrontmatter["provenance"];
  }): Promise<WikiRuntimeResult> {
    const current = await this.store.getWiki(input.id);
    if (!current) {
      throw new RuntimeRequestError("not_found", `Wiki page not found: ${input.id}`);
    }
    const beforeContent = await this.store.readWikiContent(input.id);
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Patch wiki page: ${current.title}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "wiki.patch",
      proposedEffects: ["Edit wiki page frontmatter or markdown content."],
      execute: async (operation) => {
        const saved = await this.store.updateWikiPage(input);
        if (!saved) {
          throw new RuntimeRequestError("not_found", `Wiki page not found: ${input.id}`);
        }
        const ref = wikiRef(saved);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { wiki: current as unknown as JsonValue, content: beforeContent ?? "" },
          { wiki: saved as unknown as JsonValue, content: input.content ?? beforeContent ?? "" }
        );
        return { resource: saved, ref, rollbackPoint, summary: `Updated wiki page ${saved.title}.` };
      }
    });
  }

  async reindexWiki(): Promise<RuntimeWriteResult<{ active: number; total: number }>> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, "Reindex wiki pages");
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "wiki.reindex",
      proposedEffects: ["Refresh the SQLite wiki index from markdown files."],
      execute: async () => {
        const result = await this.store.reindexWiki();
        const ref = {
          kind: "wiki_index",
          id: "active",
          uri: "wiki/pages",
          label: "Wiki index"
        };
        return { resource: result, ref, summary: `Reindexed ${result.active} active wiki pages.` };
      }
    });
  }

  async saveCollectionSchema(schema: CollectionSchema): Promise<CollectionSchemaRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Save collection schema: ${schema.id}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "collection.schema.save",
      proposedEffects: ["Create a collection schema file and SQLite index row."],
      execute: async (operation) => {
        const saved = await this.store.saveCollectionSchema(schema);
        const ref = collectionSchemaRef(saved);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { collection_id: saved.id, version: saved.version });
        return { resource: saved, ref, rollbackPoint, summary: `Saved collection schema ${saved.id}.` };
      }
    });
  }

  async createCollectionRecord(record: CollectionRecord): Promise<CollectionRecordRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Create collection record: ${record.collection_id}/${record.id}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "collection.record.create",
      proposedEffects: ["Create a collection record file and SQLite index row."],
      execute: async (operation) => {
        const saved = await this.store.saveCollectionRecord(record);
        const ref = collectionRecordRef(saved);
        const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { collection_id: saved.collection_id, record_id: saved.id });
        return { resource: saved, ref, rollbackPoint, summary: `Created collection record ${saved.collection_id}/${saved.id}.` };
      }
    });
  }

  async applyCollectionPatch(input: { collectionId: string; recordId: string; patch: CollectionPatch }): Promise<CollectionPatchRuntimeResult> {
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `Apply collection patch: ${input.collectionId}/${input.recordId}`);
    const result = await this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName: "collection.patch.apply",
      proposedEffects: ["Apply a collection patch to an existing local record."],
      execute: async (operation) => {
        const patch = { ...input.patch, source_operation_id: operation.id };
        const patched = await this.store.applyCollectionRecordPatch({ ...input, patch });
        const ref = collectionRecordRef(patched.after);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { record: patched.before as unknown as JsonValue },
          { record: patched.after as unknown as JsonValue }
        );
        return {
          resource: patched.after,
          before: patched.before,
          ref,
          rollbackPoint,
          summary: `Applied collection patch ${patch.id}.`
        };
      }
    });
    return { ...result, before: (result as CollectionPatchRuntimeResult).before };
  }

  async runMemoryReviewAutomation(): Promise<AutomationRunRuntimeResult> {
    const startedAt = nowIso();
    let automationRun = await this.store.createAutomationRun({
      id: createId("automation_run"),
      kind: "memory_review",
      source: "cron",
      status: "started",
      started_at: startedAt
    });

    const session = await this.ensureSessionForContext(cronMemoryReviewGatewayContext, "Scheduled memory review");
    automationRun = await this.store.updateAutomationRun({ ...automationRun, session_id: session.id });

    const envelope = createCronMemoryReviewEnvelope();
    try {
      const result = await this.runAllowedWrite({
        session,
        envelope,
        context: cronMemoryReviewGatewayContext,
        operationName: "automation.memory_review.run",
        inputRef: {
          kind: "automation_run",
          id: automationRun.id,
          uri: `automation-runs/${automationRun.id}`,
          label: "Automation run"
        },
        proposedEffects: ["Run minimal scheduled memory review without external effects."],
        execute: async (operation) => {
          const ref = {
            kind: "automation_run",
            id: automationRun.id,
            uri: `automation-runs/${automationRun.id}`,
            label: "Memory review automation"
          };
          return {
            resource: automationRun,
            ref,
            summary: "Memory review automation recorded. No scheduler or LLM execution was performed."
          };
        }
      });
      automationRun = await this.store.updateAutomationRun({
        ...automationRun,
        status: "completed",
        operation_id: result.operation.id,
        completed_at: nowIso()
      });
      return { ...result, automationRun };
    } catch (error) {
      automationRun = await this.store.updateAutomationRun({
        ...automationRun,
        status: "failed",
        completed_at: nowIso(),
        error: error instanceof Error ? error.message : "Unknown error"
      });
      throw error;
    }
  }

  private async saveMessage(message: MessageRecord): Promise<MessageRecord> {
    const saved = await this.store.saveMessage(message);
    await this.emit("message.created", saved);
    return saved;
  }

  private async createOperation(
    session: SessionRecord,
    envelope: MessageEnvelope,
    operationName: string,
    proposedEffects: string[],
    options: {
      context?: GatewayContext;
      inputRef?: OperationRecord["input_ref"];
      targetResourceRefs?: OperationRecord["target_resource_refs"];
    } = {}
  ): Promise<OperationRecord> {
    const now = nowIso();
    const context = options.context ?? webGatewayContext;
    const operation: OperationRecord = {
      id: createId("operation"),
      session_id: session.id,
      capability_id: proposalCapabilityManifest.id,
      operation: operationName,
      actor_identity: context.actor_identity,
      instruction_source: context.instruction_source,
      instruction_authority: context.actor_identity,
      channel: context.channel,
      input_hash: stableHash({
        envelope,
        operationName,
        proposedEffects
      }),
      input_ref: options.inputRef ?? {
        kind: "message",
        id: envelope.id,
        uri: `messages/${envelope.id}`,
        label: context.source === "cron" ? "Scheduled context" : "User message"
      },
      target_resource_refs: options.targetResourceRefs ?? [],
      proposed_effects: proposedEffects,
      status: "created",
      created_at: now,
      updated_at: now
    };

    await this.store.saveOperation(operation);
    await this.emit("operation.created", operation);
    return operation;
  }

  private async ensureSessionForContext(context: GatewayContext, title: string): Promise<SessionRecord> {
    const existing = (await this.store.listSessions()).find((session) => session.session_key === context.session_key);
    if (existing) {
      return existing;
    }
    const settings = await this.store.getSettings();
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: context.session_key,
      title,
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now,
      updated_at: now
    };
    await this.store.createSession(session);
    await this.emit("session.created", session);
    return session;
  }

  private async runAllowedWrite<TResource, TExtra extends Record<string, unknown> = Record<string, never>>(input: {
    session: SessionRecord;
    envelope: MessageEnvelope;
    context: GatewayContext;
    operationName: string;
    proposedEffects: string[];
    inputRef?: OperationRecord["input_ref"];
    targetResourceRefs?: OperationRecord["target_resource_refs"];
    execute: (operation: OperationRecord) => Promise<{
      resource: TResource;
      ref: NonNullable<OperationRecord["result_ref"]>;
      rollbackPoint?: RollbackPoint;
      summary: string;
    } & TExtra>;
  }): Promise<RuntimeWriteResult<TResource> & TExtra> {
    const operation = await this.createOperation(input.session, input.envelope, input.operationName, input.proposedEffects, {
      context: input.context,
      inputRef: input.inputRef,
      targetResourceRefs: input.targetResourceRefs
    });
    const manifest = getCapabilityManifest(operation.capability_id);
    const decision = await this.savePolicyDecision(evaluatePolicy({
      input: this.createPolicyInput(operation),
      manifest,
      grants: await this.store.listGrants(),
      operationId: operation.id
    }));
    operation.policy_decision_id = decision.id;

    if (decision.decision !== "allow_auto" && decision.decision !== "allow_with_audit") {
      operation.status = decision.decision === "deny" ? "denied" : "pending_approval";
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      const audit = await this.auditOperation(operation, decision, "Write operation was not executed by policy.", [], undefined);
      throw new RuntimeRequestError(decision.decision === "deny" ? "forbidden" : "conflict", "policy_blocked", {
        approvalRequest: await this.createApprovalRequest(operation, decision),
        operation,
        auditRecord: audit,
        activity: await this.rebuildActivity(),
        status: decision.decision === "deny" ? "denied" : "approved"
      });
    }

    try {
      const execution = await input.execute(operation);
      operation.status = "completed";
      operation.result_ref = execution.ref;
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      const audit = await this.auditOperation(operation, decision, execution.summary, [execution.ref], execution.rollbackPoint?.id);
      const activity = await this.rebuildActivity();
      const { resource, ref: _ref, rollbackPoint, summary: _summary, ...extra } = execution;
      return {
        resource,
        operation,
        policyDecision: decision,
        auditRecord: audit,
        ...(rollbackPoint ? { rollbackPoint } : {}),
        activity,
        ...((extra as unknown) as TExtra)
      };
    } catch (error) {
      operation.status = "failed";
      operation.error = error instanceof Error ? error.message : "Unknown error";
      operation.updated_at = nowIso();
      await this.store.updateOperation(operation);
      await this.auditOperation(operation, decision, "Write operation failed before completion.", [], undefined);
      throw new RuntimeRequestError("conflict", operation.error);
    }
  }

  private async updateWikiState(
    id: string,
    state: WikiFrontmatter["state"],
    operationName: string,
    effect: string,
    summaryPrefix: string
  ): Promise<WikiRuntimeResult> {
    const current = await this.store.getWiki(id);
    if (!current) {
      throw new RuntimeRequestError("not_found", `Wiki page not found: ${id}`);
    }
    const session = await this.ensureSessionForContext(webGatewayContext, "Workspace operations");
    const envelope = createGatewayEnvelope(webGatewayContext, `${summaryPrefix}: ${current.title}`);
    return this.runAllowedWrite({
      session,
      envelope,
      context: webGatewayContext,
      operationName,
      proposedEffects: [effect],
      targetResourceRefs: [wikiRef(current)],
      execute: async (operation) => {
        const saved = await this.store.setWikiState(id, state);
        if (!saved) {
          throw new RuntimeRequestError("not_found", `Wiki page not found: ${id}`);
        }
        const ref = wikiRef(saved);
        const rollbackPoint = await this.createRollbackPoint(
          operation,
          [ref],
          { wiki: current as unknown as JsonValue },
          { wiki: saved as unknown as JsonValue }
        );
        return { resource: saved, ref, rollbackPoint, summary: `${summaryPrefix} ${saved.title}.` };
      }
    });
  }

  private createPolicyInput(operation: OperationRecord): PolicyEvaluationInput {
    return {
      capability_id: operation.capability_id,
      operation: operation.operation,
      actor_identity: operation.actor_identity,
      instruction_source: operation.instruction_source,
      instruction_authority: operation.instruction_authority,
      channel: operation.channel,
      target_resource_refs: operation.target_resource_refs,
      proposed_effects: operation.proposed_effects,
      prior_grants: [],
      recent_history: [],
      input_hash: operation.input_hash
    };
  }

  private async createMemoryArchiveOperation(
    session: SessionRecord,
    memory: MemoryFrontmatter & { file_path: string },
    actorIdentity: OperationRecord["actor_identity"],
    decidedBy: string
  ): Promise<OperationRecord> {
    const now = nowIso();
    const ref = memoryRef(memory);
    const operation: OperationRecord = {
      id: createId("operation"),
      session_id: session.id,
      capability_id: proposalCapabilityManifest.id,
      operation: "memory.archive",
      actor_identity: actorIdentity,
      instruction_source: "owner_instruction",
      instruction_authority: decidedBy,
      channel: "web",
      input_hash: stableHash({
        memory_id: memory.id,
        session_id: session.id,
        operationName: "memory.archive"
      }),
      input_ref: ref,
      target_resource_refs: [ref],
      proposed_effects: ["Archive a session-linked memory so it no longer appears in normal memory views."],
      status: "created",
      created_at: now,
      updated_at: now
    };
    await this.store.saveOperation(operation);
    await this.emit("operation.created", operation);
    return operation;
  }

  private async savePolicyDecision(decision: PolicyDecisionRecord): Promise<PolicyDecisionRecord> {
    const saved = await this.store.savePolicyDecision(decision);
    await this.emit("policy.decided", saved);
    return saved;
  }

  private assertApprovalCanBeDecided(approval: ApprovalRequest, operation: OperationRecord): void {
    if (
      approval.status !== "pending" ||
      operation.status !== "pending_approval" ||
      operation.approval_request_id !== approval.id ||
      approval.operation_id !== operation.id
    ) {
      throw new RuntimeRequestError("conflict", "Approval request is no longer pending for this operation.");
    }
  }

  private async getSavedDecisionForApproval(operation: OperationRecord): Promise<PolicyDecisionRecord> {
    if (!operation.policy_decision_id) {
      throw new RuntimeRequestError("conflict", "Operation has no saved policy decision.");
    }

    const decision = await this.store.getPolicyDecision(operation.policy_decision_id);
    if (!decision) {
      throw new RuntimeRequestError("conflict", "Saved policy decision was not found.");
    }

    return decision;
  }

  private async expireApprovalRequest(
    approval: ApprovalRequest,
    operation: OperationRecord,
    decidedBy: string
  ): Promise<ApprovalLifecycleResult> {
    const decision = await this.getSavedDecisionForApproval(operation);
    const expired: ApprovalRequest = {
      ...approval,
      status: "expired",
      decided_by: decidedBy,
      decided_at: nowIso()
    };
    await this.store.updateApprovalRequest(expired);

    operation.status = "deferred";
    operation.result_ref = {
      kind: "approval",
      id: expired.id,
      uri: `approval_requests/${expired.id}`,
      label: "Approval expired without execution"
    };
    operation.updated_at = nowIso();
    await this.store.updateOperation(operation);

    const audit = await this.auditOperation(operation, decision, "Approval expired. v1 deferred the operation without execution.", [], undefined);
    return {
      approvalRequest: expired,
      operation,
      auditRecord: audit,
      activity: await this.rebuildActivity(),
      status: "expired"
    };
  }

  private async executeAllowedOperation(
    operation: OperationRecord,
    decision: PolicyDecisionRecord,
    envelope: MessageEnvelope,
    operationPlan: OperationPlan
  ): Promise<{
    resultRef?: OperationRecord["result_ref"];
    artifact?: ArtifactRecord;
    memory?: MemoryFrontmatter;
    rollbackPoint?: RollbackPoint;
    affectedResources: OperationRecord["target_resource_refs"];
    summary: string;
  }> {
    if (operation.operation === "artifact.create") {
      if (!operationPlan.artifact) {
        throw new RuntimeRequestError("conflict", "artifact_missing");
      }
      const artifact = await createArtifactDraft({
        store: this.store,
        operation,
        title: operationPlan.artifact.title,
        content: operationPlan.artifact.content,
        locale: envelope.output_locale,
        sourceLocales: [envelope.input_locale],
        createdBy: "runtime"
      });
      const affectedResources = [artifact.file_ref];
      const rollbackPoint = await this.createRollbackPoint(operation, affectedResources, {}, { artifact_id: artifact.id });
      return {
        resultRef: artifact.file_ref,
        artifact,
        rollbackPoint,
        affectedResources,
        summary: `Created artifact ${artifact.title}.`
      };
    }

    if (operation.operation === "memory.session.create") {
      const memory = await createSessionMemory(this.store, envelope, envelope.user_intent);
      const ref = {
        kind: "memory",
        id: memory.id,
        uri: `memory/${memory.state}/${memory.id}.md`,
        label: memory.topic
      };
      const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { memory_id: memory.id });
      return {
        resultRef: ref,
        memory,
        rollbackPoint,
        affectedResources: [ref],
        summary: "Created session memory."
      };
    }

    if (operation.operation === "memory.topic.create") {
      const memory = await createTopicMemory(this.store, envelope, "preference", envelope.user_intent);
      const ref = {
        kind: "memory",
        id: memory.id,
        uri: `memory/${memory.state}/${memory.id}.md`,
        label: memory.topic
      };
      const rollbackPoint = await this.createRollbackPoint(operation, [ref], {}, { memory_id: memory.id });
      return {
        resultRef: ref,
        memory,
        rollbackPoint,
        affectedResources: [ref],
        summary: decision.decision === "allow_with_audit" ? "Created topic memory with visible audit." : "Created topic memory."
      };
    }

    return {
      affectedResources: [],
      summary: "No state change executed."
    };
  }

  private async createRollbackPoint(
    operation: OperationRecord,
    affectedResources: RollbackPoint["affected_resources"],
    beforeSnapshot: RollbackPoint["before_snapshot"],
    afterSnapshot: RollbackPoint["after_snapshot"]
  ): Promise<RollbackPoint> {
    const now = nowIso();
    const expiresAt = new Date(Date.parse(now) + 1000 * 60 * 60 * 24 * 7).toISOString();
    const point: RollbackPoint = {
      id: createId("rollback"),
      operation_id: operation.id,
      affected_resources: affectedResources,
      before_snapshot: beforeSnapshot,
      after_snapshot: afterSnapshot,
      reversible: true,
      irreversible_effects: [],
      created_at: now,
      expires_at: expiresAt
    };
    return this.store.saveRollbackPoint(point);
  }

  private async createApprovalRequest(operation: OperationRecord, decision: PolicyDecisionRecord): Promise<ApprovalRequest> {
    const now = nowIso();
    const expiresAt = new Date(Date.parse(now) + 1000 * 60 * 60 * 24).toISOString();
    const request: ApprovalRequest = {
      id: createId("approval"),
      operation_id: operation.id,
      requested_level: decision.required_approval_level === "strong_approval" ? "strong_approval" : "approval",
      status: "pending",
      reason: decision.reason,
      requested_by: "runtime",
      created_at: now,
      expires_at: expiresAt
    };
    return this.store.saveApprovalRequest(request);
  }

  private async auditOperation(
    operation: OperationRecord,
    decision: PolicyDecisionRecord,
    outputsSummary: string,
    affectedResources: AuditRecord["affected_resources"],
    rollbackPointId?: string
  ): Promise<AuditRecord> {
    const audit = createAuditRecord({
      actor_identity: operation.actor_identity,
      operation_id: operation.id,
      capability_id: operation.capability_id,
      instruction_source: operation.instruction_source,
      inputs_summary: operation.proposed_effects.join(" "),
      outputs_summary: outputsSummary,
      policy_decision_id: decision.id,
      affected_resources: affectedResources,
      rollback_point_id: rollbackPointId
    });
    await this.store.saveAuditRecord(audit);
    await this.emit("audit.recorded", audit);
    return audit;
  }

  private async generateProviderOutput(input: ProviderInput): Promise<ProviderOutput> {
    if (!this.provider) {
      throw new RuntimeRequestError("provider_not_configured", "No LLM provider is configured.");
    }

    try {
      return await this.provider.generate(input);
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        throw new RuntimeRequestError(error.code, error.message, undefined, {
          ...error.diagnostics,
          provider: error.diagnostics.provider ?? this.provider.id,
          model: error.diagnostics.model ?? this.provider.model
        });
      }
      throw new RuntimeRequestError("provider_failed", error instanceof Error ? error.message : "Provider failed.");
    }
  }

  private createOperationPlans(providerOutput: ProviderOutput): OperationPlan[] {
    const operations: OperationPlan[] = [
      {
        operation: "memory.session.create",
        proposedEffects: ["Keep the current user intent in session memory."]
      }
    ];

    for (const toolCall of providerOutput.toolCalls) {
      const plan = this.operationPlanFromToolCall(toolCall);
      if (!plan) {
        continue;
      }
      if (plan.operation === "artifact.create") {
        operations.unshift(plan);
      } else {
        operations.push(plan);
      }
    }

    return operations;
  }

  private operationPlanFromToolCall(toolCall: ProviderToolCall): OperationPlan | undefined {
    if (toolCall.name === "create_artifact") {
      const title = stringArg(toolCall.arguments.title).trim();
      const content = stringArg(toolCall.arguments.content).trim();
      if (!title || !content) {
        return undefined;
      }
      return {
        operation: "artifact.create",
        proposedEffects: ["Create a local markdown draft artifact."],
        toolCall,
        artifact: {
          title,
          content,
          ...(stringArg(toolCall.arguments.preview).trim() ? { preview: stringArg(toolCall.arguments.preview).trim() } : {})
        }
      };
    }

    if (toolCall.name === "remember_topic") {
      return {
        operation: "memory.topic.create",
        proposedEffects: ["Create a visible topic memory candidate."],
        toolCall
      };
    }

    if (toolCall.name === "request_external_send") {
      return {
        operation: "external.send",
        proposedEffects: ["Prepare an outbound action. No external effect is executed in v1."],
        toolCall
      };
    }

    if (toolCall.name === "request_delete") {
      return {
        operation: "workspace.delete",
        proposedEffects: ["Prepare a delete operation. No deletion is executed in v1."],
        toolCall
      };
    }

    return undefined;
  }

  private async rebuildActivity(): Promise<ActivityInboxItem[]> {
    const activity = buildActivityInboxItems(await this.store.readActivityInputs());
    await this.emit("activity.updated", activity);
    return activity;
  }
}

function createEnvelope(
  userIntent: string,
  inputLocale: SupportedLocale,
  outputLocale: SupportedLocale,
  metadata: Record<string, unknown> = {}
): MessageEnvelope {
  return {
    id: createId("envelope"),
    source: "web",
    actor_identity: "owner",
    session_key: "web:owner:main",
    user_intent: userIntent,
    attachments: [],
    input_locale: isSupportedLocale(inputLocale) ? inputLocale : "ja",
    output_locale: isSupportedLocale(outputLocale) ? outputLocale : "ja",
    metadata: jsonRecord(metadata),
    received_at: nowIso()
  };
}

function summarize(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}

function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
}

function jsonSafe(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return null;
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isProviderDiagnosticReason(value: unknown): value is ProviderDiagnostics["reason"] {
  return (
    value === "not_configured" ||
    value === "auth_failed" ||
    value === "rate_limited" ||
    value === "temporary_unavailable" ||
    value === "model_not_found" ||
    value === "invalid_model" ||
    value === "invalid_response" ||
    value === "network" ||
    value === "unknown"
  );
}

function createGatewayEnvelope(
  context: GatewayContext,
  userIntent: string,
  inputLocale: SupportedLocale = "ja",
  outputLocale: SupportedLocale = "ja",
  metadata: Record<string, unknown> = {}
): MessageEnvelope {
  return {
    id: createId("envelope"),
    source: context.source,
    actor_identity: context.actor_identity,
    session_key: context.session_key,
    user_intent: userIntent,
    attachments: [],
    input_locale: inputLocale,
    output_locale: outputLocale,
    metadata: jsonRecord(metadata),
    received_at: nowIso()
  };
}

function createCronMemoryReviewEnvelope(): MessageEnvelope {
  return createGatewayEnvelope(cronMemoryReviewGatewayContext, "Run scheduled memory review.");
}

function renderSkillMarkdown(frontmatter: SkillFrontmatter, content: string): string {
  const parsed = SkillFrontmatterSchema.parse(frontmatter);
  return ["---", JSON.stringify(parsed, null, 2), "---", content.trim(), ""].join("\n");
}

function parseSkillMarkdown(markdown: string): { frontmatter: SkillFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("skill_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("skill_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  return {
    frontmatter: SkillFrontmatterSchema.parse(JSON.parse(rawFrontmatter)),
    content: contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim()
  };
}

function memoryRef(memory: MemoryFrontmatter & { file_path?: string }) {
  return {
    kind: "memory",
    id: memory.id,
    uri: memory.file_path ?? `memory/${memory.state}/${memory.id}.md`,
    label: memory.topic
  };
}

function skillRef(skill: SkillWithFilePath) {
  return {
    kind: "skill",
    id: skill.id,
    uri: skill.file_path,
    label: skill.title
  };
}

function wikiRef(wiki: WikiWithFilePath) {
  return {
    kind: "wiki",
    id: wiki.id,
    uri: wiki.file_path,
    label: wiki.title
  };
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || createId("wiki_slug");
}

function collectionSchemaRef(schema: CollectionSchemaWithFilePath) {
  return {
    kind: "collection_schema",
    id: schema.id,
    uri: schema.file_path,
    version: schema.version,
    label: schema.id
  };
}

function collectionRecordRef(record: CollectionRecordWithFilePath) {
  return {
    kind: "collection_record",
    id: record.id,
    uri: record.file_path,
    label: `${record.collection_id}/${record.id}`
  };
}
