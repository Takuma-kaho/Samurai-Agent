// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { wikiWriteValueSchema } from "../../value-objects/wiki.js";
import { executeWikiStateTransition, type WikiStateTransitionPorts } from "./state-transition.js";

const Input = z.object({
  "wiki_id": z.string().trim().min(1),
  "expected_resource_version": z.number().int().positive().optional()
}).strict();
const Output = wikiWriteValueSchema;

export interface WikiArchivePorts extends WikiStateTransitionPorts {}

const wikiArchive = defineCommand<WikiArchivePorts>()({
  ...{
  "kind": "command",
  "id": "wiki.archive",
  "version": "3.0",
  "availability": "active",
  "title": "Archive Knowledge Wiki page",
  "description": "Archive a Knowledge Wiki page without deleting its markdown.",
  "sources": [
    "runtime_api",
    "external_app"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "state_transition",
  "render": [
    "knowledge_wiki"
  ],
  "resourceKinds": [
    "wiki"
  ],
  "proposedEffects": [
    "Archive a Knowledge Wiki page without deleting its markdown."
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
      execute: async function handleWikiArchive(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: await executeWikiStateTransition(ports, {
          context,
          id: input.wiki_id,
          state: "archived",
          expectedResourceVersion: input.expected_resource_version,
          operationName: "wiki.archive",
          proposedEffect: "Archive a wiki page without deleting its markdown.",
          summaryPrefix: "Archived wiki page"
        }) };
      }
    };
  }
});

export default wikiArchive;
