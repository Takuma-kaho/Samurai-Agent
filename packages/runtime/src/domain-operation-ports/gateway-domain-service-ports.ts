import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "gateway.concurrency_lock.expire" | "gateway.inbound.route" | "gateway.mcp_config.save" | "gateway.pairing.approve" | "gateway.pairing.expire" | "gateway.pairing.reject" | "gateway.pairing.revoke" | "gateway.pairing.rotate" | "gateway.pairing_policy.save" | "gateway.routing_policy.save" | "gateway.sandbox.delete" | "gateway.sandbox.recreate" | "gateway.sandbox.sync" | "gateway.state.repair">;

export function createGatewayDomainServicePorts(services: Pick<RuntimeDomainServices, "gatewayDomainService">): Ports {
  return {
    "gateway.concurrency_lock.expire": {
      executeGatewayConcurrencyLockExpire: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.expireConcurrencyLocks(input)
      })
    },
    "gateway.inbound.route": {
      routeGatewayInbound: (input) => services.gatewayDomainService.routeInboundPrimitive(input)
    },
    "gateway.mcp_config.save": {
      executeGatewayMcpConfigSave: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.saveMcpConfig(input)
      })
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
      executeGatewayPairingPolicySave: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.savePairingPolicy(input)
      })
    },
    "gateway.routing_policy.save": {
      executeGatewayRoutingPolicySave: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.saveRoutingPolicy(input)
      })
    },
    "gateway.sandbox.delete": {
      executeGatewaySandboxDelete: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.deleteSandbox(input)
      })
    },
    "gateway.sandbox.recreate": {
      executeGatewaySandboxRecreate: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.recreateSandbox(input)
      })
    },
    "gateway.sandbox.sync": {
      syncGatewaySandbox: (id, input) => services.gatewayDomainService.syncSandboxPrimitive(id, input)
    },
    "gateway.state.repair": {
      repairGatewayState: (input) => services.gatewayDomainService.repairStatePrimitive(input)
    }
  };
}
