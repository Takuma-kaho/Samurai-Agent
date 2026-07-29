import type { JsonColumn } from "./json-column";

export interface ArtifactsTable { id: string; title: string; kind: string; locale: string; source_locales_json: JsonColumn; file_ref_json: JsonColumn; metadata_json: JsonColumn; source_operation_id: string; created_by: string; created_at: string; updated_at: string; }
export interface ArtifactRevisionsTable { id: string; artifact_id: string; revision: number; revision_json: JsonColumn; content_hash: string; file_path: string; blob_path: string; created_at: string; }
