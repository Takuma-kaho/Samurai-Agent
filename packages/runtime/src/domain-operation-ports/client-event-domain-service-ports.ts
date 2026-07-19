import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "client.event.ack" | "client.event.deliver" | "client.event.expire" | "client.event.fail" | "client.event.save">;

export function createClientEventDomainServicePorts(services: Pick<RuntimeDomainServices, "clientEventDomainService">): Ports {
  return {
    "client.event.ack": {
      acknowledgeClientEvent: (id) => services.clientEventDomainService.acknowledge(id),
      clientEventNotFoundError: () => services.clientEventDomainService.notFoundError()
    },
    "client.event.deliver": {
      deliverClientEvent: (id) => services.clientEventDomainService.deliver(id),
      clientEventNotFoundError: () => services.clientEventDomainService.notFoundError()
    },
    "client.event.expire": {
      expireClientEvents: (now) => services.clientEventDomainService.expire(now)
    },
    "client.event.fail": {
      failClientEvent: (id, errorCode) => services.clientEventDomainService.fail(id, errorCode),
      clientEventNotFoundError: () => services.clientEventDomainService.notFoundError()
    },
    "client.event.save": {
      saveClientEvent: (event) => services.clientEventDomainService.save(event)
    }
  };
}
