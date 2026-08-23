import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefixes = ["HOSTED", "SELF_HOST"];

function run(label, command, args, options = {}) {
  console.log("[Server04] " + label);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...(options.env ?? {}) } });
  if (result.status !== 0) throw new Error(label + ":" + (result.signal ? "signal=" + result.signal : "exit=" + (result.status ?? "unknown")));
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
    throw new Error("server04_live_rls_requires_complete_hosted_and_self_host_database_settings");
  }
  if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
    throw new Error("server04_live_rls_requires_explicit_destructive_probe_confirmation");
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
  const container = "samurai-server04-" + suffix;
  const password = "samurai04" + suffix;
  const role = "samurai_server04_runtime";
  const started = captured("docker", [
    "run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_PASSWORD=" + password, "postgres:17-alpine"
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

function staticChecks() {
  run("architecture boundaries", "node", ["scripts/verify-architecture-boundaries.mjs"], { env: { SAMURAI_EVIDENCE_MODE: "deferred" } });
  run("Workspace Server typecheck", "pnpm", ["--filter", "@samurai-agent/workspace-server", "run", "typecheck"]);
  run("HTTP Server typecheck", "pnpm", ["--filter", "@samurai-agent/server", "run", "typecheck"]);
  run("Desktop typecheck", "pnpm", ["--filter", "@samurai-agent/desktop", "run", "typecheck"]);
  run("Native App typecheck", "pnpm", ["--filter", "@samurai-agent/web", "run", "typecheck"]);
  run("Learning probe typecheck", "pnpm", ["exec", "tsc", "--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--allowImportingTsExtensions", "--esModuleInterop", "--skipLibCheck", "--strict", "--types", "node", "scripts/verify-server-04-rls.ts"]);
  run("Native App build", "pnpm", ["--filter", "@samurai-agent/web", "run", "build"]);
  run("learning focused tests", "pnpm", ["exec", "vitest", "run",
    "packages/workspace-server/src/schema.test.ts",
    "packages/workspace-server/src/workspace-bundle-v3.test.ts",
    "packages/workspace-server/src/workspace-learning-policy.test.ts",
    "packages/workspace-server/src/workspace-learning-worker.test.ts",
    "apps/desktop/src/workspace-learning-requests.test.ts",
    "apps/desktop/src/workspace-request-signing.test.ts",
    "apps/web/src/lib/workspace-room-capabilities.test.ts"
  ]);
  run("tracked diff check", "git", ["diff", "--check"]);
  checkUntrackedWhitespace();
}

/** `git diff --check` intentionally ignores untracked files. This feature adds
 * new modules, so inspect those without staging or otherwise changing the
 * user's index. `git diff --no-index` exits 1 for a normal difference; only
 * diagnostic output or another exit status is a failure here. */
function checkUntrackedWhitespace() {
  console.log("[Server04] untracked diff check");
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

let disposable;
try {
  staticChecks();
  const environment = externalEnvironment();
  if (environment) {
    run("Hosted and Self-host PostgreSQL learning probes", "node", ["--import", "tsx", "scripts/verify-server-04-rls.ts"], { env: environment });
  } else {
    console.log("[Server04] PostgreSQL設定がないため、使い捨てPostgreSQLを起動します。");
    disposable = disposableEnvironment();
    run("Hosted and Self-host PostgreSQL learning probes", "node", ["--import", "tsx", "scripts/verify-server-04-rls.ts"], { env: disposable.env });
  }
  console.log("[Server04] PASS");
} catch (error) {
  console.error("[Server04] FAIL " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  disposable?.dispose();
}
