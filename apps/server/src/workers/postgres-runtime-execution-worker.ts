import { createHash } from "node:crypto";
import { BackendEventRecordSchema, createId, nowIso, type ResourceRef } from "@samurai-agent/core-schemas";
import {
  createInternalWorkspaceMaintenanceCaller,
  PostgresWorkspaceDatabase,
  WorkspaceServerError,
  type WorkspaceCompletionActivityInput,
  type WorkspaceCompletionService,
  type WorkspaceRecordPayload,
  type WorkspaceRequestContext,
  type WorkspaceSql
} from "@samurai-agent/workspace-server";
import type { WorkspaceExecutionJobWorkerPort } from "./workspace-worker-supervisor";

interface InterruptedRunRow {
  id: string;
  session_id: string | null;
  room_id: string | null;
  status: "queued" | "running";
  phase: "admitted" | "backend_starting" | "external_running";
  current_attempt: number | string | null;
}

interface ActivityRow {
  id: string;
  record: unknown;
}

interface CompletionProjectionRunRow {
  id: string;
  room_id: string;
  session_ref: unknown;
  backend_id: string;
  requested_by_participant_id: string | null;
  status: string;
  input_summary: string;
  input_content: string | null;
  output_summary: string | null;
  output_message_id: string | null;
  error_code: string | null;
  changed_resources: unknown;
}

/**
 * Recovers Runtime work that was admitted by the HTTP process and left
 * unfinished by a process crash. It never starts a second backend process:
 * an unstarted run becomes failed. A run that has reached an external backend
 * is deliberately excluded from automatic recovery: a provider can be quiet
 * for longer than the stale interval while still running. It needs an
 * explicit recovery decision instead of a worker guessing from started_at.
 */
export class PostgresRuntimeExecutionWorker implements WorkspaceExecutionJobWorkerPort {
  constructor(
    private readonly database: PostgresWorkspaceDatabase,
    private readonly staleAfterMs = 60_000,
    /** Optional so legacy recovery-only compositions remain valid. The
     * standard Server injects the same Completion facade used by HTTP. */
    private readonly completion?: WorkspaceCompletionService
  ) {}

  async runTick(context: WorkspaceRequestContext, input: { workerId: string; maxRuns: number; signal: AbortSignal }): Promise<{ recovered: number }> {
    if (input.signal.aborted) return { recovered: 0 };
    const result = await this.database.withContext(context, async (sql) => {
      const runs = await sql.query<InterruptedRunRow>(
        `SELECT id, session_id, room_id, status, phase, current_attempt
         FROM workspace_runtime_runs
         WHERE workspace_id = $1
           AND (
             (status = 'queued' AND phase = 'admitted' AND started_at < NOW() - ($2 * INTERVAL '1 millisecond'))
             OR (status = 'running' AND phase = 'backend_starting' AND started_at < NOW() - ($2 * INTERVAL '1 millisecond'))
           )
         ORDER BY started_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $3`,
        [context.workspaceId, this.staleAfterMs, Math.max(1, Math.min(input.maxRuns, 100))]
      );
      let recovered = 0;
      for (const run of runs.rows) {
        if (input.signal.aborted) break;
        const outcomeUnknown = run.status === "running";
        const now = nowIso();
        const eventId = createId("event");
        const eventSequence = await nextSequence(sql, context.workspaceId, run.id);
        const attemptNo = Number(run.current_attempt ?? 1) > 0 ? Number(run.current_attempt) : 1;
        const errorCode = outcomeUnknown ? "runtime_recovery_outcome_unknown" : "runtime_recovery_admission_interrupted";
        const message = outcomeUnknown
          ? "The process stopped while an external backend may have been running."
          : "The process stopped before the backend was started.";
        const terminalEvidence = outcomeUnknown
          ? { kind: "indeterminate" as const, reason: "runtime_state_unavailable" as const, providerStarted: true, mayHaveSideEffects: true }
          : {
              kind: "failed" as const,
              source: "process_exit" as const,
              error: { code: errorCode, message, retryable: true, causeCategory: "runtime" as const }
            };
        const event = BackendEventRecordSchema.parse({
          id: eventId,
          run_id: run.id,
          ...(run.session_id ? { session_id: run.session_id } : {}),
          event_type: "run_failed",
          sequence: eventSequence,
          attempt_no: attemptNo,
          payload: {
            error_code: errorCode,
            message,
            retryable: true,
            cause_category: "runtime",
            terminal_evidence: terminalEvidence
          },
          resource_refs: [],
          created_at: now
        });
        await sql.query(
          `INSERT INTO workspace_runtime_events(
             workspace_id, id, run_id, session_id, event_type, sequence, attempt_no,
             payload, resource_refs, created_at
           ) VALUES ($1, $2, $3, $4, 'run_failed', $5, $6, $7::JSONB, '[]'::JSONB, $8)`,
          [
            context.workspaceId,
            eventId,
            run.id,
            run.session_id,
            eventSequence,
            attemptNo,
            JSON.stringify(event.payload),
            now
          ]
        );
        const updated = await sql.query(
          `UPDATE workspace_runtime_runs
           SET status = $3, phase = 'settled', error_code = $4, completed_at = $5
           WHERE workspace_id = $1 AND id = $2 AND status = $6 AND phase = $7`,
          [
            context.workspaceId,
            run.id,
            outcomeUnknown ? "outcome_unknown" : "failed",
            outcomeUnknown ? "runtime_recovery_outcome_unknown" : "runtime_recovery_admission_interrupted",
            outcomeUnknown ? null : now,
            run.status,
            run.phase
          ]
        );
        if (Number(updated.rowCount ?? 0) !== 1) continue;
        await sql.query(
          `UPDATE workspace_runtime_reservations
           SET status = 'released', version = version + 1, updated_at = $3
           WHERE workspace_id = $1 AND run_id = $2 AND status = 'held'`,
          [context.workspaceId, run.id, now]
        );
        if (run.room_id) await settleActivity(sql, context.workspaceId, run.id, run.room_id, outcomeUnknown, now);
        recovered += 1;
      }
      return { recovered };
    });
    if (input.signal.aborted || !this.completion) return result;
    await this.projectSettledRuns(context, input);
    return result;
  }

  /**
   * Completion is a derived evidence projection. Runtime remains the source
   * of truth, so a process crash or a transient projection error must leave
   * the settled Run durable and let the supervisor retry this lane later.
   */
  private async projectSettledRuns(
    context: WorkspaceRequestContext,
    input: { workerId: string; maxRuns: number; signal: AbortSignal }
  ): Promise<void> {
    if (!this.completion || input.signal.aborted) return;
    const limit = Math.max(1, Math.min(Math.trunc(input.maxRuns), 100));
    const candidates = await this.database.withContext(context, async (sql) => {
      const result = await sql.query<CompletionProjectionRunRow>(
        `SELECT run.id, run.room_id, run.session_ref, run.backend_id,
                run.requested_by_participant_id, run.status,
                run.input_summary, input_message.content AS input_content,
                run.output_summary, run.output_message_id, run.error_code,
                changes.changed_resources
         FROM workspace_runtime_runs run
         LEFT JOIN workspace_runtime_messages input_message
           ON input_message.workspace_id = run.workspace_id
          AND input_message.id = run.input_message_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(jsonb_agg(change.resource_ref ORDER BY change.created_at, change.id), '[]'::JSONB) AS changed_resources
           FROM workspace_runtime_changes change
           WHERE change.workspace_id = run.workspace_id AND change.run_id = run.id
         ) changes ON TRUE
         WHERE run.workspace_id = $1
           AND run.room_id IS NOT NULL
           AND run.phase = 'settled'
           AND run.status IN ('completed', 'failed', 'cancelled', 'outcome_unknown')
           AND samurai_can_room(run.workspace_id, run.room_id, 'execute')
         ORDER BY
           CASE WHEN EXISTS (
             SELECT 1
             FROM workspace_completion_activities activity
             WHERE activity.workspace_id = run.workspace_id
               AND activity.source_app = 'samurai-workspace-chat'
               AND activity.source_id = run.id
           ) THEN 1 ELSE 0 END,
           COALESCE(run.completed_at, run.started_at), run.id
         LIMIT $2`,
        [context.workspaceId, limit]
      );
      return result.rows;
    });

    // Keep the bound in code as well as in SQL. It protects the worker from a
    // mocked/changed adapter returning more rows than the database LIMIT.
    for (const run of candidates.slice(0, limit)) {
      if (input.signal.aborted) return;
      await this.projectSettledRun(context, input, run);
    }
  }

  private async projectSettledRun(
    context: WorkspaceRequestContext,
    input: { workerId: string; maxRuns: number; signal: AbortSignal },
    run: CompletionProjectionRunRow
  ): Promise<void> {
    if (!this.completion || input.signal.aborted) return;
    const activityId = completionActivityId(context.workspaceId, run.id);
    const projectionContext = completionProjectionContext(context, input.workerId, run.id);

    // Completion owns the atomic source/activity identity, content, and
    // principal validation. Always submit the projection, including retries
    // for an existing deterministic Activity, so identical replays succeed
    // while conflicts fail closed.
    if (!run.requested_by_participant_id) {
      throw new WorkspaceServerError("workspace_completion_runtime_principal_missing", 503, { run_id: run.id });
    }
    await this.completion.ingestRuntimeCompletionActivity(
      projectionContext,
      completionActivityInput(run, activityId),
      { runId: run.id, principalAccountId: run.requested_by_participant_id }
    );
  }
}

function completionActivityId(workspaceId: string, runId: string): string {
  return `completion_activity_${createHash("sha256").update(`${workspaceId}|${runId}`).digest("hex").slice(0, 48)}`;
}

function completionProjectionContext(
  context: WorkspaceRequestContext,
  workerId: string,
  runId: string
): WorkspaceRequestContext {
  const operationId = `runtime_completion_projection_${createHash("sha256")
    .update(`${context.operationId}|${workerId}|${runId}`)
    .digest("hex")
    .slice(0, 40)}`;
  return {
    ...context,
    operationId,
    caller: createInternalWorkspaceMaintenanceCaller({
      principalAccountId: context.accountId,
      operationId
    })
  };
}

function completionActivityInput(run: CompletionProjectionRunRow, activityId: string): WorkspaceCompletionActivityInput {
  const outcome = run.status === "completed"
    ? "completed"
    : run.status === "cancelled"
      ? "cancelled"
      : run.status === "outcome_unknown"
        ? "unknown"
        : "failed";
  const resourceRefs = uniqueResourceRefs([
    ...(run.output_message_id ? [messageResourceRef(run.output_message_id)] : []),
    ...resourceReferences(run.changed_resources)
  ]);
  const changedResources = uniqueStrings(resourceRefs.map((ref) => ref.id));
  const payload: WorkspaceRecordPayload = {
    backend_id: run.backend_id,
    runtime_run_id: run.id,
    runtime_status: run.status,
    ...(resourceRefs.length > 0 ? { resource_refs: resourceRefs } : {}),
    ...(run.error_code ? { error_code: run.error_code } : {})
  };
  const sessionRef = completionSessionRef(run.session_ref);
  return {
    id: activityId,
    roomId: run.room_id,
    sourceApp: "samurai-workspace-chat",
    sourceId: run.id,
    externalEpisodeKey: run.id,
    operationId: `operation:${run.id}`,
    instructionSummary: run.input_content?.trim() || run.input_summary.trim() || "Chat turn",
    ...(run.output_summary?.trim() ? { resultSummary: run.output_summary.trim() } : {}),
    changedResources,
    verificationOutcome: outcome === "completed" ? "not_run" : outcome === "unknown" ? "unknown" : "failed",
    failureState: outcome === "completed" ? "none" : "unresolved",
    outcome,
    payload,
    ...(sessionRef ? { sessionRef } : {})
  };
}

function messageResourceRef(messageId: string): ResourceRef {
  return { kind: "message", id: messageId, uri: `runtime://messages/${messageId}` };
}

function resourceReferences(value: unknown): ResourceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isResourceRef);
}

function isResourceRef(value: unknown): value is ResourceRef {
  return isRecord(value)
    && typeof value.kind === "string"
    && value.kind.trim().length > 0
    && typeof value.id === "string"
    && value.id.trim().length > 0
    && typeof value.uri === "string"
    && value.uri.trim().length > 0
    && (value.version === undefined || typeof value.version === "string")
    && (value.label === undefined || typeof value.label === "string");
}

function completionSessionRef(value: unknown): WorkspaceCompletionActivityInput["sessionRef"] {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return undefined;
  const appId = typeof parsed.app_id === "string" ? parsed.app_id : typeof parsed.appId === "string" ? parsed.appId : undefined;
  if (!appId) return undefined;
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
  return { appId, ...(sessionId ? { sessionId } : {}) };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function uniqueResourceRefs(refs: readonly ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}:${ref.version ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function nextSequence(sql: WorkspaceSql, workspaceId: string, runId: string): Promise<number> {
  const result = await sql.query<{ max_sequence: number | string | null }>(
    "SELECT MAX(sequence) AS max_sequence FROM workspace_runtime_events WHERE workspace_id = $1 AND run_id = $2",
    [workspaceId, runId]
  );
  return Number(result.rows[0]?.max_sequence ?? 0) + 1;
}

async function settleActivity(sql: WorkspaceSql, workspaceId: string, runId: string, roomId: string, outcomeUnknown: boolean, now: string): Promise<void> {
  const result = await sql.query<ActivityRow>(
    `SELECT id, record FROM workspace_runtime_activities
     WHERE workspace_id = $1 AND backend_run_id = $2 AND room_id = $3
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [workspaceId, runId, roomId]
  );
  const activity = result.rows[0];
  if (!activity) return;
  const record = typeof activity.record === "string" ? JSON.parse(activity.record) as Record<string, unknown> : activity.record as Record<string, unknown>;
  const status = outcomeUnknown ? "outcome_unknown" : "failed";
  await sql.query(
    `UPDATE workspace_runtime_activities
     SET status = $4, record = $5::JSONB, updated_at = $6
     WHERE workspace_id = $1 AND id = $2 AND room_id = $3`,
    [workspaceId, activity.id, roomId, status, JSON.stringify({
      ...record,
      status,
      updated_at: now,
      finalized_at: now,
      failure: {
        code: outcomeUnknown ? "runtime_recovery_outcome_unknown" : "runtime_recovery_admission_interrupted",
        summary: outcomeUnknown
          ? "External execution state is unknown after process recovery."
          : "Runtime admission was interrupted before backend start."
      }
    }), now]
  );
}
