// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { workspaceRepairValueSchema } from "../../value-objects/workspace-maintenance.js";

const Input = z.object({
  "dry_run": z.boolean().default(true)
}).strict();
const Output = workspaceRepairValueSchema;

export interface WorkspaceRepairPorts {
  repairWorkspace(input: { dryRun: boolean }): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const workspaceRepair = defineCommand<WorkspaceRepairPorts>()({
  ...{
  "kind": "command",
  "id": "workspace.repair",
  "version": "2.0",
  "availability": "active",
  "title": "Repair workspace",
  "description": "Inspect and repair recoverable Workspace integrity issues.",
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
    "workspace"
  ],
  "proposedEffects": [
    "Repair recoverable Workspace integrity issues."
  ],
  "outputResourceKind": "workspace_health",
  "uiDisplayCategory": "settings",
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
      execute: async function handleWorkspaceRepair(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.repairWorkspace({ dryRun: input.dry_run })) };
      }
    };
  }
});

export default workspaceRepair;
