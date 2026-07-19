import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "plugin.status.set">;

export function createPluginDomainServicePorts(services: Pick<RuntimeDomainServices, "pluginDomainService">): Ports {
  return {
    "plugin.status.set": {
      setPluginEnabled: (id, enabled) => services.pluginDomainService.setEnabled(id, enabled),
      findPluginStatus: (id) => services.pluginDomainService.findStatus(id),
      savePluginState: (input) => services.pluginDomainService.saveState(input),
      pluginNotFoundError: () => services.pluginDomainService.notFoundError()
    }
  };
}
