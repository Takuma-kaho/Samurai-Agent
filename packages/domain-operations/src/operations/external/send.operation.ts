// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { externalSendWriteValueSchema } from "../../value-objects/external-send.js";

const Input = z.object({
  "body": z.string() .optional(),
  "channel": z.string() .optional(),
  "content": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "target": z.record(domainJsonValueSchema) .optional(),
  "title": z.string() .optional(),
  "user_intent": z.string() .optional()
}).strict();
const Output = externalSendWriteValueSchema;

export interface ExternalSendPorts {
  executeExternalSend(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const externalSend = defineCommand<ExternalSendPorts>()({
  ...{
  "kind": "command",
  "id": "external.send",
  "version": "1.0",
  "availability": "active",
  "title": "Prepare outbound send",
  "description": "Plan an outbound send request without dispatching it.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "external_idempotency",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "external_send"
  ],
  "proposedEffects": [
    "Prepare an outbound action. No external effect is executed in v1."
  ],
  "outputResourceKind": "external_send",
  "uiDisplayCategory": "external",
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
      execute: async function handleExternalSend(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeExternalSend(context, input);
      }
    };
  }
});

export default externalSend;
