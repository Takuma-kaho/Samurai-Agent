import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probePrefixes = ["HOSTED", "SELF_HOST"];

function run(label, command, args, options = {}) {
  console.log("[Server03] " + label);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...(options.env ?? {}) }
  });
  if (result.status !== 0) {
    const detail = result.signal ? "signal=" + result.signal : "exit=" + (result.status ?? "unknown");
    throw new Error(label + ":" + detail);
  }
}

function runCaptured(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options
  });
}

function externalProbeEnvironment() {
  const configured = probePrefixes.map((prefix) => ({
    prefix,
    databaseUrl: process.env["SAMURAI_SERVER_VERIFY_" + prefix + "_DATABASE_URL"],
    adminDatabaseUrl: process.env["SAMURAI_SERVER_VERIFY_" + prefix + "_DATABASE_ADMIN_URL"],
    runtimeRole: process.env["SAMURAI_SERVER_VERIFY_" + prefix + "_DATABASE_RUNTIME_ROLE"]
  }));
  const anyConfigured = configured.some((target) => target.databaseUrl || target.adminDatabaseUrl || target.runtimeRole);
  if (!anyConfigured) return undefined;
  if (configured.some((target) => !target.databaseUrl || !target.adminDatabaseUrl || !target.runtimeRole)) {
    throw new Error("server03_live_rls_requires_complete_hosted_and_self_host_database_settings");
  }
  if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
    throw new Error("server03_live_rls_requires_explicit_destructive_probe_confirmation");
  }
  return Object.fromEntries(configured.flatMap((target) => [
    ["SAMURAI_SERVER_VERIFY_" + target.prefix + "_DATABASE_URL", target.databaseUrl],
    ["SAMURAI_SERVER_VERIFY_" + target.prefix + "_DATABASE_ADMIN_URL", target.adminDatabaseUrl],
    ["SAMURAI_SERVER_VERIFY_" + target.prefix + "_DATABASE_RUNTIME_ROLE", target.runtimeRole]
  ]));
}

/**
 * Server03 is not considered verified until the probes run against PostgreSQL.
 * CI can supply dedicated disposable databases. A developer machine without
 * them gets an isolated local container which is removed in all outcomes.
 */
function createDisposableProbeEnvironment() {
  const availability = runCaptured("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (availability.status !== 0) {
    const reason = String(availability.stderr || availability.error?.message || "docker_unavailable").trim();
    throw new Error("server03_postgresql_unavailable:" + (reason || "docker_unavailable"));
  }

  const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
  const containerName = "samurai-server03-" + suffix;
  const password = "samurai03" + suffix;
  const runtimeRole = "samurai_server03_runtime";
  const hostedDatabase = "samurai_server03_hosted";
  const selfHostDatabase = "samurai_server03_self_host";
  const started = runCaptured("docker", [
    "run", "--detach", "--rm", "--name", containerName,
    "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_PASSWORD=" + password,
    "postgres:16-alpine"
  ]);
  if (started.status !== 0) {
    const reason = String(started.stderr || started.error?.message || "docker_postgres_start_failed").trim();
    throw new Error("server03_postgresql_unavailable:" + (reason || "docker_postgres_start_failed"));
  }

  try {
    waitForPostgres(containerName);
    runDockerSql(containerName, [
      "CREATE ROLE " + runtimeRole + " LOGIN PASSWORD '" + password + "';",
      "CREATE DATABASE " + hostedDatabase + ";",
      "CREATE DATABASE " + selfHostDatabase + ";"
    ].join("\n"));
    const port = dockerPostgresPort(containerName);
    const adminUrl = (database) => "postgresql://postgres:" + password + "@127.0.0.1:" + port + "/" + database;
    const runtimeUrl = (database) => "postgresql://" + runtimeRole + ":" + password + "@127.0.0.1:" + port + "/" + database;
    return {
      env: {
        SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_URL: runtimeUrl(hostedDatabase),
        SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_ADMIN_URL: adminUrl(hostedDatabase),
        SAMURAI_SERVER_VERIFY_HOSTED_DATABASE_RUNTIME_ROLE: runtimeRole,
        SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_URL: runtimeUrl(selfHostDatabase),
        SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_ADMIN_URL: adminUrl(selfHostDatabase),
        SAMURAI_SERVER_VERIFY_SELF_HOST_DATABASE_RUNTIME_ROLE: runtimeRole,
        SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE: "yes"
      },
      dispose() {
        runCaptured("docker", ["rm", "--force", containerName]);
      }
    };
  } catch (error) {
    runCaptured("docker", ["rm", "--force", containerName]);
    throw error;
  }
}

function waitForPostgres(containerName) {
  const deadline = Date.now() + 30_000;
  let lastReason = "postgres_not_ready";
  while (Date.now() < deadline) {
    const result = runCaptured("docker", ["exec", containerName, "pg_isready", "-U", "postgres", "-d", "postgres"]);
    if (result.status === 0) return;
    lastReason = String(result.stderr || result.stdout || result.error?.message || lastReason).trim();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("server03_postgresql_start_timeout:" + lastReason);
}

function runDockerSql(containerName, sql) {
  const result = runCaptured("docker", [
    "exec", "-i", containerName,
    "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"
  ], { input: sql });
  if (result.status !== 0) {
    throw new Error("server03_postgresql_setup_failed:" + String(result.stderr || result.error?.message || "unknown").trim());
  }
}

function dockerPostgresPort(containerName) {
  const result = runCaptured("docker", ["port", containerName, "5432/tcp"]);
  if (result.status !== 0) throw new Error("server03_postgresql_port_unavailable");
  const match = String(result.stdout).match(/:(\d+)\s*$/m);
  if (!match) throw new Error("server03_postgresql_port_invalid");
  return match[1];
}

function runStaticAndFocusedChecks() {
  run("architecture boundaries", "node", ["scripts/verify-architecture-boundaries.mjs"], {
    env: { SAMURAI_EVIDENCE_MODE: "deferred" }
  });
  // `desktop:verify` is a repository-wide historical audit.  It currently
  // covers unrelated Gateway, Client Event Queue, and AppShot contracts, so
  // using it here would make the Room hierarchy gate fail before checking its
  // own Desktop signing boundary.  This verifier instead executes the
  // concrete signing and purpose-specific Room IPC tests below, alongside the
  // Desktop typecheck.  The broader audit remains available as `pnpm
  // desktop:verify` and is not masked or changed here.
  run("Workspace Server typecheck", "pnpm", ["--filter", "@samurai-agent/workspace-server", "run", "typecheck"]);
  run("HTTP Server typecheck", "pnpm", ["--filter", "@samurai-agent/server", "run", "typecheck"]);
  run("Desktop typecheck", "pnpm", ["--filter", "@samurai-agent/desktop", "run", "typecheck"]);
  run("Native App typecheck", "pnpm", ["--filter", "@samurai-agent/web", "run", "typecheck"]);
  run("Room hierarchy live probe typecheck", "pnpm", ["exec", "tsc", "--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--allowImportingTsExtensions", "--esModuleInterop", "--skipLibCheck", "--strict", "--types", "node", "scripts/verify-server-03-rls.ts"]);
  run("Native App build", "pnpm", ["--filter", "@samurai-agent/web", "run", "build"]);
  run("Room hierarchy focused tests", "pnpm", ["exec", "vitest", "run",
    "packages/workspace-server/src/schema.test.ts",
    "packages/workspace-server/src/sqlite-migration.test.ts",
    "packages/workspace-server/src/workspace-bundle-v3.test.ts",
    "apps/server/src/workspace-server/realtime.test.ts",
    "apps/desktop/src/workspace-connections.test.ts",
    "apps/desktop/src/workspace-request-signing.test.ts",
    "apps/desktop/src/workspace-room-requests.test.ts",
    "apps/web/src/lib/workspace-room-tree.test.ts",
    "apps/web/src/lib/workspace-room-capabilities.test.ts"
  ]);
  run("diff check", "git", ["diff", "--check"]);
}

let disposable;
try {
  runStaticAndFocusedChecks();
  const externalEnvironment = externalProbeEnvironment();
  if (externalEnvironment) {
    run("Hosted and Self-host PostgreSQL Room hierarchy probes", "node", ["--import", "tsx", "scripts/verify-server-03-rls.ts"], { env: externalEnvironment });
  } else {
    console.log("[Server03] PostgreSQL設定がないため、使い捨てPostgreSQLを起動します。");
    disposable = createDisposableProbeEnvironment();
    run("Hosted and Self-host PostgreSQL Room hierarchy probes", "node", ["--import", "tsx", "scripts/verify-server-03-rls.ts"], { env: disposable.env });
  }
  console.log("[Server03] PASS");
} catch (error) {
  console.error("[Server03] FAIL " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  disposable?.dispose();
}
