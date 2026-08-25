import { execFileSync } from "node:child_process";
import { constants, existsSync, readFileSync, readdirSync, statSync, accessSync } from "node:fs";
import path from "node:path";

/**
 * Local operator diagnostics for the PostgreSQL Workspace Server.
 *
 * The doctor deliberately does not open a database file or run ad-hoc SQL.
 * Database, migration, RLS, file-transaction, Runtime, learning, and Gateway
 * checks belong to the short-lived administrator CLI.
 */
const root = process.cwd();
const envFile = readEnvFile(path.join(root, ".env"));
const env = { ...envFile.values, ...process.env };
const storageRoot = resolveStorageRoot(env);
const apiPort = Number(env.PORT || env.SAMURAI_API_PORT || 4317);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const repairRequested = process.argv.includes("--repair");
const strictRequested = process.argv.includes("--strict");

const checks = [];
for (const runCheck of [
  () => checkStorageRoot(storageRoot),
  () => checkLegacyRepoWorkspaceData(root),
  () => checkEnvFile(envFile),
  () => checkProviderEnv(env),
  () => checkBackendEnv(env),
  () => checkSandboxEnvironment(),
  () => checkDependencyState(root),
  () => checkRunnerState(root)
]) {
  const check = runCheck();
  checks.push(check);
  printCheck(check);
}

const operatorHealth = checkOperatorHealth(root, env);
checks.push(operatorHealth);
printCheck(operatorHealth);

const apiCheck = await checkApi(`${apiUrl}/api/health`);
checks.push(apiCheck);
printCheck(apiCheck);

if (repairRequested) {
  const repairCheck = {
    name: "repair",
    ok: false,
    message: "自動修復は廃止しました。認証済みWorkspace操作または管理者手順で対象を指定してください"
  };
  checks.push(repairCheck);
  printCheck(repairCheck);
}

if (strictRequested) {
  const persistentChecks = new Set(["storage", "legacy-workspace", "operator-health"]);
  const hasStorage = existsSync(storageRoot);
  process.exitCode = hasStorage && checks.some((check) => persistentChecks.has(check.name) && !check.ok) ? 1 : 0;
} else {
  process.exitCode = 0;
}

function checkStorageRoot(directory) {
  if (!existsSync(directory)) {
    return { name: "storage", ok: false, message: `${directory} がありません。Server起動時に作成されます` };
  }
  try {
    const stat = statSync(directory);
    return stat.isDirectory()
      ? { name: "storage", ok: true, message: `PostgreSQL file storage root ok: ${directory}` }
      : { name: "storage", ok: false, message: `${directory} はディレクトリではありません` };
  } catch (error) {
    return { name: "storage", ok: false, message: safeErrorMessage(error) };
  }
}

function checkLegacyRepoWorkspaceData(repositoryRoot) {
  const legacy = path.join(repositoryRoot, "workspace-data");
  if (!workspaceHasUserData(legacy)) {
    return { name: "legacy-workspace", ok: true, message: "旧repo内 workspace-data は未使用です" };
  }
  return {
    name: "legacy-workspace",
    ok: false,
    message: `旧repo内 workspace-data にデータがあります。旧形式データの自動取り込みはしません: ${legacy}`
  };
}

function checkOperatorHealth(rootDir, envValues) {
  if (!envValues.SAMURAI_DATABASE_ADMIN_URL || !envValues.SAMURAI_DATABASE_RUNTIME_ROLE) {
    return { name: "operator-health", ok: false, message: "SAMURAI_DATABASE_ADMIN_URL / SAMURAI_DATABASE_RUNTIME_ROLE が未設定です" };
  }
  try {
    const output = execFileSync(process.execPath, [
      "--import", "tsx", "apps/server/src/workspace-server-admin-cli.ts", "health"
    ], {
      cwd: rootDir,
      env: envValues,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    const report = JSON.parse(output);
    const schema = report.schema ?? {};
    const workspace = report.workspace ?? {};
    const runtime = report.runtime ?? {};
    const issueText = Array.isArray(report.issues) ? report.issues.map((issue) => issue.code).filter(Boolean).join(",") : "";
    return {
      name: "operator-health",
      ok: report.ok === true,
      message: `storage=${report.storage ?? "postgresql"} migration=${schema.migration_ok === true ? "ok" : "mismatch"} rls_unprotected=${schema.unprotected_workspace_tables ?? "?"} pending_file_tx=${workspace.pending_file_transactions ?? "?"} unresolved_ops=${runtime.unresolved_operations ?? "?"}${issueText ? ` issues=${issueText}` : ""}`
    };
  } catch (error) {
    return { name: "operator-health", ok: false, message: `admin health unavailable: ${safeErrorMessage(error)}` };
  }
}

function printCheck(check) {
  console.log(`${check.ok ? "ok" : "warn"} ${check.name}: ${check.message}`);
}

function checkEnvFile(result) {
  if (!result.exists) return { name: "env", ok: true, message: ".envなし。必要な設定は .env.example を参照" };
  if (result.error) return { name: "env", ok: false, message: `.env read failed: ${result.error}` };
  return { name: "env", ok: true, message: `.env loaded keys=${Object.keys(result.values).length}` };
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
  if (!model) return { name: "provider", ok: false, message: "SAMURAI_LLM_MODEL が未設定" };
  const keyName = keyMap[provider];
  if (!keyName) return { name: "provider", ok: false, message: `unsupported model ref: ${model}` };
  return { name: "provider", ok: Boolean(envValues[keyName]), message: envValues[keyName] ? `${model} / ${keyName}=set` : `${model} / ${keyName}=empty` };
}

function checkBackendEnv(envValues) {
  const probes = [["codex", envValues.SAMURAI_CODEX_COMMAND], ["claude-code", envValues.SAMURAI_CLAUDE_CODE_COMMAND]]
    .filter(([, command]) => Boolean(command))
    .map(([name, command]) => ({ name, ...resolveCommandProbe(command) }));
  const missing = probes.filter((probe) => !probe.resolved);
  return {
    name: "backends",
    ok: missing.length === 0,
    message: probes.length > 0 ? probes.map((probe) => `${probe.name}:${probe.resolved ? "ready" : probe.reason}`).join(", ") : "external CLI backend は未設定"
  };
}

function checkSandboxEnvironment() {
  const docker = resolveCommandProbe("docker");
  const ssh = resolveCommandProbe("ssh");
  const rsync = resolveCommandProbe("rsync");
  return {
    name: "sandbox-env",
    ok: true,
    message: `docker=${docker.resolved ? "ready" : docker.reason} / ssh=${ssh.resolved ? "ready" : ssh.reason} / rsync=${rsync.resolved ? "ready" : rsync.reason} / long_e2e=manual_opt_in`
  };
}

function checkDependencyState(rootDir) {
  const pnpmDir = path.join(rootDir, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return { name: "dependencies", ok: false, message: "node_modules/.pnpm がありません。pnpm install を実行してください" };
  try {
    const packageDirs = readdirSync(pnpmDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const duplicateArtifacts = packageDirs.filter((entry) => entry.name.endsWith(" 2"));
    return duplicateArtifacts.length === 0
      ? { name: "dependencies", ok: true, message: "pnpm store ok" }
      : { name: "dependencies", ok: false, message: `pnpm duplicate artifacts=${duplicateArtifacts.length}` };
  } catch (error) {
    return { name: "dependencies", ok: false, message: safeErrorMessage(error) };
  }
}

function checkRunnerState(rootDir) {
  const probes = [
    probeNodeRunner("node", ["-e", "process.stdout.write('ready')"], { timeout: 1_000, warnAfter: 500 }),
    probeNodeRunner("tsx_import", ["--import", "tsx", "-e", "process.stdout.write('ready')"], { timeout: 10_000, warnAfter: 2_500 }),
    probeNodeRunner("vitest_cli", [path.join(rootDir, "node_modules", "vitest", "vitest.mjs"), "--version"], { timeout: 10_000, warnAfter: 2_500 })
  ];
  const failed = probes.filter((probe) => !probe.ok);
  return { name: "runner", ok: failed.length === 0, message: probes.map((probe) => `${probe.name}:${probe.message}`).join(", ") };
}

async function checkApi(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return { name: "api", ok: false, message: `${response.status} ${response.statusText}` };
    const body = await response.json();
    return { name: "api", ok: body?.ok === true, message: body?.ok === true ? `running at ${url}` : `unhealthy at ${url}` };
  } catch {
    return { name: "api", ok: false, message: `not running at ${url}` };
  }
}

function probeNodeRunner(name, args, options) {
  const startedAt = Date.now();
  try {
    execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: options.timeout, stdio: ["ignore", "pipe", "pipe"] });
    const duration = Date.now() - startedAt;
    return { name, ok: duration <= options.warnAfter, message: duration <= options.warnAfter ? `ready:${duration}ms` : `slow_${options.warnAfter}ms:${duration}ms` };
  } catch (error) {
    const duration = Date.now() - startedAt;
    return { name, ok: false, message: `${runnerProbeFailureReason(error, options.timeout)}:${duration}ms` };
  }
}

function runnerProbeFailureReason(error, timeout) {
  if (error && typeof error === "object" && (error.signal === "SIGTERM" || error.killed === true || error.code === "ETIMEDOUT")) return `timeout_${timeout}ms`;
  return "failed";
}

function resolveCommandProbe(command) {
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed) return { resolved: false, reason: "command_not_configured" };
  const candidates = path.isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")
    ? [trimmed]
    : (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, trimmed));
  for (const candidate of candidates) if (isExecutableFile(candidate)) return { resolved: true };
  return { resolved: false, reason: candidates.some((candidate) => existsSync(candidate)) ? "command_not_executable" : "command_not_found" };
}

function isExecutableFile(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function workspaceHasUserData(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).some((entry) => entry.name !== ".DS_Store");
  } catch {
    return false;
  }
}

function readEnvFile(filePath) {
  if (!existsSync(filePath)) return { exists: false, values: {}, error: "" };
  try {
    const values = {};
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index > 0) values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
    return { exists: true, values, error: "" };
  } catch (error) {
    return { exists: true, values: {}, error: safeErrorMessage(error) };
  }
}

function resolveStorageRoot(values) {
  return path.resolve(values.SAMURAI_WORKSPACE_STORAGE_ROOT?.trim() || values.SAMURAI_WORKSPACE_ROOT?.trim() || values.WORKSPACE_DATA_DIR?.trim() || path.join(root, "storage"));
}

function safeErrorMessage(error) {
  if (error instanceof Error) return error.message.replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, "$1<redacted>");
  return String(error);
}
