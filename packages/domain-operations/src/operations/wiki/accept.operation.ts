// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { wikiWriteValueSchema } from "../../value-objects/wiki.js";
import { executeWikiStateTransition, type WikiStateTransitionPorts } from "./state-transition.js";

const Input = z.object({ "wiki_id": z.string().trim().min(1) }).strict();
const Output = wikiWriteValueSchema;

export interface WikiAcceptPorts extends WikiStateTransitionPorts {}

const wikiAccept = defineCommand<WikiAcceptPorts>()({
  ...{
  "kind": "command",
  "id": "wiki.accept",
  "version": "2.0",
  "availability": "active",
  "title": "Accept Knowledge Wiki page",
  "description": "Accept a proposed Knowledge Wiki page for active retrieval.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "knowledge_wiki"
  ],
  "resourceKinds": [
    "wiki"
  ],
  "proposedEffects": [
    "Accept a Knowledge Wiki page for active retrieval."
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
      execute: async function handleWikiAccept(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: await executeWikiStateTransition(ports, { id: input.wiki_id, state: "active", operationName: "wiki.accept", proposedEffect: "Accept a wiki proposal for active retrieval.", summaryPrefix: "Accepted wiki page" }) };
      }
    };
  }
});

export default wikiAccept;
