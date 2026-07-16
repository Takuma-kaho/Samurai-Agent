// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { expirePairing, rotatePairingCode } from "@samurai-agent/gateway";
import type { GatewayPairingRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayPairingValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "pairing_id": z.string(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = gatewayPairingValueSchema;

export interface GatewayPairingRotatePorts {
  requireGatewayPairing(id: string): Promise<GatewayPairingRecord>;
  saveGatewayPairing(record: GatewayPairingRecord): Promise<GatewayPairingRecord>;
  emitGatewayPairingUpdated(record: GatewayPairingRecord): Promise<void>;
}

const gatewayPairingRotate = defineCommand<GatewayPairingRotatePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.pairing.rotate",
  "version": "1.0",
  "availability": "active",
  "title": "Rotate Gateway pairing",
  "description": "Rotate a Gateway pairing code.",
  "sources": [
    "runtime_api"
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
    "Rotate a Gateway pairing code."
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
      execute: async function handleGatewayPairingRotate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const fresh = expirePairing(await ports.requireGatewayPairing(input.pairing_id));
        const saved = await ports.saveGatewayPairing(fresh.status === "expired" ? fresh : rotatePairingCode(fresh));
        await ports.emitGatewayPairingUpdated(saved);
        return { ok: true, value: saved };
      }
    };
  }
});

export default gatewayPairingRotate;
