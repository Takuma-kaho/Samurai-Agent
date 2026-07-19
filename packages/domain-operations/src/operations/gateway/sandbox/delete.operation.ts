// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewaySandboxInstanceValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({
  sandbox_id: z.string().trim().min(1).max(256)
}).strict();
const Output = gatewaySandboxInstanceValueSchema;

export type GatewaySandboxDeleteInput = z.infer<typeof Input>;

export interface GatewaySandboxDeleteRequest {
  sandboxId: string;
}

export interface GatewaySandboxDeletePorts {
  deleteGatewaySandbox(request: GatewaySandboxDeleteRequest): Promise<z.infer<typeof Output>>;
}

const gatewaySandboxDelete = defineCommand<GatewaySandboxDeletePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.sandbox.delete",
  "version": "2.0",
  "availability": "active",
  "title": "Delete Gateway sandbox",
  "description": "Delete a Gateway sandbox instance.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "sandbox_instance"
  ],
  "proposedEffects": [
    "Delete a Gateway sandbox instance."
  ],
  "outputResourceKind": "sandbox_instance",
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
      execute: async function handleGatewaySandboxDelete(_context: TrustedDomainContext, input: GatewaySandboxDeleteInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const request: GatewaySandboxDeleteRequest = { sandboxId: input.sandbox_id };
        const value = await ports.deleteGatewaySandbox(request);
        return { ok: true, value };
      }
    };
  }
});

export default gatewaySandboxDelete;
