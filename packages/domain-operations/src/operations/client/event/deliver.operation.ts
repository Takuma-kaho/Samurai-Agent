// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { clientEventValueSchema } from "../../../value-objects/client-event.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "error_code": z.string() .optional(),
  "event_id": z.string(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = clientEventValueSchema;

export interface ClientEventDeliverPorts {
  executeClientEventDeliver(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const clientEventDeliver = defineCommand<ClientEventDeliverPorts>()({
  ...{
  "kind": "command",
  "id": "client.event.deliver",
  "version": "1.0",
  "availability": "active",
  "title": "Mark client event delivered",
  "description": "Mark a client event as delivered.",
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
    "client_event"
  ],
  "proposedEffects": [
    "Mark a client event as delivered."
  ],
  "outputResourceKind": "client_event",
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
      execute: async function handleClientEventDeliver(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeClientEventDeliver(context, input);
      }
    };
  }
});

export default clientEventDeliver;
