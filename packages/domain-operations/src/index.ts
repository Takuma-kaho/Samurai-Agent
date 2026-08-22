export * from "./definition/index.js";
export * from "./definition/access-classification.js";
export {
  operationDefinitions,
  domainCommandIds,
  domainOperationIds,
  domainQueryIds,
  isDomainCommandId,
  isDomainQueryId,
  parseDomainOperationInput,
  type DomainCommandId,
  type DomainOperationContractMap,
  type DomainOperationId,
  type DomainOperationInput,
  type DomainOperationOutput,
  type DomainQueryId
} from "./generated/operation-index.generated.js";
export { bindOperationDefinitions, type DomainOperationPorts } from "./generated/operation-binder.generated.js";
export { domainOperationClient, domainOperationIdFor, type DomainOperationKey } from "./generated/operation-client.generated.js";
export { collectionManageCompatibility, deprecatedOperations } from "./generated/legacy-operations.generated.js";
export * from "./catalog.js";
export { default as chatTurnRun } from "./operations/chat/turn/run.operation.js";
export { default as sessionCreate } from "./operations/session/create.operation.js";
export { default as generatedSurfaceActionRun } from "./operations/generated_surface/action/run.operation.js";
export { default as generatedSurfaceCreate } from "./operations/generated_surface/create.operation.js";
export { default as generatedSurfaceExport } from "./operations/generated_surface/export.operation.js";
export { default as generatedSurfaceInteractionRecord } from "./operations/generated_surface/interaction/record.operation.js";
export { default as generatedSurfaceRevise } from "./operations/generated_surface/revise.operation.js";
export { default as generatedSurfaceState } from "./operations/generated_surface/state.operation.js";
export type { GeneratedSurfaceCreateInput, GeneratedSurfaceCreatePorts } from "./operations/generated_surface/create.operation.js";
export type { GeneratedSurfaceExportInput, GeneratedSurfaceExportPorts } from "./operations/generated_surface/export.operation.js";
export type { GeneratedSurfaceReviseInput, GeneratedSurfaceRevisePorts } from "./operations/generated_surface/revise.operation.js";
export type { GeneratedSurfaceActionRunInput, GeneratedSurfaceActionRunPorts } from "./operations/generated_surface/action/run.operation.js";
export type { GeneratedSurfaceInteractionRecordInput, GeneratedSurfaceInteractionRecordPorts } from "./operations/generated_surface/interaction/record.operation.js";
export type { GeneratedSurfaceStateInput, GeneratedSurfaceStatePorts } from "./operations/generated_surface/state.operation.js";
export * from "./registry/operation-registry.js";
export { skillOptimizationStartValueSchema } from "./value-objects/skill.js";
export { mcpCallValueSchema, sandboxExecValueSchema } from "./value-objects/tool-execution.js";
export { resourceRedactionValueSchema, resourceTransferValueSchema } from "./operations/resource/transfer.js";
export type { GatewayMcpConfigSaveRequest } from "./operations/gateway/mcp_config/save.operation.js";
export type { GatewayPairingPolicySaveRequest } from "./operations/gateway/pairing_policy/save.operation.js";
export type { GatewayRoutingPolicySaveRequest } from "./operations/gateway/routing_policy/save.operation.js";
/**
 * Standard PostgreSQL adapters bind these definitions directly when they do
 * not construct the legacy all-features Runtime registry. Keeping the
 * definitions public preserves the same validated Domain Operation boundary
 * for Web, Native, and external ingress composition.
 */
export { default as gatewayConcurrencyLockExpire } from "./operations/gateway/concurrency_lock/expire.operation.js";
export { default as gatewayInboundRoute } from "./operations/gateway/inbound/route.operation.js";
export { default as gatewayMcpConfigSave } from "./operations/gateway/mcp_config/save.operation.js";
export { default as gatewayPairingPolicySave } from "./operations/gateway/pairing_policy/save.operation.js";
export { default as gatewayPairingApprove } from "./operations/gateway/pairing/approve.operation.js";
export { default as gatewayPairingExpire } from "./operations/gateway/pairing/expire.operation.js";
export { default as gatewayPairingReject } from "./operations/gateway/pairing/reject.operation.js";
export { default as gatewayPairingRevoke } from "./operations/gateway/pairing/revoke.operation.js";
export { default as gatewayPairingRotate } from "./operations/gateway/pairing/rotate.operation.js";
export { default as gatewayRoutingPolicySave } from "./operations/gateway/routing_policy/save.operation.js";
export { default as gatewaySandboxDelete } from "./operations/gateway/sandbox/delete.operation.js";
export { default as gatewaySandboxRecreate } from "./operations/gateway/sandbox/recreate.operation.js";
export { default as gatewaySandboxSync } from "./operations/gateway/sandbox/sync.operation.js";
export { default as gatewayStateRepair } from "./operations/gateway/state/repair.operation.js";
export { default as skillOptimizationCancel } from "./operations/skill/optimization/cancel.operation.js";
export { default as skillOptimizationPromote } from "./operations/skill/optimization/promote.operation.js";
export { default as skillOptimizationReject } from "./operations/skill/optimization/reject.operation.js";
export { default as skillOptimizationRollback } from "./operations/skill/optimization/rollback.operation.js";
export { default as skillOptimizationStart } from "./operations/skill/optimization/start.operation.js";
export type { ReflectionArtifactSnapshot, ReflectionWorkflowInput } from "./operations/reflection/run.operation.js";
export type { HumanChangeRequestInput, HumanChangeRequestOutput, HumanChangeRequestPorts } from "./operations/human-change-request.js";
export type { ResourceCopyInput } from "./operations/resource/copy.operation.js";
export type { ResourceMoveInput } from "./operations/resource/move.operation.js";
export type { ResourcePromoteInput } from "./operations/resource/promote.operation.js";
export type { ResourceRedactInput } from "./operations/resource/redact.operation.js";
export type { ResourceRedactionValue, ResourceTransferValue, TransferableResourceKind } from "./operations/resource/transfer.js";
