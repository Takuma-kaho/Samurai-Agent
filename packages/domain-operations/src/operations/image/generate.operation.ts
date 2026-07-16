// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { SupportedLocaleSchema, type ActivityInboxItem, ArtifactRecord, type ArtifactRevisionRecord, type JsonValue, type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactRevisionWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "data_base64": z.string().min(4).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine((value) => value.length % 4 === 0),
  "height": z.number().int().min(1),
  "input_locale": SupportedLocaleSchema.optional(),
  "mime_type": z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
  "output_locale": SupportedLocaleSchema.optional(),
  "preview": z.string() .optional(),
  "prompt": z.string().trim().min(1),
  "provenance": z.record(domainJsonValueSchema).default({}),
  "provider": z.string().trim().min(1),
  "source_run_id": z.string().trim().min(1),
  "title": z.string().trim().min(1).default("Generated image"),
  "width": z.number().int().min(1)
}).strict();
const Output = artifactRevisionWriteValueSchema;

export interface ImageGeneratePorts {
  artifactContract(id: "image.generate"): { id: string; proposed_effects: string[] };
  ensureArtifactSession(): Promise<SessionRecord>; createArtifactEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  decodeImageBase64(value: string): Uint8Array;
  createArtifactDraft(input: { operation: OperationRecord; title: string; content: { bytes: Uint8Array; mime_type: string; extension: string; preview?: string }; kind: "image"; locale: z.infer<typeof SupportedLocaleSchema>; sourceLocales: z.infer<typeof SupportedLocaleSchema>[]; createdBy: string; metadata: Record<string, JsonValue> }): Promise<ArtifactRecord>;
  createArtifactRevision(input: { artifactId: string; content: Uint8Array; extension: string; producerRunId: string; editorSource: "image_provider"; changeSummary: string; provenance: Record<string, JsonValue> }): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord }>;
  createArtifactRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runArtifactMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string; extra: { revision: ArtifactRevisionRecord } }> }): Promise<{ resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[]; revision: ArtifactRevisionRecord }>;
}

const imageGenerate = defineCommand<ImageGeneratePorts>()({
  ...{
  "kind": "command",
  "id": "image.generate",
  "version": "3.0",
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
        const contract = ports.artifactContract("image.generate");
        const bytes = ports.decodeImageBase64(input.data_base64);
        const extension = extensions[input.mime_type];
        const provenance = imageProvenance(input);
        const session = await ports.ensureArtifactSession();
        const envelope = ports.createArtifactEnvelope(session, `Save generated image: ${input.title}`);
        const value = await ports.runArtifactMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, execute: async (operation) => {
          const artifact = await ports.createArtifactDraft({ operation, title: input.title, content: { bytes, mime_type: input.mime_type, extension, preview: input.preview }, kind: "image", locale: input.output_locale ?? session.output_locale, sourceLocales: [input.input_locale ?? session.ui_locale], createdBy: "image_provider", metadata: { image_operation: "generate", ...provenance } });
          const created = await ports.createArtifactRevision({ artifactId: artifact.id, content: bytes, extension, producerRunId: input.source_run_id, editorSource: "image_provider", changeSummary: "Saved generated image provider result.", provenance });
          const rollbackPoint = await ports.createArtifactRollback(operation, [artifact.file_ref, created.revision.file_ref], {}, { artifact_id: artifact.id });
          return { resource: created.artifact, ref: created.artifact.file_ref, rollbackPoint, summary: `Saved generated image ${artifact.title}.`, extra: { revision: created.revision } };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default imageGenerate;

const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" } as const;
function imageProvenance(input: z.infer<typeof Input>): Record<string, JsonValue> { return { operation: "generate", prompt: input.prompt, provider: input.provider, source_run_id: input.source_run_id, mime_type: input.mime_type, width: input.width, height: input.height, ...input.provenance }; }
