// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { wikiWriteValueSchema } from "../../value-objects/wiki.js";

const Input = z.object({
  "content": z.string() .optional(),
  "content_locale": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provenance": z.record(domainJsonValueSchema) .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "source_refs": z.array(z.record(domainJsonValueSchema)) .optional(),
  "surface_operation_id": z.string() .optional(),
  "tags": z.array(z.string()) .optional(),
  "title": z.string() .optional(),
  "wiki_id": z.string()
}).strict();
const Output = wikiWriteValueSchema;

export interface WikiPatchPorts {
  executeWikiPatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const wikiPatch = defineCommand<WikiPatchPorts>()({
  ...{
  "kind": "command",
  "id": "wiki.patch",
  "version": "2.0",
  "availability": "active",
  "title": "Patch Knowledge Wiki page",
  "description": "Edit Knowledge Wiki frontmatter or markdown content.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "knowledge_wiki"
  ],
  "resourceKinds": [
    "wiki"
  ],
  "proposedEffects": [
    "Edit Knowledge Wiki frontmatter or markdown content."
  ],
  "outputResourceKind": "wiki",
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
      execute: async function handleWikiPatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeWikiPatch(context, input);
      }
    };
  }
});

export default wikiPatch;
