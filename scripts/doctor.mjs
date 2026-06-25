import { execFileSync } from "node:child_process";
import { existsSync, openSync, readFileSync, closeSync, readSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const env = readEnvFile(path.join(root, ".env"));
const workspaceDir = env.WORKSPACE_DATA_DIR || path.join(root, "workspace-data");
const dbPath = path.join(workspaceDir, "workspace.sqlite");
const apiPort = Number(env.PORT || process.env.PORT || 4317);
const apiUrl = `http://127.0.0.1:${apiPort}`;

const checks = [];
for (const check of [checkDb(dbPath), checkProviderEnv(env), checkBackendEnv(env)]) {
  checks.push(check);
  printCheck(check);
}
const apiCheck = await checkApi(`${apiUrl}/api/health`);
checks.push(apiCheck);
printCheck(apiCheck);
const latestRunCheck = checkLatestRuns(dbPath);
checks.push(latestRunCheck);
printCheck(latestRunCheck);

process.exitCode = 0;

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
    return { name: "db", ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function printCheck(check) {
  console.log(`${check.ok ? "ok" : "warn"} ${check.name}: ${check.message}`);
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
  const codex = envValues.SAMURAI_CODEX_COMMAND;
  const claude = envValues.SAMURAI_CLAUDE_CODE_COMMAND;
  const configured = [codex ? "codex" : "", claude ? "claude-code" : ""].filter(Boolean);
  return {
    name: "backends",
    ok: true,
    message: configured.length > 0 ? `configured: ${configured.join(", ")}` : "external CLI backend は未設定"
  };
}

async function checkApi(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      return { name: "api", ok: false, message: `${response.status} ${response.statusText}` };
    }
    const body = await response.json();
    return {
      name: "api",
      ok: body?.ok === true && body?.db?.ok !== false,
      message: body?.ok === true ? `running at ${url}` : `unhealthy at ${url}`
    };
  } catch {
    return { name: "api", ok: false, message: `not running at ${url}` };
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
    return { name: "latest-run", ok: false, message: error instanceof Error ? error.message : String(error) };
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
    return {};
  }
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
  return env;
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
