import { requireDomainCommandEntry, requireDomainQueryEntry } from "@samurai-agent/action-catalog";

export function collectionSchemaDocsQueryId(): string {
  return requireDomainQueryEntry("collection.schema.docs").id;
}

export function collectionSchemaQueryId(): string {
  return requireDomainQueryEntry("collection.schema.get").id;
}

export function collectionRecordsQueryId(): string {
  return requireDomainQueryEntry("collection.records.list").id;
}

export function collectionSchemaSaveCommandId(): string {
  return requireDomainCommandEntry("collection.schema.save").id;
}

export function collectionRecordPatchCommandId(): string {
  return requireDomainCommandEntry("collection.patch.apply").id;
}

export function collectionRecordCreateCommandId(): string {
  return requireDomainCommandEntry("collection.record.create").id;
}
