import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDirectory = path.join(root, "reports", "server04-completion");
const prefixes = ["HOSTED", "SELF_HOST"];
const checks = [];

function run(label, command, args, options = {}) {
  console.log("[Server04 complete] " + label);
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...(options.env ?? {}) }
  });
  const passed = result.status === 0 && !result.error;
  checks.push({
    label,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    status: passed ? "passed" : "failed",
    ...(result.status === null || result.status === undefined ? {} : { exit_code: result.status }),
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.error ? { error: result.error.message } : {})
  });
  return passed;
}

function runCheck(label, action) {
  console.log("[Server04 complete] " + label);
  const startedAt = new Date().toISOString();
  try {
    action();
    checks.push({ label, started_at: startedAt, completed_at: new Date().toISOString(), status: "passed" });
    return true;
  } catch (error) {
    checks.push({
      label,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

function captured(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

function externalEnvironment() {
  const targets = prefixes.map((prefix) => ({
    prefix,
    databaseUrl: process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_URL`],
    adminDatabaseUrl: process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_ADMIN_URL`],
    runtimeRole: process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_RUNTIME_ROLE`]
  }));
  if (!targets.some((target) => target.databaseUrl || target.adminDatabaseUrl || target.runtimeRole)) return undefined;
  if (targets.some((target) => !target.databaseUrl || !target.adminDatabaseUrl || !target.runtimeRole)) {
    throw new Error("server04_complete_live_rls_requires_complete_hosted_and_self_host_database_settings");
  }
  if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
    throw new Error("server04_complete_live_rls_requires_explicit_destructive_probe_confirmation");
  }
  return Object.fromEntries(targets.flatMap((target) => [
    [`SAMURAI_SERVER_VERIFY_${target.prefix}_DATABASE_URL`, target.databaseUrl],
    [`SAMURAI_SERVER_VERIFY_${target.prefix}_DATABASE_ADMIN_URL`, target.adminDatabaseUrl],
    [`SAMURAI_SERVER_VERIFY_${target.prefix}_DATABASE_RUNTIME_ROLE`, target.runtimeRole]
  ]));
}

function disposableEnvironment() {
  const available = captured("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (available.status !== 0) {
    const reason = String(available.stderr || available.error?.message || "docker_unavailable").trim();
    throw new Error("server04_postgresql_unavailable:" + (reason || "docker_unavailable"));
  }
  const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
  const container = "samurai-server04-complete-" + suffix;
  const password = "samurai04" + suffix;
  const role = "samurai_server04_runtime";
  const started = captured("docker", [
    "run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_PASSWORD=" + password, "postgres:16-alpine"
  ]);
  if (started.status !== 0) throw new Error("server04_postgresql_unavailable:" + String(started.stderr || started.error?.message || "docker_postgres_start_failed").trim());
  try {
    waitForPostgres(container);
    dockerSql(container, [
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}';`,
      "CREATE DATABASE samurai_server04_hosted;",
      "CREATE DATABASE samurai_server04_self_host;"
    ].join("\n"));
    const port = dockerPort(container);
    const adminUrl = (database) => `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`;
    const runtimeUrl = (database) => `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`;
    return {
      env: {
        SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_URL: runtimeUrl("samurai_server04_hosted"),
        SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_ADMIN_URL: adminUrl("samurai_server04_hosted"),
        SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_RUNTIME_ROLE: role,
        SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_URL: runtimeUrl("samurai_server04_self_host"),
        SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_ADMIN_URL: adminUrl("samurai_server04_self_host"),
        SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_RUNTIME_ROLE: role,
        SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE: "yes"
      },
      dispose: () => captured("docker", ["rm", "--force", container])
    };
  } catch (error) {
    captured("docker", ["rm", "--force", container]);
    throw error;
  }
}

function waitForPostgres(container) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (captured("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "postgres"]).status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("server04_postgresql_start_timeout");
}

function dockerSql(container, sql) {
  const result = captured("docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: sql });
  if (result.status !== 0) throw new Error("server04_postgresql_setup_failed:" + String(result.stderr || result.error?.message || "unknown").trim());
}

function dockerPort(container) {
  const result = captured("docker", ["port", container, "5432/tcp"]);
  const match = String(result.stdout).match(/:(\d+)\s*$/m);
  if (result.status !== 0 || !match) throw new Error("server04_postgresql_port_unavailable");
  return match[1];
}

function checkUntrackedWhitespace() {
  const listed = captured("git", ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (listed.status !== 0) throw new Error("untracked_diff_list_failed:" + String(listed.stderr || "unknown").trim());
  const files = String(listed.stdout).split("\0").filter(Boolean);
  for (const file of files) {
    const result = captured("git", ["diff", "--no-index", "--check", "/dev/null", file]);
    const diagnostics = String(result.stdout || result.stderr || "").trim();
    if ((result.status !== 0 && result.status !== 1) || diagnostics) {
      throw new Error("untracked_diff_check_failed:" + file + (diagnostics ? ":" + diagnostics : ""));
    }
  }
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function writeReports() {
  const passed = checks.every((check) => check.status === "passed");
  const liveLabels = [
    "Hosted and Self-host PostgreSQL Server02 probes",
    "Hosted and Self-host PostgreSQL Server03 probes",
    "Hosted and Self-host PostgreSQL legacy Server04 learning probes",
    "Hosted and Self-host PostgreSQL Completion Server04 probes",
    "Hosted and Self-host PostgreSQL Completion Server04 load probes"
  ];
  const statusFor = (label) => checks.find((check) => check.label === label)?.status === "passed";
  const actualPostgresqlPassed = liveLabels.every(statusFor);
  const categories = {
    implementation: checks.filter((check) => /typecheck|build|source lint|architecture boundaries|diff check/.test(check.label)).every((check) => check.status === "passed"),
    automated_tests: statusFor("Server04 and completion focused tests"),
    actual_postgresql: actualPostgresqlPassed,
    rls_realtime: statusFor("Hosted and Self-host PostgreSQL Server03 probes") && statusFor("Hosted and Self-host PostgreSQL Completion Server04 probes"),
    file_recovery: statusFor("Hosted and Self-host PostgreSQL Completion Server04 probes"),
    migration: statusFor("Hosted and Self-host PostgreSQL Completion Server04 probes"),
    bundle: statusFor("Hosted and Self-host PostgreSQL Completion Server04 probes"),
    performance: statusFor("Hosted and Self-host PostgreSQL Completion Server04 load probes")
  };
  const unchecked = checks.filter((check) => check.status !== "passed").map((check) => check.label);
  const head = captured("git", ["rev-parse", "HEAD"]);
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    commit_sha: head.status === 0 ? String(head.stdout).trim() : null,
    complete: passed && actualPostgresqlPassed && Object.values(categories).every(Boolean) && unchecked.length === 0,
    actual_postgresql: actualPostgresqlPassed ? "passed" : "failed",
    verification: {
      implementation: categories.implementation ? "passed" : "failed",
      automated_tests: categories.automated_tests ? "passed" : "failed",
      actual_postgresql: categories.actual_postgresql ? "passed" : "failed",
      rls_realtime: categories.rls_realtime ? "passed" : "failed",
      file_recovery: categories.file_recovery ? "passed" : "failed",
      migration: categories.migration ? "passed" : "failed",
      bundle: categories.bundle ? "passed" : "failed",
      performance: categories.performance ? "passed" : "failed",
      unverified: unchecked,
      intentional_out_of_scope: ["Native App UI", "OAuth", "MCP", "Plugin", "Vector DB", "Graph DB", "Policy DSL"]
    },
    checks
  };
  const failures = checks.filter((check) => check.status !== "passed");
  const selfReview = [
    "# Server 04 backend completion self-review",
    "",
    `- 総合判定: ${report.complete ? "PASS" : "FAIL"}`,
    `- 実PostgreSQL（Hosted / Self-host）: ${actualPostgresqlPassed ? "PASS" : "FAIL"}`,
    `- RLS／Realtime: ${categories.rls_realtime ? "PASS" : "FAIL"}`,
    `- 実ファイル復旧: ${categories.file_recovery ? "PASS" : "FAIL"}`,
    `- Migration: ${categories.migration ? "PASS" : "FAIL"}`,
    `- Bundle: ${categories.bundle ? "PASS" : "FAIL"}`,
    `- 性能計測: ${categories.performance ? "PASS" : "FAIL"}`,
    "- 確認範囲: schema/RLS、Realtime、ファイル本文/復旧、Review、Policy、Skill package、Evaluation/Curator Job、移行、Bundle v4、負荷、API契約。",
    "- 未解決事項:",
    ...(failures.length ? failures.map((check) => `  - ${check.label}: ${check.error ?? `exit=${check.exit_code ?? "unknown"}`}`) : ["  - なし"]),
    "",
    "この報告は実DB検証が失敗または未実行なら完成扱いにしない。",
    ""
  ].join("\n");
  const cases = checks.map((check) => {
    const duration = Math.max(0, new Date(check.completed_at).getTime() - new Date(check.started_at).getTime()) / 1000;
    const failure = check.status === "passed" ? "" : `<failure message=\"${escapeXml(check.error ?? `exit=${check.exit_code ?? "unknown"}`)}\"/>`;
    return `  <testcase name=\"${escapeXml(check.label)}\" time=\"${duration.toFixed(3)}\">${failure}</testcase>`;
  });
  const junit = [
    `<?xml version=\"1.0\" encoding=\"UTF-8\"?>`,
    `<testsuite name=\"server04-completion\" tests=\"${checks.length}\" failures=\"${failures.length}\">`,
    ...cases,
    "</testsuite>",
    ""
  ].join("\n");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(path.join(reportDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(reportDirectory, "junit.xml"), junit);
  await writeFile(path.join(reportDirectory, "self-review.md"), selfReview);
  return report;
}

let disposable;
try {
  const staticPassed = [
    run("architecture boundaries", "node", ["scripts/verify-architecture-boundaries.mjs"], { env: { SAMURAI_EVIDENCE_MODE: "deferred" } }),
    run("Workspace Server typecheck", "pnpm", ["--filter", "@samurai-agent/workspace-server", "run", "typecheck"]),
    run("Workspace Server source lint", "pnpm", ["exec", "tsc", "-p", "packages/workspace-server/tsconfig.json", "--noEmit", "--noUnusedLocals", "--noUnusedParameters"]),
    run("HTTP Server typecheck", "pnpm", ["--filter", "@samurai-agent/server", "run", "typecheck"]),
    run("Desktop typecheck", "pnpm", ["--filter", "@samurai-agent/desktop", "run", "typecheck"]),
    run("Native App typecheck", "pnpm", ["--filter", "@samurai-agent/web", "run", "typecheck"]),
    run("Workspace Server build", "pnpm", ["--filter", "@samurai-agent/workspace-server", "run", "build"]),
    run("HTTP Server build", "pnpm", ["--filter", "@samurai-agent/server", "run", "build"]),
    run("completion PostgreSQL probe typecheck", "pnpm", ["exec", "tsc", "--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--allowImportingTsExtensions", "--esModuleInterop", "--skipLibCheck", "--strict", "--types", "node", "scripts/verify-server-04-completion-rls.ts"]),
    run("completion PostgreSQL load probe typecheck", "pnpm", ["exec", "tsc", "--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--allowImportingTsExtensions", "--esModuleInterop", "--skipLibCheck", "--strict", "--types", "node", "scripts/verify-server-04-completion-load.ts"]),
    run("Native App build", "pnpm", ["--filter", "@samurai-agent/web", "run", "build"]),
    run("Server04 and completion focused tests", "pnpm", ["exec", "vitest", "run",
      "packages/workspace-server/src/schema.test.ts",
      "packages/workspace-server/src/workspace-bundle-v3.test.ts",
      "packages/workspace-server/src/workspace-completion-files.test.ts",
      "packages/workspace-server/src/workspace-completion-policy.test.ts",
      "packages/workspace-server/src/workspace-learning-policy.test.ts",
      "packages/workspace-server/src/workspace-learning-worker.test.ts",
      "apps/server/src/workspace-server/completion-contract.test.ts",
      "apps/desktop/src/workspace-learning-requests.test.ts",
      "apps/desktop/src/workspace-request-signing.test.ts",
      "apps/web/src/lib/workspace-room-capabilities.test.ts"
    ]),
    run("tracked diff check", "git", ["diff", "--check"]),
    runCheck("untracked diff check", checkUntrackedWhitespace)
  ].every(Boolean);
  if (staticPassed) {
    let environment;
    try {
      environment = externalEnvironment();
      if (!environment) {
        console.log("[Server04 complete] PostgreSQL設定がないため、使い捨てPostgreSQLを起動します。");
        disposable = disposableEnvironment();
        environment = disposable.env;
      }
      run("Hosted and Self-host PostgreSQL Server02 probes", "node", ["--import", "tsx", "scripts/verify-server-02-rls.ts"], { env: environment });
      run("Hosted and Self-host PostgreSQL Server03 probes", "node", ["--import", "tsx", "scripts/verify-server-03-rls.ts"], { env: environment });
      run("Hosted and Self-host PostgreSQL legacy Server04 learning probes", "node", ["--import", "tsx", "scripts/verify-server-04-rls.ts"], { env: environment });
      run("Hosted and Self-host PostgreSQL Completion Server04 probes", "node", ["--import", "tsx", "scripts/verify-server-04-completion-rls.ts"], { env: environment });
      run("Hosted and Self-host PostgreSQL Completion Server04 load probes", "node", ["--import", "tsx", "scripts/verify-server-04-completion-load.ts"], { env: environment });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        label: "Hosted and Self-host PostgreSQL environment",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        status: "failed",
        error: message
      });
      for (const label of [
        "Hosted and Self-host PostgreSQL Server02 probes",
        "Hosted and Self-host PostgreSQL Server03 probes",
        "Hosted and Self-host PostgreSQL legacy Server04 learning probes",
        "Hosted and Self-host PostgreSQL Completion Server04 probes",
        "Hosted and Self-host PostgreSQL Completion Server04 load probes"
      ]) {
        checks.push({
          label,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          status: "failed",
          error: "postgresql_environment_unavailable: " + message
        });
      }
    }
  } else {
    checks.push({
      label: "Hosted and Self-host PostgreSQL Server02 probes",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: "failed",
      error: "static_checks_failed"
    });
    checks.push({
      label: "Hosted and Self-host PostgreSQL Server03 probes",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: "failed",
      error: "static_checks_failed"
    });
    checks.push({
      label: "Hosted and Self-host PostgreSQL legacy Server04 learning probes",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: "failed",
      error: "static_checks_failed"
    });
    checks.push({
      label: "Hosted and Self-host PostgreSQL Completion Server04 probes",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: "failed",
      error: "static_checks_failed"
    });
    checks.push({
      label: "Hosted and Self-host PostgreSQL Completion Server04 load probes",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: "failed",
      error: "static_checks_failed"
    });
  }
} finally {
  disposable?.dispose();
  const report = await writeReports();
  console.log(`[Server04 complete] ${report.complete ? "PASS" : "FAIL"}; reports/server04-completion/`);
  if (!report.complete) process.exitCode = 1;
}
