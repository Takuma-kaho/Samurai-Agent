import {
  type ActivityInboxItem,
  type JsonValue,
  type OperationRecord,
  type ResourceRef,
  type RollbackPoint,
  type SupportedLocale,
  type WikiFrontmatter
} from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";

export type StoredWiki = WikiFrontmatter & { file_path: string; resource_version: number };
interface WikiReindexResult {
  active: number;
  total: number;
  files: number;
  indexed: number;
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: Array<{ file_path: string; message: string }>;
}
type WikiInput = {
  id: string; title?: string; content?: string; tags?: string[]; content_locale?: SupportedLocale;
  source_refs?: WikiFrontmatter["source_refs"]; provenance?: WikiFrontmatter["provenance"]; usage_scope?: WikiFrontmatter["usage_scope"]; pinned?: boolean; expected_resource_version?: number;
};
export interface WikiWriteResult<T> { resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }
export interface WikiMutationInput<T> {
  trustedContext: TrustedDomainContext;
  operationName: string;
  proposedEffects: string[];
  inputSummary?: string;
  targetResourceRefs?: ResourceRef[];
  boundaryResourceRefs?: ResourceRef[];
  /** The handler owns the destination boundary transaction itself. */
  resultResourceBoundaryMode?: "managed_by_operation";
  /** A scope move changes its source boundary within the same transaction. */
  skipPostMutationTargetBoundaryCheck?: boolean;
  execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }>;
}

export interface WikiExecutionPort {
  get(id: string): Promise<StoredWiki | undefined>;
  readContent(id: string): Promise<string | undefined>;
  save(record: WikiFrontmatter, content: string): Promise<StoredWiki>;
  copy(input: {
    source_id: string;
    target_id: string;
    target_slug: string;
    target_usage_scope: NonNullable<WikiFrontmatter["usage_scope"]>;
    expected_source_resource_version: number;
    target_boundary?: { sourceRoomId: string; ownerParticipantId: string; creatorParticipantId?: string; resourceCreatedAt?: string };
  }): Promise<StoredWiki | undefined>;
  move(input: {
    id: string;
    source_room_id: string;
    target_room_id: string;
    expected_resource_version: number;
  }): Promise<StoredWiki | undefined>;
  update(input: WikiInput): Promise<StoredWiki | undefined>;
  setState(id: string, state: WikiFrontmatter["state"], expectedResourceVersion?: number): Promise<StoredWiki | undefined>;
  reindex(): Promise<WikiReindexResult>;
  defaultOutputLocale(): Promise<SupportedLocale>;
  runMutation<T>(input: WikiMutationInput<T>): Promise<WikiWriteResult<T>>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  requestError(code: "not_found", message: string): Error;
  mapWriteError(error: unknown): Error;
}

export class WikiDomainService {
  constructor(private readonly dependencies: { wiki: WikiExecutionPort }) {}

  defaultWikiOutputLocale() { return this.dependencies.wiki.defaultOutputLocale(); }
  reindexWikiPages() { return this.dependencies.wiki.reindex(); }
  runWikiMutation<T>(input: WikiMutationInput<T>): Promise<WikiWriteResult<T>> { return this.dependencies.wiki.runMutation(input); }
  getWikiPage(id: string) { return this.dependencies.wiki.get(id); }
  setWikiPageState(id: string, state: WikiFrontmatter["state"], expectedResourceVersion?: number) {
    return this.dependencies.wiki.setState(id, state, expectedResourceVersion);
  }
  createWikiRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.dependencies.wiki.createRollback(operation, refs, before, after); }
  wikiPageNotFoundError(id: string) { return this.dependencies.wiki.requestError("not_found", `Wiki page not found: ${id}`); }
  mapWikiWriteError(error: unknown) { return this.dependencies.wiki.mapWriteError(error); }
  saveWikiPage(record: WikiFrontmatter, content: string) { return this.dependencies.wiki.save(record, content); }
  copyWikiPage(input: Parameters<WikiExecutionPort["copy"]>[0]) { return this.dependencies.wiki.copy(input); }
  moveWikiPage(input: Parameters<WikiExecutionPort["move"]>[0]) { return this.dependencies.wiki.move(input); }
  readWikiContent(id: string) { return this.dependencies.wiki.readContent(id); }
  updateWikiPage(input: WikiInput) { return this.dependencies.wiki.update(input); }


}
