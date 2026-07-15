// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionSchemaGetValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "slug": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = collectionSchemaGetValueSchema;

export interface CollectionSchemaGetPorts extends DomainQueryPorts {
  executeCollectionSchemaGet(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const collectionSchemaGet = defineQuery<CollectionSchemaGetPorts>()({
  ...{
  "kind": "query",
  "id": "collection.schema.get",
  "version": "1.0",
  "availability": "active",
  "title": "Read Collection schema",
  "description": "Read one validated Collection schema.",
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
      execute: async function handleCollectionSchemaGet(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCollectionSchemaGet(context, input);
      }
    };
  }
});

export default collectionSchemaGet;
