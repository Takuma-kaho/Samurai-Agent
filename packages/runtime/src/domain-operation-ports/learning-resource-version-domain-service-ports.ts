import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "learning.resource.version.restore" | "learning.resource.version.update">;

export function createLearningResourceVersionDomainServicePorts(
  services: Pick<RuntimeDomainServices, "learningResourceVersionDomainService">
): Ports {
  return {
    "learning.resource.version.restore": {
      restoreLearningResourceVersion: (input) => services.learningResourceVersionDomainService.restore(input)
    },
    "learning.resource.version.update": {
      updateLearningResourceVersion: (input) => services.learningResourceVersionDomainService.update(input)
    }
  };
}
