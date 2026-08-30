import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = path.join(root, "plans/phase-0-1-entry-ledger.json");
execFileSync(process.execPath, [path.join(root, "scripts/generate-phase01-entry-ledger.mjs"), "--check"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/generate-phase01-public-spec.mjs"), "--check"], { cwd: root, stdio: "inherit" });
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const requiredRequirements = ["P0-01", "P0-02", "P0-03", "P0-04", "P1-01", "P1-02", "P1-03", "P1-04", "P1-05", "P1-06", "P1-07", "P1-08", "P1-09"];
assert.deepEqual(ledger.phase_scope, Array.from({ length: 11 }, (_value, index) => index));
assert.deepEqual(ledger.requirements.map((requirement) => requirement.id), requiredRequirements);
assert.ok(ledger.entries.length > 0, "phase01_entry_ledger_empty");
assert.equal(ledger.entries.filter((entry) => !entry.classification).length, 0, "phase01_entry_unclassified");
assert.equal(ledger.entries.filter((entry) => entry.direct_persistence === true).length, 0, "phase01_direct_persistence_entry");
for (const entry of ledger.entries) {
  for (const field of ["current_handler", "persistence_responsibility", "authorization_scope", "idempotency", "emitted_event", "migration_phase", "related_tests", "direct_persistence_evidence", "out_of_scope_reason", "requirement_ids"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(entry, field), `${entry.id}:${field}_missing`);
  }
  assert.ok(Array.isArray(entry.related_tests), `${entry.id}:related_tests_invalid`);
  assert.ok(Array.isArray(entry.direct_persistence_evidence), `${entry.id}:direct_persistence_evidence_invalid`);
  assert.ok(Array.isArray(entry.requirement_ids) && entry.requirement_ids.length > 0, `${entry.id}:requirement_ids_invalid`);
}
for (const entry of ledger.entries) {
  if (entry.classification === "internal_management") assert.ok(entry.classification_reason, `${entry.id}:internal_reason_missing`);
  if (entry.compatibility === true) assert.ok(entry.compatibility_exit_condition, `${entry.id}:compatibility_exit_condition_missing`);
}
const v1Paths = new Set(ledger.entries.filter((entry) => entry.path.startsWith("/api/v1/")).map((entry) => `${entry.method} ${entry.path}`));
for (const required of [
  "GET /api/v1/workspaces/:workspaceId/domain/catalog",
  "POST /api/v1/workspaces/:workspaceId/domain/operations/:operationId",
  "POST /api/v1/workspaces/:workspaceId/domain/queries/:queryId",
  "POST /api/v1/workspaces/:workspaceId/activities",
  "POST /api/v1/workspaces/:workspaceId/runs/:runId/actions/:action",
  "GET /api/v1/workspaces/:workspaceId/events"
]) assert.ok(v1Paths.has(required), `phase01_required_v1_entry_missing:${required}`);
assert.ok(ledger.entries.some((entry) => entry.entry_kind === "socket_event" && entry.path === "workspace:v1:resync"), "phase01_v1_socket_resync_missing");
assert.ok(ledger.entries.some((entry) => entry.entry_kind === "socket_event" && entry.path === "workspace:v1:event"), "phase01_v1_socket_event_missing");

const domainOperationsRoot = path.join(root, "packages/domain-operations/src/operations");
const operationFiles = filesUnder(domainOperationsRoot).filter((file) => file.endsWith(".operation.ts"));
assert.ok(operationFiles.length > 0, "phase01_operation_catalog_empty");
const operationIds = operationFiles.map((file) => {
  const source = readFileSync(file, "utf8");
  const match = source.match(/["']?id["']?\s*:\s*["']([^"']+)["']/);
  assert.ok(match, `phase01_operation_id_missing:${path.relative(root, file)}`);
  assert.match(source, /\binput:\s*[A-Za-z0-9_]+/u, `phase01_operation_input_schema_missing:${path.relative(root, file)}`);
  assert.match(source, /\boutput:\s*[A-Za-z0-9_]+/u, `phase01_operation_output_schema_missing:${path.relative(root, file)}`);
  assert.match(source, /\bcreateHandler\s*\(/u, `phase01_operation_handler_missing:${path.relative(root, file)}`);
  return match[1];
});
assert.equal(new Set(operationIds).size, operationIds.length, "phase01_duplicate_operation_id");
const generatedIndex = readFileSync(path.join(root, "packages/domain-operations/src/generated/operation-index.generated.ts"), "utf8");
assert.match(generatedIndex, /export const operationDefinitions/,
  "phase01_generated_operation_index_missing");
const domainApiSource = readFileSync(path.join(root, "packages/domain-api/src/index.ts"), "utf8");
for (const eventType of ["workspace.room.changed", "workspace.agent.changed", "workspace.activity.ingested", "workspace.run.changed", "workspace.artifact.changed"]) {
  assert.ok(domainApiSource.includes(`\"${eventType}\"`), `phase01_event_schema_missing:${eventType}`);
}
assert.ok(existsSync(path.join(root, "packages/domain-api/src/index.ts")), "phase01_public_contract_package_missing");
assert.ok(existsSync(path.join(root, "plans/phase-0-1-public-api-spec.json")), "phase01_public_api_spec_missing");
process.stdout.write(`verified Phase 0-1 gate: ${ledger.entries.length} entries, unclassified=0, direct_persistence=0\n`);

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}
