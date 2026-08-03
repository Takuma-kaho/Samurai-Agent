import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "learning.background_review.apply">;

export function createCore05BackgroundReviewMutationDomainServicePorts(
  services: Pick<RuntimeDomainServices, "core05BackgroundReviewMutationDomainService">
): Ports {
  return {
    "learning.background_review.apply": {
      applyBackgroundReviewMutations: (input) => services.core05BackgroundReviewMutationDomainService.apply(input)
    }
  };
}
