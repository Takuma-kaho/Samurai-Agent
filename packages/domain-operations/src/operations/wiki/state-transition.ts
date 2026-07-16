import type { ActivityInboxItem, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord, WikiFrontmatter } from "@samurai-agent/core-schemas";
import type { z } from "zod";
import { storedWikiSchema } from "../../value-objects/wiki.js";

type StoredWiki = z.infer<typeof storedWikiSchema>;
type WikiStateOperation = "wiki.accept" | "wiki.archive" | "wiki.reject";

export interface WikiStateTransitionPorts {
  getWikiPage(id: string): Promise<StoredWiki | undefined>;
  setWikiPageState(id: string, state: WikiFrontmatter["state"]): Promise<StoredWiki | undefined>;
  ensureWikiSession(): Promise<SessionRecord>;
  createWikiEnvelope(content: string): MessageEnvelope;
  wikiPageNotFoundError(id: string): Error;
  createWikiRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runWikiMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: WikiStateOperation; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: StoredWiki; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: StoredWiki; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

export async function executeWikiStateTransition(ports: WikiStateTransitionPorts, input: {
  id: string; state: WikiFrontmatter["state"]; operationName: WikiStateOperation; proposedEffect: string; summaryPrefix: string;
}) {
  const current = await ports.getWikiPage(input.id);
  if (!current) throw ports.wikiPageNotFoundError(input.id);
  const session = await ports.ensureWikiSession();
  const envelope = ports.createWikiEnvelope(`${input.summaryPrefix}: ${current.title}`);
  const currentRef = wikiRef(current);
  return ports.runWikiMutation({ session, envelope, operationName: input.operationName, proposedEffects: [input.proposedEffect], targetResourceRefs: [currentRef], execute: async (operation) => {
    const saved = await ports.setWikiPageState(input.id, input.state);
    if (!saved) throw ports.wikiPageNotFoundError(input.id);
    const ref = wikiRef(saved);
    const rollbackPoint = await ports.createWikiRollback(operation, [ref], { wiki: wikiJsonRecord(current) }, { wiki: wikiJsonRecord(saved) });
    return { resource: saved, ref, rollbackPoint, summary: `${input.summaryPrefix} ${saved.title}.` };
  }});
}

function wikiRef(wiki: StoredWiki): ResourceRef { return { kind: "wiki", id: wiki.id, uri: wiki.file_path, label: wiki.title }; }
export function wikiJsonRecord(wiki: StoredWiki): Record<string, JsonValue> { return JSON.parse(JSON.stringify(wiki)) as Record<string, JsonValue>; }
