// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { collectionReindexWriteValueSchema } from "../../value-objects/collection.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = collectionReindexWriteValueSchema;

export interface CollectionReindexPorts {
  collectionMutationContract(id: "collection.reindex"): { id: string; proposed_effects: string[] };
  ensureCollectionMutationSession(): Promise<SessionRecord>;
  createCollectionMutationEnvelope(content: string): MessageEnvelope;
  reindexCollectionStore(): Promise<z.infer<typeof Output>["resource"]>;
  runCollectionMutation<T>(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const collectionReindex = defineCommand<CollectionReindexPorts>()({
  ...{
  "kind": "command",
  "id": "collection.reindex",
  "version": "2.0",
  "availability": "active",
  "title": "Reindex collections",
  "description": "Refresh Collection SQLite indexes from schema and record files.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "collection"
  ],
  "resourceKinds": [
    "collection_schema",
    "collection_record",
    "collection_index"
  ],
  "proposedEffects": [
    "Refresh Collection SQLite indexes from schema and record files."
  ],
  "outputResourceKind": "collection_index",
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
      execute: async function handleCollectionReindex(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const contract = ports.collectionMutationContract("collection.reindex");
        const session = await ports.ensureCollectionMutationSession();
        const envelope = ports.createCollectionMutationEnvelope("Reindex collections");
        const result = await ports.runCollectionMutation({
          session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects,
          execute: async () => {
            const resource = await ports.reindexCollectionStore();
            return {
              resource,
              ref: { kind: "collection_index", id: "collections", uri: "collections", label: "Collection index" },
              summary: `Reindexed ${resource.schemas.indexed} collection schema(s) and ${resource.records.indexed} record(s).`
            };
          }
        });
        return { ok: true, value: Output.parse(result) };
      }
    };
  }
});

export default collectionReindex;
