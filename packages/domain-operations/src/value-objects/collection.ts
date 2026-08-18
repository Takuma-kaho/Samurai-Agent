import { CollectionRecordSchema, CollectionSchemaSchema, SessionRefSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { domainJsonValueSchema } from "../definition/index.js";
import { surfaceRenderSpecSchema } from "./surface-render.js";
import { runtimeWriteValueSchema } from "./runtime-write.js";
import { chatTurnValueSchema } from "./chat.js";

export const storedCollectionSchema = CollectionSchemaSchema.extend({
  file_path: z.string().min(1),
  // This is the optimistic-concurrency version maintained by Workspace Store,
  // distinct from the user-facing Collection schema version string.
  resource_version: z.number().int().positive().optional()
}).strict();
export const storedCollectionRecordSchema = CollectionRecordSchema.extend({ file_path: z.string().min(1) }).strict();
export const collectionSchemaWriteValueSchema = runtimeWriteValueSchema(storedCollectionSchema);
export const collectionRecordWriteValueSchema = runtimeWriteValueSchema(storedCollectionRecordSchema);
export const collectionPatchWriteValueSchema = runtimeWriteValueSchema(storedCollectionRecordSchema, { before: storedCollectionRecordSchema });
const collectionReindexPartitionSchema = z.object({
  files: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.array(z.object({ file_path: z.string(), message: z.string() }).strict())
}).strict();
export const collectionReindexWriteValueSchema = runtimeWriteValueSchema(z.object({
  schemas: collectionReindexPartitionSchema,
  records: collectionReindexPartitionSchema
}).strict());
const collectionActionResourceSchema = z.union([
  storedCollectionRecordSchema,
  z.object({ schemas: collectionReindexPartitionSchema, records: collectionReindexPartitionSchema }).strict(),
  z.object({
    collection_id: z.string().min(1), action_id: z.string().min(1), action_kind: z.string().min(1), status: z.literal("completed"),
    backend_run_id: z.string().min(1), session_ref: SessionRefSchema.optional(), custom_view: z.record(domainJsonValueSchema).optional(),
    output: z.object({ backend_status: z.string().min(1), output_text: z.string(), custom_view: z.record(domainJsonValueSchema).optional() }).strict()
  }).strict(),
  z.object({
    collection_id: z.string().min(1), action_id: z.string().min(1), action_kind: z.string().min(1),
    catalog_action_id: z.string().min(1), handler_id: z.string().optional(), status: z.literal("completed"), output: domainJsonValueSchema.optional()
  }).strict()
]);
export const collectionActionWriteValueSchema = runtimeWriteValueSchema(collectionActionResourceSchema, {
  chat: chatTurnValueSchema.extend({ customView: z.record(domainJsonValueSchema).optional() }).strict().optional(),
  before: storedCollectionRecordSchema.optional()
});

export const collectionRecordsListValueSchema = z.object({
  action: z.literal("getItems"),
  collection_id: z.string().min(1),
  count: z.number().int().nonnegative(),
  items: z.array(z.record(domainJsonValueSchema)),
  linked_data: domainJsonValueSchema,
  schema_fields: domainJsonValueSchema
}).strict();

export const collectionSchemaDocsValueSchema = z.object({
  action: z.literal("schemaDocs"),
  schema_docs: domainJsonValueSchema
}).strict();

export const collectionSchemaGetValueSchema = z.object({
  action: z.literal("getSchema"),
  collection_id: z.string().min(1),
  schema: storedCollectionSchema
}).strict();

export const collectionViewValueSchema = z.object({
  collection_id: z.string().min(1),
  view_id: z.string().min(1),
  schema: storedCollectionSchema,
  record_count: z.number().int().nonnegative(),
  render_spec: surfaceRenderSpecSchema
}).strict();
