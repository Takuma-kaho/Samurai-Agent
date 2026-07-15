import {
  GatewayBoundaryPolicySchema,
  GatewayConcurrencyLockRecordSchema,
  GatewayDeliveryRecordSchema,
  GatewayInboundMessageRecordSchema,
  GatewayPairingRecordSchema
} from "@samurai-agent/core-schemas";
import { z } from "zod";
import { chatTurnValueSchema, sessionRecordSchema } from "./chat.js";

export const gatewayInboundValueSchema = z.object({
  inbound: GatewayInboundMessageRecordSchema,
  pairing: GatewayPairingRecordSchema.optional(),
  boundaryPolicy: GatewayBoundaryPolicySchema.optional(),
  concurrencyLock: GatewayConcurrencyLockRecordSchema.optional(),
  session: sessionRecordSchema.optional(),
  chat: chatTurnValueSchema.optional(),
  deliveries: z.array(GatewayDeliveryRecordSchema).optional()
}).strict();
