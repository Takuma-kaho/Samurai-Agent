import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "learning.resource.usage.record">;

export function createLearningResourceUseDomainServicePorts(
  services: Pick<RuntimeDomainServices, "learningResourceUseDomainService">
): Ports {
  return {
    "learning.resource.usage.record": {
      recordAppliedLearningResourceUse: (input) => services.learningResourceUseDomainService.recordAppliedResourceUse(input)
    }
  };
}
