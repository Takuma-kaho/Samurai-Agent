import {
  CollectionPatchSchema,
  CollectionRecordSchema,
  CollectionSchemaSchema,
  type CollectionPatch,
  type CollectionRecord,
  type CollectionSchema,
  type JsonValue
} from "@samurai-agent/core-schemas";

export type CollectionMarkdownKind = "schema" | "record";

/**
 * Collection definitions and records are kept as readable Markdown files.
 * The JSON block is a deterministic canonical projection consumed by the
 * validator; it is not a second source of truth.
 */
export function renderCollectionMarkdown(kind: CollectionMarkdownKind, value: CollectionSchema | CollectionRecord): string {
  const id = "collection_id" in value ? value.collection_id : value.id;
  const title = kind === "schema" ? `# Collection: ${id}` : `# Collection record: ${id}`;
  return [
    "---",
    `samurai_collection_kind: ${kind}`,
    `collection_id: ${id}`,
    "---",
    title,
    "",
    kind === "schema" ? "This Markdown file is the editable Collection definition." : "This Markdown file is the editable Collection record.",
    "",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
    ""
  ].join("\n");
}

export function parseCollectionMarkdown(value: string, expectedKind: CollectionMarkdownKind): unknown {
  const kind = /^samurai_collection_kind:\s*(schema|record)\s*$/m.exec(value)?.[1];
  if (kind !== expectedKind) throw new Error("collection_markdown_kind_mismatch");
  const match = /```json\s*([\s\S]*?)\s*```/m.exec(value);
  if (!match?.[1]) throw new Error("collection_markdown_json_block_missing");
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error("collection_markdown_json_invalid");
  }
}

export function applyCollectionPatch(record: CollectionRecord, patch: CollectionPatch, schema: CollectionSchema): CollectionRecord {
  const parsedSchema = parseCollectionSchema(schema);
  const parsedRecord = parseCollectionRecord(record, parsedSchema);
  const parsedPatch = parseCollectionPatch(patch, parsedRecord, parsedSchema);

  return {
    ...parsedRecord,
    version: parsedRecord.version + 1,
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

export function parseCollectionRecord(value: unknown, schema: CollectionSchema) {
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
