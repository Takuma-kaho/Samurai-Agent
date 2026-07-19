import { domainQueryIds, type DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "./domain-operation-services.js";
import { createArtifactDomainServicePorts } from "./domain-operation-ports/artifact-domain-service-ports.js";
import { createAutomationDomainServicePorts } from "./domain-operation-ports/automation-domain-service-ports.js";
import { createBrowserDomainServicePorts } from "./domain-operation-ports/browser-domain-service-ports.js";
import { createClientEventDomainServicePorts } from "./domain-operation-ports/client-event-domain-service-ports.js";
import { createCollectionDomainServicePorts } from "./domain-operation-ports/collection-domain-service-ports.js";
import { createConversationDomainServicePorts } from "./domain-operation-ports/conversation-domain-service-ports.js";
import { createExecutionDomainServicePorts } from "./domain-operation-ports/execution-domain-service-ports.js";
import { createExternalSendDomainServicePorts } from "./domain-operation-ports/external-send-domain-service-ports.js";
import { createFileDomainServicePorts } from "./domain-operation-ports/file-domain-service-ports.js";
import { createGatewayDomainServicePorts } from "./domain-operation-ports/gateway-domain-service-ports.js";
import { createGeneratedSurfaceDomainServicePorts } from "./domain-operation-ports/generated-surface-domain-service-ports.js";
import { createLearningDomainServicePorts } from "./domain-operation-ports/learning-domain-service-ports.js";
import { createMemoryDomainServicePorts } from "./domain-operation-ports/memory-domain-service-ports.js";
import { createObjectiveDomainServicePorts } from "./domain-operation-ports/objective-domain-service-ports.js";
import { createPluginDomainServicePorts } from "./domain-operation-ports/plugin-domain-service-ports.js";
import { createPresentationDomainServicePorts } from "./domain-operation-ports/presentation-domain-service-ports.js";
import { createSettingsDomainServicePorts } from "./domain-operation-ports/settings-domain-service-ports.js";
import { createSkillDomainServicePorts } from "./domain-operation-ports/skill-domain-service-ports.js";
import { createSystemDomainServicePorts } from "./domain-operation-ports/system-domain-service-ports.js";
import { createTranslationDomainServicePorts } from "./domain-operation-ports/translation-domain-service-ports.js";
import { createWikiDomainServicePorts } from "./domain-operation-ports/wiki-domain-service-ports.js";
import { createSearchDomainServicePorts } from "./domain-operation-ports/search-domain-service-ports.js";

export type { RuntimeDomainServices } from "./domain-operation-services.js";

export function createDomainOperationPorts(services: RuntimeDomainServices): DomainOperationPorts {
  const ports = {
    ...createArtifactDomainServicePorts(services),
    ...createAutomationDomainServicePorts(services),
    ...createBrowserDomainServicePorts(services),
    ...createClientEventDomainServicePorts(services),
    ...createCollectionDomainServicePorts(services),
    ...createConversationDomainServicePorts(services),
    ...createExecutionDomainServicePorts(services),
    ...createExternalSendDomainServicePorts(services),
    ...createFileDomainServicePorts(services),
    ...createGatewayDomainServicePorts(services),
    ...createGeneratedSurfaceDomainServicePorts(services),
    ...createLearningDomainServicePorts(services),
    ...createMemoryDomainServicePorts(services),
    ...createObjectiveDomainServicePorts(services),
    ...createPluginDomainServicePorts(services),
    ...createPresentationDomainServicePorts(services),
    ...createSettingsDomainServicePorts(services),
    ...createSkillDomainServicePorts(services),
    ...createSystemDomainServicePorts(services),
    ...createTranslationDomainServicePorts(services),
    ...createWikiDomainServicePorts(services),
    ...createSearchDomainServicePorts(services)
  };
  const missingQueryPorts = domainQueryIds.filter((id) => !(id in ports));
  if (missingQueryPorts.length > 0) throw new Error(`domain_query_ports_incomplete:${missingQueryPorts.join(",")}`);
  return ports;
}
