import {
  ExternalAssistRecordSchema,
  nowIso,
  type BackgroundReviewChangeRecord,
  type CuratorStateRecord,
  type ExternalAssistRecord,
  type LearningEvaluationRecord,
  type LearningResourceUseRecord,
  type LearningSnapshotRecord,
  type ReflectionRunRecord,
  type ReflectionSuggestionRecord
} from "@samurai-agent/core-schemas";
import type {
  BackgroundReviewChangeTable,
  CuratorStateTable,
  ExternalAssistRecordsTable,
  LearningEvaluationTable,
  LearningResourceUseTable,
  LearningSnapshotTable,
  ReflectionRunsTable,
  ReflectionSuggestionsTable
} from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

export function learningResourceUseFromRow(row: LearningResourceUseTable): LearningResourceUseRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    session_id: row.session_id,
    activity_context: row.room_id && row.agent_id ? { room_id: row.room_id, session_id: row.session_id, agent_id: row.agent_id } : undefined,
    resource_kind: row.resource_kind as LearningResourceUseRecord["resource_kind"],
    resource_id: row.resource_id,
    resource_version: row.resource_version ?? undefined,
    content_hash: row.content_hash ?? undefined,
    stage: row.stage as LearningResourceUseRecord["stage"],
    source_operation_id: row.source_operation_id ?? undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at
  };
}

export function learningEvaluationFromRow(row: LearningEvaluationTable): LearningEvaluationRecord {
  return {
    id: row.id,
    learning_resource_ref: parse(row.learning_resource_ref_json),
    learning_resource_version: row.learning_resource_version ?? undefined,
    task_class: row.task_class,
    compared_run_ids: parse(row.compared_run_ids_json),
    before_metrics: parse(row.before_metrics_json),
    after_metrics: parse(row.after_metrics_json),
    effect_estimate: row.effect_estimate,
    confidence: row.confidence,
    assessment: row.assessment as LearningEvaluationRecord["assessment"],
    evidence_refs: parse(row.evidence_refs_json),
    evaluator: row.evaluator,
    created_at: row.created_at
  };
}

export function learningSnapshotFromRow(row: LearningSnapshotTable): LearningSnapshotRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    path: row.path,
    resource_counts: parse(row.resource_counts_json),
    created_at: row.created_at,
    restored_at: row.restored_at ?? undefined
  };
}

export function backgroundReviewChangeFromRow(row: BackgroundReviewChangeTable): BackgroundReviewChangeRecord {
  return {
    id: row.id,
    origin: "background_review",
    source_run_id: row.source_run_id,
    source_session_id: row.source_session_id,
    activity_context: row.room_id && row.agent_id ? { room_id: row.room_id, session_id: row.source_session_id, agent_id: row.agent_id } : undefined,
    review_run_id: row.review_run_id,
    mutation_kind: row.mutation_kind as BackgroundReviewChangeRecord["mutation_kind"],
    resource_ref: parse(row.resource_ref_json),
    before_version: row.before_version ?? undefined,
    after_version: row.after_version,
    reason_summary: row.reason_summary,
    evidence_refs: parse(row.evidence_refs_json),
    created_at: row.created_at
  };
}

export function defaultCuratorState(): CuratorStateRecord {
  return {
    id: "default",
    paused: false,
    interval_hours: 24 * 7,
    min_idle_hours: 2,
    stale_after_days: 30,
    archive_after_days: 90,
    run_count: 0,
    updated_at: nowIso()
  };
}

export function curatorStateToRow(record: CuratorStateRecord): CuratorStateTable {
  return {
    id: record.id,
    paused: record.paused ? 1 : 0,
    interval_hours: record.interval_hours,
    min_idle_hours: record.min_idle_hours,
    stale_after_days: record.stale_after_days,
    archive_after_days: record.archive_after_days,
    last_run_at: record.last_run_at ?? null,
    last_run_summary: record.last_run_summary ?? null,
    run_count: record.run_count,
    updated_at: record.updated_at
  };
}

export function curatorStateFromRow(row: CuratorStateTable): CuratorStateRecord {
  return {
    id: "default",
    paused: row.paused === 1,
    interval_hours: row.interval_hours,
    min_idle_hours: row.min_idle_hours,
    stale_after_days: row.stale_after_days,
    archive_after_days: row.archive_after_days,
    last_run_at: row.last_run_at ?? undefined,
    last_run_summary: row.last_run_summary ?? undefined,
    run_count: row.run_count,
    updated_at: row.updated_at
  };
}

export function reflectionRunToRow(run: ReflectionRunRecord): ReflectionRunsTable {
  return {
    id: run.id,
    kind: run.kind,
    source_run_id: run.source_run_id ?? null,
    session_id: run.session_id ?? null,
    room_id: run.activity_context?.room_id ?? null,
    agent_id: run.activity_context?.agent_id ?? null,
    status: run.status,
    input_summary: run.input_summary,
    output_summary: run.output_summary ?? null,
    started_at: run.started_at,
    completed_at: run.completed_at ?? null,
    error: run.error ?? null
  };
}

export function reflectionRunFromRow(row: ReflectionRunsTable): ReflectionRunRecord {
  return {
    id: row.id,
    kind: row.kind as ReflectionRunRecord["kind"],
    source_run_id: row.source_run_id ?? undefined,
    session_id: row.session_id ?? undefined,
    activity_context: row.room_id && row.session_id && row.agent_id ? { room_id: row.room_id, session_id: row.session_id, agent_id: row.agent_id } : undefined,
    status: row.status as ReflectionRunRecord["status"],
    input_summary: row.input_summary,
    output_summary: row.output_summary ?? undefined,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    error: row.error ?? undefined
  };
}

export function reflectionSuggestionToRow(suggestion: ReflectionSuggestionRecord): ReflectionSuggestionsTable {
  return {
    id: suggestion.id,
    reflection_run_id: suggestion.reflection_run_id,
    suggestion_type: suggestion.suggestion_type,
    status: suggestion.status,
    title: suggestion.title,
    content: suggestion.content,
    target_ref_json: suggestion.target_ref ? stringify(suggestion.target_ref) : null,
    source_refs_json: stringify(suggestion.source_refs),
    confidence: suggestion.confidence,
    created_at: suggestion.created_at,
    updated_at: suggestion.updated_at
  };
}

export function reflectionSuggestionFromRow(row: ReflectionSuggestionsTable): ReflectionSuggestionRecord {
  return {
    id: row.id,
    reflection_run_id: row.reflection_run_id,
    suggestion_type: row.suggestion_type as ReflectionSuggestionRecord["suggestion_type"],
    status: row.status as ReflectionSuggestionRecord["status"],
    title: row.title,
    content: row.content,
    target_ref: row.target_ref_json ? parse(row.target_ref_json) : undefined,
    source_refs: parse(row.source_refs_json),
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function externalAssistRecordToRow(record: ExternalAssistRecord): ExternalAssistRecordsTable {
  return {
    id: record.id,
    phase: record.phase,
    status: record.status,
    provider_id: record.provider_id,
    session_id: record.session_id,
    run_id: record.run_id ?? null,
    input_message_id: record.input_message_id ?? null,
    query: record.query,
    role: record.role,
    hints_json: stringify(record.hints),
    error: record.error ?? null,
    isolated_from_memory: record.isolated_from_memory ? 1 : 0,
    included_in_active_memory: record.included_in_active_memory ? 1 : 0,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export function externalAssistRecordFromRow(row: ExternalAssistRecordsTable): ExternalAssistRecord {
  return ExternalAssistRecordSchema.parse({
    id: row.id,
    phase: row.phase,
    status: row.status,
    provider_id: row.provider_id,
    session_id: row.session_id,
    run_id: row.run_id ?? undefined,
    input_message_id: row.input_message_id ?? undefined,
    query: row.query,
    role: row.role,
    hints: parse(row.hints_json),
    error: row.error ?? undefined,
    isolated_from_memory: Boolean(row.isolated_from_memory),
    included_in_active_memory: Boolean(row.included_in_active_memory),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}
