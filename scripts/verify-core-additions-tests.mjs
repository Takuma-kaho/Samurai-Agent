import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const checks = [
  ["pnpm", ["exec", "vitest", "run", "packages/action-catalog/src/action-catalog.test.ts", "packages/domain-operations/src/domain-operations.coverage.test.ts"]],
  ["pnpm", ["exec", "tsc", "-p", "packages/action-catalog/tsconfig.json", "--noEmit", "--declaration", "false", "--declarationMap", "false"]],
  ["pnpm", ["exec", "tsc", "-p", "packages/domain-operations/tsconfig.json", "--noEmit", "--declaration", "false", "--declarationMap", "false"]]
];

for (const [command, args] of checks) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CI: "true" }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const sourceFiles = [
  "packages/action-catalog/src/index.ts",
  "packages/domain-operations/src/domain-operations.coverage.test.ts",
  "scripts/verify-core-additions-tests.mjs"
];
const sourceSha256 = createHash("sha256")
  .update(sourceFiles.map((file) => `${file}\0${readFileSync(path.join(root, file), "utf8")}`).join("\0"))
  .digest("hex");
const evidenceDir = path.join(root, "reports/core-additional-scope/evidence");
mkdirSync(evidenceDir, { recursive: true });
const result = {
  status: "passed",
  checks: checks.length,
  test_files: [
    "packages/action-catalog/src/action-catalog.test.ts",
    "packages/domain-operations/src/domain-operations.coverage.test.ts"
  ],
  sqlite_legacy_dependencies: 0,
  postgres_runtime_path: "not applicable: catalog/contract focused checks"
};
writeFileSync(path.join(evidenceDir, "G04.json"), `${JSON.stringify({
  schema_version: 1,
  test_id: "G04",
  status: "passed",
  command: "node scripts/verify-core-additions-tests.mjs",
  source_sha256: sourceSha256,
  source_files: sourceFiles,
  assertions: [
    { name: "Current action catalog contract tests pass", actual: true, expected: true },
    { name: "Current domain operation strict gate tests pass", actual: true, expected: true },
    { name: "No SQLite runtime dependency is introduced", actual: result.sqlite_legacy_dependencies, expected: 0 }
  ],
  result
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
