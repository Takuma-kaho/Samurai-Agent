// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ResourceRefSchema, type ActivityInboxItem, type ActivityRecord, type GeneratedSurfaceDefinition, type GeneratedSurfaceRevisionRecord, type OperationRecord, type ResourceRef, type RollbackPoint, type SurfaceGenerationRequest } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { generatedSurfaceSavedValueSchema } from "../../value-objects/generated-surface.js";

const boundedJsonObjectSchema = z.record(domainJsonValueSchema)
  .refine((value) => Object.keys(value).length <= 128, "generated_surface_json_object_too_large");
const generatedSurfaceRequestSchema = z.object({
  user_intent: z.string().trim().min(1).max(100_000),
  source_resource_refs: z.array(ResourceRefSchema).max(128),
  allowed_domain_commands: z.array(z.string().trim().min(1).max(256)).max(128),
  selected_knowledge_refs: z.array(ResourceRefSchema).max(128),
  selected_skill_refs: z.array(ResourceRefSchema).max(128),
  client_capabilities: boundedJsonObjectSchema,
  expected_lifetime: z.enum(["message", "session", "pinned"]),
  fallback_chain: z.array(z.enum(["built_in_surface", "artifact", "text"])).min(1).max(3)
}).strict();
const actionSchema = z.object({
  id: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(512),
  command_id: z.string().trim().min(1).max(256),
  input_schema: boundedJsonObjectSchema,
  payload_template: boundedJsonObjectSchema.default({}),
  requires_confirmation: z.boolean().default(false)
}).strict();
const assetPathSchema = z.string().trim().min(1).max(1_024).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/")
    && normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    && /^[A-Za-z0-9._~/-]+$/.test(normalized);
}, "generated_surface_asset_path_invalid");
const assetSchema = z.object({
  path: assetPathSchema,
  content: z.string().max(2_000_000),
  encoding: z.enum(["utf8", "base64"]).optional(),
  mime_type: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/).optional()
}).strict();
const Bundle = z.object({
  title: z.string().trim().min(1).max(512),
  html: z.string().min(1).max(200_000),
  css: z.string().max(100_000).optional(),
  script: z.string().max(50_000).optional(),
  actions: z.array(actionSchema).max(20),
  input_data_schema: boundedJsonObjectSchema.optional(),
  assets: z.array(assetSchema).max(50)
    .refine((assets) => assets.reduce((size, asset) => size + asset.content.length, 0) <= 2_700_000, "generated_surface_assets_too_large")
    .optional()
}).strict();
const BundleInput = z.union([Bundle, z.object({ custom_view: Bundle }).strict()]);
const Input = z.object({
  bundle: BundleInput,
  request: generatedSurfaceRequestSchema
}).strict();
const Output = generatedSurfaceSavedValueSchema;

export type GeneratedSurfaceBundleInput = z.infer<typeof Bundle>;
export type GeneratedSurfaceCreateInput = z.infer<typeof Input>;

export interface GeneratedSurfaceCreatePorts {
  createGeneratedSurfaceRequestId(): string;
  generatedSurfaceNow(): string;
  generatedSurfaceFingerprint(value: string): string;
  buildGeneratedSurfaceRevision(input: { request: SurfaceGenerationRequest; bundle: GeneratedSurfaceBundleInput; producerRunId?: string; promptFingerprint?: string; existing?: GeneratedSurfaceDefinition; surfaceId?: string; revisionId?: string }): { definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord };
  saveGeneratedSurfaceRevision(input: { definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord; html: string; css?: string; script?: string; assets?: GeneratedSurfaceBundleInput["assets"] }): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord }>;
  runGeneratedSurfaceMutation<TExtra extends Record<string, unknown>>(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord, activity?: ActivityRecord): Promise<{ resource: GeneratedSurfaceDefinition; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string } & TExtra> }): Promise<{ resource: GeneratedSurfaceDefinition; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] } & TExtra>;
}

const generatedSurfaceCreate = defineCommand<GeneratedSurfaceCreatePorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.create",
  "version": "4.0",
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
      execute: async function handleGeneratedSurfaceCreate(context: TrustedDomainContext, input: GeneratedSurfaceCreateInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const bundle = "custom_view" in input.bundle ? input.bundle.custom_view : input.bundle;
        const saved = await ports.runGeneratedSurfaceMutation<{ revision: GeneratedSurfaceRevisionRecord }>({
          trustedContext: context,
          inputSummary: `Create generated surface: ${bundle.title}`,
          operationName: "generated_surface.create",
          proposedEffects: ["Validate and persist a versioned Generated Surface bundle."],
          execute: async (operation, activity) => {
            const request: SurfaceGenerationRequest = {
              id: ports.createGeneratedSurfaceRequestId(),
              ...(context.sessionId ? { session_id: context.sessionId } : {}),
              ...(context.sessionRef ? { session_ref: context.sessionRef } : {}),
              ...(activity ? { activity_id: activity.id } : {}),
              domain_operation_id: operation.id,
              user_intent: input.request.user_intent,
              source_resource_refs: input.request.source_resource_refs,
              allowed_domain_commands: input.request.allowed_domain_commands,
              selected_knowledge_refs: input.request.selected_knowledge_refs,
              selected_skill_refs: input.request.selected_skill_refs,
              client_capabilities: input.request.client_capabilities,
              expected_lifetime: !context.sessionId && input.request.expected_lifetime === "pinned" ? "session" : input.request.expected_lifetime,
              fallback_chain: input.request.fallback_chain,
              created_at: ports.generatedSurfaceNow()
            };
            const built = ports.buildGeneratedSurfaceRevision({
              request,
              bundle,
              producerRunId: context.runId,
              promptFingerprint: ports.generatedSurfaceFingerprint(input.request.user_intent)
            });
            const persisted = await ports.saveGeneratedSurfaceRevision({
              definition: built.definition,
              revision: built.revision,
              html: bundle.html,
              css: bundle.css,
              script: bundle.script,
              assets: bundle.assets
            });
            return {
              resource: persisted.definition,
              ref: { kind: "generated_surface", id: persisted.definition.id, uri: `surfaces/${persisted.definition.id}`, label: persisted.definition.title },
              summary: `Created generated surface ${persisted.definition.title}.`,
              revision: persisted.revision
            };
          }
        });
        return { ok: true, value: Output.parse({ definition: saved.resource, revision: saved.revision }) };
      }
    };
  }
});

export default generatedSurfaceCreate;
