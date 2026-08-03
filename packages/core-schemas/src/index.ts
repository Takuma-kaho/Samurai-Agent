import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const supportedLocales = ["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"] as const;
export const translationStatuses = ["verified", "draft", "missing"] as const;

export const policyDecisions = [
  "allow_auto",
  "allow_with_audit",
  "requires_first_time_confirm",
  "requires_approval",
  "requires_strong_approval",
  "deny"
] as const;

export const riskLevels = ["low", "medium", "high", "irreversible", "sensitive"] as const;
export const executionScopes = [
  "workspace",
  "session",
  "collection",
  "memory",
  "skill",
  "artifact",
  "gateway_session",
  "external_channel",
  "secret",
  "payment",
  "public",
  "identity"
] as const;

export const instructionSources = [
  "owner_instruction",
  "owner_approved_policy",
  "agent_reasoning",
  "workspace_data",
  "external_content",
  "paired_identity_message",
  "tool_output",
  "scheduled_context",
  "system_policy"
] as const;

export const actorIdentities = [
  "owner",
  "owner_scheduled",
  "paired_contact",
  "external_unknown",
  "webhook_source",
  "system"
] as const;

export const operationStatuses = [
  "created",
  "completed",
  "pending_approval",
  "deferred",
  "denied",
  "failed"
] as const;

export const approvalStatuses = ["pending", "approved", "denied", "expired", "cancelled"] as const;
export const memoryStates = ["session", "provisional", "active", "sensitive", "archived", "topic"] as const;
export const skillStates = ["candidate", "project", "active", "stale", "archived", "pinned"] as const;
export const wikiStates = ["proposed", "active", "archived", "rejected"] as const;
export const captureModes = ["auto", "manual", "off"] as const;
export const externalProviderRoles = ["assistive", "disabled"] as const;
export const activityTypes = [
  "auto_run",
  "approval_required",
  "anomaly",
  "rollback_expiring",
  "boundary_change",
  "failure"
] as const;
export const activitySeverities = ["info", "notice", "warning", "critical"] as const;
export const agentBackendKinds = ["mock", "samurai_native", "claude_code", "codex", "external"] as const;
export const backendConnectionStates = ["ready", "unconfigured", "disabled", "degraded", "unverified"] as const;
export const backendExecutionOwners = ["host", "backend", "tool_bridge"] as const;
export const backendSessionAcquisitionModes = ["provider_event", "start_session", "none"] as const;
export const backendSessionResumeModes = ["native", "unsupported", "replay_forbidden"] as const;
export const backendRunStatuses = ["queued", "running", "waiting_for_backend_input", "completed", "failed", "cancelled", "outcome_unknown"] as const;
export const backendRunPhases = ["admitted", "preparing", "backend_starting", "external_running", "waiting", "cancelling", "finalizing", "post_turn", "settled"] as const;
export const BackendRunPhaseSchema = z.enum(backendRunPhases);
export type BackendRunPhase = z.infer<typeof BackendRunPhaseSchema>;
export const backendEventTypes = [
  "run_started",
  "agent_reasoning",
  "host_progress",
  "text_delta",
  "tool_call_started",
  "tool_call_output",
  "artifact_created",
  "workspace_change_suggested",
  "memory_suggested",
  "skill_candidate_created",
  "backend_waiting_for_native_input",
  "backend_native_input_submitted",
  "backend_stream_synced",
  "backend_stream_unavailable",
  "host_post_turn_failed",
  "host_cleanup_failed",
  "host_emit_failed",
  "backend_protocol_diagnostic",
  "run_completed",
  "run_failed"
] as const;
export const clientTargetKinds = ["desktop", "web", "any"] as const;
export const clientEventStatuses = ["pending", "delivered", "acked", "expired", "failed"] as const;
export const clientEventTypes = [
  "client.notification.requested",
  "client.workspace.open_requested",
  "client.session.open_requested",
  "client.artifact.open_requested",
  "client.run.open_requested",
  "client.status.refresh_requested"
] as const;
export const workspaceChangeTypes = ["artifact_created", "memory_suggested", "skill_candidate_created", "collection_changed", "settings_changed", "other"] as const;
export const reflectionRunKinds = ["chat_turn", "background_review", "manual", "scheduled", "curator", "evaluation"] as const;
export const reflectionRunStatuses = ["queued", "deferred", "started", "completed", "failed"] as const;
export const reflectionSuggestionTypes = ["memory", "knowledge_wiki", "skill", "memory_patch", "skill_patch", "conflict"] as const;
export const reflectionSuggestionStatuses = ["proposed", "applied", "rejected", "archived"] as const;
export const toolRunStatuses = ["completed", "ignored", "failed"] as const;
export const learningResourceKinds = ["memory", "wiki", "skill", "skill_support", "session_result"] as const;
export const learningResourceUseStages = ["selected", "body_loaded", "support_loaded", "applied"] as const;
export const learningAssessments = ["helpful", "neutral", "harmful", "insufficient_evidence"] as const;
/** Evidence and use are independent axes for Core 05 learning resources. */
export const learningEvidenceStates = ["direct_confirmed", "inferred", "supported", "conflict"] as const;
export const learningUsageStates = ["normal", "limited", "dormant"] as const;
export const learningKnowledgeKinds = ["reference", "experience_rule"] as const;
export const learningEvaluationVerdicts = ["supported", "refuted", "indeterminate"] as const;
export const learningBudgetUnits = ["currency", "tokens"] as const;
export const learningCandidateSignalKinds = [
  "explicit_memory_save",
  "explicit_experience_rule",
  "user_correction",
  "user_negation",
  "tool_failure_then_success",
  "objective_result",
  "resource_applied",
  "workspace_change",
  "repeated_procedure",
  "backend_learning_signal"
] as const;
export const skillOptimizationRunStatuses = ["queued", "running", "completed", "failed", "cancelled"] as const;
export const skillOptimizationCandidateStatuses = ["proposed", "passed", "rejected", "promoted", "rolled_back"] as const;
export const skillOptimizationDatasetSources = ["real", "golden", "synthetic"] as const;
export const skillOptimizationDatasetSplits = ["train", "validation", "holdout"] as const;
export const automationJobStatuses = ["enabled", "disabled", "archived"] as const;
export const externalSendStatuses = ["draft", "pending_approval", "approved", "dispatched", "denied", "failed"] as const;
export const externalSendChannels = ["webhook", "email", "slack", "telegram", "line"] as const;
export const externalSendTransportStatuses = ["ready", "dry_run_only", "not_configured"] as const;
export const gatewayPairingStatuses = ["pending", "approved", "rejected", "expired", "revoked"] as const;
export const gatewayPairingPolicyStatuses = ["enabled", "disabled"] as const;
export const gatewayPairingTrustModes = ["pairing_required", "auto_approve", "blocked"] as const;
export const gatewayRoutingPolicyStatuses = ["enabled", "disabled"] as const;
export const gatewayRoutingSessionKeyStrategies = ["account_thread", "account_main", "channel_main"] as const;
export const gatewayInboundStatuses = ["blocked", "routed", "processed", "failed"] as const;
export const gatewayChannels = ["telegram", "slack", "line", "email", "mobile", "webhook", "local_cli", "cron"] as const;
export const gatewayBoundarySources = ["web", "telegram", "slack", "line", "email", "mobile", "webhook", "local_cli", "cron"] as const;
export const secretRefSources = ["env", "file", "keychain", "external_vault"] as const;
export const sandboxModes = ["off", "non_main", "all"] as const;
export const sandboxScopes = ["agent", "session", "shared"] as const;
export const sandboxBackends = ["none", "docker", "ssh", "remote"] as const;
export const sandboxWorkspaceAccess = ["none", "read", "write", "read_write"] as const;
export const sandboxNetworkAccess = ["none", "localhost", "external"] as const;
export const concurrencyLockScopes = ["source_identity", "session", "workspace", "global"] as const;
export const gatewayConcurrencyLockStatuses = ["acquired", "released", "expired"] as const;
export const gatewaySandboxInstanceStatuses = ["ready", "recreated", "deleted", "failed"] as const;
export const gatewaySandboxWorkspaceSyncDirections = ["seed_to_sandbox", "pull_from_sandbox", "mirror"] as const;
export const gatewaySandboxWorkspaceSyncStatuses = ["planned", "completed", "failed", "skipped"] as const;
export const gatewayMcpTransports = ["stdio", "http"] as const;
export const gatewayMcpStdioFramings = ["json_lines", "content_length"] as const;

export const SupportedLocaleSchema = z.enum(supportedLocales);
export const TranslationStatusSchema = z.enum(translationStatuses);
export const PolicyDecisionSchema = z.enum(policyDecisions);
export const RiskLevelSchema = z.enum(riskLevels);
export const ExecutionScopeSchema = z.enum(executionScopes);
export const InstructionSourceSchema = z.enum(instructionSources);
export const ActorIdentitySchema = z.enum(actorIdentities);
export const OperationStatusSchema = z.enum(operationStatuses);
export const ApprovalStatusSchema = z.enum(approvalStatuses);
export const MemoryStateSchema = z.enum(memoryStates);
export const SkillStateSchema = z.enum(skillStates);
export const WikiStateSchema = z.enum(wikiStates);
export const CaptureModeSchema = z.enum(captureModes);
export const ExternalProviderRoleSchema = z.enum(externalProviderRoles);
export const ActivityTypeSchema = z.enum(activityTypes);
export const ActivitySeveritySchema = z.enum(activitySeverities);
export const AgentBackendKindSchema = z.enum(agentBackendKinds);
export const BackendConnectionStateSchema = z.enum(backendConnectionStates);
export const BackendExecutionOwnerSchema = z.enum(backendExecutionOwners);
export const BackendSessionAcquisitionModeSchema = z.enum(backendSessionAcquisitionModes);
export const BackendSessionResumeModeSchema = z.enum(backendSessionResumeModes);
export const BackendRunStatusSchema = z.enum(backendRunStatuses);
export const BackendEventTypeSchema = z.enum(backendEventTypes);
export const ClientTargetKindSchema = z.enum(clientTargetKinds);
export const ClientEventStatusSchema = z.enum(clientEventStatuses);
export const ClientEventTypeSchema = z.enum(clientEventTypes);
export const WorkspaceChangeTypeSchema = z.enum(workspaceChangeTypes);
export const ReflectionRunKindSchema = z.enum(reflectionRunKinds);
export const ReflectionRunStatusSchema = z.enum(reflectionRunStatuses);
export const ReflectionSuggestionTypeSchema = z.enum(reflectionSuggestionTypes);
export const ReflectionSuggestionStatusSchema = z.enum(reflectionSuggestionStatuses);
export const ToolRunStatusSchema = z.enum(toolRunStatuses);
export const LearningResourceKindSchema = z.enum(learningResourceKinds);
export const LearningResourceUseStageSchema = z.enum(learningResourceUseStages);
export const LearningAssessmentSchema = z.enum(learningAssessments);
export const LearningEvidenceStateSchema = z.enum(learningEvidenceStates);
export const LearningUsageStateSchema = z.enum(learningUsageStates);
export const LearningKnowledgeKindSchema = z.enum(learningKnowledgeKinds);
export const LearningEvaluationVerdictSchema = z.enum(learningEvaluationVerdicts);
export const LearningBudgetUnitSchema = z.enum(learningBudgetUnits);
export const LearningCandidateSignalKindSchema = z.enum(learningCandidateSignalKinds);
export const AutomationJobStatusSchema = z.enum(automationJobStatuses);
export const ExternalSendStatusSchema = z.enum(externalSendStatuses);
export const ExternalSendChannelSchema = z.enum(externalSendChannels);
export const ExternalSendTransportStatusSchema = z.enum(externalSendTransportStatuses);
export const GatewayPairingStatusSchema = z.enum(gatewayPairingStatuses);
export const GatewayPairingPolicyStatusSchema = z.enum(gatewayPairingPolicyStatuses);
export const GatewayPairingTrustModeSchema = z.enum(gatewayPairingTrustModes);
export const GatewayRoutingPolicyStatusSchema = z.enum(gatewayRoutingPolicyStatuses);
export const GatewayRoutingSessionKeyStrategySchema = z.enum(gatewayRoutingSessionKeyStrategies);
export const GatewayInboundStatusSchema = z.enum(gatewayInboundStatuses);
export const GatewayChannelSchema = z.enum(gatewayChannels);
export const GatewayBoundarySourceSchema = z.enum(gatewayBoundarySources);
export const SecretRefSourceSchema = z.enum(secretRefSources);
export const SandboxModeSchema = z.enum(sandboxModes);
export const SandboxScopeSchema = z.enum(sandboxScopes);
export const SandboxBackendSchema = z.enum(sandboxBackends);
export const SandboxWorkspaceAccessSchema = z.enum(sandboxWorkspaceAccess);
export const SandboxNetworkAccessSchema = z.enum(sandboxNetworkAccess);
export const ConcurrencyLockScopeSchema = z.enum(concurrencyLockScopes);
export const GatewayConcurrencyLockStatusSchema = z.enum(gatewayConcurrencyLockStatuses);
export const GatewaySandboxInstanceStatusSchema = z.enum(gatewaySandboxInstanceStatuses);
export const GatewaySandboxWorkspaceSyncDirectionSchema = z.enum(gatewaySandboxWorkspaceSyncDirections);
export const GatewaySandboxWorkspaceSyncStatusSchema = z.enum(gatewaySandboxWorkspaceSyncStatuses);
export const GatewayMcpTransportSchema = z.enum(gatewayMcpTransports);
export const GatewayMcpStdioFramingSchema = z.enum(gatewayMcpStdioFramings);

export type SupportedLocale = z.infer<typeof SupportedLocaleSchema>;
export type TranslationStatus = z.infer<typeof TranslationStatusSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type ExecutionScope = z.infer<typeof ExecutionScopeSchema>;
export type InstructionSource = z.infer<typeof InstructionSourceSchema>;
export type ActorIdentity = z.infer<typeof ActorIdentitySchema>;
export type OperationStatus = z.infer<typeof OperationStatusSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type MemoryState = z.infer<typeof MemoryStateSchema>;
export type SkillState = z.infer<typeof SkillStateSchema>;
export type WikiState = z.infer<typeof WikiStateSchema>;
export type CaptureMode = z.infer<typeof CaptureModeSchema>;
export type ExternalProviderRole = z.infer<typeof ExternalProviderRoleSchema>;
export type ActivityType = z.infer<typeof ActivityTypeSchema>;
export type ActivitySeverity = z.infer<typeof ActivitySeveritySchema>;
export type AgentBackendKind = z.infer<typeof AgentBackendKindSchema>;
export type BackendConnectionState = z.infer<typeof BackendConnectionStateSchema>;
export type BackendExecutionOwner = z.infer<typeof BackendExecutionOwnerSchema>;
export type BackendSessionAcquisitionMode = z.infer<typeof BackendSessionAcquisitionModeSchema>;
export type BackendSessionResumeMode = z.infer<typeof BackendSessionResumeModeSchema>;
export type BackendRunStatus = z.infer<typeof BackendRunStatusSchema>;
export type BackendEventType = z.infer<typeof BackendEventTypeSchema>;
export type ClientTargetKind = z.infer<typeof ClientTargetKindSchema>;
export type ClientEventStatus = z.infer<typeof ClientEventStatusSchema>;
export type ClientEventType = z.infer<typeof ClientEventTypeSchema>;
export type WorkspaceChangeType = z.infer<typeof WorkspaceChangeTypeSchema>;
export type ReflectionRunKind = z.infer<typeof ReflectionRunKindSchema>;
export type ReflectionRunStatus = z.infer<typeof ReflectionRunStatusSchema>;
export type ReflectionSuggestionType = z.infer<typeof ReflectionSuggestionTypeSchema>;
export type ReflectionSuggestionStatus = z.infer<typeof ReflectionSuggestionStatusSchema>;
export type ToolRunStatus = z.infer<typeof ToolRunStatusSchema>;
export type LearningEvidenceState = z.infer<typeof LearningEvidenceStateSchema>;
export type LearningUsageState = z.infer<typeof LearningUsageStateSchema>;
export type LearningKnowledgeKind = z.infer<typeof LearningKnowledgeKindSchema>;
export type LearningEvaluationVerdict = z.infer<typeof LearningEvaluationVerdictSchema>;
export type LearningBudgetUnit = z.infer<typeof LearningBudgetUnitSchema>;
export type LearningCandidateSignalKind = z.infer<typeof LearningCandidateSignalKindSchema>;
export type AutomationJobStatus = z.infer<typeof AutomationJobStatusSchema>;
export type ExternalSendStatus = z.infer<typeof ExternalSendStatusSchema>;
export type ExternalSendChannel = z.infer<typeof ExternalSendChannelSchema>;
export type ExternalSendTransportStatus = z.infer<typeof ExternalSendTransportStatusSchema>;
export type GatewayPairingStatus = z.infer<typeof GatewayPairingStatusSchema>;
export type GatewayPairingPolicyStatus = z.infer<typeof GatewayPairingPolicyStatusSchema>;
export type GatewayPairingTrustMode = z.infer<typeof GatewayPairingTrustModeSchema>;
export type GatewayRoutingPolicyStatus = z.infer<typeof GatewayRoutingPolicyStatusSchema>;
export type GatewayRoutingSessionKeyStrategy = z.infer<typeof GatewayRoutingSessionKeyStrategySchema>;
export type GatewayInboundStatus = z.infer<typeof GatewayInboundStatusSchema>;
export type GatewayChannel = z.infer<typeof GatewayChannelSchema>;
export type GatewayBoundarySource = z.infer<typeof GatewayBoundarySourceSchema>;
export type SecretRefSource = z.infer<typeof SecretRefSourceSchema>;
export type SandboxMode = z.infer<typeof SandboxModeSchema>;
export type SandboxScope = z.infer<typeof SandboxScopeSchema>;
export type SandboxBackend = z.infer<typeof SandboxBackendSchema>;
export type SandboxWorkspaceAccess = z.infer<typeof SandboxWorkspaceAccessSchema>;
export type SandboxNetworkAccess = z.infer<typeof SandboxNetworkAccessSchema>;
export type ConcurrencyLockScope = z.infer<typeof ConcurrencyLockScopeSchema>;
export type GatewayConcurrencyLockStatus = z.infer<typeof GatewayConcurrencyLockStatusSchema>;
export type GatewaySandboxInstanceStatus = z.infer<typeof GatewaySandboxInstanceStatusSchema>;
export type GatewaySandboxWorkspaceSyncDirection = z.infer<typeof GatewaySandboxWorkspaceSyncDirectionSchema>;
export type GatewaySandboxWorkspaceSyncStatus = z.infer<typeof GatewaySandboxWorkspaceSyncStatusSchema>;
export type GatewayMcpTransport = z.infer<typeof GatewayMcpTransportSchema>;
export type GatewayMcpStdioFraming = z.infer<typeof GatewayMcpStdioFramingSchema>;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema)])
);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const BackendSessionPolicySchema = z.object({
  acquisition: BackendSessionAcquisitionModeSchema,
  resume: BackendSessionResumeModeSchema
}).strict();
export type BackendSessionPolicy = z.infer<typeof BackendSessionPolicySchema>;

export const BackendRuntimeFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  causeCategory: z.enum(["configuration", "provider", "transport", "cancellation", "process", "runtime", "unknown"])
}).strict();
export type BackendRuntimeFailure = z.infer<typeof BackendRuntimeFailureSchema>;

export const BackendTerminalEvidenceSchema = z.union([
  z.object({ kind: z.literal("completed"), source: z.enum(["canonical_event", "process_exit", "provider_terminal_response", "owned_loop_return"]) }).strict(),
  z.object({ kind: z.literal("failed"), source: z.enum(["canonical_event", "process_exit", "provider_terminal_response", "owned_loop_return"]), error: BackendRuntimeFailureSchema }).strict(),
  z.object({ kind: z.literal("cancelled"), source: z.enum(["canonical_event", "process_exit", "provider_terminal_response", "owned_loop_return"]) }).strict(),
  z.object({ kind: z.literal("not_started"), source: z.literal("preflight_rejection") }).strict(),
  z.object({ kind: z.literal("indeterminate"), reason: z.enum(["transport_lost", "cancel_unconfirmed", "runtime_state_unavailable"]), providerStarted: z.boolean(), mayHaveSideEffects: z.boolean() }).strict()
]);
export type BackendTerminalEvidence = z.infer<typeof BackendTerminalEvidenceSchema>;

// The Runtime owns creation of this decision.  Keeping the opaque marker in
// the shared schema package lets the Workspace Store accept the settlement
// Port without importing Runtime back into the persistence layer.
declare const lifecycleTransitionDecisionBrand: unique symbol;
export type LifecycleTransitionDecision = {
  readonly fromStatus: BackendRunStatus;
  readonly toStatus: BackendRunStatus;
  readonly fromPhase: BackendRunPhase;
  readonly toPhase: BackendRunPhase;
  readonly reason: string;
  readonly terminalEvidence?: JsonValue;
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly phase: BackendRunPhase;
    readonly retryable: boolean;
    readonly causeCategory: string;
  };
  readonly [lifecycleTransitionDecisionBrand]: true;
};

/**
 * Contract schemas are authored in Zod and published as strict JSON Schema.
 * Keeping this conversion at the shared schema boundary prevents each caller
 * from inventing a different JSON Schema dialect or reference strategy.
 */
export function toStrictJsonSchema(schema: z.ZodTypeAny, _name: string): Record<string, JsonValue> {
  const converted: unknown = JSON.parse(JSON.stringify(zodToJsonSchema(schema, { $refStrategy: "root" })));
  if (!isJsonRecord(converted)) throw new Error("zod_json_schema_conversion_invalid");
  return converted;
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}

export const ResourceRefSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  uri: z.string().min(1),
  version: z.string().optional(),
  label: z.string().optional()
}).strict();
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

export const ProvenanceSchema = z.object({
  kind: z.enum(["user_authored", "generated_local", "external_provider", "imported", "system"]),
  summary: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  verified: z.boolean()
}).strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const LocalizedTextSchema = z.object({
  canonical_locale: SupportedLocaleSchema,
  values: z.record(SupportedLocaleSchema, z.string()),
  status_by_locale: z.record(SupportedLocaleSchema, TranslationStatusSchema)
});
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

export const ResourceTranslationRecordSchema = z.object({
  id: z.string().min(1),
  source_ref: ResourceRefSchema,
  source_locale: SupportedLocaleSchema,
  target_locale: SupportedLocaleSchema,
  status: TranslationStatusSchema,
  original_hash: z.string().min(1),
  translated_text: z.string(),
  provenance: ProvenanceSchema.optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type ResourceTranslationRecord = z.infer<typeof ResourceTranslationRecordSchema>;

export const MessageEnvelopeSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["web", "telegram", "slack", "line", "email", "mobile", "webhook", "local_cli", "cron"]),
  actor_identity: ActorIdentitySchema,
  session_key: z.string().min(1),
  user_intent: z.string().min(1),
  attachments: z.array(ResourceRefSchema),
  input_locale: SupportedLocaleSchema,
  output_locale: SupportedLocaleSchema,
  metadata: z.record(jsonValueSchema),
  received_at: z.string().datetime()
}).strict();
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

export const AgentBackendConfigSchema = z.object({
  id: z.string().min(1),
  kind: AgentBackendKindSchema,
  label: z.string().min(1),
  enabled: z.boolean(),
  metadata: z.record(jsonValueSchema),
  session_policy: BackendSessionPolicySchema,
  execution_owner: BackendExecutionOwnerSchema
}).strict();
export type AgentBackendConfig = z.infer<typeof AgentBackendConfigSchema>;

export const BackendCapabilityIdSchema = z.enum([
  "web_search",
  "web_fetch",
  "browser_read",
  "browser_interact",
  "browser_screenshot",
  "subagent_delegate",
  "mcp_tools"
]);
export type BackendCapabilityId = z.infer<typeof BackendCapabilityIdSchema>;

export const BackendCapabilityStateSchema = z.enum([
  "available",
  "unavailable",
  "misconfigured",
  "unverified"
]);
export type BackendCapabilityState = z.infer<typeof BackendCapabilityStateSchema>;

export const BackendCapabilityStatusSchema = z.object({
  backend_id: z.string().min(1),
  capability_id: BackendCapabilityIdSchema,
  state: BackendCapabilityStateSchema,
  source: z.enum(["backend_native", "mcp_adapter", "samurai_adapter"]),
  mode: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  checked_at: z.string().datetime(),
  probe_version: z.string().min(1),
  evidence_summary: z.string().min(1)
});
export type BackendCapabilityStatus = z.infer<typeof BackendCapabilityStatusSchema>;

/** A durable collaboration space inside one Workspace. */
export const RoomRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type RoomRecord = z.infer<typeof RoomRecordSchema>;

/** A stable agent identity. Its Backend can change without changing this record. */
export const AgentRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(20_000),
  backend_id: z.string().trim().min(1),
  enabled: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

/** One explicit reuse boundary for Workspace knowledge resources. */
export const UsageScopeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("room"), room_id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("agent"), agent_id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("session"), session_id: z.string().min(1) }).strict()
]);
export type UsageScopeRef = z.infer<typeof UsageScopeRefSchema>;

/** The concrete Room, Session, and Agent that produced an activity. */
export const ActivityContextRefSchema = z.object({
  room_id: z.string().min(1),
  session_id: z.string().min(1),
  agent_id: z.string().min(1)
}).strict();
export type ActivityContextRef = z.infer<typeof ActivityContextRefSchema>;

export const BackendRunRecordSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  input_message_id: z.string().min(1),
  output_message_id: z.string().optional(),
  backend_id: z.string().min(1),
  backend_kind: AgentBackendKindSchema,
  backend_session_id: z.string().min(1).optional(),
  status: BackendRunStatusSchema,
  phase: BackendRunPhaseSchema.optional(),
  current_attempt: z.number().int().positive().optional(),
  request_idempotency_key: z.string().min(1).optional(),
  request_hash: z.string().min(1).optional(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  input_summary: z.string(),
  output_summary: z.string().optional(),
  error_code: z.string().optional(),
  metadata: z.record(jsonValueSchema)
}).strict();
export type BackendRunRecord = z.infer<typeof BackendRunRecordSchema>;

const BackendEventRecordBaseSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  backend_session_id: z.string().min(1).optional(),
  event_type: BackendEventTypeSchema,
  sequence: z.number().int().positive(),
  attempt_no: z.number().int().positive().optional(),
  source_event_id: z.string().min(1).optional(),
  source_sequence: z.number().int().positive().optional(),
  // Each known event below replaces this opaque slot with an explicit shape.
  // Keeping the base opaque prevents a free-form payload from becoming part of
  // the public union type by accident.
  payload: z.unknown(),
  resource_refs: z.array(ResourceRefSchema),
  created_at: z.string().datetime()
}).strict();
const backendEventProviderShape: z.ZodRawShape = {
  provider: z.string().min(1).optional(),
  provider_event_type: z.string().min(1).optional(),
  provider_tool_name: z.string().min(1).optional(),
  provider_thread_id: z.string().min(1).optional(),
  backend_id: z.string().min(1).optional()
};
const backendEventPayload = (shape: z.ZodRawShape = {}) => z.object({ ...backendEventProviderShape, ...shape }).strict();
const backendEventTextPayload = backendEventPayload({
  text: z.string().min(1),
  item_type: z.string().min(1).optional(),
  display_kind: z.string().min(1).optional(),
  activity_kind: z.string().min(1).optional(),
  ui_visible: z.boolean().optional()
});
const backendToolStartedPayload = backendEventPayload({
  tool_call_id: z.string().min(1),
  provider_tool_name: z.string().min(1).optional(),
  action_id: z.string().min(1).optional(),
  tool_identity: z.string().min(1).optional(),
  tool_input_hash: z.string().min(1).optional(),
  tool_origin: z.string().min(1).optional(),
  input: jsonValueSchema.optional(),
  arguments: jsonValueSchema.optional(),
  capability_id: z.string().min(1).optional(),
  child_task_summary: z.string().optional(),
  parent_relation: z.string().min(1).optional(),
  search_mode: z.string().min(1).optional(),
  execution_boundary: z.string().min(1).optional(),
  requires_host_execution: z.boolean().optional(),
  server_name: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional()
}).superRefine((payload, context) => {
  if (typeof payload.provider_tool_name !== "string" && typeof payload.action_id !== "string") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "provider_tool_name or action_id is required for tool_call_started" });
  }
});
const backendToolOutputPayload = backendEventPayload({
  tool_call_id: z.string().min(1),
  provider_tool_name: z.string().min(1).optional(),
  action_id: z.string().min(1).optional(),
  tool_identity: z.string().min(1).optional(),
  tool_input_hash: z.string().min(1).optional(),
  tool_origin: z.string().min(1).optional(),
  server_name: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional(),
  status: jsonValueSchema.optional(),
  ok: z.boolean().optional(),
  reason: z.string().min(1).nullable().optional(),
  retryable: z.boolean().optional(),
  retry_count: z.number().int().nonnegative().optional(),
  already_executed: z.boolean().optional(),
  input: jsonValueSchema.optional(),
  arguments: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  result: jsonValueSchema.optional(),
  output_summary: z.string().optional(),
  summary: z.string().optional(),
  text: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: jsonValueSchema.optional(),
  token: z.string().optional(),
  error_code: z.string().min(1).optional(),
  exit_code: z.number().int().nullable().optional(),
  signal: z.string().min(1).nullable().optional(),
  capability_id: z.string().min(1).optional(),
  search_mode: z.string().min(1).optional(),
  source_urls: z.array(z.string()).optional(),
  operation_id: z.string().min(1).optional(),
  resource_id: z.string().min(1).optional(),
  resource_kind: z.string().min(1).optional(),
  collection_id: z.string().min(1).optional(),
  record_id: z.string().min(1).optional(),
  query_id: z.string().min(1).optional(),
  surface_id: z.string().min(1).optional(),
  revision_id: z.string().min(1).optional(),
  preview_url: z.string().optional(),
  command: z.string().optional(),
  sandbox: jsonValueSchema.optional(),
  sandbox_instance: jsonValueSchema.optional(),
  secret_resolution: jsonValueSchema.optional(),
  gateway_boundary: jsonValueSchema.optional(),
  render_specs: jsonValueSchema.optional(),
  tool_run_ids: z.array(z.string()).optional(),
  resource_ref: ResourceRefSchema.optional(),
  resource_refs: z.array(ResourceRefSchema).optional(),
  execution_boundary: z.string().min(1).optional(),
  requires_host_execution: z.boolean().optional(),
  ui_visible: z.boolean().optional()
});
const backendWaitingPayload = backendEventPayload({
  prompt: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  waiting_execution: z.enum(["live", "suspended"]).optional()
}).superRefine((payload, context) => {
  if (typeof payload.prompt !== "string" && typeof payload.message !== "string") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "prompt or message is required for backend waiting" });
  }
});
const backendProcessFailurePayload = backendEventPayload({
  reason: z.string().min(1).nullable().optional(),
  message: z.string().optional(),
  error_code: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
  cause_category: z.string().min(1).optional(),
  exit_code: z.number().int().nullable().optional(),
  signal: z.string().min(1).nullable().optional(),
  stderr_summary: z.string().optional(),
  process_error_summary: z.string().optional(),
  command_name: z.string().min(1).optional(),
  output_summary: z.string().optional(),
  finish_reason: z.string().nullable().optional(),
  usage: jsonValueSchema.optional(),
  terminal_evidence: BackendTerminalEvidenceSchema.optional()
});
const backendCompletedPayload = backendProcessFailurePayload.superRefine((payload, context) => {
  const evidence = BackendTerminalEvidenceSchema.safeParse(payload.terminal_evidence);
  if (!evidence.success || evidence.data.kind !== "completed") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["terminal_evidence"], message: "run_completed requires completed evidence" });
  }
});
const backendFailedPayload = backendProcessFailurePayload.superRefine((payload, context) => {
  const evidence = BackendTerminalEvidenceSchema.safeParse(payload.terminal_evidence);
  if (!evidence.success || evidence.data.kind === "completed") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["terminal_evidence"], message: "run_failed requires non-completed evidence" });
  }
});
const backendProtocolDiagnosticPayload = z.object({
  provider: z.string().min(1),
  reason: z.enum(["unknown_event", "invalid_json", "required_field_missing", "tool_id_missing", "session_conflict", "terminal_missing"]),
  summary: z.string().min(1).max(240),
  raw_type: z.string().min(1).optional()
}).strict();
const backendNativeInputSubmittedPayload = z.object({
  submitted_at: z.string().datetime(),
  has_input: z.boolean()
}).strict();

export const BackendEventPayloadSchemas = {
  run_started: backendEventPayload({
    subtype: z.string().min(1).optional(),
    input_summary: z.string().optional(),
    input_locale: z.string().min(1).optional(),
    output_locale: z.string().min(1).optional(),
    locale_contract: jsonValueSchema.optional()
  }),
  agent_reasoning: backendEventTextPayload,
  host_progress: backendEventTextPayload,
  text_delta: backendEventTextPayload,
  tool_call_started: backendToolStartedPayload,
  tool_call_output: backendToolOutputPayload,
  artifact_created: backendEventPayload({
    artifact_id: z.string().min(1).optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    resource_id: z.string().min(1).optional(),
    resource_kind: z.string().min(1).optional(),
    resource_ref: ResourceRefSchema.optional(),
    resource_refs: z.array(ResourceRefSchema).optional(),
    tool_call_id: z.string().min(1).optional(),
    ui_visible: z.boolean().optional()
  }),
  workspace_change_suggested: backendEventPayload({
    operation_id: z.string().min(1).optional(),
    resource_id: z.string().min(1).optional(),
    resource_kind: z.string().min(1).optional(),
    resource_ref: ResourceRefSchema.optional(),
    resource_refs: z.array(ResourceRefSchema).optional(),
    summary: z.string().optional(),
    tool_call_id: z.string().min(1).optional()
  }),
  memory_suggested: backendEventPayload({
    memory_id: z.string().min(1).optional(),
    topic: z.string().optional(),
    content: z.string().optional(),
    resource_ref: ResourceRefSchema.optional(),
    resource_refs: z.array(ResourceRefSchema).optional(),
    tool_call_id: z.string().min(1).optional()
  }),
  skill_candidate_created: backendEventPayload({
    skill_id: z.string().min(1).optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    resource_ref: ResourceRefSchema.optional(),
    resource_refs: z.array(ResourceRefSchema).optional(),
    tool_call_id: z.string().min(1).optional()
  }),
  backend_waiting_for_native_input: backendWaitingPayload,
  backend_native_input_submitted: backendNativeInputSubmittedPayload,
  backend_stream_synced: backendEventPayload({
    reason: z.string().min(1).nullable().optional(),
    run_status: z.string().min(1).optional(),
    observed_event_count: z.number().int().nonnegative().optional(),
    persisted_event_count: z.number().int().nonnegative().optional(),
    ui_visible: z.boolean().optional()
  }),
  backend_stream_unavailable: backendEventPayload({
    reason: z.string().min(1).nullable().optional(),
    message: z.string().optional(),
    ui_visible: z.boolean().optional()
  }),
  host_post_turn_failed: backendProcessFailurePayload,
  host_cleanup_failed: backendProcessFailurePayload,
  host_emit_failed: backendProcessFailurePayload,
  backend_protocol_diagnostic: backendProtocolDiagnosticPayload,
  run_completed: backendProcessFailurePayload,
  run_failed: backendProcessFailurePayload
} as const;

export type BackendEventPayloadByType = {
  [T in keyof typeof BackendEventPayloadSchemas]: z.infer<(typeof BackendEventPayloadSchemas)[T]>
};

function backendEventVariant<T extends BackendEventType, P extends z.ZodTypeAny>(eventType: T, payload: P) {
  return BackendEventRecordBaseSchema.extend({ event_type: z.literal(eventType), payload });
}

type BackendEventVariant = z.ZodDiscriminatedUnionOption<"event_type">;
const backendEventVariants = [
  backendEventVariant("run_started", BackendEventPayloadSchemas.run_started),
  backendEventVariant("agent_reasoning", BackendEventPayloadSchemas.agent_reasoning),
  backendEventVariant("host_progress", BackendEventPayloadSchemas.host_progress),
  backendEventVariant("text_delta", BackendEventPayloadSchemas.text_delta),
  backendEventVariant("tool_call_started", BackendEventPayloadSchemas.tool_call_started),
  backendEventVariant("tool_call_output", BackendEventPayloadSchemas.tool_call_output),
  backendEventVariant("artifact_created", BackendEventPayloadSchemas.artifact_created),
  backendEventVariant("workspace_change_suggested", BackendEventPayloadSchemas.workspace_change_suggested),
  backendEventVariant("memory_suggested", BackendEventPayloadSchemas.memory_suggested),
  backendEventVariant("skill_candidate_created", BackendEventPayloadSchemas.skill_candidate_created),
  backendEventVariant("backend_waiting_for_native_input", BackendEventPayloadSchemas.backend_waiting_for_native_input),
  backendEventVariant("backend_native_input_submitted", BackendEventPayloadSchemas.backend_native_input_submitted),
  backendEventVariant("backend_stream_synced", BackendEventPayloadSchemas.backend_stream_synced),
  backendEventVariant("backend_stream_unavailable", BackendEventPayloadSchemas.backend_stream_unavailable),
  backendEventVariant("host_post_turn_failed", BackendEventPayloadSchemas.host_post_turn_failed),
  backendEventVariant("host_cleanup_failed", BackendEventPayloadSchemas.host_cleanup_failed),
  backendEventVariant("host_emit_failed", BackendEventPayloadSchemas.host_emit_failed),
  backendEventVariant("backend_protocol_diagnostic", BackendEventPayloadSchemas.backend_protocol_diagnostic),
  backendEventVariant("run_completed", backendCompletedPayload),
  backendEventVariant("run_failed", backendFailedPayload)
] as const satisfies readonly [BackendEventVariant, ...BackendEventVariant[]];

/** New rows are checked by event kind; callers may still read older rows through the Store compatibility path. */
export interface BackendEventRecord {
  id: string;
  run_id: string;
  session_id: string;
  backend_session_id?: string;
  event_type: BackendEventType;
  sequence: number;
  attempt_no?: number;
  source_event_id?: string;
  source_sequence?: number;
  /** The runtime schema above is strict; this read view also supports legacy rows. */
  payload: Record<string, JsonValue>;
  resource_refs: ResourceRef[];
  created_at: string;
}
export const BackendEventRecordSchema: z.ZodType<BackendEventRecord, z.ZodTypeDef, unknown> = z.discriminatedUnion("event_type", backendEventVariants);

export const ClientEventRecordSchema = z.object({
  id: z.string().min(1),
  target_client_kind: ClientTargetKindSchema,
  target_client_id: z.string().min(1).optional(),
  event_type: ClientEventTypeSchema,
  status: ClientEventStatusSchema,
  payload: z.record(jsonValueSchema),
  resource_refs: z.array(ResourceRefSchema),
  created_at: z.string().datetime(),
  delivered_at: z.string().datetime().optional(),
  acked_at: z.string().datetime().optional(),
  expires_at: z.string().datetime().optional(),
  error_code: z.string().optional()
}).strict();
export type ClientEventRecord = z.infer<typeof ClientEventRecordSchema>;

export const WorkspaceChangeRecordSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  resource_ref: ResourceRefSchema,
  change_type: WorkspaceChangeTypeSchema,
  summary: z.string(),
  legacy_operation_id: z.string().optional(),
  correlation_id: z.string().optional(),
  created_at: z.string().datetime()
}).strict();
export type WorkspaceChangeRecord = z.infer<typeof WorkspaceChangeRecordSchema>;

export const SkillIndexEntryReadModelSchema = z.object({
  id: z.string().min(1),
  state: SkillStateSchema,
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  required_capabilities: z.array(z.string()),
  file_path: z.string().min(1),
  updated_at: z.string().datetime().optional()
});
export type SkillIndexEntryReadModel = z.infer<typeof SkillIndexEntryReadModelSchema>;

export const ChangeHistoryEntrySchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  change_type: WorkspaceChangeTypeSchema,
  resource_ref: ResourceRefSchema,
  summary: z.string(),
  created_at: z.string().datetime()
});
export type ChangeHistoryEntry = z.infer<typeof ChangeHistoryEntrySchema>;

export const RunHistoryEntrySchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  backend_id: z.string().min(1),
  backend_kind: AgentBackendKindSchema,
  status: BackendRunStatusSchema,
  input_summary: z.string(),
  output_summary: z.string().optional(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  event_count: z.number().int().nonnegative(),
  workspace_change_count: z.number().int().nonnegative(),
  error_code: z.string().optional()
});
export type RunHistoryEntry = z.infer<typeof RunHistoryEntrySchema>;

export const ProfileDocumentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["soul", "profile"]),
  file_ref: ResourceRefSchema,
  content: z.string(),
  loaded_at: z.string().datetime()
});
export type ProfileDocument = z.infer<typeof ProfileDocumentSchema>;

export const FreezeSnapshotSchema = z.object({
  id: z.string().min(1),
  soul: ProfileDocumentSchema,
  profile: ProfileDocumentSchema.optional(),
  memory_refs: z.array(ResourceRefSchema),
  skill_refs: z.array(ResourceRefSchema),
  wiki_refs: z.array(ResourceRefSchema),
  content: z.string(),
  stable_hash: z.string().min(1),
  created_at: z.string().datetime()
});
export type FreezeSnapshot = z.infer<typeof FreezeSnapshotSchema>;

export const ExternalAssistPhaseSchema = z.enum(["prefetch", "sync"]);
export type ExternalAssistPhase = z.infer<typeof ExternalAssistPhaseSchema>;

export const ExternalAssistStatusSchema = z.enum(["disabled", "skipped", "completed", "failed"]);
export type ExternalAssistStatus = z.infer<typeof ExternalAssistStatusSchema>;

export const ExternalAssistHintSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  summary: z.string(),
  source_uri: z.string().optional(),
  source_label: z.string().optional(),
  confidence: z.number().min(0).max(1).optional()
});
export type ExternalAssistHint = z.infer<typeof ExternalAssistHintSchema>;

export const ExternalAssistRecordSchema = z.object({
  id: z.string().min(1),
  phase: ExternalAssistPhaseSchema,
  status: ExternalAssistStatusSchema,
  provider_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().optional(),
  input_message_id: z.string().optional(),
  query: z.string(),
  role: ExternalProviderRoleSchema,
  hints: z.array(ExternalAssistHintSchema),
  error: z.string().optional(),
  isolated_from_memory: z.boolean(),
  included_in_active_memory: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type ExternalAssistRecord = z.infer<typeof ExternalAssistRecordSchema>;

export const ExternalAssistContextSchema = z.object({
  role: ExternalProviderRoleSchema,
  isolated_from_memory: z.boolean(),
  included_in_active_memory: z.boolean(),
  note: z.string(),
  hints: z.array(ExternalAssistHintSchema),
  last_prefetch: ExternalAssistRecordSchema.optional(),
  recent_failures: z.array(ExternalAssistRecordSchema)
});
export type ExternalAssistContext = z.infer<typeof ExternalAssistContextSchema>;

export const ExternalAssistDiagnosticsGroupSchema = z.object({
  provider_id: z.string().min(1),
  phase: ExternalAssistPhaseSchema,
  status: ExternalAssistStatusSchema,
  count: z.number().int().nonnegative(),
  hint_count: z.number().int().nonnegative(),
  latest_record: ExternalAssistRecordSchema
});
export type ExternalAssistDiagnosticsGroup = z.infer<typeof ExternalAssistDiagnosticsGroupSchema>;

export const ExternalAssistDiagnosticsViolationSchema = z.object({
  code: z.enum(["external_assist_not_isolated", "external_assist_included_in_active_memory"]),
  record_id: z.string().min(1),
  provider_id: z.string().min(1),
  phase: ExternalAssistPhaseSchema,
  status: ExternalAssistStatusSchema,
  message: z.string()
});
export type ExternalAssistDiagnosticsViolation = z.infer<typeof ExternalAssistDiagnosticsViolationSchema>;

export const ExternalAssistDiagnosticsReportSchema = z.object({
  generated_at: z.string().datetime(),
  scope: z.object({
    session_id: z.string().optional(),
    phase: ExternalAssistPhaseSchema.optional(),
    status: ExternalAssistStatusSchema.optional(),
    provider_id: z.string().optional(),
    limit: z.number().int().positive()
  }),
  total_records: z.number().int().nonnegative(),
  failed_records: z.number().int().nonnegative(),
  hint_count: z.number().int().nonnegative(),
  unisolated_records: z.number().int().nonnegative(),
  included_in_active_memory_records: z.number().int().nonnegative(),
  groups: z.array(ExternalAssistDiagnosticsGroupSchema),
  violations: z.array(ExternalAssistDiagnosticsViolationSchema),
  recent_failures: z.array(ExternalAssistRecordSchema),
  recommendation: z.string()
});
export type ExternalAssistDiagnosticsReport = z.infer<typeof ExternalAssistDiagnosticsReportSchema>;

export const ExternalAssistProviderConfigDiagnosticsSchema = z.object({
  configured: z.boolean(),
  source: z.enum(["none", "http", "local_file", "multiple", "invalid", "injected"]),
  provider_id: z.string().nullable(),
  provider_ids: z.array(z.string()).optional(),
  provider_count: z.number().int().nonnegative().optional(),
  provider_kind: z.enum(["http", "local_file", "multiple", "injected"]).nullable(),
  max_hints: z.number().int().positive(),
  timeout_ms: z.number().int().positive().nullable(),
  token_configured: z.boolean(),
  auth_header: z.string().nullable(),
  endpoint_origin: z.string().optional(),
  endpoint_path_configured: z.boolean().optional(),
  file_name: z.string().optional(),
  errors: z.array(z.string()),
  warnings: z.array(z.string())
});
export type ExternalAssistProviderConfigDiagnostics = z.infer<typeof ExternalAssistProviderConfigDiagnosticsSchema>;

export const SettingsResponseSchema = z.object({
  ui_locale: SupportedLocaleSchema,
  output_locale: SupportedLocaleSchema,
  memory_capture_mode: CaptureModeSchema,
  knowledge_wiki_capture_mode: CaptureModeSchema,
  skill_capture_mode: CaptureModeSchema,
  learning_enabled: z.boolean().default(true),
  learning_budget_ratio: z.number().min(0).max(1).default(0.1),
  learning_budget_window_days: z.number().int().positive().default(7),
  external_provider_role: ExternalProviderRoleSchema,
  updated_at: z.string().datetime(),
  external_assist_config: ExternalAssistProviderConfigDiagnosticsSchema
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

export const BackendReleaseManualGateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["manual_opt_in_required"]),
  effect: z.enum(["authenticated_external_service", "external_sandbox", "external_channel_service"]),
  reason: z.string().min(1),
  command: z.string().min(1),
  confirmation_flag: z.literal("--confirm-external-effects"),
  runbook: z.string().min(1)
}).strict();
export type BackendReleaseManualGate = z.infer<typeof BackendReleaseManualGateSchema>;

export const BackendReleaseProfileSchema = z.object({
  id: z.enum(["local_oss", "production_ops"]),
  label: z.string().min(1),
  status: z.enum(["available", "manual_opt_in_required"]),
  non_destructive_command: z.string().min(1),
  required_gate_ids: z.array(z.string().min(1)),
  manual_gate_ids: z.array(z.string().min(1)),
  runbook: z.string().min(1),
  notes: z.array(z.string().min(1))
}).strict();
export type BackendReleaseProfile = z.infer<typeof BackendReleaseProfileSchema>;

export const BackendReleaseReadinessHealthSchema = z.object({
  non_destructive: z.object({
    status: z.enum(["available"]),
    command: z.string().min(1)
  }).strict(),
  external_effects_confirmed: z.literal(false),
  manual_gate_count: z.number().int().nonnegative(),
  manual_gates: z.array(BackendReleaseManualGateSchema),
  profiles: z.array(BackendReleaseProfileSchema)
}).strict();
export type BackendReleaseReadinessHealth = z.infer<typeof BackendReleaseReadinessHealthSchema>;

export const ActiveMemoryExclusionReasonSchema = z.enum([
  "session_only",
  "provisional_pending",
  "archived",
  "not_active_state",
  "learning_conflict",
  "learning_dormant",
  "empty_content"
]);
export type ActiveMemoryExclusionReason = z.infer<typeof ActiveMemoryExclusionReasonSchema>;

export const ActiveMemoryRetrievalReportSchema = z.object({
  query: z.string(),
  retrieved_at: z.string().datetime(),
  candidate_count: z.number().int().nonnegative(),
  included_count: z.number().int().nonnegative(),
  included_memory_ids: z.array(z.string().min(1)),
  excluded: z.array(z.object({
    id: z.string().min(1),
    topic: z.string(),
    state: MemoryStateSchema,
    reason: ActiveMemoryExclusionReasonSchema
  })),
  sensitive_redactions: z.array(z.object({
    id: z.string().min(1),
    topic: z.string(),
    sensitive_level: z.enum(["low", "high"]),
    redacted: z.boolean(),
    reason: z.string()
  })),
  conflict_groups: z.array(z.object({
    id: z.string().min(1),
    memory_ids: z.array(z.string().min(1)),
    reason: z.string(),
    proposed_action: z.enum(["review", "merge", "archive_one"])
  })),
  resolution_suggestions: z.array(z.object({
    kind: z.enum(["conflict_review", "sensitive_review", "provisional_review"]),
    memory_ids: z.array(z.string().min(1)),
    reason: z.string()
  }))
});
export type ActiveMemoryRetrievalReport = z.infer<typeof ActiveMemoryRetrievalReportSchema>;

export const KnowledgeWikiExclusionReasonSchema = z.enum([
  "proposed",
  "rejected",
  "archived",
  "not_active",
  "learning_conflict",
  "learning_dormant",
  "empty_content"
]);
export type KnowledgeWikiExclusionReason = z.infer<typeof KnowledgeWikiExclusionReasonSchema>;

export const KnowledgeWikiRetrievalReportSchema = z.object({
  query: z.string(),
  retrieved_at: z.string().datetime(),
  candidate_count: z.number().int().nonnegative(),
  included_count: z.number().int().nonnegative(),
  included_wiki_ids: z.array(z.string().min(1)),
  excluded: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    title: z.string(),
    state: WikiStateSchema,
    reason: KnowledgeWikiExclusionReasonSchema
  })),
  source_refs: z.array(ResourceRefSchema)
});
export type KnowledgeWikiRetrievalReport = z.infer<typeof KnowledgeWikiRetrievalReportSchema>;

export const KnowledgeWikiGraphSchema = z.object({
  active_only: z.boolean(),
  nodes: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    title: z.string(),
    state: WikiStateSchema,
    source_ref_count: z.number().int().nonnegative()
  })),
  edges: z.array(z.object({
    from_wiki_id: z.string().min(1),
    relation: z.literal("source_ref"),
    to_ref: ResourceRefSchema
  }))
});
export type KnowledgeWikiGraph = z.infer<typeof KnowledgeWikiGraphSchema>;

export const KnowledgeWikiLintReportSchema = z.object({
  generated_at: z.string().datetime(),
  active_pages: z.number().int().nonnegative(),
  broken_links: z.array(z.object({ from_wiki_id: z.string(), target: z.string() })),
  duplicate_groups: z.array(z.object({ key: z.string(), wiki_ids: z.array(z.string()).min(2) })),
  orphan_wiki_ids: z.array(z.string()),
  backlinks: z.record(z.string(), z.array(z.object({ from_wiki_id: z.string(), label: z.string() })))
});
export type KnowledgeWikiLintReport = z.infer<typeof KnowledgeWikiLintReportSchema>;

export const KnowledgeWikiDiagnosticsIssueSchema = z.object({
  code: z.enum([
    "active_wiki_empty_content",
    "active_wiki_missing_provenance",
    "active_wiki_unverified_provenance",
    "active_wiki_missing_source_refs",
    "active_wiki_retrieval_includes_non_active"
  ]),
  severity: z.enum(["warning", "critical"]),
  wiki_id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string(),
  state: WikiStateSchema,
  message: z.string()
});
export type KnowledgeWikiDiagnosticsIssue = z.infer<typeof KnowledgeWikiDiagnosticsIssueSchema>;

export const KnowledgeWikiDiagnosticsReportSchema = z.object({
  generated_at: z.string().datetime(),
  total_pages: z.number().int().nonnegative(),
  active_pages: z.number().int().nonnegative(),
  state_counts: z.record(z.number().int().nonnegative()),
  active_with_provenance: z.number().int().nonnegative(),
  active_with_verified_provenance: z.number().int().nonnegative(),
  active_with_source_refs: z.number().int().nonnegative(),
  active_empty_pages: z.number().int().nonnegative(),
  issues: z.array(KnowledgeWikiDiagnosticsIssueSchema),
  recommendation: z.string()
});
export type KnowledgeWikiDiagnosticsReport = z.infer<typeof KnowledgeWikiDiagnosticsReportSchema>;

export const HostContextAssemblySourceKindSchema = z.enum([
  "session",
  "recent_messages",
  "freeze_snapshot",
  "active_memory",
  "knowledge_wiki",
  "collection_notes",
  "selected_skills",
  "session_search",
  "external_assist",
  "available_tools",
  "gateway_boundary"
]);
export type HostContextAssemblySourceKind = z.infer<typeof HostContextAssemblySourceKindSchema>;

export const HostContextAssemblySourceStatusSchema = z.enum([
  "included",
  "empty",
  "disabled",
  "filtered",
  "missing",
  "skipped"
]);
export type HostContextAssemblySourceStatus = z.infer<typeof HostContextAssemblySourceStatusSchema>;

export const ContextHandoffModeSchema = z.enum(["inline", "pointer", "skipped"]);
export type ContextHandoffMode = z.infer<typeof ContextHandoffModeSchema>;

export const ContextHandoffSourceSchema = z.object({
  kind: HostContextAssemblySourceKindSchema,
  mode: ContextHandoffModeSchema,
  candidate_count: z.number().int().nonnegative(),
  included_count: z.number().int().nonnegative(),
  reason: z.string(),
  refs: z.array(ResourceRefSchema)
});
export type ContextHandoffSource = z.infer<typeof ContextHandoffSourceSchema>;

export const ContextHandoffSchema = z.object({
  version: z.literal(1),
  strategy: z.enum(["inline_context", "pointer_first"]),
  sources: z.array(ContextHandoffSourceSchema),
  prompt_size_warning: z.string().optional()
});
export type ContextHandoff = z.infer<typeof ContextHandoffSchema>;

export const HostContextAssemblyCheckStatusSchema = z.enum(["pass", "warning", "fail"]);
export type HostContextAssemblyCheckStatus = z.infer<typeof HostContextAssemblyCheckStatusSchema>;

export const HostContextAssemblySchema = z.object({
  version: z.literal(1),
  assembled_at: z.string().datetime(),
  session_id: z.string().min(1),
  query: z.string(),
  sources: z.array(z.object({
    kind: HostContextAssemblySourceKindSchema,
    status: HostContextAssemblySourceStatusSchema,
    candidate_count: z.number().int().nonnegative(),
    included_count: z.number().int().nonnegative(),
    reason: z.string()
  })),
  omissions: z.array(z.object({
    kind: HostContextAssemblySourceKindSchema,
    reason: z.string(),
    count: z.number().int().nonnegative().optional()
  })),
  limits: z.object({
    recent_messages: z.number().int().positive(),
    knowledge_wiki: z.number().int().positive(),
    collection_notes: z.number().int().positive(),
    selected_skills: z.number().int().positive(),
    session_search: z.number().int().positive()
  }),
  gateway_boundary: z.object({
    present: z.boolean(),
    policy_id: z.string().optional(),
    source_channel: GatewayBoundarySourceSchema.optional(),
    source_identity: z.string().optional(),
    allowed_tools_count: z.number().int().nonnegative(),
    available_tools_before_boundary: z.number().int().nonnegative(),
    available_tools_after_boundary: z.number().int().nonnegative(),
    filtered_tool_count: z.number().int().nonnegative(),
    reason: z.string()
  }),
  quality_checks: z.array(z.object({
    id: z.string().min(1),
    status: HostContextAssemblyCheckStatusSchema,
    detail: z.string()
  }))
});
export type HostContextAssembly = z.infer<typeof HostContextAssemblySchema>;

export const ContextPreviewSchema = z.object({
  session_id: z.string().min(1),
  query: z.string(),
  context_assembly: HostContextAssemblySchema,
  session_summary: z.object({
    session_key: z.string().min(1),
    title: z.string(),
    ui_locale: SupportedLocaleSchema,
    output_locale: SupportedLocaleSchema,
    message_count: z.number().int().nonnegative(),
    operation_count: z.number().int().nonnegative(),
    backend_run_count: z.number().int().nonnegative(),
    tool_run_count: z.number().int().nonnegative(),
    workspace_change_count: z.number().int().nonnegative(),
    last_message_at: z.string().datetime().optional(),
    last_backend_run_id: z.string().optional(),
    last_backend_run_status: BackendRunStatusSchema.optional()
  }),
  external_assist: ExternalAssistContextSchema,
  freeze_snapshot: FreezeSnapshotSchema.optional(),
  active_memory: z.array(z.object({
    id: z.string().min(1),
    topic: z.string().min(1),
    content: z.string(),
    state: z.enum(["active", "topic", "sensitive"]),
    sensitive_level: z.enum(["none", "low", "high"]),
    priority: z.enum(["primary", "sensitive", "conflict"]),
    selection_reason: z.string(),
    evidence_state: LearningEvidenceStateSchema.optional(),
    usage_state: LearningUsageStateSchema.optional(),
    conflicts_with: z.array(z.string())
  })),
  active_memory_report: ActiveMemoryRetrievalReportSchema,
  knowledge_wiki: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
    source_refs: z.array(ResourceRefSchema),
    provenance: ProvenanceSchema,
    evidence_state: LearningEvidenceStateSchema.optional(),
    usage_state: LearningUsageStateSchema.optional()
  })),
  knowledge_wiki_report: KnowledgeWikiRetrievalReportSchema,
  collection_notes: z.array(z.object({
    collection_id: z.string().min(1),
    file_path: z.string().min(1),
    content: z.string(),
    role: z.literal("context_only")
  })),
  skill_selection_report: z.object({
    query: z.string(),
    candidate_count: z.number().int().nonnegative(),
    selected_count: z.number().int().nonnegative(),
    selected_skill_ids: z.array(z.string().min(1)),
    available_capabilities: z.array(z.string()),
    environment: z.object({
      runtime: z.literal("local_workspace"),
      platform: z.string()
    }),
    excluded: z.array(z.object({
      id: z.string().min(1),
      title: z.string(),
      reason: z.enum(["missing_capability", "scope_unsupported", "low_match"]),
      missing_capabilities: z.array(z.string()),
      unsupported_scopes: z.array(ExecutionScopeSchema)
    }))
  }),
  selected_skills: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    allowed_scopes: z.array(ExecutionScopeSchema),
    required_capabilities: z.array(z.string()),
    disclosure_level: z.enum(["catalog", "body", "support"]),
    evidence_state: LearningEvidenceStateSchema.optional(),
    usage_state: LearningUsageStateSchema.optional(),
    selection_reason: z.string().optional(),
    selection: z.object({
      score: z.number(),
      matched_terms: z.array(z.string()),
      matched_capabilities: z.array(z.string()),
      missing_capabilities: z.array(z.string()),
      unsupported_scopes: z.array(ExecutionScopeSchema),
      reasons: z.array(z.string())
    }).optional(),
    usage: z.object({
      use_count: z.number().int().nonnegative(),
      last_used_at: z.string().datetime().optional()
    }).optional(),
    content: z.string().optional(),
    support_file_refs: z.array(z.object({
      path: z.string().min(1),
      file_path: z.string().min(1)
    })).optional(),
    support_files: z.array(z.object({
      path: z.string().min(1),
      file_path: z.string().min(1),
      content: z.string()
    })).optional()
  })),
  session_search: z.array(z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
    title: z.string(),
    summary: z.string()
  })),
  recent_messages: z.array(z.object({
    id: z.string().min(1),
    role: z.enum(["user", "agent", "system"]),
    content: z.string()
  })),
  available_tools: z.array(z.string())
});
export type ContextPreview = z.infer<typeof ContextPreviewSchema>;

export const ContextFreezeResponseSchema = z.object({
  session_id: z.string().min(1),
  query: z.string(),
  freeze_snapshot: FreezeSnapshotSchema,
  context_assembly: HostContextAssemblySchema,
  session_summary: ContextPreviewSchema.shape.session_summary,
  source_refs: z.array(ResourceRefSchema),
  stable_hash: z.string().min(1),
  created_at: z.string().datetime()
});
export type ContextFreezeResponse = z.infer<typeof ContextFreezeResponseSchema>;

export const LearningCandidateSignalSchema = z.object({
  kind: LearningCandidateSignalKindSchema,
  summary: z.string().min(1),
  evidence_refs: z.array(ResourceRefSchema),
  details: z.record(jsonValueSchema).default({})
}).strict();
export type LearningCandidateSignal = z.infer<typeof LearningCandidateSignalSchema>;

/** The only mutations a Background Review may request. Runtime validates this plan before writing. */
export const LearningBackgroundReviewMutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("memory_create"),
    topic: z.string().min(1),
    content: z.string().min(1),
    reason: z.string().min(1),
    evidence_refs: z.array(ResourceRefSchema).min(1),
    usage_scope: z.object({ kind: z.literal("room"), room_id: z.string().min(1) }).strict(),
    evidence_state: z.enum(["direct_confirmed", "inferred"]),
    usage_state: z.enum(["normal", "limited"])
  }).strict(),
  z.object({
    kind: z.literal("experience_rule_create"),
    title: z.string().min(1),
    summary: z.string().min(1),
    conditions: z.array(z.string().min(1)).min(1),
    recommended_action: z.string().min(1),
    predicted_result: z.string().min(1),
    reason: z.string().min(1),
    evidence_refs: z.array(ResourceRefSchema).min(1),
    usage_scope: z.object({ kind: z.literal("room"), room_id: z.string().min(1) }).strict(),
    evidence_state: z.enum(["direct_confirmed", "inferred"]),
    usage_state: z.enum(["normal", "limited"])
  }).strict(),
  z.object({
    kind: z.literal("skill_candidate_create"),
    title: z.string().min(1),
    description: z.string().min(1),
    content: z.string().min(1),
    reason: z.string().min(1),
    evidence_refs: z.array(ResourceRefSchema).min(1),
    usage_scope: z.object({ kind: z.literal("room"), room_id: z.string().min(1) }).strict()
  }).strict(),
  z.object({
    kind: z.literal("resource_evidence_append"),
    resource_kind: z.enum(["memory", "wiki", "skill"]),
    resource_id: z.string().min(1),
    reason: z.string().min(1),
    evidence_refs: z.array(ResourceRefSchema).min(1)
  }).strict(),
  z.object({
    kind: z.literal("resource_replacement_candidate"),
    resource_kind: z.enum(["memory", "wiki", "skill"]),
    resource_id: z.string().min(1),
    reason: z.string().min(1),
    evidence_refs: z.array(ResourceRefSchema).min(1)
  }).strict(),
  z.object({
    kind: z.literal("skill_patch_candidate"),
    resource_id: z.string().min(1),
    content: z.string().min(1),
    reason: z.string().min(1),
    evidence_refs: z.array(ResourceRefSchema).min(1)
  }).strict()
]);
export type LearningBackgroundReviewMutation = z.infer<typeof LearningBackgroundReviewMutationSchema>;

export const LearningBackgroundReviewMutationPlanSchema = z.object({
  reviewer: z.string().min(1),
  summary: z.string(),
  mutations: z.array(LearningBackgroundReviewMutationSchema).max(50)
}).strict();
export type LearningBackgroundReviewMutationPlan = z.infer<typeof LearningBackgroundReviewMutationPlanSchema>;

export const ReflectionRunRecordSchema = z.object({
  id: z.string().min(1),
  kind: ReflectionRunKindSchema,
  source_run_id: z.string().optional(),
  session_id: z.string().optional(),
  activity_context: ActivityContextRefSchema.optional(),
  status: ReflectionRunStatusSchema,
  /** Present only for a deterministic Core 05 review candidate. */
  candidate_key: z.string().min(1).optional(),
  candidate_signals: z.array(LearningCandidateSignalSchema).optional(),
  deferred_reason: z.string().min(1).optional(),
  budget_unit: LearningBudgetUnitSchema.optional(),
  budget_estimate: z.number().nonnegative().optional(),
  input_summary: z.string(),
  output_summary: z.string().optional(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  error: z.string().optional()
}).strict();
export type ReflectionRunRecord = z.infer<typeof ReflectionRunRecordSchema>;

export const ReflectionSuggestionRecordSchema = z.object({
  id: z.string().min(1),
  reflection_run_id: z.string().min(1),
  suggestion_type: ReflectionSuggestionTypeSchema,
  status: ReflectionSuggestionStatusSchema,
  title: z.string(),
  content: z.string(),
  target_ref: ResourceRefSchema.optional(),
  source_refs: z.array(ResourceRefSchema),
  confidence: z.number().min(0).max(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type ReflectionSuggestionRecord = z.infer<typeof ReflectionSuggestionRecordSchema>;

export const ReflectionDiagnosticsIssueSchema = z.object({
  code: z.enum([
    "reflection_run_missing",
    "reflection_run_failed",
    "reflection_run_stale",
    "reflection_suggestion_pending",
    "curator_run_missing",
    "curator_run_failed",
    "curator_run_stale",
    "curator_paused",
    "curator_idle_gate_skipped",
    "curator_suggestion_pending"
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
  reflection_run_id: z.string().min(1).optional(),
  suggestion_id: z.string().min(1).optional(),
  run_kind: ReflectionRunKindSchema.optional(),
  suggestion_type: ReflectionSuggestionTypeSchema.optional(),
  status: z.string().min(1).optional(),
  resource_ref: ResourceRefSchema.optional(),
  created_at: z.string().datetime().optional()
}).strict();
export type ReflectionDiagnosticsIssue = z.infer<typeof ReflectionDiagnosticsIssueSchema>;

export const ReflectionDiagnosticsReportSchema = z.object({
  generated_at: z.string().datetime(),
  stale_after_hours: z.number().int().positive(),
  total_reflection_runs: z.number().int().nonnegative(),
  completed_reflection_runs: z.number().int().nonnegative(),
  failed_reflection_runs: z.number().int().nonnegative(),
  total_curator_runs: z.number().int().nonnegative(),
  completed_curator_runs: z.number().int().nonnegative(),
  failed_curator_runs: z.number().int().nonnegative(),
  pending_reflection_suggestions: z.number().int().nonnegative(),
  pending_curator_suggestions: z.number().int().nonnegative(),
  latest_reflection_run: ReflectionRunRecordSchema.optional(),
  latest_curator_run: ReflectionRunRecordSchema.optional(),
  curator_state: z.lazy(() => CuratorStateRecordSchema),
  status_counts: z.object({
    reflection_runs: z.record(z.string(), z.number().int().nonnegative()),
    curator_runs: z.record(z.string(), z.number().int().nonnegative()),
    suggestions: z.record(z.string(), z.number().int().nonnegative()),
    suggestion_types: z.record(z.string(), z.number().int().nonnegative())
  }),
  issues: z.array(ReflectionDiagnosticsIssueSchema),
  recommendation: z.string()
});
export type ReflectionDiagnosticsReport = z.infer<typeof ReflectionDiagnosticsReportSchema>;

export const SkillUsageRecordSchema = z.object({
  skill_id: z.string().min(1),
  use_count: z.number().int().nonnegative(),
  last_used_at: z.string().datetime().optional(),
  last_run_id: z.string().min(1).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type SkillUsageRecord = z.infer<typeof SkillUsageRecordSchema>;

export const LearningResourceUseRecordSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  activity_context: ActivityContextRefSchema.optional(),
  resource_kind: LearningResourceKindSchema,
  resource_id: z.string().min(1),
  resource_version: z.string().min(1).optional(),
  content_hash: z.string().min(1).optional(),
  usage_scope: UsageScopeRefSchema.optional(),
  stage: LearningResourceUseStageSchema,
  source_operation_id: z.string().min(1).optional(),
  decision_summary: z.string().min(1).optional(),
  matched_conditions: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string().datetime()
});
export type LearningResourceUseRecord = z.infer<typeof LearningResourceUseRecordSchema>;

export const LearningEvaluationRecordSchema = z.object({
  id: z.string().min(1),
  learning_resource_ref: ResourceRefSchema,
  learning_resource_version: z.string().min(1).optional(),
  task_class: z.string().min(1),
  compared_run_ids: z.array(z.string().min(1)),
  before_metrics: z.record(z.string(), z.number()),
  after_metrics: z.record(z.string(), z.number()),
  effect_estimate: z.number(),
  confidence: z.number().min(0).max(1),
  assessment: LearningAssessmentSchema,
  /** `legacy` retains the prior score-comparison reader without treating it as Core 05 evidence. */
  evaluation_kind: z.enum(["legacy", "applied"]).optional(),
  applied_run_id: z.string().min(1).optional(),
  activity_context: ActivityContextRefSchema.optional(),
  matched_conditions: z.array(z.string().min(1)).optional(),
  affected_decision: z.string().min(1).optional(),
  predicted_result: z.string().min(1).optional(),
  actual_result: z.string().min(1).optional(),
  prediction_assessment: LearningEvaluationVerdictSchema.optional(),
  causal_assessment: LearningEvaluationVerdictSchema.optional(),
  evidence_refs: z.array(ResourceRefSchema),
  evaluator: z.string().min(1),
  created_at: z.string().datetime()
}).strict();
export type LearningEvaluationRecord = z.infer<typeof LearningEvaluationRecordSchema>;

/** Immutable metadata for one resource version.  Current bodies remain in their normal Workspace files. */
export const LearningResourceVersionRecordSchema = z.object({
  id: z.string().min(1),
  resource_kind: z.enum(["memory", "wiki", "skill"]),
  resource_id: z.string().min(1),
  version: z.string().min(1),
  parent_version: z.string().min(1).optional(),
  file_path: z.string().min(1),
  content_hash: z.string().min(1),
  change_reason: z.string().min(1),
  source_run_ids: z.array(z.string().min(1)),
  actor: z.string().min(1),
  is_current: z.boolean(),
  restored_from_version: z.string().min(1).optional(),
  created_at: z.string().datetime()
}).strict();
export type LearningResourceVersionRecord = z.infer<typeof LearningResourceVersionRecordSchema>;

export const SkillOptimizationExampleSchema = z.object({
  id: z.string().min(1),
  skill_id: z.string().min(1),
  prompt: z.string().min(1),
  expected_behavior: z.string().min(1),
  feedback: z.string().min(1),
  source: z.enum(skillOptimizationDatasetSources),
  split: z.enum(skillOptimizationDatasetSplits),
  skill_body_read_run_id: z.string().min(1).optional(),
  trace_refs: z.array(ResourceRefSchema),
  metadata: z.record(jsonValueSchema),
  created_at: z.string().datetime()
}).superRefine((value, ctx) => {
  if (value.source !== "synthetic" && !value.skill_body_read_run_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skill_body_read_run_id"], message: "real_or_golden_example_requires_skill_body_read_run" });
  }
});
export type SkillOptimizationExample = z.infer<typeof SkillOptimizationExampleSchema>;

export const SkillOptimizationDatasetSchema = z.object({
  id: z.string().min(1),
  skill_id: z.string().min(1),
  examples: z.array(SkillOptimizationExampleSchema).min(20),
  split_counts: z.object({ train: z.number().int().nonnegative(), validation: z.number().int().nonnegative(), holdout: z.number().int().nonnegative() }),
  holdout_non_synthetic_count: z.number().int().nonnegative(),
  created_at: z.string().datetime()
}).superRefine((value, ctx) => {
  const total = value.split_counts.train + value.split_counts.validation + value.split_counts.holdout;
  if (total !== value.examples.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["split_counts"], message: "dataset_split_counts_mismatch" });
  }
  if (value.split_counts.train < 12 || value.split_counts.validation < 4 || value.split_counts.holdout < 4) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["split_counts"], message: "dataset_split_minimum_not_met" });
  }
  if (value.holdout_non_synthetic_count < 1 || !value.examples.some((example) => example.split === "holdout" && example.source !== "synthetic")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["holdout_non_synthetic_count"], message: "holdout_must_include_real_or_golden_example" });
  }
});
export type SkillOptimizationDataset = z.infer<typeof SkillOptimizationDatasetSchema>;

export const SkillOptimizationRunSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  target_skill_id: z.string().min(1),
  baseline_content_hash: z.string().min(1),
  baseline_version: z.string().min(1),
  dataset_id: z.string().min(1),
  objective_id: z.string().min(1),
  work_item_id: z.string().min(1),
  optimizer: z.literal("gepa"),
  optimizer_version: z.string().min(1),
  status: z.enum(skillOptimizationRunStatuses),
  phase: z.enum(["dataset", "optimizing", "evaluating", "awaiting_confirmation", "promoting", "completed", "failed", "cancelled"]),
  progress: z.number().min(0).max(1),
  candidate_ids: z.array(z.string().min(1)),
  trace_refs: z.array(ResourceRefSchema),
  provenance: z.record(jsonValueSchema),
  error: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional()
});
export type SkillOptimizationRun = z.infer<typeof SkillOptimizationRunSchema>;

export const OptimizationCandidateSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  skill_id: z.string().min(1),
  parent_candidate_id: z.string().min(1).optional(),
  body: z.string().min(1),
  content_hash: z.string().min(1),
  baseline_holdout_score: z.number().min(0).max(100),
  holdout_score: z.number().min(0).max(100),
  holdout_delta: z.number(),
  feedback: z.array(z.string().min(1)),
  dataset_id: z.string().min(1),
  trace_refs: z.array(ResourceRefSchema),
  safety: z.object({ related_tests_passed: z.boolean(), safety_checks_passed: z.boolean(), important_regression: z.boolean() }),
  status: z.enum(skillOptimizationCandidateStatuses),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type OptimizationCandidate = z.infer<typeof OptimizationCandidateSchema>;

export const OptimizationEvaluationSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  candidate_id: z.string().min(1),
  split: z.enum(skillOptimizationDatasetSplits),
  score: z.number().min(0).max(100),
  feedback: z.array(z.string().min(1)),
  important_regression: z.boolean(),
  related_tests_passed: z.boolean(),
  safety_checks_passed: z.boolean(),
  trace_refs: z.array(ResourceRefSchema),
  created_at: z.string().datetime()
});
export type OptimizationEvaluation = z.infer<typeof OptimizationEvaluationSchema>;

export const SkillOptimizationSnapshotSchema = z.object({
  id: z.string().min(1),
  skill_id: z.string().min(1),
  run_id: z.string().min(1),
  candidate_id: z.string().min(1),
  content_hash: z.string().min(1),
  markdown: z.string().min(1),
  created_at: z.string().datetime(),
  restored_at: z.string().datetime().optional()
});
export type SkillOptimizationSnapshot = z.infer<typeof SkillOptimizationSnapshotSchema>;

export const OptimizationPromotionSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  candidate_id: z.string().min(1),
  skill_id: z.string().min(1),
  snapshot_id: z.string().min(1),
  expected_content_hash: z.string().min(1),
  promoted_content_hash: z.string().min(1),
  status: z.enum(["promoted", "rejected", "rolled_back", "conflict"]),
  provenance: z.record(jsonValueSchema),
  created_at: z.string().datetime()
});
export type OptimizationPromotion = z.infer<typeof OptimizationPromotionSchema>;

export const BackgroundReviewProvenanceSchema = z.object({
  origin: z.literal("background_review"),
  source_run_id: z.string().min(1),
  source_session_id: z.string().min(1),
  activity_context: ActivityContextRefSchema.optional(),
  review_run_id: z.string().min(1),
  before_version: z.string().optional(),
  after_version: z.string().min(1),
  reason_summary: z.string(),
  evidence_refs: z.array(ResourceRefSchema)
});
export type BackgroundReviewProvenance = z.infer<typeof BackgroundReviewProvenanceSchema>;

export const BackgroundReviewChangeRecordSchema = BackgroundReviewProvenanceSchema.extend({
  id: z.string().min(1),
  mutation_kind: z.enum(["memory_add", "memory_replace", "memory_remove", "skill_create", "skill_patch", "skill_support_write", "wiki_create", "wiki_patch", "wiki_archive", "wiki_merge"]),
  resource_ref: ResourceRefSchema,
  created_at: z.string().datetime()
});
export type BackgroundReviewChangeRecord = z.infer<typeof BackgroundReviewChangeRecordSchema>;

export const LearningSnapshotRecordSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  path: z.string().min(1),
  resource_counts: z.object({ memory: z.number().int().nonnegative(), skills: z.number().int().nonnegative(), support_files: z.number().int().nonnegative(), wiki: z.number().int().nonnegative().default(0) }),
  created_at: z.string().datetime(),
  restored_at: z.string().datetime().optional()
});
export type LearningSnapshotRecord = z.infer<typeof LearningSnapshotRecordSchema>;

export const LearningResourceEdgeRecordSchema = z.object({
  id: z.string().min(1),
  from_ref: ResourceRefSchema,
  to_ref: ResourceRefSchema,
  relation: z.enum(["duplicate", "overlaps", "conflicts", "supersedes", "derived_from"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)),
  curator_run_id: z.string().min(1),
  created_at: z.string().datetime()
});
export type LearningResourceEdgeRecord = z.infer<typeof LearningResourceEdgeRecordSchema>;

export const LearningJobReportRecordSchema = z.object({
  id: z.string().min(1),
  job_kind: z.enum(["background_review", "evaluation", "curator"]),
  run_id: z.string().min(1),
  target_resource_count: z.number().int().nonnegative(),
  mutation_count: z.number().int().nonnegative(),
  archive_count: z.number().int().nonnegative(),
  restore_count: z.number().int().nonnegative(),
  patch_count: z.number().int().nonnegative(),
  merge_count: z.number().int().nonnegative(),
  skipped_reasons: z.record(z.string(), z.number().int().nonnegative()),
  evaluation_count: z.number().int().nonnegative(),
  snapshot_id: z.string().optional(),
  duration_ms: z.number().int().nonnegative(),
  failure: z.string().optional(),
  next_run_at: z.string().datetime().optional(),
  created_at: z.string().datetime()
});
export type LearningJobReportRecord = z.infer<typeof LearningJobReportRecordSchema>;

export const SkillViewInputSchema = z.object({
  skill_id: z.string().min(1),
  path: z.string().min(1).optional(),
  run_id: z.string().min(1)
});
export type SkillViewInput = z.infer<typeof SkillViewInputSchema>;

export const SkillDiagnosticsIssueSchema = z.object({
  code: z.enum([
    "selectable_skill_empty_markdown",
    "selectable_skill_missing_provenance_detail",
    "selectable_skill_unverified_provenance",
    "selectable_skill_missing_source_refs",
    "selectable_skill_missing_allowed_scopes",
    "selectable_skill_unsupported_scope",
    "selectable_skill_empty_support_file",
    "selectable_skill_never_used"
  ]),
  severity: z.enum(["warning", "critical"]),
  skill_id: z.string().min(1),
  title: z.string(),
  state: SkillStateSchema,
  message: z.string()
});
export type SkillDiagnosticsIssue = z.infer<typeof SkillDiagnosticsIssueSchema>;

export const SkillDiagnosticsReportSchema = z.object({
  generated_at: z.string().datetime(),
  total_skills: z.number().int().nonnegative(),
  selectable_skills: z.number().int().nonnegative(),
  state_counts: z.record(z.number().int().nonnegative()),
  selectable_with_verified_provenance: z.number().int().nonnegative(),
  selectable_with_source_refs: z.number().int().nonnegative(),
  selectable_with_support_files: z.number().int().nonnegative(),
  selectable_with_usage: z.number().int().nonnegative(),
  selected_resource_uses: z.number().int().nonnegative().optional(),
  body_loaded_resource_uses: z.number().int().nonnegative().optional(),
  support_loaded_resource_uses: z.number().int().nonnegative().optional(),
  session_search_mode: z.enum(["fts5_trigram", "fts5", "like"]).optional(),
  empty_support_files: z.number().int().nonnegative(),
  issues: z.array(SkillDiagnosticsIssueSchema),
  recommendation: z.string()
});
export type SkillDiagnosticsReport = z.infer<typeof SkillDiagnosticsReportSchema>;

export const CuratorStateRecordSchema = z.object({
  id: z.literal("default"),
  paused: z.boolean(),
  interval_hours: z.number().int().positive(),
  min_idle_hours: z.number().nonnegative(),
  stale_after_days: z.number().int().positive(),
  archive_after_days: z.number().int().positive(),
  last_run_at: z.string().datetime().optional(),
  last_run_summary: z.string().optional(),
  run_count: z.number().int().nonnegative(),
  updated_at: z.string().datetime()
});
export type CuratorStateRecord = z.infer<typeof CuratorStateRecordSchema>;

export const CuratorLifecycleActionSchema = z.enum(["review", "mark_stale", "archive", "reactivate"]);
export type CuratorLifecycleAction = z.infer<typeof CuratorLifecycleActionSchema>;

export const CuratorLifecycleReportSchema = z.object({
  id: z.string().min(1),
  checked_at: z.string().datetime(),
  dry_run: z.boolean(),
  paused: z.boolean(),
  snapshot_id: z.string().min(1).optional(),
  evaluation_count: z.number().int().nonnegative().optional(),
  applied_mutation_count: z.number().int().nonnegative().optional(),
  skipped_reason: z.string().optional(),
  thresholds: z.object({
    stale_after_days: z.number().int().positive(),
    archive_after_days: z.number().int().positive(),
    min_idle_hours: z.number().nonnegative()
  }).strict(),
  counts: z.object({
    memory_items: z.number().int().nonnegative(),
    wiki_pages: z.number().int().nonnegative(),
    skill_items: z.number().int().nonnegative(),
    skill_usage_rows: z.number().int().nonnegative(),
    suggestions: z.number().int().nonnegative()
  }).strict(),
  skill_actions: z.array(z.object({
    skill_id: z.string().min(1),
    title: z.string(),
    current_state: SkillStateSchema,
    proposed_state: SkillStateSchema.optional(),
    action: CuratorLifecycleActionSchema,
    reason: z.string(),
    usage_count: z.number().int().nonnegative(),
    last_activity_at: z.string().datetime().optional(),
    owner_pinned: z.boolean(),
    suggestion_id: z.string().optional()
  }).strict()),
  protected_skills: z.array(z.object({
    skill_id: z.string().min(1),
    title: z.string(),
    state: SkillStateSchema,
    reason: z.literal("owner_pinned")
  }).strict())
}).strict();
export type CuratorLifecycleReport = z.infer<typeof CuratorLifecycleReportSchema>;

export const CuratorReviewReportSchema = z.object({
  id: z.string().min(1),
  checked_at: z.string().datetime(),
  dry_run: z.boolean(),
  counts: z.object({
    keep_candidates: z.number().int().nonnegative(),
    patch_candidates: z.number().int().nonnegative(),
    consolidate_candidates: z.number().int().nonnegative(),
    archive_candidates: z.number().int().nonnegative()
  }).strict(),
  keep_candidates: z.array(z.object({
    kind: z.enum(["memory", "knowledge_wiki", "skill"]),
    id: z.string().min(1),
    title: z.string(),
    reason: z.string()
  }).strict()),
  memory_merge_groups: z.array(z.object({
    topic: z.string(),
    memory_ids: z.array(z.string().min(1)),
    reason: z.string(),
    suggestion_id: z.string().optional()
  }).strict()),
  skill_consolidation_groups: z.array(z.object({
    group_key: z.string().min(1),
    skill_ids: z.array(z.string().min(1)),
    suggested_umbrella_title: z.string(),
    reason: z.string(),
    suggestion_id: z.string().optional()
  }).strict()),
  wiki_patch_proposals: z.array(z.object({
    wiki_id: z.string().min(1),
    title: z.string(),
    reason: z.string(),
    suggestion_id: z.string().optional()
  }).strict()),
  archive_candidates: z.array(z.object({
    kind: z.enum(["memory", "knowledge_wiki", "skill"]),
    id: z.string().min(1),
    title: z.string(),
    reason: z.string(),
    suggestion_id: z.string().optional()
  }).strict())
}).strict();
export type CuratorReviewReport = z.infer<typeof CuratorReviewReportSchema>;

export const EvaluationFindingKindSchema = z.enum([
  "run_failed",
  "run_cancelled",
  "waiting_for_input",
  "tool_not_completed",
  "no_workspace_effect",
  "no_events",
  "external_judge"
]);
export type EvaluationFindingKind = z.infer<typeof EvaluationFindingKindSchema>;

export const EvaluationTraceReportSchema = z.object({
  id: z.string().min(1),
  checked_at: z.string().datetime(),
  judge: z.object({
    deterministic_status: z.literal("completed"),
    external_status: z.enum(["not_configured", "completed", "failed"]),
    provider_id: z.string().optional(),
    summary: z.string()
  }).strict(),
  counts: z.object({
    backend_runs: z.number().int().nonnegative(),
    backend_events: z.number().int().nonnegative(),
    workspace_changes: z.number().int().nonnegative(),
    tool_runs: z.number().int().nonnegative(),
    audit_records: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
    comparisons: z.number().int().nonnegative()
  }).strict(),
  run_scores: z.array(z.object({
    run_id: z.string().min(1),
    backend_id: z.string(),
    status: BackendRunStatusSchema,
    score: z.number().int().min(0).max(100),
    verdict: z.enum(["pass", "warn", "fail"]),
    findings: z.array(z.object({
      kind: EvaluationFindingKindSchema,
      severity: z.enum(["info", "warning", "critical"]),
      reason: z.string(),
      resource_refs: z.array(ResourceRefSchema)
    }).strict()),
    suggested_improvements: z.array(z.string())
  }).strict()),
  comparisons: z.array(z.object({
    current_run_id: z.string().min(1),
    baseline_run_id: z.string().min(1).optional(),
    result: z.enum(["no_baseline", "same", "improved", "regressed"]),
    reason: z.string()
  }).strict())
}).strict();
export type EvaluationTraceReport = z.infer<typeof EvaluationTraceReportSchema>;

export const EvaluationDiagnosticsIssueSchema = z.object({
  code: z.enum([
    "evaluation_run_missing",
    "evaluation_run_failed",
    "evaluation_run_stale",
    "evaluation_suggestion_pending",
    "backend_run_failed",
    "backend_run_outcome_unknown",
    "backend_run_waiting_for_input",
    "tool_run_attention_required"
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
  reflection_run_id: z.string().min(1).optional(),
  suggestion_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  tool_run_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  resource_ref: ResourceRefSchema.optional(),
  created_at: z.string().datetime().optional()
}).strict();
export type EvaluationDiagnosticsIssue = z.infer<typeof EvaluationDiagnosticsIssueSchema>;

export const EvaluationDiagnosticsReportSchema = z.object({
  generated_at: z.string().datetime(),
  stale_after_hours: z.number().int().positive(),
  total_evaluation_runs: z.number().int().nonnegative(),
  completed_evaluation_runs: z.number().int().nonnegative(),
  failed_evaluation_runs: z.number().int().nonnegative(),
  pending_evaluation_suggestions: z.number().int().nonnegative(),
  backend_runs: z.number().int().nonnegative(),
  failed_backend_runs: z.number().int().nonnegative(),
  waiting_backend_runs: z.number().int().nonnegative(),
  outcome_unknown_backend_runs: z.number().int().nonnegative(),
  tool_runs: z.number().int().nonnegative(),
  ignored_or_failed_tool_runs: z.number().int().nonnegative(),
  workspace_changes: z.number().int().nonnegative(),
  latest_evaluation_run: ReflectionRunRecordSchema.optional(),
  status_counts: z.object({
    evaluation_runs: z.record(z.string(), z.number().int().nonnegative()),
    evaluation_suggestions: z.record(z.string(), z.number().int().nonnegative()),
    backend_runs: z.record(z.string(), z.number().int().nonnegative()),
    tool_runs: z.record(z.string(), z.number().int().nonnegative())
  }),
  issues: z.array(EvaluationDiagnosticsIssueSchema),
  recommendation: z.string()
});
export type EvaluationDiagnosticsReport = z.infer<typeof EvaluationDiagnosticsReportSchema>;

export const ToolRunRecordSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  tool_call_id: z.string().optional(),
  provider_tool_name: z.string().min(1),
  action_id: z.string().optional(),
  status: ToolRunStatusSchema,
  input_summary: z.string(),
  output_summary: z.string(),
  /** Stable machine-readable failure code when status is failed. */
  error_code: z.string().optional(),
  resource_refs: z.array(ResourceRefSchema),
  created_at: z.string().datetime()
}).strict();
export type ToolRunRecord = z.infer<typeof ToolRunRecordSchema>;

export const ToolRunDiagnosticsReasonSchema = z.object({
  reason: z.string(),
  count: z.number().int().nonnegative()
});
export type ToolRunDiagnosticsReason = z.infer<typeof ToolRunDiagnosticsReasonSchema>;

export const ToolRunDiagnosticsGroupSchema = z.object({
  provider_tool_name: z.string().min(1),
  action_id: z.string().optional(),
  status: ToolRunStatusSchema,
  count: z.number().int().nonnegative(),
  latest_tool_run: ToolRunRecordSchema,
  reasons: z.array(ToolRunDiagnosticsReasonSchema)
});
export type ToolRunDiagnosticsGroup = z.infer<typeof ToolRunDiagnosticsGroupSchema>;

export const ToolRunDiagnosticsAdapterRecommendationSchema = z.object({
  provider_tool_name: z.string().min(1),
  action_id: z.string().optional(),
  status: ToolRunStatusSchema,
  count: z.number().int().nonnegative(),
  mapping_status: z.enum(["mapped_provider_tool", "action_id_only", "unmapped_provider_tool"]),
  domain_command_id: z.string().optional(),
  suggested_next_step: z.enum(["route_through_domain_command", "add_provider_tool_mapping", "inspect_failed_domain_command"]),
  reason: z.string()
});
export type ToolRunDiagnosticsAdapterRecommendation = z.infer<typeof ToolRunDiagnosticsAdapterRecommendationSchema>;

export const ToolRunDiagnosticsReportSchema = z.object({
  generated_at: z.string().datetime(),
  scope: z.object({
    run_id: z.string().optional(),
    session_id: z.string().optional(),
    status: ToolRunStatusSchema.optional(),
    limit: z.number().int().positive()
  }),
  total_tool_runs: z.number().int().nonnegative(),
  ignored_or_failed_tool_runs: z.number().int().nonnegative(),
  groups: z.array(ToolRunDiagnosticsGroupSchema),
  repeated_ignored_provider_tools: z.array(ToolRunDiagnosticsGroupSchema),
  adapter_recommendations: z.array(ToolRunDiagnosticsAdapterRecommendationSchema).optional(),
  recommendation: z.string()
});
export type ToolRunDiagnosticsReport = z.infer<typeof ToolRunDiagnosticsReportSchema>;

export const AutomationJobRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "custom_instruction", "resource_translation"]),
  status: AutomationJobStatusSchema,
  schedule: z.string().min(1),
  target_instruction: z.string().min(1),
  delivery_target: z.record(jsonValueSchema),
  next_run_at: z.string().datetime().optional(),
  last_run_at: z.string().datetime().optional(),
  retry_after_at: z.string().datetime().optional(),
  locked_until: z.string().datetime().optional(),
  failure_count: z.number().int().nonnegative().default(0),
  max_attempts: z.number().int().positive().default(3),
  last_error: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type AutomationJobRecord = z.infer<typeof AutomationJobRecordSchema>;

export const ExternalSendRecordSchema = z.object({
  id: z.string().min(1),
  channel: ExternalSendChannelSchema,
  status: ExternalSendStatusSchema,
  target: z.record(jsonValueSchema),
  title: z.string(),
  body: z.string(),
  operation_id: z.string().optional(),
  approval_request_id: z.string().optional(),
  dispatch_result: z.record(jsonValueSchema).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  dispatched_at: z.string().datetime().optional()
});
export type ExternalSendRecord = z.infer<typeof ExternalSendRecordSchema>;

export const ExternalSendDiagnosticsIssueSchema = z.object({
  code: z.enum([
    "external_send_pending_approval",
    "external_send_dry_run_only",
    "external_send_failed",
    "external_send_stale_draft",
    "external_send_missing_target_url"
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  send_id: z.string().min(1),
  channel: ExternalSendChannelSchema,
  status: ExternalSendStatusSchema,
  title: z.string(),
  message: z.string(),
  resource_ref: ResourceRefSchema.optional()
});
export type ExternalSendDiagnosticsIssue = z.infer<typeof ExternalSendDiagnosticsIssueSchema>;

export const ExternalSendTransportReadinessSchema = z.object({
  channel: ExternalSendChannelSchema,
  status: ExternalSendTransportStatusSchema,
  configured: z.boolean(),
  dispatch_enabled: z.boolean(),
  requires_target_url: z.boolean(),
  message: z.string().min(1)
}).strict();
export type ExternalSendTransportReadiness = z.infer<typeof ExternalSendTransportReadinessSchema>;

export const ExternalSendDiagnosticsReportSchema = z.object({
  generated_at: z.string().datetime(),
  dispatch_enabled: z.boolean(),
  dry_run_default: z.boolean(),
  stale_after_hours: z.number().int().positive(),
  total_sends: z.number().int().nonnegative(),
  pending_approval_sends: z.number().int().nonnegative(),
  failed_sends: z.number().int().nonnegative(),
  dry_run_approved_sends: z.number().int().nonnegative(),
  stale_draft_sends: z.number().int().nonnegative(),
  status_counts: z.record(z.string(), z.number().int().nonnegative()),
  channel_counts: z.record(z.string(), z.number().int().nonnegative()),
  transport_status_counts: z.record(z.string(), z.number().int().nonnegative()),
  transport_readiness: z.array(ExternalSendTransportReadinessSchema),
  issues: z.array(ExternalSendDiagnosticsIssueSchema),
  recommendation: z.string()
});
export type ExternalSendDiagnosticsReport = z.infer<typeof ExternalSendDiagnosticsReportSchema>;

export const GatewayPairingRecordSchema = z.object({
  id: z.string().min(1),
  channel: GatewayChannelSchema,
  source_identity: z.string().min(1),
  source_label: z.string(),
  status: GatewayPairingStatusSchema,
  pairing_code: z.string().optional(),
  session_key: z.string().min(1),
  metadata: z.record(jsonValueSchema),
  requested_at: z.string().datetime(),
  expires_at: z.string().datetime().optional(),
  resolved_at: z.string().datetime().optional(),
  revoked_at: z.string().datetime().optional(),
  updated_at: z.string().datetime()
});
export type GatewayPairingRecord = z.infer<typeof GatewayPairingRecordSchema>;

export const GatewayPairingPolicyRecordSchema = z.object({
  id: z.string().min(1),
  channel: GatewayChannelSchema,
  status: GatewayPairingPolicyStatusSchema,
  trust_mode: GatewayPairingTrustModeSchema,
  allowlist: z.array(z.string().min(1)),
  /** Server-owned allowlist for Backend tools reached through this channel. */
  allowed_tools: z.array(z.string().min(1)),
  pairing_ttl_ms: z.number().int().positive().optional(),
  duplicate_window_ms: z.number().int().positive().optional(),
  rate_limit_window_ms: z.number().int().positive().optional(),
  rate_limit_max: z.number().int().positive().optional(),
  metadata: z.record(jsonValueSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type GatewayPairingPolicyRecord = z.infer<typeof GatewayPairingPolicyRecordSchema>;

export const GatewayRoutingPolicyRecordSchema = z.object({
  id: z.string().min(1),
  channel: GatewayChannelSchema,
  status: GatewayRoutingPolicyStatusSchema,
  session_key_strategy: GatewayRoutingSessionKeyStrategySchema,
  default_account_id: z.string().min(1).optional(),
  default_thread_id: z.string().min(1).optional(),
  default_route: z.string().min(1),
  metadata: z.record(jsonValueSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type GatewayRoutingPolicyRecord = z.infer<typeof GatewayRoutingPolicyRecordSchema>;

export const GatewayInboundMessageRecordSchema = z.object({
  id: z.string().min(1),
  channel: GatewayChannelSchema,
  source_identity: z.string().min(1),
  body: z.string(),
  status: GatewayInboundStatusSchema,
  trusted: z.boolean(),
  session_key: z.string().optional(),
  pairing_id: z.string().optional(),
  message_id: z.string().optional(),
  error: z.string().optional(),
  metadata: z.record(jsonValueSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type GatewayInboundMessageRecord = z.infer<typeof GatewayInboundMessageRecordSchema>;

export const GatewayDeliveryRecordSchema = z.object({
  id:z.string().min(1),inbound_id:z.string().min(1).optional(),session_key:z.string().min(1),channel:GatewayChannelSchema,
  status:z.enum(["pending","delivering","retry_wait","delivered","failed"]),idempotency_key:z.string().min(1),payload:z.record(jsonValueSchema),
  attempt:z.number().int().nonnegative(),max_attempts:z.number().int().positive(),next_attempt_at:z.string().datetime().optional(),lease_until:z.string().datetime().optional(),
  receipt:z.record(jsonValueSchema).optional(),last_error:z.string().optional(),created_at:z.string().datetime(),updated_at:z.string().datetime(),delivered_at:z.string().datetime().optional()
});
export type GatewayDeliveryRecord=z.infer<typeof GatewayDeliveryRecordSchema>;

export const SecretRefSchema = z.object({
  id: z.string().min(1),
  source: SecretRefSourceSchema,
  provider: z.string().min(1),
  key: z.string().min(1),
  label: z.string().optional(),
  scope: z.string().optional(),
  created_at: z.string().datetime().optional()
}).strict();
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const GatewayMcpSecretFileBindingSchema = z.object({
  secret_ref_id: z.string().min(1),
  filename: z.string().min(1),
  env: z.string().min(1),
  mode: z.number().int().positive().optional()
}).strict();
export type GatewayMcpSecretFileBinding = z.infer<typeof GatewayMcpSecretFileBindingSchema>;

export const GatewayMcpStdioConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).default({}),
  secret_env: z.record(z.string().min(1)).default({}),
  secret_files: z.array(GatewayMcpSecretFileBindingSchema).default([]),
  framing: GatewayMcpStdioFramingSchema.default("json_lines"),
  initialize: z.boolean().default(true),
  timeout_ms: z.number().int().positive().optional()
}).strict();
export type GatewayMcpStdioConfig = z.infer<typeof GatewayMcpStdioConfigSchema>;

export const GatewayMcpHttpConfigSchema = z.object({
  endpoint_url: z.string().url(),
  headers: z.record(z.string()).default({}),
  secret_headers: z.record(z.string().min(1)).default({}),
  timeout_ms: z.number().int().positive().optional()
}).strict();
export type GatewayMcpHttpConfig = z.infer<typeof GatewayMcpHttpConfigSchema>;

const GatewayMcpConfigRecordBaseShape = {
  id: z.string().min(1),
  server_name: z.string().min(1),
  enabled: z.boolean(),
  allowed_tools: z.array(z.string().min(1)),
  config_ref: ResourceRefSchema.optional(),
  secret_refs: z.array(SecretRefSchema),
  metadata: z.record(jsonValueSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
};
export const GatewayMcpConfigRecordSchema = z.discriminatedUnion("transport", [
  z.object({ ...GatewayMcpConfigRecordBaseShape, transport: z.literal("stdio"), stdio: GatewayMcpStdioConfigSchema, http: z.never().optional() }).strict(),
  z.object({ ...GatewayMcpConfigRecordBaseShape, transport: z.literal("http"), http: GatewayMcpHttpConfigSchema, stdio: z.never().optional() }).strict()
]);
export type GatewayMcpConfigRecord = z.infer<typeof GatewayMcpConfigRecordSchema>;

export const GatewayMcpConfigSummarySchema = z.object({
  id: z.string().min(1),
  server_name: z.string().min(1),
  transport: GatewayMcpTransportSchema,
  enabled: z.boolean(),
  allowed_tools: z.array(z.string().min(1)),
  config_ref: ResourceRefSchema.optional(),
  secret_ref_ids: z.array(z.string().min(1)),
  has_stdio: z.boolean(),
  has_http: z.boolean(),
  timeout_ms: z.number().int().positive().optional(),
  metadata: z.record(jsonValueSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type GatewayMcpConfigSummary = z.infer<typeof GatewayMcpConfigSummarySchema>;

export const SandboxPathAccessRuleSchema = z.object({
  root: z.string().min(1),
  access: SandboxWorkspaceAccessSchema.exclude(["none"]),
  description: z.string().optional()
}).strict();
export type SandboxPathAccessRule = z.infer<typeof SandboxPathAccessRuleSchema>;

export const SandboxPolicySchema = z.object({
  mode: SandboxModeSchema,
  scope: SandboxScopeSchema,
  backend: SandboxBackendSchema,
  workspace_access: SandboxWorkspaceAccessSchema,
  network_access: SandboxNetworkAccessSchema,
  allowed_paths: z.array(SandboxPathAccessRuleSchema),
  denied_paths: z.array(z.string().min(1)),
  timeout_ms: z.number().int().positive().optional(),
  metadata: z.record(jsonValueSchema)
}).strict();
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;

export const McpConfigRefSchema = z.object({
  id: z.string().min(1),
  server_name: z.string().min(1),
  config_ref: ResourceRefSchema.optional(),
  allowed_tools: z.array(z.string().min(1)),
  secret_refs: z.array(SecretRefSchema)
}).strict();
export type McpConfigRef = z.infer<typeof McpConfigRefSchema>;

export const McpRuntimeConfigRefSchema = z.object({
  id: z.string().min(1),
  server_name: z.string().min(1),
  config_ref: ResourceRefSchema.optional(),
  allowed_tools: z.array(z.string().min(1)),
  secret_ref_ids: z.array(z.string().min(1))
}).strict();
export type McpRuntimeConfigRef = z.infer<typeof McpRuntimeConfigRefSchema>;

export const PathNormalizationPolicySchema = z.object({
  canonical_root: z.string().min(1),
  reject_absolute_paths: z.boolean(),
  reject_parent_segments: z.boolean(),
  allowed_roots: z.array(z.string().min(1)),
  denied_roots: z.array(z.string().min(1))
}).strict();
export type PathNormalizationPolicy = z.infer<typeof PathNormalizationPolicySchema>;

export const ConcurrencyLockPolicySchema = z.object({
  scope: ConcurrencyLockScopeSchema,
  key: z.string().min(1),
  ttl_ms: z.number().int().positive()
}).strict();
export type ConcurrencyLockPolicy = z.infer<typeof ConcurrencyLockPolicySchema>;

export const GatewayBoundaryPolicySchema = z.object({
  id: z.string().min(1),
  source_channel: GatewayBoundarySourceSchema,
  source_identity: z.string().optional(),
  session_key: z.string().min(1),
  allowed_tools: z.array(z.string().min(1)),
  mcp_config_refs: z.array(McpConfigRefSchema),
  secret_refs: z.array(SecretRefSchema),
  sandbox: SandboxPolicySchema,
  path_normalization: PathNormalizationPolicySchema,
  allowlist: z.array(z.string().min(1)),
  timeout_ms: z.number().int().positive().optional(),
  concurrency_lock: ConcurrencyLockPolicySchema.optional(),
  metadata: z.record(jsonValueSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type GatewayBoundaryPolicy = z.infer<typeof GatewayBoundaryPolicySchema>;

export const GatewayBoundaryRuntimeSnapshotSchema = z.object({
  policy_id: z.string().min(1),
  source_channel: GatewayBoundarySourceSchema,
  source_identity: z.string().optional(),
  session_key: z.string().min(1),
  allowed_tools: z.array(z.string().min(1)),
  mcp_config_refs: z.array(McpRuntimeConfigRefSchema),
  secret_ref_ids: z.array(z.string().min(1)),
  sandbox: SandboxPolicySchema,
  path_normalization: PathNormalizationPolicySchema,
  allowlist: z.array(z.string().min(1)),
  timeout_ms: z.number().int().positive().optional(),
  concurrency_lock: ConcurrencyLockPolicySchema.optional(),
  created_at: z.string().datetime()
}).strict();
export type GatewayBoundaryRuntimeSnapshot = z.infer<typeof GatewayBoundaryRuntimeSnapshotSchema>;

export const GatewaySandboxInstanceRecordSchema = z.object({
  id: z.string().min(1),
  instance_key: z.string().min(1),
  scope: SandboxScopeSchema,
  backend: SandboxBackendSchema,
  status: GatewaySandboxInstanceStatusSchema,
  sandbox: SandboxPolicySchema,
  session_key: z.string().min(1).optional(),
  owner_ref: ResourceRefSchema.optional(),
  workspace_root: z.string().min(1).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_used_at: z.string().datetime().optional(),
  deleted_at: z.string().datetime().optional(),
  metadata: z.record(jsonValueSchema)
}).strict();
export type GatewaySandboxInstanceRecord = z.infer<typeof GatewaySandboxInstanceRecordSchema>;

export const GatewaySandboxWorkspaceSyncRecordSchema = z.object({
  id: z.string().min(1),
  instance_id: z.string().min(1),
  instance_key: z.string().min(1),
  direction: GatewaySandboxWorkspaceSyncDirectionSchema,
  status: GatewaySandboxWorkspaceSyncStatusSchema,
  workspace_root: z.string().min(1).optional(),
  remote_workspace_root: z.string().min(1).optional(),
  file_count: z.number().int().nonnegative().optional(),
  byte_count: z.number().int().nonnegative().optional(),
  error: z.string().min(1).optional(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  metadata: z.record(jsonValueSchema)
}).strict();
export type GatewaySandboxWorkspaceSyncRecord = z.infer<typeof GatewaySandboxWorkspaceSyncRecordSchema>;

export const GatewaySandboxWorkspaceSyncResultSchema = z.object({
  dry_run: z.boolean(),
  sync: GatewaySandboxWorkspaceSyncRecordSchema
}).strict();
export type GatewaySandboxWorkspaceSyncResult = z.infer<typeof GatewaySandboxWorkspaceSyncResultSchema>;

export const GatewayConcurrencyLockRecordSchema = z.object({
  id: z.string().min(1),
  lock_key: z.string().min(1),
  scope: ConcurrencyLockScopeSchema,
  policy_id: z.string().min(1).optional(),
  owner_ref: ResourceRefSchema.optional(),
  status: GatewayConcurrencyLockStatusSchema,
  acquired_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  released_at: z.string().datetime().optional(),
  metadata: z.record(jsonValueSchema)
}).strict();
export type GatewayConcurrencyLockRecord = z.infer<typeof GatewayConcurrencyLockRecordSchema>;

export const GatewayDiagnosticsIssueSchema = z.object({
  code: z.enum([
    "gateway_pending_pairing",
    "gateway_blocked_inbound",
    "gateway_failed_inbound",
    "gateway_active_concurrency_lock",
    "gateway_expired_concurrency_lock",
    "gateway_failed_sandbox_instance",
    "gateway_failed_sandbox_workspace_sync",
    "gateway_pairing_policy_without_routing_policy",
    "gateway_routing_policy_without_pairing_policy"
  ]),
  severity: z.enum(["warning", "critical"]),
  resource_kind: z.enum([
    "pairing",
    "pairing_policy",
    "routing_policy",
    "inbound_message",
    "concurrency_lock",
    "sandbox_instance",
    "sandbox_workspace_sync"
  ]),
  resource_id: z.string().min(1),
  message: z.string()
});
export type GatewayDiagnosticsIssue = z.infer<typeof GatewayDiagnosticsIssueSchema>;

export const GatewayDiagnosticsReportSchema = z.object({
  generated_at: z.string().datetime(),
  total_pairings: z.number().int().nonnegative(),
  pending_pairings: z.number().int().nonnegative(),
  approved_pairings: z.number().int().nonnegative(),
  pairing_policies: z.number().int().nonnegative(),
  routing_policies: z.number().int().nonnegative(),
  inbound_messages: z.number().int().nonnegative(),
  blocked_inbound_messages: z.number().int().nonnegative(),
  failed_inbound_messages: z.number().int().nonnegative(),
  boundary_policies: z.number().int().nonnegative(),
  mcp_configs: z.number().int().nonnegative(),
  concurrency_locks: z.number().int().nonnegative(),
  active_concurrency_locks: z.number().int().nonnegative(),
  expired_active_concurrency_locks: z.number().int().nonnegative(),
  sandbox_instances: z.number().int().nonnegative(),
  failed_sandbox_instances: z.number().int().nonnegative(),
  sandbox_workspace_syncs: z.number().int().nonnegative(),
  failed_sandbox_workspace_syncs: z.number().int().nonnegative(),
  status_counts: z.object({
    pairings: z.record(z.number().int().nonnegative()),
    pairing_policies: z.record(z.number().int().nonnegative()),
    routing_policies: z.record(z.number().int().nonnegative()),
    inbound_messages: z.record(z.number().int().nonnegative()),
    concurrency_locks: z.record(z.number().int().nonnegative()),
    sandbox_instances: z.record(z.number().int().nonnegative()),
    sandbox_workspace_syncs: z.record(z.number().int().nonnegative())
  }),
  issues: z.array(GatewayDiagnosticsIssueSchema),
  recommendation: z.string()
});
export type GatewayDiagnosticsReport = z.infer<typeof GatewayDiagnosticsReportSchema>;

export const GatewayRepairActionSchema = z.object({
  action: z.enum(["expire_pairing", "expire_concurrency_lock"]),
  status: z.enum(["planned", "applied", "skipped"]),
  reason: z.string().min(1),
  target_ref: ResourceRefSchema,
  before_status: z.string().min(1).optional(),
  after_status: z.string().min(1).optional(),
  metadata: z.record(jsonValueSchema)
}).strict();
export type GatewayRepairAction = z.infer<typeof GatewayRepairActionSchema>;

export const GatewayRepairResultSchema = z.object({
  dry_run: z.boolean(),
  checked_at: z.string().datetime(),
  applied_count: z.number().int().nonnegative(),
  actions: z.array(GatewayRepairActionSchema)
}).strict();
export type GatewayRepairResult = z.infer<typeof GatewayRepairResultSchema>;

export const DomainContractProvenanceSchema = z.object({
  source: z.enum(["mulmoclaude", "hermes", "openclaw", "samurai"]),
  commit_sha: z.string().min(1),
  reference_file: z.string().min(1),
  decision: z.enum(["adopted", "adapted", "not_adopted"]),
  reason: z.string().min(1)
}).strict();
export type DomainContractProvenance = z.infer<typeof DomainContractProvenanceSchema>;

export const ActionCatalogEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["command", "query"]).default("command"),
  contract_version: z.string().min(1).default("1.0"),
  contract_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  availability: z.enum(["active", "deprecated_command"]).default("active"),
  runtime_requirements: z.array(z.enum(["agent_backend", "pdf_export", "browser_adapter", "plugin_runtime"])).default([]),
  title: z.string().min(1),
  display_name: z.string().optional(),
  description: z.string(),
  input_schema: z.record(jsonValueSchema),
  output_schema: z.record(jsonValueSchema),
  allowed_sources: z.array(z.string().min(1)).default([]),
  effect_kind: z.enum(["workspace_mutation", "external_effect", "runtime_control", "read_only"]).default("runtime_control"),
  idempotency_policy: z.enum(["required", "optional", "none", "external"]).default("optional"),
  concurrency_policy: z.enum(["optimistic_version", "state_transition", "append_or_unique", "external_idempotency", "none"]).default("none"),
  render_kinds: z.array(z.string().min(1)).default([]),
  provenance: z.array(DomainContractProvenanceSchema).default([]),
  resource_kinds: z.array(z.string()),
  handler_id: z.string().min(1).optional(),
  implementation_target: z.string().optional(),
  ui_display_category: z.string().optional()
});
export type ActionCatalogEntry = z.infer<typeof ActionCatalogEntrySchema>;

export const DomainCommandCatalogDiagnosticIssueSchema = z.object({
  code: z.enum([
    "duplicate_command_id",
    "duplicate_provider_tool_name",
    "duplicate_surface_operation_kind",
    "missing_action_catalog_entry",
    "action_catalog_mismatch",
    "invalid_output_render_kind",
    "empty_input_sources",
    "empty_resource_kinds",
    "empty_proposed_effects",
    "missing_provider_tool_mapping",
    "missing_surface_operation_mapping",
    "missing_handler",
    "strict_schema_violation",
    "deprecated_command_executable"
  ]),
  command_id: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  message: z.string().min(1)
}).strict();
export type DomainCommandCatalogDiagnosticIssue = z.infer<typeof DomainCommandCatalogDiagnosticIssueSchema>;

export const DomainCommandCatalogCoverageSchema = z.object({
  commands: z.number().int().nonnegative(),
  queries: z.number().int().nonnegative().default(0),
  legacy_commands: z.number().int().nonnegative().default(0),
  action_catalog_entries: z.number().int().nonnegative(),
  provider_tool_mappings: z.number().int().nonnegative(),
  surface_operation_mappings: z.number().int().nonnegative(),
  render_kinds: z.array(z.string().min(1)),
  input_sources: z.array(z.string().min(1)),
  strict_schema_rate: z.number().min(0).max(1).default(0),
  generic_schema_count: z.number().int().nonnegative().default(0)
}).strict();
export type DomainCommandCatalogCoverage = z.infer<typeof DomainCommandCatalogCoverageSchema>;

export const DomainCommandCatalogDiagnosticsReportSchema = z.object({
  ok: z.boolean(),
  generated_at: z.string().datetime(),
  coverage: DomainCommandCatalogCoverageSchema,
  issues: z.array(DomainCommandCatalogDiagnosticIssueSchema),
  recommendation: z.string().min(1)
}).strict();
export type DomainCommandCatalogDiagnosticsReport = z.infer<typeof DomainCommandCatalogDiagnosticsReportSchema>;

export const PluginDiagnosticsIssueSchema = z.object({
  code: z.enum([
    "plugin_manifest_load_issue",
    "plugin_without_actions",
    "plugin_entrypoint_not_ready",
    "plugin_unsigned_entrypoint",
    "plugin_signature_untrusted",
    "plugin_missing_handlers"
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  manifest_id: z.string().min(1).optional(),
  file_path: z.string().min(1).optional(),
  issue_code: z.string().min(1).optional(),
  entrypoint_status: z.string().min(1).optional(),
  signature_status: z.string().min(1).optional(),
  missing_handler_ids: z.array(z.string().min(1)).optional(),
  action_ids: z.array(z.string().min(1)).optional(),
  message: z.string().min(1)
}).strict();
export type PluginDiagnosticsIssue = z.infer<typeof PluginDiagnosticsIssueSchema>;

export const PluginDiagnosticsReportSchema = z.object({
  ok: z.boolean(),
  generated_at: z.string().datetime(),
  total_plugins: z.number().int().nonnegative(),
  built_in_plugins: z.number().int().nonnegative(),
  filesystem_plugins: z.number().int().nonnegative(),
  marketplace_plugins: z.number().int().nonnegative(),
  total_actions: z.number().int().nonnegative(),
  filesystem_actions: z.number().int().nonnegative(),
  total_renderers: z.number().int().nonnegative(),
  filesystem_renderers: z.number().int().nonnegative(),
  entrypoint_ready_plugins: z.number().int().nonnegative(),
  entrypoint_not_ready_plugins: z.number().int().nonnegative(),
  unsigned_entrypoint_plugins: z.number().int().nonnegative(),
  untrusted_signature_plugins: z.number().int().nonnegative(),
  plugins_with_missing_handlers: z.number().int().nonnegative(),
  registered_handlers: z.number().int().nonnegative(),
  missing_handlers: z.number().int().nonnegative(),
  load_issue_count: z.number().int().nonnegative(),
  status_counts: z.object({
    sources: z.record(z.string(), z.number().int().nonnegative()),
    kinds: z.record(z.string(), z.number().int().nonnegative()),
    entrypoints: z.record(z.string(), z.number().int().nonnegative()),
    signatures: z.record(z.string(), z.number().int().nonnegative())
  }),
  issues: z.array(PluginDiagnosticsIssueSchema),
  recommendation: z.string().min(1)
}).strict();
export type PluginDiagnosticsReport = z.infer<typeof PluginDiagnosticsReportSchema>;

export const SurfaceRendererRegistryEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  renderer: z.string().optional(),
  version: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  props_schema: z.record(jsonValueSchema),
  actions_schema: z.record(jsonValueSchema).optional(),
  fallback_kind: z.string().optional(),
  category: z.string().optional(),
  metadata: z.record(jsonValueSchema).optional()
});
export type SurfaceRendererRegistryEntry = z.infer<typeof SurfaceRendererRegistryEntrySchema>;

export const PluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  kind: z.enum(["ui", "tool", "collection_action", "backend_connector", "marketplace"]),
  actions: z.array(ActionCatalogEntrySchema),
  renderers: z.array(SurfaceRendererRegistryEntrySchema).optional(),
  resource_kinds: z.array(z.string()),
  entrypoint: z.string().optional(),
  metadata: z.record(jsonValueSchema)
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PolicyEvaluationInputSchema = z.object({
  capability_id: z.string().min(1),
  operation: z.string().min(1),
  actor_identity: ActorIdentitySchema,
  instruction_source: InstructionSourceSchema,
  instruction_authority: z.string().min(1),
  channel: z.string().min(1),
  target_resource_refs: z.array(ResourceRefSchema),
  proposed_effects: z.array(z.string()),
  prior_grants: z.array(z.string()),
  recent_history: z.array(z.string()),
  input_hash: z.string().min(1)
}).strict();
export type PolicyEvaluationInput = z.infer<typeof PolicyEvaluationInputSchema>;

export const CapabilityOperationSchema = z.object({
  operation: z.string().min(1),
  description: z.string(),
  input_schema_ref: z.string(),
  output_schema_ref: z.string(),
  risk: RiskLevelSchema,
  scope: ExecutionScopeSchema,
  reversibility: z.boolean(),
  external_impact: z.boolean(),
  secret_requirement: z.enum(["none", "secret_ref", "strong_approval"]),
  allowed_instruction_sources: z.array(InstructionSourceSchema),
  default_decision: PolicyDecisionSchema
});
export type CapabilityOperation = z.infer<typeof CapabilityOperationSchema>;

export const CapabilityManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string(),
  description: z.string(),
  operations: z.array(CapabilityOperationSchema),
  input_schema: z.record(jsonValueSchema),
  output_schema: z.record(jsonValueSchema),
  ui_surfaces: z.array(z.string()),
  agent_tools: z.array(z.string()),
  permission_policy: z.record(jsonValueSchema),
  secret_policy: z.record(jsonValueSchema),
  audit_policy: z.record(jsonValueSchema),
  rollback_policy: z.record(jsonValueSchema)
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

/** Required together for resources newly created by the Core 05 learning path. */
export const LearningResourceMetadataSchema = z.object({
  evidence_state: LearningEvidenceStateSchema,
  usage_state: LearningUsageStateSchema,
  usage_scope: UsageScopeRefSchema,
  origin_activity_context: ActivityContextRefSchema,
  source_run_ids: z.array(z.string().min(1)).min(1),
  version: z.string().min(1),
  content_hash: z.string().min(1),
  pinned: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type LearningResourceMetadata = z.infer<typeof LearningResourceMetadataSchema>;

export const ExperienceRuleSchema = z.object({
  summary: z.string().min(1),
  conditions: z.array(z.string().min(1)).min(1),
  recommended_action: z.string().min(1),
  predicted_result: z.string().min(1),
  creation_reason: z.string().min(1),
  counterexamples: z.array(z.string().min(1)).default([]),
  exclusion_conditions: z.array(z.string().min(1)).default([]),
  verification_history: z.array(z.string().min(1)).default([]),
  replaces_resource_id: z.string().min(1).optional(),
  replaced_by_resource_id: z.string().min(1).optional()
}).strict();
export type ExperienceRule = z.infer<typeof ExperienceRuleSchema>;

export const MemoryFrontmatterSchema = z.object({
  id: z.string().min(1),
  state: MemoryStateSchema,
  topic: z.string().min(1),
  source: z.string().min(1),
  source_locale: SupportedLocaleSchema,
  content_locale: SupportedLocaleSchema,
  source_kind: InstructionSourceSchema,
  instruction_authority: z.string(),
  quoted_from: z.string().optional(),
  confidence: z.number().min(0).max(1),
  created_by: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_used_at: z.string().datetime().optional(),
  related_memories: z.array(z.string()),
  conflicts_with: z.array(z.string()),
  sensitive_level: z.enum(["none", "low", "high"]),
  usage_scope: UsageScopeRefSchema.optional(),
  source_refs: z.array(ResourceRefSchema).optional(),
  provenance: ProvenanceSchema.optional(),
  evidence_state: LearningEvidenceStateSchema.optional(),
  usage_state: LearningUsageStateSchema.optional(),
  origin_activity_context: ActivityContextRefSchema.optional(),
  source_run_ids: z.array(z.string().min(1)).optional(),
  version: z.string().min(1).optional(),
  content_hash: z.string().min(1).optional(),
  pinned: z.boolean().optional()
}).strict();
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

export const UserModelFactSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
  source_refs: z.array(ResourceRefSchema).min(1).max(5),
  updated_at: z.string().datetime()
});
export type UserModelFact = z.infer<typeof UserModelFactSchema>;

export const UserModelSchema = z.object({
  version: z.number().int().positive(),
  facts: z.array(UserModelFactSchema).max(50)
});
export type UserModel = z.infer<typeof UserModelSchema>;

export const ProfileRecordSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  name: z.string().min(1).max(100),
  workspace_root: z.string().min(1),
  user_model_file: z.string().min(1).default("USER_PROFILE.json"),
  secret_ref_ids: z.array(z.string().min(1)),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type ProfileRecord = z.input<typeof ProfileRecordSchema>;

export const SkillFrontmatterSchema = z.object({
  id: z.string().min(1),
  state: SkillStateSchema,
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  provenance: z.string(),
  trust_level: z.enum(["generated_local", "user_authored", "bundled", "imported", "shared"]),
  allowed_scopes: z.array(ExecutionScopeSchema),
  required_capabilities: z.array(z.string()),
  schedule_policy: z.record(jsonValueSchema),
  secret_policy: z.record(jsonValueSchema),
  last_reviewed_at: z.string().datetime().optional(),
  owner_pinned: z.boolean(),
  usage_scope: UsageScopeRefSchema.optional(),
  source_refs: z.array(ResourceRefSchema).optional(),
  provenance_detail: ProvenanceSchema.optional(),
  evidence_state: LearningEvidenceStateSchema.optional(),
  usage_state: LearningUsageStateSchema.optional(),
  origin_activity_context: ActivityContextRefSchema.optional(),
  source_run_ids: z.array(z.string().min(1)).optional(),
  version: z.string().min(1).optional(),
  content_hash: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional()
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const WikiFrontmatterSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  state: WikiStateSchema,
  content_locale: SupportedLocaleSchema,
  tags: z.array(z.string()),
  source_refs: z.array(ResourceRefSchema),
  provenance: ProvenanceSchema,
  usage_scope: UsageScopeRefSchema.optional(),
  knowledge_kind: LearningKnowledgeKindSchema.optional(),
  experience_rule: ExperienceRuleSchema.optional(),
  evidence_state: LearningEvidenceStateSchema.optional(),
  usage_state: LearningUsageStateSchema.optional(),
  origin_activity_context: ActivityContextRefSchema.optional(),
  source_run_ids: z.array(z.string().min(1)).optional(),
  version: z.string().min(1).optional(),
  content_hash: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type WikiFrontmatter = z.infer<typeof WikiFrontmatterSchema>;

export const ArtifactRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["markdown", "document", "table", "chart", "graph", "image", "pdf", "structured_draft", "generated_report", "note"]),
  locale: SupportedLocaleSchema,
  source_locales: z.array(SupportedLocaleSchema),
  file_ref: ResourceRefSchema,
  metadata: z.record(jsonValueSchema),
  source_operation_id: z.string().min(1),
  created_by: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  body: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  metadata: z.record(jsonValueSchema).optional()
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional(),
  metadata: z.record(jsonValueSchema).optional()
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphDocumentSchema = z.object({
  version: z.literal("1"),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema)
}).superRefine((graph, context) => {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (nodeIds.size !== graph.nodes.length) context.addIssue({ code: "custom", message: "graph_duplicate_node_id" });
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) context.addIssue({ code: "custom", message: "graph_duplicate_edge_id" });
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) context.addIssue({ code: "custom", message: "graph_edge_node_missing" });
  }
});
export type GraphDocument = z.infer<typeof GraphDocumentSchema>;

export const CollectionSchemaSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  labels: z.record(SupportedLocaleSchema, z.string()),
  descriptions: z.record(SupportedLocaleSchema, z.string()),
  fields: z.array(z.record(jsonValueSchema)),
  refs: z.array(z.record(jsonValueSchema)),
  embeds: z.array(z.record(jsonValueSchema)),
  derived_fields: z.array(z.record(jsonValueSchema)),
  triggers: z.array(z.record(jsonValueSchema)),
  actions: z.array(z.record(jsonValueSchema)),
  views: z.array(z.record(jsonValueSchema)).optional(),
  permissions: z.record(jsonValueSchema)
});
export type CollectionSchema = z.infer<typeof CollectionSchemaSchema>;

export const CollectionRecordSchema = z.object({
  id: z.string().min(1),
  collection_id: z.string().min(1),
  version: z.number().int().positive().default(1),
  data: z.record(jsonValueSchema),
  resource_refs: z.array(ResourceRefSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type CollectionRecord = z.input<typeof CollectionRecordSchema>;

export const CollectionPatchSchema = z.object({
  id: z.string().min(1),
  record_id: z.string().min(1),
  changes: z.record(jsonValueSchema),
  expected_version: z.number().int().positive().optional(),
  source_operation_id: z.string().min(1),
  created_at: z.string().datetime()
});
export type CollectionPatch = z.infer<typeof CollectionPatchSchema>;

export const GrantRecordSchema = z.object({
  id: z.string().min(1),
  capability_id: z.string().min(1),
  operation: z.string().min(1),
  actor_identity: ActorIdentitySchema,
  channel: z.string().min(1),
  resource_scope: z.string().min(1),
  manifest_version: z.string().min(1),
  risk_snapshot: RiskLevelSchema,
  scope_snapshot: ExecutionScopeSchema,
  external_impact_snapshot: z.boolean(),
  secret_requirement_snapshot: z.string(),
  granted_by: z.string().min(1),
  reason: z.string(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().optional(),
  revoked_at: z.string().datetime().optional()
});
export type GrantRecord = z.infer<typeof GrantRecordSchema>;

export const OperationRecordSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  capability_id: z.string().min(1),
  operation: z.string().min(1),
  actor_identity: ActorIdentitySchema,
  instruction_source: InstructionSourceSchema,
  instruction_authority: z.string().min(1),
  channel: z.string().min(1),
  input_hash: z.string().min(1),
  input_ref: ResourceRefSchema.optional(),
  target_resource_refs: z.array(ResourceRefSchema),
  proposed_effects: z.array(z.string()),
  status: OperationStatusSchema,
  policy_decision_id: z.string().optional(),
  approval_request_id: z.string().optional(),
  result_ref: ResourceRefSchema.optional(),
  error: z.string().optional(),
  correlation_id: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

export const DomainCommandExecutionRecordSchema = z.object({
  id: z.string().min(1),
  idempotency_key: z.string().min(1),
  command_id: z.string().min(1),
  input_source: z.string().min(1),
  correlation_id: z.string().min(1),
  payload_hash: z.string().min(1),
  phase: z.enum(["claimed", "internal_running", "external_running"]),
  status: z.enum(["running", "completed", "failed", "outcome_unknown"]),
  result: jsonValueSchema.optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    details: jsonValueSchema.optional()
  }).optional(),
  heartbeat_at: z.string().datetime(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type DomainCommandExecutionRecord = z.infer<typeof DomainCommandExecutionRecordSchema>;

export const ObjectiveStatusSchema = z.enum(["active", "paused", "blocked", "completed", "cancelled", "failed"]);
export type ObjectiveStatus = z.infer<typeof ObjectiveStatusSchema>;

export const WorkItemStatusSchema = z.enum(["queued", "ready", "running", "waiting", "blocked", "completed", "failed", "cancelled"]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkFailureKindSchema = z.enum(["retryable", "non_retryable", "cancelled"]);
export type WorkFailureKind = z.infer<typeof WorkFailureKindSchema>;

export const ObjectiveRecordSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  title: z.string().min(1),
  objective: z.string().min(1),
  completion_criteria: z.array(z.string().min(1)).min(1),
  status: ObjectiveStatusSchema,
  token_budget: z.number().int().positive().optional(),
  time_budget_ms: z.number().int().positive().optional(),
  max_attempts: z.number().int().positive().optional(),
  current_checkpoint_id: z.string().min(1).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  completed_at: z.string().datetime().optional()
});
export type ObjectiveRecord = z.infer<typeof ObjectiveRecordSchema>;

export const WorkItemRecordSchema = z.object({
  id: z.string().min(1),
  objective_id: z.string().min(1),
  parent_work_item_id: z.string().min(1).optional(),
  instruction: z.string().min(1),
  status: WorkItemStatusSchema,
  priority: z.number().int(),
  attempt: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  idempotency_key: z.string().min(1),
  lease_owner: z.string().min(1).optional(),
  lease_expires_at: z.string().datetime().optional(),
  heartbeat_at: z.string().datetime().optional(),
  retry_after_at: z.string().datetime().optional(),
  backend_run_id: z.string().min(1).optional(),
  current_checkpoint_id: z.string().min(1).optional(),
  failure_kind: WorkFailureKindSchema.optional(),
  error: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional()
});
export type WorkItemRecord = z.infer<typeof WorkItemRecordSchema>;

export const WorkDependencyRecordSchema = z.object({
  id: z.string().min(1),
  objective_id: z.string().min(1),
  predecessor_work_item_id: z.string().min(1),
  successor_work_item_id: z.string().min(1),
  kind: z.enum(["blocks", "requires"]),
  created_at: z.string().datetime()
});
export type WorkDependencyRecord = z.infer<typeof WorkDependencyRecordSchema>;

export const RunCheckpointRecordSchema = z.object({
  id: z.string().min(1),
  objective_id: z.string().min(1),
  work_item_id: z.string().min(1),
  sequence: z.number().int().positive(),
  phase: z.enum(["before_side_effect", "after_side_effect", "progress", "completed"]),
  idempotency_key: z.string().min(1),
  backend_run_id: z.string().min(1).optional(),
  backend_session_id: z.string().min(1).optional(),
  event_cursor: z.number().int().nonnegative().optional(),
  summary: z.string(),
  generated_resource_refs: z.array(ResourceRefSchema),
  pending_operation_ids: z.array(z.string().min(1)),
  state: z.record(jsonValueSchema),
  created_at: z.string().datetime()
});
export type RunCheckpointRecord = z.infer<typeof RunCheckpointRecordSchema>;

export const GeneratedSurfaceStateSchema = z.enum(["ephemeral", "pinned", "archived"]);
export type GeneratedSurfaceState = z.infer<typeof GeneratedSurfaceStateSchema>;

export const GeneratedSurfaceActionDeclarationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command_id: z.string().min(1),
  input_schema: z.record(jsonValueSchema),
  payload_template: z.record(jsonValueSchema).default({}),
  requires_confirmation: z.boolean().default(false)
});
export type GeneratedSurfaceActionDeclaration = z.infer<typeof GeneratedSurfaceActionDeclarationSchema>;

export const SurfaceGenerationRequestSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  user_intent: z.string().min(1),
  source_resource_refs: z.array(ResourceRefSchema),
  allowed_domain_commands: z.array(z.string().min(1)),
  selected_knowledge_refs: z.array(ResourceRefSchema),
  selected_skill_refs: z.array(ResourceRefSchema),
  client_capabilities: z.record(jsonValueSchema),
  expected_lifetime: z.enum(["message", "session", "pinned"]),
  fallback_chain: z.array(z.enum(["built_in_surface", "artifact", "text"])),
  created_at: z.string().datetime()
});
export type SurfaceGenerationRequest = z.infer<typeof SurfaceGenerationRequestSchema>;

export const GeneratedSurfaceValidationReportSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ code: z.string().min(1), message: z.string().min(1) })),
  html_bytes: z.number().int().nonnegative(),
  css_bytes: z.number().int().nonnegative(),
  script_bytes: z.number().int().nonnegative(),
  action_count: z.number().int().nonnegative(),
  csp: z.string().min(1),
  fallback: z.enum(["built_in_surface", "artifact", "text"]).optional()
});
export type GeneratedSurfaceValidationReport = z.infer<typeof GeneratedSurfaceValidationReportSchema>;

export const GeneratedSurfaceDefinitionSchema = z.object({
  id: z.string().min(1),
  state: GeneratedSurfaceStateSchema,
  session_id: z.string().min(1),
  title: z.string().min(1),
  input_data_schema: z.record(jsonValueSchema),
  actions: z.array(GeneratedSurfaceActionDeclarationSchema),
  capability_manifest: z.object({ allowed_domain_commands: z.array(z.string().min(1)), network_access: z.literal("none"), workspace_write: z.literal("domain_commands_only") }),
  source_refs: z.array(ResourceRefSchema),
  generation_run_id: z.string().min(1).optional(),
  content_hash: z.string().min(1),
  current_revision_id: z.string().min(1),
  current_revision: z.number().int().positive(),
  preview_url: z.string().min(1),
  fallback_chain: z.array(z.enum(["built_in_surface", "artifact", "text"])),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type GeneratedSurfaceDefinition = z.infer<typeof GeneratedSurfaceDefinitionSchema>;

export const GeneratedSurfaceRevisionRecordSchema = z.object({
  id: z.string().min(1),
  surface_id: z.string().min(1),
  revision: z.number().int().positive(),
  parent_revision_id: z.string().min(1).optional(),
  producer_run_id: z.string().min(1).optional(),
  prompt_fingerprint: z.string().min(1),
  knowledge_refs: z.array(ResourceRefSchema),
  skill_refs: z.array(ResourceRefSchema),
  html_ref: ResourceRefSchema,
  css_ref: ResourceRefSchema.optional(),
  script_ref: ResourceRefSchema.optional(),
  asset_refs: z.array(ResourceRefSchema).default([]),
  bundle_hash: z.string().min(1),
  validation_report: GeneratedSurfaceValidationReportSchema,
  created_at: z.string().datetime()
});
export type GeneratedSurfaceRevisionRecord = z.infer<typeof GeneratedSurfaceRevisionRecordSchema>;

export const SurfaceInteractionRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["opened", "action", "corrected", "regenerated", "pinned", "unpinned", "dismissed"]),
  session_id: z.string().min(1),
  message_id: z.string().min(1).optional(),
  surface_id: z.string().min(1),
  revision_id: z.string().min(1),
  command_id: z.string().min(1).optional(),
  command_result: jsonValueSchema.optional(),
  user_feedback: z.string().optional(),
  created_at: z.string().datetime()
});
export type SurfaceInteractionRecord = z.infer<typeof SurfaceInteractionRecordSchema>;

export const AttachmentIngestionRecordSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  source_ref: ResourceRefSchema,
  file_name: z.string().min(1),
  media_type: z.enum(["image", "pdf", "text", "docx", "xlsx", "pptx"]),
  mime_type: z.string().min(1),
  source_hash: z.string().min(1),
  source_bytes: z.number().int().nonnegative(),
  extracted_text: z.string(),
  extracted_characters: z.number().int().nonnegative(),
  truncated: z.boolean(),
  attempts: z.number().int().positive(),
  status: z.enum(["completed", "failed"]),
  trace: z.array(z.object({ part: z.string().min(1), characters: z.number().int().nonnegative(), hash: z.string().min(1) })),
  metadata: z.record(jsonValueSchema),
  error: z.string().optional(),
  created_at: z.string().datetime()
});
export type AttachmentIngestionRecord = z.infer<typeof AttachmentIngestionRecordSchema>;

export const ArtifactRevisionRecordSchema = z.object({
  id: z.string().min(1),
  artifact_id: z.string().min(1),
  revision: z.number().int().positive(),
  parent_revision_id: z.string().min(1).optional(),
  producer_run_id: z.string().min(1).optional(),
  base_revision_id: z.string().min(1).optional(),
  editor_source: z.enum(["chat", "surface", "provider", "image_provider", "restore", "system"]).optional(),
  change_summary: z.string().optional(),
  provenance: z.record(jsonValueSchema).default({}),
  source_ref: ResourceRefSchema.optional(),
  file_ref: ResourceRefSchema,
  blob_ref: ResourceRefSchema,
  content_hash: z.string().min(1),
  content_bytes: z.number().int().nonnegative(),
  created_at: z.string().datetime()
}).strict();
export type ArtifactRevisionRecord = z.infer<typeof ArtifactRevisionRecordSchema>;

export const FileBrowserActionKindSchema = z.enum(["file", "browser"]);
export type FileBrowserActionKind = z.infer<typeof FileBrowserActionKindSchema>;

export const FileBrowserActionDiagnosticsIssueSchema = z.object({
  code: z.enum([
    "file_browser_action_failed",
    "file_browser_action_blocked",
    "file_browser_tool_run_failed",
    "file_browser_tool_run_ignored",
    "browser_workspace_fallback"
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  action_kind: FileBrowserActionKindSchema,
  operation: z.string().min(1),
  status: z.string().min(1),
  message: z.string(),
  operation_id: z.string().min(1).optional(),
  tool_run_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  session_id: z.string().min(1),
  resource_ref: ResourceRefSchema.optional(),
  output_summary: z.string().optional(),
  created_at: z.string().datetime()
}).strict();
export type FileBrowserActionDiagnosticsIssue = z.infer<typeof FileBrowserActionDiagnosticsIssueSchema>;

export const FileBrowserActionDiagnosticsReportSchema = z.object({
  generated_at: z.string().datetime(),
  scope: z.object({
    session_id: z.string().optional(),
    limit: z.number().int().positive()
  }),
  total_operations: z.number().int().nonnegative(),
  total_tool_runs: z.number().int().nonnegative(),
  file_operations: z.number().int().nonnegative(),
  browser_operations: z.number().int().nonnegative(),
  completed_file_operations: z.number().int().nonnegative(),
  completed_browser_operations: z.number().int().nonnegative(),
  failed_or_blocked_operations: z.number().int().nonnegative(),
  ignored_or_failed_tool_runs: z.number().int().nonnegative(),
  browser_workspace_fallbacks: z.number().int().nonnegative(),
  operation_status_counts: z.record(z.string(), z.number().int().nonnegative()),
  tool_run_status_counts: z.record(z.string(), z.number().int().nonnegative()),
  issues: z.array(FileBrowserActionDiagnosticsIssueSchema),
  recommendation: z.string()
});
export type FileBrowserActionDiagnosticsReport = z.infer<typeof FileBrowserActionDiagnosticsReportSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string().min(1),
  operation_id: z.string().min(1),
  requested_level: z.enum(["approval", "strong_approval", "first_time_confirm"]),
  status: ApprovalStatusSchema,
  reason: z.string(),
  requested_by: z.string().min(1),
  decided_by: z.string().optional(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  decided_at: z.string().datetime().optional()
}).strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const PolicyDecisionRecordSchema = z.object({
  id: z.string().min(1),
  operation_id: z.string().min(1),
  capability_id: z.string().min(1),
  operation: z.string().min(1),
  decision: PolicyDecisionSchema,
  reason: z.string(),
  policy_inputs: PolicyEvaluationInputSchema,
  matched_rules: z.array(z.string()),
  required_approval_level: z.enum(["none", "first_time_confirm", "approval", "strong_approval"]),
  grant_id: z.string().optional(),
  created_at: z.string().datetime()
}).strict();
export type PolicyDecisionRecord = z.infer<typeof PolicyDecisionRecordSchema>;

export const AuditRecordSchema = z.object({
  id: z.string().min(1),
  actor_identity: ActorIdentitySchema,
  operation_id: z.string().min(1),
  capability_id: z.string().min(1),
  instruction_source: InstructionSourceSchema,
  inputs_summary: z.string(),
  outputs_summary: z.string(),
  policy_decision_id: z.string().min(1),
  affected_resources: z.array(ResourceRefSchema),
  rollback_point_id: z.string().optional(),
  created_at: z.string().datetime()
}).strict();
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export const RollbackPointSchema = z.object({
  id: z.string().min(1),
  operation_id: z.string().min(1),
  affected_resources: z.array(ResourceRefSchema),
  before_snapshot: z.record(jsonValueSchema),
  after_snapshot: z.record(jsonValueSchema),
  reversible: z.boolean(),
  irreversible_effects: z.array(z.string()),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime()
}).strict();
export type RollbackPoint = z.infer<typeof RollbackPointSchema>;

export const ActivityInboxItemSchema = z.object({
  id: z.string().min(1),
  activity_type: ActivityTypeSchema,
  severity: ActivitySeveritySchema,
  title: z.string(),
  summary: z.string(),
  operation_id: z.string().optional(),
  approval_request_id: z.string().optional(),
  audit_record_id: z.string().optional(),
  rollback_point_id: z.string().optional(),
  created_at: z.string().datetime()
}).strict();
export type ActivityInboxItem = z.infer<typeof ActivityInboxItemSchema>;

export interface SettingsRecord {
  ui_locale: SupportedLocale;
  output_locale: SupportedLocale;
  memory_capture_mode: CaptureMode;
  knowledge_wiki_capture_mode: CaptureMode;
  skill_capture_mode: CaptureMode;
  /** Stops automatic candidate review, without disabling explicit saves. */
  learning_enabled: boolean;
  /** Provisional share of the preceding normal-run usage available to learning. */
  learning_budget_ratio: number;
  learning_budget_window_days: number;
  external_provider_role: ExternalProviderRole;
  default_backend_id?: string;
  default_room_id?: string;
  default_agent_id?: string;
  updated_at: string;
}

export interface SessionRecord {
  id: string;
  session_key: string;
  room_id?: string;
  title: string;
  ui_locale: SupportedLocale;
  output_locale: SupportedLocale;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  session_id: string;
  role: "user" | "agent" | "system";
  content: string;
  input_locale: SupportedLocale;
  output_locale: SupportedLocale;
  envelope?: MessageEnvelope;
  created_at: string;
}

export const SessionCompactionRecordSchema = z.object({
  session_id: z.string().min(1),
  source_message_count: z.number().int().nonnegative(),
  source_last_message_id: z.string().min(1),
  objectives: z.array(z.string().min(1)),
  decisions: z.array(z.string().min(1)),
  open_work: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  recent_messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "agent", "system"]), content: z.string() })),
  estimated_tokens: z.number().int().nonnegative(),
  token_budget: z.number().int().positive(),
  omitted_message_count: z.number().int().nonnegative(),
  created_at: z.string().datetime()
});
export type SessionCompactionRecord = z.infer<typeof SessionCompactionRecordSchema>;

export interface MessagePresentationRecord {
  id: string;
  session_id: string;
  message_id: string;
  kind: "collection_app" | "generated_surface" | "skill_optimization";
  title: string;
  subtitle: string;
  collection_id: string;
  view_id: string;
  renderer: string;
  view_state?: Record<string, JsonValue>;
  surface_id?: string;
  revision_id?: string;
  preview_url?: string;
  created_at: string;
  updated_at: string;
}

export const createId = (prefix: string) => `${prefix}_${createRandomId()}`;
export const nowIso = () => new Date().toISOString();

export function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type PrivacyRedactionOptions = {
  redactPii?: boolean;
};

const sensitivePrivacyKey = /(?:^|[_-])(secret|token|api[_-]?key|password|credential|authorization|cookie|private[_-]?key)(?:$|[_-])/i;
const technicalIdentifierKey = /(?:^|_)(?:id|ids|sha|hash)$/i;

export function redactPrivateData<T>(value: T, options: PrivacyRedactionOptions = {}, key = ""): T {
  if (isSecretReferenceMetadataKey(key)) {
    return value;
  }
  if (sensitivePrivacyKey.test(key) && !isSecretReferenceMetadataKey(key)) {
    return "[redacted]" as T;
  }
  if (typeof value === "string") {
    let redacted = value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
      .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
      .replace(/\b(api[_-]?key|authorization|token|secret|password|credential|cookie|private[_-]?key)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]");
    if (options.redactPii && !technicalIdentifierKey.test(key)) {
      redacted = redacted
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
        .replace(/(?<!\d)(?:\+?81[-\s]?)?(?:0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})(?!\d)/g, "[redacted-phone]");
    }
    return redacted as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactPrivateData(entry, options)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
        entryKey,
        redactPrivateData(entry, options, entryKey)
      ])
    ) as T;
  }
  return value;
}

function isSecretReferenceMetadataKey(key: string): boolean {
  return key === "secret_env"
    || key === "secret_files"
    || key === "secret_resolution"
    || key === "secret_ref_ids"
    || key === "resolved_secret_ref_ids"
    || key === "unresolved_secret_ref_ids"
    || key === "unresolved_reasons";
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function createRandomId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && "randomUUID" in cryptoRef) {
    return cryptoRef.randomUUID().replaceAll("-", "").slice(0, 16);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export const defaultSettings = (): SettingsRecord => ({
  ui_locale: "ja",
  output_locale: "ja",
  memory_capture_mode: "auto",
  knowledge_wiki_capture_mode: "auto",
  skill_capture_mode: "auto",
  learning_enabled: true,
  learning_budget_ratio: 0.1,
  learning_budget_window_days: 7,
  external_provider_role: "assistive",
  updated_at: nowIso()
});
