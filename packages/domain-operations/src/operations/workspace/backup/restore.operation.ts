// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { workspaceRestoreValueSchema } from "../../../value-objects/workspace-maintenance.js";

const Input = z.object({
  "backup_id": z.string(),
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
const Output = workspaceRestoreValueSchema;

export interface WorkspaceBackupRestorePorts {
  executeWorkspaceBackupRestore(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const workspaceBackupRestore = defineCommand<WorkspaceBackupRestorePorts>()({
  ...{
  "kind": "command",
  "id": "workspace.backup.restore",
  "version": "1.0",
  "availability": "active",
  "title": "Restore workspace backup",
  "description": "Restore a verified Workspace backup.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "workspace_backup",
    "workspace"
  ],
  "proposedEffects": [
    "Restore a verified Workspace backup."
  ],
  "outputResourceKind": "workspace_backup",
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
      execute: async function handleWorkspaceBackupRestore(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeWorkspaceBackupRestore(context, input);
      }
    };
  }
});

export default workspaceBackupRestore;
