import type { JsonColumn } from "./json-column";

/** `version` is the Collection's user-facing schema version.  The separate
 * monotonically increasing `resource_version` is the write-CAS value. */
export interface CollectionSchemasTable { id: string; version: string; resource_version: number; file_path: string; schema_json: JsonColumn; updated_at: string; }
export interface CollectionRecordsTable { id: string; collection_id: string; file_path: string; record_json: JsonColumn; version: number; created_at: string; updated_at: string; }
export interface CollectionPatchesTable { id: string; collection_id: string; record_id: string; patch_json: JsonColumn; source_operation_id: string; created_at: string; }
