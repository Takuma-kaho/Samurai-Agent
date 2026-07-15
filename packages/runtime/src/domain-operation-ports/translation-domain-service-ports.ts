import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "resource.translation.save" | "resource.translation_job.save">;

export function createTranslationDomainServicePorts(services: Pick<RuntimeDomainServices, "translationDomainService">): Ports {
  return {
    "resource.translation.save": {
      executeResourceTranslationSave: async (context, input) => ({
        ok: true as const,
        value: await services.translationDomainService.save(input)
      })
    },
    "resource.translation_job.save": {
      executeResourceTranslationJobSave: async (context, input) => ({
        ok: true as const,
        value: await services.translationDomainService.saveJob(input)
      })
    }
  };
}

