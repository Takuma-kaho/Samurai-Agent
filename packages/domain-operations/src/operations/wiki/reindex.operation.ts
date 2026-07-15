// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { wikiReindexValueSchema } from "../../value-objects/wiki.js";

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
const Output = wikiReindexValueSchema;

export interface WikiReindexPorts {
  executeWikiReindex(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const wikiReindex = defineCommand<WikiReindexPorts>()({
  ...{
  "kind": "command",
  "id": "wiki.reindex",
  "version": "2.0",
  "availability": "active",
  "title": "Reindex Knowledge Wiki",
  "description": "Refresh the Knowledge Wiki SQLite index from markdown pages.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "knowledge_wiki"
  ],
  "resourceKinds": [
    "wiki",
    "wiki_index"
  ],
  "proposedEffects": [
    "Refresh the Knowledge Wiki SQLite index from markdown pages."
  ],
  "outputResourceKind": "wiki_index",
  "uiDisplayCategory": "knowledge_wiki",
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
      execute: async function handleWikiReindex(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeWikiReindex(context, input);
      }
    };
  }
});

export default wikiReindex;
