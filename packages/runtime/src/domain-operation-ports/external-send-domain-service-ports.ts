import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "external.send" | "external.send.dispatch" | "external.send.prepare">;

export function createExternalSendDomainServicePorts(services: Pick<RuntimeDomainServices, "externalSendDomainService">): Ports {
  return {
    "external.send": {
      ensureExternalSendSession: () => services.externalSendDomainService.ensureExternalSendSession(),
      createExternalSendEnvelope: (session, content) => services.externalSendDomainService.createExternalSendEnvelope(session, content),
      createExternalSendId: () => services.externalSendDomainService.createExternalSendId(),
      externalSendNow: () => services.externalSendDomainService.externalSendNow(),
      saveExternalSend: (record) => services.externalSendDomainService.saveExternalSend(record),
      createExternalSendRollback: (operation, refs, before, after) => services.externalSendDomainService.createExternalSendRollback(operation, refs, before, after),
      runExternalSendMutation: (input) => services.externalSendDomainService.runExternalSendMutation(input)
    },
    "external.send.dispatch": {
      getExternalSend: (id) => services.externalSendDomainService.getExternalSendForCurrentRoom(id),
      saveExternalSend: (record) => services.externalSendDomainService.saveExternalSend(record),
      claimDispatch: (input) => services.externalSendDomainService.claimExternalSendDispatch(input),
      settleDispatch: (input) => services.externalSendDomainService.settleExternalSendDispatch(input),
      markOutcomeUnknown: (input) => services.externalSendDomainService.markExternalSendOutcomeUnknown(input),
      dispatchExternalSend: (record, dryRun) => services.externalSendDomainService.dispatchExternalSend(record, dryRun),
      ensureExternalSendSession: () => services.externalSendDomainService.ensureExternalSendSession(),
      createExternalSendEnvelope: (session, content) => services.externalSendDomainService.createExternalSendEnvelope(session, content),
      externalSendNow: () => services.externalSendDomainService.externalSendNow(),
      externalSendDefaultDryRun: () => services.externalSendDomainService.externalSendDefaultDryRun(),
      externalSendNotFound: (id) => services.externalSendDomainService.externalSendNotFound(id),
      runExternalSendMutation: (input) => services.externalSendDomainService.runExternalSendMutation(input)
    },
    "external.send.prepare": {
      ensureExternalSendSession: () => services.externalSendDomainService.ensureExternalSendSession(),
      createExternalSendEnvelope: (session, content) => services.externalSendDomainService.createExternalSendEnvelope(session, content),
      createExternalSendId: () => services.externalSendDomainService.createExternalSendId(),
      externalSendNow: () => services.externalSendDomainService.externalSendNow(),
      saveExternalSend: (record) => services.externalSendDomainService.saveExternalSend(record),
      createExternalSendRollback: (operation, refs, before, after) => services.externalSendDomainService.createExternalSendRollback(operation, refs, before, after),
      runExternalSendMutation: (input) => services.externalSendDomainService.runExternalSendMutation(input)
    }
  };
}
