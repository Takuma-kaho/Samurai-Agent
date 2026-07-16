import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "settings.patch">;

export function createSettingsDomainServicePorts(services: Pick<RuntimeDomainServices, "settingsDomainService">): Ports {
  return {
    "settings.patch": {
      patchSettings: (patch) => services.settingsDomainService.patch(patch)
    }
  };
}
