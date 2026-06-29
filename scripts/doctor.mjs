import { execFileSync } from "node:child_process";
import { constants, existsSync, openSync, readFileSync, closeSync, readSync, statSync, readdirSync, accessSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const envFile = readEnvFile(path.join(root, ".env"));
const env = envFile.values;
const workspaceDir = env.WORKSPACE_DATA_DIR || path.join(root, "workspace-data");
const dbPath = path.join(workspaceDir, "workspace.sqlite");
const apiPort = Number(env.PORT || process.env.PORT || 4317);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const repairRequested = process.argv.includes("--repair");

const checks = [];
const initialChecks = [
  () => checkWorkspaceLayout(workspaceDir),
  () => checkDb(dbPath),
  () => checkEnvFile(envFile),
  () => checkProviderEnv(env),
  () => checkBackendEnv(env),
  () => checkSandboxEnvironment(),
  () => checkDependencyState(root),
  () => checkRunnerState(root)
];
for (const runCheck of initialChecks) {
  const check = runCheck();
  checks.push(check);
  printCheck(check);
}
const migrationCheck = checkMigrationJournal(dbPath);
checks.push(migrationCheck);
printCheck(migrationCheck);
const workspaceIndexCheck = checkWorkspaceIndexes(workspaceDir, dbPath);
checks.push(workspaceIndexCheck);
printCheck(workspaceIndexCheck);
const skillSupportCheck = checkSkillSupportState(workspaceDir, dbPath);
checks.push(skillSupportCheck);
printCheck(skillSupportCheck);
const backupCheck = checkBackupState(workspaceDir);
checks.push(backupCheck);
printCheck(backupCheck);
const apiCheck = await checkApi(`${apiUrl}/api/health`);
checks.push(apiCheck);
printCheck(apiCheck);
const workspaceHealthApiCheck = await checkWorkspaceHealthApi(`${apiUrl}/api/workspace/health`);
checks.push(workspaceHealthApiCheck);
printCheck(workspaceHealthApiCheck);
if (repairRequested) {
  const repairCheck = await repairWorkspaceApi(`${apiUrl}/api/workspace/repair`);
  checks.push(repairCheck);
  printCheck(repairCheck);
}
const latestRunCheck = checkLatestRuns(dbPath);
checks.push(latestRunCheck);
printCheck(latestRunCheck);
const gatewayCheck = checkGatewayState(dbPath);
checks.push(gatewayCheck);
printCheck(gatewayCheck);
const gatewayPolicyCheck = checkGatewayPolicy(env, dbPath);
checks.push(gatewayPolicyCheck);
printCheck(gatewayPolicyCheck);

process.exitCode = 0;

function checkWorkspaceLayout(workspaceDir) {
  const expected = ["artifacts", "memory", "skills", "wiki", "rollback"];
  if (!existsSync(workspaceDir)) {
    return { name: "workspace", ok: false, message: `${workspaceDir} がありません。API起動時に作成されます` };
  }
  const missing = expected.filter((name) => !existsSync(path.join(workspaceDir, name)));
  return {
    name: "workspace",
    ok: missing.length === 0,
    message: missing.length === 0 ? `layout ok: ${workspaceDir}` : `missing: ${missing.join(", ")}`
  };
}

function checkBackupState(workspaceDir) {
  const backupsDir = path.join(workspaceDir, "backups");
  if (!existsSync(workspaceDir)) {
    return { name: "backup", ok: true, message: "workspaceなし" };
  }
  if (!existsSync(backupsDir)) {
    return { name: "backup", ok: false, message: "backups directory がありません。API起動時に作成されます" };
  }
  try {
    const backups = readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("backup_"))
      .map((entry) => {
        const manifestPath = path.join(backupsDir, entry.name, "manifest.json");
        return {
          id: entry.name,
          hasManifest: existsSync(manifestPath),
          mtimeMs: statSync(path.join(backupsDir, entry.name)).mtimeMs
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (backups.length === 0) {
      return { name: "backup", ok: true, message: "backupなし" };
    }
    const invalid = backups.filter((backup) => !backup.hasManifest);
    return {
      name: "backup",
      ok: invalid.length === 0,
      message: invalid.length === 0
        ? `count=${backups.length} latest=${backups[0].id}`
        : `manifest missing=${invalid.length} / latest=${backups[0].id}`
    };
  } catch (error) {
    return { name: "backup", ok: false, message: safeErrorMessage(error) };
  }
}

function checkDb(filePath) {
  if (!existsSync(filePath)) {
    return { name: "db", ok: false, message: `${filePath} がありません` };
  }
  try {
    const stat = statSync(filePath);
    const header = readSqliteHeader(filePath);
    if (header !== "SQLite format 3") {
      return { name: "db", ok: false, message: `SQLite header が不正: ${header || "(empty)"}` };
    }
    const integrity = runSqlite(filePath, "pragma integrity_check;", 1500);
    return {
      name: "db",
      ok: integrity === "ok",
      message: integrity === "ok" ? `readable (${formatBytes(stat.size)})` : `header ok / integrity_check=${integrity}`
    };
  } catch (error) {
    return { name: "db", ok: false, message: safeErrorMessage(error) };
  }
}

function checkMigrationJournal(filePath) {
  if (!existsSync(filePath)) {
    return { name: "migration", ok: true, message: "DBなし" };
  }
  try {
    const latest = runSqlite(filePath, "select name || ':' || status || ':' || created_at from migration_journal order by created_at desc limit 1;", 1500);
    return {
      name: "migration",
      ok: Boolean(latest),
      message: latest || "migration journal 履歴なし"
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message.includes("no such table: migration_journal")) {
      return { name: "migration", ok: true, message: "migration_journal は未初期化です。API起動時に作成されます" };
    }
    return { name: "migration", ok: false, message };
  }
}

function printCheck(check) {
  console.log(`${check.ok ? "ok" : "warn"} ${check.name}: ${check.message}`);
}

function checkEnvFile(result) {
  if (!result.exists) {
    return { name: "env", ok: true, message: ".envなし。必要な設定は .env.example を参照" };
  }
  if (result.error) {
    return { name: "env", ok: false, message: `.env read failed: ${result.error}` };
  }
  return {
    name: "env",
    ok: true,
    message: `.env loaded keys=${Object.keys(result.values).length}`
  };
}

function checkProviderEnv(envValues) {
  const model = envValues.SAMURAI_LLM_MODEL;
  const provider = model?.split("/")[0];
  const keyMap = {
    openai: "OPENAI_API_KEY",
    gemini: envValues.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "openai-compatible": "SAMURAI_OPENAI_COMPATIBLE_API_KEY"
  };
  if (!model) {
    return { name: "provider", ok: false, message: "SAMURAI_LLM_MODEL が未設定" };
  }
  const keyName = keyMap[provider];
  if (!keyName) {
    return { name: "provider", ok: false, message: `unsupported model ref: ${model}` };
  }
  return {
    name: "provider",
    ok: Boolean(envValues[keyName]),
    message: envValues[keyName] ? `${model} / ${keyName}=set` : `${model} / ${keyName}=empty`
  };
}

function checkBackendEnv(envValues) {
  const probes = [
    ["codex", envValues.SAMURAI_CODEX_COMMAND],
    ["claude-code", envValues.SAMURAI_CLAUDE_CODE_COMMAND]
  ]
    .filter(([, command]) => Boolean(command))
    .map(([name, command]) => ({ name, ...resolveCommandProbe(command) }));
  const missing = probes.filter((probe) => !probe.resolved);
  return {
    name: "backends",
    ok: missing.length === 0,
    message: probes.length > 0
      ? probes.map((probe) => `${probe.name}:${probe.resolved ? "ready" : probe.reason}`).join(", ")
      : "external CLI backend は未設定"
  };
}

function checkSandboxEnvironment() {
  const dockerCommand = resolveCommandProbe("docker");
  const sshCommand = resolveCommandProbe("ssh");
  const rsyncCommand = resolveCommandProbe("rsync");
  const dockerCli = dockerCommand.resolved
    ? probeSystemCommand("docker", ["--version"], { timeout: 1500 })
    : { ok: false, message: dockerCommand.reason };
  const dockerDaemon = dockerCommand.resolved
    ? probeSystemCommand("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 1500 })
    : { ok: false, message: "skipped_no_docker_cli" };
  const sshCli = sshCommand.resolved
    ? probeSystemCommand("ssh", ["-V"], { timeout: 1500 })
    : { ok: false, message: sshCommand.reason };
  const rsyncCli = rsyncCommand.resolved
    ? probeSystemCommand("rsync", ["--version"], { timeout: 1500 })
    : { ok: false, message: rsyncCommand.reason };
  const dockerStatus = [
    `cli=${dockerCli.ok ? "ready" : dockerCli.message}`,
    `daemon=${dockerDaemon.ok ? `ready${dockerDaemon.message ? `:${dockerDaemon.message}` : ""}` : dockerDaemon.message}`
  ].join(",");
  const remoteTransportStatus = [
    `ssh=${sshCli.ok ? "ready" : sshCli.message}`,
    `rsync=${rsyncCli.ok ? "ready" : rsyncCli.message}`,
    "target=runtime_metadata"
  ].join(",");
  return {
    name: "sandbox-env",
    ok: true,
    message: `docker(${dockerStatus}) / remote(${remoteTransportStatus}) / long_e2e=manual_opt_in`
  };
}

function checkDependencyState(rootDir) {
  const nodeModulesDir = path.join(rootDir, "node_modules");
  const pnpmDir = path.join(nodeModulesDir, ".pnpm");
  if (!existsSync(pnpmDir)) {
    return { name: "dependencies", ok: false, message: "node_modules/.pnpm がありません。pnpm install を実行してください" };
  }
  try {
    const packageDirs = readdirSync(pnpmDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const duplicateArtifacts = [
      ...dependencyTopLevelDuplicateArtifacts(nodeModulesDir),
      ...packageDirs.flatMap((entry) => dependencyDuplicateArtifacts(pnpmDir, entry.name))
    ]
      .sort((left, right) => left.name.localeCompare(right.name));
    const missingBins = requiredPackageBins(rootDir).filter((item) => existsSync(item.packagePath) && !existsSync(item.binPath));
    if (duplicateArtifacts.length === 0 && missingBins.length === 0) {
      return { name: "dependencies", ok: true, message: "pnpm store ok" };
    }
    const emptyCount = duplicateArtifacts.filter((entry) => entry.empty).length;
    const nonEmptyCount = duplicateArtifacts.length - emptyCount;
    const samples = duplicateArtifacts.slice(0, 5).map((entry) => entry.name).join(", ");
    const missingBinMessage = missingBins.length ? ` missing_bins=${missingBins.map((item) => item.name).join(",")};` : "";
    const duplicateMessage = duplicateArtifacts.length
      ? `pnpm duplicate artifacts=${duplicateArtifacts.length} empty=${emptyCount} non_empty=${nonEmptyCount} samples=${samples};`
      : "pnpm duplicate artifacts=0;";
    return {
      name: "dependencies",
      ok: false,
      message: `${duplicateMessage}${missingBinMessage} node_modules の再生成を検討してください`
    };
  } catch (error) {
    return { name: "dependencies", ok: false, message: safeErrorMessage(error) };
  }
}

function dependencyTopLevelDuplicateArtifacts(nodeModulesDir) {
  return safeReadDir(nodeModulesDir)
    .filter((entry) => entry.name.endsWith(" 2") || entry.name.includes(" 2."))
    .map((entry) => {
      const entryPath = path.join(nodeModulesDir, entry.name);
      return {
        name: entry.name,
        empty: entry.isDirectory() ? safeReadDir(entryPath).length === 0 : false
      };
    });
}

function dependencyDuplicateArtifacts(pnpmDir, packageDirName) {
  const packagePath = path.join(pnpmDir, packageDirName);
  const candidates = packageDirName.endsWith(" 2")
    ? [{ name: packageDirName, path: packagePath }]
    : [];
  for (const child of safeReadDir(packagePath)) {
    if (child.isDirectory() && child.name.endsWith(" 2")) {
      candidates.push({
        name: `${packageDirName}/${child.name}`,
        path: path.join(packagePath, child.name)
      });
    }
  }
  return candidates.map((candidate) => ({
    name: candidate.name,
    empty: safeReadDir(candidate.path).length === 0
  }));
}

function requiredPackageBins(rootDir) {
  return [{
    name: "vite",
    packagePath: path.join(rootDir, "node_modules", "vite", "package.json"),
    binPath: path.join(rootDir, "node_modules", "vite", "bin", "vite.js")
  }, {
    name: "vitest",
    packagePath: path.join(rootDir, "node_modules", "vitest", "package.json"),
    binPath: path.join(rootDir, "node_modules", "vitest", "vitest.mjs")
  }];
}

function safeReadDir(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function checkRunnerState(rootDir) {
  const vitestCli = path.join(rootDir, "node_modules", "vitest", "vitest.mjs");
  const probes = [
    probeNodeRunner("node", ["-e", "process.stdout.write('ready')"], { timeout: 1000, warnAfter: 500 }),
    probeNodeRunner("typescript", ["-e", "require('typescript'); process.stdout.write('ready')"], { timeout: 5000, warnAfter: 1000 }),
    probeNodeRunner("tsx_import", ["--import", "tsx", "-e", "process.stdout.write('ready')"], { timeout: 10000, warnAfter: 2500 }),
    existsSync(vitestCli)
      ? probeNodeRunner("vitest_cli", [vitestCli, "--version"], { timeout: 10000, warnAfter: 2500 })
      : { name: "vitest_cli", ok: false, message: "not_installed" }
  ];
  const failed = probes.filter((probe) => !probe.ok);
  const advice = runnerProbeAdvice(failed);
  return {
    name: "runner",
    ok: failed.length === 0,
    message: `${probes.map((probe) => `${probe.name}:${probe.message}`).join(", ")}${advice ? `; ${advice}` : ""}`
  };
}

function probeNodeRunner(name, args, options) {
  const startedAt = Date.now();
  try {
    execFileSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: options.timeout,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const duration = Date.now() - startedAt;
    return {
      name,
      ok: duration <= options.warnAfter,
      message: duration <= options.warnAfter ? `ready:${duration}ms` : `slow_${options.warnAfter}ms:${duration}ms`
    };
  } catch (error) {
    const duration = Date.now() - startedAt;
    return {
      name,
      ok: false,
      message: `${runnerProbeFailureReason(error, options.timeout)}:${duration}ms`
    };
  }
}

function probeSystemCommand(command, args, options) {
  try {
    const output = execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: options.timeout,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return {
      ok: true,
      message: summarizeProbeMessage(output)
    };
  } catch (error) {
    return {
      ok: false,
      message: systemProbeFailureReason(error, options.timeout)
    };
  }
}

function runnerProbeFailureReason(error, timeout) {
  if (error && typeof error === "object") {
    if (error.signal === "SIGTERM" || error.killed === true || error.code === "ETIMEDOUT") {
      return `timeout_${timeout}ms`;
    }
    const stderr = typeof error.stderr === "string" ? error.stderr : Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : "";
    const message = safeErrorMessage(stderr || error.message || String(error));
    if (message.includes("The service was stopped")) {
      return "esbuild_service_stopped";
    }
    if (message.includes("EPERM")) {
      return "eperm";
    }
    const code = typeof error.status === "number" ? `exit_${error.status}` : "failed";
    return `${code}${message ? `:${summarizeProbeMessage(message)}` : ""}`;
  }
  return "failed";
}

function systemProbeFailureReason(error, timeout) {
  if (error && typeof error === "object") {
    if (error.signal === "SIGTERM" || error.killed === true || error.code === "ETIMEDOUT") {
      return `timeout_${timeout}ms`;
    }
    const stderr = typeof error.stderr === "string" ? error.stderr : Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : "";
    const stdout = typeof error.stdout === "string" ? error.stdout : Buffer.isBuffer(error.stdout) ? error.stdout.toString("utf8") : "";
    const message = safeErrorMessage(stderr || stdout || error.message || String(error));
    const code = typeof error.status === "number" ? `exit_${error.status}` : "failed";
    return `${code}${message ? `:${summarizeProbeMessage(message)}` : ""}`;
  }
  return "failed";
}

function runnerProbeAdvice(failedProbes) {
  if (failedProbes.length === 0) {
    return "";
  }
  const failedNames = new Set(failedProbes.map((probe) => probe.name));
  const failureText = failedProbes.map((probe) => probe.message).join(" ");
  if (failureText.includes("not_installed")) {
    return "next=pnpm_install_required; test/dev runner may hang";
  }
  if (failureText.includes("esbuild_service_stopped")) {
    return "next=refresh_node_modules_esbuild; test/dev runner may hang";
  }
  if (failureText.includes("eperm")) {
    return "next=check_ipc_permissions; test/dev runner may hang";
  }
  if (failureText.includes("slow_")) {
    return "next=runner_warmup_or_dependency_refresh_before_long_verification; test/dev runner may be slow";
  }
  if (
    (failedNames.has("tsx_import") || failedNames.has("vitest_cli"))
    && failureText.includes("timeout_")
  ) {
    return "next=refresh_node_modules_before_trusting_tests; test/dev runner may hang";
  }
  return "next=inspect_runner_stderr; test/dev runner may hang";
}

function summarizeProbeMessage(message) {
  return message.replace(/\s+/g, " ").trim().slice(0, 80);
}

function resolveCommandProbe(command) {
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed) {
    return { resolved: false, reason: "command_not_configured" };
  }
  const candidates = isDirectCommandPath(trimmed)
    ? [trimmed]
    : (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, trimmed));
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return { resolved: true };
    }
  }
  return { resolved: false, reason: candidates.some((candidate) => existsSync(candidate)) ? "command_not_executable" : "command_not_found" };
}

function isDirectCommandPath(command) {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function isExecutableFile(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function checkWorkspaceIndexes(workspaceDir, filePath) {
  if (!existsSync(workspaceDir)) {
    return { name: "workspace-index", ok: true, message: "workspaceなし" };
  }
  if (!existsSync(filePath)) {
    return { name: "workspace-index", ok: true, message: "DBなし" };
  }
  try {
    const files = listWikiMarkdownFiles(workspaceDir);
    const output = runSqlite(filePath, "select id || char(9) || file_path || char(9) || state from wiki_index order by updated_at desc;", 1500);
    const rows = output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [id, filePathValue, state] = line.split("\t");
        return { id, file_path: filePathValue, state };
      });
    const fileSet = new Set(files);
    const indexSet = new Set(rows.map((row) => row.file_path));
    const missing = rows.filter((row) => !fileSet.has(row.file_path));
    const unindexed = files.filter((file) => !indexSet.has(file));
    const active = rows.filter((row) => row.state === "active").length;
    if (missing.length === 0 && unindexed.length === 0) {
      return { name: "workspace-index", ok: true, message: `Knowledge Wiki ok: files=${files.length} indexed=${rows.length} active=${active}` };
    }
    return {
      name: "workspace-index",
      ok: false,
      message: `Knowledge Wiki drift: unindexed=${unindexed.length} missing=${missing.length}; /api/wiki/reindex で再構築できます`
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message.includes("no such table: wiki_index")) {
      return { name: "workspace-index", ok: true, message: "wiki_index は未初期化です。API起動時に作成されます" };
    }
    return { name: "workspace-index", ok: false, message };
  }
}

function checkSkillSupportState(workspaceDir, filePath) {
  if (!existsSync(workspaceDir)) {
    return { name: "skill-support", ok: true, message: "workspaceなし" };
  }
  const supportRoot = path.join(workspaceDir, "skills", "support");
  if (!existsSync(supportRoot)) {
    return { name: "skill-support", ok: true, message: "support files=0" };
  }
  try {
    const supportDirs = readdirSync(supportRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const supportFiles = listFiles(supportRoot);
    if (!existsSync(filePath)) {
      return {
        name: "skill-support",
        ok: true,
        message: `files=${supportFiles.length} skills_with_support=${supportDirs.length} / DBなし`
      };
    }
    const skillIds = new Set(runSqlite(filePath, "select id from skill_index;", 1500).split(/\r?\n/).filter(Boolean));
    const orphanDirs = supportDirs.filter((skillId) => !skillIds.has(skillId));
    return {
      name: "skill-support",
      ok: orphanDirs.length === 0,
      message: orphanDirs.length === 0
        ? `files=${supportFiles.length} skills_with_support=${supportDirs.length}`
        : `orphan_support_dirs=${orphanDirs.length}: ${orphanDirs.slice(0, 3).join(", ")}`
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message.includes("no such table: skill_index")) {
      return { name: "skill-support", ok: true, message: "skill_index は未初期化です。API起動時に作成されます" };
    }
    return { name: "skill-support", ok: false, message };
  }
}

async function checkApi(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      return { name: "api", ok: false, message: `${response.status} ${response.statusText}` };
    }
    const body = await response.json();
    const workspaceStatus = body.workspace
      ? `workspace=${body.workspace.ok === true ? "ok" : `issues=${body.workspace.issue_count ?? "?"}/repairs=${body.workspace.repair_plan_count ?? "?"}`}`
      : "workspace=?";
    const blockedReasons = formatReasonCounts(body.gateway?.blocked_inbound_reasons);
    const mcpPoolStatus = formatMcpProcessPool(body.gateway?.mcp_process_pool);
    const pairingStatuses = formatStatusCounts(body.gateway?.pairing_statuses);
    const pairingPolicyStatuses = formatStatusCounts(body.gateway?.pairing_policy_statuses);
    const pairingPolicyTrustModes = formatStatusCounts(body.gateway?.pairing_policy_trust_modes);
    const routingPolicyStatuses = formatStatusCounts(body.gateway?.routing_policy_statuses);
    const routingPolicyStrategies = formatStatusCounts(body.gateway?.routing_policy_strategies);
    const inboundStatuses = formatStatusCounts(body.gateway?.inbound_statuses);
    const lockStatuses = formatStatusCounts(body.gateway?.concurrency_lock_statuses);
    const sandboxExecutors = formatSandboxExecutorStatuses(body.gateway?.sandbox_executor_statuses);
    const sandboxStatuses = formatStatusCounts(body.gateway?.sandbox_instance_statuses);
    const sandboxSyncStatuses = formatStatusCounts(body.gateway?.sandbox_workspace_sync_statuses);
    const externalAssistStatus = formatExternalAssistStatus(body.external_assist);
    const releaseManualGates = formatReleaseManualGates(body.release);
    const gatewayStatus = `gateway pairings=${pairingStatuses || `pending=${body.gateway?.pending_pairings ?? "?"}/approved=${body.gateway?.approved_pairings ?? "?"}`} pairing_policies=${pairingPolicyStatuses || "?"}/${pairingPolicyTrustModes || "?"} routing_policies=${routingPolicyStatuses || "?"}/${routingPolicyStrategies || "?"} inbound=${inboundStatuses || "?"} blocked=${body.gateway?.blocked_inbound_recent ?? "?"}${blockedReasons ? ` reasons=${blockedReasons}` : ""} failed=${body.gateway?.failed_inbound_recent ?? "?"} boundary=${body.gateway?.boundary_policies ?? "?"} mcp_pool=${mcpPoolStatus} locks=${lockStatuses || `active=${body.gateway?.active_concurrency_locks ?? "?"}`} sandbox_exec=${sandboxExecutors} sandbox=${sandboxStatuses || "none"} sandbox_sync=${sandboxSyncStatuses || "none"}`;
    return {
      name: "api",
      ok: body?.ok === true && body?.db?.ok !== false && body?.workspace?.ok !== false,
      message: body?.ok === true ? `running at ${url} / ${workspaceStatus} / external_assist=${externalAssistStatus} / release_manual=${releaseManualGates} / ${gatewayStatus}` : `unhealthy at ${url}`
    };
  } catch {
    return { name: "api", ok: false, message: `not running at ${url}` };
  }
}

function formatExternalAssistStatus(assist) {
  if (!assist) {
    return "unknown";
  }
  const errors = Array.isArray(assist.errors) ? assist.errors.filter(Boolean) : [];
  const warnings = Array.isArray(assist.warnings) ? assist.warnings.filter(Boolean) : [];
  if (assist.configured) {
    const id = assist.provider_id || "configured";
    const kind = assist.provider_kind ? `(${assist.provider_kind})` : "";
    const warningText = warnings.length > 0 ? `/warnings=${warnings.join(",")}` : "";
    return `${id}${kind}${warningText}`;
  }
  if (assist.source === "invalid" || errors.length > 0) {
    return `invalid:${errors.join(",") || "unknown_error"}`;
  }
  return "none";
}

function formatReleaseManualGates(release) {
  if (!release) {
    return "unknown";
  }
  const gates = Array.isArray(release.manual_gates) ? release.manual_gates : [];
  if (gates.length === 0) {
    return "none";
  }
  const ids = gates.map((gate) => `${gate?.id || "unknown"}:${gate?.status || "unknown"}`).join(",");
  return `${release.manual_gate_count ?? gates.length}:${ids}`;
}

async function checkWorkspaceHealthApi(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      return { name: "workspace-health-api", ok: false, message: `${response.status} ${response.statusText}` };
    }
    const body = await response.json();
    const boundaries = Array.isArray(body?.resource_boundaries) ? body.resource_boundaries : [];
    const resources = boundaries.map((boundary) => boundary?.resource).filter(Boolean);
    const required = ["memory", "knowledge_wiki", "skill", "artifact", "collection", "session_run_history"];
    const missing = required.filter((resource) => !resources.includes(resource));
    const repairPlan = Array.isArray(body?.repair_plan) ? body.repair_plan : [];
    const repairOps = repairPlan.map((step) => step?.operation).filter(Boolean);
    const indexes = body?.indexes ?? {};
    const indexSummary = [
      `wiki=${indexes.wiki?.files ?? "?"}/${indexes.wiki?.indexed ?? "?"}`,
      `artifacts=${indexes.artifacts?.files ?? "?"}/${indexes.artifacts?.indexed ?? "?"}`,
      `memory=${indexes.memory?.files ?? "?"}/${indexes.memory?.indexed ?? "?"}`,
      `skills=${indexes.skills?.files ?? "?"}/${indexes.skills?.indexed ?? "?"}`,
      `collections=${indexes.collections?.schemas?.files ?? "?"}/${indexes.collections?.schemas?.indexed ?? "?"}/${indexes.collections?.records?.files ?? "?"}/${indexes.collections?.records?.indexed ?? "?"}`
    ].join(" ");
    return {
      name: "workspace-health-api",
      ok: body?.ok !== false && missing.length === 0,
      message: missing.length === 0
        ? `boundaries=${boundaries.length} repairs=${repairPlan.length}${repairOps.length ? ` ops=${repairOps.join(",")}` : ""} indexes ${indexSummary}`
        : `missing boundaries: ${missing.join(", ")}`
    };
  } catch {
    return { name: "workspace-health-api", ok: true, message: "API未起動のためskip" };
  }
}

async function repairWorkspaceApi(url) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dry_run: false }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      return { name: "workspace-repair-api", ok: false, message: `${response.status} ${response.statusText}` };
    }
    const body = await response.json();
    const applied = Array.isArray(body?.applied) ? body.applied : [];
    const skipped = Array.isArray(body?.skipped) ? body.skipped : [];
    const healthOk = body?.health?.ok === true;
    return {
      name: "workspace-repair-api",
      ok: healthOk && skipped.length === 0,
      message: `applied=${applied.length ? applied.join(",") : "none"} skipped=${skipped.length ? skipped.join(",") : "none"} health=${healthOk ? "ok" : "needs_attention"}`
    };
  } catch {
    return { name: "workspace-repair-api", ok: false, message: `not running at ${url}` };
  }
}

function checkLatestRuns(filePath) {
  if (!existsSync(filePath)) {
    return { name: "latest-run", ok: true, message: "DBなし" };
  }
  try {
    const output = runSqlite(
      filePath,
      "select backend_id || ':' || status || case when error_code is null or error_code = '' then '' else '/' || error_code end from backend_runs order by started_at desc limit 3;",
      1500
    );
    if (!output) {
      return { name: "latest-run", ok: true, message: "履歴なし" };
    }
    return {
      name: "latest-run",
      ok: true,
      message: output.split(/\r?\n/).filter(Boolean).join(", ")
    };
  } catch (error) {
    return { name: "latest-run", ok: false, message: safeErrorMessage(error) };
  }
}

function checkGatewayState(filePath) {
  if (!existsSync(filePath)) {
    return { name: "gateway", ok: true, message: "DBなし" };
  }
  try {
    const pairings = runSqlite(filePath, "select status || ':' || count(*) from gateway_pairings group by status order by status;", 1500);
    const pairingPolicies = runSqlite(filePath, "select trust_mode || ':' || count(*) from gateway_pairing_policies group by trust_mode order by trust_mode;", 1500);
    const routingPolicies = runSqlite(filePath, "select session_key_strategy || ':' || count(*) from gateway_routing_policies group by session_key_strategy order by session_key_strategy;", 1500);
    const inbound = runSqlite(filePath, "select status || ':' || count(*) from gateway_inbound_messages group by status order by status;", 1500);
    const boundaries = runSqlite(filePath, "select count(*) from gateway_boundary_policies;", 1500);
    const locks = runSqlite(filePath, "select status || ':' || count(*) from gateway_concurrency_locks group by status order by status;", 1500);
    return {
      name: "gateway",
      ok: true,
      message: `pairings=${pairings || "none"} / pairing_policies=${pairingPolicies || "none"} / routing_policies=${routingPolicies || "none"} / inbound=${inbound || "none"} / boundary_policies=${boundaries || "0"} / locks=${locks || "none"}`
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message.includes("no such table: gateway_")) {
      return { name: "gateway", ok: true, message: "Gateway tables are not initialized yet; start the API once to run migrations" };
    }
    return { name: "gateway", ok: false, message: safeErrorMessage(error) };
  }
}

function checkGatewayPolicy(envValues, filePath) {
  const allowlist = parseList(envValues.SAMURAI_GATEWAY_SOURCE_ALLOWLIST);
  if (!existsSync(filePath)) {
    return { name: "gateway-policy", ok: true, message: allowlist.length ? `allowlist entries=${allowlist.length}` : "DBなし" };
  }
  try {
    const approved = Number(runSqlite(filePath, "select count(*) from gateway_pairings where status = 'approved';", 1500) || "0");
    const storedPolicies = Number(runSqlite(filePath, "select count(*) from gateway_pairing_policies;", 1500) || "0");
    const policyModes = runSqlite(filePath, "select trust_mode || ':' || count(*) from gateway_pairing_policies group by trust_mode order by trust_mode;", 1500);
    const routingPolicies = Number(runSqlite(filePath, "select count(*) from gateway_routing_policies;", 1500) || "0");
    const routingStrategies = runSqlite(filePath, "select session_key_strategy || ':' || count(*) from gateway_routing_policies group by session_key_strategy order by session_key_strategy;", 1500);
    const expiredLocks = Number(runSqlite(filePath, `select count(*) from gateway_concurrency_locks where status = 'acquired' and expires_at <= '${new Date().toISOString()}';`, 1500) || "0");
    if (allowlist.length === 0 && storedPolicies === 0 && approved > 0) {
      return { name: "gateway-policy", ok: false, message: `allowlist未設定かつ保存policyなし / approved_pairings=${approved}` };
    }
    if (expiredLocks > 0) {
      return { name: "gateway-policy", ok: false, message: `expired_active_locks=${expiredLocks} / approved_pairings=${approved}` };
    }
    return {
      name: "gateway-policy",
      ok: true,
      message: `allowlist entries=${allowlist.length} / stored_policies=${storedPolicies} / policy_modes=${policyModes || "none"} / routing_policies=${routingPolicies} / routing_strategies=${routingStrategies || "none"} / approved_pairings=${approved} / expired_active_locks=0`
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message.includes("no such table: gateway_")) {
      return { name: "gateway-policy", ok: true, message: "Gateway tables are not initialized yet; start the API once to run migrations" };
    }
    return { name: "gateway-policy", ok: false, message };
  }
}

function readSqliteHeader(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(15);
    readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function runSqlite(filePath, sql, timeout) {
  return execFileSync("sqlite3", [filePath, sql], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function readEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return { exists: false, values: {}, error: "" };
  }
  try {
    const env = {};
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const index = trimmed.indexOf("=");
      if (index <= 0) {
        continue;
      }
      env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
    return { exists: true, values: env, error: "" };
  } catch (error) {
    return { exists: true, values: {}, error: safeErrorMessage(error) };
  }
}

function listWikiMarkdownFiles(workspaceDir) {
  const wikiRoot = path.join(workspaceDir, "wiki", "pages");
  if (!existsSync(wikiRoot)) {
    return [];
  }
  return listFiles(wikiRoot)
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".md")
    .map((filePath) => path.join("wiki", "pages", filePath))
    .sort();
}

function listFiles(rootDir, currentDir = rootDir) {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(rootDir, absolutePath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, absolutePath));
    }
  }
  return files;
}

function parseList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatReasonCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.entries(value)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
}

function formatStatusCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.entries(value)
    .filter(([, count]) => Number(count) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(",");
}

function formatMcpProcessPool(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "?";
  }
  const count = Number(value.process_count);
  const max = Number(value.max_processes);
  const servers = Array.isArray(value.servers) ? value.servers.length : undefined;
  const countText = Number.isFinite(count) ? count : "?";
  const maxText = Number.isFinite(max) ? max : "?";
  return `${countText}/${maxText}${servers !== undefined ? ` servers=${servers}` : ""}`;
}

function formatSandboxExecutorStatuses(value) {
  if (!Array.isArray(value)) {
    return "?";
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const backend = typeof entry.backend === "string" ? entry.backend : "unknown";
      const state = entry.available === true ? "ok" : (typeof entry.reason === "string" ? entry.reason : "unavailable");
      return `${backend}:${state}`;
    })
    .filter(Boolean)
    .join(",");
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecretLikeString(message);
}

function redactSecretLikeString(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bkey\s*=\s*["']?[^"',\s}]+/gi, "key=[redacted]")
    .replace(/\b(api[_-]?key|authorization|token|secret|password|credential|cookie)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]");
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
