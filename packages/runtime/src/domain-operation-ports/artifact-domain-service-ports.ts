import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "artifact.create" | "artifact.export_pdf" | "artifact.repair" | "artifact.restore_revision" | "artifact.revise" | "graph.create" | "graph.patch" | "image.edit" | "image.generate">;

export function createArtifactDomainServicePorts(services: Pick<RuntimeDomainServices, "artifactDomainService">): Ports {
  return {
    "artifact.create": {
      executeArtifactCreate: async (context, input) => ({
        ok: true as const,
        value: await services.artifactDomainService.create(input, context.inputSource)
      })
    },
    "artifact.export_pdf": {
      executeArtifactExportPdf: async (context, input) => ({
        ok: true as const,
        value: await services.artifactDomainService.exportPdf(input)
      })
    },
    "artifact.repair": {
      executeArtifactRepair: async (context, input) => ({
        ok: true as const,
        value: await services.artifactDomainService.repair(input)
      })
    },
    "artifact.restore_revision": {
      executeArtifactRestoreRevision: async (context, input) => ({
        ok: true as const,
        value: await services.artifactDomainService.restoreRevision(input)
      })
    },
    "artifact.revise": {
      executeArtifactRevise: async (context, input) => ({
        ok: true as const,
        value: await services.artifactDomainService.revise(input, context.inputSource)
      })
    },
    "graph.create": {
      executeGraphCreate: async (context, input) => ({
        ok: true as const,
        value: await services.artifactDomainService.createGraph(input, context.inputSource)
      })
    },
    "graph.patch": {
      executeGraphPatch: async (context, input) => ({
        ok: true as const,
        value: await services.artifactDomainService.patchGraph(input, context.inputSource)
      })
    },
    "image.edit": {
      executeImageEdit: async (context, input) => ({
        ok: true as const,
        value: await services.artifactDomainService.editImage(input)
      })
    },
    "image.generate": {
      executeImageGenerate: async (context, input) => ({
        ok: true as const,
        value: await services.artifactDomainService.generateImage(input)
      })
    }
  };
}

