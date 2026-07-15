// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { memoryWriteValueSchema } from "../../../value-objects/memory.js";

const Input = z.object({
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
  "target_instruction": z.string() .optional(),
  "title": z.string() .optional(),
  "ui_locale": z.string() .optional(),
  "user_intent": z.string() .optional()
}).strict();
const Output = memoryWriteValueSchema;

export interface MemorySessionCreatePorts {
  executeMemorySessionCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const memorySessionCreate = defineCommand<MemorySessionCreatePorts>()({
  ...{
  "kind": "command",
  "id": "memory.session.create",
  "version": "2.0",
  "availability": "active",
  "title": "Create session memory",
  "description": "Keep the current turn as session-scoped memory.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "memory"
  ],
  "resourceKinds": [
    "memory"
  ],
  "proposedEffects": [
    "Keep the current user intent in session memory."
  ],
  "outputResourceKind": "memory",
  "uiDisplayCategory": "memory",
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
      execute: async function handleMemorySessionCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeMemorySessionCreate(context, input);
      }
    };
  }
});

export default memorySessionCreate;
