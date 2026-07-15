import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "message.presentation.update" | "presentation.plan">;

export function createPresentationDomainServicePorts(services: Pick<RuntimeDomainServices, "presentationDomainService">): Ports {
  return {
    "message.presentation.update": {
      executeMessagePresentationUpdate: async (context, input) => ({
        ok: true as const,
        value: await services.presentationDomainService.update(input)
      })
    },
    "presentation.plan": {
      executePresentationPlan: async (context, input) => ({
        ok: true as const,
        value: await services.presentationDomainService.plan(input)
      })
    }
  };
}

