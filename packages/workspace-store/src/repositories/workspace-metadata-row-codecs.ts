import { type ResourceRef, type ResourceTranslationRecord } from "@samurai-agent/core-schemas";
import type { ResourceTranslationsTable } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

export function resourceTranslationToRow(record: ResourceTranslationRecord): ResourceTranslationsTable {
  return {
    id: record.id,
    source_ref_json: stringify(record.source_ref),
    source_locale: record.source_locale,
    target_locale: record.target_locale,
    status: record.status,
    original_hash: record.original_hash,
    translated_text: record.translated_text,
    provenance_json: record.provenance ? stringify(record.provenance) : null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export function resourceTranslationFromRow(row: ResourceTranslationsTable): ResourceTranslationRecord {
  return {
    id: row.id,
    source_ref: parse(row.source_ref_json),
    source_locale: row.source_locale as ResourceTranslationRecord["source_locale"],
    target_locale: row.target_locale as ResourceTranslationRecord["target_locale"],
    status: row.status as ResourceTranslationRecord["status"],
    original_hash: row.original_hash,
    translated_text: row.translated_text,
    provenance: row.provenance_json ? parse(row.provenance_json) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function resourceRefKey(ref: ResourceRef): string {
  return `${ref.kind}:${ref.id ?? ""}:${ref.uri}`;
}
