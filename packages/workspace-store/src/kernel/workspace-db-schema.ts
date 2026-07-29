/** SQLite row shapes owned by the Workspace persistence kernel. */
export type JsonColumn = string;

export interface SessionsTable { id: string; session_key: string; title: string; ui_locale: string; output_locale: string; created_at: string; updated_at: string; }
export interface MessagesTable { id: string; session_id: string; role: "user" | "agent" | "system"; content: string; input_locale: string; output_locale: string; envelope_json: JsonColumn | null; created_at: string; }
export interface MessagePresentationsTable { id: string; session_id: string; message_id: string; kind: string; title: string; subtitle: string; collection_id: string; view_id: string; renderer: string; view_state_json: JsonColumn | null; surface_id: string | null; revision_id: string | null; preview_url: string | null; created_at: string; updated_at: string; }
export interface SkillOptimizationRunsTable { id: string; target_skill_id: string; session_id: string | null; status: string; run_json: JsonColumn; created_at: string; updated_at: string; }
export interface SkillOptimizationDatasetsTable { id: string; skill_id: string; dataset_json: JsonColumn; created_at: string; }
export interface OptimizationCandidatesTable { id: string; run_id: string; skill_id: string; content_hash: string; body: string; candidate_json: JsonColumn; created_at: string; updated_at: string; }
export interface OptimizationEvaluationsTable { id: string; run_id: string; candidate_id: string; evaluation_json: JsonColumn; created_at: string; }
export interface OptimizationPromotionsTable { id: string; run_id: string; candidate_id: string; skill_id: string; promotion_json: JsonColumn; created_at: string; }
export interface SkillOptimizationSnapshotsTable { id: string; skill_id: string; candidate_id: string; content_hash: string; markdown: string; snapshot_json: JsonColumn; created_at: string; restored_at: string | null; }
export interface SkillOptimizationLocksTable { skill_id: string; run_id: string; acquired_at: string; }
export interface OperationsTable { id: string; session_id: string; capability_id: string; operation: string; actor_identity: string; instruction_source: string; instruction_authority: string; channel: string; input_hash: string; input_ref_json: JsonColumn | null; target_resource_refs_json: JsonColumn; proposed_effects_json: JsonColumn; status: string; policy_decision_id: string | null; approval_request_id: string | null; result_ref_json: JsonColumn | null; error: string | null; correlation_id: string | null; created_at: string; updated_at: string; }
export interface DomainCommandExecutionsTable { id: string; idempotency_key: string; command_id: string; input_source: string; correlation_id: string; payload_hash: string; phase: string; status: string; result_json: JsonColumn | null; error: string | null; heartbeat_at: string; created_at: string; updated_at: string; }
export interface ObjectivesTable { id: string; session_id: string | null; title: string; objective: string; completion_criteria_json: JsonColumn; status: string; token_budget: number | null; time_budget_ms: number | null; max_attempts: number | null; current_checkpoint_id: string | null; created_at: string; updated_at: string; completed_at: string | null; }
export interface WorkItemsTable { id: string; objective_id: string; parent_work_item_id: string | null; instruction: string; status: string; priority: number; attempt: number; max_attempts: number; idempotency_key: string; lease_owner: string | null; lease_expires_at: string | null; heartbeat_at: string | null; retry_after_at: string | null; backend_run_id: string | null; current_checkpoint_id: string | null; failure_kind: string | null; error: string | null; created_at: string; updated_at: string; started_at: string | null; completed_at: string | null; }
export interface WorkDependenciesTable { id: string; objective_id: string; predecessor_work_item_id: string; successor_work_item_id: string; kind: string; created_at: string; }
export interface RunCheckpointsTable { id: string; objective_id: string; work_item_id: string; sequence: number; phase: string; idempotency_key: string; backend_run_id: string | null; backend_session_id: string | null; event_cursor: number | null; summary: string; generated_resource_refs_json: JsonColumn; pending_operation_ids_json: JsonColumn; state_json: JsonColumn; created_at: string; }
export interface WorkspaceFileTransactionsTable { id: string; kind: string; status: string; target_path: string; staged_path: string; collection_id: string | null; record_id: string | null; patch_id: string | null; before_json: JsonColumn; after_json: JsonColumn; created_at: string; updated_at: string; }
export interface GeneratedSurfacesTable { id: string; state: string; session_id: string; title: string; definition_json: JsonColumn; content_hash: string; current_revision_id: string; current_revision: number; created_at: string; updated_at: string; }
export interface ArtifactRevisionsTable { id: string; artifact_id: string; revision: number; revision_json: JsonColumn; content_hash: string; file_path: string; blob_path: string; created_at: string; }
export interface GeneratedSurfaceRevisionsTable { id: string; surface_id: string; revision: number; revision_json: JsonColumn; bundle_hash: string; created_at: string; }
export interface SurfaceInteractionsTable { id: string; surface_id: string; revision_id: string; session_id: string; kind: string; interaction_json: JsonColumn; created_at: string; }
export interface PolicyDecisionsTable { id: string; operation_id: string; capability_id: string; operation: string; decision: string; reason: string; policy_inputs_json: JsonColumn; matched_rules_json: JsonColumn; required_approval_level: string; grant_id: string | null; created_at: string; }
export interface ApprovalRequestsTable { id: string; operation_id: string; requested_level: string; status: string; reason: string; requested_by: string; decided_by: string | null; created_at: string; expires_at: string; decided_at: string | null; }
export interface AuditRecordsTable { id: string; actor_identity: string; operation_id: string; capability_id: string; instruction_source: string; inputs_summary: string; outputs_summary: string; policy_decision_id: string; affected_resources_json: JsonColumn; rollback_point_id: string | null; created_at: string; }
export interface RollbackPointsTable { id: string; operation_id: string; affected_resources_json: JsonColumn; before_snapshot_json: JsonColumn; after_snapshot_json: JsonColumn; reversible: number; irreversible_effects_json: JsonColumn; created_at: string; expires_at: string; }
export interface ArtifactsTable { id: string; title: string; kind: string; locale: string; source_locales_json: JsonColumn; file_ref_json: JsonColumn; metadata_json: JsonColumn; source_operation_id: string; created_by: string; created_at: string; updated_at: string; }
export interface MemoryIndexTable { id: string; state: string; topic: string; source: string; source_locale: string; content_locale: string; source_kind: string; instruction_authority: string; file_path: string; frontmatter_json: JsonColumn; created_at: string; updated_at: string; }
export interface SkillIndexTable { id: string; state: string; title: string; description: string; tags_json: JsonColumn; required_capabilities_json: JsonColumn; file_path: string; frontmatter_json: JsonColumn; created_at: string; updated_at: string; }
export interface SkillUsageTable { skill_id: string; use_count: number; last_used_at: string | null; last_run_id: string | null; created_at: string; updated_at: string; }
export interface LearningResourceUseTable { id: string; run_id: string; session_id: string; resource_kind: string; resource_id: string; resource_version: string | null; content_hash: string | null; stage: string; source_operation_id: string | null; metadata_json: JsonColumn; created_at: string; }
export interface LearningEvaluationTable { id: string; learning_resource_ref_json: JsonColumn; learning_resource_version: string | null; task_class: string; compared_run_ids_json: JsonColumn; before_metrics_json: JsonColumn; after_metrics_json: JsonColumn; effect_estimate: number; confidence: number; assessment: string; evidence_refs_json: JsonColumn; evaluator: string; created_at: string; }
export interface LearningSnapshotTable { id: string; run_id: string; path: string; resource_counts_json: JsonColumn; created_at: string; restored_at: string | null; }
export interface BackgroundReviewChangeTable { id: string; origin: string; source_run_id: string; source_session_id: string; review_run_id: string; mutation_kind: string; resource_ref_json: JsonColumn; before_version: string | null; after_version: string; reason_summary: string; evidence_refs_json: JsonColumn; created_at: string; }
export interface LearningJobReportTable { id: string; job_kind: string; run_id: string; report_json: JsonColumn; created_at: string; }
export interface CuratorStateTable { id: string; paused: number; interval_hours: number; min_idle_hours: number; stale_after_days: number; archive_after_days: number; last_run_at: string | null; last_run_summary: string | null; run_count: number; updated_at: string; }
export interface WikiIndexTable { id: string; slug: string; title: string; state: string; content_locale: string; tags_json: JsonColumn; source_refs_json: JsonColumn; provenance_json: JsonColumn; file_path: string; frontmatter_json: JsonColumn; created_at: string; updated_at: string; }
export interface CollectionSchemasTable { id: string; version: string; file_path: string; schema_json: JsonColumn; updated_at: string; }
export interface CollectionRecordsTable { id: string; collection_id: string; file_path: string; record_json: JsonColumn; version: number; created_at: string; updated_at: string; }
export interface CollectionPatchesTable { id: string; collection_id: string; record_id: string; patch_json: JsonColumn; source_operation_id: string; created_at: string; }
export interface AutomationRunsTable { id: string; kind: string; source: string; session_id: string | null; backend_run_id: string | null; status: string; operation_id: string | null; started_at: string; completed_at: string | null; error: string | null; }
export interface AutomationJobsTable { id: string; title: string; kind: string; status: string; schedule: string; target_instruction: string; delivery_target_json: JsonColumn; next_run_at: string | null; last_run_at: string | null; retry_after_at: string | null; locked_until: string | null; failure_count: number; max_attempts: number; last_error: string | null; created_at: string; updated_at: string; }
export interface ExternalSendsTable { id: string; channel: string; status: string; target_json: JsonColumn; title: string; body: string; operation_id: string | null; approval_request_id: string | null; dispatch_result_json: JsonColumn | null; created_at: string; updated_at: string; dispatched_at: string | null; }
export interface GatewayPairingsTable { id: string; channel: string; source_identity: string; source_label: string; status: string; pairing_code: string | null; session_key: string; metadata_json: JsonColumn; requested_at: string; expires_at: string | null; resolved_at: string | null; updated_at: string; }
export interface GatewayPairingPoliciesTable { id: string; channel: string; status: string; trust_mode: string; allowlist_json: JsonColumn; allowed_tools_json: JsonColumn; pairing_ttl_ms: number | null; duplicate_window_ms: number | null; rate_limit_window_ms: number | null; rate_limit_max: number | null; metadata_json: JsonColumn; created_at: string; updated_at: string; }
export interface GatewayRoutingPoliciesTable { id: string; channel: string; status: string; session_key_strategy: string; default_account_id: string | null; default_thread_id: string | null; default_route: string; metadata_json: JsonColumn; created_at: string; updated_at: string; }
export interface GatewayInboundMessagesTable { id: string; channel: string; source_identity: string; body: string; status: string; trusted: number; session_key: string | null; pairing_id: string | null; message_id: string | null; error: string | null; metadata_json: JsonColumn; created_at: string; updated_at: string; }
export interface GatewayDeliveriesTable { id: string; inbound_id: string | null; session_key: string; channel: string; status: string; idempotency_key: string; payload_json: JsonColumn; attempt: number; max_attempts: number; next_attempt_at: string | null; lease_until: string | null; receipt_json: JsonColumn | null; last_error: string | null; created_at: string; updated_at: string; delivered_at: string | null; }
export interface GatewayBoundaryPoliciesTable { id: string; source_channel: string; source_identity: string | null; session_key: string; allowed_tools_json: JsonColumn; mcp_config_refs_json: JsonColumn; secret_refs_json: JsonColumn; sandbox_json: JsonColumn; path_normalization_json: JsonColumn; allowlist_json: JsonColumn; timeout_ms: number | null; concurrency_lock_json: JsonColumn | null; metadata_json: JsonColumn; created_at: string; updated_at: string; }
export interface GatewayMcpConfigsTable { id: string; server_name: string; transport: string; enabled: number; allowed_tools_json: JsonColumn; config_ref_json: JsonColumn | null; secret_refs_json: JsonColumn; stdio_json: JsonColumn | null; http_json: JsonColumn | null; metadata_json: JsonColumn; created_at: string; updated_at: string; }
export interface GatewayConcurrencyLocksTable { id: string; lock_key: string; scope: string; policy_id: string | null; owner_ref_json: JsonColumn | null; status: string; acquired_at: string; expires_at: string; released_at: string | null; metadata_json: JsonColumn; }
export interface GatewaySandboxInstancesTable { id: string; instance_key: string; scope: string; backend: string; status: string; sandbox_json: JsonColumn; session_key: string | null; owner_ref_json: JsonColumn | null; workspace_root: string | null; created_at: string; updated_at: string; last_used_at: string | null; deleted_at: string | null; metadata_json: JsonColumn; }
export interface GatewaySandboxWorkspaceSyncsTable { id: string; instance_id: string; instance_key: string; direction: string; status: string; workspace_root: string | null; remote_workspace_root: string | null; file_count: number | null; byte_count: number | null; error: string | null; started_at: string; completed_at: string | null; metadata_json: JsonColumn; }
export interface ReflectionRunsTable { id: string; kind: string; source_run_id: string | null; session_id: string | null; status: string; input_summary: string; output_summary: string | null; started_at: string; completed_at: string | null; error: string | null; }
export interface ReflectionSuggestionsTable { id: string; reflection_run_id: string; suggestion_type: string; status: string; title: string; content: string; target_ref_json: JsonColumn | null; source_refs_json: JsonColumn; confidence: number; created_at: string; updated_at: string; }
export interface ToolRunsTable { id: string; run_id: string; session_id: string; tool_call_id: string | null; provider_tool_name: string; action_id: string | null; status: string; input_summary: string; output_summary: string; error_code: string | null; resource_refs_json: JsonColumn; created_at: string; }
export interface ExternalAssistRecordsTable { id: string; phase: string; status: string; provider_id: string; session_id: string; run_id: string | null; input_message_id: string | null; query: string; role: string; hints_json: JsonColumn; error: string | null; isolated_from_memory: number; included_in_active_memory: number; created_at: string; updated_at: string; }
export interface SettingsTable { id: "default"; ui_locale: string; output_locale: string; memory_capture_mode: string; knowledge_wiki_capture_mode: string; llm_wiki_capture_mode?: string; skill_capture_mode: string; external_provider_role: string; default_backend_id: string | null; updated_at: string; }
export interface PluginStatesTable { manifest_id: string; enabled: number; version: string; updated_at: string; }
export interface MigrationJournalTable { id: string; name: string; status: string; details_json: JsonColumn; created_at: string; }
export interface GrantsTable { id: string; capability_id: string; operation: string; actor_identity: string; channel: string; resource_scope: string; manifest_version: string; risk_snapshot: string; scope_snapshot: string; external_impact_snapshot: number; secret_requirement_snapshot: string; granted_by: string; reason: string; created_at: string; expires_at: string | null; revoked_at: string | null; }
export interface BackendRunsTable { id: string; session_id: string; input_message_id: string; output_message_id: string | null; backend_id: string; backend_kind: string; backend_session_id: string | null; status: string; phase: string | null; current_attempt: number | null; request_idempotency_key: string | null; request_hash: string | null; started_at: string; completed_at: string | null; input_summary: string; output_summary: string | null; error_code: string | null; metadata_json: JsonColumn; }
export interface BackendEventsTable { id: string; run_id: string; session_id: string; backend_session_id: string | null; event_type: string; sequence: number; attempt_no: number | null; source_event_id: string | null; source_sequence: number | null; payload_json: JsonColumn; resource_refs_json: JsonColumn; created_at: string; }
export interface SessionRunReservationsTable { session_id: string; run_id: string; status: string; version: number; held_at: string; released_at: string | null; }
export interface ClientEventsTable { id: string; target_client_kind: string; target_client_id: string | null; event_type: string; status: string; payload_json: JsonColumn; resource_refs_json: JsonColumn; created_at: string; delivered_at: string | null; acked_at: string | null; expires_at: string | null; error_code: string | null; }
export interface WorkspaceChangesTable { id: string; run_id: string; session_id: string; resource_ref_json: JsonColumn; change_type: string; summary: string; legacy_operation_id: string | null; correlation_id: string | null; created_at: string; }
export interface ResourceTranslationsTable { id: string; source_ref_json: JsonColumn; source_locale: string; target_locale: string; status: string; original_hash: string; translated_text: string; provenance_json: JsonColumn | null; created_at: string; updated_at: string; }

export interface WorkspaceDb {
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
  skill_usage: SkillUsageTable;
  learning_resource_uses: LearningResourceUseTable;
  learning_evaluations: LearningEvaluationTable;
  learning_snapshots: LearningSnapshotTable;
  background_review_changes: BackgroundReviewChangeTable;
  learning_job_reports: LearningJobReportTable;
  curator_state: CuratorStateTable;
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
  gateway_deliveries: GatewayDeliveriesTable;
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
  session_run_reservations: SessionRunReservationsTable;
  backend_events: BackendEventsTable;
  client_events: ClientEventsTable;
  workspace_changes: WorkspaceChangesTable;
  resource_translations: ResourceTranslationsTable;
  migration_journal: MigrationJournalTable;
}
