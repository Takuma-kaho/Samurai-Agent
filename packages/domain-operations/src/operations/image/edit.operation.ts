// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactRevisionWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "artifact_id": z.string(),
  "base_revision_id": z.string() .optional(),
  "change_summary": z.string() .optional(),
  "data_base64": z.string(),
  "envelope_id": z.string() .optional(),
  "height": z.number().int().min(1),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "mime_type": z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
  "output_locale": z.string() .optional(),
  "prompt": z.string(),
  "provenance": z.record(domainJsonValueSchema) .optional(),
  "provider": z.string(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "source_run_id": z.string(),
  "surface_operation_id": z.string() .optional(),
  "width": z.number().int().min(1)
}).strict();
const Output = artifactRevisionWriteValueSchema;

export interface ImageEditPorts {
  executeImageEdit(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const imageEdit = defineCommand<ImageEditPorts>()({
  ...{
  "kind": "command",
  "id": "image.edit",
  "version": "1.0",
  "availability": "active",
  "title": "Save edited image",
  "description": "Save an edited image provider result as a new immutable Artifact revision.",
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
    "artifact",
    "artifact_revision"
  ],
  "proposedEffects": [
    "Save an edited image result as a new Artifact revision while preserving the original asset."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
  "providerToolNames": [
    "image.edit.result",
    "samurai.image.edit.result"
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
      execute: async function handleImageEdit(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeImageEdit(context, input);
      }
    };
  }
});

export default imageEdit;
