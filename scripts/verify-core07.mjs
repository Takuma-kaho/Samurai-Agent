import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, command, args, environment = {}) {
  console.log(`[Core07] ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...environment } });
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

function verifyCore07Boundary() {
  const ingest = read("packages/runtime/src/activity/activity-ingest-service.ts");
  const worker = read("packages/runtime/src/activity/workspace-job-worker.ts");
  const processor = read("packages/runtime/src/activity/activity-processor-port.ts");
  const runtime = read("packages/runtime/src/agent-runtime.ts");
  const runtimeComposition = [
    runtime,
    read("packages/runtime/src/composition/runtime-host.ts"),
    read("packages/runtime/src/composition/create-agent-host.ts")
  ].join("\n");
  const captureStart = runtime.indexOf("private async captureActivityForRun");
  const captureEnd = runtime.indexOf("private async linkActivityToRun", captureStart);
  const capture = captureStart >= 0 && captureEnd > captureStart ? runtime.slice(captureStart, captureEnd) : "";

  assert(!ingest.includes("enqueueWorkspaceJob("), "activity_ingest_must_not_enqueue_workspace_jobs");
  assert(!ingest.includes("saveMemory("), "activity_ingest_must_not_write_memory");
  assert(!ingest.includes("saveSkillMarkdown("), "activity_ingest_must_not_write_skill");
  assert(!ingest.includes("saveWikiPage("), "activity_ingest_must_not_write_knowledge");
  assert(!capture.includes("enqueueWorkspaceJob("), "activity_capture_must_not_auto_enqueue_job");
  assert(!capture.includes("registerLearningCandidateForCompletedRun"), "activity_capture_must_not_start_learning");
  assert(!processor.includes("WorkspaceStore"), "processor_port_must_not_receive_workspace_store");
  assert(!worker.includes("WorkspaceStore"), "job_worker_must_not_receive_workspace_store");
  assert(!worker.includes("enqueueWorkspaceJob("), "job_worker_must_not_enqueue_workspace_jobs");
  assert(!worker.includes("saveMemory("), "job_worker_must_not_write_memory");
  assert(!worker.includes("saveSkillMarkdown("), "job_worker_must_not_write_skill");
  assert(!worker.includes("saveWikiPage("), "job_worker_must_not_write_knowledge");
  assert(!runtimeComposition.includes("ActivityProcessorRegistry"), "core07_must_not_register_a_production_processor");
  assert(!runtimeComposition.includes("DeterministicFakeActivityProcessor"), "core07_must_not_register_the_test_processor");
  const activityMigration = read("packages/workspace-store/src/migrations/012-core07-activity-history.ts");
  const jobMigration = read("packages/workspace-store/src/migrations/013-core07-workspace-jobs.ts");
  assert(activityMigration.includes("activity_records"), "migration_012_activity_records_missing");
  assert(activityMigration.includes("resource_usage_records_update_immutable"), "migration_012_resource_usage_immutability_missing");
  assert(jobMigration.includes("workspace_job_attempts"), "migration_013_workspace_job_attempts_missing");
  assert(jobMigration.includes("prepared_at IS NOT NULL"), "migration_013_attempt_input_preparation_missing");
}

function verifyChangedScope() {
  const output = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const allowed = [
    "ARCHITECTURE.md",
    "SAMURAI_AGENT_MANUAL.md",
    "package.json",
    "plans/",
    "scripts/verify-core07.mjs",
    "packages/core-schemas/",
    "packages/workspace-store/",
    "packages/runtime/"
  ];
  for (const line of output.split("\n").filter(Boolean)) {
    const changedPath = line.slice(3).replace(/^"|"$/g, "");
    assert(allowed.some((prefix) => changedPath === prefix || changedPath.startsWith(prefix)), `core07_scope_violation:${changedPath}`);
  }
}

const focusedTests = [
  "packages/core-schemas/src/core07-activity-job.test.ts",
  "packages/workspace-store/src/core07-activity-job-foundation.test.ts",
  "packages/runtime/src/core07-activity-job-runtime.test.ts",
  "packages/workspace-store/src/core06-room-permissions.test.ts",
  "packages/runtime/src/core05-learning-foundation.test.ts",
  "packages/runtime/src/core06-room-authorization.test.ts",
  "packages/runtime/src/core06-workspace-execution.test.ts"
];

try {
  verifyChangedScope();
  verifyCore07Boundary();
  run("architecture boundaries", "node", ["scripts/verify-architecture-boundaries.mjs"], { SAMURAI_EVIDENCE_MODE: "deferred" });
  run("focused Core05-Core07 tests", "pnpm", ["exec", "vitest", "run", ...focusedTests]);
  for (const packageName of ["@samurai-agent/core-schemas", "@samurai-agent/workspace-store", "@samurai-agent/runtime"]) {
    run(`typecheck ${packageName}`, "pnpm", ["--filter", packageName, "run", "typecheck"]);
  }
  run("diff check", "git", ["diff", "--check"]);
  console.log("[Core07] PASS");
} catch (error) {
  console.error(`[Core07] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
