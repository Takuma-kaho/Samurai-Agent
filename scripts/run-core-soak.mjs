import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const root = process.cwd();
const platformPrefix = process.platform === "darwin"
  ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
  : `@esbuild+${process.platform}-${process.arch}@`;
const packageDirectory = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(platformPrefix));
if (!packageDirectory) throw new Error("esbuild missing");
const packageName = packageDirectory.slice(0, packageDirectory.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDirectory, "node_modules", packageName, "bin/esbuild");
const cacheRoot = path.join(root, "node_modules/.cache");
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-soak-"));
const output = path.join(temporaryRoot, "verify.mjs");
const argumentsList = process.argv.slice(2);
const releaseCertification = argumentsList.includes("--wall-clock");
const evidenceName = releaseCertification ? "G04-release-certification.json" : "G04.json";
const command = releaseCertification ? `pnpm core:soak -- ${argumentsList.join(" ")}` : "pnpm core:soak";
const sources = [
  "packages/workspace-store/src/index.ts",
  "packages/runtime/src/index.ts",
  "scripts/fixtures/core-soak.ts",
  "scripts/run-core-soak.mjs",
  "scripts/lib/core-evidence.mjs"
];

try {
  execFileSync(esbuild, [
    path.join(root, "scripts/fixtures/core-soak.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    `--outfile=${output}`
  ], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString();
  const raw = execFileSync(process.execPath, [output, ...argumentsList], { cwd: root, encoding: "utf8" }).trim();
  const result = JSON.parse(raw);
  const completedAt = new Date().toISOString();
  const evidenceDirectory = path.join(root, "reports/core-completion/evidence");
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(path.join(evidenceDirectory, evidenceName), `${JSON.stringify({
    schema_version: 1,
    test_id: releaseCertification ? "G04-release-certification" : "G04",
    command,
    status: result.status,
    ...committedSourceEvidence(root, sources),
    started_at: startedAt,
    completed_at: completedAt,
    assertions: [
      { name: "stuck", actual: result.stuck, expected: 0 },
      { name: "orphan", actual: result.orphan, expected: 0 },
      { name: "duplicate", actual: result.duplicate, expected: 0 },
      { name: "data_loss", actual: result.data_loss, expected: 0 },
      { name: "scale", actual: { objectives: result.objectives, jobs: result.jobs }, expected: { objectives: 100, jobs: 1000 } }
    ],
    release_certification: {
      required_for_core: false,
      wall_clock_24_hours: result.mode === "wall_clock" && result.duration_hours >= 24
    },
    result
  }, null, 2)}\n`);
  process.stdout.write(`${raw}\n`);
  if (result.status !== "passed") process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
