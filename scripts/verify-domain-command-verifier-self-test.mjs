import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { domainVerifierViolationCodes } from "./lib/domain-verifier-policy.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suppliedSandbox = process.env.SAMURAI_MUTATION_ROOT;
const sandbox = suppliedSandbox ? path.resolve(suppliedSandbox) : createMutationSandbox();
const cases = [
  ["V001_ACTIVE_ID_MISSING", mutateActiveIdMissing, () => expectFailure(runNode("scripts/generate-domain-operation-index.mjs", ["--check"]), "generated_domain_operation_drift")],
  ["V002_HANDLER_REUSED", mutateHandlerReuse, () => expectStructureGate("ST04")],
  ["V003_GENERIC_FORWARDER", mutateGenericForwarder, () => expectStructureGate("ST07")],
  ["V004_OPERATION_REDISPATCH", mutateOperationRedispatch, () => expectStructureGate("ST06")],
  ["V005_QUERY_WRITE_PORT", mutateQueryWritePort, () => expectStructureGate("ST09")],
  ["V006_FORBIDDEN_STORE_IMPORT", mutateForbiddenStoreImport, () => expectStructureGate("ST08")],
  ["V007_NON_STRICT_INPUT", mutateNonStrictInput, () => expectStructureGate("CT03")],
  ["V008_OUTPUT_VALIDATION_MISSING", mutateOutputValidation, () => expectStructureGate("RH05")],
  ["V009_EFFECT_INFERRED_FROM_ID", mutateExplicitEffect, () => expectStructureGate("CT11")],
  ["V010_ZOD_PRIVATE_API", mutateZodPrivateApi, () => expectStructureGate("ST11")],
  ["V011_DIRECT_STORE_MUTATION", mutateDirectStoreMutation, expectArchitectureFailure],
  ["V012_CATALOG_SCHEMA_DRIFT", mutateCatalogSchema, () => expectStructureGate("CT07")],
  ["V013_GENERATED_INDEX_DRIFT", mutateGeneratedIndex, () => expectFailure(runNode("scripts/generate-domain-operation-index.mjs", ["--check"]), "generated_domain_operation_drift")],
  ["V014_EVIDENCE_ACTUAL_MISMATCH", mutateEvidence, expectEvidenceFailure],
  ["V015_FALSE_PASSED_STATUS", mutateFalsePassedModel, expectFalsePassedRejected],
  ["V016_DIRECT_PORT_FORWARDER", mutateDirectPortForwarder, () => expectStructureGate("ST07")],
  ["V017_ARTIFACT_SOURCE_BRANCH", mutateArtifactSourceBranch, () => expectStructureGate("IN01")],
  ["V018_ARTIFACT_LEGACY_SURFACE_CALL", mutateArtifactLegacySurfaceCall, () => expectStructureGate("IN03")],
  ["V019_COLLECTION_ACTION_ENVELOPE_FIELD", mutateCollectionActionEnvelopeField, () => expectStructureGate("CT05")],
  ["V020_FILE_READ_PATH_OPTIONAL", mutateFileReadPathOptional, () => expectStructureGate("CT05")],
  ["V021_PORT_DTO_TO_RAW_RECORD", mutateCollectionActionPortDtoToRawRecord, () => expectStructureGate("CT05")],
  ["V022_FILE_READ_PATH_BOUND", mutateFileReadPathBound, () => expectStructureGate("CT05")],
  ["V023_COLLECTION_ACTION_REQUIRED_FIELD", mutateCollectionActionRequiredField, () => expectStructureGate("CT05")],
  ["V024_SERVICE_DTO_TO_RAW_RECORD", mutateCollectionActionServiceDtoToRawRecord, () => expectStructureGate("DT01")],
  ["V025_GENERATED_SURFACE_SESSION_NOT_CONTEXT_OWNED", mutateGeneratedSurfaceSessionOwnership, () => expectTrustedContextFailure("domain_operation_internal:generated_surface.create|provider payload must not move the surface into a forged session")],
  ["V026_GENERATED_SURFACE_RUN_NOT_CONTEXT_OWNED", mutateGeneratedSurfaceRunOwnership, () => expectTrustedContextFailure("Expected values to be strictly equal")],
  ["V027_GENERATED_SURFACE_TIME_NOT_SERVER_OWNED", mutateGeneratedSurfaceServerTime, () => expectTrustedContextFailure("created definition time adopted provider time")],
  ["V028_GENERATED_SURFACE_PROVIDER_ID_NOT_REJECTED", mutateGeneratedSurfaceProviderIdRejection, () => expectTrustedContextFailure("request.id must be rejected before the Generated Surface handler")],
  ["V029_GENERATED_SURFACE_PROVIDER_SURFACE_ID_NOT_REJECTED", mutateGeneratedSurfaceProviderSurfaceIdRejection, () => expectTrustedContextFailure("surface_id must be rejected before the Generated Surface handler")],
  ["V030_PROVIDER_SERVER_OWNED_FIELD_NOT_TYPED", mutateProviderServerOwnedFieldRejection, () => expectTrustedContextFailure("ordinary-command-server-owned-workspace_id must retain its typed Provider failure code")],
  ["V031_PROVIDER_UNKNOWN_FIELD_SILENTLY_DROPPED", mutateProviderUnknownFieldPreservation, () => expectTrustedContextFailure("ordinary-command-unknown-field must never be reported as a successful Provider tool")],
  ["V032_PROVIDER_FAILURE_FALLS_THROUGH", mutateProviderFailureTerminalOutcome, () => expectTrustedContextFailure("ordinary-command-server-owned-workspace_id must emit one stable Provider tool rejection")],
  ["V033_GENERATED_SURFACE_TARGET_REDISPATCH", mutateGeneratedSurfaceTargetRedispatch, () => expectStructureGate("ST06")],
  ["V034_GENERATED_SURFACE_GENERIC_TARGET_DISPATCH", mutateGeneratedSurfaceTargetRedispatch, () => expectStructureGate("ST07")],
  ["V035_PROVIDER_OPERATION_COMPOSITION_ALIAS", mutateProviderOperationCompositionAlias, () => expectStructureGate("ST14")],
  ["V036_POSTHOC_QUERY_BRAND", mutatePostHocQueryBrand, () => expectStructureGate("QP01")]
];

try {
  assert.equal(cases.every(([code]) => domainVerifierViolationCodes.includes(code)), true, "verifier mutation code is not registered in the verifier policy");
  // Fault injection is meaningful only against a passing, unmodified
  // implementation. Each distinct verifier is preflighted against this same
  // sandbox before any mutation is applied; otherwise an unrelated existing
  // failure could be mistaken for successful fault detection.
  assertVerifierBaselines();
  for (const [code, mutate, verify] of cases) {
    const restorations = [];
    const edit = (relative, transform) => {
      const file = path.join(sandbox, relative);
      const original = readFileSync(file, "utf8");
      restorations.push(() => writeFileSync(file, original));
      const mutated = transform(original);
      assert.notEqual(mutated, original, `${code} did not mutate ${relative}`);
      writeFileSync(file, mutated);
    };
    const remove = (relative) => {
      const file = path.join(sandbox, relative);
      const original = readFileSync(file);
      restorations.push(() => writeFileSync(file, original));
      unlinkSync(file);
    };
    try {
      mutate(edit, remove);
      verify();
      process.stderr.write(`verified ${code}\n`);
    } catch (error) {
      throw new Error(`${code}:${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      restorations.reverse().forEach((restore) => restore());
    }
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", mutations: cases.length, expected_error_codes: cases.map(([code]) => code), mode: "real_source_mutation" })}\n`);
} finally {
  if (!suppliedSandbox) rmSync(sandbox, { recursive: true, force: true });
}

function createMutationSandbox() {
  const target = mkdtempSync(path.join(tmpdir(), "samurai-domain-verifier-mutations-"));
  // Copy only mutation targets; leave every other workspace package as a
  // relative source link. This preserves the real monorepo dependency graph
  // while avoiding generated dist duplication in every fault-injection run.
  const copiedPackages = new Set(["action-catalog", "domain-operations", "runtime"]);
  const sourcePackages = path.join(sourceRoot, "packages");
  const targetPackages = path.join(target, "packages");
  mkdirSync(targetPackages, { recursive: true });
  for (const name of readdirSync(sourcePackages)) {
    const sourcePackage = path.join(sourcePackages, name);
    const targetPackage = path.join(targetPackages, name);
    if (!copiedPackages.has(name)) {
      if (process.platform === "win32") cpSync(sourcePackage, targetPackage, { recursive: true, verbatimSymlinks: true });
      else symlinkSync(sourcePackage, targetPackage, "dir");
      continue;
    }
    mkdirSync(targetPackage, { recursive: true });
    for (const relative of ["package.json", "src", "node_modules"]) {
      const source = path.join(sourcePackage, relative);
      const destination = path.join(targetPackage, relative);
      if (relative === "package.json") mkdirSync(path.dirname(destination), { recursive: true });
      if (relative === "node_modules") symlinkSync(source, destination, "dir");
      else cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    }
  }
  for (const relative of [
    "package.json",
    "apps/server/src", "apps/web/src",
    "scripts/fixtures/domain-operation-evidence-valid.json", "scripts/fixtures/domain-verifier-model-valid.json",
    "scripts/fixtures/domain-command-contract.ts",
    "scripts/fixtures/domain-command-schema-matrix.ts", "scripts/fixtures/domain-command-schema-expectations.json",
    "scripts/fixtures/domain-operation-handler-matrix.ts", "scripts/fixtures/domain-operation-handler-expectations.ts",
    "scripts/fixtures/domain-command-trusted-context.ts", "scripts/fixtures/domain-operation-structure.ts",
    "scripts/generate-domain-operation-index.mjs", "scripts/verify-architecture-boundaries.mjs",
    "scripts/lib/domain-verifier-policy.mjs"
  ]) {
    const destination = path.join(target, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(sourceRoot, relative), destination, { recursive: true, verbatimSymlinks: true });
  }
  // External dependencies remain immutable and resolve through the source
  // checkout; workspace package links above resolve only within this sandbox.
  if (process.platform === "win32") cpSync(path.join(sourceRoot, "node_modules"), path.join(target, "node_modules"), { recursive: true, verbatimSymlinks: true });
  else symlinkSync(path.join(sourceRoot, "node_modules"), path.join(target, "node_modules"), "dir");
  return target;
}

function runNode(relative, args = []) {
  const loader = relative.endsWith(".ts") ? ["--import", "tsx"] : [];
  const scriptRoot = existsSync(path.join(sandbox, relative)) ? sandbox : sourceRoot;
  return spawnSync(process.execPath, [...loader, path.join(scriptRoot, relative), ...args], {
    cwd: scriptRoot,
    encoding: "utf8",
    env: { ...process.env, SAMURAI_REPO_ROOT: sandbox, SAMURAI_EVIDENCE_MODE: "deferred" }
  });
}

function expectFailure(result, message) {
  assert.notEqual(result.status, 0, `mutation unexpectedly passed: ${result.stdout}`);
  assert.match(`${result.stdout}${result.stderr}`, new RegExp(message));
}

function expectStructureGate(gate) {
  const result = runNode("scripts/fixtures/domain-operation-structure.ts");
  expectFailure(result, `\\"gate\\": \\"${gate}\\"`);
}

function expectArchitectureFailure() {
  expectFailure(runNode("scripts/verify-architecture-boundaries.mjs"), "server_route_direct_store_mutation");
}

function expectEvidenceFailure() {
  expectFailure(runNode("scripts/verify-domain-operation-evidence.mjs", [path.join(sandbox, "scripts/fixtures/domain-operation-evidence-valid.json")]), "evidence_actual_expected_mismatch");
}

function expectFalsePassedRejected() {
  expectFailure(runVerifierModelValidation(), "V015_FALSE_PASSED_STATUS");
}

function runVerifierModelValidation() {
  const script = `import { readFileSync } from "node:fs"; import { validateDomainVerifierModel } from ${JSON.stringify(path.join(sandbox, "scripts/lib/domain-verifier-policy.mjs"))}; const model=JSON.parse(readFileSync(${JSON.stringify(path.join(sandbox, "scripts/fixtures/domain-verifier-model-valid.json"))}, "utf8")); const violations=validateDomainVerifierModel(model); if (violations.length) { process.stderr.write(violations.join(",")); process.exit(1); }`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: sandbox, encoding: "utf8" });
}

function expectTrustedContextFailure(message) {
  const result = runSandboxTrustedContextFixture();
  expectFailure(result, message);
}

function assertVerifierBaselines() {
  const baselines = [
    ["generated-index", () => runNode("scripts/generate-domain-operation-index.mjs", ["--check"])],
    ["operation-structure", () => runNode("scripts/fixtures/domain-operation-structure.ts")],
    ["architecture-boundaries", () => runNode("scripts/verify-architecture-boundaries.mjs")],
    ["evidence", () => runNode("scripts/verify-domain-operation-evidence.mjs", [path.join(sandbox, "scripts/fixtures/domain-operation-evidence-valid.json")])],
    ["verifier-model", runVerifierModelValidation],
    ["schema-matrix", () => runSourceBundledFixture("scripts/fixtures/domain-command-schema-matrix.ts")],
    ["handler-matrix", () => runSourceBundledFixture("scripts/fixtures/domain-operation-handler-matrix.ts")],
    ["trusted-context", runSandboxTrustedContextFixture]
  ];
  for (const [name, verify] of baselines) {
    const result = verify();
    assert.equal(
      result.status,
      0,
      `${name} baseline must pass before fault injection:\n${result.stdout ?? ""}${result.stderr ?? ""}`
    );
  }
}

function runSandboxTsFixture(relative, args = []) {
  const output = path.join(sandbox, relative.replace(/\.ts$/, ".mjs"));
  const build = spawnSync(resolveEsbuild(), [
    path.join(sandbox, relative),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    ...workspacePackageAliases(),
    `--outfile=${output}`
  ], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...process.env, SAMURAI_REPO_ROOT: sandbox, SAMURAI_EVIDENCE_MODE: "deferred" },
    timeout: 600_000
  });
  if (build.status !== 0) return build;
  return spawnSync(process.execPath, [output, ...args], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...process.env, SAMURAI_REPO_ROOT: sandbox, SAMURAI_EVIDENCE_MODE: "deferred" },
    timeout: 600_000
  });
}

function runSourceBundledFixture(relative, args = []) {
  const output = path.join(sourceRoot, "node_modules", ".cache", path.basename(relative).replace(/\.ts$/, ".mjs"));
  const build = spawnSync(resolveEsbuild(), [
    path.join(sourceRoot, relative),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    ...workspacePackageAliases(),
    `--outfile=${output}`
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: { ...process.env, SAMURAI_REPO_ROOT: sourceRoot, SAMURAI_EVIDENCE_MODE: "deferred" },
    timeout: 600_000
  });
  if (build.status !== 0) return build;
  return spawnSync(process.execPath, [output, ...args], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: { ...process.env, SAMURAI_REPO_ROOT: sourceRoot, SAMURAI_EVIDENCE_MODE: "deferred" },
    timeout: 600_000
  });
}

function resolveEsbuild() {
  const platformPrefix = process.platform === "darwin"
    ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
    : `@esbuild+${process.platform}-${process.arch}@`;
  const packageRoot = path.join(sourceRoot, "node_modules", ".pnpm");
  const packageName = readdirSync(packageRoot).find((candidate) => candidate.startsWith(platformPrefix));
  assert.ok(packageName, `esbuild package not found: ${platformPrefix}`);
  const binaryName = packageName.slice(0, packageName.lastIndexOf("@")).replace("+", "/");
  return path.join(packageRoot, packageName, "node_modules", binaryName, "bin", "esbuild");
}

function workspacePackageAliases() {
  return [
    "action-catalog",
    "agent-backends",
    "artifacts",
    "audit",
    "capability-registry",
    "core-schemas",
    "domain-operations",
    "gateway",
    "learning",
    "localization",
    "memory",
    "skill-optimization",
    "skills",
    "ui-protocol",
    "workspace-store"
  ].map((name) => `--alias:@samurai-agent/${name}=${path.join(sandbox, "packages", name, "src", "index.ts")}`);
}

function runSandboxTrustedContextFixture() {
  const platformPrefix = process.platform === "darwin"
    ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@`
    : `@esbuild+${process.platform}-${process.arch}@`;
  const packageRoot = path.join(sourceRoot, "node_modules", ".pnpm");
  const packageName = readdirSync(packageRoot).find((candidate) => candidate.startsWith(platformPrefix));
  assert.ok(packageName, `esbuild package not found: ${platformPrefix}`);
  const binaryName = packageName.slice(0, packageName.lastIndexOf("@")).replace("+", "/");
  const esbuild = path.join(packageRoot, packageName, "node_modules", binaryName, "bin", "esbuild");
  const output = path.join(sandbox, "domain-command-trusted-context.mjs");
  const build = spawnSync(esbuild, [
    path.join(sandbox, "scripts/fixtures/domain-command-trusted-context.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:better-sqlite3",
    ...workspacePackageAliases(),
    `--outfile=${output}`
  ], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...process.env, GOMAXPROCS: process.env.GOMAXPROCS ?? "4" },
    timeout: 120_000
  });
  if (build.status !== 0) return build;
  return spawnSync(process.execPath, [output], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
    timeout: 120_000
  });
}

function mutateActiveIdMissing(edit) {
  edit("packages/domain-operations/src/generated/operation-index.generated.ts", (source) => source.replace('import operation0 from "../operations/artifact/create.operation.js";\n', "").replace("  operation0,\n", ""));
}
function mutateHandlerReuse(edit) {
  edit("packages/domain-operations/src/operations/artifact/export_pdf.operation.ts", (source) => source.replace("handleArtifactExportPdf", "handleArtifactCreate"));
}
function mutateGenericForwarder(edit) {
  edit("packages/runtime/src/domain-operation-ports/artifact-domain-service-ports.ts", (source) => `${source}\nexport const typedPortHandler = (ports: { execute(): unknown }) => ports.execute();\n`);
}
function mutateOperationRedispatch(edit) {
  edit("packages/runtime/src/commands/services/artifact-domain-service.ts", (source) => `${source}\nconst injectedOperationHandlers = new Map([["artifact.create", () => true]]);\nexport function injectedRedispatch(id: string) { return injectedOperationHandlers.get(id)?.() ?? false; }\n`);
}
function mutateQueryWritePort(edit) {
  edit("packages/domain-operations/src/definition/index.ts", (source) => source.replace(
    '  readonly [domainWriteCapability]?: never;\n}\n\nexport interface DomainWritePorts',
    '  readonly [domainWriteCapability]?: never;\n  save(value: string): Promise<void>;\n}\n\nexport interface DomainWritePorts'
  ));
}
function mutateForbiddenStoreImport(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => `import type { WorkspaceStore } from "@samurai-agent/workspace-store";\n${source}`);
}
function mutateNonStrictInput(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => source.replace("}).strict();", "});"));
}
function mutateOutputValidation(edit) {
  edit("packages/domain-operations/src/definition/index.ts", (source) => source.replace("definition.output.safeParse(envelope.data.value)", "({ success: true, data: envelope.data.value })"));
}
function mutateExplicitEffect(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => source.replace(/\n  "effect": "[^"]+",/, ""));
}
function mutateZodPrivateApi(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => source.replace("const Output =", "const injectedPrivateApi = Input._def;\nconst Output ="));
}
function mutateDirectStoreMutation(edit) {
  edit("apps/server/src/api-server.ts", (source) => `${source}
export function injectedDirectMutation(runtime: { store: { saveArtifact(): void } }) {
  const { store: destructuredStore } = runtime;
  const alias = destructuredStore;
  const write = alias.saveArtifact;
  function wrapper(target: { saveArtifact(): void }) { target.saveArtifact(); }
  write();
  wrapper(alias);
}
`);
}
function mutateCatalogSchema(edit) {
  edit("packages/action-catalog/src/domain-catalog-projection.ts", (source) => source.replace("input_schema: entry.input_schema,", "input_schema: entry.output_schema,"));
}
function mutateGeneratedIndex(edit) {
  edit("packages/domain-operations/src/generated/operation-index.generated.ts", (source) => `${source}\n// injected drift\n`);
}
function mutateEvidence(edit) {
  edit("scripts/fixtures/domain-operation-evidence-valid.json", (source) => source.replace('"expected": 81', '"expected": 80'));
}
function mutateFalsePassedModel(edit) {
  edit("scripts/fixtures/domain-verifier-model-valid.json", (source) => source.replace('"allGatesPassed": true', '"allGatesPassed": false'));
}

function mutateDirectPortForwarder(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => replaceNamedFunctionBody(
    source,
    "handleArtifactCreate",
    "void input;\n        return ports.execute(context, input);"
  ));
}

function mutateArtifactSourceBranch(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => insertNamedFunctionBodyPrefix(
    source,
    "handleArtifactCreate",
    'if (context.inputSource === "surface_operation") { void input; }'
  ));
}

function mutateArtifactLegacySurfaceCall(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => insertNamedFunctionBodyPrefix(
    source,
    "handleArtifactCreate",
    "void ports.runArtifactSurface;"
  ));
}

function mutateCollectionActionEnvelopeField(edit) {
  edit("packages/domain-operations/src/operations/collection/action/run.operation.ts", (source) => source.replace(
    '  "payload": z.record(domainJsonValueSchema).default({})',
    '  "session_id": z.string().trim().min(1).max(256).optional(),\n  "payload": z.record(domainJsonValueSchema).default({})'
  ));
}

function mutateFileReadPathOptional(edit) {
  edit("packages/domain-operations/src/operations/file/read.operation.ts", (source) => source.replace(
    '"path": z.string().trim().min(1).max(4096)',
    '"path": z.string().optional()'
  ));
}

function mutateCollectionActionPortDtoToRawRecord(edit) {
  edit("packages/domain-operations/src/operations/collection/action/run.operation.ts", (source) => source.replace(
    "runCollectionAction(input: CollectionActionRunRequest)",
    "runCollectionAction(input: Record<string, unknown>)"
  ));
}

function mutateFileReadPathBound(edit) {
  edit("packages/domain-operations/src/operations/file/read.operation.ts", (source) => source.replace(
    '"path": z.string().trim().min(1).max(4096)',
    '"path": z.string().trim().min(1).max(4097)'
  ));
}

function mutateCollectionActionRequiredField(edit) {
  edit("packages/domain-operations/src/operations/collection/action/run.operation.ts", (source) => source.replace(
    '"action_id": z.string().trim().min(1).max(256)',
    '"action_id": z.string().trim().min(1).max(256).optional()'
  ));
}

function mutateCollectionActionServiceDtoToRawRecord(edit) {
  edit("packages/runtime/src/commands/services/collection-domain-service.ts", (source) => source.replace(
    "async runAction(input: CollectionActionRunInput)",
    "async runAction(input: Record<string, unknown>)"
  ));
}

function mutateGeneratedSurfaceSessionOwnership(edit) {
  edit("packages/domain-operations/src/operations/generated_surface/create.operation.ts", (source) => source.replace(
    "session_id: context.sessionId",
    'session_id: "forged-session"'
  ));
}

function mutateGeneratedSurfaceRunOwnership(edit) {
  edit("packages/domain-operations/src/operations/generated_surface/create.operation.ts", (source) => source.replace(
    "producerRunId: context.runId",
    'producerRunId: "forged-run"'
  ));
}

function mutateGeneratedSurfaceServerTime(edit) {
  edit("packages/runtime/src/presentation/generated-surface.ts", (source) => source.replace(
    "const now = input.now ?? nowIso();",
    'const now = "2001-01-01T00:00:00.000Z";'
  ));
}

function mutateGeneratedSurfaceProviderIdRejection(edit) {
  edit("packages/runtime/src/agent-runtime.ts", (source) => source.replace(
    '  "id",\n  "surface_id"\n',
    '  "surface_id"\n'
  ));
}

function mutateGeneratedSurfaceProviderSurfaceIdRejection(edit) {
  edit("packages/runtime/src/agent-runtime.ts", (source) => source.replace(
    'for (const key of [...providerServerOwnedContextFields, "surface_id"] as const) {',
    'for (const key of providerServerOwnedContextFields) {'
  ));
}

function mutateProviderServerOwnedFieldRejection(edit) {
  edit("packages/runtime/src/agent-runtime.ts", (source) => source.replace(
    'for (const key of providerServerOwnedContextFields) {\n    if (args[key] !== undefined) {',
    'for (const key of providerServerOwnedContextFields) {\n    if (key !== "workspace_id" && args[key] !== undefined) {'
  ));
}

function mutateProviderUnknownFieldPreservation(edit) {
  edit("packages/runtime/src/agent-runtime.ts", (source) => source.replace(
    'const payload: Record<string, JsonValue> = { ...args };',
    'const payload: Record<string, JsonValue> = Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(properties, key)));'
  ));
}

function mutateProviderFailureTerminalOutcome(edit) {
  edit("packages/runtime/src/agent-runtime.ts", (source) => source.replace(
    'return { kind: "failed", toolRun };',
    'return { kind: "unhandled" };'
  ));
}

function mutateGeneratedSurfaceTargetRedispatch(edit) {
  edit("packages/runtime/src/commands/services/generated-surface-domain-service.ts", (source) => `${source}\nexport const injectedGeneratedSurfaceRedispatch = "dispatchSurfaceCommand";\n`);
}

function mutateProviderOperationCompositionAlias(edit) {
  edit("packages/runtime/src/provider-tool-bridge-composition.ts", (source) => `${source}\nconst injectedProviderOperation = "artifact.create";\nconst injectedProviderResult = getDomainOperationForProviderToolName(injectedProviderOperation);\nexport { injectedProviderResult };\n`);
}

function mutatePostHocQueryBrand(edit) {
  edit("packages/runtime/src/domain-operation-composition.ts", (source) => `${source}\nexport const injectedQueryBrand = markQuery({ injected: true }) as never;\n`);
}

function replaceNamedFunctionBody(source, functionName, body) {
  const functionIndex = source.indexOf(`function ${functionName}`);
  assert.notEqual(functionIndex, -1, `handler not found: ${functionName}`);
  const openingBrace = source.indexOf("{", functionIndex);
  assert.notEqual(openingBrace, -1, `handler opening brace not found: ${functionName}`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    return `${source.slice(0, openingBrace + 1)}\n        ${body}\n      ${source.slice(index)}`;
  }
  throw new Error(`handler closing brace not found: ${functionName}`);
}

function insertNamedFunctionBodyPrefix(source, functionName, prefix) {
  const functionIndex = source.indexOf(`function ${functionName}`);
  assert.notEqual(functionIndex, -1, `handler not found: ${functionName}`);
  const openingBrace = source.indexOf("{", functionIndex);
  assert.notEqual(openingBrace, -1, `handler opening brace not found: ${functionName}`);
  return `${source.slice(0, openingBrace + 1)}\n        ${prefix}${source.slice(openingBrace + 1)}`;
}
