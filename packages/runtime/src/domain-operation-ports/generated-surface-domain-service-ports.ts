import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "generated_surface.action.run" | "generated_surface.create" | "generated_surface.interaction.record" | "generated_surface.revise" | "generated_surface.state" | "generated_surface.export">;

export function createGeneratedSurfaceDomainServicePorts(services: Pick<RuntimeDomainServices, "generatedSurfaceDomainService">): Ports {
  return {
    "generated_surface.action.run": {
      executeGeneratedSurfaceActionRun: async (context, input) => ({
        ok: true as const,
        value: await services.generatedSurfaceDomainService.runAction(input)
      })
    },
    "generated_surface.create": {
      executeGeneratedSurfaceCreate: async (context, input) => ({
        ok: true as const,
        value: await services.generatedSurfaceDomainService.create(input)
      })
    },
    "generated_surface.interaction.record": {
      executeGeneratedSurfaceInteractionRecord: async (context, input) => ({
        ok: true as const,
        value: await services.generatedSurfaceDomainService.recordInteraction(input)
      })
    },
    "generated_surface.revise": {
      executeGeneratedSurfaceRevise: async (context, input) => ({
        ok: true as const,
        value: await services.generatedSurfaceDomainService.revise(input)
      })
    },
    "generated_surface.state": {
      executeGeneratedSurfaceState: async (context, input) => ({
        ok: true as const,
        value: await services.generatedSurfaceDomainService.setState(input)
      })
    },
    "generated_surface.export": {
      executeGeneratedSurfaceExport: async (context, input) => ({
        ok: true as const,
        value: await services.generatedSurfaceDomainService.export(input)
      })
    }
  };
}

