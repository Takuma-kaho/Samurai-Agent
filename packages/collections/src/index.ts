import {
  CollectionPatchSchema,
  CollectionRecordSchema,
  CollectionSchemaSchema,
  type CollectionPatch,
  type CollectionRecord,
  type CollectionSchema,
  type JsonValue
} from "@samurai-agent/core-schemas";

export function applyCollectionPatch(record: CollectionRecord, patch: CollectionPatch, schema: CollectionSchema): CollectionRecord {
  const parsedSchema = parseCollectionSchema(schema);
  const parsedRecord = parseCollectionRecord(record, parsedSchema);
  const parsedPatch = parseCollectionPatch(patch, parsedRecord, parsedSchema);

  return {
    ...parsedRecord,
    data: {
      ...parsedRecord.data,
      ...parsedPatch.changes
    },
    updated_at: parsedPatch.created_at
  };
}

export function parseCollectionSchema(value: unknown): CollectionSchema {
  const schema = CollectionSchemaSchema.parse(value);
  ensureUniqueFields(schema);
  return schema;
}

export function parseCollectionRecord(value: unknown, schema: CollectionSchema): CollectionRecord {
  const record = CollectionRecordSchema.parse(value);
  if (record.collection_id !== schema.id) {
    throw new Error("collection_record_collection_id_mismatch");
  }
  rejectUnknownFields(record.data, allowedFieldIds(schema));
  return record;
}

export function parseCollectionPatch(value: unknown, record: CollectionRecord, schema: CollectionSchema): CollectionPatch {
  const patch = CollectionPatchSchema.parse(value);
  if (patch.record_id !== record.id) {
    throw new Error("collection_patch_record_id_mismatch");
  }
  rejectUnknownFields(patch.changes, allowedFieldIds(schema));
  return patch;
}

function ensureUniqueFields(schema: CollectionSchema): void {
  const seen = new Set<string>();
  for (const field of schema.fields) {
    const id = fieldId(field);
    if (!id) {
      throw new Error("collection_field_id_required");
    }
    if (seen.has(id)) {
      throw new Error(`collection_field_duplicate:${id}`);
    }
    seen.add(id);
  }
}

function allowedFieldIds(schema: CollectionSchema): Set<string> {
  return new Set(schema.fields.map(fieldId).filter((id): id is string => Boolean(id)));
}

function rejectUnknownFields(data: Record<string, JsonValue>, allowed: Set<string>): void {
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      throw new Error(`collection_unknown_field:${key}`);
    }
  }
}

function fieldId(field: Record<string, JsonValue>): string | undefined {
  const value = field.id ?? field.name;
  return typeof value === "string" && value.trim() ? value : undefined;
}
