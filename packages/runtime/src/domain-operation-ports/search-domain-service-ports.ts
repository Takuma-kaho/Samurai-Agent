import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "session.search" | "memory.search" | "wiki.search" | "skill.search" | "collection.search">;

export function createSearchDomainServicePorts(services: Pick<RuntimeDomainServices, "searchDomainService">): Ports {
  return {
    "session.search": readOnlyQueryPort<Ports["session.search"]>({
      searchSessions: (query, limit) => services.searchDomainService.searchSessions(query, limit)
    }),
    "memory.search": readOnlyQueryPort<Ports["memory.search"]>({
      searchMemory: (runId, query, limit) => services.searchDomainService.searchMemory(runId, query, limit)
    }),
    "wiki.search": readOnlyQueryPort<Ports["wiki.search"]>({
      searchWiki: (runId, query, limit) => services.searchDomainService.searchWiki(runId, query, limit)
    }),
    "skill.search": readOnlyQueryPort<Ports["skill.search"]>({
      searchSkills: (runId, query, limit) => services.searchDomainService.searchSkills(runId, query, limit)
    }),
    "collection.search": readOnlyQueryPort<Ports["collection.search"]>({
      searchCollections: (collectionId, query, limit) => services.searchDomainService.searchCollections(collectionId, query, limit)
    })
  };
}
