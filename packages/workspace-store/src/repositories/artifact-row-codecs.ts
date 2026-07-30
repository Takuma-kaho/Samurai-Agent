import { type ArtifactRecord, type ArtifactRevisionRecord } from "@samurai-agent/core-schemas";
import type { ArtifactRevisionsTable, ArtifactsTable } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

export function artifactRevisionToRow(record: ArtifactRevisionRecord): ArtifactRevisionsTable {
  return { id: record.id, artifact_id: record.artifact_id, revision: record.revision, revision_json: stringify(record), content_hash: record.content_hash, file_path: record.file_ref.uri, blob_path: record.blob_ref.uri, created_at: record.created_at };
}

export function artifactFromRow(row: ArtifactsTable): ArtifactRecord {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as ArtifactRecord["kind"],
    locale: row.locale as ArtifactRecord["locale"],
    source_locales: parse(row.source_locales_json),
    file_ref: parse(row.file_ref_json),
    metadata: parse(row.metadata_json),
    source_operation_id: row.source_operation_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function artifactContentTypeFromMetadata(artifact: ArtifactRecord): string {
  const contentType = artifact.metadata.content_type;
  return typeof contentType === "string" ? contentType : "text/markdown";
}

export function isTextArtifactContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/markdown";
}

export function safeArtifactExtension(extension: string): string {
  const normalized = extension.trim().replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9]+$/.test(normalized)) {
    throw new Error("artifact_extension_invalid");
  }
  return normalized;
}
