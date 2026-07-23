import type { BackendEventRecord } from "@samurai-agent/core-schemas";

export interface BackendEventsTable {
  id: string;
  run_id: string;
  session_id: string;
  event_type: string;
  sequence: number;
  attempt_no: number | null;
  source_event_id: string | null;
  source_sequence: number | null;
  payload_json: string;
  resource_refs_json: string;
  created_at: string;
}

export function backendEventToRow(event: BackendEventRecord): BackendEventsTable {
  return { id: event.id, run_id: event.run_id, session_id: event.session_id, event_type: event.event_type, sequence: event.sequence, attempt_no: event.attempt_no ?? null, source_event_id: event.source_event_id ?? null, source_sequence: event.source_sequence ?? null, payload_json: JSON.stringify(event.payload), resource_refs_json: JSON.stringify(event.resource_refs), created_at: event.created_at };
}

export function backendEventFromRow(row: BackendEventsTable): BackendEventRecord {
  return { id: row.id, run_id: row.run_id, session_id: row.session_id, event_type: row.event_type as BackendEventRecord["event_type"], sequence: row.sequence, ...(row.attempt_no !== null ? { attempt_no: row.attempt_no } : {}), ...(row.source_event_id ? { source_event_id: row.source_event_id } : {}), ...(row.source_sequence !== null ? { source_sequence: row.source_sequence } : {}), payload: JSON.parse(row.payload_json), resource_refs: JSON.parse(row.resource_refs_json), created_at: row.created_at };
}
