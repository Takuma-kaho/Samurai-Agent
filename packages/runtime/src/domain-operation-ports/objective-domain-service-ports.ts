import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "objective.create" | "objective.transition">;

export function createObjectiveDomainServicePorts(services: Pick<RuntimeDomainServices, "objectiveDomainService">): Ports {
  return {
    "objective.create": {
      executeObjectiveCreate: async (context, input) => ({
        ok: true as const,
        value: await services.objectiveDomainService.create(input)
      })
    },
    "objective.transition": {
      executeObjectiveTransition: async (context, input) => ({
        ok: true as const,
        value: await services.objectiveDomainService.transition(input)
      })
    }
  };
}

