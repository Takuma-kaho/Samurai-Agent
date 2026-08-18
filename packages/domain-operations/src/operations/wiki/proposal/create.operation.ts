// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ProvenanceSchema, ResourceRefSchema, SupportedLocaleSchema, createId, nowIso, type JsonValue, type OperationRecord, type ResourceRef, type RollbackPoint, type WikiFrontmatter } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { wikiWriteValueSchema } from "../../../value-objects/wiki.js";

const Input = z.object({
  "content": z.string().min(1),
  "content_locale": SupportedLocaleSchema.optional(),
  "provenance": ProvenanceSchema.optional(),
  "slug": z.string().trim().min(1).optional(),
  "source_refs": z.array(ResourceRefSchema.strict()).default([]),
  "tags": z.array(z.string().trim().min(1)).default([]),
  "title": z.string().trim().min(1)
}).strict();
const Output = wikiWriteValueSchema;
type OutputValue = z.infer<typeof Output>;

export interface WikiProposalCreatePorts {
  defaultWikiOutputLocale(): Promise<WikiFrontmatter["content_locale"]>;
  saveWikiPage(record: WikiFrontmatter, content: string): Promise<OutputValue["resource"]>;
  createWikiRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runWikiMutation(input: { trustedContext: TrustedDomainContext; operationName: "wiki.proposal.create"; proposedEffects: string[]; inputSummary: string; boundaryResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: OutputValue["resource"]; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<OutputValue>;
}

const wikiProposalCreate = defineCommand<WikiProposalCreatePorts>()({
  ...{
  "kind": "command",
  "id": "wiki.proposal.create",
  "version": "3.0",
  "availability": "active",
  "title": "Create Knowledge Wiki proposal",
  "description": "Create a proposed Knowledge Wiki page with provenance.",
  "sources": [
    "runtime_api",
    "scheduled_context",
    "external_app"
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
        const now = nowIso();
        const wiki: WikiFrontmatter = {
          id: createId("wiki"), slug: slugify(input.slug ?? input.title), title: input.title, state: "proposed",
          content_locale: input.content_locale ?? await ports.defaultWikiOutputLocale(), tags: input.tags, source_refs: input.source_refs,
          provenance: input.provenance ?? { kind: "user_authored", summary: "Created from an explicit local request.", verified: true },
          created_at: now, updated_at: now
        };
        const value = await ports.runWikiMutation({ trustedContext: context, operationName: "wiki.proposal.create", inputSummary: `Create wiki proposal: ${input.title}`,
          proposedEffects: ["Create a proposed wiki markdown page."], boundaryResourceRefs: [{ kind: "wiki", id: wiki.id, uri: `wiki/${wiki.id}`, label: wiki.title }], execute: async (operation) => {
          const saved = await ports.saveWikiPage(wiki, input.content);
          const ref: ResourceRef = { kind: "wiki", id: saved.id, uri: saved.file_path, label: saved.title };
          const rollbackPoint = await ports.createWikiRollback(operation, [ref], {}, { wiki_id: saved.id });
          return { resource: saved, ref, rollbackPoint, summary: `Created wiki proposal ${saved.title}.` };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default wikiProposalCreate;

function slugify(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "wiki"; }
