// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { fileReadValueSchema } from "../../value-objects/file.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "path": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = fileReadValueSchema;

export interface FileInspectPorts extends DomainQueryPorts {
  executeFileInspect(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const fileInspect = defineQuery<FileInspectPorts>()({
  ...{
  "kind": "query",
  "id": "file.inspect",
  "version": "1.0",
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
        return ports.executeFileInspect(context, input);
      }
    };
  }
});

export default fileInspect;
