import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BackendEventRecordSchema,
  SessionCompactionRecordSchema,
  createId,
  nowIso,
  redactPrivateData,
  type BackendEventRecord,
  type BackendRunRecord,
  type ChangeHistoryEntry,
  type JsonValue,
  type MessagePresentationRecord,
  type MessageRecord,
  type OperationRecord,
  type RunHistoryEntry,
  type SessionCompactionRecord,
  type SessionRecord,
  type ToolRunDiagnosticsReport,
  type ToolRunRecord,
  type ToolRunStatus,
  type WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import { sql, type Kysely, type Transaction } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import { SessionSearchIndex } from "../kernel/session-search-index";
import type { Core02SettlementInput } from "../workspace-store-contracts";
import { backendEventFromRow, backendEventToRow } from "./backend-events";
import {
  assertCore02SettlementReplay,
  countBy,
  findSettlementEvent,
  isBackendRunIdempotencyConstraint,
  isInitialSessionTitle,
  isSqliteBusyError,
  isTerminalBackendRunStatus,
  normalizeSettlementEvent,
  releaseReservationInTransaction,
  sameBackendEvent,
  sameBackendEventIgnoringIdentity,
  sameMessage,
  sameTerminalEvidence,
  settlementEvidenceMatchesStatus,
  titleFromContent
} from "./session-execution-codecs";
import {
  backendRunFromRow,
  backendRunToRow,
  messageFromRow,
  messagePresentationFromRow,
  messagePresentationToRow,
  operationFromRow,
  operationToRow,
  sessionFromRow,
  workspaceChangeFromRow,
  workspaceChangeToRow
} from "./session-execution-row-codecs";
import { stringify } from "./serialization";
import { groupToolRunDiagnostics, normalizeToolRunDiagnosticsLimit } from "./tool-run-diagnostics";
import { toolRunFromRow, toolRunToRow } from "./tool-run-row-codecs";

/** Session, message, run, event, reservation, tool, and workspace-change persistence. */
export class SessionExecutionRepository {
  constructor(
    private readonly db: Kysely<WorkspaceDb>,
    private readonly rootDir: string,
    private readonly search: SessionSearchIndex
  ) {}

async createSession(session: SessionRecord): Promise<SessionRecord> {
  await this.db.insertInto("sessions").values(session).execute();
  await this.search.upsert({ kind: "session", id: session.id, title: session.title, body: session.session_key });
  return session;
}

async listSessions(): Promise<SessionRecord[]> {
  const rows = await this.db.selectFrom("sessions").selectAll().orderBy("updated_at", "desc").execute();
  return rows.map(sessionFromRow);
}

async getSession(sessionId: string): Promise<SessionRecord | undefined> {
  const row = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
  return row ? sessionFromRow(row) : undefined;
}

async saveSessionCompaction(recordInput: SessionCompactionRecord): Promise<SessionCompactionRecord> {
  const record = SessionCompactionRecordSchema.parse(recordInput);
  const relativePath = path.join("sessions", record.session_id, "context-summary.json");
  const absolutePath = path.join(this.rootDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const pendingPath = `${absolutePath}.pending`;
  await writeFile(pendingPath, `${JSON.stringify(record, null, 2)}\n`);
  await rename(pendingPath, absolutePath);
  return record;
}

async getSessionCompaction(sessionId: string): Promise<SessionCompactionRecord | undefined> {
  const raw = await readFile(path.join(this.rootDir, "sessions", sessionId, "context-summary.json"), "utf8").catch(() => undefined);
  return raw ? SessionCompactionRecordSchema.parse(JSON.parse(raw)) : undefined;
}


async touchSession(sessionId: string, title?: string): Promise<void> {
  await this.db
    .updateTable("sessions")
    .set({
      ...(title ? { title } : {}),
      updated_at: nowIso()
    })
    .where("id", "=", sessionId)
    .execute();
  const session = await this.getSession(sessionId);
  if (session) await this.search.upsert({ kind: "session", id: session.id, title: session.title, body: session.session_key });
}

async saveMessage(message: MessageRecord): Promise<MessageRecord> {
  await this.db
    .insertInto("messages")
    .values({
      id: message.id,
      session_id: message.session_id,
      role: message.role,
      content: message.content,
      input_locale: message.input_locale,
      output_locale: message.output_locale,
      envelope_json: message.envelope ? stringify(message.envelope) : null,
      created_at: message.created_at
    })
    .execute();
  const session = await this.getSession(message.session_id);
  const nextTitle = message.role === "user" && session && isInitialSessionTitle(session.title) ? titleFromContent(message.content) : undefined;
  await this.touchSession(message.session_id, nextTitle);
  await this.search.upsert({ kind: "message", id: message.id, sessionId: message.session_id, title: message.role, body: message.content });
  return message;
}

async updateMessageContent(messageId: string, content: string): Promise<MessageRecord | undefined> {
  await this.db.updateTable("messages").set({ content }).where("id", "=", messageId).execute();
  const row = await this.db.selectFrom("messages").selectAll().where("id", "=", messageId).executeTakeFirst();
  if (!row) return undefined;
  const message = messageFromRow(row);
  await this.search.upsert({ kind: "message", id: message.id, sessionId: message.session_id, title: message.role, body: message.content });
  return message;
}

async deleteMessage(messageId: string): Promise<boolean> {
  const result = await this.db.deleteFrom("messages").where("id", "=", messageId).executeTakeFirst();
  if (Number(result.numDeletedRows) === 1) await this.search.remove("message", messageId);
  return Number(result.numDeletedRows) === 1;
}

async listMessages(sessionId: string): Promise<MessageRecord[]> {
  const rows = await this.db.selectFrom("messages").selectAll().where("session_id", "=", sessionId).orderBy("created_at").execute();
  return rows.map(messageFromRow);
}

async saveMessagePresentation(presentation: MessagePresentationRecord): Promise<MessagePresentationRecord> {
  await this.db
    .insertInto("message_presentations")
    .values(messagePresentationToRow(presentation))
    .execute();
  return presentation;
}

async getMessagePresentation(id: string): Promise<MessagePresentationRecord | undefined> {
  const row = await this.db
    .selectFrom("message_presentations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? messagePresentationFromRow(row) : undefined;
}

async updateMessagePresentationViewState(input: { id: string; viewState: Record<string, JsonValue>; updatedAt?: string }): Promise<MessagePresentationRecord | undefined> {
  const updatedAt = input.updatedAt ?? nowIso();
  const viewId = typeof input.viewState.view_id === "string" && input.viewState.view_id.trim()
    ? input.viewState.view_id
    : undefined;
  const renderer = typeof input.viewState.renderer === "string" && input.viewState.renderer.trim()
    ? input.viewState.renderer
    : undefined;
  await this.db
    .updateTable("message_presentations")
    .set({
      ...(viewId ? { view_id: viewId } : {}),
      ...(renderer ? { renderer } : {}),
      view_state_json: stringify(input.viewState),
      updated_at: updatedAt
    })
    .where("id", "=", input.id)
    .execute();
  const row = await this.db
    .selectFrom("message_presentations")
    .selectAll()
    .where("id", "=", input.id)
    .executeTakeFirst();
  return row ? messagePresentationFromRow(row) : undefined;
}

async listMessagePresentations(input: { sessionId: string; messageId?: string }): Promise<MessagePresentationRecord[]> {
  let query = this.db
    .selectFrom("message_presentations")
    .selectAll()
    .where("session_id", "=", input.sessionId);
  if (input.messageId) {
    query = query.where("message_id", "=", input.messageId);
  }
  const rows = await query.orderBy("created_at").execute();
  return rows.map(messagePresentationFromRow);
}

async saveOperation(operation: OperationRecord): Promise<OperationRecord> {
  await this.db
    .insertInto("operations")
    .values(operationToRow(operation))
    .execute();
  return operation;
}



async updateOperation(operation: OperationRecord): Promise<OperationRecord> {
  await this.db
    .updateTable("operations")
    .set(operationToRow(operation))
    .where("id", "=", operation.id)
    .execute();
  return operation;
}

async getOperation(operationId: string): Promise<OperationRecord | undefined> {
  const row = await this.db.selectFrom("operations").selectAll().where("id", "=", operationId).executeTakeFirst();
  return row ? operationFromRow(row) : undefined;
}

async listOperations(sessionId?: string): Promise<OperationRecord[]> {
  let query = this.db.selectFrom("operations").selectAll();
  if (sessionId) {
    query = query.where("session_id", "=", sessionId);
  }
  const rows = await query.orderBy("created_at", "desc").execute();
  return rows.map(operationFromRow);
}

async saveBackendRun(run: BackendRunRecord): Promise<BackendRunRecord> {
  await this.db.insertInto("backend_runs").values(backendRunToRow(run)).execute();
  return run;
}

/** Core 02 admission: reservation, user message and queued run commit together. */
private async executeCore02Transaction<T>(operation: (transaction: Transaction<WorkspaceDb>) => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  const defaultBusyTimeoutMs = 5000;
  await sql.raw("PRAGMA busy_timeout = 100").execute(this.db);
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.db.transaction().execute(operation);
      } catch (error) {
        if (!isSqliteBusyError(error) || attempt === maxAttempts) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 10));
      }
    }
  } finally {
    await sql.raw(`PRAGMA busy_timeout = ${defaultBusyTimeoutMs}`).execute(this.db);
  }
  throw new Error("core02_transaction_retry_exhausted");
}

async admitTurn(input: {
  session: SessionRecord;
  binding: { id: string; kind: BackendRunRecord["backend_kind"] };
  request: { sessionId: string; content: string; envelope: MessageRecord["envelope"]; idempotencyKey: string; agentId?: string; metadata?: JsonValue };
  requestHash: string;
  runId: string;
  now: string;
}): Promise<{ reservation: { sessionId: string; runId: string; version: number; status: "held" | "released" }; userMessage: MessageRecord; run: BackendRunRecord; replay: boolean }> {
  if (!input.request.envelope) throw new Error("message_envelope_required");
  const message: MessageRecord = { id: createId("message"), session_id: input.session.id, role: "user", content: input.request.content, input_locale: input.request.envelope.input_locale, output_locale: input.request.envelope.output_locale, envelope: input.request.envelope, created_at: input.now };
  const run: BackendRunRecord = { id: input.runId, session_id: input.session.id, ...(input.request.agentId ? { agent_id: input.request.agentId } : {}), input_message_id: message.id, backend_id: input.binding.id, backend_kind: input.binding.kind, status: "queued", phase: "admitted", current_attempt: 1, request_idempotency_key: input.request.idempotencyKey, request_hash: input.requestHash, started_at: input.now, input_summary: input.request.content.slice(0, 240), metadata: typeof input.request.metadata === "object" && input.request.metadata && !Array.isArray(input.request.metadata) ? input.request.metadata as Record<string, JsonValue> : {} };
  let reservationVersion = 1;
  try {
    await this.executeCore02Transaction(async (transaction) => {
    // The first write is the source of truth for same-key races.  Do not
    // pre-read the unique key and then upgrade a read transaction to write.
    await transaction.insertInto("backend_runs").values(backendRunToRow(run)).execute();
    const reservation = await transaction.selectFrom("session_run_reservations").selectAll().where("session_id", "=", input.session.id).executeTakeFirst();
    if (reservation?.status === "held") {
      const heldRun = await transaction.selectFrom("backend_runs").select(["status"]).where("id", "=", reservation.run_id).executeTakeFirst();
      const code = heldRun?.status === "waiting_for_backend_input" ? "session_waiting_for_backend_input" : "session_run_in_progress";
      throw new Error(`${code}:${reservation.run_id}`);
    }
    reservationVersion = reservation ? reservation.version + 1 : 1;
    await transaction.insertInto("messages").values({ id: message.id, session_id: message.session_id, role: message.role, content: message.content, input_locale: message.input_locale, output_locale: message.output_locale, envelope_json: stringify(message.envelope), created_at: message.created_at }).execute();
    if (reservation) {
      const updated = await transaction.updateTable("session_run_reservations").set({ run_id: run.id, status: "held", version: reservationVersion, held_at: input.now, released_at: null }).where("session_id", "=", input.session.id).where("status", "=", "released").where("version", "=", reservation.version).executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) !== 1) throw new Error("session_reservation_conflict");
    } else {
      await transaction.insertInto("session_run_reservations").values({ session_id: input.session.id, run_id: run.id, status: "held", version: 1, held_at: input.now, released_at: null }).execute();
    }
    });
  } catch (error) {
    if (isBackendRunIdempotencyConstraint(error)) {
      const replayRunRow = await this.db.selectFrom("backend_runs").selectAll()
        .where("session_id", "=", input.session.id)
        .where("request_idempotency_key", "=", input.request.idempotencyKey)
        .executeTakeFirst();
      if (replayRunRow) {
        const replayRun = backendRunFromRow(replayRunRow);
        if (replayRun.request_hash !== input.requestHash) {
          throw new Error("idempotency_conflict");
        }
        const replayMessageRow = await this.db.selectFrom("messages").selectAll().where("id", "=", replayRun.input_message_id).executeTakeFirst();
        if (!replayMessageRow) {
          throw new Error(`admission_replay_missing_message:${replayRun.id}`);
        }
        const replayReservation = await this.db.selectFrom("session_run_reservations").selectAll().where("run_id", "=", replayRun.id).executeTakeFirst();
        const released = replayReservation?.status === "released" || isTerminalBackendRunStatus(replayRun.status);
        return {
          reservation: { sessionId: input.session.id, runId: replayRun.id, version: replayReservation?.version ?? 1, status: released ? "released" : "held" },
          userMessage: messageFromRow(replayMessageRow),
          run: replayRun,
          replay: true
        };
      }
    }
    throw error;
  }
  return { reservation: { sessionId: input.session.id, runId: run.id, version: reservationVersion, status: "held" }, userMessage: message, run, replay: false };
}

async releaseReservation(runId: string): Promise<void> {
  await this.db.updateTable("session_run_reservations").set({ status: "released", released_at: nowIso(), version: sql<number>`version + 1` }).where("run_id", "=", runId).where("status", "=", "held").execute();
}

async getSessionRunReservation(input: { runId: string }): Promise<{ sessionId: string; runId: string; version: number; status: "held" | "released" } | undefined> {
  const row = await this.db.selectFrom("session_run_reservations").selectAll().where("run_id", "=", input.runId).executeTakeFirst();
  if (!row) return undefined;
  return { sessionId: row.session_id, runId: row.run_id, version: row.version, status: row.status === "held" ? "held" : "released" };
}

async commitCore02RunTransition(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> {
  let query = this.db.updateTable("backend_runs")
    .set(backendRunToRow(input.nextRun))
    .where("id", "=", input.expectedRun.id)
    .where("status", "=", input.expectedRun.status);
  query = input.expectedRun.phase === undefined ? query.where("phase", "is", null) : query.where("phase", "=", input.expectedRun.phase);
  query = input.expectedRun.current_attempt === undefined ? query.where("current_attempt", "is", null) : query.where("current_attempt", "=", input.expectedRun.current_attempt);
  const updated = await query.executeTakeFirst();
  if (Number(updated.numUpdatedRows ?? 0) !== 1) throw new Error(`run_lifecycle_cas_conflict:${input.expectedRun.id}`);
  return input.nextRun;
}

async commitCore02BackendSession(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> {
  if (input.expectedRun.backend_session_id && input.nextRun.backend_session_id !== input.expectedRun.backend_session_id) {
    throw new Error(`backend_session_conflict:${input.expectedRun.id}`);
  }
  return this.commitCore02RunTransition(input);
}

/**
 * Core 02's only terminal persistence boundary. The terminal Event is
 * prepared in memory by the Journal and becomes durable here, together with
 * the output/diagnostic, Run settlement, and Session reservation release.
 */
async commitTurnSettlement(input: Core02SettlementInput): Promise<BackendRunRecord> {
  const nextStatus = input.nextRun.status;
  if (!isTerminalBackendRunStatus(nextStatus)) throw new Error(`settlement_status_not_terminal:${nextStatus}`);
  if (input.outputSourceId !== `message:${input.expectedRun.id}:output`) throw new Error(`settlement_output_source_conflict:${input.expectedRun.id}`);
  if (!Number.isSafeInteger(input.attemptNo) || input.attemptNo <= 0) throw new Error(`settlement_attempt_invalid:${input.expectedRun.id}`);
  if (input.nextRun.phase !== "settled" || input.decision.toStatus !== nextStatus || input.decision.toPhase !== "settled") throw new Error(`settlement_decision_conflict:${input.expectedRun.id}`);
  if (input.decision.fromStatus !== input.expectedRun.status || input.decision.fromPhase !== (input.expectedRun.phase ?? "admitted")) throw new Error(`settlement_decision_source_conflict:${input.expectedRun.id}`);
  if (input.expectedRun.id !== input.nextRun.id || input.expectedRun.session_id !== input.nextRun.session_id || input.reservation.runId !== input.expectedRun.id || input.reservation.sessionId !== input.expectedRun.session_id) {
    throw new Error(`settlement_scope_conflict:${input.expectedRun.id}`);
  }
  if (input.terminalEvent.run_id !== input.expectedRun.id || input.terminalEvent.session_id !== input.expectedRun.session_id) throw new Error(`settlement_event_scope_conflict:${input.expectedRun.id}`);
  if (input.terminalEvent.event_type !== "run_completed" && input.terminalEvent.event_type !== "run_failed") throw new Error(`settlement_event_not_terminal:${input.expectedRun.id}`);
  if (!Number.isSafeInteger(input.terminalEvent.attempt_no) || input.terminalEvent.attempt_no !== input.attemptNo) throw new Error(`settlement_attempt_conflict:${input.expectedRun.id}`);
  if (input.sourceIdentity.sourceEventId !== undefined && input.terminalEvent.source_event_id !== input.sourceIdentity.sourceEventId) throw new Error(`settlement_source_identity_conflict:${input.expectedRun.id}`);
  if (input.sourceIdentity.sourceSequence !== undefined && input.terminalEvent.source_sequence !== input.sourceIdentity.sourceSequence) throw new Error(`settlement_source_identity_conflict:${input.expectedRun.id}`);
  if (!sameTerminalEvidence(input.terminalEvent.payload.terminal_evidence, input.terminalEvidence)) throw new Error(`terminal_evidence_conflict:${input.expectedRun.id}`);
  if (!settlementEvidenceMatchesStatus(input.terminalEvent.payload.terminal_evidence, nextStatus)) throw new Error(`settlement_evidence_status_conflict:${input.expectedRun.id}`);
  if (!input.output && !input.diagnostic) throw new Error(`settlement_result_required:${input.expectedRun.id}`);
  if (input.output && (input.output.id !== input.outputSourceId || input.output.id !== `message:${input.expectedRun.id}:output`)) throw new Error(`settlement_output_source_conflict:${input.expectedRun.id}`);
  if (input.output && (input.output.session_id !== input.expectedRun.session_id || input.output.role !== "agent")) throw new Error(`settlement_output_scope_conflict:${input.expectedRun.id}`);
  const now = nowIso();
  return this.executeCore02Transaction(async (transaction) => {
    const currentRow = await transaction.selectFrom("backend_runs").selectAll().where("id", "=", input.expectedRun.id).executeTakeFirst();
    if (!currentRow) throw new Error(`settlement_run_not_found:${input.expectedRun.id}`);
    const current = backendRunFromRow(currentRow);
    const safeEvent = normalizeSettlementEvent(input.terminalEvent, current, input.nextRun);
    BackendEventRecordSchema.parse(safeEvent);
    const safeOutput = input.output ? { ...input.output, envelope: input.output.envelope } : undefined;

    const isUnknownCorrection = current.status === "outcome_unknown" && input.nextRun.status !== "outcome_unknown";
    if (isTerminalBackendRunStatus(current.status) && !isUnknownCorrection) {
      await assertCore02SettlementReplay(current, input.nextRun, safeEvent, safeOutput, input.diagnostic, transaction);
      await releaseReservationInTransaction(transaction, current.id, input.reservation.version, now);
      return current;
    }
    const expectedStatus = isUnknownCorrection ? current.status : input.expectedRun.status;
    const expectedPhase = isUnknownCorrection ? current.phase : input.expectedRun.phase;
    const expectedAttempt = isUnknownCorrection ? current.current_attempt : input.expectedRun.current_attempt;
    if (current.status !== expectedStatus || (current.phase ?? null) !== (expectedPhase ?? null) || (current.current_attempt ?? 1) !== (expectedAttempt ?? 1)) {
      throw new Error(`settlement_cas_conflict:${current.id}`);
    }
    if (input.expectedRun.status === "outcome_unknown" && input.nextRun.status === "outcome_unknown") {
      throw new Error(`settlement_conflict:${current.id}`);
    }

    const identityExisting = await findSettlementEvent(transaction, safeEvent);
    // Keep the SQLite row shape (`payload_json` / `resource_refs_json`) at
    // the storage boundary.  The settlement result carries a domain
    // BackendEventRecord, so convert only after reading the row.
    let committedEvent = identityExisting ? backendEventFromRow(identityExisting) : undefined;
    if (identityExisting) {
      if (!sameBackendEvent(identityExisting, safeEvent) && !(identityExisting.id === safeEvent.id && sameBackendEventIgnoringIdentity(identityExisting, safeEvent))) throw new Error(`settlement_event_conflict:${current.id}`);
    } else {
      const max = await transaction.selectFrom("backend_events").select(({ fn }) => fn.max("sequence").as("max_sequence")).where("run_id", "=", current.id).executeTakeFirst();
      committedEvent = { ...safeEvent, sequence: Number(max?.max_sequence ?? 0) + 1 };
      await transaction.insertInto("backend_events").values(backendEventToRow(committedEvent)).execute();
    }

    if (safeOutput) {
      const outputRow = await transaction.selectFrom("messages").selectAll().where("id", "=", safeOutput.id).executeTakeFirst();
      if (outputRow && !sameMessage(outputRow, safeOutput)) throw new Error(`settlement_output_conflict:${current.id}`);
      if (!outputRow) {
        await transaction.insertInto("messages").values({
          id: safeOutput.id,
          session_id: safeOutput.session_id,
          role: safeOutput.role,
          content: safeOutput.content,
          input_locale: safeOutput.input_locale,
          output_locale: safeOutput.output_locale,
          envelope_json: safeOutput.envelope ? stringify(safeOutput.envelope) : null,
          created_at: safeOutput.created_at
        }).execute();
      }
    }

    const settled: BackendRunRecord = {
      ...input.nextRun,
      phase: "settled",
      metadata: {
        ...input.nextRun.metadata,
        ...(input.diagnostic ? {
          settlement_diagnostic_code: input.diagnostic.code,
          settlement_diagnostic_message: input.diagnostic.message,
          ...(input.diagnostic.metadata ?? {})
        } : {})
      },
      ...(safeOutput ? { output_message_id: safeOutput.id, output_summary: safeOutput.content } : {}),
      ...(nextStatus === "outcome_unknown" ? { completed_at: undefined } : { completed_at: input.nextRun.completed_at ?? now })
    };
    let update = transaction.updateTable("backend_runs")
      .set(backendRunToRow(settled))
      .where("id", "=", current.id)
      .where("status", "=", expectedStatus)
    update = expectedPhase === undefined ? update.where("phase", "is", null) : update.where("phase", "=", expectedPhase);
    update = expectedAttempt === undefined ? update.where("current_attempt", "is", null) : update.where("current_attempt", "=", expectedAttempt);
    const updated = await update.executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) !== 1) throw new Error(`settlement_cas_conflict:${current.id}`);
    await releaseReservationInTransaction(transaction, current.id, input.reservation.version, now);
    return settled;
  });
}

async updateBackendRun(run: BackendRunRecord): Promise<BackendRunRecord> {
  await this.db.updateTable("backend_runs").set(backendRunToRow(run)).where("id", "=", run.id).execute();
  return run;
}

async getBackendRun(runId: string): Promise<BackendRunRecord | undefined> {
  const row = await this.db.selectFrom("backend_runs").selectAll().where("id", "=", runId).executeTakeFirst();
  return row ? backendRunFromRow(row) : undefined;
}

async listBackendRuns(sessionId?: string): Promise<BackendRunRecord[]> {
  let query = this.db.selectFrom("backend_runs").selectAll();
  if (sessionId) {
    query = query.where("session_id", "=", sessionId);
  }
  const rows = await query.orderBy("started_at", "desc").execute();
  return rows.map(backendRunFromRow);
}

/** Startup recovery query: only durable non-terminal work with a held lane, plus unknown Runs eligible for later confirmation. */
async listCore02RecoveryCandidates(): Promise<BackendRunRecord[]> {
  const rows = await this.db
    .selectFrom("backend_runs")
    .leftJoin("session_run_reservations", "session_run_reservations.run_id", "backend_runs.id")
    .selectAll("backend_runs")
    .where((expression) => expression.or([
      expression.and([
        expression("backend_runs.status", "in", ["queued", "running", "waiting_for_backend_input"]),
        expression("session_run_reservations.status", "=", "held")
      ]),
      expression("backend_runs.status", "=", "outcome_unknown")
    ]))
    .orderBy("backend_runs.started_at", "asc")
    .execute();
  return rows.map(backendRunFromRow);
}

async listRunHistoryEntries(sessionId?: string): Promise<RunHistoryEntry[]> {
  const [runs, events, changes] = await Promise.all([
    this.listBackendRuns(sessionId),
    this.listBackendEvents(sessionId ? { sessionId } : {}),
    this.listWorkspaceChanges(sessionId)
  ]);
  const eventCounts = countBy(events, (event) => event.run_id);
  const changeCounts = countBy(changes, (change) => change.run_id);
  return runs.map((run) => ({
    id: run.id,
    session_id: run.session_id,
    backend_id: run.backend_id,
    backend_kind: run.backend_kind,
    status: run.status,
    input_summary: run.input_summary,
    output_summary: run.output_summary,
    started_at: run.started_at,
    completed_at: run.completed_at,
    event_count: eventCounts.get(run.id) ?? 0,
    workspace_change_count: changeCounts.get(run.id) ?? 0,
    error_code: run.error_code
  }));
}

async saveBackendEvent(event: BackendEventRecord): Promise<BackendEventRecord> {
  const safeEvent = BackendEventRecordSchema.parse({ ...event, payload: redactPrivateData(event.payload, { redactPii: true }) });
  await this.db.insertInto("backend_events").values(backendEventToRow(safeEvent)).execute();
  return safeEvent;
}

async appendCore02Event(event: BackendEventRecord): Promise<{ event: BackendEventRecord; duplicate: boolean }> {
  if (event.event_type === "run_completed" || event.event_type === "run_failed" || event.payload.terminal_evidence !== undefined) {
    throw new Error("terminal_event_requires_settlement");
  }
  if (!Number.isSafeInteger(event.attempt_no) || (event.source_event_id === undefined && event.source_sequence === undefined)) throw new Error("core02_event_identity_required");
  const safeInput = { ...event, payload: redactPrivateData(event.payload, { redactPii: true }) };
  return this.db.transaction().execute(async (transaction) => {
    if (safeInput.source_event_id) {
      const duplicate = await transaction.selectFrom("backend_events").selectAll().where("run_id", "=", safeInput.run_id).where("attempt_no", "=", safeInput.attempt_no ?? 1).where("source_event_id", "=", safeInput.source_event_id).executeTakeFirst();
      if (duplicate) return { event: backendEventFromRow(duplicate), duplicate: true };
    }
    if (!safeInput.source_event_id && safeInput.source_sequence !== undefined) {
      const duplicate = await transaction.selectFrom("backend_events").selectAll().where("run_id", "=", safeInput.run_id).where("attempt_no", "=", safeInput.attempt_no ?? 1).where("source_event_id", "is", null).where("source_sequence", "=", safeInput.source_sequence).executeTakeFirst();
      if (duplicate) return { event: backendEventFromRow(duplicate), duplicate: true };
    }
    const max = await transaction.selectFrom("backend_events").select(({ fn }) => fn.max("sequence").as("max_sequence")).where("run_id", "=", safeInput.run_id).executeTakeFirst();
    const next = { ...safeInput, sequence: Number(max?.max_sequence ?? 0) + 1 };
    BackendEventRecordSchema.parse(next);
    await transaction.insertInto("backend_events").values(backendEventToRow(next)).execute();
    return { event: next, duplicate: false };
  });
}

/** Host diagnostics share the existing backend journal and never mutate Run state. */
async appendHostDiagnostic(input: {
  runId: string;
  sessionId: string;
  attemptNo: number;
  operationId: string;
  eventType: "host_post_turn_failed" | "host_cleanup_failed" | "host_emit_failed";
  message: string;
  metadata?: Record<string, JsonValue>;
}): Promise<void> {
  await this.appendCore02Event({
    id: `host-diagnostic:${input.runId}:${input.attemptNo}:${input.operationId}`,
    run_id: input.runId,
    session_id: input.sessionId,
    event_type: input.eventType,
    sequence: 1,
    attempt_no: input.attemptNo,
    source_event_id: `host-diagnostic:${input.runId}:${input.attemptNo}:${input.operationId}`,
    payload: {
      reason: "host_operation_failed",
      message: input.message,
      command_name: input.operationId,
      retryable: false,
      cause_category: "host",
      ...(input.metadata ? { usage: input.metadata } : {})
    },
    resource_refs: [],
    created_at: nowIso()
  });
}

async commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }> {
  if (input.event.event_type === "run_completed" || input.event.event_type === "run_failed" || input.event.payload.terminal_evidence !== undefined) {
    throw new Error("terminal_event_requires_settlement");
  }
  if (!Number.isSafeInteger(input.event.attempt_no) || (input.event.source_event_id === undefined && input.event.source_sequence === undefined)) throw new Error("core02_event_identity_required");
  return this.db.transaction().execute(async (transaction) => {
    if (input.event.source_event_id) {
      const duplicate = await transaction.selectFrom("backend_events").selectAll().where("run_id", "=", input.event.run_id).where("attempt_no", "=", input.event.attempt_no ?? 1).where("source_event_id", "=", input.event.source_event_id).executeTakeFirst();
      if (duplicate) {
        const current = await transaction.selectFrom("backend_runs").selectAll().where("id", "=", input.expectedRun.id).executeTakeFirst();
        return { run: current ? backendRunFromRow(current) : input.expectedRun, event: backendEventFromRow(duplicate), duplicate: true };
      }
    }
    if (!input.event.source_event_id && input.event.source_sequence !== undefined) {
      const duplicate = await transaction.selectFrom("backend_events").selectAll().where("run_id", "=", input.event.run_id).where("attempt_no", "=", input.event.attempt_no ?? 1).where("source_event_id", "is", null).where("source_sequence", "=", input.event.source_sequence).executeTakeFirst();
      if (duplicate) {
        const current = await transaction.selectFrom("backend_runs").selectAll().where("id", "=", input.expectedRun.id).executeTakeFirst();
        return { run: current ? backendRunFromRow(current) : input.expectedRun, event: backendEventFromRow(duplicate), duplicate: true };
      }
    }
    const max = await transaction.selectFrom("backend_events").select(({ fn }) => fn.max("sequence").as("max_sequence")).where("run_id", "=", input.event.run_id).executeTakeFirst();
    const event = { ...input.event, sequence: Number(max?.max_sequence ?? 0) + 1 };
    BackendEventRecordSchema.parse(event);
    await transaction.insertInto("backend_events").values(backendEventToRow(event)).execute();
    let update = transaction.updateTable("backend_runs").set(backendRunToRow(input.nextRun)).where("id", "=", input.expectedRun.id).where("status", "=", input.expectedRun.status);
    update = input.expectedRun.phase === undefined ? update.where("phase", "is", null) : update.where("phase", "=", input.expectedRun.phase);
    update = input.expectedRun.current_attempt === undefined ? update.where("current_attempt", "is", null) : update.where("current_attempt", "=", input.expectedRun.current_attempt);
    const updated = await update.executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) !== 1) throw new Error(`run_lifecycle_cas_conflict:${input.expectedRun.id}`);
    return { run: input.nextRun, event, duplicate: false };
  });
}

async listBackendEvents(input: { runId?: string; sessionId?: string; afterSequence?: number; limit?: number } = {}): Promise<BackendEventRecord[]> {
  let query = this.db.selectFrom("backend_events").selectAll();
  if (input.runId) {
    query = query.where("run_id", "=", input.runId);
  }
  if (input.sessionId) {
    query = query.where("session_id", "=", input.sessionId);
  }
  if (input.afterSequence !== undefined) {
    query = query.where("sequence", ">", input.afterSequence);
  }
  if (input.limit !== undefined) {
    query = query.limit(Math.max(1, Math.min(input.limit, 1_000)));
  }
  const rows = await query.orderBy("run_id").orderBy("sequence").execute();
  return rows.map(backendEventFromRow);
}



async saveWorkspaceChange(change: WorkspaceChangeRecord): Promise<WorkspaceChangeRecord> {
  const operation = change.legacy_operation_id ? await this.getOperation(change.legacy_operation_id) : undefined;
  const correlated = !change.correlation_id && operation?.correlation_id
    ? { ...change, correlation_id: operation.correlation_id }
    : change;
  await this.db.insertInto("workspace_changes").values(workspaceChangeToRow(correlated)).execute();
  return correlated;
}

async setWorkspaceChangeCorrelation(changeId: string, correlationId: string): Promise<void> {
  await this.db.updateTable("workspace_changes").set({ correlation_id: correlationId }).where("id", "=", changeId).execute();
}

async listWorkspaceChanges(sessionId?: string): Promise<WorkspaceChangeRecord[]> {
  let query = this.db.selectFrom("workspace_changes").selectAll();
  if (sessionId) {
    query = query.where("session_id", "=", sessionId);
  }
  const rows = await query.orderBy("created_at", "desc").execute();
  return rows.map(workspaceChangeFromRow);
}

async listChangeHistoryEntries(sessionId?: string): Promise<ChangeHistoryEntry[]> {
  return (await this.listWorkspaceChanges(sessionId)).map((change) => ({
    id: change.id,
    session_id: change.session_id,
    run_id: change.run_id,
    change_type: change.change_type,
    resource_ref: change.resource_ref,
    summary: change.summary,
    created_at: change.created_at
  }));
}

  /** Internal narrow port for Learning rollback; callers never write this table directly. */
  async deleteWorkspaceChangesBySummaryLike(summaryPattern: string): Promise<void> {
    await this.db.deleteFrom("workspace_changes").where("summary", "like", summaryPattern).execute();
  }

  /** Retention is initiated by maintenance but executed by the event owner. */
  async removeBackendEvents(eventIds: readonly string[]): Promise<number> {
    if (eventIds.length === 0) return 0;
    const result = await this.db.deleteFrom("backend_events").where("id", "in", [...eventIds]).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }



async saveToolRun(run: ToolRunRecord): Promise<ToolRunRecord> {
  await this.db.insertInto("tool_runs").values(toolRunToRow(run)).execute();
  return run;
}

async listToolRuns(input: { runId?: string; sessionId?: string } = {}): Promise<ToolRunRecord[]> {
  let query = this.db.selectFrom("tool_runs").selectAll();
  if (input.runId) {
    query = query.where("run_id", "=", input.runId);
  }
  if (input.sessionId) {
    query = query.where("session_id", "=", input.sessionId);
  }
  const rows = await query.orderBy("created_at", "desc").execute();
  return rows.map(toolRunFromRow);
}

async getToolRunDiagnostics(input: {
  runId?: string;
  sessionId?: string;
  status?: ToolRunStatus;
  limit?: number;
} = {}): Promise<ToolRunDiagnosticsReport> {
  const limit = normalizeToolRunDiagnosticsLimit(input.limit);
  const scopedToolRuns = (await this.listToolRuns({ runId: input.runId, sessionId: input.sessionId }))
    .filter((run) => input.status === undefined || run.status === input.status)
    .slice(0, limit);
  const actionableToolRuns = scopedToolRuns.filter((run) => run.status === "ignored" || run.status === "failed");
  const groups = groupToolRunDiagnostics(actionableToolRuns);

  return {
    generated_at: nowIso(),
    scope: {
      ...(input.runId ? { run_id: input.runId } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.status ? { status: input.status } : {}),
      limit
    },
    total_tool_runs: scopedToolRuns.length,
    ignored_or_failed_tool_runs: actionableToolRuns.length,
    groups,
    repeated_ignored_provider_tools: groups.filter((group) => group.status === "ignored" && group.count > 1),
    recommendation: groups.length
      ? "Review repeated ignored or failed provider tool calls and normalize them through the Domain Command catalog or adapter mapping."
      : "No ignored or failed provider tool calls were found in the selected scope."
  };
}


}
