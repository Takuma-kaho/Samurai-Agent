import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
import { evaluateVerifierAssertions, reportVerifierFailures, verifierEvidenceStatus } from "./lib/verifier-assertions.mjs";

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
const temporary = mkdtempSync(path.join(cache, "samurai-automation-race-"));
const output = path.join(temporary, "verify.mjs");
const sources = [
  "packages/workspace-store/src/index.ts",
  "scripts/fixtures/automation-worker-race.ts",
  "scripts/verify-automation-worker-race.mjs",
  "scripts/lib/core-evidence.mjs",
  "scripts/lib/verifier-assertions.mjs"
];

try {
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/automation-worker-race.ts"), "--bundle", "--platform=node", "--format=esm",
    "--external:better-sqlite3", `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const raw = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(raw);
  const completedAt = new Date().toISOString();
  const evidence = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidence, { recursive: true });
  const assertions = [
      { name: "10 workers racing 100 claims produce one winner and side effect", actual: { claims: result.successful_claims, side_effects: result.side_effects }, expected: { claims: 1, side_effects: 1 } },
      { name: "Lock owner token rejects another worker and blocks early reclaim", actual: result.token_bound && result.early_reclaim_rejected, expected: true },
      { name: "Expired lease is reclaimed after Store restart", actual: result.restart_reclaim, expected: true },
      { name: "Retry cannot claim before due and claims at due time", actual: result.retry_before_due_rejected && result.retry_at_due_claimed, expected: true }
  ];
  const failures = evaluateVerifierAssertions(assertions, result);
  writeFileSync(path.join(evidence, "F02.json"), `${JSON.stringify({
    schema_version: 1,
    test_id: "F02",
    command: "pnpm core:test:automation-race",
    status: verifierEvidenceStatus(result, failures),
    ...committedSourceEvidence(root, sources),
    started_at: startedAt,
    completed_at: completedAt,
    assertions, ...(failures.length ? { failures } : {}),
    result
  }, null, 2)}\n`);
  reportVerifierFailures("F02", failures); process.stdout.write(`${raw}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
