import path from "node:path";
import { defineConfig } from "vitest/config";

const bundleRoot = process.env.SAMURAI_CORE02_VITEST_ROOT;
const testGroup = process.env.SAMURAI_CORE02_VITEST_GROUP;
const cacheDir = path.join(process.cwd(), "node_modules/.vite/core02-vitest");
const sourceIncludes = [
  "packages/runtime/src/execution/run-state-machine.test.ts",
  "packages/runtime/src/execution/run-lifecycle.test.ts",
  "packages/runtime/src/execution/backend-event-journal.test.ts",
  "packages/runtime/src/execution/turn-executor.test.ts",
  "packages/runtime/src/execution/run-control.test.ts",
  "packages/runtime/src/execution/run-recovery.test.ts",
  "packages/runtime/src/execution/session-run-queue.test.ts",
  "packages/workspace-store/src/core02-*.test.ts"
];

export default defineConfig({
  cacheDir,
  ...(bundleRoot ? { root: bundleRoot } : {}),
  test: {
    environment: "node",
    include: bundleRoot
      ? testGroup === "workspace" ? ["core02-*.test.mjs"] : ["run-*.test.mjs", "backend-event-journal.test.mjs", "turn-executor.test.mjs", "session-run-queue.test.mjs"]
      : sourceIncludes,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    isolate: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    maxWorkers: 1,
    minWorkers: 1,
    reporters: ["verbose"]
  }
});
