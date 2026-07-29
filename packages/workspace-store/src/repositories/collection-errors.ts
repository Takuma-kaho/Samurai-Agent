import type { CollectionRecordWithFilePath } from "../workspace-store-contracts";

/** Optimistic-version conflict returned with the newest durable record. */
export class CollectionRecordVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly latest: CollectionRecordWithFilePath
  ) {
    super(`collection_record_version_conflict:expected=${expectedVersion}:actual=${latest.version}`);
    this.name = "CollectionRecordVersionConflictError";
  }
}
