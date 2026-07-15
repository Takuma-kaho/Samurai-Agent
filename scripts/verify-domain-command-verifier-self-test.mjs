import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { domainVerifierViolationCodes, passingDomainVerifierModel, validateDomainVerifierModel } from "./lib/domain-verifier-policy.mjs";

const mutations = [
  ["activeIdsComplete", "V001_ACTIVE_ID_MISSING"],
  ["handlersUnique", "V002_HANDLER_REUSED"],
  ["genericForwarderAbsent", "V003_GENERIC_FORWARDER"],
  ["operationRedispatchAbsent", "V004_OPERATION_REDISPATCH"],
  ["queryWriteCompileRejected", "V005_QUERY_WRITE_PORT"],
  ["forbiddenStoreImportsAbsent", "V006_FORBIDDEN_STORE_IMPORT"],
  ["strictInputs", "V007_NON_STRICT_INPUT"],
  ["outputValidationPresent", "V008_OUTPUT_VALIDATION_MISSING"],
  ["explicitEffects", "V009_EFFECT_INFERRED_FROM_ID"],
  ["zodPrivateApiAbsent", "V010_ZOD_PRIVATE_API"],
  ["directStoreMutationAbsent", "V011_DIRECT_STORE_MUTATION"],
  ["catalogSchemaMatches", "V012_CATALOG_SCHEMA_DRIFT"],
  ["generatedIndexMatches", "V013_GENERATED_INDEX_DRIFT"],
  ["evidenceActualMatches", "V014_EVIDENCE_ACTUAL_MISMATCH"],
  ["allGatesPassed", "V015_FALSE_PASSED_STATUS"]
];

const requestedCase = process.argv[2];
if (requestedCase) {
  const mutation = mutations.find(([field]) => field === requestedCase);
  assert.ok(mutation, `unknown verifier mutation: ${requestedCase}`);
  const [field, expectedCode] = mutation;
  const violations = validateDomainVerifierModel({ ...passingDomainVerifierModel(), [field]: false });
  assert.deepEqual(violations, [expectedCode]);
  process.stderr.write(`${expectedCode}\n`);
  process.exit(1);
}

assert.deepEqual(validateDomainVerifierModel(passingDomainVerifierModel()), []);
const selfPath = fileURLToPath(import.meta.url);
for (const [field, expectedCode] of mutations) {
  const result = spawnSync(process.execPath, [selfPath, field], { encoding: "utf8" });
  assert.notEqual(result.status, 0, `${field} did not fail`);
  assert.equal(result.stderr.trim(), expectedCode, `${field} did not emit its dedicated verifier code`);
}
assert.deepEqual(mutations.map(([, code]) => code), domainVerifierViolationCodes);
process.stdout.write(`${JSON.stringify({ status: "passed", mutations: mutations.length, expected_error_codes: mutations.map(([, code]) => code) })}\n`);
