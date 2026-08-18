import type { CollectionRecordWithFilePath } from "../workspace-store-contracts";
import type { CollectionSchemaWithFilePath } from "../workspace-store-contracts";

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

/** Schema semantic versions are user supplied strings, so they cannot serve
 * as a compare-and-swap value.  This error exposes the durable resource
 * version instead. */
export class CollectionSchemaVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly latest: CollectionSchemaWithFilePath
  ) {
    super(`collection_schema_version_conflict:expected=${expectedVersion}:actual=${latest.resource_version}`);
    this.name = "CollectionSchemaVersionConflictError";
  }
}
