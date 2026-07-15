// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactRevisionWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "data_base64": z.string(),
  "envelope_id": z.string() .optional(),
  "height": z.number().int().min(1),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "mime_type": z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
  "output_locale": z.string() .optional(),
  "preview": z.string() .optional(),
  "prompt": z.string(),
  "provenance": z.record(domainJsonValueSchema) .optional(),
  "provider": z.string(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "source_run_id": z.string(),
  "surface_operation_id": z.string() .optional(),
  "title": z.string() .optional(),
  "width": z.number().int().min(1)
}).strict();
const Output = artifactRevisionWriteValueSchema;

export interface ImageGeneratePorts {
  executeImageGenerate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const imageGenerate = defineCommand<ImageGeneratePorts>()({
  ...{
  "kind": "command",
  "id": "image.generate",
  "version": "2.0",
  "availability": "active",
  "title": "Save generated image",
  "description": "Save an image provider result as a provenance-backed Artifact.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "artifact"
  ],
  "resourceKinds": [
    "artifact"
  ],
  "proposedEffects": [
    "Save a generated image provider result as an Artifact."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
  "providerToolNames": [
    "image.generate.result",
    "samurai.image.generate.result"
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
      execute: async function handleImageGenerate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeImageGenerate(context, input);
      }
    };
  }
});

export default imageGenerate;
