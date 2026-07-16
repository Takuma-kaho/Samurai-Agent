import {
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
import type { WikiReindexResult } from "@samurai-agent/workspace-store";

type StoredWiki = WikiFrontmatter & { file_path: string };
type WikiInput = {
  id: string; title?: string; content?: string; tags?: string[]; content_locale?: SupportedLocale;
  source_refs?: WikiFrontmatter["source_refs"]; provenance?: WikiFrontmatter["provenance"];
};
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
  constructor(private readonly dependencies: { wiki: WikiExecutionPort }) {}

  ensureWikiSession() { return this.dependencies.wiki.ensureSession(); }
  createWikiEnvelope(content: string) { return this.dependencies.wiki.createEnvelope(content); }
  reindexWikiPages() { return this.dependencies.wiki.reindex(); }
  runWikiMutation<T>(input: Parameters<WikiExecutionPort["runMutation"]>[0]) { return this.dependencies.wiki.runMutation(input) as Promise<WikiWriteResult<T>>; }
  getWikiPage(id: string) { return this.dependencies.wiki.get(id); }
  setWikiPageState(id: string, state: WikiFrontmatter["state"]) { return this.dependencies.wiki.setState(id, state); }
  createWikiRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.dependencies.wiki.createRollback(operation, refs, before, after); }
  wikiPageNotFoundError(id: string) { return this.dependencies.wiki.requestError("not_found", `Wiki page not found: ${id}`); }
  saveWikiPage(record: WikiFrontmatter, content: string) { return this.dependencies.wiki.save(record, content); }
  readWikiContent(id: string) { return this.dependencies.wiki.readContent(id); }
  updateWikiPage(input: WikiInput) { return this.dependencies.wiki.update(input); }


}
