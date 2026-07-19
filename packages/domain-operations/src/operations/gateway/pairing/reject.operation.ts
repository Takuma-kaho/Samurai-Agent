// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { rejectPairing } from "@samurai-agent/gateway";
import type { GatewayPairingRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayPairingValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({ "pairing_id": z.string() }).strict();
const Output = gatewayPairingValueSchema;

export interface GatewayPairingRejectPorts {
  requireGatewayPairing(id: string): Promise<GatewayPairingRecord>;
  saveGatewayPairing(record: GatewayPairingRecord): Promise<GatewayPairingRecord>;
  emitGatewayPairingUpdated(record: GatewayPairingRecord): Promise<void>;
}

const gatewayPairingReject = defineCommand<GatewayPairingRejectPorts>()({
  ...{
  "kind": "command",
  "id": "gateway.pairing.reject",
  "version": "2.0",
  "availability": "active",
  "title": "Reject Gateway pairing",
  "description": "Reject a pending Gateway pairing.",
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
    "Reject a Gateway pairing."
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
      execute: async function handleGatewayPairingReject(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const saved = await ports.saveGatewayPairing(rejectPairing(await ports.requireGatewayPairing(input.pairing_id)));
        await ports.emitGatewayPairingUpdated(saved);
        return { ok: true, value: saved };
      }
    };
  }
});

export default gatewayPairingReject;
