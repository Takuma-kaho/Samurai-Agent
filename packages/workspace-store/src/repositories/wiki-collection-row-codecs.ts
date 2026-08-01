import { type CollectionPatch, type CollectionSchema, type WikiFrontmatter } from "@samurai-agent/core-schemas";
import type { CollectionPatchesTable, CollectionRecordsTable, CollectionSchemasTable, WikiIndexTable } from "../kernel/workspace-db-schema";
import type { CollectionRecordWithFilePath, CollectionSchemaWithFilePath, WikiWithFilePath } from "../workspace-store-contracts";
import { parse, stringify } from "./serialization";
import { usageScopeIndexColumns } from "./usage-scope";
import { withUsageScope } from "./usage-scope";

export function wikiToRow(frontmatter: WikiFrontmatter, filePath: string): WikiIndexTable {
  return {
    id: frontmatter.id,
    slug: frontmatter.slug,
    title: frontmatter.title,
    state: frontmatter.state,
    content_locale: frontmatter.content_locale,
    tags_json: stringify(frontmatter.tags),
    source_refs_json: stringify(frontmatter.source_refs),
    provenance_json: stringify(frontmatter.provenance),
    ...usageScopeIndexColumns(frontmatter.usage_scope),
    file_path: filePath,
    frontmatter_json: stringify(frontmatter),
    created_at: frontmatter.created_at,
    updated_at: frontmatter.updated_at
  };
}

export function wikiFromRow(row: WikiIndexTable): WikiWithFilePath {
  return {
    ...withUsageScope(parse<WikiFrontmatter>(row.frontmatter_json)),
    file_path: row.file_path
  };
}

export function collectionSchemaFromRow(row: CollectionSchemasTable): CollectionSchemaWithFilePath {
  return {
    ...parse(row.schema_json),
    file_path: row.file_path
  };
}

export function collectionRecordFromRow(row: CollectionRecordsTable): CollectionRecordWithFilePath {
  return {
    ...parse(row.record_json),
    version: row.version,
    file_path: row.file_path
  };
}

export function collectionPatchToRow(collectionId: string, patch: CollectionPatch): CollectionPatchesTable {
  return {
    id: patch.id,
    collection_id: collectionId,
    record_id: patch.record_id,
    patch_json: stringify(patch),
    source_operation_id: patch.source_operation_id,
    created_at: patch.created_at
  };
}

export function collectionPatchFromRow(row: CollectionPatchesTable): CollectionPatch {
  return parse(row.patch_json);
}
