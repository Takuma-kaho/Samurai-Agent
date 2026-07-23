import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const tracked = gitLines(["ls-files"]);
const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
const trackedCore02 = tracked.filter(isCore02Target);
const untrackedCore02 = untracked.filter(isCore02Target);
const allCore02 = [...new Set([...trackedCore02, ...untrackedCore02, "reports/core-02/source-inventory.json"])].sort();
const commitSha = gitLines(["rev-parse", "HEAD"])[0] ?? "unavailable";
const inventory = {
  schema_version: 1,
  scope: "Core-02 Phase 0-2 plus C02-FINAL-01 only",
  source_plan: "plans/core-02-host-runtime-oss-quality-completion-plan.md",
  recorded_at: new Date().toISOString(),
  commit_sha: commitSha,
  tracked_core02_files: trackedCore02.sort(),
  untracked_core02_files: untrackedCore02.sort(),
  all_core02_files: allCore02
};
const output = path.join(root, "reports/core-02/source-inventory.json");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, output: path.relative(root, output), tracked: trackedCore02.length, untracked: untrackedCore02.length, total: allCore02.length, commit_sha: commitSha }));

function isCore02Target(file) {
  return file.startsWith("packages/runtime/src/execution/")
    || file.startsWith("packages/runtime/src/host/")
    || file === "packages/runtime/src/composition/create-agent-host.ts"
    || file === "packages/agent-backends/src/index.ts"
    || file === "packages/core-schemas/src/index.ts"
    || file === "packages/workspace-store/src/workspace-store.ts"
    || file === "scripts/build-core02-test-bundles.mjs"
    || file.startsWith("plans/core-02-")
    || file === "plans/core-progress-ledger.md"
    || file.startsWith("reports/core-02/")
    || file === "scripts/check-core-host-runtime.mjs"
    || file === "scripts/record-core-02-source-inventory.mjs"
    || file === "scripts/run-core02-focused-tests.mjs"
    || file === "scripts/verify-core-host-runtime.mjs"
    || file === "vitest.core02.config.mjs";
}

function gitLines(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 }).split(/\r?\n/).filter(Boolean);
}
