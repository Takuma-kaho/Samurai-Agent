import type { JsonColumn } from "./json-column";

export interface WorkspaceFileTransactionsTable { id: string; kind: string; status: string; target_path: string; staged_path: string; collection_id: string | null; record_id: string | null; patch_id: string | null; before_json: JsonColumn; after_json: JsonColumn; created_at: string; updated_at: string; }
export interface MigrationJournalTable { id: string; name: string; status: string; details_json: JsonColumn; created_at: string; }
