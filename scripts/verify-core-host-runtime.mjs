import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const startedAt = new Date().toISOString();
const workspaceTestFiles = readdirSync(path.join(root, "packages/workspace-store/src"))
  .filter((file) => /^core02-.*\.test\.ts$/.test(file))
  .map((file) => `packages/workspace-store/src/${file}`);

const sourceFiles = [
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
  "apps/server/src/api-server.ts"
];

const commands = [
  command("core:host-runtime:check", "node", ["scripts/check-core-host-runtime.mjs"]),
  command("core-02 independent blocker audit", "node", ["scripts/audit-core-host-runtime.mjs"]),
  command("core-schemas typecheck", "node_modules/.bin/tsc", ["-p", "packages/core-schemas/tsconfig.json", "--noEmit"]),
  command("agent-backends typecheck", "node_modules/.bin/tsc", ["-p", "packages/agent-backends/tsconfig.json", "--noEmit"]),
  command("workspace-store typecheck", "node_modules/.bin/tsc", ["-p", "packages/workspace-store/tsconfig.json", "--noEmit"]),
  command("runtime typecheck", "node_modules/.bin/tsc", ["-p", "packages/runtime/tsconfig.json", "--noEmit", "--rootDir", "../.."]),
  command("server typecheck", "node_modules/.bin/tsc", ["-p", "apps/server/tsconfig.json", "--noEmit"]),
  command("focused runtime tests", "node_modules/.bin/vitest", ["run", "--config", "vitest.core02.config.mjs", "packages/runtime/src/execution", "packages/runtime/src/host"], "core02-runtime-focused"),
  command("focused SQLite tests", "node_modules/.bin/vitest", ["run", "--config", "vitest.core02.config.mjs", ...workspaceTestFiles], "core02-workspace-sqlite"),
  command("production composition test", "node_modules/.bin/vitest", ["run", "--config", "vitest.core02.config.mjs", "apps/server/src/composition/runtime.test.ts"], "core02-production-composition"),
  command("git diff check", "git", ["diff", "--no-ext-diff", "--no-textconv", "--check"])
];

let stopRequested = false;
let stopSignal;
let activeChild;
const results = [];

const requestStop = (signal) => {
  if (stopRequested) return;
  stopRequested = true;
  stopSignal = signal;
  console.error(JSON.stringify({ event: "stop_requested", signal, at: new Date().toISOString() }));
  activeChild?.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
};
process.once("SIGINT", () => requestStop("SIGINT"));
process.once("SIGTERM", () => requestStop("SIGTERM"));

console.log(JSON.stringify({ event: "verification_started", scope: "Core-02", at: startedAt, command_count: commands.length }));
for (const spec of commands) {
  const result = stopRequested ? unverifiedResult(spec, "not_started_after_stop") : await runCommand(spec);
  results.push(result);
}

const finishedAt = new Date().toISOString();
const commitSha = readGitSha();
const ci = { status: "not_run", reason: "GitHubへのpushとCI実行はユーザー許可の対象" };
const auditResult = results.find((result) => result.name === "core-02 independent blocker audit");
const hasFailure = results.some((result) => result.status === "fail");
const hasUnverified = results.some((result) => result.status === "unverified");
const localOk = !hasFailure && !hasUnverified;
const auditStatus = auditResult?.status ?? "unverified";
const status = hasFailure
  ? "failed"
  : hasUnverified
    ? "implementation_complete_environment_pending"
    : localOk && auditStatus === "pass"
      ? "implementation_complete_ci_pending"
      : "failed";

const phaseLedger = [
  phase("Phase 0", "scope and contracts", ["packages/runtime/src/host/host-types.ts", "packages/core-schemas/src/index.ts"], ["core:host-runtime:check", "core-schemas typecheck"]),
  phase("Phase 1", "lifecycle and Journal", ["packages/runtime/src/execution/run-lifecycle.ts", "packages/runtime/src/execution/backend-event-journal.ts", "packages/runtime/src/execution/run-state-machine.ts"], ["runtime typecheck", "core02-runtime-focused"]),
  phase("Phase 2", "atomic settlement", ["packages/workspace-store/src/workspace-store.ts", "packages/runtime/src/host/turn-completion-coordinator.ts"], ["workspace-store typecheck", "core02-workspace-sqlite"]),
  phase("Phase 3", "named Host Ports", ["packages/runtime/src/host/agent-host.ts", "packages/runtime/src/host/turn-preparer.ts", "packages/runtime/src/execution/turn-executor.ts"], ["core:host-runtime:check", "runtime typecheck", "core02-runtime-focused"]),
  phase("Phase 4", "recovery and control", ["packages/runtime/src/execution/run-control.ts", "packages/runtime/src/execution/run-recovery.ts", "packages/runtime/src/execution/session-run-queue.ts"], ["runtime typecheck", "core02-runtime-focused", "core-02 independent blocker audit"]),
  phase("Phase 5", "production composition", ["apps/server/src/composition/runtime.ts", "packages/runtime/src/composition/runtime-host.ts", "apps/server/src/api-server.ts"], ["server typecheck", "core02-production-composition", "core-02 independent blocker audit"]),
  phase("Phase 6", "old Turn path removal", ["packages/runtime/src/agent-runtime.ts", "packages/runtime/src/execution/durable-work-coordinator.ts"], ["core:host-runtime:check", "core-02 independent blocker audit", "runtime typecheck"]),
  phase("Phase 7", "source-freeze verification", sourceFiles, commands.map((item) => item.name))
];

const ledger = {
  schema_version: 2,
  scope: "Core-02 Phase 0-7",
  status,
  started_at: startedAt,
  finished_at: finishedAt,
  interrupted: stopRequested,
  ...(stopSignal ? { stop_signal: stopSignal } : {}),
  commit_sha: commitSha,
  production_source: sourceFiles,
  phase_ledger: phaseLedger,
  tests: commands.filter((spec) => spec.test_id).map((spec) => {
    const result = results.find((item) => item.test_id === spec.test_id);
    return {
      id: spec.test_id,
      command: formatCommand(spec),
      exit_code: result?.exit_code ?? null,
      duration_ms: result?.duration_ms ?? null,
      status: result?.status ?? "unverified"
    };
  }),
  commands: results,
  independent_audit: {
    status: auditStatus,
    blockers: auditStatus === "fail" ? ["audit_failed"] : [],
    ...(auditResult?.output_tail ? { output_tail: auditResult.output_tail } : {})
  },
  production_call_graph: {
    status: auditStatus,
    source: ["packages/runtime/src/agent-runtime.ts", "apps/server/src/composition/runtime.ts", "apps/server/src/composition/runtime.test.ts"]
  },
  ci,
  out_of_scope: [
    "自動retry基盤",
    "quarantine/probe/手動解除UI",
    "分散queue",
    "他Coreの業務仕様変更",
    "HTTP API刷新",
    "新しい診断DB",
    "将来機能だけのPort",
    "coverage/mutation/soak/全OS検証"
  ]
};

const reportDir = path.join(root, "reports/core-02");
mkdirSync(reportDir, { recursive: true });
writeFileSync(path.join(reportDir, "scope-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);
writeFileSync(path.join(reportDir, "completion-report.md"), renderReport(ledger));

console.log(JSON.stringify({
  event: "verification_finished",
  status,
  commit_sha: commitSha,
  local_ok: localOk,
  interrupted: stopRequested,
  ci: ci.status,
  evidence: ["reports/core-02/scope-ledger.json", "reports/core-02/completion-report.md"]
}, null, 2));

if (status === "implementation_complete_ci_pending") process.exitCode = 2;
else if (status === "failed") process.exitCode = 1;
else process.exitCode = 0;

function command(name, executable, args, test_id) {
  return { name, executable, args, ...(test_id ? { test_id } : {}) };
}

function phase(id, description, source, commandNames) {
  const missingSource = source.filter((relative) => !existsSync(path.join(root, relative)));
  const relevant = commandNames
    .map((name) => results.find((result) => result.name === name || result.test_id === name))
    .filter(Boolean);
  let status = "unverified";
  if (missingSource.length > 0 || relevant.some((result) => result.status === "fail")) status = "fail";
  else if (missingSource.length === 0 && relevant.length === commandNames.length && relevant.every((result) => result.status === "pass")) status = "verified";
  return {
    id,
    description,
    status,
    source,
    ...(missingSource.length ? { missing_source: missingSource } : {}),
    command_results: relevant.map((result) => ({ name: result.name, status: result.status, exit_code: result.exit_code }))
  };
}

function formatCommand(spec) {
  return [spec.executable, ...spec.args].join(" ");
}

function unverifiedResult(spec, reason) {
  const result = {
    name: spec.name,
    ...(spec.test_id ? { test_id: spec.test_id } : {}),
    command: formatCommand(spec),
    exit_code: null,
    duration_ms: 0,
    status: "unverified",
    termination: reason,
    timed_out: false
  };
  console.log(JSON.stringify({ event: "verification_skipped", command: spec.name, status: result.status, reason }));
  return result;
}

function runCommand(spec) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(JSON.stringify({ event: "verification_command_started", command: spec.name, at: new Date().toISOString() }));
    let output = "";
    let finished = false;
    let spawned;
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 12_000) output = output.slice(-12_000);
    };
    const finish = (exitCode, signal, termination) => {
      if (finished) return;
      finished = true;
      if (activeChild === spawned) activeChild = undefined;
      const normalExit = typeof exitCode === "number" && signal === null && !stopRequested;
      const status = normalExit ? (exitCode === 0 ? "pass" : "fail") : "unverified";
      const result = {
        name: spec.name,
        ...(spec.test_id ? { test_id: spec.test_id } : {}),
        command: formatCommand(spec),
        exit_code: normalExit ? exitCode : null,
        duration_ms: Date.now() - started,
        status,
        termination,
        timed_out: false,
        ...(status !== "pass" && output.trim() ? { output_tail: output.slice(-4_000) } : {})
      };
      console.log(JSON.stringify({ event: "verification_command_finished", command: spec.name, status, exit_code: result.exit_code, duration_ms: result.duration_ms, termination }));
      if (status !== "pass" && output.trim()) console.error(output.slice(-4_000));
      resolve(result);
    };
    try {
      spawned = spawn(spec.executable, spec.args, {
        cwd: root,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false
      });
      activeChild = spawned;
      spawned.stdout.on("data", append);
      spawned.stderr.on("data", append);
      spawned.once("error", (error) => finish(null, null, `spawn_error:${error.message}`));
      spawned.once("close", (exitCode, signal) => finish(exitCode, signal, signal ? `signal:${signal}` : "exit"));
    } catch (error) {
      finish(null, null, `spawn_error:${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function readGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
      timeout: 15_000
    }).trim();
  } catch {
    return "unavailable";
  }
}

function renderReport(value) {
  const localStatus = value.status === "failed"
    ? "失敗・未完了"
    : value.status === "implementation_complete_environment_pending"
      ? "実装完了・環境検証待ち"
      : value.status === "implementation_complete_ci_pending"
        ? "実装完了・CI待ち"
        : "完了";
  const commandRows = value.commands.map((item) => `| ${item.name} | ${item.status} | ${item.exit_code ?? "-"} | ${item.duration_ms}ms |`).join("\n");
  const phaseRows = value.phase_ledger.map((item) => `| ${item.id} | ${item.status} | ${item.command_results.map((result) => `${result.name}:${result.status}`).join(", ")} |`).join("\n");
  return `# Core-02 completion report

- 判定: ${localStatus}
- Commit SHA: ${value.commit_sha}
- CI: ${value.ci.status}${value.ci.reason ? `（${value.ci.reason}）` : ""}
- 検証中断: ${value.interrupted ? `あり（${value.stop_signal ?? "signal不明"}）` : "なし"}

## 最終production経路

Chat、Gateway、AutomationのChat実行は、Server composition rootで一度だけ生成したAgentHostのrunTurnへ入る。AgentRuntimeは入力変換とcommit済みRunの読み直し・従来Resultへの投影を担当する。

## 検証結果

| Command | 結果 | exit code | 所要時間 |
| --- | --- | ---: | ---: |
${commandRows}

## Phase判定

| Phase | 状態 | 実結果 |
| --- | --- | --- |
${phaseRows}

## 責務分離

- RunLifecycleが状態判断、Journalが通常Eventとterminal準備、StoreのcommitTurnSettlementがterminal Event・Message・Run・予約解放を一括確定。
- Presentation、Learning Review、External Assist Syncは確定後の名前付きpost-turn operationとして実行し、失敗は既存JournalのHost診断Eventへ保存する。
- 検証は正常終了したコマンドのexit codeだけでpass/failを決め、中断・環境停止・未実行はunverifiedとして残す。

## 対象外

${value.out_of_scope.map((item) => `- ${item}`).join("\n")}

CIが未実行、またはunverifiedが残る場合は、Core-02を完了扱いにしない。
`;
}
