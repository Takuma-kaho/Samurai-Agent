// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionActionWriteValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "action_id": z.string(),
  "backend_id": z.string() .optional(),
  "changes": z.record(domainJsonValueSchema) .optional(),
  "collection_id": z.string(),
  "data": z.record(domainJsonValueSchema) .optional(),
  "envelope_id": z.string() .optional(),
  "error_code": z.string() .optional(),
  "input": z.record(domainJsonValueSchema) .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "message": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "model": z.string() .optional(),
  "output_locale": z.string() .optional(),
  "output_summary": z.string() .optional(),
  "payload": z.record(domainJsonValueSchema) .optional(),
  "provider": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "provider_tool_name": z.string() .optional(),
  "reason": z.string() .optional(),
  "record_id": z.string() .optional(),
  "retryable": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "status": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "text": z.string() .optional(),
  "tool_call_id": z.string() .optional(),
  "view_id": z.string() .optional()
}).strict();
const Output = collectionActionWriteValueSchema;

export interface CollectionActionRunPorts {
  executeCollectionActionRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const collectionActionRun = defineCommand<CollectionActionRunPorts>()({
  ...{
  "kind": "command",
  "id": "collection.action.run",
  "version": "1.0",
  "availability": "active",
  "title": "Run collection action",
  "description": "Run a schema-defined Collection action such as patch, create, or reindex.",
  "sources": [
    "surface_operation",
    "runtime_api",
    "scheduled_context",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "collection_record",
    "collection",
    "custom_view",
    "status_timeline"
  ],
  "resourceKinds": [
    "collection_record",
    "collection_index"
  ],
  "proposedEffects": [
    "Run a schema-defined Collection action through the runtime boundary."
  ],
  "outputResourceKind": "collection_record",
  "uiDisplayCategory": "collection",
  "surfaceOperationKinds": [
    "collection.action.run"
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
      execute: async function handleCollectionActionRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCollectionActionRun(context, input);
      }
    };
  }
});

export default collectionActionRun;
