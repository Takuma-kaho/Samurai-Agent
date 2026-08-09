import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const timeoutMs = 60_000;
const prefix = process.platform === "darwin"
  ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
  : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix));
if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-workspace-persistence-"));
const onlyArgument = process.argv.find((argument) => argument.startsWith("--only="));
const only = onlyArgument
  ? new Set(onlyArgument.slice("--only=".length).split(",").map((name) => name.trim()).filter(Boolean))
  : undefined;

function text(value) {
  return typeof value === "string" ? value : value?.toString("utf8") ?? "";
}

function failureStatus(error) {
  return error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM" ? "unverified" : "failed";
}

function runFixture(name, sourceFile) {
  const output = path.join(temporaryRoot, `${name}.mjs`);
  try {
    execFileSync(esbuild, [
      path.join(root, sourceFile),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--external:better-sqlite3",
      `--outfile=${output}`
    ], { cwd: root, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    const raw = execFileSync(process.execPath, [output], {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    if (!raw) {
      return { name, status: "failed", reason: "fixture_produced_no_output" };
    }
    const result = JSON.parse(raw);
    if (result.status !== "passed") {
      return { name, status: "failed", reason: "fixture_did_not_report_passed", result };
    }
    return { name, status: "passed", result };
  } catch (error) {
    return {
      name,
      status: failureStatus(error),
      reason: error instanceof Error ? error.message : String(error),
      stdout: text(error?.stdout).trim().slice(-2_000),
      stderr: text(error?.stderr).trim().slice(-2_000)
    };
  }
}

function runVitest(name, testFiles) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = [
    "exec", "vitest", "run", ...testFiles,
    "--reporter=dot"
  ];
  try {
    const raw = execFileSync(pnpm, args, {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    if (!raw) {
      return { name, status: "failed", reason: "vitest_produced_no_output" };
    }
    return { name, status: "passed", output: raw.slice(-2_000) };
  } catch (error) {
    return {
      name,
      status: failureStatus(error),
      reason: error instanceof Error ? error.message : String(error),
      stdout: text(error?.stdout).trim().slice(-2_000),
      stderr: text(error?.stderr).trim().slice(-2_000)
    };
  }
}

try {
  const availableChecks = [
    { name: "workspace-persistence", run: () => runFixture("workspace-persistence", "scripts/fixtures/workspace-persistence.ts") },
    { name: "workspace-migration", run: () => runFixture("workspace-migration", "scripts/fixtures/workspace-migration.ts") },
    { name: "workspace-file-transaction-recovery", run: () => runFixture("workspace-file-transaction-recovery", "scripts/fixtures/workspace-file-transaction-recovery.ts") },
    { name: "workspace-restore-atomicity", run: () => runFixture("workspace-restore-atomicity", "scripts/fixtures/workspace-restore-atomicity.ts") },
    { name: "workspace-bundle-restore", run: () => runFixture("workspace-bundle-restore", "scripts/fixtures/workspace-bundle-restore.ts") },
    { name: "workspace-restore-recovery", run: () => runFixture("workspace-restore-recovery", "scripts/fixtures/workspace-restore-recovery.ts") },
    { name: "workspace-portability", run: () => runFixture("workspace-portability", "scripts/fixtures/workspace-portability.ts") },
    { name: "session-search-index", run: () => runFixture("session-search-index", "scripts/fixtures/session-search-index.ts") },
    { name: "workspace-store-compatibility", run: () => runVitest("workspace-store-compatibility", ["packages/workspace-store/src/workspace-store.test.ts"]) },
    { name: "core02_transaction_contracts", run: () => runVitest("core02_transaction_contracts", [
      "packages/workspace-store/src/core02-admission.test.ts",
      "packages/workspace-store/src/core02-event-identity.test.ts",
      "packages/workspace-store/src/core02-settlement.test.ts"
    ]) },
    { name: "host_terminal_diagnostic", run: () => runVitest("host_terminal_diagnostic", ["packages/runtime/src/host/agent-host.test.ts"]) }
  ];
  const selected = only ? availableChecks.filter((check) => only.has(check.name)) : availableChecks;
  if (only && (selected.length !== only.size || selected.length === 0)) {
    throw new Error(`workspace_persistence_unknown_check:${[...only].filter((name) => !selected.some((check) => check.name === name)).join(",")}`);
  }
  const checks = selected.map((check) => check.run());
  const status = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "unverified")
      ? "unverified"
      : "passed";
  process.stdout.write(`${JSON.stringify({
    status,
    command: "pnpm core:workspace-persistence:verify",
    timeout_ms_per_child: timeoutMs,
    checks
  })}\n`);
  if (status !== "passed") {
    process.exitCode = 1;
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
