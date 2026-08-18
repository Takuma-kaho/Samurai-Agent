import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "policy.change.request" | "profile.change.request" | "soul.change.request">;

export function createHumanChangeRequestDomainServicePorts(
  services: Pick<RuntimeDomainServices, "humanChangeRequestDomainService">
): Ports {
  return {
    "policy.change.request": {
      requestHumanChange: (context, input) => services.humanChangeRequestDomainService.request(context, input)
    },
    "profile.change.request": {
      requestHumanChange: (context, input) => services.humanChangeRequestDomainService.request(context, input)
    },
    "soul.change.request": {
      requestHumanChange: (context, input) => services.humanChangeRequestDomainService.request(context, input)
    }
  };
}
