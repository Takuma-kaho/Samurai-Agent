import { z } from "zod";

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
export const captureModes = ["manual", "suggest", "off"] as const;
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
export const backendRunStatuses = ["queued", "running", "waiting_for_backend_input", "completed", "failed", "cancelled"] as const;
export const backendEventTypes = [
  "run_started",
  "text_delta",
  "tool_call_started",
  "tool_call_output",
  "artifact_created",
  "workspace_change_suggested",
  "memory_suggested",
  "skill_candidate_created",
  "backend_waiting_for_native_input",
  "run_completed",
  "run_failed"
] as const;
export const workspaceChangeTypes = ["artifact_created", "memory_suggested", "skill_candidate_created", "collection_changed", "settings_changed", "other"] as const;
export const reflectionRunKinds = ["chat_turn", "manual", "scheduled", "curator", "evaluation"] as const;
export const reflectionRunStatuses = ["started", "completed", "failed"] as const;
export const reflectionSuggestionTypes = ["memory", "knowledge_wiki", "skill", "memory_patch", "skill_patch", "conflict"] as const;
export const reflectionSuggestionStatuses = ["proposed", "applied", "rejected", "archived"] as const;
export const toolRunStatuses = ["completed", "ignored", "failed"] as const;
export const automationJobStatuses = ["enabled", "disabled", "archived"] as const;
export const externalSendStatuses = ["draft", "pending_approval", "approved", "dispatched", "denied", "failed"] as const;

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
export const BackendRunStatusSchema = z.enum(backendRunStatuses);
export const BackendEventTypeSchema = z.enum(backendEventTypes);
export const WorkspaceChangeTypeSchema = z.enum(workspaceChangeTypes);
export const ReflectionRunKindSchema = z.enum(reflectionRunKinds);
export const ReflectionRunStatusSchema = z.enum(reflectionRunStatuses);
export const ReflectionSuggestionTypeSchema = z.enum(reflectionSuggestionTypes);
export const ReflectionSuggestionStatusSchema = z.enum(reflectionSuggestionStatuses);
export const ToolRunStatusSchema = z.enum(toolRunStatuses);
export const AutomationJobStatusSchema = z.enum(automationJobStatuses);
export const ExternalSendStatusSchema = z.enum(externalSendStatuses);

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
export type BackendRunStatus = z.infer<typeof BackendRunStatusSchema>;
export type BackendEventType = z.infer<typeof BackendEventTypeSchema>;
export type WorkspaceChangeType = z.infer<typeof WorkspaceChangeTypeSchema>;
export type ReflectionRunKind = z.infer<typeof ReflectionRunKindSchema>;
export type ReflectionRunStatus = z.infer<typeof ReflectionRunStatusSchema>;
export type ReflectionSuggestionType = z.infer<typeof ReflectionSuggestionTypeSchema>;
export type ReflectionSuggestionStatus = z.infer<typeof ReflectionSuggestionStatusSchema>;
export type ToolRunStatus = z.infer<typeof ToolRunStatusSchema>;
export type AutomationJobStatus = z.infer<typeof AutomationJobStatusSchema>;
export type ExternalSendStatus = z.infer<typeof ExternalSendStatusSchema>;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema)])
);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const ResourceRefSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  uri: z.string().min(1),
  version: z.string().optional(),
  label: z.string().optional()
});
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

export const ProvenanceSchema = z.object({
  kind: z.enum(["user_authored", "generated_local", "external_provider", "imported", "system"]),
  summary: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  verified: z.boolean()
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const LocalizedTextSchema = z.object({
  canonical_locale: SupportedLocaleSchema,
  values: z.record(SupportedLocaleSchema, z.string()),
  status_by_locale: z.record(SupportedLocaleSchema, TranslationStatusSchema)
});
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

export const MessageEnvelopeSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["web", "telegram", "slack", "line", "email", "webhook", "cron"]),
  actor_identity: ActorIdentitySchema,
  session_key: z.string().min(1),
  user_intent: z.string().min(1),
  attachments: z.array(ResourceRefSchema),
  input_locale: SupportedLocaleSchema,
  output_locale: SupportedLocaleSchema,
  metadata: z.record(jsonValueSchema),
  received_at: z.string().datetime()
});
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

export const AgentBackendConfigSchema = z.object({
  id: z.string().min(1),
  kind: AgentBackendKindSchema,
  label: z.string().min(1),
  enabled: z.boolean(),
  metadata: z.record(jsonValueSchema)
});
export type AgentBackendConfig = z.infer<typeof AgentBackendConfigSchema>;

export const BackendRunRecordSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  input_message_id: z.string().min(1),
  output_message_id: z.string().optional(),
  backend_id: z.string().min(1),
  backend_kind: AgentBackendKindSchema,
  status: BackendRunStatusSchema,
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  input_summary: z.string(),
  output_summary: z.string().optional(),
  error_code: z.string().optional(),
  metadata: z.record(jsonValueSchema)
});
export type BackendRunRecord = z.infer<typeof BackendRunRecordSchema>;

export const BackendEventRecordSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  event_type: BackendEventTypeSchema,
  sequence: z.number().int().positive(),
  payload: z.record(jsonValueSchema),
  resource_refs: z.array(ResourceRefSchema),
  created_at: z.string().datetime()
});
export type BackendEventRecord = z.infer<typeof BackendEventRecordSchema>;

export const WorkspaceChangeRecordSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  resource_ref: ResourceRefSchema,
  change_type: WorkspaceChangeTypeSchema,
  summary: z.string(),
  legacy_operation_id: z.string().optional(),
  created_at: z.string().datetime()
});
export type WorkspaceChangeRecord = z.infer<typeof WorkspaceChangeRecordSchema>;

export const ContextPreviewSchema = z.object({
  session_id: z.string().min(1),
  query: z.string(),
  active_memory: z.array(z.object({
    id: z.string().min(1),
    topic: z.string().min(1),
    content: z.string()
  })),
  knowledge_wiki: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    title: z.string().min(1),
    content: z.string()
  })),
  selected_skills: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    required_capabilities: z.array(z.string()),
    content: z.string().optional()
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

export const ReflectionRunRecordSchema = z.object({
  id: z.string().min(1),
  kind: ReflectionRunKindSchema,
  source_run_id: z.string().optional(),
  session_id: z.string().optional(),
  status: ReflectionRunStatusSchema,
  input_summary: z.string(),
  output_summary: z.string().optional(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  error: z.string().optional()
});
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
});
export type ReflectionSuggestionRecord = z.infer<typeof ReflectionSuggestionRecordSchema>;

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
  resource_refs: z.array(ResourceRefSchema),
  created_at: z.string().datetime()
});
export type ToolRunRecord = z.infer<typeof ToolRunRecordSchema>;

export const AutomationJobRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["memory_review", "skill_curator", "wiki_reindex", "daily_digest", "custom_instruction"]),
  status: AutomationJobStatusSchema,
  schedule: z.string().min(1),
  target_instruction: z.string().min(1),
  delivery_target: z.record(jsonValueSchema),
  next_run_at: z.string().datetime().optional(),
  last_run_at: z.string().datetime().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type AutomationJobRecord = z.infer<typeof AutomationJobRecordSchema>;

export const ExternalSendRecordSchema = z.object({
  id: z.string().min(1),
  channel: z.enum(["webhook", "email", "slack"]),
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

export const ActionCatalogEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  input_schema: z.record(jsonValueSchema),
  output_schema: z.record(jsonValueSchema),
  resource_kinds: z.array(z.string()),
  handler_id: z.string().min(1)
});
export type ActionCatalogEntry = z.infer<typeof ActionCatalogEntrySchema>;

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
});
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
  source_refs: z.array(ResourceRefSchema).optional(),
  provenance: ProvenanceSchema.optional()
});
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

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
  source_refs: z.array(ResourceRefSchema).optional(),
  provenance_detail: ProvenanceSchema.optional()
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
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type WikiFrontmatter = z.infer<typeof WikiFrontmatterSchema>;

export const ArtifactRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["markdown", "table", "chart", "note"]),
  locale: SupportedLocaleSchema,
  source_locales: z.array(SupportedLocaleSchema),
  file_ref: ResourceRefSchema,
  metadata: z.record(jsonValueSchema),
  source_operation_id: z.string().min(1),
  created_by: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

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
  permissions: z.record(jsonValueSchema)
});
export type CollectionSchema = z.infer<typeof CollectionSchemaSchema>;

export const CollectionRecordSchema = z.object({
  id: z.string().min(1),
  collection_id: z.string().min(1),
  data: z.record(jsonValueSchema),
  resource_refs: z.array(ResourceRefSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type CollectionRecord = z.infer<typeof CollectionRecordSchema>;

export const CollectionPatchSchema = z.object({
  id: z.string().min(1),
  record_id: z.string().min(1),
  changes: z.record(jsonValueSchema),
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
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

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
});
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
});
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
});
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
});
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
});
export type ActivityInboxItem = z.infer<typeof ActivityInboxItemSchema>;

export interface SettingsRecord {
  ui_locale: SupportedLocale;
  output_locale: SupportedLocale;
  memory_capture_mode: CaptureMode;
  knowledge_wiki_capture_mode: CaptureMode;
  skill_capture_mode: CaptureMode;
  external_provider_role: ExternalProviderRole;
  updated_at: string;
}

export interface SessionRecord {
  id: string;
  session_key: string;
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
  memory_capture_mode: "suggest",
  knowledge_wiki_capture_mode: "suggest",
  skill_capture_mode: "suggest",
  external_provider_role: "assistive",
  updated_at: nowIso()
});
