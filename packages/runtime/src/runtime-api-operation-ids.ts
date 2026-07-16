import { requireDomainCommandEntry } from "@samurai-agent/action-catalog";

const ids = {
  evaluationRun: "evaluation.run",
  memoryArchive: "memory.archive",
  reflectionRun: "reflection.run",
  reflectionSuggestionApply: "reflection.suggestion.apply",
  rollbackRestore: "rollback.restore",
  wikiProposalCreate: "wiki.proposal.create",
  wikiAccept: "wiki.accept",
  wikiReject: "wiki.reject",
  wikiArchive: "wiki.archive",
  wikiPatch: "wiki.patch",
  wikiReindex: "wiki.reindex"
} as const;

for (const id of Object.values(ids)) requireDomainCommandEntry(id);

export const runtimeApiOperationIds = Object.freeze(ids);
