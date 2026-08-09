// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ResourceRefSchema, createId, nowIso, type ActivityInboxItem, type CollectionRecord, type OperationRecord, type ResourceRef, type RollbackPoint } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionRecordWriteValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string().trim().min(1).max(256),
  "data": z.record(domainJsonValueSchema),
  "record_id": z.string().trim().min(1).max(256).optional(),
  "resource_refs": z.array(ResourceRefSchema).max(1_000).default([])
}).strict();
const Output = collectionRecordWriteValueSchema;

export interface CollectionRecordCreatePorts {
  saveCollectionRecord(record: CollectionRecord): Promise<z.infer<typeof Output>["resource"]>;
  collectionRecordRef(record: z.infer<typeof Output>["resource"]): ResourceRef;
  createCollectionRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, z.infer<typeof domainJsonValueSchema>>, after: Record<string, z.infer<typeof domainJsonValueSchema>>): Promise<RollbackPoint>;
  queueCollectionTrigger(input: { collectionId: string; recordId: string; event: "record.created" }): Promise<void>;
  runCollectionMutation<T>(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const collectionRecordCreate = defineCommand<CollectionRecordCreatePorts>()({
  ...{
  "kind": "command",
  "id": "collection.record.create",
  "version": "4.0",
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
        const now = nowIso();
        const record: CollectionRecord = {
          id: input.record_id ?? createId("collection_record"), collection_id: input.collection_id,
          version: 1, data: input.data, resource_refs: input.resource_refs, created_at: now, updated_at: now
        };
        const result = await ports.runCollectionMutation({
          trustedContext: context, inputSummary: `Create collection record: ${record.collection_id}/${record.id}`, operationName: "collection.record.create",
          proposedEffects: ["Create a collection record file and SQLite index row."],
          execute: async (operation) => {
            const saved = await ports.saveCollectionRecord(record);
            const ref = ports.collectionRecordRef(saved);
            const rollbackPoint = await ports.createCollectionRollback(operation, [ref], {}, { collection_id: saved.collection_id, record_id: saved.id });
            return { resource: saved, ref, rollbackPoint, summary: `Created collection record ${saved.collection_id}/${saved.id}.` };
          }
        });
        await ports.queueCollectionTrigger({ collectionId: result.resource.collection_id, recordId: result.resource.id, event: "record.created" });
        return { ok: true, value: Output.parse(result) };
      }
    };
  }
});

export default collectionRecordCreate;
