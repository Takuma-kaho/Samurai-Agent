import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { evaluatePhase13Completion } from "./lib/phase13-completion.mjs";

const root = process.cwd();
const writeReport = process.argv.includes("--write-report");
const reportDirectory = writeReport
  ? path.join(root, "reports/core-completion")
  : mkdtempSync(path.join(os.tmpdir(), "samurai-phase13-completion-"));
mkdirSync(reportDirectory, { recursive: true });

const definitions = [
  {
    id: "postgres-migration-static",
    kind: "migration",
    command: process.execPath,
    args: ["scripts/verify-postgres-migration-readiness.mjs", "--static-only"]
  },
  {
    id: "postgres-runtime-scope",
    kind: "migration",
    command: process.execPath,
    args: ["scripts/verify-postgres-runtime-scope.mjs"]
  },
  {
    id: "standard-postgres-entry",
    kind: "entry",
    command: process.execPath,
    args: ["scripts/verify-standard-postgres-entry.mjs"]
  },
  {
    id: "source-quality",
    kind: "quality",
    command: process.execPath,
    args: ["scripts/verify-source-quality.mjs"]
  },
  {
    id: "core-additions",
    kind: "quality",
    command: process.execPath,
    args: ["scripts/verify-core-additions.mjs"]
  },
  {
    id: "ci-full",
    kind: "integration",
    command: process.execPath,
    args: ["scripts/verify/ci-full.mjs"],
    timeoutMs: 45 * 60 * 1000
  }
];

const secretValues = Object.entries(process.env)
  .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|DATABASE_URL)/i.test(key) && value && value.length >= 4)
  .map(([, value]) => value)
  .sort((left, right) => right.length - left.length);

function sanitize(value) {
  let text = String(value ?? "");
  for (const secret of secretValues) text = text.replaceAll(secret, "[REDACTED]");
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/((?:token|secret|password|api[_-]?key|authorization|private[_-]?key)\s*[:=]\s*)[^\s,}]+/gi, "$1[REDACTED]");
}

function runCheck(definition) {
  const startedAt = Date.now();
  const result = spawnSync(definition.command, definition.args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI ?? "true" },
    timeout: definition.timeoutMs ?? 10 * 60 * 1000
  });
  const stdout = sanitize(result.stdout ?? "");
  const stderr = sanitize(result.stderr ?? "");
  const exitCode = typeof result.status === "number" ? result.status : null;
  const status = result.error || (exitCode !== 0 && exitCode !== 2)
    ? "failed"
    : exitCode === 2
      ? "unverified"
      : "passed";
  return {
    id: definition.id,
    kind: definition.kind,
    status,
    command: [definition.command, ...definition.args],
    exit_code: exitCode,
    signal: result.signal ?? null,
    duration_ms: Date.now() - startedAt,
    output_tail: sanitize(`${stdout}\n${stderr}`).trim().slice(-2_000),
    ...(result.error ? { error: sanitize(result.error.message) } : {})
  };
}

const startedAt = new Date().toISOString();
const checks = definitions.map(runCheck);
const decision = evaluatePhase13Completion(checks);
const report = {
  schema_version: 1,
  verifier: "phase13-completion",
  ...decision,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  repository_root: root,
  checks,
  note: "環境依存の未検証はPhase 13の静的完了判定と分離し、成功扱いにはしない。",
  ...(writeReport ? {} : { report_directory: reportDirectory })
};

const reportPath = path.join(reportDirectory, "phase13-latest.json");
writeFileSync(reportPath, `${JSON.stringify({ ...report, report_file: reportPath }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ verifier: report.verifier, status: report.status, complete: report.complete, environment_verified: report.environment_verified, failed: decision.failed.map((check) => check.id), unverified: decision.unverified.map((check) => check.id), report_file: reportPath })}\n`);
process.exitCode = decision.exit_code;
