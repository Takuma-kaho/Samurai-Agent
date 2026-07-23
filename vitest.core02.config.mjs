import { defineConfig } from "vitest/config";

const runtimeTests = [
  "packages/runtime/src/execution/run-state-machine.test.ts",
  "packages/runtime/src/execution/run-lifecycle.test.ts",
  "packages/runtime/src/execution/backend-event-journal.test.ts",
  "packages/runtime/src/execution/turn-executor.test.ts",
  "packages/runtime/src/execution/run-control.test.ts",
  "packages/runtime/src/execution/run-recovery.test.ts",
  "packages/runtime/src/execution/session-run-queue.test.ts",
  "packages/runtime/src/host/agent-host.test.ts",
  "packages/runtime/src/host/turn-completion-coordinator.test.ts",
  "packages/runtime/src/host/turn-preparer.test.ts",
  "packages/runtime/src/host/turn-preparation-policy.test.ts",
  "apps/server/src/composition/runtime.test.ts"
];
const workspaceTests = [
  "packages/workspace-store/src/core02-*.test.ts"
];

export default defineConfig({
  test: {
    environment: "node",
    include: [...runtimeTests, ...workspaceTests],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    isolate: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    maxWorkers: 1,
    minWorkers: 1,
    reporters: ["verbose"]
  }
});
