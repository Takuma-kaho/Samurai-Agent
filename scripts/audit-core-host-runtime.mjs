import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();
const blockers = [];

const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => existsSync(path.join(root, relative));
const parse = (relative) => ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const walk = (node, visitor) => {
  visitor(node);
  node.forEachChild((child) => walk(child, visitor));
};
const moduleSpecifiers = (relative) => {
  const values = [];
  walk(parse(relative), (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) values.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) values.push(node.moduleSpecifier.text);
  });
  return values;
};
const methodText = (relative, name) => {
  let value = "";
  walk(parse(relative), (node) => {
    if (value || (!ts.isMethodDeclaration(node) && !ts.isFunctionDeclaration(node))) return;
    const named = node.name && ts.isIdentifier(node.name) && node.name.text === name;
    if (named) value = node.getText();
  });
  return value;
};
const hasAssignmentTo = (relativeFiles, properties) => relativeFiles.some((relative) => {
  let found = false;
  walk(parse(relative), (node) => {
    if (found || !ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = node.left;
    if (ts.isPropertyAccessExpression(left) && properties.has(left.name.text)) found = true;
  });
  return found;
});

const hostBoundaryFiles = [
  "packages/runtime/src/host/agent-host.ts",
  "packages/runtime/src/host/host-types.ts",
  "packages/runtime/src/host/turn-admission.ts",
  "packages/runtime/src/host/turn-preparer.ts",
  "packages/runtime/src/host/turn-completion-coordinator.ts",
  "packages/runtime/src/execution/run-lifecycle.ts",
  "packages/runtime/src/execution/backend-event-journal.ts",
  "packages/runtime/src/execution/run-control.ts",
  "packages/runtime/src/execution/run-recovery.ts",
  "packages/runtime/src/execution/turn-executor.ts"
];
const hostBoundarySource = hostBoundaryFiles.map(read).join("\n");
const runtimeSource = read("packages/runtime/src/agent-runtime.ts");
const compositionSource = read("apps/server/src/composition/runtime.ts");
const compositionTestSource = read("apps/server/src/composition/runtime.test.ts");

// Blocker 1: the extracted Host has no AgentRuntime or giant callback dependency.
const namedHostPorts = [
  "HostStorePort", "HostContextPort", "TurnPreflightPort", "CommittedEventPublisherPort",
  "AdmissionObserverPort", "TurnToolExecutionPort", "TurnCleanupPort", "HostDiagnosticsPort"
];
if (/(?:AgentRuntime|agent-runtime)/.test(hostBoundarySource)
  || !namedHostPorts.every((name) => hostBoundarySource.includes(name))) {
  blockers.push("blocker_1_host_runtime_dependency");
}

// Blocker 2: production Chat/Gateway/Automation all reach the single attached Host.
const chatFacade = methodText("packages/runtime/src/agent-runtime.ts", "runChatTurn");
const ingressCoordinator = read("packages/runtime/src/domain-ingress-coordinator.ts");
const automationScheduler = read("apps/server/src/workers/automation-scheduler.ts");
const oldTurnCalls = /\b(?:backend\.runTurn|commitTurnSettlement|admitTurn|saveBackendEvent|updateBackendRun)\s*\(/;
if (!chatFacade.includes("requireAgentHost().runTurn")
  || !chatFacade.includes("projectChatTurn")
  || !chatFacade.includes("getBackendRun(outcome.run.id)")
  || oldTurnCalls.test(chatFacade)
  || !compositionSource.includes("deferHost: true")
  || !compositionSource.includes("attachAgentHost")
  || !runtimeSource.includes("runChat: (input) => this.runChatTurn")
  || !ingressCoordinator.includes('requireDomainCommandEntry("gateway.inbound.route")')
  || !ingressCoordinator.includes('requireDomainCommandEntry("automation.job.run")')
  || !automationScheduler.includes("runtime.runDueAutomationJobs")) {
  blockers.push("blocker_2_multiple_turn_paths");
}

// Blocker 3: terminal Event persistence is reachable only through settlement.
const journalTerminalMethod = methodText("packages/runtime/src/execution/backend-event-journal.ts", "prepareTerminalSettlement");
const completionSource = read("packages/runtime/src/host/turn-completion-coordinator.ts");
const controlSource = read("packages/runtime/src/execution/run-control.ts");
const recoverySource = read("packages/runtime/src/execution/run-recovery.ts");
if (!completionSource.includes("commitTurnSettlement")
  || !controlSource.includes("commitTurnSettlement")
  || !recoverySource.includes("commitTurnSettlement")
  || !journalTerminalMethod
  || /appendCore02Event|commitCore02LifecycleEvent|saveBackendEvent/.test(journalTerminalMethod)
  || /(?:saveBackendEvent|updateBackendRun|releaseReservation)\s*\(/.test(`${runtimeSource}\n${hostBoundarySource}`)) {
  blockers.push("blocker_3_terminal_settlement_bypass");
}

// Blocker 4: Host/turn/execution imports remain Ports-first, not concrete Store/HTTP/domain services.
const concreteHostImports = hostBoundaryFiles
  .flatMap((relative) => moduleSpecifiers(relative))
  .filter((specifier) => /workspace-store|api-server|transport|domain-service|renderer/i.test(specifier));
if (concreteHostImports.length > 0) blockers.push("blocker_4_concrete_host_dependency");

// Blocker 5: focused tests exercise production Host composition and settlement behavior.
const hostTestSource = read("packages/runtime/src/host/agent-host.test.ts");
const completionTestSource = read("packages/runtime/src/host/turn-completion-coordinator.test.ts");
if (!hostTestSource.includes("new AgentHost")
  || !hostTestSource.includes("WorkspaceStore")
  || !completionTestSource.includes("host_post_turn_failed")
  || !compositionTestSource.includes("composeAgentRuntime")
  || !["Chat", "Gateway", "Automation"].every((name) => compositionTestSource.includes(`name: "${name}"`))) {
  blockers.push("blocker_5_nonproduction_fixture");
}

// Blocker 6: RunLifecycle owns state decisions; Journal/API cannot persist terminal state directly.
const lifecycleSource = read("packages/runtime/src/execution/run-lifecycle.ts");
const stateMachineSource = read("packages/runtime/src/execution/run-state-machine.ts");
const lifecycleFiles = [...hostBoundaryFiles, "packages/runtime/src/execution/run-state-machine.ts"];
if (!lifecycleSource.includes("class RunLifecycle")
  || !stateMachineSource.includes("LifecycleTransitionDecision")
  || !journalTerminalMethod.includes("this.lifecycle.apply")
  || hasAssignmentTo(lifecycleFiles, new Set(["status", "phase"]))) {
  blockers.push("blocker_6_lifecycle_owner_bypass");
}

// Blocker 7: a phase is not marked complete while the fixed gate has fail/unverified work.
let phaseGateMismatch = false;
try {
  const ledger = JSON.parse(read("plans/core-02-phase-0-2-scope-ledger.json"));
  const outOfScopeStatuses = (ledger.out_of_scope ?? []).map((item) => item.status);
  const progress = read("plans/core-progress-ledger.md");
  phaseGateMismatch = ledger.status === "completed"
    && (outOfScopeStatuses.includes("fail") || outOfScopeStatuses.includes("unverified") || /Core-02.*完了/.test(progress));
} catch {
  phaseGateMismatch = true;
}
if (phaseGateMismatch) blockers.push("blocker_7_phase_gate_mismatch");

// Blocker 8: the fixed consumer ledger names status/phase/attempt/idempotency consumers.
let consumerLedgerComplete = false;
try {
  const ledger = JSON.parse(read("plans/core-02-phase-0-2-scope-ledger.json"));
  const required = new Set(["status", "phase", "attempt", "request_idempotency"]);
  const entries = Array.isArray(ledger.consumer_ledger) ? ledger.consumer_ledger : [];
  consumerLedgerComplete = entries.length === required.size
    && entries.every((entry) => required.has(entry.field) && entry.status === "registered" && Array.isArray(entry.consumers) && entry.consumers.length > 0);
} catch {
  consumerLedgerComplete = false;
}
if (!consumerLedgerComplete) blockers.push("blocker_8_consumer_ledger_incomplete");

// Blocker 9: exactly the two evidence files contain source/test/command results and commit identity.
let evidenceComplete = false;
try {
  const evidence = JSON.parse(read("reports/core-02/scope-ledger.json"));
  const report = read("reports/core-02/completion-report.md");
  const commandResults = Array.isArray(evidence.commands) && evidence.commands.length > 0
    && evidence.commands.every((item) => typeof item.name === "string" && typeof item.status === "string" && "exit_code" in item && "duration_ms" in item);
  const testResults = Array.isArray(evidence.tests) && evidence.tests.every((item) => typeof item.id === "string" && typeof item.status === "string" && "exit_code" in item);
  evidenceComplete = commandResults && testResults && typeof evidence.commit_sha === "string"
    && report.includes("Commit SHA:") && report.includes("検証結果") && report.includes("exit code");
} catch {
  evidenceComplete = false;
}
if (!evidenceComplete) blockers.push("blocker_9_evidence_incomplete");

const result = { ok: blockers.length === 0, blockers, checked_at: new Date().toISOString(), blocker_count: 9 };
if (!result.ok) {
  console.error(JSON.stringify(result));
  process.exit(1);
}
console.log(JSON.stringify(result));
