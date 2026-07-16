import {
  ProvenanceSchema,
  ResourceRefSchema,
  createId,
  nowIso,
  supportedLocales,
  type ActivityInboxItem,
  type JsonValue,
  type MessageEnvelope,
  type OperationRecord,
  type ResourceRef,
  type RollbackPoint,
  type SessionRecord,
  type SupportedLocale,
  type WikiFrontmatter
} from "@samurai-agent/core-schemas";
import { z } from "zod";
import type { WikiReindexResult } from "@samurai-agent/workspace-store";
import { jsonValue } from "./json-value.js";

type StoredWiki = WikiFrontmatter & { file_path: string };
type WikiInput = {
  id: string; title?: string; content?: string; tags?: string[]; content_locale?: SupportedLocale;
  source_refs?: WikiFrontmatter["source_refs"]; provenance?: WikiFrontmatter["provenance"];
};
type WikiProposalInput = Omit<WikiInput, "id"> & { title: string; content: string; slug?: string };
interface WikiWriteResult<T> { resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }

export interface WikiExecutionPort {
  get(id: string): Promise<StoredWiki | undefined>;
  readContent(id: string): Promise<string | undefined>;
  save(record: WikiFrontmatter, content: string): Promise<StoredWiki>;
  update(input: WikiInput): Promise<StoredWiki | undefined>;
  setState(id: string, state: WikiFrontmatter["state"]): Promise<StoredWiki | undefined>;
  reindex(): Promise<WikiReindexResult>;
  ensureSession(): Promise<SessionRecord>;
  createEnvelope(content: string): MessageEnvelope;
  runMutation<T>(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<WikiWriteResult<T>>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  requestError(code: "not_found", message: string): Error;
}

export class WikiDomainService {
  constructor(private readonly dependencies: {
    wiki: WikiExecutionPort;
    conflictError: (message: string) => Error;
  }) {}

  accept(payload: Record<string, JsonValue>) { return this.changeState(requiredId(payload, "wiki_id"), "active", "wiki.accept", "Accept a wiki proposal for active retrieval.", "Accepted wiki page"); }
  archive(payload: Record<string, JsonValue>) { return this.changeState(requiredId(payload, "wiki_id"), "archived", "wiki.archive", "Archive a wiki page without deleting its markdown.", "Archived wiki page"); }
  reject(payload: Record<string, JsonValue>) { return this.changeState(requiredId(payload, "wiki_id"), "rejected", "wiki.reject", "Reject a wiki proposal without deleting its markdown.", "Rejected wiki page"); }
  reindex() { return this.reindexAll(); }

  patch(payload: Record<string, JsonValue>) {
    return this.patchInput({
      id: requiredId(payload, "wiki_id"),
      title: optionalString(payload.title) || undefined,
      content: typeof payload.content === "string" ? payload.content : undefined,
      tags: Array.isArray(payload.tags) ? stringArray(payload.tags) : undefined,
      content_locale: locale(payload.content_locale),
      source_refs: sourceRefs(payload.source_refs),
      provenance: provenance(payload.provenance)
    });
  }

  createProposal(payload: Record<string, JsonValue>) {
    const title = optionalString(payload.title);
    const content = optionalString(payload.content);
    if (!title || !content) throw this.dependencies.conflictError("domain_command_wiki_title_content_required");
    return this.createProposalInput({
      title, content,
      slug: optionalString(payload.slug) || undefined,
      tags: stringArray(payload.tags),
      content_locale: locale(payload.content_locale),
      source_refs: sourceRefs(payload.source_refs),
      provenance: provenance(payload.provenance)
    });
  }

  async createProposalInput(input: WikiProposalInput): Promise<WikiWriteResult<StoredWiki>> {
    const session = await this.dependencies.wiki.ensureSession();
    const envelope = this.dependencies.wiki.createEnvelope(`Create wiki proposal: ${input.title}`);
    const now = nowIso();
    const wiki: WikiFrontmatter = {
      id: createId("wiki"), slug: slugify(input.slug ?? input.title), title: input.title, state: "proposed",
      content_locale: input.content_locale ?? session.output_locale, tags: input.tags ?? [], source_refs: input.source_refs ?? [],
      provenance: input.provenance ?? { kind: "user_authored", summary: "Created from an explicit local request.", verified: true },
      created_at: now, updated_at: now
    };
    return this.dependencies.wiki.runMutation({ session, envelope, operationName: "wiki.proposal.create", proposedEffects: ["Create a proposed wiki markdown page."], execute: async (operation) => {
      const saved = await this.dependencies.wiki.save(wiki, input.content); const ref = wikiRef(saved);
      const rollbackPoint = await this.dependencies.wiki.createRollback(operation, [ref], {}, { wiki_id: saved.id });
      return { resource: saved, ref, rollbackPoint, summary: `Created wiki proposal ${saved.title}.` };
    }});
  }

  async patchInput(input: WikiInput): Promise<WikiWriteResult<StoredWiki>> {
    const current = await this.dependencies.wiki.get(input.id);
    if (!current) throw this.dependencies.wiki.requestError("not_found", `Wiki page not found: ${input.id}`);
    const beforeContent = await this.dependencies.wiki.readContent(input.id);
    const session = await this.dependencies.wiki.ensureSession(); const envelope = this.dependencies.wiki.createEnvelope(`Patch wiki page: ${current.title}`);
    return this.dependencies.wiki.runMutation({ session, envelope, operationName: "wiki.patch", proposedEffects: ["Edit wiki page frontmatter or markdown content."], execute: async (operation) => {
      const saved = await this.dependencies.wiki.update(input);
      if (!saved) throw this.dependencies.wiki.requestError("not_found", `Wiki page not found: ${input.id}`);
      const ref = wikiRef(saved); const rollbackPoint = await this.dependencies.wiki.createRollback(operation, [ref], { wiki: jsonValue(current), content: beforeContent ?? "" }, { wiki: jsonValue(saved), content: input.content ?? beforeContent ?? "" });
      return { resource: saved, ref, rollbackPoint, summary: `Updated wiki page ${saved.title}.` };
    }});
  }

  changeState(id: string, state: WikiFrontmatter["state"], operationName: string, effect: string, summaryPrefix: string): Promise<WikiWriteResult<StoredWiki>> {
    return this.updateState(id, state, operationName, effect, summaryPrefix);
  }

  private async updateState(id: string, state: WikiFrontmatter["state"], operationName: string, effect: string, summaryPrefix: string): Promise<WikiWriteResult<StoredWiki>> {
    const current = await this.dependencies.wiki.get(id);
    if (!current) throw this.dependencies.wiki.requestError("not_found", `Wiki page not found: ${id}`);
    const session = await this.dependencies.wiki.ensureSession(); const envelope = this.dependencies.wiki.createEnvelope(`${summaryPrefix}: ${current.title}`);
    return this.dependencies.wiki.runMutation({ session, envelope, operationName, proposedEffects: [effect], targetResourceRefs: [wikiRef(current)], execute: async (operation) => {
      const saved = await this.dependencies.wiki.setState(id, state);
      if (!saved) throw this.dependencies.wiki.requestError("not_found", `Wiki page not found: ${id}`);
      const ref = wikiRef(saved); const rollbackPoint = await this.dependencies.wiki.createRollback(operation, [ref], { wiki: jsonValue(current) }, { wiki: jsonValue(saved) });
      return { resource: saved, ref, rollbackPoint, summary: `${summaryPrefix} ${saved.title}.` };
    }});
  }

  private async reindexAll(): Promise<WikiWriteResult<WikiReindexResult>> {
    const session = await this.dependencies.wiki.ensureSession(); const envelope = this.dependencies.wiki.createEnvelope("Reindex wiki pages");
    return this.dependencies.wiki.runMutation({ session, envelope, operationName: "wiki.reindex", proposedEffects: ["Refresh the SQLite wiki index from markdown files."], execute: async () => {
      const resource = await this.dependencies.wiki.reindex(); const ref = { kind: "wiki_index", id: "active", uri: "wiki/pages", label: "Wiki index" };
      return { resource, ref, summary: `Reindexed ${resource.active} active wiki pages.` };
    }});
  }
}

function wikiRef(wiki: StoredWiki): ResourceRef { return { kind: "wiki", id: wiki.id, uri: wiki.file_path, label: wiki.title }; }
function slugify(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "wiki"; }

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
function requiredId(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]) || optionalString(payload.id);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}
function stringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return values.length ? values : undefined;
}
function locale(value: JsonValue | undefined): SupportedLocale | undefined {
  return typeof value === "string" && supportedLocales.includes(value as SupportedLocale) ? value as SupportedLocale : undefined;
}
function sourceRefs(value: JsonValue | undefined): WikiFrontmatter["source_refs"] | undefined {
  const parsed = z.array(ResourceRefSchema).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
function provenance(value: JsonValue | undefined): WikiFrontmatter["provenance"] | undefined {
  const parsed = ProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
