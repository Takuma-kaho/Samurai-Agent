import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "resource.redact">;

/** The external contract receives one formal Runtime service, never a Store
 * handle or direct markdown path. */
export function createResourceRedactionDomainServicePorts(
  services: Pick<RuntimeDomainServices, "resourceRedactionDomainService">
): Ports {
  return {
    "resource.redact": {
      redactResource: (context, input) => services.resourceRedactionDomainService.redact(context, input)
    }
  };
}
