// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewaySandboxSyncValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({
  "direction": z.string() .optional(),
  "dry_run": z.boolean() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "sandbox_id": z.string(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = gatewaySandboxSyncValueSchema;

export interface GatewaySandboxSyncPorts {
  executeGatewaySandboxSync(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const gatewaySandboxSync = defineCommand<GatewaySandboxSyncPorts>()({
  ...{
  "kind": "command",
  "id": "gateway.sandbox.sync",
  "version": "1.0",
  "availability": "active",
  "title": "Sync Gateway sandbox",
  "description": "Synchronize Workspace data with a Gateway sandbox.",
  "sources": [
    "runtime_api",
    "automation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "sandbox_instance",
    "sandbox_sync"
  ],
  "proposedEffects": [
    "Synchronize Workspace data with a Gateway sandbox."
  ],
  "outputResourceKind": "sandbox_sync",
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
      execute: async function handleGatewaySandboxSync(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGatewaySandboxSync(context, input);
      }
    };
  }
});

export default gatewaySandboxSync;
