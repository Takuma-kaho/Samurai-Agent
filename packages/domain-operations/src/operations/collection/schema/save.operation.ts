// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { CollectionSchemaSchema, type ActivityInboxItem, type CollectionSchema, type OperationRecord, type ResourceRef, type RollbackPoint } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { storedCollectionSchema } from "../../../value-objects/collection.js";
import { collectionSchemaWriteValueSchema } from "../../../value-objects/collection.js";

const Input = CollectionSchemaSchema.extend({
  // Used by External Integration.  It is deliberately separate from the
  // Collection's user-facing string schema version.
  expected_resource_version: z.number().int().positive().optional()
}).strict();
const Output = collectionSchemaWriteValueSchema;

function toCollectionSchema(input: z.infer<typeof Input>): CollectionSchema {
  return {
    id: input.id,
    version: input.version,
    labels: input.labels,
    descriptions: input.descriptions,
    fields: input.fields,
    refs: input.refs,
    embeds: input.embeds,
    derived_fields: input.derived_fields,
    triggers: input.triggers,
    actions: input.actions,
    ...(input.views === undefined ? {} : { views: input.views }),
    permissions: input.permissions
  };
}

export interface CollectionSchemaSavePorts {
  getCollectionSchemaForMutation(id: string): Promise<z.infer<typeof storedCollectionSchema> | undefined>;
  saveCollectionSchema(schema: CollectionSchema): Promise<z.infer<typeof storedCollectionSchema>>;
  updateCollectionSchema(schema: CollectionSchema, expectedResourceVersion?: number): Promise<z.infer<typeof storedCollectionSchema>>;
  collectionSchemaRef(schema: z.infer<typeof storedCollectionSchema>): ResourceRef;
  createCollectionRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, z.infer<typeof domainJsonValueSchema>>, after: Record<string, z.infer<typeof domainJsonValueSchema>>): Promise<RollbackPoint>;
  collectionMutationContract(id: "collection.schema.save"): { id: string; proposed_effects: string[] };
  runCollectionMutation<T>(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const collectionSchemaSave = defineCommand<CollectionSchemaSavePorts>()({
  ...{
  "kind": "command",
  "id": "collection.schema.save",
  "version": "4.0",
  "availability": "active",
  "title": "Save collection schema",
  "description": "Save a Collection schema with validated fields and Workspace view definitions.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "external_app"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "collection"
  ],
  "resourceKinds": [
    "collection_schema"
  ],
  "proposedEffects": [
    "Create a Collection schema file, renderer view definitions, and PostgreSQL projection row."
  ],
  "outputResourceKind": "collection_schema",
  "uiDisplayCategory": "collection",
  "providerToolNames": [
    "samurai.collection.schema.save",
    "collection.schema.save",
    "save_collection_schema",
    "mcp__samurai__collection_schema_save"
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
      execute: async function handleCollectionSchemaSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const schema = toCollectionSchema(input);
        const existing = await ports.getCollectionSchemaForMutation(schema.id);
        const contract = ports.collectionMutationContract("collection.schema.save");
        const result = await ports.runCollectionMutation({
          trustedContext: context, inputSummary: `Save collection schema: ${schema.id}`, operationName: contract.id, proposedEffects: contract.proposed_effects,
          targetResourceRefs: existing ? [ports.collectionSchemaRef(existing)] : [],
          execute: async (operation) => {
            const saved = existing ? await ports.updateCollectionSchema(schema, input.expected_resource_version) : await ports.saveCollectionSchema(schema);
            const ref = ports.collectionSchemaRef(saved);
            const rollbackPoint = await ports.createCollectionRollback(operation, [ref], existing ? { collection_schema: domainJsonValueSchema.parse(existing) } : {}, { collection_schema: domainJsonValueSchema.parse(saved) });
            return { resource: saved, ref, rollbackPoint, summary: `Saved collection schema ${saved.id}.` };
          }
        });
        return { ok: true, value: Output.parse(result) };
      }
    };
  }
});

export default collectionSchemaSave;
