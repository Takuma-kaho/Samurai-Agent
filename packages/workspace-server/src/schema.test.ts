import { describe, expect, it } from "vitest";
import { workspaceServerMigrationDefinitions, workspaceServerMigrationStatus } from "./schema";

describe("Workspace Server PostgreSQL schema", () => {
  it("defines tenant RLS for records, files, history, jobs, and notifications", () => {
    const migrations = workspaceServerMigrationDefinitions();
    const schema = migrations.flatMap((migration) => migration.statements).join("\n");

    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
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
    expect(schema).toContain("samurai_has_workspace_membership");
    expect(schema).toContain("target_receipt->>'target_integrity_hash' IS DISTINCT FROM exported_hash");
    expect(schema).toContain("workspace_transfer_bundle_conflict");
    expect(schema).toContain("room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')");
    expect(schema).toContain("target_status NOT IN ('active', 'disabled')");
  });
});
