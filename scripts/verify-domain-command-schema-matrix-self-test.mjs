import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = resolveEsbuild();
const cases = [
  ["SM01_INPUT_FIELD_REMOVED", mutateInputFieldRemoved, "schema_projection_drift:file.read:input"],
  ["SM02_INPUT_FIELD_OPTIONAL", mutateInputFieldOptional, "schema_projection_drift:file.read:input"],
  ["SM03_INPUT_BOUND_REMOVED", mutateInputBoundRemoved, "schema_projection_drift:file.read:input"],
  ["SM04_OUTPUT_UNKNOWN_KEY_RELAXED", mutateOutputRelaxed, "schema_projection_drift:file.read:output"],
  ["SM05_STATIC_MANIFEST_ENTRY_MISSING", mutateManifestEntryMissing, "schema_manifest_operation_count_mismatch"],
  ["SM06_INPUT_FIELD_UNUSED", mutateInputFieldUnused, "domain_operation_input_field_unused:file.read:unused_schema_matrix_probe"]
];

const baseline = runMatrix(sourceRoot);
assert.equal(baseline.status, 0, `schema_matrix_baseline_failed:${baseline.stdout}${baseline.stderr}`);

for (const [code, mutate, expectedError] of cases) {
  const sandbox = createSandbox();
  try {
    mutate(sandbox);
    const result = runMatrix(sandbox);
    assert.notEqual(result.status, 0, `${code}:mutation_unexpectedly_passed:${result.stdout}`);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(expectedError), `${code}:wrong_failure_reason`);
    process.stderr.write(`verified ${code}\n`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  gates: ["CT03", "CT04", "CT05", "CT08", "RH04", "RH05"],
  mode: "real_source_mutation",
  mutations: cases.length,
  expected_error_codes: cases.map(([code]) => code)
})}\n`);

function createSandbox() {
  const sandbox = mkdtempSync(path.join(tmpdir(), "samurai-schema-matrix-mutation-"));
  for (const relative of [
    "packages/domain-operations/src",
    "scripts/fixtures/domain-command-schema-matrix.ts",
    "scripts/fixtures/domain-command-schema-expectations.json"
  ]) cpSync(path.join(sourceRoot, relative), path.join(sandbox, relative), { recursive: true });
  symlinkSync(path.join(sourceRoot, "node_modules"), path.join(sandbox, "node_modules"), "dir");
  return sandbox;
}

function runMatrix(sandbox) {
  const fixture = path.join(sandbox, "scripts/fixtures/domain-command-schema-matrix.ts");
  const bundle = path.join(sandbox, "domain-command-schema-matrix.mjs");
  const bundled = spawnSync(esbuild, [
    fixture, "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3",
    `--alias:@samurai-agent/core-schemas=${path.join(sourceRoot, "packages/core-schemas/src/index.ts")}`,
    `--alias:@samurai-agent/gateway=${path.join(sourceRoot, "packages/gateway/src/index.ts")}`,
    `--alias:@samurai-agent/room-permissions=${path.join(sourceRoot, "packages/room-permissions/src/index.ts")}`,
    `--alias:@samurai-agent/skills=${path.join(sourceRoot, "packages/skills/src/index.ts")}`,
    `--outfile=${bundle}`
  ], {
    cwd: sandbox,
    encoding: "utf8"
  });
  assert.equal(bundled.status, 0, `schema_matrix_mutation_bundle_failed:${bundled.stdout}${bundled.stderr}`);
  return spawnSync(process.execPath, [bundle], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...process.env, SAMURAI_REPO_ROOT: sandbox }
  });
}

function mutateInputFieldRemoved(sandbox) {
  edit(sandbox, "packages/domain-operations/src/operations/file/read.operation.ts", (source) => source.replace('  "path": z.string().trim().min(1).max(4096)\n', ""));
}

function mutateInputFieldOptional(sandbox) {
  edit(sandbox, "packages/domain-operations/src/operations/file/read.operation.ts", (source) => source.replace('"path": z.string().trim().min(1).max(4096)', '"path": z.string().trim().min(1).max(4096).optional()'));
}

function mutateInputBoundRemoved(sandbox) {
  edit(sandbox, "packages/domain-operations/src/operations/file/read.operation.ts", (source) => source.replace('"path": z.string().trim().min(1).max(4096)', '"path": z.string().trim().min(1)'));
}

function mutateOutputRelaxed(sandbox) {
  edit(sandbox, "packages/domain-operations/src/operations/file/read.operation.ts", (source) => source.replace('const Output = fileReadValueSchema;', 'const Output = fileReadValueSchema.passthrough();'));
}

function mutateManifestEntryMissing(sandbox) {
  const file = path.join(sandbox, "scripts/fixtures/domain-command-schema-expectations.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.operations = manifest.operations.filter((operation) => operation.id !== "file.read");
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function mutateInputFieldUnused(sandbox) {
  edit(sandbox, "packages/domain-operations/src/operations/file/read.operation.ts", (source) => source.replace('  "path": z.string().trim().min(1).max(4096)\n', '  "path": z.string().trim().min(1).max(4096),\n  "unused_schema_matrix_probe": z.string().optional()\n'));
}

function edit(sandbox, relative, transform) {
  const file = path.join(sandbox, relative);
  const original = readFileSync(file, "utf8");
  const mutated = transform(original);
  assert.notEqual(mutated, original, `schema_matrix_mutation_did_not_change:${relative}`);
  writeFileSync(file, mutated);
}

function resolveEsbuild() {
  const platformPrefix = process.platform === "darwin"
    ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
    : `@esbuild+${process.platform}-${process.arch}@`;
  const pnpmRoot = path.join(sourceRoot, "node_modules/.pnpm");
  const packageDir = readdirSync(pnpmRoot).find((entry) => entry.startsWith(platformPrefix));
  if (!packageDir) throw new Error(`schema_matrix_esbuild_missing:${platformPrefix}`);
  const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
  return path.join(pnpmRoot, packageDir, "node_modules", packageName, "bin", "esbuild");
}
