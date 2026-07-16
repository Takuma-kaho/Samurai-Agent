import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "generated_surface.action.run" | "generated_surface.create" | "generated_surface.interaction.record" | "generated_surface.revise" | "generated_surface.state" | "generated_surface.export">;

export function createGeneratedSurfaceDomainServicePorts(services: Pick<RuntimeDomainServices, "generatedSurfaceDomainService">): Ports {
  return {
    "generated_surface.action.run": {
      getGeneratedSurface: (id) => services.generatedSurfaceDomainService.getSurface(id),
      dispatchGeneratedSurfaceCommand: (input) => services.generatedSurfaceDomainService.dispatchSurfaceCommand(input),
      saveGeneratedSurfaceInteraction: (record) => services.generatedSurfaceDomainService.saveInteractionRecord(record),
      generatedSurfaceActionError: (code, message) => services.generatedSurfaceDomainService.surfaceError(code, message)
    },
    "generated_surface.create": {
      buildGeneratedSurfaceRevision: (input) => services.generatedSurfaceDomainService.buildSurfaceRevision(input),
      saveGeneratedSurfaceRevision: (input) => services.generatedSurfaceDomainService.saveSurfaceRevision(input)
    },
    "generated_surface.interaction.record": {
      getGeneratedSurface: (id) => services.generatedSurfaceDomainService.getSurface(id),
      saveGeneratedSurfaceInteraction: (record) => services.generatedSurfaceDomainService.saveInteractionRecord(record),
      generatedSurfaceInteractionError: (message) => services.generatedSurfaceDomainService.surfaceError("not_found", message)
    },
    "generated_surface.revise": {
      getGeneratedSurface: (id) => services.generatedSurfaceDomainService.getSurface(id),
      buildGeneratedSurfaceRevision: (input) => services.generatedSurfaceDomainService.buildSurfaceRevision(input),
      saveGeneratedSurfaceRevision: (input) => services.generatedSurfaceDomainService.saveSurfaceRevision(input),
      generatedSurfaceReviseError: (message) => services.generatedSurfaceDomainService.surfaceError("not_found", message)
    },
    "generated_surface.state": {
      updateGeneratedSurfaceState: (id, state) => services.generatedSurfaceDomainService.updateSurfaceState(id, state),
      saveGeneratedSurfaceInteraction: (record) => services.generatedSurfaceDomainService.saveInteractionRecord(record),
      generatedSurfaceStateError: (code, message) => services.generatedSurfaceDomainService.surfaceError(code, message)
    },
    "generated_surface.export": {
      getGeneratedSurface: (id) => services.generatedSurfaceDomainService.getSurface(id),
      getGeneratedSurfaceRevision: (id) => services.generatedSurfaceDomainService.getRevision(id),
      readGeneratedSurfaceBundle: (id) => services.generatedSurfaceDomainService.readBundle(id),
      generatedSurfaceQueryError: (message) => services.generatedSurfaceDomainService.surfaceError("not_found", message)
    }
  };
}
