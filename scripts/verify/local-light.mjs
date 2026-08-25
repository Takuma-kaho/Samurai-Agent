import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const startedAt = new Date().toISOString();
const resultDirectory = mkdtempSync(path.join(os.tmpdir(), "samurai-verify-local-light-"));
const commandDirectory = path.join(resultDirectory, "commands");
mkdirSync(commandDirectory, { recursive: true });
const checks = [];
const unverified = [];
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

function safeRelativePath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("unsafe_repository_path");
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new Error("unsafe_repository_path");
  }
  const absolute = path.resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("unsafe_repository_path");
  return normalized;
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
    timeout: options.timeoutMs ?? 10 * 60 * 1000
  });
  const stdout = sanitize(result.stdout ?? "");
  const stderr = sanitize(result.stderr ?? "");
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  const status = result.error || result.status !== 0 ? "failed" : "passed";
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
    output_tail: sanitize(`${stdout}\n${stderr}`).trim().slice(-2_000)
  };
  if (result.error) check.error = sanitize(result.error.message);
  checks.push(check);
  return check;
}

function recordUnverified(id, kind, reason, details = {}) {
  const entry = { id, kind, status: "unverified", reason, ...details };
  unverified.push(entry);
  checks.push(entry);
  return entry;
}

function gitPaths(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`git_${args.join("_")}_failed`);
  }
  return String(result.stdout ?? "")
    .split("\0")
    .filter(Boolean)
    .map(safeRelativePath);
}

function changedFiles() {
  return [...new Set([
    ...gitPaths(["diff", "--name-only", "-z", "HEAD"]),
    ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"])
  ])].sort();
}

function packageManifests() {
  const paths = ["package.json"];
  for (const container of ["packages", "apps"]) {
    const containerPath = path.join(root, container);
    if (!existsSync(containerPath)) continue;
    for (const entry of readdirSync(containerPath, { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(path.join(container, entry.name, "package.json"));
    }
  }
  return paths
    .filter((relativePath) => existsSync(path.join(root, relativePath)))
    .map((relativePath) => {
      const manifest = JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
      const directory = path.dirname(relativePath);
      return {
        name: manifest.name,
        directory,
        manifestPath: relativePath,
        scripts: manifest.scripts ?? {},
        testFiles: []
      };
    })
    .filter((item) => typeof item.name === "string");
}

function isTestFile(relativePath) {
  return /\.(?:test|spec)\.(?:mjs|cjs|js|ts|tsx|jsx)$/.test(relativePath);
}

function packageForFile(relativePath, manifests) {
  return manifests
    .filter((item) => item.directory === "." || relativePath === item.directory || relativePath.startsWith(`${item.directory}${path.sep}`))
    .sort((left, right) => right.directory.length - left.directory.length)[0];
}

function changedPackages(files, manifests) {
  return manifests.filter((manifest) => files.some((file) => file === manifest.manifestPath || (manifest.directory !== "." && file.startsWith(`${manifest.directory}${path.sep}`))));
}

function relatedFocusedTests(files, manifests) {
  const tests = files.filter(isTestFile);
  const candidates = new Set(tests);
  const allTestFiles = manifests.flatMap((manifest) => {
    const sourceRoot = path.join(root, manifest.directory);
    if (!existsSync(sourceRoot)) return [];
    const found = [];
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else {
          const relative = path.relative(root, absolute);
          if (isTestFile(relative)) found.push(relative);
        }
      }
    };
    visit(sourceRoot);
    return found;
  });

  for (const file of files.filter((item) => !isTestFile(item))) {
    const manifest = packageForFile(file, manifests);
    if (!manifest) continue;
    const base = path.basename(file).replace(/\.[^.]+$/, "").toLowerCase();
    const tokens = new Set(base.split(/[-_.]/).filter((token) => token.length > 2));
    const packageTests = allTestFiles.filter((test) => packageForFile(test, manifests)?.name === manifest.name);
    const scored = packageTests.map((test) => {
      const testBase = path.basename(test).toLowerCase();
      const score = [...tokens].filter((token) => testBase.includes(token)).length
        + (path.dirname(test) === path.dirname(file) ? 3 : 0)
        + (testBase.includes("runtime") && base.includes("runtime") ? 1 : 0);
      return { test, score };
    }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.test.localeCompare(right.test));
    for (const item of scored.slice(0, 4)) candidates.add(item.test);
  }
  return [...candidates].sort();
}

function writeReport(report) {
  const reportPath = path.join(resultDirectory, "result.json");
  writeFileSync(reportPath, `${JSON.stringify({ ...report, result_file: reportPath }, null, 2)}\n`);
  return reportPath;
}

let files = [];
let manifests = [];
try {
  files = changedFiles();
  manifests = packageManifests();
  const packages = changedPackages(files, manifests);
  const focusedTests = relatedFocusedTests(files, manifests);

  runCheck("architecture-static", "static", process.execPath, ["scripts/verify/architecture-invariants.mjs", "--strict"]);

  for (const manifest of packages) {
    if (!manifest.scripts.typecheck) {
      recordUnverified(`typecheck-${manifest.name}`, "typecheck", "package_has_no_typecheck_script", { package: manifest.name });
      continue;
    }
    const command = manifest.directory === "." ? ["pnpm", ["run", "typecheck"]] : ["pnpm", ["--filter", manifest.name, "run", "typecheck"]];
    runCheck(`typecheck-${manifest.name}`, "typecheck", command[0], command[1], { timeoutMs: 15 * 60 * 1000 });
  }

  if (focusedTests.length > 0) {
    // Keep unrelated test files in separate worker processes. A single worker
    // can retain a server/socket handle from one package and make the next
    // package appear to hang even though the same tests pass in isolation and
    // in the full suite.
    runCheck("focused-tests", "test", "pnpm", ["exec", "vitest", "run", ...focusedTests, "--pool=forks", "--maxWorkers=4"], { timeoutMs: 15 * 60 * 1000 });
  } else {
    recordUnverified("focused-tests", "test", "no_changed_or_related_test_found");
  }

  runCheck("web-build", "build", "pnpm", ["--filter", "@samurai-agent/web", "run", "build"], { timeoutMs: 15 * 60 * 1000 });
  recordUnverified("docker", "environment", "local_light_does_not_start_or_use_docker");
  recordUnverified("network", "environment", "local_light_does_not_run_network_probes_or_install_dependencies");
  recordUnverified("browser", "environment", "local_light_does_not_run_browser_e2e");
  recordUnverified("electron-packaging", "environment", "local_light_does_not_build_or_package_electron");
} catch (error) {
  checks.push({ id: "local-light-runner", kind: "runner", status: "failed", reason: sanitize(error instanceof Error ? error.message : error) });
}

const failed = checks.some((check) => check.status === "failed");
const status = failed ? "failed" : unverified.length > 0 ? "passed_with_unverified" : "passed";
const report = {
  schema_version: 1,
  verifier: "local-light",
  status,
  // Local-light deliberately skips Docker, network, browser, and Electron
  // packaging.  An incomplete environment is therefore not a successful
  // verification; callers must distinguish it from an actual pass.
  exit_code: failed ? 1 : unverified.length > 0 ? 2 : 0,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  repository_root: root,
  changed_files: files,
  constraints: { docker: "not_run", network: "not_run", browser: "not_run", electron_packaging: "not_run" },
  checks,
  unverified,
  result_directory: resultDirectory
};
const reportPath = writeReport(report);
process.stdout.write(`${JSON.stringify({ verifier: report.verifier, status: report.status, exit_code: report.exit_code, result_directory: resultDirectory, result_file: reportPath })}\n`);
process.exitCode = report.exit_code;
