import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const startedAt = new Date().toISOString();
const commands = [
  { name: "core:host-runtime:check", command: "node", args: ["scripts/check-core-host-runtime.mjs"], timeoutMs: 120_000 },
  { name: "core-schemas typecheck", command: "node_modules/.bin/tsc", args: ["-p", "packages/core-schemas/tsconfig.json", "--noEmit"], timeoutMs: 180_000 },
  { name: "agent-backends typecheck", command: "node_modules/.bin/tsc", args: ["-p", "packages/agent-backends/tsconfig.json", "--noEmit"], timeoutMs: 180_000 },
  { name: "workspace-store typecheck", command: "node_modules/.bin/tsc", args: ["-p", "packages/workspace-store/tsconfig.json", "--noEmit"], timeoutMs: 180_000 },
  { name: "runtime typecheck", command: "node_modules/.bin/tsc", args: ["-p", "packages/runtime/tsconfig.json", "--noEmit", "--rootDir", "../.."], timeoutMs: 180_000 },
  { name: "focused test bundle", command: "node", args: ["scripts/build-core02-test-bundles.mjs"], timeoutMs: 120_000, inheritOutput: true, detached: false },
  { name: "focused vitest runtime", command: "node", args: ["scripts/run-core02-focused-tests.mjs", "runtime"], timeoutMs: 120_000, syncOutput: true },
  { name: "focused vitest workspace", command: "node", args: ["scripts/run-core02-focused-tests.mjs", "workspace"], timeoutMs: 120_000, syncOutput: true },
  { name: "git diff check", command: "git", args: ["diff", "--no-ext-diff", "--no-textconv", "--check"], timeoutMs: 120_000 }
];

const results = [];
for (const spec of commands) results.push(await runCommand(spec));
const sha = readGit(["rev-parse", "HEAD"]);
const dirty = readGit(["status", "--short", "--untracked-files=normal"]);
const ok = results.every((result) => result.ok) && Boolean(sha) && dirty !== undefined;
const report = {
  report: "core-02-host-runtime",
  scope: "Phase 0-2 plus C02-FINAL-01 only",
  status: ok ? "verified" : "failed",
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  commit_sha: sha ?? "unavailable",
  dirty_worktree: dirty ?? null,
  commands: results,
  out_of_scope: ["Phase 3", "Phase 4 Port separation", "Phase 5 production switch", "Phase 6 old Runtime removal", "Phase 7 final hard gate"]
};
const reportDir = path.join(root, "reports/core-02");
mkdirSync(reportDir, { recursive: true });
writeFileSync(path.join(reportDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(reportDir, "latest.md"), `# Core 02 Phase 0-2\n\n- status: ${report.status}\n- commit: ${report.commit_sha}\n- scope: Phase 0-2 plus C02-FINAL-01\n- commands: ${results.map((result) => `${result.name}=${result.ok ? "pass" : "fail"}(${result.duration_ms}ms)`).join(", ")}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(ok ? 0 : 1);

function runCommand(spec) {
  if (spec.syncOutput) return runSyncCommand(spec);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(spec.command, spec.args, {
      cwd: root,
      env: process.env,
      stdio: spec.inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32" && spec.detached !== false
    });
    let output = "";
    let timedOut = false;
    let finished = false;
    let forceTimer;
    let timeoutTimer;
    const appendOutput = (chunk) => {
      output += chunk.toString();
      if (output.length > 1_000_000) output = output.slice(-1_000_000);
    };
    if (!spec.inheritOutput) {
      child.stdout.on("data", appendOutput);
      child.stderr.on("data", appendOutput);
    }
    const finish = (exitCode, signal, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      const duration = Date.now() - started;
      const record = {
        name: spec.name,
        command: [spec.command, ...spec.args].join(" "),
        timeout_ms: spec.timeoutMs,
        started_at: new Date(started).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: duration,
        exit_code: timedOut ? null : exitCode,
        signal: signal ?? (error ? error.code : null),
        ok: !timedOut && exitCode === 0,
        timed_out: timedOut,
        output_tail: output.slice(-4000)
      };
      console.log(JSON.stringify({ command: spec.name, ok: record.ok, exit_code: record.exit_code, duration_ms: record.duration_ms, timed_out: record.timed_out }));
      resolve(record);
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (exitCode, signal) => finish(exitCode, signal, null));
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child);
      forceTimer = setTimeout(() => finish(null, "SIGTERM", null), 2_000);
    }, spec.timeoutMs);
  });
}

function runSyncCommand(spec) {
  const started = Date.now();
  const result = spawnSync(spec.command, spec.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    timeout: spec.timeoutMs,
    killSignal: "SIGTERM"
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  const record = {
    name: spec.name,
    command: [spec.command, ...spec.args].join(" "),
    timeout_ms: spec.timeoutMs,
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    exit_code: timedOut ? null : result.status,
    signal: timedOut ? "SIGTERM" : result.signal,
    ok: !timedOut && result.status === 0,
    timed_out: timedOut,
    output_tail: ""
  };
  console.log(JSON.stringify({ command: spec.name, ok: record.ok, exit_code: record.exit_code, duration_ms: record.duration_ms, timed_out: record.timed_out }));
  return record;
}

function terminateProcessGroup(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function readGit(args) {
  const result = spawnSync("git", args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", timeout: 15_000, maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0 || result.error) return undefined;
  return args[0] === "status" ? (result.stdout ?? "").split(/\r?\n/).filter(Boolean) : (result.stdout ?? "").trim();
}
