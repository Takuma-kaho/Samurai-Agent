import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, command, args, options = {}) {
  console.log(`[Server02] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...(options.env ?? {}) }
  });
  if (result.status !== 0) {
    const detail = result.signal ? `signal=${result.signal}` : `exit=${result.status ?? "unknown"}`;
    throw new Error(`${label}:${detail}`);
  }
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function verifyStaticContract() {
  const schema = read("packages/workspace-server/src/schema.ts");
  const server = read("apps/server/src/workspace-server/http-server.ts");
  const bundle = read("packages/workspace-server/src/workspace-bundle-v3.ts");
  const config = read("packages/workspace-server/src/config.ts");
  const sqliteMigration = read("packages/workspace-server/src/sqlite-migration.ts");
  const compose = read("docker/self-host/compose.yaml");
  const packageJson = JSON.parse(read("package.json"));
  const lockfile = read("pnpm-lock.yaml");
  assert(schema.includes("ENABLE ROW LEVEL SECURITY"), "server02_rls_missing");
  assert(schema.includes("samurai_current_workspace_id()"), "server02_workspace_context_missing");
  assert(schema.includes("account_operations"), "server02_workspace_creation_idempotency_missing");
  assert(schema.includes("workspace_last_owner_cannot_be_revoked"), "server02_owner_role_guard_missing");
  assert(schema.includes("REVOKE CREATE ON SCHEMA public FROM PUBLIC"), "server02_public_schema_create_not_revoked");
  assert(!schema.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public"), "server02_runtime_role_grant_too_broad");
  assert(server.includes("emitAuthorizedRoomWorkspaceEvent"), "server02_room_realtime_isolation_missing");
  assert(server.includes("authenticateInvitationAcceptance"), "server02_invitation_acceptance_auth_missing");
  assert(server.includes("workspaceInvitationLink"), "server02_invitation_link_missing");
  assert(server.includes("x-samurai-operation-id"), "server02_operation_id_missing");
  assert(server.includes("commands."), "server02_http_command_boundary_missing");
  const nanoidOverride = packageJson.pnpm?.overrides?.nanoid;
  assert(typeof nanoidOverride === "string" && patchedNanoidVersion(nanoidOverride), "server02_nanoid_security_override_missing");
  assert(lockfile.includes(`\n  nanoid: ${nanoidOverride}\n`), "server02_nanoid_lockfile_override_drift");
  const lockedNanoidVersions = [...lockfile.matchAll(/\n  nanoid@(\d+\.\d+\.\d+):/g)].map((match) => match[1]);
  assert(lockedNanoidVersions.length > 0 && lockedNanoidVersions.every(patchedNanoidVersion), "server02_nanoid_vulnerable_lockfile_entry");
  assert(bundle.includes("verifyWorkspaceBundleV3"), "server02_bundle_hash_verification_missing");
  assert(schema.includes("target_status <> 'active'"), "server02_import_account_boundary_missing");
  assert(schema.includes("samurai_finalize_workspace_file_transaction"), "server02_file_recovery_boundary_missing");
  assert(schema.includes("samurai_has_workspace_membership"), "server02_operation_completion_boundary_missing");
  assert(schema.includes("target_receipt->>'target_integrity_hash' IS DISTINCT FROM exported_hash"), "server02_transfer_receipt_hash_boundary_missing");
  assert(schema.includes("workspaceServerMigrationStatus"), "server02_schema_readiness_guard_missing");
  assert(schema.includes("REVOKE INSERT, UPDATE, DELETE ON TABLE samurai_server_schema_migrations"), "server02_runtime_migration_write_grant_missing");
  assert(schema.includes("workspace_operations_update"), "server02_operation_ledger_immutability_missing");
  assert(schema.includes("workspace_transfer_bundle_conflict"), "server02_transfer_export_retry_guard_missing");
  assert(schema.includes("room_id IS NOT NULL AND samurai_can_room(workspace_id, room_id, 'read')"), "server02_audit_room_rls_missing");
  assert(schema.includes("target_status NOT IN ('active', 'disabled')"), "server02_bundle_account_status_guard_missing");
  assert(config.includes("samurai_database_admin_url_forbidden_at_runtime"), "server02_runtime_admin_url_boundary_missing");
  assert(config.includes("samurai_public_base_url_required"), "server02_invitation_public_origin_missing");
  assert(sqliteMigration.includes("query_only = ON"), "server02_sqlite_readonly_migration_missing");
  assert(sqliteMigration.includes("copyLegacySqliteReadSource"), "server02_sqlite_source_copy_missing");
  assert(sqliteMigration.includes("omitted_unverified_workspace_memberships"), "server02_sqlite_identity_boundary_missing");
  assert(compose.includes("SAMURAI_SERVER_MODE: self_host"), "server02_self_host_compose_missing");
  assert(compose.includes("SAMURAI_DATABASE_RUNTIME_ROLE"), "server02_runtime_role_missing");
  for (const relative of ["docker/self-host/scripts/backup.sh", "docker/self-host/scripts/restore.sh", "docker/self-host/scripts/update.sh"]) {
    assert(existsSync(path.join(root, relative)), `server02_operational_script_missing:${relative}`);
  }
}

function liveProbeConfiguration() {
  const modes = ["HOSTED", "SELF_HOST"];
  const configured = modes.map((mode) => ({
    mode,
    databaseUrl: process.env[`SAMURAI_SERVER_VERIFY_${mode}_DATABASE_URL`],
    adminDatabaseUrl: process.env[`SAMURAI_SERVER_VERIFY_${mode}_DATABASE_ADMIN_URL`],
    runtimeRole: process.env[`SAMURAI_SERVER_VERIFY_${mode}_DATABASE_RUNTIME_ROLE`]
  }));
  const present = configured.filter((item) => item.databaseUrl || item.adminDatabaseUrl || item.runtimeRole);
  if (present.length === 0) return false;
  if (present.length !== modes.length || configured.some((item) => !item.databaseUrl || !item.adminDatabaseUrl || !item.runtimeRole)) {
    throw new Error("server02_live_rls_requires_hosted_and_self_host_database_settings");
  }
  if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
    throw new Error("server02_live_rls_requires_explicit_destructive_probe_confirmation");
  }
  return true;
}

function patchedNanoidVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 3 || (major === 3 && (minor > 3 || (minor === 3 && patch >= 18)));
}

try {
  verifyStaticContract();
  run("architecture boundaries", "node", ["scripts/verify-architecture-boundaries.mjs"], {
    env: { SAMURAI_EVIDENCE_MODE: "deferred" }
  });
  if (process.env.CI === "true" || process.env.SAMURAI_SERVER_VERIFY_ONLINE_AUDIT === "yes") {
    run("high severity dependency audit", "pnpm", ["audit", "--audit-level=high"]);
  } else {
    console.log("[Server02] オンライン依存監査はCIまたは明示指定時に実行します。");
  }
  run("Workspace Server typecheck", "pnpm", ["--filter", "@samurai-agent/workspace-server", "run", "typecheck"]);
  run("HTTP Server typecheck", "pnpm", ["--filter", "@samurai-agent/server", "run", "typecheck"]);
  run("Desktop connection typecheck", "pnpm", ["--filter", "@samurai-agent/desktop", "run", "typecheck"]);
  run("Native App connection Web build", "pnpm", ["--filter", "@samurai-agent/web", "run", "build"]);
  run("focused tests", "pnpm", ["exec", "vitest", "run",
    "packages/workspace-server/src/auth.test.ts",
    "packages/workspace-server/src/config.test.ts",
    "packages/workspace-server/src/schema.test.ts",
    "packages/workspace-server/src/sqlite-migration.test.ts",
    "packages/workspace-server/src/workspace-bundle-v3.test.ts",
    "packages/workspace-server/src/self-host-owner.test.ts",
    "apps/server/src/workspace-server/realtime.test.ts",
    "apps/desktop/src/workspace-connections.test.ts",
    "apps/desktop/src/workspace-request-signing.test.ts"
  ]);
  if (liveProbeConfiguration()) {
    run("Hosted and Self-host PostgreSQL RLS probes", "node", ["--import", "tsx", "scripts/verify-server-02-rls.ts"]);
  } else {
    console.log("[Server02] PostgreSQL実機RLS検証は未設定のため未実行です。");
  }
  run("diff check", "git", ["diff", "--check"]);
  console.log("[Server02] PASS");
} catch (error) {
  console.error(`[Server02] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
