import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "external.send" | "external.send.dispatch" | "external.send.prepare">;

export function createExternalSendDomainServicePorts(services: Pick<RuntimeDomainServices, "externalSendDomainService">): Ports {
  return {
    "external.send": {
      executeExternalSend: async (context, input) => ({
        ok: true as const,
        value: await services.externalSendDomainService.request(input)
      })
    },
    "external.send.dispatch": {
      executeExternalSendDispatch: async (context, input) => ({
        ok: true as const,
        value: await services.externalSendDomainService.dispatch(input)
      })
    },
    "external.send.prepare": {
      executeExternalSendPrepare: async (context, input) => ({
        ok: true as const,
        value: await services.externalSendDomainService.prepare(input)
      })
    }
  };
}

