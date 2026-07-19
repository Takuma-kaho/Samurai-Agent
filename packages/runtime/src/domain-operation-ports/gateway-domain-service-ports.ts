import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "gateway.concurrency_lock.expire" | "gateway.inbound.route" | "gateway.mcp_config.save" | "gateway.pairing.approve" | "gateway.pairing.expire" | "gateway.pairing.reject" | "gateway.pairing.revoke" | "gateway.pairing.rotate" | "gateway.pairing_policy.save" | "gateway.routing_policy.save" | "gateway.sandbox.delete" | "gateway.sandbox.recreate" | "gateway.sandbox.sync" | "gateway.state.repair">;

export function createGatewayDomainServicePorts(services: Pick<RuntimeDomainServices, "gatewayDomainService">): Ports {
  return {
    "gateway.concurrency_lock.expire": {
      expireGatewayConcurrencyLocks: (request) => services.gatewayDomainService.expireConcurrencyLocks({
        now: request.now
      })
    },
    "gateway.inbound.route": {
      routeGatewayInbound: (request) => services.gatewayDomainService.routeInboundPrimitive({
        channel: request.channel,
        source_identity: request.sourceIdentity,
        body: request.body,
        source_label: request.sourceLabel,
        account_id: request.accountId,
        thread_id: request.threadId,
        route: request.route,
        metadata: request.metadata,
        backend_id: request.backendId,
        input_locale: request.inputLocale,
        output_locale: request.outputLocale
      })
    },
    "gateway.mcp_config.save": {
      saveGatewayMcpConfig: (request) => services.gatewayDomainService.saveMcpConfig(request)
    },
    "gateway.pairing.approve": {
      requireGatewayPairing: (id) => services.gatewayDomainService.requirePairing(id),
      saveGatewayPairing: (record) => services.gatewayDomainService.savePairing(record),
      emitGatewayPairingUpdated: (record) => services.gatewayDomainService.emitPairingUpdated(record)
    },
    "gateway.pairing.expire": {
      expireGatewayPairings: (now) => services.gatewayDomainService.expirePairingsPrimitive(now),
      emitGatewayPairingUpdated: (record) => services.gatewayDomainService.emitPairingUpdated(record)
    },
    "gateway.pairing.reject": {
      requireGatewayPairing: (id) => services.gatewayDomainService.requirePairing(id),
      saveGatewayPairing: (record) => services.gatewayDomainService.savePairing(record),
      emitGatewayPairingUpdated: (record) => services.gatewayDomainService.emitPairingUpdated(record)
    },
    "gateway.pairing.revoke": {
      requireGatewayPairing: (id) => services.gatewayDomainService.requirePairing(id),
      saveGatewayPairing: (record) => services.gatewayDomainService.savePairing(record),
      emitGatewayPairingUpdated: (record) => services.gatewayDomainService.emitPairingUpdated(record)
    },
    "gateway.pairing.rotate": {
      requireGatewayPairing: (id) => services.gatewayDomainService.requirePairing(id),
      saveGatewayPairing: (record) => services.gatewayDomainService.savePairing(record),
      emitGatewayPairingUpdated: (record) => services.gatewayDomainService.emitPairingUpdated(record)
    },
    "gateway.pairing_policy.save": {
      saveGatewayPairingPolicy: (request) => services.gatewayDomainService.savePairingPolicy(request)
    },
    "gateway.routing_policy.save": {
      saveGatewayRoutingPolicy: (request) => services.gatewayDomainService.saveRoutingPolicy(request)
    },
    "gateway.sandbox.delete": {
      deleteGatewaySandbox: (request) => services.gatewayDomainService.deleteSandbox(request.sandboxId)
    },
    "gateway.sandbox.recreate": {
      recreateGatewaySandbox: (request) => services.gatewayDomainService.recreateSandbox(request.sandboxId)
    },
    "gateway.sandbox.sync": {
      syncGatewaySandbox: (id, input) => services.gatewayDomainService.syncSandboxPrimitive(id, input)
    },
    "gateway.state.repair": {
      repairGatewayState: (input) => services.gatewayDomainService.repairStatePrimitive(input)
    }
  };
}
