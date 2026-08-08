// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, OperationRecord, ResourceRef, RollbackPoint } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { wikiReindexValueSchema } from "../../value-objects/wiki.js";

const Input = z.object({}).strict();
const Output = wikiReindexValueSchema;
type OutputValue = z.infer<typeof Output>;

export interface WikiReindexPorts {
  reindexWikiPages(): Promise<OutputValue["resource"]>;
  runWikiMutation(input: { trustedContext: TrustedDomainContext; operationName: "wiki.reindex"; proposedEffects: string[]; inputSummary: string; execute(operation: OperationRecord): Promise<{ resource: OutputValue["resource"]; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: OutputValue["resource"]; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const wikiReindex = defineCommand<WikiReindexPorts>()({
  ...{
  "kind": "command",
  "id": "wiki.reindex",
  "version": "3.0",
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
        const value = await ports.runWikiMutation({ trustedContext: context, operationName: "wiki.reindex", inputSummary: "Reindex wiki pages", proposedEffects: ["Refresh the SQLite wiki index from markdown files."], execute: async () => {
          const resource = await ports.reindexWikiPages();
          const ref: ResourceRef = { kind: "wiki_index", id: "active", uri: "wiki/pages", label: "Wiki index" };
          return { resource, ref, summary: `Reindexed ${resource.active} active wiki pages.` };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default wikiReindex;
