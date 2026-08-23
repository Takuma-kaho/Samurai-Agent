import { BackendEventRecordSchema, createId, nowIso } from "@samurai-agent/core-schemas";
import { PostgresWorkspaceDatabase, type WorkspaceRequestContext, type WorkspaceSql } from "@samurai-agent/workspace-server";
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
    private readonly staleAfterMs = 60_000
  ) {}

  async runTick(context: WorkspaceRequestContext, input: { workerId: string; maxRuns: number; signal: AbortSignal }): Promise<{ recovered: number }> {
    if (input.signal.aborted) return { recovered: 0 };
    return this.database.withContext(context, async (sql) => {
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
            now,
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
  }
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
