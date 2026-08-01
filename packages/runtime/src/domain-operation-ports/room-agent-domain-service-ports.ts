import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "room.create" | "room.patch" | "room.list" | "room.view" | "agent.create" | "agent.patch" | "agent.backend.bind" | "agent.list" | "agent.view">;

export function createRoomAgentDomainServicePorts(services: Pick<RuntimeDomainServices, "roomAgentDomainService">): Ports {
  return {
    "room.create": { createRoom: (input) => services.roomAgentDomainService.createRoom(input) },
    "room.patch": { patchRoom: (input) => services.roomAgentDomainService.patchRoom(input) },
    "room.list": readOnlyQueryPort<DomainOperationPorts["room.list"]>({ listRooms: () => services.roomAgentDomainService.listRooms() }),
    "room.view": readOnlyQueryPort<DomainOperationPorts["room.view"]>({ viewRoom: (id) => services.roomAgentDomainService.viewRoom(id) }),
    "agent.create": { createAgent: (input) => services.roomAgentDomainService.createAgent(input) },
    "agent.patch": { patchAgent: (input) => services.roomAgentDomainService.patchAgent(input) },
    "agent.backend.bind": { bindAgentBackend: (input) => services.roomAgentDomainService.bindAgentBackend(input) },
    "agent.list": readOnlyQueryPort<DomainOperationPorts["agent.list"]>({ listAgents: () => services.roomAgentDomainService.listAgents() }),
    "agent.view": readOnlyQueryPort<DomainOperationPorts["agent.view"]>({ viewAgent: (id) => services.roomAgentDomainService.viewAgent(id) })
  };
}
