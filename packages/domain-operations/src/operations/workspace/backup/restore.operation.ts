// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { workspaceRestoreValueSchema } from "../../../value-objects/workspace-maintenance.js";

const Input = z.object({
  "backup_id": z.string().trim().min(1).max(256)
}).strict();
const Output = workspaceRestoreValueSchema;

export interface WorkspaceBackupRestorePorts {
  restoreWorkspaceBackup(input: { backupId: string }): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const workspaceBackupRestore = defineCommand<WorkspaceBackupRestorePorts>()({
  ...{
  "kind": "command",
  "id": "workspace.backup.restore",
  "version": "2.1",
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
      execute: async function handleWorkspaceBackupRestore(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.restoreWorkspaceBackup({ backupId: input.backup_id })) };
      }
    };
  }
});

export default workspaceBackupRestore;
