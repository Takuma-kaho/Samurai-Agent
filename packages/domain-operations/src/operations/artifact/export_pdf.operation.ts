// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "artifact_id": z.string(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = artifactWriteValueSchema;

export interface ArtifactExportPdfPorts {
  executeArtifactExportPdf(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const artifactExportPdf = defineCommand<ArtifactExportPdfPorts>()({
  ...{
  "kind": "command",
  "id": "artifact.export_pdf",
  "version": "3.0",
  "availability": "active",
  "runtimeRequirements": ["pdf_export"],
  "title": "Export PDF",
  "description": "Export a text Artifact through a configured PDF adapter while preserving source revision provenance.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation"
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
    "Create a PDF Artifact from the selected source Artifact."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
  "providerToolNames": [
    "artifact.export_pdf",
    "samurai.artifact.export_pdf"
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
      execute: async function handleArtifactExportPdf(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeArtifactExportPdf(context, input);
      }
    };
  }
});

export default artifactExportPdf;
