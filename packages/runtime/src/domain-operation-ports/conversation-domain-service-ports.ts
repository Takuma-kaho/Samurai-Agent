import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "chat.turn.run" | "session.create" | "session.search.reindex">;

export function createConversationDomainServicePorts(services: Pick<RuntimeDomainServices, "conversationDomainService">): Ports {
  return {
    "chat.turn.run": {
      runChatTurn: (context, input) => services.conversationDomainService.executeChatTurn(context, input)
    },
    "session.create": {
      createSession: (context, input) => services.conversationDomainService.createSession(context, input)
    },
    "session.search.reindex": {
      reindexSessionSearch: () => services.conversationDomainService.reindexSearch()
    }
  };
}
