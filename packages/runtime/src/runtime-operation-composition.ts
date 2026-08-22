import { domainOperationIdFor } from "@samurai-agent/domain-operations";

/** Runtime-only operation bindings. AgentRuntime consumes values, not operation-key lookup logic. */
export const runtimeOperationIds = Object.freeze({
  reflectionRun: domainOperationIdFor("reflectionRun"),
  rollbackRestore: domainOperationIdFor("rollbackRestore"),
  curatorRun: domainOperationIdFor("curatorRun"),
  learningBackgroundReviewApply: domainOperationIdFor("learningBackgroundReviewApply"),
  skillView: domainOperationIdFor("skillView"),
  skillLifecycleApply: domainOperationIdFor("skillLifecycleApply"),
  evaluationRun: domainOperationIdFor("evaluationRun"),
  artifactCreate: domainOperationIdFor("artifactCreate"),
  gatewayPairingApprove: domainOperationIdFor("gatewayPairingApprove"),
  collectionSchemaSave: domainOperationIdFor("collectionSchemaSave"),
  roomCreate: domainOperationIdFor("roomCreate"),
  sessionCreate: domainOperationIdFor("sessionCreate"),
  sandboxExec: domainOperationIdFor("sandboxExec"),
  mcpCall: domainOperationIdFor("mcpCall"),
  generatedSurfaceActionRun: domainOperationIdFor("generatedSurfaceActionRun"),
  generatedSurfaceInteractionRecord: domainOperationIdFor("generatedSurfaceInteractionRecord"),
  collectionPatchApply: domainOperationIdFor("collectionPatchApply"),
  automationJobSave: domainOperationIdFor("automationJobSave"),
  clientEventSave: domainOperationIdFor("clientEventSave"),
  resourceTranslationSave: domainOperationIdFor("resourceTranslationSave"),
  externalAppConnectionCreate: domainOperationIdFor("externalAppConnectionCreate"),
  workspaceContextGet: domainOperationIdFor("workspaceContextGet")
});

export type RuntimeOperationId = (typeof runtimeOperationIds)[keyof typeof runtimeOperationIds];
