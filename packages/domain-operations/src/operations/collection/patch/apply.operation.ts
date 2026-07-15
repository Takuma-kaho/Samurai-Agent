// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionPatchWriteValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "changes": z.record(domainJsonValueSchema),
  "collection_id": z.string(),
  "envelope_id": z.string() .optional(),
  "expected_version": z.number().int().min(1),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "patch_id": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "record_id": z.string(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = collectionPatchWriteValueSchema;

export interface CollectionPatchApplyPorts {
  executeCollectionPatchApply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const collectionPatchApply = defineCommand<CollectionPatchApplyPorts>()({
  ...{
  "kind": "command",
  "id": "collection.patch.apply",
  "version": "2.0",
  "availability": "active",
  "title": "Apply collection patch",
  "description": "Patch a schema-validated Collection record.",
  "sources": [
    "surface_operation",
    "runtime_api",
    "provider_tool_call",
    "scheduled_context",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "collection_record"
  ],
  "resourceKinds": [
    "collection_record"
  ],
  "proposedEffects": [
    "Apply a schema-validated Collection patch and return the updated Collection record render spec."
  ],
  "outputResourceKind": "collection_record",
  "uiDisplayCategory": "collection",
  "providerToolNames": [
    "collection.record.patch",
    "patch_collection_record",
    "mcp__samurai__collection_record_patch"
  ],
  "surfaceOperationKinds": [
    "collection.record.patch"
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
      execute: async function handleCollectionPatchApply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCollectionPatchApply(context, input);
      }
    };
  }
});

export default collectionPatchApply;
