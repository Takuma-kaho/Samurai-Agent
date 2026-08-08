// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { SupportedLocaleSchema } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { memoryWriteValueSchema } from "../../../value-objects/memory.js";

const Input = z.object({
  "content": z.string().min(1),
  "input_locale": SupportedLocaleSchema.optional(), "metadata": z.record(domainJsonValueSchema).default({}),
  "output_locale": SupportedLocaleSchema.optional(),
  "title": z.string().optional(), "ui_locale": SupportedLocaleSchema.optional()
}).strict();
const Output = memoryWriteValueSchema;

export interface MemorySessionCreatePorts {
  memorySessionScopeWriteDisabledError(): Error;
}

const memorySessionCreate = defineCommand<MemorySessionCreatePorts>()({
  ...{
  "kind": "command",
  "id": "memory.session.create",
  "version": "4.0",
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
        void context;
        void input;
        throw ports.memorySessionScopeWriteDisabledError();
      }
    };
  }
});

export default memorySessionCreate;
