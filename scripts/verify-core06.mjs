import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, command, args) {
  console.log(`[Core06] ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    const detail = result.signal ? `signal=${result.signal}` : `exit=${result.status ?? "unknown"}`;
    throw new Error(`${label}:${detail}`);
  }
}

const focusedTests = [
  "packages/room-permissions/src/index.test.ts",
  "packages/runtime/src/core05-learning-foundation.test.ts",
  "packages/runtime/src/core06-room-authorization.test.ts",
  "packages/runtime/src/core06-workspace-execution.test.ts",
  "packages/runtime/src/host/agent-host.test.ts",
  "packages/workspace-store/src/core06-room-permissions.test.ts",
  "packages/workspace-store/src/core06-session-reference-migration.test.ts",
  "packages/workspace-store/src/workspace-store.test.ts",
  "packages/domain-operations/src/domain-operations.coverage.test.ts",
  "packages/domain-operations/src/registry/operation-registry-cancellation.test.ts",
  "packages/runtime/src/commands/domain-command-bus.test.ts",
  "apps/server/src/domain-ingress.test.ts"
];

const typecheckPackages = [
  "@samurai-agent/core-schemas",
  "@samurai-agent/room-permissions",
  "@samurai-agent/domain-operations",
  "@samurai-agent/action-catalog",
  "@samurai-agent/workspace-store",
  "@samurai-agent/agent-backends",
  "@samurai-agent/runtime",
  "@samurai-agent/server",
  "@samurai-agent/web"
];

const contractChecks = [
  ["domain command contract", "node", ["--import", "tsx", "scripts/fixtures/domain-command-contract.ts"]],
  ["domain operation structure", "node", ["--import", "tsx", "scripts/fixtures/domain-operation-structure.ts"]],
  ["domain query purity", "node", ["--import", "tsx", "scripts/fixtures/domain-query-purity.ts"]],
  ["domain command compatibility", "node", ["--import", "tsx", "scripts/fixtures/domain-command-compatibility.ts"]],
  ["domain command version", "node", ["--import", "tsx", "scripts/fixtures/domain-command-version.ts"]],
  ["domain command parity", "node", ["--import", "tsx", "scripts/fixtures/domain-command-parity.ts"]],
  ["domain command trusted context", "node", ["--import", "tsx", "scripts/fixtures/domain-command-trusted-context.ts"]],
  ["domain command schema matrix", "node", ["--import", "tsx", "scripts/fixtures/domain-command-schema-matrix.ts"]],
  ["domain operation handler matrix", "node", ["--import", "tsx", "scripts/fixtures/domain-operation-handler-matrix.ts"]],
  ["domain operation handler shard A", "node", ["--import", "tsx", "scripts/fixtures/domain-operation-handler-matrix-shard-a.ts"]],
  ["domain operation handler shard B", "node", ["--import", "tsx", "scripts/fixtures/domain-operation-handler-matrix-shard-b.ts"]],
  ["domain operation handler shard C", "node", ["--import", "tsx", "scripts/fixtures/domain-operation-handler-matrix-c.ts"]],
  ["domain operation handler aggregate", "node", ["--import", "tsx", "scripts/fixtures/domain-operation-handler-matrix-aggregate.ts"]],
  ["domain verifier self-test", "node", ["scripts/verify-domain-command-verifier-self-test.mjs"]]
];

try {
  run("generated operation bindings", "node", ["scripts/generate-domain-operation-index.mjs", "--check"]);
  run("architecture boundaries", "node", ["scripts/verify-architecture-boundaries.mjs"]);
  for (const [label, command, args] of contractChecks) {
    run(label, command, args);
  }
  run("focused tests", "pnpm", ["exec", "vitest", "run", ...focusedTests]);
  for (const packageName of typecheckPackages) {
    run(`typecheck ${packageName}`, "pnpm", ["--filter", packageName, "run", "typecheck"]);
  }
  run("diff check", "git", ["diff", "--check"]);
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  console.log(`[Core06] PASS commit=${sha}`);
} catch (error) {
  console.error(`[Core06] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
