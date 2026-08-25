import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "plugin.status.set">;

export function createPluginDomainServicePorts(services: Pick<RuntimeDomainServices, "pluginDomainService">): Ports {
  return {
    "plugin.status.set": {
      setPluginEnabled: (id, enabled) => services.pluginDomainService.setEnabled(id, enabled),
      getPluginEnabled: (id) => services.pluginDomainService.getEnabled(id),
      findPluginStatus: (id) => {
        const status = services.pluginDomainService.findStatus(id);
        return status ? { manifest_id: status.manifest_id, version: status.version } : undefined;
      },
      savePluginState: (input) => services.pluginDomainService.saveState(input),
      pluginNotFoundError: () => services.pluginDomainService.notFoundError()
    }
  };
}
