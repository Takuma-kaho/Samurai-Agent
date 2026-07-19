import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "wiki.accept" | "wiki.archive" | "wiki.patch" | "wiki.proposal.create" | "wiki.reindex" | "wiki.reject">;

export function createWikiDomainServicePorts(services: Pick<RuntimeDomainServices, "wikiDomainService">): Ports {
  return {
    "wiki.accept": {
      getWikiPage: (id) => services.wikiDomainService.getWikiPage(id),
      setWikiPageState: (id, state) => services.wikiDomainService.setWikiPageState(id, state),
      ensureWikiSession: () => services.wikiDomainService.ensureWikiSession(), createWikiEnvelope: (content) => services.wikiDomainService.createWikiEnvelope(content),
      wikiPageNotFoundError: (id) => services.wikiDomainService.wikiPageNotFoundError(id),
      createWikiRollback: (operation, refs, before, after) => services.wikiDomainService.createWikiRollback(operation, refs, before, after),
      runWikiMutation: (input) => services.wikiDomainService.runWikiMutation(input)
    },
    "wiki.archive": {
      getWikiPage: (id) => services.wikiDomainService.getWikiPage(id), setWikiPageState: (id, state) => services.wikiDomainService.setWikiPageState(id, state),
      ensureWikiSession: () => services.wikiDomainService.ensureWikiSession(), createWikiEnvelope: (content) => services.wikiDomainService.createWikiEnvelope(content),
      wikiPageNotFoundError: (id) => services.wikiDomainService.wikiPageNotFoundError(id), createWikiRollback: (operation, refs, before, after) => services.wikiDomainService.createWikiRollback(operation, refs, before, after),
      runWikiMutation: (input) => services.wikiDomainService.runWikiMutation(input)
    },
    "wiki.patch": {
      getWikiPage: (id) => services.wikiDomainService.getWikiPage(id), readWikiContent: (id) => services.wikiDomainService.readWikiContent(id),
      updateWikiPage: (input) => services.wikiDomainService.updateWikiPage(input),
      ensureWikiSession: () => services.wikiDomainService.ensureWikiSession(), createWikiEnvelope: (content) => services.wikiDomainService.createWikiEnvelope(content),
      wikiPageNotFoundError: (id) => services.wikiDomainService.wikiPageNotFoundError(id), createWikiRollback: (operation, refs, before, after) => services.wikiDomainService.createWikiRollback(operation, refs, before, after),
      runWikiMutation: (input) => services.wikiDomainService.runWikiMutation(input)
    },
    "wiki.proposal.create": {
      ensureWikiSession: () => services.wikiDomainService.ensureWikiSession(), createWikiEnvelope: (content) => services.wikiDomainService.createWikiEnvelope(content),
      saveWikiPage: (record, content) => services.wikiDomainService.saveWikiPage(record, content),
      createWikiRollback: (operation, refs, before, after) => services.wikiDomainService.createWikiRollback(operation, refs, before, after),
      runWikiMutation: (input) => services.wikiDomainService.runWikiMutation(input)
    },
    "wiki.reindex": {
      ensureWikiSession: () => services.wikiDomainService.ensureWikiSession(),
      createWikiEnvelope: (content) => services.wikiDomainService.createWikiEnvelope(content),
      reindexWikiPages: () => services.wikiDomainService.reindexWikiPages(),
      runWikiMutation: (input) => services.wikiDomainService.runWikiMutation(input)
    },
    "wiki.reject": {
      getWikiPage: (id) => services.wikiDomainService.getWikiPage(id), setWikiPageState: (id, state) => services.wikiDomainService.setWikiPageState(id, state),
      ensureWikiSession: () => services.wikiDomainService.ensureWikiSession(), createWikiEnvelope: (content) => services.wikiDomainService.createWikiEnvelope(content),
      wikiPageNotFoundError: (id) => services.wikiDomainService.wikiPageNotFoundError(id), createWikiRollback: (operation, refs, before, after) => services.wikiDomainService.createWikiRollback(operation, refs, before, after),
      runWikiMutation: (input) => services.wikiDomainService.runWikiMutation(input)
    }
  };
}
