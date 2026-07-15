import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "file.patch" | "file.write" | "file.inspect" | "file.list" | "file.read">;

export function createFileDomainServicePorts(services: Pick<RuntimeDomainServices, "fileDomainService">): Ports {
  return {
    "file.patch": {
      executeFilePatch: async (context, input) => ({
        ok: true as const,
        value: await services.fileDomainService.patchFile(input)
      })
    },
    "file.write": {
      executeFileWrite: async (context, input) => ({
        ok: true as const,
        value: await services.fileDomainService.writeFile(input)
      })
    },
    "file.inspect": {
      executeFileInspect: async (context, input) => ({
        ok: true as const,
        value: await services.fileDomainService.inspectFile(input)
      })
    },
    "file.list": {
      executeFileList: async (context, input) => ({
        ok: true as const,
        value: await services.fileDomainService.listFiles(input)
      })
    },
    "file.read": {
      executeFileRead: async (context, input) => ({
        ok: true as const,
        value: await services.fileDomainService.readFile(input)
      })
    }
  };
}

