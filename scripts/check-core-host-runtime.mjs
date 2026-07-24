import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const ts = createRequire(import.meta.url)("typescript");

const required = [
  "packages/core-schemas/src/index.ts",
  "packages/agent-backends/src/index.ts",
  "packages/workspace-store/src/workspace-store.ts",
  "packages/runtime/src/agent-runtime.ts",
  "packages/runtime/src/host/agent-host.ts",
  "packages/runtime/src/host/host-types.ts",
  "packages/runtime/src/host/turn-admission.ts",
  "packages/runtime/src/host/turn-preparer.ts",
  "packages/runtime/src/host/turn-preparation-policy.ts",
  "packages/runtime/src/host/turn-completion-coordinator.ts",
  "packages/runtime/src/execution/run-state-machine.ts",
  "packages/runtime/src/execution/run-lifecycle.ts",
  "packages/runtime/src/execution/backend-event-journal.ts",
  "packages/runtime/src/execution/session-run-queue.ts",
  "packages/runtime/src/execution/run-control.ts",
  "packages/runtime/src/execution/run-recovery.ts",
  "packages/runtime/src/execution/turn-executor.ts",
  "packages/runtime/src/composition/create-agent-host.ts",
  "packages/runtime/src/composition/runtime-host.ts",
  "packages/runtime/src/host/backend-tool-bridge.ts",
  "packages/runtime/src/execution/durable-work-coordinator.ts",
  "apps/server/src/composition/runtime.ts",
  "apps/server/src/workers/automation-scheduler.ts",
  "apps/server/src/api-server.ts",
  "scripts/check-core-host-runtime.mjs",
  "scripts/verify-core-host-runtime.mjs",
  "scripts/audit-core-host-runtime.mjs",
  "vitest.core02.config.mjs"
];

const obsolete = [
  "scripts/build-core02-test-bundles.mjs",
  "scripts/run-core02-focused-tests.mjs",
  "scripts/record-core-02-source-inventory.mjs",
  "reports/core-02/latest.json",
  "reports/core-02/latest.md",
  "reports/core-02/source-inventory.json",
  "reports/core-02/legacy-characterization.json"
];

const focusTests = [
  "packages/runtime/src/execution/run-state-machine.test.ts",
  "packages/runtime/src/execution/run-lifecycle.test.ts",
  "packages/runtime/src/execution/backend-event-journal.test.ts",
  "packages/runtime/src/execution/turn-executor.test.ts",
  "packages/runtime/src/execution/run-control.test.ts",
  "packages/runtime/src/execution/run-recovery.test.ts",
  "packages/runtime/src/execution/session-run-queue.test.ts",
  "packages/runtime/src/host/agent-host.test.ts",
  "packages/runtime/src/host/turn-completion-coordinator.test.ts",
  "packages/runtime/src/host/turn-preparer.test.ts",
  "packages/runtime/src/host/turn-preparation-policy.test.ts",
  "apps/server/src/composition/runtime.test.ts",
  ...readdirSync(path.join(root, "packages/workspace-store/src"))
    .filter((file) => /^core02-.*\.test\.ts$/.test(file))
    .map((file) => `packages/workspace-store/src/${file}`)
];

const missing = [...required, ...focusTests].filter((file) => !existsSync(path.join(root, file)));
if (missing.length) fail(`core_host_runtime_missing:${missing.join(",")}`);
const presentObsolete = obsolete.filter((file) => existsSync(path.join(root, file)));
if (presentObsolete.length) fail(`core_host_runtime_obsolete_files:${presentObsolete.join(",")}`);

const parseTargets = [...new Set([
  ...required.filter((file) => file.endsWith(".ts")),
  ...focusTests,
  ...required.filter((file) => file.endsWith(".mjs"))
])];
const parseErrors = [];
for (const relative of parseTargets) {
  const file = path.join(root, relative);
  const source = readFileSync(file, "utf8");
  if (relative.endsWith(".ts")) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (sourceFile.parseDiagnostics.length) parseErrors.push(`${relative}:${sourceFile.parseDiagnostics.map((diagnostic) => diagnostic.messageText).join("|")}`);
  }
  if (/[ \t]+(?:\r?\n|$)/.test(source)) parseErrors.push(`${relative}:trailing_whitespace`);
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(source)) parseErrors.push(`${relative}:conflict_marker`);
  if (relative.endsWith(".json")) {
    try { JSON.parse(source); } catch { parseErrors.push(`${relative}:invalid_json`); }
  }
}
if (parseErrors.length) fail(`core_host_runtime_source_error:${parseErrors.join(",")}`);

const productionSources = required
  .filter((file) => file.startsWith("packages/") || file.startsWith("apps/"))
  .map((file) => [file, readFileSync(path.join(root, file), "utf8")]);
const structuralErrors = [];
for (const [relative, source] of productionSources) {
  if (!relative.startsWith("packages/runtime/src/")) continue;
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const name = node.expression.name.text;
    if (["updateBackendRun", "saveBackendEvent", "releaseReservation", "settleTurn"].includes(name)) {
      structuralErrors.push(`${relative}:${node.getStart(sourceFile)}:old_turn_store_api:${name}`);
    }
  });
}

const hostJournal = readText("packages/runtime/src/execution/backend-event-journal.ts");
const terminalPreparation = hostJournal.match(/async prepareTerminalSettlement[\s\S]*?(?=\n  async |\n  private |\n}\n)/)?.[0] ?? "";
if (/appendCore02Event|commitCore02LifecycleEvent|saveBackendEvent/.test(terminalPreparation)) {
  structuralErrors.push("backend-event-journal.ts:terminal_preparation_persists_event");
}

const requiredContracts = [
  ["packages/runtime/src/host/host-types.ts", ["CommitTurnSettlementPort", "commitTurnSettlement", "TurnPreflightPort", "CommittedEventPublisherPort", "AdmissionObserverPort", "TurnToolExecutionPort", "TurnCleanupPort", "HostDiagnosticsPort", "presentation", "learningReview"]],
  ["packages/workspace-store/src/workspace-store.ts", ["commitTurnSettlement", "appendHostDiagnostic", "host-diagnostic:", "listCore02RecoveryCandidates"]],
  ["packages/runtime/src/host/agent-host.ts", ["runTurn", "cancelRun", "resumeRun", "syncRun", "shutdown", "commitSettlement"]],
  ["packages/runtime/src/agent-runtime.ts", ["requireAgentHost().runTurn", "requireAgentHost().cancelRun", "requireAgentHost().resumeRun", "requireAgentHost().syncRun"]],
  ["packages/runtime/src/composition/runtime-host.ts", ["core:", "preparation:", "execution:", "postTurn:", "diagnostics:"]],
  ["apps/server/src/composition/runtime.ts", ["deferHost: true", "attachAgentHost", "composeRuntimeHost", "production_logger_required"]]
];
for (const [relative, tokens] of requiredContracts) {
  const source = readText(relative);
  for (const token of tokens) if (!source.includes(token)) structuralErrors.push(`${relative}:contract_missing:${token}`);
}

const schema = readText("packages/core-schemas/src/index.ts");
for (const token of ["outcome_unknown", "request_idempotency_key", "current_attempt", "backendRunPhases", "host_post_turn_failed", "host_cleanup_failed", "host_emit_failed"]) {
  if (!schema.includes(token)) structuralErrors.push(`core-schemas.ts:token_missing:${token}`);
}
const lifecycle = readText("packages/runtime/src/execution/run-lifecycle.ts");
for (const token of ["export type LifecycleTransitionDecision", "commitCore02RunTransition", "commitCore02BackendSession", "lifecycleDecisionBrand"]) {
  if (!lifecycle.includes(token)) structuralErrors.push(`run-lifecycle.ts:token_missing:${token}`);
}

const oldTokens = [
  "legacyRunChatTurn",
  "legacyCancelBackendRun",
  "legacySyncBackendStream",
  "legacyResumeBackendRun",
  "PostTurnPort",
  "SAMURAI_CORE02_VITEST",
  ".tmp-core02-vitest",
  "build-core02-test-bundles",
  "run-core02-focused-tests"
];
for (const [relative, source] of productionSources) {
  for (const token of oldTokens) if (source.includes(token)) structuralErrors.push(`${relative}:obsolete_token:${token}`);
}

if (structuralErrors.length) fail(`core_host_runtime_structural_violation:${structuralErrors.join(",")}`);

console.log(JSON.stringify({
  ok: true,
  required_files: required.length,
  parsed_files: parseTargets.length,
  production_sources: productionSources.length,
  obsolete_files: 0,
  checked_at: new Date().toISOString()
}));

function readText(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function walk(node, visitor) {
  visitor(node);
  node.forEachChild((child) => walk(child, visitor));
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message, checked_at: new Date().toISOString() }));
  process.exit(1);
}
