import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "message.presentation.update" | "presentation.plan">;

export function createPresentationDomainServicePorts(services: Pick<RuntimeDomainServices, "presentationDomainService">): Ports {
  return {
    "message.presentation.update": {
      getMessagePresentation: (id) => services.presentationDomainService.getPresentation(id),
      presentCollectionView: (input) => services.presentationDomainService.presentView(input),
      applyPresentationViewState: (spec, state) => services.presentationDomainService.applyViewState(spec, state),
      presentationViewStateFromSpec: (spec) => services.presentationDomainService.viewStateFromSpec(spec),
      updateMessagePresentationViewState: (input) => services.presentationDomainService.updateViewState(input),
      messagePresentationNotFoundError: (id) => services.presentationDomainService.presentationNotFound(id)
    },
    "presentation.plan": readOnlyQueryPort<Ports["presentation.plan"]>({})
  };
}
