import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { RuntimeExecutionResourceCandidate } from "@samurai-agent/runtime";
import {
  createInternalWorkspaceMaintenanceCaller,
  type PostgresWorkspaceDatabase,
  type WorkspaceCompletionResource,
  type WorkspaceCompletionResourceVersion,
  type WorkspaceCompletionService,
  type WorkspaceDatabaseContext,
  type WorkspaceRequestContext,
  type WorkspaceServerCommandService,
  type WorkspaceServerConfig,
  type WorkspaceSql,
  WorkspaceContextQueryService,
  type WorkspaceContextQueryDatabase,
  buildWorkspaceNotificationOutbox,
  WorkspaceNotificationService,
  type WorkspaceNotificationAuthorizationResolver,
  type WorkspaceNotificationOutbox,
  type WorkspaceNotificationOutboxInput,
  type WorkspaceNotificationProjectionTransaction,
  type WorkspaceNotificationRecord,
  type WorkspaceNotificationResolution,
  type WorkspaceNotificationStore
} from "@samurai-agent/workspace-server";

type DatabaseWithContext = Pick<PostgresWorkspaceDatabase, "withContext">;
type DatabaseWithReadSnapshot = Pick<PostgresWorkspaceDatabase, "withReadSnapshot">;
type AccountWorkspaceContext = Pick<WorkspaceRequestContext, "workspaceId" | "accountId">;

export interface WorkspaceNotificationWorkerContext extends AccountWorkspaceContext {}

export interface PostgresWorkspaceNotificationStoreOptions {
  /** The configured maintenance identities are the only Server-owned writer
   * context allowed to project the private outbox. */
  resolveWorkerContexts?: () => Promise<readonly WorkspaceNotificationWorkerContext[]>;
  onProjected?: (outbox: WorkspaceNotificationOutbox) => Promise<void> | void;
}

export interface PostgresWorkspaceNotificationServiceOptions extends PostgresWorkspaceNotificationStoreOptions {
  clock?: () => Date;
}

/**
 * The Context Query Core already owns validation, authorization ordering, and
 * cursor integrity. This adapter only binds its read snapshot to PostgreSQL's
 * RLS transaction; it never performs an unscoped candidate query.
 */
export function createPostgresWorkspaceContextQueryDatabase(
  database: DatabaseWithReadSnapshot
): WorkspaceContextQueryDatabase {
  return {
    withReadSnapshot: (context, action) => database.withReadSnapshot(context, action)
  };
}

export function canonicalWorkspaceServerOrigin(config: Pick<WorkspaceServerConfig, "publicBaseUrl" | "bindAddress" | "port">): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const host = config.bindAddress === "::1" ? "[::1]" : config.bindAddress;
  return `http://${host}:${config.port}`;
}

/** Reuses the existing server secret while separating this cursor purpose. */
export function workspaceContextCursorSecret(serverSecret: string): Uint8Array {
  return createHash("sha256")
    .update("samurai.workspace-context.cursor\0", "utf8")
    .update(serverSecret, "utf8")
    .digest();
}

export function createPostgresWorkspaceContextQueryService(
  database: DatabaseWithReadSnapshot,
  config: Pick<WorkspaceServerConfig, "publicBaseUrl" | "bindAddress" | "port" | "invitationTokenSecret">
): WorkspaceContextQueryService {
  return new WorkspaceContextQueryService({
    database: createPostgresWorkspaceContextQueryDatabase(database),
    origin: canonicalWorkspaceServerOrigin(config),
    cursorSecret: workspaceContextCursorSecret(config.invitationTokenSecret)
  });
}

interface NotificationRow extends QueryResultRow {
  id: string;
  recipient_account_id: string;
  workspace_id: string | null;
  room_id: string | null;
  kind: string;
  source_kind: string;
  source_id: string;
  source_revision: number | string;
  created_at: Date | string;
  read_at: Date | string | null;
}

interface OutboxRow extends QueryResultRow {
  id: string;
  workspace_id: string | null;
  room_id: string | null;
  source_kind: string;
  source_id: string;
  source_revision: number | string;
  kind: string;
  action: "create" | "invalidate";
  recipient_account_ids: unknown;
  created_at: Date | string;
  processed_at: Date | string | null;
  attempts: number | string;
  next_attempt_at: Date | string;
  last_error_code: string | null;
}

/**
 * PostgreSQL implementation of the Notification Core storage seam. User
 * reads run under the authenticated Account/Workspace RLS context. Projection
 * reads and writes run only through configured maintenance identities.
 */
export class PostgresWorkspaceNotificationStore implements WorkspaceNotificationStore {
  constructor(
    private readonly database: DatabaseWithContext,
    private readonly options: PostgresWorkspaceNotificationStoreOptions = {}
  ) {}

  async listPendingOutboxes(input: { now: string; limit: number }): Promise<readonly WorkspaceNotificationOutbox[]> {
    const contexts = await this.workerContexts();
    const rows: WorkspaceNotificationOutbox[] = [];
    for (const context of contexts) {
      const values = await this.withMaintenanceContext(context, "list", async (sql) => {
        const result = await sql.query<OutboxRow>(
          `SELECT id, workspace_id, room_id, source_kind, source_id, source_revision,
                  kind, action, recipient_account_ids, created_at, processed_at,
                  attempts, next_attempt_at, last_error_code
             FROM account_notification_outbox
            WHERE processed_at IS NULL AND next_attempt_at <= $1::TIMESTAMPTZ
            ORDER BY next_attempt_at ASC, id ASC
            LIMIT $2`,
          [input.now, input.limit]
        );
        return result.rows.map(outboxFromRow);
      });
      rows.push(...values);
    }
    const unique = new Map(rows.map((row) => [row.id, row]));
    return [...unique.values()]
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }

  async withOutboxTransaction<T>(
    outboxId: string,
    action: (transaction: WorkspaceNotificationProjectionTransaction, outbox: WorkspaceNotificationOutbox) => Promise<T>
  ): Promise<T> {
    const contexts = await this.workerContexts();
    for (const context of contexts) {
      let found = false;
      let resultValue: T | undefined;
      await this.withMaintenanceContext(context, `lock:${outboxId}`, async (sql) => {
        const locked = await sql.query<OutboxRow>(
          `SELECT id, workspace_id, room_id, source_kind, source_id, source_revision,
                  kind, action, recipient_account_ids, created_at, processed_at,
                  attempts, next_attempt_at, last_error_code
             FROM account_notification_outbox
            WHERE id = $1
            FOR UPDATE`,
          [outboxId]
        );
        if (!locked.rows[0]) return;
        found = true;
        const outbox = outboxFromRow(locked.rows[0]);
        const transaction: WorkspaceNotificationProjectionTransaction = {
          insertNotification: async (notification) => {
            // Keep the internal boundary explicit at the write site as well
            // as at transaction entry.  This protects the projector if a
            // future transaction wrapper introduces another savepoint or
            // connection seam before the notification INSERT.
            await sql.query("SELECT set_config('samurai.internal_access', '1', true)");
            const inserted = await sql.query(
              `INSERT INTO account_notifications(
                 id, recipient_account_id, workspace_id, room_id, kind,
                 source_kind, source_id, source_revision, created_at, read_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::TIMESTAMPTZ, NULL)
               ON CONFLICT (id) DO NOTHING`,
              [
                notification.id,
                notification.recipientAccountId,
                notification.workspaceId ?? null,
                notification.roomId ?? null,
                notification.kind,
                notification.sourceKind,
                notification.sourceId,
                notification.sourceRevision,
                notification.createdAt
              ]
            );
            return inserted.rowCount === 1 ? "inserted" : "existing";
          },
          markOutboxProcessed: async (processedAt) => {
            await sql.query(
              `UPDATE account_notification_outbox
                  SET processed_at = $2::TIMESTAMPTZ
                WHERE id = $1 AND processed_at IS NULL`,
              [outbox.id, processedAt]
            );
          }
        };
        resultValue = await action(transaction, outbox);
      });
      if (found) {
        if (this.options.onProjected) await this.options.onProjected((await this.readOutbox(outboxId, context)) ?? { id: outboxId } as WorkspaceNotificationOutbox);
        return resultValue as T;
      }
    }
    throw new Error("workspace_notification_outbox_not_found");
  }

  async markOutboxFailure(input: { outboxId: string; attempts: number; nextAttemptAt: string; lastErrorCode: string }): Promise<void> {
    const contexts = await this.workerContexts();
    for (const context of contexts) {
      const updated = await this.withMaintenanceContext(context, `failure:${input.outboxId}`, async (sql) => {
        const result = await sql.query(
          `UPDATE account_notification_outbox
              SET attempts = $2, next_attempt_at = $3::TIMESTAMPTZ,
                  last_error_code = $4, processed_at = NULL
            WHERE id = $1`,
          [input.outboxId, input.attempts, input.nextAttemptAt, input.lastErrorCode]
        );
        return result.rowCount === 1;
      });
      if (updated) return;
    }
    throw new Error("workspace_notification_outbox_not_found");
  }

  async listNotifications(input: { accountId: string; workspaceId?: string; invitationOnly?: boolean }): Promise<readonly WorkspaceNotificationRecord[]> {
    const rows = await this.database.withContext({ accountId: input.accountId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) }, async (sql) => {
      const result = await sql.query<NotificationRow>(
        `SELECT id, recipient_account_id, workspace_id, room_id, kind,
                source_kind, source_id, source_revision, created_at, read_at
           FROM account_notifications
          WHERE recipient_account_id = $1
            AND ($2::TEXT IS NULL OR workspace_id = $2)
            AND ($3::BOOLEAN = FALSE OR kind = 'invitation')
          ORDER BY created_at DESC, id DESC`,
        [input.accountId, input.workspaceId ?? null, input.invitationOnly === true]
      );
      return result.rows;
    });
    return rows.map(notificationFromRow);
  }

  async getNotifications(input: { accountId: string; notificationIds: readonly string[] }): Promise<readonly WorkspaceNotificationRecord[]> {
    if (input.notificationIds.length === 0) return [];
    const rows = await this.database.withContext({ accountId: input.accountId }, async (sql) => {
      const result = await sql.query<NotificationRow>(
        `SELECT id, recipient_account_id, workspace_id, room_id, kind,
                source_kind, source_id, source_revision, created_at, read_at
           FROM account_notifications
          WHERE recipient_account_id = $1 AND id = ANY($2::TEXT[])`,
        [input.accountId, [...input.notificationIds]]
      );
      return result.rows;
    });
    return rows.map(notificationFromRow);
  }

  async markNotificationsRead(input: { accountId: string; workspaceId?: string; notificationIds: readonly string[]; readAt: string }): Promise<readonly WorkspaceNotificationRecord[]> {
    if (input.notificationIds.length === 0) return [];
    const rows = await this.database.withContext({ accountId: input.accountId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) }, async (sql) => {
      const result = await sql.query<NotificationRow>(
        `UPDATE account_notifications
            SET read_at = COALESCE(read_at, $4::TIMESTAMPTZ)
          WHERE recipient_account_id = $1
            AND id = ANY($2::TEXT[])
            AND ($3::TEXT IS NULL OR workspace_id = $3)
        RETURNING id, recipient_account_id, workspace_id, room_id, kind,
                  source_kind, source_id, source_revision, created_at, read_at`,
        [input.accountId, [...input.notificationIds], input.workspaceId ?? null, input.readAt]
      );
      return result.rows;
    });
    return rows.map(notificationFromRow);
  }

  private async workerContexts(): Promise<readonly WorkspaceNotificationWorkerContext[]> {
    const contexts = await this.options.resolveWorkerContexts?.();
    return contexts ?? [];
  }

  private async withMaintenanceContext<T>(context: WorkspaceNotificationWorkerContext, suffix: string, action: (sql: WorkspaceSql) => Promise<T>): Promise<T> {
    const operationId = `notification_projection_${createHash("sha256").update(`${context.workspaceId}|${context.accountId}|${suffix}`).digest("hex").slice(0, 48)}`;
    const databaseContext: WorkspaceDatabaseContext = {
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      worker: true,
      caller: createInternalWorkspaceMaintenanceCaller({ principalAccountId: context.accountId, operationId })
    };
    return this.database.withContext(databaseContext, async (sql) => {
      // The outbox is Server-owned metadata.  Keep this elevation confined to
      // a transaction opened with a configured maintenance identity; ordinary
      // Account/Workspace reads never set this flag.
      await sql.query("SELECT set_config('samurai.internal_access', '1', true)");
      return action(sql);
    });
  }

  private async readOutbox(id: string, context: WorkspaceNotificationWorkerContext): Promise<WorkspaceNotificationOutbox | undefined> {
    return this.withMaintenanceContext(context, `read:${id}`, async (sql) => {
      const result = await sql.query<OutboxRow>(
        `SELECT id, workspace_id, room_id, source_kind, source_id, source_revision,
                kind, action, recipient_account_ids, created_at, processed_at,
                attempts, next_attempt_at, last_error_code
           FROM account_notification_outbox WHERE id = $1`,
        [id]
      );
      return result.rows[0] ? outboxFromRow(result.rows[0]) : undefined;
    });
  }
}

export function createPostgresWorkspaceNotificationStore(
  database: DatabaseWithContext,
  options: PostgresWorkspaceNotificationStoreOptions = {}
): PostgresWorkspaceNotificationStore {
  return new PostgresWorkspaceNotificationStore(database, options);
}

/**
 * Source-state resolver. The SQL paths only select title/summary/status and
 * never return a file path, body, recipient list, or other internal metadata.
 */
export class PostgresWorkspaceNotificationAuthorization implements WorkspaceNotificationAuthorizationResolver {
  constructor(private readonly database: DatabaseWithContext) {}

  async authorizeWorkspace(input: { accountId: string; workspaceId: string }): Promise<boolean> {
    return this.database.withContext({ accountId: input.accountId, workspaceId: input.workspaceId }, async (sql) => {
      const result = await sql.query<{ allowed: boolean }>(
        "SELECT samurai_can_workspace($1, 'guest') AS allowed",
        [input.workspaceId]
      );
      return result.rows[0]?.allowed === true;
    });
  }

  async resolveNotification(input: { accountId: string; workspaceId?: string; notification: WorkspaceNotificationRecord }): Promise<WorkspaceNotificationResolution> {
    const notification = input.notification;
    if (notification.recipientAccountId !== input.accountId) return { allowed: false };
    if (input.workspaceId !== undefined && notification.workspaceId !== input.workspaceId) return { allowed: false };
    if (notification.workspaceId === undefined) {
      return this.resolveInvitation(input.accountId, notification);
    }
    if (!notification.roomId) return { allowed: false };
    return this.database.withContext({ accountId: input.accountId, workspaceId: notification.workspaceId }, async (sql) => {
      const room = await sql.query<{ allowed: boolean }>(
        "SELECT samurai_can_room($1, $2, 'read') AS allowed",
        [notification.workspaceId, notification.roomId]
      );
      if (room.rows[0]?.allowed !== true) return { allowed: false };
      return resolveWorkspaceSource(sql, notification);
    });
  }

  private async resolveInvitation(accountId: string, notification: WorkspaceNotificationRecord): Promise<WorkspaceNotificationResolution> {
    if (notification.kind !== "invitation") return { allowed: false };
    return this.database.withContext({ accountId }, async (sql) => {
      const organization = await sql.query<{ id: string; organization_id: string; role: string; expires_at: Date | string; revoked_at: Date | string | null; accepted_at: Date | string | null }>(
        `SELECT id, organization_id, role, expires_at, revoked_at, accepted_at
           FROM organization_invitations
          WHERE id = $1 AND target_account_id = $2`,
        [notification.sourceId, accountId]
      );
      if (organization.rows[0]) {
        const row = organization.rows[0];
        const active = !row.revoked_at && !row.accepted_at && Date.parse(String(row.expires_at)) > Date.now();
        return {
          allowed: true,
          actionState: active ? "pending" : "resolved",
          title: "Organization invitation",
          summary: active ? `Invitation to join as ${row.role}.` : "This invitation is no longer active.",
          target: { kind: "invitation", invitationId: notification.sourceId }
        };
      }
      // Workspace invitations are readable only when PostgreSQL's policy says
      // the Account may read them. No token or internal source is projected.
      if (notification.workspaceId) {
        const workspace = await sql.query<{ id: string; expires_at: Date | string; revoked_at: Date | string | null; accepted_at: Date | string | null }>(
          `SELECT id, expires_at, revoked_at, accepted_at
             FROM workspace_invitations
            WHERE workspace_id = $1 AND id = $2`,
          [notification.workspaceId, notification.sourceId]
        );
        const row = workspace.rows[0];
        if (row) {
          const active = !row.revoked_at && !row.accepted_at && Date.parse(String(row.expires_at)) > Date.now();
          return {
            allowed: true,
            actionState: active ? "pending" : "resolved",
            title: "Workspace invitation",
            summary: active ? "You have an invitation to join a Workspace." : "This invitation is no longer active.",
            target: { kind: "invitation", invitationId: notification.sourceId }
          };
        }
      }
      return { allowed: false };
    });
  }
}

export function createPostgresWorkspaceNotificationAuthorization(database: DatabaseWithContext): PostgresWorkspaceNotificationAuthorization {
  return new PostgresWorkspaceNotificationAuthorization(database);
}

export function createPostgresWorkspaceNotificationService(
  database: DatabaseWithContext,
  options: PostgresWorkspaceNotificationServiceOptions = {}
): WorkspaceNotificationService {
  const authorization = createPostgresWorkspaceNotificationAuthorization(database);
  const store = createPostgresWorkspaceNotificationStore(database, options);
  return new WorkspaceNotificationService(store, authorization, options.clock ? { clock: options.clock } : {});
}

export interface WorkspaceNotificationProjectionWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  runTick(input?: { now?: string; limit?: number }): Promise<{ processedIds: string[]; failed: Array<{ outboxId: string; errorCode: string }> }>;
}

/** A restart-safe projection lane: every tick scans durable due outbox rows. */
export function createWorkspaceNotificationProjectionWorker(
  service: WorkspaceNotificationService,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {}
): WorkspaceNotificationProjectionWorker {
  const intervalMs = Math.max(1_000, Math.min(options.intervalMs ?? 30_000, 86_400_000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<unknown> | undefined;
  let stopped = false;
  const runTick = async (input: { now?: string; limit?: number } = {}) => {
    const task = service.projectOutbox(input);
    active = task;
    try {
      return await task;
    } finally {
      if (active === task) active = undefined;
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runTick().catch((error) => options.onError?.(error)).finally(schedule);
    }, intervalMs);
    timer.unref?.();
  };
  return {
    async start() {
      if (timer !== undefined || active !== undefined) return;
      stopped = false;
      void runTick().catch((error) => options.onError?.(error)).finally(schedule);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await active?.catch(() => undefined);
    },
    runTick
  };
}

export interface WorkspaceNotificationOutboxPort {
  enqueue(input: WorkspaceNotificationOutboxInput): Promise<WorkspaceNotificationOutbox | undefined>;
  enqueueInTransaction(sql: WorkspaceSql, input: WorkspaceNotificationOutboxInput): Promise<WorkspaceNotificationOutbox | undefined>;
}

/**
 * Organization invitation mutations already commit their authoritative row
 * and organization event in Workspace Server Core.  This bridge writes only
 * the recipient-scoped notification outbox metadata after that durable
 * result, using the same deterministic source/version key on retries.  It
 * never accepts an Account supplied by a request body and never carries the
 * invitation token into notification storage.
 */
export interface WorkspaceOrganizationNotificationBridge {
  created(result: unknown): Promise<void>;
  invalidated(result: unknown): Promise<void>;
  reissued(context: { accountId: string; organizationId?: string }, previousInvitationId: string, result: unknown): Promise<void>;
  accepted(context: Pick<WorkspaceRequestContext, "accountId">, result: unknown): Promise<void>;
}

export function createPostgresOrganizationNotificationBridge(
  database: DatabaseWithContext,
  outbox: WorkspaceNotificationOutboxPort
): WorkspaceOrganizationNotificationBridge {
  const enqueueInvitation = async (input: {
    invitationId: string;
    sourceRevision: number;
    targetAccountId?: string;
    action: "create" | "invalidate";
  }): Promise<void> => {
    if (!input.targetAccountId) return;
    const projected = await outbox.enqueue({
      sourceKind: "organization_invitation",
      sourceId: input.invitationId,
      sourceRevision: input.sourceRevision,
      kind: "invitation",
      action: input.action,
      recipientAccountIds: [input.targetAccountId]
    });
    // The mutation has already been committed.  Surface a durable projection
    // failure instead of returning a false notification success; retrying the
    // same idempotent command calls this bridge again and is harmless.
    if (!projected) throw new Error("workspace_notification_outbox_unavailable");
  };

  const invitationFromResult = (value: unknown): {
    id: string;
    version: number;
    targetAccountId?: string;
  } | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const body = value as Record<string, unknown>;
    const candidate = body.invitation && typeof body.invitation === "object" && !Array.isArray(body.invitation)
      ? body.invitation as Record<string, unknown>
      : body;
    if (typeof candidate.id !== "string" || !Number.isSafeInteger(Number(candidate.version)) || Number(candidate.version) < 1) return undefined;
    return {
      id: candidate.id,
      version: Number(candidate.version),
      ...(typeof candidate.targetAccountId === "string" ? { targetAccountId: candidate.targetAccountId } : {})
    };
  };

  return {
    created: async (result) => {
      const invitation = invitationFromResult(result);
      if (!invitation) return;
      await enqueueInvitation({
        invitationId: invitation.id,
        sourceRevision: invitation.version,
        targetAccountId: invitation.targetAccountId,
        action: "create"
      });
    },
    invalidated: async (result) => {
      const invitation = invitationFromResult(result);
      if (!invitation) return;
      await enqueueInvitation({
        invitationId: invitation.id,
        sourceRevision: invitation.version,
        targetAccountId: invitation.targetAccountId,
        action: "invalidate"
      });
    },
    reissued: async (context, previousInvitationId, result) => {
      const replacement = invitationFromResult(result);
      if (!replacement) return;
      const previous = await database.withContext({ accountId: context.accountId }, async (sql) => {
        const selected = await sql.query<{ version: number | string; target_account_id: string | null }>(
          `SELECT version, target_account_id
             FROM organization_invitations
            WHERE id = $1
              AND ($2::TEXT IS NULL OR organization_id = $2)
            LIMIT 1`,
          [previousInvitationId, context.organizationId ?? null]
        );
        return selected.rows[0];
      });
      await enqueueInvitation({
        invitationId: previousInvitationId,
        sourceRevision: previous ? Number(previous.version) : replacement.version,
        targetAccountId: previous?.target_account_id ?? replacement.targetAccountId,
        action: "invalidate"
      });
      await enqueueInvitation({
        invitationId: replacement.id,
        sourceRevision: replacement.version,
        targetAccountId: replacement.targetAccountId,
        action: "create"
      });
    },
    accepted: async (context, result) => {
      if (!result || typeof result !== "object" || Array.isArray(result)) return;
      const body = result as Record<string, unknown>;
      if (typeof body.organizationId !== "string" || typeof body.accountId !== "string") return;
      // The command result is only meaningful for the authenticated Account;
      // never let a malformed/replayed result select another recipient.
      if (body.accountId !== context.accountId) return;
      const invitation = await database.withContext({ accountId: context.accountId }, async (sql) => {
        const selected = await sql.query<{ id: string; version: number | string; target_account_id: string | null }>(
          `SELECT id, version, target_account_id
             FROM organization_invitations
            WHERE organization_id = $1
              AND target_account_id = $2
              AND accepted_by = $2
              AND accepted_at IS NOT NULL
            ORDER BY accepted_at DESC, id DESC
            LIMIT 1`,
          [body.organizationId, body.accountId]
        );
        return selected.rows[0];
      });
      if (!invitation) return;
      await enqueueInvitation({
        invitationId: invitation.id,
        sourceRevision: Number(invitation.version),
        targetAccountId: invitation.target_account_id ?? undefined,
        action: "invalidate"
      });
    }
  };
}

/**
 * Keep invitation projection at the command boundary while leaving the
 * existing Workspace Server command implementation and transaction owner
 * untouched.  All other methods retain their original receiver/capabilities.
 */
export function createOrganizationNotificationAwareCommands(
  commands: WorkspaceServerCommandService,
  bridge: WorkspaceOrganizationNotificationBridge
): WorkspaceServerCommandService {
  const facade = Object.create(commands) as WorkspaceServerCommandService;
  facade.inviteOrganizationMember = (async (context, input) => {
    const result = await commands.inviteOrganizationMember(context, input);
    await bridge.created(result);
    return result;
  }) as WorkspaceServerCommandService["inviteOrganizationMember"];
  facade.revokeOrganizationInvitation = (async (context, input) => {
    const result = await commands.revokeOrganizationInvitation(context, input);
    await bridge.invalidated(result);
    return result;
  }) as WorkspaceServerCommandService["revokeOrganizationInvitation"];
  facade.extendOrganizationInvitation = (async (context, input) => {
    const result = await commands.extendOrganizationInvitation(context, input);
    await bridge.invalidated(result);
    return result;
  }) as WorkspaceServerCommandService["extendOrganizationInvitation"];
  facade.reissueOrganizationInvitation = (async (context, input) => {
    const result = await commands.reissueOrganizationInvitation(context, input);
    const previousInvitationId = typeof input.invitationId === "string"
      ? input.invitationId
      : typeof input.invitation_id === "string" ? input.invitation_id : "";
    if (previousInvitationId) await bridge.reissued({ accountId: context.accountId, organizationId: context.organizationId }, previousInvitationId, result);
    else await bridge.created(result);
    return result;
  }) as WorkspaceServerCommandService["reissueOrganizationInvitation"];
  facade.acceptOrganizationInvitation = (async (context, input) => {
    const result = await commands.acceptOrganizationInvitation(context, input);
    await bridge.accepted(context, result);
    return result;
  }) as WorkspaceServerCommandService["acceptOrganizationInvitation"];
  return facade;
}

/**
 * Explicit state-transition port. Callers that already own a Core transaction
 * should use enqueueInTransaction so the outbox row shares that transaction;
 * the standalone method is reserved for recovery/host composition.
 */
export function createPostgresWorkspaceNotificationOutboxPort(
  database: DatabaseWithContext,
  resolveWorkerContexts: () => Promise<readonly WorkspaceNotificationWorkerContext[]>
): WorkspaceNotificationOutboxPort {
  const enqueueInTransaction = async (sql: WorkspaceSql, input: WorkspaceNotificationOutboxInput) => {
    const outbox = buildWorkspaceNotificationOutbox(input);
    if (!outbox) return undefined;
    // The outbox is Server-owned transaction state.  Its RLS policy deliberately
    // rejects ordinary Account writes, including when the caller is a Workspace
    // owner; mark only this short-lived transaction as the internal projector.
    await sql.query("SELECT set_config('samurai.internal_access', '1', true)");
    await sql.query(
      `INSERT INTO account_notification_outbox(
         id, workspace_id, room_id, source_kind, source_id, source_revision,
         kind, action, recipient_account_ids, created_at, next_attempt_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10::TIMESTAMPTZ, $10::TIMESTAMPTZ)
       ON CONFLICT (id) DO NOTHING`,
      [
        outbox.id,
        outbox.workspaceId ?? null,
        outbox.roomId ?? null,
        outbox.sourceKind,
        outbox.sourceId,
        outbox.sourceRevision,
        outbox.kind,
        outbox.action,
        JSON.stringify(outbox.recipientAccountIds),
        outbox.createdAt
      ]
    );
    return outbox;
  };
  return {
    enqueueInTransaction,
    enqueue: async (input) => {
      const contexts = await resolveWorkerContexts();
      const context = contexts.find((candidate) => candidate.workspaceId === input.workspaceId) ?? contexts[0];
      if (!context) return undefined;
      return database.withContext({
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        worker: true,
        caller: createInternalWorkspaceMaintenanceCaller({
          principalAccountId: context.accountId,
          operationId: `notification_enqueue_${createHash("sha256").update(`${context.workspaceId}|${input.sourceId}`).digest("hex").slice(0, 48)}`
        })
      }, (sql) => enqueueInTransaction(sql, input));
    }
  };
}

/**
 * Completion-backed Runtime selector. It deliberately calls only Room and
 * Agent targets; Workspace Knowledge cannot enter the candidate arrays.
 */
export function createPostgresRuntimeExecutionContextSelector(
  completion: WorkspaceCompletionService
): NonNullable<import("../adapters/runtime/postgres-runtime-chat").PostgresRuntimeChatOptions["executionContext"]> {
  return {
    select: async (context, input) => {
      const query = input.query.trim() || "context";
      const limit = Math.max(1, Math.min(input.limit ?? 32, 32));
      if (!input.roomId || !input.agentId) return {};
      const room = await selectCompletionCandidates(completion, context, { roomId: input.roomId, query, limit, source: "room" });
      const agentKnowledge = await selectCompletionCandidates(completion, context, { agentId: input.agentId, query, limit, source: "agentKnowledge" });
      const agentSkills = await selectCompletionCandidates(completion, context, { agentId: input.agentId, query, limit, source: "agentSkills" });
      return { roomKnowledge: room, agentKnowledge, agentSkills };
    }
  };
}

async function selectCompletionCandidates(
  completion: WorkspaceCompletionService,
  context: AccountWorkspaceContext,
  input: { roomId?: string; agentId?: string; query: string; limit: number; source: "room" | "agentKnowledge" | "agentSkills" }
): Promise<RuntimeExecutionResourceCandidate[]> {
  const resources: Array<WorkspaceCompletionResource & { rank?: number }> = [];
  if (input.source === "room") {
    resources.push(...await completion.searchKnowledge(context, { roomId: input.roomId, query: input.query, limit: input.limit }));
    if (resources.length === 0) resources.push(...await completion.listResources(context, { roomId: input.roomId, scopeKind: "room", kind: "knowledge", includeArchived: false, limit: input.limit }));
  } else if (input.source === "agentKnowledge") {
    resources.push(...await completion.searchKnowledge(context, { agentId: input.agentId, query: input.query, limit: input.limit }));
    if (resources.length === 0) resources.push(...await completion.listResources(context, { agentId: input.agentId, scopeKind: "agent", kind: "knowledge", includeArchived: false, limit: input.limit }));
  } else {
    const page = await completion.searchSkillsPage(context, { agentId: input.agentId, query: input.query, limit: input.limit });
    resources.push(...page.items);
    if (resources.length === 0) resources.push(...await completion.listSkills(context, { agentId: input.agentId, limit: input.limit }));
  }

  const unique = new Map<string, WorkspaceCompletionResource & { rank?: number }>();
  for (const resource of resources) {
    if (unique.has(resource.id)) continue;
    if (resource.lifecycleState !== "active" || resource.evidenceState !== "confirmed") continue;
    if (input.source === "room" && (resource.kind !== "knowledge" || resource.scope.kind !== "room" || resource.scope.roomId !== input.roomId)) continue;
    if ((input.source === "agentKnowledge" || input.source === "agentSkills")
      && (resource.scope.kind !== "agent" || resource.scope.agentId !== input.agentId)) continue;
    if (input.source === "agentKnowledge" && resource.kind !== "knowledge") continue;
    if (input.source === "agentSkills" && resource.kind !== "skill") continue;
    unique.set(resource.id, resource);
  }

  const candidates: RuntimeExecutionResourceCandidate[] = [];
  for (const resource of unique.values()) {
    const document = await completion.getResourceBody(context, resource.id);
    if (!confirmedActive(resource, document.version)) continue;
    const sourceScope = resource.scope.kind === "room" && typeof resource.scope.roomId === "string"
      ? { kind: "room" as const, room_id: resource.scope.roomId }
      : resource.scope.kind === "agent" && typeof resource.scope.agentId === "string"
        ? { kind: "agent" as const, agent_id: resource.scope.agentId }
        : undefined;
    if (!sourceScope) continue;
    candidates.push({
      id: resource.id,
      kind: resource.kind === "skill" ? "skill" : "knowledge",
      title: resource.title,
      version: document.version.version,
      contentHash: document.version.contentHash,
      sourceScope,
      evidenceState: "confirmed",
      lifecycleState: "active",
      finalized: true,
      archived: false,
      rank: resource.rank,
      selectionReason: resource.rank === undefined ? `completion_${input.source}_list` : `completion_${input.source}_rank:${resource.rank}`,
      disclosureLevel: resource.kind === "skill" ? "body" : undefined,
      bodyAllowed: resource.kind === "skill" ? true : undefined,
      content: document.content
    });
  }
  return candidates;
}

function confirmedActive(resource: WorkspaceCompletionResource, version: WorkspaceCompletionResourceVersion): boolean {
  return resource.evidenceState === "confirmed"
    && resource.lifecycleState === "active"
    && version.evidenceState === "confirmed"
    && version.lifecycleState === "active";
}

async function resolveWorkspaceSource(sql: WorkspaceSql, notification: WorkspaceNotificationRecord): Promise<WorkspaceNotificationResolution> {
  const workspaceId = notification.workspaceId!;
  const roomId = notification.roomId!;
  const sourceKind = notification.sourceKind.toLowerCase();
  if (sourceKind === "work" || sourceKind === "room_work" || sourceKind === "room_work_assignment" || sourceKind === "workspace_human_work") {
    const work = await sql.query<{ id: string; title: string; objective: string; status: string; room_id: string; work_id?: string }>(
      `SELECT work.id, work.title, work.objective, work.status, work.room_id,
              NULL::TEXT AS work_id
         FROM workspace_human_works work
        WHERE work.workspace_id = $1 AND work.room_id = $2 AND work.id = $3
       UNION ALL
       SELECT work.id, work.title, work.objective, work.status, work.room_id,
              assignment.work_id AS work_id
         FROM workspace_human_work_assignments assignment
         JOIN workspace_human_works work
           ON work.workspace_id = assignment.workspace_id AND work.id = assignment.work_id
        WHERE assignment.workspace_id = $1 AND assignment.room_id = $2 AND assignment.id = $3
        LIMIT 1`,
      [workspaceId, roomId, notification.sourceId]
    );
    const row = work.rows[0];
    if (!row) return { allowed: false };
    return {
      allowed: true,
      title: row.title,
      summary: `${row.objective} (${row.status})`,
      target: { kind: "work", roomId, workId: row.id },
      actionState: "not_required"
    };
  }
  if (sourceKind === "interaction_request" || sourceKind === "approval" || sourceKind === "input") {
    const record = await sql.query<{ id: string; version: number | string; payload: unknown }>(
      `SELECT id, version, payload
         FROM workspace_records
        WHERE workspace_id = $1 AND room_id = $2 AND record_type = 'interaction_request' AND id = $3`,
      [workspaceId, roomId, notification.sourceId]
    );
    const row = record.rows[0];
    if (!row || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return { allowed: false };
    const payload = row.payload as Record<string, unknown>;
    const title = safeText(payload.title, "Interaction required", 500);
    const summary = safeText(payload.summary, "The Server is waiting for your response.", 2_000);
    const status = typeof payload.status === "string" ? payload.status : "pending";
    return {
      allowed: true,
      title,
      summary,
      target: { kind: "interaction_request", roomId, requestId: notification.sourceId },
      actionState: status === "pending" || status === "accepted" || status === "executing" ? "pending" : "resolved"
    };
  }
  // Future source kinds are rendered as a room-local generic notification.
  // The source identifier and unknown internal fields never cross this port.
  return {
    allowed: true,
    title: "Workspace update",
    summary: notification.kind === "work_failed" ? "A Room operation needs attention." : "A Room operation was updated.",
    target: { kind: "room", roomId },
    actionState: notification.kind === "approval_required" || notification.kind === "input_required" ? "pending" : "not_required"
  };
}

function notificationFromRow(row: NotificationRow): WorkspaceNotificationRecord {
  return {
    id: String(row.id),
    recipientAccountId: String(row.recipient_account_id),
    ...(row.workspace_id === null ? {} : { workspaceId: String(row.workspace_id) }),
    ...(row.room_id === null ? {} : { roomId: String(row.room_id) }),
    kind: String(row.kind),
    sourceKind: String(row.source_kind),
    sourceId: String(row.source_id),
    sourceRevision: Number(row.source_revision),
    createdAt: iso(row.created_at),
    readAt: row.read_at === null ? null : iso(row.read_at)
  };
}

function outboxFromRow(row: OutboxRow): WorkspaceNotificationOutbox {
  const parsedRecipients: unknown = Array.isArray(row.recipient_account_ids)
    ? row.recipient_account_ids
    : typeof row.recipient_account_ids === "string"
      ? JSON.parse(row.recipient_account_ids) as unknown
      : [];
  const recipients: unknown[] = Array.isArray(parsedRecipients) ? parsedRecipients : [];
  return {
    id: String(row.id),
    ...(row.workspace_id === null ? {} : { workspaceId: String(row.workspace_id) }),
    ...(row.room_id === null ? {} : { roomId: String(row.room_id) }),
    sourceKind: String(row.source_kind),
    sourceId: String(row.source_id),
    sourceRevision: Number(row.source_revision),
    kind: String(row.kind),
    action: row.action,
    recipientAccountIds: recipients.filter((value): value is string => typeof value === "string"),
    createdAt: iso(row.created_at),
    processedAt: row.processed_at === null ? null : iso(row.processed_at),
    attempts: Number(row.attempts),
    nextAttemptAt: iso(row.next_attempt_at),
    lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code)
  };
}

function iso(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) throw new Error("workspace_notification_timestamp_invalid");
  return result.toISOString();
}

function safeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/\s+/gu, " ").slice(0, maxLength);
}
