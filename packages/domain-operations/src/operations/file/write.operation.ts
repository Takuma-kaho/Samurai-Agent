// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { fileResourceSchema } from "../../value-objects/file.js";
import { runtimeWriteValueSchema } from "../../value-objects/runtime-write.js";

const Input = z.object({
  "content": z.string(),
  "path": z.string().trim().min(1)
}).strict();
const Output = runtimeWriteValueSchema(fileResourceSchema);

export interface FileWritePorts {
  resolveFilePath(path: string): { absolutePath: string; relativePath: string };
  ensureFileSession(): Promise<SessionRecord>;
  createFileEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  readFileTextIfExists(path: string): Promise<string | undefined>;
  ensureFileParent(path: string): Promise<void>;
  writeFileText(path: string, content: string): Promise<void>;
  isManagedCollectionPath(path: string): boolean;
  reindexManagedCollections(): Promise<unknown>;
  createFileRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runFileMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: z.infer<typeof fileResourceSchema>; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: z.infer<typeof fileResourceSchema>; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const fileWrite = defineCommand<FileWritePorts>()({
  ...{
  "kind": "command",
  "id": "file.write",
  "version": "2.0",
  "availability": "active",
  "title": "Write workspace file",
  "description": "Write a file inside the local workspace.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "file"
  ],
  "proposedEffects": [
    "Write a file inside the local workspace."
  ],
  "outputResourceKind": "file",
  "uiDisplayCategory": "workspace",
  "providerToolNames": [
    "file.write"
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
      execute: async function handleFileWrite(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const path = ports.resolveFilePath(input.path);
        const session = await ports.ensureFileSession();
        const envelope = ports.createFileEnvelope(session, `file.write: ${path.relativePath}`);
        const ref: ResourceRef = { kind: "file", id: path.relativePath, uri: path.relativePath, label: path.relativePath };
        const value = await ports.runFileMutation({
          session, envelope, operationName: "file.write",
          proposedEffects: [`file.write ${path.relativePath} inside the workspace.`], targetResourceRefs: [ref],
          execute: async (operation) => {
            const before = await ports.readFileTextIfExists(path.absolutePath);
            await ports.ensureFileParent(path.absolutePath);
            await ports.writeFileText(path.absolutePath, input.content);
            if (ports.isManagedCollectionPath(path.relativePath)) await ports.reindexManagedCollections();
            const rollbackPoint = await ports.createFileRollback(operation, [ref], { path: path.relativePath, content: before ?? null }, { path: path.relativePath, content: input.content });
            return { resource: { path: path.relativePath, content: input.content }, ref, rollbackPoint, summary: `Wrote workspace file ${path.relativePath}.` };
          }
        });
        return { ok: true, value };
      }
    };
  }
});

export default fileWrite;
