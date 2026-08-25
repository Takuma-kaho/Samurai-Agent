import { describe, expect, it } from "vitest";
import { workspaceServerMigrationDefinitions, workspaceServerMigrationStatus } from "./schema";

describe("Workspace Server PostgreSQL schema", () => {
  it("defines tenant RLS for records, files, history, jobs, and notifications", () => {
    const migrations = workspaceServerMigrationDefinitions();
    const schema = migrations.flatMap((migration) => migration.statements).join("\n");

    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
    expect(workspaceServerMigrationStatus().map((migration) => migration.version)).toEqual(migrations.map((migration) => migration.version));
    for (const table of ["workspace_records", "workspace_files", "workspace_events", "workspace_jobs", "workspace_operations"]) {
      expect(schema).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(schema).toContain(`workspace_id`);
    }
    expect(schema).toContain("samurai_current_workspace_id()");
    expect(schema).toContain("samurai_can_room(workspace_id, room_id, 'read')");
    expect(schema).toContain("source_event_id");
    expect(schema).toContain("account_operations");
    expect(schema).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_owner_role_escalation_guards");
    expect(schema).toContain("workspace_last_owner_cannot_be_revoked");
    expect(schema).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    expect(schema).toContain("samurai_workspace_is_writable");
    expect(schema).toContain("samurai_record_workspace_transfer_receipt");
    expect(schema).toContain("samurai_append_workspace_audit");
    expect(schema).toContain("samurai_list_completion_maintenance_identities");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_gateway_runtime_state");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_skill_optimization_state");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_gateway_policy_metadata_columns");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_import_resume_capability");
    for (const table of [
      "workspace_gateway_pairings", "workspace_gateway_pairing_policies", "workspace_gateway_routing_policies",
      "workspace_gateway_inbound_messages", "workspace_gateway_deliveries", "workspace_gateway_boundary_policies",
      "workspace_gateway_mcp_configs", "workspace_gateway_concurrency_locks", "workspace_gateway_sandbox_instances",
      "workspace_gateway_sandbox_syncs", "workspace_skill_optimization_runs", "workspace_skill_optimization_datasets",
      "workspace_skill_optimization_objectives", "workspace_skill_optimization_work_items", "workspace_skill_optimization_candidates",
      "workspace_skill_optimization_evaluations", "workspace_skill_optimization_promotions", "workspace_skill_optimization_snapshots",
      "workspace_skill_optimization_locks"
    ]) {
      expect(schema).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(schema).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(schema).toContain("workspace_gateway_deliveries_due");
    expect(schema).toContain("workspace_skill_optimization_work_items_due");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_import_account_identity_is_non_destructive");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_operation_and_file_recovery_guards");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_operation_completion_and_transfer_receipt_guards");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_operation_ledger_is_actor_immutable");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_transfer_export_retry_is_idempotent");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_audit_history_respects_room_access");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_bundle_account_status_is_not_escalated");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_room_hierarchy_and_membership_guards");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_room_hierarchy_privacy_and_realtime_integrity");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_room_hierarchy_invitation_and_import_guards");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_room_hierarchy_reactivation_does_not_restore_room_access");
    expect(schema).toContain("samurai_has_workspace_membership");
    expect(schema).toContain("target_receipt->>'target_integrity_hash' IS DISTINCT FROM exported_hash");
    expect(schema).toContain("workspace_transfer_bundle_conflict");
    expect(schema).toContain("room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')");
    expect(schema).toContain("target_status NOT IN ('active', 'disabled')");
    expect(schema).toContain("parent_room_id");
    expect(schema).toContain("samurai_move_room");
    expect(schema).toContain("room_hierarchy_cycle");
    expect(schema).toContain("room_parent_membership_required");
    expect(schema).toContain("room_last_owner_cannot_be_removed");
    expect(schema).toContain("AND state = 'active'");
    expect(schema).toContain("ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED");
    expect(schema).toContain("samurai.workspace.room_hierarchy:");
    expect(schema).toContain("A role demotion is not a removal cascade");
    expect(schema).toContain("samurai_room_member_change_impact");
    expect(schema).toContain("room_parent_not_available");
    expect(schema).toContain("samurai_import_workspace_member");
    expect(schema).toContain("workspace_invitation_operation_id_required");
    expect(schema).toContain("samurai_clear_stale_room_memberships_on_workspace_activation");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_knowledge_learning_loop");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_learning_integrity_hardening");
    for (const table of ["workspace_learning_activities", "workspace_learning_resources", "workspace_learning_resource_versions", "workspace_learning_evidence", "workspace_learning_resource_links", "workspace_learning_settings", "workspace_learning_jobs", "workspace_learning_job_attempts", "workspace_learning_resource_uses"]) {
      expect(schema).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(schema).toContain("ai_update_locked BOOLEAN NOT NULL DEFAULT FALSE");
    expect(schema).toContain("CHECK (resource_kind <> 'workspace_rule' OR scope_kind = 'workspace')");
    expect(schema).toContain("CREATE POLICY workspace_learning_resources_insert ON workspace_learning_resources FOR INSERT");
    expect(schema).toContain("CREATE POLICY workspace_learning_resources_update ON workspace_learning_resources FOR UPDATE");
    expect(schema).not.toContain("CREATE POLICY workspace_learning_resources_write ON workspace_learning_resources FOR ALL");
    expect(schema).toContain("workspace_learning_workspace_settings_singleton");
    expect(schema).toContain("id = 'workspace'");
    expect(schema).toContain("id = ('room:' || room_id)");
    expect(schema).toContain("REFERENCES workspace_learning_resource_versions(workspace_id, resource_id, version)");
    expect(schema).toContain("samurai_is_import_session(workspace_id)");
    expect(schema).toContain("currency_reserved");
    expect(schema).toContain("samurai_adjust_workspace_learning_usage");
    expect(schema).toContain("samurai_lock_workspace_learning_settings");
    expect(schema).toContain("workspace_learning_reservation_underflow");
    expect(schema.lastIndexOf("DELETE FROM workspace_learning_resources WHERE workspace_id = target_workspace_id;")).toBeLessThan(schema.lastIndexOf("DELETE FROM workspace_learning_job_attempts WHERE workspace_id = target_workspace_id;"));
    expect(schema).toContain("source_attempt_id");
    expect(schema).toContain("workspace_learning_resources_source_attempt_job_fkey");
    expect(schema).toContain("workspace_learning_resource_use_correction_unique ON workspace_learning_resource_uses(workspace_id, supersedes_use_id)");
    expect(schema).toContain("workspace_learning_resource_uses_insert ON workspace_learning_resource_uses FOR INSERT");
    expect(schema).toContain("DROP POLICY workspace_learning_settings_write ON workspace_learning_settings");
    expect(schema).toContain("CREATE POLICY workspace_learning_settings_delete ON workspace_learning_settings FOR DELETE");
    expect(schema).toContain("workspace_learning_resource_uses_supersedes_fkey");
    expect(schema).toContain("workspace_learning_evidence_activity_shape_check");
    for (const [table, stem] of [
      ["workspace_learning_resource_versions", "workspace_learning_versions"],
      ["workspace_learning_evidence", "workspace_learning_evidence"],
      ["workspace_learning_resource_links", "workspace_learning_links"],
      ["workspace_learning_resource_uses", "workspace_learning_resource_uses"]
    ]) {
      expect(schema).toContain(`CREATE POLICY ${stem}_read ON ${table} FOR SELECT`);
      expect(schema).toContain(`CREATE POLICY ${stem}_insert ON ${table} FOR INSERT`);
      expect(schema).not.toContain(`CREATE POLICY ${stem}_access ON ${table} FOR ALL`);
    }
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_resource_file_policy_episode");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_batch_visibility_append_only");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_profile_soul_file_metadata");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_skill_package_files");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_retention_and_redaction");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_maintenance_identity");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_legacy_migration_rollback");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_scope_caller_attestation_hardening");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_migration_run_write_boundary");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_migration_run_phase_capability");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_migration_run_start_audit");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_bundle_v4_final_ledger");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_bundle_v4_legacy_staging_ledger_repair");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_runtime_settings_respect_workspace_freeze");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_bundle_v4_agent_connection_import_guards");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_runtime_client_event_room_authorization");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_runtime_client_event_room_command_rls");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_room_invitation_output_column_ambiguity_fix");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_bundle_v4_transfer_ledger");
    expect(schema).toContain("ALTER POLICY workspace_runtime_settings_access ON workspace_runtime_settings");
    for (const table of [
      "workspace_completion_configurations", "workspace_completion_activities", "workspace_completion_episodes",
      "workspace_completion_episode_activities", "workspace_completion_resources", "workspace_completion_resource_versions", "workspace_completion_skill_files",
      "workspace_completion_evidence", "workspace_completion_resource_links", "workspace_completion_policy_rules",
      "workspace_completion_policy_change_requests", "workspace_completion_uses", "workspace_completion_evaluations",
      "workspace_completion_jobs", "workspace_completion_job_attempts", "workspace_completion_curator_state",
      "workspace_completion_curator_snapshots", "workspace_completion_file_batches", "workspace_completion_file_batch_entries",
      "workspace_completion_search_projection", "workspace_completion_migration_receipts", "workspace_completion_workspace_documents",
      "workspace_completion_job_raw_outputs", "workspace_completion_redactions", "workspace_completion_maintenance_identities",
      "workspace_completion_migration_runs", "workspace_completion_policy_approvals", "workspace_completion_attestations"
    ]) {
      expect(schema).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(schema).toContain("resource_kind IN ('knowledge', 'skill', 'policy')");
    expect(schema).toContain("knowledge_kind IN ('fact', 'decision', 'explanation', 'experience_rule')");
    expect(schema).toContain("UNIQUE NULLS NOT DISTINCT (workspace_id, room_id, external_episode_key)");
    expect(schema).toContain("samurai_reject_legacy_learning_kinds");
    expect(schema).toContain("workspace_completion_versions_immutable");
    expect(schema).toContain("workspace_completion_evidence_activity_required");
    expect(schema).toContain("semantic_enabled BOOLEAN NOT NULL DEFAULT FALSE");
    expect(schema).toContain("file_batch_id TEXT NOT NULL");
    expect(schema).toContain("samurai_is_completion_maintenance_identity");
    expect(schema).toContain("samurai_rollback_completion_legacy_migration");
    expect(schema).toContain("scope_kind IN ('workspace', 'room')");
    expect(schema).toContain("COUNT(DISTINCT scope_key) > 1");
    expect(schema).toContain("room_id = reference.scope_room_id");
    expect(schema).toContain("samurai_begin_completion_migration_run");
    expect(schema).toContain("workspace_completion_migration_run_capability_invalid");
    expect(schema).toContain("samurai_record_workspace_bundle_v4");
    expect(schema).toContain("samurai_record_workspace_bundle_v4_transfer");
    expect(schema).toContain("samurai_repair_workspace_bundle_v4_legacy_ledger");
    expect(schema).toContain("samurai_guard_completion_machine_attestation");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_bundle_import_abort_column_resolution");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_import_search_projection_policy");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_completion_file_batch_delete_policy");
    expect(schema).toContain("workspace_key");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_agent_room_permissions_and_connection_descriptors");
    for (const table of ["workspace_agents", "workspace_agent_room_permissions", "workspace_connection_descriptors"]) {
      expect(schema).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(schema).toContain("workspace_agents_write_denied");
    expect(schema).toContain("workspace_agent_room_permissions_write_denied");
    expect(schema).toContain("workspace_connection_descriptors_write_denied");
    expect(schema).toContain("samurai_register_workspace_agent");
    expect(schema).toContain("samurai_can_agent_room");
    expect(schema).toContain("SELECT COALESCE(CASE action_name");
    expect(schema).toContain("samurai_set_workspace_agent_room_permission");
    expect(schema).toContain("samurai_upsert_workspace_connection_descriptor");
    expect(schema).toContain("workspace_agents_backend_id_nonempty");
    expect(schema).toContain("samurai_set_workspace_agent_backend");
    expect(schema).toContain("samurai_import_workspace_agent");
    expect(schema).toContain("samurai_import_workspace_agent_room_permission");
    expect(schema).toContain("samurai_import_workspace_connection_descriptor");
    expect(schema).toContain("workspace_completion_episodes_external_key_unique");
    for (const table of ["workspace_runtime_sessions", "workspace_runtime_messages", "workspace_runtime_runs", "workspace_runtime_events", "workspace_runtime_activities", "workspace_runtime_resources"]) {
      expect(schema).toContain(`CREATE TABLE ${table}`);
      expect(schema).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(schema).toContain("workspace_runtime_runs_idempotency_index");
    expect(schema).toContain("workspace_runtime_reservations");
    expect(schema).toContain("workspace_runtime_client_events_room_fkey");
    const clientEventRlsMigration = migrations.find((migration) => migration.version === 57);
    expect(clientEventRlsMigration?.statements.join("\n")).toContain("room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')");
    expect(clientEventRlsMigration?.statements.join("\n")).toContain("room_id IS NULL AND samurai_can_workspace(workspace_id, 'guest')");
    const invitationAmbiguityFixMigration = migrations.find((migration) => migration.version === 58);
    expect(invitationAmbiguityFixMigration?.statements.join("\n")).toContain("ancestor_member.room_id = ancestors.room_id");
    const invitationConflictTargetFixMigration = migrations.find((migration) => migration.version === 59);
    expect(invitationConflictTargetFixMigration?.statements.join("\n")).toContain("ON CONFLICT ON CONSTRAINT room_members_pkey");
    const learningResourceUseUniquenessRepairMigration = migrations.find((migration) => migration.version === 60);
    expect(learningResourceUseUniquenessRepairMigration?.statements.join("\n")).toContain("constraint_row.conkey = ARRAY[");
    expect(learningResourceUseUniquenessRepairMigration?.statements.join("\n")).toContain("workspace_learning_resource_use_initial_unique");
    const completionActivityCorrectionIndexMigration = migrations.find((migration) => migration.version === 61);
    expect(completionActivityCorrectionIndexMigration?.statements.join("\n")).toContain("workspace_completion_activities_correction_index");
    const machineVerifiedTransitionGuardMigration = migrations.find((migration) => migration.version === 62);
    const machineVerifiedTransitionGuard = machineVerifiedTransitionGuardMigration?.statements.join("\n");
    expect(machineVerifiedTransitionGuard).toContain("IF TG_OP = 'INSERT' THEN");
    expect(machineVerifiedTransitionGuard).toContain("ELSIF OLD.creation_source IS DISTINCT FROM 'machine_verified' THEN");
    expect(machineVerifiedTransitionGuard).toContain("NOT samurai_is_import_session(NEW.workspace_id)");
    const migrationFileBatchVisibility = migrations.find((migration) => migration.version === 63)?.statements.join("\n");
    expect(migrationFileBatchVisibility).toContain("workspace_completion_file_batches_access");
    expect(migrationFileBatchVisibility).toContain("workspace_completion_file_batch_entries_access");
    expect(migrationFileBatchVisibility).toContain("samurai_completion_migration_write_allowed(workspace_id)");
    const migrationFileBatchCapability = migrations.find((migration) => migration.version === 64)?.statements.join("\n");
    expect(migrationFileBatchCapability).toContain("target_workspace_id = samurai_current_workspace_id()");
    expect(migrationFileBatchCapability).toContain("workspace_completion_file_batches_migration_access");
    expect(migrationFileBatchCapability).toContain("workspace_completion_file_batch_entries_migration_access");
    const importAbortDependencyOrder = migrations.find((migration) => migration.version === 65)?.statements.join("\n");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_bundle_import_abort_dependency_order");
    expect(importAbortDependencyOrder).toContain("workspace_completion_skill_files");
    expect(importAbortDependencyOrder).toContain("workspace_completion_workspace_documents");
    expect(importAbortDependencyOrder).toContain("workspace_completion_policy_approvals");
    expect(importAbortDependencyOrder).toContain("workspace_completion_attestations");
    expect(importAbortDependencyOrder).toContain("workspace_completion_migration_runs");
    expect(importAbortDependencyOrder!.indexOf("DELETE FROM workspace_completion_resource_versions")).toBeLessThan(importAbortDependencyOrder!.indexOf("DELETE FROM workspace_completion_file_batches"));
    expect(importAbortDependencyOrder!.indexOf("DELETE FROM workspace_completion_file_batch_entries")).toBeLessThan(importAbortDependencyOrder!.indexOf("DELETE FROM workspace_completion_file_batches"));
    const importSearchProjectionPolicy = migrations.find((migration) => migration.version === 67)?.statements.join("\n");
    expect(importSearchProjectionPolicy).toContain("samurai_is_import_session(workspace_id)");
    const fileBatchDeletePolicy = migrations.find((migration) => migration.version === 68)?.statements.join("\n");
    expect(fileBatchDeletePolicy).toContain("workspace_completion_file_batches_delete");
    expect(fileBatchDeletePolicy).toContain("workspace_completion_file_batch_entries_delete");
    expect(fileBatchDeletePolicy).toContain("samurai_completion_migration_write_allowed(workspace_id)");
    const importResourceLinkPolicy = migrations.find((migration) => migration.version === 69)?.statements.join("\n");
    expect(importResourceLinkPolicy).toContain("workspace_completion_links_access");
    expect(importResourceLinkPolicy).toContain("samurai_is_import_session(workspace_id)");
    const importEvidencePolicy = migrations.find((migration) => migration.version === 70)?.statements.join("\n");
    expect(importEvidencePolicy).toContain("workspace_completion_policy_rules_access");
    expect(importEvidencePolicy).toContain("workspace_completion_uses_access");
    expect(importEvidencePolicy).toContain("workspace_completion_evaluations_access");
    expect(importEvidencePolicy).toContain("samurai_is_import_session(workspace_id)");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_runtime_automation_jobs_and_runs");
    for (const table of ["workspace_runtime_automation_jobs", "workspace_runtime_automation_runs"]) {
      expect(schema).toContain(`CREATE TABLE ${table}`);
      expect(schema).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(schema).toContain("workspace_runtime_automation_jobs_due_index");
    expect(schema).toContain("workspace_runtime_automation_runs_job_index");
    expect(schema).toContain("CREATE TABLE workspace_external_integration_records (");
    expect(schema).toContain("CREATE UNIQUE INDEX workspace_external_integration_records_workspace_unique_index");
    expect(schema).toContain("CREATE UNIQUE INDEX workspace_external_integration_records_global_unique_index");
    const externalMigration = migrations.find((migration) => migration.version === 45);
    expect(externalMigration?.statements.join("\n")).not.toContain("PRIMARY KEY (workspace_id, record_type, id)");
    const runtimeMigration = migrations.find((migration) => migration.version === 43);
    expect(runtimeMigration?.statements.join("\n")).not.toContain("workspace_runtime_automation_jobs");
    const automationMigration = migrations.find((migration) => migration.version === 44);
    expect(automationMigration?.statements.join("\n")).toContain("workspace_runtime_automation_jobs");
    expect(schema).not.toContain("api_key TEXT");
    expect(schema).not.toContain("access_token TEXT");
    expect(schema).not.toContain("secret TEXT");
  });
});
