import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "settings.patch">;

export function createSettingsDomainServicePorts(services: Pick<RuntimeDomainServices, "settingsDomainService">): Ports {
  return {
    "settings.patch": {
      executeSettingsPatch: async (context, input) => ({
        ok: true as const,
        value: await services.settingsDomainService.patch(input)
      })
    }
  };
}

