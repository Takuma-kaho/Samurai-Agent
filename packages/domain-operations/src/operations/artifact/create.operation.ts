// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactCreateValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "content": z.string(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "instruction": z.string() .optional(),
  "kind": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "title": z.string()
}).strict();
const Output = artifactCreateValueSchema;

export interface ArtifactCreatePorts {
  executeArtifactCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const artifactCreate = defineCommand<ArtifactCreatePorts>()({
  ...{
  "kind": "command",
  "id": "artifact.create",
  "version": "1.0",
  "availability": "active",
  "title": "Create artifact",
  "description": "Create a local workspace artifact from backend, UI, or generated surface output.",
  "sources": [
    "surface_operation",
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "artifact",
    "form",
    "table",
    "chart",
    "custom_view"
  ],
  "resourceKinds": [
    "artifact"
  ],
  "proposedEffects": [
    "Create a local workspace artifact draft."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
  "providerToolNames": [
    "create_artifact",
    "samurai.artifact.create",
    "mcp__samurai__artifact_create"
  ],
  "surfaceOperationKinds": [
    "form.submit",
    "table.patch",
    "chart.request",
    "artifact.request",
    "custom_view.action"
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
      execute: async function handleArtifactCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeArtifactCreate(context, input);
      }
    };
  }
});

export default artifactCreate;
