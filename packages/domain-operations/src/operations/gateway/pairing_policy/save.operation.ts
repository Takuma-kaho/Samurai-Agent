// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayPairingPolicyValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = gatewayPairingPolicyValueSchema;

export interface GatewayPairingPolicySavePorts {
  executeGatewayPairingPolicySave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const gatewayPairingPolicySave = defineCommand<GatewayPairingPolicySavePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.pairing_policy.save",
  "version": "1.0",
  "availability": "active",
  "title": "Save Gateway pairing policy",
  "description": "Save an owner Gateway pairing policy.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "gateway_policy"
  ],
  "proposedEffects": [
    "Save a Gateway pairing policy."
  ],
  "outputResourceKind": "gateway_policy",
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
      execute: async function handleGatewayPairingPolicySave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGatewayPairingPolicySave(context, input);
      }
    };
  }
});

export default gatewayPairingPolicySave;
