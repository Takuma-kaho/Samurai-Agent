// Domain operation module. Keep its contract and handler together.
import { GeneratedSurfaceDefinitionSchema, GeneratedSurfaceRevisionRecordSchema, type GeneratedSurfaceDefinition, type GeneratedSurfaceRevisionRecord } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({
  "format": z.enum(["html", "zip"]).optional(),
  "revision_id": z.string().trim().min(1).max(256).optional(),
  "surface_id": z.string().trim().min(1).max(256)
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

export type GeneratedSurfaceExportInput = z.infer<typeof Input>;

export interface GeneratedSurfaceExportPorts extends DomainQueryPorts {
  getGeneratedSurface: ReadCapability<(id: string) => Promise<GeneratedSurfaceDefinition | undefined>>;
  getGeneratedSurfaceRevision: ReadCapability<(id: string) => Promise<GeneratedSurfaceRevisionRecord | undefined>>;
  readGeneratedSurfaceBundle: ReadCapability<(id: string) => Promise<{ html: string; css?: string; script?: string } | undefined>>;
  generatedSurfaceQueryError: ReadCapability<(message: string) => Error>;
}

const generatedSurfaceExport = defineQuery<GeneratedSurfaceExportPorts>()({
  ...{
  "kind": "query",
  "id": "generated_surface.export",
  "version": "2.0",
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
      execute: async function handleGeneratedSurfaceExport(_context: TrustedDomainContext, input: GeneratedSurfaceExportInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const surface = await ports.getGeneratedSurface(input.surface_id);
        if (!surface) throw ports.generatedSurfaceQueryError("generated_surface_not_found");
        const revisionId = input.revision_id ?? surface.current_revision_id;
        const revision = await ports.getGeneratedSurfaceRevision(revisionId);
        const bundle = revision ? await ports.readGeneratedSurfaceBundle(revision.id) : undefined;
        if (!revision || revision.surface_id !== surface.id || !bundle) {
          throw ports.generatedSurfaceQueryError("generated_surface_revision_not_found");
        }
        const format = input.format ?? "html";
        return { ok: true, value: Output.parse({ surface, revision, bundle, format, file_name: `${surface.id}-revision-${revision.revision}.${format}` }) };
      }
    };
  }
});

export default generatedSurfaceExport;
