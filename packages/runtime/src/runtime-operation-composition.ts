import { domainOperationIdFor } from "@samurai-agent/domain-operations";

/** Runtime-only operation bindings. AgentRuntime consumes values, not operation-key lookup logic. */
export const runtimeOperationIds = Object.freeze({
  reflectionRun: domainOperationIdFor("reflectionRun"),
  curatorRun: domainOperationIdFor("curatorRun"),
  skillView: domainOperationIdFor("skillView"),
  skillLifecycleApply: domainOperationIdFor("skillLifecycleApply"),
  evaluationRun: domainOperationIdFor("evaluationRun"),
  artifactCreate: domainOperationIdFor("artifactCreate"),
  gatewayPairingApprove: domainOperationIdFor("gatewayPairingApprove"),
  collectionSchemaSave: domainOperationIdFor("collectionSchemaSave"),
  sandboxExec: domainOperationIdFor("sandboxExec"),
  mcpCall: domainOperationIdFor("mcpCall"),
  generatedSurfaceActionRun: domainOperationIdFor("generatedSurfaceActionRun"),
  generatedSurfaceInteractionRecord: domainOperationIdFor("generatedSurfaceInteractionRecord"),
  collectionPatchApply: domainOperationIdFor("collectionPatchApply")
});

export type RuntimeOperationId = (typeof runtimeOperationIds)[keyof typeof runtimeOperationIds];
