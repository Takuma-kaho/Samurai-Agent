import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "resource.copy" | "resource.move" | "resource.promote">;

/** Keeps the public handlers dependent on a small, formal Runtime service
 * rather than on Workspace Store or a Client adapter. */
export function createResourceTransferDomainServicePorts(
  services: Pick<RuntimeDomainServices, "resourceTransferDomainService">
): Ports {
  return {
    "resource.copy": {
      copyResource: (context, input) => services.resourceTransferDomainService.copy(context, input)
    },
    "resource.move": {
      moveResource: (context, input) => services.resourceTransferDomainService.move(context, input)
    },
    "resource.promote": {
      promoteResource: (context, input) => services.resourceTransferDomainService.promote(context, input)
    }
  };
}
