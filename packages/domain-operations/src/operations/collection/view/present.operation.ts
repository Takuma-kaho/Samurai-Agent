// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionViewValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string().trim().min(1).max(256),
  "view_id": z.string().trim().min(1).max(256).optional()
}).strict();
const Output = collectionViewValueSchema;

export interface CollectionViewPresentPorts extends DomainQueryPorts {
  presentCollectionView: ReadCapability<(input: { collectionId: string; viewId?: string }) => Promise<z.infer<typeof Output>>>;
}

const collectionViewPresent = defineQuery<CollectionViewPresentPorts>()({
  ...{
  "kind": "query",
  "id": "collection.view.present",
  "version": "2.0",
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
      execute: async function handleCollectionViewPresent(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.presentCollectionView({ collectionId: input.collection_id, viewId: input.view_id })) };
      }
    };
  }
});

export default collectionViewPresent;
