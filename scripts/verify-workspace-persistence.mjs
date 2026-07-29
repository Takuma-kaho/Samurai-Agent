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
  const checks = [
    runFixture("workspace-persistence", "scripts/fixtures/workspace-persistence.ts"),
    runFixture("workspace-migration", "scripts/fixtures/workspace-migration.ts"),
    runFixture("workspace-file-transaction-recovery", "scripts/fixtures/workspace-file-transaction-recovery.ts"),
    runFixture("workspace-restore-atomicity", "scripts/fixtures/workspace-restore-atomicity.ts"),
    runFixture("session-search-index", "scripts/fixtures/session-search-index.ts"),
    runVitest("workspace-store-compatibility", ["packages/workspace-store/src/workspace-store.test.ts"]),
    runVitest("core02_transaction_contracts", [
      "packages/workspace-store/src/core02-admission.test.ts",
      "packages/workspace-store/src/core02-event-identity.test.ts",
      "packages/workspace-store/src/core02-settlement.test.ts"
    ]),
    runVitest("host_terminal_diagnostic", ["packages/runtime/src/host/agent-host.test.ts"])
  ];
  const status = checks.every((check) => check.status === "passed") ? "passed" : "failed";
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
