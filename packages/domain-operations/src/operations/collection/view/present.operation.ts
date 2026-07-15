// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionViewValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "query": z.string() .optional(),
  "record_id": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "view_id": z.string() .optional()
}).strict();
const Output = collectionViewValueSchema;

export interface CollectionViewPresentPorts extends DomainQueryPorts {
  executeCollectionViewPresent(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const collectionViewPresent = defineQuery<CollectionViewPresentPorts>()({
  ...{
  "kind": "query",
  "id": "collection.view.present",
  "version": "1.0",
  "availability": "active",
  "title": "Present collection view",
  "description": "Regenerate a Collection view render spec from current schema, records, actions, and permissions.",
  "sources": [
    "surface_operation",
    "runtime_api",
    "provider_tool_call"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "collection",
    "custom_view"
  ],
  "resourceKinds": [
    "collection_schema",
    "collection_record"
  ],
  "proposedEffects": [
    "Read collection_view without changing Workspace state."
  ],
  "outputResourceKind": "collection_view",
  "uiDisplayCategory": "collection",
  "providerToolNames": [
    "samurai.collection.view.present",
    "present_collection",
    "mcp__samurai__collection_view_present"
  ],
  "surfaceOperationKinds": [
    "collection.view.present"
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
      execute: async function handleCollectionViewPresent(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCollectionViewPresent(context, input);
      }
    };
  }
});

export default collectionViewPresent;
