import type { CollectionPatch, CollectionRecord, CollectionSchema } from "@samurai-agent/core-schemas";

export function applyCollectionPatch(record: CollectionRecord, patch: CollectionPatch, schema: CollectionSchema): CollectionRecord {
  const allowedFields = new Set(schema.fields.map((field) => String(field.id ?? field.name ?? "")));
  const changes = Object.fromEntries(
    Object.entries(patch.changes).filter(([key]) => allowedFields.size === 0 || allowedFields.has(key))
  );

  return {
    ...record,
    data: {
      ...record.data,
      ...changes
    },
    updated_at: patch.created_at
  };
}
