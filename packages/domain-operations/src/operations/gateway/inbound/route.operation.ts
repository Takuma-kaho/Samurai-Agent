// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { GatewayChannelSchema, type GatewayChannel, type JsonValue } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayInboundValueSchema } from "../../../value-objects/gateway-inbound.js";

const Input = z.object({
  "account_id": z.string() .optional(),
  "backend_id": z.string() .optional(),
  "body": z.string().trim().min(1),
  "channel": GatewayChannelSchema,
  "input_locale": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema).default({}),
  "output_locale": z.string() .optional(),
  "route": z.string() .optional(),
  "source_identity": z.string().trim().min(1).max(200),
  "source_label": z.string() .optional(),
  "thread_id": z.string() .optional()
}).strict();
const Output = gatewayInboundValueSchema;

export interface GatewayInboundRoutePorts {
  routeGatewayInbound(input: {
    channel: GatewayChannel;
    source_identity: string;
    body: string;
    source_label?: string;
    account_id?: string;
    thread_id?: string;
    route?: string;
    metadata: Record<string, JsonValue>;
    backend_id?: string;
    input_locale?: string;
    output_locale?: string;
  }): Promise<z.infer<typeof Output>>;
}

const gatewayInboundRoute = defineCommand<GatewayInboundRoutePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.inbound.route",
  "version": "2.0",
  "availability": "active",
  "title": "Route gateway inbound",
  "description": "Route an approved external inbound message into a Host session.",
  "sources": [
    "gateway_inbound"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "chat",
    "gateway"
  ],
  "resourceKinds": [
    "gateway_inbound",
    "backend_run"
  ],
  "proposedEffects": [
    "Route an approved external inbound message into a Host session."
  ],
  "outputResourceKind": "gateway_inbound",
  "uiDisplayCategory": "gateway",
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleGatewayInboundRoute(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const value = await ports.routeGatewayInbound(input);
        return { ok: true, value };
      }
    };
  }
});

export default gatewayInboundRoute;
