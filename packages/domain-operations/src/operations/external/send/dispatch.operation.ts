// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { externalSendWriteValueSchema } from "../../../value-objects/external-send.js";

const Input = z.object({
  "dry_run": z.boolean() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "send_id": z.string() .optional(),
  "sendId": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = externalSendWriteValueSchema;

export interface ExternalSendDispatchPorts {
  executeExternalSendDispatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const externalSendDispatch = defineCommand<ExternalSendDispatchPorts>()({
  ...{
  "kind": "command",
  "id": "external.send.dispatch",
  "version": "2.0",
  "availability": "active",
  "title": "Dispatch external send",
  "description": "Dispatch a prepared outbound send after approval.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "external_effect",
  "idempotency": "external",
  "concurrency": "external_idempotency",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "external_send"
  ],
  "proposedEffects": [
    "Dispatch a prepared outbound send after approval."
  ],
  "outputResourceKind": "external_send",
  "uiDisplayCategory": "external",
  "providerToolNames": [
    "external.send.dispatch"
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
      execute: async function handleExternalSendDispatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeExternalSendDispatch(context, input);
      }
    };
  }
});

export default externalSendDispatch;
