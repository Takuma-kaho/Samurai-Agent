import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "resource.version.get">;

export function createResourceVersionDomainServicePorts(services: Pick<RuntimeDomainServices, "resourceVersionDomainService">): Ports {
  return {
    "resource.version.get": readOnlyQueryPort<Ports["resource.version.get"]>({
      getResourceVersion: (context, input) => services.resourceVersionDomainService.get(context, input)
    })
  };
}
