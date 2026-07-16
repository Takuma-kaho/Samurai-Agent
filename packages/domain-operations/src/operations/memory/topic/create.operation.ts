// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { SupportedLocaleSchema } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { memoryWriteValueSchema } from "../../../value-objects/memory.js";
import { createMemory, type MemoryCreatePorts } from "../create-memory.js";

const Input = z.object({
  "content": z.string().min(1), "envelope_id": z.string().trim().min(1).optional(),
  "input_locale": SupportedLocaleSchema.optional(), "metadata": z.record(domainJsonValueSchema).default({}),
  "output_locale": SupportedLocaleSchema.optional(), "session_id": z.string().trim().min(1).optional(),
  "topic_kind": z.string().trim().min(1).default("preference")
}).strict();
const Output = memoryWriteValueSchema;

export interface MemoryTopicCreatePorts extends MemoryCreatePorts {}

const memoryTopicCreate = defineCommand<MemoryTopicCreatePorts>()({
  ...{
  "kind": "command",
  "id": "memory.topic.create",
  "version": "2.0",
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
        return { ok: true, value: Output.parse(await createMemory(ports, { kind: "topic", content: input.content, sessionId: input.session_id, inputLocale: input.input_locale, outputLocale: input.output_locale, metadata: input.metadata, envelopeId: input.envelope_id, topicKind: input.topic_kind })) };
      }
    };
  }
});

export default memoryTopicCreate;
