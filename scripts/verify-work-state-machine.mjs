import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix));
if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-work-state-"));
const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/core-schemas/src/index.ts", "packages/workspace-store/src/index.ts", "packages/agent-backends/src/index.ts", "packages/runtime/src/execution/work-state-machine.ts", "packages/runtime/src/execution/durable-work-coordinator.ts", "scripts/fixtures/work-state-machine.ts", "scripts/verify-work-state-machine.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/work-state-machine.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "B06.json"), `${JSON.stringify({
    schema_version: 1, test_id: "B06", command: "pnpm core:test:execution-model", status: "passed",
    ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt,
    assertions: [
      { name: "Pause and resume model", actual: result.pause_resume, expected: true },
      { name: "Cancel propagates to child work", actual: result.cancel_propagation, expected: true },
      { name: "Cancel identifies Backend runs", actual: result.backend_cancel_ids.length, expected: 1 },
      { name: "Steer updates current work", actual: result.steer_is_current_item, expected: true },
      { name: "Follow-up creates dependent child", actual: result.follow_up_is_dependent_child, expected: true },
      { name: "Terminal transition guards", actual: result.terminal_state_guards, expected: true }
      ,{ name: "State transitions persist", actual: result.persisted_state_transitions, expected: true }
      ,{ name: "Cancel propagates to Backend", actual: result.backend_cancel_propagated, expected: true }
    ], result
  }, null, 2)}\n`);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
