import { ArtifactRecordSchema, ArtifactRevisionRecordSchema, WorkspaceChangeRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { runtimeWriteValueSchema } from "./runtime-write.js";
import { domainJsonValueSchema } from "../definition/index.js";
import { surfaceRenderSpecSchema } from "./surface-render.js";

export const artifactWriteValueSchema = runtimeWriteValueSchema(ArtifactRecordSchema);
export const artifactRevisionWriteValueSchema = runtimeWriteValueSchema(ArtifactRecordSchema, {
  revision: ArtifactRevisionRecordSchema
});
export const artifactRepairWriteValueSchema = runtimeWriteValueSchema(ArtifactRecordSchema, {
  repair: z.object({ repaired: z.boolean() }).strict()
});

const surfaceArtifactWriteValueSchema = runtimeWriteValueSchema(ArtifactRecordSchema, {
  sourceArtifact: ArtifactRecordSchema.optional(),
  workspaceChange: WorkspaceChangeRecordSchema
});

export const artifactCreateValueSchema = z.union([
  artifactWriteValueSchema,
  z.object({
    operation: z.record(domainJsonValueSchema),
    result_kind: z.enum(["chat_turn", "collection_view", "collection_record", "collection_patch", "collection_delete", "collection_action", "message_presentation", "artifact", "form_submission", "table_patch", "chart_request", "custom_view_action"]),
    render_spec: surfaceRenderSpecSchema,
    render_specs: z.array(surfaceRenderSpecSchema).optional(),
    result: surfaceArtifactWriteValueSchema
  }).strict()
]);
