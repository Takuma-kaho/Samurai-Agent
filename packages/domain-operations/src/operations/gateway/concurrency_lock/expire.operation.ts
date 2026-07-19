// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayExpiredLocksValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({
  now: z.string().datetime().optional()
}).strict();
const Output = gatewayExpiredLocksValueSchema;

export type GatewayConcurrencyLockExpireInput = z.infer<typeof Input>;

/** The runtime request deliberately excludes transport-only envelope fields. */
export interface GatewayConcurrencyLockExpireRequest {
  now?: string;
}

export interface GatewayConcurrencyLockExpirePorts {
  expireGatewayConcurrencyLocks(request: GatewayConcurrencyLockExpireRequest): Promise<z.infer<typeof Output>>;
}

const gatewayConcurrencyLockExpire = defineCommand<GatewayConcurrencyLockExpirePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.concurrency_lock.expire",
  "version": "2.0",
  "availability": "active",
  "title": "Expire Gateway locks",
  "description": "Expire stale Gateway concurrency locks.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "gateway_lock"
  ],
  "proposedEffects": [
    "Expire stale Gateway concurrency locks."
  ],
  "outputResourceKind": "gateway_lock",
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
      execute: async function handleGatewayConcurrencyLockExpire(_context: TrustedDomainContext, input: GatewayConcurrencyLockExpireInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const request: GatewayConcurrencyLockExpireRequest = input.now === undefined ? {} : { now: input.now };
        const value = await ports.expireGatewayConcurrencyLocks(request);
        return { ok: true, value };
      }
    };
  }
});

export default gatewayConcurrencyLockExpire;
