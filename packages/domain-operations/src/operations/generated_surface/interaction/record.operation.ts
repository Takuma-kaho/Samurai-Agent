// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { generatedSurfaceInteractionValueSchema } from "../../../value-objects/generated-surface.js";

const Input = z.object({
  "command_id": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "interaction_id": z.string() .optional(),
  "kind": z.string() .optional(),
  "message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "revision_id": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_id": z.string(),
  "surface_operation_id": z.string() .optional(),
  "user_feedback": z.string() .optional()
}).strict();
const Output = generatedSurfaceInteractionValueSchema;

export interface GeneratedSurfaceInteractionRecordPorts {
  executeGeneratedSurfaceInteractionRecord(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const generatedSurfaceInteractionRecord = defineCommand<GeneratedSurfaceInteractionRecordPorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.interaction.record",
  "version": "1.0",
  "availability": "active",
  "title": "Record surface interaction",
  "description": "Record a Generated Surface open, dismiss, correction, or regeneration signal.",
  "sources": [
    "runtime_api",
    "surface_operation",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "generated_surface",
    "surface_interaction"
  ],
  "proposedEffects": [
    "Record a Generated Surface interaction for audit and learning."
  ],
  "outputResourceKind": "surface_interaction",
  "uiDisplayCategory": "generated_surface",
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
      execute: async function handleGeneratedSurfaceInteractionRecord(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGeneratedSurfaceInteractionRecord(context, input);
      }
    };
  }
});

export default generatedSurfaceInteractionRecord;
