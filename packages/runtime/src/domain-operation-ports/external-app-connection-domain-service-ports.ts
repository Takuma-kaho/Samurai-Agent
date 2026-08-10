import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts,
  "external_app.connection.create" | "external_app.connection.update_scope" | "external_app.connection.revoke">;

export function createExternalAppConnectionDomainServicePorts(
  services: Pick<RuntimeDomainServices, "externalAppConnectionDomainService">
): Ports {
  return {
    "external_app.connection.create": {
      createExternalAppConnection: (input) => services.externalAppConnectionDomainService.create(input)
    },
    "external_app.connection.update_scope": {
      updateExternalAppConnectionScope: (input) => services.externalAppConnectionDomainService.updateScope(input)
    },
    "external_app.connection.revoke": {
      revokeExternalAppConnection: (input) => services.externalAppConnectionDomainService.revoke(input)
    }
  };
}
