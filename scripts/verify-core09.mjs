import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, command, args, environment = {}) {
  console.log(`[Core09] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...environment }
  });
  if (result.status !== 0) {
    const detail = result.signal ? `signal=${result.signal}` : `exit=${result.status ?? "unknown"}`;
    throw new Error(`${label}:${detail}`);
  }
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyChangedScope() {
  const output = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const allowed = [
    "PRODUCT.md",
    "ARCHITECTURE.md",
    "package.json",
    "pnpm-lock.yaml",
    "plans/",
    "reports/",
    "apps/desktop/",
    "apps/server/",
    "apps/web/",
    "scripts/",
    "packages/collections/",
    "packages/core-schemas/",
    "packages/domain-operations/",
    "packages/external-integration/",
    "packages/gateway/",
    "packages/room-permissions/",
    "packages/runtime/",
    "packages/ui-protocol/",
    "packages/workspace-server/",
    "packages/workspace-store/"
  ];
  for (const line of output.split("\n").filter(Boolean)) {
    const changedPath = line.slice(3).replace(/^"|"$/g, "");
    assert(allowed.some((prefix) => changedPath === prefix || changedPath.startsWith(prefix)), `core09_scope_violation:${changedPath}`);
  }
}

function verifyCore09Boundary() {
  const schema = read("packages/core-schemas/src/index.ts");
  const migration = read("packages/workspace-store/src/migrations/015-core09-external-ingress-automation-boundary.ts");
  const managerLocksMigration = read("packages/workspace-store/src/migrations/016-core09-automation-manager-locks.ts");
  const repository = read("packages/workspace-store/src/repositories/external-app-connection-repository.ts");
  const resolver = read("packages/runtime/src/external-app/external-app-context-resolver.ts");
  const ingress = read("packages/runtime/src/external-app/external-app-ingress.ts");
  const referenceAdapter = read("packages/runtime/src/external-app/reference-adapter.ts");
  const runtime = read("packages/runtime/src/agent-runtime.ts");
  const automation = read("packages/runtime/src/commands/services/core09-automation-domain-service.ts");
  const access = read("packages/domain-operations/src/definition/access-classification.ts");
  const automationRun = read("packages/domain-operations/src/operations/automation/job/run.operation.ts");
  const gateway = read("packages/gateway/src/formal-workspace-ingress.ts");
  const activity = read("packages/runtime/src/activity/activity-ingest-service.ts");

  assert(schema.includes("ExternalAppConnectionRecordSchema"), "core09_connection_schema_missing");
  assert(schema.includes("connectionMetadataEnvironments"), "core09_connection_metadata_allowlist_missing");
  assert(schema.includes("automationManagementStates"), "core09_automation_management_state_missing");
  assert(schema.includes("rebind_required"), "core09_automation_rebind_state_missing");
  assert(migration.includes("external_app_connections"), "core09_connection_migration_missing");
  assert(migration.includes("UPDATE automation_jobs SET authorization_state = 'rebind_required'"), "core09_legacy_job_must_not_be_inferred");
  assert(migration.includes("session_ref_json"), "core09_session_ref_compatibility_missing");
  assert(managerLocksMigration.includes("management_state"), "core09_manager_state_migration_missing");
  assert(managerLocksMigration.includes("lock_owner_token"), "core09_lock_token_migration_missing");
  assert(managerLocksMigration.includes("idx_automation_runs_one_started_per_job"), "core09_single_started_run_index_missing");
  assert(managerLocksMigration.includes("automation_execution_interrupted"), "core09_interrupted_run_migration_missing");
  assert(repository.includes("external_app_connection_reactivation_forbidden"), "core09_connection_reactivation_guard_missing");

  assert(resolver.includes("ConnectorEvidenceSchema.parse"), "core09_connector_evidence_validation_missing");
  assert(resolver.includes("external_app_connection_room_scope_denied"), "core09_connection_room_scope_guard_missing");
  assert(resolver.includes("external_app_ingress_class_denied"), "core09_ingress_scope_guard_missing");
  assert(resolver.includes("external_app_room_permission_denied"), "core09_current_room_permission_guard_missing");
  for (const forbidden of ["createSession(", "saveExternalAppConnection(", "saveAutomationJob(", "runChatTurn("]) {
    assert(!resolver.includes(forbidden), `core09_resolver_side_effect_forbidden:${forbidden}`);
  }

  assert(ingress.includes('ingressClass: "query"'), "core09_query_ingress_missing");
  assert(ingress.includes('ingressClass: "domain_operation"'), "core09_domain_operation_ingress_missing");
  assert(ingress.includes('ingressClass: "activity_ingest"'), "core09_activity_ingest_missing");
  assert(!ingress.includes("WorkspaceStore"), "core09_adapter_must_not_receive_store");
  assert(!ingress.includes("createSession("), "core09_ingress_must_not_create_session");
  assert(ingress.includes("ExternalActivityIngestSchema"), "core09_activity_public_shape_missing");
  assert(ingress.includes('usage_scope: { kind: "room"'), "core09_activity_usage_scope_must_be_server_owned");
  assert(runtime.includes('const recordQueryAudit = inputSource !== "external_app"'), "core09_external_query_must_skip_audit_write");
  assert(!referenceAdapter.includes("fetch("), "core09_reference_adapter_must_not_open_transport");
  assert(!referenceAdapter.includes("listen("), "core09_reference_adapter_must_not_open_port");

  assert(access.includes('scope: "automation_execution"'), "core09_scheduler_scope_missing");
  assert(automationRun.includes('"automation"') && automationRun.includes('"scheduled_context"'), "core09_scheduler_sources_missing");
  assert(!automationRun.includes('"runtime_api"'), "core09_scheduler_must_not_be_public_runtime_api");
  assert(automation.includes('authorityFromJob(locked, "execute")'), "core09_authority_must_be_rechecked_after_lock");
  assert(automation.includes("lockOwnerToken"), "core09_lock_owner_token_missing");
  assert(automation.includes("managerStop"), "core09_manager_stop_missing");
  assert(automation.includes("recoverInterruptedRuns"), "core09_restart_recovery_missing");
  assert(automation.includes("attachAutomationRunEvidence"), "core09_run_evidence_link_missing");
  assert(automation.includes("automation_sessionless_executor_unsupported"), "core09_unsupported_automation_must_stop");
  for (const forbidden of ["ensureSession", "createGatewayEnvelope", "runChatTurn(", "system:unbound-gateway", "enqueueWorkspaceJob(", "heartbeatAutomationJobLock", "state_version", "AbortSignal"]) {
    assert(!automation.includes(forbidden), `core09_automation_session_or_job_fallback_forbidden:${forbidden}`);
  }

  assert(gateway.includes("class GatewayFormalWorkspaceIngress"), "core09_gateway_formal_ingress_missing");
  assert(!gateway.includes("WorkspaceStore"), "core09_gateway_must_not_receive_store");
  assert(!activity.includes("enqueueWorkspaceJob("), "core09_activity_must_not_enqueue_job");
  assert(!activity.includes("saveMemory("), "core09_activity_must_not_generate_memory");
  assert(!activity.includes("saveSkillMarkdown("), "core09_activity_must_not_generate_skill");
  assert(!activity.includes("saveWikiPage("), "core09_activity_must_not_generate_knowledge");
  assert(activity.includes("activity_external_resource_kind_not_allowed"), "core09_activity_external_resource_boundary_missing");
  assert(activity.includes("assertOperationScopes"), "core09_activity_operation_scope_boundary_missing");
}

const focusedTests = [
  "packages/core-schemas/src/core07-activity-job.test.ts",
  "packages/workspace-store/src/core06-room-permissions.test.ts",
  "packages/runtime/src/core06-room-authorization.test.ts",
  "packages/runtime/src/core06-workspace-execution.test.ts",
  "packages/workspace-store/src/core07-activity-job-foundation.test.ts",
  "packages/runtime/src/core07-activity-job-runtime.test.ts",
  "packages/workspace-store/src/core08-resource-session-boundary-migration.test.ts",
  "packages/runtime/src/activity/resource-mutation-activity-service.test.ts",
  "packages/workspace-store/src/core09-external-ingress-automation-migration.test.ts",
  "packages/runtime/src/core09-external-app-ingress.test.ts",
  "packages/runtime/src/core09-automation-sessionless.test.ts",
  "packages/gateway/src/formal-workspace-ingress.test.ts"
];

try {
  verifyChangedScope();
  verifyCore09Boundary();
  run("generated operation bindings", "node", ["scripts/generate-domain-operation-index.mjs", "--check"]);
  run("focused Core06-Core09 tests", "pnpm", ["exec", "vitest", "run", ...focusedTests]);
  run("Gateway restart recovery", "node", ["--import", "tsx", "scripts/verify-gateway-recovery.mjs"]);
  for (const packageName of [
    "@samurai-agent/core-schemas",
    "@samurai-agent/room-permissions",
    "@samurai-agent/domain-operations",
    "@samurai-agent/workspace-store",
    "@samurai-agent/runtime",
    "@samurai-agent/gateway"
  ]) {
    run(`typecheck ${packageName}`, "pnpm", ["--filter", packageName, "run", "typecheck"]);
  }
  run("diff check", "git", ["diff", "--check"]);
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  console.log(`[Core09] PASS base=${sha}`);
} catch (error) {
  console.error(`[Core09] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
