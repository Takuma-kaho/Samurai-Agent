// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { CollectionSchema, JsonValue } from "@samurai-agent/core-schemas";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionRecordsListValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string().trim().min(1).max(256),
  "fields": z.array(z.string().trim().min(1).max(256)).max(1_000).default([]),
  "ids": z.array(z.string().trim().min(1).max(256)).max(1_000).default([])
}).strict();
const Output = collectionRecordsListValueSchema;

export interface CollectionRecordsListPorts extends DomainQueryPorts {
  getCollectionSchema: ReadCapability<(id: string) => Promise<(CollectionSchema & { file_path: string }) | undefined>>;
  listCollectionRecords: ReadCapability<(schema: CollectionSchema & { file_path: string }, input: { ids: string[]; fields: string[] }) => Promise<{ collection_id: string; count: number; items: Record<string, JsonValue>[]; linked_data: JsonValue; schema_fields: JsonValue }>>;
  collectionRecordsQueryError: ReadCapability<(message: string) => Error>;
}

const collectionRecordsList = defineQuery<CollectionRecordsListPorts>()({
  ...{
  "kind": "query",
  "id": "collection.records.list",
  "version": "2.0",
  "availability": "active",
  "title": "List Collection records",
  "description": "Read computed Collection records and linked data.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation",
    "generated_surface",
    "external_app"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "collection",
    "collection_record",
    "custom_view"
  ],
  "resourceKinds": [
    "collection_schema",
    "collection_record"
  ],
  "proposedEffects": [
    "Read Collection records without changing Workspace state."
  ],
  "outputResourceKind": "collection_records",
  "uiDisplayCategory": "collection",
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
      execute: async function handleCollectionRecordsList(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const schema = await ports.getCollectionSchema(input.collection_id);
        if (!schema) throw ports.collectionRecordsQueryError(`Collection schema not found: ${input.collection_id}`);
        const records = await ports.listCollectionRecords(schema, { ids: input.ids, fields: input.fields });
        return { ok: true, value: Output.parse({ action: "getItems", ...records }) };
      }
    };
  }
});

export default collectionRecordsList;
