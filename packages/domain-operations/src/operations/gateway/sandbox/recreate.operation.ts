// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewaySandboxInstanceValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({
  sandbox_id: z.string().trim().min(1).max(256)
}).strict();
const Output = gatewaySandboxInstanceValueSchema;

export type GatewaySandboxRecreateInput = z.infer<typeof Input>;

export interface GatewaySandboxRecreateRequest {
  sandboxId: string;
}

export interface GatewaySandboxRecreatePorts {
  recreateGatewaySandbox(request: GatewaySandboxRecreateRequest): Promise<z.infer<typeof Output>>;
}

const gatewaySandboxRecreate = defineCommand<GatewaySandboxRecreatePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.sandbox.recreate",
  "version": "2.0",
  "availability": "active",
  "title": "Recreate Gateway sandbox",
  "description": "Recreate a Gateway sandbox instance.",
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
    "sandbox_instance"
  ],
  "proposedEffects": [
    "Recreate a Gateway sandbox instance."
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
      execute: async function handleGatewaySandboxRecreate(_context: TrustedDomainContext, input: GatewaySandboxRecreateInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const request: GatewaySandboxRecreateRequest = { sandboxId: input.sandbox_id };
        const value = await ports.recreateGatewaySandbox(request);
        return { ok: true, value };
      }
    };
  }
});

export default gatewaySandboxRecreate;
