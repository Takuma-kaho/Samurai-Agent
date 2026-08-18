// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { fileReadValueSchema } from "../../value-objects/file.js";

const Input = z.object({
  "path": z.string().trim().min(1).max(4096),
  "limit": z.number().int().min(1).max(200).optional(),
  "offset": z.number().int().min(0).max(10_000).default(0)
}).strict();
const Output = fileReadValueSchema;

export type FileListInput = z.infer<typeof Input>;
export type FileListOutput = z.infer<typeof Output>;

export interface FileListPorts extends DomainQueryPorts {
  listWorkspaceFiles: ReadCapability<(input: { path: string; limit?: number; offset?: number }) => Promise<FileListOutput> | FileListOutput>;
}

const fileList = defineQuery<FileListPorts>()({
  ...{
  "kind": "query",
  "id": "file.list",
  "version": "2.0",
  "availability": "active",
  "title": "List workspace files",
  "description": "List files inside the local workspace.",
  "sources": [
    "provider_tool_call",
  "runtime_api",
  "external_app"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "file"
  ],
  "proposedEffects": [
    "Read file without changing Workspace state."
  ],
  "outputResourceKind": "file",
  "uiDisplayCategory": "workspace",
  "providerToolNames": [
    "file.list"
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
      execute: async function handleFileList(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return {
          ok: true,
          value: Output.parse(await ports.listWorkspaceFiles({
            path: input.path,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            offset: input.offset ?? 0
          }))
        };
      }
    };
  }
});

export default fileList;
