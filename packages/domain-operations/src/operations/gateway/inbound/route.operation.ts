// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { GatewayChannelSchema, SupportedLocaleSchema, type GatewayChannel, type JsonValue, type SupportedLocale } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayInboundValueSchema } from "../../../value-objects/gateway-inbound.js";

const Input = z.object({
  "account_id": z.string().trim().min(1).max(256).optional(),
  "backend_id": z.string().trim().min(1).max(256).optional(),
  "body": z.string().trim().min(1).max(1_000_000),
  "channel": GatewayChannelSchema,
  "input_locale": SupportedLocaleSchema.optional(),
  "metadata": z.record(domainJsonValueSchema)
    .refine((metadata) => Object.keys(metadata).length <= 128, "gateway_inbound_metadata_too_large")
    .default({}),
  "output_locale": SupportedLocaleSchema.optional(),
  "route": z.string().trim().min(1).max(512).optional(),
  "source_identity": z.string().trim().min(1).max(200)
    .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "gateway_source_identity_invalid"),
  "source_label": z.string().trim().min(1).max(512).optional(),
  "thread_id": z.string().trim().min(1).max(256).optional()
}).strict();
const Output = gatewayInboundValueSchema;

export type GatewayInboundRouteInput = z.infer<typeof Input>;

export interface GatewayInboundRouteRequest {
  channel: GatewayChannel;
  sourceIdentity: string;
  body: string;
  sourceLabel?: string;
  accountId?: string;
  threadId?: string;
  route?: string;
  metadata: Record<string, JsonValue>;
  backendId?: string;
  inputLocale?: SupportedLocale;
  outputLocale?: SupportedLocale;
}

export interface GatewayInboundRoutePorts {
  routeGatewayInbound(request: GatewayInboundRouteRequest): Promise<z.infer<typeof Output>>;
}

const gatewayInboundRoute = defineCommand<GatewayInboundRoutePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.inbound.route",
  "version": "4.1",
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
      execute: async function handleGatewayInboundRoute(_context: TrustedDomainContext, input: GatewayInboundRouteInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const request: GatewayInboundRouteRequest = {
          channel: input.channel,
          sourceIdentity: input.source_identity,
          body: input.body,
          sourceLabel: input.source_label,
          accountId: input.account_id,
          threadId: input.thread_id,
          route: input.route,
          metadata: input.metadata,
          backendId: input.backend_id,
          inputLocale: input.input_locale,
          outputLocale: input.output_locale
        };
        const value = await ports.routeGatewayInbound(request);
        return { ok: true, value };
      }
    };
  }
});

export default gatewayInboundRoute;
