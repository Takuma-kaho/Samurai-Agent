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

const temporary = mkdtempSync(path.join(cache, "samurai-curator-"));
const output = path.join(temporary, "verify.mjs");
const sources = [
  "packages/learning/src/curator/resource-graph.ts",
  "packages/workspace-store/src/index.ts",
  "packages/workspace-store/src/repositories/learning-repository.ts",
  "packages/core-schemas/src/index.ts",
  "scripts/fixtures/curator-resource-graph.ts",
  "scripts/verify-curator-resource-graph.mjs",
  "scripts/lib/core-evidence.mjs",
  "scripts/lib/verifier-assertions.mjs"
];

try {
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/curator-resource-graph.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });

  const started_at = new Date().toISOString();
  const raw = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(raw);
  const completed_at = new Date().toISOString();
  const evidence = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidence, { recursive: true });
  const assertions = [
        {
          name: "Duplicate, overlap, conflict, supersede and derivation edges persist",
          actual: result.relations,
          expected: ["conflicts", "derived_from", "duplicate", "overlaps", "supersedes"]
        },
        {
          name: "Pin, stale, archive and correction/usage lifecycle rules work",
          actual: result.pinned_protected && result.stale_detected && result.archive_detected && result.correction_review,
          expected: true
        },
        {
          name: "Memory, Wiki, Skill and Surface pattern participate",
          actual: result.resource_kinds,
          expected: ["memory", "wiki", "skill", "surface_pattern"]
        },
        {
          name: "Curator graph restores exactly from snapshot",
          actual: result.snapshot_rollback_exact,
          expected: true
        }
      ];
  const failures = evaluateVerifierAssertions(assertions, result);
  writeFileSync(
    path.join(evidence, "E09.json"),
    `${JSON.stringify({
      schema_version: 1,
      test_id: "E09",
      command: "pnpm core:test:curator-graph",
      status: verifierEvidenceStatus(result, failures),
      ...committedSourceEvidence(root, sources),
      started_at,
      completed_at,
      assertions, ...(failures.length ? { failures } : {}),
      result
    }, null, 2)}\n`
  );
  reportVerifierFailures("E09", failures); process.stdout.write(`${raw}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
