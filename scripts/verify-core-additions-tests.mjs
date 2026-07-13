import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const checks = [
  ["pnpm", ["exec", "tsc", "-p", "packages/core-schemas/tsconfig.json", "--noEmit", "--declaration", "false", "--declarationMap", "false"]],
  ["pnpm", ["exec", "tsc", "-p", "packages/agent-backends/tsconfig.json", "--noEmit", "--declaration", "false", "--declarationMap", "false"]],
  ["pnpm", ["exec", "tsc", "-p", "packages/action-catalog/tsconfig.json", "--noEmit", "--declaration", "false", "--declarationMap", "false"]],
  ["pnpm", ["exec", "tsc", "-p", "packages/capability-registry/tsconfig.json", "--noEmit", "--declaration", "false", "--declarationMap", "false"]],
  ["pnpm", ["exec", "tsc", "-p", "packages/ui-protocol/tsconfig.json", "--noEmit", "--declaration", "false", "--declarationMap", "false"]],
  ["pnpm", ["exec", "tsc", "-p", "packages/workspace-store/tsconfig.json", "--noEmit", "--declaration", "false", "--declarationMap", "false"]],
  ["pnpm", ["exec", "tsc", "-p", "packages/runtime/tsconfig.json", "--noEmit", "--declaration", "false", "--declarationMap", "false"]],
  ["node", ["scripts/verify-artifact-revisions.mjs"]],
  ["node", ["scripts/verify-core-additions-new-contracts.mjs"]],
  ["node", ["scripts/verify-core-additions-regression.mjs"]]
];

for (const [command, args] of checks) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit", env: { ...process.env, CI: "true" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const root = process.cwd();
const sourceFiles = [
  "packages/core-schemas/src/index.ts",
  "packages/agent-backends/src/index.ts",
  "packages/action-catalog/src/index.ts",
  "packages/capability-registry/src/index.ts",
  "packages/ui-protocol/src/index.ts",
  "packages/workspace-store/src/workspace-store.ts",
  "packages/runtime/src/agent-runtime.ts",
  "scripts/verify-core-additions-tests.mjs"
];
const head = readFileSync(path.join(root, ".git/HEAD"), "utf8").trim();
const commitSha = head.startsWith("ref: ") ? readFileSync(path.join(root, ".git", head.slice(5)), "utf8").trim() : head;
const sourceSha256 = createHash("sha256").update(sourceFiles.map((file) => `${file}\0${readFileSync(path.join(root, file))}`).join("\0")).digest("hex");
const evidenceDir = path.join(root, "reports/core-additional-scope/evidence");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(path.join(evidenceDir, "G04.json"), `${JSON.stringify({
  schema_version: 1,
  test_id: "G04",
  status: "passed",
  command: "node scripts/verify-core-additions-tests.mjs",
  commit_sha: commitSha,
  source_sha256: sourceSha256,
  source_files: sourceFiles,
  assertions: [
    { name: "Affected Core packages typecheck", actual: 7, expected: 7 },
    { name: "Targeted integration checks", actual: 3, expected: 3 }
  ],
  result: { checks: checks.length }
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: "passed", checks: checks.length })}\n`);
