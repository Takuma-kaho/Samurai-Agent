// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { fileResourceSchema } from "../../value-objects/file.js";
import { runtimeWriteValueSchema } from "../../value-objects/runtime-write.js";

const Input = z.object({
  "content": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "path": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "replace": z.string() .optional(),
  "search": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = runtimeWriteValueSchema(fileResourceSchema);

export interface FilePatchPorts {
  executeFilePatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const filePatch = defineCommand<FilePatchPorts>()({
  ...{
  "kind": "command",
  "id": "file.patch",
  "version": "2.0",
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
        return ports.executeFilePatch(context, input);
      }
    };
  }
});

export default filePatch;
