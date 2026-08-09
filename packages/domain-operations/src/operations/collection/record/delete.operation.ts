// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, CollectionSchema, OperationRecord, ResourceRef, RollbackPoint } from "@samurai-agent/core-schemas";
import { storedCollectionRecordSchema, storedCollectionSchema } from "../../../value-objects/collection.js";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionRecordWriteValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string().trim().min(1).max(256),
  "record_id": z.string().trim().min(1).max(256),
  "view_id": z.string().trim().min(1).max(256).optional()
}).strict();
const Output = collectionRecordWriteValueSchema;

export interface CollectionRecordDeletePorts {
  getCollectionSchemaForMutation(id: string): Promise<z.infer<typeof storedCollectionSchema> | undefined>;
  collectionDeleteAllowed(schema: CollectionSchema, viewId?: string): boolean;
  getCollectionRecord(collectionId: string, recordId: string): Promise<z.infer<typeof storedCollectionRecordSchema> | undefined>;
  deleteCollectionRecord(collectionId: string, recordId: string): Promise<z.infer<typeof Output>["resource"]>;
  collectionRecordRef(record: z.infer<typeof Output>["resource"]): ResourceRef;
  collectionMutationError(code: "forbidden" | "not_found", message: string): Error;
  createCollectionRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, z.infer<typeof domainJsonValueSchema>>, after: Record<string, z.infer<typeof domainJsonValueSchema>>): Promise<RollbackPoint>;
  runCollectionMutation<T>(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const collectionRecordDelete = defineCommand<CollectionRecordDeletePorts>()({
  ...{
  "kind": "command",
  "id": "collection.record.delete",
  "version": "4.0",
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
        const schema = await ports.getCollectionSchemaForMutation(input.collection_id);
        if (!schema) throw ports.collectionMutationError("not_found", `Collection schema not found: ${input.collection_id}`);
        if (!ports.collectionDeleteAllowed(schema, input.view_id)) throw ports.collectionMutationError("forbidden", "collection_record_delete_not_allowed");
        const record = await ports.getCollectionRecord(input.collection_id, input.record_id);
        if (!record) throw ports.collectionMutationError("not_found", `Collection record not found: ${input.collection_id}/${input.record_id}`);
        const result = await ports.runCollectionMutation({
          trustedContext: context, inputSummary: `Delete collection record: ${input.collection_id}/${input.record_id}`, operationName: "collection.record.delete",
          proposedEffects: ["Delete a collection record file and SQLite index row."],
          execute: async (operation) => {
            const deleted = await ports.deleteCollectionRecord(input.collection_id, input.record_id);
            const ref = ports.collectionRecordRef(deleted);
            const rollbackPoint = await ports.createCollectionRollback(operation, [ref], { record: domainJsonValueSchema.parse(record) }, {});
            return { resource: deleted, ref, rollbackPoint, summary: `Deleted collection record ${deleted.collection_id}/${deleted.id}.` };
          }
        });
        return { ok: true, value: Output.parse(result) };
      }
    };
  }
});

export default collectionRecordDelete;
