import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "memory.archive" | "memory.session.create" | "memory.topic.create">;

export function createMemoryDomainServicePorts(services: Pick<RuntimeDomainServices, "memoryDomainService">): Ports {
  return {
    "memory.archive": {
      getMemorySession: (id) => services.memoryDomainService.getSession(id),
      getMemoryForArchive: (id) => services.memoryDomainService.getMemoryForArchive(id),
      listMemoryForSession: (id) => services.memoryDomainService.listMemoryForSession(id),
      archiveMemoryRecord: (id) => services.memoryDomainService.archiveMemoryRecord(id),
      memoryArchiveError: (code, message) => services.memoryDomainService.memoryArchiveError(code, message),
      memoryResourceRef: (memory) => services.memoryDomainService.memoryRef(memory),
      memoryArchiveCapabilityId: () => services.memoryDomainService.memoryArchiveCapabilityId(),
      saveMemoryArchiveOperation: (operation) => services.memoryDomainService.saveMemoryArchiveOperation(operation),
      updateMemoryArchiveOperation: (operation) => services.memoryDomainService.updateMemoryArchiveOperation(operation),
      emitMemoryArchiveOperation: (operation) => services.memoryDomainService.emitMemoryArchiveOperation(operation),
      createMemoryArchiveRollback: (operation, refs, before, after) => services.memoryDomainService.createMemoryArchiveRollback(operation, refs, before, after),
      rebuildMemoryActivity: () => services.memoryDomainService.rebuildMemoryActivity()
    },
    "memory.session.create": {
      memorySessionScopeWriteDisabledError: () => services.memoryDomainService.memorySessionScopeWriteDisabledError()
    },
    "memory.topic.create": {
      memoryCreateError: (message) => services.memoryDomainService.memoryCreateError(message),
      writeRoomTopicMemory: (input) => services.memoryDomainService.writeRoomTopicMemory(input),
      memoryResourceRef: (memory) => services.memoryDomainService.memoryRef(memory),
      createMemoryRollback: (operation, refs, after) => services.memoryDomainService.createMemoryRollback(operation, refs, after), emitMemoryCandidate: (memory) => services.memoryDomainService.emitMemoryCandidate(memory),
      runMemoryMutation: (input) => services.memoryDomainService.runMemoryMutation(input)
    }
  };
}
