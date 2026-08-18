// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { fileReadValueSchema } from "../../value-objects/file.js";

const Input = z.object({
  "path": z.string().trim().min(1).max(4096)
}).strict();
const Output = fileReadValueSchema;

export type FileReadInput = z.infer<typeof Input>;
export type FileReadOutput = z.infer<typeof Output>;

export interface FileReadPorts extends DomainQueryPorts {
  readWorkspaceFile: ReadCapability<(input: Pick<FileReadInput, "path">) => Promise<FileReadOutput> | FileReadOutput>;
}

const fileRead = defineQuery<FileReadPorts>()({
  ...{
  "kind": "query",
  "id": "file.read",
  "version": "2.0",
  "availability": "active",
  "title": "Read workspace file",
  "description": "Read a file inside the local workspace.",
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
    "file.read"
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
      execute: async function handleFileRead(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.readWorkspaceFile({ path: input.path })) };
      }
    };
  }
});

export default fileRead;
