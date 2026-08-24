import {
  bindOperationDefinition,
  gatewayConcurrencyLockExpire,
  gatewayInboundRoute,
  gatewayMcpConfigSave,
  gatewayPairingApprove,
  gatewayPairingExpire,
  gatewayPairingPolicySave,
  gatewayPairingReject,
  gatewayPairingRevoke,
  gatewayPairingRotate,
  gatewayRoutingPolicySave,
  gatewaySandboxDelete,
  gatewaySandboxRecreate,
  gatewaySandboxSync,
  gatewayStateRepair,
  type BoundOperationDefinition,
  type DomainResult,
  type TrustedDomainContext
} from "@samurai-agent/domain-operations";
import {
  createGatewayDomainServicePorts,
  GatewayDomainService
} from "@samurai-agent/runtime";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import { PostgresGatewayAdapter, type PostgresGatewayAdapterOptions } from "./postgres-gateway";
import { PostgresDomainOperationLedger } from "./postgres-domain-operation-ledger";

const gatewayDefinitions = [
  [gatewayConcurrencyLockExpire, "gateway.concurrency_lock.expire"],
  [gatewayInboundRoute, "gateway.inbound.route"],
  [gatewayMcpConfigSave, "gateway.mcp_config.save"],
  [gatewayPairingPolicySave, "gateway.pairing_policy.save"],
  [gatewayPairingApprove, "gateway.pairing.approve"],
  [gatewayPairingExpire, "gateway.pairing.expire"],
  [gatewayPairingReject, "gateway.pairing.reject"],
  [gatewayPairingRevoke, "gateway.pairing.revoke"],
  [gatewayPairingRotate, "gateway.pairing.rotate"],
  [gatewayRoutingPolicySave, "gateway.routing_policy.save"],
  [gatewaySandboxDelete, "gateway.sandbox.delete"],
  [gatewaySandboxRecreate, "gateway.sandbox.recreate"],
  [gatewaySandboxSync, "gateway.sandbox.sync"],
  [gatewayStateRepair, "gateway.state.repair"]
] as const;

/**
 * Narrow Domain Operation composition for the standard PostgreSQL Gateway
 * path. It intentionally binds only Gateway definitions; the old compatibility
 * all-features registry is not imported into the Workspace Server.
 */
export class PostgresGatewayDomainOperations {
  readonly adapter: PostgresGatewayAdapter;
  private readonly service: GatewayDomainService;
  private readonly ledger: PostgresDomainOperationLedger;
  private readonly bindings = new Map<string, BoundOperationDefinition>();

  constructor(options: PostgresGatewayAdapterOptions) {
    this.adapter = new PostgresGatewayAdapter(options);
    this.ledger = new PostgresDomainOperationLedger(options.database, options.workspaceId, options.accountId);
    this.service = new GatewayDomainService(this.adapter.dependencies());
    const ports = createGatewayDomainServicePorts({ gatewayDomainService: this.service });
    for (const [definition, id] of gatewayDefinitions) {
      const key = id as keyof typeof ports;
      const operationPorts = ports[key];
      if (!operationPorts) throw new Error(`postgres_gateway_operation_port_missing:${id}`);
      this.bindings.set(id, bindGatewayDefinition(definition, operationPorts));
    }
  }

  listPairingPolicies() { return this.service.listPairingPolicies(); }
  getPairingPolicy(channel: Parameters<GatewayDomainService["getPairingPolicy"]>[0]) { return this.service.getPairingPolicy(channel); }
  listRoutingPolicies() { return this.service.listRoutingPolicies(); }
  getRoutingPolicy(channel: Parameters<GatewayDomainService["getRoutingPolicy"]>[0]) { return this.service.getRoutingPolicy(channel); }

  async execute(
    context: TrustedDomainContext,
    operationId: string,
    input: unknown
  ): Promise<DomainResult<unknown>> {
    const binding = this.bindings.get(operationId);
    if (!binding) throw new WorkspaceServerError("gateway_domain_operation_not_found", 404);
    const result = await this.ledger.run({
      operationId,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      request: input,
      execute: () => binding.execute(context, input)
    });
    return result.value;
  }
}

function bindGatewayDefinition(
  definition: (typeof gatewayDefinitions)[number][0],
  ports: unknown
): BoundOperationDefinition {
  // The generated operation definitions retain their concrete port contract.
  // This local boundary is the only place where the disjoint Gateway union
  // is narrowed for the typed bindOperationDefinition call.
  return bindOperationDefinition(
    definition as Parameters<typeof bindOperationDefinition>[0],
    definition.createHandler(ports as never)
  );
}
