// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ProvenanceSchema, ResourceRefSchema, SupportedLocaleSchema, type JsonValue, type OperationRecord, type ResourceRef, type RollbackPoint, type WikiFrontmatter } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { wikiWriteValueSchema } from "../../value-objects/wiki.js";
import { wikiJsonRecord } from "./state-transition.js";

const Input = z.object({
  "content": z.string() .optional(),
  "content_locale": SupportedLocaleSchema.optional(),
  "provenance": ProvenanceSchema.optional(),
  "pinned": z.boolean().optional(),
  "expected_resource_version": z.number().int().positive().optional(),
  "source_refs": z.array(ResourceRefSchema.strict()).optional(),
  "tags": z.array(z.string().trim().min(1)).optional(),
  "title": z.string().trim().min(1).optional(),
  "wiki_id": z.string().trim().min(1)
}).strict();
const Output = wikiWriteValueSchema;
type InputValue = z.infer<typeof Input>;
type OutputValue = z.infer<typeof Output>;

export interface WikiPatchPorts {
  getWikiPage(id: string): Promise<OutputValue["resource"] | undefined>;
  readWikiContent(id: string): Promise<string | undefined>;
  updateWikiPage(input: { id: string; title?: string; content?: string; tags?: string[]; content_locale?: InputValue["content_locale"]; source_refs?: WikiFrontmatter["source_refs"]; provenance?: WikiFrontmatter["provenance"]; pinned?: boolean; expected_resource_version?: number }): Promise<OutputValue["resource"] | undefined>;
  mapWikiWriteError(error: unknown): Error;
  wikiPageNotFoundError(id: string): Error;
  createWikiRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runWikiMutation(input: { trustedContext: TrustedDomainContext; operationName: "wiki.patch"; proposedEffects: string[]; inputSummary: string; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: OutputValue["resource"]; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<OutputValue>;
}

const wikiPatch = defineCommand<WikiPatchPorts>()({
  ...{
  "kind": "command",
  "id": "wiki.patch",
  "version": "3.0",
  "availability": "active",
  "title": "Patch Knowledge Wiki page",
  "description": "Edit Knowledge Wiki frontmatter or markdown content.",
  "sources": [
    "runtime_api",
    "external_app"
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
        const current = await ports.getWikiPage(input.wiki_id);
        if (!current) throw ports.wikiPageNotFoundError(input.wiki_id);
        const beforeContent = await ports.readWikiContent(input.wiki_id);
        const update = { id: input.wiki_id, title: input.title, content: input.content, tags: input.tags, content_locale: input.content_locale, source_refs: input.source_refs, provenance: input.provenance, pinned: input.pinned, expected_resource_version: input.expected_resource_version };
        const currentRef: ResourceRef = { kind: "wiki", id: current.id, uri: current.file_path, label: current.title };
        const value = await ports.runWikiMutation({ trustedContext: context, operationName: "wiki.patch", inputSummary: `Patch wiki page: ${current.title}`,
          proposedEffects: ["Edit wiki page frontmatter or markdown content."], targetResourceRefs: [currentRef], execute: async (operation) => {
          let saved;
          try {
            saved = await ports.updateWikiPage(update);
          } catch (error) {
            throw ports.mapWikiWriteError(error);
          }
          if (!saved) throw ports.wikiPageNotFoundError(input.wiki_id);
          const ref: ResourceRef = { kind: "wiki", id: saved.id, uri: saved.file_path, label: saved.title };
          const rollbackPoint = await ports.createWikiRollback(operation, [ref], { wiki: wikiJsonRecord(current), content: beforeContent ?? "" }, { wiki: wikiJsonRecord(saved), content: input.content ?? beforeContent ?? "" });
          return { resource: saved, ref, rollbackPoint, summary: `Updated wiki page ${saved.title}.` };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default wikiPatch;
