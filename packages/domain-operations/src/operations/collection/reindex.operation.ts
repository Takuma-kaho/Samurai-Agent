// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, OperationRecord, ResourceRef, RollbackPoint } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { collectionReindexWriteValueSchema } from "../../value-objects/collection.js";

const Input = z.object({}).strict();
const Output = collectionReindexWriteValueSchema;

export interface CollectionReindexPorts {
  collectionMutationContract(id: "collection.reindex"): { id: string; proposed_effects: string[] };
  reindexCollectionStore(): Promise<z.infer<typeof Output>["resource"]>;
  runCollectionMutation<T>(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; evidenceKind?: "resource_change" | "derived_repair"; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const collectionReindex = defineCommand<CollectionReindexPorts>()({
  ...{
  "kind": "command",
  "id": "collection.reindex",
  "version": "3.1",
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
      execute: async function handleCollectionReindex(context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const contract = ports.collectionMutationContract("collection.reindex");
        const result = await ports.runCollectionMutation({
          trustedContext: context, inputSummary: "Reindex collections", operationName: contract.id, proposedEffects: contract.proposed_effects, evidenceKind: "derived_repair",
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
