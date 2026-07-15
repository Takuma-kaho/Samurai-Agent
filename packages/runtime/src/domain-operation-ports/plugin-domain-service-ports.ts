import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "plugin.status.set">;

export function createPluginDomainServicePorts(services: Pick<RuntimeDomainServices, "pluginDomainService">): Ports {
  return {
    "plugin.status.set": {
      executePluginStatusSet: async (context, input) => ({
        ok: true as const,
        value: await services.pluginDomainService.setStatus(input)
      })
    }
  };
}

