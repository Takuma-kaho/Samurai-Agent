import { describe, expect, it } from "vitest";
import { workspaceServerMigrationDefinitions, workspaceServerMigrationStatus } from "./schema";

describe("Workspace Server PostgreSQL schema", () => {
  it("defines tenant RLS for records, files, history, jobs, and notifications", () => {
    const migrations = workspaceServerMigrationDefinitions();
    const schema = migrations.flatMap((migration) => migration.statements).join("\n");

    expect(migrations.map((migration) => migration.version)).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
    expect(workspaceServerMigrationStatus().map((migration) => migration.version)).toEqual(migrations.map((migration) => migration.version));
    for (const table of ["workspace_records", "workspace_files", "workspace_events", "workspace_jobs", "workspace_operations"]) {
      expect(schema).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(schema).toContain(`workspace_id`);
    }
    expect(schema).toContain("samurai_current_workspace_id()");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_organization_boundary_and_workspace_backfill");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS organizations");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS organization_members");
    expect(schema).toContain("ALTER TABLE workspaces ALTER COLUMN organization_id SET NOT NULL");
    expect(schema).toContain("workspace_event_organization_mismatch");
    expect(schema).toContain("organization_last_owner_cannot_be_changed");
    expect(schema).toContain("organization_operations ADD COLUMN IF NOT EXISTS consumed_at");
    expect(schema).toContain("DROP CONSTRAINT IF EXISTS workspace_events_workspace_organization_fkey");
    expect(schema).not.toContain("ADD CONSTRAINT workspace_events_workspace_organization_fkey");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_organization_invitation_and_move_hardening");
    expect(schema).toContain("samurai_resolve_organization_invitation");
    expect(schema).toContain("organization.deleted_at IS NULL");
    expect(schema).toContain("organizations_pending_invitation_revoke");
    expect(schema).toContain("organization_invitation_accept_guard");
    expect(schema).toContain("IF source_organization_id < target_organization_id THEN");
    const hardening = migrations.find((migration) => migration.name === "workspace_server_organization_invitation_and_move_hardening");
    const hardeningSql = hardening?.statements.join("\n") ?? "";
    expect(hardeningSql.indexOf("Resolve a candidate without taking the invitation row lock first")).toBeGreaterThanOrEqual(0);
    expect(hardeningSql.indexOf("Resolve a candidate without taking the invitation row lock first")).toBeLessThan(hardeningSql.indexOf("pg_advisory_xact_lock(hashtextextended('samurai.organization.owner:'"));
    expect(hardeningSql.indexOf("Re-read under the Organization lock and lock the invitation")).toBeGreaterThan(hardeningSql.indexOf("pg_advisory_xact_lock(hashtextextended('samurai.organization.owner:'"));
    expect(hardeningSql.lastIndexOf("FOR UPDATE;")).toBeGreaterThan(hardeningSql.indexOf("Re-read under the Organization lock and lock the invitation"));
    expect(schema).toContain("samurai.organization:");
    expect(schema).toContain("token_hash");
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
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_room_role_requires_existing_room");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_public_event_journal");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_v1_room_agent_mutation_contract");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_public_event_execute_policy");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_public_event_import_policy");
    expect(schema).toContain("samurai_is_import_session(workspace_id)");
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
    expect(schema).toContain("IF NOT FOUND THEN RETURN NULL; END IF;");
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
    const episodeExternalKeyRepairMigration = migrations.find((migration) => migration.version === 126);
    expect(episodeExternalKeyRepairMigration?.name).toBe("workspace_server_completion_episode_external_key_nullability_repair");
    const episodeExternalKeyRepairSql = episodeExternalKeyRepairMigration?.statements.join("\n") ?? "";
    expect(episodeExternalKeyRepairSql).toContain("pg_get_constraintdef");
    expect(episodeExternalKeyRepairSql).toContain("UNIQUE NULLS NOT DISTINCT (workspace_id, room_id, external_episode_key)");
    expect(episodeExternalKeyRepairSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS workspace_completion_episodes_external_key_unique");
    expect(episodeExternalKeyRepairSql).toContain("WHERE external_episode_key IS NOT NULL");
    const runtimeBindingScopeFixMigration = migrations.find((migration) => migration.version === 127);
    expect(runtimeBindingScopeFixMigration?.name).toBe("workspace_server_human_work_runtime_binding_scope_fix");
    const runtimeBindingScopeFixSql = runtimeBindingScopeFixMigration?.statements.join("\n") ?? "";
    expect(runtimeBindingScopeFixSql).toContain("has_human_work_binding");
    expect(runtimeBindingScopeFixSql).toContain("IF NOT has_human_work_binding THEN RETURN NEW; END IF;");
    expect(runtimeBindingScopeFixSql).toContain("binding ->> 'work_id'");
    expect(runtimeBindingScopeFixSql).toContain("binding ->> 'reservation_id'");
    expect(runtimeBindingScopeFixSql).toContain("RAISE EXCEPTION 'human_work_runtime_binding_invalid'");
    for (const table of ["workspace_runtime_sessions", "workspace_runtime_messages", "workspace_runtime_runs", "workspace_runtime_events", "workspace_runtime_activities", "workspace_runtime_resources"]) {
      expect(schema).toContain(`CREATE TABLE ${table}`);
      expect(schema).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(schema).toContain("workspace_runtime_runs_idempotency_index");
    expect(schema).toContain("workspace_runtime_reservations");
    expect(schema).toContain("workspace_runtime_client_events_room_fkey");
    const delegationMigration = migrations.find((migration) => migration.version === 102);
    expect(delegationMigration?.name).toBe("workspace_server_human_work_delegation");
    const delegationSql = delegationMigration?.statements.join("\n") ?? "";
    expect(delegationSql).toContain("dependency_assignment_ids");
    expect(delegationSql).toContain("samurai_delegate_human_work");
    expect(delegationSql).toContain("samurai_restore_human_work_assignment_dependencies");
    expect(delegationSql).toContain("samurai_guard_human_work_dependency_ready");
    expect(delegationSql).toContain("samurai_release_human_work_dependency_children");
    expect(delegationSql).toContain("FOR UPDATE");
    const roomAgentRevocationMigration = migrations.find((migration) => migration.version === 104);
    expect(roomAgentRevocationMigration?.name).toBe("workspace_server_room_agent_permission_revocation");
    const roomAgentRevocationSql = roomAgentRevocationMigration?.statements.join("\n") ?? "";
    expect(roomAgentRevocationSql).toContain("samurai_remove_workspace_agent_room_permission");
    expect(roomAgentRevocationSql).toContain("workspace_default_agent_remove_required");
    expect(roomAgentRevocationSql).toContain("Do not alter existing Work/Assignment rows");
    const attachmentVersionMigration = migrations.find((migration) => migration.version === 105);
    expect(attachmentVersionMigration?.name).toBe("workspace_server_human_work_attachment_version_contract");
    const attachmentVersionSql = attachmentVersionMigration?.statements.join("\n") ?? "";
    expect(attachmentVersionSql).toContain("jsonb_build_object('version', file.version::TEXT)");
    expect(attachmentVersionSql).toContain("NOT (attachment ? 'version')");
    expect(attachmentVersionSql).toContain("file_row.version::TEXT IS DISTINCT FROM attachment_version");
    const runtimeAdmissionCleanupMigration = migrations.find((migration) => migration.version === 106);
    expect(runtimeAdmissionCleanupMigration?.name).toBe("workspace_server_human_work_runtime_admission_cleanup");
    const runtimeAdmissionCleanupSql = runtimeAdmissionCleanupMigration?.statements.join("\n") ?? "";
    expect(runtimeAdmissionCleanupSql).toContain("samurai_discard_human_work_runtime_admission");
    expect(runtimeAdmissionCleanupSql).toContain("current_run_id = NULL");
    const delegationContinuationMigration = migrations.find((migration) => migration.version === 107);
    expect(delegationContinuationMigration?.name).toBe("workspace_server_human_work_delegation_continuation_guards");
    const delegationContinuationSql = delegationContinuationMigration?.statements.join("\n") ?? "";
    expect(delegationContinuationSql).toContain("origin_kind");
    expect(delegationContinuationSql).toContain("samurai_delegate_human_work_from_runtime");
    expect(delegationContinuationSql).toContain("human_work_launch_generation_conflict");
    expect(delegationContinuationSql).toContain("samurai_create_human_work_parent_continuation");
    expect(delegationContinuationSql).toContain("candidate_parent_id := COALESCE(NEW.parent_assignment_id, NEW.id)");
    expect(delegationContinuationSql).toContain("control_generation = GREATEST(control_generation, NEW.generation)");
    expect(delegationContinuationSql).toContain("samurai_control_human_work_v106");
    const continuationRestoreHardeningMigration = migrations.find((migration) => migration.version === 109);
    expect(continuationRestoreHardeningMigration?.name).toBe("workspace_server_human_work_continuation_restore_hardening");
    const continuationRestoreHardeningSql = continuationRestoreHardeningMigration?.statements.join("\n") ?? "";
    expect(continuationRestoreHardeningSql).toContain("samurai_human_work_assignment_outcome_tree");
    expect(continuationRestoreHardeningSql).toContain("samurai_is_completion_maintenance_identity");
    expect(continuationRestoreHardeningSql).toContain("status NOT IN ('completed', 'failed', 'cancelled')");
    expect(continuationRestoreHardeningSql).toContain("samurai.human_work.reassign");
    expect(continuationRestoreHardeningSql).toContain("WITH RECURSIVE ancestors(id, depth)");
    expect(continuationRestoreHardeningSql).toContain("ORDER BY depth ASC, id");
    expect(continuationRestoreHardeningSql).toContain("reason', 'reassigned");
    expect(continuationRestoreHardeningSql).toContain("parent_assignment_id IS DISTINCT FROM assignment_row.parent_assignment_id");
    expect(continuationRestoreHardeningSql).toContain("parent_assignment.agent_version IS DISTINCT FROM restored_assignment.agent_version");
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
    const importV4AbortCleanup = migrations.find((migration) => migration.version === 71)?.statements.join("\n");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_bundle_import_abort_v4_dependencies");
    for (const table of [
      "workspace_runtime_activities", "workspace_runtime_automation_runs", "workspace_runtime_automation_jobs",
      "workspace_connection_descriptors", "workspace_agent_room_permissions", "workspace_agents"
    ]) {
      expect(importV4AbortCleanup).toContain(`DELETE FROM ${table}`);
    }
    expect(importV4AbortCleanup!.indexOf("DELETE FROM workspace_runtime_automation_runs")).toBeLessThan(importV4AbortCleanup!.indexOf("DELETE FROM workspace_runtime_automation_jobs"));
    expect(importV4AbortCleanup!.indexOf("DELETE FROM workspace_connection_descriptors")).toBeLessThan(importV4AbortCleanup!.indexOf("DELETE FROM workspace_agent_room_permissions"));
    expect(importV4AbortCleanup!.indexOf("DELETE FROM workspace_agent_room_permissions")).toBeLessThan(importV4AbortCleanup!.indexOf("DELETE FROM workspace_agents"));
    expect(importV4AbortCleanup!.indexOf("DELETE FROM workspace_agents")).toBeLessThan(importV4AbortCleanup!.indexOf("DELETE FROM rooms"));
    for (const table of [
      "workspace_completion_configurations", "workspace_completion_activities", "workspace_completion_episodes",
      "workspace_completion_episode_activities", "workspace_completion_resources", "workspace_completion_resource_versions",
      "workspace_completion_skill_files", "workspace_completion_policy_approvals", "workspace_completion_attestations",
      "workspace_completion_evidence", "workspace_completion_resource_links", "workspace_completion_policy_rules",
      "workspace_completion_policy_change_requests", "workspace_completion_uses", "workspace_completion_evaluations",
      "workspace_completion_jobs", "workspace_completion_job_attempts", "workspace_completion_curator_state",
      "workspace_completion_curator_snapshots", "workspace_completion_search_projection", "workspace_completion_workspace_documents",
      "workspace_completion_redactions", "workspace_completion_file_batches", "workspace_completion_file_batch_entries",
      "workspace_completion_migration_receipts", "workspace_completion_migration_runs", "workspace_completion_maintenance_identities",
      "workspace_runtime_activities", "workspace_runtime_automation_runs", "workspace_runtime_automation_jobs",
      "workspace_connection_descriptors", "workspace_agent_room_permissions", "workspace_agents"
    ]) {
      expect(importV4AbortCleanup!.indexOf(`DELETE FROM ${table}`)).toBeLessThan(importV4AbortCleanup!.indexOf("DELETE FROM rooms"));
    }
    const automationCommandPolicies = migrations.find((migration) => migration.version === 72)?.statements.join("\n");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_runtime_automation_command_specific_rls");
    expect(automationCommandPolicies).toContain("workspace_runtime_automation_jobs_select");
    expect(automationCommandPolicies).toContain("workspace_runtime_automation_jobs_insert");
    expect(automationCommandPolicies).toContain("workspace_runtime_automation_jobs_update");
    expect(automationCommandPolicies).toContain("workspace_runtime_automation_runs_select");
    expect(automationCommandPolicies).toContain("workspace_runtime_automation_runs_insert");
    expect(automationCommandPolicies).toContain("workspace_runtime_automation_runs_update");
    expect(automationCommandPolicies).not.toContain("FOR ALL");
    expect(automationCommandPolicies).not.toContain("FOR DELETE");
    const automationUpdateSourcePolicies = migrations.find((migration) => migration.version === 73)?.statements.join("\n");
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_runtime_automation_update_source_room_rls");
    expect(automationUpdateSourcePolicies).toContain("DROP POLICY IF EXISTS workspace_runtime_automation_jobs_update");
    expect(automationUpdateSourcePolicies).toContain("DROP POLICY IF EXISTS workspace_runtime_automation_runs_update");
    expect(automationUpdateSourcePolicies).toContain("samurai_can_room(workspace_id, room_id, 'edit')");
    expect(automationUpdateSourcePolicies).toContain("samurai_can_room(workspace_id, room_id, 'execute')");
    expect(automationUpdateSourcePolicies).not.toContain("samurai_can_room(workspace_id, room_id, 'read')");
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

    const runtimeHistoryAbortCleanup = migrations.find((migration) => migration.version === 88)?.statements.join("\n") ?? "";
    expect(migrations.map((migration) => migration.name)).toContain("workspace_server_bundle_import_abort_runtime_history_dependency_order");
    for (const table of [
      "workspace_runtime_resource_usage", "workspace_runtime_changes", "workspace_runtime_events",
      "workspace_runtime_activities", "workspace_runtime_runs", "workspace_runtime_messages", "workspace_runtime_sessions"
    ]) {
      expect(runtimeHistoryAbortCleanup).toContain(`DELETE FROM ${table} WHERE workspace_id = workspace_key`);
    }
    const runtimeHistoryCleanupOrder = [
      "workspace_runtime_resource_usage", "workspace_runtime_changes", "workspace_runtime_events",
      "workspace_runtime_activities", "workspace_runtime_runs", "workspace_runtime_messages", "workspace_runtime_sessions"
    ].map((table) => runtimeHistoryAbortCleanup.indexOf(`DELETE FROM ${table} WHERE workspace_id = workspace_key`));
    expect(runtimeHistoryCleanupOrder.every((index) => index >= 0)).toBe(true);
    for (let index = 1; index < runtimeHistoryCleanupOrder.length; index += 1) {
      expect(runtimeHistoryCleanupOrder[index - 1]).toBeLessThan(runtimeHistoryCleanupOrder[index]);
    }
    expect(runtimeHistoryAbortCleanup).toContain("DELETE FROM workspace_runtime_automation_runs WHERE workspace_id = workspace_key");
    expect(runtimeHistoryAbortCleanup).toContain("DELETE FROM workspace_runtime_automation_jobs WHERE workspace_id = workspace_key");
    expect(runtimeHistoryAbortCleanup.indexOf("DELETE FROM workspace_runtime_automation_runs")).toBeLessThan(
      runtimeHistoryAbortCleanup.indexOf("DELETE FROM rooms")
    );
  });

  it("makes Organization optional without changing Workspace-content RLS", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 80);
    expect(migration?.name).toBe("workspace_server_workspace_first_organization_optional");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("ALTER TABLE workspaces ALTER COLUMN organization_id DROP NOT NULL");
    expect(sql).toContain("ALTER TABLE workspace_events ALTER COLUMN organization_id DROP NOT NULL");
    expect(sql).toContain("FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL");
    expect(sql).toContain("workspace_first_generated_organization_cleanup");
    expect(sql).toContain("samurai.legacy.organization|");
    expect(sql).toContain("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS legacy_backfill_marker TEXT");
    expect(sql).toContain("workspace_server_v78_account_backfill");
    expect(sql).toContain("FROM samurai_server_schema_migrations");
    expect(sql).toContain("organization.created_at = backfill_applied_at");
    expect(sql).toContain("WHERE organization.legacy_backfill_marker = 'workspace_server_v78_account_backfill'");
    expect(sql.indexOf("SET legacy_backfill_marker = 'workspace_server_v78_account_backfill'")).toBeLessThan(
      sql.indexOf("DELETE FROM organizations")
    );
    expect(sql).toContain("DELETE FROM organization_invitation_workspace_grants");
    expect(sql).toContain("DELETE FROM organization_invitations");
    expect(sql).toContain("DELETE FROM organization_members");
    expect(sql).toContain("DELETE FROM organization_operations");
    expect(sql).toContain("DELETE FROM organizations");
    expect(sql).toContain("RETURN;");
    expect(sql.indexOf("DROP TRIGGER IF EXISTS workspace_events_organization_guard ON workspace_events")).toBeLessThan(
      sql.indexOf("DO $workspace_first_generated_organization_cleanup$")
    );
    expect(sql).not.toContain("organization_required");
    expect(sql).not.toContain("target_organization_id IS NULL THEN\n          RAISE EXCEPTION 'workspace_creation_context_invalid'");

    const workspacePolicyStart = sql.lastIndexOf("CREATE POLICY workspaces_read ON workspaces");
    const workspacePolicyEnd = sql.indexOf("DROP POLICY IF EXISTS workspace_members_read ON workspace_members", workspacePolicyStart);
    expect(workspacePolicyStart).toBeGreaterThanOrEqual(0);
    const workspacePolicy = sql.slice(workspacePolicyStart, workspacePolicyEnd);
    expect(workspacePolicy).toContain("organization_id IS NOT NULL AND samurai_can_organization(organization_id, 'admin')");
    expect(workspacePolicy).not.toContain("samurai_can_organization(organization_id, 'member')");
    expect(workspacePolicy).not.toContain("samurai_can_organization(organization_id, 'guest')");
    const memberPolicyStart = sql.lastIndexOf("CREATE POLICY workspace_members_read ON workspace_members");
    expect(memberPolicyStart).toBeGreaterThanOrEqual(0);
    const memberPolicyEnd = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_create_workspace(", memberPolicyStart);
    const memberPolicy = sql.slice(memberPolicyStart, memberPolicyEnd);
    expect(memberPolicy).toContain("workspace.organization_id IS NOT NULL");
    expect(memberPolicy).toContain("samurai_can_organization(workspace.organization_id, 'admin')");
    expect(memberPolicy).not.toContain("samurai_can_organization(workspace.organization_id, 'member')");
    expect(memberPolicy).not.toContain("samurai_can_organization(workspace.organization_id, 'guest')");

    for (const contentTable of ["rooms", "room_members", "workspace_records", "workspace_files", "workspace_events"]) {
      expect(sql).not.toMatch(new RegExp(`(?:DROP|CREATE) POLICY[^\\n]* ON ${contentTable}\\b`));
    }

    expect(sql).toContain("source_workspace_id");
    expect(sql).toContain("idempotency_key");
    expect(sql).toContain("verified_at");
    expect(sql).toContain("cutover_at");
    expect(sql).toContain("source_archived_at");
    expect(sql).toContain("source_deleted_at");
    for (const transferState of [
      "preparing", "exported", "imported", "committed", "rolled_back", "failed",
      "restoring", "verified", "cutover", "source_retained", "source_deleted"
    ]) {
      expect(sql).toContain(`'${transferState}'`);
    }
    expect(sql).toContain("workspace_transfers_state_check");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS workspace_transfers_state_check");
    expect(sql).toContain("transfer_metadata");
    expect(sql).toContain("workspace_transfers_metadata_defaults");
    expect(sql).toContain("portable restore runs under an import session");
    expect(sql).toContain("NEW.payload := NEW.payload - ARRAY[");
    expect(sql).toContain("'source_organization_id', 'target_organization_id'");
    expect(sql).toContain("workspace.organization.attached");
    expect(sql).toContain("workspace.organization.detached");
    expect(sql).toContain("COALESCE(target_organization_id, source_organization_id)");
    expect(sql).toContain("organization_id, cursor, correlation_id, resources");
    const moveStart = sql.lastIndexOf("CREATE OR REPLACE FUNCTION samurai_move_workspace_organization(");
    expect(moveStart).toBeGreaterThanOrEqual(0);
    const moveSql = sql.slice(moveStart);
    expect(moveSql).toContain("samurai_can_organization(source_organization_id, 'admin')");
    expect(moveSql).toContain("samurai_can_organization(target_organization_id, 'admin')");
    expect(moveSql).toContain("target_organization_id IS NULL");
    expect(moveSql).toContain("samurai_can_workspace(target_workspace_id, 'owner')");
    expect(moveSql).toContain("samurai_role_rank(organization_members.role)");
    expect(moveSql).not.toContain("samurai_can_organization(source_organization_id, 'owner')");
    expect(moveSql).not.toContain("samurai_can_organization(target_organization_id, 'owner')");
    expect(moveSql).toContain("samurai.organization.owner:");

    const allSql = workspaceServerMigrationDefinitions().flatMap((entry) => entry.statements).join("\n");
    const transferFunctionStart = allSql.indexOf("CREATE OR REPLACE FUNCTION samurai_begin_workspace_transfer(");
    const transferFunctionEnd = allSql.indexOf("CREATE OR REPLACE FUNCTION samurai_record_import_bundle(", transferFunctionStart);
    expect(transferFunctionStart).toBeGreaterThanOrEqual(0);
    expect(transferFunctionEnd).toBeGreaterThan(transferFunctionStart);
    const transferSql = allSql.slice(transferFunctionStart, transferFunctionEnd);
    expect(transferSql).not.toContain("INSERT INTO workspace_events");
    expect(transferSql).not.toContain("organization_id");

    const membershipFunctionStart = allSql.lastIndexOf("CREATE OR REPLACE FUNCTION samurai_set_organization_workspace_member(");
    const membershipFunctionEnd = allSql.indexOf("CREATE OR REPLACE FUNCTION samurai_set_organization_workspace_lifecycle(", membershipFunctionStart);
    expect(membershipFunctionStart).toBeGreaterThanOrEqual(0);
    expect(allSql.slice(membershipFunctionStart, membershipFunctionEnd)).toContain("SECURITY DEFINER");
    expect(allSql.slice(membershipFunctionStart, membershipFunctionEnd)).toContain("samurai_can_organization(target_organization_id, 'admin')");
  });

  it("round-trips V4 Agent role, instructions, and enabled fields", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 81);
    expect(migration?.name).toBe("workspace_server_bundle_v4_agent_import_contract");
    const sql = migration?.statements.join("\n") ?? "";

    const signature = `CREATE OR REPLACE FUNCTION samurai_import_workspace_agent(
        target_workspace_id TEXT,
        target_agent_id TEXT,
        target_display_name TEXT,
        target_description TEXT,
        target_role TEXT,
        target_instructions TEXT,
        target_backend_id TEXT,
        target_enabled BOOLEAN,
        target_status TEXT,
        target_version BIGINT,
        target_created_by TEXT,
        target_created_at TIMESTAMPTZ,
        target_updated_at TIMESTAMPTZ`;
    expect(sql).toContain(signature);
    expect(sql).toContain("workspace_id, id, display_name, description, role, instructions,");
    expect(sql).toContain("backend_id, enabled, status, version, created_by, created_at, updated_at");
    expect(sql).toContain("role = EXCLUDED.role");
    expect(sql).toContain("instructions = EXCLUDED.instructions");
    expect(sql).toContain("enabled = EXCLUDED.enabled");
    expect(sql).toContain("target_enabled IS NULL");
    expect(sql).toContain("samurai_is_import_session(target_workspace_id)");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_import_workspace_agent(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC");

    const allSql = workspaceServerMigrationDefinitions().flatMap((entry) => entry.statements).join("\n");
    const oldFunctionStart = allSql.indexOf("CREATE OR REPLACE FUNCTION samurai_import_workspace_agent(");
    const newFunctionStart = allSql.indexOf(signature);
    expect(oldFunctionStart).toBeGreaterThanOrEqual(0);
    expect(newFunctionStart).toBeGreaterThan(oldFunctionStart);
  });

  it("qualifies transfer parameters that overlap transfer columns", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 83);
    expect(migration?.name).toBe("workspace_server_transfer_parameter_function_qualification_fix");
    const sql = migration?.statements.join("\n") ?? "";

    for (const functionName of [
      "samurai_begin_workspace_transfer",
      "samurai_record_workspace_bundle",
      "samurai_fail_workspace_transfer",
      "samurai_rollback_workspace_transfer",
      "samurai_record_workspace_transfer_receipt",
      "samurai_complete_workspace_transfer",
      "samurai_record_workspace_bundle_v4_transfer"
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${functionName}(`);
    }
    expect(sql).toContain("samurai_record_workspace_bundle.target_workspace_id");
    expect(sql).toContain("transfer.workspace_id = samurai_record_workspace_bundle_v4_transfer.target_workspace_id");
    expect(sql).toContain("samurai_record_workspace_transfer_receipt.target_receipt");
    expect(sql).toContain("DECLARE transfer_state TEXT");
    expect(sql).toContain("SELECT transfer.state, transfer.bundle_path, transfer.bundle_hash");
    expect(sql).toContain("workspace_transfer_bundle_conflict");
    expect(sql).not.toContain("<<workspace_");
    expect(sql).not.toMatch(/WHERE workspace_id = target_workspace_id/);
    expect(sql).not.toMatch(/UPDATE workspace_transfers SET/);
    expect(sql).not.toMatch(/FROM workspace_transfers\s+WHERE/);
  });

  it("adds transfer retry semantics in a new migration without changing v80-v83", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 84);
    expect(migration?.name).toBe("workspace_server_transfer_resume_and_receipt_replay");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("state IN ('failed', 'rolled_back')");
    expect(sql).toContain("SET state = 'preparing'");
    expect(sql).toContain("bundle_path = NULL");
    expect(sql).toContain("target_receipt = NULL");
    expect(sql).toContain("state = 'read_only'");
    expect(sql).toContain("version = transfer.version + 1");
    expect(sql).toContain("target_receipt IS DISTINCT FROM");
    expect(sql).toContain("workspace_transfer_receipt_conflict");
    expect(sql).toContain("IF transfer_row.state IN ('imported', 'committed')");
  });

  it("deletes Organizations by detaching Workspaces in a new migration", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 85);
    expect(migration?.name).toBe("workspace_server_organization_delete_detaches_workspaces");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("target_expected_organization_version BIGINT");
    expect(sql).toContain("LANGUAGE plpgsql SECURITY DEFINER");
    expect(sql).toContain("FROM organizations AS organization");
    expect(sql).toContain("FOR UPDATE;");
    expect(sql).toContain("organization_owner_permission_required");
    expect(sql).toContain("organization_version_conflict");
    expect(sql).toContain("SET organization_id = NULL, version = workspace.version + 1");
    expect(sql).toContain("workspace.organization.detached");
    expect(sql).toContain("organization.deleted");
    for (const table of ["workspaces", "workspace_members", "rooms", "room_members", "workspace_records", "workspace_files"]) {
      expect(sql).not.toMatch(new RegExp(`DELETE FROM ${table}\\b`));
    }
    expect(sql).not.toContain("organization_workspaces_remaining");
    expect(sql).toContain("samurai_delete_organization(target_organization_id, NULL::BIGINT, target_operation_id)");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_delete_organization(TEXT, BIGINT, TEXT) FROM PUBLIC");
  });

  it("returns the deleted Organization through a SECURITY DEFINER projection wrapper", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 86);
    expect(migration?.name).toBe("workspace_server_organization_delete_returning_projection");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_delete_organization_and_return(");
    expect(sql).toContain("target_expected_organization_version BIGINT");
    expect(sql).toContain("target_operation_id TEXT");
    expect(sql).toContain("RETURNS TABLE(");
    for (const field of ["id TEXT", "name TEXT", "icon TEXT", "description TEXT", "created_by TEXT", "version BIGINT", "created_at TIMESTAMPTZ", "updated_at TIMESTAMPTZ", "deleted_at TIMESTAMPTZ"]) {
      expect(sql).toContain(field);
    }
    expect(sql).toContain("LANGUAGE plpgsql SECURITY DEFINER");
    expect(sql).toContain("PERFORM samurai_delete_organization(");
    expect(sql).toContain("FROM organizations AS organization");
    expect(sql).toContain("organization.deleted_at IS NOT NULL");
    expect(sql).toContain("organization_delete_result_not_found");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_delete_organization_and_return(TEXT, BIGINT, TEXT) FROM PUBLIC");
    expect(sql).not.toContain("CREATE OR REPLACE FUNCTION samurai_delete_organization(");

    const allSql = workspaceServerMigrationDefinitions().flatMap((entry) => entry.statements).join("\n");
    expect(allSql.indexOf("CREATE OR REPLACE FUNCTION samurai_delete_organization_and_return(")).toBeGreaterThan(
      allSql.lastIndexOf("CREATE OR REPLACE FUNCTION samurai_delete_organization(")
    );
  });

  it("adds Room defaults, private Agent DM, human work persistence, and import guards in v89", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 89);
    expect(migration?.name).toBe("workspace_server_room_default_agent_dm_and_human_work");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS default_agent_id TEXT");
    expect(sql).toContain("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS default_agent_version BIGINT");
    expect(sql).toContain("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_kind TEXT NOT NULL DEFAULT 'normal'");
    expect(sql).toContain("workspace_agent_dm_unique");
    expect(sql).toContain("agent_dm_membership_required");
    const roomRoleStart = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_room_role(");
    const roomRoleEnd = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_create_room(", roomRoleStart);
    const roomRoleSql = sql.slice(roomRoleStart, roomRoleEnd);
    expect(roomRoleSql).toContain("IF room_kind_name = 'agent_dm' THEN");
    const dmRoleStart = roomRoleSql.indexOf("IF room_kind_name = 'agent_dm' THEN");
    const normalRoleStart = roomRoleSql.indexOf("workspace_role_name :=", dmRoleStart);
    expect(roomRoleSql.slice(dmRoleStart, normalRoleStart)).not.toContain("samurai_workspace_role(");

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_import_workspace_room_v2(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_import_workspace_human_work(");
    expect(sql).toContain("workspace_import_session_invalid");
    for (const table of [
      "workspace_human_works", "workspace_human_work_assignments", "workspace_human_work_instructions",
      "workspace_human_work_comments", "workspace_human_work_comment_reactions", "workspace_human_work_controls",
      "workspace_human_work_launch_reservations"
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY ${table}_insert_denied ON ${table} FOR INSERT WITH CHECK (false)`);
    }
    expect(sql).toContain("samurai_set_human_work_comment_reaction");
    expect(sql).toContain("target_reservation_id TEXT");
    expect(sql).toContain("target_lease_owner TEXT");
    expect(sql).toContain("target_expected_generation BIGINT");
    expect(sql).toContain("human_work_assignment_lease_conflict");
    expect(sql).toContain("work_generation <> target_expected_generation AND target_status <> 'outcome_unknown'");

    const controlStart = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_can_human_work_control(");
    const controlEnd = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_set_human_work_comment_reaction(", controlStart);
    const controlSql = sql.slice(controlStart, controlEnd);
    // The requester must still be an active member of the Room. Workspace
    // role inheritance alone must not let a removed requester control work.
    expect(controlSql).toContain("JOIN room_members AS room_member");
    expect(controlSql).toContain("room_member.state = 'active'");
    expect(controlSql).toContain("work.requester_account_id = samurai_current_account_id()");
    expect(controlSql).toContain("room_member.role IN ('owner', 'admin')");

    for (const functionName of [
      "samurai_append_human_work_instruction",
      "samurai_reflect_human_work_comment",
      "samurai_reassign_human_work"
    ]) {
      const functionStart = sql.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}(`);
      const functionEnd = sql.indexOf("$$`,", functionStart);
      const functionSql = sql.slice(functionStart, functionEnd);
      // These mutations change the next execution; unlike stop, they require
      // a fresh execute capability in addition to current control ownership.
      expect(functionSql).toContain("samurai_can_room(target_workspace_id");
      expect(functionSql).toContain("'execute'");
    }

    const abortStart = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_abort_workspace_import(");
    const abortEnd = sql.indexOf("ALTER TABLE rooms ADD COLUMN", abortStart);
    const abortSql = sql.slice(abortStart, abortEnd);
    expect(abortSql).toContain("DELETE FROM workspace_human_work_controls");
    expect(abortSql).toContain("DELETE FROM workspace_human_works");
    expect(abortSql.indexOf("DELETE FROM workspace_human_work_controls")).toBeLessThan(
      abortSql.indexOf("DELETE FROM workspace_human_work_assignments")
    );
    expect(abortSql.indexOf("DELETE FROM workspace_human_works")).toBeLessThan(
      abortSql.indexOf("DELETE FROM rooms")
    );
    expect(abortSql.indexOf("DELETE FROM rooms")).toBeLessThan(
      abortSql.indexOf("DELETE FROM workspace_agents")
    );
  });

  it("keeps legacy Session-to-Room-work resolution internal and atomic in v90", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 90);
    expect(migration?.name).toBe("workspace_server_legacy_session_room_work_bridge");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE TABLE workspace_human_work_legacy_sessions");
    expect(sql).toContain("UNIQUE (workspace_id, legacy_session_id)");
    expect(sql).toContain("REFERENCES workspace_runtime_sessions(workspace_id, id) ON DELETE RESTRICT");
    expect(sql).toContain("CREATE POLICY workspace_human_work_legacy_sessions_read ON workspace_human_work_legacy_sessions FOR SELECT");
    expect(sql).toContain("workspace_human_work_legacy_sessions_insert_denied");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_bind_human_work_legacy_session(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_import_workspace_human_work_legacy_sessions(");
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(sql).toContain("samurai_abort_workspace_import_v89");
    expect(sql).toContain("DELETE FROM workspace_human_work_legacy_sessions");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_bind_human_work_legacy_session");
  });

  it("keeps the legacy bridge binding id before the Session id", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 90);
    const sql = migration?.statements.join("\n") ?? "";
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_bind_human_work_legacy_session(");
    const end = sql.indexOf(") RETURNS JSONB", start);
    const signature = sql.slice(start, end);

    expect(signature.indexOf("target_binding_id TEXT")).toBeLessThan(signature.indexOf("target_legacy_session_id TEXT"));
    expect(signature.indexOf("target_legacy_session_id TEXT")).toBeLessThan(signature.indexOf("target_room_id TEXT"));
    expect(signature.indexOf("target_room_id TEXT")).toBeLessThan(signature.indexOf("target_work_id TEXT"));
    expect(signature.indexOf("target_work_id TEXT")).toBeLessThan(signature.indexOf("target_operation_id TEXT"));
  });

  it("keeps Room-work reservation candidate locking inside the server-owned claim function in v91", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 91);
    expect(migration?.name).toBe("workspace_server_human_work_server_owned_claim");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_claim_human_work_launch(");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("target_reservation_id IS NULL");
    expect(sql).toContain("FOR UPDATE OF reservation SKIP LOCKED");
    expect(sql).toContain("samurai_can_room(target_workspace_id, reservation.room_id, 'execute')");
    expect(sql).toContain("RETURN NULL");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_claim_human_work_launch");
    expect(sql).not.toContain("GRANT UPDATE ON TABLE workspace_human_work_launch_reservations");
  });

  it("keeps the Room default-Agent lock inside a server-owned function in v92", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 92);
    expect(migration?.name).toBe("workspace_server_human_work_room_default_lock");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_lock_room_default_agent(");
    expect(sql).toContain("RETURNS TABLE(default_agent_id TEXT, default_agent_version BIGINT)");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("samurai_can_room(target_workspace_id, target_room_id, 'execute')");
    expect(sql).toContain("FOR SHARE");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_lock_room_default_agent(TEXT, TEXT) FROM PUBLIC");
  });

  it("clears terminal Room-work reservation lease state in v93", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 93);
    expect(migration?.name).toBe("workspace_server_human_work_terminal_reservation_state");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_normalize_human_work_launch_reservation_state()");
    expect(sql).toContain("NEW.status IN ('released', 'cancelled')");
    expect(sql).toContain("NEW.claimed_at := NULL");
    expect(sql).toContain("NEW.lease_owner := NULL");
    expect(sql).toContain("NEW.lease_expires_at := NULL");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF status ON workspace_human_work_launch_reservations");
  });

  it("captures the runtime Run link when Room work settles in v94", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 94);
    expect(migration?.name).toBe("workspace_server_human_work_assignment_run_link");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_capture_human_work_assignment_run_link()");
    expect(sql).toContain("NEW.result ->> 'run_id'");
    expect(sql).toContain("NEW.current_run_id := run_id");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF status, result ON workspace_human_work_assignments");
  });

  it("creates a new assignment and launch reservation for terminal Room-work replies in v95", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 95);
    expect(migration?.name).toBe("workspace_server_human_work_continuation_assignment");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_append_human_work_instruction(");
    expect(sql).toContain("target_source_kind IN ('reply', 'comment_reflection')");
    expect(sql).toContain("active_assignment_count = 0");
    expect(sql).toContain("status = 'outcome_unknown'");
    expect(sql).toContain("RAISE EXCEPTION 'human_work_outcome_unknown'");
    expect(sql).toContain("INSERT INTO workspace_human_work_assignments");
    expect(sql).toContain("parent_assignment_id, agent_id");
    expect(sql).toContain("INSERT INTO workspace_human_work_launch_reservations");
    expect(sql).toContain("status = 'queued'");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_append_human_work_instruction");
  });

  it("queues active Room-work continuations and only releases them after a known parent outcome in v96", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 96);
    expect(migration?.name).toBe("workspace_server_human_work_waiting_continuation");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_append_human_work_instruction(");
    expect(sql).toContain("active_assignment_count > 1 AND target_assignment_id IS NULL");
    expect(sql).toContain("RAISE EXCEPTION 'human_work_instruction_target_required'");
    expect(sql).toContain("status = 'waiting'");
    expect(sql).toContain("RAISE EXCEPTION 'human_work_instruction_child_pending'");
    expect(sql).toContain("parent_assignment_id, agent_id");
    expect(sql).toContain("status = 'reserved'");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_settle_human_work_assignment(");
    expect(sql).toContain("target_status IN ('completed', 'failed', 'cancelled') AND work_stop_state = 'none'");
    expect(sql).toContain("SET status = 'ready'");
    expect(sql).toContain("target_status = 'outcome_unknown'");
    expect(sql).toContain("status = 'reserved'");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_settle_human_work_assignment");
  });

  it("cancels waiting assignment-stop descendants and their reservations in v97", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 97);
    expect(migration?.name).toBe("workspace_server_human_work_assignment_stop_descendants");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_control_human_work(");
    expect(sql).toContain("target_action = 'assignment_stop'");
    expect(sql).toContain("WITH RECURSIVE assignment_tree AS");
    expect(sql).toContain("JOIN assignment_tree AS parent ON parent.id = child.parent_assignment_id");
    expect(sql).toContain("status IN ('queued', 'ready', 'waiting', 'blocked')");
    expect(sql).toContain("SET status = 'cancelled'");
    expect(sql).toContain("status = 'reserved'");
    expect(sql).toContain("released_at = COALESCE(reservation.released_at, NOW())");
    expect(sql).toContain("status IN ('reserved', 'claimed')");
    expect(sql).toContain("human_work_assignment_not_stoppable");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_control_human_work");
  });

  it("projects instruction state from assignment evidence in v98", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 98);
    expect(migration?.name).toBe("workspace_server_human_work_instruction_state_projection");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_human_work_instruction_state_for_assignment(");
    expect(sql).toContain("target_assignment_status IN ('queued', 'ready', 'running', 'blocked') THEN 'accepted'");
    expect(sql).toContain("target_assignment_status = 'waiting' AND target_parent_assignment_id IS NOT NULL THEN 'pending'");
    expect(sql).toContain("target_assignment_status = 'completed' THEN 'applied'");
    expect(sql).toContain("target_assignment_status IN ('failed', 'cancelled', 'outcome_unknown') THEN 'failed'");
    expect(sql).not.toContain("'delivered'");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF assignment_id ON workspace_human_work_instructions");
    expect(sql).toContain("AFTER INSERT OR UPDATE OF status, parent_assignment_id ON workspace_human_work_assignments");
    expect(sql).toContain("SET state = samurai_human_work_instruction_state_for_assignment(");
    expect(sql).toContain("FROM workspace_human_work_assignments AS assignment");
    expect(sql).toContain("DROP TRIGGER IF EXISTS workspace_human_work_instruction_state_before_write");
    expect(sql).toContain("DROP TRIGGER IF EXISTS workspace_human_work_instruction_state_after_assignment");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_human_work_instruction_state_for_assignment");
  });

  it("serializes Room-work active stop and runtime admission in v99", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 99);
    expect(migration?.name).toBe("workspace_server_human_work_active_stop_protocol");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("ALTER TABLE workspace_human_work_controls");
    expect(sql).toContain("lease_owner TEXT");
    expect(sql).toContain("lease_expires_at TIMESTAMPTZ");
    expect(sql).toContain("attempt BIGINT NOT NULL DEFAULT 0");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_control_human_work(");
    expect(sql).toContain("assignment.status = 'running' AND assignment.current_run_id IS NULL");
    expect(sql).toContain("target_action = 'assignment_stop'");
    expect(sql).toContain("status IN ('queued', 'ready', 'waiting', 'blocked')");
    expect(sql).not.toContain("human_work_assignment_not_stoppable");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_assert_human_work_runtime_admission(");
    expect(sql).toContain("human_work_execution_admission_closed");
    expect(sql).toContain("control.action = 'assignment_stop'");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_capture_human_work_runtime_run_link()");
    expect(sql).toContain("NEW.metadata -> 'runtime_binding'");
    expect(sql).toContain("assignment_row.current_run_id");
    expect(sql).toContain("CREATE TRIGGER workspace_human_work_runtime_run_link");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_claim_human_work_stop_dispatch(");
    expect(sql).toContain("'targets', targets");
    expect(sql).toContain("'reservation_id', reservation_id");
    expect(sql).toContain("'run_id', run_id");
    expect(sql).toContain("'lease_owner', target_lease_owner");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_reconcile_human_work_stop_dispatch(");
    expect(sql).toContain("target_outcome NOT IN ('completed', 'failed', 'cancelled', 'outcome_unknown')");
    expect(sql).toContain("stop_state = 'unconfirmed'");
    expect(sql).toContain("stop_state = 'confirmed', status = 'cancelled'");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_settle_human_work_assignment(");
    expect(sql).toContain("late result is accepted only when the server-owned Run link");
    expect(sql).toContain("IF stale_generation THEN");
    expect(sql).toContain("never releases a waiting");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_assert_human_work_runtime_admission");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_claim_human_work_stop_dispatch");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_reconcile_human_work_stop_dispatch");
  });

  it("projects unconfirmed stop assignees without exposing dispatch details in v100", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 100);
    expect(migration?.name).toBe("workspace_server_human_work_stop_unconfirmed_projection");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_project_human_work_stop_control_details()");
    expect(sql).toContain("unconfirmed_assignee_ids");
    expect(sql).toContain("assignment.status = 'outcome_unknown'");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF state, details ON workspace_human_work_controls");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_project_human_work_stop_control_details");
  });

  it("orders Room-work launch claim locks as Work, Assignment, Reservation in v101", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 101);
    expect(migration?.name).toBe("workspace_server_human_work_launch_lock_order");
    const sql = migration?.statements.join("\n") ?? "";
    const functionStart = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_claim_human_work_launch(");
    const functionEnd = sql.indexOf("$$`,", functionStart);
    const functionSql = sql.slice(functionStart, functionEnd);

    expect(functionSql).toContain("FOR UPDATE OF work SKIP LOCKED");
    expect(functionSql).toContain("FROM workspace_human_works\n        WHERE workspace_id = target_workspace_id AND id = candidate_work_id\n        FOR UPDATE SKIP LOCKED");
    expect(functionSql).toContain("FROM workspace_human_work_assignments\n        WHERE workspace_id = target_workspace_id");
    expect(functionSql).toContain("FROM workspace_human_work_launch_reservations\n        WHERE workspace_id = target_workspace_id");
    expect(functionSql.indexOf("FROM workspace_human_works\n        WHERE workspace_id = target_workspace_id AND id = candidate_work_id\n        FOR UPDATE SKIP LOCKED")).toBeLessThan(
      functionSql.indexOf("FROM workspace_human_work_assignments\n        WHERE workspace_id = target_workspace_id")
    );
    expect(functionSql.indexOf("FROM workspace_human_work_assignments\n        WHERE workspace_id = target_workspace_id")).toBeLessThan(
      functionSql.indexOf("FROM workspace_human_work_launch_reservations\n        WHERE workspace_id = target_workspace_id")
    );
    expect(functionSql).toContain("human_work_stopped");
    expect(functionSql).toContain("status IN ('ready', 'queued')");
    expect(functionSql).toContain("REVOKE EXECUTE ON FUNCTION samurai_claim_human_work_launch");
  });

  it("guards Room-work attachment refs against foreign, stale, and unsafe files in v103", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 103);
    expect(migration?.name).toBe("workspace_server_human_work_attachment_reference_guards");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_validate_human_work_attachment_refs()");
    expect(sql).toContain("samurai_can_room(NEW.workspace_id, NEW.room_id, 'read')");
    expect(sql).toContain("file.room_id = NEW.room_id");
    expect(sql).toContain("file_row.sha256 IS DISTINCT FROM attachment_id");
    expect(sql).toContain("file_row.version::TEXT IS DISTINCT FROM attachment_version");
    expect(sql).toContain("workspace_human_work_instruction_attachment_refs");
    expect(sql).toContain("workspace_human_work_comment_attachment_refs");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_validate_human_work_attachment_refs()");
  });

  it("keeps Agent DM permissions private while preserving normal Room and default-Agent paths in v108", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 108);
    expect(migration?.name).toBe("workspace_server_agent_dm_specialist_permission_guards");
    const sql = migration?.statements.join("\n") ?? "";

    const canAgentRoomStart = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_can_agent_room(");
    const canAgentRoomEnd = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_set_workspace_agent_room_permission(", canAgentRoomStart);
    const canAgentRoomSql = sql.slice(canAgentRoomStart, canAgentRoomEnd);
    expect(canAgentRoomSql).toContain("room.room_kind <> 'agent_dm' OR room.default_agent_id = permission.agent_id");

    const setPermissionStart = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_set_workspace_agent_room_permission(");
    const setPermissionEnd = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_remove_workspace_agent_room_permission(", setPermissionStart);
    const setPermissionSql = sql.slice(setPermissionStart, setPermissionEnd);
    expect(setPermissionSql).toContain("IF target_room_kind = 'agent_dm' THEN");
    expect(setPermissionSql).toContain("agent_dm_specialist_permission_denied");
    expect(setPermissionSql).toContain("agent_dm_default_agent_permission_immutable");
    // The guard is scoped to DM rows; the existing insert/upsert path remains
    // available for normal Rooms.
    expect(setPermissionSql).toContain("INSERT INTO workspace_agent_room_permissions(");

    const importPermissionStart = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_import_workspace_agent_room_permission(");
    const importPermissionEnd = sql.indexOf("REVOKE EXECUTE ON FUNCTION samurai_set_workspace_agent_room_permission", importPermissionStart);
    const importPermissionSql = sql.slice(importPermissionStart, importPermissionEnd);
    expect(importPermissionSql).toContain("IF target_room_kind = 'agent_dm'");
    expect(importPermissionSql).toContain("AND target_agent_id IS DISTINCT FROM target_default_agent_id");
    expect(importPermissionSql).toContain("RETURN;");
    // Invalid historical specialist rows are omitted from the restored target;
    // the migration never deletes the source row.
    expect(sql).not.toContain("DELETE FROM workspace_agent_room_permissions");

    const v89 = workspaceServerMigrationDefinitions().find((entry) => entry.version === 89);
    const v89Sql = v89?.statements.join("\n") ?? "";
    expect(v89Sql).toContain("target_room_kind = 'agent_dm', TRUE, 1");
    expect(v89Sql).toContain("INSERT INTO workspace_agent_room_permissions(");
    expect(v89Sql).toContain("agent_dm_default_agent_immutable");
  });

  it("projects legacy attachment history safely and terminally rejects it at launch in v110", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 110);
    expect(migration?.name).toBe("workspace_server_human_work_dm_attachment_compatibility");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("legacy_unresolved");
    expect(sql).toContain("samurai_project_human_work_attachment_refs");
    expect(sql).toContain("samurai_human_work_attachment_refs_have_unresolved");
    expect(sql).toContain("samurai_fail_human_work_launch_preflight");
    expect(sql).toContain("samurai.human_work.reassign");
    expect(sql).toContain("replaced_by_assignment_id");
    expect(sql).toContain("human_work_dm_delegation_forbidden");
    const dmGuardStart = sql.indexOf("CREATE OR REPLACE FUNCTION samurai_guard_human_work_dm_delegation()");
    const dmGuardEnd = sql.indexOf("DROP TRIGGER IF EXISTS workspace_human_work_dm_delegation_guard", dmGuardStart);
    expect(sql.slice(dmGuardStart, dmGuardEnd)).not.toContain("samurai_is_import_session");
  });

  it("rejects DM delegated restore and excludes superseded assignment subtrees from continuation in v111", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 111);
    expect(migration?.name).toBe("workspace_server_human_work_reassignment_continuation_boundary");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("human_work_reassign_parent_continuation_forbidden");
    expect(sql).toContain("samurai_human_work_assignment_is_superseded");
    expect(sql).toContain("NOT samurai_human_work_assignment_is_superseded(NEW.workspace_id, child.id)");
    expect(sql).toContain("NOT samurai_human_work_assignment_is_superseded(NEW.workspace_id, descendants.id)");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_human_work_assignment_outcome_tree");
  });

  it("repairs only structurally proven legacy reply continuation origins in v112", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 112);
    expect(migration?.name).toBe("workspace_server_human_work_legacy_reply_continuation_origin");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("samurai_is_legacy_human_work_reply_continuation");
    expect(sql).toContain("child.origin_kind = 'normal'");
    expect(sql).toContain("instruction.source_kind = 'reply'");
    expect(sql).toContain("child.agent_id = parent.agent_id");
    expect(sql).toContain("child.agent_version = parent.agent_version");
    expect(sql).toContain("parent.status IN ('completed', 'failed', 'cancelled')");
    expect(sql).toContain("NOT EXISTS (");
    expect(sql).toContain("room.room_kind = 'agent_dm'");
    expect(sql).toContain("SET origin_kind = 'parent_continuation'");
  });

  it("converges legacy v109 continuation definitions and classifies only reply children in v113", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 113);
    expect(migration?.name).toBe("workspace_server_human_work_continuation_legacy_checksum_convergence");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_human_work_reply_continuation_safe(");
    expect(sql).toContain("WITH RECURSIVE assignment_chain");
    expect(sql).toContain("reason' = 'reassigned");
    expect(sql).toContain("action = 'assignment_stop'");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_mark_human_work_reply_continuation()");
    expect(sql).toContain("NEW.source_kind IS DISTINCT FROM 'reply'");
    expect(sql).toContain("child.agent_id = parent.agent_id");
    expect(sql).toContain("child.agent_version = parent.agent_version");
    expect(sql).toContain("current_setting('samurai.human_work.reassign', true) = '1'");
    expect(sql).toContain("origin_kind = 'parent_continuation'");
    expect(sql).toContain("workspace_human_work_instruction_reply_continuation_origin");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_reassign_human_work(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_restore_human_work_assignment_origins(");
  });

  it("hardens continuation safety in the append-only v114 migration", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 114);
    expect(migration?.name).toBe("workspace_server_human_work_continuation_restore_safety");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("work.stop_state = 'none'");
    expect(sql).toContain("sibling.result ->> 'reason' = 'reassigned'");
    expect(sql).toContain("action = 'assignment_stop'");
    expect(sql).toContain("samurai_human_work_reply_continuation_safe(child.workspace_id, child.id, FALSE)");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_human_work_jsonb_field_safe(");
    expect(sql).toContain("EXCEPTION WHEN OTHERS THEN");
    expect(sql).not.toContain("pg_input_is_valid");
    expect(sql).toContain("samurai_human_work_jsonb_field_safe(instruction.body, 'kind')");
    expect(sql).toContain("Never demote an existing");
    expect(sql).toContain("WHERE item.origin_kind = 'parent_continuation'");
  });

  it("makes v115 reply-only and audits existing continuation rows before applying", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 115);
    expect(migration?.name).toBe("workspace_server_human_work_continuation_reply_only");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("instruction.source_kind = 'reply'");
    expect(sql).toContain("workspace_server_parent_continuation_invalid");
    expect(sql).toContain("origin_kind = 'parent_continuation'");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_regenerate_human_work_assignment_sibling_reservations()");
    expect(sql).toContain("WITH RECURSIVE stopped_tree");
    expect(sql).toContain("SET generation = work_generation");
    expect(sql).toContain("DROP FUNCTION IF EXISTS samurai_human_work_jsonb_field_safe(TEXT, TEXT)");
    expect(sql).not.toContain("source_kind = 'system'");
    expect(sql).not.toContain("SET origin_kind = 'normal'");
  });

  it("cancels reassigned descendant reservations and fails closed at claim in v116", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 116);
    expect(migration?.name).toBe("workspace_server_human_work_reassignment_descendant_claim_guard");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("samurai_cancel_human_work_reassigned_descendants");
    expect(sql).toContain("WITH RECURSIVE descendant_tree");
    expect(sql).toContain("assignment.status IN ('queued', 'ready', 'waiting', 'blocked')");
    expect(sql).toContain("reservation.status = 'reserved'");
    expect(sql).toContain("reason', 'reassigned'");
    expect(sql).toContain("NOT samurai_human_work_assignment_is_superseded(target_workspace_id, assignment.id)");
    expect(sql).toContain("IF samurai_human_work_assignment_is_superseded(target_workspace_id, assignment_row.id)");
    expect(sql).toContain("SET status = 'cancelled', released_at = COALESCE(released_at, NOW())");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_reassign_human_work(");
    expect(sql).toContain("PERFORM samurai_cancel_human_work_reassigned_descendants(");
  });

  it("requires stop reconciliation before reassignment and closes superseded dependencies in v117", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 117);
    expect(migration?.name).toBe("workspace_server_human_work_reassignment_stop_and_dependency_boundary");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("samurai_human_work_assignment_dependencies_safe");
    expect(sql).toContain("dependency.status = 'outcome_unknown'");
    expect(sql).toContain("samurai_human_work_assignment_is_superseded(target_workspace_id, dependency.id)");
    expect(sql).toContain("samurai_guard_human_work_reassign_transition");
    expect(sql).toContain("human_work_reassign_outcome_unknown");
    expect(sql).toContain("human_work_reassign_stop_required");
    expect(sql).toContain("human_work_reassign_stop_pending");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_human_work_reassignment_affected_assignments(");
    expect(sql).toContain("current_assignment.assignment_id = ANY(");
    expect(sql).toContain("FROM samurai_human_work_reassignment_affected_assignments(");
    expect(sql).toContain("SELECT dependent.id AS assignment_id");
    expect(sql).toContain("samurai_cancel_human_work_reassigned_descendants");
    expect(sql).toContain("ALTER FUNCTION samurai_claim_human_work_launch(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) RENAME TO samurai_claim_human_work_launch_v116");
    expect(sql).toContain("samurai_human_work_assignment_dependencies_safe");
    expect(sql).toContain("reason', 'dependency_reassigned'");
  });

  it("keeps invalid claims side-effect free and rejects A to B to C reassignment in v118", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 118);
    expect(migration?.name).toBe("workspace_server_human_work_reassignment_idempotency_and_claim_input_boundary");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("samurai_guard_human_work_reassign_superseded");
    expect(sql).toContain("human_work_assignment_already_reassigned");
    expect(sql).toContain("samurai_human_work_assignment_is_superseded(OLD.workspace_id, OLD.id)");
    expect(sql).toContain("ALTER FUNCTION samurai_claim_human_work_launch(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT)");
    expect(sql).toContain("RENAME TO samurai_claim_human_work_launch_v117");
    expect(sql).toContain("btrim(COALESCE(target_lease_owner, '')) = ''");
    expect(sql).toContain("target_lease_expires_at IS NULL");
    expect(sql).toContain("btrim(COALESCE(target_operation_id, '')) = ''");
    expect(sql).toContain("RETURN samurai_claim_human_work_launch_v116(");
    expect(sql).toContain("RETURN samurai_claim_human_work_launch_v117(");
  });

  it("stores reply/comment continuation origins at creation and repairs only safe legacy rows in v119", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 119);
    expect(migration?.name).toBe("workspace_server_human_work_continuation_origin_at_creation");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("pg_get_functiondef");
    expect(sql).toContain("instruction.source_kind IN (''reply'', ''comment_reflection'')");
    expect(sql).toContain("RENAME TO samurai_append_human_work_instruction_v118");
    expect(sql).toContain("target_source_kind IN ('reply', 'comment_reflection')");
    expect(sql).toContain("SET origin_kind = 'parent_continuation'");
    expect(sql).toContain("samurai_human_work_reply_continuation_safe(assignment.workspace_id, assignment.id, FALSE)");
    expect(sql).toContain("GET DIAGNOSTICS changed_count = ROW_COUNT");
    expect(sql).toContain("EXIT WHEN changed_count = 0");
  });

  it("qualifies runtime delegation bindings without weakening the Room/Work boundary in v120", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 120);
    expect(migration?.name).toBe("workspace_server_human_work_runtime_delegation_column_ambiguity_fix");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_delegate_human_work_from_runtime(");
    expect(sql).toContain("bound_work_id");
    expect(sql).toContain("bound_room_id");
    expect(sql).toContain("bound_parent_assignment_id");
    expect(sql).toContain("run_row.room_id IS DISTINCT FROM bound_room_id");
    expect(sql).toContain("assignment.work_id = bound_work_id");
    expect(sql).toContain("assignment.room_id = bound_room_id");
    expect(sql).toContain("samurai_can_room(target_workspace_id, bound_room_id, 'execute')");
    expect(sql).not.toContain("assignment.work_id = work_id");
    expect(sql).not.toContain("assignment.room_id = room_id");
  });

  it("requeues stale pre-admission sibling claims without reviving stopped descendants in v121", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 121);
    expect(migration?.name).toBe("workspace_server_human_work_assignment_stop_pre_admission_guard");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("samurai.human_work.assignment_stop");
    expect(sql).toContain("status = 'claimed'");
    expect(sql).toContain("assignment.current_run_id IS NULL");
    expect(sql).toContain("SET status = 'ready'");
    expect(sql).toContain("SET status = 'reserved', generation = work_generation");
    expect(sql).toContain("WITH RECURSIVE stopped_tree AS");
    expect(sql).toContain("NOT EXISTS (\n            SELECT 1 FROM stopped_tree");
    expect(sql).toContain("DROP TRIGGER IF EXISTS workspace_human_work_assignment_sibling_generation");
    expect(sql).toContain("CREATE TRIGGER workspace_human_work_assignment_sibling_generation");
  });

  it("rejects a second human in an Agent DM through the shared preview/mutation guard in v123", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 123);
    expect(migration?.name).toBe("workspace_server_agent_dm_human_membership_guard");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_room_member_change_impact(");
    expect(sql).toContain("target_room_kind TEXT");
    expect(sql).toContain("target_dm_account_id TEXT");
    expect(sql).toContain("target_account_id IS DISTINCT FROM target_dm_account_id");
    expect(sql).toContain("agent_dm_human_membership_forbidden");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_room_member_change_impact");

    const preview = workspaceServerMigrationDefinitions()
      .find((entry) => entry.version === 23)?.statements.join("\n") ?? "";
    expect(preview).toContain("impact := samurai_room_member_change_impact(");
    expect(preview).toContain("CREATE OR REPLACE FUNCTION samurai_set_room_member_with_impact(");
    expect(preview).toContain("impact := samurai_room_member_change_impact(");
  });

  it("recovers expired Room-work claims without relaunching an existing Runtime Run", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 124);
    expect(migration?.name).toBe("workspace_server_human_work_lease_recovery_and_runtime_fence");
    const sql = migration?.statements.join("\n") ?? "";

    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_recover_human_work_launch(");
    expect(sql).toContain("reservation.status = 'claimed'");
    expect(sql).toContain("current_run_id");
    expect(sql).toContain("'kind', 'requeued'");
    expect(sql).toContain("'kind', 'recovery'");
    expect(sql).toContain("'kind', 'skip'");
    expect(sql).toContain("samurai_human_work_assignment_is_superseded");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_assert_human_work_runtime_admission_v2(");
    expect(sql).toContain("reservation_row.lease_owner IS DISTINCT FROM btrim(target_lease_owner)");
    expect(sql).toContain("reservation_row.lease_expires_at <= NOW()");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_require_human_work_runtime_fence()");
    expect(sql).toContain("workspace_human_work_runtime_fence");
    expect(sql).toContain("binding ->> 'reservation_id'");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_recover_human_work_launch");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_assert_human_work_runtime_admission_v2");
  });

  it("restores human-work Completion refs only through the guarded v128 import", () => {
    const migration = workspaceServerMigrationDefinitions().find((entry) => entry.version === 128);
    expect(migration?.name).toBe("workspace_server_human_work_resource_refs_bundle_import");
    const sql = migration?.statements.join("\n") ?? "";
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_validate_human_work_resource_refs(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION samurai_import_workspace_human_work_v2(");
    expect(sql).toContain("workspace_bundle_human_work_resource_reference_invalid");
    expect(sql).toContain("workspace_bundle_human_work_resource_reference_not_found");
    expect(sql).toContain("workspace_bundle_human_work_resource_reference_scope_invalid");
    expect(sql).toContain("resource_refs");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION samurai_import_workspace_human_work_v2");
    expect(sql).toContain("PERFORM samurai_import_workspace_human_work(");
  });

});
