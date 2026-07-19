// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { approvePairing, expirePairing } from "@samurai-agent/gateway";
import type { GatewayPairingRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayPairingValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({ "pairing_id": z.string() }).strict();
const Output = gatewayPairingValueSchema;

export interface GatewayPairingApprovePorts {
  requireGatewayPairing(id: string): Promise<GatewayPairingRecord>;
  saveGatewayPairing(record: GatewayPairingRecord): Promise<GatewayPairingRecord>;
  emitGatewayPairingUpdated(record: GatewayPairingRecord): Promise<void>;
}

const gatewayPairingApprove = defineCommand<GatewayPairingApprovePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.pairing.approve",
  "version": "2.0",
  "availability": "active",
  "title": "Approve Gateway pairing",
  "description": "Approve a pending Gateway pairing.",
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
    "Approve a Gateway pairing."
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
      execute: async function handleGatewayPairingApprove(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const pairing = await ports.requireGatewayPairing(input.pairing_id);
        const fresh = expirePairing(pairing);
        const next = fresh.status === "expired" ? fresh : approvePairing(fresh);
        const saved = await ports.saveGatewayPairing(next);
        await ports.emitGatewayPairingUpdated(saved);
        return { ok: true, value: saved };
      }
    };
  }
});

export default gatewayPairingApprove;
