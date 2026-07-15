// Domain operation module. Keep its contract and handler together.
import { GeneratedSurfaceDefinitionSchema, GeneratedSurfaceRevisionRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "format": z.enum(["html", "zip"]) .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "revision_id": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_id": z.string(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = z.object({
  surface: GeneratedSurfaceDefinitionSchema,
  revision: GeneratedSurfaceRevisionRecordSchema,
  bundle: z.object({
    html: z.string(),
    css: z.string().optional(),
    script: z.string().optional()
  }).strict(),
  format: z.enum(["html", "zip"]),
  file_name: z.string().min(1)
}).strict();

export interface GeneratedSurfaceExportPorts extends DomainQueryPorts {
  executeGeneratedSurfaceExport(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const generatedSurfaceExport = defineQuery<GeneratedSurfaceExportPorts>()({
  ...{
  "kind": "query",
  "id": "generated_surface.export",
  "version": "1.0",
  "availability": "active",
  "title": "Export generated surface",
  "description": "Export the selected Generated Surface as HTML or ZIP.",
  "sources": [
    "runtime_api",
    "surface_operation",
    "generated_surface"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "artifact"
  ],
  "resourceKinds": [
    "generated_surface",
    "generated_surface_export"
  ],
  "proposedEffects": [
    "Read generated_surface_export without changing Workspace state."
  ],
  "outputResourceKind": "generated_surface_export",
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
      execute: async function handleGeneratedSurfaceExport(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGeneratedSurfaceExport(context, input);
      }
    };
  }
});

export default generatedSurfaceExport;
