import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "collection.action.run" | "collection.patch.apply" | "collection.record.create" | "collection.record.delete" | "collection.reindex" | "collection.schema.save" | "collection.records.list" | "collection.schema.docs" | "collection.schema.get" | "collection.view.present">;

export function createCollectionDomainServicePorts(services: Pick<RuntimeDomainServices, "collectionDomainService">): Ports {
  return {
    "collection.action.run": {
      runCollectionAction: (input) => services.collectionDomainService.runAction(input)
    },
    "collection.patch.apply": {
      ensureCollectionMutationSession: () => services.collectionDomainService.ensureCollectionMutationSession(),
      createCollectionMutationEnvelope: (content) => services.collectionDomainService.createCollectionMutationEnvelope(content),
      applyCollectionRecordPatch: (input) => services.collectionDomainService.applyCollectionRecordPatch(input),
      mapCollectionPatchError: (error) => services.collectionDomainService.mapCollectionPatchError(error),
      collectionRecordRef: (record) => services.collectionDomainService.collectionRecordRef(record),
      createCollectionRollback: (operation, refs, before, after) => services.collectionDomainService.createCollectionRollback(operation, refs, before, after),
      queueCollectionTrigger: (input) => services.collectionDomainService.queueCollectionTrigger(input),
      runCollectionMutation: (input) => services.collectionDomainService.runCollectionMutation(input)
    },
    "collection.record.create": {
      ensureCollectionMutationSession: () => services.collectionDomainService.ensureCollectionMutationSession(),
      createCollectionMutationEnvelope: (content) => services.collectionDomainService.createCollectionMutationEnvelope(content),
      saveCollectionRecord: (record) => services.collectionDomainService.saveCollectionRecord(record),
      collectionRecordRef: (record) => services.collectionDomainService.collectionRecordRef(record),
      createCollectionRollback: (operation, refs, before, after) => services.collectionDomainService.createCollectionRollback(operation, refs, before, after),
      queueCollectionTrigger: (input) => services.collectionDomainService.queueCollectionTrigger(input),
      runCollectionMutation: (input) => services.collectionDomainService.runCollectionMutation(input)
    },
    "collection.record.delete": {
      getCollectionSchemaForMutation: (id) => services.collectionDomainService.getCollectionSchemaForMutation(id),
      collectionDeleteAllowed: (schema, viewId) => services.collectionDomainService.collectionDeleteAllowed(schema, viewId),
      getCollectionRecord: (collectionId, recordId) => services.collectionDomainService.getCollectionRecord(collectionId, recordId),
      deleteCollectionRecord: (collectionId, recordId) => services.collectionDomainService.deleteCollectionRecord(collectionId, recordId),
      collectionRecordRef: (record) => services.collectionDomainService.collectionRecordRef(record),
      collectionMutationError: (code, message) => services.collectionDomainService.collectionMutationError(code, message),
      ensureCollectionMutationSession: () => services.collectionDomainService.ensureCollectionMutationSession(),
      createCollectionMutationEnvelope: (content) => services.collectionDomainService.createCollectionMutationEnvelope(content),
      createCollectionRollback: (operation, refs, before, after) => services.collectionDomainService.createCollectionRollback(operation, refs, before, after),
      runCollectionMutation: (input) => services.collectionDomainService.runCollectionMutation(input)
    },
    "collection.reindex": {
      collectionMutationContract: (id) => services.collectionDomainService.collectionMutationContract(id),
      ensureCollectionMutationSession: () => services.collectionDomainService.ensureCollectionMutationSession(),
      createCollectionMutationEnvelope: (content) => services.collectionDomainService.createCollectionMutationEnvelope(content),
      reindexCollectionStore: () => services.collectionDomainService.reindexCollectionStore(),
      runCollectionMutation: (input) => services.collectionDomainService.runCollectionMutation(input)
    },
    "collection.schema.save": {
      getCollectionSchemaForMutation: (id) => services.collectionDomainService.getCollectionSchemaForMutation(id),
      saveCollectionSchema: (schema) => services.collectionDomainService.saveCollectionSchema(schema),
      updateCollectionSchema: (schema) => services.collectionDomainService.updateCollectionSchema(schema),
      collectionSchemaRef: (schema) => services.collectionDomainService.collectionSchemaRef(schema),
      createCollectionRollback: (operation, refs, before, after) => services.collectionDomainService.createCollectionRollback(operation, refs, before, after),
      collectionMutationContract: (id) => services.collectionDomainService.collectionMutationContract(id),
      ensureCollectionMutationSession: () => services.collectionDomainService.ensureCollectionMutationSession(),
      createCollectionMutationEnvelope: (content) => services.collectionDomainService.createCollectionMutationEnvelope(content),
      runCollectionMutation: (input) => services.collectionDomainService.runCollectionMutation(input)
    },
    "collection.records.list": readOnlyQueryPort<Ports["collection.records.list"]>({
      getCollectionSchema: (id) => services.collectionDomainService.getCollectionSchema(id),
      listCollectionRecords: (schema, input) => services.collectionDomainService.listCollectionRecords(schema, input),
      collectionRecordsQueryError: (message) => services.collectionDomainService.collectionQueryError(message)
    }),
    "collection.schema.docs": readOnlyQueryPort<Ports["collection.schema.docs"]>({
      readCollectionSchemaDocs: () => services.collectionDomainService.schemaDocs()
    }),
    "collection.schema.get": readOnlyQueryPort<Ports["collection.schema.get"]>({
      getCollectionSchema: (id) => services.collectionDomainService.getCollectionSchema(id),
      collectionSchemaQueryError: (message) => services.collectionDomainService.collectionQueryError(message)
    }),
    "collection.view.present": readOnlyQueryPort<Ports["collection.view.present"]>({
      presentCollectionView: (input) => services.collectionDomainService.presentCollectionView(input)
    })
  };
}
