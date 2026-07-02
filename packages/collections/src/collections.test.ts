import { describe, expect, it } from "vitest";
import { nowIso, type CollectionPatch, type CollectionRecord, type CollectionSchema } from "@samurai-agent/core-schemas";
import { applyCollectionPatch, parseCollectionRecord, parseCollectionSchema } from "./index";

const schema: CollectionSchema = {
  id: "people",
  version: "1",
  labels: { ja: "人", en: "People", zh: "People", ko: "People", es: "People", "pt-BR": "People", fr: "People", de: "People" },
  descriptions: { ja: "人の一覧", en: "People", zh: "People", ko: "People", es: "People", "pt-BR": "People", fr: "People", de: "People" },
  fields: [{ id: "name", type: "string" }],
  refs: [],
  embeds: [],
  derived_fields: [],
  triggers: [],
  actions: [],
  permissions: {}
};

function record(): CollectionRecord {
  const now = nowIso();
  return {
    id: "person_1",
    collection_id: "people",
    data: { name: "Takuma" },
    resource_refs: [],
    created_at: now,
    updated_at: now
  };
}

describe("collections", () => {
  it("parses schema and records", () => {
    const parsedSchema = parseCollectionSchema(schema);
    const parsedRecord = parseCollectionRecord(record(), parsedSchema);

    expect(parsedRecord.data.name).toBe("Takuma");
  });

  it("applies patches and rejects unknown fields", () => {
    const patch: CollectionPatch = {
      id: "patch_1",
      record_id: "person_1",
      changes: { name: "Samurai" },
      source_operation_id: "operation_1",
      created_at: nowIso()
    };

    expect(applyCollectionPatch(record(), patch, schema).data.name).toBe("Samurai");
    expect(() => applyCollectionPatch(record(), { ...patch, changes: { unknown: true } }, schema)).toThrow("collection_unknown_field");
  });

  it("rejects collection and record mismatches", () => {
    expect(() => parseCollectionRecord({ ...record(), collection_id: "other" }, schema)).toThrow("collection_record_collection_id_mismatch");
    expect(() => applyCollectionPatch(record(), { id: "patch_2", record_id: "other", changes: {}, source_operation_id: "operation_1", created_at: nowIso() }, schema)).toThrow(
      "collection_patch_record_id_mismatch"
    );
  });
});
