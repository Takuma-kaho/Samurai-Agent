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
      executeGatewayInboundRoute: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.routeInbound(input)
      })
    },
    "gateway.mcp_config.save": {
      executeGatewayMcpConfigSave: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.saveMcpConfig(input)
      })
    },
    "gateway.pairing.approve": {
      executeGatewayPairingApprove: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.approvePairing(input)
      })
    },
    "gateway.pairing.expire": {
      executeGatewayPairingExpire: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.expirePairings(input)
      })
    },
    "gateway.pairing.reject": {
      executeGatewayPairingReject: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.rejectPairing(input)
      })
    },
    "gateway.pairing.revoke": {
      executeGatewayPairingRevoke: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.revokePairing(input)
      })
    },
    "gateway.pairing.rotate": {
      executeGatewayPairingRotate: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.rotatePairing(input)
      })
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
      executeGatewaySandboxSync: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.syncSandbox(input)
      })
    },
    "gateway.state.repair": {
      executeGatewayStateRepair: async (context, input) => ({
        ok: true as const,
        value: await services.gatewayDomainService.repairState(input)
      })
    }
  };
}

