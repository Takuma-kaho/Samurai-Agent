import { type DomainCommandExecutionRecord, type ObjectiveRecord, type RunCheckpointRecord, type WorkDependencyRecord, type WorkItemRecord } from "@samurai-agent/core-schemas";
import type { DomainCommandExecutionsTable, ObjectivesTable, RunCheckpointsTable, WorkDependenciesTable, WorkItemsTable } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

export function domainCommandExecutionToRow(record: DomainCommandExecutionRecord): DomainCommandExecutionsTable {
  return {
    id: record.id,
    idempotency_key: record.idempotency_key,
    command_id: record.command_id,
    input_source: record.input_source,
    correlation_id: record.correlation_id,
    payload_hash: record.payload_hash,
    phase: record.phase,
    status: record.status,
    result_json: record.result === undefined ? null : stringify(record.result),
    error: record.error ? stringify(record.error) : null,
    heartbeat_at: record.heartbeat_at,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export function domainCommandExecutionFromRow(row: DomainCommandExecutionsTable): DomainCommandExecutionRecord {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    command_id: row.command_id,
    input_source: row.input_source,
    correlation_id: row.correlation_id,
    payload_hash: row.payload_hash,
    phase: row.phase === "claimed" || row.phase === "internal_running" ? row.phase : "external_running",
    status: row.status as DomainCommandExecutionRecord["status"],
    result: row.result_json === null ? undefined : parse(row.result_json),
    error: row.error ? parseDomainCommandExecutionError(row.error) : undefined,
    heartbeat_at: row.heartbeat_at || row.updated_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function objectiveToRow(record: ObjectiveRecord): ObjectivesTable {
  return {
    id: record.id,
    session_id: record.session_id ?? null,
    room_id: requiredRoomId(record.room_id, "objective"),
    title: record.title,
    objective: record.objective,
    completion_criteria_json: stringify(record.completion_criteria),
    status: record.status,
    token_budget: record.token_budget ?? null,
    time_budget_ms: record.time_budget_ms ?? null,
    max_attempts: record.max_attempts ?? null,
    current_checkpoint_id: record.current_checkpoint_id ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at ?? null
  };
}

export function objectiveFromRow(row: ObjectivesTable): ObjectiveRecord {
  return {
    id: row.id,
    session_id: row.session_id ?? undefined,
    room_id: requiredRoomId(row.room_id, "objective"),
    title: row.title,
    objective: row.objective,
    completion_criteria: parse(row.completion_criteria_json),
    status: row.status as ObjectiveRecord["status"],
    token_budget: row.token_budget ?? undefined,
    time_budget_ms: row.time_budget_ms ?? undefined,
    max_attempts: row.max_attempts ?? undefined,
    current_checkpoint_id: row.current_checkpoint_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? undefined
  };
}

export function workItemToRow(record: WorkItemRecord): WorkItemsTable {
  return {
    id: record.id,
    objective_id: record.objective_id,
    room_id: requiredRoomId(record.room_id, "work_item"),
    parent_work_item_id: record.parent_work_item_id ?? null,
    instruction: record.instruction,
    status: record.status,
    priority: record.priority,
    attempt: record.attempt,
    max_attempts: record.max_attempts,
    idempotency_key: record.idempotency_key,
    lease_owner: record.lease_owner ?? null,
    lease_expires_at: record.lease_expires_at ?? null,
    heartbeat_at: record.heartbeat_at ?? null,
    retry_after_at: record.retry_after_at ?? null,
    backend_run_id: record.backend_run_id ?? null,
    current_checkpoint_id: record.current_checkpoint_id ?? null,
    failure_kind: record.failure_kind ?? null,
    error: record.error ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    started_at: record.started_at ?? null,
    completed_at: record.completed_at ?? null
  };
}

export function workItemFromRow(row: WorkItemsTable): WorkItemRecord {
  return {
    id: row.id,
    objective_id: row.objective_id,
    room_id: requiredRoomId(row.room_id, "work_item"),
    parent_work_item_id: row.parent_work_item_id ?? undefined,
    instruction: row.instruction,
    status: row.status as WorkItemRecord["status"],
    priority: row.priority,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    idempotency_key: row.idempotency_key,
    lease_owner: row.lease_owner ?? undefined,
    lease_expires_at: row.lease_expires_at ?? undefined,
    heartbeat_at: row.heartbeat_at ?? undefined,
    retry_after_at: row.retry_after_at ?? undefined,
    backend_run_id: row.backend_run_id ?? undefined,
    current_checkpoint_id: row.current_checkpoint_id ?? undefined,
    failure_kind: row.failure_kind ? row.failure_kind as WorkItemRecord["failure_kind"] : undefined,
    error: row.error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at ?? undefined,
    completed_at: row.completed_at ?? undefined
  };
}

function requiredRoomId(roomId: string | null | undefined, resourceKind: "objective" | "work_item"): string {
  const normalized = roomId?.trim();
  if (!normalized) throw new Error(`${resourceKind}_room_scope_required`);
  return normalized;
}

export function workDependencyToRow(record: WorkDependencyRecord): WorkDependenciesTable {
  return { ...record };
}

export function workDependencyFromRow(row: WorkDependenciesTable): WorkDependencyRecord {
  return { ...row, kind: row.kind as WorkDependencyRecord["kind"] };
}

export function runCheckpointToRow(record: RunCheckpointRecord): RunCheckpointsTable {
  return {
    id: record.id,
    objective_id: record.objective_id,
    work_item_id: record.work_item_id,
    sequence: record.sequence,
    phase: record.phase,
    idempotency_key: record.idempotency_key,
    backend_run_id: record.backend_run_id ?? null,
    backend_session_id: record.backend_session_id ?? null,
    event_cursor: record.event_cursor ?? null,
    summary: record.summary,
    generated_resource_refs_json: stringify(record.generated_resource_refs),
    pending_operation_ids_json: stringify(record.pending_operation_ids),
    state_json: stringify(record.state),
    created_at: record.created_at
  };
}

export function runCheckpointFromRow(row: RunCheckpointsTable): RunCheckpointRecord {
  return {
    id: row.id,
    objective_id: row.objective_id,
    work_item_id: row.work_item_id,
    sequence: row.sequence,
    phase: row.phase as RunCheckpointRecord["phase"],
    idempotency_key: row.idempotency_key,
    backend_run_id: row.backend_run_id ?? undefined,
    backend_session_id: row.backend_session_id ?? undefined,
    event_cursor: row.event_cursor ?? undefined,
    summary: row.summary,
    generated_resource_refs: parse(row.generated_resource_refs_json),
    pending_operation_ids: parse(row.pending_operation_ids_json),
    state: parse(row.state_json),
    created_at: row.created_at
  };
}

function parseDomainCommandExecutionError(value: string): NonNullable<DomainCommandExecutionRecord["error"]> {
  try {
    const parsed = JSON.parse(value) as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
    if (typeof parsed.code === "string" && typeof parsed.message === "string" && typeof parsed.retryable === "boolean") {
      return { code: parsed.code, message: parsed.message, retryable: parsed.retryable, ...(parsed.details === undefined ? {} : { details: parsed.details as never }) };
    }
  } catch {
    // Older rows stored an unstructured error message.
  }
  return { code: "domain_command_failed", message: value, retryable: false };
}
