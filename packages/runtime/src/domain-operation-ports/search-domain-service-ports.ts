import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "session.search" | "memory.search" | "wiki.search" | "skill.search" | "collection.search">;

export function createSearchDomainServicePorts(services: Pick<RuntimeDomainServices, "searchDomainService">): Ports {
  return {
    "session.search": readOnlyQueryPort<Ports["session.search"]>({
      searchSessions: (context, query, limit) => services.searchDomainService.searchSessions(context, query, limit)
    }),
    "memory.search": readOnlyQueryPort<Ports["memory.search"]>({
      searchMemory: (context, query, limit, offset) => services.searchDomainService.searchMemory(context, query, limit, offset)
    }),
    "wiki.search": readOnlyQueryPort<Ports["wiki.search"]>({
      searchWiki: (context, query, limit, offset) => services.searchDomainService.searchWiki(context, query, limit, offset)
    }),
    "skill.search": readOnlyQueryPort<Ports["skill.search"]>({
      searchSkills: (context, query, limit, offset) => services.searchDomainService.searchSkills(context, query, limit, offset)
    }),
    "collection.search": readOnlyQueryPort<Ports["collection.search"]>({
      searchCollections: (context, collectionId, query, limit, offset) => services.searchDomainService.searchCollections(context, collectionId, query, limit, offset)
    })
  };
}
