import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "generated_surface.action.run" | "generated_surface.create" | "generated_surface.interaction.record" | "generated_surface.revise" | "generated_surface.state" | "generated_surface.export">;

export function createGeneratedSurfaceDomainServicePorts(services: Pick<RuntimeDomainServices, "generatedSurfaceDomainService">): Ports {
  return {
    "generated_surface.action.run": {
      resolveGeneratedSurfaceAction: (input) => services.generatedSurfaceDomainService.resolveSurfaceAction({
        surfaceId: input.surfaceId,
        revisionId: input.revisionId,
        actionId: input.actionId
      })
    },
    "generated_surface.create": {
      createGeneratedSurfaceRequestId: () => services.generatedSurfaceDomainService.createGeneratedSurfaceRequestId(),
      generatedSurfaceNow: () => services.generatedSurfaceDomainService.generatedSurfaceNow(),
      generatedSurfaceFingerprint: (value) => services.generatedSurfaceDomainService.generatedSurfaceFingerprint(value),
      generatedSurfaceCreateError: (message) => services.generatedSurfaceDomainService.surfaceError("conflict", message),
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
      createGeneratedSurfaceRequestId: () => services.generatedSurfaceDomainService.createGeneratedSurfaceRequestId(),
      generatedSurfaceNow: () => services.generatedSurfaceDomainService.generatedSurfaceNow(),
      generatedSurfaceFingerprint: (value) => services.generatedSurfaceDomainService.generatedSurfaceFingerprint(value),
      buildGeneratedSurfaceRevision: (input) => services.generatedSurfaceDomainService.buildSurfaceRevision(input),
      saveGeneratedSurfaceRevision: (input) => services.generatedSurfaceDomainService.saveSurfaceRevision(input),
      generatedSurfaceReviseError: (message) => services.generatedSurfaceDomainService.surfaceError("not_found", message)
    },
    "generated_surface.state": {
      updateGeneratedSurfaceState: (id, state) => services.generatedSurfaceDomainService.updateSurfaceState(id, state),
      saveGeneratedSurfaceInteraction: (record) => services.generatedSurfaceDomainService.saveInteractionRecord(record),
      generatedSurfaceStateError: (code, message) => services.generatedSurfaceDomainService.surfaceError(code, message)
    },
    "generated_surface.export": readOnlyQueryPort<Ports["generated_surface.export"]>({
      getGeneratedSurface: (id) => services.generatedSurfaceDomainService.getSurface(id),
      getGeneratedSurfaceRevision: (id) => services.generatedSurfaceDomainService.getRevision(id),
      readGeneratedSurfaceBundle: (id) => services.generatedSurfaceDomainService.readBundle(id),
      generatedSurfaceQueryError: (message) => services.generatedSurfaceDomainService.surfaceError("not_found", message)
    })
  };
}
