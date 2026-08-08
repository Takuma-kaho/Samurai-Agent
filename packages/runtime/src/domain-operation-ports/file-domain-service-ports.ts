import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "file.patch" | "file.write" | "file.inspect" | "file.list" | "file.read">;

export function createFileDomainServicePorts(services: Pick<RuntimeDomainServices, "fileDomainService">): Ports {
  return {
    "file.patch": {
      resolveFilePath: (path) => services.fileDomainService.resolveFilePath(path),
      readFileTextIfExists: (path) => services.fileDomainService.readFileTextIfExists(path),
      ensureFileParent: (path) => services.fileDomainService.ensureFileParent(path),
      writeFileText: (path, content) => services.fileDomainService.writeFileText(path, content),
      isManagedCollectionPath: (path) => services.fileDomainService.isManagedCollectionPath(path),
      reindexManagedCollections: async () => { await services.fileDomainService.reindexManagedCollections(); },
      fileNotFoundError: (path) => services.fileDomainService.fileNotFoundError(path),
      filePatchConflictError: () => services.fileDomainService.filePatchConflictError(),
      createFileRollback: (operation, refs, before, after) => services.fileDomainService.createFileRollback(operation, refs, before, after),
      runFileMutation: (input) => services.fileDomainService.runFileMutation(input)
    },
    "file.write": {
      resolveFilePath: (path) => services.fileDomainService.resolveFilePath(path),
      readFileTextIfExists: (path) => services.fileDomainService.readFileTextIfExists(path),
      ensureFileParent: (path) => services.fileDomainService.ensureFileParent(path),
      writeFileText: (path, content) => services.fileDomainService.writeFileText(path, content),
      isManagedCollectionPath: (path) => services.fileDomainService.isManagedCollectionPath(path),
      reindexManagedCollections: async () => { await services.fileDomainService.reindexManagedCollections(); },
      createFileRollback: (operation, refs, before, after) => services.fileDomainService.createFileRollback(operation, refs, before, after),
      runFileMutation: (input) => services.fileDomainService.runFileMutation(input)
    },
    "file.inspect": readOnlyQueryPort<Ports["file.inspect"]>({
      inspectWorkspaceFile: (input) => services.fileDomainService.inspectFile(input)
    }),
    "file.list": readOnlyQueryPort<Ports["file.list"]>({
      listWorkspaceFiles: (input) => services.fileDomainService.listFiles(input)
    }),
    "file.read": readOnlyQueryPort<Ports["file.read"]>({
      readWorkspaceFile: (input) => services.fileDomainService.readFile(input)
    })
  };
}
