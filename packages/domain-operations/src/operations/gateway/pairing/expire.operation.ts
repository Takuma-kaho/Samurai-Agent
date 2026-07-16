// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { nowIso, type GatewayPairingRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayPairingListValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "now": z.string() .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = gatewayPairingListValueSchema;

export interface GatewayPairingExpirePorts {
  expireGatewayPairings(now: string): Promise<GatewayPairingRecord[]>;
  emitGatewayPairingUpdated(record: GatewayPairingRecord): Promise<void>;
}

const gatewayPairingExpire = defineCommand<GatewayPairingExpirePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.pairing.expire",
  "version": "1.0",
  "availability": "active",
  "title": "Expire Gateway pairings",
  "description": "Expire stale Gateway pairing requests.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "gateway_pairing"
  ],
  "proposedEffects": [
    "Expire stale Gateway pairings."
  ],
  "outputResourceKind": "gateway_pairing",
  "uiDisplayCategory": "gateway",
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleGatewayPairingExpire(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const expired = await ports.expireGatewayPairings(input.now?.trim() || nowIso());
        for (const pairing of expired) await ports.emitGatewayPairingUpdated(pairing);
        return { ok: true, value: expired };
      }
    };
  }
});

export default gatewayPairingExpire;
