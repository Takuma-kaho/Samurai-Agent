// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { externalSendWriteValueSchema } from "../../../value-objects/external-send.js";

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
  "summary": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "target": z.record(domainJsonValueSchema) .optional(),
  "title": z.string() .optional()
}).strict();
const Output = externalSendWriteValueSchema;

export interface ExternalSendPreparePorts {
  executeExternalSendPrepare(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const externalSendPrepare = defineCommand<ExternalSendPreparePorts>()({
  ...{
  "kind": "command",
  "id": "external.send.prepare",
  "version": "2.0",
  "availability": "active",
  "title": "Prepare external send draft",
  "description": "Prepare an outbound send draft without dispatching it.",
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
    "Create an outbound send draft without dispatching."
  ],
  "outputResourceKind": "external_send",
  "uiDisplayCategory": "external",
  "providerToolNames": [
    "request_external_send",
    "external.send.prepare"
  ],
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
      execute: async function handleExternalSendPrepare(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeExternalSendPrepare(context, input);
      }
    };
  }
});

export default externalSendPrepare;
