// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { createId, nowIso, type ActivityInboxItem, type CollectionPatch, type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionPatchWriteValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "changes": z.record(domainJsonValueSchema),
  "collection_id": z.string().trim().min(1).max(256),
  // Optimistic concurrency is part of this command's public contract.  A
  // patch without the caller's observed version cannot be safely applied.
  "expected_version": z.number().int().min(1),
  "patch_id": z.string().trim().min(1).max(256).optional(),
  "record_id": z.string().trim().min(1).max(256)
}).strict();
const Output = collectionPatchWriteValueSchema;

export interface CollectionPatchApplyPorts {
  ensureCollectionMutationSession(): Promise<SessionRecord>;
  createCollectionMutationEnvelope(content: string): MessageEnvelope;
  applyCollectionRecordPatch(input: { collectionId: string; recordId: string; patch: CollectionPatch }): Promise<{ before: z.infer<typeof Output>["before"]; after: z.infer<typeof Output>["resource"] }>;
  mapCollectionPatchError(error: unknown): Error;
  collectionRecordRef(record: z.infer<typeof Output>["resource"]): ResourceRef;
  createCollectionRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, z.infer<typeof domainJsonValueSchema>>, after: Record<string, z.infer<typeof domainJsonValueSchema>>): Promise<RollbackPoint>;
  queueCollectionTrigger(input: { collectionId: string; recordId: string; event: "record.patched" }): Promise<void>;
  runCollectionMutation<T, Extra extends Record<string, unknown>>(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string } & Extra> }): Promise<{ resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] } & Extra>;
}

const collectionPatchApply = defineCommand<CollectionPatchApplyPorts>()({
  ...{
  "kind": "command",
  "id": "collection.patch.apply",
  "version": "4.0",
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
      execute: async function handleCollectionPatchApply(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const session = await ports.ensureCollectionMutationSession();
        const envelope = ports.createCollectionMutationEnvelope(`Apply collection patch: ${input.collection_id}/${input.record_id}`);
        const result = await ports.runCollectionMutation<z.infer<typeof Output>["resource"], { before: z.infer<typeof Output>["before"] }>({
          session, envelope, operationName: "collection.patch.apply",
          proposedEffects: ["Apply a collection patch to an existing local record."],
          execute: async (operation) => {
            const patch: CollectionPatch = { id: input.patch_id ?? createId("collection_patch"), record_id: input.record_id, changes: input.changes, expected_version: input.expected_version, source_operation_id: operation.id, created_at: nowIso() };
            let patched;
            try { patched = await ports.applyCollectionRecordPatch({ collectionId: input.collection_id, recordId: input.record_id, patch }); }
            catch (error) { throw ports.mapCollectionPatchError(error); }
            const ref = ports.collectionRecordRef(patched.after);
            const rollbackPoint = await ports.createCollectionRollback(operation, [ref], { record: domainJsonValueSchema.parse(patched.before) }, { record: domainJsonValueSchema.parse(patched.after) });
            return { resource: patched.after, before: patched.before, ref, rollbackPoint, summary: `Applied collection patch ${patch.id}.` };
          }
        });
        await ports.queueCollectionTrigger({ collectionId: result.resource.collection_id, recordId: result.resource.id, event: "record.patched" });
        return { ok: true, value: Output.parse(result) };
      }
    };
  }
});

export default collectionPatchApply;
