import { type GeneratedSurfaceDefinition, type GeneratedSurfaceRevisionRecord, type SurfaceInteractionRecord } from "@samurai-agent/core-schemas";
import type { GeneratedSurfaceRevisionsTable, GeneratedSurfacesTable, SurfaceInteractionsTable } from "../kernel/workspace-db-schema";
import { stringify } from "./serialization";

export function generatedSurfaceToRow(record: GeneratedSurfaceDefinition): GeneratedSurfacesTable {
  return {
    id: record.id,
    state: record.state,
    session_id: record.session_id,
    title: record.title,
    definition_json: stringify(record),
    content_hash: record.content_hash,
    current_revision_id: record.current_revision_id,
    current_revision: record.current_revision,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export function generatedSurfaceRevisionToRow(record: GeneratedSurfaceRevisionRecord): GeneratedSurfaceRevisionsTable {
  return { id: record.id, surface_id: record.surface_id, revision: record.revision, revision_json: stringify(record), bundle_hash: record.bundle_hash, created_at: record.created_at };
}

export function surfaceInteractionToRow(record: SurfaceInteractionRecord): SurfaceInteractionsTable {
  return { id: record.id, surface_id: record.surface_id, revision_id: record.revision_id, session_id: record.session_id, kind: record.kind, interaction_json: stringify(record), created_at: record.created_at };
}
