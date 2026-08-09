import type { JsonColumn } from "./json-column";

export interface GeneratedSurfacesTable { id: string; state: string; session_id: string | null; session_ref_json: JsonColumn | null; activity_id: string | null; domain_operation_id: string | null; title: string; definition_json: JsonColumn; content_hash: string; current_revision_id: string; current_revision: number; created_at: string; updated_at: string; }
export interface GeneratedSurfaceRevisionsTable { id: string; surface_id: string; revision: number; activity_id: string | null; domain_operation_id: string | null; revision_json: JsonColumn; bundle_hash: string; created_at: string; }
export interface SurfaceInteractionsTable { id: string; surface_id: string; revision_id: string; session_id: string | null; session_ref_json: JsonColumn | null; activity_id: string | null; domain_operation_id: string | null; kind: string; interaction_json: JsonColumn; created_at: string; }
