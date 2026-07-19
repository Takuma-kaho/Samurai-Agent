import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "chat.turn.run" | "session.create" | "session.search.reindex">;

export function createConversationDomainServicePorts(services: Pick<RuntimeDomainServices, "conversationDomainService">): Ports {
  return {
    "chat.turn.run": {
      createChatSession: (input) => services.conversationDomainService.createChatSession(input),
      runChatTurn: (input) => services.conversationDomainService.executeChatTurn(input)
    },
    "session.create": {
      createSession: (input) => services.conversationDomainService.createSession(input)
    },
    "session.search.reindex": {
      reindexSessionSearch: () => services.conversationDomainService.reindexSearch()
    }
  };
}
