import type { JsonColumn } from "./json-column";

export interface ClientEventsTable { id: string; room_id: string | null; target_client_kind: string; target_client_id: string | null; event_type: string; status: string; payload_json: JsonColumn; resource_refs_json: JsonColumn; created_at: string; delivered_at: string | null; acked_at: string | null; expires_at: string | null; error_code: string | null; }
