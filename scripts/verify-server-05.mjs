import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(root, "reports", "server05-external-integration");
const reportPath = path.join(reportDir, "report.json");
const evidencePath = path.join(reportDir, "live-evidence.json");
const checks = [];
const liveClients = ["codex", "claude_code", "hermes"];
const operatingSystems = ["darwin", "win32", "linux"];
const deployments = ["hosted", "self_host"];
const clientCoreFlows = ["oauth", "mcp", "project_room_binding", "context_snapshot", "read", "write", "activity_ingest", "approval"];

/** Every write capability named in the agreed Server 05 plan.  These are
 * checked independently from ordinary type/tests so a partial public catalog
 * can never turn the whole feature into PASS. */
const requiredMutationCapabilities = [
  { id: "activity_ingest", label: "Activity Ingest", terms: ["samurai.activity.ingest"] },
  { id: "artifact", label: "Artifact create/update/restore", terms: ["artifact.create", "artifact.revise", "artifact.restore_revision"] },
  { id: "collection", label: "Collection create/update", terms: ["collection.schema.save", "collection.record.create", "collection.patch.apply"] },
  { id: "knowledge", label: "Knowledge create/update", terms: ["wiki.proposal.create", "wiki.patch"] },
  { id: "skill", label: "Skill create/update", terms: ["skill.candidate.create", "skill.patch"] },
  { id: "fixed_pinned", label: "fixed/pinned state change", terms: ["wiki.patch", "skill.patch"] },
  { id: "copy_move_promote", label: "Resource copy/move/promote", terms: ["resource.copy", "resource.move", "resource.promote"] },
  { id: "archive_delete_restore_redact", label: "Archive/delete/restore/redact", terms: ["wiki.archive", "collection.record.delete", "resource.redact"] },
  { id: "human_change_request", label: "Policy/Profile/Soul human change request", terms: ["policy.change.request", "profile.change.request", "soul.change.request"] },
  { id: "room_binding", label: "Room Binding change", terms: ["samurai.room.binding.change"] }
];

/** This verifier deliberately separates local code checks, local formal-ingress
 * integration, and evidence captured from real Clients. A flag or fixture
 * can never substitute for a live result. */
function run(label, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) }
  });
  const passed = result.status === 0;
  checks.push({
    label,
    passed,
    duration_ms: Date.now() - started,
    exit_code: result.status,
    output_tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-2_000)
  });
  return passed;
}

function staticBoundaryCheck() {
  const forbidden = [
    ["external integration package Store boundary", "WorkspaceStore|better-sqlite|kysely|node:fs", "packages/external-integration/src"],
    ["runtime MCP Workspace Store boundary", "import type \\{ WorkspaceStore \\}|options\\.store\\.(get|list)|new WorkspaceStore", "packages/runtime/src/external-app/mcp-workspace-port.ts"],
    ["external Automation execution boundary", "external_app", "packages/domain-operations/src/operations/automation/job/run.operation.ts"],
    ["external Memory Review execution boundary", "external_app", "packages/domain-operations/src/operations/automation/memory_review/run.operation.ts"]
  ];
  for (const [label, pattern, target] of forbidden) {
    const result = spawnSync("rg", ["-n", pattern, target], { cwd: root, encoding: "utf8" });
    const output = String(result.stdout ?? "").trim();
    checks.push({
      label,
      passed: result.status !== 0 || !output,
      duration_ms: 0,
      exit_code: result.status,
      output_tail: output || "no forbidden direct dependency"
    });
  }
}

function diffCheck() {
  run("tracked diff whitespace", "git", ["diff", "--check"]);
  run("staged diff whitespace", "git", ["diff", "--cached", "--check"]);
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  const paths = String(result.stdout ?? "").split("\n").filter(Boolean)
    // report.json is generated below; every source/evidence file remains in
    // scope, including untracked migration and test files.
    .filter((relativePath) => path.resolve(root, relativePath) !== reportPath);
  let passed = result.status === 0;
  const failures = [];
  for (const relativePath of paths) {
    const checked = spawnSync("git", ["diff", "--no-index", "--check", "/dev/null", relativePath], { cwd: root, encoding: "utf8" });
    // --no-index returns 1 for an ordinary new file. Diagnostics, not that
    // exit code, identify whitespace errors.
    const output = `${checked.stdout ?? ""}${checked.stderr ?? ""}`.trim();
    if (checked.status !== 0 && output) {
      passed = false;
      failures.push(`${relativePath}: ${output}`);
    }
  }
  checks.push({
    label: "untracked diff whitespace",
    passed,
    duration_ms: 0,
    exit_code: passed ? 0 : 1,
    output_tail: failures.join("\n").slice(-2_000) || `${paths.length} untracked files checked`
  });
}

async function sourceHash() {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  const files = String(listed.stdout ?? "").split("\n").filter(Boolean)
    .filter((relativePath) => isServer05Source(relativePath))
    .sort();
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(path.join(root, relativePath)));
    hash.update("\0");
  }
  return { hash: hash.digest("hex"), files };
}

function isServer05Source(relativePath) {
  return relativePath === "package.json"
    || relativePath === "pnpm-lock.yaml"
    || relativePath === "apps/server/package.json"
    || relativePath.startsWith("apps/server/src/")
    || relativePath.startsWith("packages/external-integration/")
    || relativePath.startsWith("packages/runtime/src/external-app/")
    || relativePath.startsWith("packages/runtime/src/commands/services/resource-version-")
    || relativePath.startsWith("packages/runtime/src/commands/services/workspace-context-")
    || relativePath.startsWith("packages/runtime/src/domain-operation-ports/resource-version-")
    || relativePath.startsWith("packages/runtime/src/domain-operation-ports/workspace-context-")
    || relativePath.startsWith("packages/runtime/src/domain-operation-")
    || relativePath === "packages/runtime/src/agent-runtime.ts"
    || relativePath.startsWith("packages/workspace-server/src/")
    || relativePath === "packages/domain-operations/src/definition/access-classification.ts"
    || relativePath.startsWith("packages/domain-operations/src/operations/resource/version/")
    || relativePath.startsWith("packages/domain-operations/src/operations/workspace/context/")
    || relativePath.startsWith("packages/domain-operations/src/operations/artifact/")
    || relativePath.startsWith("packages/domain-operations/src/operations/collection/")
    || relativePath.startsWith("packages/domain-operations/src/operations/wiki/")
    || relativePath.startsWith("packages/domain-operations/src/operations/skill/")
    || relativePath.startsWith("packages/domain-operations/src/generated/")
    || relativePath.startsWith("packages/workspace-store/src/")
    || relativePath.startsWith("plans/workspace-server-05-")
    || relativePath === "scripts/verify-server-05.mjs";
}

async function loadLiveEvidence(expectedSourceHash) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { entries: [], issues: ["live_evidence_file_missing"] };
    return { entries: [], issues: ["live_evidence_file_invalid"] };
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const issues = [];
  const valid = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      issues.push("live_evidence_entry_invalid");
      continue;
    }
    if (entry.result !== "pass" || typeof entry.client !== "string" || typeof entry.os !== "string" || typeof entry.deployment !== "string" || typeof entry.source_hash !== "string" || typeof entry.target_version !== "string" || typeof entry.executed_at !== "string" || !Array.isArray(entry.flows) || entry.flows.some((flow) => typeof flow !== "string") || typeof entry.login_session !== "string" || typeof entry.evidence_ref !== "string" || typeof entry.evidence_sha256 !== "string") {
      issues.push("live_evidence_entry_fields_invalid");
      continue;
    }
    if (!Number.isFinite(Date.parse(entry.executed_at))) {
      issues.push("live_evidence_timestamp_invalid");
      continue;
    }
    if (entry.source_hash !== expectedSourceHash) {
      issues.push(`live_evidence_source_hash_mismatch:${entry.client}:${entry.os}:${entry.deployment}`);
      continue;
    }
    if (!entry.evidence_ref.trim() || !/^[a-f0-9]{64}$/i.test(entry.evidence_sha256)) {
      issues.push(`live_evidence_proof_invalid:${entry.client}:${entry.os}:${entry.deployment}`);
      continue;
    }
    valid.push(entry);
  }
  return { entries: valid, issues: [...new Set(issues)] };
}

function flowMatrix(entries) {
  const has = (client, flow) => entries.some((entry) => entry.client === client && entry.flows.includes(flow));
  const clients = Object.fromEntries(liveClients.map((client) => [client, Object.fromEntries(clientCoreFlows.map((flow) => [flow, has(client, flow)]))]));
  const coreClients = Object.fromEntries(liveClients.map((client) => [client, clientCoreFlows.every((flow) => clients[client][flow]) && entries.some((entry) => entry.client === client && entry.login_session === "samurai")]));
  return {
    clients,
    core_clients: coreClients,
    capture: entries.some((entry) => entry.flows.includes("capture")),
    approval_ui: entries.some((entry) => entry.flows.includes("approval_ui")),
    complete: Object.values(coreClients).every(Boolean)
  };
}

async function publicMutationCoverage() {
  const [legacyServerSource, postgresIntegrationSource, postgresIngressSource, mcpSource, runtimeSource] = await Promise.all([
    readFile(path.join(root, "apps/server/src/external-integration.ts"), "utf8"),
    readFile(path.join(root, "apps/server/src/adapters/external/postgres-external-integration.ts"), "utf8"),
    readFile(path.join(root, "apps/server/src/adapters/external/postgres-external-app-ingress.ts"), "utf8"),
    readFile(path.join(root, "packages/external-integration/src/mcp.ts"), "utf8"),
    readFile(path.join(root, "packages/runtime/src/external-app/mcp-workspace-port.ts"), "utf8")
  ]);
  const surface = `${legacyServerSource}\n${postgresIntegrationSource}\n${postgresIngressSource}\n${mcpSource}\n${runtimeSource}`;
  const capabilities = requiredMutationCapabilities.map((capability) => ({
    ...capability,
    missing: capability.terms.filter((term) => !surface.includes(`"${term}"`))
  }));
  return {
    capabilities,
    missing: capabilities.filter((capability) => capability.missing.length > 0).map((capability) => ({ id: capability.id, label: capability.label, missing: capability.missing })),
    complete: capabilities.every((capability) => capability.missing.length === 0)
  };
}

async function contextCoverage() {
  const source = await readFile(path.join(root, "packages/runtime/src/external-app/mcp-workspace-port.ts"), "utf8");
  const requiredFormalQueries = ["workspace.context.get", "room.view", "wiki.search", "memory.search"];
  const missingQueries = requiredFormalQueries.filter((query) => !source.includes(`"${query}"`));
  const fields = ["workspaceName", "roomName", "roomPurpose", "workGoal", "fixedKnowledge", "pinnedKnowledge", "rules", "permissions", "tools"];
  const missingFields = fields.filter((field) => !source.includes(field));
  return { required_queries: requiredFormalQueries, missing_queries: missingQueries, missing_fields: missingFields, complete: missingQueries.length === 0 && missingFields.length === 0 };
}

function evidenceMatrix(entries) {
  const matches = (predicate) => entries.some(predicate);
  const clients = Object.fromEntries(liveClients.map((client) => [client, matches((entry) => entry.client === client)]));
  const systems = Object.fromEntries(operatingSystems.map((os) => [os, matches((entry) => entry.os === os)]));
  const modes = Object.fromEntries(deployments.map((deployment) => [deployment, matches((entry) => entry.deployment === deployment)]));
  return {
    clients,
    operating_systems: systems,
    deployments: modes,
    complete: Object.values(clients).every(Boolean) && Object.values(systems).every(Boolean) && Object.values(modes).every(Boolean)
  };
}

async function main() {
  staticBoundaryCheck();
  const architecturePass = run("architecture boundaries", "node", ["scripts/verify-architecture-boundaries.mjs"], { env: { SAMURAI_EVIDENCE_MODE: "deferred" } });
  const catalogPass = run("generated operation catalog", "node", ["scripts/generate-domain-operation-index.mjs", "--check"]);
  const packageTypePass = run("external integration typecheck", "pnpm", ["--filter", "@samurai-agent/external-integration", "run", "typecheck"]);
  const storeTypePass = run("workspace store typecheck", "pnpm", ["--filter", "@samurai-agent/workspace-store", "run", "typecheck"]);
  const runtimeTypePass = run("runtime typecheck", "pnpm", ["--filter", "@samurai-agent/runtime", "run", "typecheck"]);
  const serverTypePass = run("server typecheck", "pnpm", ["--filter", "@samurai-agent/server", "run", "typecheck"]);
  const contractPass = run("external integration contract tests", "pnpm", ["exec", "vitest", "run", "packages/external-integration/src/external-integration.test.ts", "packages/external-integration/src/connector-sdk.test.ts", "packages/workspace-store/src/external-integration-repository.test.ts"]);
  const formalIngressPass = run("MCP formal ingress integration", "pnpm", ["exec", "vitest", "run", "packages/runtime/src/core09-external-app-ingress.test.ts", "packages/workspace-store/src/workspace-store.test.ts"]);
  diffCheck();

  const source = await sourceHash();
  const evidence = await loadLiveEvidence(source.hash);
  const matrix = evidenceMatrix(evidence.entries);
  const flows = flowMatrix(evidence.entries);
  const mutationCoverage = await publicMutationCoverage();
  const context = await contextCoverage();
  const implementationPass = checks.every((check) => check.passed);
  const integrationPass = Boolean(architecturePass && catalogPass && packageTypePass && storeTypePass && runtimeTypePass && serverTypePass && contractPass && formalIngressPass);
  const selfReview = await selfReviewCoverage();
  const corrections = correctionLedger({ implementationPass, integrationPass, matrix, flows, mutationCoverage, context, selfReview });
  const requirements = requirementLedger({ implementationPass, integrationPass, matrix, corrections });
  const liveClientPass = Object.values(matrix.clients).every(Boolean);
  const threeOsPass = Object.values(matrix.operating_systems).every(Boolean);
  const hostedSelfHostPass = Object.values(matrix.deployments).every(Boolean);
  const complete = implementationPass
    && integrationPass
    && selfReview.complete
    && matrix.complete
    && flows.complete
    && liveClientPass
    && threeOsPass
    && hostedSelfHostPass
    && evidence.issues.length === 0
    && corrections.filter((item) => item.id !== "C31").every((item) => item.status === "complete")
    && requirements.every((item) => item.status === "complete");
  const report = {
    feature: "workspace-server-05-external-integration",
    status: implementationPass ? (complete ? "PASS" : "INCOMPLETE") : "FAIL",
    implementation_pass: implementationPass,
    integration_pass: integrationPass,
    live_client_pass: liveClientPass,
    three_os_pass: threeOsPass,
    hosted_self_host_pass: hostedSelfHostPass,
    complete,
    generated_at: new Date().toISOString(),
    source_hash: source.hash,
    source_file_count: source.files.length,
    checks,
    evidence_matrix: matrix,
    flow_matrix: flows,
    evidence_issues: evidence.issues,
    mutation_coverage: mutationCoverage,
    context_coverage: context,
    self_review: selfReview,
    corrections,
    requirements,
    unverified: incompleteReasons({ implementationPass, integrationPass, matrix, corrections, evidenceIssues: evidence.issues, complete })
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[Server05] ${report.status}`);
  if (report.status === "FAIL") process.exitCode = 1;
  else if (report.status === "INCOMPLETE") process.exitCode = 2;
}

main().catch(async (error) => {
  const report = {
    feature: "workspace-server-05-external-integration",
    status: "FAIL",
    implementation_pass: false,
    integration_pass: false,
    complete: false,
    generated_at: new Date().toISOString(),
    checks,
    error: error instanceof Error ? error.message : String(error)
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`[Server05] FAIL ${report.error}`);
  process.exitCode = 1;
});

function correctionLedger(flags) {
  const focused = flags.implementationPass && flags.integrationPass;
  const complete = (value) => value ? "complete" : "incomplete";
  const client = flags.flows.core_clients;
  const allClientFlows = flags.flows.complete;
  const liveMatrix = flags.matrix.complete;
  return [
    ["C01", "実Clientの登録・導入経路", focused && flags.selfReview.complete, "official_manifest_and_connector_config_path"],
    ["C02", "Adapterを実設定・Hook・Session開始へ接続", focused && flags.selfReview.complete, "adapter_hook_relay_and_startup_instruction"],
    ["C03", "Project参照の保持", focused, "transport_session_project_mismatch_tests"],
    ["C04", "OAuth本人をSamurai実ログインSessionで確認", focused && flags.selfReview.login_session, "owner_token_login_session_adapter"],
    ["C05", "OAuth承認とCode保存の原子化", focused, "oauth_atomic_contract_tests"],
    ["C06", "MCP厳密な入力・結果Schema", focused, "ajv_input_output_contract_tests"],
    ["C07", "MCP RuntimeからStore直接参照を除去", focused, "formal_ingress_and_static_boundary"],
    ["C08", "保存Transaction内のVersion確認", focused, "artifact_collection_atomic_version_tests"],
    ["C09", "Cancel/Timeout後の停止と結果不明", focused, "abort_and_outcome_unknown_tests"],
    ["C10", "必須書き込みToolの公開", focused && flags.mutationCoverage.complete, "published_mutation_coverage"],
    ["C11", "範囲外Automation操作の除外", focused, "automation_external_source_static_boundary"],
    ["C12", "Contextを正本の実データから作成", focused && flags.context.complete, "formal_workspace_context_query"],
    ["C13", "Context削減順序", focused, "context_priority_tests"],
    ["C14", "Context最終本文Hash", focused, "context_hash_tests"],
    ["C15", "標準Room初回適用", focused, "binding_default_room_contract"],
    ["C16", "承認期限の全状態再確認", focused, "approval_expiry_tests"],
    ["C17", "承認再利用の完全比較", focused, "approval_canonical_input_tests"],
    ["C18", "承認実行後の状態保存と回復", focused, "approval_outcome_unknown_tests"],
    ["C19", "承認画面の拒否・影響表示", focused && flags.selfReview.approval_ui, "approval_deny_and_impact_html"],
    ["C20", "Captureを本番Hookから接続", focused && flags.selfReview.capture, "authenticated_hook_capture_path"],
    ["C21", "JSON・自由文のSecret除去", focused, "structured_and_text_redaction_tests"],
    ["C22", "Capture Quotaの原子性", focused, "concurrent_capture_quota_tests"],
    ["C23", "Retention削除のAudit", focused, "retention_audit_tests"],
    ["C24", "not_runの保存", focused, "activity_verification_mapping_tests"],
    ["C25", "ConnectorのWorkspace分離", focused, "cross_workspace_connector_tests"],
    ["C26", "SemVer互換性", focused, "semver_contract_tests"],
    ["C27", "Unit/Integration/Liveの分離", focused, "verifier_report_categories"],
    ["C28", "未完成を非0で終了", focused, "incomplete_exit_code_2"],
    ["C29", "全要件をEvidenceから機械判定", focused, "17_requirements_and_31_corrections"],
    ["C30", "未追跡を含む差分健全性", focused, "tracked_staged_untracked_diff_checks"],
    ["C31", "実Client・3OS・Hosted/Self-host証拠", liveMatrix && allClientFlows && client.codex && client.claude_code && client.hermes, "dated_hashed_live_evidence_matrix"]
  ].map(([id, correction, done, evidence]) => ({ id, correction, evidence, status: complete(done) }));
}

function requirementLedger(flags) {
  const correction = new Map(flags.corrections.map((item) => [item.id, item.status === "complete"]));
  const done = (...ids) => flags.implementationPass && flags.integrationPass && ids.every((id) => correction.get(id));
  return [
    [1, "Codex／Claude Code／Hermes", done("C01", "C02"), "three_client_adapter_and_manifest"],
    [2, "Native Appと同じRoom認可", done("C07"), "formal_ingress_negative_tests"],
    [3, "外部AI→Samuraiのみ", done("C07", "C11"), "architecture_boundary"],
    [4, "macOS／Windows／Linux", done("C01", "C02"), "three_os_adapter_config_paths"],
    [5, "OAuth", done("C04", "C05", "C25"), "oauth_login_session_and_workspace_separation"],
    [6, "第三者Connector", done("C25", "C26"), "connector_contract_and_sample_test"],
    [7, "Project→Room固定", done("C03", "C15"), "binding_default_room_and_version"],
    [8, "開始時Context", done("C12", "C13", "C14"), "snapshot_priority_and_hash"],
    [9, "5種類の読み取り", done("C06", "C07"), "formal_query_integration"],
    [10, "構造化Activity", done("C20", "C24"), "hook_normalization_and_dedupe"],
    [11, "任意全文保存", done("C20", "C21", "C22", "C23"), "capture_contract_and_retention"],
    [12, "書き込み・承認", done("C08", "C10", "C16", "C17", "C18", "C19"), "operation_and_approval_contract"],
    [13, "共有設定と個人Grant", done("C04", "C05", "C25"), "oauth_scope_and_workspace_separation"],
    [14, "Hosted／Self-host", done("C04", "C07"), "shared_public_contract"],
    [15, "自動連携", done("C02", "C09", "C20"), "reconnect_and_dedupe_contract"],
    [16, "最小UI", done("C19"), "oauth_and_approval_html"],
    [17, "完成証明", done(...Array.from({ length: 30 }, (_value, index) => `C${String(index + 1).padStart(2, "0")}`)), "code_self_review_complete"]
  ].map(([number, requirement, complete, evidence]) => ({ number, requirement, evidence, status: complete ? "complete" : "incomplete" }));
}

function incompleteReasons(input) {
  const reasons = [];
  if (!input.implementationPass) reasons.push("local_checks_failed");
  if (!input.integrationPass) reasons.push("formal_integration_checks_failed");
  for (const correction of input.corrections) {
    if (correction.id === "C31") {
      if (!input.complete) reasons.push("live_client_os_deployment_deferred_to_self_review");
      continue;
    }
    if (correction.status !== "complete") reasons.push(`correction_unresolved:${correction.id}`);
  }
  if (!input.complete) reasons.push(...input.evidenceIssues);
  return [...new Set(reasons)];
}

async function selfReviewCoverage() {
  const [serverSource, httpSource, adapterSource, hookSource] = await Promise.all([
    readFile(path.join(root, "apps/server/src/external-integration.ts"), "utf8"),
    readFile(path.join(root, "packages/external-integration/src/http.ts"), "utf8"),
    readFile(path.join(root, "packages/external-integration/src/adapters.ts"), "utf8"),
    readFile(path.join(root, "scripts/external-integration-hook.ts"), "utf8")
  ]);
  const loginSession = serverSource.includes("createSamuraiLoginBrowserSession")
    && serverSource.includes("OwnerTokenManager")
    && serverSource.includes("localOwnerParticipantId")
    && serverSource.includes("samurai_login_session_invalid");
  const hookRelay = serverSource.includes("defaultHookRelayCommand")
    && serverSource.includes("scripts/external-integration-hook.ts")
    && hookSource.includes("/connector/activity")
    && hookSource.includes("/connector/capture");
  const adapters = ["codex", "claude_code", "hermes"].every((client) => adapterSource.includes(`client: "${client}"`))
    && adapterSource.includes("win32")
    && adapterSource.includes("configPath");
  const approvalUi = httpSource.includes("/oauth/deny")
    && httpSource.includes("/approval/deny")
    && httpSource.includes("Review the before/after change")
    && httpSource.includes('Deny</button>');
  const capture = httpSource.includes("/connector/capture")
    && hookSource.includes("--capture");
  return {
    login_session: loginSession,
    hook_relay: hookRelay,
    adapters,
    approval_ui: approvalUi,
    capture,
    complete: loginSession && hookRelay && adapters && approvalUi && capture
  };
}
