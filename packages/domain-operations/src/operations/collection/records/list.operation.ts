// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionRecordsListValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string(),
  "envelope_id": z.string() .optional(),
  "fields": z.array(z.string()) .optional(),
  "ids": z.array(z.string()) .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = collectionRecordsListValueSchema;

export interface CollectionRecordsListPorts extends DomainQueryPorts {
  executeCollectionRecordsList(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const collectionRecordsList = defineQuery<CollectionRecordsListPorts>()({
  ...{
  "kind": "query",
  "id": "collection.records.list",
  "version": "1.0",
  "availability": "active",
  "title": "List Collection records",
  "description": "Read computed Collection records and linked data.",
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
      execute: async function handleCollectionRecordsList(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCollectionRecordsList(context, input);
      }
    };
  }
});

export default collectionRecordsList;
