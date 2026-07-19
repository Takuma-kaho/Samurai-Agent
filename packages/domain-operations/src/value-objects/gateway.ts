import { GatewayConcurrencyLockRecordSchema, GatewayMcpConfigRecordSchema, GatewayPairingPolicyRecordSchema, GatewayPairingRecordSchema, GatewayRepairResultSchema, GatewayRoutingPolicyRecordSchema, GatewaySandboxInstanceRecordSchema, GatewaySandboxWorkspaceSyncResultSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";

export const gatewayExpiredLocksValueSchema = z.object({
  expired_count: z.number().int().nonnegative(), locks: z.array(GatewayConcurrencyLockRecordSchema)
}).strict();
export const gatewayMcpConfigValueSchema = GatewayMcpConfigRecordSchema;
export const gatewayPairingPolicyValueSchema = GatewayPairingPolicyRecordSchema.strict();
export const gatewayRoutingPolicyValueSchema = GatewayRoutingPolicyRecordSchema.strict();
export const gatewayPairingValueSchema = GatewayPairingRecordSchema.strict();
export const gatewayPairingListValueSchema = z.array(GatewayPairingRecordSchema);
export const gatewaySandboxInstanceValueSchema = GatewaySandboxInstanceRecordSchema.strict();
export const gatewaySandboxSyncValueSchema = GatewaySandboxWorkspaceSyncResultSchema.strict();
export const gatewayRepairValueSchema = GatewayRepairResultSchema.strict();
