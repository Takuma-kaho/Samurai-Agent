import { spawnSync } from "node:child_process";

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

const result = {
  status: "passed",
  checks: checks.length,
  test_files: [
    "packages/action-catalog/src/action-catalog.test.ts",
    "packages/domain-operations/src/domain-operations.coverage.test.ts"
  ],
  description: "Current action catalog and domain operation contract focused checks"
};
process.stdout.write(`${JSON.stringify(result)}\n`);
