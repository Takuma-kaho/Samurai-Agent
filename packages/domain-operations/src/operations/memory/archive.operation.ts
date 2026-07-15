// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { memoryArchiveValueSchema } from "../../value-objects/memory.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "memory_id": z.string(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = memoryArchiveValueSchema;

export interface MemoryArchivePorts {
  executeMemoryArchive(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const memoryArchive = defineCommand<MemoryArchivePorts>()({
  ...{
  "kind": "command",
  "id": "memory.archive",
  "version": "2.0",
  "availability": "active",
  "title": "Archive memory",
  "description": "Archive a memory item without physically deleting it.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "state_transition",
  "render": [
    "memory"
  ],
  "resourceKinds": [
    "memory"
  ],
  "proposedEffects": [
    "Archive a memory item so it leaves normal memory views."
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
      execute: async function handleMemoryArchive(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeMemoryArchive(context, input);
      }
    };
  }
});

export default memoryArchive;
