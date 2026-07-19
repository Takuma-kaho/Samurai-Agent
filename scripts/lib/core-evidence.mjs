import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const sourceReadTimeoutMs = 10_000;
const sourceReadScript = "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))";

export function committedSourceEvidence(root, sourceFiles) {
  const facadeImplementations = new Map([
    ["packages/runtime/src/index.ts", ["packages/runtime/src/agent-runtime.ts"]],
    ["packages/workspace-store/src/index.ts", ["packages/workspace-store/src/workspace-store.ts", "packages/workspace-store/src/backup/backup-id.ts", "packages/workspace-store/src/migrations/gateway-delivery.ts", "packages/workspace-store/src/repositories/backend-events.ts", "packages/workspace-store/src/search/scoring.ts", "packages/workspace-store/src/transactions/recovery-policy.ts"]],
    ["packages/runtime/src/provider.ts", ["packages/runtime/src/backend/provider.ts"]],
    ["packages/runtime/src/native-backend.ts", ["packages/runtime/src/backend/native-backend.ts"]],
    ["packages/runtime/src/external-assist-provider.ts", ["packages/runtime/src/backend/external-assist-provider.ts"]],
    ["packages/runtime/src/backend-event-bridge.ts", ["packages/runtime/src/backend/event-bridge.ts"]],
    ["packages/runtime/src/backend-feedback.ts", ["packages/runtime/src/backend/feedback.ts"]],
    ["apps/server/src/index.ts", ["apps/server/src/api-server.ts", "apps/server/src/middleware/security.ts", "apps/server/src/routes/backend-events.ts", "apps/server/src/streams/backend-events.ts", "apps/server/src/workers/automation-scheduler.ts"]]
  ]);
  const files = [...new Set(sourceFiles.flatMap((file) => [file, ...(facadeImplementations.get(file) ?? [])]))].sort();
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const sourceContents = new Map(files.map((file) => [file, readSourceFile(root, file)]));
  const sourceReadErrors = files.filter((file) => !sourceContents.get(file));
  const sourceHash = createHash("sha256");
  for (const file of files) {
    const content = sourceContents.get(file);
    sourceHash.update(file).update("\0").update(content ?? Buffer.from("source_read_failed")).update("\0");
  }
  const sourceSha256 = sourceHash.digest("hex");
  const sourceGraph = files.map((file) => ({
    file,
    imports: extractImportSpecifiers(sourceContents.get(file)).sort()
  }));
  const sourceGraphSha256 = createHash("sha256").update(JSON.stringify(sourceGraph)).digest("hex");
  const contractVersions = readContractVersions(sourceContents.get("plans/domain-command-contract-ledger.json"));
  const contractVersionsSha256 = createHash("sha256").update(JSON.stringify(contractVersions)).digest("hex");
  const headBlobs = new Map(execFileSync("git", ["ls-tree", "-r", "HEAD"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean).map((line) => { const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/); return match ? [match[2], match[1]] : ["", ""]; }));
  const worktreeClean = files.every((file) => {
    try {
      const content = sourceContents.get(file);
      if (!content) return false;
      const blob = createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
      return headBlobs.get(file) === blob;
    } catch { return false; }
  });
  return {
    commit_sha: commitSha,
    worktree_clean: worktreeClean,
    source_sha256: sourceSha256,
    source_graph_sha256: sourceGraphSha256,
    contract_versions_sha256: contractVersionsSha256,
    source_files: files,
    source_read_errors: sourceReadErrors
  };
}

function extractImportSpecifiers(content) {
  if (!content) return [];
  const source = content.toString("utf8");
  const staticImports = [...source.matchAll(/\b(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
  const dynamicImports = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
  return [...staticImports, ...dynamicImports];
}

function readContractVersions(content) {
  if (!content) return [];
  try {
    const ledger = JSON.parse(content.toString("utf8"));
    return ["commands", "queries", "legacy_commands"].flatMap((key) => (Array.isArray(ledger[key]) ? ledger[key] : []))
      .map((entry) => ({ id: entry.id, contract_version: entry.contract_version }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  } catch {
    return [{ invalid: true }];
  }
}

function readSourceFile(root, file) {
  try {
    return execFileSync(process.execPath, ["-e", sourceReadScript, path.join(root, file)], {
      cwd: root,
      encoding: null,
      timeout: sourceReadTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return undefined;
  }
}
