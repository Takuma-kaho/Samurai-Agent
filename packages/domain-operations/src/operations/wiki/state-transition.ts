import type { ActivityInboxItem, JsonValue, OperationRecord, ResourceRef, RollbackPoint, WikiFrontmatter } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import type { z } from "zod";
import { storedWikiSchema } from "../../value-objects/wiki.js";

type StoredWiki = z.infer<typeof storedWikiSchema>;
type WikiStateOperation = "wiki.accept" | "wiki.archive" | "wiki.reject";

export interface WikiStateTransitionPorts {
  getWikiPage(id: string): Promise<StoredWiki | undefined>;
  setWikiPageState(id: string, state: WikiFrontmatter["state"], expectedResourceVersion?: number): Promise<StoredWiki | undefined>;
  mapWikiWriteError(error: unknown): Error;
  wikiPageNotFoundError(id: string): Error;
  createWikiRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runWikiMutation(input: { trustedContext: TrustedDomainContext; operationName: WikiStateOperation; proposedEffects: string[]; inputSummary: string; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: StoredWiki; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: StoredWiki; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

export async function executeWikiStateTransition(ports: WikiStateTransitionPorts, input: {
  context: TrustedDomainContext; id: string; state: WikiFrontmatter["state"]; expectedResourceVersion?: number; operationName: WikiStateOperation; proposedEffect: string; summaryPrefix: string;
}) {
  const current = await ports.getWikiPage(input.id);
  if (!current) throw ports.wikiPageNotFoundError(input.id);
  const currentRef = wikiRef(current);
  return ports.runWikiMutation({ trustedContext: input.context, operationName: input.operationName, inputSummary: `${input.summaryPrefix}: ${current.title}`,
    proposedEffects: [input.proposedEffect], targetResourceRefs: [currentRef], execute: async (operation) => {
    let saved;
    try {
      // Every state transition is a compare-and-set, including callers that
      // do not provide a client version. The version read above is the
      // operation's snapshot and prevents a concurrent archive/reject/write
      // from being silently overwritten.
      const expectedResourceVersion = input.expectedResourceVersion ?? current.resource_version;
      saved = await ports.setWikiPageState(input.id, input.state, expectedResourceVersion);
    } catch (error) {
      throw ports.mapWikiWriteError(error);
    }
    if (!saved) throw ports.wikiPageNotFoundError(input.id);
    const ref = wikiRef(saved);
    const rollbackPoint = await ports.createWikiRollback(operation, [ref], { wiki: wikiJsonRecord(current) }, { wiki: wikiJsonRecord(saved) });
    return { resource: saved, ref, rollbackPoint, summary: `${input.summaryPrefix} ${saved.title}.` };
  }});
}

function wikiRef(wiki: StoredWiki): ResourceRef { return { kind: "wiki", id: wiki.id, uri: wiki.file_path, label: wiki.title }; }
export function wikiJsonRecord(wiki: StoredWiki): Record<string, JsonValue> { return JSON.parse(JSON.stringify(wiki)) as Record<string, JsonValue>; }
