import {
  ClientEventRecordSchema,
  nowIso,
  stableHash,
  type ClientEventRecord
} from "@samurai-agent/core-schemas";
import {
  PostgresWorkspaceDatabase,
  WorkspaceServerError,
  canonicalJson,
  type WorkspaceRequestContext,
  type WorkspaceServerStore
} from "@samurai-agent/workspace-server";

export interface PostgresRuntimeClientEventListInput {
  targetClientKind?: ClientEventRecord["target_client_kind"];
  targetClientId?: string;
  status?: ClientEventRecord["status"];
  limit?: number;
}

interface ClientEventRow {
  workspace_id: string;
  id: string;
  room_id: string | null;
  target_client_kind: string;
  target_client_id: string | null;
  event_type: string;
  status: string;
  payload: unknown;
  resource_refs: unknown;
  /** node-postgres returns PostgreSQL TIMESTAMPTZ columns as Date by default. */
  created_at: Date | string;
  delivered_at: Date | string | null;
  acked_at: Date | string | null;
  expires_at: Date | string | null;
  error_code: string | null;
}

/**
 * PostgreSQL-backed Client Event queue.
 *
 * Client Events are OS/UI delivery requests, not a second Chat store. Their
 * durable state is kept in the Runtime schema, while save and state changes
 * use the Workspace operation ledger so a Desktop retry cannot deliver or
 * acknowledge the same event twice.
 */
export class PostgresRuntimeClientEvents {
  constructor(
    private readonly database: PostgresWorkspaceDatabase,
    private readonly store: WorkspaceServerStore
  ) {}

  async list(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: PostgresRuntimeClientEventListInput = {}
  ): Promise<ClientEventRecord[]> {
    const limit = boundedLimit(input.limit);
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<ClientEventRow>(
        `SELECT workspace_id, id, room_id, target_client_kind, target_client_id, event_type, status,
                payload, resource_refs, created_at, delivered_at, acked_at, expires_at, error_code
         FROM workspace_runtime_client_events
         WHERE workspace_id = $1
           AND ($2::TEXT IS NULL OR target_client_kind = $2)
           AND ($3::TEXT IS NULL OR target_client_id = $3)
           AND ($4::TEXT IS NULL OR status = $4)
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at, id
         LIMIT $5`,
        [context.workspaceId, input.targetClientKind ?? null, input.targetClientId ?? null, input.status ?? null, limit]
      );
      return result.rows.map(clientEventFromRow);
    });
  }

  async save(context: WorkspaceRequestContext, event: ClientEventRecord): Promise<{ event: ClientEventRecord; replayed: boolean }> {
    const normalized = ClientEventRecordSchema.parse(event);
    const result = await this.store.runIdempotentResult(
      context,
      { action: "client.event.save", input: normalized },
      async (sql) => {
        const existing = await sql.query<ClientEventRow>(
          `SELECT workspace_id, id, room_id, target_client_kind, target_client_id, event_type, status,
                  payload, resource_refs, created_at, delivered_at, acked_at, expires_at, error_code
           FROM workspace_runtime_client_events
           WHERE workspace_id = $1 AND id = $2
           FOR UPDATE`,
          [context.workspaceId, normalized.id]
        );
        if (existing.rows[0]) {
          const saved = clientEventFromRow(existing.rows[0]);
          if (canonicalJson(saved) !== canonicalJson(normalized)) {
            throw new WorkspaceServerError("client_event_id_conflict", 409);
          }
          return saved;
        }
        const inserted = await sql.query<ClientEventRow>(
          `INSERT INTO workspace_runtime_client_events(
             workspace_id, id, room_id, target_client_kind, target_client_id, event_type, status,
             payload, resource_refs, created_at, delivered_at, acked_at, expires_at, error_code
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9::JSONB, $10, $11, $12, $13, $14)
           RETURNING workspace_id, id, room_id, target_client_kind, target_client_id, event_type, status,
                     payload, resource_refs, created_at, delivered_at, acked_at, expires_at, error_code`,
          [
            context.workspaceId,
            normalized.id,
            normalized.room_id ?? null,
            normalized.target_client_kind,
            normalized.target_client_id ?? null,
            normalized.event_type,
            normalized.status,
            canonicalJson(normalized.payload),
            canonicalJson(normalized.resource_refs),
            normalized.created_at,
            normalized.delivered_at ?? null,
            normalized.acked_at ?? null,
            normalized.expires_at ?? null,
            normalized.error_code ?? null
          ]
        );
        const row = inserted.rows[0];
        if (!row) throw new WorkspaceServerError("client_event_save_failed", 500);
        const saved = clientEventFromRow(row);
        await this.store.insertAudit(sql, context, {
          action: "client.event.save",
          subjectKind: "client_event",
          subjectId: saved.id,
          details: { target_client_kind: saved.target_client_kind, event_type: saved.event_type }
        });
        return saved;
      }
    );
    return { event: result.value, replayed: result.replayed };
  }

  async deliver(context: WorkspaceRequestContext, eventId: string): Promise<{ event: ClientEventRecord; replayed: boolean }> {
    return this.transition(context, "deliver", eventId);
  }

  async acknowledge(context: WorkspaceRequestContext, eventId: string): Promise<{ event: ClientEventRecord; replayed: boolean }> {
    return this.transition(context, "ack", eventId);
  }

  async fail(context: WorkspaceRequestContext, eventId: string, errorCode: string): Promise<{ event: ClientEventRecord; replayed: boolean }> {
    const normalizedErrorCode = errorCode.trim().slice(0, 160) || "client_event_failed";
    return this.transition(context, "fail", eventId, normalizedErrorCode);
  }

  async expire(context: WorkspaceRequestContext, now = nowIso()): Promise<{ events: ClientEventRecord[]; replayed: boolean }> {
    const normalizedNow = new Date(now);
    if (!Number.isFinite(normalizedNow.getTime())) throw new WorkspaceServerError("client_event_expiry_time_invalid", 400);
    const result = await this.store.runIdempotentResult(
      context,
      { action: "client.event.expire", input: { now: normalizedNow.toISOString() } },
      async (sql) => {
        const expired = await sql.query<ClientEventRow>(
          `UPDATE workspace_runtime_client_events
           SET status = 'expired', error_code = NULL
           WHERE workspace_id = $1 AND status IN ('pending', 'delivered')
             AND expires_at IS NOT NULL AND expires_at <= $2
           RETURNING workspace_id, id, room_id, target_client_kind, target_client_id, event_type, status,
                     payload, resource_refs, created_at, delivered_at, acked_at, expires_at, error_code`,
          [context.workspaceId, normalizedNow.toISOString()]
        );
        if (expired.rows.length > 0) {
          await this.store.insertAudit(sql, context, {
            action: "client.event.expire",
            details: { count: expired.rows.length }
          });
        }
        return expired.rows.map(clientEventFromRow);
      }
    );
    return { events: result.value, replayed: result.replayed };
  }

  /** Build the same notification shape used by the legacy Runtime event hook. */
  static notificationForRun(run: {
    id: string;
    status: string;
    room_id?: string;
    backend_id: string;
    session_id?: string;
    completed_at?: string;
    started_at: string;
    output_summary?: string;
    error_code?: string;
  }): ClientEventRecord | undefined {
    if (![
      "completed",
      "failed",
      "cancelled",
      "waiting_for_backend_input",
      "outcome_unknown"
    ].includes(run.status)) return undefined;
    const statusLabel = run.status === "completed"
      ? "完了"
      : run.status === "failed"
        ? "失敗"
        : run.status === "cancelled"
          ? "取消"
          : run.status === "outcome_unknown"
            ? "結果未確認"
            : "確認待ち";
    const createdAt = run.completed_at ?? run.started_at;
    const id = `client_event_${stableHash({ kind: "backend_run_status_notification", run_id: run.id, status: run.status }).slice(0, 24)}`;
    return ClientEventRecordSchema.parse({
      id,
      ...(run.room_id ? { room_id: run.room_id } : {}),
      target_client_kind: "desktop",
      event_type: "client.notification.requested",
      status: "pending",
      payload: {
        title: `Runが${statusLabel}しました`,
        body: run.output_summary ?? run.error_code ?? `Backend ${run.backend_id} の処理結果を確認してください。`,
        deep_link: `samurai://run/${encodeURIComponent(run.id)}`,
        run_id: run.id,
        ...(run.session_id ? { session_id: run.session_id } : {}),
        backend_id: run.backend_id,
        backend_status: run.status
      },
      resource_refs: [{ kind: "backend_run", id: run.id, uri: `runs/${run.id}`, label: run.id }],
      created_at: createdAt
    });
  }

  private async transition(
    context: WorkspaceRequestContext,
    action: "deliver" | "ack" | "fail",
    eventId: string,
    errorCode?: string
  ): Promise<{ event: ClientEventRecord; replayed: boolean }> {
    const normalizedId = eventId.trim();
    if (!normalizedId) throw new WorkspaceServerError("client_event_id_required", 400);
    const result = await this.store.runIdempotentResult(
      context,
      { action: `client.event.${action}`, input: { eventId: normalizedId, errorCode: errorCode ?? null } },
      async (sql) => {
        const currentResult = await sql.query<ClientEventRow>(
          `SELECT workspace_id, id, room_id, target_client_kind, target_client_id, event_type, status,
                  payload, resource_refs, created_at, delivered_at, acked_at, expires_at, error_code
           FROM workspace_runtime_client_events
           WHERE workspace_id = $1 AND id = $2
           FOR UPDATE`,
          [context.workspaceId, normalizedId]
        );
        const current = currentResult.rows[0];
        if (!current) throw new WorkspaceServerError("client_event_not_found", 404);
        const nextStatus = action === "deliver" ? "delivered" : action === "ack" ? "acked" : "failed";
        const canTransition = action === "deliver"
          ? current.status === "pending"
          : action === "ack"
            ? current.status === "pending" || current.status === "delivered"
            : current.status === "pending" || current.status === "delivered";
        if (canTransition) {
          const now = nowIso();
          await sql.query(
            `UPDATE workspace_runtime_client_events
             SET status = $3, delivered_at = CASE WHEN $3 IN ('delivered', 'acked', 'failed') THEN $4 ELSE delivered_at END,
                 acked_at = CASE WHEN $3 = 'acked' THEN $4 ELSE acked_at END,
                 error_code = CASE WHEN $3 = 'failed' THEN $5 ELSE NULL END
             WHERE workspace_id = $1 AND id = $2`,
            [context.workspaceId, normalizedId, nextStatus, now, errorCode ?? null]
          );
        }
        const savedResult = await sql.query<ClientEventRow>(
          `SELECT workspace_id, id, room_id, target_client_kind, target_client_id, event_type, status,
                  payload, resource_refs, created_at, delivered_at, acked_at, expires_at, error_code
           FROM workspace_runtime_client_events WHERE workspace_id = $1 AND id = $2`,
          [context.workspaceId, normalizedId]
        );
        const saved = savedResult.rows[0];
        if (!saved) throw new WorkspaceServerError("client_event_not_found", 404);
        await this.store.insertAudit(sql, context, {
          action: `client.event.${action}`,
          subjectKind: "client_event",
          subjectId: normalizedId,
          details: { status: saved.status, ...(errorCode ? { error_code: errorCode } : {}) }
        });
        return clientEventFromRow(saved);
      }
    );
    return { event: result.value, replayed: result.replayed };
  }
}

function clientEventFromRow(row: ClientEventRow): ClientEventRecord {
  return ClientEventRecordSchema.parse({
    id: row.id,
    ...(row.room_id ? { room_id: row.room_id } : {}),
    target_client_kind: row.target_client_kind,
    ...(row.target_client_id ? { target_client_id: row.target_client_id } : {}),
    event_type: row.event_type,
    status: row.status,
    payload: jsonRecord(row.payload),
    resource_refs: jsonArray(row.resource_refs),
    created_at: clientEventTimestamp(row.created_at),
    ...(row.delivered_at ? { delivered_at: clientEventTimestamp(row.delivered_at) } : {}),
    ...(row.acked_at ? { acked_at: clientEventTimestamp(row.acked_at) } : {}),
    ...(row.expires_at ? { expires_at: clientEventTimestamp(row.expires_at) } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {})
  });
}

/** Normalize both node-postgres Date values and compatibility string rows. */
function clientEventTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new WorkspaceServerError("client_event_timestamp_invalid", 500);
  return timestamp.toISOString();
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("client_event_payload_invalid", 500);
  return parsed as Record<string, unknown>;
}

function jsonArray(value: unknown): unknown[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new WorkspaceServerError("client_event_resource_refs_invalid", 500);
  return parsed;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new WorkspaceServerError("client_event_limit_invalid", 400);
  return value;
}
