import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const startedAt = new Date().toISOString();
const postgresOnly = process.argv.includes("--postgres-only");
const verifierName = postgresOnly ? "postgres-deep" : "ci-full";
const configuredResultDirectory = process.env.SAMURAI_VERIFY_REPORT_DIRECTORY?.trim()
  || process.env.SAMURAI_CI_FULL_REPORT_DIRECTORY?.trim();
const resultDirectory = configuredResultDirectory
  ? path.resolve(configuredResultDirectory)
  : mkdtempSync(path.join(os.tmpdir(), `samurai-verify-${verifierName}-`));
mkdirSync(resultDirectory, { recursive: true });
const commandDirectory = path.join(resultDirectory, "commands");
mkdirSync(commandDirectory, { recursive: true });
const checks = [];
const outputSecretValues = Object.entries(process.env)
  .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|DATABASE_URL)/i.test(key) && value && value.length >= 4)
  .map(([, value]) => value)
  .sort((left, right) => right.length - left.length);

function sanitize(value) {
  let text = String(value ?? "");
  for (const secret of outputSecretValues) text = text.replaceAll(secret, "[REDACTED]");
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/((?:token|secret|password|api[_-]?key|authorization|private[_-]?key)\s*[:=]\s*)[^\s,}]+/gi, "$1[REDACTED]");
}

function runCheck(id, kind, command, args, options = {}) {
  const index = checks.length.toString().padStart(3, "0");
  const fileId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  const stdoutPath = path.join(commandDirectory, `${index}-${fileId}.stdout.txt`);
  const stderrPath = path.join(commandDirectory, `${index}-${fileId}.stderr.txt`);
  const checkStartedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeoutMs ?? 30 * 60 * 1000
  });
  const stdout = sanitize(result.stdout ?? "");
  const stderr = sanitize(result.stderr ?? "");
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  const status = result.error || (result.status !== 0 && result.status !== 2)
    ? "failed"
    : result.status === 2
      ? "unverified"
      : "passed";
  const check = {
    id,
    kind,
    status,
    command: [command, ...args],
    exit_code: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    duration_ms: Date.now() - checkStartedAt,
    stdout_file: stdoutPath,
    stderr_file: stderrPath,
    output_tail: `${stdout}\n${stderr}`.trim().slice(-2_000)
  };
  if (result.error) check.error = sanitize(result.error.message);
  checks.push(check);
  return check;
}

function unverified(id, kind, reason, details = {}) {
  const check = { id, kind, status: "unverified", reason, ...details };
  checks.push(check);
  return check;
}

function postgresEnvironment() {
  const targets = ["HOSTED", "SELF_HOST"];
  const required = targets.flatMap((target) => [
    `SAMURAI_SERVER_VERIFY_${target}_DATABASE_URL`,
    `SAMURAI_SERVER_VERIFY_${target}_DATABASE_ADMIN_URL`,
    `SAMURAI_SERVER_VERIFY_${target}_DATABASE_RUNTIME_ROLE`
  ]);
  const missing = required.filter((key) => !process.env[key]);
  if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") missing.push("SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE=yes");
  return { configured: missing.length === 0, missing };
}

function migrationEnvironment(target) {
  return {
    SAMURAI_DATABASE_ADMIN_URL: process.env[`SAMURAI_SERVER_VERIFY_${target}_DATABASE_ADMIN_URL`],
    SAMURAI_DATABASE_RUNTIME_ROLE: process.env[`SAMURAI_SERVER_VERIFY_${target}_DATABASE_RUNTIME_ROLE`]
  };
}

function runPostgresChecks() {
  const environment = postgresEnvironment();
  if (!environment.configured) {
    const details = { missing_environment: environment.missing };
    for (const target of ["HOSTED", "SELF_HOST"]) {
      unverified(`postgres-migration-${target.toLowerCase()}`, "migration", "postgres_environment_unavailable", details);
    }
    for (const id of ["postgres-rls", "postgres-room-hierarchy", "server-worker-bundle", "completion-worker-bundle", "runtime-recovery-rls"]) {
      unverified(id, "postgres", "postgres_environment_unavailable", details);
    }
    return;
  }

  for (const target of ["HOSTED", "SELF_HOST"]) {
    runCheck(`postgres-migration-${target.toLowerCase()}`, "migration", "pnpm", ["--filter", "@samurai-agent/server", "run", "workspace-server:admin", "--", "migrate"], {
      env: migrationEnvironment(target),
      timeoutMs: 15 * 60 * 1000
    });
  }
  runCheck("postgres-rls", "postgres", process.execPath, ["--import", "tsx", "scripts/verify-server-02-rls.ts"], { timeoutMs: 20 * 60 * 1000 });
  runCheck("postgres-room-hierarchy", "postgres", process.execPath, ["--import", "tsx", "scripts/verify-server-03-rls.ts"], { timeoutMs: 20 * 60 * 1000 });
  runCheck("server-worker-bundle", "server-worker-bundle", process.execPath, ["--import", "tsx", "scripts/verify-server-04-rls.ts"], { timeoutMs: 30 * 60 * 1000 });
  runCheck("completion-worker-bundle", "server-worker-bundle", process.execPath, ["--import", "tsx", "scripts/verify-server-04-completion-rls.ts"], { timeoutMs: 30 * 60 * 1000 });
  runCheck("runtime-recovery-rls", "server-worker-recovery", process.execPath, ["--import", "tsx", "scripts/verify-runtime-recovery-rls.ts"], { timeoutMs: 30 * 60 * 1000 });
}

function writeReport(report) {
  const reportPath = path.join(resultDirectory, "result.json");
  writeFileSync(reportPath, `${JSON.stringify({ ...report, result_file: reportPath }, null, 2)}\n`);
  return reportPath;
}

function problemCheckSummary(check) {
  return {
    id: check.id,
    kind: check.kind,
    status: check.status,
    exit_code: check.exit_code ?? null,
    signal: check.signal ?? null,
    duration_ms: check.duration_ms ?? null,
    ...(check.command ? { command: check.command } : {}),
    ...(check.reason ? { reason: check.reason } : {}),
    ...(check.error ? { error: check.error } : {}),
    ...(check.missing_environment ? { missing_environment: check.missing_environment } : {}),
    ...(check.output_tail ? { output_tail: check.output_tail } : {})
  };
}

function escapeMarkdownCodeFence(value) {
  return String(value).replaceAll("```", "` ` `");
}

function writeGitHubStepSummary(report, reportPath) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (!summaryPath) return;
  const problemChecks = report.checks.filter((check) => check.status !== "passed");
  const lines = [
    `## ${report.verifier}`,
    "",
    `- Status: **${report.status}**`,
    `- Failed: **${report.checks.filter((check) => check.status === "failed").length}**`,
    `- Unverified: **${report.checks.filter((check) => check.status === "unverified").length}**`,
    `- Report: \`${reportPath}\``
  ];
  for (const check of problemChecks) {
    lines.push("", `### ${check.id}: ${check.status}`);
    if (check.reason) lines.push("", `Reason: \`${escapeMarkdownCodeFence(check.reason)}\``);
    if (check.error) lines.push("", `Error: \`${escapeMarkdownCodeFence(check.error)}\``);
    if (check.output_tail) {
      lines.push("", "<details><summary>Sanitized output tail</summary>", "", "```text", escapeMarkdownCodeFence(check.output_tail), "```", "", "</details>");
    }
  }
  writeFileSync(summaryPath, `${lines.join("\n")}\n`, { flag: "a" });
}

try {
  if (!postgresOnly) {
    runCheck("architecture-static", "static", process.execPath, ["scripts/verify/architecture-invariants.mjs", "--strict"]);
  }
  runCheck("postgres-migration-readiness", "migration", "pnpm", ["run", "verify:postgres-migration"], { timeoutMs: 5 * 60 * 1000 });
  if (!postgresOnly) {
    runCheck("full-typecheck", "typecheck", "pnpm", ["run", "typecheck"], { timeoutMs: 30 * 60 * 1000 });
    runCheck("web-build", "build", "pnpm", ["--filter", "@samurai-agent/web", "run", "build"], { timeoutMs: 20 * 60 * 1000 });
    runCheck("full-test", "test", "pnpm", ["run", "test"], { timeoutMs: 45 * 60 * 1000 });
  }
  runPostgresChecks();
} catch (error) {
  checks.push({ id: `${verifierName}-runner`, kind: "runner", status: "failed", reason: sanitize(error instanceof Error ? error.message : error) });
}

const failed = checks.some((check) => check.status === "failed");
const hasUnverified = checks.some((check) => check.status === "unverified");
const status = failed ? "failed" : hasUnverified ? "unverified" : "passed";
const exitCode = failed ? 1 : hasUnverified ? 2 : 0;
const report = {
  schema_version: 1,
  verifier: verifierName,
  status,
  exit_code: exitCode,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  repository_root: root,
  postgres_environment_mode: process.env.SAMURAI_CI_FULL_POSTGRES_MODE?.trim() || "external_or_unavailable",
  scope: postgresOnly
    ? ["postgresql", "migration", "rls", "realtime", "server", "worker", "runtime-recovery", "bundle"]
    : ["postgresql", "migration", "server", "worker", "runtime-recovery", "bundle", "web", "full-test"],
  checks,
  unverified: checks.filter((check) => check.status === "unverified"),
  result_directory: resultDirectory
};
const reportPath = writeReport(report);
writeGitHubStepSummary(report, reportPath);
process.stdout.write(`${JSON.stringify({
  verifier: report.verifier,
  status: report.status,
  exit_code: report.exit_code,
  result_directory: resultDirectory,
  result_file: reportPath,
  failed_checks: checks.filter((check) => check.status === "failed").map(problemCheckSummary),
  unverified_checks: checks.filter((check) => check.status === "unverified").map(problemCheckSummary)
}, null, 2)}\n`);
process.exitCode = exitCode;
