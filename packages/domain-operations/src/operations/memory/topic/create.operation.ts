// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { memoryWriteValueSchema } from "../../../value-objects/memory.js";

const Input = z.object({
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
  "topic": z.string() .optional(),
  "topic_kind": z.string() .optional()
}).strict();
const Output = memoryWriteValueSchema;

export interface MemoryTopicCreatePorts {
  executeMemoryTopicCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const memoryTopicCreate = defineCommand<MemoryTopicCreatePorts>()({
  ...{
  "kind": "command",
  "id": "memory.topic.create",
  "version": "1.0",
  "availability": "active",
  "title": "Create topic memory",
  "description": "Create a visible topic memory candidate.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
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
    "Create a visible topic memory candidate."
  ],
  "outputResourceKind": "memory",
  "uiDisplayCategory": "memory",
  "providerToolNames": [
    "remember_topic"
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
      execute: async function handleMemoryTopicCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeMemoryTopicCreate(context, input);
      }
    };
  }
});

export default memoryTopicCreate;
