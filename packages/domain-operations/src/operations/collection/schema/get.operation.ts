// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { CollectionSchema } from "@samurai-agent/core-schemas";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionSchemaGetValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string().trim().min(1).max(256)
}).strict();
const Output = collectionSchemaGetValueSchema;

export interface CollectionSchemaGetPorts extends DomainQueryPorts {
  getCollectionSchema: ReadCapability<(id: string) => Promise<(CollectionSchema & { file_path: string }) | undefined>>;
  collectionSchemaQueryError: ReadCapability<(message: string) => Error>;
}

const collectionSchemaGet = defineQuery<CollectionSchemaGetPorts>()({
  ...{
  "kind": "query",
  "id": "collection.schema.get",
  "version": "2.0",
  "availability": "active",
  "title": "Read Collection schema",
  "description": "Read one validated Collection schema.",
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
    "custom_view"
  ],
  "resourceKinds": [
    "collection_schema"
  ],
  "proposedEffects": [
    "Read a Collection schema without changing Workspace state."
  ],
  "outputResourceKind": "collection_schema",
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
      execute: async function handleCollectionSchemaGet(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const schema = await ports.getCollectionSchema(input.collection_id);
        if (!schema) throw ports.collectionSchemaQueryError(`Collection schema not found: ${input.collection_id}`);
        return { ok: true, value: Output.parse({ action: "getSchema", collection_id: schema.id, schema }) };
      }
    };
  }
});

export default collectionSchemaGet;
