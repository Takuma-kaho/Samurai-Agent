// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionRecordWriteValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "record_id": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "view_id": z.string() .optional()
}).strict();
const Output = collectionRecordWriteValueSchema;

export interface CollectionRecordDeletePorts {
  executeCollectionRecordDelete(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const collectionRecordDelete = defineCommand<CollectionRecordDeletePorts>()({
  ...{
  "kind": "command",
  "id": "collection.record.delete",
  "version": "1.0",
  "availability": "active",
  "title": "Delete collection record",
  "description": "Delete a Collection record through Runtime permission checks.",
  "sources": [
    "surface_operation",
    "runtime_api",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "collection_record",
    "collection",
    "custom_view"
  ],
  "resourceKinds": [
    "collection_record"
  ],
  "proposedEffects": [
    "Delete a schema-validated Collection record when schema and view permissions allow it."
  ],
  "outputResourceKind": "collection_record",
  "uiDisplayCategory": "collection",
  "surfaceOperationKinds": [
    "collection.record.delete"
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
      execute: async function handleCollectionRecordDelete(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCollectionRecordDelete(context, input);
      }
    };
  }
});

export default collectionRecordDelete;
