import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "wiki.accept" | "wiki.archive" | "wiki.patch" | "wiki.proposal.create" | "wiki.reindex" | "wiki.reject">;

export function createWikiDomainServicePorts(services: Pick<RuntimeDomainServices, "wikiDomainService">): Ports {
  return {
    "wiki.accept": {
      executeWikiAccept: async (context, input) => ({
        ok: true as const,
        value: await services.wikiDomainService.accept(input)
      })
    },
    "wiki.archive": {
      executeWikiArchive: async (context, input) => ({
        ok: true as const,
        value: await services.wikiDomainService.archive(input)
      })
    },
    "wiki.patch": {
      executeWikiPatch: async (context, input) => ({
        ok: true as const,
        value: await services.wikiDomainService.patch(input)
      })
    },
    "wiki.proposal.create": {
      executeWikiProposalCreate: async (context, input) => ({
        ok: true as const,
        value: await services.wikiDomainService.createProposal(input)
      })
    },
    "wiki.reindex": {
      executeWikiReindex: async (context, input) => ({
        ok: true as const,
        value: await services.wikiDomainService.reindex()
      })
    },
    "wiki.reject": {
      executeWikiReject: async (context, input) => ({
        ok: true as const,
        value: await services.wikiDomainService.reject(input)
      })
    }
  };
}

