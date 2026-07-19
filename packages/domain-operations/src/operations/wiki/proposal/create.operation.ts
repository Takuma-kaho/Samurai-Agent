// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ProvenanceSchema, ResourceRefSchema, SupportedLocaleSchema, createId, nowIso, type JsonValue, type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord, type WikiFrontmatter } from "@samurai-agent/core-schemas";
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
  ensureWikiSession(): Promise<SessionRecord>; createWikiEnvelope(content: string): MessageEnvelope;
  saveWikiPage(record: WikiFrontmatter, content: string): Promise<OutputValue["resource"]>;
  createWikiRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runWikiMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: "wiki.proposal.create"; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: OutputValue["resource"]; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<OutputValue>;
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
        const session = await ports.ensureWikiSession();
        const envelope = ports.createWikiEnvelope(`Create wiki proposal: ${input.title}`);
        const now = nowIso();
        const wiki: WikiFrontmatter = {
          id: createId("wiki"), slug: slugify(input.slug ?? input.title), title: input.title, state: "proposed",
          content_locale: input.content_locale ?? session.output_locale, tags: input.tags, source_refs: input.source_refs,
          provenance: input.provenance ?? { kind: "user_authored", summary: "Created from an explicit local request.", verified: true },
          created_at: now, updated_at: now
        };
        const value = await ports.runWikiMutation({ session, envelope, operationName: "wiki.proposal.create", proposedEffects: ["Create a proposed wiki markdown page."], execute: async (operation) => {
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
