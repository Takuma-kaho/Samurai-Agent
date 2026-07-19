// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { GatewaySandboxWorkspaceSyncDirectionSchema, type GatewaySandboxWorkspaceSyncDirection } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewaySandboxSyncValueSchema } from "../../../value-objects/gateway.js";

const Input = z.object({
  "direction": GatewaySandboxWorkspaceSyncDirectionSchema.optional(),
  "dry_run": z.boolean().default(true),
  "sandbox_id": z.string()
}).strict();
const Output = gatewaySandboxSyncValueSchema;

export interface GatewaySandboxSyncPorts {
  syncGatewaySandbox(id: string, input: { direction?: GatewaySandboxWorkspaceSyncDirection; dryRun: boolean }): Promise<z.infer<typeof Output>>;
}

const gatewaySandboxSync = defineCommand<GatewaySandboxSyncPorts>()({
  ...{
  "kind": "command",
  "id": "gateway.sandbox.sync",
  "version": "3.0",
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
        const value = await ports.syncGatewaySandbox(input.sandbox_id, {
          direction: input.direction,
          dryRun: input.dry_run
        });
        return { ok: true, value };
      }
    };
  }
});

export default gatewaySandboxSync;
