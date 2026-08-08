import { BackendEventRecordSchema, type BackendEventRecord, type JsonValue, jsonValueSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import type { BackendEventsTable } from "../kernel/workspace-db-schema";

export type { BackendEventsTable } from "../kernel/workspace-db-schema";

export function backendEventToRow(event: BackendEventRecord): BackendEventsTable {
  const payload = { ...event.payload };
  const legacySessionId = typeof payload.backend_session_id === "string" && payload.backend_session_id.trim() ? payload.backend_session_id : undefined;
  delete payload.backend_session_id;
  return { id: event.id, run_id: event.run_id, session_id: event.session_id ?? null, backend_session_id: event.backend_session_id ?? legacySessionId ?? null, event_type: event.event_type, sequence: event.sequence, attempt_no: event.attempt_no ?? null, source_event_id: event.source_event_id ?? null, source_sequence: event.source_sequence ?? null, payload_json: JSON.stringify(payload), resource_refs_json: JSON.stringify(event.resource_refs), created_at: event.created_at };
}

export function backendEventFromRow(row: BackendEventsTable): BackendEventRecord {
  const payload = JSON.parse(row.payload_json) as Record<string, JsonValue>;
  const legacySessionId = typeof payload.backend_session_id === "string" && payload.backend_session_id.trim() ? payload.backend_session_id : undefined;
  const candidate = { id: row.id, run_id: row.run_id, ...(row.session_id ? { session_id: row.session_id } : {}), ...(row.backend_session_id ?? legacySessionId ? { backend_session_id: row.backend_session_id ?? legacySessionId } : {}), event_type: row.event_type as BackendEventRecord["event_type"], sequence: row.sequence, ...(row.attempt_no !== null ? { attempt_no: row.attempt_no } : {}), ...(row.source_event_id ? { source_event_id: row.source_event_id } : {}), ...(row.source_sequence !== null ? { source_sequence: row.source_sequence } : {}), payload, resource_refs: JSON.parse(row.resource_refs_json), created_at: row.created_at };
  const current = BackendEventRecordSchema.safeParse(candidate);
  // Existing rows may use the pre-Core03 payload shape. They remain readable;
  // only new writes are required to pass the strict current schema.
  return current.success ? current.data : candidate as BackendEventRecord;
}

/** Kept as a named compatibility validator for callers auditing old rows. */
export const LegacyBackendEventPayloadSchema = z.record(jsonValueSchema);
