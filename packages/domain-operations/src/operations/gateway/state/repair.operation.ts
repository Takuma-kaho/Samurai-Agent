// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayRepairValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({
  "dry_run": z.boolean().default(true),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "now": z.string().datetime().optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = gatewayRepairValueSchema;

export interface GatewayStateRepairPorts {
  repairGatewayState(input: { dryRun: boolean; now?: string }): Promise<z.infer<typeof Output>>;
}

const gatewayStateRepair = defineCommand<GatewayStateRepairPorts>()({
  ...{
  "kind": "command",
  "id": "gateway.state.repair",
  "version": "1.0",
  "availability": "active",
  "title": "Repair Gateway state",
  "description": "Repair recoverable Gateway state inconsistencies.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "state_transition",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "gateway_state"
  ],
  "proposedEffects": [
    "Repair recoverable Gateway state."
  ],
  "outputResourceKind": "gateway_state",
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
      execute: async function handleGatewayStateRepair(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const value = await ports.repairGatewayState({ dryRun: input.dry_run, now: input.now?.trim() || undefined });
        return { ok: true, value };
      }
    };
  }
});

export default gatewayStateRepair;
