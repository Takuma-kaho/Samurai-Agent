import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "client.event.ack" | "client.event.deliver" | "client.event.expire" | "client.event.fail" | "client.event.save">;

export function createClientEventDomainServicePorts(services: Pick<RuntimeDomainServices, "clientEventDomainService">): Ports {
  return {
    "client.event.ack": {
      executeClientEventAck: async (context, input) => ({
        ok: true as const,
        value: await services.clientEventDomainService.acknowledge(input)
      })
    },
    "client.event.deliver": {
      executeClientEventDeliver: async (context, input) => ({
        ok: true as const,
        value: await services.clientEventDomainService.deliver(input)
      })
    },
    "client.event.expire": {
      executeClientEventExpire: async (context, input) => ({
        ok: true as const,
        value: await services.clientEventDomainService.expire(input)
      })
    },
    "client.event.fail": {
      executeClientEventFail: async (context, input) => ({
        ok: true as const,
        value: await services.clientEventDomainService.fail(input)
      })
    },
    "client.event.save": {
      executeClientEventSave: async (context, input) => ({
        ok: true as const,
        value: await services.clientEventDomainService.save(input)
      })
    }
  };
}

