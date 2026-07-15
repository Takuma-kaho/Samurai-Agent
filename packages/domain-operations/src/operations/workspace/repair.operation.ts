// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { workspaceRepairValueSchema } from "../../value-objects/workspace-maintenance.js";

const Input = z.object({
  "dry_run": z.boolean() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = workspaceRepairValueSchema;

export interface WorkspaceRepairPorts {
  executeWorkspaceRepair(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const workspaceRepair = defineCommand<WorkspaceRepairPorts>()({
  ...{
  "kind": "command",
  "id": "workspace.repair",
  "version": "1.0",
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
      execute: async function handleWorkspaceRepair(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeWorkspaceRepair(context, input);
      }
    };
  }
});

export default workspaceRepair;
