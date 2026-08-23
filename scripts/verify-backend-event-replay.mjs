import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
import { evaluateVerifierAssertions, reportVerifierFailures, verifierEvidenceStatus } from "./lib/verifier-assertions.mjs";

const root = process.cwd();
const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix));
if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-event-replay-"));
const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/core-schemas/src/index.ts", "packages/workspace-store/src/index.ts", "apps/server/src/index.ts", "apps/server/src/routes/backend-events.ts", "scripts/fixtures/backend-event-replay.ts", "scripts/verify-backend-event-replay.mjs", "scripts/lib/core-evidence.mjs", "scripts/lib/verifier-assertions.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/backend-event-replay.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", "--external:express", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(rawResult);
  const completedAt = new Date().toISOString();
  const evidenceDir = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const assertions = [
      { name: "Events survive restart", actual: result.persisted_events, expected: 100 },
      { name: "Replay after_sequence has no missing events", actual: result.missing, expected: 0 },
      { name: "Replay after_sequence has no duplicates", actual: result.duplicates, expected: 0 },
      { name: "Final cursor", actual: result.final_cursor, expected: 100 },
      { name: "API Server restarted during HTTP replay", actual: result.api_server_restarted, expected: true }
    ];
  const failures = evaluateVerifierAssertions(assertions, result);
  writeFileSync(path.join(evidenceDir, "B07.json"), `${JSON.stringify({
    schema_version: 1, test_id: "B07", command: "pnpm core:test:event-replay", status: verifierEvidenceStatus(result, failures),
    ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt,
    assertions, ...(failures.length ? { failures } : {}), result
  }, null, 2)}\n`);
  reportVerifierFailures("B07", failures);
  process.stdout.write(`${rawResult}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
