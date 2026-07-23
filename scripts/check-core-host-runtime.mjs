import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const ts = createRequire(import.meta.url)("typescript");

const root = process.cwd();
const required = [
  "packages/runtime/src/host/agent-host.ts",
  "packages/runtime/src/host/host-types.ts",
  "packages/runtime/src/host/turn-admission.ts",
  "packages/runtime/src/host/turn-completion-coordinator.ts",
  "packages/runtime/src/execution/run-state-machine.ts",
  "packages/runtime/src/execution/run-lifecycle.ts",
  "packages/runtime/src/execution/backend-event-journal.ts",
  "packages/runtime/src/execution/session-run-queue.ts",
  "packages/runtime/src/execution/run-control.ts",
  "packages/runtime/src/execution/run-recovery.ts",
  "packages/runtime/src/execution/turn-executor.ts",
  "packages/runtime/src/composition/create-agent-host.ts",
  "packages/core-schemas/src/index.ts",
  "packages/agent-backends/src/index.ts",
  "packages/workspace-store/src/workspace-store.ts",
  "scripts/build-core02-test-bundles.mjs",
  "scripts/run-core02-focused-tests.mjs",
  "reports/core-02/source-inventory.json"
];
const missing = required.filter((file) => !existsSync(path.join(root, file)));
if (missing.length) fail(`core_host_runtime_missing:${missing.join(",")}`);
const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
const targetUntracked = untracked.filter((file) => isCore02Target(file));
const sourceInventory = readJson(path.join(root, "reports/core-02/source-inventory.json"));
const currentTrackedCore02 = gitLines(["ls-files"]).filter(isCore02Target).sort();
const currentUntrackedCore02 = targetUntracked.filter((file) => file !== "reports/core-02/source-inventory.json").sort();
const expectedInventory = [...new Set([...currentTrackedCore02, ...currentUntrackedCore02, "reports/core-02/source-inventory.json"])].sort();
if (!sameList(sourceInventory.all_core02_files, expectedInventory)) fail("core_host_runtime_source_inventory_stale");

const parseTargets = [
  ...required.filter((file) => file.endsWith(".ts")),
  ...targetUntracked.filter((file) => file.endsWith(".ts")),
  "scripts/check-core-host-runtime.mjs",
  "scripts/verify-core-host-runtime.mjs",
  "scripts/build-core02-test-bundles.mjs",
  "scripts/run-core02-focused-tests.mjs"
];
const structuralTargets = required.filter((file) => file.startsWith("packages/runtime/src/"));
const structuralErrors = [];

for (const relative of structuralTargets) {
  const file = path.join(root, relative);
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  walk(sourceFile, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(sourceFile);
      const name = node.expression.name.text;
      if ((name === "updateBackendRun" || name === "settleTurn") && receiver === "store" && relative !== "packages/runtime/src/execution/run-lifecycle.ts") {
        structuralErrors.push(`${relative}:${node.getStart(sourceFile)}:direct_store_${name}`);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && (node.left.name.text === "status" || node.left.name.text === "phase")) {
      structuralErrors.push(`${relative}:${node.getStart(sourceFile)}:direct_state_assignment`);
    }
  });
}

const journalSource = readFileSync(path.join(root, "packages/runtime/src/execution/backend-event-journal.ts"), "utf8");
const terminalPreparation = journalSource.match(/async prepareTerminalSettlement[\s\S]*?(?=\n  async |\n  private |\n}\n)/)?.[0] ?? "";
if (/saveBackendEvent|appendCore02Event|commitCore02LifecycleEvent/.test(terminalPreparation)) {
  structuralErrors.push("backend-event-journal.ts:terminal_preparation_persists_event");
}
if (!/commitTurnSettlement\s*\(/.test(readFileSync(path.join(root, "packages/workspace-store/src/workspace-store.ts"), "utf8"))) {
  structuralErrors.push("workspace-store.ts:commit_turn_settlement_missing");
}
if (structuralErrors.length) fail(`core_host_runtime_structural_violation:${structuralErrors.join(",")}`);

const parseErrors = [];
for (const relative of parseTargets.filter((file) => file.endsWith(".ts"))) {
  const file = path.join(root, relative);
  const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sourceFile.parseDiagnostics.length) parseErrors.push(`${relative}:${sourceFile.parseDiagnostics.map((diagnostic) => diagnostic.messageText).join("|")}`);
}
if (parseErrors.length) fail(`core_host_runtime_syntax_error:${parseErrors.join(",")}`);

const schema = readFileSync(path.join(root, "packages/core-schemas/src/index.ts"), "utf8");
const lifecycleSource = readFileSync(path.join(root, "packages/runtime/src/execution/run-lifecycle.ts"), "utf8");
const storeSource = readFileSync(path.join(root, "packages/workspace-store/src/workspace-store.ts"), "utf8");
for (const token of ["outcome_unknown", "request_idempotency_key", "current_attempt", "backendRunPhases"]) {
  if (!schema.includes(token)) fail(`core_host_runtime_schema_missing:${token}`);
}
for (const token of ["export type LifecycleTransitionDecision", "lifecycleTransitionDecisionBrand"]) {
  if (!schema.includes(token)) fail(`core_host_runtime_decision_contract_missing:${token}`);
}
if (!lifecycleSource.includes("CoreLifecycleTransitionDecision") || !/as LifecycleTransitionDecision/.test(lifecycleSource)) {
  fail("core_host_runtime_decision_owner_missing");
}
if (!storeSource.includes("type LifecycleTransitionDecision") || !/decision:\s*LifecycleTransitionDecision/.test(storeSource)) {
  fail("core_host_runtime_settlement_port_decision_missing");
}
for (const token of ["RunLifecycle", "PreparedTerminalSettlement", "terminal_event_requires_settlement"]) {
  if (!journalSource.includes(token)) fail(`core_host_runtime_journal_missing:${token}`);
}

const hygieneErrors = scanHygiene(targetUntracked);
if (hygieneErrors.length) fail(`core_host_runtime_untracked_hygiene:${hygieneErrors.join(",")}`);

console.log(JSON.stringify({ ok: true, required_files: required.length, parsed_files: parseTargets.length, untracked_core02_files: targetUntracked.length, checked_at: new Date().toISOString() }));

function walk(node, visitor) {
  visitor(node);
  node.forEachChild((child) => walk(child, visitor));
}

function isCore02Target(file) {
  return file.startsWith("packages/runtime/src/execution/")
    || file.startsWith("packages/runtime/src/host/")
    || file === "packages/runtime/src/composition/create-agent-host.ts"
    || file === "packages/agent-backends/src/index.ts"
    || file === "packages/core-schemas/src/index.ts"
    || file === "packages/workspace-store/src/workspace-store.ts"
    || file.startsWith("plans/core-02-phase-0-2-")
    || file.startsWith("plans/core-02-host-runtime-")
    || file === "plans/core-progress-ledger.md"
    || file.startsWith("reports/core-02/")
    || file.startsWith("scripts/check-core-host-runtime")
    || file === "scripts/build-core02-test-bundles.mjs"
    || file === "scripts/record-core-02-source-inventory.mjs"
    || file === "scripts/run-core02-focused-tests.mjs"
    || file.startsWith("scripts/verify-core-host-runtime")
    || file === "vitest.core02.config.mjs";
}

function scanHygiene(files) {
  const errors = [];
  for (const relative of files) {
    const file = path.join(root, relative);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    if (/[ \t]+(?:\r?\n|$)/.test(source)) errors.push(`${relative}:trailing_whitespace`);
    if (/^(<<<<<<<|=======|>>>>>>>)/m.test(source)) errors.push(`${relative}:conflict_marker`);
    if (relative.endsWith(".json")) {
      try { JSON.parse(source); } catch { errors.push(`${relative}:invalid_json`); }
    }
  }
  return errors;
}

function gitLines(args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 }).split(/\r?\n/).filter(Boolean); }
  catch (error) { fail(`core_host_runtime_git_failed:${error?.message ?? String(error)}`); }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { fail(`core_host_runtime_source_inventory_missing:${path.relative(root, file)}`); }
}

function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message, checked_at: new Date().toISOString() }));
  process.exit(1);
}
