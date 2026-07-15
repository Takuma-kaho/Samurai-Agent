// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionSchemaWriteValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "actions": z.array(domainJsonValueSchema) .optional(),
  "derived_fields": z.array(domainJsonValueSchema) .optional(),
  "descriptions": z.record(domainJsonValueSchema) .optional(),
  "embeds": z.array(domainJsonValueSchema) .optional(),
  "envelope_id": z.string() .optional(),
  "fields": z.array(domainJsonValueSchema),
  "id": z.string(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "labels": z.record(domainJsonValueSchema) .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "permissions": z.record(domainJsonValueSchema),
  "provider_tool_call": z.boolean() .optional(),
  "refs": z.array(domainJsonValueSchema) .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "triggers": z.array(domainJsonValueSchema) .optional(),
  "version": z.string(),
  "views": z.array(domainJsonValueSchema) .optional()
}).strict();
const Output = collectionSchemaWriteValueSchema;

export interface CollectionSchemaSavePorts {
  executeCollectionSchemaSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const collectionSchemaSave = defineCommand<CollectionSchemaSavePorts>()({
  ...{
  "kind": "command",
  "id": "collection.schema.save",
  "version": "1.0",
  "availability": "active",
  "title": "Save collection schema",
  "description": "Save a Collection schema with validated fields and Workspace view definitions.",
  "sources": [
    "runtime_api",
    "provider_tool_call"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "collection"
  ],
  "resourceKinds": [
    "collection_schema"
  ],
  "proposedEffects": [
    "Create a Collection schema file, renderer view definitions, and SQLite index row."
  ],
  "outputResourceKind": "collection_schema",
  "uiDisplayCategory": "collection",
  "providerToolNames": [
    "samurai.collection.schema.save",
    "collection.schema.save",
    "save_collection_schema",
    "mcp__samurai__collection_schema_save"
  ],
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
      execute: async function handleCollectionSchemaSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCollectionSchemaSave(context, input);
      }
    };
  }
});

export default collectionSchemaSave;
