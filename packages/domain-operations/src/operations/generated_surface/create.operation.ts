// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { generatedSurfaceSavedValueSchema } from "../../value-objects/generated-surface.js";

const Input = z.object({
  "bundle": z.record(domainJsonValueSchema),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "producer_run_id": z.string() .optional(),
  "prompt_fingerprint": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "request": z.record(domainJsonValueSchema),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = generatedSurfaceSavedValueSchema;

export interface GeneratedSurfaceCreatePorts {
  executeGeneratedSurfaceCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const generatedSurfaceCreate = defineCommand<GeneratedSurfaceCreatePorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.create",
  "version": "1.0",
  "availability": "active",
  "title": "Create generated surface",
  "description": "Validate and persist a versioned Generated Surface bundle.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "custom_view"
  ],
  "resourceKinds": [
    "generated_surface"
  ],
  "proposedEffects": [
    "Validate and persist a versioned Generated Surface bundle."
  ],
  "outputResourceKind": "generated_surface",
  "uiDisplayCategory": "generated_surface",
  "providerToolNames": [
    "generated_surface.create",
    "samurai.generated_surface.create",
    "mcp__samurai__generated_surface_create",
    "create_generated_surface"
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
      execute: async function handleGeneratedSurfaceCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGeneratedSurfaceCreate(context, input);
      }
    };
  }
});

export default generatedSurfaceCreate;
