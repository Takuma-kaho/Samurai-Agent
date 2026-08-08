// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, JsonValue, OperationRecord, ResourceRef, RollbackPoint } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { fileResourceSchema } from "../../value-objects/file.js";
import { runtimeWriteValueSchema } from "../../value-objects/runtime-write.js";

const Input = z.object({
  "path": z.string().trim().min(1).max(4_096),
  "replace": z.string().max(1_000_000),
  "search": z.string().min(1).max(1_000_000)
}).strict();
const Output = runtimeWriteValueSchema(fileResourceSchema);

export interface FilePatchPorts {
  resolveFilePath(path: string): { absolutePath: string; relativePath: string };
  readFileTextIfExists(path: string): Promise<string | undefined>;
  ensureFileParent(path: string): Promise<void>;
  writeFileText(path: string, content: string): Promise<void>;
  isManagedCollectionPath(path: string): boolean;
  reindexManagedCollections(): Promise<void>;
  fileNotFoundError(path: string): Error;
  filePatchConflictError(): Error;
  createFileRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runFileMutation(input: { trustedContext: TrustedDomainContext; operationName: string; proposedEffects: string[]; inputSummary: string; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: z.infer<typeof fileResourceSchema>; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: z.infer<typeof fileResourceSchema>; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const filePatch = defineCommand<FilePatchPorts>()({
  ...{
  "kind": "command",
  "id": "file.patch",
  "version": "4.0",
  "availability": "active",
  "title": "Patch workspace file",
  "description": "Patch a file inside the local workspace.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "file"
  ],
  "proposedEffects": [
    "Patch a file inside the local workspace."
  ],
  "outputResourceKind": "file",
  "uiDisplayCategory": "workspace",
  "providerToolNames": [
    "file.patch"
  ],
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
      execute: async function handleFilePatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const path = ports.resolveFilePath(input.path);
        const ref: ResourceRef = { kind: "file", id: path.relativePath, uri: path.relativePath, label: path.relativePath };
        const value = await ports.runFileMutation({
          trustedContext: context, operationName: "file.patch", inputSummary: `file.patch: ${path.relativePath}`,
          proposedEffects: [`file.patch ${path.relativePath} inside the workspace.`], targetResourceRefs: [ref],
          execute: async (operation) => {
            const before = await ports.readFileTextIfExists(path.absolutePath);
            if (before === undefined) throw ports.fileNotFoundError(path.relativePath);
            if (!before.includes(input.search)) throw ports.filePatchConflictError();
            const content = before.replace(input.search, input.replace);
            await ports.ensureFileParent(path.absolutePath);
            await ports.writeFileText(path.absolutePath, content);
            if (ports.isManagedCollectionPath(path.relativePath)) await ports.reindexManagedCollections();
            const rollbackPoint = await ports.createFileRollback(operation, [ref], { path: path.relativePath, content: before }, { path: path.relativePath, content });
            return { resource: { path: path.relativePath, content }, ref, rollbackPoint, summary: `Patched workspace file ${path.relativePath}.` };
          }
        });
        return { ok: true, value };
      }
    };
  }
});

export default filePatch;
