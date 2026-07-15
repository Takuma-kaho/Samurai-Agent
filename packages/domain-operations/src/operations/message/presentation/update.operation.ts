// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { messagePresentationUpdateValueSchema } from "../../../value-objects/presentation.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "presentation_id": z.string(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "view_state": z.record(domainJsonValueSchema) .optional()
}).strict();
const Output = messagePresentationUpdateValueSchema;

export interface MessagePresentationUpdatePorts {
  executeMessagePresentationUpdate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const messagePresentationUpdate = defineCommand<MessagePresentationUpdatePorts>()({
  ...{
  "kind": "command",
  "id": "message.presentation.update",
  "version": "1.0",
  "availability": "active",
  "title": "Update message presentation state",
  "description": "Persist card-local UI state for a chat message presentation.",
  "sources": [
    "surface_operation",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "chat",
    "custom_view"
  ],
  "resourceKinds": [
    "message_presentation",
    "collection_schema"
  ],
  "proposedEffects": [
    "Persist the current view state for a chat card."
  ],
  "outputResourceKind": "message_presentation",
  "uiDisplayCategory": "chat",
  "surfaceOperationKinds": [
    "message.presentation.update"
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
      execute: async function handleMessagePresentationUpdate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeMessagePresentationUpdate(context, input);
      }
    };
  }
});

export default messagePresentationUpdate;
