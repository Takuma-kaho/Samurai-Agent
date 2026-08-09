// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { collectionActionWriteValueSchema } from "../../../value-objects/collection.js";

const Input = z.object({
  "collection_id": z.string().trim().min(1).max(256),
  "action_id": z.string().trim().min(1).max(256),
  "record_id": z.string().trim().min(1).max(256).optional(),
  "backend_id": z.string().trim().min(1).max(256).optional(),
  "payload": z.record(domainJsonValueSchema).default({})
}).strict();
const Output = collectionActionWriteValueSchema;

export type CollectionActionRunInput = z.infer<typeof Input>;
export type CollectionActionRunOutput = z.infer<typeof Output>;

export interface CollectionActionRunRequest {
  collectionId: string;
  actionId: string;
  recordId?: string;
  backendId?: string;
  trustedContext: TrustedDomainContext;
  payload: Record<string, z.infer<typeof domainJsonValueSchema>>;
}

export interface CollectionActionRunPorts {
  runCollectionAction(input: CollectionActionRunRequest): Promise<CollectionActionRunOutput> | CollectionActionRunOutput;
}

const collectionActionRun = defineCommand<CollectionActionRunPorts>()({
  ...{
  "kind": "command",
  "id": "collection.action.run",
  "version": "4.2",
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
        const value = await ports.runCollectionAction({
          collectionId: input.collection_id,
          actionId: input.action_id,
          ...(input.record_id ? { recordId: input.record_id } : {}),
          ...(input.backend_id ? { backendId: input.backend_id } : {}),
          trustedContext: context,
          payload: input.payload
        });
        return { ok: true, value: Output.parse(value) };
      }
    };
  }
});

export default collectionActionRun;
