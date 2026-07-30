import { redactPrivateData, stableHash, type BackendEventRecord, type BackendRunRecord, type JsonValue, type MessageRecord } from "@samurai-agent/core-schemas";
import { sql, type Transaction } from "kysely";
import type { BackendEventsTable, MessagesTable, WorkspaceDb as KernelWorkspaceDb } from "../kernel/workspace-db-schema";
import { backendEventToRow } from "./backend-events";
import { parse } from "./serialization";
import type { Core02SettlementInput } from "../workspace-store-contracts";

export function titleFromContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").slice(0, 48) || "Untitled chat";
}

export function isInitialSessionTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "" || normalized === "new chat" || normalized === "untitled chat";
}

export function isTerminalBackendRunStatus(status: BackendRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "outcome_unknown";
}

export function isBackendRunIdempotencyConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("backend_runs.session_id, backend_runs.request_idempotency_key")
    || message.includes("idx_backend_runs_session_idempotency");
}

export function normalizeSettlementEvent(event: BackendEventRecord, current: BackendRunRecord, nextRun: BackendRunRecord): BackendEventRecord {
  const payload = redactPrivateData(event.payload, { redactPii: true });
  const attemptNo = event.attempt_no ?? nextRun.current_attempt ?? current.current_attempt ?? 1;
  const terminalEvidence = payload.terminal_evidence ?? inferredSettlementEvidence(nextRun.status, nextRun.error_code);
  return {
    ...event,
    source_event_id: event.source_event_id ?? `terminal:${current.id}:${attemptNo}:${nextRun.status}`,
    attempt_no: attemptNo,
    sequence: Math.max(1, event.sequence),
    payload: { ...payload, terminal_evidence: terminalEvidence }
  };
}

export function inferredSettlementEvidence(status: BackendRunRecord["status"], errorCode?: string): JsonValue {
  if (status === "completed") return { kind: "completed", source: "canonical_event" };
  if (status === "cancelled") return { kind: "cancelled", source: "canonical_event" };
  if (status === "outcome_unknown") return { kind: "indeterminate", reason: "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true };
  return { kind: "failed", source: "canonical_event", error: { code: errorCode ?? "backend_failed", message: "Backend operation failed.", retryable: false, causeCategory: "runtime" } };
}

export async function findSettlementEvent(transaction: Transaction<KernelWorkspaceDb>, event: BackendEventRecord): Promise<BackendEventsTable | undefined> {
  if (event.source_event_id) {
    const bySource = await transaction.selectFrom("backend_events").selectAll().where("run_id", "=", event.run_id).where("attempt_no", "=", event.attempt_no ?? 1).where("source_event_id", "=", event.source_event_id).executeTakeFirst();
    if (bySource) return bySource;
  }
  if (!event.source_event_id && event.source_sequence !== undefined) {
    const bySequence = await transaction.selectFrom("backend_events").selectAll().where("run_id", "=", event.run_id).where("attempt_no", "=", event.attempt_no ?? 1).where("source_event_id", "is", null).where("source_sequence", "=", event.source_sequence).executeTakeFirst();
    if (bySequence) return bySequence;
  }
  return transaction.selectFrom("backend_events").selectAll().where("id", "=", event.id).executeTakeFirst();
}

export async function releaseReservationInTransaction(transaction: Transaction<KernelWorkspaceDb>, runId: string, expectedVersion: number, releasedAt: string): Promise<void> {
  let update = transaction.updateTable("session_run_reservations")
    .set({ status: "released", released_at: releasedAt, version: sql<number>`version + 1` })
    .where("run_id", "=", runId)
    .where("status", "=", "held");
  if (expectedVersion > 0) update = update.where("version", "=", expectedVersion);
  const result = await update.executeTakeFirst();
  if (Number(result.numUpdatedRows ?? 0) === 1 || expectedVersion === 0) return;
  const current = await transaction.selectFrom("session_run_reservations").select(["status"]).where("run_id", "=", runId).executeTakeFirst();
  if (current?.status === "released") return;
  throw new Error(`settlement_reservation_conflict:${runId}`);
}

export async function assertCore02SettlementReplay(
  current: BackendRunRecord,
  nextRun: BackendRunRecord,
  event: BackendEventRecord,
  output: MessageRecord | undefined,
  diagnostic: Core02SettlementInput["diagnostic"],
  transaction: Transaction<KernelWorkspaceDb>
): Promise<void> {
  const resultWasCorrected = current.status === "outcome_unknown" && nextRun.status !== "outcome_unknown";
  if (current.status !== nextRun.status && !resultWasCorrected) throw new Error(`settlement_conflict:${current.id}`);
  const existingEvent = await findSettlementEvent(transaction, event);
  if (!existingEvent || (!sameBackendEvent(existingEvent, event) && !(existingEvent.id === event.id && sameBackendEventIgnoringIdentity(existingEvent, event)))) throw new Error(`settlement_event_conflict:${current.id}`);
  if (output) {
    if (current.output_message_id !== output.id) throw new Error(`settlement_output_conflict:${current.id}`);
    const outputRow = await transaction.selectFrom("messages").selectAll().where("id", "=", output.id).executeTakeFirst();
    if (!outputRow || !sameMessage(outputRow, output)) throw new Error(`settlement_output_conflict:${current.id}`);
  } else if (current.output_message_id) {
    throw new Error(`settlement_output_conflict:${current.id}`);
  }
  const storedDiagnosticCode = current.metadata.settlement_diagnostic_code;
  const storedDiagnosticMessage = current.metadata.settlement_diagnostic_message;
  if (diagnostic) {
    if (storedDiagnosticCode !== diagnostic.code || storedDiagnosticMessage !== diagnostic.message) {
      throw new Error(`settlement_conflict:${current.id}`);
    }
    for (const [key, value] of Object.entries(diagnostic.metadata ?? {})) {
      if (current.metadata[key] !== value) throw new Error(`settlement_conflict:${current.id}`);
    }
  } else if (storedDiagnosticCode !== undefined || storedDiagnosticMessage !== undefined) {
    throw new Error(`settlement_conflict:${current.id}`);
  }
}

export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message);
}

export function sameMessage(row: MessagesTable, message: MessageRecord): boolean {
  return stableHash({
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    input_locale: row.input_locale,
    output_locale: row.output_locale,
    envelope: row.envelope_json === null ? null : parse(row.envelope_json)
  }) === stableHash({
    id: message.id,
    session_id: message.session_id,
    role: message.role,
    content: message.content,
    input_locale: message.input_locale,
    output_locale: message.output_locale,
    envelope: message.envelope ?? null
  });
}

export function sameBackendEvent(row: BackendEventsTable, event: BackendEventRecord): boolean {
  const comparableRow = {
    run_id: row.run_id,
    session_id: row.session_id,
    backend_session_id: row.backend_session_id,
    event_type: row.event_type,
    attempt_no: row.attempt_no,
    source_event_id: row.source_event_id,
    source_sequence: row.source_sequence,
    payload_json: row.payload_json,
    resource_refs_json: row.resource_refs_json
  };
  const comparableEvent = backendEventToRow(event);
  return stableHash(comparableRow) === stableHash({
    run_id: comparableEvent.run_id,
    session_id: comparableEvent.session_id,
    backend_session_id: comparableEvent.backend_session_id,
    event_type: comparableEvent.event_type,
    attempt_no: comparableEvent.attempt_no,
    source_event_id: comparableEvent.source_event_id,
    source_sequence: comparableEvent.source_sequence,
    payload_json: comparableEvent.payload_json,
    resource_refs_json: comparableEvent.resource_refs_json
  });
}

export function sameBackendEventIgnoringIdentity(row: BackendEventsTable, event: BackendEventRecord): boolean {
  const comparableRow = {
    run_id: row.run_id,
    session_id: row.session_id,
    backend_session_id: row.backend_session_id,
    event_type: row.event_type,
    attempt_no: row.attempt_no,
    payload_json: row.payload_json,
    resource_refs_json: row.resource_refs_json
  };
  const comparableEvent = backendEventToRow(event);
  return stableHash(comparableRow) === stableHash({
    run_id: comparableEvent.run_id,
    session_id: comparableEvent.session_id,
    backend_session_id: comparableEvent.backend_session_id,
    event_type: comparableEvent.event_type,
    attempt_no: comparableEvent.attempt_no,
    payload_json: comparableEvent.payload_json,
    resource_refs_json: comparableEvent.resource_refs_json
  });
}

export function sameTerminalEvidence(left: unknown, right: unknown): boolean {
  return left !== undefined && right !== undefined && stableHash(left) === stableHash(right);
}

export function settlementEvidenceMatchesStatus(value: unknown, status: BackendRunRecord["status"]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (status === "completed") return kind === "completed";
  if (status === "failed") return kind === "failed" || kind === "not_started";
  if (status === "cancelled") return kind === "cancelled" || kind === "not_started";
  return status === "outcome_unknown" && kind === "indeterminate";
}

export function countBy<T>(items: T[], keyFor: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFor(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export async function assertSettlementReplayMatches(
  transaction: Transaction<KernelWorkspaceDb>,
  current: BackendRunRecord,
  requestedStatus: BackendRunRecord["status"],
  output: MessageRecord | undefined,
  safeEvents: Array<{ source: BackendEventRecord; safe: BackendEventRecord }>
): Promise<void> {
  if (current.status !== requestedStatus) {
    throw new Error(`settlement_conflict:${current.id}`);
  }
  if (output) {
    if (current.output_message_id !== output.id) {
      throw new Error(`settlement_output_conflict:${current.id}`);
    }
    const outputRow = await transaction.selectFrom("messages").selectAll().where("id", "=", output.id).executeTakeFirst();
    if (!outputRow || !sameMessage(outputRow, output)) {
      throw new Error(`settlement_output_conflict:${current.id}`);
    }
  }
  for (const { source, safe } of safeEvents) {
    const existingById = await transaction.selectFrom("backend_events").selectAll().where("id", "=", source.id).executeTakeFirst();
    const existingBySequence = await transaction.selectFrom("backend_events").selectAll().where("run_id", "=", source.run_id).where("sequence", "=", source.sequence).executeTakeFirst();
    const existing = existingById ?? existingBySequence;
    if (!existing || !sameBackendEvent(existing, safe)) {
      throw new Error(`settlement_event_conflict:${current.id}`);
    }
  }
}
