import { describe, expect, it } from "vitest";
import type { OperationRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import collectionReindex from "./reindex.operation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api", workspaceId: "workspace", actorId: "owner", correlationId: "core08-reindex"
};
const emptyPartition = { files: 0, indexed: 0, created: 0, updated: 0, removed: 0, skipped: 0, errors: [] };
const operation: OperationRecord = {
  id: "operation-core08-reindex", capability_id: "workspace", operation: "collection.reindex",
  actor_identity: "owner", instruction_source: "owner_instruction", instruction_authority: "owner",
  channel: "runtime_api", input_hash: "hash", target_resource_refs: [], proposed_effects: [],
  status: "completed", created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z"
};

describe("collection.reindex handler", () => {
  it("labels index repair as derived work, not a user Resource change", async () => {
    let evidenceKind: "resource_change" | "derived_repair" | undefined;
    const handler = collectionReindex.createHandler({
      collectionMutationContract: () => ({ id: "collection.reindex", proposed_effects: ["Refresh index"] }),
      reindexCollectionStore: async () => ({ schemas: emptyPartition, records: emptyPartition }),
      runCollectionMutation: async (input) => {
        evidenceKind = input.evidenceKind;
        const executed = await input.execute(operation);
        return { resource: executed.resource, operation, activity: [] };
      }
    });

    await handler.execute(context, collectionReindex.input.parse({}));

    expect(evidenceKind).toBe("derived_repair");
  });
});
