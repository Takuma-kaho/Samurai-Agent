// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { fileReadValueSchema } from "../../value-objects/file.js";

const Input = z.object({
  "path": z.string().trim().min(1).max(4096)
}).strict();
const Output = fileReadValueSchema;

export type FileInspectInput = z.infer<typeof Input>;
export type FileInspectOutput = z.infer<typeof Output>;

export interface FileInspectPorts extends DomainQueryPorts {
  inspectWorkspaceFile: ReadCapability<(input: Pick<FileInspectInput, "path">) => Promise<FileInspectOutput> | FileInspectOutput>;
}

const fileInspect = defineQuery<FileInspectPorts>()({
  ...{
  "kind": "query",
  "id": "file.inspect",
  "version": "2.0",
  "availability": "active",
  "title": "Inspect workspace file",
  "description": "Inspect file metadata, content hash, and related Workspace provenance.",
  "sources": [
    "provider_tool_call",
    "runtime_api",
    "surface_operation"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "file",
    "artifact",
    "workspace_change"
  ],
  "proposedEffects": [
    "Read file without changing Workspace state."
  ],
  "outputResourceKind": "file",
  "uiDisplayCategory": "workspace",
  "providerToolNames": [
    "file.inspect"
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
      execute: async function handleFileInspect(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.inspectWorkspaceFile({ path: input.path })) };
      }
    };
  }
});

export default fileInspect;
