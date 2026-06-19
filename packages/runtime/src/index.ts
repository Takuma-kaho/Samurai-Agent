import { createArtifactDraft } from "@samurai-agent/artifacts";
import { buildActivityInboxItems, createAuditRecord } from "@samurai-agent/audit";
import { getCapabilityManifest, proposalCapabilityManifest } from "@samurai-agent/capability-registry";
import {
  type ActivityInboxItem,
  type ApprovalRequest,
  type ArtifactRecord,
  type AuditRecord,
  type MemoryFrontmatter,
  type MessageEnvelope,
  type MessageRecord,
  type OperationRecord,
  type PolicyDecisionRecord,
  type PolicyEvaluationInput,
  type RollbackPoint,
  type SessionRecord,
  type SupportedLocale,
  createId,
  nowIso,
  stableHash
} from "@samurai-agent/core-schemas";
import { isSupportedLocale } from "@samurai-agent/localization";
import { createSessionMemory, createTopicMemory, retrieveActiveMemory } from "@samurai-agent/memory";
import { evaluatePolicy } from "@samurai-agent/policy-engine";
import type { RuntimeEventSink } from "@samurai-agent/ui-protocol";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";

interface MockProviderInput {
  envelope: MessageEnvelope;
  activeMemoryCount: number;
}

interface MockProviderOutput {
  agentMessage: string;
  artifactTitle: string;
  artifactContent: string;
  operations: Array<{
    operation: string;
    proposedEffects: string[];
  }>;
}

export interface RunChatTurnInput {
  sessionId: string;
  content: string;
  input_locale?: SupportedLocale;
  output_locale?: SupportedLocale;
  metadata?: Record<string, unknown>;
}

export interface RunChatTurnResult {
  session: SessionRecord;
  messages: MessageRecord[];
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

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string,
    readonly payload?: ApprovalLifecycleResult
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

export class MockProviderAdapter {
  generate(input: MockProviderInput): MockProviderOutput {
    const intent = input.envelope.user_intent;
    const outputLocale = input.envelope.output_locale;
    const isJapanese = outputLocale === "ja";
    const needsOutboundApproval = /送信|メール|外部|公開|send|mail|publish|post/i.test(intent);
    const needsDeleteApproval = /削除|消して|delete|remove/i.test(intent);
    const wantsMemory = /覚えて|今後|好み|preference|remember|from now on/i.test(intent);

    const operations: MockProviderOutput["operations"] = [
      {
        operation: "artifact.create",
        proposedEffects: ["Create a local markdown draft artifact."]
      },
      {
        operation: "memory.session.create",
        proposedEffects: ["Keep the current user intent in session memory."]
      }
    ];

    if (wantsMemory) {
      operations.push({
        operation: "memory.topic.create",
        proposedEffects: ["Create a visible topic memory candidate."]
      });
    }

    if (needsOutboundApproval) {
      operations.push({
        operation: "external.send",
        proposedEffects: ["Prepare an outbound action. No external effect is executed in v1."]
      });
    }

    if (needsDeleteApproval) {
      operations.push({
        operation: "workspace.delete",
        proposedEffects: ["Prepare a delete operation. No deletion is executed in v1."]
      });
    }

    return {
      agentMessage: isJapanese
        ? `下書きを作りました。参照Memoryは${input.activeMemoryCount}件です。承認が必要な操作だけ保留します。`
        : `Draft created. ${input.activeMemoryCount} memory item(s) were considered. Only approval-gated work is held.`,
      artifactTitle: isJapanese ? "作業メモ" : "Workspace note",
      artifactContent: buildArtifactContent(intent, outputLocale, input.activeMemoryCount),
      operations
    };
  }
}

export class AgentRuntime {
  private readonly provider = new MockProviderAdapter();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly emit: RuntimeEventSink = () => undefined
  ) {}

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

    const activeMemory = await retrieveActiveMemory(this.store, input.content);
    const providerOutput = this.provider.generate({
      envelope,
      activeMemoryCount: activeMemory.length
    });

    const operations: OperationRecord[] = [];
    const policyDecisions: PolicyDecisionRecord[] = [];
    const artifacts: ArtifactRecord[] = [];
    const memories: MemoryFrontmatter[] = [];
    const approvalRequests: ApprovalRequest[] = [];
    const auditRecords: AuditRecord[] = [];
    const rollbackPoints: RollbackPoint[] = [];

    for (const operationPlan of providerOutput.operations) {
      const operation = await this.createOperation(session, envelope, operationPlan.operation, operationPlan.proposedEffects);
      operations.push(operation);

      const manifest = getCapabilityManifest(operation.capability_id);
      const policyInput = this.createPolicyInput(operation);
      const decision = await this.savePolicyDecision(evaluatePolicy({
        input: policyInput,
        manifest,
        grants: await this.store.listGrants(),
        operationId: operation.id
      }));
      policyDecisions.push(decision);

      operation.policy_decision_id = decision.id;

      if (decision.decision === "allow_auto" || decision.decision === "allow_with_audit") {
        const execution = await this.executeAllowedOperation(operation, decision, envelope, providerOutput);
        operation.status = "completed";
        operation.result_ref = execution.resultRef;
        operation.updated_at = nowIso();
        await this.store.updateOperation(operation);

        if (execution.artifact) {
          artifacts.push(execution.artifact);
          await this.emit("artifact.created", execution.artifact);
        }
        if (execution.memory) {
          memories.push(execution.memory);
          await this.emit("memory.candidate.created", execution.memory);
        }
        if (execution.rollbackPoint) {
          rollbackPoints.push(execution.rollbackPoint);
        }

        const audit = await this.auditOperation(operation, decision, execution.summary, execution.affectedResources, execution.rollbackPoint?.id);
        auditRecords.push(audit);
      } else if (decision.decision === "requires_approval" || decision.decision === "requires_strong_approval") {
        const request = await this.createApprovalRequest(operation, decision);
        approvalRequests.push(request);
        operation.status = "pending_approval";
        operation.approval_request_id = request.id;
        operation.updated_at = nowIso();
        await this.store.updateOperation(operation);
        await this.emit("approval.requested", request);
        const audit = await this.auditOperation(operation, decision, "Operation held for approval. No external effect executed.", [], undefined);
        auditRecords.push(audit);
      } else {
        operation.status = "denied";
        operation.updated_at = nowIso();
        await this.store.updateOperation(operation);
        const audit = await this.auditOperation(operation, decision, "Operation denied by policy.", [], undefined);
        auditRecords.push(audit);
      }
    }

    const agentMessage = await this.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: providerOutput.agentMessage,
      input_locale: envelope.input_locale,
      output_locale: envelope.output_locale,
      created_at: nowIso()
    });

    const activity = await this.rebuildActivity();
    return {
      session,
      messages: [userMessage, agentMessage],
      operations,
      policyDecisions,
      artifacts,
      memories,
      approvalRequests,
      auditRecords,
      rollbackPoints,
      activity
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

  private async saveMessage(message: MessageRecord): Promise<MessageRecord> {
    const saved = await this.store.saveMessage(message);
    await this.emit("message.created", saved);
    return saved;
  }

  private async createOperation(
    session: SessionRecord,
    envelope: MessageEnvelope,
    operationName: string,
    proposedEffects: string[]
  ): Promise<OperationRecord> {
    const now = nowIso();
    const operation: OperationRecord = {
      id: createId("operation"),
      session_id: session.id,
      capability_id: proposalCapabilityManifest.id,
      operation: operationName,
      actor_identity: envelope.actor_identity,
      instruction_source: "owner_instruction",
      instruction_authority: envelope.actor_identity,
      channel: envelope.source,
      input_hash: stableHash({
        envelope,
        operationName,
        proposedEffects
      }),
      input_ref: {
        kind: "message",
        id: envelope.id,
        uri: `messages/${envelope.id}`,
        label: "User message"
      },
      target_resource_refs: [],
      proposed_effects: proposedEffects,
      status: "created",
      created_at: now,
      updated_at: now
    };

    await this.store.saveOperation(operation);
    await this.emit("operation.created", operation);
    return operation;
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
    providerOutput: MockProviderOutput
  ): Promise<{
    resultRef?: OperationRecord["result_ref"];
    artifact?: ArtifactRecord;
    memory?: MemoryFrontmatter;
    rollbackPoint?: RollbackPoint;
    affectedResources: OperationRecord["target_resource_refs"];
    summary: string;
  }> {
    if (operation.operation === "artifact.create") {
      const artifact = await createArtifactDraft({
        store: this.store,
        operation,
        title: providerOutput.artifactTitle,
        content: providerOutput.artifactContent,
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
    metadata: metadata as MessageEnvelope["metadata"],
    received_at: nowIso()
  };
}

function buildArtifactContent(intent: string, outputLocale: SupportedLocale, activeMemoryCount: number): string {
  if (outputLocale === "ja") {
    return [
      "# 作業メモ",
      "",
      `依頼: ${intent}`,
      "",
      "## Draft",
      "",
      "この下書きはローカルWorkspaceに保存されました。",
      "外部送信、公開、削除はこの初期版では実行しません。",
      "",
      "## Context",
      "",
      `参照したActive Memory: ${activeMemoryCount}件`
    ].join("\n");
  }

  return [
    "# Workspace note",
    "",
    `Request: ${intent}`,
    "",
    "## Draft",
    "",
    "This draft was saved in the local workspace.",
    "Outbound send, publishing, and deletion are not executed in this initial build.",
    "",
    "## Context",
    "",
    `Active memory considered: ${activeMemoryCount}`
  ].join("\n");
}
