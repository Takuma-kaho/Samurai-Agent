import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "activity.history.list">;

export function createActivityHistoryDomainServicePorts(services: Pick<RuntimeDomainServices, "activityHistoryDomainService">): Ports {
  return {
    "activity.history.list": readOnlyQueryPort<Ports["activity.history.list"]>({
      listActivityHistory: (input) => services.activityHistoryDomainService.list(input)
    })
  };
}
