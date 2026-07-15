import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "collection.action.run" | "collection.patch.apply" | "collection.record.create" | "collection.record.delete" | "collection.reindex" | "collection.schema.save" | "collection.records.list" | "collection.schema.docs" | "collection.schema.get" | "collection.view.present">;

export function createCollectionDomainServicePorts(services: Pick<RuntimeDomainServices, "collectionDomainService">): Ports {
  return {
    "collection.action.run": {
      executeCollectionActionRun: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.runAction(input)
      })
    },
    "collection.patch.apply": {
      executeCollectionPatchApply: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.applyPatch(input)
      })
    },
    "collection.record.create": {
      executeCollectionRecordCreate: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.createRecord(input)
      })
    },
    "collection.record.delete": {
      executeCollectionRecordDelete: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.deleteRecord(input)
      })
    },
    "collection.reindex": {
      executeCollectionReindex: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.reindex()
      })
    },
    "collection.schema.save": {
      executeCollectionSchemaSave: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.saveSchema(input)
      })
    },
    "collection.records.list": {
      executeCollectionRecordsList: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.listRecords(input)
      })
    },
    "collection.schema.docs": {
      executeCollectionSchemaDocs: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.schemaDocs()
      })
    },
    "collection.schema.get": {
      executeCollectionSchemaGet: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.getSchema(input)
      })
    },
    "collection.view.present": {
      executeCollectionViewPresent: async (context, input) => ({
        ok: true as const,
        value: await services.collectionDomainService.presentView(input)
      })
    }
  };
}

