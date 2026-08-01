import type { JsonColumn } from "./json-column";

export interface MemoryIndexTable { id: string; state: string; topic: string; source: string; source_locale: string; content_locale: string; source_kind: string; instruction_authority: string; usage_scope_kind: string | null; usage_scope_ref_id: string | null; file_path: string; frontmatter_json: JsonColumn; created_at: string; updated_at: string; }
