export const domainVerifierViolationCodes = Object.freeze([
  "V001_ACTIVE_ID_MISSING",
  "V002_HANDLER_REUSED",
  "V003_GENERIC_FORWARDER",
  "V004_OPERATION_REDISPATCH",
  "V005_QUERY_WRITE_PORT",
  "V006_FORBIDDEN_STORE_IMPORT",
  "V007_NON_STRICT_INPUT",
  "V008_OUTPUT_VALIDATION_MISSING",
  "V009_EFFECT_INFERRED_FROM_ID",
  "V010_ZOD_PRIVATE_API",
  "V011_DIRECT_STORE_MUTATION",
  "V012_CATALOG_SCHEMA_DRIFT",
  "V013_GENERATED_INDEX_DRIFT",
  "V014_EVIDENCE_ACTUAL_MISMATCH",
  "V015_FALSE_PASSED_STATUS",
  "V016_DIRECT_PORT_FORWARDER",
  "V017_ARTIFACT_SOURCE_BRANCH",
  "V018_ARTIFACT_LEGACY_SURFACE_CALL",
  "V019_COLLECTION_ACTION_ENVELOPE_FIELD",
  "V020_FILE_READ_PATH_OPTIONAL",
  "V021_PORT_DTO_TO_RAW_RECORD",
  "V022_FILE_READ_PATH_BOUND",
  "V023_COLLECTION_ACTION_REQUIRED_FIELD",
  "V024_SERVICE_DTO_TO_RAW_RECORD",
  "V025_GENERATED_SURFACE_SESSION_NOT_CONTEXT_OWNED",
  "V026_GENERATED_SURFACE_RUN_NOT_CONTEXT_OWNED",
  "V027_GENERATED_SURFACE_TIME_NOT_SERVER_OWNED",
  "V028_GENERATED_SURFACE_PROVIDER_ID_NOT_REJECTED",
  "V029_GENERATED_SURFACE_PROVIDER_SURFACE_ID_NOT_REJECTED",
  "V030_PROVIDER_SERVER_OWNED_FIELD_NOT_TYPED",
  "V031_PROVIDER_UNKNOWN_FIELD_SILENTLY_DROPPED",
  "V032_PROVIDER_FAILURE_FALLS_THROUGH",
  "V033_GENERATED_SURFACE_TARGET_REDISPATCH",
  "V034_GENERATED_SURFACE_GENERIC_TARGET_DISPATCH",
  "V035_PROVIDER_OPERATION_COMPOSITION_ALIAS",
  "V036_POSTHOC_QUERY_BRAND"
]);

export function validateDomainVerifierModel(model) {
  const violations = [];
  if (!model.activeIdsComplete) violations.push("V001_ACTIVE_ID_MISSING");
  if (!model.handlersUnique) violations.push("V002_HANDLER_REUSED");
  if (!model.genericForwarderAbsent) violations.push("V003_GENERIC_FORWARDER");
  if (!model.operationRedispatchAbsent) violations.push("V004_OPERATION_REDISPATCH");
  if (!model.queryWriteCompileRejected) violations.push("V005_QUERY_WRITE_PORT");
  if (!model.forbiddenStoreImportsAbsent) violations.push("V006_FORBIDDEN_STORE_IMPORT");
  if (!model.strictInputs) violations.push("V007_NON_STRICT_INPUT");
  if (!model.outputValidationPresent) violations.push("V008_OUTPUT_VALIDATION_MISSING");
  if (!model.explicitEffects) violations.push("V009_EFFECT_INFERRED_FROM_ID");
  if (!model.zodPrivateApiAbsent) violations.push("V010_ZOD_PRIVATE_API");
  if (!model.directStoreMutationAbsent) violations.push("V011_DIRECT_STORE_MUTATION");
  if (!model.catalogSchemaMatches) violations.push("V012_CATALOG_SCHEMA_DRIFT");
  if (!model.generatedIndexMatches) violations.push("V013_GENERATED_INDEX_DRIFT");
  if (!model.evidenceActualMatches) violations.push("V014_EVIDENCE_ACTUAL_MISMATCH");
  if (model.reportedPassed && !model.allGatesPassed) violations.push("V015_FALSE_PASSED_STATUS");
  return violations;
}

export function passingDomainVerifierModel() {
  return {
    activeIdsComplete: true,
    handlersUnique: true,
    genericForwarderAbsent: true,
    operationRedispatchAbsent: true,
    queryWriteCompileRejected: true,
    forbiddenStoreImportsAbsent: true,
    strictInputs: true,
    outputValidationPresent: true,
    explicitEffects: true,
    zodPrivateApiAbsent: true,
    directStoreMutationAbsent: true,
    catalogSchemaMatches: true,
    generatedIndexMatches: true,
    evidenceActualMatches: true,
    allGatesPassed: true,
    reportedPassed: true
  };
}
