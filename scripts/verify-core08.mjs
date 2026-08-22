import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, command, args, environment = {}) {
  console.log(`[Core08] ${label}`);
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

function verifyCore08Boundary() {
  const artifact = read("packages/runtime/src/commands/services/artifact-domain-service.ts");
  const artifactCreateOperation = read("packages/domain-operations/src/operations/artifact/create.operation.ts");
  const collection = read("packages/runtime/src/commands/services/collection-domain-service.ts");
  const surface = read("packages/runtime/src/commands/services/generated-surface-domain-service.ts");
  const activity = read("packages/runtime/src/activity/resource-mutation-activity-service.ts");
  const runtime = read("packages/runtime/src/agent-runtime.ts");
  const changeSchema = read("packages/core-schemas/src/index.ts");
  const migration = read("packages/workspace-store/src/migrations/014-core08-resource-session-boundary.ts");
  const changeRepository = read("packages/workspace-store/src/repositories/session-execution-repository.ts");
  const surfaceRepository = read("packages/workspace-store/src/repositories/generated-surface-repository.ts");
  const surfaceInteraction = read("packages/domain-operations/src/operations/generated_surface/interaction/record.operation.ts");
  const surfaceState = read("packages/domain-operations/src/operations/generated_surface/state.operation.ts");
  const catalog = read("packages/workspace-store/src/kernel/workspace-resource-catalog.ts");
  const backup = read("packages/workspace-store/src/backup/workspace-bundle-service.ts");
  const roomPermissions = read("packages/domain-operations/src/value-objects/room-permissions.ts");

  assert(!artifact.includes("ensureArtifactSession"), "artifact_mutation_must_not_create_a_session");
  assert(!artifact.includes("createArtifactEnvelope"), "artifact_mutation_must_not_create_a_message_envelope");
  assert(artifactCreateOperation.includes("createdBy: trustedCreatorId(context)"), "artifact_creator_must_come_from_trusted_principal");
  assert(!collection.includes("ensureCollectionMutationSession"), "collection_mutation_must_not_create_a_session");
  assert(!collection.includes("runChatTurn("), "collection_instruction_must_not_use_a_chat_turn");
  assert(!surface.includes("generated_surface_session_required"), "generated_surface_mutation_must_not_require_a_session");
  assert(activity.includes("getActivityByBackendRunId"), "resource_mutation_must_reuse_a_parent_activity");
  assert(activity.includes("commitResourceMutationEvidence"), "resource_mutation_evidence_must_be_atomic");
  assert(runtime.includes("error instanceof ResourceMutationEvidenceError"), "committed_resource_evidence_failure_must_not_mark_operation_failed");
  for (const forbidden of ["enqueueWorkspaceJob(", "saveMemory(", "saveSkillMarkdown(", "saveWikiPage(", "registerLearningCandidate"]) {
    assert(!activity.includes(forbidden), `resource_mutation_must_not_start_learning_or_jobs:${forbidden}`);
  }
  assert(runtime.includes("collectionRecordResourceId(collectionTarget.collectionId, collectionTarget.recordId)"), "collection_record_boundary_must_use_canonical_identity");
  assert(migration.includes("workspace_changes_v14"), "migration_014_workspace_changes_missing");
  assert(migration.includes("activity_id TEXT"), "migration_014_workspace_change_activity_missing");
  assert(migration.includes("domain_operation_id TEXT"), "migration_014_workspace_change_operation_missing");
  assert(migration.includes("session_id TEXT REFERENCES sessions"), "migration_014_session_compatibility_missing");
  assert(migration.includes("generated_surfaces_v14"), "migration_014_generated_surface_missing");
  assert(changeSchema.includes("NewWorkspaceChangeRecordSchema"), "new_workspace_changes_must_have_a_write_schema");
  assert(changeRepository.includes("workspace_change_room_required"), "new_workspace_change_must_name_a_room");
  assert(changeRepository.includes("workspace_change_legacy_operation_write_forbidden"), "legacy_operation_must_be_read_only");
  assert(changeRepository.includes("commitResourceMutationEvidence"), "change_usage_activity_must_commit_together");
  assert(surfaceRepository.includes("isMissingFileError"), "missing_derived_surface_bundle_must_be_a_cache_miss");
  assert(surfaceInteraction.includes("isDisplayOnlyInteraction") && surfaceState.includes("!context.sessionId"), "sessionless_surface_display_state_must_be_rejected");
  assert(catalog.includes('owner: "generated_surface"') && catalog.includes("backup_roots: []"), "surface_must_be_derived_in_backup_catalog");
  assert(backup.includes("Core08 no longer emits it"), "backup_must_keep_legacy_surface_restore_only");
  assert(roomPermissions.includes("New shares exclude app-owned Sessions and derived Generated Surfaces."), "new_generated_surface_shares_must_be_forbidden");
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
    assert(allowed.some((prefix) => changedPath === prefix || changedPath.startsWith(prefix)), `core08_scope_violation:${changedPath}`);
  }
}

const focusedTests = [
  "packages/domain-operations/src/operations/artifact/artifact-create.operation.test.ts",
  "packages/domain-operations/src/operations/artifact/artifact-revise.operation.test.ts",
  "packages/domain-operations/src/operations/artifact/artifact-restore-revision.operation.test.ts",
  "packages/domain-operations/src/operations/artifact/artifact-repair.operation.test.ts",
  "packages/domain-operations/src/operations/artifact/artifact-export-pdf.operation.test.ts",
  "packages/domain-operations/src/operations/graph/graph-create.operation.test.ts",
  "packages/domain-operations/src/operations/graph/graph-patch.operation.test.ts",
  "packages/domain-operations/src/operations/image/image-generate.operation.test.ts",
  "packages/domain-operations/src/operations/image/image-edit.operation.test.ts",
  "packages/domain-operations/src/operations/collection/reindex.operation.test.ts",
  "packages/runtime/src/core06-room-authorization.test.ts",
  "packages/runtime/src/core06-workspace-execution.test.ts",
  "packages/runtime/src/activity/resource-mutation-activity-service.test.ts",
  "packages/runtime/src/commands/domain-command-bus.test.ts",
  "packages/domain-operations/src/operations/generated_surface/interaction/record.operation.test.ts",
  "packages/domain-operations/src/operations/generated_surface/state.operation.test.ts",
  "packages/runtime/src/generated-surface-action-ingress.test.ts",
  "packages/workspace-store/src/core08-resource-session-boundary-migration.test.ts",
  "packages/workspace-store/src/workspace-store.test.ts"
];

const typecheckPackages = [
  "@samurai-agent/core-schemas",
  "@samurai-agent/room-permissions",
  "@samurai-agent/action-catalog",
  "@samurai-agent/domain-operations",
  "@samurai-agent/artifacts",
  "@samurai-agent/collections",
  "@samurai-agent/workspace-store",
  "@samurai-agent/runtime"
];

try {
  verifyChangedScope();
  verifyCore08Boundary();
  run("generated operation bindings", "node", ["scripts/generate-domain-operation-index.mjs", "--check"]);
  run("focused tests", "pnpm", ["exec", "vitest", "run", ...focusedTests]);
  run("artifact fixture", "pnpm", ["core:test:artifact"]);
  run("collection safety fixture", "pnpm", ["core:test:collection-safety"]);
  run("generated surface validation", "pnpm", ["core:test:generated-surface"]);
  run("generated surface lifecycle", "pnpm", ["core:test:surface-lifecycle"]);
  run("Core08 backup and portability", "node", ["scripts/verify-workspace-persistence.mjs", "--only=workspace-bundle-restore,workspace-portability"]);
  for (const packageName of typecheckPackages) {
    run(`typecheck ${packageName}`, "pnpm", ["--filter", packageName, "run", "typecheck"]);
  }
  run("diff check", "git", ["diff", "--check"]);
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  console.log(`[Core08] PASS base=${sha}`);
} catch (error) {
  console.error(`[Core08] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
