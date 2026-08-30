// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { workspaceBackupValueSchema } from "../../../value-objects/workspace-maintenance.js";

const Input = z.object({}).strict();
const Output = workspaceBackupValueSchema;

export interface WorkspaceBackupCreatePorts {
  createWorkspaceBackup(): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const workspaceBackupCreate = defineCommand<WorkspaceBackupCreatePorts>()({
  ...{
  "kind": "command",
  "id": "workspace.backup.create",
  "version": "2.2",
  "availability": "active",
  "title": "Create workspace backup",
  "description": "Create an atomic Workspace backup.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "workspace_backup"
  ],
  "proposedEffects": [
    "Create an atomic Workspace backup."
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
      execute: async function handleWorkspaceBackupCreate(_context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.createWorkspaceBackup()) };
      }
    };
  }
});

export default workspaceBackupCreate;
