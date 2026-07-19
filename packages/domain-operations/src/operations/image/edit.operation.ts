// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, ArtifactRecord, ArtifactRevisionRecord, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactRevisionWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "artifact_id": z.string().trim().min(1),
  "base_revision_id": z.string().trim().min(1).optional(),
  "change_summary": z.string().trim().min(1).optional(),
  "data_base64": z.string().min(4).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine((value) => value.length % 4 === 0),
  "height": z.number().int().min(1),
  "mime_type": z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
  "prompt": z.string().trim().min(1),
  "provenance": z.record(domainJsonValueSchema).default({}),
  "provider": z.string().trim().min(1),
  "source_run_id": z.string().trim().min(1),
  "width": z.number().int().min(1)
}).strict();
const Output = artifactRevisionWriteValueSchema;

export interface ImageEditPorts {
  artifactContract(id: "image.edit"): { id: string; proposed_effects: string[] };
  getArtifact(id: string): Promise<ArtifactRecord | undefined>; imageArtifactNotFoundError(): Error;
  ensureArtifactSession(): Promise<SessionRecord>; createArtifactEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  decodeImageBase64(value: string): Uint8Array;
  createArtifactRevision(input: { artifactId: string; content: Uint8Array; extension: string; baseRevisionId?: string; producerRunId: string; editorSource: "image_provider"; changeSummary: string; provenance: Record<string, JsonValue> }): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord }>;
  createArtifactRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runArtifactMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string; extra: { revision: ArtifactRevisionRecord } }> }): Promise<{ resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[]; revision: ArtifactRevisionRecord }>;
}

const imageEdit = defineCommand<ImageEditPorts>()({
  ...{
  "kind": "command",
  "id": "image.edit",
  "version": "3.0",
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
        const artifact = await ports.getArtifact(input.artifact_id);
        if (!artifact || artifact.kind !== "image") throw ports.imageArtifactNotFoundError();
        const contract = ports.artifactContract("image.edit");
        const bytes = ports.decodeImageBase64(input.data_base64);
        const extension = extensions[input.mime_type];
        const provenance = imageProvenance(input, artifact.id);
        const session = await ports.ensureArtifactSession();
        const envelope = ports.createArtifactEnvelope(session, `Save edited image: ${artifact.title}`);
        const value = await ports.runArtifactMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [artifact.file_ref], execute: async (operation) => {
          const created = await ports.createArtifactRevision({ artifactId: artifact.id, content: bytes, extension, baseRevisionId: input.base_revision_id ?? currentRevisionId(artifact), producerRunId: input.source_run_id, editorSource: "image_provider", changeSummary: input.change_summary ?? "Saved image provider edit.", provenance });
          const rollbackPoint = await ports.createArtifactRollback(operation, [artifact.file_ref, created.revision.file_ref], { artifact: jsonRecord(artifact) }, { artifact: jsonRecord(created.artifact) });
          return { resource: created.artifact, ref: created.artifact.file_ref, rollbackPoint, summary: `Saved edited image ${artifact.title}.`, extra: { revision: created.revision } };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default imageEdit;

const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" } as const;
function currentRevisionId(artifact: ArtifactRecord): string | undefined { return typeof artifact.metadata.current_revision_id === "string" ? artifact.metadata.current_revision_id : undefined; }
function imageProvenance(input: z.infer<typeof Input>, sourceArtifactId: string): Record<string, JsonValue> { return { operation: "edit", prompt: input.prompt, provider: input.provider, source_run_id: input.source_run_id, mime_type: input.mime_type, width: input.width, height: input.height, source_asset_id: sourceArtifactId, ...input.provenance }; }
function jsonRecord(artifact: ArtifactRecord): Record<string, JsonValue> { return JSON.parse(JSON.stringify(artifact)) as Record<string, JsonValue>; }
