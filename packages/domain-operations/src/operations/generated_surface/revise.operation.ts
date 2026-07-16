// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { GeneratedSurfaceActionDeclarationSchema, SurfaceGenerationRequestSchema, type GeneratedSurfaceDefinition, type GeneratedSurfaceRevisionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { generatedSurfaceSavedValueSchema } from "../../value-objects/generated-surface.js";

const Bundle = z.object({
  title: z.string().trim().min(1), html: z.string().min(1), css: z.string().optional(), script: z.string().optional(),
  actions: z.array(GeneratedSurfaceActionDeclarationSchema), input_data_schema: z.record(z.unknown()).optional(),
  assets: z.array(z.object({ path: z.string().min(1), content: z.string(), encoding: z.enum(["utf8", "base64"]).optional(), mime_type: z.string().optional() }).strict()).optional()
}).strict();
const BundleInput = z.union([Bundle, z.object({ custom_view: Bundle }).strict()]);
const Input = z.object({
  "bundle": BundleInput,
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "producer_run_id": z.string() .optional(),
  "prompt_fingerprint": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "request": SurfaceGenerationRequestSchema,
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_id": z.string(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = generatedSurfaceSavedValueSchema;

export interface GeneratedSurfaceRevisePorts {
  getGeneratedSurface(id: string): Promise<GeneratedSurfaceDefinition | undefined>;
  buildGeneratedSurfaceRevision(input: { request: z.infer<typeof SurfaceGenerationRequestSchema>; bundle: z.infer<typeof Bundle>; producerRunId?: string; promptFingerprint?: string; existing?: GeneratedSurfaceDefinition }): { definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord };
  saveGeneratedSurfaceRevision(input: { definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord; html: string; css?: string; script?: string; assets?: z.infer<typeof Bundle>["assets"] }): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord }>;
  generatedSurfaceReviseError(message: string): Error;
}

const generatedSurfaceRevise = defineCommand<GeneratedSurfaceRevisePorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.revise",
  "version": "2.0",
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
        const existing = await ports.getGeneratedSurface(input.surface_id);
        if (!existing) throw ports.generatedSurfaceReviseError("generated_surface_not_found");
        const bundle = "custom_view" in input.bundle ? input.bundle.custom_view : input.bundle;
        const built = ports.buildGeneratedSurfaceRevision({ request: input.request, bundle, existing, producerRunId: input.producer_run_id, promptFingerprint: input.prompt_fingerprint });
        const saved = await ports.saveGeneratedSurfaceRevision({ definition: built.definition, revision: built.revision, html: bundle.html, css: bundle.css, script: bundle.script, assets: bundle.assets });
        return { ok: true, value: Output.parse(saved) };
      }
    };
  }
});

export default generatedSurfaceRevise;
