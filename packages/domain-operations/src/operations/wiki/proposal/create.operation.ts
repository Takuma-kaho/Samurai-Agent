// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { wikiWriteValueSchema } from "../../../value-objects/wiki.js";

const Input = z.object({
  "content": z.string(),
  "content_locale": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provenance": z.record(domainJsonValueSchema) .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "slug": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "source_refs": z.array(z.record(domainJsonValueSchema)) .optional(),
  "surface_operation_id": z.string() .optional(),
  "tags": z.array(z.string()) .optional(),
  "title": z.string()
}).strict();
const Output = wikiWriteValueSchema;

export interface WikiProposalCreatePorts {
  executeWikiProposalCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const wikiProposalCreate = defineCommand<WikiProposalCreatePorts>()({
  ...{
  "kind": "command",
  "id": "wiki.proposal.create",
  "version": "2.0",
  "availability": "active",
  "title": "Create Knowledge Wiki proposal",
  "description": "Create a proposed Knowledge Wiki page with provenance.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "knowledge_wiki"
  ],
  "resourceKinds": [
    "wiki"
  ],
  "proposedEffects": [
    "Create a proposed Knowledge Wiki markdown page."
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
      execute: async function handleWikiProposalCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeWikiProposalCreate(context, input);
      }
    };
  }
});

export default wikiProposalCreate;
