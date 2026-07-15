// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayInboundValueSchema } from "../../../value-objects/gateway-inbound.js";

const Input = z.object({
  "account_id": z.string() .optional(),
  "action_id": z.string() .optional(),
  "backend_id": z.string() .optional(),
  "body": z.string() .optional(),
  "channel": z.string() .optional(),
  "content": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "error_code": z.string() .optional(),
  "input": z.record(domainJsonValueSchema) .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "message": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "model": z.string() .optional(),
  "output_locale": z.string() .optional(),
  "output_summary": z.string() .optional(),
  "provider": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "provider_tool_name": z.string() .optional(),
  "reason": z.string() .optional(),
  "retryable": z.boolean() .optional(),
  "route": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_identity": z.string() .optional(),
  "source_label": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "status": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "text": z.string() .optional(),
  "thread_id": z.string() .optional(),
  "tool_call_id": z.string() .optional(),
  "user_intent": z.string() .optional()
}).strict();
const Output = gatewayInboundValueSchema;

export interface GatewayInboundRoutePorts {
  executeGatewayInboundRoute(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const gatewayInboundRoute = defineCommand<GatewayInboundRoutePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.inbound.route",
  "version": "1.0",
  "availability": "active",
  "title": "Route gateway inbound",
  "description": "Route an approved external inbound message into a Host session.",
  "sources": [
    "gateway_inbound"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "chat",
    "gateway"
  ],
  "resourceKinds": [
    "gateway_inbound",
    "backend_run"
  ],
  "proposedEffects": [
    "Route an approved external inbound message into a Host session."
  ],
  "outputResourceKind": "gateway_inbound",
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
      execute: async function handleGatewayInboundRoute(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGatewayInboundRoute(context, input);
      }
    };
  }
});

export default gatewayInboundRoute;
