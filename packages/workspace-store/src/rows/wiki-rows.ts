import type { JsonColumn } from "./json-column";

export interface WikiIndexTable { id: string; slug: string; title: string; state: string; content_locale: string; tags_json: JsonColumn; source_refs_json: JsonColumn; provenance_json: JsonColumn; file_path: string; frontmatter_json: JsonColumn; created_at: string; updated_at: string; }
