import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "objective.create" | "objective.transition">;

export function createObjectiveDomainServicePorts(services: Pick<RuntimeDomainServices, "objectiveDomainService">): Ports {
  return {
    "objective.create": {
      saveObjective: (record) => services.objectiveDomainService.save(record)
    },
    "objective.transition": {
      transitionObjective: (id, action) => services.objectiveDomainService.transition(id, action)
    }
  };
}
