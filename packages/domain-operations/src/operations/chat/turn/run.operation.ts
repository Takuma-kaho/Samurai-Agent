// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { chatTurnValueSchema } from "../../../value-objects/chat.js";

const Input = z.object({
  "attachments": z.array(z.record(domainJsonValueSchema)) .optional(),
  "backend_id": z.string() .optional(),
  "content": z.string(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "temporary_context": z.array(z.record(domainJsonValueSchema)) .optional()
}).strict();
const Output = chatTurnValueSchema;

export interface ChatTurnRunPorts {
  executeChatTurnRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const chatTurnRun = defineCommand<ChatTurnRunPorts>()({
  ...{
  "kind": "command",
  "id": "chat.turn.run",
  "version": "2.0",
  "availability": "active",
  "runtimeRequirements": ["agent_backend"],
  "title": "Run chat turn",
  "description": "Route a user message through Host context assembly and the selected Backend cassette.",
  "sources": [
    "surface_operation",
    "runtime_api",
    "gateway_inbound",
    "automation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "chat"
  ],
  "resourceKinds": [
    "backend_run",
    "message"
  ],
  "proposedEffects": [
    "Route the message through Host context assembly and a BackendRun."
  ],
  "outputResourceKind": "backend_run",
  "uiDisplayCategory": "chat",
  "surfaceOperationKinds": [
    "message.submit"
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
      execute: async function handleChatTurnRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeChatTurnRun(context, input);
      }
    };
  }
});

export default chatTurnRun;
