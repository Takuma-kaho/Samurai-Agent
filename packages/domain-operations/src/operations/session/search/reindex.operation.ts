// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { sessionSearchReindexValueSchema } from "../../../value-objects/system-records.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = sessionSearchReindexValueSchema;

export interface SessionSearchReindexPorts {
  executeSessionSearchReindex(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const sessionSearchReindex = defineCommand<SessionSearchReindexPorts>()({
  ...{
  "kind": "command",
  "id": "session.search.reindex",
  "version": "1.0",
  "availability": "active",
  "title": "Reindex session search",
  "description": "Rebuild the Session search read model.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "search_index"
  ],
  "proposedEffects": [
    "Rebuild the Session search index."
  ],
  "outputResourceKind": "search_index",
  "uiDisplayCategory": "chat",
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
      execute: async function handleSessionSearchReindex(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSessionSearchReindex(context, input);
      }
    };
  }
});

export default sessionSearchReindex;
