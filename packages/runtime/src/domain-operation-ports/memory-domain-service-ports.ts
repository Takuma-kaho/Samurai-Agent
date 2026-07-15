import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "memory.archive" | "memory.session.create" | "memory.topic.create">;

export function createMemoryDomainServicePorts(services: Pick<RuntimeDomainServices, "memoryDomainService">): Ports {
  return {
    "memory.archive": {
      executeMemoryArchive: async (context, input) => ({
        ok: true as const,
        value: await services.memoryDomainService.archive(input)
      })
    },
    "memory.session.create": {
      executeMemorySessionCreate: async (context, input) => ({
        ok: true as const,
        value: await services.memoryDomainService.createSession(input)
      })
    },
    "memory.topic.create": {
      executeMemoryTopicCreate: async (context, input) => ({
        ok: true as const,
        value: await services.memoryDomainService.createTopic(input)
      })
    }
  };
}

