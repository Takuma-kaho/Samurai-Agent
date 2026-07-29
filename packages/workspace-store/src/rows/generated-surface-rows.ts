import type { JsonColumn } from "./json-column";

export interface GeneratedSurfacesTable { id: string; state: string; session_id: string; title: string; definition_json: JsonColumn; content_hash: string; current_revision_id: string; current_revision: number; created_at: string; updated_at: string; }
export interface GeneratedSurfaceRevisionsTable { id: string; surface_id: string; revision: number; revision_json: JsonColumn; bundle_hash: string; created_at: string; }
export interface SurfaceInteractionsTable { id: string; surface_id: string; revision_id: string; session_id: string; kind: string; interaction_json: JsonColumn; created_at: string; }
