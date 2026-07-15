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
  "surface_id": z.string(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = generatedSurfaceSavedValueSchema;

export interface GeneratedSurfaceRevisePorts {
  executeGeneratedSurfaceRevise(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const generatedSurfaceRevise = defineCommand<GeneratedSurfaceRevisePorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.revise",
  "version": "1.0",
  "availability": "active",
  "title": "Revise generated surface",
  "description": "Create a new immutable revision of a Generated Surface.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "custom_view"
  ],
  "resourceKinds": [
    "generated_surface"
  ],
  "proposedEffects": [
    "Create a new immutable Generated Surface revision."
  ],
  "outputResourceKind": "generated_surface",
  "uiDisplayCategory": "generated_surface",
  "providerToolNames": [
    "generated_surface.revise",
    "samurai.generated_surface.revise",
    "mcp__samurai__generated_surface_revise"
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
      execute: async function handleGeneratedSurfaceRevise(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGeneratedSurfaceRevise(context, input);
      }
    };
  }
});

export default generatedSurfaceRevise;
