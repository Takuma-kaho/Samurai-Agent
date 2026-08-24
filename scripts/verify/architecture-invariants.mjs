import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const strict = process.argv.includes("--strict");

const trackedFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((file) => existsSync(path.join(root, file)));

const sourceFiles = trackedFiles.filter((file) => /\.(?:mjs|cjs|cts|ts|tsx|vue|py)$/.test(file));
const packageFiles = trackedFiles.filter((file) => file.endsWith("package.json"));
const sources = new Map();
for (const file of sourceFiles) {
  try {
    sources.set(file, readFileSync(path.join(root, file), "utf8"));
  } catch {
    sources.set(file, "");
  }
}

const directDatabaseReference = /(?:^\s*(?:import|export)[^\n]*\bPostgresWorkspaceDatabase\b|\bnew\s+Client\s*\()/m;

const routeFiles = [];
const socketFiles = [];
const realtimeFiles = [];
const cliFiles = [];
const workerFiles = [];
const entrypoints = [];
const apiMethods = [];
const ipcMethods = [];
const databaseDependencies = [];
const findings = [];

for (const [file, source] of sources) {
  if (file.startsWith("apps/server/")) {
    if (/\/(?:routes|streams)\//.test(file) || /\bapp\.(?:get|post|put|patch|delete|use)\s*\(/.test(source)) {
      routeFiles.push(file);
    }
    if (/socket\.io|SocketServer|io\.on\s*\(|socket\.on\s*\(/i.test(source)) socketFiles.push(file);
    if (/realtime|socket|subscribe|emitAuthorized/i.test(file) || /realtime|socket/i.test(source)) realtimeFiles.push(file);
    if (/(?:^|\/)(?:[^/]*cli|[^/]*entry)\.(?:mjs|ts)$/.test(file)) cliFiles.push(file);
    if (/workers?\//.test(file) || /Scheduler|Worker|Supervisor|claimWorkItem|claimJob/i.test(source)) workerFiles.push(file);
    if (/(?:^|\/)(?:index|main|server)\.(?:mjs|ts)$/.test(file) || /start(?:Server|WorkspaceServer)\s*\(/.test(source)) entrypoints.push(file);
    for (const match of source.matchAll(/app\.(get|post|put|patch|delete|use)\s*\(\s*["'`]([^"'`]+)/g)) {
      apiMethods.push({ file, method: match[1].toUpperCase(), path: match[2] });
    }
  }
  if (file.startsWith("apps/desktop/") && /ipcMain\.(?:handle|on)\s*\(/.test(source)) {
    for (const match of source.matchAll(/ipcMain\.(handle|on)\s*\(\s*["'`]([^"'`]+)/g)) {
      ipcMethods.push({ file, method: match[1], channel: match[2] });
    }
  }
  if (/(?:from\s+["']pg["']|PostgresWorkspaceDatabase)/.test(source)) {
    databaseDependencies.push(file);
  }
}

for (const [file, source] of sources) {
  if (/\.test\.(?:mjs|ts|tsx)$/.test(file)) continue;
  if (file.startsWith("packages/runtime/") && directDatabaseReference.test(source)) {
    findings.push({ rule: "runtime-storage-dependency", file });
  }
  if (file.startsWith("packages/gateway/") && directDatabaseReference.test(source)) {
    findings.push({ rule: "gateway-storage-dependency", file });
  }
  if (file.startsWith("packages/external-integration/") && directDatabaseReference.test(source)) {
    findings.push({ rule: "external-integration-storage-dependency", file });
  }
  if (/^apps\/(?:web|desktop)\//.test(file) && directDatabaseReference.test(source)) {
    findings.push({ rule: "client-storage-dependency", file });
  }
  const gatewayWorkspaceBoundary = /sandboxWorkspaceSyncPathError|sandboxCoreWorkspaceRootError|sandboxWorkspaceSyncRoots/.test(source);
  if (/^packages\/gateway\//.test(file)
    && /(?:rsync|cp\s|copyFile|rename|rmSync|rm\(|unlink|workspace_sync_delete)/.test(source)
    && !gatewayWorkspaceBoundary) {
    findings.push({ rule: "gateway-filesystem-write", file });
  }
}

const packageScripts = {};
for (const file of packageFiles) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
    packageScripts[file] = manifest.scripts ?? {};
  } catch {
    findings.push({ rule: "invalid-package-manifest", file });
  }
}

const result = {
  schema_version: 1,
  checked_at: new Date().toISOString(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString("utf8").trim(),
  tracked_file_count: trackedFiles.length,
  source_file_count: sourceFiles.length,
  entrypoints: [...new Set(entrypoints)].sort(),
  route_files: [...new Set(routeFiles)].sort(),
  api_methods: apiMethods,
  socket_files: [...new Set(socketFiles)].sort(),
  realtime_files: [...new Set(realtimeFiles)].sort(),
  cli_files: [...new Set(cliFiles)].sort(),
  worker_files: [...new Set(workerFiles)].sort(),
  ipc_methods: ipcMethods,
  database_dependencies: [...new Set(databaseDependencies)].sort(),
  package_scripts: packageScripts,
  findings
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (strict && findings.length > 0) process.exitCode = 1;
