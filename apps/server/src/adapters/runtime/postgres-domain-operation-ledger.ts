import { createHash } from "node:crypto";
import { canonicalJson, assertOpaqueId, WorkspaceServerError, type WorkspaceSql } from "@samurai-agent/workspace-server";

export interface PostgresOperationLedgerDatabase {
  withContext<T>(
    context: { workspaceId: string; accountId: string },
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<T>;
}

export interface PostgresOperationLedgerResult<T> {
  value: T;
  replayed: boolean;
}

/**
 * Retry admission for PostgreSQL Domain Operations.
 *
 * The operation row is committed before the business action starts. This is
 * intentional: a second request cannot enter the same action while the first
 * request is still running, and a process crash leaves an explicit
 * `in_progress` outcome instead of guessing whether the action was applied.
 * The business action owns its own RLS-scoped transaction and therefore can
 * continue to use the existing Runtime/Adapter boundaries.
 */
export class PostgresDomainOperationLedger {
  constructor(
    private readonly database: PostgresOperationLedgerDatabase,
    private readonly workspaceId: string,
    private readonly accountId: string
  ) {}

  async run<T>(input: {
    operationId: string;
    actorId?: string;
    idempotencyKey?: string;
    request: unknown;
    execute: () => Promise<T>;
  }): Promise<PostgresOperationLedgerResult<T>> {
    assertOpaqueId(this.workspaceId, "workspace_id_invalid");
    assertOpaqueId(this.accountId, "account_id_invalid");
    assertOpaqueId(input.operationId, "operation_id_invalid");
    if (input.actorId !== undefined && input.actorId !== this.accountId) {
      throw new WorkspaceServerError("workspace_operation_actor_mismatch", 403);
    }
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey) throw new WorkspaceServerError("workspace_operation_id_required", 400);
    assertOpaqueId(idempotencyKey, "idempotency_key_invalid");

    const requestHash = sha256(canonicalJson({ operation_id: input.operationId, input: input.request ?? null }));
    // The schema intentionally has a Workspace-wide unique idempotency key.
    // Scope the stored key to the authenticated Account so PostgreSQL RLS
    // cannot hide another Account's conflicting row and make a retry appear
    // new to this transaction.
    const operationKey = `account_${sha256(`${this.accountId}|${idempotencyKey}`).slice(0, 40)}`;
    const existing = await this.database.withContext({ workspaceId: this.workspaceId, accountId: this.accountId }, async (sql) => {
      const inserted = await sql.query<{ id: string }>(
        `INSERT INTO workspace_operations(workspace_id, id, idempotency_key, actor_account_id, request_hash, status)
         VALUES ($1, $2, $2, $3, $4, 'running')
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [this.workspaceId, operationKey, this.accountId, requestHash]
      );
      if (inserted.rows[0]) return undefined;
      const result = await sql.query<{ request_hash: string; status: string; result: unknown }>(
        `SELECT request_hash, status, result
           FROM workspace_operations
          WHERE workspace_id = $1 AND idempotency_key = $2`,
        [this.workspaceId, operationKey]
      );
      return result.rows[0];
    });

    if (existing) {
      if (existing.request_hash !== requestHash) throw new WorkspaceServerError("workspace_operation_id_reused", 409);
      if (existing.status === "failed") throw new WorkspaceServerError("workspace_operation_previously_failed", 409);
      if (existing.status !== "completed" || existing.result === null) {
        throw new WorkspaceServerError("workspace_operation_in_progress", 409);
      }
      return { value: existing.result as T, replayed: true };
    }

    let value: T;
    try {
      value = await input.execute();
    } catch (error) {
      await this.database.withContext({ workspaceId: this.workspaceId, accountId: this.accountId }, async (sql) => {
        await sql.query(
          `UPDATE workspace_operations
              SET status = 'failed', error_code = $3, updated_at = NOW()
            WHERE workspace_id = $1 AND idempotency_key = $2 AND status = 'running'`,
          [this.workspaceId, operationKey, operationErrorCode(error)]
        );
      }).catch(() => undefined);
      throw error;
    }

    await this.database.withContext({ workspaceId: this.workspaceId, accountId: this.accountId }, async (sql) => {
      await sql.query(
        `UPDATE workspace_operations
            SET status = 'completed', result = $3::JSONB, updated_at = NOW()
          WHERE workspace_id = $1 AND idempotency_key = $2 AND status = 'running'`,
        [this.workspaceId, operationKey, canonicalJson(value === undefined ? {} : value)]
      );
    });
    return { value, replayed: false };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function operationErrorCode(error: unknown): string {
  const code = error instanceof WorkspaceServerError
    ? error.code
    : error instanceof Error
      ? error.message.split("\n", 1)[0] ?? "workspace_operation_failed"
      : "workspace_operation_failed";
  return code.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 160) || "workspace_operation_failed";
}
