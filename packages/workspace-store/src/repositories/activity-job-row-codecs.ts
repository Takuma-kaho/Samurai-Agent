import {
  ActivityRecordSchema,
  ResourceUsageRecordSchema,
  WorkspaceJobAttemptRecordSchema,
  WorkspaceJobRecordSchema,
  type ActivityRecord,
  type Principal,
  type ResourceUsageRecord,
  type TrustedWorkspaceSource,
  type WorkspaceJobAttemptRecord,
  type WorkspaceJobRecord
} from "@samurai-agent/core-schemas";
import type {
  ActivityRecordsTable,
  ResourceUsageRecordsTable,
  WorkspaceJobAttemptsTable,
  WorkspaceJobsTable
} from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

function principalIndex(principal: Principal): { kind: string; id: string } {
  if (principal.kind === "human") return { kind: principal.kind, id: principal.participant_id };
  if (principal.kind === "agent") return { kind: principal.kind, id: principal.agent_id };
  if (principal.kind === "external_app") return { kind: principal.kind, id: principal.app_id };
  return { kind: principal.kind, id: principal.system_id };
}

function sourceId(source: TrustedWorkspaceSource): string | null {
  return source.app_id ?? source.connector_id ?? null;
}

export function activityToRow(recordInput: ActivityRecord): ActivityRecordsTable {
  const record = ActivityRecordSchema.parse(recordInput);
  const principal = principalIndex(record.principal);
  return {
    id: record.id,
    workspace_id: record.workspace_id,
    room_id: record.room_id,
    principal_json: stringify(record.principal),
    principal_kind: principal.kind,
    principal_id: principal.id,
    source_json: stringify(record.source),
    source_kind: record.source.kind,
    source_id: sourceId(record.source),
    status: record.status,
    idempotency_key: record.idempotency_key,
    instruction_summary: record.instruction_summary,
    result_summary: record.result_summary ?? null,
    verification_json: stringify(record.verification),
    failure_json: record.failure ? stringify(record.failure) : null,
    correction_of_activity_id: record.correction_of_activity_id ?? null,
    session_ref_json: record.session_ref ? stringify(record.session_ref) : null,
    backend_run_id: record.backend_run_id ?? null,
    domain_operation_ids_json: stringify(record.domain_operation_ids),
    provenance_json: stringify(record.provenance),
    created_at: record.created_at,
    updated_at: record.updated_at,
    finalized_at: record.finalized_at ?? null
  };
}

export function activityFromRow(row: ActivityRecordsTable): ActivityRecord {
  return ActivityRecordSchema.parse({
    id: row.id,
    workspace_id: row.workspace_id,
    room_id: row.room_id,
    principal: parse(row.principal_json),
    source: parse(row.source_json),
    status: row.status,
    idempotency_key: row.idempotency_key,
    instruction_summary: row.instruction_summary,
    ...(row.result_summary ? { result_summary: row.result_summary } : {}),
    verification: parse(row.verification_json),
    ...(row.failure_json ? { failure: parse(row.failure_json) } : {}),
    ...(row.correction_of_activity_id ? { correction_of_activity_id: row.correction_of_activity_id } : {}),
    ...(row.session_ref_json ? { session_ref: parse(row.session_ref_json) } : {}),
    ...(row.backend_run_id ? { backend_run_id: row.backend_run_id } : {}),
    domain_operation_ids: parse(row.domain_operation_ids_json),
    provenance: parse(row.provenance_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.finalized_at ? { finalized_at: row.finalized_at } : {})
  });
}

export function resourceUsageToRow(recordInput: ResourceUsageRecord): ResourceUsageRecordsTable {
  const record = ResourceUsageRecordSchema.parse(recordInput);
  return {
    id: record.id,
    activity_id: record.activity_id,
    workspace_job_attempt_id: record.workspace_job_attempt_id ?? null,
    resource_ref_json: stringify(record.resource_ref),
    resource_kind: record.resource_ref.kind,
    resource_id: record.resource_ref.id,
    resource_version: record.resource_version ?? null,
    content_hash: record.content_hash ?? null,
    usage_scope_json: stringify(record.usage_scope),
    stage: record.stage,
    domain_operation_id: record.domain_operation_id ?? null,
    workspace_change_id: record.workspace_change_id ?? null,
    created_at: record.created_at
  };
}

export function resourceUsageFromRow(row: ResourceUsageRecordsTable): ResourceUsageRecord {
  return ResourceUsageRecordSchema.parse({
    id: row.id,
    activity_id: row.activity_id,
    ...(row.workspace_job_attempt_id ? { workspace_job_attempt_id: row.workspace_job_attempt_id } : {}),
    resource_ref: parse(row.resource_ref_json),
    ...(row.resource_version ? { resource_version: row.resource_version } : {}),
    ...(row.content_hash ? { content_hash: row.content_hash } : {}),
    usage_scope: parse(row.usage_scope_json),
    stage: row.stage,
    ...(row.domain_operation_id ? { domain_operation_id: row.domain_operation_id } : {}),
    ...(row.workspace_change_id ? { workspace_change_id: row.workspace_change_id } : {}),
    created_at: row.created_at
  });
}

export function workspaceJobToRow(recordInput: WorkspaceJobRecord): WorkspaceJobsTable {
  const record = WorkspaceJobRecordSchema.parse(recordInput);
  return {
    id: record.id,
    workspace_id: record.workspace_id,
    room_id: record.room_id,
    root_activity_id: record.root_activity_id,
    kind: record.kind,
    processor_id: record.processor_id,
    processor_version: record.processor_version,
    idempotency_key: record.idempotency_key,
    status: record.status,
    attempt_count: record.attempt_count,
    max_attempts: record.max_attempts,
    retryable: record.retryable ? 1 : 0,
    cancel_requested_at: record.cancel_requested_at ?? null,
    lease_owner: record.lease_owner ?? null,
    lease_expires_at: record.lease_expires_at ?? null,
    heartbeat_at: record.heartbeat_at ?? null,
    retry_after_at: record.retry_after_at ?? null,
    error_code: record.error_code ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    started_at: record.started_at ?? null,
    completed_at: record.completed_at ?? null
  };
}

export function workspaceJobFromRow(row: WorkspaceJobsTable): WorkspaceJobRecord {
  return WorkspaceJobRecordSchema.parse({
    id: row.id,
    workspace_id: row.workspace_id,
    room_id: row.room_id,
    root_activity_id: row.root_activity_id,
    kind: row.kind,
    processor_id: row.processor_id,
    processor_version: row.processor_version,
    idempotency_key: row.idempotency_key,
    status: row.status,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    retryable: row.retryable === 1,
    ...(row.cancel_requested_at ? { cancel_requested_at: row.cancel_requested_at } : {}),
    ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { lease_expires_at: row.lease_expires_at } : {}),
    ...(row.heartbeat_at ? { heartbeat_at: row.heartbeat_at } : {}),
    ...(row.retry_after_at ? { retry_after_at: row.retry_after_at } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.started_at ? { started_at: row.started_at } : {}),
    ...(row.completed_at ? { completed_at: row.completed_at } : {})
  });
}

export function workspaceJobAttemptToRow(recordInput: WorkspaceJobAttemptRecord): WorkspaceJobAttemptsTable {
  const record = WorkspaceJobAttemptRecordSchema.parse(recordInput);
  return {
    id: record.id,
    workspace_job_id: record.workspace_job_id,
    attempt_no: record.attempt_no,
    activity_id: record.activity_id,
    processor_id: record.processor_id,
    processor_version: record.processor_version,
    model_json: record.model ? stringify(record.model) : null,
    prompt_or_policy_version: record.prompt_or_policy_version ?? null,
    input_schema_version: record.input_schema_version,
    output_schema_version: record.output_schema_version ?? null,
    resource_versions_json: stringify(record.resource_versions),
    input_hash: record.input_hash ?? null,
    output_hash: record.output_hash ?? null,
    output_json: record.output ? stringify(record.output) : null,
    summary: record.summary ?? null,
    diagnostics_json: stringify(record.diagnostics),
    status: record.status,
    error_code: record.error_code ?? null,
    started_at: record.started_at,
    prepared_at: record.prepared_at ?? null,
    completed_at: record.completed_at ?? null
  };
}

export function workspaceJobAttemptFromRow(row: WorkspaceJobAttemptsTable): WorkspaceJobAttemptRecord {
  return WorkspaceJobAttemptRecordSchema.parse({
    id: row.id,
    workspace_job_id: row.workspace_job_id,
    attempt_no: row.attempt_no,
    activity_id: row.activity_id,
    processor_id: row.processor_id,
    processor_version: row.processor_version,
    ...(row.model_json ? { model: parse(row.model_json) } : {}),
    ...(row.prompt_or_policy_version ? { prompt_or_policy_version: row.prompt_or_policy_version } : {}),
    input_schema_version: row.input_schema_version,
    ...(row.output_schema_version ? { output_schema_version: row.output_schema_version } : {}),
    resource_versions: parse(row.resource_versions_json),
    ...(row.input_hash ? { input_hash: row.input_hash } : {}),
    ...(row.output_hash ? { output_hash: row.output_hash } : {}),
    ...(row.output_json ? { output: parse(row.output_json) } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    diagnostics: parse(row.diagnostics_json),
    status: row.status,
    ...(row.error_code ? { error_code: row.error_code } : {}),
    started_at: row.started_at,
    ...(row.prepared_at ? { prepared_at: row.prepared_at } : {}),
    ...(row.completed_at ? { completed_at: row.completed_at } : {})
  });
}
