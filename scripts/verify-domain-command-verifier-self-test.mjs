import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  ["V015_FALSE_PASSED_STATUS", mutateFalsePassedModel, expectFalsePassedRejected]
];

try {
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
  for (const relative of [
    "apps/server/src", "apps/web/src",
    "packages/action-catalog/src", "packages/core-schemas/src", "packages/domain-operations/src",
    "packages/runtime/src/agent-runtime.ts", "packages/runtime/src/domain-operation-composition.ts",
    "packages/runtime/src/domain-operation-ports", "packages/runtime/src/commands/services",
    "packages/learning/src", "packages/ui-protocol/src", "packages/agent-backends/src", "packages/gateway/src",
    "scripts/fixtures/domain-operation-evidence-valid.json", "scripts/fixtures/domain-verifier-model-valid.json",
    "scripts/lib/domain-verifier-policy.mjs"
  ]) {
    const destination = path.join(target, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(sourceRoot, relative), destination, { recursive: true });
  }
  return target;
}

function runNode(relative, args = []) {
  const loader = relative.endsWith(".ts") ? ["--import", "tsx"] : [];
  const scriptRoot = relative === "scripts/fixtures/domain-command-contract.ts" ? sandbox : sourceRoot;
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
  const script = `import { readFileSync } from "node:fs"; import { validateDomainVerifierModel } from ${JSON.stringify(path.join(sandbox, "scripts/lib/domain-verifier-policy.mjs"))}; const model=JSON.parse(readFileSync(${JSON.stringify(path.join(sandbox, "scripts/fixtures/domain-verifier-model-valid.json"))}, "utf8")); const violations=validateDomainVerifierModel(model); if (violations.length) { process.stderr.write(violations.join(",")); process.exit(1); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: sandbox, encoding: "utf8" });
  expectFailure(result, "V015_FALSE_PASSED_STATUS");
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
  edit("packages/domain-operations/src/definition/index.ts", (source) => source.replace('readonly domainPortKind?: "query";', 'readonly domainPortKind?: "query";\n  save(value: string): Promise<void>;'));
}
function mutateForbiddenStoreImport(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => `import type { WorkspaceStore } from "@samurai-agent/workspace-store";\n${source}`);
}
function mutateNonStrictInput(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => source.replace("}).strict();", "});"));
}
function mutateOutputValidation(edit) {
  edit("packages/domain-operations/src/registry/operation-registry.ts", (source) => source.replace("definition.output.safeParse(envelope.data.value)", "({ success: true, data: envelope.data.value })"));
}
function mutateExplicitEffect(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => source.replace(/\n  "effect": "[^"]+",/, ""));
}
function mutateZodPrivateApi(edit) {
  edit("packages/domain-operations/src/operations/artifact/create.operation.ts", (source) => source.replace("const Output =", "const injectedPrivateApi = Input._def;\nconst Output ="));
}
function mutateDirectStoreMutation(edit) {
  edit("apps/server/src/api-server.ts", (source) => `${source}\nexport function injectedDirectMutation(store: { saveArtifact(): void }) { store.saveArtifact(); }\n`);
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
