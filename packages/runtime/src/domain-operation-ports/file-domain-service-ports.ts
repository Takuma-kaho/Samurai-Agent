import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "file.patch" | "file.write" | "file.inspect" | "file.list" | "file.read">;

export function createFileDomainServicePorts(services: Pick<RuntimeDomainServices, "fileDomainService">): Ports {
  return {
    "file.patch": {
      resolveFilePath: (path) => services.fileDomainService.resolveFilePath(path),
      ensureFileSession: () => services.fileDomainService.ensureFileSession(),
      createFileEnvelope: (session, content) => services.fileDomainService.createFileEnvelope(session, content),
      readFileTextIfExists: (path) => services.fileDomainService.readFileTextIfExists(path),
      ensureFileParent: (path) => services.fileDomainService.ensureFileParent(path),
      writeFileText: (path, content) => services.fileDomainService.writeFileText(path, content),
      isManagedCollectionPath: (path) => services.fileDomainService.isManagedCollectionPath(path),
      reindexManagedCollections: () => services.fileDomainService.reindexManagedCollections(),
      fileNotFoundError: (path) => services.fileDomainService.fileNotFoundError(path),
      filePatchConflictError: () => services.fileDomainService.filePatchConflictError(),
      createFileRollback: (operation, refs, before, after) => services.fileDomainService.createFileRollback(operation, refs, before, after),
      runFileMutation: (input) => services.fileDomainService.runFileMutation(input)
    },
    "file.write": {
      resolveFilePath: (path) => services.fileDomainService.resolveFilePath(path),
      ensureFileSession: () => services.fileDomainService.ensureFileSession(),
      createFileEnvelope: (session, content) => services.fileDomainService.createFileEnvelope(session, content),
      readFileTextIfExists: (path) => services.fileDomainService.readFileTextIfExists(path),
      ensureFileParent: (path) => services.fileDomainService.ensureFileParent(path),
      writeFileText: (path, content) => services.fileDomainService.writeFileText(path, content),
      isManagedCollectionPath: (path) => services.fileDomainService.isManagedCollectionPath(path),
      reindexManagedCollections: () => services.fileDomainService.reindexManagedCollections(),
      createFileRollback: (operation, refs, before, after) => services.fileDomainService.createFileRollback(operation, refs, before, after),
      runFileMutation: (input) => services.fileDomainService.runFileMutation(input)
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
