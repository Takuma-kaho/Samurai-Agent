import { type BackendRunRecord, type JsonValue, type MessagePresentationRecord, type MessageRecord, type OperationRecord, type SessionRecord, type WorkspaceChangeRecord } from "@samurai-agent/core-schemas";
import type { BackendRunsTable, MessagePresentationsTable, MessagesTable, OperationsTable, SessionsTable, WorkspaceChangesTable } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

export function sessionFromRow(row: SessionsTable): SessionRecord {
  return {
    id: row.id,
    session_key: row.session_key,
    room_id: row.room_id ?? undefined,
    title: row.title,
    ui_locale: row.ui_locale as SessionRecord["ui_locale"],
    output_locale: row.output_locale as SessionRecord["output_locale"],
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function messageFromRow(row: MessagesTable): MessageRecord {
  const envelope = row.envelope_json ? safeParse(row.envelope_json) : undefined;
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    input_locale: row.input_locale as MessageRecord["input_locale"],
    output_locale: row.output_locale as MessageRecord["output_locale"],
    envelope: envelope as MessageRecord["envelope"],
    created_at: row.created_at
  };
}

export function safeParse(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function operationToRow(operation: OperationRecord): OperationsTable {
  return {
    id: operation.id,
    session_id: operation.session_id ?? null,
    run_id: operation.run_id ?? null,
    capability_id: operation.capability_id,
    operation: operation.operation,
    actor_identity: operation.actor_identity,
    participant_id: operation.participant_id ?? null,
    participant_kind: operation.participant_kind ?? null,
    requested_by_participant_id: operation.requested_by_participant_id ?? null,
    room_id: operation.room_id ?? null,
    principal_json: operation.principal ? stringify(operation.principal) : null,
    source_json: operation.source ? stringify(operation.source) : null,
    session_ref_json: operation.session_ref ? stringify(operation.session_ref) : null,
    instruction_source: operation.instruction_source,
    instruction_authority: operation.instruction_authority,
    channel: operation.channel,
    input_hash: operation.input_hash,
    input_ref_json: operation.input_ref ? stringify(operation.input_ref) : null,
    target_resource_refs_json: stringify(operation.target_resource_refs),
    proposed_effects_json: stringify(operation.proposed_effects),
    status: operation.status,
    policy_decision_id: operation.policy_decision_id ?? null,
    approval_request_id: operation.approval_request_id ?? null,
    result_ref_json: operation.result_ref ? stringify(operation.result_ref) : null,
    error: operation.error ?? null,
    correlation_id: operation.correlation_id ?? null,
    created_at: operation.created_at,
    updated_at: operation.updated_at
  };
}

export function operationFromRow(row: OperationsTable): OperationRecord {
  return {
    id: row.id,
    ...(row.session_id ? { session_id: row.session_id } : {}),
    ...(row.run_id ? { run_id: row.run_id } : {}),
    capability_id: row.capability_id,
    operation: row.operation,
    actor_identity: row.actor_identity as OperationRecord["actor_identity"],
    participant_id: row.participant_id ?? undefined,
    participant_kind: row.participant_kind as OperationRecord["participant_kind"] | undefined,
    requested_by_participant_id: row.requested_by_participant_id ?? undefined,
    room_id: row.room_id ?? undefined,
    ...(row.principal_json ? { principal: parse(row.principal_json) } : {}),
    ...(row.source_json ? { source: parse(row.source_json) } : {}),
    ...(row.session_ref_json ? { session_ref: parse(row.session_ref_json) } : {}),
    instruction_source: row.instruction_source as OperationRecord["instruction_source"],
    instruction_authority: row.instruction_authority,
    channel: row.channel,
    input_hash: row.input_hash,
    input_ref: row.input_ref_json ? parse(row.input_ref_json) : undefined,
    target_resource_refs: parse(row.target_resource_refs_json),
    proposed_effects: parse(row.proposed_effects_json),
    status: row.status as OperationRecord["status"],
    policy_decision_id: row.policy_decision_id ?? undefined,
    approval_request_id: row.approval_request_id ?? undefined,
    result_ref: row.result_ref_json ? parse(row.result_ref_json) : undefined,
    error: row.error ?? undefined,
    correlation_id: row.correlation_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function backendRunToRow(run: BackendRunRecord): BackendRunsTable {
  return {
    id: run.id,
    session_id: run.session_id ?? null,
    room_id: run.room_id ?? null,
    principal_json: run.principal ? stringify(run.principal) : null,
    source_json: run.source ? stringify(run.source) : null,
    session_ref_json: run.session_ref ? stringify(run.session_ref) : null,
    agent_id: run.agent_id ?? null,
    requested_by_participant_id: run.requested_by_participant_id ?? null,
    input_message_id: run.input_message_id ?? null,
    output_message_id: run.output_message_id ?? null,
    backend_id: run.backend_id,
    backend_kind: run.backend_kind,
    backend_session_id: run.backend_session_id ?? null,
    status: run.status,
    phase: run.phase ?? null,
    current_attempt: run.current_attempt ?? null,
    request_idempotency_key: run.request_idempotency_key ?? null,
    request_hash: run.request_hash ?? null,
    started_at: run.started_at,
    completed_at: run.completed_at ?? null,
    input_summary: run.input_summary,
    output_summary: run.output_summary ?? null,
    error_code: run.error_code ?? null,
    metadata_json: stringify(run.metadata)
  };
}

export function backendRunFromRow(row: BackendRunsTable): BackendRunRecord {
  return {
    id: row.id,
    ...(row.session_id ? { session_id: row.session_id } : {}),
    ...(row.room_id ? { room_id: row.room_id } : {}),
    ...(row.principal_json ? { principal: parse(row.principal_json) } : {}),
    ...(row.source_json ? { source: parse(row.source_json) } : {}),
    ...(row.session_ref_json ? { session_ref: parse(row.session_ref_json) } : {}),
    agent_id: row.agent_id ?? undefined,
    requested_by_participant_id: row.requested_by_participant_id ?? undefined,
    ...(row.input_message_id ? { input_message_id: row.input_message_id } : {}),
    output_message_id: row.output_message_id ?? undefined,
    backend_id: row.backend_id,
    backend_kind: row.backend_kind as BackendRunRecord["backend_kind"],
    status: row.status as BackendRunRecord["status"],
    ...(row.phase ? { phase: row.phase as BackendRunRecord["phase"] } : {}),
    ...(row.backend_session_id ? { backend_session_id: row.backend_session_id } : {}),
    ...(row.current_attempt !== null ? { current_attempt: row.current_attempt } : {}),
    ...(row.request_idempotency_key ? { request_idempotency_key: row.request_idempotency_key } : {}),
    ...(row.request_hash ? { request_hash: row.request_hash } : {}),
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    input_summary: row.input_summary,
    output_summary: row.output_summary ?? undefined,
    error_code: row.error_code ?? undefined,
    metadata: parse(row.metadata_json)
  };
}

export function workspaceChangeToRow(change: WorkspaceChangeRecord): WorkspaceChangesTable {
  return {
    id: change.id,
    run_id: change.run_id,
    session_id: change.session_id ?? null,
    resource_ref_json: stringify(change.resource_ref),
    change_type: change.change_type,
    summary: change.summary,
    legacy_operation_id: change.legacy_operation_id ?? null,
    correlation_id: change.correlation_id ?? null,
    created_at: change.created_at
  };
}

export function workspaceChangeFromRow(row: WorkspaceChangesTable): WorkspaceChangeRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    ...(row.session_id ? { session_id: row.session_id } : {}),
    resource_ref: parse(row.resource_ref_json),
    change_type: row.change_type as WorkspaceChangeRecord["change_type"],
    summary: row.summary,
    legacy_operation_id: row.legacy_operation_id ?? undefined,
    correlation_id: row.correlation_id ?? undefined,
    created_at: row.created_at
  };
}

export function messagePresentationToRow(presentation: MessagePresentationRecord): MessagePresentationsTable {
  return {
    id: presentation.id,
    session_id: presentation.session_id,
    message_id: presentation.message_id,
    kind: presentation.kind,
    title: presentation.title,
    subtitle: presentation.subtitle,
    collection_id: presentation.collection_id,
    view_id: presentation.view_id,
    renderer: presentation.renderer,
    view_state_json: presentation.view_state ? stringify(presentation.view_state) : null,
    surface_id: presentation.surface_id ?? null,
    revision_id: presentation.revision_id ?? null,
    preview_url: presentation.preview_url ?? null,
    created_at: presentation.created_at,
    updated_at: presentation.updated_at
  };
}

export function messagePresentationFromRow(row: MessagePresentationsTable): MessagePresentationRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    message_id: row.message_id,
    kind: row.kind === "generated_surface" ? "generated_surface" : row.kind === "skill_optimization" ? "skill_optimization" : "collection_app",
    title: row.title,
    subtitle: row.subtitle,
    collection_id: row.collection_id,
    view_id: row.view_id,
    renderer: row.renderer,
    view_state: row.view_state_json ? parse<Record<string, JsonValue>>(row.view_state_json) : undefined,
    ...(row.surface_id ? { surface_id: row.surface_id } : {}),
    ...(row.revision_id ? { revision_id: row.revision_id } : {}),
    ...(row.preview_url ? { preview_url: row.preview_url } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
