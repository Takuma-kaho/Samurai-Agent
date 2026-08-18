import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "workspace.context.get">;

export function createWorkspaceContextDomainServicePorts(services: Pick<RuntimeDomainServices, "workspaceContextDomainService">): Ports {
  return {
    "workspace.context.get": readOnlyQueryPort<Ports["workspace.context.get"]>({
      getWorkspaceContext: (context, input) => services.workspaceContextDomainService.get(context, input)
    })
  };
}
