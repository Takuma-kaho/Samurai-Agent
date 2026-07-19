// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import {
  GatewayChannelSchema,
  GatewayRoutingPolicyStatusSchema,
  GatewayRoutingSessionKeyStrategySchema,
  type GatewayChannel,
  type GatewayRoutingPolicyStatus,
  type GatewayRoutingSessionKeyStrategy,
  type JsonValue
} from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayRoutingPolicyValueSchema } from "../../../value-objects/gateway.js";

const policyMetadataSchema = z.record(domainJsonValueSchema)
  .refine((metadata) => Object.keys(metadata).length <= 128, "gateway_policy_metadata_too_large");
const Input = z.object({
  channel: GatewayChannelSchema,
  status: GatewayRoutingPolicyStatusSchema.optional(),
  session_key_strategy: GatewayRoutingSessionKeyStrategySchema.optional(),
  /** `null` deliberately clears the default account. */
  default_account_id: z.string().trim().min(1).max(256).nullable().optional(),
  /** `null` deliberately clears the default thread. */
  default_thread_id: z.string().trim().min(1).max(256).nullable().optional(),
  default_route: z.string().trim().min(1).max(512).optional(),
  metadata: policyMetadataSchema.optional()
}).strict();
const Output = gatewayRoutingPolicyValueSchema;

export type GatewayRoutingPolicySaveInput = z.infer<typeof Input>;

export interface GatewayRoutingPolicySaveRequest {
  channel: GatewayChannel;
  status?: GatewayRoutingPolicyStatus;
  sessionKeyStrategy?: GatewayRoutingSessionKeyStrategy;
  defaultAccountId?: string | null;
  defaultThreadId?: string | null;
  defaultRoute?: string;
  metadata?: Record<string, JsonValue>;
}

export interface GatewayRoutingPolicySavePorts {
  saveGatewayRoutingPolicy(request: GatewayRoutingPolicySaveRequest): Promise<z.infer<typeof Output>>;
}

const gatewayRoutingPolicySave = defineCommand<GatewayRoutingPolicySavePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.routing_policy.save",
  "version": "3.0",
  "availability": "active",
  "title": "Save Gateway routing policy",
  "description": "Save an owner Gateway routing policy.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "gateway_policy"
  ],
  "proposedEffects": [
    "Save a Gateway routing policy."
  ],
  "outputResourceKind": "gateway_policy",
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
      execute: async function handleGatewayRoutingPolicySave(_context: TrustedDomainContext, input: GatewayRoutingPolicySaveInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const request: GatewayRoutingPolicySaveRequest = {
          channel: input.channel,
          status: input.status,
          sessionKeyStrategy: input.session_key_strategy,
          defaultAccountId: input.default_account_id,
          defaultThreadId: input.default_thread_id,
          defaultRoute: input.default_route,
          metadata: input.metadata
        };
        const value = await ports.saveGatewayRoutingPolicy(request);
        return { ok: true, value };
      }
    };
  }
});

export default gatewayRoutingPolicySave;
