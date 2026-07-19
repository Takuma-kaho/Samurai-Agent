// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionSchemaDocsValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({}).strict();
const Output = collectionSchemaDocsValueSchema;

export interface CollectionSchemaDocsPorts extends DomainQueryPorts {
  readCollectionSchemaDocs: ReadCapability<() => Promise<z.infer<typeof Output>> | z.infer<typeof Output>>;
}

const collectionSchemaDocs = defineQuery<CollectionSchemaDocsPorts>()({
  ...{
  "kind": "query",
  "id": "collection.schema.docs",
  "version": "2.0",
  "availability": "active",
  "title": "Read Collection schema docs",
  "description": "Read the supported Collection schema and view contract.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation",
    "generated_surface"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "collection",
    "custom_view"
  ],
  "resourceKinds": [
    "collection_schema_docs"
  ],
  "proposedEffects": [
    "Read Collection schema documentation without changing Workspace state."
  ],
  "outputResourceKind": "collection_schema_docs",
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
      execute: async function handleCollectionSchemaDocs(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.readCollectionSchemaDocs()) };
      }
    };
  }
});

export default collectionSchemaDocs;
