import { describe, expect, it } from "vitest";
import { workspaceServerMigrationDefinitions, workspaceServerMigrationStatus } from "./schema";

describe("Workspace Server PostgreSQL schema", () => {
  it("defines tenant RLS for records, files, history, jobs, and notifications", () => {
    const migrations = workspaceServerMigrationDefinitions();
    const schema = migrations.flatMap((migration) => migration.statements).join("\n");

    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41]);
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
    expect(schema).toContain("samurai_repair_workspace_bundle_v4_legacy_ledger");
    expect(schema).toContain("samurai_guard_completion_machine_attestation");
  });
});
