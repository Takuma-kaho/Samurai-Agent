// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import {
  GatewayChannelSchema,
  GatewayPairingPolicyStatusSchema,
  GatewayPairingTrustModeSchema,
  type GatewayChannel,
  type GatewayPairingPolicyStatus,
  type GatewayPairingTrustMode,
  type JsonValue
} from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayPairingPolicyValueSchema } from "../../../value-objects/gateway.js";

const policyMetadataSchema = z.record(domainJsonValueSchema)
  .refine((metadata) => Object.keys(metadata).length <= 128, "gateway_policy_metadata_too_large");
const Input = z.object({
  channel: GatewayChannelSchema,
  status: GatewayPairingPolicyStatusSchema.optional(),
  trust_mode: GatewayPairingTrustModeSchema.optional(),
  allowlist: z.array(z.string().trim().min(1).max(512)).max(10_000).optional(),
  allowed_tools: z.array(z.string().trim().min(1).max(512)).max(10_000).optional(),
  pairing_ttl_ms: z.number().int().min(1).max(31_536_000_000).optional(),
  duplicate_window_ms: z.number().int().min(1).max(31_536_000_000).optional(),
  rate_limit_window_ms: z.number().int().min(1).max(31_536_000_000).optional(),
  rate_limit_max: z.number().int().min(1).max(1_000_000).optional(),
  metadata: policyMetadataSchema.optional()
}).strict();
const Output = gatewayPairingPolicyValueSchema;

export type GatewayPairingPolicySaveInput = z.infer<typeof Input>;

export interface GatewayPairingPolicySaveRequest {
  channel: GatewayChannel;
  status?: GatewayPairingPolicyStatus;
  trustMode?: GatewayPairingTrustMode;
  allowlist?: string[];
  allowedTools?: string[];
  pairingTtlMs?: number;
  duplicateWindowMs?: number;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  metadata?: Record<string, JsonValue>;
}

export interface GatewayPairingPolicySavePorts {
  saveGatewayPairingPolicy(request: GatewayPairingPolicySaveRequest): Promise<z.infer<typeof Output>>;
}

const gatewayPairingPolicySave = defineCommand<GatewayPairingPolicySavePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.pairing_policy.save",
  "version": "4.0",
  "availability": "active",
  "title": "Save Gateway pairing policy",
  "description": "Save an owner Gateway pairing policy.",
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
    "Save a Gateway pairing policy."
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
      execute: async function handleGatewayPairingPolicySave(_context: TrustedDomainContext, input: GatewayPairingPolicySaveInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const request: GatewayPairingPolicySaveRequest = {
          channel: input.channel,
          status: input.status,
          trustMode: input.trust_mode,
          allowlist: input.allowlist,
          allowedTools: input.allowed_tools,
          pairingTtlMs: input.pairing_ttl_ms,
          duplicateWindowMs: input.duplicate_window_ms,
          rateLimitWindowMs: input.rate_limit_window_ms,
          rateLimitMax: input.rate_limit_max,
          metadata: input.metadata
        };
        const value = await ports.saveGatewayPairingPolicy(request);
        return { ok: true, value };
      }
    };
  }
});

export default gatewayPairingPolicySave;
