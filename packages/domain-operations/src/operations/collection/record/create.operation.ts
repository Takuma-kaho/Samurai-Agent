// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionRecordWriteValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string(),
  "data": z.record(domainJsonValueSchema),
  "envelope_id": z.string() .optional(),
  "id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "record_id": z.string() .optional(),
  "resource_refs": z.array(domainJsonValueSchema) .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = collectionRecordWriteValueSchema;

export interface CollectionRecordCreatePorts {
  executeCollectionRecordCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const collectionRecordCreate = defineCommand<CollectionRecordCreatePorts>()({
  ...{
  "kind": "command",
  "id": "collection.record.create",
  "version": "1.0",
  "availability": "active",
  "title": "Create collection record",
  "description": "Create a schema-validated Collection record.",
  "sources": [
    "surface_operation",
    "runtime_api",
    "provider_tool_call",
    "scheduled_context",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "collection_record"
  ],
  "resourceKinds": [
    "collection_record"
  ],
  "proposedEffects": [
    "Create a schema-validated Collection record and return a Collection record render spec."
  ],
  "outputResourceKind": "collection_record",
  "uiDisplayCategory": "collection",
  "providerToolNames": [
    "samurai.collection.record.create",
    "collection.record.create",
    "create_collection_record",
    "mcp__samurai__collection_record_create"
  ],
  "surfaceOperationKinds": [
    "collection.record.create"
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
      execute: async function handleCollectionRecordCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCollectionRecordCreate(context, input);
      }
    };
  }
});

export default collectionRecordCreate;
