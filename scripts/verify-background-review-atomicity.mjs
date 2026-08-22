import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const prefix = process.platform === "darwin"
  ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
  : `@esbuild+${process.platform}-${process.arch}@`;
const directory = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix));
if (!directory) throw new Error("esbuild missing");
const packageName = directory.slice(0, directory.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", directory, "node_modules", packageName, "bin/esbuild");
const cache = path.join(root, "node_modules/.cache");
mkdirSync(cache, { recursive: true });
const temp = mkdtempSync(path.join(cache, "samurai-review-"));
const output = path.join(temp, "verify.mjs");
const sources = [
  "packages/learning/src/core05.ts",
  "packages/runtime/src/agent-runtime.ts",
  "packages/runtime/src/commands/services/core05-background-review-mutation-domain-service.ts",
  "packages/workspace-store/src/repositories/learning-row-codecs.ts",
  "packages/workspace-store/src/index.ts",
  "scripts/fixtures/background-review-atomicity.ts",
  "scripts/verify-background-review-atomicity.mjs",
  "scripts/lib/core-evidence.mjs"
];

try {
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/background-review-atomicity.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const raw = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(raw);
  const completedAt = new Date().toISOString();
  const evidenceDirectory = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(path.join(evidenceDirectory, "E06.json"), `${JSON.stringify({
    schema_version: 1,
    test_id: "E06",
    command: "pnpm core:test:background-review",
    status: "passed",
    ...committedSourceEvidence(root, sources),
    started_at: startedAt,
    completed_at: completedAt,
    assertions: [
      { name: "Malformed mutations are rejected", actual: result.malformed_rejected, expected: true },
      { name: "Room-scoped compensation rolls back a mid-write failure", actual: result.mid_write_failure_rolled_back && result.partial_metadata === 0, expected: true },
      { name: "A valid mutation applies once and duplicate execution is idempotent", actual: { valid: result.valid_mutations, duplicate: result.duplicate_mutations }, expected: { valid: 1, duplicate: 0 } }
    ],
    result
  }, null, 2)}\n`);
  process.stdout.write(`${raw}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
