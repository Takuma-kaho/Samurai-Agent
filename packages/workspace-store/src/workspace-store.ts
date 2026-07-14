import Database from "better-sqlite3";
export * from "./profile-registry";
import { access, copyFile, cp, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { gatewayDeliveryMigration } from "./migrations/gateway-delivery";
import { skillOptimizationMigration } from "./migrations/skill-optimization";
import { compareScoredSearch, scoreSearchFields, searchTerms, stateSearchBoost } from "./search/scoring";
import { normalizeBackupId } from "./backup/backup-id";
import { backendEventFromRow, backendEventToRow, type BackendEventsTable } from "./repositories/backend-events";
import { workspaceFileRecoveryAction } from "./transactions/recovery-policy";
import {
  type ActivityInboxItem,
  type ApprovalRequest,
  type ArtifactRecord,
  type ArtifactRevisionRecord,
  type AuditRecord,
  type AutomationJobRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type ChangeHistoryEntry,
  type ClientEventRecord,
  CollectionRecordSchema,
  CollectionSchemaSchema,
  type CollectionPatch,
  type CollectionRecord,
  type CollectionSchema,
  type CuratorStateRecord,
  type DomainCommandExecutionRecord,
  type ExternalAssistDiagnosticsGroup,
  type ExternalAssistDiagnosticsReport,
  ExternalAssistRecordSchema,
  type ExternalAssistPhase,
  type ExternalAssistRecord,
  type ExternalAssistStatus,
  type GrantRecord,
  type GeneratedSurfaceDefinition,
  type GeneratedSurfaceRevisionRecord,
  type SurfaceInteractionRecord,
  type SkillOptimizationRun,
  SkillOptimizationRunSchema,
  type SkillOptimizationDataset,
  SkillOptimizationDatasetSchema,
  type OptimizationCandidate,
  OptimizationCandidateSchema,
  type OptimizationEvaluation,
  OptimizationEvaluationSchema,
  type OptimizationPromotion,
  OptimizationPromotionSchema,
  type SkillOptimizationSnapshot,
  SkillOptimizationSnapshotSchema,
  type LearningResourceUseRecord,
  type LearningEvaluationRecord,
  LearningResourceEdgeRecordSchema,
  type LearningResourceEdgeRecord,
  type LearningSnapshotRecord,
  type BackgroundReviewChangeRecord,
  type LearningJobReportRecord,
  type JsonValue,
  type MemoryFrontmatter,
  MemoryFrontmatterSchema,
  type MessageRecord,
  type MessagePresentationRecord,
  type OperationRecord,
  type ObjectiveRecord,
  type WorkItemRecord,
  type WorkDependencyRecord,
  type RunCheckpointRecord,
  type ExternalSendRecord,
  type GatewayBoundaryPolicy,
  type GatewayConcurrencyLockRecord,
  type GatewayInboundMessageRecord,
  GatewayDeliveryRecordSchema,
  type GatewayDeliveryRecord,
  GatewayMcpConfigRecordSchema,
  type GatewayMcpConfigRecord,
  GatewayPairingPolicyRecordSchema,
  type GatewayPairingPolicyRecord,
  type GatewayPairingRecord,
  GatewayRoutingPolicyRecordSchema,
  type GatewayRoutingPolicyRecord,
  GatewaySandboxInstanceRecordSchema,
  type GatewaySandboxInstanceRecord,
  GatewaySandboxWorkspaceSyncRecordSchema,
  type GatewaySandboxWorkspaceSyncRecord,
  type PolicyDecisionRecord,
  type ReflectionRunRecord,
  type ReflectionSuggestionRecord,
  type ResourceRef,
  redactPrivateData,
  type ResourceTranslationRecord,
  type RollbackPoint,
  type SessionRecord,
  SessionCompactionRecordSchema,
  type SessionCompactionRecord,
  type SettingsRecord,
  SkillFrontmatterSchema,
  type SkillFrontmatter,
  type SkillIndexEntryReadModel,
  type SkillUsageRecord,
  type ToolRunDiagnosticsGroup,
  type ToolRunDiagnosticsReport,
  type ToolRunRecord,
  type ToolRunStatus,
  WikiFrontmatterSchema,
  type WikiFrontmatter,
  type WorkspaceChangeRecord,
  type RunHistoryEntry,
  createId,
  defaultSettings,
  nowIso,
  stableHash
} from "@samurai-agent/core-schemas";
import { Kysely, SqliteDialect, sql } from "kysely";

type JsonColumn = string;

interface SessionsTable {
  id: string;
  session_key: string;
  title: string;
  ui_locale: string;
  output_locale: string;
  created_at: string;
  updated_at: string;
}

interface MessagesTable {
  id: string;
  session_id: string;
  role: "user" | "agent" | "system";
  content: string;
  input_locale: string;
  output_locale: string;
  envelope_json: JsonColumn | null;
  created_at: string;
}

interface MessagePresentationsTable {
  id: string;
  session_id: string;
  message_id: string;
  kind: string;
  title: string;
  subtitle: string;
  collection_id: string;
  view_id: string;
  renderer: string;
  view_state_json: JsonColumn | null;
  surface_id: string | null;
  revision_id: string | null;
  preview_url: string | null;
  created_at: string;
  updated_at: string;
}

interface SkillOptimizationRunsTable {
  id: string;
  target_skill_id: string;
  session_id: string | null;
  status: string;
  run_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface SkillOptimizationDatasetsTable {
  id: string;
  skill_id: string;
  dataset_json: JsonColumn;
  created_at: string;
}

interface OptimizationCandidatesTable {
  id: string;
  run_id: string;
  skill_id: string;
  content_hash: string;
  body: string;
  candidate_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface OptimizationEvaluationsTable {
  id: string;
  run_id: string;
  candidate_id: string;
  evaluation_json: JsonColumn;
  created_at: string;
}

interface OptimizationPromotionsTable {
  id: string;
  run_id: string;
  candidate_id: string;
  skill_id: string;
  promotion_json: JsonColumn;
  created_at: string;
}

interface SkillOptimizationSnapshotsTable {
  id: string;
  skill_id: string;
  candidate_id: string;
  content_hash: string;
  markdown: string;
  snapshot_json: JsonColumn;
  created_at: string;
  restored_at: string | null;
}

interface SkillOptimizationLocksTable {
  skill_id: string;
  run_id: string;
  acquired_at: string;
}

interface OperationsTable {
  id: string;
  session_id: string;
  capability_id: string;
  operation: string;
  actor_identity: string;
  instruction_source: string;
  instruction_authority: string;
  channel: string;
  input_hash: string;
  input_ref_json: JsonColumn | null;
  target_resource_refs_json: JsonColumn;
  proposed_effects_json: JsonColumn;
  status: string;
  policy_decision_id: string | null;
  approval_request_id: string | null;
  result_ref_json: JsonColumn | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface DomainCommandExecutionsTable {
  id: string;
  idempotency_key: string;
  command_id: string;
  input_source: string;
  payload_hash: string;
  status: string;
  result_json: JsonColumn | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ObjectivesTable {
  id: string;
  session_id: string | null;
  title: string;
  objective: string;
  completion_criteria_json: JsonColumn;
  status: string;
  token_budget: number | null;
  time_budget_ms: number | null;
  max_attempts: number | null;
  current_checkpoint_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface WorkItemsTable {
  id: string;
  objective_id: string;
  parent_work_item_id: string | null;
  instruction: string;
  status: string;
  priority: number;
  attempt: number;
  max_attempts: number;
  idempotency_key: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  retry_after_at: string | null;
  backend_run_id: string | null;
  current_checkpoint_id: string | null;
  failure_kind: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface WorkDependenciesTable {
  id: string;
  objective_id: string;
  predecessor_work_item_id: string;
  successor_work_item_id: string;
  kind: string;
  created_at: string;
}

interface RunCheckpointsTable {
  id: string;
  objective_id: string;
  work_item_id: string;
  sequence: number;
  phase: string;
  idempotency_key: string;
  backend_run_id: string | null;
  backend_session_id: string | null;
  event_cursor: number | null;
  summary: string;
  generated_resource_refs_json: JsonColumn;
  pending_operation_ids_json: JsonColumn;
  state_json: JsonColumn;
  created_at: string;
}

interface WorkspaceFileTransactionsTable {
  id: string;
  kind: string;
  status: string;
  target_path: string;
  staged_path: string;
  collection_id: string | null;
  record_id: string | null;
  patch_id: string | null;
  before_json: JsonColumn;
  after_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface GeneratedSurfacesTable {
  id: string;
  state: string;
  session_id: string;
  title: string;
  definition_json: JsonColumn;
  content_hash: string;
  current_revision_id: string;
  current_revision: number;
  created_at: string;
  updated_at: string;
}

interface ArtifactRevisionsTable {
  id: string;
  artifact_id: string;
  revision: number;
  revision_json: JsonColumn;
  content_hash: string;
  file_path: string;
  blob_path: string;
  created_at: string;
}

interface GeneratedSurfaceRevisionsTable {
  id: string;
  surface_id: string;
  revision: number;
  revision_json: JsonColumn;
  bundle_hash: string;
  created_at: string;
}

interface SurfaceInteractionsTable {
  id: string;
  surface_id: string;
  revision_id: string;
  session_id: string;
  kind: string;
  interaction_json: JsonColumn;
  created_at: string;
}

interface PolicyDecisionsTable {
  id: string;
  operation_id: string;
  capability_id: string;
  operation: string;
  decision: string;
  reason: string;
  policy_inputs_json: JsonColumn;
  matched_rules_json: JsonColumn;
  required_approval_level: string;
  grant_id: string | null;
  created_at: string;
}

interface ApprovalRequestsTable {
  id: string;
  operation_id: string;
  requested_level: string;
  status: string;
  reason: string;
  requested_by: string;
  decided_by: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

interface AuditRecordsTable {
  id: string;
  actor_identity: string;
  operation_id: string;
  capability_id: string;
  instruction_source: string;
  inputs_summary: string;
  outputs_summary: string;
  policy_decision_id: string;
  affected_resources_json: JsonColumn;
  rollback_point_id: string | null;
  created_at: string;
}

interface RollbackPointsTable {
  id: string;
  operation_id: string;
  affected_resources_json: JsonColumn;
  before_snapshot_json: JsonColumn;
  after_snapshot_json: JsonColumn;
  reversible: number;
  irreversible_effects_json: JsonColumn;
  created_at: string;
  expires_at: string;
}

interface ArtifactsTable {
  id: string;
  title: string;
  kind: string;
  locale: string;
  source_locales_json: JsonColumn;
  file_ref_json: JsonColumn;
  metadata_json: JsonColumn;
  source_operation_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MemoryIndexTable {
  id: string;
  state: string;
  topic: string;
  source: string;
  source_locale: string;
  content_locale: string;
  source_kind: string;
  instruction_authority: string;
  file_path: string;
  frontmatter_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface SkillIndexTable {
  id: string;
  state: string;
  title: string;
  description: string;
  tags_json: JsonColumn;
  required_capabilities_json: JsonColumn;
  file_path: string;
  frontmatter_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface SkillUsageTable {
  skill_id: string;
  use_count: number;
  last_used_at: string | null;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface LearningResourceUseTable {
  id: string;
  run_id: string;
  session_id: string;
  resource_kind: string;
  resource_id: string;
  resource_version: string | null;
  content_hash: string | null;
  stage: string;
  source_operation_id: string | null;
  metadata_json: JsonColumn;
  created_at: string;
}

interface LearningEvaluationTable {
  id: string;
  learning_resource_ref_json: JsonColumn;
  learning_resource_version: string | null;
  task_class: string;
  compared_run_ids_json: JsonColumn;
  before_metrics_json: JsonColumn;
  after_metrics_json: JsonColumn;
  effect_estimate: number;
  confidence: number;
  assessment: string;
  evidence_refs_json: JsonColumn;
  evaluator: string;
  created_at: string;
}

interface LearningSnapshotTable {
  id: string;
  run_id: string;
  path: string;
  resource_counts_json: JsonColumn;
  created_at: string;
  restored_at: string | null;
}

interface BackgroundReviewChangeTable {
  id: string;
  origin: string;
  source_run_id: string;
  source_session_id: string;
  review_run_id: string;
  mutation_kind: string;
  resource_ref_json: JsonColumn;
  before_version: string | null;
  after_version: string;
  reason_summary: string;
  evidence_refs_json: JsonColumn;
  created_at: string;
}

interface LearningJobReportTable {
  id: string;
  job_kind: string;
  run_id: string;
  report_json: JsonColumn;
  created_at: string;
}

interface CuratorStateTable {
  id: string;
  paused: number;
  interval_hours: number;
  min_idle_hours: number;
  stale_after_days: number;
  archive_after_days: number;
  last_run_at: string | null;
  last_run_summary: string | null;
  run_count: number;
  updated_at: string;
}

interface WikiIndexTable {
  id: string;
  slug: string;
  title: string;
  state: string;
  content_locale: string;
  tags_json: JsonColumn;
  source_refs_json: JsonColumn;
  provenance_json: JsonColumn;
  file_path: string;
  frontmatter_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface CollectionSchemasTable {
  id: string;
  version: string;
  file_path: string;
  schema_json: JsonColumn;
  updated_at: string;
}

interface CollectionRecordsTable {
  id: string;
  collection_id: string;
  file_path: string;
  record_json: JsonColumn;
  version: number;
  created_at: string;
  updated_at: string;
}

interface CollectionPatchesTable {
  id: string;
  collection_id: string;
  record_id: string;
  patch_json: JsonColumn;
  source_operation_id: string;
  created_at: string;
}

interface AutomationRunsTable {
  id: string;
  kind: string;
  source: string;
  session_id: string | null;
  backend_run_id: string | null;
  status: string;
  operation_id: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface AutomationJobsTable {
  id: string;
  title: string;
  kind: string;
  status: string;
  schedule: string;
  target_instruction: string;
  delivery_target_json: JsonColumn;
  next_run_at: string | null;
  last_run_at: string | null;
  retry_after_at: string | null;
  locked_until: string | null;
  failure_count: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ExternalSendsTable {
  id: string;
  channel: string;
  status: string;
  target_json: JsonColumn;
  title: string;
  body: string;
  operation_id: string | null;
  approval_request_id: string | null;
  dispatch_result_json: JsonColumn | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
}

interface GatewayPairingsTable {
  id: string;
  channel: string;
  source_identity: string;
  source_label: string;
  status: string;
  pairing_code: string | null;
  session_key: string;
  metadata_json: JsonColumn;
  requested_at: string;
  expires_at: string | null;
  resolved_at: string | null;
  updated_at: string;
}

interface GatewayPairingPoliciesTable {
  id: string;
  channel: string;
  status: string;
  trust_mode: string;
  allowlist_json: JsonColumn;
  pairing_ttl_ms: number | null;
  duplicate_window_ms: number | null;
  rate_limit_window_ms: number | null;
  rate_limit_max: number | null;
  metadata_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface GatewayRoutingPoliciesTable {
  id: string;
  channel: string;
  status: string;
  session_key_strategy: string;
  default_account_id: string | null;
  default_thread_id: string | null;
  default_route: string;
  metadata_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface GatewayInboundMessagesTable {
  id: string;
  channel: string;
  source_identity: string;
  body: string;
  status: string;
  trusted: number;
  session_key: string | null;
  pairing_id: string | null;
  message_id: string | null;
  error: string | null;
  metadata_json: JsonColumn;
  created_at: string;
  updated_at: string;
}
interface GatewayDeliveriesTable {id:string;inbound_id:string|null;session_key:string;channel:string;status:string;idempotency_key:string;payload_json:JsonColumn;attempt:number;max_attempts:number;next_attempt_at:string|null;lease_until:string|null;receipt_json:JsonColumn|null;last_error:string|null;created_at:string;updated_at:string;delivered_at:string|null}

interface GatewayBoundaryPoliciesTable {
  id: string;
  source_channel: string;
  source_identity: string | null;
  session_key: string;
  allowed_tools_json: JsonColumn;
  mcp_config_refs_json: JsonColumn;
  secret_refs_json: JsonColumn;
  sandbox_json: JsonColumn;
  path_normalization_json: JsonColumn;
  allowlist_json: JsonColumn;
  timeout_ms: number | null;
  concurrency_lock_json: JsonColumn | null;
  metadata_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface GatewayMcpConfigsTable {
  id: string;
  server_name: string;
  transport: string;
  enabled: number;
  allowed_tools_json: JsonColumn;
  config_ref_json: JsonColumn | null;
  secret_refs_json: JsonColumn;
  stdio_json: JsonColumn | null;
  http_json: JsonColumn | null;
  metadata_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface GatewayConcurrencyLocksTable {
  id: string;
  lock_key: string;
  scope: string;
  policy_id: string | null;
  owner_ref_json: JsonColumn | null;
  status: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
  metadata_json: JsonColumn;
}

interface GatewaySandboxInstancesTable {
  id: string;
  instance_key: string;
  scope: string;
  backend: string;
  status: string;
  sandbox_json: JsonColumn;
  session_key: string | null;
  owner_ref_json: JsonColumn | null;
  workspace_root: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  deleted_at: string | null;
  metadata_json: JsonColumn;
}

interface GatewaySandboxWorkspaceSyncsTable {
  id: string;
  instance_id: string;
  instance_key: string;
  direction: string;
  status: string;
  workspace_root: string | null;
  remote_workspace_root: string | null;
  file_count: number | null;
  byte_count: number | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  metadata_json: JsonColumn;
}

interface ReflectionRunsTable {
  id: string;
  kind: string;
  source_run_id: string | null;
  session_id: string | null;
  status: string;
  input_summary: string;
  output_summary: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface ReflectionSuggestionsTable {
  id: string;
  reflection_run_id: string;
  suggestion_type: string;
  status: string;
  title: string;
  content: string;
  target_ref_json: JsonColumn | null;
  source_refs_json: JsonColumn;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface ToolRunsTable {
  id: string;
  run_id: string;
  session_id: string;
  tool_call_id: string | null;
  provider_tool_name: string;
  action_id: string | null;
  status: string;
  input_summary: string;
  output_summary: string;
  resource_refs_json: JsonColumn;
  created_at: string;
}

interface ExternalAssistRecordsTable {
  id: string;
  phase: string;
  status: string;
  provider_id: string;
  session_id: string;
  run_id: string | null;
  input_message_id: string | null;
  query: string;
  role: string;
  hints_json: JsonColumn;
  error: string | null;
  isolated_from_memory: number;
  included_in_active_memory: number;
  created_at: string;
  updated_at: string;
}

interface SettingsTable {
  id: "default";
  ui_locale: string;
  output_locale: string;
  memory_capture_mode: string;
  knowledge_wiki_capture_mode: string;
  llm_wiki_capture_mode?: string;
  skill_capture_mode: string;
  external_provider_role: string;
  default_backend_id: string | null;
  updated_at: string;
}

interface PluginStatesTable {
  manifest_id: string;
  enabled: number;
  version: string;
  updated_at: string;
}

interface MigrationJournalTable {
  id: string;
  name: string;
  status: string;
  details_json: JsonColumn;
  created_at: string;
}

interface GrantsTable {
  id: string;
  capability_id: string;
  operation: string;
  actor_identity: string;
  channel: string;
  resource_scope: string;
  manifest_version: string;
  risk_snapshot: string;
  scope_snapshot: string;
  external_impact_snapshot: number;
  secret_requirement_snapshot: string;
  granted_by: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface BackendRunsTable {
  id: string;
  session_id: string;
  input_message_id: string;
  output_message_id: string | null;
  backend_id: string;
  backend_kind: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  input_summary: string;
  output_summary: string | null;
  error_code: string | null;
  metadata_json: JsonColumn;
}

interface ClientEventsTable {
  id: string;
  target_client_kind: string;
  target_client_id: string | null;
  event_type: string;
  status: string;
  payload_json: JsonColumn;
  resource_refs_json: JsonColumn;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  expires_at: string | null;
  error_code: string | null;
}

interface WorkspaceChangesTable {
  id: string;
  run_id: string;
  session_id: string;
  resource_ref_json: JsonColumn;
  change_type: string;
  summary: string;
  legacy_operation_id: string | null;
  created_at: string;
}

interface ResourceTranslationsTable {
  id: string;
  source_ref_json: JsonColumn;
  source_locale: string;
  target_locale: string;
  status: string;
  original_hash: string;
  translated_text: string;
  provenance_json: JsonColumn | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceDb {
  sessions: SessionsTable;
  messages: MessagesTable;
  message_presentations: MessagePresentationsTable;
  skill_optimization_runs: SkillOptimizationRunsTable;
  skill_optimization_datasets: SkillOptimizationDatasetsTable;
  optimization_candidates: OptimizationCandidatesTable;
  optimization_evaluations: OptimizationEvaluationsTable;
  optimization_promotions: OptimizationPromotionsTable;
  skill_optimization_snapshots: SkillOptimizationSnapshotsTable;
  skill_optimization_locks: SkillOptimizationLocksTable;
  operations: OperationsTable;
  domain_command_executions: DomainCommandExecutionsTable;
  objectives: ObjectivesTable;
  work_items: WorkItemsTable;
  work_dependencies: WorkDependenciesTable;
  run_checkpoints: RunCheckpointsTable;
  workspace_file_transactions: WorkspaceFileTransactionsTable;
  generated_surfaces: GeneratedSurfacesTable;
  artifact_revisions: ArtifactRevisionsTable;
  generated_surface_revisions: GeneratedSurfaceRevisionsTable;
  surface_interactions: SurfaceInteractionsTable;
  policy_decisions: PolicyDecisionsTable;
  approval_requests: ApprovalRequestsTable;
  audit_records: AuditRecordsTable;
  rollback_points: RollbackPointsTable;
  artifacts: ArtifactsTable;
  memory_index: MemoryIndexTable;
  skill_index: SkillIndexTable;
  learning_resource_uses: LearningResourceUseTable;
  learning_evaluations: LearningEvaluationTable;
  learning_snapshots: LearningSnapshotTable;
  background_review_changes: BackgroundReviewChangeTable;
  learning_job_reports: LearningJobReportTable;
  wiki_index: WikiIndexTable;
  collection_schemas: CollectionSchemasTable;
  collection_records: CollectionRecordsTable;
  collection_patches: CollectionPatchesTable;
  automation_jobs: AutomationJobsTable;
  automation_runs: AutomationRunsTable;
  external_sends: ExternalSendsTable;
  gateway_pairings: GatewayPairingsTable;
  gateway_pairing_policies: GatewayPairingPoliciesTable;
  gateway_routing_policies: GatewayRoutingPoliciesTable;
  gateway_inbound_messages: GatewayInboundMessagesTable;
  gateway_deliveries:GatewayDeliveriesTable;
  gateway_boundary_policies: GatewayBoundaryPoliciesTable;
  gateway_mcp_configs: GatewayMcpConfigsTable;
  gateway_concurrency_locks: GatewayConcurrencyLocksTable;
  gateway_sandbox_instances: GatewaySandboxInstancesTable;
  gateway_sandbox_workspace_syncs: GatewaySandboxWorkspaceSyncsTable;
  reflection_runs: ReflectionRunsTable;
  reflection_suggestions: ReflectionSuggestionsTable;
  tool_runs: ToolRunsTable;
  external_assist_records: ExternalAssistRecordsTable;
  settings: SettingsTable;
  plugin_states: PluginStatesTable;
  grants: GrantsTable;
  backend_runs: BackendRunsTable;
  backend_events: BackendEventsTable;
  client_events: ClientEventsTable;
  workspace_changes: WorkspaceChangesTable;
  resource_translations: ResourceTranslationsTable;
  migration_journal: MigrationJournalTable;
}

export interface WorkspaceStoreOptions {
  rootDir: string;
  fileTransactionFailureInjector?: (phase: "planned" | "staged" | "db_committed" | "renamed") => void;
  restoreFailureInjector?: (phase: "extract" | "hash_verify" | "swap") => void;
}

export class WorkspaceSimulatedCrashError extends Error {}

export interface SearchResult {
  kind: "session" | "message" | "artifact" | "audit";
  id: string;
  title: string;
  summary: string;
  session_id?: string;
  operation_id?: string;
}

export type MemoryWithFilePath = MemoryFrontmatter & { file_path: string };
export interface SkillIndexEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  state: SkillFrontmatter["state"];
  allowed_scopes: SkillFrontmatter["allowed_scopes"];
  required_capabilities: string[];
  owner_pinned: boolean;
  frontmatter: SkillFrontmatter;
  file_path?: string;
}
export type SkillWithFilePath = SkillIndexEntry & { file_path: string };

export interface SkillSupportFile {
  skill_id: string;
  path: string;
  file_path: string;
  content: string;
}
export type WikiWithFilePath = WikiFrontmatter & { file_path: string };
export type CollectionSchemaWithFilePath = CollectionSchema & { file_path: string };
export type CollectionRecordWithFilePath = Omit<CollectionRecord, "version"> & { version: number; file_path: string };

export class CollectionRecordVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly latest: CollectionRecordWithFilePath
  ) {
    super(`collection_record_version_conflict:expected=${expectedVersion}:actual=${latest.version}`);
    this.name = "CollectionRecordVersionConflictError";
  }
}
export interface CollectionResolvedRef {
  ref_id: string;
  field: string;
  target_collection_id: string;
  target_record_id: string;
  record: CollectionRecordWithFilePath;
  resource_ref: ResourceRef;
}
export interface CollectionMissingRef {
  ref_id: string;
  field: string;
  target_collection_id: string;
  target_record_id?: string;
  reason: "empty" | "invalid" | "not_found";
}
export interface CollectionResolvedEmbed {
  embed_id: string;
  field: string;
  value: JsonValue;
}
export interface CollectionRecordResolution {
  collection_id: string;
  record_id: string;
  resolved_refs: CollectionResolvedRef[];
  missing_refs: CollectionMissingRef[];
  embed_fields: CollectionResolvedEmbed[];
}
export interface CollectionTriggerEffect {
  id: string;
  event: "record.created" | "record.patched";
  action_id: string;
  action_kind: string;
  status: "queued" | "ignored";
  reason?: string;
  record_ref: ResourceRef;
}
export interface CollectionTriggerJobSummary {
  id: string;
  status: AutomationJobRecord["status"];
  next_run_at?: string;
  last_run_at?: string;
  retry_after_at?: string;
  failure_count: number;
  last_error?: string;
  updated_at: string;
}
export interface AutomationQueueSummary {
  now: string;
  total: number;
  due: number;
  locked: number;
  retry_due: number;
  retry_pending: number;
  exhausted: number;
  by_status: Record<string, number>;
  by_kind: Record<string, number>;
  next_due_at?: string;
  oldest_locked_until?: string;
}
export interface CollectionTriggerState {
  collection_id: string;
  trigger_id: string;
  event: string;
  action_id: string;
  action_kind: string;
  enabled: boolean;
  action_exists: boolean;
  status: "idle" | "queued" | "completed" | "failed" | "disabled" | "action_missing";
  pending_job_count: number;
  job_count: number;
  last_job?: CollectionTriggerJobSummary;
  definition: Record<string, JsonValue>;
}
export interface CollectionNote {
  collection_id: string;
  file_path: string;
  content: string;
  role: "context_only";
}
export interface SessionTranscriptExport {
  session: SessionRecord;
  messages: MessageRecord[];
  message_presentations: MessagePresentationRecord[];
  operations: OperationRecord[];
  policy_decisions: PolicyDecisionRecord[];
  audit_records: AuditRecord[];
  artifacts: ArtifactRecord[];
  backend_runs: BackendRunRecord[];
  backend_events: BackendEventRecord[];
  tool_runs: ToolRunRecord[];
  workspace_changes: WorkspaceChangeRecord[];
  change_history: ChangeHistoryEntry[];
  run_history: RunHistoryEntry[];
}

export interface ResourceTranslationResolution {
  status: ResourceTranslationRecord["status"];
  text: string;
  source: "translation" | "fallback";
  target_locale: ResourceTranslationRecord["target_locale"];
  translation?: ResourceTranslationRecord;
}

export interface WorkspaceLayoutCheck {
  path: string;
  exists: boolean;
  kind: "directory";
  required: boolean;
}

export interface WorkspaceDriftIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
  file_path?: string;
  resource_id?: string;
}

export interface WorkspaceRepairStep {
  operation: string;
  reason: string;
  effect: string;
}

export interface WorkspaceResourceBoundary {
  resource: string;
  source_of_truth: "filesystem" | "sqlite" | "derived";
  file_roots: string[];
  sqlite_tables: string[];
  sqlite_role: "none" | "index" | "history" | "queue" | "audit" | "metadata";
  note: string;
}

export interface WikiReindexResult {
  active: number;
  total: number;
  files: number;
  indexed: number;
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: Array<{ file_path: string; message: string }>;
}

export interface CollectionReindexResult {
  schemas: {
    files: number;
    indexed: number;
    created: number;
    updated: number;
    removed: number;
    skipped: number;
    errors: Array<{ file_path: string; message: string }>;
  };
  records: {
    files: number;
    indexed: number;
    created: number;
    updated: number;
    removed: number;
    skipped: number;
    errors: Array<{ file_path: string; message: string }>;
  };
}

export interface MemoryReindexResult {
  files: number;
  indexed: number;
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: Array<{ file_path: string; message: string }>;
}

export interface SkillReindexResult {
  files: number;
  indexed: number;
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: Array<{ file_path: string; message: string }>;
}

export interface WorkspaceHealthReport {
  ok: boolean;
  checked_at: string;
  root_dir: string;
  db_path: string;
  layout: {
    ok: boolean;
    checks: WorkspaceLayoutCheck[];
    missing: string[];
  };
  resource_boundaries: WorkspaceResourceBoundary[];
  indexes: {
    search: {
      ok: boolean;
      mode: "fts5_trigram" | "fts5" | "like";
      indexed: number;
      source_records: number;
      stale: boolean;
    };
    wiki: {
      ok: boolean;
      files: number;
      indexed: number;
      active: number;
      missing_files: Array<{ id: string; file_path: string; title: string }>;
      unindexed_files: string[];
      invalid_files: Array<{ file_path: string; message: string }>;
      duplicate_ids: Array<{ id: string; file_paths: string[] }>;
    };
    artifacts: {
      ok: boolean;
      files: number;
      indexed: number;
      missing_files: Array<{ id: string; file_path: string; title: string }>;
      unindexed_files: string[];
    };
    memory: {
      ok: boolean;
      files: number;
      indexed: number;
      missing_files: Array<{ id: string; file_path: string; topic: string }>;
      unindexed_files: string[];
      invalid_files: Array<{ file_path: string; message: string }>;
      duplicate_ids: Array<{ id: string; file_paths: string[] }>;
    };
    skills: {
      ok: boolean;
      files: number;
      indexed: number;
      missing_files: Array<{ id: string; file_path: string; title: string }>;
      unindexed_files: string[];
      invalid_files: Array<{ file_path: string; message: string }>;
      duplicate_ids: Array<{ id: string; file_paths: string[] }>;
    };
    collections: {
      ok: boolean;
      schemas: {
        files: number;
        indexed: number;
        missing_files: Array<{ id: string; file_path: string }>;
        unindexed_files: string[];
        invalid_files: Array<{ file_path: string; message: string }>;
      };
      records: {
        files: number;
        indexed: number;
        missing_files: Array<{ id: string; collection_id: string; file_path: string }>;
        unindexed_files: string[];
        invalid_files: Array<{ file_path: string; message: string }>;
      };
    };
  };
  issues: WorkspaceDriftIssue[];
  repair_plan: WorkspaceRepairStep[];
}

export interface MigrationJournalRecord {
  id: string;
  name: string;
  status: "completed" | "failed";
  details: Record<string, JsonValue>;
  created_at: string;
}

export interface WorkspaceIntegrityReport {
  ok: boolean;
  checked_at: string;
  db: {
    ok: boolean;
    result: string;
    path: string;
  };
  workspace: WorkspaceHealthReport;
}

export interface WorkspaceRepairResult {
  dry_run: boolean;
  plan: WorkspaceRepairStep[];
  applied: string[];
  skipped: string[];
  wiki_reindex?: WikiReindexResult;
  memory_reindex?: MemoryReindexResult;
  skill_reindex?: SkillReindexResult;
  collection_reindex?: CollectionReindexResult;
  health: WorkspaceHealthReport;
}

export interface WorkspaceBackupManifest {
  id: string;
  created_at: string;
  source_root: string;
  db_file: string;
  file_roots: string[];
  resource_boundaries: WorkspaceResourceBoundary[];
  health_ok: boolean;
  integrity_ok: boolean;
  file_hashes: Record<string, string>;
}

export interface WorkspaceBackupRecord {
  id: string;
  path: string;
  manifest: WorkspaceBackupManifest;
}

export interface WorkspaceRestoreResult {
  backup_id: string;
  restored_at: string;
  restored_paths: string[];
  db_restored: boolean;
  manifest: WorkspaceBackupManifest;
  pre_restore_health: WorkspaceHealthReport;
  integrity: WorkspaceIntegrityReport;
  health: WorkspaceHealthReport;
}

export interface AutomationRunRecord {
  id: string;
  kind: string;
  source: string;
  session_id?: string;
  backend_run_id?: string;
  status: "started" | "completed" | "failed";
  operation_id?: string;
  started_at: string;
  completed_at?: string;
  error?: string;
}

export interface MemoryArchiveSnapshot {
  frontmatter: MemoryFrontmatter;
  file_path: string;
  state: MemoryFrontmatter["state"];
  updated_at: string;
}

export interface ArchiveMemoryResult {
  before: MemoryArchiveSnapshot;
  after: MemoryArchiveSnapshot;
  content: string;
  changed: boolean;
  warning?: string;
}

export class WorkspaceStore {
  readonly rootDir: string;
  readonly dbPath: string;
  db: Kysely<WorkspaceDb>;
  private sessionSearchIndexMode: "fts5_trigram" | "fts5" | "like" = "like";
  private readonly fileTransactionFailureInjector?: WorkspaceStoreOptions["fileTransactionFailureInjector"];
  private readonly restoreFailureInjector?: WorkspaceStoreOptions["restoreFailureInjector"];

  constructor(options: WorkspaceStoreOptions) {
    this.rootDir = options.rootDir;
    this.dbPath = path.join(this.rootDir, "workspace.sqlite");
    this.fileTransactionFailureInjector = options.fileTransactionFailureInjector;
    this.restoreFailureInjector = options.restoreFailureInjector;
    this.db = this.openDatabase();
  }

  private openDatabase(): Kysely<WorkspaceDb> {
    const database = new Database(this.dbPath);
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.pragma("busy_timeout = 5000");
    return new Kysely<WorkspaceDb>({
      dialect: new SqliteDialect({
        database
      })
    });
  }

  private reopenDatabase(): void {
    this.db = this.openDatabase();
  }

  static async create(options: WorkspaceStoreOptions): Promise<WorkspaceStore> {
    await ensureWorkspaceLayout(options.rootDir);
    const store = new WorkspaceStore(options);
    await store.migrate();
    await store.recoverWorkspaceFileTransactions();
    await store.ensureDefaultSettings();
    return store;
  }

  async migrate(): Promise<void> {
    const migrationJournalStatement = `CREATE TABLE IF NOT EXISTS migration_journal (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`;
    await sql.raw(migrationJournalStatement).execute(this.db);
    await sql.raw(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`).execute(this.db);

    const statements = [
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        title TEXT NOT NULL,
        ui_locale TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        input_locale TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        envelope_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS message_presentations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        view_id TEXT NOT NULL,
        renderer TEXT NOT NULL,
        view_state_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (message_id) REFERENCES messages(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_message_presentations_session_message ON message_presentations(session_id, message_id)`,
      `CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        actor_identity TEXT NOT NULL,
        instruction_source TEXT NOT NULL,
        instruction_authority TEXT NOT NULL,
        channel TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_ref_json TEXT,
        target_resource_refs_json TEXT NOT NULL,
        proposed_effects_json TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_decision_id TEXT,
        approval_request_id TEXT,
        result_ref_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS domain_command_executions (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        command_id TEXT NOT NULL,
        input_source TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_domain_command_executions_status_updated ON domain_command_executions(status, updated_at)`,
      `CREATE TABLE IF NOT EXISTS objectives (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        completion_criteria_json TEXT NOT NULL,
        status TEXT NOT NULL,
        token_budget INTEGER,
        time_budget_ms INTEGER,
        max_attempts INTEGER,
        current_checkpoint_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_objectives_status_updated ON objectives(status, updated_at)`,
      `CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        parent_work_item_id TEXT,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        retry_after_at TEXT,
        backend_run_id TEXT,
        current_checkpoint_id TEXT,
        failure_kind TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (objective_id) REFERENCES objectives(id),
        FOREIGN KEY (parent_work_item_id) REFERENCES work_items(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_work_items_claim ON work_items(status, retry_after_at, priority, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_work_items_objective ON work_items(objective_id, status)`,
      `CREATE TABLE IF NOT EXISTS work_dependencies (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        predecessor_work_item_id TEXT NOT NULL,
        successor_work_item_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(predecessor_work_item_id, successor_work_item_id),
        FOREIGN KEY (objective_id) REFERENCES objectives(id),
        FOREIGN KEY (predecessor_work_item_id) REFERENCES work_items(id),
        FOREIGN KEY (successor_work_item_id) REFERENCES work_items(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_work_dependencies_successor ON work_dependencies(successor_work_item_id)`,
      `CREATE TABLE IF NOT EXISTS run_checkpoints (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        phase TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        backend_run_id TEXT,
        backend_session_id TEXT,
        event_cursor INTEGER,
        summary TEXT NOT NULL,
        generated_resource_refs_json TEXT NOT NULL,
        pending_operation_ids_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(work_item_id, sequence),
        FOREIGN KEY (objective_id) REFERENCES objectives(id),
        FOREIGN KEY (work_item_id) REFERENCES work_items(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_run_checkpoints_work_item ON run_checkpoints(work_item_id, sequence)`,
      `CREATE TABLE IF NOT EXISTS workspace_file_transactions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        target_path TEXT NOT NULL,
        staged_path TEXT NOT NULL,
        collection_id TEXT,
        record_id TEXT,
        patch_id TEXT,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workspace_file_transactions_status ON workspace_file_transactions(status, created_at)`,
      `CREATE TABLE IF NOT EXISTS generated_surfaces (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        current_revision_id TEXT NOT NULL,
        current_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS artifact_revisions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        revision_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        file_path TEXT NOT NULL,
        blob_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(artifact_id, revision),
        FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_revisions_artifact ON artifact_revisions(artifact_id, revision)`,
      `CREATE TABLE IF NOT EXISTS generated_surface_revisions (
        id TEXT PRIMARY KEY,
        surface_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        revision_json TEXT NOT NULL,
        bundle_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(surface_id, revision),
        FOREIGN KEY (surface_id) REFERENCES generated_surfaces(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_generated_surface_revisions_surface ON generated_surface_revisions(surface_id, revision)`,
      `CREATE TABLE IF NOT EXISTS surface_interactions (
        id TEXT PRIMARY KEY,
        surface_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        interaction_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (surface_id) REFERENCES generated_surfaces(id),
        FOREIGN KEY (revision_id) REFERENCES generated_surface_revisions(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_surface_interactions_surface ON surface_interactions(surface_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS policy_decisions (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        policy_inputs_json TEXT NOT NULL,
        matched_rules_json TEXT NOT NULL,
        required_approval_level TEXT NOT NULL,
        grant_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        requested_level TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        decided_by TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS audit_records (
        id TEXT PRIMARY KEY,
        actor_identity TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        instruction_source TEXT NOT NULL,
        inputs_summary TEXT NOT NULL,
        outputs_summary TEXT NOT NULL,
        policy_decision_id TEXT NOT NULL,
        affected_resources_json TEXT NOT NULL,
        rollback_point_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS rollback_points (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        affected_resources_json TEXT NOT NULL,
        before_snapshot_json TEXT NOT NULL,
        after_snapshot_json TEXT NOT NULL,
        reversible INTEGER NOT NULL,
        irreversible_effects_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        locale TEXT NOT NULL,
        source_locales_json TEXT NOT NULL,
        file_ref_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        source_operation_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS memory_index (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        topic TEXT NOT NULL,
        source TEXT NOT NULL,
        source_locale TEXT NOT NULL,
        content_locale TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        instruction_authority TEXT NOT NULL,
        file_path TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS skill_index (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        required_capabilities_json TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        frontmatter_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS skill_usage (
        skill_id TEXT PRIMARY KEY,
        use_count INTEGER NOT NULL,
        last_used_at TEXT,
        last_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (skill_id) REFERENCES skill_index(id)
      )`,
      `CREATE TABLE IF NOT EXISTS learning_resource_uses (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version TEXT,
        content_hash TEXT,
        stage TEXT NOT NULL,
        source_operation_id TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, resource_kind, resource_id, stage, source_operation_id),
        FOREIGN KEY (run_id) REFERENCES backend_runs(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE INDEX IF NOT EXISTS learning_resource_uses_run_idx ON learning_resource_uses(run_id, created_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS learning_resource_uses_dedupe_idx ON learning_resource_uses(run_id, resource_kind, resource_id, stage, COALESCE(source_operation_id, ''))`,
      `CREATE TABLE IF NOT EXISTS learning_evaluations (
        id TEXT PRIMARY KEY,
        learning_resource_ref_json TEXT NOT NULL,
        learning_resource_version TEXT,
        task_class TEXT NOT NULL,
        compared_run_ids_json TEXT NOT NULL,
        before_metrics_json TEXT NOT NULL,
        after_metrics_json TEXT NOT NULL,
        effect_estimate REAL NOT NULL,
        confidence REAL NOT NULL,
        assessment TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        evaluator TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS learning_evaluations_resource_idx ON learning_evaluations(learning_resource_version, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS learning_snapshots (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        path TEXT NOT NULL,
        resource_counts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS background_review_changes (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        review_run_id TEXT NOT NULL,
        mutation_kind TEXT NOT NULL,
        resource_ref_json TEXT NOT NULL,
        before_version TEXT,
        after_version TEXT NOT NULL,
        reason_summary TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_run_id, mutation_kind, after_version)
      )`,
      `CREATE TABLE IF NOT EXISTS learning_job_reports (
        id TEXT PRIMARY KEY,
        job_kind TEXT NOT NULL,
        run_id TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS learning_job_reports_kind_idx ON learning_job_reports(job_kind, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS curator_state (
        id TEXT PRIMARY KEY,
        paused INTEGER NOT NULL,
        interval_hours INTEGER NOT NULL,
        min_idle_hours REAL NOT NULL,
        stale_after_days INTEGER NOT NULL,
        archive_after_days INTEGER NOT NULL,
        last_run_at TEXT,
        last_run_summary TEXT,
        run_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS wiki_index (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        content_locale TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        frontmatter_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS collection_schemas (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        schema_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS collection_records (
        id TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS collection_patches (
        id TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        source_operation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (collection_id, record_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        backend_run_id TEXT,
        status TEXT NOT NULL,
        operation_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS automation_jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        schedule TEXT NOT NULL,
        target_instruction TEXT NOT NULL,
        delivery_target_json TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        retry_after_at TEXT,
        locked_until TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS external_sends (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        target_json TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        operation_id TEXT,
        approval_request_id TEXT,
        dispatch_result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispatched_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_pairings (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        source_identity TEXT NOT NULL,
        source_label TEXT NOT NULL,
        status TEXT NOT NULL,
        pairing_code TEXT,
        session_key TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_pairing_policies (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        trust_mode TEXT NOT NULL,
        allowlist_json TEXT NOT NULL,
        pairing_ttl_ms INTEGER,
        duplicate_window_ms INTEGER,
        rate_limit_window_ms INTEGER,
        rate_limit_max INTEGER,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_routing_policies (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        session_key_strategy TEXT NOT NULL,
        default_account_id TEXT,
        default_thread_id TEXT,
        default_route TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_inbound_messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        source_identity TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        trusted INTEGER NOT NULL,
        session_key TEXT,
        pairing_id TEXT,
        message_id TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_boundary_policies (
        id TEXT PRIMARY KEY,
        source_channel TEXT NOT NULL,
        source_identity TEXT,
        session_key TEXT NOT NULL,
        allowed_tools_json TEXT NOT NULL,
        mcp_config_refs_json TEXT NOT NULL,
        secret_refs_json TEXT NOT NULL,
        sandbox_json TEXT NOT NULL,
        path_normalization_json TEXT NOT NULL,
        allowlist_json TEXT NOT NULL,
        timeout_ms INTEGER,
        concurrency_lock_json TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_mcp_configs (
        id TEXT PRIMARY KEY,
        server_name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        allowed_tools_json TEXT NOT NULL,
        config_ref_json TEXT,
        secret_refs_json TEXT NOT NULL,
        stdio_json TEXT,
        http_json TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_concurrency_locks (
        id TEXT PRIMARY KEY,
        lock_key TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        policy_id TEXT,
        owner_ref_json TEXT,
        status TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        metadata_json TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_sandbox_instances (
        id TEXT PRIMARY KEY,
        instance_key TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        backend TEXT NOT NULL,
        status TEXT NOT NULL,
        sandbox_json TEXT NOT NULL,
        session_key TEXT,
        owner_ref_json TEXT,
        workspace_root TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        deleted_at TEXT,
        metadata_json TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS gateway_sandbox_workspace_syncs (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        instance_key TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_root TEXT,
        remote_workspace_root TEXT,
        file_count INTEGER,
        byte_count INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS reflection_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_run_id TEXT,
        session_id TEXT,
        status TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        output_summary TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS reflection_suggestions (
        id TEXT PRIMARY KEY,
        reflection_run_id TEXT NOT NULL,
        suggestion_type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        target_ref_json TEXT,
        source_refs_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (reflection_run_id) REFERENCES reflection_runs(id)
      )`,
      `CREATE TABLE IF NOT EXISTS tool_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT,
        provider_tool_name TEXT NOT NULL,
        action_id TEXT,
        status TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        output_summary TEXT NOT NULL,
        resource_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES backend_runs(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS external_assist_records (
        id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT,
        input_message_id TEXT,
        query TEXT NOT NULL,
        role TEXT NOT NULL,
        hints_json TEXT NOT NULL,
        error TEXT,
        isolated_from_memory INTEGER NOT NULL,
        included_in_active_memory INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (run_id) REFERENCES backend_runs(id),
        FOREIGN KEY (input_message_id) REFERENCES messages(id)
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY,
        ui_locale TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        memory_capture_mode TEXT NOT NULL DEFAULT 'auto',
        knowledge_wiki_capture_mode TEXT NOT NULL DEFAULT 'auto',
        skill_capture_mode TEXT NOT NULL DEFAULT 'auto',
        external_provider_role TEXT NOT NULL DEFAULT 'assistive',
        default_backend_id TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS plugin_states (
        manifest_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        version TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        actor_identity TEXT NOT NULL,
        channel TEXT NOT NULL,
        resource_scope TEXT NOT NULL,
        manifest_version TEXT NOT NULL,
        risk_snapshot TEXT NOT NULL,
        scope_snapshot TEXT NOT NULL,
        external_impact_snapshot INTEGER NOT NULL,
        secret_requirement_snapshot TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS backend_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        input_message_id TEXT NOT NULL,
        output_message_id TEXT,
        backend_id TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        input_summary TEXT NOT NULL,
        output_summary TEXT,
        error_code TEXT,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS backend_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        resource_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES backend_runs(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS client_events (
        id TEXT PRIMARY KEY,
        target_client_kind TEXT NOT NULL,
        target_client_id TEXT,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        resource_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acked_at TEXT,
        expires_at TEXT,
        error_code TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_client_events_delivery ON client_events(target_client_kind, status, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_client_events_expiry ON client_events(status, expires_at)`,
      `CREATE TABLE IF NOT EXISTS workspace_changes (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        resource_ref_json TEXT NOT NULL,
        change_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        legacy_operation_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES backend_runs(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS resource_translations (
        id TEXT PRIMARY KEY,
        source_ref_json TEXT NOT NULL,
        source_locale TEXT NOT NULL,
        target_locale TEXT NOT NULL,
        status TEXT NOT NULL,
        original_hash TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        provenance_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ];

    try {
      for (const statement of statements) {
        await sql.raw(statement).execute(this.db);
      }

      await this.ensureSettingsColumns();
      await this.ensureAutomationJobColumns();
      await this.ensureAutomationRunColumns();
      await this.ensureCollectionRecordColumns();
      await this.ensureSessionSearchIndexes();
      const migrationVersion = 1;
      const migrationName = "core_baseline";
      const checksum = createHash("sha256").update(JSON.stringify({ statements, migrationName })).digest("hex");
      const existing = await sql<{ checksum: string }>`SELECT checksum FROM schema_migrations WHERE version = ${migrationVersion}`.execute(this.db);
      const existingChecksum = existing.rows[0]?.checksum;
      if (existingChecksum && existingChecksum !== checksum) {
        throw new Error(`schema_migration_checksum_mismatch:${migrationVersion}`);
      }
      if (!existingChecksum) {
        await sql`INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (${migrationVersion}, ${migrationName}, ${checksum}, ${nowIso()})`.execute(this.db);
      }
      const deliveryMigration=gatewayDeliveryMigration;
      const deliveryChecksum=createHash("sha256").update(JSON.stringify({statements:deliveryMigration.statements,migrationName:deliveryMigration.name})).digest("hex");
      const deliveryExisting=await sql<{checksum:string}>`SELECT checksum FROM schema_migrations WHERE version = ${deliveryMigration.version}`.execute(this.db);
      if(deliveryExisting.rows[0]?.checksum&&deliveryExisting.rows[0].checksum!==deliveryChecksum)throw new Error(`schema_migration_checksum_mismatch:${deliveryMigration.version}`);
      if(!deliveryExisting.rows[0]){for(const statement of deliveryMigration.statements)await sql.raw(statement).execute(this.db);await sql`INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (${deliveryMigration.version},${deliveryMigration.name},${deliveryChecksum},${nowIso()})`.execute(this.db)}
      const optimizationChecksum = createHash("sha256").update(JSON.stringify({ statements: skillOptimizationMigration.statements, migrationName: skillOptimizationMigration.name })).digest("hex");
      const optimizationExisting = await sql<{ checksum: string }>`SELECT checksum FROM schema_migrations WHERE version = ${skillOptimizationMigration.version}`.execute(this.db);
      if (optimizationExisting.rows[0]?.checksum && optimizationExisting.rows[0].checksum !== optimizationChecksum) throw new Error(`schema_migration_checksum_mismatch:${skillOptimizationMigration.version}`);
      if (!optimizationExisting.rows[0]) {
        for (const statement of skillOptimizationMigration.statements) await sql.raw(statement).execute(this.db);
        await sql`INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (${skillOptimizationMigration.version},${skillOptimizationMigration.name},${optimizationChecksum},${nowIso()})`.execute(this.db);
      }
      await this.ensureGeneratedSurfacePresentationColumns();
      await this.recordMigrationJournal("schema.ensure", "completed", { statement_count: statements.length });
    } catch (error) {
      await this.recordMigrationJournal("schema.ensure", "failed", {
        statement_count: statements.length,
        error: errorMessage(error)
      }).catch(() => undefined);
      throw error;
    }
  }

  private async ensureGeneratedSurfacePresentationColumns(): Promise<void> {
    const columns = await sql<{ name: string }>`PRAGMA table_info(message_presentations)`.execute(this.db);
    const existing = new Set(columns.rows.map((row) => row.name));
    for (const column of ["surface_id", "revision_id", "preview_url"] as const) {
      if (!existing.has(column)) {
        await sql.raw(`ALTER TABLE message_presentations ADD COLUMN ${column} TEXT`).execute(this.db);
      }
    }
  }

  async listSchemaMigrations(): Promise<Array<{ version: number; name: string; checksum: string; applied_at: string }>> {
    const result = await sql<{ version: number; name: string; checksum: string; applied_at: string }>`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`.execute(this.db);
    return result.rows.map((row) => ({ ...row, version: Number(row.version) }));
  }

  async getSqliteRuntimeSettings(): Promise<{ foreign_keys: number; journal_mode: string; busy_timeout: number; synchronous: number }> {
    const [foreignKeys, journalMode, busyTimeout, synchronous] = await Promise.all([
      sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(this.db),
      sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(this.db),
      sql<{ timeout: number }>`PRAGMA busy_timeout`.execute(this.db),
      sql<{ synchronous: number }>`PRAGMA synchronous`.execute(this.db)
    ]);
    return {
      foreign_keys: Number(foreignKeys.rows[0]?.foreign_keys ?? 0),
      journal_mode: String(journalMode.rows[0]?.journal_mode ?? ""),
      busy_timeout: Number(busyTimeout.rows[0]?.timeout ?? 0),
      synchronous: Number(synchronous.rows[0]?.synchronous ?? 0)
    };
  }

  private async ensureSessionSearchIndexes(): Promise<void> {
    try {
      await sql.raw("DROP TABLE IF EXISTS session_search_fts").execute(this.db);
      await sql.raw("DROP TABLE IF EXISTS session_search_trigram").execute(this.db);
      await sql.raw("CREATE VIRTUAL TABLE session_search_fts USING fts5(kind UNINDEXED, id UNINDEXED, session_id UNINDEXED, operation_id UNINDEXED, title, body, tokenize='unicode61')").execute(this.db);
      try {
        await sql.raw("CREATE VIRTUAL TABLE session_search_trigram USING fts5(kind UNINDEXED, id UNINDEXED, session_id UNINDEXED, operation_id UNINDEXED, title, body, tokenize='trigram')").execute(this.db);
        this.sessionSearchIndexMode = "fts5_trigram";
      } catch {
        this.sessionSearchIndexMode = "fts5";
      }
      await this.reindexSessionSearch();
    } catch {
      this.sessionSearchIndexMode = "like";
    }
  }

  private async ensureSettingsColumns(): Promise<void> {
    const hadKnowledgeWikiCaptureMode = await this.hasTableColumn("settings", "knowledge_wiki_capture_mode");
    const hadLegacyLlmWikiCaptureMode = await this.hasTableColumn("settings", "llm_wiki_capture_mode");
    const columns = [
      ["memory_capture_mode", "TEXT NOT NULL DEFAULT 'auto'"],
      ["knowledge_wiki_capture_mode", "TEXT NOT NULL DEFAULT 'auto'"],
      ["skill_capture_mode", "TEXT NOT NULL DEFAULT 'auto'"],
      ["external_provider_role", "TEXT NOT NULL DEFAULT 'assistive'"],
      ["default_backend_id", "TEXT"]
    ] as const;

    for (const [name, definition] of columns) {
      try {
        await sql.raw(`ALTER TABLE settings ADD COLUMN ${name} ${definition}`).execute(this.db);
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error;
        }
      }
    }

    if (!hadKnowledgeWikiCaptureMode && hadLegacyLlmWikiCaptureMode) {
      await sql.raw(
        "UPDATE settings SET knowledge_wiki_capture_mode = llm_wiki_capture_mode WHERE llm_wiki_capture_mode IS NOT NULL"
      ).execute(this.db);
    }
    await sql.raw("UPDATE settings SET memory_capture_mode = 'auto' WHERE memory_capture_mode = 'suggest'").execute(this.db);
    await sql.raw("UPDATE settings SET knowledge_wiki_capture_mode = 'auto' WHERE knowledge_wiki_capture_mode = 'suggest'").execute(this.db);
    await sql.raw("UPDATE settings SET skill_capture_mode = 'auto' WHERE skill_capture_mode = 'suggest'").execute(this.db);
  }

  private async ensureAutomationJobColumns(): Promise<void> {
    const columns = [
      ["retry_after_at", "TEXT"],
      ["locked_until", "TEXT"],
      ["failure_count", "INTEGER NOT NULL DEFAULT 0"],
      ["max_attempts", "INTEGER NOT NULL DEFAULT 3"],
      ["last_error", "TEXT"]
    ] as const;

    for (const [name, definition] of columns) {
      try {
        await sql.raw(`ALTER TABLE automation_jobs ADD COLUMN ${name} ${definition}`).execute(this.db);
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error;
        }
      }
    }
  }

  private async ensureAutomationRunColumns(): Promise<void> {
    const columns = [
      ["backend_run_id", "TEXT"]
    ] as const;

    for (const [name, definition] of columns) {
      try {
        await sql.raw(`ALTER TABLE automation_runs ADD COLUMN ${name} ${definition}`).execute(this.db);
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error;
        }
      }
    }
  }

  private async ensureCollectionRecordColumns(): Promise<void> {
    try {
      await sql.raw("ALTER TABLE collection_records ADD COLUMN version INTEGER NOT NULL DEFAULT 1").execute(this.db);
    } catch (error) {
      if (!isDuplicateColumnError(error)) {
        throw error;
      }
    }
  }

  private async hasTableColumn(table: string, name: string): Promise<boolean> {
    const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(this.db);
    return result.rows.some((row) => row.name === name);
  }

  async ensureDefaultSettings(): Promise<void> {
    const existing = await this.db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirst();
    if (existing) {
      return;
    }

    const settings = defaultSettings();
    await this.db
      .insertInto("settings")
      .values({
        id: "default",
        ui_locale: settings.ui_locale,
        output_locale: settings.output_locale,
        memory_capture_mode: settings.memory_capture_mode,
        knowledge_wiki_capture_mode: settings.knowledge_wiki_capture_mode,
        skill_capture_mode: settings.skill_capture_mode,
        external_provider_role: settings.external_provider_role,
        default_backend_id: settings.default_backend_id ?? null,
        updated_at: settings.updated_at
      })
      .execute();
  }

  async createSession(session: SessionRecord): Promise<SessionRecord> {
    await this.db.insertInto("sessions").values(session).execute();
    await this.upsertSessionSearchEntry({ kind: "session", id: session.id, title: session.title, body: session.session_key });
    return session;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const rows = await this.db.selectFrom("sessions").selectAll().orderBy("updated_at", "desc").execute();
    return rows.map(sessionFromRow);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const row = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
    return row ? sessionFromRow(row) : undefined;
  }

  async saveSessionCompaction(recordInput: SessionCompactionRecord): Promise<SessionCompactionRecord> {
    const record = SessionCompactionRecordSchema.parse(recordInput);
    const relativePath = path.join("sessions", record.session_id, "context-summary.json");
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const pendingPath = `${absolutePath}.pending`;
    await writeFile(pendingPath, `${JSON.stringify(record, null, 2)}\n`);
    await rename(pendingPath, absolutePath);
    return record;
  }

  async getSessionCompaction(sessionId: string): Promise<SessionCompactionRecord | undefined> {
    const raw = await readFile(path.join(this.rootDir, "sessions", sessionId, "context-summary.json"), "utf8").catch(() => undefined);
    return raw ? SessionCompactionRecordSchema.parse(JSON.parse(raw)) : undefined;
  }

  async exportSessionTranscript(sessionId: string): Promise<SessionTranscriptExport | undefined> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const [messages, messagePresentations, operations, artifacts, backendRuns, backendEvents, toolRuns, workspaceChanges, changeHistory, runHistory] = await Promise.all([
      this.listMessages(sessionId),
      this.listMessagePresentations({ sessionId }),
      this.listOperations(sessionId),
      this.listArtifactsForSession(sessionId),
      this.listBackendRuns(sessionId),
      this.listBackendEvents({ sessionId }),
      this.listToolRuns({ sessionId }),
      this.listWorkspaceChanges(sessionId),
      this.listChangeHistoryEntries(sessionId),
      this.listRunHistoryEntries(sessionId)
    ]);
    const operationIds = new Set(operations.map((operation) => operation.id));
    const [policyDecisions, auditRecords] = await Promise.all([
      this.listPolicyDecisions(),
      this.listAuditRecords()
    ]);
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

  async touchSession(sessionId: string, title?: string): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({
        ...(title ? { title } : {}),
        updated_at: nowIso()
      })
      .where("id", "=", sessionId)
      .execute();
    const session = await this.getSession(sessionId);
    if (session) await this.upsertSessionSearchEntry({ kind: "session", id: session.id, title: session.title, body: session.session_key });
  }

  async saveMessage(message: MessageRecord): Promise<MessageRecord> {
    await this.db
      .insertInto("messages")
      .values({
        id: message.id,
        session_id: message.session_id,
        role: message.role,
        content: message.content,
        input_locale: message.input_locale,
        output_locale: message.output_locale,
        envelope_json: message.envelope ? stringify(message.envelope) : null,
        created_at: message.created_at
      })
      .execute();
    const session = await this.getSession(message.session_id);
    const nextTitle = message.role === "user" && session && isInitialSessionTitle(session.title) ? titleFromContent(message.content) : undefined;
    await this.touchSession(message.session_id, nextTitle);
    await this.upsertSessionSearchEntry({ kind: "message", id: message.id, sessionId: message.session_id, title: message.role, body: message.content });
    return message;
  }

  async updateMessageContent(messageId: string, content: string): Promise<MessageRecord | undefined> {
    await this.db.updateTable("messages").set({ content }).where("id", "=", messageId).execute();
    const row = await this.db.selectFrom("messages").selectAll().where("id", "=", messageId).executeTakeFirst();
    if (!row) return undefined;
    const message = messageFromRow(row);
    await this.upsertSessionSearchEntry({ kind: "message", id: message.id, sessionId: message.session_id, title: message.role, body: message.content });
    return message;
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    const result = await this.db.deleteFrom("messages").where("id", "=", messageId).executeTakeFirst();
    if (Number(result.numDeletedRows) === 1) await this.deleteSessionSearchEntry("message", messageId);
    return Number(result.numDeletedRows) === 1;
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const rows = await this.db.selectFrom("messages").selectAll().where("session_id", "=", sessionId).orderBy("created_at").execute();
    return rows.map(messageFromRow);
  }

  async saveMessagePresentation(presentation: MessagePresentationRecord): Promise<MessagePresentationRecord> {
    await this.db
      .insertInto("message_presentations")
      .values(messagePresentationToRow(presentation))
      .execute();
    return presentation;
  }

  async getMessagePresentation(id: string): Promise<MessagePresentationRecord | undefined> {
    const row = await this.db
      .selectFrom("message_presentations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? messagePresentationFromRow(row) : undefined;
  }

  async updateMessagePresentationViewState(input: { id: string; viewState: Record<string, JsonValue>; updatedAt?: string }): Promise<MessagePresentationRecord | undefined> {
    const updatedAt = input.updatedAt ?? nowIso();
    const viewId = typeof input.viewState.view_id === "string" && input.viewState.view_id.trim()
      ? input.viewState.view_id
      : undefined;
    const renderer = typeof input.viewState.renderer === "string" && input.viewState.renderer.trim()
      ? input.viewState.renderer
      : undefined;
    await this.db
      .updateTable("message_presentations")
      .set({
        ...(viewId ? { view_id: viewId } : {}),
        ...(renderer ? { renderer } : {}),
        view_state_json: stringify(input.viewState),
        updated_at: updatedAt
      })
      .where("id", "=", input.id)
      .execute();
    const row = await this.db
      .selectFrom("message_presentations")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    return row ? messagePresentationFromRow(row) : undefined;
  }

  async listMessagePresentations(input: { sessionId: string; messageId?: string }): Promise<MessagePresentationRecord[]> {
    let query = this.db
      .selectFrom("message_presentations")
      .selectAll()
      .where("session_id", "=", input.sessionId);
    if (input.messageId) {
      query = query.where("message_id", "=", input.messageId);
    }
    const rows = await query.orderBy("created_at").execute();
    return rows.map(messagePresentationFromRow);
  }

  async saveOperation(operation: OperationRecord): Promise<OperationRecord> {
    await this.db
      .insertInto("operations")
      .values(operationToRow(operation))
      .execute();
    return operation;
  }

  async saveObjective(record: ObjectiveRecord): Promise<ObjectiveRecord> {
    await this.db.insertInto("objectives").values(objectiveToRow(record)).onConflict((conflict) => conflict.column("id").doUpdateSet(objectiveToRow(record))).execute();
    return record;
  }

  async getObjective(id: string): Promise<ObjectiveRecord | undefined> {
    const row = await this.db.selectFrom("objectives").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? objectiveFromRow(row) : undefined;
  }

  async listObjectives(status?: ObjectiveRecord["status"]): Promise<ObjectiveRecord[]> {
    let query = this.db.selectFrom("objectives").selectAll();
    if (status) query = query.where("status", "=", status);
    return (await query.orderBy("updated_at", "desc").execute()).map(objectiveFromRow);
  }

  async updateObjective(record: ObjectiveRecord): Promise<ObjectiveRecord> {
    await this.db.updateTable("objectives").set(objectiveToRow(record)).where("id", "=", record.id).execute();
    return record;
  }

  async saveWorkItem(record: WorkItemRecord): Promise<WorkItemRecord> {
    await this.db.insertInto("work_items").values(workItemToRow(record)).onConflict((conflict) => conflict.column("id").doUpdateSet(workItemToRow(record))).execute();
    return record;
  }

  async getWorkItem(id: string): Promise<WorkItemRecord | undefined> {
    const row = await this.db.selectFrom("work_items").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? workItemFromRow(row) : undefined;
  }

  async listWorkItems(input: { objectiveId?: string; status?: WorkItemRecord["status"] } = {}): Promise<WorkItemRecord[]> {
    let query = this.db.selectFrom("work_items").selectAll();
    if (input.objectiveId) query = query.where("objective_id", "=", input.objectiveId);
    if (input.status) query = query.where("status", "=", input.status);
    return (await query.orderBy("priority", "desc").orderBy("created_at", "asc").execute()).map(workItemFromRow);
  }

  async saveWorkDependency(record: WorkDependencyRecord): Promise<WorkDependencyRecord> {
    await this.db.insertInto("work_dependencies").values(workDependencyToRow(record)).onConflict((conflict) => conflict.columns(["predecessor_work_item_id", "successor_work_item_id"]).doNothing()).execute();
    return record;
  }

  async listWorkDependencies(objectiveId: string): Promise<WorkDependencyRecord[]> {
    return (await this.db.selectFrom("work_dependencies").selectAll().where("objective_id", "=", objectiveId).orderBy("created_at", "asc").execute()).map(workDependencyFromRow);
  }

  async claimWorkItem(input: { workerId: string; leaseMs: number; now?: string }): Promise<WorkItemRecord | undefined> {
    const now = input.now ?? nowIso();
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString();
    const candidates = await this.db.selectFrom("work_items").selectAll()
      .where("status", "in", ["queued", "ready"])
      .where((eb) => eb.or([eb("retry_after_at", "is", null), eb("retry_after_at", "<=", now)]))
      .orderBy("priority", "desc").orderBy("created_at", "asc").limit(50).execute();
    for (const candidate of candidates) {
      const blockers = await this.db.selectFrom("work_dependencies as dependency")
        .innerJoin("work_items as predecessor", "predecessor.id", "dependency.predecessor_work_item_id")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("dependency.successor_work_item_id", "=", candidate.id)
        .where("predecessor.status", "!=", "completed")
        .executeTakeFirst();
      if (Number(blockers?.count ?? 0) > 0) continue;
      const updated = await this.db.updateTable("work_items").set({
        status: "running",
        lease_owner: input.workerId,
        lease_expires_at: leaseExpiresAt,
        heartbeat_at: now,
        attempt: candidate.attempt + 1,
        started_at: candidate.started_at ?? now,
        updated_at: now,
        retry_after_at: null,
        failure_kind: null,
        error: null
      }).where("id", "=", candidate.id).where("status", "in", ["queued", "ready"]).executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1) return this.getWorkItem(candidate.id);
    }
    return undefined;
  }

  async heartbeatWorkItem(input: { workItemId: string; workerId: string; leaseMs: number; now?: string }): Promise<WorkItemRecord | undefined> {
    const now = input.now ?? nowIso();
    const updated = await this.db.updateTable("work_items").set({
      heartbeat_at: now,
      lease_expires_at: new Date(Date.parse(now) + input.leaseMs).toISOString(),
      updated_at: now
    }).where("id", "=", input.workItemId).where("status", "=", "running").where("lease_owner", "=", input.workerId).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getWorkItem(input.workItemId) : undefined;
  }

  async completeWorkItem(input: { workItemId: string; workerId: string; now?: string }): Promise<WorkItemRecord | undefined> {
    const now = input.now ?? nowIso();
    const updated = await this.db.updateTable("work_items").set({
      status: "completed",
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      retry_after_at: null,
      failure_kind: null,
      error: null,
      completed_at: now,
      updated_at: now
    }).where("id", "=", input.workItemId).where("status", "=", "running").where("lease_owner", "=", input.workerId).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getWorkItem(input.workItemId) : undefined;
  }

  async failWorkItem(input: { workItemId: string; workerId: string; failureKind: "retryable" | "non_retryable" | "cancelled"; error: string; now?: string; baseRetryMs?: number }): Promise<WorkItemRecord | undefined> {
    const current = await this.getWorkItem(input.workItemId);
    if (!current || current.status !== "running" || current.lease_owner !== input.workerId) return undefined;
    const now = input.now ?? nowIso();
    const canRetry = input.failureKind === "retryable" && current.attempt < current.max_attempts;
    const retryDelay = (input.baseRetryMs ?? 1_000) * Math.min(2 ** Math.max(0, current.attempt - 1), 64);
    const updated = await this.db.updateTable("work_items").set({
      status: canRetry ? "ready" : input.failureKind === "cancelled" ? "cancelled" : "failed",
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      retry_after_at: canRetry ? new Date(Date.parse(now) + retryDelay).toISOString() : null,
      failure_kind: input.failureKind,
      error: input.error,
      completed_at: canRetry ? null : now,
      updated_at: now
    }).where("id", "=", input.workItemId).where("status", "=", "running").where("lease_owner", "=", input.workerId).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getWorkItem(input.workItemId) : undefined;
  }

  async cancelObjective(input: { objectiveId: string; now?: string }): Promise<{ objective?: ObjectiveRecord; workItems: WorkItemRecord[] }> {
    const now = input.now ?? nowIso();
    await this.db.transaction().execute(async (transaction) => {
      await transaction.updateTable("objectives").set({ status: "cancelled", updated_at: now, completed_at: now }).where("id", "=", input.objectiveId).where("status", "not in", ["completed", "cancelled", "failed"]).execute();
      await transaction.updateTable("work_items").set({
        status: "cancelled",
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        retry_after_at: null,
        failure_kind: "cancelled",
        error: "objective_cancelled",
        updated_at: now,
        completed_at: now
      }).where("objective_id", "=", input.objectiveId).where("status", "not in", ["completed", "cancelled", "failed"]).execute();
    });
    return { objective: await this.getObjective(input.objectiveId), workItems: await this.listWorkItems({ objectiveId: input.objectiveId }) };
  }

  async reconcileExpiredWorkItems(input: { now?: string; baseRetryMs?: number } = {}): Promise<WorkItemRecord[]> {
    const now = input.now ?? nowIso();
    const expired = await this.db.selectFrom("work_items").selectAll().where("status", "=", "running").where("lease_expires_at", "<=", now).execute();
    const reconciled: WorkItemRecord[] = [];
    for (const row of expired) {
      const terminal = row.attempt >= row.max_attempts;
      const retryDelay = (input.baseRetryMs ?? 1_000) * Math.min(2 ** Math.max(0, row.attempt - 1), 64);
      const updated = await this.db.updateTable("work_items").set({
        status: terminal ? "failed" : "ready",
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        retry_after_at: terminal ? null : new Date(Date.parse(now) + retryDelay).toISOString(),
        failure_kind: terminal ? "non_retryable" : "retryable",
        error: terminal ? "work_item_max_attempts_exceeded" : "work_item_lease_expired",
        updated_at: now,
        completed_at: terminal ? now : null
      }).where("id", "=", row.id).where("status", "=", "running").where("lease_expires_at", "<=", now).executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1) {
        const record = await this.getWorkItem(row.id);
        if (record) reconciled.push(record);
      }
    }
    return reconciled;
  }

  async saveRunCheckpoint(record: RunCheckpointRecord): Promise<RunCheckpointRecord> {
    await this.db.insertInto("run_checkpoints").values(runCheckpointToRow(record)).onConflict((conflict) => conflict.column("idempotency_key").doNothing()).execute();
    const saved = await this.db.selectFrom("run_checkpoints").selectAll().where("idempotency_key", "=", record.idempotency_key).executeTakeFirstOrThrow();
    const checkpoint = runCheckpointFromRow(saved);
    await this.db.updateTable("work_items").set({ current_checkpoint_id: checkpoint.id, updated_at: record.created_at }).where("id", "=", record.work_item_id).execute();
    await this.db.updateTable("objectives").set({ current_checkpoint_id: checkpoint.id, updated_at: record.created_at }).where("id", "=", record.objective_id).execute();
    return checkpoint;
  }

  async saveGeneratedSurfaceRevision(input: {
    definition: GeneratedSurfaceDefinition;
    revision: GeneratedSurfaceRevisionRecord;
    html: string;
    css?: string;
    script?: string;
    assets?: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>;
  }): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord }> {
    const assetFiles = (input.assets ?? []).map((asset) => {
      const ref = input.revision.asset_refs.find((candidate) => candidate.label === asset.path);
      if (!ref) throw new Error(`generated_surface_asset_ref_missing:${asset.path}`);
      return { ref, content: asset.encoding === "base64" ? Buffer.from(asset.content, "base64") : asset.content };
    });
    const files = [
      { ref: input.revision.html_ref, content: input.html },
      ...(input.revision.css_ref ? [{ ref: input.revision.css_ref, content: input.css ?? "" }] : []),
      ...(input.revision.script_ref ? [{ ref: input.revision.script_ref, content: input.script ?? "" }] : []),
      ...assetFiles
    ];
    const absoluteFiles = files.map((file) => {
      const absolute = path.resolve(this.rootDir, file.ref.uri);
      const root = `${path.resolve(this.rootDir)}${path.sep}`;
      if (!absolute.startsWith(root)) throw new Error("generated_surface_file_path_invalid");
      return { ...file, absolute };
    });
    for (const file of absoluteFiles) {
      const absolute = file.absolute;
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content, { flag: "wx" });
    }
    try {
      await this.db.transaction().execute(async (transaction) => {
        await transaction.insertInto("generated_surfaces").values(generatedSurfaceToRow(input.definition)).onConflict((conflict) => conflict.column("id").doUpdateSet(generatedSurfaceToRow(input.definition))).execute();
        await transaction.insertInto("generated_surface_revisions").values(generatedSurfaceRevisionToRow(input.revision)).execute();
      });
    } catch (error) {
      await Promise.all(absoluteFiles.map((file) => rm(file.absolute, { force: true })));
      throw error;
    }
    return { definition: input.definition, revision: input.revision };
  }

  async getGeneratedSurface(id: string): Promise<GeneratedSurfaceDefinition | undefined> {
    const row = await this.db.selectFrom("generated_surfaces").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? parse<GeneratedSurfaceDefinition>(row.definition_json) : undefined;
  }

  async listGeneratedSurfaces(sessionId?: string): Promise<GeneratedSurfaceDefinition[]> {
    let query = this.db.selectFrom("generated_surfaces").selectAll();
    if (sessionId) query = query.where("session_id", "=", sessionId);
    return (await query.orderBy("updated_at", "desc").execute()).map((row) => parse<GeneratedSurfaceDefinition>(row.definition_json));
  }

  async getGeneratedSurfaceRevision(id: string): Promise<GeneratedSurfaceRevisionRecord | undefined> {
    const row = await this.db.selectFrom("generated_surface_revisions").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? parse<GeneratedSurfaceRevisionRecord>(row.revision_json) : undefined;
  }

  async listGeneratedSurfaceRevisions(surfaceId: string): Promise<GeneratedSurfaceRevisionRecord[]> {
    return (await this.db.selectFrom("generated_surface_revisions").selectAll().where("surface_id", "=", surfaceId).orderBy("revision", "asc").execute()).map((row) => parse<GeneratedSurfaceRevisionRecord>(row.revision_json));
  }

  async readGeneratedSurfaceBundle(revisionId: string): Promise<{ html: string; css?: string; script?: string } | undefined> {
    const revision = await this.getGeneratedSurfaceRevision(revisionId);
    if (!revision) return undefined;
    return {
      html: await readFile(path.join(this.rootDir, revision.html_ref.uri), "utf8"),
      ...(revision.css_ref ? { css: await readFile(path.join(this.rootDir, revision.css_ref.uri), "utf8") } : {}),
      ...(revision.script_ref ? { script: await readFile(path.join(this.rootDir, revision.script_ref.uri), "utf8") } : {})
    };
  }

  async readGeneratedSurfaceAssets(revisionId: string): Promise<Array<{ path: string; content: Buffer }>> {
    const revision = await this.getGeneratedSurfaceRevision(revisionId);
    if (!revision) return [];
    const root = `${path.resolve(this.rootDir)}${path.sep}`;
    const assets: Array<{ path: string; content: Buffer }> = [];
    for (const ref of revision.asset_refs ?? []) {
      const absolute = path.resolve(this.rootDir, ref.uri);
      if (!absolute.startsWith(root)) continue;
      const assetPath = ref.label ?? path.basename(ref.uri);
      if (!assetPath || assetPath.includes("..")) continue;
      try {
        assets.push({ path: assetPath, content: await readFile(absolute) });
      } catch {
        // A missing optional asset does not make the HTML revision unreadable.
      }
    }
    return assets;
  }

  async updateGeneratedSurfaceState(id: string, state: GeneratedSurfaceDefinition["state"], updatedAt = nowIso()): Promise<GeneratedSurfaceDefinition | undefined> {
    const current = await this.getGeneratedSurface(id);
    if (!current) return undefined;
    const next = { ...current, state, updated_at: updatedAt };
    await this.db.updateTable("generated_surfaces").set(generatedSurfaceToRow(next)).where("id", "=", id).execute();
    return next;
  }

  async saveSurfaceInteraction(record: SurfaceInteractionRecord): Promise<SurfaceInteractionRecord> {
    await this.db.insertInto("surface_interactions").values(surfaceInteractionToRow(record)).execute();
    return record;
  }

  async listSurfaceInteractions(surfaceId: string): Promise<SurfaceInteractionRecord[]> {
    return (await this.db.selectFrom("surface_interactions").selectAll().where("surface_id", "=", surfaceId).orderBy("created_at", "asc").execute()).map((row) => parse<SurfaceInteractionRecord>(row.interaction_json));
  }

  async saveSkillOptimizationRun(input: SkillOptimizationRun): Promise<SkillOptimizationRun> {
    const record = SkillOptimizationRunSchema.parse(input);
    await this.db.insertInto("skill_optimization_runs").values({
      id: record.id,
      target_skill_id: record.target_skill_id,
      session_id: record.session_id ?? null,
      status: record.status,
      run_json: stringify(record),
      created_at: record.created_at,
      updated_at: record.updated_at
    }).onConflict((conflict) => conflict.column("id").doUpdateSet({
      status: record.status,
      run_json: stringify(record),
      updated_at: record.updated_at
    })).execute();
    return record;
  }

  async getSkillOptimizationRun(id: string): Promise<SkillOptimizationRun | undefined> {
    const row = await this.db.selectFrom("skill_optimization_runs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? SkillOptimizationRunSchema.parse(parse<SkillOptimizationRun>(row.run_json)) : undefined;
  }

  async listSkillOptimizationRuns(input: { skillId?: string; status?: SkillOptimizationRun["status"] } = {}): Promise<SkillOptimizationRun[]> {
    let query = this.db.selectFrom("skill_optimization_runs").selectAll().orderBy("created_at", "desc");
    if (input.skillId) query = query.where("target_skill_id", "=", input.skillId);
    if (input.status) query = query.where("status", "=", input.status);
    return (await query.execute()).map((row) => SkillOptimizationRunSchema.parse(parse<SkillOptimizationRun>(row.run_json)));
  }

  async saveSkillOptimizationDataset(input: SkillOptimizationDataset): Promise<SkillOptimizationDataset> {
    const record = SkillOptimizationDatasetSchema.parse(input);
    await this.db.insertInto("skill_optimization_datasets").values({
      id: record.id,
      skill_id: record.skill_id,
      dataset_json: stringify(record),
      created_at: record.created_at
    }).onConflict((conflict) => conflict.column("id").doUpdateSet({ dataset_json: stringify(record) })).execute();
    return record;
  }

  async getSkillOptimizationDataset(id: string): Promise<SkillOptimizationDataset | undefined> {
    const row = await this.db.selectFrom("skill_optimization_datasets").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? SkillOptimizationDatasetSchema.parse(parse<SkillOptimizationDataset>(row.dataset_json)) : undefined;
  }

  async saveOptimizationCandidate(input: OptimizationCandidate): Promise<OptimizationCandidate> {
    const record = OptimizationCandidateSchema.parse(input);
    await this.db.insertInto("optimization_candidates").values({
      id: record.id,
      run_id: record.run_id,
      skill_id: record.skill_id,
      content_hash: record.content_hash,
      body: record.body,
      candidate_json: stringify(record),
      created_at: record.created_at,
      updated_at: record.updated_at
    }).onConflict((conflict) => conflict.column("id").doUpdateSet({
      content_hash: record.content_hash,
      body: record.body,
      candidate_json: stringify(record),
      updated_at: record.updated_at
    })).execute();
    return record;
  }

  async getOptimizationCandidate(id: string): Promise<OptimizationCandidate | undefined> {
    const row = await this.db.selectFrom("optimization_candidates").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? OptimizationCandidateSchema.parse(parse<OptimizationCandidate>(row.candidate_json)) : undefined;
  }

  async listOptimizationCandidates(runId: string): Promise<OptimizationCandidate[]> {
    return (await this.db.selectFrom("optimization_candidates").selectAll().where("run_id", "=", runId).orderBy("created_at", "asc").execute()).map((row) => OptimizationCandidateSchema.parse(parse<OptimizationCandidate>(row.candidate_json)));
  }

  async saveOptimizationEvaluation(input: OptimizationEvaluation): Promise<OptimizationEvaluation> {
    const record = OptimizationEvaluationSchema.parse(input);
    await this.db.insertInto("optimization_evaluations").values({
      id: record.id,
      run_id: record.run_id,
      candidate_id: record.candidate_id,
      evaluation_json: stringify(record),
      created_at: record.created_at
    }).onConflict((conflict) => conflict.column("id").doUpdateSet({ evaluation_json: stringify(record) })).execute();
    return record;
  }

  async listOptimizationEvaluations(candidateId?: string): Promise<OptimizationEvaluation[]> {
    let query = this.db.selectFrom("optimization_evaluations").selectAll().orderBy("created_at", "asc");
    if (candidateId) query = query.where("candidate_id", "=", candidateId);
    return (await query.execute()).map((row) => OptimizationEvaluationSchema.parse(parse<OptimizationEvaluation>(row.evaluation_json)));
  }

  async saveSkillOptimizationSnapshot(input: SkillOptimizationSnapshot): Promise<SkillOptimizationSnapshot> {
    const record = SkillOptimizationSnapshotSchema.parse(input);
    await this.db.insertInto("skill_optimization_snapshots").values({
      id: record.id,
      skill_id: record.skill_id,
      candidate_id: record.candidate_id,
      content_hash: record.content_hash,
      markdown: record.markdown,
      snapshot_json: stringify(record),
      created_at: record.created_at,
      restored_at: record.restored_at ?? null
    }).onConflict((conflict) => conflict.column("id").doUpdateSet({ restored_at: record.restored_at ?? null, snapshot_json: stringify(record) })).execute();
    return record;
  }

  async getSkillOptimizationSnapshot(id: string): Promise<SkillOptimizationSnapshot | undefined> {
    const row = await this.db.selectFrom("skill_optimization_snapshots").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? SkillOptimizationSnapshotSchema.parse(parse<SkillOptimizationSnapshot>(row.snapshot_json)) : undefined;
  }

  async saveOptimizationPromotion(input: OptimizationPromotion): Promise<OptimizationPromotion> {
    const record = OptimizationPromotionSchema.parse(input);
    await this.db.insertInto("optimization_promotions").values({
      id: record.id,
      run_id: record.run_id,
      candidate_id: record.candidate_id,
      skill_id: record.skill_id,
      promotion_json: stringify(record),
      created_at: record.created_at
    }).onConflict((conflict) => conflict.column("id").doUpdateSet({ promotion_json: stringify(record) })).execute();
    return record;
  }

  async listOptimizationPromotions(input: { skillId?: string; candidateId?: string } = {}): Promise<OptimizationPromotion[]> {
    let query = this.db.selectFrom("optimization_promotions").selectAll().orderBy("created_at", "desc");
    if (input.skillId) query = query.where("skill_id", "=", input.skillId);
    if (input.candidateId) query = query.where("candidate_id", "=", input.candidateId);
    return (await query.execute()).map((row) => OptimizationPromotionSchema.parse(parse<OptimizationPromotion>(row.promotion_json)));
  }

  async acquireSkillOptimizationLock(input: { skillId: string; runId: string; acquiredAt?: string }): Promise<boolean> {
    const result = await this.db.insertInto("skill_optimization_locks").values({
      skill_id: input.skillId,
      run_id: input.runId,
      acquired_at: input.acquiredAt ?? nowIso()
    }).onConflict((conflict) => conflict.column("skill_id").doNothing()).executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
  }

  async getSkillOptimizationLock(skillId: string): Promise<{ skill_id: string; run_id: string; acquired_at: string } | undefined> {
    return this.db.selectFrom("skill_optimization_locks").selectAll().where("skill_id", "=", skillId).executeTakeFirst();
  }

  async releaseSkillOptimizationLock(input: { skillId: string; runId: string }): Promise<boolean> {
    const result = await this.db.deleteFrom("skill_optimization_locks").where("skill_id", "=", input.skillId).where("run_id", "=", input.runId).executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  async listRunCheckpoints(workItemId: string): Promise<RunCheckpointRecord[]> {
    return (await this.db.selectFrom("run_checkpoints").selectAll().where("work_item_id", "=", workItemId).orderBy("sequence", "asc").execute()).map(runCheckpointFromRow);
  }

  async claimDomainCommandExecution(record: DomainCommandExecutionRecord): Promise<{ record: DomainCommandExecutionRecord; claimed: boolean }> {
    const inserted = await this.db
      .insertInto("domain_command_executions")
      .values(domainCommandExecutionToRow(record))
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 1) {
      return { record, claimed: true };
    }
    const existing = await this.getDomainCommandExecution(record.idempotency_key);
    if (!existing) {
      throw new Error(`Domain command execution claim disappeared: ${record.idempotency_key}`);
    }
    return { record: existing, claimed: false };
  }

  async getDomainCommandExecution(idempotencyKey: string): Promise<DomainCommandExecutionRecord | undefined> {
    const row = await this.db
      .selectFrom("domain_command_executions")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row ? domainCommandExecutionFromRow(row) : undefined;
  }

  async listDomainCommandExecutions():Promise<DomainCommandExecutionRecord[]>{return(await this.db.selectFrom("domain_command_executions").selectAll().orderBy("created_at","asc").execute()).map(domainCommandExecutionFromRow)}

  async getCorrelationTrace(sessionId:string){const[messages,operations,objectives,backendRuns,toolRuns,changes,learningUses,reflections,commands]=await Promise.all([this.listMessages(sessionId),this.listOperations(sessionId),this.listObjectives(),this.listBackendRuns(sessionId),this.listToolRuns({sessionId}),this.listWorkspaceChanges(sessionId),this.listLearningResourceUses({sessionId}),this.listReflectionRuns(sessionId),this.listDomainCommandExecutions()]);const scopedObjectives=objectives.filter(x=>x.session_id===sessionId),objectiveIds=new Set(scopedObjectives.map(x=>x.id)),workItems=(await this.listWorkItems()).filter(x=>objectiveIds.has(x.objective_id)),runIds=new Set([...backendRuns.map(x=>x.id),...workItems.map(x=>x.backend_run_id).filter((x):x is string=>Boolean(x))]),operationIds=new Set(operations.map(x=>x.id));const scopedCommands=commands.filter(command=>{const text=JSON.stringify(command.result??{});return text.includes(sessionId)||[...operationIds].some(id=>text.includes(id))});const edges:Array<{from:string;to:string;relation:string}>=[];for(const message of messages)edges.push({from:`session:${sessionId}`,to:`message:${message.id}`,relation:"contains"});for(const operation of operations)edges.push({from:`session:${sessionId}`,to:`operation:${operation.id}`,relation:"requested"});for(const objective of scopedObjectives)edges.push({from:`session:${sessionId}`,to:`objective:${objective.id}`,relation:"owns"});for(const work of workItems){edges.push({from:`objective:${work.objective_id}`,to:`work_item:${work.id}`,relation:"decomposes"});if(work.backend_run_id)edges.push({from:`work_item:${work.id}`,to:`run:${work.backend_run_id}`,relation:"executes"})}for(const run of backendRuns)edges.push({from:`session:${sessionId}`,to:`run:${run.id}`,relation:"runs"});for(const tool of toolRuns)edges.push({from:`run:${tool.run_id}`,to:`tool:${tool.id}`,relation:"calls"});for(const change of changes)edges.push({from:`run:${change.run_id}`,to:`change:${change.id}`,relation:"changes"});for(const use of learningUses)edges.push({from:`run:${use.run_id}`,to:`learning_use:${use.id}`,relation:"learns_from"});for(const reflection of reflections)if(reflection.source_run_id)edges.push({from:`run:${reflection.source_run_id}`,to:`reflection:${reflection.id}`,relation:"reviews"});for(const command of scopedCommands)for(const operationId of operationIds)if(JSON.stringify(command.result??{}).includes(operationId))edges.push({from:`command:${command.id}`,to:`operation:${operationId}`,relation:"dispatches"});return{session_id:sessionId,commands:scopedCommands,messages,operations,objectives:scopedObjectives,work_items:workItems,backend_runs:backendRuns.filter(x=>runIds.has(x.id)),tool_runs:toolRuns,workspace_changes:changes,learning_uses:learningUses,reflections,edges}}

  async updateDomainCommandExecution(record: DomainCommandExecutionRecord): Promise<DomainCommandExecutionRecord> {
    await this.db
      .updateTable("domain_command_executions")
      .set(domainCommandExecutionToRow(record))
      .where("id", "=", record.id)
      .execute();
    return record;
  }

  async updateOperation(operation: OperationRecord): Promise<OperationRecord> {
    await this.db
      .updateTable("operations")
      .set(operationToRow(operation))
      .where("id", "=", operation.id)
      .execute();
    return operation;
  }

  async getOperation(operationId: string): Promise<OperationRecord | undefined> {
    const row = await this.db.selectFrom("operations").selectAll().where("id", "=", operationId).executeTakeFirst();
    return row ? operationFromRow(row) : undefined;
  }

  async listOperations(sessionId?: string): Promise<OperationRecord[]> {
    let query = this.db.selectFrom("operations").selectAll();
    if (sessionId) {
      query = query.where("session_id", "=", sessionId);
    }
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map(operationFromRow);
  }

  async saveBackendRun(run: BackendRunRecord): Promise<BackendRunRecord> {
    await this.db.insertInto("backend_runs").values(backendRunToRow(run)).execute();
    return run;
  }

  async updateBackendRun(run: BackendRunRecord): Promise<BackendRunRecord> {
    await this.db.updateTable("backend_runs").set(backendRunToRow(run)).where("id", "=", run.id).execute();
    return run;
  }

  async getBackendRun(runId: string): Promise<BackendRunRecord | undefined> {
    const row = await this.db.selectFrom("backend_runs").selectAll().where("id", "=", runId).executeTakeFirst();
    return row ? backendRunFromRow(row) : undefined;
  }

  async listBackendRuns(sessionId?: string): Promise<BackendRunRecord[]> {
    let query = this.db.selectFrom("backend_runs").selectAll();
    if (sessionId) {
      query = query.where("session_id", "=", sessionId);
    }
    const rows = await query.orderBy("started_at", "desc").execute();
    return rows.map(backendRunFromRow);
  }

  async listRunHistoryEntries(sessionId?: string): Promise<RunHistoryEntry[]> {
    const [runs, events, changes] = await Promise.all([
      this.listBackendRuns(sessionId),
      this.listBackendEvents(sessionId ? { sessionId } : {}),
      this.listWorkspaceChanges(sessionId)
    ]);
    const eventCounts = countBy(events, (event) => event.run_id);
    const changeCounts = countBy(changes, (change) => change.run_id);
    return runs.map((run) => ({
      id: run.id,
      session_id: run.session_id,
      backend_id: run.backend_id,
      backend_kind: run.backend_kind,
      status: run.status,
      input_summary: run.input_summary,
      output_summary: run.output_summary,
      started_at: run.started_at,
      completed_at: run.completed_at,
      event_count: eventCounts.get(run.id) ?? 0,
      workspace_change_count: changeCounts.get(run.id) ?? 0,
      error_code: run.error_code
    }));
  }

  async saveBackendEvent(event: BackendEventRecord): Promise<BackendEventRecord> {
    const safeEvent = { ...event, payload: redactPrivateData(event.payload, { redactPii: true }) };
    await this.db.insertInto("backend_events").values(backendEventToRow(safeEvent)).execute();
    return safeEvent;
  }

  async listBackendEvents(input: { runId?: string; sessionId?: string; afterSequence?: number; limit?: number } = {}): Promise<BackendEventRecord[]> {
    let query = this.db.selectFrom("backend_events").selectAll();
    if (input.runId) {
      query = query.where("run_id", "=", input.runId);
    }
    if (input.sessionId) {
      query = query.where("session_id", "=", input.sessionId);
    }
    if (input.afterSequence !== undefined) {
      query = query.where("sequence", ">", input.afterSequence);
    }
    if (input.limit !== undefined) {
      query = query.limit(Math.max(1, Math.min(input.limit, 1_000)));
    }
    const rows = await query.orderBy("run_id").orderBy("sequence").execute();
    return rows.map(backendEventFromRow);
  }

  async saveClientEvent(event: ClientEventRecord): Promise<ClientEventRecord> {
    await this.db
      .insertInto("client_events")
      .values(clientEventToRow(event))
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    return event;
  }

  async getClientEvent(eventId: string): Promise<ClientEventRecord | undefined> {
    const row = await this.db.selectFrom("client_events").selectAll().where("id", "=", eventId).executeTakeFirst();
    return row ? clientEventFromRow(row) : undefined;
  }

  async listClientEvents(input: {
    targetClientKind?: ClientEventRecord["target_client_kind"];
    targetClientId?: string;
    status?: ClientEventRecord["status"];
    limit?: number;
  } = {}): Promise<ClientEventRecord[]> {
    let query = this.db.selectFrom("client_events").selectAll();
    if (input.targetClientKind) {
      const targetClientKind = input.targetClientKind;
      query = query.where((eb) => eb.or([
        eb("target_client_kind", "=", targetClientKind),
        eb("target_client_kind", "=", "any")
      ]));
    }
    if (input.targetClientId) {
      const targetClientId = input.targetClientId;
      query = query.where((eb) => eb.or([
        eb("target_client_id", "is", null),
        eb("target_client_id", "=", targetClientId)
      ]));
    } else if (input.targetClientKind) {
      query = query.where("target_client_id", "is", null);
    }
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    const rows = await query.orderBy("created_at", "asc").limit(input.limit ?? 50).execute();
    return rows.map(clientEventFromRow);
  }

  async markClientEventDelivered(eventId: string, deliveredAt = nowIso()): Promise<ClientEventRecord | undefined> {
    await this.db
      .updateTable("client_events")
      .set({
        status: "delivered",
        delivered_at: deliveredAt,
        error_code: null
      })
      .where("id", "=", eventId)
      .where("status", "=", "pending")
      .execute();
    return this.getClientEvent(eventId);
  }

  async ackClientEvent(eventId: string, ackedAt = nowIso()): Promise<ClientEventRecord | undefined> {
    await this.db
      .updateTable("client_events")
      .set({
        status: "acked",
        delivered_at: ackedAt,
        acked_at: ackedAt,
        error_code: null
      })
      .where("id", "=", eventId)
      .where("status", "in", ["pending", "delivered"])
      .execute();
    return this.getClientEvent(eventId);
  }

  async failClientEvent(eventId: string, errorCode: string, failedAt = nowIso()): Promise<ClientEventRecord | undefined> {
    await this.db
      .updateTable("client_events")
      .set({
        status: "failed",
        delivered_at: failedAt,
        error_code: errorCode
      })
      .where("id", "=", eventId)
      .where("status", "in", ["pending", "delivered"])
      .execute();
    return this.getClientEvent(eventId);
  }

  async expireClientEvents(input: { now?: string } = {}): Promise<ClientEventRecord[]> {
    const now = input.now ?? nowIso();
    const rows = await this.db
      .selectFrom("client_events")
      .selectAll()
      .where("status", "in", ["pending", "delivered"])
      .where("expires_at", "<=", now)
      .execute();
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    await this.db
      .updateTable("client_events")
      .set({ status: "expired" })
      .where("id", "in", ids)
      .execute();
    return rows.map((row) => clientEventFromRow({ ...row, status: "expired" }));
  }

  async saveResourceTranslation(record: ResourceTranslationRecord): Promise<ResourceTranslationRecord> {
    await this.db
      .insertInto("resource_translations")
      .values(resourceTranslationToRow(record))
      .onConflict((oc) => oc.column("id").doUpdateSet(resourceTranslationToRow(record)))
      .execute();
    return record;
  }

  async listResourceTranslations(input: { sourceRef?: ResourceRef; targetLocale?: ResourceTranslationRecord["target_locale"]; status?: ResourceTranslationRecord["status"] } = {}): Promise<ResourceTranslationRecord[]> {
    let query = this.db.selectFrom("resource_translations").selectAll();
    if (input.targetLocale) {
      query = query.where("target_locale", "=", input.targetLocale);
    }
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    const records = rows.map(resourceTranslationFromRow);
    if (!input.sourceRef) {
      return records;
    }
    const key = resourceRefKey(input.sourceRef);
    return records.filter((record) => resourceRefKey(record.source_ref) === key);
  }

  async resolveResourceTranslation(input: {
    sourceRef: ResourceRef;
    targetLocale: ResourceTranslationRecord["target_locale"];
    originalHash?: string;
    fallbackText?: string;
  }): Promise<ResourceTranslationResolution> {
    const translations = await this.listResourceTranslations({
      sourceRef: input.sourceRef,
      targetLocale: input.targetLocale
    });
    const currentTranslations = input.originalHash
      ? translations.filter((record) => record.original_hash === input.originalHash)
      : translations;
    const preferred = currentTranslations.find((record) => record.status === "verified")
      ?? currentTranslations.find((record) => record.status === "draft");
    if (preferred) {
      return {
        status: preferred.status,
        text: preferred.translated_text,
        source: "translation",
        target_locale: input.targetLocale,
        translation: preferred
      };
    }
    return {
      status: "missing",
      text: input.fallbackText ?? "",
      source: "fallback",
      target_locale: input.targetLocale
    };
  }

  async saveWorkspaceChange(change: WorkspaceChangeRecord): Promise<WorkspaceChangeRecord> {
    await this.db.insertInto("workspace_changes").values(workspaceChangeToRow(change)).execute();
    return change;
  }

  async listWorkspaceChanges(sessionId?: string): Promise<WorkspaceChangeRecord[]> {
    let query = this.db.selectFrom("workspace_changes").selectAll();
    if (sessionId) {
      query = query.where("session_id", "=", sessionId);
    }
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map(workspaceChangeFromRow);
  }

  async listChangeHistoryEntries(sessionId?: string): Promise<ChangeHistoryEntry[]> {
    return (await this.listWorkspaceChanges(sessionId)).map((change) => ({
      id: change.id,
      session_id: change.session_id,
      run_id: change.run_id,
      change_type: change.change_type,
      resource_ref: change.resource_ref,
      summary: change.summary,
      created_at: change.created_at
    }));
  }

  async savePolicyDecision(decision: PolicyDecisionRecord): Promise<PolicyDecisionRecord> {
    await this.db
      .insertInto("policy_decisions")
      .values({
        id: decision.id,
        operation_id: decision.operation_id,
        capability_id: decision.capability_id,
        operation: decision.operation,
        decision: decision.decision,
        reason: decision.reason,
        policy_inputs_json: stringify(decision.policy_inputs),
        matched_rules_json: stringify(decision.matched_rules),
        required_approval_level: decision.required_approval_level,
        grant_id: decision.grant_id ?? null,
        created_at: decision.created_at
      })
      .execute();
    return decision;
  }

  async listPolicyDecisions(): Promise<PolicyDecisionRecord[]> {
    const rows = await this.db.selectFrom("policy_decisions").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(policyDecisionFromRow);
  }

  async getPolicyDecision(id: string): Promise<PolicyDecisionRecord | undefined> {
    const row = await this.db.selectFrom("policy_decisions").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? policyDecisionFromRow(row) : undefined;
  }

  async saveApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    await this.db
      .insertInto("approval_requests")
      .values({
        id: request.id,
        operation_id: request.operation_id,
        requested_level: request.requested_level,
        status: request.status,
        reason: request.reason,
        requested_by: request.requested_by,
        decided_by: request.decided_by ?? null,
        created_at: request.created_at,
        expires_at: request.expires_at,
        decided_at: request.decided_at ?? null
      })
      .execute();
    return request;
  }

  async updateApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    await this.db
      .updateTable("approval_requests")
      .set({
        requested_level: request.requested_level,
        status: request.status,
        reason: request.reason,
        requested_by: request.requested_by,
        decided_by: request.decided_by ?? null,
        expires_at: request.expires_at,
        decided_at: request.decided_at ?? null
      })
      .where("id", "=", request.id)
      .execute();
    return request;
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    const row = await this.db.selectFrom("approval_requests").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? approvalRequestFromRow(row) : undefined;
  }

  async listApprovalRequests(): Promise<ApprovalRequest[]> {
    const rows = await this.db.selectFrom("approval_requests").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(approvalRequestFromRow);
  }

  async saveAuditRecord(record: AuditRecord): Promise<AuditRecord> {
    await this.db
      .insertInto("audit_records")
      .values({
        id: record.id,
        actor_identity: record.actor_identity,
        operation_id: record.operation_id,
        capability_id: record.capability_id,
        instruction_source: record.instruction_source,
        inputs_summary: record.inputs_summary,
        outputs_summary: record.outputs_summary,
        policy_decision_id: record.policy_decision_id,
        affected_resources_json: stringify(record.affected_resources),
        rollback_point_id: record.rollback_point_id ?? null,
        created_at: record.created_at
      })
      .execute();
    return record;
  }

  async listAuditRecords(): Promise<AuditRecord[]> {
    const rows = await this.db.selectFrom("audit_records").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(auditRecordFromRow);
  }

  async listAuditRecordsForOperation(operationId: string): Promise<AuditRecord[]> {
    const rows = await this.db.selectFrom("audit_records").selectAll().where("operation_id", "=", operationId).orderBy("created_at", "desc").execute();
    return rows.map(auditRecordFromRow);
  }

  async saveRollbackPoint(point: RollbackPoint): Promise<RollbackPoint> {
    const filePath = path.join(this.rootDir, "rollback", `${point.id}.json`);
    await writeFile(filePath, JSON.stringify(point, null, 2));
    await this.db
      .insertInto("rollback_points")
      .values({
        id: point.id,
        operation_id: point.operation_id,
        affected_resources_json: stringify(point.affected_resources),
        before_snapshot_json: stringify(point.before_snapshot),
        after_snapshot_json: stringify(point.after_snapshot),
        reversible: point.reversible ? 1 : 0,
        irreversible_effects_json: stringify(point.irreversible_effects),
        created_at: point.created_at,
        expires_at: point.expires_at
      })
      .execute();
    return point;
  }

  async listRollbackPoints(): Promise<RollbackPoint[]> {
    const rows = await this.db.selectFrom("rollback_points").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(rollbackPointFromRow);
  }

  async getRollbackPoint(id: string): Promise<RollbackPoint | undefined> {
    const row = await this.db.selectFrom("rollback_points").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? rollbackPointFromRow(row) : undefined;
  }

  async saveArtifactMetadata(record: ArtifactRecord): Promise<ArtifactRecord> {
    const safeRecord = { ...record, metadata: redactPrivateData(record.metadata, { redactPii: true }) };
    await this.db
      .insertInto("artifacts")
      .values({
        id: safeRecord.id,
        title: safeRecord.title,
        kind: safeRecord.kind,
        locale: safeRecord.locale,
        source_locales_json: stringify(safeRecord.source_locales),
        file_ref_json: stringify(safeRecord.file_ref),
        metadata_json: stringify(safeRecord.metadata),
        source_operation_id: safeRecord.source_operation_id,
        created_by: safeRecord.created_by,
        created_at: safeRecord.created_at,
        updated_at: safeRecord.updated_at
      })
      .execute();
    const sourceOperation = await this.getOperation(record.source_operation_id);
    await this.upsertSessionSearchEntry({
      kind: "artifact",
      id: record.id,
      sessionId: sourceOperation?.session_id,
      operationId: record.source_operation_id,
      title: record.title,
      body: (await this.readArtifactContent(record.id).catch(() => "")) ?? ""
    });
    return safeRecord;
  }

  async getArtifact(id: string): Promise<ArtifactRecord | undefined> {
    const row = await this.db.selectFrom("artifacts").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? artifactFromRow(row) : undefined;
  }

  async listArtifacts(): Promise<ArtifactRecord[]> {
    const rows = await this.db.selectFrom("artifacts").selectAll().orderBy("updated_at", "desc").execute();
    return rows.map(artifactFromRow);
  }

  async listArtifactsForSession(sessionId: string): Promise<ArtifactRecord[]> {
    const rows = await this.db
      .selectFrom("artifacts")
      .innerJoin("operations", "operations.id", "artifacts.source_operation_id")
      .selectAll("artifacts")
      .where("operations.session_id", "=", sessionId)
      .orderBy("artifacts.updated_at", "desc")
      .execute();
    return rows.map(artifactFromRow);
  }

  async createArtifactRevision(input: {
    artifactId: string;
    content: string | Uint8Array;
    producerRunId?: string;
    extension?: string;
    baseRevisionId?: string;
    editorSource?: ArtifactRevisionRecord["editor_source"];
    changeSummary?: string;
    provenance?: Record<string, JsonValue>;
  }): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord }> {
    const artifact = await this.getArtifact(input.artifactId);
    if (!artifact) throw new Error(`artifact_not_found:${input.artifactId}`);
    const revisions = await this.listArtifactRevisions(artifact.id);
    const currentRevisionId = revisions.at(-1)?.id;
    if (input.baseRevisionId && input.baseRevisionId !== currentRevisionId) {
      throw new Error(`artifact_revision_conflict:${currentRevisionId ?? "none"}`);
    }
    const revisionNumber = (revisions.at(-1)?.revision ?? 0) + 1;
    const extension = safeArtifactExtension((input.extension ?? path.extname(artifact.file_ref.uri).slice(1)) || "bin");
    const content = typeof input.content === "string" ? Buffer.from(input.content) : Buffer.from(input.content);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const revisionId = createId("artifact_revision");
    const revisionPath = path.join("artifacts", artifact.id, "revisions", `${revisionNumber}.${extension}`);
    const blobPath = path.join("artifacts", ".blobs", `${contentHash}.${extension}`);
    await mkdir(path.join(this.rootDir, path.dirname(revisionPath)), { recursive: true });
    await mkdir(path.join(this.rootDir, path.dirname(blobPath)), { recursive: true });
    if (!await pathExists(path.join(this.rootDir, blobPath))) await writeFile(path.join(this.rootDir, blobPath), content, { flag: "wx" }).catch(async (error) => { if (!await pathExists(path.join(this.rootDir, blobPath))) throw error; });
    await writeFile(path.join(this.rootDir, revisionPath), content, { flag: "wx" });
    const now = nowIso();
    const revision: ArtifactRevisionRecord = {
      id: revisionId,
      artifact_id: artifact.id,
      revision: revisionNumber,
      parent_revision_id: revisions.at(-1)?.id,
      producer_run_id: input.producerRunId,
      base_revision_id: input.baseRevisionId,
      editor_source: input.editorSource,
      change_summary: input.changeSummary,
      provenance: input.provenance ?? {},
      source_ref: artifact.file_ref,
      file_ref: { kind: "artifact_revision", id: revisionId, uri: revisionPath, label: `${artifact.title} r${revisionNumber}` },
      blob_ref: { kind: "artifact_blob", id: contentHash, uri: blobPath, label: contentHash },
      content_hash: contentHash,
      content_bytes: content.byteLength,
      created_at: now
    };
    const nextArtifact: ArtifactRecord = {
      ...artifact,
      file_ref: revision.file_ref,
      metadata: { ...artifact.metadata, current_revision_id: revision.id, current_revision: revision.revision, content_hash: revision.content_hash },
      updated_at: now
    };
    try {
      await this.db.transaction().execute(async (transaction) => {
        await transaction.insertInto("artifact_revisions").values(artifactRevisionToRow(revision)).execute();
        await transaction.updateTable("artifacts").set({ file_ref_json: stringify(nextArtifact.file_ref), metadata_json: stringify(nextArtifact.metadata), updated_at: now }).where("id", "=", artifact.id).execute();
      });
    } catch (error) {
      await rm(path.join(this.rootDir, revisionPath), { force: true });
      throw error;
    }
    return { artifact: nextArtifact, revision };
  }

  async listArtifactRevisions(artifactId: string): Promise<ArtifactRevisionRecord[]> {
    return (await this.db.selectFrom("artifact_revisions").selectAll().where("artifact_id", "=", artifactId).orderBy("revision", "asc").execute()).map((row) => parse<ArtifactRevisionRecord>(row.revision_json));
  }

  async getArtifactRevision(revisionId: string): Promise<ArtifactRevisionRecord | undefined> {
    const row = await this.db.selectFrom("artifact_revisions").selectAll().where("id", "=", revisionId).executeTakeFirst();
    return row ? parse<ArtifactRevisionRecord>(row.revision_json) : undefined;
  }

  async readArtifactRevisionContent(revisionId: string): Promise<Uint8Array | undefined> {
    const revision = await this.getArtifactRevision(revisionId);
    return revision ? readFile(path.join(this.rootDir, revision.file_ref.uri)).catch(() => undefined) : undefined;
  }

  async repairArtifactRevisionSource(artifactId: string): Promise<{ repaired: boolean; revision?: ArtifactRevisionRecord }> {
    const artifact = await this.getArtifact(artifactId);
    if (!artifact) throw new Error(`artifact_not_found:${artifactId}`);
    const revisionId = typeof artifact.metadata.current_revision_id === "string" ? artifact.metadata.current_revision_id : undefined;
    const revision = revisionId ? await this.getArtifactRevision(revisionId) : undefined;
    if (!revision) return { repaired: false };
    const target = path.join(this.rootDir, revision.file_ref.uri);
    if (await pathExists(target)) return { repaired: false, revision };
    const blob = path.join(this.rootDir, revision.blob_ref.uri);
    if (!await pathExists(blob)) throw new Error("artifact_revision_blob_missing");
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(blob, target);
    const restoredHash = createHash("sha256").update(await readFile(target)).digest("hex");
    if (restoredHash !== revision.content_hash) {
      await rm(target, { force: true });
      throw new Error("artifact_revision_repair_hash_mismatch");
    }
    return { repaired: true, revision };
  }

  async readArtifactContent(id: string): Promise<string | undefined> {
    const artifact = await this.getArtifact(id);
    if (!artifact) {
      return undefined;
    }
    const contentType = artifactContentTypeFromMetadata(artifact);
    if (!isTextArtifactContentType(contentType)) {
      return undefined;
    }
    return readFile(path.join(this.rootDir, artifact.file_ref.uri), "utf8");
  }

  async readArtifactBinaryContent(id: string): Promise<Uint8Array | undefined> {
    const artifact = await this.getArtifact(id);
    if (!artifact) {
      return undefined;
    }
    return readFile(path.join(this.rootDir, artifact.file_ref.uri));
  }

  async writeArtifactContent(id: string, content: string | Uint8Array, options: { extension?: string } = {}): Promise<string> {
    const extension = safeArtifactExtension(typeof content === "string" ? options.extension ?? "md" : options.extension ?? "bin");
    const relativePath = path.join("artifacts", `${id}.${extension}`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await writeFile(absolutePath, content);
    const artifact = await this.getArtifact(id);
    if (artifact) await this.upsertSessionSearchEntry({ kind: "artifact", id, operationId: artifact.source_operation_id, title: artifact.title, body: typeof content === "string" ? content : "" });
    return relativePath;
  }

  async saveMemory(frontmatter: MemoryFrontmatter, content: string): Promise<MemoryFrontmatter> {
    const validated = MemoryFrontmatterSchema.parse(frontmatter);
    const relativePath = path.join("memory", validated.state, `${validated.id}.md`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${renderFrontmatter(validated)}\n${content.trim()}\n`);
    await this.db
      .insertInto("memory_index")
      .values({
        id: validated.id,
        state: validated.state,
        topic: validated.topic,
        source: validated.source,
        source_locale: validated.source_locale,
        content_locale: validated.content_locale,
        source_kind: validated.source_kind,
        instruction_authority: validated.instruction_authority,
        file_path: relativePath,
        frontmatter_json: stringify(validated),
        created_at: validated.created_at,
        updated_at: validated.updated_at
      })
      .execute();
    return validated;
  }

  async replaceMemoryContent(id: string, content: string): Promise<MemoryWithFilePath | undefined> {
    const memory = await this.getMemory(id);
    if (!memory) return undefined;
    const next = { ...memory, updated_at: nowIso() };
    await writeFile(path.join(this.rootDir, memory.file_path), `${renderFrontmatter(next)}\n${content.trim()}\n`);
    await this.db.updateTable("memory_index").set({
      frontmatter_json: stringify(next),
      updated_at: next.updated_at
    }).where("id", "=", id).execute();
    return next;
  }

  async listMemory(options: { includeArchived?: boolean } = {}): Promise<MemoryWithFilePath[]> {
    let query = this.db.selectFrom("memory_index").selectAll();
    if (!options.includeArchived) {
      query = query.where("state", "!=", "archived");
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map((row) => ({ ...parse<MemoryFrontmatter>(row.frontmatter_json), file_path: row.file_path }));
  }

  async listMemoryForSession(sessionId: string, options: { includeArchived?: boolean } = {}): Promise<MemoryWithFilePath[]> {
    const messages = await this.listMessages(sessionId);
    const envelopeIds = new Set<string>();
    for (const message of messages) {
      envelopeIds.add(message.id);
      if (message.envelope?.id) {
        envelopeIds.add(message.envelope.id);
      }
    }
    if (envelopeIds.size === 0) {
      return [];
    }

    let query = this.db.selectFrom("memory_index").selectAll();
    if (!options.includeArchived) {
      query = query.where("state", "!=", "archived");
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows
      .filter((row) => envelopeIds.has(row.source))
      .map((row) => ({ ...parse<MemoryFrontmatter>(row.frontmatter_json), file_path: row.file_path }));
  }

  async searchMemory(query: string, limit = 5, options: { includeArchived?: boolean } = {}): Promise<MemoryWithFilePath[]> {
    let dbQuery = this.db.selectFrom("memory_index").selectAll();
    if (!options.includeArchived) {
      dbQuery = dbQuery.where("state", "!=", "archived");
    }
    const rows = await dbQuery.orderBy("updated_at", "desc").execute();
    const terms = searchTerms(query);
    const scored = await Promise.all(
      rows.map(async (row) => {
        const memory = { ...parse<MemoryFrontmatter>(row.frontmatter_json), file_path: row.file_path };
        const content = await readWorkspaceText(this.rootDir, row.file_path);
        const score = terms.length === 0
          ? stateSearchBoost(memory.state)
          : scoreSearchFields(terms, [
            { value: row.topic, weight: 12 },
            { value: row.source, weight: 3 },
            { value: stripFrontmatter(content), weight: 10 },
            { value: row.frontmatter_json, weight: 2 }
          ]) + stateSearchBoost(memory.state) + memory.confidence;
        return { item: memory, score, updatedAt: row.updated_at };
      })
    );
    return scored
      .filter((entry) => terms.length === 0 ? entry.score > 0 : entry.score > stateSearchBoost(entry.item.state))
      .sort(compareScoredSearch)
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  async getMemory(id: string): Promise<MemoryWithFilePath | undefined> {
    const row = await this.db.selectFrom("memory_index").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? { ...parse<MemoryFrontmatter>(row.frontmatter_json), file_path: row.file_path } : undefined;
  }

  async readMemoryContent(id: string): Promise<string | undefined> {
    const memory = await this.getMemory(id);
    if (!memory) {
      return undefined;
    }
    const raw = await readFile(path.join(this.rootDir, memory.file_path), "utf8");
    return stripFrontmatter(raw).trim();
  }

  async archiveMemory(id: string): Promise<ArchiveMemoryResult | undefined> {
    const row = await this.db.selectFrom("memory_index").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) {
      return undefined;
    }

    const frontmatter = parse<MemoryFrontmatter>(row.frontmatter_json);
    const content = await this.readMemoryContent(id);
    if (content === undefined) {
      return undefined;
    }
    const before = memorySnapshot(frontmatter, row.file_path);

    if (frontmatter.state === "archived") {
      return {
        before,
        after: before,
        content,
        changed: false
      };
    }

    const nextFrontmatter: MemoryFrontmatter = {
      ...frontmatter,
      state: "archived",
      updated_at: nowIso()
    };
    const archivedPath = path.join("memory", "archived", `${id}.md`);
    const previousAbsolutePath = path.join(this.rootDir, row.file_path);
    const archivedAbsolutePath = path.join(this.rootDir, archivedPath);
    await mkdir(path.dirname(archivedAbsolutePath), { recursive: true });
    await writeFile(archivedAbsolutePath, `${renderFrontmatter(nextFrontmatter)}\n${content.trim()}\n`);

    try {
      await this.db
        .updateTable("memory_index")
        .set({
          state: nextFrontmatter.state,
          file_path: archivedPath,
          frontmatter_json: stringify(nextFrontmatter),
          updated_at: nextFrontmatter.updated_at
        })
        .where("id", "=", id)
        .execute();
    } catch (error) {
      await unlink(archivedAbsolutePath).catch(() => undefined);
      throw error;
    }

    let warning: string | undefined;
    try {
      await unlink(previousAbsolutePath);
    } catch (error) {
      warning = error instanceof Error ? `old_file_delete_failed:${error.message}` : "old_file_delete_failed";
    }

    return {
      before,
      after: memorySnapshot(nextFrontmatter, archivedPath),
      content,
      changed: true,
      warning
    };
  }

  async saveSkillMarkdown(input: { state: "candidate" | "project"; skillId: string; markdown: string }): Promise<SkillWithFilePath> {
    const relativePath = path.join("skills", input.state, `${input.skillId}.md`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.markdown, { flag: "wx" });

    try {
      const { frontmatter } = parseSkillMarkdownLocal(await readFile(absolutePath, "utf8"));
      if (frontmatter.id !== input.skillId || frontmatter.state !== input.state) {
        throw new Error("skill_frontmatter_path_mismatch");
      }
      const now = nowIso();
      await this.db
        .insertInto("skill_index")
        .values({
          id: frontmatter.id,
          state: frontmatter.state,
          title: frontmatter.title,
          description: frontmatter.description,
          tags_json: stringify(frontmatter.tags),
          required_capabilities_json: stringify(frontmatter.required_capabilities),
          file_path: relativePath,
          frontmatter_json: stringify(frontmatter),
          created_at: now,
          updated_at: now
        })
        .execute();
      return { ...buildSkillIndexEntry(frontmatter), file_path: relativePath };
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  }

  async listSkills(): Promise<SkillWithFilePath[]> {
    const rows = await this.db.selectFrom("skill_index").selectAll().orderBy("updated_at", "desc").execute();
    return rows.map(skillFromRow);
  }

  async listSkillIndexReadModel(): Promise<SkillIndexEntryReadModel[]> {
    const rows = await this.db.selectFrom("skill_index").selectAll().orderBy("updated_at", "desc").execute();
    return rows.map((row) => ({
      id: row.id,
      state: row.state as SkillFrontmatter["state"],
      title: row.title,
      description: row.description,
      tags: parse(row.tags_json),
      required_capabilities: parse(row.required_capabilities_json),
      file_path: row.file_path,
      updated_at: row.updated_at
    }));
  }

  async getSkill(id: string): Promise<SkillWithFilePath | undefined> {
    const row = await this.db.selectFrom("skill_index").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? skillFromRow(row) : undefined;
  }

  async readSkillMarkdown(id: string): Promise<string | undefined> {
    const skill = await this.getSkill(id);
    if (!skill) {
      return undefined;
    }
    return readFile(path.join(this.rootDir, skill.file_path), "utf8");
  }

  async patchSkill(input: { id: string; title?: string; description?: string; tags?: string[]; content?: string }): Promise<SkillWithFilePath | undefined> {
    await this.assertSkillWriteUnlocked(input.id);
    const current = await this.getSkill(input.id);
    const raw = await this.readSkillMarkdown(input.id);
    if (!current || !raw) return undefined;
    const parsed = parseSkillMarkdownLocal(raw);
    const now = nowIso();
    const frontmatter: SkillFrontmatter = SkillFrontmatterSchema.parse({
      ...parsed.frontmatter,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      last_reviewed_at: now
    });
    const markdown = ["---", JSON.stringify(frontmatter, null, 2), "---", (input.content ?? parsed.content).trim(), ""].join("\n");
    const absolutePath = path.join(this.rootDir, current.file_path);
    const temporaryPath = `${absolutePath}.tmp-${randomUUID()}`;
    await writeFile(temporaryPath, markdown, { flag: "wx" });
    try {
      await rename(temporaryPath, absolutePath);
      await this.db.updateTable("skill_index").set({
        title: frontmatter.title,
        description: frontmatter.description,
        tags_json: stringify(frontmatter.tags),
        required_capabilities_json: stringify(frontmatter.required_capabilities),
        frontmatter_json: stringify(frontmatter),
        updated_at: now
      }).where("id", "=", input.id).execute();
    } catch (error) {
      await rm(temporaryPath, { force: true });
      await writeFile(absolutePath, raw).catch(() => undefined);
      throw error;
    }
    return { ...buildSkillIndexEntry(frontmatter), file_path: current.file_path };
  }

  async updateSkillState(id: string, state: SkillFrontmatter["state"]): Promise<SkillWithFilePath | undefined> {
    await this.assertSkillWriteUnlocked(id);
    const current = await this.getSkill(id);
    if (!current) {
      return undefined;
    }
    const raw = await this.readSkillMarkdown(id);
    if (!raw) {
      return undefined;
    }
    const parsed = parseSkillMarkdownLocal(raw);
    const now = nowIso();
    const nextFrontmatter: SkillFrontmatter = {
      ...parsed.frontmatter,
      state,
      last_reviewed_at: now
    };
    const nextPath = path.join("skills", state, `${id}.md`);
    const nextAbsolutePath = path.join(this.rootDir, nextPath);
    const previousAbsolutePath = path.join(this.rootDir, current.file_path);
    const nextMarkdown = ["---", JSON.stringify(nextFrontmatter, null, 2), "---", parsed.content.trim(), ""].join("\n");
    await mkdir(path.dirname(nextAbsolutePath), { recursive: true });
    if (nextAbsolutePath === previousAbsolutePath) {
      await writeFile(nextAbsolutePath, nextMarkdown);
    } else {
      await writeFile(nextAbsolutePath, nextMarkdown, { flag: "wx" });
    }

    try {
      await this.db
        .updateTable("skill_index")
        .set({
          state: nextFrontmatter.state,
          title: nextFrontmatter.title,
          description: nextFrontmatter.description,
          tags_json: stringify(nextFrontmatter.tags),
          required_capabilities_json: stringify(nextFrontmatter.required_capabilities),
          file_path: nextPath,
          frontmatter_json: stringify(nextFrontmatter),
          updated_at: now
        })
        .where("id", "=", id)
        .execute();
    } catch (error) {
      await unlink(nextAbsolutePath).catch(() => undefined);
      throw error;
    }

    if (nextAbsolutePath !== previousAbsolutePath) {
      await unlink(previousAbsolutePath).catch(() => undefined);
    }
    return { ...buildSkillIndexEntry(nextFrontmatter), file_path: nextPath };
  }

  async replaceSkillContent(id: string, content: string): Promise<SkillWithFilePath | undefined> {
    await this.assertSkillWriteUnlocked(id);
    const skill = await this.getSkill(id);
    if (!skill) return undefined;
    const frontmatter = { ...skill.frontmatter, last_reviewed_at: nowIso() };
    await writeFile(path.join(this.rootDir, skill.file_path), `${renderFrontmatter(frontmatter)}\n${content.trim()}\n`);
    await this.db.updateTable("skill_index").set({
      frontmatter_json: stringify(frontmatter),
      updated_at: frontmatter.last_reviewed_at ?? nowIso()
    }).where("id", "=", id).execute();
    return { ...buildSkillIndexEntry(frontmatter), file_path: skill.file_path };
  }

  async replaceSkillContentIfUnchanged(input: { id: string; expectedContentHash: string; content: string; lockRunId?: string }): Promise<SkillWithFilePath | undefined> {
    await this.assertSkillWriteUnlocked(input.id, input.lockRunId);
    const skill = await this.getSkill(input.id);
    const raw = await this.readSkillMarkdown(input.id);
    if (!skill || !raw) return undefined;
    const currentBodyHash = stableHash(stripFrontmatter(raw).trim());
    if (currentBodyHash !== input.expectedContentHash) {
      throw new Error(`skill_content_conflict:${input.id}`);
    }
    const frontmatter = { ...skill.frontmatter, last_reviewed_at: nowIso() };
    await writeFile(path.join(this.rootDir, skill.file_path), `${renderFrontmatter(frontmatter)}\n${input.content.trim()}\n`);
    await this.db.updateTable("skill_index").set({
      frontmatter_json: stringify(frontmatter),
      updated_at: frontmatter.last_reviewed_at ?? nowIso()
    }).where("id", "=", input.id).execute();
    return { ...buildSkillIndexEntry(frontmatter), file_path: skill.file_path };
  }

  private async assertSkillWriteUnlocked(skillId: string, ownerRunId?: string): Promise<void> {
    const lock = await this.getSkillOptimizationLock(skillId);
    if (lock && lock.run_id !== ownerRunId) {
      throw new Error(`skill_locked_for_optimization:${skillId}`);
    }
  }

  async recordSkillUsage(input: { skillId: string; runId?: string; usedAt?: string }): Promise<SkillUsageRecord> {
    const skill = await this.getSkill(input.skillId);
    if (!skill) {
      throw new Error(`skill_not_found:${input.skillId}`);
    }
    const usedAt = input.usedAt ?? nowIso();
    const existing = await this.getSkillUsage(input.skillId);
    const next: SkillUsageRecord = existing
      ? {
          ...existing,
          use_count: existing.use_count + 1,
          last_used_at: usedAt,
          last_run_id: input.runId,
          updated_at: usedAt
        }
      : {
          skill_id: input.skillId,
          use_count: 1,
          last_used_at: usedAt,
          last_run_id: input.runId,
          created_at: usedAt,
          updated_at: usedAt
        };
    if (existing) {
      await sql`
        UPDATE skill_usage
        SET use_count = ${next.use_count},
            last_used_at = ${next.last_used_at ?? null},
            last_run_id = ${next.last_run_id ?? null},
            updated_at = ${next.updated_at}
        WHERE skill_id = ${input.skillId}
      `.execute(this.db);
    } else {
      await sql`
        INSERT INTO skill_usage (skill_id, use_count, last_used_at, last_run_id, created_at, updated_at)
        VALUES (${next.skill_id}, ${next.use_count}, ${next.last_used_at ?? null}, ${next.last_run_id ?? null}, ${next.created_at}, ${next.updated_at})
      `.execute(this.db);
    }
    return next;
  }

  async getSkillUsage(skillId: string): Promise<SkillUsageRecord | undefined> {
    const result = await sql<SkillUsageTable>`
      SELECT skill_id, use_count, last_used_at, last_run_id, created_at, updated_at
      FROM skill_usage
      WHERE skill_id = ${skillId}
    `.execute(this.db);
    const row = result.rows[0];
    return row ? skillUsageFromRow(row) : undefined;
  }

  async listSkillUsage(): Promise<SkillUsageRecord[]> {
    const result = await sql<SkillUsageTable>`
      SELECT skill_id, use_count, last_used_at, last_run_id, created_at, updated_at
      FROM skill_usage
      ORDER BY updated_at DESC
    `.execute(this.db);
    return result.rows.map(skillUsageFromRow);
  }

  async recordLearningResourceUse(record: LearningResourceUseRecord): Promise<LearningResourceUseRecord> {
    const safeRecord = { ...record, metadata: redactPrivateData(record.metadata, { redactPii: true }) };
    const existing = await sql<LearningResourceUseTable>`
      SELECT * FROM learning_resource_uses
      WHERE run_id = ${record.run_id}
        AND resource_kind = ${record.resource_kind}
        AND resource_id = ${record.resource_id}
        AND stage = ${record.stage}
        AND COALESCE(source_operation_id, '') = COALESCE(${record.source_operation_id ?? null}, '')
      LIMIT 1
    `.execute(this.db);
    const row = existing.rows[0];
    if (row) {
      return learningResourceUseFromRow(row);
    }
    await sql`
      INSERT INTO learning_resource_uses (
        id, run_id, session_id, resource_kind, resource_id, resource_version,
        content_hash, stage, source_operation_id, metadata_json, created_at
      ) VALUES (
        ${record.id}, ${record.run_id}, ${record.session_id}, ${record.resource_kind}, ${record.resource_id}, ${record.resource_version ?? null},
        ${safeRecord.content_hash ?? null}, ${safeRecord.stage}, ${safeRecord.source_operation_id ?? null}, ${stringify(safeRecord.metadata)}, ${safeRecord.created_at}
      )
    `.execute(this.db);
    return safeRecord;
  }

  async listLearningResourceUses(input: { runId?: string; sessionId?: string; resourceId?: string } = {}): Promise<LearningResourceUseRecord[]> {
    let query = this.db.selectFrom("learning_resource_uses").selectAll().orderBy("created_at", "desc");
    if (input.runId) query = query.where("run_id", "=", input.runId);
    if (input.sessionId) query = query.where("session_id", "=", input.sessionId);
    if (input.resourceId) query = query.where("resource_id", "=", input.resourceId);
    return (await query.execute()).map(learningResourceUseFromRow);
  }

  async saveLearningEvaluation(record: LearningEvaluationRecord): Promise<LearningEvaluationRecord> {
    await this.db.insertInto("learning_evaluations").values({
      id: record.id,
      learning_resource_ref_json: stringify(record.learning_resource_ref),
      learning_resource_version: record.learning_resource_version ?? null,
      task_class: record.task_class,
      compared_run_ids_json: stringify(record.compared_run_ids),
      before_metrics_json: stringify(record.before_metrics),
      after_metrics_json: stringify(record.after_metrics),
      effect_estimate: record.effect_estimate,
      confidence: record.confidence,
      assessment: record.assessment,
      evidence_refs_json: stringify(record.evidence_refs),
      evaluator: record.evaluator,
      created_at: record.created_at
    }).execute();
    return record;
  }

  async listLearningEvaluations(input: { resourceId?: string; taskClass?: string } = {}): Promise<LearningEvaluationRecord[]> {
    let query = this.db.selectFrom("learning_evaluations").selectAll().orderBy("created_at", "desc");
    if (input.taskClass) query = query.where("task_class", "=", input.taskClass);
    const records = (await query.execute()).map(learningEvaluationFromRow);
    return input.resourceId ? records.filter((record) => record.learning_resource_ref.id === input.resourceId) : records;
  }

  async saveLearningResourceEdge(recordInput: LearningResourceEdgeRecord): Promise<LearningResourceEdgeRecord> {
    const record = LearningResourceEdgeRecordSchema.parse(recordInput);
    const directory = path.join(this.rootDir, "learning-graph", "edges"); await mkdir(directory,{recursive:true});
    const target=path.join(directory,`${record.id}.json`),pending=`${target}.pending`;await writeFile(pending,`${JSON.stringify(record,null,2)}\n`);await rename(pending,target);return record;
  }

  async listLearningResourceEdges(): Promise<LearningResourceEdgeRecord[]> {
    const directory=path.join(this.rootDir,"learning-graph","edges");const files=(await readdir(directory).catch(()=>[])).filter(x=>x.endsWith(".json")).sort();return Promise.all(files.map(async file=>LearningResourceEdgeRecordSchema.parse(JSON.parse(await readFile(path.join(directory,file),"utf8")))));
  }

  async createLearningSnapshot(runId: string): Promise<LearningSnapshotRecord> {
    const id = createId("learning_snapshot");
    const relativePath = path.join("learning-snapshots", id);
    const snapshotRoot = path.join(this.rootDir, relativePath);
    await mkdir(snapshotRoot, { recursive: true });
    for (const rootName of ["memory", "skills", "wiki", "learning-graph"]) {
      const source = path.join(this.rootDir, rootName);
      if (await pathExists(source)) await cp(source, path.join(snapshotRoot, rootName), { recursive: true, force: true });
    }
    const [memories, skills, wiki, skillUsage, evaluations, resourceUses] = await Promise.all([
      this.listMemory({ includeArchived: true }), this.listSkills(), this.listWiki({ activeOnly: false }), this.listSkillUsage(), this.listLearningEvaluations(), this.listLearningResourceUses()
    ]);
    const supportFiles = (await Promise.all(skills.map((skill) => this.listSkillSupportFiles(skill.id)))).flat();
    const record: LearningSnapshotRecord = {
      id,
      run_id: runId,
      path: relativePath,
      resource_counts: { memory: memories.length, skills: skills.length, support_files: supportFiles.length, wiki: wiki.length },
      created_at: nowIso()
    };
    await writeFile(path.join(snapshotRoot, "manifest.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(snapshotRoot, "metadata.json"), `${JSON.stringify({ skill_usage: skillUsage, evaluations, resource_uses: resourceUses }, null, 2)}\n`);
    await this.db.insertInto("learning_snapshots").values({
      id: record.id,
      run_id: record.run_id,
      path: record.path,
      resource_counts_json: stringify(record.resource_counts),
      created_at: record.created_at,
      restored_at: null
    }).execute();
    await this.pruneLearningSnapshots(20);
    return record;
  }

  async listLearningSnapshots(): Promise<LearningSnapshotRecord[]> {
    return (await this.db.selectFrom("learning_snapshots").selectAll().orderBy("created_at", "desc").execute()).map(learningSnapshotFromRow);
  }

  async pruneLearningSnapshots(retain = 20): Promise<{ retained: number; removed: string[] }> {
    const keep = Math.max(1, Math.min(Math.floor(retain), 200));
    const snapshots = await this.listLearningSnapshots();
    const removed: string[] = [];
    for (const snapshot of snapshots.slice(keep)) {
      await rm(path.join(this.rootDir, snapshot.path), { recursive: true, force: true });
      await this.db.deleteFrom("learning_snapshots").where("id", "=", snapshot.id).execute();
      removed.push(snapshot.id);
    }
    return { retained: Math.min(snapshots.length, keep), removed };
  }

  async restoreLearningSnapshot(id: string): Promise<LearningSnapshotRecord | undefined> {
    const row = await this.db.selectFrom("learning_snapshots").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return undefined;
    const snapshotRoot = path.join(this.rootDir, row.path);
    for (const rootName of ["memory", "skills", "wiki", "learning-graph"]) {
      const snapshotSource = path.join(snapshotRoot, rootName);
      await rm(path.join(this.rootDir, rootName), { recursive: true, force: true });
      if (await pathExists(snapshotSource)) {
        await cp(snapshotSource, path.join(this.rootDir, rootName), { recursive: true, force: true });
      }
    }
    const [memoryResult, skillResult, wikiResult] = await Promise.all([this.reindexMemory(), this.reindexSkills(), this.reindexWiki()]);
    if (memoryResult.errors.length || skillResult.errors.length || wikiResult.errors.length) {
      throw new Error(`learning_snapshot_reindex_failed:${JSON.stringify({ memory: memoryResult.errors, skills: skillResult.errors, wiki: wikiResult.errors })}`);
    }
    const restoredAt = nowIso();
    await this.db.updateTable("learning_snapshots").set({ restored_at: restoredAt }).where("id", "=", id).execute();
    return learningSnapshotFromRow({ ...row, restored_at: restoredAt });
  }

  async saveBackgroundReviewChange(record: BackgroundReviewChangeRecord): Promise<BackgroundReviewChangeRecord> {
    await this.db.insertInto("background_review_changes").values({
      id: record.id,
      origin: record.origin,
      source_run_id: record.source_run_id,
      source_session_id: record.source_session_id,
      review_run_id: record.review_run_id,
      mutation_kind: record.mutation_kind,
      resource_ref_json: stringify(record.resource_ref),
      before_version: record.before_version ?? null,
      after_version: record.after_version,
      reason_summary: record.reason_summary,
      evidence_refs_json: stringify(record.evidence_refs),
      created_at: record.created_at
    }).execute();
    return record;
  }

  async rollbackBackgroundReviewMetadata(reviewRunId: string): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction.deleteFrom("background_review_changes").where("review_run_id", "=", reviewRunId).execute();
      await transaction.deleteFrom("reflection_suggestions").where("reflection_run_id", "=", reviewRunId).execute();
      await transaction.deleteFrom("workspace_changes").where("summary", "like", `%Background Review ${reviewRunId}%`).execute();
    });
  }

  async listBackgroundReviewChanges(input: { sourceRunId?: string; reviewRunId?: string } = {}): Promise<BackgroundReviewChangeRecord[]> {
    let query = this.db.selectFrom("background_review_changes").selectAll().orderBy("created_at", "desc");
    if (input.sourceRunId) query = query.where("source_run_id", "=", input.sourceRunId);
    if (input.reviewRunId) query = query.where("review_run_id", "=", input.reviewRunId);
    return (await query.execute()).map(backgroundReviewChangeFromRow);
  }

  async saveLearningJobReport(record: LearningJobReportRecord): Promise<LearningJobReportRecord> {
    await this.db.insertInto("learning_job_reports").values({ id: record.id, job_kind: record.job_kind, run_id: record.run_id, report_json: stringify(record), created_at: record.created_at }).execute();
    return record;
  }

  async listLearningJobReports(input: { jobKind?: LearningJobReportRecord["job_kind"]; limit?: number } = {}): Promise<LearningJobReportRecord[]> {
    let query = this.db.selectFrom("learning_job_reports").selectAll().orderBy("created_at", "desc");
    if (input.jobKind) query = query.where("job_kind", "=", input.jobKind);
    if (input.limit) query = query.limit(input.limit);
    return (await query.execute()).map((row) => parse(row.report_json));
  }

  async getCuratorState(): Promise<CuratorStateRecord> {
    const result = await sql<CuratorStateTable>`
      SELECT id, paused, interval_hours, min_idle_hours, stale_after_days, archive_after_days, last_run_at, last_run_summary, run_count, updated_at
      FROM curator_state
      WHERE id = 'default'
    `.execute(this.db);
    const row = result.rows[0];
    return row ? curatorStateFromRow(row) : defaultCuratorState();
  }

  async saveCuratorState(patch: Partial<Omit<CuratorStateRecord, "id" | "updated_at">> = {}): Promise<CuratorStateRecord> {
    const current = await this.getCuratorState();
    const next: CuratorStateRecord = {
      ...current,
      ...patch,
      id: "default",
      updated_at: nowIso()
    };
    const row = curatorStateToRow(next);
    await sql`
      INSERT INTO curator_state (
        id,
        paused,
        interval_hours,
        min_idle_hours,
        stale_after_days,
        archive_after_days,
        last_run_at,
        last_run_summary,
        run_count,
        updated_at
      )
      VALUES (
        ${row.id},
        ${row.paused},
        ${row.interval_hours},
        ${row.min_idle_hours},
        ${row.stale_after_days},
        ${row.archive_after_days},
        ${row.last_run_at},
        ${row.last_run_summary},
        ${row.run_count},
        ${row.updated_at}
      )
      ON CONFLICT(id) DO UPDATE SET
        paused = excluded.paused,
        interval_hours = excluded.interval_hours,
        min_idle_hours = excluded.min_idle_hours,
        stale_after_days = excluded.stale_after_days,
        archive_after_days = excluded.archive_after_days,
        last_run_at = excluded.last_run_at,
        last_run_summary = excluded.last_run_summary,
        run_count = excluded.run_count,
        updated_at = excluded.updated_at
    `.execute(this.db);
    return next;
  }

  async writeSkillSupportFile(input: { skillId: string; path: string; content: string }): Promise<SkillSupportFile> {
    await this.assertSkillWriteUnlocked(input.skillId);
    const skill = await this.getSkill(input.skillId);
    if (!skill) {
      throw new Error(`skill_not_found:${input.skillId}`);
    }
    const supportPath = normalizeSkillSupportPath(input.path);
    const filePath = path.join("skills", "support", input.skillId, supportPath);
    const absolutePath = path.join(this.rootDir, filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content);
    return {
      skill_id: input.skillId,
      path: supportPath,
      file_path: filePath,
      content: input.content
    };
  }

  async readSkillSupportFile(input: { skillId: string; path: string }): Promise<SkillSupportFile | undefined> {
    const skill = await this.getSkill(input.skillId);
    if (!skill) return undefined;
    const supportPath = normalizeSkillSupportPath(input.path);
    const filePath = path.join("skills", "support", input.skillId, supportPath);
    try {
      const supportRoot = path.join(this.rootDir, "skills", "support", input.skillId);
      const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(supportRoot), realpath(path.join(this.rootDir, filePath))]);
      if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) return undefined;
      return {
        skill_id: input.skillId,
        path: supportPath,
        file_path: filePath,
        content: await readFile(path.join(this.rootDir, filePath), "utf8")
      };
    } catch {
      return undefined;
    }
  }

  async listSkillSupportFiles(skillId: string): Promise<SkillSupportFile[]> {
    const supportRoot = path.join(this.rootDir, "skills", "support", skillId);
    const filePaths = await listRelativeFiles(supportRoot).catch(() => []);
    const files = await Promise.all(
      filePaths.map(async (supportPath) => {
        const filePath = path.join("skills", "support", skillId, supportPath);
        return {
          skill_id: skillId,
          path: supportPath,
          file_path: filePath,
          content: await readFile(path.join(this.rootDir, filePath), "utf8")
        };
      })
    );
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async searchSkills(
    query: string,
    limit = 5,
    options: { states?: SkillFrontmatter["state"][] } = {}
  ): Promise<SkillWithFilePath[]> {
    let rows = await this.db.selectFrom("skill_index").selectAll().orderBy("updated_at", "desc").execute();
    if (options.states?.length) {
      const allowed = new Set(options.states);
      rows = rows.filter((row) => allowed.has(row.state as SkillFrontmatter["state"]));
    }
    const terms = searchTerms(query);
    const scored = await Promise.all(
      rows.map(async (row) => {
        const skill = skillFromRow(row);
        const markdown = await readWorkspaceText(this.rootDir, row.file_path);
        const score = terms.length === 0
          ? stateSearchBoost(skill.state)
          : scoreSearchFields(terms, [
            { value: row.title, weight: 12 },
            { value: row.description, weight: 9 },
            { value: row.tags_json, weight: 5 },
            { value: stripFrontmatter(markdown), weight: 8 },
            { value: row.required_capabilities_json, weight: 3 }
          ]) + stateSearchBoost(skill.state);
        return { item: skill, score, updatedAt: row.updated_at };
      })
    );
    return scored
      .filter((entry) => terms.length === 0 ? entry.score > 0 : entry.score > stateSearchBoost(entry.item.state))
      .sort(compareScoredSearch)
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  async saveWikiPage(frontmatter: WikiFrontmatter, content: string): Promise<WikiWithFilePath> {
    const relativePath = path.join("wiki", "pages", `${frontmatter.slug}.md`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${renderFrontmatter(frontmatter)}\n${content.trim()}\n`, { flag: "wx" });

    try {
      const parsed = parseWikiMarkdownLocal(await readFile(absolutePath, "utf8"));
      if (parsed.frontmatter.id !== frontmatter.id || parsed.frontmatter.slug !== frontmatter.slug) {
        throw new Error("wiki_frontmatter_path_mismatch");
      }
      await this.db
        .insertInto("wiki_index")
        .values(wikiToRow(parsed.frontmatter, relativePath))
        .execute();
      return { ...parsed.frontmatter, file_path: relativePath };
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  }

  async listWiki(options: { activeOnly?: boolean } = {}): Promise<WikiWithFilePath[]> {
    let query = this.db.selectFrom("wiki_index").selectAll();
    if (options.activeOnly) {
      query = query.where("state", "=", "active");
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(wikiFromRow);
  }

  async searchWiki(query: string, limit = 5, options: { activeOnly?: boolean } = { activeOnly: true }): Promise<WikiWithFilePath[]> {
    let dbQuery = this.db.selectFrom("wiki_index").selectAll();
    if (options.activeOnly ?? true) {
      dbQuery = dbQuery.where("state", "=", "active");
    }
    const rows = await dbQuery.orderBy("updated_at", "desc").execute();
    const terms = searchTerms(query);
    const scored = await Promise.all(
      rows.map(async (row) => {
        const wiki = wikiFromRow(row);
        const markdown = await readWorkspaceText(this.rootDir, row.file_path);
        const score = terms.length === 0
          ? stateSearchBoost(wiki.state)
          : scoreSearchFields(terms, [
            { value: row.title, weight: 12 },
            { value: row.slug, weight: 7 },
            { value: row.tags_json, weight: 5 },
            { value: stripFrontmatter(markdown), weight: 10 },
            { value: row.provenance_json, weight: 2 }
          ]) + stateSearchBoost(wiki.state);
        return { item: wiki, score, updatedAt: row.updated_at };
      })
    );
    return scored
      .filter((entry) => terms.length === 0 ? entry.score > 0 : entry.score > stateSearchBoost(entry.item.state))
      .sort(compareScoredSearch)
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  async getWiki(id: string): Promise<WikiWithFilePath | undefined> {
    const row = await this.db.selectFrom("wiki_index").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? wikiFromRow(row) : undefined;
  }

  async readWikiContent(id: string): Promise<string | undefined> {
    const wiki = await this.getWiki(id);
    if (!wiki) {
      return undefined;
    }
    const raw = await readFile(path.join(this.rootDir, wiki.file_path), "utf8");
    return stripFrontmatter(raw).trim();
  }

  async updateWikiPage(input: {
    id: string;
    title?: string;
    content?: string;
    tags?: string[];
    content_locale?: WikiFrontmatter["content_locale"];
    source_refs?: WikiFrontmatter["source_refs"];
    provenance?: WikiFrontmatter["provenance"];
  }): Promise<WikiWithFilePath | undefined> {
    const current = await this.getWiki(input.id);
    if (!current) {
      return undefined;
    }
    const content = input.content ?? (await this.readWikiContent(input.id));
    if (content === undefined) {
      return undefined;
    }
    const { file_path: filePath, ...currentFrontmatter } = current;
    const next: WikiFrontmatter = {
      ...currentFrontmatter,
      title: input.title ?? current.title,
      tags: input.tags ?? current.tags,
      content_locale: input.content_locale ?? current.content_locale,
      source_refs: input.source_refs ?? current.source_refs,
      provenance: input.provenance ?? current.provenance,
      updated_at: nowIso()
    };
    await this.writeWikiPage(next, filePath, content);
    return { ...next, file_path: filePath };
  }

  async setWikiState(id: string, state: WikiFrontmatter["state"]): Promise<WikiWithFilePath | undefined> {
    const current = await this.getWiki(id);
    if (!current) {
      return undefined;
    }
    const content = await this.readWikiContent(id);
    if (content === undefined) {
      return undefined;
    }
    const { file_path: filePath, ...currentFrontmatter } = current;
    const next: WikiFrontmatter = {
      ...currentFrontmatter,
      state,
      updated_at: nowIso()
    };
    await this.writeWikiPage(next, filePath, content);
    return { ...next, file_path: filePath };
  }

  async reindexWiki(): Promise<WikiReindexResult> {
    const existingRows = await this.db.selectFrom("wiki_index").selectAll().execute();
    const existingIds = new Set(existingRows.map((row) => row.id));
    const markdownFiles = await listWikiMarkdownFiles(this.rootDir);
    const indexedFilePaths = new Set<string>();
    const seenIds = new Set<string>();
    const errors: WikiReindexResult["errors"] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const filePath of markdownFiles) {
      try {
        const raw = await readFile(path.join(this.rootDir, filePath), "utf8");
        const parsed = parseWikiMarkdownLocal(raw);
        if (seenIds.has(parsed.frontmatter.id)) {
          skipped += 1;
          errors.push({ file_path: filePath, message: `duplicate wiki id: ${parsed.frontmatter.id}` });
          continue;
        }
        seenIds.add(parsed.frontmatter.id);
        indexedFilePaths.add(filePath);
        const row = wikiToRow(parsed.frontmatter, filePath);
        await this.db
          .insertInto("wiki_index")
          .values(row)
          .onConflict((oc) => oc.column("id").doUpdateSet(row))
          .execute();
        if (existingIds.has(parsed.frontmatter.id)) {
          updated += 1;
        } else {
          created += 1;
        }
      } catch (error) {
        skipped += 1;
        errors.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    let removed = 0;
    for (const row of existingRows) {
      if (indexedFilePaths.has(row.file_path) || seenIds.has(row.id)) {
        continue;
      }
      await this.db.deleteFrom("wiki_index").where("id", "=", row.id).execute();
      removed += 1;
    }

    const pages = await this.listWiki();
    return {
      active: pages.filter((page) => page.state === "active").length,
      total: pages.length,
      files: markdownFiles.length,
      indexed: pages.length,
      created,
      updated,
      removed,
      skipped,
      errors
    };
  }

  async reindexMemory(): Promise<MemoryReindexResult> {
    const existingRows = await this.db.selectFrom("memory_index").selectAll().execute();
    const existingIds = new Set(existingRows.map((row) => row.id));
    const markdownFiles = await listMemoryMarkdownFiles(this.rootDir);
    const indexedFilePaths = new Set<string>();
    const seenIds = new Set<string>();
    const errors: MemoryReindexResult["errors"] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const filePath of markdownFiles) {
      try {
        const parsed = parseMemoryMarkdownLocal(await readFile(path.join(this.rootDir, filePath), "utf8"));
        assertMemoryPathMatchesFrontmatter(filePath, parsed.frontmatter);
        if (seenIds.has(parsed.frontmatter.id)) {
          skipped += 1;
          errors.push({ file_path: filePath, message: `duplicate memory id: ${parsed.frontmatter.id}` });
          continue;
        }
        seenIds.add(parsed.frontmatter.id);
        indexedFilePaths.add(filePath);
        const row = memoryToRow(parsed.frontmatter, filePath);
        await this.db
          .insertInto("memory_index")
          .values(row)
          .onConflict((oc) => oc.column("id").doUpdateSet(row))
          .execute();
        if (existingIds.has(parsed.frontmatter.id)) {
          updated += 1;
        } else {
          created += 1;
        }
      } catch (error) {
        skipped += 1;
        errors.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    let removed = 0;
    for (const row of existingRows) {
      if (indexedFilePaths.has(row.file_path) || seenIds.has(row.id)) {
        continue;
      }
      await this.db.deleteFrom("memory_index").where("id", "=", row.id).execute();
      removed += 1;
    }

    const rows = await this.db.selectFrom("memory_index").selectAll().execute();
    return {
      files: markdownFiles.length,
      indexed: rows.length,
      created,
      updated,
      removed,
      skipped,
      errors
    };
  }

  async reindexSkills(): Promise<SkillReindexResult> {
    const existingRows = await this.db.selectFrom("skill_index").selectAll().execute();
    const existingIds = new Set(existingRows.map((row) => row.id));
    const markdownFiles = await listSkillMarkdownFiles(this.rootDir);
    const indexedFilePaths = new Set<string>();
    const seenIds = new Set<string>();
    const errors: SkillReindexResult["errors"] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const filePath of markdownFiles) {
      try {
        const parsed = parseSkillMarkdownLocal(await readFile(path.join(this.rootDir, filePath), "utf8"));
        assertSkillPathMatchesFrontmatter(filePath, parsed.frontmatter);
        if (seenIds.has(parsed.frontmatter.id)) {
          skipped += 1;
          errors.push({ file_path: filePath, message: `duplicate skill id: ${parsed.frontmatter.id}` });
          continue;
        }
        seenIds.add(parsed.frontmatter.id);
        indexedFilePaths.add(filePath);
        const row = skillToRow(parsed.frontmatter, filePath);
        await this.db
          .insertInto("skill_index")
          .values(row)
          .onConflict((oc) => oc.column("id").doUpdateSet(row))
          .execute();
        if (existingIds.has(parsed.frontmatter.id)) {
          updated += 1;
        } else {
          created += 1;
        }
      } catch (error) {
        skipped += 1;
        errors.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    let removed = 0;
    for (const row of existingRows) {
      if (indexedFilePaths.has(row.file_path) || seenIds.has(row.id)) {
        continue;
      }
      await this.db.deleteFrom("skill_index").where("id", "=", row.id).execute();
      removed += 1;
    }

    const rows = await this.db.selectFrom("skill_index").selectAll().execute();
    return {
      files: markdownFiles.length,
      indexed: rows.length,
      created,
      updated,
      removed,
      skipped,
      errors
    };
  }

  async inspectWorkspace(): Promise<WorkspaceHealthReport> {
    const checkedAt = nowIso();
    const layoutChecks = await Promise.all(
      workspaceLayoutDirs(this.rootDir).map(async (dir) => ({
        path: path.relative(this.rootDir, dir) || ".",
        exists: await pathExists(dir),
        kind: "directory" as const,
        required: true
      }))
    );
    const missingLayout = layoutChecks.filter((check) => !check.exists).map((check) => check.path);
    const wikiFiles = await listWikiMarkdownFiles(this.rootDir);
    const wikiPages = await this.listWiki();
    const [artifactHealth, memoryHealth, skillHealth, collectionHealth, searchHealth, brokenCollectionRefs] = await Promise.all([
      this.inspectArtifactIndexes(),
      this.inspectMemoryIndex(),
      this.inspectSkillIndex(),
      this.inspectCollectionIndexes(),
      this.inspectSessionSearchIndex(),
      this.inspectBrokenCollectionResourceRefs()
    ]);
    const wikiFileSet = new Set(wikiFiles);
    const indexedIds = new Set(wikiPages.map((page) => page.id));
    const missingFiles = wikiPages
      .filter((page) => !wikiFileSet.has(page.file_path))
      .map((page) => ({ id: page.id, file_path: page.file_path, title: page.title }));
    const unindexedFiles: string[] = [];
    const invalidFiles: Array<{ file_path: string; message: string }> = [];
    const filesById = new Map<string, string[]>();

    for (const filePath of wikiFiles) {
      try {
        const parsed = parseWikiMarkdownLocal(await readFile(path.join(this.rootDir, filePath), "utf8"));
        const paths = filesById.get(parsed.frontmatter.id) ?? [];
        paths.push(filePath);
        filesById.set(parsed.frontmatter.id, paths);
        if (!indexedIds.has(parsed.frontmatter.id)) {
          unindexedFiles.push(filePath);
        }
      } catch (error) {
        invalidFiles.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    const duplicateIds = [...filesById.entries()]
      .filter(([, filePaths]) => filePaths.length > 1)
      .map(([id, filePaths]) => ({ id, file_paths: filePaths }));
    const issues: WorkspaceDriftIssue[] = [];

    for (const item of missingFiles) {
      issues.push({
        code: "wiki_index_missing_file",
        severity: "warning",
        message: `Knowledge Wiki index points to a missing markdown file: ${item.file_path}`,
        file_path: item.file_path,
        resource_id: item.id
      });
    }
    for (const filePath of unindexedFiles) {
      issues.push({
        code: "wiki_file_unindexed",
        severity: "warning",
        message: `Knowledge Wiki markdown file is not present in SQLite index: ${filePath}`,
        file_path: filePath
      });
    }
    for (const item of invalidFiles) {
      issues.push({
        code: "wiki_file_invalid",
        severity: "error",
        message: `Knowledge Wiki markdown frontmatter is invalid: ${item.message}`,
        file_path: item.file_path
      });
    }
    for (const item of duplicateIds) {
      issues.push({
        code: "wiki_duplicate_id",
        severity: "error",
        message: `Knowledge Wiki id is duplicated across ${item.file_paths.length} files: ${item.id}`,
        resource_id: item.id
      });
    }
    for (const item of missingLayout) {
      issues.push({
        code: "workspace_layout_missing",
        severity: "error",
        message: `Workspace directory is missing: ${item}`,
        file_path: item
      });
    }
    for (const item of artifactHealth.missing_files) {
      issues.push({
        code: "artifact_metadata_missing_file",
        severity: "warning",
        message: `Artifact metadata points to a missing file: ${item.file_path}`,
        file_path: item.file_path,
        resource_id: item.id
      });
    }
    for (const filePath of artifactHealth.unindexed_files) {
      issues.push({
        code: "artifact_file_unindexed",
        severity: "warning",
        message: `Artifact file is not referenced by SQLite metadata: ${filePath}`,
        file_path: filePath
      });
    }
    for (const item of memoryHealth.missing_files) {
      issues.push({
        code: "memory_index_missing_file",
        severity: "warning",
        message: `Memory index points to a missing markdown file: ${item.file_path}`,
        file_path: item.file_path,
        resource_id: item.id
      });
    }
    for (const filePath of memoryHealth.unindexed_files) {
      issues.push({
        code: "memory_file_unindexed",
        severity: "warning",
        message: `Memory markdown file is not present in SQLite index: ${filePath}`,
        file_path: filePath
      });
    }
    for (const item of memoryHealth.invalid_files) {
      issues.push({
        code: "memory_file_invalid",
        severity: "error",
        message: `Memory markdown frontmatter is invalid: ${item.message}`,
        file_path: item.file_path
      });
    }
    for (const item of memoryHealth.duplicate_ids) {
      issues.push({
        code: "memory_duplicate_id",
        severity: "error",
        message: `Memory id is duplicated across ${item.file_paths.length} files: ${item.id}`,
        resource_id: item.id
      });
    }
    for (const item of skillHealth.missing_files) {
      issues.push({
        code: "skill_index_missing_file",
        severity: "warning",
        message: `Skill index points to a missing markdown file: ${item.file_path}`,
        file_path: item.file_path,
        resource_id: item.id
      });
    }
    for (const filePath of skillHealth.unindexed_files) {
      issues.push({
        code: "skill_file_unindexed",
        severity: "warning",
        message: `Skill markdown file is not present in SQLite index: ${filePath}`,
        file_path: filePath
      });
    }
    for (const item of skillHealth.invalid_files) {
      issues.push({
        code: "skill_file_invalid",
        severity: "error",
        message: `Skill markdown frontmatter is invalid: ${item.message}`,
        file_path: item.file_path
      });
    }
    for (const item of skillHealth.duplicate_ids) {
      issues.push({
        code: "skill_duplicate_id",
        severity: "error",
        message: `Skill id is duplicated across ${item.file_paths.length} files: ${item.id}`,
        resource_id: item.id
      });
    }
    for (const item of collectionHealth.schemas.missing_files) {
      issues.push({
        code: "collection_schema_index_missing_file",
        severity: "warning",
        message: `Collection schema index points to a missing file: ${item.file_path}`,
        file_path: item.file_path,
        resource_id: item.id
      });
    }
    for (const filePath of collectionHealth.schemas.unindexed_files) {
      issues.push({
        code: "collection_schema_file_unindexed",
        severity: "warning",
        message: `Collection schema file is not present in SQLite index: ${filePath}`,
        file_path: filePath
      });
    }
    for (const item of collectionHealth.schemas.invalid_files) {
      issues.push({
        code: "collection_schema_file_invalid",
        severity: "error",
        message: `Collection schema file is invalid: ${item.message}`,
        file_path: item.file_path
      });
    }
    for (const item of collectionHealth.records.missing_files) {
      issues.push({
        code: "collection_record_index_missing_file",
        severity: "warning",
        message: `Collection record index points to a missing file: ${item.file_path}`,
        file_path: item.file_path,
        resource_id: item.id
      });
    }
    for (const filePath of collectionHealth.records.unindexed_files) {
      issues.push({
        code: "collection_record_file_unindexed",
        severity: "warning",
        message: `Collection record file is not present in SQLite index: ${filePath}`,
        file_path: filePath
      });
    }
    for (const item of collectionHealth.records.invalid_files) {
      issues.push({
        code: "collection_record_file_invalid",
        severity: "error",
        message: `Collection record file is invalid: ${item.message}`,
        file_path: item.file_path
      });
    }
    for (const item of brokenCollectionRefs) {
      issues.push({
        code: "collection_record_broken_ref",
        severity: "warning",
        message: `Collection record references a missing local resource: ${item.ref.kind}/${item.ref.id}`,
        file_path: item.file_path,
        resource_id: item.record_id
      });
    }

    const repairPlan: WorkspaceRepairStep[] = [];
    if (missingFiles.length > 0 || unindexedFiles.length > 0) {
      repairPlan.push({
        operation: "wiki.reindex",
        reason: "Knowledge Wiki markdown files and SQLite index are out of sync.",
        effect: "Rebuild the derived wiki_index table from workspace/wiki/pages/*.md and remove stale index rows."
      });
    }
    if (invalidFiles.length > 0 || duplicateIds.length > 0) {
      repairPlan.push({
        operation: "manual_wiki_frontmatter_fix",
        reason: "Some Knowledge Wiki files cannot be safely indexed.",
        effect: "Fix invalid or duplicated frontmatter, then run wiki.reindex again."
      });
    }
    if (missingLayout.length > 0) {
      repairPlan.push({
        operation: "ensure_workspace_layout",
        reason: "Required Workspace directories are missing.",
        effect: "Recreate the standard Workspace directory layout."
      });
    }
    if (!collectionHealth.ok) {
      repairPlan.push({
        operation: "collection.reindex",
        reason: "Collection schema or record files and SQLite indexes are out of sync.",
        effect: "Rebuild Collection index rows from collections/*/schema.json and collections/*/records/*.json."
      });
    }
    if (brokenCollectionRefs.length > 0) {
      repairPlan.push({
        operation: "collection.remove_broken_refs",
        reason: "Collection records contain references to local resources that no longer exist.",
        effect: "Remove only confirmed-missing local references and increment affected record versions."
      });
    }
    if (!artifactHealth.ok) {
      repairPlan.push({
        operation: "manual_artifact_inventory_fix",
        reason: "Artifact body files and SQLite metadata are out of sync.",
        effect: "Restore missing artifact files from backup, or import/delete orphan files with an explicit user decision."
      });
    }
    if (memoryHealth.missing_files.length > 0 || memoryHealth.unindexed_files.length > 0) {
      repairPlan.push({
        operation: "memory.reindex",
        reason: "Memory markdown files and SQLite index are out of sync.",
        effect: "Rebuild the derived memory_index table from memory/*/*.md and remove stale index rows."
      });
    }
    if (memoryHealth.invalid_files.length > 0 || memoryHealth.duplicate_ids.length > 0) {
      repairPlan.push({
        operation: "manual_memory_frontmatter_fix",
        reason: "Some Memory files cannot be safely indexed.",
        effect: "Fix invalid or duplicated frontmatter, then run memory.reindex again."
      });
    }
    if (skillHealth.missing_files.length > 0 || skillHealth.unindexed_files.length > 0) {
      repairPlan.push({
        operation: "skill.reindex",
        reason: "Skill markdown files and SQLite index are out of sync.",
        effect: "Rebuild the derived skill_index table from skills/*/*.md and remove stale index rows."
      });
    }
    if (skillHealth.invalid_files.length > 0 || skillHealth.duplicate_ids.length > 0) {
      repairPlan.push({
        operation: "manual_skill_frontmatter_fix",
        reason: "Some Skill files cannot be safely indexed.",
        effect: "Fix invalid or duplicated frontmatter, then run skill.reindex again."
      });
    }
    if (searchHealth.stale) {
      issues.push({ code: "session_search_index_stale", severity: "warning", message: "Session Search index does not match source records." });
      repairPlan.push({ operation: "session_search.reindex", reason: "Session Search index is stale.", effect: "Rebuild FTS read models from Session, Message, and Artifact sources." });
    }

    const wikiOk = missingFiles.length === 0 && unindexedFiles.length === 0 && invalidFiles.length === 0 && duplicateIds.length === 0;
    const layoutOk = missingLayout.length === 0;
    return {
      ok: layoutOk && wikiOk && artifactHealth.ok && memoryHealth.ok && skillHealth.ok && collectionHealth.ok && searchHealth.ok && brokenCollectionRefs.length === 0,
      checked_at: checkedAt,
      root_dir: this.rootDir,
      db_path: this.dbPath,
      layout: {
        ok: layoutOk,
        checks: layoutChecks,
        missing: missingLayout
      },
      resource_boundaries: workspaceResourceBoundaries(),
      indexes: {
        search: searchHealth,
        wiki: {
          ok: wikiOk,
          files: wikiFiles.length,
          indexed: wikiPages.length,
          active: wikiPages.filter((page) => page.state === "active").length,
          missing_files: missingFiles,
          unindexed_files: unindexedFiles,
          invalid_files: invalidFiles,
          duplicate_ids: duplicateIds
        },
        artifacts: artifactHealth,
        memory: memoryHealth,
        skills: skillHealth,
        collections: collectionHealth
      },
      issues,
      repair_plan: repairPlan
    };
  }

  private async inspectBrokenCollectionResourceRefs(): Promise<Array<{ collection_id: string; record_id: string; file_path: string; ref: ResourceRef }>> {
    const [recordRows, artifactRows, memoryRows, skillRows, wikiRows] = await Promise.all([
      this.db.selectFrom("collection_records").selectAll().execute(),
      this.db.selectFrom("artifacts").select("id").execute(),
      this.db.selectFrom("memory_index").select("id").execute(),
      this.db.selectFrom("skill_index").select("id").execute(),
      this.db.selectFrom("wiki_index").select("id").execute()
    ]);
    const ids = {
      artifact: new Set(artifactRows.map((row) => row.id)),
      memory: new Set(memoryRows.map((row) => row.id)),
      skill: new Set(skillRows.map((row) => row.id)),
      wiki: new Set(wikiRows.map((row) => row.id)),
      collection_record: new Set(recordRows.map((row) => row.id))
    };
    const broken: Array<{ collection_id: string; record_id: string; file_path: string; ref: ResourceRef }> = [];
    for (const row of recordRows) {
      const record = collectionRecordFromRow(row);
      for (const ref of record.resource_refs) {
        if (ref.kind in ids && !(ids[ref.kind as keyof typeof ids] as Set<string>).has(ref.id)) {
          broken.push({ collection_id: row.collection_id, record_id: row.id, file_path: row.file_path, ref });
        }
      }
    }
    return broken;
  }

  private async inspectSessionSearchIndex(): Promise<WorkspaceHealthReport["indexes"]["search"]> {
    const [sessions, messages, artifacts] = await Promise.all([
      this.db.selectFrom("sessions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirst(),
      this.db.selectFrom("messages").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirst(),
      this.db.selectFrom("artifacts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirst()
    ]);
    const sourceRecords = Number(sessions?.count ?? 0) + Number(messages?.count ?? 0) + Number(artifacts?.count ?? 0);
    if (this.sessionSearchIndexMode === "like") return { ok: true, mode: "like", indexed: 0, source_records: sourceRecords, stale: false };
    const table = this.sessionSearchIndexMode === "fts5_trigram" ? "session_search_trigram" : "session_search_fts";
    const result = await sql<{ count: number }>`SELECT COUNT(*) as count FROM ${sql.raw(table)}`.execute(this.db).catch(() => ({ rows: [{ count: 0 }] }));
    const indexed = Number(result.rows[0]?.count ?? 0);
    return { ok: indexed === sourceRecords, mode: this.sessionSearchIndexMode, indexed, source_records: sourceRecords, stale: indexed !== sourceRecords };
  }

  private async inspectArtifactIndexes(): Promise<WorkspaceHealthReport["indexes"]["artifacts"]> {
    const [rows, revisionRows] = await Promise.all([
      this.db.selectFrom("artifacts").selectAll().execute(),
      this.db.selectFrom("artifact_revisions").selectAll().execute()
    ]);
    const artifactFiles = await listArtifactFiles(this.rootDir);
    const artifactFileSet = new Set(artifactFiles);
    const indexedFileSet = new Set([
      ...rows.map((row) => artifactFromRow(row).file_ref.uri),
      ...revisionRows.flatMap((row) => [row.file_path, row.blob_path])
    ]);
    const missingFiles = [...rows
      .map(artifactFromRow)
      .filter((artifact) => !artifactFileSet.has(artifact.file_ref.uri))
      .map((artifact) => ({ id: artifact.id, file_path: artifact.file_ref.uri, title: artifact.title })),
      ...revisionRows.flatMap((row) => [row.file_path, row.blob_path].filter((filePath) => !artifactFileSet.has(filePath)).map((filePath) => ({ id: row.artifact_id, file_path: filePath, title: `Artifact revision ${row.revision}` })))];
    const unindexedFiles = artifactFiles.filter((filePath) => !indexedFileSet.has(filePath));
    return {
      ok: missingFiles.length === 0 && unindexedFiles.length === 0,
      files: artifactFiles.length,
      indexed: indexedFileSet.size,
      missing_files: missingFiles,
      unindexed_files: unindexedFiles
    };
  }

  private async inspectMemoryIndex(): Promise<WorkspaceHealthReport["indexes"]["memory"]> {
    const rows = await this.db.selectFrom("memory_index").selectAll().execute();
    const memoryFiles = await listMemoryMarkdownFiles(this.rootDir);
    const memoryFileSet = new Set(memoryFiles);
    const indexedIds = new Set(rows.map((row) => row.id));
    const missingFiles = rows
      .filter((row) => !memoryFileSet.has(row.file_path))
      .map((row) => ({ id: row.id, file_path: row.file_path, topic: row.topic }));
    const unindexedFiles: string[] = [];
    const invalidFiles: Array<{ file_path: string; message: string }> = [];
    const filesById = new Map<string, string[]>();

    for (const filePath of memoryFiles) {
      try {
        const parsed = parseMemoryMarkdownLocal(await readFile(path.join(this.rootDir, filePath), "utf8"));
        assertMemoryPathMatchesFrontmatter(filePath, parsed.frontmatter);
        const paths = filesById.get(parsed.frontmatter.id) ?? [];
        paths.push(filePath);
        filesById.set(parsed.frontmatter.id, paths);
        if (!indexedIds.has(parsed.frontmatter.id)) {
          unindexedFiles.push(filePath);
        }
      } catch (error) {
        invalidFiles.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    const duplicateIds = [...filesById.entries()]
      .filter(([, filePaths]) => filePaths.length > 1)
      .map(([id, filePaths]) => ({ id, file_paths: filePaths }));
    return {
      ok: missingFiles.length === 0 && unindexedFiles.length === 0 && invalidFiles.length === 0 && duplicateIds.length === 0,
      files: memoryFiles.length,
      indexed: rows.length,
      missing_files: missingFiles,
      unindexed_files: unindexedFiles,
      invalid_files: invalidFiles,
      duplicate_ids: duplicateIds
    };
  }

  private async inspectSkillIndex(): Promise<WorkspaceHealthReport["indexes"]["skills"]> {
    const rows = await this.db.selectFrom("skill_index").selectAll().execute();
    const skillFiles = await listSkillMarkdownFiles(this.rootDir);
    const skillFileSet = new Set(skillFiles);
    const indexedIds = new Set(rows.map((row) => row.id));
    const missingFiles = rows
      .filter((row) => !skillFileSet.has(row.file_path))
      .map((row) => ({ id: row.id, file_path: row.file_path, title: row.title }));
    const unindexedFiles: string[] = [];
    const invalidFiles: Array<{ file_path: string; message: string }> = [];
    const filesById = new Map<string, string[]>();

    for (const filePath of skillFiles) {
      try {
        const parsed = parseSkillMarkdownLocal(await readFile(path.join(this.rootDir, filePath), "utf8"));
        assertSkillPathMatchesFrontmatter(filePath, parsed.frontmatter);
        const paths = filesById.get(parsed.frontmatter.id) ?? [];
        paths.push(filePath);
        filesById.set(parsed.frontmatter.id, paths);
        if (!indexedIds.has(parsed.frontmatter.id)) {
          unindexedFiles.push(filePath);
        }
      } catch (error) {
        invalidFiles.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    const duplicateIds = [...filesById.entries()]
      .filter(([, filePaths]) => filePaths.length > 1)
      .map(([id, filePaths]) => ({ id, file_paths: filePaths }));
    return {
      ok: missingFiles.length === 0 && unindexedFiles.length === 0 && invalidFiles.length === 0 && duplicateIds.length === 0,
      files: skillFiles.length,
      indexed: rows.length,
      missing_files: missingFiles,
      unindexed_files: unindexedFiles,
      invalid_files: invalidFiles,
      duplicate_ids: duplicateIds
    };
  }

  private async inspectCollectionIndexes(): Promise<WorkspaceHealthReport["indexes"]["collections"]> {
    const [schemaRows, recordRows] = await Promise.all([
      this.db.selectFrom("collection_schemas").selectAll().execute(),
      this.db.selectFrom("collection_records").selectAll().execute()
    ]);
    const schemaFiles = await listCollectionSchemaFiles(this.rootDir);
    const recordFiles = await listCollectionRecordFiles(this.rootDir);
    const schemaFileSet = new Set(schemaFiles);
    const recordFileSet = new Set(recordFiles);
    const indexedSchemaIds = new Set(schemaRows.map((row) => row.id));
    const indexedRecordKeys = new Set(recordRows.map((row) => `${row.collection_id}/${row.id}`));
    const schemasById = new Map<string, CollectionSchema>();

    for (const row of schemaRows) {
      try {
        const schema = collectionSchemaFromRow(row);
        schemasById.set(schema.id, schema);
      } catch {
        // Corrupt SQLite rows are surfaced through missing/unindexed file drift first.
      }
    }

    const missingSchemaFiles = schemaRows
      .filter((row) => !schemaFileSet.has(row.file_path))
      .map((row) => ({ id: row.id, file_path: row.file_path }));
    const unindexedSchemaFiles: string[] = [];
    const invalidSchemaFiles: Array<{ file_path: string; message: string }> = [];

    for (const filePath of schemaFiles) {
      try {
        const schema = parseCollectionSchemaLocal(JSON.parse(await readFile(path.join(this.rootDir, filePath), "utf8")));
        schemasById.set(schema.id, schema);
        if (!indexedSchemaIds.has(schema.id)) {
          unindexedSchemaFiles.push(filePath);
        }
      } catch (error) {
        invalidSchemaFiles.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    const missingRecordFiles = recordRows
      .filter((row) => !recordFileSet.has(row.file_path))
      .map((row) => ({ id: row.id, collection_id: row.collection_id, file_path: row.file_path }));
    const unindexedRecordFiles: string[] = [];
    const invalidRecordFiles: Array<{ file_path: string; message: string }> = [];

    for (const filePath of recordFiles) {
      try {
        const raw = JSON.parse(await readFile(path.join(this.rootDir, filePath), "utf8")) as Record<string, unknown>;
        const collectionId = typeof raw.collection_id === "string" ? raw.collection_id : "";
        const schema = schemasById.get(collectionId);
        if (!schema) {
          throw new Error("collection_schema_not_found");
        }
        const record = parseCollectionRecordLocal(raw, schema);
        const key = `${record.collection_id}/${record.id}`;
        if (!indexedRecordKeys.has(key)) {
          unindexedRecordFiles.push(filePath);
        }
      } catch (error) {
        invalidRecordFiles.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    const ok = missingSchemaFiles.length === 0
      && unindexedSchemaFiles.length === 0
      && invalidSchemaFiles.length === 0
      && missingRecordFiles.length === 0
      && unindexedRecordFiles.length === 0
      && invalidRecordFiles.length === 0;
    return {
      ok,
      schemas: {
        files: schemaFiles.length,
        indexed: schemaRows.length,
        missing_files: missingSchemaFiles,
        unindexed_files: unindexedSchemaFiles,
        invalid_files: invalidSchemaFiles
      },
      records: {
        files: recordFiles.length,
        indexed: recordRows.length,
        missing_files: missingRecordFiles,
        unindexed_files: unindexedRecordFiles,
        invalid_files: invalidRecordFiles
      }
    };
  }

  async checkIntegrity(): Promise<WorkspaceIntegrityReport> {
    const [workspace, integrity] = await Promise.all([
      this.inspectWorkspace(),
      this.checkDatabaseIntegrity()
    ]);
    return {
      ok: integrity.ok && workspace.ok,
      checked_at: nowIso(),
      db: {
        ok: integrity.ok,
        result: integrity.result,
        path: this.dbPath
      },
      workspace
    };
  }

  private async checkDatabaseIntegrity(): Promise<{ ok: boolean; result: string }> {
    const integrity = await sql<{ integrity_check: string }>`PRAGMA integrity_check`.execute(this.db);
    const result = integrity.rows.map((row) => row.integrity_check).join("\n") || "unknown";
    return {
      ok: result === "ok",
      result
    };
  }

  async listMigrationJournal(limit = 20): Promise<MigrationJournalRecord[]> {
    const rows = await this.db
      .selectFrom("migration_journal")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map(migrationJournalFromRow);
  }

  async repairWorkspace(options: { dryRun?: boolean } = {}): Promise<WorkspaceRepairResult> {
    const dryRun = options.dryRun ?? true;
    const before = await this.inspectWorkspace();
    const result: WorkspaceRepairResult = {
      dry_run: dryRun,
      plan: before.repair_plan,
      applied: [],
      skipped: [],
      health: before
    };
    if (dryRun) {
      return result;
    }

    for (const step of before.repair_plan) {
      if (step.operation === "ensure_workspace_layout") {
        await ensureWorkspaceLayout(this.rootDir);
        result.applied.push(step.operation);
        continue;
      }
      if (step.operation === "wiki.reindex") {
        result.wiki_reindex = await this.reindexWiki();
        result.applied.push(step.operation);
        continue;
      }
      if (step.operation === "memory.reindex") {
        result.memory_reindex = await this.reindexMemory();
        result.applied.push(step.operation);
        continue;
      }
      if (step.operation === "skill.reindex") {
        result.skill_reindex = await this.reindexSkills();
        result.applied.push(step.operation);
        continue;
      }
      if (step.operation === "collection.reindex") {
        result.collection_reindex = await this.reindexCollections();
        result.applied.push(step.operation);
        continue;
      }
      if (step.operation === "collection.remove_broken_refs") {
        await this.removeBrokenCollectionResourceRefs();
        result.applied.push(step.operation);
        continue;
      }
      if (step.operation === "session_search.reindex") {
        await this.reindexSessionSearch();
        result.applied.push(step.operation);
        continue;
      }
      result.skipped.push(step.operation);
    }

    result.health = await this.inspectWorkspace();
    return result;
  }

  private async removeBrokenCollectionResourceRefs(): Promise<number> {
    const broken = await this.inspectBrokenCollectionResourceRefs();
    const grouped = new Map<string, typeof broken>();
    for (const item of broken) {
      const key = `${item.collection_id}\0${item.record_id}`;
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    let repaired = 0;
    for (const items of grouped.values()) {
      const first = items[0];
      if (!first) continue;
      const before = await this.getCollectionRecord(first.collection_id, first.record_id);
      if (!before) continue;
      const brokenKeys = new Set(items.map((item) => `${item.ref.kind}\0${item.ref.id}\0${item.ref.uri}`));
      const after = {
        ...before,
        version: before.version + 1,
        resource_refs: before.resource_refs.filter((ref) => !brokenKeys.has(`${ref.kind}\0${ref.id}\0${ref.uri}`)),
        updated_at: nowIso()
      };
      const targetPath = path.join(this.rootDir, before.file_path);
      const transactionId = createId("file_transaction");
      const stagedRelativePath = `${before.file_path}.pending-${transactionId}`;
      const stagedPath = path.join(this.rootDir, stagedRelativePath);
      const createdAt = nowIso();
      await this.db.insertInto("workspace_file_transactions").values({
        id: transactionId, kind: "collection_record_repair", status: "planned", target_path: before.file_path,
        staged_path: stagedRelativePath, collection_id: before.collection_id, record_id: before.id, patch_id: null,
        before_json: stringify(before), after_json: stringify(after), created_at: createdAt, updated_at: createdAt
      }).execute();
      await writeFile(stagedPath, `${JSON.stringify(after, null, 2)}\n`, { flag: "wx" });
      await this.db.transaction().execute(async (transaction) => {
        const update = await transaction.updateTable("collection_records").set({ record_json: stringify(after), version: after.version, updated_at: after.updated_at }).where("collection_id", "=", before.collection_id).where("id", "=", before.id).where("version", "=", before.version).executeTakeFirst();
        if (Number(update.numUpdatedRows) !== 1) throw new Error("collection_record_repair_version_conflict");
        await transaction.updateTable("workspace_file_transactions").set({ status: "db_committed", updated_at: nowIso() }).where("id", "=", transactionId).execute();
      });
      await rename(stagedPath, targetPath);
      await this.db.deleteFrom("workspace_file_transactions").where("id", "=", transactionId).execute();
      repaired += 1;
    }
    return repaired;
  }

  async createWorkspaceBackup(): Promise<WorkspaceBackupRecord> {
    await sql`PRAGMA wal_checkpoint(FULL)`.execute(this.db).catch(() => undefined);
    const [health, dbIntegrity] = await Promise.all([
      this.inspectWorkspace(),
      this.checkDatabaseIntegrity()
    ]);
    const id = createBackupId();
    const relativeBackupPath = path.join("backups", id);
    const backupPath = path.join(this.rootDir, relativeBackupPath);
    const filesPath = path.join(backupPath, "files");
    await mkdir(filesPath, { recursive: true });
    await copyFile(this.dbPath, path.join(backupPath, "workspace.sqlite"));
    const copiedRoots: string[] = [];

    for (const rootName of workspaceBackupRoots()) {
      const source = path.join(this.rootDir, rootName);
      if (!await pathExists(source)) {
        continue;
      }
      await cp(source, path.join(filesPath, rootName), { recursive: true, force: true });
      copiedRoots.push(rootName);
    }

    const fileHashes = await hashFilesUnderRoot(backupPath, ["manifest.json"]);

    const manifest: WorkspaceBackupManifest = {
      id,
      created_at: nowIso(),
      source_root: this.rootDir,
      db_file: "workspace.sqlite",
      file_roots: copiedRoots,
      resource_boundaries: health.resource_boundaries,
      health_ok: health.ok,
      integrity_ok: health.ok && dbIntegrity.ok,
      file_hashes: fileHashes
    };
    await writeFile(path.join(backupPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      id,
      path: relativeBackupPath,
      manifest
    };
  }

  async listWorkspaceBackups(): Promise<WorkspaceBackupRecord[]> {
    const backupsRoot = path.join(this.rootDir, "backups");
    let entries: string[];
    try {
      entries = await readdir(backupsRoot);
    } catch {
      return [];
    }
    const records = await Promise.all(entries.map(async (entry) => {
      try {
        const id = normalizeBackupId(entry);
        const manifest = parseWorkspaceBackupManifest(JSON.parse(await readFile(path.join(backupsRoot, id, "manifest.json"), "utf8")));
        return {
          id,
          path: path.join("backups", id),
          manifest
        };
      } catch {
        return undefined;
      }
    }));
    return records
      .filter((record): record is WorkspaceBackupRecord => Boolean(record))
      .sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
  }

  async applyResourceRetention(policy:{max_queue:number;max_concurrency:number;max_context_tokens:number;max_file_bytes:number;max_events_per_run:number;max_backups:number;max_snapshots:number;now?:string}){const now=policy.now??nowIso();for(const[key,value]of Object.entries(policy))if(key!=="now"&&(!Number.isFinite(value as number)||(value as number)<=0))throw new Error(`resource_limit_invalid:${key}`);const deliveries=await this.listGatewayDeliveries(),activeQueue=deliveries.filter(x=>!["delivered","failed"].includes(x.status));if(activeQueue.length>policy.max_queue)throw new Error(`resource_queue_limit_exceeded:${activeQueue.length}:${policy.max_queue}`);const completed=deliveries.filter(x=>x.status==="delivered").sort((a,b)=>b.updated_at.localeCompare(a.updated_at));const removedDeliveries=completed.slice(policy.max_queue);if(removedDeliveries.length)await this.db.deleteFrom("gateway_deliveries").where("id","in",removedDeliveries.map(x=>x.id)).execute();const expiredLocks=await this.reclaimExpiredGatewayConcurrencyLocks(now);const activeLocks=await this.listGatewayConcurrencyLocks({status:"acquired",limit:10000});if(activeLocks.length>policy.max_concurrency)throw new Error(`resource_concurrency_limit_exceeded:${activeLocks.length}:${policy.max_concurrency}`);const runs=await this.listBackendRuns();let removedEvents=0;for(const run of runs){const events=await this.listBackendEvents({runId:run.id});const remove=events.slice(0,Math.max(0,events.length-policy.max_events_per_run));if(remove.length){await this.db.deleteFrom("backend_events").where("id","in",remove.map(x=>x.id)).execute();removedEvents+=remove.length}}const backups=await this.listWorkspaceBackups();const removedBackups=backups.slice(policy.max_backups);for(const backup of removedBackups)await rm(path.join(this.rootDir,backup.path),{recursive:true,force:true});const snapshotResult=await this.pruneLearningSnapshots(policy.max_snapshots);const indexResult=await this.reindexSessionSearch();const fileBytes=await directoryByteSize(this.rootDir,["backups"]);if(fileBytes>policy.max_file_bytes)throw new Error(`resource_file_limit_exceeded:${fileBytes}:${policy.max_file_bytes}`);return{checked_at:now,limits:policy,queue:{active:activeQueue.length,removed_completed:removedDeliveries.length},concurrency:{active:activeLocks.length,reclaimed:expiredLocks.length},context:{max_tokens:policy.max_context_tokens},files:{bytes:fileBytes,max_bytes:policy.max_file_bytes},events:{removed:removedEvents,max_per_run:policy.max_events_per_run},backups:{retained:Math.min(backups.length,policy.max_backups),removed:removedBackups.map(x=>x.id)},snapshots:snapshotResult,index:{rebuilt:true,...indexResult}}}

  async exportWorkspaceBundle(destinationRoot: string): Promise<{ path: string; backup: WorkspaceBackupRecord }> {
    const backup = await this.createWorkspaceBackup();
    const destination = path.join(path.resolve(destinationRoot), `samurai-workspace-${backup.id}`);
    if (await pathExists(destination)) throw new Error("workspace_export_destination_exists");
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(this.rootDir, backup.path), destination, { recursive: true, force: false, errorOnExist: true });
    return { path: destination, backup };
  }

  async importWorkspaceBundle(bundlePath: string): Promise<WorkspaceRestoreResult> {
    const source = path.resolve(bundlePath);
    const manifest = parseWorkspaceBackupManifest(JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")));
    const destination = path.join(this.rootDir, "backups", manifest.id);
    if (await pathExists(destination)) throw new Error("workspace_import_backup_exists");
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    try {
      return await this.restoreWorkspaceBackup(manifest.id);
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async restoreWorkspaceBackup(backupId: string): Promise<WorkspaceRestoreResult> {
    const safeId = normalizeBackupId(backupId);
    const backupPath = path.join(this.rootDir, "backups", safeId);
    const manifest = parseWorkspaceBackupManifest(JSON.parse(await readFile(path.join(backupPath, "manifest.json"), "utf8")));
    const backupDbPath = path.join(backupPath, manifest.db_file);
    const preRestoreHealth = await this.inspectWorkspace();
    const restoredPaths: string[] = [];
    const restoreId = `${safeId}-${randomUUID().slice(0, 8)}`;
    const stagedRoot = path.join(this.rootDir, `.restore-stage-${restoreId}`);
    const rollbackRoot = path.join(this.rootDir, `.restore-rollback-${restoreId}`);
    await mkdir(path.join(stagedRoot, "files"), { recursive: true });
    try {
      await copyFile(backupDbPath, path.join(stagedRoot, "workspace.sqlite"));
      for (const rootName of manifest.file_roots) {
        const source = path.join(backupPath, "files", rootName);
        if (!await pathExists(source)) {
          continue;
        }
        await cp(source, path.join(stagedRoot, "files", rootName), { recursive: true, force: true });
      }
      this.restoreFailureInjector?.("extract");

      const stagedHashes = await hashFilesUnderRoot(stagedRoot);
      if (Object.keys(manifest.file_hashes).length === 0 || JSON.stringify(stagedHashes) !== JSON.stringify(manifest.file_hashes)) {
        throw new Error("workspace_backup_hash_mismatch");
      }
      const stagedDatabase = new Database(path.join(stagedRoot, "workspace.sqlite"), { readonly: true });
      const integrity = stagedDatabase.pragma("integrity_check", { simple: true });
      stagedDatabase.close();
      if (integrity !== "ok") throw new Error(`workspace_backup_integrity_failed:${String(integrity)}`);
      this.restoreFailureInjector?.("hash_verify");

      await sql`PRAGMA wal_checkpoint(FULL)`.execute(this.db).catch(() => undefined);
      await this.db.destroy();
      await mkdir(rollbackRoot, { recursive: true });
      let swapped = false;
      try {
        if (await pathExists(this.dbPath)) await rename(this.dbPath, path.join(rollbackRoot, "workspace.sqlite"));
        for (const rootName of workspaceBackupRoots()) {
          const current = path.join(this.rootDir, rootName);
          if (await pathExists(current)) await rename(current, path.join(rollbackRoot, rootName));
        }
        this.restoreFailureInjector?.("swap");
        await rename(path.join(stagedRoot, "workspace.sqlite"), this.dbPath);
        for (const rootName of manifest.file_roots) {
          const source = path.join(stagedRoot, "files", rootName);
          if (!await pathExists(source)) continue;
          await rename(source, path.join(this.rootDir, rootName));
          restoredPaths.push(rootName);
        }
        swapped = true;
      } catch (error) {
        await rm(this.dbPath, { force: true });
        for (const rootName of workspaceBackupRoots()) await rm(path.join(this.rootDir, rootName), { recursive: true, force: true });
        if (await pathExists(path.join(rollbackRoot, "workspace.sqlite"))) await rename(path.join(rollbackRoot, "workspace.sqlite"), this.dbPath);
        for (const rootName of workspaceBackupRoots()) {
          const original = path.join(rollbackRoot, rootName);
          if (await pathExists(original)) await rename(original, path.join(this.rootDir, rootName));
        }
        throw error;
      } finally {
        this.reopenDatabase();
      }
      if (!swapped) throw new Error("workspace_restore_swap_incomplete");
      await ensureWorkspaceLayout(this.rootDir);
      await this.migrate();
      await this.recoverWorkspaceFileTransactions();
      await this.ensureDefaultSettings();
      await rm(rollbackRoot, { recursive: true, force: true });
    } finally {
      await rm(stagedRoot, { recursive: true, force: true });
    }

    const health = await this.inspectWorkspace();
    const integrity = await this.checkIntegrity();
    return {
      backup_id: safeId,
      restored_at: nowIso(),
      restored_paths: restoredPaths,
      db_restored: true,
      manifest,
      pre_restore_health: preRestoreHealth,
      integrity,
      health
    };
  }

  private async writeWikiPage(frontmatter: WikiFrontmatter, filePath: string, content: string): Promise<void> {
    const absolutePath = path.join(this.rootDir, filePath);
    await writeFile(absolutePath, `${renderFrontmatter(frontmatter)}\n${content.trim()}\n`);
    await this.db
      .updateTable("wiki_index")
      .set(wikiToRow(frontmatter, filePath))
      .where("id", "=", frontmatter.id)
      .execute();
  }

  private async recordMigrationJournal(name: string, status: MigrationJournalRecord["status"], details: Record<string, JsonValue>): Promise<void> {
    await this.db
      .insertInto("migration_journal")
      .values({
        id: createId("migration"),
        name,
        status,
        details_json: stringify(details),
        created_at: nowIso()
      })
      .execute();
  }

  async saveCollectionSchema(schemaInput: CollectionSchema): Promise<CollectionSchemaWithFilePath> {
    const relativePath = path.join("collections", schemaInput.id, "schema.json");
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(schemaInput, null, 2)}\n`, { flag: "wx" });

    try {
      const schema = parseCollectionSchemaLocal(JSON.parse(await readFile(absolutePath, "utf8")));
      const now = nowIso();
      await this.db
        .insertInto("collection_schemas")
        .values({
          id: schema.id,
          version: schema.version,
          file_path: relativePath,
          schema_json: stringify(schema),
          updated_at: now
        })
        .execute();
      return { ...schema, file_path: relativePath };
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  }

  async getCollectionSchema(collectionId: string): Promise<CollectionSchemaWithFilePath | undefined> {
    const row = await this.db.selectFrom("collection_schemas").selectAll().where("id", "=", collectionId).executeTakeFirst();
    return row ? collectionSchemaFromRow(row) : undefined;
  }

  async listCollectionSchemas(): Promise<CollectionSchemaWithFilePath[]> {
    const rows = await this.db.selectFrom("collection_schemas").selectAll().orderBy("id").execute();
    return rows.map(collectionSchemaFromRow);
  }

  async updateCollectionSchema(schemaInput: CollectionSchema): Promise<CollectionSchemaWithFilePath> {
    const existing = await this.getCollectionSchema(schemaInput.id);
    const relativePath = existing?.file_path ?? path.join("collections", schemaInput.id, "schema.json");
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const schema = parseCollectionSchemaLocal(schemaInput);
    await writeFile(absolutePath, `${JSON.stringify(schema, null, 2)}\n`);
    await this.db
      .insertInto("collection_schemas")
      .values({
        id: schema.id,
        version: schema.version,
        file_path: relativePath,
        schema_json: stringify(schema),
        updated_at: nowIso()
      })
      .onConflict((oc) => oc.column("id").doUpdateSet({
        version: schema.version,
        file_path: relativePath,
        schema_json: stringify(schema),
        updated_at: nowIso()
      }))
      .execute();
    return { ...schema, file_path: relativePath };
  }

  async saveCollectionRecord(recordInput: CollectionRecord): Promise<CollectionRecordWithFilePath> {
    const schema = await this.getCollectionSchema(recordInput.collection_id);
    if (!schema) {
      throw new Error("collection_schema_not_found");
    }
    const record = parseCollectionRecordLocal(recordInput, schema);
    await this.validateCollectionRecordLinks(record, schema);
    const relativePath = path.join("collections", recordInput.collection_id, "records", `${recordInput.id}.json`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });

    try {
      await this.db
        .insertInto("collection_records")
        .values({
          id: record.id,
          collection_id: record.collection_id,
          file_path: relativePath,
          record_json: stringify(record),
          version: record.version,
          created_at: record.created_at,
          updated_at: record.updated_at
        })
        .execute();
      return { ...record, file_path: relativePath };
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  }

  async upsertCollectionRecord(recordInput: CollectionRecord): Promise<CollectionRecordWithFilePath> {
    const schema = await this.getCollectionSchema(recordInput.collection_id);
    if (!schema) {
      throw new Error("collection_schema_not_found");
    }
    const existing = await this.getCollectionRecord(recordInput.collection_id, recordInput.id);
    const record = parseCollectionRecordLocal({
      ...recordInput,
      created_at: existing?.created_at ?? recordInput.created_at
    }, schema);
    await this.validateCollectionRecordLinks(record, schema);
    const relativePath = existing?.file_path ?? path.join("collections", recordInput.collection_id, "records", `${recordInput.id}.json`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(record, null, 2)}\n`);
    await this.db
      .insertInto("collection_records")
      .values({
        id: record.id,
        collection_id: record.collection_id,
        file_path: relativePath,
        record_json: stringify(record),
        version: record.version,
        created_at: record.created_at,
        updated_at: record.updated_at
      })
      .onConflict((oc) => oc.columns(["collection_id", "id"]).doUpdateSet({
        file_path: relativePath,
        record_json: stringify(record),
        version: record.version,
        updated_at: record.updated_at
      }))
      .execute();
    return { ...record, file_path: relativePath };
  }

  async deleteCollectionRecord(collectionId: string, recordId: string): Promise<CollectionRecordWithFilePath> {
    const existing = await this.getCollectionRecord(collectionId, recordId);
    if (!existing) {
      throw new Error("collection_record_not_found");
    }
    await rm(path.join(this.rootDir, existing.file_path), { force: true });
    await this.db
      .deleteFrom("collection_records")
      .where("collection_id", "=", collectionId)
      .where("id", "=", recordId)
      .execute();
    return existing;
  }

  async getCollectionRecord(collectionId: string, recordId: string): Promise<CollectionRecordWithFilePath | undefined> {
    const row = await this.db
      .selectFrom("collection_records")
      .selectAll()
      .where("collection_id", "=", collectionId)
      .where("id", "=", recordId)
      .executeTakeFirst();
    return row ? collectionRecordFromRow(row) : undefined;
  }

  async listCollectionRecords(collectionId?: string): Promise<CollectionRecordWithFilePath[]> {
    let query = this.db.selectFrom("collection_records").selectAll();
    if (collectionId) {
      query = query.where("collection_id", "=", collectionId);
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(collectionRecordFromRow);
  }

  async listCollectionPatches(input: { collectionId?: string; recordId?: string } = {}): Promise<CollectionPatch[]> {
    let query = this.db.selectFrom("collection_patches").selectAll();
    if (input.collectionId) {
      query = query.where("collection_id", "=", input.collectionId);
    }
    if (input.recordId) {
      query = query.where("record_id", "=", input.recordId);
    }
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map(collectionPatchFromRow);
  }

  async getCollectionPatch(collectionId: string, recordId: string, patchId: string): Promise<CollectionPatch | undefined> {
    const row = await this.db
      .selectFrom("collection_patches")
      .selectAll()
      .where("collection_id", "=", collectionId)
      .where("record_id", "=", recordId)
      .where("id", "=", patchId)
      .executeTakeFirst();
    return row ? collectionPatchFromRow(row) : undefined;
  }

  async resolveCollectionRecordRefs(collectionId: string, recordId: string): Promise<CollectionRecordResolution> {
    const [schema, record] = await Promise.all([
      this.getCollectionSchema(collectionId),
      this.getCollectionRecord(collectionId, recordId)
    ]);
    if (!schema) {
      throw new Error("collection_schema_not_found");
    }
    if (!record) {
      throw new Error("collection_record_not_found");
    }

    const resolvedRefs: CollectionResolvedRef[] = [];
    const missingRefs: CollectionMissingRef[] = [];
    const embedFields: CollectionResolvedEmbed[] = [];

    for (const ref of schema.refs) {
      const field = collectionDefinitionField(ref);
      if (!field) {
        continue;
      }
      const refId = collectionFieldId(ref) ?? field;
      const targetCollection = collectionDefinitionString(ref, "collection_id")
        ?? collectionDefinitionString(ref, "target_collection_id")
        ?? record.collection_id;
      const value = record.data[field];
      if (value === undefined || value === null || value === "") {
        missingRefs.push({
          ref_id: refId,
          field,
          target_collection_id: targetCollection,
          reason: "empty"
        });
        continue;
      }
      const targetId = collectionRefTargetId(value);
      if (!targetId) {
        missingRefs.push({
          ref_id: refId,
          field,
          target_collection_id: targetCollection,
          reason: "invalid"
        });
        continue;
      }
      const target = await this.getCollectionRecord(targetCollection, targetId);
      if (!target) {
        missingRefs.push({
          ref_id: refId,
          field,
          target_collection_id: targetCollection,
          target_record_id: targetId,
          reason: "not_found"
        });
        continue;
      }
      resolvedRefs.push({
        ref_id: refId,
        field,
        target_collection_id: targetCollection,
        target_record_id: target.id,
        record: target,
        resource_ref: collectionRecordRefLocal(target)
      });
    }

    for (const embed of schema.embeds) {
      const field = collectionDefinitionField(embed);
      if (!field || !(field in record.data)) {
        continue;
      }
      embedFields.push({
        embed_id: collectionFieldId(embed) ?? field,
        field,
        value: record.data[field] ?? null
      });
    }

    return {
      collection_id: record.collection_id,
      record_id: record.id,
      resolved_refs: resolvedRefs,
      missing_refs: missingRefs,
      embed_fields: embedFields
    };
  }

  async evaluateCollectionTriggers(input: {
    collectionId: string;
    recordId: string;
    event: CollectionTriggerEffect["event"];
  }): Promise<CollectionTriggerEffect[]> {
    const [schema, record] = await Promise.all([
      this.getCollectionSchema(input.collectionId),
      this.getCollectionRecord(input.collectionId, input.recordId)
    ]);
    if (!schema) {
      throw new Error("collection_schema_not_found");
    }
    if (!record) {
      throw new Error("collection_record_not_found");
    }
    return schema.triggers.map((trigger, index) => collectionTriggerEffect(trigger, index, input.event, collectionRecordRefLocal(record)));
  }

  async listCollectionTriggerStates(collectionId?: string): Promise<CollectionTriggerState[]> {
    const schema = collectionId ? await this.getCollectionSchema(collectionId) : undefined;
    const schemas = collectionId ? (schema ? [schema] : []) : await this.listCollectionSchemas();
    const jobs = await this.listAutomationJobs();
    const states: CollectionTriggerState[] = [];

    for (const schema of schemas) {
      schema.triggers.forEach((trigger, index) => {
        const triggerId = collectionDefinitionString(trigger, "id") ?? `trigger_${index + 1}`;
        const actionId = collectionDefinitionString(trigger, "action_id")
          ?? collectionDefinitionString(trigger, "action")
          ?? collectionDefinitionString(trigger, "name")
          ?? triggerId;
        const actionKind = collectionDefinitionString(trigger, "kind") ?? collectionDefinitionString(trigger, "type") ?? "custom_instruction";
        const event = collectionDefinitionString(trigger, "event") ?? collectionDefinitionString(trigger, "on") ?? "any";
        const enabled = trigger.enabled !== false;
        const actionExists = collectionSchemaHasAction(schema, actionId);
        const triggerJobs = jobs
          .filter((job) => collectionDefinitionString(job.delivery_target, "channel") === "collection_trigger")
          .filter((job) => collectionDefinitionString(job.delivery_target, "collection_id") === schema.id)
          .filter((job) => collectionDefinitionString(job.delivery_target, "trigger_id") === triggerId)
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
        const lastJob = triggerJobs[0];
        const pendingJobCount = triggerJobs.filter((job) => job.status === "enabled").length;
        states.push({
          collection_id: schema.id,
          trigger_id: triggerId,
          event,
          action_id: actionId,
          action_kind: actionKind,
          enabled,
          action_exists: actionExists,
          status: collectionTriggerStateStatus({ enabled, actionExists, pendingJobCount, lastJob }),
          pending_job_count: pendingJobCount,
          job_count: triggerJobs.length,
          last_job: lastJob ? collectionTriggerJobSummary(lastJob) : undefined,
          definition: trigger
        });
      });
    }

    return states;
  }

  private async validateCollectionRecordLinks(record: CollectionRecord, schema: CollectionSchema): Promise<void> {
    for (const ref of schema.refs) {
      const field = collectionDefinitionField(ref);
      if (!field) {
        continue;
      }
      const value = record.data[field];
      if (value === undefined || value === null || value === "") {
        if (collectionDefinitionBoolean(ref, "required")) {
          throw new Error(`collection_ref_required:${field}`);
        }
        continue;
      }
      const targetCollection = collectionDefinitionString(ref, "collection_id")
        ?? collectionDefinitionString(ref, "target_collection_id")
        ?? record.collection_id;
      const targetId = collectionRefTargetId(value);
      if (!targetId) {
        throw new Error(`collection_ref_invalid:${field}`);
      }
      const target = await this.getCollectionRecord(targetCollection, targetId);
      if (!target) {
        throw new Error(`collection_ref_not_found:${field}:${targetCollection}/${targetId}`);
      }
    }
    for (const embed of schema.embeds) {
      const field = collectionDefinitionField(embed);
      if (!field) {
        continue;
      }
      const value = record.data[field];
      if ((value === undefined || value === null) && collectionDefinitionBoolean(embed, "required")) {
        throw new Error(`collection_embed_required:${field}`);
      }
      if (value !== undefined && value !== null && typeof value !== "object") {
        throw new Error(`collection_embed_invalid:${field}`);
      }
    }
  }

  async reindexCollections(): Promise<CollectionReindexResult> {
    const [existingSchemaRows, existingRecordRows] = await Promise.all([
      this.db.selectFrom("collection_schemas").selectAll().execute(),
      this.db.selectFrom("collection_records").selectAll().execute()
    ]);
    const existingSchemaIds = new Set(existingSchemaRows.map((row) => row.id));
    const existingRecordKeys = new Set(existingRecordRows.map((row) => `${row.collection_id}/${row.id}`));
    const schemaFiles = await listCollectionSchemaFiles(this.rootDir);
    const recordFiles = await listCollectionRecordFiles(this.rootDir);
    const schemasById = new Map<string, CollectionSchema>();
    const seenSchemaIds = new Set<string>();
    const seenRecordKeys = new Set<string>();
    const schemaErrors: CollectionReindexResult["schemas"]["errors"] = [];
    const recordErrors: CollectionReindexResult["records"]["errors"] = [];
    let schemasCreated = 0;
    let schemasUpdated = 0;
    let schemasSkipped = 0;
    let recordsCreated = 0;
    let recordsUpdated = 0;
    let recordsSkipped = 0;

    for (const filePath of schemaFiles) {
      try {
        const schema = parseCollectionSchemaLocal(JSON.parse(await readFile(path.join(this.rootDir, filePath), "utf8")));
        if (seenSchemaIds.has(schema.id)) {
          schemasSkipped += 1;
          schemaErrors.push({ file_path: filePath, message: `duplicate collection schema id: ${schema.id}` });
          continue;
        }
        seenSchemaIds.add(schema.id);
        schemasById.set(schema.id, schema);
        const row = {
          id: schema.id,
          version: schema.version,
          file_path: filePath,
          schema_json: stringify(schema),
          updated_at: nowIso()
        };
        await this.db
          .insertInto("collection_schemas")
          .values(row)
          .onConflict((oc) => oc.column("id").doUpdateSet(row))
          .execute();
        if (existingSchemaIds.has(schema.id)) {
          schemasUpdated += 1;
        } else {
          schemasCreated += 1;
        }
      } catch (error) {
        schemasSkipped += 1;
        schemaErrors.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    let schemasRemoved = 0;
    for (const row of existingSchemaRows) {
      if (seenSchemaIds.has(row.id)) {
        continue;
      }
      await this.db.deleteFrom("collection_schemas").where("id", "=", row.id).execute();
      schemasRemoved += 1;
    }

    for (const filePath of recordFiles) {
      try {
        const raw = JSON.parse(await readFile(path.join(this.rootDir, filePath), "utf8")) as Record<string, unknown>;
        const collectionId = typeof raw.collection_id === "string" ? raw.collection_id : "";
        const schema = schemasById.get(collectionId);
        if (!schema) {
          throw new Error("collection_schema_not_found");
        }
        const record = parseCollectionRecordLocal(raw, schema);
        const key = `${record.collection_id}/${record.id}`;
        if (seenRecordKeys.has(key)) {
          recordsSkipped += 1;
          recordErrors.push({ file_path: filePath, message: `duplicate collection record id: ${key}` });
          continue;
        }
        seenRecordKeys.add(key);
        const row = {
          id: record.id,
          collection_id: record.collection_id,
          file_path: filePath,
          record_json: stringify(record),
          version: record.version,
          created_at: record.created_at,
          updated_at: record.updated_at
        };
        await this.db
          .insertInto("collection_records")
          .values(row)
          .onConflict((oc) => oc.columns(["collection_id", "id"]).doUpdateSet(row))
          .execute();
        if (existingRecordKeys.has(key)) {
          recordsUpdated += 1;
        } else {
          recordsCreated += 1;
        }
      } catch (error) {
        recordsSkipped += 1;
        recordErrors.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    let recordsRemoved = 0;
    for (const row of existingRecordRows) {
      if (seenRecordKeys.has(`${row.collection_id}/${row.id}`)) {
        continue;
      }
      await this.db
        .deleteFrom("collection_records")
        .where("collection_id", "=", row.collection_id)
        .where("id", "=", row.id)
        .execute();
      recordsRemoved += 1;
    }

    const [schemaCountRow, recordCountRow] = await Promise.all([
      this.db.selectFrom("collection_schemas").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      this.db.selectFrom("collection_records").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);

    return {
      schemas: {
        files: schemaFiles.length,
        indexed: Number(schemaCountRow.count),
        created: schemasCreated,
        updated: schemasUpdated,
        removed: schemasRemoved,
        skipped: schemasSkipped,
        errors: schemaErrors
      },
      records: {
        files: recordFiles.length,
        indexed: Number(recordCountRow.count),
        created: recordsCreated,
        updated: recordsUpdated,
        removed: recordsRemoved,
        skipped: recordsSkipped,
        errors: recordErrors
      }
    };
  }

  async recoverWorkspaceFileTransactions(): Promise<{ completed: number; rolled_back: number }> {
    const rows = await this.db.selectFrom("workspace_file_transactions").selectAll().where("status", "!=", "completed").orderBy("created_at", "asc").execute();
    let completed = 0;
    let rolledBack = 0;
    for (const row of rows) {
      const targetPath = path.join(this.rootDir, row.target_path);
      const stagedPath = path.join(this.rootDir, row.staged_path);
      const target = await readFile(targetPath, "utf8").then((value) => JSON.parse(value) as CollectionRecord).catch(() => undefined);
      const after = parse<CollectionRecord>(row.after_json);
      const action = workspaceFileRecoveryAction({ status: row.status, stagedExists: await pathExists(stagedPath), targetVersion: target?.version, afterVersion: after.version });
      if (action === "finalize_staged") { await rename(stagedPath, targetPath); completed += 1; }
      else if (action === "accept_target") completed += 1;
      else if (action === "rollback_database" && row.collection_id && row.record_id) {
        const before = parse<CollectionRecord>(row.before_json);
        await this.db.updateTable("collection_records").set({ record_json: stringify(before), version: typeof before.version === "number" ? before.version : 1, updated_at: before.updated_at }).where("collection_id", "=", row.collection_id).where("id", "=", row.record_id).execute();
        if (row.patch_id) await this.db.deleteFrom("collection_patches").where("collection_id", "=", row.collection_id).where("record_id", "=", row.record_id).where("id", "=", row.patch_id).execute();
        rolledBack += 1;
      } else if (action === "discard_staged") {
        await rm(stagedPath, { force: true });
        rolledBack += 1;
      }
      await this.db.deleteFrom("workspace_file_transactions").where("id", "=", row.id).execute();
    }
    return { completed, rolled_back: rolledBack };
  }

  async countPendingWorkspaceFileTransactions(): Promise<number> {
    const row = await this.db.selectFrom("workspace_file_transactions").select(({ fn }) => fn.countAll<number>().as("count")).where("status", "!=", "completed").executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async applyCollectionRecordPatch(input: { collectionId: string; recordId: string; patch: CollectionPatch }): Promise<{
    before: CollectionRecordWithFilePath;
    after: CollectionRecordWithFilePath;
  }> {
    const [schema, before] = await Promise.all([
      this.getCollectionSchema(input.collectionId),
      this.getCollectionRecord(input.collectionId, input.recordId)
    ]);
    if (!schema) {
      throw new Error("collection_schema_not_found");
    }
    if (!before) {
      throw new Error("collection_record_not_found");
    }
    if (input.patch.expected_version !== undefined && input.patch.expected_version !== before.version) {
      throw new CollectionRecordVersionConflictError(input.patch.expected_version, before);
    }
    const after = applyCollectionPatchLocal(before, input.patch, schema);
    await this.validateCollectionRecordLinks(after, schema);
    const absolutePath = path.join(this.rootDir, before.file_path);
    const stagedPath = `${absolutePath}.pending-${input.patch.id}`;
    const stagedRelativePath = `${before.file_path}.pending-${input.patch.id}`;
    const transactionId = createId("file_transaction");
    const transactionNow = nowIso();
    await this.db.insertInto("workspace_file_transactions").values({
      id: transactionId,
      kind: "collection_record_patch",
      status: "planned",
      target_path: before.file_path,
      staged_path: stagedRelativePath,
      collection_id: input.collectionId,
      record_id: input.recordId,
      patch_id: input.patch.id,
      before_json: stringify(before),
      after_json: stringify(after),
      created_at: transactionNow,
      updated_at: transactionNow
    }).execute();
    let simulatedCrash = false;
    try {
      this.fileTransactionFailureInjector?.("planned");
      await writeFile(stagedPath, `${JSON.stringify(after, null, 2)}\n`, { flag: "wx" });
      await this.db.updateTable("workspace_file_transactions").set({ status: "staged", updated_at: nowIso() }).where("id", "=", transactionId).execute();
      this.fileTransactionFailureInjector?.("staged");
      const updated = await this.db.transaction().execute(async (transaction) => {
        const result = await transaction
          .updateTable("collection_records")
          .set({ record_json: stringify(after), version: after.version, updated_at: after.updated_at })
          .where("collection_id", "=", input.collectionId)
          .where("id", "=", input.recordId)
          .where("version", "=", before.version)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) {
          return false;
        }
        await transaction
          .insertInto("collection_patches")
          .values(collectionPatchToRow(input.collectionId, input.patch))
          .onConflict((oc) => oc.columns(["collection_id", "record_id", "id"]).doNothing())
          .execute();
        await transaction.updateTable("workspace_file_transactions").set({ status: "db_committed", updated_at: nowIso() }).where("id", "=", transactionId).execute();
        return true;
      });
      if (!updated) {
        const latest = await this.getCollectionRecord(input.collectionId, input.recordId);
        throw new CollectionRecordVersionConflictError(input.patch.expected_version ?? before.version, latest ?? before);
      }
      this.fileTransactionFailureInjector?.("db_committed");
      try {
        await rename(stagedPath, absolutePath);
        this.fileTransactionFailureInjector?.("renamed");
        await this.db.deleteFrom("workspace_file_transactions").where("id", "=", transactionId).execute();
      } catch (error) {
        if (error instanceof WorkspaceSimulatedCrashError) {
          simulatedCrash = true;
          throw error;
        }
        await this.db.transaction().execute(async (transaction) => {
          await transaction.updateTable("collection_records")
            .set({ record_json: stringify(before), version: before.version, updated_at: before.updated_at })
            .where("collection_id", "=", input.collectionId)
            .where("id", "=", input.recordId)
            .where("version", "=", after.version)
            .execute();
          await transaction.deleteFrom("collection_patches")
            .where("collection_id", "=", input.collectionId)
            .where("record_id", "=", input.recordId)
            .where("id", "=", input.patch.id)
            .execute();
          await transaction.deleteFrom("workspace_file_transactions").where("id", "=", transactionId).execute();
        });
        throw error;
      }
    } catch (error) {
      if (error instanceof WorkspaceSimulatedCrashError) {
        simulatedCrash = true;
        throw error;
      }
      await this.db.deleteFrom("workspace_file_transactions").where("id", "=", transactionId).execute();
      throw error;
    } finally {
      if (!simulatedCrash) await rm(stagedPath, { force: true });
    }
    return { before, after: { ...after, file_path: before.file_path } };
  }

  async listCollectionNotes(collectionId: string): Promise<CollectionNote[]> {
    const notesDir = path.join(this.rootDir, "collections", collectionId, "notes");
    let entries: string[];
    try {
      entries = await readdir(notesDir);
    } catch {
      return [];
    }
    const notes: CollectionNote[] = [];
    for (const entry of entries.filter((item) => item.endsWith(".md")).sort()) {
      const relativePath = path.join("collections", collectionId, "notes", entry);
      notes.push({
        collection_id: collectionId,
        file_path: relativePath,
        content: await readFile(path.join(this.rootDir, relativePath), "utf8"),
        role: "context_only"
      });
    }
    return notes;
  }

  async saveAutomationJob(job: AutomationJobRecord): Promise<AutomationJobRecord> {
    await this.db
      .insertInto("automation_jobs")
      .values(automationJobToRow(job))
      .onConflict((oc) => oc.column("id").doUpdateSet(automationJobToRow(job)))
      .execute();
    return job;
  }

  async getAutomationJob(id: string): Promise<AutomationJobRecord | undefined> {
    const row = await this.db.selectFrom("automation_jobs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? automationJobFromRow(row) : undefined;
  }

  async listAutomationJobs(input: { dueAt?: string; enabledOnly?: boolean } = {}): Promise<AutomationJobRecord[]> {
    let query = this.db.selectFrom("automation_jobs").selectAll();
    if (input.enabledOnly) {
      query = query.where("status", "=", "enabled");
    }
    const dueAt = input.dueAt;
    if (dueAt) {
      query = query
        .where((eb) => eb.or([
          eb("next_run_at", "is", null),
          eb("next_run_at", "<=", dueAt)
        ]))
        .where((eb) => eb.or([
          eb("retry_after_at", "is", null),
          eb("retry_after_at", "<=", dueAt)
        ]))
        .where((eb) => eb.or([
          eb("locked_until", "is", null),
          eb("locked_until", "<=", dueAt)
        ]))
        .whereRef("failure_count", "<", "max_attempts");
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(automationJobFromRow);
  }

  async acquireAutomationJobLock(jobId: string, input: { lockedUntil: string; now?: string }): Promise<AutomationJobRecord | undefined> {
    const now = input.now ?? nowIso();
    const updated = await this.db.updateTable("automation_jobs")
      .set({ locked_until: input.lockedUntil, updated_at: now })
      .where("id","=",jobId).where("status","=","enabled")
      .where((eb)=>eb.or([eb("locked_until","is",null),eb("locked_until","<=",now)]))
      .where((eb)=>eb.or([eb("next_run_at","is",null),eb("next_run_at","<=",now)]))
      .where((eb)=>eb.or([eb("retry_after_at","is",null),eb("retry_after_at","<=",now)]))
      .whereRef("failure_count","<","max_attempts").executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? this.getAutomationJob(jobId) : undefined;
  }

  async heartbeatAutomationJobLock(jobId:string,input:{expectedLockedUntil:string;lockedUntil:string;now?:string}):Promise<AutomationJobRecord|undefined>{const now=input.now??nowIso();const updated=await this.db.updateTable("automation_jobs").set({locked_until:input.lockedUntil,updated_at:now}).where("id","=",jobId).where("locked_until","=",input.expectedLockedUntil).where("locked_until",">",now).executeTakeFirst();return Number(updated.numUpdatedRows)===1?this.getAutomationJob(jobId):undefined}

  async releaseAutomationJobLock(jobId: string, now = nowIso()): Promise<AutomationJobRecord | undefined> {
    const job = await this.getAutomationJob(jobId);
    if (!job) {
      return undefined;
    }
    const released = { ...job, locked_until: undefined, updated_at: now };
    await this.saveAutomationJob(released);
    return released;
  }

  async requeueAutomationJob(jobId: string, input: { nextRunAt?: string; now?: string } = {}): Promise<AutomationJobRecord | undefined> {
    const now = input.now ?? nowIso();
    const job = await this.getAutomationJob(jobId);
    if (!job) {
      return undefined;
    }
    const requeued: AutomationJobRecord = {
      ...job,
      status: "enabled",
      next_run_at: input.nextRunAt ?? now,
      retry_after_at: undefined,
      locked_until: undefined,
      failure_count: 0,
      last_error: undefined,
      updated_at: now
    };
    await this.saveAutomationJob(requeued);
    return requeued;
  }

  async getAutomationQueueSummary(now = nowIso()): Promise<AutomationQueueSummary> {
    const jobs = await this.listAutomationJobs();
    const enabled = jobs.filter((job) => job.status === "enabled");
    const dueJobs = enabled.filter((job) => isAutomationJobDue(job, now));
    const lockedJobs = jobs.filter((job) => job.locked_until && job.locked_until > now);
    const retryDueJobs = enabled.filter((job) => job.retry_after_at && job.retry_after_at <= now);
    const retryPendingJobs = enabled.filter((job) => job.retry_after_at && job.retry_after_at > now);
    const exhaustedJobs = jobs.filter((job) => (job.failure_count ?? 0) >= (job.max_attempts ?? 3));
    const nextDueAt = enabled
      .flatMap((job) => [job.next_run_at, job.retry_after_at].filter((value): value is string => Boolean(value)))
      .sort()[0];
    const oldestLockedUntil = lockedJobs.map((job) => job.locked_until).filter((value): value is string => Boolean(value)).sort()[0];
    return {
      now,
      total: jobs.length,
      due: dueJobs.length,
      locked: lockedJobs.length,
      retry_due: retryDueJobs.length,
      retry_pending: retryPendingJobs.length,
      exhausted: exhaustedJobs.length,
      by_status: countAutomationJobs(jobs, "status"),
      by_kind: countAutomationJobs(jobs, "kind"),
      next_due_at: nextDueAt,
      oldest_locked_until: oldestLockedUntil
    };
  }

  async saveExternalSend(send: ExternalSendRecord): Promise<ExternalSendRecord> {
    await this.db
      .insertInto("external_sends")
      .values(externalSendToRow(send))
      .onConflict((oc) => oc.column("id").doUpdateSet(externalSendToRow(send)))
      .execute();
    return send;
  }

  async getExternalSend(id: string): Promise<ExternalSendRecord | undefined> {
    const row = await this.db.selectFrom("external_sends").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? externalSendFromRow(row) : undefined;
  }

  async listExternalSends(): Promise<ExternalSendRecord[]> {
    const rows = await this.db.selectFrom("external_sends").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(externalSendFromRow);
  }

  async saveGatewayPairingPolicy(policy: GatewayPairingPolicyRecord): Promise<GatewayPairingPolicyRecord> {
    const parsed = GatewayPairingPolicyRecordSchema.parse(policy);
    await this.db
      .insertInto("gateway_pairing_policies")
      .values(gatewayPairingPolicyToRow(parsed))
      .onConflict((oc) => oc.column("channel").doUpdateSet(gatewayPairingPolicyToRow(parsed)))
      .execute();
    return parsed;
  }

  async getGatewayPairingPolicy(channel: GatewayPairingPolicyRecord["channel"]): Promise<GatewayPairingPolicyRecord | undefined> {
    const row = await this.db.selectFrom("gateway_pairing_policies").selectAll().where("channel", "=", channel).executeTakeFirst();
    return row ? gatewayPairingPolicyFromRow(row) : undefined;
  }

  async listGatewayPairingPolicies(input: { status?: GatewayPairingPolicyRecord["status"] } = {}): Promise<GatewayPairingPolicyRecord[]> {
    let query = this.db.selectFrom("gateway_pairing_policies").selectAll();
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(gatewayPairingPolicyFromRow);
  }

  async saveGatewayRoutingPolicy(policy: GatewayRoutingPolicyRecord): Promise<GatewayRoutingPolicyRecord> {
    const parsed = GatewayRoutingPolicyRecordSchema.parse(policy);
    await this.db
      .insertInto("gateway_routing_policies")
      .values(gatewayRoutingPolicyToRow(parsed))
      .onConflict((oc) => oc.column("channel").doUpdateSet(gatewayRoutingPolicyToRow(parsed)))
      .execute();
    return parsed;
  }

  async getGatewayRoutingPolicy(channel: GatewayRoutingPolicyRecord["channel"]): Promise<GatewayRoutingPolicyRecord | undefined> {
    const row = await this.db.selectFrom("gateway_routing_policies").selectAll().where("channel", "=", channel).executeTakeFirst();
    return row ? gatewayRoutingPolicyFromRow(row) : undefined;
  }

  async listGatewayRoutingPolicies(input: { status?: GatewayRoutingPolicyRecord["status"] } = {}): Promise<GatewayRoutingPolicyRecord[]> {
    let query = this.db.selectFrom("gateway_routing_policies").selectAll();
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(gatewayRoutingPolicyFromRow);
  }

  async saveGatewayPairing(pairing: GatewayPairingRecord): Promise<GatewayPairingRecord> {
    await this.db
      .insertInto("gateway_pairings")
      .values(gatewayPairingToRow(pairing))
      .onConflict((oc) => oc.column("id").doUpdateSet(gatewayPairingToRow(pairing)))
      .execute();
    return pairing;
  }

  async getGatewayPairing(id: string): Promise<GatewayPairingRecord | undefined> {
    const row = await this.db.selectFrom("gateway_pairings").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? gatewayPairingFromRow(row) : undefined;
  }

  async findGatewayPairing(input: {
    channel: GatewayPairingRecord["channel"];
    sourceIdentity: string;
    status?: GatewayPairingRecord["status"];
    sessionKey?: string;
  }): Promise<GatewayPairingRecord | undefined> {
    let query = this.db
      .selectFrom("gateway_pairings")
      .selectAll()
      .where("channel", "=", input.channel)
      .where("source_identity", "=", input.sourceIdentity);
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    if (input.sessionKey) {
      query = query.where("session_key", "=", input.sessionKey);
    }
    const row = await query.orderBy("updated_at", "desc").executeTakeFirst();
    return row ? gatewayPairingFromRow(row) : undefined;
  }

  async listGatewayPairings(input: GatewayPairingRecord["status"] | {
    status?: GatewayPairingRecord["status"];
    channel?: GatewayPairingRecord["channel"];
    sourceIdentity?: string;
    sessionKey?: string;
    limit?: number;
  } = {}): Promise<GatewayPairingRecord[]> {
    const filters = typeof input === "string" ? { status: input } : input;
    let query = this.db.selectFrom("gateway_pairings").selectAll();
    if (filters.status) {
      query = query.where("status", "=", filters.status);
    }
    if (filters.channel) {
      query = query.where("channel", "=", filters.channel);
    }
    if (filters.sourceIdentity) {
      query = query.where("source_identity", "=", filters.sourceIdentity);
    }
    if (filters.sessionKey) {
      query = query.where("session_key", "=", filters.sessionKey);
    }
    if (filters.limit !== undefined) {
      query = query.limit(filters.limit);
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(gatewayPairingFromRow);
  }

  async expireGatewayPairings(now = nowIso()): Promise<GatewayPairingRecord[]> {
    const pending = await this.listGatewayPairings("pending");
    const expired = pending.filter((pairing) =>
      pairing.expires_at && Date.parse(pairing.expires_at) <= Date.parse(now)
    ).map((pairing) => ({
      ...pairing,
      status: "expired" as const,
      pairing_code: undefined,
      resolved_at: now,
      updated_at: now
    }));
    for (const pairing of expired) {
      await this.saveGatewayPairing(pairing);
    }
    return expired;
  }

  async saveGatewayInboundMessage(message: GatewayInboundMessageRecord): Promise<GatewayInboundMessageRecord> {
    const safeMessage = {
      ...message,
      error: message.error ? redactPrivateData(message.error, { redactPii: true }) : undefined,
      metadata: redactPrivateData(message.metadata, { redactPii: true })
    };
    await this.db
      .insertInto("gateway_inbound_messages")
      .values(gatewayInboundMessageToRow(safeMessage))
      .onConflict((oc) => oc.column("id").doUpdateSet(gatewayInboundMessageToRow(safeMessage)))
      .execute();
    return safeMessage;
  }

  async listGatewayInboundMessages(input: { status?: GatewayInboundMessageRecord["status"]; limit?: number } = {}): Promise<GatewayInboundMessageRecord[]> {
    let query = this.db.selectFrom("gateway_inbound_messages").selectAll();
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    const rows = await query.orderBy("created_at", "desc").limit(input.limit ?? 50).execute();
    return rows.map(gatewayInboundMessageFromRow);
  }

  async enqueueGatewayDelivery(input:GatewayDeliveryRecord):Promise<GatewayDeliveryRecord>{const record=GatewayDeliveryRecordSchema.parse(input);await this.db.insertInto("gateway_deliveries").values(gatewayDeliveryToRow(record)).onConflict(oc=>oc.column("idempotency_key").doNothing()).execute();const saved=await this.db.selectFrom("gateway_deliveries").selectAll().where("idempotency_key","=",record.idempotency_key).executeTakeFirstOrThrow();const existing=gatewayDeliveryFromRow(saved);if(stringify(existing.payload)!==stringify(record.payload)||existing.session_key!==record.session_key||existing.channel!==record.channel)throw new Error("gateway_delivery_idempotency_mismatch");return existing}
  async getGatewayDelivery(id:string):Promise<GatewayDeliveryRecord|undefined>{const row=await this.db.selectFrom("gateway_deliveries").selectAll().where("id","=",id).executeTakeFirst();return row?gatewayDeliveryFromRow(row):undefined}
  async listGatewayDeliveries():Promise<GatewayDeliveryRecord[]>{return(await this.db.selectFrom("gateway_deliveries").selectAll().orderBy("created_at","desc").execute()).map(gatewayDeliveryFromRow)}
  async claimGatewayDelivery(id:string,input:{now:string;leaseUntil:string}):Promise<GatewayDeliveryRecord|undefined>{const updated=await this.db.updateTable("gateway_deliveries").set({status:"delivering",lease_until:input.leaseUntil,attempt:sql`attempt + 1`,updated_at:input.now}).where("id","=",id).whereRef("attempt","<","max_attempts").where(eb=>eb.or([eb("status","=","pending"),eb("status","=","retry_wait")])).where(eb=>eb.or([eb("next_attempt_at","is",null),eb("next_attempt_at","<=",input.now)])).where(eb=>eb.or([eb("lease_until","is",null),eb("lease_until","<=",input.now)])).executeTakeFirst();return Number(updated.numUpdatedRows)===1?this.getGatewayDelivery(id):undefined}
  async completeGatewayDelivery(id:string,input:{now:string;receipt:Record<string,JsonValue>}):Promise<GatewayDeliveryRecord>{await this.db.updateTable("gateway_deliveries").set({status:"delivered",receipt_json:stringify(input.receipt),lease_until:null,next_attempt_at:null,last_error:null,delivered_at:input.now,updated_at:input.now}).where("id","=",id).where("status","=","delivering").execute();const delivery=await this.getGatewayDelivery(id);if(!delivery||delivery.status!=="delivered")throw new Error("gateway_delivery_not_claimed");return delivery}
  async failGatewayDelivery(id:string,input:{now:string;error:string;retryAt?:string}):Promise<GatewayDeliveryRecord>{const current=await this.getGatewayDelivery(id);if(!current||current.status!=="delivering")throw new Error("gateway_delivery_not_claimed");const retry=Boolean(input.retryAt)&&current.attempt<current.max_attempts;await this.db.updateTable("gateway_deliveries").set({status:retry?"retry_wait":"failed",next_attempt_at:retry?input.retryAt!:null,lease_until:null,last_error:input.error,updated_at:input.now}).where("id","=",id).where("status","=","delivering").execute();return(await this.getGatewayDelivery(id))!}
  async reconcileExpiredGatewayDeliveries(now=nowIso()):Promise<GatewayDeliveryRecord[]>{const expired=await this.db.selectFrom("gateway_deliveries").selectAll().where("status","=","delivering").where("lease_until","<=",now).execute();const reconciled:GatewayDeliveryRecord[]=[];for(const row of expired){const terminal=row.attempt>=row.max_attempts;await this.db.updateTable("gateway_deliveries").set({status:terminal?"failed":"retry_wait",next_attempt_at:terminal?null:now,lease_until:null,last_error:terminal?"gateway_delivery_max_attempts_exceeded":"gateway_delivery_lease_expired",updated_at:now}).where("id","=",row.id).where("status","=","delivering").where("lease_until","<=",now).execute();const saved=await this.getGatewayDelivery(row.id);if(saved)reconciled.push(saved)}return reconciled}

  async saveGatewayBoundaryPolicy(policy: GatewayBoundaryPolicy): Promise<GatewayBoundaryPolicy> {
    await this.db
      .insertInto("gateway_boundary_policies")
      .values(gatewayBoundaryPolicyToRow(policy))
      .onConflict((oc) => oc.column("id").doUpdateSet(gatewayBoundaryPolicyToRow(policy)))
      .execute();
    return policy;
  }

  async getGatewayBoundaryPolicy(id: string): Promise<GatewayBoundaryPolicy | undefined> {
    const row = await this.db.selectFrom("gateway_boundary_policies").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? gatewayBoundaryPolicyFromRow(row) : undefined;
  }

  async listGatewayBoundaryPolicies(input: { sourceChannel?: GatewayBoundaryPolicy["source_channel"]; sessionKey?: string } = {}): Promise<GatewayBoundaryPolicy[]> {
    let query = this.db.selectFrom("gateway_boundary_policies").selectAll();
    if (input.sourceChannel) {
      query = query.where("source_channel", "=", input.sourceChannel);
    }
    if (input.sessionKey) {
      query = query.where("session_key", "=", input.sessionKey);
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(gatewayBoundaryPolicyFromRow);
  }

  async saveGatewayMcpConfig(config: GatewayMcpConfigRecord): Promise<GatewayMcpConfigRecord> {
    const parsed = GatewayMcpConfigRecordSchema.parse(config);
    await this.db
      .insertInto("gateway_mcp_configs")
      .values(gatewayMcpConfigToRow(parsed))
      .onConflict((oc) => oc.column("id").doUpdateSet(gatewayMcpConfigToRow(parsed)))
      .execute();
    return parsed;
  }

  async getGatewayMcpConfig(id: string): Promise<GatewayMcpConfigRecord | undefined> {
    const row = await this.db.selectFrom("gateway_mcp_configs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? gatewayMcpConfigFromRow(row) : undefined;
  }

  async getGatewayMcpConfigByServerName(serverName: string): Promise<GatewayMcpConfigRecord | undefined> {
    const row = await this.db.selectFrom("gateway_mcp_configs").selectAll().where("server_name", "=", serverName).executeTakeFirst();
    return row ? gatewayMcpConfigFromRow(row) : undefined;
  }

  async listGatewayMcpConfigs(input: { enabled?: boolean; serverName?: string } = {}): Promise<GatewayMcpConfigRecord[]> {
    let query = this.db.selectFrom("gateway_mcp_configs").selectAll();
    if (input.enabled !== undefined) {
      query = query.where("enabled", "=", input.enabled ? 1 : 0);
    }
    if (input.serverName) {
      query = query.where("server_name", "=", input.serverName);
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(gatewayMcpConfigFromRow);
  }

  async acquireGatewayConcurrencyLock(input: {
    lockKey: string;
    scope: GatewayConcurrencyLockRecord["scope"];
    policyId?: string;
    ownerRef?: GatewayConcurrencyLockRecord["owner_ref"];
    ttlMs: number;
    metadata?: Record<string, JsonValue>;
    now?: string;
  }): Promise<{ acquired: true; lock: GatewayConcurrencyLockRecord } | { acquired: false; lock: GatewayConcurrencyLockRecord }> {
    const now = input.now ?? nowIso();
    const existing = await this.getGatewayConcurrencyLock(input.lockKey);
    if (existing && existing.status === "acquired" && Date.parse(existing.expires_at) > Date.parse(now)) {
      return { acquired: false, lock: existing };
    }

    const lock: GatewayConcurrencyLockRecord = {
      id: existing?.id ?? createId("gateway_lock"),
      lock_key: input.lockKey,
      scope: input.scope,
      policy_id: input.policyId,
      owner_ref: input.ownerRef,
      status: "acquired",
      acquired_at: now,
      expires_at: new Date(Date.parse(now) + input.ttlMs).toISOString(),
      metadata: input.metadata ?? {}
    };
    await this.db
      .insertInto("gateway_concurrency_locks")
      .values(gatewayConcurrencyLockToRow(lock))
      .onConflict((oc) => oc.column("lock_key").doUpdateSet(gatewayConcurrencyLockToRow(lock)))
      .execute();
    return { acquired: true, lock };
  }

  async getGatewayConcurrencyLock(lockKey: string): Promise<GatewayConcurrencyLockRecord | undefined> {
    const row = await this.db.selectFrom("gateway_concurrency_locks").selectAll().where("lock_key", "=", lockKey).executeTakeFirst();
    return row ? gatewayConcurrencyLockFromRow(row) : undefined;
  }

  async releaseGatewayConcurrencyLock(lockKey: string, now = nowIso()): Promise<GatewayConcurrencyLockRecord | undefined> {
    const existing = await this.getGatewayConcurrencyLock(lockKey);
    if (!existing) {
      return undefined;
    }
    const released: GatewayConcurrencyLockRecord = {
      ...existing,
      status: Date.parse(existing.expires_at) <= Date.parse(now) ? "expired" : "released",
      released_at: now
    };
    await this.db
      .updateTable("gateway_concurrency_locks")
      .set(gatewayConcurrencyLockToRow(released))
      .where("lock_key", "=", lockKey)
      .execute();
    return released;
  }

  async expireGatewayConcurrencyLocks(now = nowIso()): Promise<GatewayConcurrencyLockRecord[]> {
    const locks = await this.listGatewayConcurrencyLocks({ status: "acquired", limit: 500 });
    const expired: GatewayConcurrencyLockRecord[] = [];
    for (const lock of locks) {
      if (Date.parse(lock.expires_at) > Date.parse(now)) {
        continue;
      }
      const released = await this.releaseGatewayConcurrencyLock(lock.lock_key, now);
      if (released) {
        expired.push(released);
      }
    }
    return expired;
  }

  async reclaimExpiredGatewayConcurrencyLocks(now=nowIso()):Promise<GatewayConcurrencyLockRecord[]>{return this.expireGatewayConcurrencyLocks(now)}

  async listGatewayConcurrencyLocks(input: { status?: GatewayConcurrencyLockRecord["status"]; limit?: number } = {}): Promise<GatewayConcurrencyLockRecord[]> {
    let query = this.db.selectFrom("gateway_concurrency_locks").selectAll();
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    const rows = await query.orderBy("acquired_at", "desc").limit(input.limit ?? 50).execute();
    return rows.map(gatewayConcurrencyLockFromRow);
  }

  async saveGatewaySandboxInstance(instance: GatewaySandboxInstanceRecord): Promise<GatewaySandboxInstanceRecord> {
    const parsed = GatewaySandboxInstanceRecordSchema.parse(instance);
    await this.db
      .insertInto("gateway_sandbox_instances")
      .values(gatewaySandboxInstanceToRow(parsed))
      .onConflict((oc) => oc.column("instance_key").doUpdateSet(gatewaySandboxInstanceToRow(parsed)))
      .execute();
    return parsed;
  }

  async getGatewaySandboxInstance(idOrKey: string): Promise<GatewaySandboxInstanceRecord | undefined> {
    const row = await this.db
      .selectFrom("gateway_sandbox_instances")
      .selectAll()
      .where((eb) => eb.or([
        eb("id", "=", idOrKey),
        eb("instance_key", "=", idOrKey)
      ]))
      .executeTakeFirst();
    return row ? gatewaySandboxInstanceFromRow(row) : undefined;
  }

  async listGatewaySandboxInstances(input: {
    status?: GatewaySandboxInstanceRecord["status"];
    scope?: GatewaySandboxInstanceRecord["scope"];
    backend?: GatewaySandboxInstanceRecord["backend"];
    limit?: number;
  } = {}): Promise<GatewaySandboxInstanceRecord[]> {
    let query = this.db.selectFrom("gateway_sandbox_instances").selectAll();
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    if (input.scope) {
      query = query.where("scope", "=", input.scope);
    }
    if (input.backend) {
      query = query.where("backend", "=", input.backend);
    }
    const rows = await query.orderBy("updated_at", "desc").limit(input.limit ?? 50).execute();
    return rows.map(gatewaySandboxInstanceFromRow);
  }

  async saveGatewaySandboxWorkspaceSync(sync: GatewaySandboxWorkspaceSyncRecord): Promise<GatewaySandboxWorkspaceSyncRecord> {
    const parsed = GatewaySandboxWorkspaceSyncRecordSchema.parse(sync);
    await this.db
      .insertInto("gateway_sandbox_workspace_syncs")
      .values(gatewaySandboxWorkspaceSyncToRow(parsed))
      .onConflict((oc) => oc.column("id").doUpdateSet(gatewaySandboxWorkspaceSyncToRow(parsed)))
      .execute();
    return parsed;
  }

  async listGatewaySandboxWorkspaceSyncs(input: {
    instanceId?: string;
    instanceKey?: string;
    status?: GatewaySandboxWorkspaceSyncRecord["status"];
    direction?: GatewaySandboxWorkspaceSyncRecord["direction"];
    limit?: number;
  } = {}): Promise<GatewaySandboxWorkspaceSyncRecord[]> {
    let query = this.db.selectFrom("gateway_sandbox_workspace_syncs").selectAll();
    if (input.instanceId) {
      query = query.where("instance_id", "=", input.instanceId);
    }
    if (input.instanceKey) {
      query = query.where("instance_key", "=", input.instanceKey);
    }
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    if (input.direction) {
      query = query.where("direction", "=", input.direction);
    }
    const rows = await query.orderBy("started_at", "desc").limit(input.limit ?? 50).execute();
    return rows.map(gatewaySandboxWorkspaceSyncFromRow);
  }

  async createAutomationRun(run: AutomationRunRecord): Promise<AutomationRunRecord> {
    await this.db
      .insertInto("automation_runs")
      .values(automationRunToRow(run))
      .execute();
    return run;
  }

  async updateAutomationRun(run: AutomationRunRecord): Promise<AutomationRunRecord> {
    await this.db
      .updateTable("automation_runs")
      .set(automationRunToRow(run))
      .where("id", "=", run.id)
      .execute();
    return run;
  }

  async getAutomationRun(id: string): Promise<AutomationRunRecord | undefined> {
    const row = await this.db.selectFrom("automation_runs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? automationRunFromRow(row) : undefined;
  }

  async listAutomationRuns(limit = 100): Promise<AutomationRunRecord[]> {
    const rows = await this.db.selectFrom("automation_runs").selectAll().orderBy("started_at", "desc").limit(Math.max(1, Math.min(500, limit))).execute();
    return rows.map(automationRunFromRow);
  }

  async createReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord> {
    await this.db.insertInto("reflection_runs").values(reflectionRunToRow(run)).execute();
    return run;
  }

  async updateReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord> {
    await this.db.updateTable("reflection_runs").set(reflectionRunToRow(run)).where("id", "=", run.id).execute();
    return run;
  }

  async getReflectionRun(id: string): Promise<ReflectionRunRecord | undefined> {
    const row = await this.db.selectFrom("reflection_runs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? reflectionRunFromRow(row) : undefined;
  }

  async listReflectionRuns(sessionId?: string): Promise<ReflectionRunRecord[]> {
    let query = this.db.selectFrom("reflection_runs").selectAll();
    if (sessionId) {
      query = query.where("session_id", "=", sessionId);
    }
    const rows = await query.orderBy("started_at", "desc").execute();
    return rows.map(reflectionRunFromRow);
  }

  async saveReflectionSuggestion(suggestion: ReflectionSuggestionRecord): Promise<ReflectionSuggestionRecord> {
    await this.db.insertInto("reflection_suggestions").values(reflectionSuggestionToRow(suggestion)).execute();
    return suggestion;
  }

  async updateReflectionSuggestion(suggestion: ReflectionSuggestionRecord): Promise<ReflectionSuggestionRecord> {
    await this.db
      .updateTable("reflection_suggestions")
      .set(reflectionSuggestionToRow(suggestion))
      .where("id", "=", suggestion.id)
      .execute();
    return suggestion;
  }

  async listReflectionSuggestions(reflectionRunId?: string): Promise<ReflectionSuggestionRecord[]> {
    let query = this.db.selectFrom("reflection_suggestions").selectAll();
    if (reflectionRunId) {
      query = query.where("reflection_run_id", "=", reflectionRunId);
    }
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map(reflectionSuggestionFromRow);
  }

  async saveToolRun(run: ToolRunRecord): Promise<ToolRunRecord> {
    await this.db.insertInto("tool_runs").values(toolRunToRow(run)).execute();
    return run;
  }

  async listToolRuns(input: { runId?: string; sessionId?: string } = {}): Promise<ToolRunRecord[]> {
    let query = this.db.selectFrom("tool_runs").selectAll();
    if (input.runId) {
      query = query.where("run_id", "=", input.runId);
    }
    if (input.sessionId) {
      query = query.where("session_id", "=", input.sessionId);
    }
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map(toolRunFromRow);
  }

  async getToolRunDiagnostics(input: {
    runId?: string;
    sessionId?: string;
    status?: ToolRunStatus;
    limit?: number;
  } = {}): Promise<ToolRunDiagnosticsReport> {
    const limit = normalizeToolRunDiagnosticsLimit(input.limit);
    const scopedToolRuns = (await this.listToolRuns({ runId: input.runId, sessionId: input.sessionId }))
      .filter((run) => input.status === undefined || run.status === input.status)
      .slice(0, limit);
    const actionableToolRuns = scopedToolRuns.filter((run) => run.status === "ignored" || run.status === "failed");
    const groups = groupToolRunDiagnostics(actionableToolRuns);

    return {
      generated_at: nowIso(),
      scope: {
        ...(input.runId ? { run_id: input.runId } : {}),
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.status ? { status: input.status } : {}),
        limit
      },
      total_tool_runs: scopedToolRuns.length,
      ignored_or_failed_tool_runs: actionableToolRuns.length,
      groups,
      repeated_ignored_provider_tools: groups.filter((group) => group.status === "ignored" && group.count > 1),
      recommendation: groups.length
        ? "Review repeated ignored or failed provider tool calls and normalize them through the Domain Command catalog or adapter mapping."
        : "No ignored or failed provider tool calls were found in the selected scope."
    };
  }

  async saveExternalAssistRecord(record: ExternalAssistRecord): Promise<ExternalAssistRecord> {
    const parsed = ExternalAssistRecordSchema.parse(record);
    await this.db
      .insertInto("external_assist_records")
      .values(externalAssistRecordToRow(parsed))
      .onConflict((oc) => oc.column("id").doUpdateSet(externalAssistRecordToRow(parsed)))
      .execute();
    return parsed;
  }

  async listExternalAssistRecords(input: {
    sessionId?: string;
    phase?: ExternalAssistPhase;
    status?: ExternalAssistStatus;
    providerId?: string;
    limit?: number;
  } = {}): Promise<ExternalAssistRecord[]> {
    let query = this.db.selectFrom("external_assist_records").selectAll();
    if (input.sessionId) {
      query = query.where("session_id", "=", input.sessionId);
    }
    if (input.phase) {
      query = query.where("phase", "=", input.phase);
    }
    if (input.status) {
      query = query.where("status", "=", input.status);
    }
    if (input.providerId) {
      query = query.where("provider_id", "=", input.providerId);
    }
    query = query.orderBy("created_at", "desc");
    if (input.limit !== undefined) {
      query = query.limit(input.limit);
    }
    const rows = await query.execute();
    return rows.map(externalAssistRecordFromRow);
  }

  async getExternalAssistDiagnostics(input: {
    sessionId?: string;
    phase?: ExternalAssistPhase;
    status?: ExternalAssistStatus;
    providerId?: string;
    limit?: number;
  } = {}): Promise<ExternalAssistDiagnosticsReport> {
    const limit = normalizeExternalAssistDiagnosticsLimit(input.limit);
    const records = await this.listExternalAssistRecords({
      sessionId: input.sessionId,
      phase: input.phase,
      status: input.status,
      providerId: input.providerId,
      limit
    });
    const violations = externalAssistDiagnosticsViolations(records);

    return {
      generated_at: nowIso(),
      scope: {
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.phase ? { phase: input.phase } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.providerId ? { provider_id: input.providerId } : {}),
        limit
      },
      total_records: records.length,
      failed_records: records.filter((record) => record.status === "failed").length,
      hint_count: records.reduce((count, record) => count + record.hints.length, 0),
      unisolated_records: records.filter((record) => !record.isolated_from_memory).length,
      included_in_active_memory_records: records.filter((record) => record.included_in_active_memory).length,
      groups: groupExternalAssistDiagnostics(records),
      violations,
      recent_failures: records.filter((record) => record.status === "failed").slice(0, 10),
      recommendation: externalAssistDiagnosticsRecommendation(records, violations)
    };
  }

  async getSettings(): Promise<SettingsRecord> {
    const row = await this.db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirstOrThrow();
    return {
      ui_locale: row.ui_locale as SettingsRecord["ui_locale"],
      output_locale: row.output_locale as SettingsRecord["output_locale"],
      memory_capture_mode: row.memory_capture_mode as SettingsRecord["memory_capture_mode"],
      knowledge_wiki_capture_mode: row.knowledge_wiki_capture_mode as SettingsRecord["knowledge_wiki_capture_mode"],
      skill_capture_mode: row.skill_capture_mode as SettingsRecord["skill_capture_mode"],
      external_provider_role: row.external_provider_role as SettingsRecord["external_provider_role"],
      default_backend_id: row.default_backend_id ?? undefined,
      updated_at: row.updated_at
    };
  }

  async patchSettings(patch: Partial<Omit<SettingsRecord, "updated_at">>): Promise<SettingsRecord> {
    const current = await this.getSettings();
    const next: SettingsRecord = {
      ...current,
      ...patch,
      updated_at: nowIso()
    };
    await this.db
      .updateTable("settings")
      .set({
        ui_locale: next.ui_locale,
        output_locale: next.output_locale,
        memory_capture_mode: next.memory_capture_mode,
        knowledge_wiki_capture_mode: next.knowledge_wiki_capture_mode,
        skill_capture_mode: next.skill_capture_mode,
        external_provider_role: next.external_provider_role,
        default_backend_id: next.default_backend_id ?? null,
        updated_at: next.updated_at
      })
      .where("id", "=", "default")
      .execute();
    return next;
  }

  async savePluginState(input: { manifestId: string; enabled: boolean; version: string }): Promise<{ manifest_id: string; enabled: boolean; version: string; updated_at: string }> {
    const updatedAt = nowIso();
    await this.db.insertInto("plugin_states").values({ manifest_id: input.manifestId, enabled: input.enabled ? 1 : 0, version: input.version, updated_at: updatedAt }).onConflict((oc) => oc.column("manifest_id").doUpdateSet({ enabled: input.enabled ? 1 : 0, version: input.version, updated_at: updatedAt })).execute();
    return { manifest_id: input.manifestId, enabled: input.enabled, version: input.version, updated_at: updatedAt };
  }

  async listPluginStates(): Promise<Array<{ manifest_id: string; enabled: boolean; version: string; updated_at: string }>> {
    return (await this.db.selectFrom("plugin_states").selectAll().orderBy("manifest_id").execute()).map((row) => ({ manifest_id: row.manifest_id, enabled: row.enabled === 1, version: row.version, updated_at: row.updated_at }));
  }

  async listGrants(): Promise<GrantRecord[]> {
    const rows = await this.db.selectFrom("grants").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(grantFromRow);
  }

  async getGrant(id: string): Promise<GrantRecord | undefined> {
    const row = await this.db.selectFrom("grants").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? grantFromRow(row) : undefined;
  }

  async saveGrant(grant: GrantRecord): Promise<GrantRecord> {
    await this.db
      .insertInto("grants")
      .values({
        id: grant.id,
        capability_id: grant.capability_id,
        operation: grant.operation,
        actor_identity: grant.actor_identity,
        channel: grant.channel,
        resource_scope: grant.resource_scope,
        manifest_version: grant.manifest_version,
        risk_snapshot: grant.risk_snapshot,
        scope_snapshot: grant.scope_snapshot,
        external_impact_snapshot: grant.external_impact_snapshot ? 1 : 0,
        secret_requirement_snapshot: grant.secret_requirement_snapshot,
        granted_by: grant.granted_by,
        reason: grant.reason,
        created_at: grant.created_at,
        expires_at: grant.expires_at ?? null,
        revoked_at: grant.revoked_at ?? null
      })
      .execute();
    return grant;
  }

  async revokeGrant(id: string, revokedAt: string): Promise<GrantRecord | undefined> {
    await this.db
      .updateTable("grants")
      .set({ revoked_at: revokedAt })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .execute();
    return this.getGrant(id);
  }

  async reindexSessionSearch(): Promise<{ mode: "fts5_trigram" | "fts5" | "like"; indexed: number }> {
    if (this.sessionSearchIndexMode === "like") return { mode: "like", indexed: 0 };
    try {
      await sql.raw("DELETE FROM session_search_fts").execute(this.db);
      if (this.sessionSearchIndexMode === "fts5_trigram") {
        await sql.raw("DELETE FROM session_search_trigram").execute(this.db);
      }
      const [sessions, messages, artifacts] = await Promise.all([
        this.db.selectFrom("sessions").selectAll().execute(),
        this.db.selectFrom("messages").selectAll().execute(),
        this.db.selectFrom("artifacts").leftJoin("operations", "operations.id", "artifacts.source_operation_id").selectAll("artifacts").select(["operations.session_id as session_id"]).execute()
      ]);
      const artifactEntries = await Promise.all(artifacts.map(async (row) => ({
        kind: "artifact" as const,
        id: row.id,
        sessionId: row.session_id ?? undefined,
        operationId: row.source_operation_id,
        title: row.title,
        body: (await this.readArtifactContent(row.id).catch(() => "")) ?? ""
      })));
      const entries: Array<{ kind: "session" | "message" | "artifact"; id: string; sessionId?: string; operationId?: string; title: string; body: string }> = [
        ...sessions.map((row) => ({ kind: "session" as const, id: row.id, title: row.title, body: row.session_key })),
        ...messages.map((row) => ({ kind: "message" as const, id: row.id, sessionId: row.session_id, title: row.role, body: row.content })),
        ...artifactEntries
      ];
      for (const entry of entries) {
        await sql`INSERT INTO session_search_fts (kind, id, session_id, operation_id, title, body) VALUES (${entry.kind}, ${entry.id}, ${entry.sessionId ?? null}, ${entry.operationId ?? null}, ${entry.title}, ${entry.body})`.execute(this.db);
        if (this.sessionSearchIndexMode === "fts5_trigram") {
          await sql`INSERT INTO session_search_trigram (kind, id, session_id, operation_id, title, body) VALUES (${entry.kind}, ${entry.id}, ${entry.sessionId ?? null}, ${entry.operationId ?? null}, ${entry.title}, ${entry.body})`.execute(this.db);
        }
      }
      return { mode: this.sessionSearchIndexMode, indexed: entries.length };
    } catch {
      this.sessionSearchIndexMode = "like";
      return { mode: "like", indexed: 0 };
    }
  }

  private async upsertSessionSearchEntry(entry: { kind: "session" | "message" | "artifact"; id: string; sessionId?: string; operationId?: string; title: string; body: string }): Promise<void> {
    if (this.sessionSearchIndexMode === "like") return;
    await sql`DELETE FROM session_search_fts WHERE kind = ${entry.kind} AND id = ${entry.id}`.execute(this.db);
    await sql`INSERT INTO session_search_fts (kind, id, session_id, operation_id, title, body) VALUES (${entry.kind}, ${entry.id}, ${entry.sessionId ?? null}, ${entry.operationId ?? null}, ${entry.title}, ${entry.body})`.execute(this.db);
    if (this.sessionSearchIndexMode === "fts5_trigram") {
      await sql`DELETE FROM session_search_trigram WHERE kind = ${entry.kind} AND id = ${entry.id}`.execute(this.db);
      await sql`INSERT INTO session_search_trigram (kind, id, session_id, operation_id, title, body) VALUES (${entry.kind}, ${entry.id}, ${entry.sessionId ?? null}, ${entry.operationId ?? null}, ${entry.title}, ${entry.body})`.execute(this.db);
    }
  }

  private async deleteSessionSearchEntry(kind: "session" | "message" | "artifact", id: string): Promise<void> {
    if (this.sessionSearchIndexMode === "like") return;
    await sql`DELETE FROM session_search_fts WHERE kind = ${kind} AND id = ${id}`.execute(this.db);
    if (this.sessionSearchIndexMode === "fts5_trigram") await sql`DELETE FROM session_search_trigram WHERE kind = ${kind} AND id = ${id}`.execute(this.db);
  }

  getSessionSearchMode(): "fts5_trigram" | "fts5" | "like" {
    return this.sessionSearchIndexMode;
  }

  private async searchSessionIndex(query: string): Promise<SearchResult[]> {
    if (this.sessionSearchIndexMode === "like") return [];
    const table = this.sessionSearchIndexMode === "fts5_trigram" && containsJapanese(query)
      ? "session_search_trigram"
      : "session_search_fts";
    const matchQuery = `"${query.replaceAll('"', '""')}"`;
    try {
      const rows = containsJapanese(query) && [...query].length < 3
        ? await sql<{ kind: SearchResult["kind"]; id: string; session_id: string | null; operation_id: string | null; title: string; body: string }>`
            SELECT kind, id, session_id, operation_id, title, body FROM ${sql.raw(table)}
            WHERE title LIKE ${`%${query}%`} OR body LIKE ${`%${query}%`} ORDER BY kind, id LIMIT 30
          `.execute(this.db)
        : await sql<{ kind: SearchResult["kind"]; id: string; session_id: string | null; operation_id: string | null; title: string; body: string }>`
            SELECT kind, id, session_id, operation_id, title, body FROM ${sql.raw(table)}
            WHERE ${sql.raw(table)} MATCH ${matchQuery} ORDER BY bm25(${sql.raw(table)}), kind, id LIMIT 30
          `.execute(this.db);
      return rows.rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        title: row.title,
        summary: row.body.slice(0, 120),
        session_id: row.session_id ?? undefined,
        operation_id: row.operation_id ?? undefined
      }));
    } catch {
      return [];
    }
  }

  async search(query: string): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    let indexedResults: SearchResult[] = [];
    if (this.sessionSearchIndexMode !== "like") {
      indexedResults = await this.searchSessionIndex(trimmed);
      const needle = `%${trimmed}%`;
      const audits = await this.db
        .selectFrom("audit_records")
        .leftJoin("operations", "operations.id", "audit_records.operation_id")
        .selectAll("audit_records")
        .select(["operations.session_id as session_id"])
        .where((eb) => eb.or([eb("inputs_summary", "like", needle), eb("outputs_summary", "like", needle)]))
        .limit(10)
        .execute();
      return [...indexedResults, ...audits.map((row) => ({
        kind: "audit" as const,
        id: row.id,
        title: row.operation_id,
        summary: `${row.inputs_summary} -> ${row.outputs_summary}`.slice(0, 140),
        session_id: row.session_id ?? undefined,
        operation_id: row.operation_id
      }))];
    }

    const needle = `%${trimmed}%`;
    const [sessions, messages, artifacts, audits] = await Promise.all([
      this.db.selectFrom("sessions").selectAll().where("title", "like", needle).limit(10).execute(),
      this.db.selectFrom("messages").selectAll().where("content", "like", needle).limit(10).execute(),
      this.db
        .selectFrom("artifacts")
        .leftJoin("operations", "operations.id", "artifacts.source_operation_id")
        .selectAll("artifacts")
        .select(["operations.session_id as session_id"])
        .execute(),
      this.db
        .selectFrom("audit_records")
        .leftJoin("operations", "operations.id", "audit_records.operation_id")
        .selectAll("audit_records")
        .select(["operations.session_id as session_id"])
        .where((eb) => eb.or([eb("inputs_summary", "like", needle), eb("outputs_summary", "like", needle)]))
        .limit(10)
        .execute()
    ]);

    const artifactResults: SearchResult[] = [];
    for (const artifact of artifacts) {
      const content = (await this.readArtifactContent(artifact.id).catch(() => "")) ?? "";
      if (artifact.title.includes(trimmed) || content.includes(trimmed)) {
        artifactResults.push({
          kind: "artifact",
          id: artifact.id,
          title: artifact.title,
          summary: content.slice(0, 120),
          session_id: artifact.session_id ?? undefined,
          operation_id: artifact.source_operation_id
        });
      }
      if (artifactResults.length >= 10) {
        break;
      }
    }

    const fallbackResults: SearchResult[] = [
      ...sessions.map((row) => ({ kind: "session" as const, id: row.id, title: row.title, summary: row.session_key })),
      ...messages.map((row) => ({
        kind: "message" as const,
        id: row.id,
        title: row.role,
        summary: row.content.slice(0, 120),
        session_id: row.session_id
      })),
      ...artifactResults,
      ...audits.map((row) => ({
        kind: "audit" as const,
        id: row.id,
        title: row.operation_id,
        summary: `${row.inputs_summary} -> ${row.outputs_summary}`.slice(0, 140),
        session_id: row.session_id ?? undefined,
        operation_id: row.operation_id
      }))
    ];
    return fallbackResults;
  }

  async readActivityInputs(): Promise<{
    approvals: ApprovalRequest[];
    operations: OperationRecord[];
    decisions: PolicyDecisionRecord[];
    audits: AuditRecord[];
    rollbacks: RollbackPoint[];
  }> {
    const [approvals, operations, decisions, audits, rollbacks] = await Promise.all([
      this.listApprovalRequests(),
      this.listOperations(),
      this.listPolicyDecisions(),
      this.listAuditRecords(),
      this.listRollbackPoints()
    ]);
    return { approvals, operations, decisions, audits, rollbacks };
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}

export async function ensureWorkspaceLayout(rootDir: string): Promise<void> {
  await Promise.all(workspaceLayoutDirs(rootDir).map((dir) => mkdir(dir, { recursive: true })));
}

function workspaceLayoutDirs(rootDir: string): string[] {
  return [
    rootDir,
    path.join(rootDir, "artifacts"),
    path.join(rootDir, "profile"),
    path.join(rootDir, "memory", "session"),
    path.join(rootDir, "memory", "provisional"),
    path.join(rootDir, "memory", "topic"),
    path.join(rootDir, "memory", "active"),
    path.join(rootDir, "memory", "sensitive"),
    path.join(rootDir, "memory", "archived"),
    path.join(rootDir, "skills", "candidate"),
    path.join(rootDir, "skills", "project"),
    path.join(rootDir, "skills", "active"),
    path.join(rootDir, "skills", "stale"),
    path.join(rootDir, "skills", "archived"),
    path.join(rootDir, "skills", "pinned"),
    path.join(rootDir, "skills", "support"),
    path.join(rootDir, "wiki", "pages"),
    path.join(rootDir, "rollback"),
    path.join(rootDir, "collections"),
    path.join(rootDir, "surfaces"),
    path.join(rootDir, "backups")
  ];
}

function workspaceBackupRoots(): string[] {
  return ["artifacts", "profile", "memory", "skills", "wiki", "rollback", "collections", "surfaces"];
}

function workspaceResourceBoundaries(): WorkspaceResourceBoundary[] {
  return [
    {
      resource: "generated_surfaces",
      source_of_truth: "filesystem",
      file_roots: ["surfaces"],
      sqlite_tables: ["generated_surfaces", "generated_surface_revisions", "surface_interactions"],
      sqlite_role: "metadata",
      note: "Versioned Generated Surface bundles live in Workspace files; SQLite tracks revisions, state, and interactions."
    },
    {
      resource: "profile",
      source_of_truth: "filesystem",
      file_roots: ["profile"],
      sqlite_tables: ["settings"],
      sqlite_role: "metadata",
      note: "Profile and SOUL-style identity files live in the workspace; settings rows hold operational preferences."
    },
    {
      resource: "memory",
      source_of_truth: "filesystem",
      file_roots: ["memory"],
      sqlite_tables: ["memory_index"],
      sqlite_role: "index",
      note: "Memory markdown is the durable source; SQLite is used for search, state, and retrieval metadata."
    },
    {
      resource: "knowledge_wiki",
      source_of_truth: "filesystem",
      file_roots: ["wiki/pages"],
      sqlite_tables: ["wiki_index"],
      sqlite_role: "index",
      note: "Knowledge Wiki markdown is the durable source; SQLite is a repairable active/search index."
    },
    {
      resource: "skill",
      source_of_truth: "filesystem",
      file_roots: ["skills"],
      sqlite_tables: ["skill_usage"],
      sqlite_role: "metadata",
      note: "Skill markdown and support files are the durable source; usage stats are derived operational metadata."
    },
    {
      resource: "artifact",
      source_of_truth: "filesystem",
      file_roots: ["artifacts"],
      sqlite_tables: ["artifacts"],
      sqlite_role: "metadata",
      note: "Artifact body files are durable output; SQLite stores metadata, session links, and render hints."
    },
    {
      resource: "collection",
      source_of_truth: "filesystem",
      file_roots: ["collections"],
      sqlite_tables: ["collection_schemas", "collection_records", "collection_patches"],
      sqlite_role: "index",
      note: "Collection schemas, records, and notes live in files; SQLite rows are rebuildable indexes."
    },
    {
      resource: "session_run_history",
      source_of_truth: "sqlite",
      file_roots: [],
      sqlite_tables: ["sessions", "messages", "operations", "backend_runs", "backend_events", "tool_runs", "workspace_changes"],
      sqlite_role: "history",
      note: "Session and run history are structured append-oriented records used for resume, search, and audit views."
    },
    {
      resource: "learning_core",
      source_of_truth: "derived",
      file_roots: ["learning-snapshots"],
      sqlite_tables: ["learning_resource_uses", "learning_evaluations", "background_review_changes", "learning_snapshots", "learning_job_reports", "session_search_fts", "session_search_trigram"],
      sqlite_role: "history",
      note: "Learning usage, evaluation, provenance, snapshots, and Session Search are derived or restorable records; Memory and Skill markdown remain the durable source."
    },
    {
      resource: "policy_audit_rollback",
      source_of_truth: "sqlite",
      file_roots: ["rollback"],
      sqlite_tables: ["policy_decisions", "audit_records", "rollback_points"],
      sqlite_role: "audit",
      note: "Policy/audit records are SQLite history; rollback snapshots may reference filesystem payloads."
    },
    {
      resource: "gateway_automation",
      source_of_truth: "sqlite",
      file_roots: [],
      sqlite_tables: ["gateway_pairings", "gateway_pairing_policies", "gateway_routing_policies", "gateway_inbound_messages", "gateway_concurrency_locks", "gateway_sandbox_instances", "gateway_sandbox_workspace_syncs", "automation_jobs", "automation_runs"],
      sqlite_role: "queue",
      note: "Gateway and scheduler state are operational queues/control-plane records, not workspace prose."
    },
    {
      resource: "client_event_queue",
      source_of_truth: "sqlite",
      file_roots: [],
      sqlite_tables: ["client_events"],
      sqlite_role: "queue",
      note: "Client events are queued OS/UI requests for Web, Desktop, or future clients; Runtime and Desktop stay decoupled through this table."
    },
    {
      resource: "localized_derivatives",
      source_of_truth: "derived",
      file_roots: [],
      sqlite_tables: ["resource_translations"],
      sqlite_role: "metadata",
      note: "Resource translations are derived records tied to source resource hashes and can fall back to original text."
    }
  ];
}

function createBackupId(): string {
  return `backup_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
}

function parseWorkspaceBackupManifest(value: unknown): WorkspaceBackupManifest {
  if (!value || typeof value !== "object") {
    throw new Error("workspace_backup_manifest_invalid");
  }
  const manifest = value as Record<string, unknown>;
  if (
    typeof manifest.id !== "string"
    || typeof manifest.created_at !== "string"
    || typeof manifest.source_root !== "string"
    || typeof manifest.db_file !== "string"
    || !Array.isArray(manifest.file_roots)
    || typeof manifest.health_ok !== "boolean"
  ) {
    throw new Error("workspace_backup_manifest_invalid");
  }
  if (manifest.db_file !== "workspace.sqlite") {
    throw new Error("workspace_backup_manifest_invalid");
  }
  return {
    id: normalizeBackupId(manifest.id),
    created_at: manifest.created_at,
    source_root: manifest.source_root,
    db_file: manifest.db_file,
    file_roots: manifest.file_roots.filter((item): item is string => typeof item === "string"),
    resource_boundaries: Array.isArray(manifest.resource_boundaries)
      ? manifest.resource_boundaries.filter(isWorkspaceResourceBoundary)
      : workspaceResourceBoundaries(),
    health_ok: manifest.health_ok,
    integrity_ok: typeof manifest.integrity_ok === "boolean" ? manifest.integrity_ok : manifest.health_ok,
    file_hashes: manifest.file_hashes && typeof manifest.file_hashes === "object"
      ? Object.fromEntries(Object.entries(manifest.file_hashes as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {}
  };
}

async function hashFilesUnderRoot(root: string, excluded: string[] = []): Promise<Record<string, string>> {
  const excludedSet = new Set(excluded);
  const files = (await listRelativeFiles(root)).filter((file) => !excludedSet.has(file)).sort();
  const entries = await Promise.all(files.map(async (file) => {
    const content = await readFile(path.join(root, file));
    return [file, createHash("sha256").update(content).digest("hex")] as const;
  }));
  return Object.fromEntries(entries);
}

function isWorkspaceResourceBoundary(value: unknown): value is WorkspaceResourceBoundary {
  if (!value || typeof value !== "object") {
    return false;
  }
  const boundary = value as Record<string, unknown>;
  return typeof boundary.resource === "string"
    && (boundary.source_of_truth === "filesystem" || boundary.source_of_truth === "sqlite" || boundary.source_of_truth === "derived")
    && Array.isArray(boundary.file_roots)
    && boundary.file_roots.every((item) => typeof item === "string")
    && Array.isArray(boundary.sqlite_tables)
    && boundary.sqlite_tables.every((item) => typeof item === "string")
    && (boundary.sqlite_role === "none" || boundary.sqlite_role === "index" || boundary.sqlite_role === "history" || boundary.sqlite_role === "queue" || boundary.sqlite_role === "audit" || boundary.sqlite_role === "metadata")
    && typeof boundary.note === "string";
}

export function renderFrontmatter(frontmatter: object): string {
  return [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---"
  ].join("\n");
}

function titleFromContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").slice(0, 48) || "Untitled chat";
}

function isInitialSessionTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "" || normalized === "new chat" || normalized === "untitled chat";
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

async function readWorkspaceText(rootDir: string, filePath: string): Promise<string> {
  return readFile(path.join(rootDir, filePath), "utf8").catch(() => "");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listWikiMarkdownFiles(rootDir: string): Promise<string[]> {
  const wikiRoot = path.join(rootDir, "wiki", "pages");
  if (!await pathExists(wikiRoot)) {
    return [];
  }
  const files = await listRelativeFiles(wikiRoot);
  return files
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".md")
    .map((filePath) => path.join("wiki", "pages", filePath))
    .sort();
}

async function listArtifactFiles(rootDir: string): Promise<string[]> {
  const artifactRoot = path.join(rootDir, "artifacts");
  if (!await pathExists(artifactRoot)) {
    return [];
  }
  const files = await listRelativeFiles(artifactRoot);
  return files
    .filter((filePath) => !filePath.endsWith(".DS_Store"))
    .map((filePath) => path.join("artifacts", filePath))
    .sort();
}

async function listMemoryMarkdownFiles(rootDir: string): Promise<string[]> {
  const memoryRoot = path.join(rootDir, "memory");
  if (!await pathExists(memoryRoot)) {
    return [];
  }
  const files = await listRelativeFiles(memoryRoot);
  return files
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".md")
    .map((filePath) => path.join("memory", filePath))
    .sort();
}

async function listSkillMarkdownFiles(rootDir: string): Promise<string[]> {
  const skillsRoot = path.join(rootDir, "skills");
  if (!await pathExists(skillsRoot)) {
    return [];
  }
  const files = await listRelativeFiles(skillsRoot);
  return files
    .filter((filePath) => {
      const parts = filePath.split(path.sep);
      return parts.length === 2 && parts[0] !== "support" && path.extname(filePath).toLowerCase() === ".md";
    })
    .map((filePath) => path.join("skills", filePath))
    .sort();
}

async function listCollectionSchemaFiles(rootDir: string): Promise<string[]> {
  const collectionsRoot = path.join(rootDir, "collections");
  if (!await pathExists(collectionsRoot)) {
    return [];
  }
  const files = await listRelativeFiles(collectionsRoot);
  return files
    .filter((filePath) => path.basename(filePath) === "schema.json")
    .map((filePath) => path.join("collections", filePath))
    .sort();
}

async function listCollectionRecordFiles(rootDir: string): Promise<string[]> {
  const collectionsRoot = path.join(rootDir, "collections");
  if (!await pathExists(collectionsRoot)) {
    return [];
  }
  const files = await listRelativeFiles(collectionsRoot);
  return files
    .filter((filePath) => {
      const parts = filePath.split(path.sep);
      return parts.includes("records") && path.extname(filePath).toLowerCase() === ".json";
    })
    .map((filePath) => path.join("collections", filePath))
    .sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) {
    return raw;
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return raw;
  }
  const contentStart = raw.indexOf("\n", end + 4);
  return contentStart === -1 ? "" : raw.slice(contentStart + 1);
}

function parseMemoryMarkdownLocal(markdown: string): { frontmatter: MemoryFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("memory_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("memory_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim();
  return {
    frontmatter: MemoryFrontmatterSchema.parse(parseRenderedFrontmatter(rawFrontmatter)),
    content
  };
}

function parseSkillMarkdownLocal(markdown: string): { frontmatter: SkillFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("skill_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("skill_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim();
  return {
    frontmatter: SkillFrontmatterSchema.parse(JSON.parse(rawFrontmatter)),
    content
  };
}

function parseWikiMarkdownLocal(markdown: string): { frontmatter: WikiFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("wiki_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("wiki_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim();
  return {
    frontmatter: WikiFrontmatterSchema.parse(parseRenderedFrontmatter(rawFrontmatter)),
    content
  };
}

function parseRenderedFrontmatter(rawFrontmatter: string): Record<string, unknown> {
  const entries = rawFrontmatter
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        throw new Error("wiki_frontmatter_invalid_line");
      }
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      return [key, JSON.parse(value)] as const;
    });
  return Object.fromEntries(entries);
}

function assertMemoryPathMatchesFrontmatter(filePath: string, frontmatter: MemoryFrontmatter): void {
  const expected = path.join("memory", frontmatter.state, `${frontmatter.id}.md`);
  if (filePath !== expected) {
    throw new Error(`memory_frontmatter_path_mismatch:${expected}`);
  }
}

function assertSkillPathMatchesFrontmatter(filePath: string, frontmatter: SkillFrontmatter): void {
  const expected = path.join("skills", frontmatter.state, `${frontmatter.id}.md`);
  if (filePath !== expected) {
    throw new Error(`skill_frontmatter_path_mismatch:${expected}`);
  }
}

function buildSkillIndexEntry(frontmatter: SkillFrontmatter): SkillIndexEntry {
  return {
    id: frontmatter.id,
    title: frontmatter.title,
    description: frontmatter.description,
    tags: frontmatter.tags,
    state: frontmatter.state,
    allowed_scopes: frontmatter.allowed_scopes,
    required_capabilities: frontmatter.required_capabilities,
    owner_pinned: frontmatter.owner_pinned,
    frontmatter
  };
}

function parseCollectionSchemaLocal(value: unknown): CollectionSchema {
  const schema = CollectionSchemaSchema.parse(value);
  const seen = new Set<string>();
  for (const field of schema.fields) {
    const id = collectionFieldId(field);
    if (!id) {
      throw new Error("collection_field_id_required");
    }
    if (seen.has(id)) {
      throw new Error(`collection_field_duplicate:${id}`);
    }
    seen.add(id);
  }
  validateCollectionViewRenderersLocal(schema);
  return schema;
}

const supportedCollectionViewRenderersLocal = new Set([
  "collection_table",
  "collection_gallery",
  "calendar_view",
  "collection_kanban"
]);

const legacyCollectionViewRenderersLocal = new Set([
  "collection_dashboard",
  "task_list"
]);

function validateCollectionViewRenderersLocal(schema: CollectionSchema): void {
  for (const view of schema.views ?? []) {
    const renderer = typeof view.renderer === "string" ? view.renderer.trim() : "";
    if (!renderer) {
      continue;
    }
    if (supportedCollectionViewRenderersLocal.has(renderer)) {
      continue;
    }
    if (legacyCollectionViewRenderersLocal.has(renderer)) {
      continue;
    }
    throw new Error(`collection_view_renderer_unsupported:${renderer}`);
  }
}

function parseCollectionRecordLocal(value: unknown, schema: CollectionSchema): CollectionRecord & { version: number } {
  const record = CollectionRecordSchema.parse(value);
  if (record.collection_id !== schema.id) {
    throw new Error("collection_record_collection_id_mismatch");
  }
  const data = stripCollectionDerivedFieldsLocal(record.data, schema);
  rejectUnknownCollectionFields(data, schema);
  validateCollectionRequiredFields(data, schema);
  validateCollectionFieldValues(data, schema);
  return { ...record, data };
}

function applyCollectionPatchLocal(record: CollectionRecord, patch: CollectionPatch, schema: CollectionSchema): CollectionRecord & { version: number } {
  if (patch.record_id !== record.id) {
    throw new Error("collection_patch_record_id_mismatch");
  }
  rejectUnknownCollectionFields(patch.changes, schema);
  const data = {
    ...stripCollectionDerivedFieldsLocal(record.data, schema),
    ...patch.changes
  };
  rejectUnknownCollectionFields(data, schema);
  validateCollectionRequiredFields(data, schema);
  validateCollectionFieldValues(data, schema);
  return {
    ...record,
    version: (record.version ?? 1) + 1,
    data,
    updated_at: patch.created_at
  };
}

function rejectUnknownCollectionFields(data: Record<string, JsonValue>, schema: CollectionSchema): void {
  const allowed = new Set([
    ...schema.fields.map(collectionFieldId),
    ...schema.refs.map(collectionDefinitionField),
    ...schema.embeds.map(collectionDefinitionField)
  ].filter((id): id is string => Boolean(id)));
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      throw new Error(`collection_unknown_field:${key}`);
    }
  }
}

function validateCollectionRequiredFields(data: Record<string, JsonValue>, schema: CollectionSchema): void {
  for (const field of schema.fields) {
    if (field.required !== true) {
      continue;
    }
    const id = collectionFieldId(field);
    if (!id) {
      continue;
    }
    if (collectionRequiredValueMissing(data[id])) {
      throw new Error(`collection_required_field:${id}`);
    }
  }
}

function validateCollectionFieldValues(data: Record<string, JsonValue>, schema: CollectionSchema): void {
  for (const field of schema.fields) {
    const id = collectionFieldId(field);
    if (!id || !(id in data)) {
      continue;
    }
    const value = data[id];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const type = collectionDefinitionString(field, "type") ?? "string";
    if (!collectionFieldValueMatchesType(value, field, type)) {
      throw new Error(`collection_field_type:${id}:${type}`);
    }
    if (type === "enum") {
      const values = collectionDefinitionStringArray(field, "enum_values");
      if (values.length > 0 && (typeof value !== "string" || !values.includes(value))) {
        throw new Error(`collection_enum_value:${id}`);
      }
    }
  }
}

function collectionFieldValueMatchesType(value: JsonValue, field: Record<string, JsonValue>, type: string): boolean {
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type === "boolean") {
    return typeof value === "boolean";
  }
  if (type === "date") {
    return typeof value === "string" && collectionDateStringValid(value);
  }
  if (type === "datetime") {
    return typeof value === "string" && collectionDateTimeStringValid(value);
  }
  if (type === "enum" || type === "ref") {
    return typeof value === "string";
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "object") {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "json") {
    return true;
  }
  if (["string", "text", "markdown", "url", "email", "image"].includes(type)) {
    return typeof value === "string";
  }
  const enumValues = collectionDefinitionStringArray(field, "enum_values");
  if (enumValues.length > 0) {
    return typeof value === "string" && enumValues.includes(value);
  }
  return true;
}

function collectionDateStringValid(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function collectionDateTimeStringValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}[tT\s]\d{2}:\d{2}/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function collectionRequiredValueMissing(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  return false;
}

function collectionFieldId(field: Record<string, JsonValue>): string | undefined {
  const value = field.id ?? field.name;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stripCollectionDerivedFieldsLocal(data: Record<string, JsonValue>, schema: CollectionSchema): Record<string, JsonValue> {
  const derived = new Set(schema.derived_fields.map(collectionFieldId).filter((id): id is string => Boolean(id)));
  if (derived.size === 0) {
    return data;
  }
  const next = { ...data };
  for (const id of derived) {
    delete next[id];
  }
  return next;
}

function evaluateCollectionDerivedField(field: Record<string, JsonValue>, data: Record<string, JsonValue>): JsonValue {
  const expression = collectionDefinitionString(field, "expression");
  if (expression) {
    const separatorIndex = expression.indexOf(":");
    const operator = separatorIndex === -1 ? expression : expression.slice(0, separatorIndex);
    const args = separatorIndex === -1 ? "" : expression.slice(separatorIndex + 1);
    const fields = args.split(",").map((item) => item.trim()).filter(Boolean);
    if (operator === "concat") {
      const joiner = collectionDefinitionString(field, "join") ?? " ";
      return fields.map((name) => jsonValueToDisplay(data[name])).filter(Boolean).join(joiner);
    }
    if (operator === "length") {
      const value = data[fields[0] ?? ""];
      return typeof value === "string" || Array.isArray(value) ? value.length : 0;
    }
    if (operator === "sum") {
      return fields.reduce((total, name) => total + (typeof data[name] === "number" ? data[name] as number : 0), 0);
    }
    if (operator === "count") {
      const value = data[fields[0] ?? ""];
      return Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1;
    }
    if (operator === "copy") {
      return data[fields[0] ?? ""] ?? null;
    }
  }
  const from = field.from;
  if (Array.isArray(from)) {
    const joiner = collectionDefinitionString(field, "join") ?? " ";
    return from
      .filter((item): item is string => typeof item === "string")
      .map((name) => jsonValueToDisplay(data[name]))
      .filter(Boolean)
      .join(joiner);
  }
  if ("value" in field) {
    return field.value ?? null;
  }
  return null;
}

function collectionDefinitionField(definition: Record<string, JsonValue>): string | undefined {
  return collectionDefinitionString(definition, "field")
    ?? collectionDefinitionString(definition, "field_id")
    ?? collectionFieldId(definition);
}

function collectionDefinitionString(definition: Record<string, JsonValue>, key: string): string | undefined {
  const value = definition[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function collectionDefinitionStringArray(definition: Record<string, JsonValue>, key: string): string[] {
  const value = definition[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function collectionDefinitionBoolean(definition: Record<string, JsonValue>, key: string): boolean {
  return definition[key] === true;
}

function collectionRefTargetId(value: JsonValue): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = value.id;
    if (typeof id === "string" && id.trim()) {
      return id;
    }
  }
  return undefined;
}

function jsonValueToDisplay(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function collectionRecordRefLocal(record: CollectionRecordWithFilePath | CollectionRecord): ResourceRef {
  return {
    kind: "collection_record",
    id: record.id,
    uri: "file_path" in record ? record.file_path : `collections/${record.collection_id}/records/${record.id}.json`,
    label: `${record.collection_id}/${record.id}`
  };
}

function collectionTriggerEffect(
  trigger: Record<string, JsonValue>,
  index: number,
  event: CollectionTriggerEffect["event"],
  recordRef: ResourceRef
): CollectionTriggerEffect {
  const triggerEvent = collectionDefinitionString(trigger, "event") ?? collectionDefinitionString(trigger, "on");
  const enabled = trigger.enabled !== false;
  const actionId = collectionDefinitionString(trigger, "action_id")
    ?? collectionDefinitionString(trigger, "action")
    ?? collectionDefinitionString(trigger, "name")
    ?? `trigger_${index + 1}`;
  const actionKind = collectionDefinitionString(trigger, "kind") ?? collectionDefinitionString(trigger, "type") ?? "custom_instruction";
  const matches = enabled && (!triggerEvent || triggerEvent === event);
  return {
    id: collectionDefinitionString(trigger, "id") ?? `trigger_${index + 1}`,
    event,
    action_id: actionId,
    action_kind: actionKind,
    status: matches ? "queued" : "ignored",
    reason: matches ? undefined : enabled ? `event_mismatch:${triggerEvent ?? "any"}` : "trigger_disabled",
    record_ref: recordRef
  };
}

function collectionSchemaHasAction(schema: CollectionSchema, actionId: string): boolean {
  return schema.actions.some((action) => {
    const id = collectionDefinitionString(action, "id")
      ?? collectionDefinitionString(action, "action_id")
      ?? collectionDefinitionString(action, "name");
    return id === actionId;
  });
}

function collectionTriggerStateStatus(input: {
  enabled: boolean;
  actionExists: boolean;
  pendingJobCount: number;
  lastJob?: AutomationJobRecord;
}): CollectionTriggerState["status"] {
  if (!input.enabled) {
    return "disabled";
  }
  if (!input.actionExists) {
    return "action_missing";
  }
  if (input.lastJob?.last_error) {
    return "failed";
  }
  if (input.pendingJobCount > 0) {
    return "queued";
  }
  if (input.lastJob?.last_run_at) {
    return "completed";
  }
  return "idle";
}

function collectionTriggerJobSummary(job: AutomationJobRecord): CollectionTriggerJobSummary {
  return {
    id: job.id,
    status: job.status,
    next_run_at: job.next_run_at,
    last_run_at: job.last_run_at,
    retry_after_at: job.retry_after_at,
    failure_count: job.failure_count ?? 0,
    last_error: job.last_error,
    updated_at: job.updated_at
  };
}

function isAutomationJobDue(job: AutomationJobRecord, now: string): boolean {
  return job.status === "enabled" &&
    (!job.next_run_at || job.next_run_at <= now) &&
    (!job.retry_after_at || job.retry_after_at <= now) &&
    (!job.locked_until || job.locked_until <= now) &&
    (job.failure_count ?? 0) < (job.max_attempts ?? 3);
}

function countAutomationJobs(jobs: AutomationJobRecord[], key: "status" | "kind"): Record<string, number> {
  return jobs.reduce<Record<string, number>>((counts, job) => {
    counts[job[key]] = (counts[job[key]] ?? 0) + 1;
    return counts;
  }, {});
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFor(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function memorySnapshot(frontmatter: MemoryFrontmatter, filePath: string): MemoryArchiveSnapshot {
  return {
    frontmatter,
    file_path: filePath,
    state: frontmatter.state,
    updated_at: frontmatter.updated_at
  };
}

function sessionFromRow(row: SessionsTable): SessionRecord {
  return {
    id: row.id,
    session_key: row.session_key,
    title: row.title,
    ui_locale: row.ui_locale as SessionRecord["ui_locale"],
    output_locale: row.output_locale as SessionRecord["output_locale"],
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function messageFromRow(row: MessagesTable): MessageRecord {
  const envelope = row.envelope_json ? safeParse(row.envelope_json) : undefined;
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    input_locale: row.input_locale as MessageRecord["input_locale"],
    output_locale: row.output_locale as MessageRecord["output_locale"],
    envelope: envelope as MessageRecord["envelope"],
    created_at: row.created_at
  };
}

function safeParse(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function operationToRow(operation: OperationRecord): OperationsTable {
  return {
    id: operation.id,
    session_id: operation.session_id,
    capability_id: operation.capability_id,
    operation: operation.operation,
    actor_identity: operation.actor_identity,
    instruction_source: operation.instruction_source,
    instruction_authority: operation.instruction_authority,
    channel: operation.channel,
    input_hash: operation.input_hash,
    input_ref_json: operation.input_ref ? stringify(operation.input_ref) : null,
    target_resource_refs_json: stringify(operation.target_resource_refs),
    proposed_effects_json: stringify(operation.proposed_effects),
    status: operation.status,
    policy_decision_id: operation.policy_decision_id ?? null,
    approval_request_id: operation.approval_request_id ?? null,
    result_ref_json: operation.result_ref ? stringify(operation.result_ref) : null,
    error: operation.error ?? null,
    created_at: operation.created_at,
    updated_at: operation.updated_at
  };
}

function operationFromRow(row: OperationsTable): OperationRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    capability_id: row.capability_id,
    operation: row.operation,
    actor_identity: row.actor_identity as OperationRecord["actor_identity"],
    instruction_source: row.instruction_source as OperationRecord["instruction_source"],
    instruction_authority: row.instruction_authority,
    channel: row.channel,
    input_hash: row.input_hash,
    input_ref: row.input_ref_json ? parse(row.input_ref_json) : undefined,
    target_resource_refs: parse(row.target_resource_refs_json),
    proposed_effects: parse(row.proposed_effects_json),
    status: row.status as OperationRecord["status"],
    policy_decision_id: row.policy_decision_id ?? undefined,
    approval_request_id: row.approval_request_id ?? undefined,
    result_ref: row.result_ref_json ? parse(row.result_ref_json) : undefined,
    error: row.error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function domainCommandExecutionToRow(record: DomainCommandExecutionRecord): DomainCommandExecutionsTable {
  return {
    id: record.id,
    idempotency_key: record.idempotency_key,
    command_id: record.command_id,
    input_source: record.input_source,
    payload_hash: record.payload_hash,
    status: record.status,
    result_json: record.result === undefined ? null : stringify(record.result),
    error: record.error ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function objectiveToRow(record: ObjectiveRecord): ObjectivesTable {
  return {
    id: record.id,
    session_id: record.session_id ?? null,
    title: record.title,
    objective: record.objective,
    completion_criteria_json: stringify(record.completion_criteria),
    status: record.status,
    token_budget: record.token_budget ?? null,
    time_budget_ms: record.time_budget_ms ?? null,
    max_attempts: record.max_attempts ?? null,
    current_checkpoint_id: record.current_checkpoint_id ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at ?? null
  };
}

function objectiveFromRow(row: ObjectivesTable): ObjectiveRecord {
  return {
    id: row.id,
    session_id: row.session_id ?? undefined,
    title: row.title,
    objective: row.objective,
    completion_criteria: parse(row.completion_criteria_json),
    status: row.status as ObjectiveRecord["status"],
    token_budget: row.token_budget ?? undefined,
    time_budget_ms: row.time_budget_ms ?? undefined,
    max_attempts: row.max_attempts ?? undefined,
    current_checkpoint_id: row.current_checkpoint_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? undefined
  };
}

function workItemToRow(record: WorkItemRecord): WorkItemsTable {
  return {
    id: record.id,
    objective_id: record.objective_id,
    parent_work_item_id: record.parent_work_item_id ?? null,
    instruction: record.instruction,
    status: record.status,
    priority: record.priority,
    attempt: record.attempt,
    max_attempts: record.max_attempts,
    idempotency_key: record.idempotency_key,
    lease_owner: record.lease_owner ?? null,
    lease_expires_at: record.lease_expires_at ?? null,
    heartbeat_at: record.heartbeat_at ?? null,
    retry_after_at: record.retry_after_at ?? null,
    backend_run_id: record.backend_run_id ?? null,
    current_checkpoint_id: record.current_checkpoint_id ?? null,
    failure_kind: record.failure_kind ?? null,
    error: record.error ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    started_at: record.started_at ?? null,
    completed_at: record.completed_at ?? null
  };
}

function workItemFromRow(row: WorkItemsTable): WorkItemRecord {
  return {
    id: row.id,
    objective_id: row.objective_id,
    parent_work_item_id: row.parent_work_item_id ?? undefined,
    instruction: row.instruction,
    status: row.status as WorkItemRecord["status"],
    priority: row.priority,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    idempotency_key: row.idempotency_key,
    lease_owner: row.lease_owner ?? undefined,
    lease_expires_at: row.lease_expires_at ?? undefined,
    heartbeat_at: row.heartbeat_at ?? undefined,
    retry_after_at: row.retry_after_at ?? undefined,
    backend_run_id: row.backend_run_id ?? undefined,
    current_checkpoint_id: row.current_checkpoint_id ?? undefined,
    failure_kind: row.failure_kind ? row.failure_kind as WorkItemRecord["failure_kind"] : undefined,
    error: row.error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at ?? undefined,
    completed_at: row.completed_at ?? undefined
  };
}

function workDependencyToRow(record: WorkDependencyRecord): WorkDependenciesTable {
  return { ...record };
}

function workDependencyFromRow(row: WorkDependenciesTable): WorkDependencyRecord {
  return { ...row, kind: row.kind as WorkDependencyRecord["kind"] };
}

function runCheckpointToRow(record: RunCheckpointRecord): RunCheckpointsTable {
  return {
    id: record.id,
    objective_id: record.objective_id,
    work_item_id: record.work_item_id,
    sequence: record.sequence,
    phase: record.phase,
    idempotency_key: record.idempotency_key,
    backend_run_id: record.backend_run_id ?? null,
    backend_session_id: record.backend_session_id ?? null,
    event_cursor: record.event_cursor ?? null,
    summary: record.summary,
    generated_resource_refs_json: stringify(record.generated_resource_refs),
    pending_operation_ids_json: stringify(record.pending_operation_ids),
    state_json: stringify(record.state),
    created_at: record.created_at
  };
}

function runCheckpointFromRow(row: RunCheckpointsTable): RunCheckpointRecord {
  return {
    id: row.id,
    objective_id: row.objective_id,
    work_item_id: row.work_item_id,
    sequence: row.sequence,
    phase: row.phase as RunCheckpointRecord["phase"],
    idempotency_key: row.idempotency_key,
    backend_run_id: row.backend_run_id ?? undefined,
    backend_session_id: row.backend_session_id ?? undefined,
    event_cursor: row.event_cursor ?? undefined,
    summary: row.summary,
    generated_resource_refs: parse(row.generated_resource_refs_json),
    pending_operation_ids: parse(row.pending_operation_ids_json),
    state: parse(row.state_json),
    created_at: row.created_at
  };
}

function generatedSurfaceToRow(record: GeneratedSurfaceDefinition): GeneratedSurfacesTable {
  return {
    id: record.id,
    state: record.state,
    session_id: record.session_id,
    title: record.title,
    definition_json: stringify(record),
    content_hash: record.content_hash,
    current_revision_id: record.current_revision_id,
    current_revision: record.current_revision,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function artifactRevisionToRow(record: ArtifactRevisionRecord): ArtifactRevisionsTable {
  return { id: record.id, artifact_id: record.artifact_id, revision: record.revision, revision_json: stringify(record), content_hash: record.content_hash, file_path: record.file_ref.uri, blob_path: record.blob_ref.uri, created_at: record.created_at };
}

function generatedSurfaceRevisionToRow(record: GeneratedSurfaceRevisionRecord): GeneratedSurfaceRevisionsTable {
  return { id: record.id, surface_id: record.surface_id, revision: record.revision, revision_json: stringify(record), bundle_hash: record.bundle_hash, created_at: record.created_at };
}

function surfaceInteractionToRow(record: SurfaceInteractionRecord): SurfaceInteractionsTable {
  return { id: record.id, surface_id: record.surface_id, revision_id: record.revision_id, session_id: record.session_id, kind: record.kind, interaction_json: stringify(record), created_at: record.created_at };
}

function domainCommandExecutionFromRow(row: DomainCommandExecutionsTable): DomainCommandExecutionRecord {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    command_id: row.command_id,
    input_source: row.input_source,
    payload_hash: row.payload_hash,
    status: row.status as DomainCommandExecutionRecord["status"],
    result: row.result_json === null ? undefined : parse(row.result_json),
    error: row.error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function backendRunToRow(run: BackendRunRecord): BackendRunsTable {
  return {
    id: run.id,
    session_id: run.session_id,
    input_message_id: run.input_message_id,
    output_message_id: run.output_message_id ?? null,
    backend_id: run.backend_id,
    backend_kind: run.backend_kind,
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at ?? null,
    input_summary: run.input_summary,
    output_summary: run.output_summary ?? null,
    error_code: run.error_code ?? null,
    metadata_json: stringify(run.metadata)
  };
}

function backendRunFromRow(row: BackendRunsTable): BackendRunRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    input_message_id: row.input_message_id,
    output_message_id: row.output_message_id ?? undefined,
    backend_id: row.backend_id,
    backend_kind: row.backend_kind as BackendRunRecord["backend_kind"],
    status: row.status as BackendRunRecord["status"],
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    input_summary: row.input_summary,
    output_summary: row.output_summary ?? undefined,
    error_code: row.error_code ?? undefined,
    metadata: parse(row.metadata_json)
  };
}

function clientEventToRow(event: ClientEventRecord): ClientEventsTable {
  return {
    id: event.id,
    target_client_kind: event.target_client_kind,
    target_client_id: event.target_client_id ?? null,
    event_type: event.event_type,
    status: event.status,
    payload_json: stringify(event.payload),
    resource_refs_json: stringify(event.resource_refs),
    created_at: event.created_at,
    delivered_at: event.delivered_at ?? null,
    acked_at: event.acked_at ?? null,
    expires_at: event.expires_at ?? null,
    error_code: event.error_code ?? null
  };
}

function clientEventFromRow(row: ClientEventsTable): ClientEventRecord {
  return {
    id: row.id,
    target_client_kind: row.target_client_kind as ClientEventRecord["target_client_kind"],
    target_client_id: row.target_client_id ?? undefined,
    event_type: row.event_type as ClientEventRecord["event_type"],
    status: row.status as ClientEventRecord["status"],
    payload: parse(row.payload_json),
    resource_refs: parse(row.resource_refs_json),
    created_at: row.created_at,
    delivered_at: row.delivered_at ?? undefined,
    acked_at: row.acked_at ?? undefined,
    expires_at: row.expires_at ?? undefined,
    error_code: row.error_code ?? undefined
  };
}

function resourceTranslationToRow(record: ResourceTranslationRecord): ResourceTranslationsTable {
  return {
    id: record.id,
    source_ref_json: stringify(record.source_ref),
    source_locale: record.source_locale,
    target_locale: record.target_locale,
    status: record.status,
    original_hash: record.original_hash,
    translated_text: record.translated_text,
    provenance_json: record.provenance ? stringify(record.provenance) : null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function resourceTranslationFromRow(row: ResourceTranslationsTable): ResourceTranslationRecord {
  return {
    id: row.id,
    source_ref: parse(row.source_ref_json),
    source_locale: row.source_locale as ResourceTranslationRecord["source_locale"],
    target_locale: row.target_locale as ResourceTranslationRecord["target_locale"],
    status: row.status as ResourceTranslationRecord["status"],
    original_hash: row.original_hash,
    translated_text: row.translated_text,
    provenance: row.provenance_json ? parse(row.provenance_json) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function resourceRefKey(ref: ResourceRef): string {
  return `${ref.kind}:${ref.id ?? ""}:${ref.uri}`;
}

function workspaceChangeToRow(change: WorkspaceChangeRecord): WorkspaceChangesTable {
  return {
    id: change.id,
    run_id: change.run_id,
    session_id: change.session_id,
    resource_ref_json: stringify(change.resource_ref),
    change_type: change.change_type,
    summary: change.summary,
    legacy_operation_id: change.legacy_operation_id ?? null,
    created_at: change.created_at
  };
}

function workspaceChangeFromRow(row: WorkspaceChangesTable): WorkspaceChangeRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    session_id: row.session_id,
    resource_ref: parse(row.resource_ref_json),
    change_type: row.change_type as WorkspaceChangeRecord["change_type"],
    summary: row.summary,
    legacy_operation_id: row.legacy_operation_id ?? undefined,
    created_at: row.created_at
  };
}

function policyDecisionFromRow(row: PolicyDecisionsTable): PolicyDecisionRecord {
  return {
    id: row.id,
    operation_id: row.operation_id,
    capability_id: row.capability_id,
    operation: row.operation,
    decision: row.decision as PolicyDecisionRecord["decision"],
    reason: row.reason,
    policy_inputs: parse(row.policy_inputs_json),
    matched_rules: parse(row.matched_rules_json),
    required_approval_level: row.required_approval_level as PolicyDecisionRecord["required_approval_level"],
    grant_id: row.grant_id ?? undefined,
    created_at: row.created_at
  };
}

function approvalRequestFromRow(row: ApprovalRequestsTable): ApprovalRequest {
  return {
    id: row.id,
    operation_id: row.operation_id,
    requested_level: row.requested_level as ApprovalRequest["requested_level"],
    status: row.status as ApprovalRequest["status"],
    reason: row.reason,
    requested_by: row.requested_by,
    decided_by: row.decided_by ?? undefined,
    created_at: row.created_at,
    expires_at: row.expires_at,
    decided_at: row.decided_at ?? undefined
  };
}

function auditRecordFromRow(row: AuditRecordsTable): AuditRecord {
  return {
    id: row.id,
    actor_identity: row.actor_identity as AuditRecord["actor_identity"],
    operation_id: row.operation_id,
    capability_id: row.capability_id,
    instruction_source: row.instruction_source as AuditRecord["instruction_source"],
    inputs_summary: row.inputs_summary,
    outputs_summary: row.outputs_summary,
    policy_decision_id: row.policy_decision_id,
    affected_resources: parse(row.affected_resources_json),
    rollback_point_id: row.rollback_point_id ?? undefined,
    created_at: row.created_at
  };
}

function rollbackPointFromRow(row: RollbackPointsTable): RollbackPoint {
  return {
    id: row.id,
    operation_id: row.operation_id,
    affected_resources: parse(row.affected_resources_json),
    before_snapshot: parse(row.before_snapshot_json),
    after_snapshot: parse(row.after_snapshot_json),
    reversible: row.reversible === 1,
    irreversible_effects: parse(row.irreversible_effects_json),
    created_at: row.created_at,
    expires_at: row.expires_at
  };
}

function memoryToRow(frontmatter: MemoryFrontmatter, filePath: string): MemoryIndexTable {
  return {
    id: frontmatter.id,
    state: frontmatter.state,
    topic: frontmatter.topic,
    source: frontmatter.source,
    source_locale: frontmatter.source_locale,
    content_locale: frontmatter.content_locale,
    source_kind: frontmatter.source_kind,
    instruction_authority: frontmatter.instruction_authority,
    file_path: filePath,
    frontmatter_json: stringify(frontmatter),
    created_at: frontmatter.created_at,
    updated_at: frontmatter.updated_at
  };
}

function skillToRow(frontmatter: SkillFrontmatter, filePath: string): SkillIndexTable {
  const now = nowIso();
  return {
    id: frontmatter.id,
    state: frontmatter.state,
    title: frontmatter.title,
    description: frontmatter.description,
    tags_json: stringify(frontmatter.tags),
    required_capabilities_json: stringify(frontmatter.required_capabilities),
    file_path: filePath,
    frontmatter_json: stringify(frontmatter),
    created_at: now,
    updated_at: frontmatter.last_reviewed_at ?? now
  };
}

function skillFromRow(row: SkillIndexTable): SkillWithFilePath {
  return {
    ...buildSkillIndexEntry(parse(row.frontmatter_json)),
    file_path: row.file_path
  };
}

function skillUsageToRow(record: SkillUsageRecord): SkillUsageTable {
  return {
    skill_id: record.skill_id,
    use_count: record.use_count,
    last_used_at: record.last_used_at ?? null,
    last_run_id: record.last_run_id ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function skillUsageFromRow(row: SkillUsageTable): SkillUsageRecord {
  return {
    skill_id: row.skill_id,
    use_count: row.use_count,
    last_used_at: row.last_used_at ?? undefined,
    last_run_id: row.last_run_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function containsJapanese(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
}

function learningResourceUseFromRow(row: LearningResourceUseTable): LearningResourceUseRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    session_id: row.session_id,
    resource_kind: row.resource_kind as LearningResourceUseRecord["resource_kind"],
    resource_id: row.resource_id,
    resource_version: row.resource_version ?? undefined,
    content_hash: row.content_hash ?? undefined,
    stage: row.stage as LearningResourceUseRecord["stage"],
    source_operation_id: row.source_operation_id ?? undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at
  };
}

function learningEvaluationFromRow(row: LearningEvaluationTable): LearningEvaluationRecord {
  return {
    id: row.id,
    learning_resource_ref: parse(row.learning_resource_ref_json),
    learning_resource_version: row.learning_resource_version ?? undefined,
    task_class: row.task_class,
    compared_run_ids: parse(row.compared_run_ids_json),
    before_metrics: parse(row.before_metrics_json),
    after_metrics: parse(row.after_metrics_json),
    effect_estimate: row.effect_estimate,
    confidence: row.confidence,
    assessment: row.assessment as LearningEvaluationRecord["assessment"],
    evidence_refs: parse(row.evidence_refs_json),
    evaluator: row.evaluator,
    created_at: row.created_at
  };
}

function learningSnapshotFromRow(row: LearningSnapshotTable): LearningSnapshotRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    path: row.path,
    resource_counts: parse(row.resource_counts_json),
    created_at: row.created_at,
    restored_at: row.restored_at ?? undefined
  };
}

function backgroundReviewChangeFromRow(row: BackgroundReviewChangeTable): BackgroundReviewChangeRecord {
  return {
    id: row.id,
    origin: "background_review",
    source_run_id: row.source_run_id,
    source_session_id: row.source_session_id,
    review_run_id: row.review_run_id,
    mutation_kind: row.mutation_kind as BackgroundReviewChangeRecord["mutation_kind"],
    resource_ref: parse(row.resource_ref_json),
    before_version: row.before_version ?? undefined,
    after_version: row.after_version,
    reason_summary: row.reason_summary,
    evidence_refs: parse(row.evidence_refs_json),
    created_at: row.created_at
  };
}

function defaultCuratorState(): CuratorStateRecord {
  return {
    id: "default",
    paused: false,
    interval_hours: 24 * 7,
    min_idle_hours: 2,
    stale_after_days: 30,
    archive_after_days: 90,
    run_count: 0,
    updated_at: nowIso()
  };
}

function curatorStateToRow(record: CuratorStateRecord): CuratorStateTable {
  return {
    id: record.id,
    paused: record.paused ? 1 : 0,
    interval_hours: record.interval_hours,
    min_idle_hours: record.min_idle_hours,
    stale_after_days: record.stale_after_days,
    archive_after_days: record.archive_after_days,
    last_run_at: record.last_run_at ?? null,
    last_run_summary: record.last_run_summary ?? null,
    run_count: record.run_count,
    updated_at: record.updated_at
  };
}

function curatorStateFromRow(row: CuratorStateTable): CuratorStateRecord {
  return {
    id: "default",
    paused: row.paused === 1,
    interval_hours: row.interval_hours,
    min_idle_hours: row.min_idle_hours,
    stale_after_days: row.stale_after_days,
    archive_after_days: row.archive_after_days,
    last_run_at: row.last_run_at ?? undefined,
    last_run_summary: row.last_run_summary ?? undefined,
    run_count: row.run_count,
    updated_at: row.updated_at
  };
}

function normalizeSkillSupportPath(inputPath: string): string {
  const normalized = path.posix.normalize(inputPath.replaceAll("\\", "/").replace(/^\/+/, ""));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("\0")) {
    throw new Error("skill_support_path_invalid");
  }
  return normalized;
}

async function listRelativeFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(rootDir, absolutePath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, absolutePath));
    }
  }
  return files;
}

async function directoryByteSize(rootDir:string,excludedRoots:string[]=[]):Promise<number>{let total=0;const excluded=new Set(excludedRoots);const walk=async(directory:string,relative="")=>{for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])){const childRelative=relative?path.join(relative,entry.name):entry.name;if(!relative&&excluded.has(entry.name))continue;const absolute=path.join(directory,entry.name);if(entry.isDirectory())await walk(absolute,childRelative);else if(entry.isFile())total+=(await stat(absolute)).size}};await walk(rootDir);return total}

function wikiToRow(frontmatter: WikiFrontmatter, filePath: string): WikiIndexTable {
  return {
    id: frontmatter.id,
    slug: frontmatter.slug,
    title: frontmatter.title,
    state: frontmatter.state,
    content_locale: frontmatter.content_locale,
    tags_json: stringify(frontmatter.tags),
    source_refs_json: stringify(frontmatter.source_refs),
    provenance_json: stringify(frontmatter.provenance),
    file_path: filePath,
    frontmatter_json: stringify(frontmatter),
    created_at: frontmatter.created_at,
    updated_at: frontmatter.updated_at
  };
}

function wikiFromRow(row: WikiIndexTable): WikiWithFilePath {
  return {
    ...parse<WikiFrontmatter>(row.frontmatter_json),
    file_path: row.file_path
  };
}

function collectionSchemaFromRow(row: CollectionSchemasTable): CollectionSchemaWithFilePath {
  return {
    ...parse(row.schema_json),
    file_path: row.file_path
  };
}

function collectionRecordFromRow(row: CollectionRecordsTable): CollectionRecordWithFilePath {
  return {
    ...parse(row.record_json),
    version: row.version,
    file_path: row.file_path
  };
}

function collectionPatchToRow(collectionId: string, patch: CollectionPatch): CollectionPatchesTable {
  return {
    id: patch.id,
    collection_id: collectionId,
    record_id: patch.record_id,
    patch_json: stringify(patch),
    source_operation_id: patch.source_operation_id,
    created_at: patch.created_at
  };
}

function collectionPatchFromRow(row: CollectionPatchesTable): CollectionPatch {
  return parse(row.patch_json);
}

function automationJobToRow(job: AutomationJobRecord): AutomationJobsTable {
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    status: job.status,
    schedule: job.schedule,
    target_instruction: job.target_instruction,
    delivery_target_json: stringify(job.delivery_target),
    next_run_at: job.next_run_at ?? null,
    last_run_at: job.last_run_at ?? null,
    retry_after_at: job.retry_after_at ?? null,
    locked_until: job.locked_until ?? null,
    failure_count: job.failure_count ?? 0,
    max_attempts: job.max_attempts ?? 3,
    last_error: job.last_error ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at
  };
}

function automationJobFromRow(row: AutomationJobsTable): AutomationJobRecord {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as AutomationJobRecord["kind"],
    status: row.status as AutomationJobRecord["status"],
    schedule: row.schedule,
    target_instruction: row.target_instruction,
    delivery_target: parse(row.delivery_target_json),
    next_run_at: row.next_run_at ?? undefined,
    last_run_at: row.last_run_at ?? undefined,
    retry_after_at: row.retry_after_at ?? undefined,
    locked_until: row.locked_until ?? undefined,
    failure_count: row.failure_count,
    max_attempts: row.max_attempts,
    last_error: row.last_error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function externalSendToRow(send: ExternalSendRecord): ExternalSendsTable {
  return {
    id: send.id,
    channel: send.channel,
    status: send.status,
    target_json: stringify(send.target),
    title: send.title,
    body: send.body,
    operation_id: send.operation_id ?? null,
    approval_request_id: send.approval_request_id ?? null,
    dispatch_result_json: send.dispatch_result ? stringify(send.dispatch_result) : null,
    created_at: send.created_at,
    updated_at: send.updated_at,
    dispatched_at: send.dispatched_at ?? null
  };
}

function externalSendFromRow(row: ExternalSendsTable): ExternalSendRecord {
  return {
    id: row.id,
    channel: row.channel as ExternalSendRecord["channel"],
    status: row.status as ExternalSendRecord["status"],
    target: parse(row.target_json),
    title: row.title,
    body: row.body,
    operation_id: row.operation_id ?? undefined,
    approval_request_id: row.approval_request_id ?? undefined,
    dispatch_result: row.dispatch_result_json ? parse(row.dispatch_result_json) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    dispatched_at: row.dispatched_at ?? undefined
  };
}

function gatewayPairingToRow(pairing: GatewayPairingRecord): GatewayPairingsTable {
  return {
    id: pairing.id,
    channel: pairing.channel,
    source_identity: pairing.source_identity,
    source_label: pairing.source_label,
    status: pairing.status,
    pairing_code: pairing.pairing_code ?? null,
    session_key: pairing.session_key,
    metadata_json: stringify(pairing.metadata),
    requested_at: pairing.requested_at,
    expires_at: pairing.expires_at ?? null,
    resolved_at: pairing.resolved_at ?? null,
    updated_at: pairing.updated_at
  };
}

function gatewayPairingFromRow(row: GatewayPairingsTable): GatewayPairingRecord {
  return {
    id: row.id,
    channel: row.channel as GatewayPairingRecord["channel"],
    source_identity: row.source_identity,
    source_label: row.source_label,
    status: row.status as GatewayPairingRecord["status"],
    pairing_code: row.pairing_code ?? undefined,
    session_key: row.session_key,
    metadata: parse(row.metadata_json),
    requested_at: row.requested_at,
    expires_at: row.expires_at ?? undefined,
    resolved_at: row.resolved_at ?? undefined,
    updated_at: row.updated_at
  };
}

function gatewayPairingPolicyToRow(policy: GatewayPairingPolicyRecord): GatewayPairingPoliciesTable {
  return {
    id: policy.id,
    channel: policy.channel,
    status: policy.status,
    trust_mode: policy.trust_mode,
    allowlist_json: stringify(policy.allowlist),
    pairing_ttl_ms: policy.pairing_ttl_ms ?? null,
    duplicate_window_ms: policy.duplicate_window_ms ?? null,
    rate_limit_window_ms: policy.rate_limit_window_ms ?? null,
    rate_limit_max: policy.rate_limit_max ?? null,
    metadata_json: stringify(policy.metadata),
    created_at: policy.created_at,
    updated_at: policy.updated_at
  };
}

function gatewayPairingPolicyFromRow(row: GatewayPairingPoliciesTable): GatewayPairingPolicyRecord {
  return {
    id: row.id,
    channel: row.channel as GatewayPairingPolicyRecord["channel"],
    status: row.status as GatewayPairingPolicyRecord["status"],
    trust_mode: row.trust_mode as GatewayPairingPolicyRecord["trust_mode"],
    allowlist: parse(row.allowlist_json),
    pairing_ttl_ms: row.pairing_ttl_ms ?? undefined,
    duplicate_window_ms: row.duplicate_window_ms ?? undefined,
    rate_limit_window_ms: row.rate_limit_window_ms ?? undefined,
    rate_limit_max: row.rate_limit_max ?? undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function gatewayRoutingPolicyToRow(policy: GatewayRoutingPolicyRecord): GatewayRoutingPoliciesTable {
  return {
    id: policy.id,
    channel: policy.channel,
    status: policy.status,
    session_key_strategy: policy.session_key_strategy,
    default_account_id: policy.default_account_id ?? null,
    default_thread_id: policy.default_thread_id ?? null,
    default_route: policy.default_route,
    metadata_json: stringify(policy.metadata),
    created_at: policy.created_at,
    updated_at: policy.updated_at
  };
}

function gatewayRoutingPolicyFromRow(row: GatewayRoutingPoliciesTable): GatewayRoutingPolicyRecord {
  return {
    id: row.id,
    channel: row.channel as GatewayRoutingPolicyRecord["channel"],
    status: row.status as GatewayRoutingPolicyRecord["status"],
    session_key_strategy: row.session_key_strategy as GatewayRoutingPolicyRecord["session_key_strategy"],
    default_account_id: row.default_account_id ?? undefined,
    default_thread_id: row.default_thread_id ?? undefined,
    default_route: row.default_route,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function gatewayInboundMessageToRow(message: GatewayInboundMessageRecord): GatewayInboundMessagesTable {
  return {
    id: message.id,
    channel: message.channel,
    source_identity: message.source_identity,
    body: message.body,
    status: message.status,
    trusted: message.trusted ? 1 : 0,
    session_key: message.session_key ?? null,
    pairing_id: message.pairing_id ?? null,
    message_id: message.message_id ?? null,
    error: message.error ?? null,
    metadata_json: stringify(message.metadata),
    created_at: message.created_at,
    updated_at: message.updated_at
  };
}

function gatewayInboundMessageFromRow(row: GatewayInboundMessagesTable): GatewayInboundMessageRecord {
  return {
    id: row.id,
    channel: row.channel as GatewayInboundMessageRecord["channel"],
    source_identity: row.source_identity,
    body: row.body,
    status: row.status as GatewayInboundMessageRecord["status"],
    trusted: row.trusted === 1,
    session_key: row.session_key ?? undefined,
    pairing_id: row.pairing_id ?? undefined,
    message_id: row.message_id ?? undefined,
    error: row.error ?? undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function gatewayDeliveryToRow(record:GatewayDeliveryRecord):GatewayDeliveriesTable{return{id:record.id,inbound_id:record.inbound_id??null,session_key:record.session_key,channel:record.channel,status:record.status,idempotency_key:record.idempotency_key,payload_json:stringify(record.payload),attempt:record.attempt,max_attempts:record.max_attempts,next_attempt_at:record.next_attempt_at??null,lease_until:record.lease_until??null,receipt_json:record.receipt?stringify(record.receipt):null,last_error:record.last_error??null,created_at:record.created_at,updated_at:record.updated_at,delivered_at:record.delivered_at??null}}
function gatewayDeliveryFromRow(row:GatewayDeliveriesTable):GatewayDeliveryRecord{return GatewayDeliveryRecordSchema.parse({id:row.id,inbound_id:row.inbound_id??undefined,session_key:row.session_key,channel:row.channel,status:row.status,idempotency_key:row.idempotency_key,payload:parse(row.payload_json),attempt:row.attempt,max_attempts:row.max_attempts,next_attempt_at:row.next_attempt_at??undefined,lease_until:row.lease_until??undefined,receipt:row.receipt_json?parse(row.receipt_json):undefined,last_error:row.last_error??undefined,created_at:row.created_at,updated_at:row.updated_at,delivered_at:row.delivered_at??undefined})}

function gatewayBoundaryPolicyToRow(policy: GatewayBoundaryPolicy): GatewayBoundaryPoliciesTable {
  return {
    id: policy.id,
    source_channel: policy.source_channel,
    source_identity: policy.source_identity ?? null,
    session_key: policy.session_key,
    allowed_tools_json: stringify(policy.allowed_tools),
    mcp_config_refs_json: stringify(policy.mcp_config_refs),
    secret_refs_json: stringify(policy.secret_refs),
    sandbox_json: stringify(policy.sandbox),
    path_normalization_json: stringify(policy.path_normalization),
    allowlist_json: stringify(policy.allowlist),
    timeout_ms: policy.timeout_ms ?? null,
    concurrency_lock_json: policy.concurrency_lock ? stringify(policy.concurrency_lock) : null,
    metadata_json: stringify(policy.metadata),
    created_at: policy.created_at,
    updated_at: policy.updated_at
  };
}

function gatewayBoundaryPolicyFromRow(row: GatewayBoundaryPoliciesTable): GatewayBoundaryPolicy {
  return {
    id: row.id,
    source_channel: row.source_channel as GatewayBoundaryPolicy["source_channel"],
    source_identity: row.source_identity ?? undefined,
    session_key: row.session_key,
    allowed_tools: parse(row.allowed_tools_json),
    mcp_config_refs: parse(row.mcp_config_refs_json),
    secret_refs: parse(row.secret_refs_json),
    sandbox: parse(row.sandbox_json),
    path_normalization: parse(row.path_normalization_json),
    allowlist: parse(row.allowlist_json),
    timeout_ms: row.timeout_ms ?? undefined,
    concurrency_lock: row.concurrency_lock_json ? parse(row.concurrency_lock_json) : undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function gatewayMcpConfigToRow(config: GatewayMcpConfigRecord): GatewayMcpConfigsTable {
  return {
    id: config.id,
    server_name: config.server_name,
    transport: config.transport,
    enabled: config.enabled ? 1 : 0,
    allowed_tools_json: stringify(config.allowed_tools),
    config_ref_json: config.config_ref ? stringify(config.config_ref) : null,
    secret_refs_json: stringify(config.secret_refs),
    stdio_json: config.stdio ? stringify(config.stdio) : null,
    http_json: config.http ? stringify(config.http) : null,
    metadata_json: stringify(config.metadata),
    created_at: config.created_at,
    updated_at: config.updated_at
  };
}

function gatewayMcpConfigFromRow(row: GatewayMcpConfigsTable): GatewayMcpConfigRecord {
  return GatewayMcpConfigRecordSchema.parse({
    id: row.id,
    server_name: row.server_name,
    transport: row.transport,
    enabled: row.enabled === 1,
    allowed_tools: parse(row.allowed_tools_json),
    config_ref: row.config_ref_json ? parse(row.config_ref_json) : undefined,
    secret_refs: parse(row.secret_refs_json),
    stdio: row.stdio_json ? parse(row.stdio_json) : undefined,
    http: row.http_json ? parse(row.http_json) : undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function gatewayConcurrencyLockToRow(lock: GatewayConcurrencyLockRecord): GatewayConcurrencyLocksTable {
  return {
    id: lock.id,
    lock_key: lock.lock_key,
    scope: lock.scope,
    policy_id: lock.policy_id ?? null,
    owner_ref_json: lock.owner_ref ? stringify(lock.owner_ref) : null,
    status: lock.status,
    acquired_at: lock.acquired_at,
    expires_at: lock.expires_at,
    released_at: lock.released_at ?? null,
    metadata_json: stringify(lock.metadata)
  };
}

function gatewayConcurrencyLockFromRow(row: GatewayConcurrencyLocksTable): GatewayConcurrencyLockRecord {
  return {
    id: row.id,
    lock_key: row.lock_key,
    scope: row.scope as GatewayConcurrencyLockRecord["scope"],
    policy_id: row.policy_id ?? undefined,
    owner_ref: row.owner_ref_json ? parse(row.owner_ref_json) : undefined,
    status: row.status as GatewayConcurrencyLockRecord["status"],
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    released_at: row.released_at ?? undefined,
    metadata: parse(row.metadata_json)
  };
}

function gatewaySandboxInstanceToRow(instance: GatewaySandboxInstanceRecord): GatewaySandboxInstancesTable {
  return {
    id: instance.id,
    instance_key: instance.instance_key,
    scope: instance.scope,
    backend: instance.backend,
    status: instance.status,
    sandbox_json: stringify(instance.sandbox),
    session_key: instance.session_key ?? null,
    owner_ref_json: instance.owner_ref ? stringify(instance.owner_ref) : null,
    workspace_root: instance.workspace_root ?? null,
    created_at: instance.created_at,
    updated_at: instance.updated_at,
    last_used_at: instance.last_used_at ?? null,
    deleted_at: instance.deleted_at ?? null,
    metadata_json: stringify(instance.metadata)
  };
}

function gatewaySandboxInstanceFromRow(row: GatewaySandboxInstancesTable): GatewaySandboxInstanceRecord {
  return GatewaySandboxInstanceRecordSchema.parse({
    id: row.id,
    instance_key: row.instance_key,
    scope: row.scope,
    backend: row.backend,
    status: row.status,
    sandbox: parse(row.sandbox_json),
    session_key: row.session_key ?? undefined,
    owner_ref: row.owner_ref_json ? parse(row.owner_ref_json) : undefined,
    workspace_root: row.workspace_root ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at ?? undefined,
    deleted_at: row.deleted_at ?? undefined,
    metadata: parse(row.metadata_json)
  });
}

function gatewaySandboxWorkspaceSyncToRow(sync: GatewaySandboxWorkspaceSyncRecord): GatewaySandboxWorkspaceSyncsTable {
  return {
    id: sync.id,
    instance_id: sync.instance_id,
    instance_key: sync.instance_key,
    direction: sync.direction,
    status: sync.status,
    workspace_root: sync.workspace_root ?? null,
    remote_workspace_root: sync.remote_workspace_root ?? null,
    file_count: sync.file_count ?? null,
    byte_count: sync.byte_count ?? null,
    error: sync.error ?? null,
    started_at: sync.started_at,
    completed_at: sync.completed_at ?? null,
    metadata_json: stringify(sync.metadata)
  };
}

function gatewaySandboxWorkspaceSyncFromRow(row: GatewaySandboxWorkspaceSyncsTable): GatewaySandboxWorkspaceSyncRecord {
  return GatewaySandboxWorkspaceSyncRecordSchema.parse({
    id: row.id,
    instance_id: row.instance_id,
    instance_key: row.instance_key,
    direction: row.direction,
    status: row.status,
    workspace_root: row.workspace_root ?? undefined,
    remote_workspace_root: row.remote_workspace_root ?? undefined,
    file_count: row.file_count ?? undefined,
    byte_count: row.byte_count ?? undefined,
    error: row.error ?? undefined,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    metadata: parse(row.metadata_json)
  });
}

function automationRunToRow(run: AutomationRunRecord): AutomationRunsTable {
  return {
    id: run.id,
    kind: run.kind,
    source: run.source,
    session_id: run.session_id ?? null,
    backend_run_id: run.backend_run_id ?? null,
    status: run.status,
    operation_id: run.operation_id ?? null,
    started_at: run.started_at,
    completed_at: run.completed_at ?? null,
    error: run.error ?? null
  };
}

function automationRunFromRow(row: AutomationRunsTable): AutomationRunRecord {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    session_id: row.session_id ?? undefined,
    backend_run_id: row.backend_run_id ?? undefined,
    status: row.status as AutomationRunRecord["status"],
    operation_id: row.operation_id ?? undefined,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    error: row.error ?? undefined
  };
}

function reflectionRunToRow(run: ReflectionRunRecord): ReflectionRunsTable {
  return {
    id: run.id,
    kind: run.kind,
    source_run_id: run.source_run_id ?? null,
    session_id: run.session_id ?? null,
    status: run.status,
    input_summary: run.input_summary,
    output_summary: run.output_summary ?? null,
    started_at: run.started_at,
    completed_at: run.completed_at ?? null,
    error: run.error ?? null
  };
}

function reflectionRunFromRow(row: ReflectionRunsTable): ReflectionRunRecord {
  return {
    id: row.id,
    kind: row.kind as ReflectionRunRecord["kind"],
    source_run_id: row.source_run_id ?? undefined,
    session_id: row.session_id ?? undefined,
    status: row.status as ReflectionRunRecord["status"],
    input_summary: row.input_summary,
    output_summary: row.output_summary ?? undefined,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    error: row.error ?? undefined
  };
}

function reflectionSuggestionToRow(suggestion: ReflectionSuggestionRecord): ReflectionSuggestionsTable {
  return {
    id: suggestion.id,
    reflection_run_id: suggestion.reflection_run_id,
    suggestion_type: suggestion.suggestion_type,
    status: suggestion.status,
    title: suggestion.title,
    content: suggestion.content,
    target_ref_json: suggestion.target_ref ? stringify(suggestion.target_ref) : null,
    source_refs_json: stringify(suggestion.source_refs),
    confidence: suggestion.confidence,
    created_at: suggestion.created_at,
    updated_at: suggestion.updated_at
  };
}

function reflectionSuggestionFromRow(row: ReflectionSuggestionsTable): ReflectionSuggestionRecord {
  return {
    id: row.id,
    reflection_run_id: row.reflection_run_id,
    suggestion_type: row.suggestion_type as ReflectionSuggestionRecord["suggestion_type"],
    status: row.status as ReflectionSuggestionRecord["status"],
    title: row.title,
    content: row.content,
    target_ref: row.target_ref_json ? parse(row.target_ref_json) : undefined,
    source_refs: parse(row.source_refs_json),
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toolRunToRow(run: ToolRunRecord): ToolRunsTable {
  return {
    id: run.id,
    run_id: run.run_id,
    session_id: run.session_id,
    tool_call_id: run.tool_call_id ?? null,
    provider_tool_name: run.provider_tool_name,
    action_id: run.action_id ?? null,
    status: run.status,
    input_summary: run.input_summary,
    output_summary: run.output_summary,
    resource_refs_json: stringify(run.resource_refs),
    created_at: run.created_at
  };
}

function toolRunFromRow(row: ToolRunsTable): ToolRunRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    session_id: row.session_id,
    tool_call_id: row.tool_call_id ?? undefined,
    provider_tool_name: row.provider_tool_name,
    action_id: row.action_id ?? undefined,
    status: row.status as ToolRunRecord["status"],
    input_summary: row.input_summary,
    output_summary: row.output_summary,
    resource_refs: parse(row.resource_refs_json),
    created_at: row.created_at
  };
}

function messagePresentationToRow(presentation: MessagePresentationRecord): MessagePresentationsTable {
  return {
    id: presentation.id,
    session_id: presentation.session_id,
    message_id: presentation.message_id,
    kind: presentation.kind,
    title: presentation.title,
    subtitle: presentation.subtitle,
    collection_id: presentation.collection_id,
    view_id: presentation.view_id,
    renderer: presentation.renderer,
    view_state_json: presentation.view_state ? stringify(presentation.view_state) : null,
    surface_id: presentation.surface_id ?? null,
    revision_id: presentation.revision_id ?? null,
    preview_url: presentation.preview_url ?? null,
    created_at: presentation.created_at,
    updated_at: presentation.updated_at
  };
}

function messagePresentationFromRow(row: MessagePresentationsTable): MessagePresentationRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    message_id: row.message_id,
    kind: row.kind === "generated_surface" ? "generated_surface" : row.kind === "skill_optimization" ? "skill_optimization" : "collection_app",
    title: row.title,
    subtitle: row.subtitle,
    collection_id: row.collection_id,
    view_id: row.view_id,
    renderer: row.renderer,
    view_state: row.view_state_json ? parse<Record<string, JsonValue>>(row.view_state_json) : undefined,
    ...(row.surface_id ? { surface_id: row.surface_id } : {}),
    ...(row.revision_id ? { revision_id: row.revision_id } : {}),
    ...(row.preview_url ? { preview_url: row.preview_url } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function normalizeToolRunDiagnosticsLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.trunc(limit)));
}

function groupToolRunDiagnostics(toolRuns: ToolRunRecord[]): ToolRunDiagnosticsGroup[] {
  const groups = new Map<string, {
    provider_tool_name: string;
    action_id?: string;
    status: ToolRunStatus;
    count: number;
    latest_tool_run: ToolRunRecord;
    reasons: Map<string, number>;
  }>();

  for (const toolRun of toolRuns) {
    const key = `${toolRun.provider_tool_name}\u0000${toolRun.action_id ?? ""}\u0000${toolRun.status}`;
    const existing = groups.get(key);
    const reason = toolRun.output_summary || "unknown";
    if (existing) {
      existing.count += 1;
      existing.reasons.set(reason, (existing.reasons.get(reason) ?? 0) + 1);
      if (toolRun.created_at > existing.latest_tool_run.created_at) {
        existing.latest_tool_run = toolRun;
      }
      continue;
    }
    groups.set(key, {
      provider_tool_name: toolRun.provider_tool_name,
      action_id: toolRun.action_id,
      status: toolRun.status,
      count: 1,
      latest_tool_run: toolRun,
      reasons: new Map([[reason, 1]])
    });
  }

  return [...groups.values()]
    .map((group) => ({
      provider_tool_name: group.provider_tool_name,
      ...(group.action_id ? { action_id: group.action_id } : {}),
      status: group.status,
      count: group.count,
      latest_tool_run: group.latest_tool_run,
      reasons: [...group.reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    }))
    .sort((a, b) => b.count - a.count || b.latest_tool_run.created_at.localeCompare(a.latest_tool_run.created_at));
}

function normalizeExternalAssistDiagnosticsLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.trunc(limit)));
}

function groupExternalAssistDiagnostics(records: ExternalAssistRecord[]): ExternalAssistDiagnosticsGroup[] {
  const groups = new Map<string, {
    provider_id: string;
    phase: ExternalAssistPhase;
    status: ExternalAssistStatus;
    count: number;
    hint_count: number;
    latest_record: ExternalAssistRecord;
  }>();

  for (const record of records) {
    const key = `${record.provider_id}\u0000${record.phase}\u0000${record.status}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.hint_count += record.hints.length;
      if (record.created_at > existing.latest_record.created_at) {
        existing.latest_record = record;
      }
      continue;
    }
    groups.set(key, {
      provider_id: record.provider_id,
      phase: record.phase,
      status: record.status,
      count: 1,
      hint_count: record.hints.length,
      latest_record: record
    });
  }

  return [...groups.values()].sort((a, b) =>
    b.count - a.count || b.latest_record.created_at.localeCompare(a.latest_record.created_at)
  );
}

function externalAssistDiagnosticsViolations(records: ExternalAssistRecord[]): ExternalAssistDiagnosticsReport["violations"] {
  return records.flatMap((record) => {
    const violations: ExternalAssistDiagnosticsReport["violations"] = [];
    if (!record.isolated_from_memory) {
      violations.push({
        code: "external_assist_not_isolated",
        record_id: record.id,
        provider_id: record.provider_id,
        phase: record.phase,
        status: record.status,
        message: "External Assist record must stay isolated from Memory and Knowledge Wiki source-of-truth records."
      });
    }
    if (record.included_in_active_memory) {
      violations.push({
        code: "external_assist_included_in_active_memory",
        record_id: record.id,
        provider_id: record.provider_id,
        phase: record.phase,
        status: record.status,
        message: "External Assist record must not be included in active Memory retrieval."
      });
    }
    return violations;
  });
}

function externalAssistDiagnosticsRecommendation(records: ExternalAssistRecord[], violations: ExternalAssistDiagnosticsReport["violations"]): string {
  if (violations.length > 0) {
    return "External Assist crossed the Memory isolation boundary. Keep provider hints as unverified context only and review the affected records.";
  }
  if (records.some((record) => record.status === "failed")) {
    return "External Assist stayed isolated, but recent provider failures should be reviewed before relying on those hints.";
  }
  if (records.length === 0) {
    return "No External Assist records were found in the selected scope.";
  }
  return "External Assist records are isolated from Memory and available as unverified assistive context.";
}

function externalAssistRecordToRow(record: ExternalAssistRecord): ExternalAssistRecordsTable {
  return {
    id: record.id,
    phase: record.phase,
    status: record.status,
    provider_id: record.provider_id,
    session_id: record.session_id,
    run_id: record.run_id ?? null,
    input_message_id: record.input_message_id ?? null,
    query: record.query,
    role: record.role,
    hints_json: stringify(record.hints),
    error: record.error ?? null,
    isolated_from_memory: record.isolated_from_memory ? 1 : 0,
    included_in_active_memory: record.included_in_active_memory ? 1 : 0,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function externalAssistRecordFromRow(row: ExternalAssistRecordsTable): ExternalAssistRecord {
  return ExternalAssistRecordSchema.parse({
    id: row.id,
    phase: row.phase,
    status: row.status,
    provider_id: row.provider_id,
    session_id: row.session_id,
    run_id: row.run_id ?? undefined,
    input_message_id: row.input_message_id ?? undefined,
    query: row.query,
    role: row.role,
    hints: parse(row.hints_json),
    error: row.error ?? undefined,
    isolated_from_memory: Boolean(row.isolated_from_memory),
    included_in_active_memory: Boolean(row.included_in_active_memory),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function migrationJournalFromRow(row: MigrationJournalTable): MigrationJournalRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status as MigrationJournalRecord["status"],
    details: parse(row.details_json),
    created_at: row.created_at
  };
}

function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && /duplicate column name/i.test(error.message);
}

function artifactFromRow(row: ArtifactsTable): ArtifactRecord {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as ArtifactRecord["kind"],
    locale: row.locale as ArtifactRecord["locale"],
    source_locales: parse(row.source_locales_json),
    file_ref: parse(row.file_ref_json),
    metadata: parse(row.metadata_json),
    source_operation_id: row.source_operation_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function artifactContentTypeFromMetadata(artifact: ArtifactRecord): string {
  const contentType = artifact.metadata.content_type;
  return typeof contentType === "string" ? contentType : "text/markdown";
}

function isTextArtifactContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/markdown";
}

function safeArtifactExtension(extension: string): string {
  const normalized = extension.trim().replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9]+$/.test(normalized)) {
    throw new Error("artifact_extension_invalid");
  }
  return normalized;
}

function grantFromRow(row: GrantsTable): GrantRecord {
  return {
    id: row.id,
    capability_id: row.capability_id,
    operation: row.operation,
    actor_identity: row.actor_identity as GrantRecord["actor_identity"],
    channel: row.channel,
    resource_scope: row.resource_scope,
    manifest_version: row.manifest_version,
    risk_snapshot: row.risk_snapshot as GrantRecord["risk_snapshot"],
    scope_snapshot: row.scope_snapshot as GrantRecord["scope_snapshot"],
    external_impact_snapshot: row.external_impact_snapshot === 1,
    secret_requirement_snapshot: row.secret_requirement_snapshot,
    granted_by: row.granted_by,
    reason: row.reason,
    created_at: row.created_at,
    expires_at: row.expires_at ?? undefined,
    revoked_at: row.revoked_at ?? undefined
  };
}

export type { ActivityInboxItem };
